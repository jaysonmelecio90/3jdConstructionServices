<?php
// api/payroll-all.php — company-wide payroll view across all projects.
//   GET ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
//       &project_id=N&worker_id=N&q=search
//         -> {
//              filters: { period_start, period_end, project_id, worker_id, q },
//              summary: { count, worker_count, project_count,
//                         gross_regular, gross_overtime, gross_total,
//                         advances_total, net },
//              by_project: [ ... ORDER BY gross DESC ],
//              by_worker:  [ ... ORDER BY gross DESC ],
//              items:      [ raw entries, ORDER BY period_start DESC, id DESC, LIMIT 500 ]
//            }
// Session-based auth (require_login — staff and admin both allowed).
// Money/units/rate as STRINGS (money_str). Overlap predicate when period bounds set:
//   entry.period_end >= filters.period_start AND entry.period_start <= filters.period_end.
// Payroll vs cash_advances are NEVER joined together — each SUM is its own aggregate.
// Cash advances are PER-PROJECT (not per-worker): they net against by_project &
// the overall summary only. When a worker filter is active, advances cannot be
// attributed to one worker, so they are omitted (advances_total = 0) for that view.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET') {
    json_out(['error' => 'method not allowed'], 405);
}

$pdo = db();

/** Trim a value to a non-empty string, or null. */
function nstr_all($v): ?string
{
    if ($v === null) {
        return null;
    }
    $s = trim((string) $v);
    return $s === '' ? null : $s;
}

/** Validate a 'YYYY-MM-DD' date string; return it, or null. */
function valid_date_all(?string $s): ?string
{
    if ($s === null || $s === '') {
        return null;
    }
    $d = DateTime::createFromFormat('Y-m-d', $s);
    return ($d && $d->format('Y-m-d') === $s) ? $s : null;
}

// ---------------------------------------------------------------------------
// Parse + validate filters.
// ---------------------------------------------------------------------------
$rawStart = nstr_all($_GET['period_start'] ?? null);
$rawEnd   = nstr_all($_GET['period_end']   ?? null);

if ($rawStart !== null && valid_date_all($rawStart) === null) {
    json_out(['error' => 'period_start must be YYYY-MM-DD'], 422);
}
if ($rawEnd !== null && valid_date_all($rawEnd) === null) {
    json_out(['error' => 'period_end must be YYYY-MM-DD'], 422);
}
$periodStart = valid_date_all($rawStart);
$periodEnd   = valid_date_all($rawEnd);
if ($periodStart !== null && $periodEnd !== null && $periodEnd < $periodStart) {
    json_out(['error' => 'end date is before start date'], 422);
}

$projectId = isset($_GET['project_id']) && $_GET['project_id'] !== ''
    ? (int) $_GET['project_id'] : 0;
$workerId  = isset($_GET['worker_id']) && $_GET['worker_id'] !== ''
    ? (int) $_GET['worker_id'] : 0;
$qRaw = nstr_all($_GET['q'] ?? null);
$q    = $qRaw === null ? '' : $qRaw;
$adminOnly = isset($_GET['admin_only']) && in_array((string) $_GET['admin_only'], ['1','true','yes','on'], true);
$workerType = nstr_all($_GET['type'] ?? null);
if ($workerType !== null && !in_array($workerType, ['field','admin'], true)) {
    json_out(['error' => 'type must be field or admin'], 422);
}

// ---------------------------------------------------------------------------
// Build shared WHERE for payroll_entries.
// ---------------------------------------------------------------------------
$peWhere  = [];
$peParams = [];

if ($periodStart !== null && $periodEnd !== null) {
    $peWhere[] = 'pe.period_end >= ? AND pe.period_start <= ?';
    $peParams[] = $periodStart;
    $peParams[] = $periodEnd;
} elseif ($periodStart !== null) {
    // Open-ended: include entries that overlap [periodStart, +inf)
    $peWhere[] = '(pe.period_end IS NULL OR pe.period_end >= ?)';
    $peParams[] = $periodStart;
} elseif ($periodEnd !== null) {
    // Open-ended: include entries that overlap (-inf, periodEnd]
    $peWhere[] = '(pe.period_start IS NULL OR pe.period_start <= ?)';
    $peParams[] = $periodEnd;
}

if ($projectId > 0) {
    $peWhere[] = 'pe.project_id = ?';
    $peParams[] = $projectId;
}
if ($workerId > 0) {
    $peWhere[] = 'pe.worker_id = ?';
    $peParams[] = $workerId;
}
if ($q !== '') {
    $peWhere[] = '(w.name LIKE ? OR p.name LIKE ? OR pe.note LIKE ?)';
    $like = '%' . $q . '%';
    $peParams[] = $like;
    $peParams[] = $like;
    $peParams[] = $like;
}
if ($adminOnly) {
    $peWhere[] = 'pe.project_id IS NULL';
}
if ($workerType !== null) {
    $peWhere[] = 'w.type = ?';
    $peParams[] = $workerType;
}
$peWhereSql = $peWhere ? ('WHERE ' . implode(' AND ', $peWhere)) : '';

// ---------------------------------------------------------------------------
// Build shared WHERE for cash_advances (no note/search filter — the q filter
// is anchored to payroll context). Advances are per-project, so we scope by
// project + period only (never by worker).
//
// Advances net against GROSS only when the gross side is restricted by the
// SAME dimensions we can mirror onto cash_advances (period + project). Any
// payroll-only narrowing that has no cash_advances equivalent — a worker
// filter, the Admin/Overhead scope (advances are never admin: cash_advances
// .project_id is NOT NULL), a name/note search, or a worker-type filter —
// would desynchronize gross vs. advances and yield a nonsense (often negative)
// net. In those views we suppress advances entirely so net stays == gross.
// ---------------------------------------------------------------------------
$applyAdvances = ($workerId === 0 && !$adminOnly && $q === '' && $workerType === null);

$caWhere  = [];
$caParams = [];

if ($periodStart !== null && $periodEnd !== null) {
    $caWhere[] = 'ca.period_end >= ? AND ca.period_start <= ?';
    $caParams[] = $periodStart;
    $caParams[] = $periodEnd;
} elseif ($periodStart !== null) {
    $caWhere[] = '(ca.period_end IS NULL OR ca.period_end >= ?)';
    $caParams[] = $periodStart;
} elseif ($periodEnd !== null) {
    $caWhere[] = '(ca.period_start IS NULL OR ca.period_start <= ?)';
    $caParams[] = $periodEnd;
}

if ($projectId > 0) {
    $caWhere[] = 'ca.project_id = ?';
    $caParams[] = $projectId;
}
$caWhereSql = $caWhere ? ('WHERE ' . implode(' AND ', $caWhere)) : '';

// ---------------------------------------------------------------------------
// 1. Top-level summary — separate aggregates (NEVER joined together).
// ---------------------------------------------------------------------------
$sql = "
    SELECT
        COUNT(*)                          AS cnt,
        COUNT(DISTINCT pe.worker_id)      AS worker_cnt,
        COUNT(DISTINCT pe.project_id)     AS project_cnt,
        COALESCE(SUM(pe.regular_amount), 0)  AS gross_regular,
        COALESCE(SUM(pe.overtime_amount), 0) AS gross_overtime,
        COALESCE(SUM(pe.amount), 0)          AS gross_total
    FROM payroll_entries pe
    JOIN workers  w ON w.id = pe.worker_id
    LEFT JOIN projects p ON p.id = pe.project_id
    $peWhereSql
";
$stmt = $pdo->prepare($sql);
$stmt->execute($peParams);
$agg = $stmt->fetch() ?: [
    'cnt' => 0, 'worker_cnt' => 0, 'project_cnt' => 0,
    'gross_regular' => 0, 'gross_overtime' => 0, 'gross_total' => 0,
];

$advancesTotal = 0.0;
if ($applyAdvances) {
    $sql = "
        SELECT COALESCE(SUM(ca.amount), 0) AS adv_total
        FROM cash_advances ca
        $caWhereSql
    ";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($caParams);
    $advAggRow   = $stmt->fetch();
    $advancesTotal = $advAggRow ? (float) $advAggRow['adv_total'] : 0.0;
}

$grossRegular  = (float) $agg['gross_regular'];
$grossOvertime = (float) $agg['gross_overtime'];
$grossTotal    = (float) $agg['gross_total'];
$net           = $grossTotal - $advancesTotal;

$summary = [
    'count'          => (int) $agg['cnt'],
    'worker_count'   => (int) $agg['worker_cnt'],
    'project_count'  => (int) $agg['project_cnt'],
    'gross_regular'  => number_format($grossRegular,  2, '.', ''),
    'gross_overtime' => number_format($grossOvertime, 2, '.', ''),
    'gross_total'    => number_format($grossTotal,    2, '.', ''),
    'advances_total' => number_format($advancesTotal, 2, '.', ''),
    'net'            => number_format($net,           2, '.', ''),
];

// ---------------------------------------------------------------------------
// 2. by_project — payroll aggregate per project, then merge advances aggregate.
// ---------------------------------------------------------------------------
$sql = "
    SELECT pe.project_id,
           p.name AS project_name,
           p.slug AS project_slug,
           COUNT(*) AS entry_count,
           COALESCE(SUM(pe.regular_amount), 0)  AS gross_regular,
           COALESCE(SUM(pe.overtime_amount), 0) AS gross_overtime,
           COALESCE(SUM(pe.amount), 0)          AS gross_total
    FROM payroll_entries pe
    JOIN workers  w ON w.id = pe.worker_id
    LEFT JOIN projects p ON p.id = pe.project_id
    $peWhereSql
    GROUP BY pe.project_id, p.name, p.slug
";
$stmt = $pdo->prepare($sql);
$stmt->execute($peParams);
$projectPayroll = $stmt->fetchAll();

$projectAdvances = [];
if ($applyAdvances) {
    $sql = "
        SELECT ca.project_id,
               p.name AS project_name,
               p.slug AS project_slug,
               COALESCE(SUM(ca.amount), 0) AS advances_total
        FROM cash_advances ca
        JOIN projects p ON p.id = ca.project_id
        $caWhereSql
        GROUP BY ca.project_id, p.name, p.slug
    ";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($caParams);
    $projectAdvances = $stmt->fetchAll();
}

// Synthetic "admin" key for the Admin / Overhead bucket (NULL project_id).
$ADMIN_KEY = '__admin__';

$projectMap = [];
foreach ($projectPayroll as $r) {
    $isAdmin = $r['project_id'] === null;
    $key = $isAdmin ? $ADMIN_KEY : (int) $r['project_id'];
    $projectMap[$key] = [
        'project_id'     => $isAdmin ? null : (int) $r['project_id'],
        'project_name'   => $isAdmin ? 'Admin / Overhead' : $r['project_name'],
        'project_slug'   => $isAdmin ? null : $r['project_slug'],
        '_is_admin'      => $isAdmin,
        'entry_count'    => (int) $r['entry_count'],
        'gross_regular'  => (float) $r['gross_regular'],
        'gross_overtime' => (float) $r['gross_overtime'],
        'gross_total'    => (float) $r['gross_total'],
        'advances_total' => 0.0,
    ];
}
foreach ($projectAdvances as $r) {
    // cash_advances.project_id is NOT NULL, so no admin bucket here.
    $pid = (int) $r['project_id'];
    if (!isset($projectMap[$pid])) {
        $projectMap[$pid] = [
            'project_id'     => $pid,
            'project_name'   => $r['project_name'],
            'project_slug'   => $r['project_slug'],
            '_is_admin'      => false,
            'entry_count'    => 0,
            'gross_regular'  => 0.0,
            'gross_overtime' => 0.0,
            'gross_total'    => 0.0,
            'advances_total' => 0.0,
        ];
    }
    $projectMap[$pid]['advances_total'] += (float) $r['advances_total'];
}

$byProject = [];
foreach ($projectMap as $row) {
    $byProject[] = [
        'project_id'     => $row['project_id'],
        'project_name'   => $row['project_name'],
        'project_slug'   => $row['project_slug'],
        'entry_count'    => $row['entry_count'],
        'gross_regular'  => number_format($row['gross_regular'],  2, '.', ''),
        'gross_overtime' => number_format($row['gross_overtime'], 2, '.', ''),
        'gross_total'    => number_format($row['gross_total'],    2, '.', ''),
        'advances_total' => number_format($row['advances_total'], 2, '.', ''),
        'net'            => number_format($row['gross_total'] - $row['advances_total'], 2, '.', ''),
    ];
}
// Admin / Overhead bucket sinks to the bottom; otherwise sort by gross DESC, name ASC.
usort($byProject, function ($a, $b) {
    $aAdmin = $a['project_id'] === null ? 1 : 0;
    $bAdmin = $b['project_id'] === null ? 1 : 0;
    if ($aAdmin !== $bAdmin) {
        return $aAdmin - $bAdmin;
    }
    $av = (float) $a['gross_total'];
    $bv = (float) $b['gross_total'];
    if ($av === $bv) {
        return strcasecmp((string) $a['project_name'], (string) $b['project_name']);
    }
    return ($bv <=> $av);
});

// ---------------------------------------------------------------------------
// 3. by_worker — payroll aggregate per worker, then merge advances aggregate.
// ---------------------------------------------------------------------------
$sql = "
    SELECT pe.worker_id,
           w.name AS worker_name,
           w.designation,
           COUNT(*) AS entry_count,
           COUNT(DISTINCT pe.project_id) AS project_count,
           COALESCE(SUM(pe.regular_amount), 0)  AS gross_regular,
           COALESCE(SUM(pe.overtime_amount), 0) AS gross_overtime,
           COALESCE(SUM(pe.amount), 0)          AS gross_total
    FROM payroll_entries pe
    JOIN workers  w ON w.id = pe.worker_id
    LEFT JOIN projects p ON p.id = pe.project_id
    $peWhereSql
    GROUP BY pe.worker_id, w.name, w.designation
";
$stmt = $pdo->prepare($sql);
$stmt->execute($peParams);
$workerPayroll = $stmt->fetchAll();

// Advances are per-project, never per-worker — the by_worker rollup carries
// gross pay only (no advance/net columns).
$workerMap = [];
foreach ($workerPayroll as $r) {
    $wid = (int) $r['worker_id'];
    $workerMap[$wid] = [
        'worker_id'      => $wid,
        'worker_name'    => $r['worker_name'],
        'designation'    => $r['designation'],
        'entry_count'    => (int) $r['entry_count'],
        'project_count'  => (int) $r['project_count'],
        'gross_regular'  => (float) $r['gross_regular'],
        'gross_overtime' => (float) $r['gross_overtime'],
        'gross_total'    => (float) $r['gross_total'],
    ];
}

$byWorker = [];
foreach ($workerMap as $row) {
    $byWorker[] = [
        'worker_id'      => $row['worker_id'],
        'worker_name'    => $row['worker_name'],
        'designation'    => $row['designation'],
        'entry_count'    => $row['entry_count'],
        'project_count'  => $row['project_count'],
        'gross_regular'  => number_format($row['gross_regular'],  2, '.', ''),
        'gross_overtime' => number_format($row['gross_overtime'], 2, '.', ''),
        'gross_total'    => number_format($row['gross_total'],    2, '.', ''),
    ];
}
usort($byWorker, function ($a, $b) {
    $av = (float) $a['gross_total'];
    $bv = (float) $b['gross_total'];
    if ($av === $bv) {
        return strcasecmp((string) $a['worker_name'], (string) $b['worker_name']);
    }
    return ($bv <=> $av);
});

// ---------------------------------------------------------------------------
// 4. items — raw entries, limit 500, newest first.
// ---------------------------------------------------------------------------
$sql = "
    SELECT pe.id, pe.project_id, p.name AS project_name, p.slug AS project_slug,
           pe.worker_id, w.name AS worker_name, w.designation,
           pe.period_start, pe.period_end, pe.rate_type,
           pe.regular_units, pe.regular_rate, pe.regular_amount,
           pe.overtime_units, pe.overtime_rate, pe.overtime_amount,
           pe.amount, pe.note, pe.created_at
    FROM payroll_entries pe
    JOIN workers  w ON w.id = pe.worker_id
    LEFT JOIN projects p ON p.id = pe.project_id
    $peWhereSql
    ORDER BY pe.period_start IS NULL, pe.period_start DESC, pe.id DESC
    LIMIT 500
";
$stmt = $pdo->prepare($sql);
$stmt->execute($peParams);
$rows = $stmt->fetchAll();

$items = [];
foreach ($rows as $r) {
    $items[] = [
        'id'              => (int) $r['id'],
        'project_id'      => $r['project_id'] === null ? null : (int) $r['project_id'],
        'project_name'    => $r['project_name'],
        'project_slug'    => $r['project_slug'],
        'worker_id'       => (int) $r['worker_id'],
        'worker_name'     => $r['worker_name'],
        'designation'     => $r['designation'],
        'period_start'    => $r['period_start'],
        'period_end'      => $r['period_end'],
        'rate_type'       => $r['rate_type'],
        'regular_units'   => $r['regular_units']  === null ? null : (string) $r['regular_units'],
        'regular_rate'    => $r['regular_rate']   === null ? null : (string) $r['regular_rate'],
        'regular_amount'  => money_str($r['regular_amount']),
        'overtime_units'  => $r['overtime_units'] === null ? null : (string) $r['overtime_units'],
        'overtime_rate'   => $r['overtime_rate']  === null ? null : (string) $r['overtime_rate'],
        'overtime_amount' => money_str($r['overtime_amount']),
        'amount'          => money_str($r['amount']),
        'note'            => $r['note'],
        'created_at'      => $r['created_at'],
    ];
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------
json_out([
    'filters' => [
        'period_start' => $periodStart,
        'period_end'   => $periodEnd,
        'project_id'   => $projectId > 0 ? $projectId : null,
        'worker_id'    => $workerId  > 0 ? $workerId  : null,
        'q'            => $q,
        'admin_only'   => $adminOnly,
        'type'         => $workerType,
    ],
    'summary'    => $summary,
    'by_project' => $byProject,
    'by_worker'  => $byWorker,
    'items'      => $items,
]);
