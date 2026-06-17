<?php
// api/incomes.php — company-wide Income ledger CRUD.
//   GET     ?project_id= | ?project_slug= | ?q= (payer/reference/note)
//           ?from=YYYY-MM-DD | ?to=YYYY-MM-DD
//             -> { items:[ <income> ], summary:{count,total} }
//   POST    {project_id?, income_date?, amount, payer?, method?, reference?, note?}
//             -> { ok, item } 201
//   PUT     {id, ...partial}                                  -> { ok, item }
//   DELETE  ?id= | {id}                                       -> { ok, id, deleted }
// Session-based auth. project_id may be NULL. Money returned as STRINGS.
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

/** Validate that a project id exists. */
function project_exists(PDO $pdo, int $projectId): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM projects WHERE id = ? LIMIT 1');
    $stmt->execute([$projectId]);
    return (bool) $stmt->fetchColumn();
}

/** Resolve a project id from ?project_id= or ?project_slug= (0 if none/missing). */
function resolve_project_id_filter(PDO $pdo, array $src): int
{
    if (isset($src['project_id']) && $src['project_id'] !== '') {
        $pid = (int) $src['project_id'];
        return project_exists($pdo, $pid) ? $pid : 0;
    }
    if (isset($src['project_slug']) && $src['project_slug'] !== '') {
        $stmt = $pdo->prepare('SELECT id FROM projects WHERE slug = ? LIMIT 1');
        $stmt->execute([trim((string) $src['project_slug'])]);
        $row = $stmt->fetchColumn();
        return $row ? (int) $row : 0;
    }
    return 0;
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

/** Shape one joined income row (money as STRING). */
function shape_income(array $r): array
{
    return [
        'id'           => (int) $r['id'],
        'project_id'   => $r['project_id'] === null ? null : (int) $r['project_id'],
        'project_name' => $r['project_name'],
        'project_slug' => $r['project_slug'],
        'income_date'  => $r['income_date'],
        'amount'       => money_str($r['amount']),
        'payer'        => $r['payer'],
        'method'       => $r['method'],
        'reference'    => $r['reference'],
        'note'         => $r['note'],
        'created_at'   => $r['created_at'],
    ];
}

/** Fetch one shaped income by id (LEFT JOIN — project may be null). */
function fetch_income(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT i.id, i.project_id,
               p.name AS project_name, p.slug AS project_slug,
               i.income_date, i.amount, i.payer, i.method,
               i.reference, i.note, i.created_at
        FROM incomes i
        LEFT JOIN projects p ON p.id = i.project_id
        WHERE i.id = ?
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_income($row) : null;
}

// ===========================================================================
// GET — list + summary
// ===========================================================================
if ($method === 'GET') {
    $where  = [];
    $params = [];

    if ((isset($_GET['project_id']) && $_GET['project_id'] !== '') ||
        (isset($_GET['project_slug']) && $_GET['project_slug'] !== '')) {
        $projectId = resolve_project_id_filter($pdo, $_GET);
        if ($projectId <= 0) {
            json_out(['error' => 'a valid project is required'], 422);
        }
        $where[]  = 'i.project_id = ?';
        $params[] = $projectId;
    }

    if (isset($_GET['q']) && trim((string) $_GET['q']) !== '') {
        $where[] = '(i.payer LIKE ? OR i.reference LIKE ? OR i.note LIKE ?)';
        $like = '%' . trim((string) $_GET['q']) . '%';
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;
    }

    if (isset($_GET['from']) && $_GET['from'] !== '') {
        $from = valid_date(nstr($_GET['from']));
        if ($from !== null) {
            $where[]  = 'i.income_date >= ?';
            $params[] = $from;
        }
    }

    if (isset($_GET['to']) && $_GET['to'] !== '') {
        $to = valid_date(nstr($_GET['to']));
        if ($to !== null) {
            $where[]  = 'i.income_date <= ?';
            $params[] = $to;
        }
    }

    $sql = "
        SELECT i.id, i.project_id,
               p.name AS project_name, p.slug AS project_slug,
               i.income_date, i.amount, i.payer, i.method,
               i.reference, i.note, i.created_at
        FROM incomes i
        LEFT JOIN projects p ON p.id = i.project_id
    ";
    if (!empty($where)) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY i.income_date IS NULL, i.income_date DESC, i.id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $items = [];
    $count = 0;
    $total = 0.0;
    foreach ($stmt->fetchAll() as $r) {
        $items[] = shape_income($r);
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
// POST — add an income
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    // project_id is optional — may be null/empty/0 -> NULL. If given, must exist.
    $projectId = null;
    if (array_key_exists('project_id', $b) && $b['project_id'] !== null && $b['project_id'] !== '') {
        $pid = (int) $b['project_id'];
        if ($pid <= 0 || !project_exists($pdo, $pid)) {
            json_out(['error' => 'project_id does not exist'], 422);
        }
        $projectId = $pid;
    }

    $incomeDate = valid_date(nstr($b['income_date'] ?? null));
    $amount     = nn_num($b['amount'] ?? null);
    $payer      = nstr($b['payer'] ?? null);
    $methodVal  = nstr($b['method'] ?? null);
    $reference  = nstr($b['reference'] ?? null);
    $note       = nstr($b['note'] ?? null);

    if ($amount === null) {
        json_out(['error' => 'amount is required and must be numeric (>= 0)'], 422);
    }

    $amountStr = number_format($amount, 2, '.', '');

    $stmt = $pdo->prepare("
        INSERT INTO incomes
            (project_id, income_date, amount, payer, method, reference, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([$projectId, $incomeDate, $amountStr, $payer, $methodVal, $reference, $note]);
    $id = (int) $pdo->lastInsertId();

    json_out(['ok' => true, 'item' => fetch_income($pdo, $id)], 201);
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

    $existing = fetch_income($pdo, $id);
    if (!$existing) {
        json_out(['error' => 'not found'], 404);
    }

    if (array_key_exists('project_id', $b)) {
        if ($b['project_id'] === null || $b['project_id'] === '' || (int) $b['project_id'] <= 0) {
            $projectId = null;
        } else {
            $pid = (int) $b['project_id'];
            if (!project_exists($pdo, $pid)) {
                json_out(['error' => 'project_id does not exist'], 422);
            }
            $projectId = $pid;
        }
    } else {
        $projectId = $existing['project_id'];
    }

    if (array_key_exists('income_date', $b)) {
        $incomeDate = valid_date(nstr($b['income_date']));
    } else {
        $incomeDate = $existing['income_date'];
    }

    if (array_key_exists('amount', $b)) {
        $amount = nn_num($b['amount']);
        if ($amount === null) {
            json_out(['error' => 'amount must be numeric (>= 0)'], 422);
        }
    } else {
        $amount = (float) ($existing['amount'] ?? 0);
    }
    $amountStr = number_format($amount, 2, '.', '');

    $payer     = array_key_exists('payer', $b)     ? nstr($b['payer'])     : $existing['payer'];
    $methodVal = array_key_exists('method', $b)    ? nstr($b['method'])    : $existing['method'];
    $reference = array_key_exists('reference', $b) ? nstr($b['reference']) : $existing['reference'];
    $note      = array_key_exists('note', $b)      ? nstr($b['note'])      : $existing['note'];

    $stmt = $pdo->prepare("
        UPDATE incomes
        SET project_id = ?, income_date = ?, amount = ?, payer = ?,
            method = ?, reference = ?, note = ?
        WHERE id = ?
    ");
    $stmt->execute([$projectId, $incomeDate, $amountStr, $payer, $methodVal, $reference, $note, $id]);

    json_out(['ok' => true, 'item' => fetch_income($pdo, $id)]);
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

    $stmt = $pdo->prepare('DELETE FROM incomes WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id, 'deleted' => $stmt->rowCount()]);
}

json_out(['error' => 'method not allowed'], 405);
