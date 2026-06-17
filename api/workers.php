<?php
// api/workers.php — Workers Directory CRUD.
//   GET     -> list (optional ?q= search name/designation/phone/email, ?status=active|inactive)
//              each row carries project_count (DISTINCT projects via project_workers)
//   POST    -> add  (JSON body; name required; hourly_rate/daily_rate optional but numeric>=0)
//   PUT     -> edit (JSON body, requires id; falls back to existing values)
//   DELETE  -> remove (?id= or JSON body { id }); 409 if worker has payroll_entries or loans.
// Same-origin, session auth (consistent with the rest of the data API).
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$pdo = db();

$STATUSES = ['active', 'inactive'];
$TYPES    = ['field', 'admin'];

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

/**
 * Parse an optional rate (hourly/daily). Returns:
 *   - [true, null]              if not provided / empty string  (use existing / null)
 *   - [true, '0.00'..]          if a valid numeric >= 0
 *   - [false, null]             if invalid (caller should 422)
 * Stored/returned as DECIMAL string to match the rest of the API.
 */
function parse_rate($v): array
{
    if ($v === null) {
        return [true, null];
    }
    if (is_string($v) && trim($v) === '') {
        return [true, null];
    }
    if (!is_numeric($v)) {
        return [false, null];
    }
    $f = (float) $v;
    if ($f < 0) {
        return [false, null];
    }
    return [true, number_format(round($f, 2), 2, '.', '')];
}

/** Shape a raw joined row into the canonical worker object. */
function shape_worker(array $r): array
{
    return [
        'id'            => (int) $r['id'],
        'name'          => $r['name'],
        'designation'   => $r['designation'],
        'type'          => $r['type'] ?? 'field',
        'hourly_rate'   => $r['hourly_rate'] === null ? null : (string) $r['hourly_rate'],
        'daily_rate'    => $r['daily_rate']  === null ? null : (string) $r['daily_rate'],
        'phone'         => $r['phone'],
        'email'         => $r['email'],
        'status'        => $r['status'],
        'created_at'    => $r['created_at'],
        'project_count' => (int) $r['project_count'],
    ];
}

/** SELECT one shaped worker by id (with project_count). */
function fetch_worker(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT w.id, w.name, w.designation, w.type, w.hourly_rate, w.daily_rate,
               w.phone, w.email, w.status, w.created_at,
               COUNT(DISTINCT pw.project_id) AS project_count
        FROM workers w
        LEFT JOIN project_workers pw ON pw.worker_id = w.id
        WHERE w.id = ?
        GROUP BY w.id, w.name, w.designation, w.type, w.hourly_rate, w.daily_rate,
                 w.phone, w.email, w.status, w.created_at
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_worker($row) : null;
}

// ===========================================================================
// GET — list
// ===========================================================================
if ($method === 'GET') {
    $where = [];
    $args = [];

    if (isset($_GET['q']) && trim((string) $_GET['q']) !== '') {
        $where[] = '(w.name LIKE ? OR w.designation LIKE ? OR w.phone LIKE ? OR w.email LIKE ?)';
        $like = '%' . trim((string) $_GET['q']) . '%';
        $args[] = $like;
        $args[] = $like;
        $args[] = $like;
        $args[] = $like;
    }
    if (isset($_GET['status']) && in_array($_GET['status'], $STATUSES, true)) {
        $where[] = 'w.status = ?';
        $args[] = $_GET['status'];
    }
    if (isset($_GET['type']) && in_array($_GET['type'], $TYPES, true)) {
        $where[] = 'w.type = ?';
        $args[] = $_GET['type'];
    }

    $sql = "
        SELECT w.id, w.name, w.designation, w.type, w.hourly_rate, w.daily_rate,
               w.phone, w.email, w.status, w.created_at,
               COUNT(DISTINCT pw.project_id) AS project_count
        FROM workers w
        LEFT JOIN project_workers pw ON pw.worker_id = w.id
    ";
    if ($where) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= "
        GROUP BY w.id, w.name, w.designation, w.type, w.hourly_rate, w.daily_rate,
                 w.phone, w.email, w.status, w.created_at
        ORDER BY (w.status = 'active') DESC, w.name ASC
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($args);

    $items = [];
    $count = 0;
    $activeCount = 0;
    $inactiveCount = 0;
    $adminCount = 0;
    $fieldCount = 0;
    foreach ($stmt->fetchAll() as $r) {
        $items[] = shape_worker($r);
        $count++;
        $isActive = $r['status'] === 'active';
        if ($isActive) {
            $activeCount++;
        } elseif ($r['status'] === 'inactive') {
            $inactiveCount++;
        }
        if ($isActive && ($r['type'] ?? 'field') === 'admin') {
            $adminCount++;
        } elseif ($isActive) {
            $fieldCount++;
        }
    }

    json_out([
        'items'   => $items,
        'summary' => [
            'count'          => $count,
            'active_count'   => $activeCount,
            'inactive_count' => $inactiveCount,
            'admin_count'    => $adminCount,
            'field_count'    => $fieldCount,
        ],
    ]);
}

// ===========================================================================
// POST — add
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    $name        = nstr($b['name'] ?? null);
    $designation = nstr($b['designation'] ?? null);
    $phone       = nstr($b['phone'] ?? null);
    $email       = nstr($b['email'] ?? null);
    $status      = (isset($b['status']) && in_array($b['status'], $STATUSES, true)) ? $b['status'] : 'active';
    $type        = 'field';
    if (array_key_exists('type', $b) && $b['type'] !== null && $b['type'] !== '') {
        if (!in_array($b['type'], $TYPES, true)) {
            json_out(['error' => 'type must be field or admin'], 422);
        }
        $type = $b['type'];
    }

    if ($name === null) {
        json_out(['error' => 'name is required'], 422);
    }

    [$hrOk, $hourly] = parse_rate($b['hourly_rate'] ?? null);
    if (!$hrOk) {
        json_out(['error' => 'hourly_rate must be a non-negative number'], 422);
    }
    [$drOk, $daily] = parse_rate($b['daily_rate'] ?? null);
    if (!$drOk) {
        json_out(['error' => 'daily_rate must be a non-negative number'], 422);
    }

    $stmt = $pdo->prepare("
        INSERT INTO workers (name, designation, type, hourly_rate, daily_rate, phone, email, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([$name, $designation, $type, $hourly, $daily, $phone, $email, $status]);
    $id = (int) $pdo->lastInsertId();

    json_out(['ok' => true, 'item' => fetch_worker($pdo, $id)], 201);
}

// ===========================================================================
// PUT — edit
// ===========================================================================
if ($method === 'PUT') {
    $b = read_json_body();
    $id = isset($b['id']) ? (int) $b['id'] : 0;
    if ($id <= 0) {
        json_out(['error' => 'id is required'], 422);
    }

    $existing = fetch_worker($pdo, $id);
    if (!$existing) {
        json_out(['error' => 'not found'], 404);
    }

    // Apply provided fields, falling back to current values.
    $name        = array_key_exists('name', $b) ? nstr($b['name']) : $existing['name'];
    $designation = array_key_exists('designation', $b) ? nstr($b['designation']) : $existing['designation'];
    $phone       = array_key_exists('phone', $b) ? nstr($b['phone']) : $existing['phone'];
    $email       = array_key_exists('email', $b) ? nstr($b['email']) : $existing['email'];
    $status      = (isset($b['status']) && in_array($b['status'], $STATUSES, true)) ? $b['status'] : $existing['status'];
    if (array_key_exists('type', $b) && $b['type'] !== null && $b['type'] !== '') {
        if (!in_array($b['type'], $TYPES, true)) {
            json_out(['error' => 'type must be field or admin'], 422);
        }
        $type = $b['type'];
    } else {
        $type = $existing['type'] ?? 'field';
    }

    if (array_key_exists('hourly_rate', $b)) {
        [$hrOk, $hourly] = parse_rate($b['hourly_rate']);
        if (!$hrOk) {
            json_out(['error' => 'hourly_rate must be a non-negative number'], 422);
        }
    } else {
        $hourly = $existing['hourly_rate'];
    }
    if (array_key_exists('daily_rate', $b)) {
        [$drOk, $daily] = parse_rate($b['daily_rate']);
        if (!$drOk) {
            json_out(['error' => 'daily_rate must be a non-negative number'], 422);
        }
    } else {
        $daily = $existing['daily_rate'];
    }

    if ($name === null) {
        json_out(['error' => 'name is required'], 422);
    }

    $stmt = $pdo->prepare("
        UPDATE workers
        SET name = ?, designation = ?, type = ?, hourly_rate = ?, daily_rate = ?,
            phone = ?, email = ?, status = ?
        WHERE id = ?
    ");
    $stmt->execute([$name, $designation, $type, $hourly, $daily, $phone, $email, $status, $id]);

    json_out(['ok' => true, 'item' => fetch_worker($pdo, $id)]);
}

// ===========================================================================
// DELETE — remove (guard against payroll history)
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

    // Block delete if any payroll entries reference this worker.
    $chk = $pdo->prepare('SELECT 1 FROM payroll_entries WHERE worker_id = ? LIMIT 1');
    $chk->execute([$id]);
    if ($chk->fetchColumn()) {
        json_out(['error' => 'cannot delete: worker has payroll entries'], 409);
    }

    // Block delete if the worker has loans — the FK cascades, so deleting would
    // silently wipe the loans and their repayment history (incl. outstanding balances).
    $chkLoan = $pdo->prepare('SELECT 1 FROM worker_loans WHERE worker_id = ? LIMIT 1');
    $chkLoan->execute([$id]);
    if ($chkLoan->fetchColumn()) {
        json_out(['error' => 'cannot delete: worker has loans'], 409);
    }

    // project_workers cascades on FK; no manual cleanup needed.
    $stmt = $pdo->prepare('DELETE FROM workers WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id, 'deleted' => $stmt->rowCount()]);
}

json_out(['error' => 'method not allowed'], 405);
