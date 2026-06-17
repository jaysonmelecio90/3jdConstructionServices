<?php
// api/payroll.php — per-project payroll entries (worker x [regular + overtime] = amount).
//   GET     ?project_id= | ?project_slug=
//             -> { items:[ <entry> ], summary:{count,total} }
//   POST    {project_id, worker_id, period_start?, period_end?, rate_type,
//            regular_units?, regular_rate?, overtime_units?, overtime_rate?, note?}
//             -> { ok, item } 201
//   PUT     {id, ...partial}                              -> { ok, item }
//   DELETE  ?id= | {id}                                   -> { ok, id, deleted }
// Session-based auth. Money/units/rate returned as STRINGS.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$pdo = db();

$RATE_TYPES = ['hourly', 'daily'];

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

/**
 * Normalize a (start, end) pair:
 *  - if both null -> [null, null]
 *  - if only one given -> mirror it to the other
 *  - if both given and end < start -> returns null (caller handles 422)
 */
function normalize_period(?string $start, ?string $end): ?array
{
    if ($start === null && $end === null) {
        return [null, null];
    }
    if ($start !== null && $end === null) {
        return [$start, $start];
    }
    if ($start === null && $end !== null) {
        return [$end, $end];
    }
    if ($end < $start) {
        return null;
    }
    return [$start, $end];
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

/**
 * Resolve an OPTIONAL project id. Returns [projectId|null, errorMessage|null].
 *  - keys absent or value empty/0/null -> [null, null]  (admin / overhead payroll)
 *  - non-empty value that resolves     -> [int, null]
 *  - non-empty value that does NOT     -> [null, 'selected project does not exist']
 */
function resolve_optional_project_id(PDO $pdo, array $src): array
{
    $hasId   = array_key_exists('project_id', $src)   && $src['project_id']   !== '' && $src['project_id']   !== null;
    $hasSlug = array_key_exists('project_slug', $src) && $src['project_slug'] !== '' && $src['project_slug'] !== null;
    if (!$hasId && !$hasSlug) {
        return [null, null];
    }
    if ($hasId && (int) $src['project_id'] === 0) {
        return [null, null];
    }
    $pid = resolve_project_id($pdo, $src);
    if ($pid <= 0) {
        return [null, 'selected project does not exist'];
    }
    return [$pid, null];
}

/** Validate that a worker id exists. */
function worker_exists(PDO $pdo, int $workerId): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM workers WHERE id = ? LIMIT 1');
    $stmt->execute([$workerId]);
    return (bool) $stmt->fetchColumn();
}

/** Shape one joined payroll row (money/units/rate as STRINGS). project_id may be NULL (admin payroll). */
function shape_entry(array $r): array
{
    return [
        'id'              => (int) $r['id'],
        'project_id'      => $r['project_id'] === null ? null : (int) $r['project_id'],
        'project_name'    => $r['project_name'] ?? null,
        'project_slug'    => $r['project_slug'] ?? null,
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

/** Fetch one shaped entry by id. */
function fetch_entry(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT pe.id, pe.project_id, p.name AS project_name, p.slug AS project_slug,
               pe.worker_id, w.name AS worker_name, w.designation,
               pe.period_start, pe.period_end, pe.rate_type,
               pe.regular_units, pe.regular_rate, pe.regular_amount,
               pe.overtime_units, pe.overtime_rate, pe.overtime_amount,
               pe.amount, pe.note, pe.created_at
        FROM payroll_entries pe
        JOIN workers w ON w.id = pe.worker_id
        LEFT JOIN projects p ON p.id = pe.project_id
        WHERE pe.id = ?
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_entry($row) : null;
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

/** Parse a non-negative numeric value with a default of 0 when null/blank. */
function nn_num_default0($v): ?float
{
    if ($v === null || $v === '') {
        return 0.0;
    }
    if (!is_numeric($v)) {
        return null;
    }
    $f = (float) $v;
    if ($f < 0) {
        return null;
    }
    return $f;
}

// ===========================================================================
// GET — list + summary
// ===========================================================================
if ($method === 'GET') {
    $projectId = resolve_project_id($pdo, $_GET);
    if ($projectId <= 0) {
        json_out(['error' => 'a valid project is required'], 422);
    }

    $stmt = $pdo->prepare("
        SELECT pe.id, pe.project_id, p.name AS project_name, p.slug AS project_slug,
               pe.worker_id, w.name AS worker_name, w.designation,
               pe.period_start, pe.period_end, pe.rate_type,
               pe.regular_units, pe.regular_rate, pe.regular_amount,
               pe.overtime_units, pe.overtime_rate, pe.overtime_amount,
               pe.amount, pe.note, pe.created_at
        FROM payroll_entries pe
        JOIN workers w ON w.id = pe.worker_id
        LEFT JOIN projects p ON p.id = pe.project_id
        WHERE pe.project_id = ?
        ORDER BY pe.period_start IS NULL, pe.period_start DESC, pe.id DESC
    ");
    $stmt->execute([$projectId]);

    $items = [];
    $count = 0;
    $total = 0.0;
    foreach ($stmt->fetchAll() as $r) {
        $items[] = shape_entry($r);
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
// POST — add a payroll entry
// ===========================================================================
if ($method === 'POST') {
    global $RATE_TYPES;
    $b = read_json_body();

    [$projectId, $projectErr] = resolve_optional_project_id($pdo, $b);
    if ($projectErr !== null) {
        json_out(['error' => $projectErr], 422);
    }
    $workerId    = isset($b['worker_id']) ? (int) $b['worker_id'] : 0;
    $rateType    = (isset($b['rate_type']) && in_array($b['rate_type'], $RATE_TYPES, true))
        ? $b['rate_type'] : null;

    $rawStart = nstr($b['period_start'] ?? null);
    $rawEnd   = nstr($b['period_end']   ?? null);
    if ($rawStart !== null && valid_date($rawStart) === null) {
        json_out(['error' => 'period_start must be YYYY-MM-DD'], 422);
    }
    if ($rawEnd !== null && valid_date($rawEnd) === null) {
        json_out(['error' => 'period_end must be YYYY-MM-DD'], 422);
    }
    $period = normalize_period(valid_date($rawStart), valid_date($rawEnd));
    if ($period === null) {
        json_out(['error' => 'end date is before start date'], 422);
    }
    [$periodStart, $periodEnd] = $period;

    $regUnits = nn_num_default0($b['regular_units']  ?? null);
    $regRate  = nn_num_default0($b['regular_rate']   ?? null);
    $otUnits  = nn_num_default0($b['overtime_units'] ?? null);
    $otRate   = nn_num_default0($b['overtime_rate']  ?? null);
    $note     = nstr($b['note'] ?? null);

    // $projectId may be null here (admin / overhead payroll).
    if ($workerId <= 0 || !worker_exists($pdo, $workerId)) {
        json_out(['error' => 'a valid worker is required'], 422);
    }
    if ($rateType === null) {
        json_out(['error' => 'rate_type must be hourly or daily'], 422);
    }
    if ($regUnits === null) {
        json_out(['error' => 'regular_units must be numeric (>= 0)'], 422);
    }
    if ($regRate === null) {
        json_out(['error' => 'regular_rate must be numeric (>= 0)'], 422);
    }
    if ($otUnits === null) {
        json_out(['error' => 'overtime_units must be numeric (>= 0)'], 422);
    }
    if ($otRate === null) {
        json_out(['error' => 'overtime_rate must be numeric (>= 0)'], 422);
    }

    $regAmount = round($regUnits * $regRate, 2);
    $otAmount  = round($otUnits  * $otRate,  2);
    $amount    = round($regAmount + $otAmount, 2);

    $regUnitsStr  = number_format($regUnits, 2, '.', '');
    $regRateStr   = number_format($regRate,  2, '.', '');
    $regAmountStr = number_format($regAmount, 2, '.', '');
    $otUnitsStr   = number_format($otUnits,  2, '.', '');
    $otRateStr    = number_format($otRate,   2, '.', '');
    $otAmountStr  = number_format($otAmount, 2, '.', '');
    $amountStr    = number_format($amount,   2, '.', '');

    $stmt = $pdo->prepare("
        INSERT INTO payroll_entries
            (project_id, worker_id, period_start, period_end, rate_type,
             regular_units, regular_rate, regular_amount,
             overtime_units, overtime_rate, overtime_amount,
             amount, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([
        $projectId, $workerId, $periodStart, $periodEnd, $rateType,
        $regUnitsStr, $regRateStr, $regAmountStr,
        $otUnitsStr,  $otRateStr,  $otAmountStr,
        $amountStr, $note,
    ]);
    $id = (int) $pdo->lastInsertId();

    json_out(['ok' => true, 'item' => fetch_entry($pdo, $id)], 201);
}

// ===========================================================================
// PUT — update; recompute amount from final regular + overtime
// ===========================================================================
if ($method === 'PUT') {
    global $RATE_TYPES;
    $b = read_json_body();
    $id = isset($b['id']) ? (int) $b['id'] : 0;
    if ($id <= 0) {
        json_out(['error' => 'id is required'], 422);
    }

    $existing = fetch_entry($pdo, $id);
    if (!$existing) {
        json_out(['error' => 'not found'], 404);
    }

    // Project / worker may be reassigned. NULL project_id is allowed (admin payroll).
    if (array_key_exists('project_id', $b) || array_key_exists('project_slug', $b)) {
        [$projectId, $projectErr] = resolve_optional_project_id($pdo, $b);
        if ($projectErr !== null) {
            json_out(['error' => $projectErr], 422);
        }
    } else {
        $projectId = $existing['project_id'] === null ? null : (int) $existing['project_id'];
    }

    if (array_key_exists('worker_id', $b)) {
        $workerId = (int) $b['worker_id'];
        if ($workerId <= 0 || !worker_exists($pdo, $workerId)) {
            json_out(['error' => 'a valid worker is required'], 422);
        }
    } else {
        $workerId = (int) $existing['worker_id'];
    }

    if (array_key_exists('rate_type', $b)) {
        if (!in_array($b['rate_type'], $RATE_TYPES, true)) {
            json_out(['error' => 'rate_type must be hourly or daily'], 422);
        }
        $rateType = $b['rate_type'];
    } else {
        $rateType = $existing['rate_type'];
    }

    // Period handling: any subset of {period_start, period_end} may be present.
    $startProvided = array_key_exists('period_start', $b);
    $endProvided   = array_key_exists('period_end', $b);

    if ($startProvided) {
        $rawStart = nstr($b['period_start']);
        if ($rawStart !== null && valid_date($rawStart) === null) {
            json_out(['error' => 'period_start must be YYYY-MM-DD'], 422);
        }
        $newStart = valid_date($rawStart);
    } else {
        $newStart = $existing['period_start'];
    }

    if ($endProvided) {
        $rawEnd = nstr($b['period_end']);
        if ($rawEnd !== null && valid_date($rawEnd) === null) {
            json_out(['error' => 'period_end must be YYYY-MM-DD'], 422);
        }
        $newEnd = valid_date($rawEnd);
    } else {
        $newEnd = $existing['period_end'];
    }

    // Only mirror when caller explicitly touched the period and supplied just one side.
    if (($startProvided || $endProvided) && ($newStart === null || $newEnd === null)) {
        if ($newStart !== null && $newEnd === null) {
            $newEnd = $newStart;
        } elseif ($newStart === null && $newEnd !== null) {
            $newStart = $newEnd;
        }
    }

    if ($newStart !== null && $newEnd !== null && $newEnd < $newStart) {
        json_out(['error' => 'end date is before start date'], 422);
    }
    $periodStart = $newStart;
    $periodEnd   = $newEnd;

    if (array_key_exists('regular_units', $b)) {
        $regUnits = nn_num_default0($b['regular_units']);
        if ($regUnits === null) {
            json_out(['error' => 'regular_units must be numeric (>= 0)'], 422);
        }
    } else {
        $regUnits = (float) ($existing['regular_units'] ?? 0);
    }

    if (array_key_exists('regular_rate', $b)) {
        $regRate = nn_num_default0($b['regular_rate']);
        if ($regRate === null) {
            json_out(['error' => 'regular_rate must be numeric (>= 0)'], 422);
        }
    } else {
        $regRate = (float) ($existing['regular_rate'] ?? 0);
    }

    if (array_key_exists('overtime_units', $b)) {
        $otUnits = nn_num_default0($b['overtime_units']);
        if ($otUnits === null) {
            json_out(['error' => 'overtime_units must be numeric (>= 0)'], 422);
        }
    } else {
        $otUnits = (float) ($existing['overtime_units'] ?? 0);
    }

    if (array_key_exists('overtime_rate', $b)) {
        $otRate = nn_num_default0($b['overtime_rate']);
        if ($otRate === null) {
            json_out(['error' => 'overtime_rate must be numeric (>= 0)'], 422);
        }
    } else {
        $otRate = (float) ($existing['overtime_rate'] ?? 0);
    }

    $note = array_key_exists('note', $b) ? nstr($b['note']) : $existing['note'];

    $regAmount = round($regUnits * $regRate, 2);
    $otAmount  = round($otUnits  * $otRate,  2);
    $amount    = round($regAmount + $otAmount, 2);

    $regUnitsStr  = number_format($regUnits, 2, '.', '');
    $regRateStr   = number_format($regRate,  2, '.', '');
    $regAmountStr = number_format($regAmount, 2, '.', '');
    $otUnitsStr   = number_format($otUnits,  2, '.', '');
    $otRateStr    = number_format($otRate,   2, '.', '');
    $otAmountStr  = number_format($otAmount, 2, '.', '');
    $amountStr    = number_format($amount,   2, '.', '');

    $stmt = $pdo->prepare("
        UPDATE payroll_entries
        SET project_id = ?, worker_id = ?, period_start = ?, period_end = ?, rate_type = ?,
            regular_units = ?, regular_rate = ?, regular_amount = ?,
            overtime_units = ?, overtime_rate = ?, overtime_amount = ?,
            amount = ?, note = ?
        WHERE id = ?
    ");
    $stmt->execute([
        $projectId, $workerId, $periodStart, $periodEnd, $rateType,
        $regUnitsStr, $regRateStr, $regAmountStr,
        $otUnitsStr,  $otRateStr,  $otAmountStr,
        $amountStr, $note, $id,
    ]);

    json_out(['ok' => true, 'item' => fetch_entry($pdo, $id)]);
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

    $stmt = $pdo->prepare('DELETE FROM payroll_entries WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id, 'deleted' => $stmt->rowCount()]);
}

json_out(['error' => 'method not allowed'], 405);
