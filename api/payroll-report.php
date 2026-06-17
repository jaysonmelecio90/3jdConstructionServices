<?php
// api/payroll-report.php — Payroll Report for a project over a payroll period.
//   GET ?project_id=N&period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
//         -> {
//              project:       { id, name, slug },
//              summary:       { period:{start,end}, gross_regular, gross_overtime,
//                               gross_total, advances_total, net,
//                               payroll_count, advances_count, worker_count },
//              workers:       [ { worker_id, worker_name, designation,
//                                 regular_total, overtime_total, gross_total } ],
//              payroll_items: [ <full payroll entry shape> ],
//              advances:      [ { id, worker_id, worker_name, designation,
//                                 period_start, period_end, amount, note } ]
//            }
// Cash advances are PER-PROJECT: they are deducted from the project's OVERALL
// payroll cost for the period (summary.net = gross_total - advances_total),
// NOT attributed to individual workers. The per-worker rows carry gross only.
// Session-based auth. Money returned as STRINGS via money_str().
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET') {
    json_out(['error' => 'method not allowed'], 405);
}

$pdo = db();

/** Trim a value to a non-empty string, or null. */
function nstr_pr($v): ?string
{
    if ($v === null) {
        return null;
    }
    $s = trim((string) $v);
    return $s === '' ? null : $s;
}

/** Validate a 'YYYY-MM-DD' date string; return it, or null. */
function valid_date_pr(?string $s): ?string
{
    if ($s === null || $s === '') {
        return null;
    }
    $d = DateTime::createFromFormat('Y-m-d', $s);
    return ($d && $d->format('Y-m-d') === $s) ? $s : null;
}

// ---------------------------------------------------------------------------
// Validate query parameters.
// ---------------------------------------------------------------------------
$projectId   = isset($_GET['project_id']) ? (int) $_GET['project_id'] : 0;
$rawStart    = nstr_pr($_GET['period_start'] ?? null);
$rawEnd      = nstr_pr($_GET['period_end']   ?? null);

if ($projectId <= 0) {
    json_out(['error' => 'project_id is required'], 422);
}
if ($rawStart === null) {
    json_out(['error' => 'period_start is required'], 422);
}
if ($rawEnd === null) {
    json_out(['error' => 'period_end is required'], 422);
}
$periodStart = valid_date_pr($rawStart);
$periodEnd   = valid_date_pr($rawEnd);
if ($periodStart === null) {
    json_out(['error' => 'period_start must be YYYY-MM-DD'], 422);
}
if ($periodEnd === null) {
    json_out(['error' => 'period_end must be YYYY-MM-DD'], 422);
}
if ($periodEnd < $periodStart) {
    json_out(['error' => 'end date is before start date'], 422);
}

// ---------------------------------------------------------------------------
// 1. Resolve project (404 if missing).
// ---------------------------------------------------------------------------
$stmt = $pdo->prepare('SELECT id, name, slug FROM projects WHERE id = ? LIMIT 1');
$stmt->execute([$projectId]);
$project = $stmt->fetch();
if (!$project) {
    json_out(['error' => 'not found'], 404);
}

// ---------------------------------------------------------------------------
// 2. Payroll entries overlapping the query period.
//    Overlap: entry.period_end >= query.period_start
//         AND entry.period_start <= query.period_end
// ---------------------------------------------------------------------------
$stmt = $pdo->prepare("
    SELECT pe.id, pe.project_id, pe.worker_id,
           w.name AS worker_name, w.designation,
           pe.period_start, pe.period_end,
           pe.rate_type,
           pe.regular_units, pe.regular_rate, pe.regular_amount,
           pe.overtime_units, pe.overtime_rate, pe.overtime_amount,
           pe.amount, pe.note
    FROM payroll_entries pe
    JOIN workers w ON w.id = pe.worker_id
    WHERE pe.project_id = ?
      AND pe.period_end   >= ?
      AND pe.period_start <= ?
    ORDER BY w.name ASC, pe.period_start ASC, pe.id ASC
");
$stmt->execute([$projectId, $periodStart, $periodEnd]);
$payrollRows = $stmt->fetchAll();

$payrollItems = [];
foreach ($payrollRows as $r) {
    $payrollItems[] = [
        'id'              => (int) $r['id'],
        'worker_id'       => (int) $r['worker_id'],
        'worker_name'     => $r['worker_name'],
        'designation'     => $r['designation'],
        'period_start'    => $r['period_start'],
        'period_end'      => $r['period_end'],
        'rate_type'       => $r['rate_type'],
        'regular_units'   => $r['regular_units']   === null ? null : (string) $r['regular_units'],
        'regular_rate'    => $r['regular_rate']    === null ? null : (string) $r['regular_rate'],
        'regular_amount'  => money_str($r['regular_amount']),
        'overtime_units'  => $r['overtime_units']  === null ? null : (string) $r['overtime_units'],
        'overtime_rate'   => $r['overtime_rate']   === null ? null : (string) $r['overtime_rate'],
        'overtime_amount' => money_str($r['overtime_amount']),
        'amount'          => money_str($r['amount']),
        'note'            => $r['note'],
    ];
}

// ---------------------------------------------------------------------------
// 3. Cash advances overlapping the query period.
// ---------------------------------------------------------------------------
$stmt = $pdo->prepare("
    SELECT ca.id, ca.worker_id,
           w.name AS worker_name, w.designation,
           ca.period_start, ca.period_end,
           ca.amount, ca.note
    FROM cash_advances ca
    LEFT JOIN workers w ON w.id = ca.worker_id
    WHERE ca.project_id = ?
      AND ca.period_end   >= ?
      AND ca.period_start <= ?
    ORDER BY ca.period_start ASC, ca.id ASC
");
$stmt->execute([$projectId, $periodStart, $periodEnd]);
$advanceRows = $stmt->fetchAll();

$advances = [];
foreach ($advanceRows as $r) {
    $advances[] = [
        'id'           => (int) $r['id'],
        'worker_id'    => $r['worker_id'] === null ? null : (int) $r['worker_id'],
        'worker_name'  => $r['worker_name'],
        'designation'  => $r['designation'],
        'period_start' => $r['period_start'],
        'period_end'   => $r['period_end'],
        'amount'       => money_str($r['amount']),
        'note'         => $r['note'],
    ];
}

// ---------------------------------------------------------------------------
// 4. Per-worker rollup. Advances are PER-PROJECT, so they are NOT folded into
//    individual workers here — each worker row carries gross pay only. The
//    advance deduction happens once, at the project level (see summary.net).
// ---------------------------------------------------------------------------
$workersAcc = []; // keyed by worker_id

foreach ($payrollRows as $r) {
    $wid = (int) $r['worker_id'];
    if (!isset($workersAcc[$wid])) {
        $workersAcc[$wid] = [
            'worker_id'      => $wid,
            'worker_name'    => $r['worker_name'],
            'designation'    => $r['designation'],
            'regular_total'  => 0.0,
            'overtime_total' => 0.0,
            'gross_total'    => 0.0,
        ];
    }
    $workersAcc[$wid]['regular_total']  += (float) $r['regular_amount'];
    $workersAcc[$wid]['overtime_total'] += (float) $r['overtime_amount'];
    $workersAcc[$wid]['gross_total']    += (float) $r['amount'];
}

$workers = [];
foreach ($workersAcc as $w) {
    $workers[] = [
        'worker_id'      => $w['worker_id'],
        'worker_name'    => $w['worker_name'],
        'designation'    => $w['designation'],
        'regular_total'  => number_format($w['regular_total'],  2, '.', ''),
        'overtime_total' => number_format($w['overtime_total'], 2, '.', ''),
        'gross_total'    => number_format($w['gross_total'],    2, '.', ''),
    ];
}
usort($workers, function ($a, $b) {
    return strcasecmp((string) $a['worker_name'], (string) $b['worker_name']);
});

// ---------------------------------------------------------------------------
// 5. Summary.
// ---------------------------------------------------------------------------
$grossRegular  = 0.0;
$grossOvertime = 0.0;
$grossTotal    = 0.0;
foreach ($payrollRows as $r) {
    $grossRegular  += (float) $r['regular_amount'];
    $grossOvertime += (float) $r['overtime_amount'];
    $grossTotal    += (float) $r['amount'];
}

$advancesTotal = 0.0;
foreach ($advanceRows as $r) {
    $advancesTotal += (float) $r['amount'];
}

$netTotal     = $grossTotal - $advancesTotal;
$payrollCount = count($payrollRows);
$advCount     = count($advanceRows);
$workerCount  = count($workersAcc);

$summary = [
    'period' => [
        'start' => $periodStart,
        'end'   => $periodEnd,
    ],
    'gross_regular'   => number_format($grossRegular,  2, '.', ''),
    'gross_overtime'  => number_format($grossOvertime, 2, '.', ''),
    'gross_total'     => number_format($grossTotal,    2, '.', ''),
    'advances_total'  => number_format($advancesTotal, 2, '.', ''),
    'net'             => number_format($netTotal,      2, '.', ''),
    'payroll_count'   => $payrollCount,
    'advances_count'  => $advCount,
    'worker_count'    => $workerCount,
];

// ---------------------------------------------------------------------------
// 6. Output.
// ---------------------------------------------------------------------------
json_out([
    'project' => [
        'id'   => (int) $project['id'],
        'name' => $project['name'],
        'slug' => $project['slug'],
    ],
    'summary'       => $summary,
    'workers'       => $workers,
    'payroll_items' => $payrollItems,
    'advances'      => $advances,
]);
