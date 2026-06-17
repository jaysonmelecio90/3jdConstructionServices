<?php
// api/loan-payments.php — manual repayments booked against a worker_loan.
//   A loan's outstanding = worker_loans.amount - SUM(loan_payments.amount).
//   GET     ?loan_id=N   -> { loan:{id,worker_name,amount,paid_total,outstanding},
//                             items:[ <payment> ], summary:{count,total} }
//   POST    {loan_id, payment_date?, amount, note?}   -> { ok, item } 201
//   PUT     {id, ...partial}                          -> { ok, item }
//   DELETE  ?id= | {id}                               -> { ok, id, deleted }
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

/** Fetch the parent loan with its repayment rollup, or null. */
function fetch_loan_brief(PDO $pdo, int $loanId): ?array
{
    $stmt = $pdo->prepare("
        SELECT wl.id, wl.amount, w.name AS worker_name,
               COALESCE(lp.total, 0) AS paid_total
        FROM worker_loans wl
        JOIN workers w ON w.id = wl.worker_id
        LEFT JOIN (SELECT loan_id, SUM(amount) AS total FROM loan_payments GROUP BY loan_id) lp
               ON lp.loan_id = wl.id
        WHERE wl.id = ?
        LIMIT 1
    ");
    $stmt->execute([$loanId]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    $amount      = (float) $row['amount'];
    $paid        = (float) $row['paid_total'];
    $outstanding = $amount - $paid;
    if ($outstanding < 0) {
        $outstanding = 0.0;
    }
    return [
        'id'          => (int) $row['id'],
        'worker_name' => $row['worker_name'],
        'amount'      => money_str($row['amount']),
        'paid_total'  => number_format($paid, 2, '.', ''),
        'outstanding' => number_format($outstanding, 2, '.', ''),
    ];
}

/**
 * Loan principal + repayments already booked (optionally excluding one payment
 * id, for PUT). Returns [principal|null, paidByOthers]. null principal = no loan.
 */
function loan_caps(PDO $pdo, int $loanId, int $exceptId = 0): array
{
    $stmt = $pdo->prepare('SELECT amount FROM worker_loans WHERE id = ? LIMIT 1');
    $stmt->execute([$loanId]);
    $principal = $stmt->fetchColumn();
    if ($principal === false) {
        return [null, 0.0];
    }
    $sql = 'SELECT COALESCE(SUM(amount), 0) FROM loan_payments WHERE loan_id = ?';
    $params = [$loanId];
    if ($exceptId > 0) {
        $sql .= ' AND id <> ?';
        $params[] = $exceptId;
    }
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return [(float) $principal, (float) $stmt->fetchColumn()];
}

/** Shape one payment row (money as STRING). */
function shape_payment(array $r): array
{
    return [
        'id'           => (int) $r['id'],
        'loan_id'      => (int) $r['loan_id'],
        'payment_date' => $r['payment_date'],
        'amount'       => money_str($r['amount']),
        'note'         => $r['note'],
        'created_at'   => $r['created_at'],
    ];
}

/** Fetch one shaped payment by id. */
function fetch_payment(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT id, loan_id, payment_date, amount, note, created_at
        FROM loan_payments WHERE id = ? LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_payment($row) : null;
}

// ===========================================================================
// GET — payments for one loan (+ loan brief)
// ===========================================================================
if ($method === 'GET') {
    $loanId = isset($_GET['loan_id']) ? (int) $_GET['loan_id'] : 0;
    if ($loanId <= 0) {
        json_out(['error' => 'loan_id is required'], 422);
    }
    $loan = fetch_loan_brief($pdo, $loanId);
    if (!$loan) {
        json_out(['error' => 'loan not found'], 404);
    }

    $stmt = $pdo->prepare("
        SELECT id, loan_id, payment_date, amount, note, created_at
        FROM loan_payments
        WHERE loan_id = ?
        ORDER BY payment_date IS NULL, payment_date DESC, id DESC
    ");
    $stmt->execute([$loanId]);

    $items = [];
    $count = 0;
    $total = 0.0;
    foreach ($stmt->fetchAll() as $r) {
        $items[] = shape_payment($r);
        $count++;
        $total += (float) $r['amount'];
    }

    json_out([
        'loan'    => $loan,
        'items'   => $items,
        'summary' => [
            'count' => $count,
            'total' => number_format($total, 2, '.', ''),
        ],
    ]);
}

// ===========================================================================
// POST — add a repayment
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    $loanId = isset($b['loan_id']) ? (int) $b['loan_id'] : 0;
    if ($loanId <= 0 || !fetch_loan_brief($pdo, $loanId)) {
        json_out(['error' => 'a valid loan is required'], 422);
    }

    $paymentDate = valid_date(nstr($b['payment_date'] ?? null));
    $amount      = nn_num($b['amount'] ?? null);
    $note        = nstr($b['note'] ?? null);

    if ($amount === null) {
        json_out(['error' => 'amount is required and must be numeric (>= 0)'], 422);
    }

    // A repayment can never exceed the loan's outstanding balance.
    [$principal, $paidByOthers] = loan_caps($pdo, $loanId);
    if ($principal !== null && ($paidByOthers + $amount) > $principal + 0.005) {
        $remaining = max(0, $principal - $paidByOthers);
        json_out(['error' => 'repayment exceeds the outstanding balance (₱' . number_format($remaining, 2) . ' left)'], 422);
    }

    $amountStr = number_format($amount, 2, '.', '');

    $stmt = $pdo->prepare("
        INSERT INTO loan_payments (loan_id, payment_date, amount, note)
        VALUES (?, ?, ?, ?)
    ");
    $stmt->execute([$loanId, $paymentDate, $amountStr, $note]);
    $id = (int) $pdo->lastInsertId();

    json_out(['ok' => true, 'item' => fetch_payment($pdo, $id), 'loan' => fetch_loan_brief($pdo, $loanId)], 201);
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

    $existing = fetch_payment($pdo, $id);
    if (!$existing) {
        json_out(['error' => 'not found'], 404);
    }

    // loan_id is normally fixed; allow re-pointing only to a valid loan.
    if (array_key_exists('loan_id', $b)) {
        $loanId = (int) $b['loan_id'];
        if ($loanId <= 0 || !fetch_loan_brief($pdo, $loanId)) {
            json_out(['error' => 'a valid loan is required'], 422);
        }
    } else {
        $loanId = (int) $existing['loan_id'];
    }

    if (array_key_exists('payment_date', $b)) {
        $paymentDate = valid_date(nstr($b['payment_date']));
    } else {
        $paymentDate = $existing['payment_date'];
    }

    if (array_key_exists('amount', $b)) {
        $amount = nn_num($b['amount']);
        if ($amount === null) {
            json_out(['error' => 'amount must be numeric (>= 0)'], 422);
        }
        $amountStr = number_format($amount, 2, '.', '');
    } else {
        $amount    = (float) $existing['amount'];
        $amountStr = money_str($existing['amount']);
    }

    // A repayment can never exceed the loan's outstanding balance (excluding this row).
    [$principal, $paidByOthers] = loan_caps($pdo, $loanId, $id);
    if ($principal !== null && ($paidByOthers + $amount) > $principal + 0.005) {
        $remaining = max(0, $principal - $paidByOthers);
        json_out(['error' => 'repayment exceeds the outstanding balance (₱' . number_format($remaining, 2) . ' left)'], 422);
    }

    $note = array_key_exists('note', $b) ? nstr($b['note']) : $existing['note'];

    $stmt = $pdo->prepare("
        UPDATE loan_payments
        SET loan_id = ?, payment_date = ?, amount = ?, note = ?
        WHERE id = ?
    ");
    $stmt->execute([$loanId, $paymentDate, $amountStr, $note, $id]);

    json_out(['ok' => true, 'item' => fetch_payment($pdo, $id), 'loan' => fetch_loan_brief($pdo, $loanId)]);
}

// ===========================================================================
// DELETE — remove a repayment
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

    $existing = fetch_payment($pdo, $id);
    $loanId   = $existing ? (int) $existing['loan_id'] : 0;

    $stmt = $pdo->prepare('DELETE FROM loan_payments WHERE id = ?');
    $stmt->execute([$id]);

    json_out([
        'ok'      => true,
        'id'      => $id,
        'deleted' => $stmt->rowCount(),
        'loan'    => $loanId > 0 ? fetch_loan_brief($pdo, $loanId) : null,
    ]);
}

json_out(['error' => 'method not allowed'], 405);
