<?php
// api/projects.php — Projects list + CRUD.
//   GET     -> { "projects": [ {id,name,slug,material_total,labor_total,
//                               other_total,grand_total,expense_count,
//                               client_id,client_name} ] }
//               (GROUP BY w/ COALESCE; ORDER BY grand_total DESC, p.name ASC)
//   POST    -> create  { name, client_id? }            -> 201 { ok, project:{id,name,slug} }
//   PUT     -> update  { id, name?, client_id? }        -> { ok:true }  (slug is NEVER changed)
//   DELETE  -> remove  (?id= or JSON { id })            -> { ok:true, id }  (FK cascade)
// Same-origin, session auth. The GET shape powers the dashboard — preserve it exactly.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$pdo = db();

/**
 * Canonical slug rule used across the whole system:
 *   lowercase; every char not [a-z0-9] -> '-'; collapse '-' runs; trim '-'.
 */
function slugify(string $name): string
{
    $s = strtolower($name);
    $s = preg_replace('/[^a-z0-9]+/', '-', $s);
    $s = preg_replace('/-+/', '-', $s);
    return trim($s, '-');
}

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

/** Parse an optional money value -> rounded float, null, or 422 on bad input. */
function parse_price($v): ?float
{
    if ($v === null || $v === '') {
        return null;
    }
    if (!is_numeric($v) || (float) $v < 0) {
        json_out(['error' => 'contract price must be a non-negative number'], 422);
    }
    return round((float) $v, 2);
}

/**
 * Whether a column exists on a table in the current database. Lets the
 * Projects module ship before the Clients module adds projects.client_id,
 * without ever breaking the dashboard GET.
 */
function column_exists(PDO $pdo, string $table, string $column): bool
{
    static $cache = [];
    $key = $table . '.' . $column;
    if (array_key_exists($key, $cache)) {
        return $cache[$key];
    }
    try {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
             LIMIT 1'
        );
        $stmt->execute([$table, $column]);
        $exists = (bool) $stmt->fetchColumn();
    } catch (Throwable $e) {
        $exists = false;
    }
    return $cache[$key] = $exists;
}

/** Whether a table exists in the current database. */
function table_exists(PDO $pdo, string $table): bool
{
    static $cache = [];
    if (array_key_exists($table, $cache)) {
        return $cache[$table];
    }
    try {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1'
        );
        $stmt->execute([$table]);
        $exists = (bool) $stmt->fetchColumn();
    } catch (Throwable $e) {
        $exists = false;
    }
    return $cache[$table] = $exists;
}

/**
 * Validate an optional client_id from a request body.
 * Returns [int|null $clientId, ?string $error].
 *   - null/empty/0 -> stored as NULL (no error)
 *   - otherwise must exist in clients (else 422 error message)
 */
function resolve_client_id(PDO $pdo, $raw): array
{
    if ($raw === null || $raw === '' || (int) $raw === 0) {
        return [null, null];
    }
    $id = (int) $raw;
    if ($id < 0) {
        return [null, 'invalid client'];
    }
    if (!table_exists($pdo, 'clients')) {
        // Clients module not installed yet — cannot assign a client.
        return [null, 'client assignment is not available yet'];
    }
    $stmt = $pdo->prepare('SELECT 1 FROM clients WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    if (!$stmt->fetchColumn()) {
        return [null, 'selected client does not exist'];
    }
    return [$id, null];
}

// ===========================================================================
// GET — list with per-category totals (+ client join). Dashboard contract.
// ===========================================================================
if ($method === 'GET') {
    $hasClient = column_exists($pdo, 'projects', 'client_id');

    // Build the client columns/join only when the schema supports it, so the
    // exact existing GET output is preserved on databases without clients.
    if ($hasClient) {
        $clientSelect = "p.client_id AS client_id, c.name AS client_name";
        $clientJoin   = "LEFT JOIN clients c ON c.id = p.client_id";
        $groupExtra   = ", p.client_id, c.name";
    } else {
        $clientSelect = "NULL AS client_id, NULL AS client_name";
        $clientJoin   = "";
        $groupExtra   = "";
    }

    // Project particulars (location/owner/contract_price), likewise guarded.
    $hasDetails = column_exists($pdo, 'projects', 'contract_price');
    if ($hasDetails) {
        $detailSelect = "p.location AS location, p.owner AS owner, p.contract_price AS contract_price";
        $detailGroup  = ", p.location, p.owner, p.contract_price";
    } else {
        $detailSelect = "NULL AS location, NULL AS owner, NULL AS contract_price";
        $detailGroup  = "";
    }

    // Payroll totals — joined as a derived subquery so the per-project SUM
    // doesn't double-count against the expenses LEFT JOIN's row fan-out.
    $hasPayroll = table_exists($pdo, 'payroll_entries');
    if ($hasPayroll) {
        $payrollSelect = "COALESCE(pay.total, 0) AS payroll_total";
        $payrollJoin   = "LEFT JOIN (SELECT project_id, SUM(amount) AS total FROM payroll_entries GROUP BY project_id) pay ON pay.project_id = p.id";
        $payrollGroup  = ", pay.total";
    } else {
        $payrollSelect = "0 AS payroll_total";
        $payrollJoin   = "";
        $payrollGroup  = "";
    }

    // Worker loans charged to a project — derived subquery, same fan-out guard.
    // Net of repayments (clamped per loan) when loan_payments exists, so a project's
    // Total/Remaining matches the dashboard's net-loan semantics.
    $hasLoans = table_exists($pdo, 'worker_loans');
    if ($hasLoans) {
        $loansSelect = "COALESCE(loans.total, 0) AS loans_total";
        if (table_exists($pdo, 'loan_payments')) {
            $loansJoin = "LEFT JOIN (
                SELECT wl.project_id,
                       SUM(GREATEST(wl.amount - COALESCE(lp.total, 0), 0)) AS total
                FROM worker_loans wl
                LEFT JOIN (SELECT loan_id, SUM(amount) AS total FROM loan_payments GROUP BY loan_id) lp
                       ON lp.loan_id = wl.id
                WHERE wl.project_id IS NOT NULL
                GROUP BY wl.project_id
            ) loans ON loans.project_id = p.id";
        } else {
            $loansJoin = "LEFT JOIN (SELECT project_id, SUM(amount) AS total FROM worker_loans WHERE project_id IS NOT NULL GROUP BY project_id) loans ON loans.project_id = p.id";
        }
        $loansGroup  = ", loans.total";
    } else {
        $loansSelect = "0 AS loans_total";
        $loansJoin   = "";
        $loansGroup  = "";
    }

    // Cash advances issued under a project — derived subquery, same fan-out guard.
    $hasAdvances = table_exists($pdo, 'cash_advances');
    if ($hasAdvances) {
        $advancesSelect = "COALESCE(adv.total, 0) AS advances_total";
        $advancesJoin   = "LEFT JOIN (SELECT project_id, SUM(amount) AS total FROM cash_advances GROUP BY project_id) adv ON adv.project_id = p.id";
        $advancesGroup  = ", adv.total";
    } else {
        $advancesSelect = "0 AS advances_total";
        $advancesJoin   = "";
        $advancesGroup  = "";
    }

    // Single GROUP BY with COALESCE so empty projects still report "0.00".
    $sql = "
        SELECT
            p.id,
            p.name,
            p.slug,
            $clientSelect,
            $detailSelect,
            COALESCE(SUM(CASE WHEN e.category = 'material' THEN e.amount END), 0) AS material_total,
            COALESCE(SUM(CASE WHEN e.category = 'labor'    THEN e.amount END), 0) AS labor_total,
            COALESCE(SUM(CASE WHEN e.category = 'other'    THEN e.amount END), 0) AS other_total,
            COALESCE(SUM(e.amount), 0) AS grand_total,
            COUNT(e.id) AS expense_count,
            $payrollSelect,
            $loansSelect,
            $advancesSelect
        FROM projects p
        LEFT JOIN expenses e ON e.project_id = p.id
        $clientJoin
        $payrollJoin
        $loansJoin
        $advancesJoin
        GROUP BY p.id, p.name, p.slug$groupExtra$detailGroup$payrollGroup$loansGroup$advancesGroup
        ORDER BY grand_total DESC, p.name ASC
    ";

    $rows = $pdo->query($sql)->fetchAll();

    $projects = [];
    foreach ($rows as $r) {
        $grandTotal     = (float) $r['grand_total'];
        $payrollTotal   = (float) $r['payroll_total'];
        $loansTotal     = (float) $r['loans_total'];
        $advancesTotal  = (float) $r['advances_total'];
        $projectTotal   = $grandTotal + $payrollTotal + $loansTotal + $advancesTotal;
        $contractPrice  = $r['contract_price'];
        $remaining      = null;
        if ($contractPrice !== null) {
            $remaining = (float) $contractPrice - $projectTotal;
        }

        $projects[] = [
            'id'             => (int) $r['id'],
            'name'           => $r['name'],
            'slug'           => $r['slug'],
            'material_total' => money_str($r['material_total']),
            'labor_total'    => money_str($r['labor_total']),
            'other_total'    => money_str($r['other_total']),
            'grand_total'    => money_str($r['grand_total']),
            'expense_count'  => (int) $r['expense_count'],
            'client_id'      => $r['client_id'] !== null ? (int) $r['client_id'] : null,
            'client_name'    => $r['client_name'] !== null ? (string) $r['client_name'] : null,
            'location'       => $r['location'] !== null ? (string) $r['location'] : null,
            'owner'          => $r['owner'] !== null ? (string) $r['owner'] : null,
            'contract_price' => $contractPrice !== null ? money_str($contractPrice) : null,
            'payroll_total'  => money_str(number_format($payrollTotal, 2, '.', '')),
            'loans_total'    => money_str(number_format($loansTotal, 2, '.', '')),
            'advances_total' => money_str(number_format($advancesTotal, 2, '.', '')),
            'project_total'  => money_str(number_format($projectTotal, 2, '.', '')),
            'remaining'      => $remaining !== null ? money_str(number_format($remaining, 2, '.', '')) : null,
        ];
    }

    json_out(['projects' => $projects]);
}

// ===========================================================================
// POST — create a project
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    $name = nstr($b['name'] ?? null);
    if ($name === null) {
        json_out(['error' => 'project name is required'], 422);
    }

    $slug = slugify($name);
    if ($slug === '') {
        json_out(['error' => 'project name must contain letters or numbers'], 422);
    }

    [$clientId, $clientErr] = resolve_client_id($pdo, $b['client_id'] ?? null);
    if ($clientErr !== null) {
        json_out(['error' => $clientErr], 422);
    }

    // Reject duplicate slug up front (also guarded by the UNIQUE index).
    $stmt = $pdo->prepare('SELECT 1 FROM projects WHERE slug = ? LIMIT 1');
    $stmt->execute([$slug]);
    if ($stmt->fetchColumn()) {
        json_out(['error' => 'a project with a similar name already exists'], 409);
    }

    $hasClient  = column_exists($pdo, 'projects', 'client_id');
    $hasDetails = column_exists($pdo, 'projects', 'contract_price');

    $cols = ['name', 'slug'];
    $vals = [$name, $slug];
    if ($hasClient) {
        $cols[] = 'client_id';
        $vals[] = $clientId;
    }
    if ($hasDetails) {
        $cols[] = 'location';
        $vals[] = nstr($b['location'] ?? null);
        $cols[] = 'owner';
        $vals[] = nstr($b['owner'] ?? null);
        $cols[] = 'contract_price';
        $vals[] = parse_price($b['contract_price'] ?? null);
    }
    $placeholders = implode(', ', array_fill(0, count($cols), '?'));

    try {
        $stmt = $pdo->prepare('INSERT INTO projects (' . implode(', ', $cols) . ') VALUES (' . $placeholders . ')');
        $stmt->execute($vals);
    } catch (PDOException $e) {
        // 23000 = integrity constraint (race on the UNIQUE slug index).
        if ($e->getCode() === '23000') {
            json_out(['error' => 'a project with a similar name already exists'], 409);
        }
        throw $e;
    }

    $id = (int) $pdo->lastInsertId();
    json_out(['ok' => true, 'project' => ['id' => $id, 'name' => $name, 'slug' => $slug]], 201);
}

// ===========================================================================
// PUT — update name and/or client_id (slug stays stable, links don't break)
// ===========================================================================
if ($method === 'PUT') {
    $b = read_json_body();
    $id = isset($b['id']) ? (int) $b['id'] : 0;
    if ($id <= 0) {
        json_out(['error' => 'id is required'], 422);
    }

    $stmt = $pdo->prepare('SELECT id FROM projects WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    if (!$stmt->fetchColumn()) {
        json_out(['error' => 'not found'], 404);
    }

    $sets = [];
    $args = [];

    // name: only updated when the key is provided; must be non-empty if so.
    if (array_key_exists('name', $b)) {
        $name = nstr($b['name']);
        if ($name === null) {
            json_out(['error' => 'project name cannot be empty'], 422);
        }
        $sets[] = 'name = ?';
        $args[] = $name;
        // NOTE: slug is intentionally NOT recomputed on rename (stable links).
    }

    // client_id: only updated when the key is provided.
    if (array_key_exists('client_id', $b)) {
        if (!column_exists($pdo, 'projects', 'client_id')) {
            json_out(['error' => 'client assignment is not available yet'], 422);
        }
        [$clientId, $clientErr] = resolve_client_id($pdo, $b['client_id']);
        if ($clientErr !== null) {
            json_out(['error' => $clientErr], 422);
        }
        $sets[] = 'client_id = ?';
        $args[] = $clientId;
    }

    // location / owner / contract_price: each updated only when its key is provided.
    if (column_exists($pdo, 'projects', 'contract_price')) {
        if (array_key_exists('location', $b)) {
            $sets[] = 'location = ?';
            $args[] = nstr($b['location']);
        }
        if (array_key_exists('owner', $b)) {
            $sets[] = 'owner = ?';
            $args[] = nstr($b['owner']);
        }
        if (array_key_exists('contract_price', $b)) {
            $sets[] = 'contract_price = ?';
            $args[] = parse_price($b['contract_price']);
        }
    }

    if (!$sets) {
        json_out(['error' => 'nothing to update'], 422);
    }

    $args[] = $id;
    $stmt = $pdo->prepare('UPDATE projects SET ' . implode(', ', $sets) . ' WHERE id = ?');
    $stmt->execute($args);

    json_out(['ok' => true]);
}

// ===========================================================================
// DELETE — remove a project (expenses / materials cascade via FK)
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

    $stmt = $pdo->prepare('DELETE FROM projects WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id]);
}

json_out(['error' => 'method not allowed'], 405);
