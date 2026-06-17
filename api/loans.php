<?php
// api/loans.php — worker loans (manual payout amount each, optional project).
//   GET     ?worker_id= ?project_id= ?project_slug= ?q= ?from=YYYY-MM-DD ?to=YYYY-MM-DD
//             -> { items:[ <loan> ], summary:{count,total} }
//   POST    {worker_id, project_id?, loan_date?, amount, note?}
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

/** Resolve a project id from ?project_id= or ?project_slug=. 0 = none/invalid. */
function resolve_project_id(PDO $pdo, array $src): int
{
    if (isset($src['project_id']) && $src['project_id'] !== '' && $src['project_id'] !== null) {
        $pid = (int) $src['project_id'];
        if ($pid <= 0) {
            return 0;
        }
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

/**
 * Shape one joined loan row (money as STRING). Carries repayment rollup:
 *   paid_total   = SUM(loan_payments.amount) for this loan
 *   outstanding  = amount - paid_total  (clamped at 0; never negative)
 *   payment_count
 */
function shape_loan(array $r): array
{
    $amount      = (float) $r['amount'];
    $paid        = isset($r['paid_total']) ? (float) $r['paid_total'] : 0.0;
    $outstanding = $amount - $paid;
    if ($outstanding < 0) {
        $outstanding = 0.0;
    }
    return [
        'id'            => (int) $r['id'],
        'worker_id'     => (int) $r['worker_id'],
        'worker_name'   => $r['worker_name'],
        'designation'   => $r['designation'],
        'project_id'    => $r['project_id'] === null ? null : (int) $r['project_id'],
        'project_name'  => $r['project_name'],
        'project_slug'  => $r['project_slug'],
        'loan_date'     => $r['loan_date'],
        'amount'        => money_str($r['amount']),
        'paid_total'    => number_format($paid, 2, '.', ''),
        'outstanding'   => number_format($outstanding, 2, '.', ''),
        'payment_count' => isset($r['payment_count']) ? (int) $r['payment_count'] : 0,
        'note'          => $r['note'],
        'created_at'    => $r['created_at'],
    ];
}

/** Fetch one shaped loan by id (with repayment rollup). */
function fetch_loan(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT wl.id, wl.worker_id,
               w.name AS worker_name, w.designation,
               wl.project_id, p.name AS project_name, p.slug AS project_slug,
               wl.loan_date, wl.amount, wl.note, wl.created_at,
               COALESCE(lp.total, 0) AS paid_total,
               COALESCE(lp.cnt, 0)   AS payment_count
        FROM worker_loans wl
        JOIN workers w ON w.id = wl.worker_id
        LEFT JOIN projects p ON p.id = wl.project_id
        LEFT JOIN (SELECT loan_id, SUM(amount) AS total, COUNT(*) AS cnt
                   FROM loan_payments GROUP BY loan_id) lp ON lp.loan_id = wl.id
        WHERE wl.id = ?
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_loan($row) : null;
}

// ===========================================================================
// GET — list + summary (with optional filters)
// ===========================================================================
if ($method === 'GET') {
    $where = [];
    $args  = [];

    if (isset($_GET['worker_id']) && $_GET['worker_id'] !== '') {
        $wid = (int) $_GET['worker_id'];
        if ($wid > 0) {
            $where[] = 'wl.worker_id = ?';
            $args[]  = $wid;
        }
    }

    // Project filter is optional; only apply when caller supplied one.
    if (
        (isset($_GET['project_id'])   && $_GET['project_id']   !== '')
        || (isset($_GET['project_slug']) && $_GET['project_slug'] !== '')
    ) {
        $projectId = resolve_project_id($pdo, $_GET);
        if ($projectId <= 0) {
            json_out(['error' => 'a valid project is required'], 422);
        }
        $where[] = 'wl.project_id = ?';
        $args[]  = $projectId;
    }

    if (isset($_GET['q']) && trim((string) $_GET['q']) !== '') {
        $where[] = 'w.name LIKE ?';
        $args[]  = '%' . trim((string) $_GET['q']) . '%';
    }

    $from = valid_date(nstr($_GET['from'] ?? null));
    $to   = valid_date(nstr($_GET['to']   ?? null));
    if ($from !== null) {
        $where[] = 'wl.loan_date >= ?';
        $args[]  = $from;
    }
    if ($to !== null) {
        $where[] = 'wl.loan_date <= ?';
        $args[]  = $to;
    }

    $sql = "
        SELECT wl.id, wl.worker_id,
               w.name AS worker_name, w.designation,
               wl.project_id, p.name AS project_name, p.slug AS project_slug,
               wl.loan_date, wl.amount, wl.note, wl.created_at,
               COALESCE(lp.total, 0) AS paid_total,
               COALESCE(lp.cnt, 0)   AS payment_count
        FROM worker_loans wl
        JOIN workers w ON w.id = wl.worker_id
        LEFT JOIN projects p ON p.id = wl.project_id
        LEFT JOIN (SELECT loan_id, SUM(amount) AS total, COUNT(*) AS cnt
                   FROM loan_payments GROUP BY loan_id) lp ON lp.loan_id = wl.id
    ";
    if (!empty($where)) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY wl.loan_date IS NULL, wl.loan_date DESC, wl.id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($args);

    $items       = [];
    $count       = 0;
    $total       = 0.0;   // total loaned (principal)
    $paid        = 0.0;   // total repaid
    $outstanding = 0.0;   // sum of per-loan outstanding (each clamped >= 0)
    foreach ($stmt->fetchAll() as $r) {
        $shaped = shape_loan($r);
        $items[] = $shaped;
        $count++;
        $total       += (float) $r['amount'];
        $paid        += (float) $shaped['paid_total'];
        $outstanding += (float) $shaped['outstanding'];
    }

    json_out([
        'items'   => $items,
        'summary' => [
            'count'             => $count,
            'total'             => number_format($total, 2, '.', ''),
            'total_loaned'      => number_format($total, 2, '.', ''),
            'total_paid'        => number_format($paid, 2, '.', ''),
            'total_outstanding' => number_format($outstanding, 2, '.', ''),
        ],
    ]);
}

// ===========================================================================
// POST — add a worker loan
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    $workerId = isset($b['worker_id']) ? (int) $b['worker_id'] : 0;
    if ($workerId <= 0 || !worker_exists($pdo, $workerId)) {
        json_out(['error' => 'a valid worker is required'], 422);
    }

    // Project is optional. Null/empty -> NULL. If provided, must resolve.
    $projectId = null;
    $hasProj = (array_key_exists('project_id', $b)   && $b['project_id']   !== null && $b['project_id']   !== '')
        || (array_key_exists('project_slug', $b) && $b['project_slug'] !== null && $b['project_slug'] !== '');
    if ($hasProj) {
        $pid = resolve_project_id($pdo, $b);
        if ($pid <= 0) {
            json_out(['error' => 'a valid project is required'], 422);
        }
        $projectId = $pid;
    }

    $loanDate = valid_date(nstr($b['loan_date'] ?? null));
    $amount   = nn_num($b['amount'] ?? null);
    $note     = nstr($b['note'] ?? null);

    if ($amount === null) {
        json_out(['error' => 'amount is required and must be numeric (>= 0)'], 422);
    }

    $amountStr = number_format($amount, 2, '.', '');

    $stmt = $pdo->prepare("
        INSERT INTO worker_loans (worker_id, project_id, loan_date, amount, note)
        VALUES (?, ?, ?, ?, ?)
    ");
    $stmt->execute([$workerId, $projectId, $loanDate, $amountStr, $note]);
    $id = (int) $pdo->lastInsertId();

    json_out(['ok' => true, 'item' => fetch_loan($pdo, $id)], 201);
}

// ===========================================================================
// PUT — update with fallback
// ===========================================================================
if ($method === 'PUT') {
    $b  = read_json_body();
    $id = isset($b['id']) ? (int) $b['id'] : 0;
    if ($id <= 0) {
        json_out(['error' => 'id is required'], 422);
    }

    $existing = fetch_loan($pdo, $id);
    if (!$existing) {
        json_out(['error' => 'not found'], 404);
    }

    if (array_key_exists('worker_id', $b)) {
        $workerId = (int) $b['worker_id'];
        if ($workerId <= 0 || !worker_exists($pdo, $workerId)) {
            json_out(['error' => 'a valid worker is required'], 422);
        }
    } else {
        $workerId = (int) $existing['worker_id'];
    }

    // Project: explicit null/empty -> NULL; provided value must resolve; absent -> unchanged.
    if (array_key_exists('project_id', $b) || array_key_exists('project_slug', $b)) {
        $pidRaw  = $b['project_id']   ?? null;
        $slugRaw = $b['project_slug'] ?? null;
        if (
            ($pidRaw === null  || $pidRaw  === '')
            && ($slugRaw === null || $slugRaw === '')
        ) {
            $projectId = null;
        } else {
            $pid = resolve_project_id($pdo, $b);
            if ($pid <= 0) {
                json_out(['error' => 'a valid project is required'], 422);
            }
            $projectId = $pid;
        }
    } else {
        $projectId = $existing['project_id'];
    }

    if (array_key_exists('loan_date', $b)) {
        $loanDate = valid_date(nstr($b['loan_date']));
    } else {
        $loanDate = $existing['loan_date'];
    }

    if (array_key_exists('amount', $b)) {
        $amount = nn_num($b['amount']);
        if ($amount === null) {
            json_out(['error' => 'amount must be numeric (>= 0)'], 422);
        }
        $amountStr = number_format($amount, 2, '.', '');
    } else {
        $amountStr = money_str($existing['amount']);
    }

    $note = array_key_exists('note', $b) ? nstr($b['note']) : $existing['note'];

    $stmt = $pdo->prepare("
        UPDATE worker_loans
        SET worker_id = ?, project_id = ?, loan_date = ?, amount = ?, note = ?
        WHERE id = ?
    ");
    $stmt->execute([$workerId, $projectId, $loanDate, $amountStr, $note, $id]);

    json_out(['ok' => true, 'item' => fetch_loan($pdo, $id)]);
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

    $stmt = $pdo->prepare('DELETE FROM worker_loans WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id, 'deleted' => $stmt->rowCount()]);
}

json_out(['error' => 'method not allowed'], 405);
