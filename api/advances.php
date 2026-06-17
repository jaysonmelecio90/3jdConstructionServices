<?php
// api/advances.php — PER-PROJECT cash advances tied to a payroll period.
//   An advance belongs to a project + period; it is deducted from that
//   project's OVERALL payroll cost for the cycle, NOT from a single worker.
//   worker_id is OPTIONAL (legacy reference only) — new advances leave it null.
//   GET     ?project_id= | ?project_slug= | ?worker_id=
//           ?period_start=YYYY-MM-DD | ?period_end=YYYY-MM-DD  (overlap semantics)
//             -> { items:[ <advance> ], summary:{count,total} }
//   POST    {project_id, worker_id?, period_start?, period_end?, amount, note?}
//             -> { ok, item } 201
//   PUT     {id, ...partial}                              -> { ok, item }
//   DELETE  ?id= | {id}                                   -> { ok, id, deleted }
// Session-based auth. Money returned as STRINGS.
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

/** Trim a value to a non-empty string, or null. */
function nstr($v): ?string
{
    if ($v === null) {
        return null;
    }
    $s = trim((string) $v);
    return $s === '' ? null : $s;
}

/** Validate a 'YYYY-MM-DD' date string; return it, or null. */
function valid_date(?string $s): ?string
{
    if ($s === null || $s === '') {
        return null;
    }
    $d = DateTime::createFromFormat('Y-m-d', $s);
    return ($d && $d->format('Y-m-d') === $s) ? $s : null;
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

/** Shape one joined cash advance row (money as STRING). worker_* may be null. */
function shape_advance(array $r): array
{
    return [
        'id'            => (int) $r['id'],
        'project_id'    => (int) $r['project_id'],
        'project_name'  => $r['project_name'],
        'project_slug'  => $r['project_slug'],
        'worker_id'     => $r['worker_id'] === null ? null : (int) $r['worker_id'],
        'worker_name'   => $r['worker_name'],
        'designation'   => $r['designation'],
        'period_start'  => $r['period_start'],
        'period_end'    => $r['period_end'],
        'amount'        => money_str($r['amount']),
        'note'          => $r['note'],
        'created_at'    => $r['created_at'],
    ];
}

/** Fetch one shaped advance by id. (LEFT JOIN workers — advance may have no worker.) */
function fetch_advance(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT ca.id, ca.project_id, ca.worker_id,
               p.name AS project_name, p.slug AS project_slug,
               w.name AS worker_name, w.designation,
               ca.period_start, ca.period_end, ca.amount,
               ca.note, ca.created_at
        FROM cash_advances ca
        JOIN projects p ON p.id = ca.project_id
        LEFT JOIN workers w ON w.id = ca.worker_id
        WHERE ca.id = ?
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_advance($row) : null;
}

/** Parse a non-negative numeric value, or return null on invalid/blank. */
function nn_num($v): ?float
{
    if ($v === null || $v === '' || !is_numeric($v)) {
        return null;
    }
    $f = (float) $v;
    if ($f < 0) {
        return null;
    }
    return $f;
}

// ===========================================================================
// GET — list + summary (optional filters)
// ===========================================================================
if ($method === 'GET') {
    $where  = [];
    $params = [];

    if ((isset($_GET['project_id']) && $_GET['project_id'] !== '') ||
        (isset($_GET['project_slug']) && $_GET['project_slug'] !== '')) {
        $projectId = resolve_project_id($pdo, $_GET);
        if ($projectId <= 0) {
            json_out(['error' => 'a valid project is required'], 422);
        }
        $where[]  = 'ca.project_id = ?';
        $params[] = $projectId;
    }

    if (isset($_GET['worker_id']) && $_GET['worker_id'] !== '') {
        $workerId = (int) $_GET['worker_id'];
        if ($workerId > 0) {
            $where[]  = 'ca.worker_id = ?';
            $params[] = $workerId;
        }
    }

    // Overlap semantics:
    //   entry.period_end   >= filter.period_start
    //   entry.period_start <= filter.period_end
    $filterStart = isset($_GET['period_start']) && $_GET['period_start'] !== ''
        ? valid_date(nstr($_GET['period_start']))
        : null;
    $filterEnd = isset($_GET['period_end']) && $_GET['period_end'] !== ''
        ? valid_date(nstr($_GET['period_end']))
        : null;

    if ($filterStart !== null) {
        $where[]  = 'ca.period_end >= ?';
        $params[] = $filterStart;
    }
    if ($filterEnd !== null) {
        $where[]  = 'ca.period_start <= ?';
        $params[] = $filterEnd;
    }

    $sql = "
        SELECT ca.id, ca.project_id, ca.worker_id,
               p.name AS project_name, p.slug AS project_slug,
               w.name AS worker_name, w.designation,
               ca.period_start, ca.period_end, ca.amount,
               ca.note, ca.created_at
        FROM cash_advances ca
        INNER JOIN projects p ON p.id = ca.project_id
        LEFT JOIN  workers  w ON w.id = ca.worker_id
    ";
    if (!empty($where)) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY ca.period_start IS NULL, ca.period_start DESC, ca.id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $items = [];
    $count = 0;
    $total = 0.0;
    foreach ($stmt->fetchAll() as $r) {
        $items[] = shape_advance($r);
        $count++;
        $total += (float) $r['amount'];
    }

    json_out([
        'items'   => $items,
        'summary' => [
            'count' => $count,
            'total' => number_format($total, 2, '.', ''),
        ],
    ]);
}

// ===========================================================================
// POST — add a cash advance
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    $projectId   = resolve_project_id($pdo, $b);
    // worker_id is OPTIONAL — an advance is per-project, not per-worker.
    $workerId    = isset($b['worker_id']) && $b['worker_id'] !== '' ? (int) $b['worker_id'] : 0;
    $periodStart = valid_date(nstr($b['period_start'] ?? null));
    $periodEnd   = valid_date(nstr($b['period_end'] ?? null));
    $amount      = nn_num($b['amount'] ?? null);
    $note        = nstr($b['note'] ?? null);

    if ($projectId <= 0) {
        json_out(['error' => 'a valid project is required'], 422);
    }
    if ($workerId > 0 && !worker_exists($pdo, $workerId)) {
        json_out(['error' => 'selected worker does not exist'], 422);
    }
    if ($amount === null) {
        json_out(['error' => 'amount is required and must be numeric (>= 0)'], 422);
    }

    // Mirror when only one date is provided.
    if ($periodStart === null && $periodEnd !== null) {
        $periodStart = $periodEnd;
    } elseif ($periodEnd === null && $periodStart !== null) {
        $periodEnd = $periodStart;
    }

    if ($periodStart !== null && $periodEnd !== null && $periodEnd < $periodStart) {
        json_out(['error' => 'end date is before start date'], 422);
    }

    $amountStr = number_format($amount, 2, '.', '');

    $stmt = $pdo->prepare("
        INSERT INTO cash_advances
            (project_id, worker_id, period_start, period_end, amount, note)
        VALUES (?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([$projectId, $workerId > 0 ? $workerId : null, $periodStart, $periodEnd, $amountStr, $note]);
    $id = (int) $pdo->lastInsertId();

    json_out(['ok' => true, 'item' => fetch_advance($pdo, $id)], 201);
}

// ===========================================================================
// PUT — update with fallback to existing values
// ===========================================================================
if ($method === 'PUT') {
    $b = read_json_body();
    $id = isset($b['id']) ? (int) $b['id'] : 0;
    if ($id <= 0) {
        json_out(['error' => 'id is required'], 422);
    }

    $existing = fetch_advance($pdo, $id);
    if (!$existing) {
        json_out(['error' => 'not found'], 404);
    }

    if (array_key_exists('project_id', $b) || array_key_exists('project_slug', $b)) {
        $projectId = resolve_project_id($pdo, $b);
        if ($projectId <= 0) {
            json_out(['error' => 'a valid project is required'], 422);
        }
    } else {
        $projectId = (int) $existing['project_id'];
    }

    if (array_key_exists('worker_id', $b)) {
        // Optional: '' / 0 / null clears the worker (advance becomes purely project-level).
        $workerId = ($b['worker_id'] === '' || $b['worker_id'] === null) ? 0 : (int) $b['worker_id'];
        if ($workerId > 0 && !worker_exists($pdo, $workerId)) {
            json_out(['error' => 'selected worker does not exist'], 422);
        }
    } else {
        $workerId = $existing['worker_id'] === null ? 0 : (int) $existing['worker_id'];
    }

    $startProvided = array_key_exists('period_start', $b);
    $endProvided   = array_key_exists('period_end', $b);

    if ($startProvided) {
        $periodStart = valid_date(nstr($b['period_start']));
    } else {
        $periodStart = $existing['period_start'];
    }

    if ($endProvided) {
        $periodEnd = valid_date(nstr($b['period_end']));
    } else {
        $periodEnd = $existing['period_end'];
    }

    // Mirror when only one date is provided (and the other was not preserved).
    if ($periodStart === null && $periodEnd !== null) {
        $periodStart = $periodEnd;
    } elseif ($periodEnd === null && $periodStart !== null) {
        $periodEnd = $periodStart;
    }

    if ($periodStart !== null && $periodEnd !== null && $periodEnd < $periodStart) {
        json_out(['error' => 'end date is before start date'], 422);
    }

    if (array_key_exists('amount', $b)) {
        $amount = nn_num($b['amount']);
        if ($amount === null) {
            json_out(['error' => 'amount must be numeric (>= 0)'], 422);
        }
    } else {
        $amount = (float) ($existing['amount'] ?? 0);
    }

    $note = array_key_exists('note', $b) ? nstr($b['note']) : $existing['note'];

    $amountStr = number_format($amount, 2, '.', '');

    $stmt = $pdo->prepare("
        UPDATE cash_advances
        SET project_id = ?, worker_id = ?, period_start = ?, period_end = ?,
            amount = ?, note = ?
        WHERE id = ?
    ");
    $stmt->execute([$projectId, $workerId > 0 ? $workerId : null, $periodStart, $periodEnd, $amountStr, $note, $id]);

    json_out(['ok' => true, 'item' => fetch_advance($pdo, $id)]);
}

// ===========================================================================
// DELETE — remove
// ===========================================================================
if ($method === 'DELETE') {
    $id = 0;
    if (isset($_GET['id']) && $_GET['id'] !== '') {
        $id = (int) $_GET['id'];
    } else {
        $b = read_json_body();
        $id = isset($b['id']) ? (int) $b['id'] : 0;
    }
    if ($id <= 0) {
        json_out(['error' => 'id is required'], 422);
    }

    $stmt = $pdo->prepare('DELETE FROM cash_advances WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id, 'deleted' => $stmt->rowCount()]);
}

json_out(['error' => 'method not allowed'], 405);
