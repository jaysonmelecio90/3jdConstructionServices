<?php
// api/project-workers.php — manage worker assignments to a project.
//   GET     ?project_id= | ?project_slug=  -> { items:[ <assignment> ] }
//   POST    {project_id, worker_id}        -> { ok, item } 201   (409 on duplicate)
//   DELETE  ?id= | {project_id, worker_id} -> { ok, deleted }
// Session-based auth (same-origin). Money/rates are returned as STRINGS.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$pdo = db();

/** Read a JSON request body into an array (empty array if none/invalid). */
function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/** Resolve a project id from ?project_id= or ?project_slug=. Returns 0 if not found. */
function resolve_project_id(PDO $pdo, array $src): int
{
    if (isset($src['project_id']) && $src['project_id'] !== '') {
        $pid = (int) $src['project_id'];
        $stmt = $pdo->prepare('SELECT id FROM projects WHERE id = ? LIMIT 1');
        $stmt->execute([$pid]);
        $row = $stmt->fetchColumn();
        return $row ? (int) $row : 0;
    }
    if (isset($src['project_slug']) && $src['project_slug'] !== '') {
        $stmt = $pdo->prepare('SELECT id FROM projects WHERE slug = ? LIMIT 1');
        $stmt->execute([trim((string) $src['project_slug'])]);
        $row = $stmt->fetchColumn();
        return $row ? (int) $row : 0;
    }
    return 0;
}

/** Validate that a worker id exists. */
function worker_exists(PDO $pdo, int $workerId): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM workers WHERE id = ? LIMIT 1');
    $stmt->execute([$workerId]);
    return (bool) $stmt->fetchColumn();
}

/** Shape a joined assignment row (money/rates as STRINGS). */
function shape_assignment(array $r): array
{
    return [
        'id'           => (int) $r['id'],
        'worker_id'    => (int) $r['worker_id'],
        'name'         => $r['name'],
        'designation'  => $r['designation'],
        'hourly_rate'  => $r['hourly_rate'] === null ? null : (string) $r['hourly_rate'],
        'daily_rate'   => $r['daily_rate']  === null ? null : (string) $r['daily_rate'],
        'status'       => $r['status'],
        'assigned_at'  => $r['assigned_at'],
    ];
}

/** Fetch one assignment by id (joined to worker). */
function fetch_assignment(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT pw.id, pw.worker_id, pw.assigned_at,
               w.name, w.designation, w.hourly_rate, w.daily_rate, w.status
        FROM project_workers pw
        JOIN workers w ON w.id = pw.worker_id
        WHERE pw.id = ?
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_assignment($row) : null;
}

// ===========================================================================
// GET — list assignments for a project
// ===========================================================================
if ($method === 'GET') {
    $projectId = resolve_project_id($pdo, $_GET);
    if ($projectId <= 0) {
        json_out(['error' => 'a valid project is required'], 422);
    }

    $stmt = $pdo->prepare("
        SELECT pw.id, pw.worker_id, pw.assigned_at,
               w.name, w.designation, w.hourly_rate, w.daily_rate, w.status
        FROM project_workers pw
        JOIN workers w ON w.id = pw.worker_id
        WHERE pw.project_id = ?
        ORDER BY (w.status = 'active') DESC, w.name ASC
    ");
    $stmt->execute([$projectId]);

    $items = [];
    foreach ($stmt->fetchAll() as $r) {
        $items[] = shape_assignment($r);
    }
    json_out(['items' => $items]);
}

// ===========================================================================
// POST — assign a worker to a project
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    $projectId = resolve_project_id($pdo, $b);
    $workerId  = isset($b['worker_id']) ? (int) $b['worker_id'] : 0;

    if ($projectId <= 0) {
        json_out(['error' => 'a valid project is required'], 422);
    }
    if ($workerId <= 0 || !worker_exists($pdo, $workerId)) {
        json_out(['error' => 'a valid worker is required'], 422);
    }

    try {
        $stmt = $pdo->prepare('INSERT INTO project_workers (project_id, worker_id) VALUES (?, ?)');
        $stmt->execute([$projectId, $workerId]);
    } catch (PDOException $e) {
        // Duplicate (UNIQUE) -> 409.
        if ($e->getCode() === '23000') {
            json_out(['error' => 'worker is already assigned to this project'], 409);
        }
        throw $e;
    }

    $id = (int) $pdo->lastInsertId();
    json_out(['ok' => true, 'item' => fetch_assignment($pdo, $id)], 201);
}

// ===========================================================================
// DELETE — unassign by ?id= or {project_id, worker_id}
// ===========================================================================
if ($method === 'DELETE') {
    $id = 0;
    if (isset($_GET['id']) && $_GET['id'] !== '') {
        $id = (int) $_GET['id'];
    }

    if ($id > 0) {
        $stmt = $pdo->prepare('DELETE FROM project_workers WHERE id = ?');
        $stmt->execute([$id]);
        json_out(['ok' => true, 'deleted' => $stmt->rowCount()]);
    }

    $b = read_json_body();
    $projectId = resolve_project_id($pdo, $b);
    $workerId  = isset($b['worker_id']) ? (int) $b['worker_id'] : 0;

    if ($projectId <= 0 || $workerId <= 0) {
        json_out(['error' => 'id or (project_id and worker_id) is required'], 422);
    }

    $stmt = $pdo->prepare('DELETE FROM project_workers WHERE project_id = ? AND worker_id = ?');
    $stmt->execute([$projectId, $workerId]);
    json_out(['ok' => true, 'deleted' => $stmt->rowCount()]);
}

json_out(['error' => 'method not allowed'], 405);
