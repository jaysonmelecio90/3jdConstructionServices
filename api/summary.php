<?php
// GET api/summary.php -> dashboard-wide aggregates.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    json_out(['error' => 'method not allowed'], 405);
}

$pdo = db();

/** True if a table exists in the current database (graceful on un-migrated DBs). */
function table_exists(PDO $pdo, string $table): bool
{
    try {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1'
        );
        $stmt->execute([$table]);
        return (bool) $stmt->fetchColumn();
    } catch (Throwable $e) {
        return false;
    }
}

/** Money string -> integer centavos. Exact for these magnitudes; avoids float drift without bcmath. */
function centavos($v): int
{
    return (int) round(((float) $v) * 100);
}

/** Integer centavos -> "n.nn" string, formatted exactly (no float in the output path). */
function pesos_str(int $c): string
{
    $sign = $c < 0 ? '-' : '';
    $c = abs($c);
    return $sign . intdiv($c, 100) . '.' . str_pad((string) ($c % 100), 2, '0', STR_PAD_LEFT);
}

// Grand total + category split across all expenses.
$row = $pdo->query("
    SELECT
        COALESCE(SUM(CASE WHEN category = 'material' THEN amount END), 0) AS material,
        COALESCE(SUM(CASE WHEN category = 'labor'    THEN amount END), 0) AS labor,
        COALESCE(SUM(CASE WHEN category = 'other'    THEN amount END), 0) AS other,
        COALESCE(SUM(amount), 0) AS grand_total
    FROM expenses
")->fetch();

$grandTotal = money_str($row['grand_total']);
$categorySplit = [
    'material' => money_str($row['material']),
    'labor'    => money_str($row['labor']),
    'other'    => money_str($row['other']),
];

// Project counts.
$projectCount = (int) $pdo->query('SELECT COUNT(*) AS c FROM projects')->fetch()['c'];
$activeProjects = (int) $pdo->query(
    'SELECT COUNT(*) AS c FROM (SELECT project_id FROM expenses GROUP BY project_id) t'
)->fetch()['c'];

// Per-project totals (same shape as projects.php), ORDER BY grand_total DESC.
$projRows = $pdo->query("
    SELECT
        p.id,
        p.name,
        p.slug,
        COALESCE(SUM(CASE WHEN e.category = 'material' THEN e.amount END), 0) AS material_total,
        COALESCE(SUM(CASE WHEN e.category = 'labor'    THEN e.amount END), 0) AS labor_total,
        COALESCE(SUM(CASE WHEN e.category = 'other'    THEN e.amount END), 0) AS other_total,
        COALESCE(SUM(e.amount), 0) AS grand_total,
        COUNT(e.id) AS expense_count
    FROM projects p
    LEFT JOIN expenses e ON e.project_id = p.id
    GROUP BY p.id, p.name, p.slug
    ORDER BY grand_total DESC, p.name ASC
")->fetchAll();

$projects = [];
foreach ($projRows as $r) {
    $projects[] = [
        'id'             => (int) $r['id'],
        'name'           => $r['name'],
        'slug'           => $r['slug'],
        'material_total' => money_str($r['material_total']),
        'labor_total'    => money_str($r['labor_total']),
        'other_total'    => money_str($r['other_total']),
        'grand_total'    => money_str($r['grand_total']),
        'expense_count'  => (int) $r['expense_count'],
    ];
}

// Timeline across all projects (entry_date NOT NULL only).
$tlRows = $pdo->query("
    SELECT
        DATE_FORMAT(entry_date, '%Y-%m') AS month,
        COALESCE(SUM(CASE WHEN category = 'material' THEN amount END), 0) AS material,
        COALESCE(SUM(CASE WHEN category = 'labor'    THEN amount END), 0) AS labor,
        COALESCE(SUM(CASE WHEN category = 'other'    THEN amount END), 0) AS other,
        COALESCE(SUM(amount), 0) AS total
    FROM expenses
    WHERE entry_date IS NOT NULL
    GROUP BY DATE_FORMAT(entry_date, '%Y-%m')
    ORDER BY month ASC
")->fetchAll();

$timeline = [];
foreach ($tlRows as $r) {
    $timeline[] = [
        'month'    => $r['month'],
        'material' => money_str($r['material']),
        'labor'    => money_str($r['labor']),
        'other'    => money_str($r['other']),
        'total'    => money_str($r['total']),
    ];
}

// Recent 10 across all projects, ORDER BY entry_date DESC (nulls last), id DESC.
$recRows = $pdo->query("
    SELECT
        e.id, e.category, e.entry_date_raw, e.entry_date, e.item_name, e.payee,
        e.quantity, e.unit_price, e.amount, e.note, e.source_sheet, e.source_row,
        p.name AS project_name, p.slug AS project_slug
    FROM expenses e
    JOIN projects p ON p.id = e.project_id
    ORDER BY e.entry_date IS NULL, e.entry_date DESC, e.id DESC
    LIMIT 10
")->fetchAll();

$recent = [];
foreach ($recRows as $r) {
    $recent[] = [
        'id'             => (int) $r['id'],
        'category'       => $r['category'],
        'entry_date_raw' => $r['entry_date_raw'],
        'entry_date'     => $r['entry_date'],
        'item_name'      => $r['item_name'],
        'payee'          => $r['payee'],
        'quantity'       => $r['quantity'] === null ? null : (string) $r['quantity'],
        'unit_price'     => $r['unit_price'] === null ? null : (string) $r['unit_price'],
        'amount'         => (string) $r['amount'],
        'note'           => $r['note'],
        'source_sheet'   => $r['source_sheet'],
        'source_row'     => $r['source_row'] === null ? null : (int) $r['source_row'],
        'project_name'   => $r['project_name'],
        'project_slug'   => $r['project_slug'],
    ];
}

// Top materials (top 8 by SUM(amount)).
$tmRows = $pdo->query("
    SELECT item_name, SUM(amount) AS total
    FROM expenses
    WHERE category = 'material'
    GROUP BY item_name
    ORDER BY total DESC
    LIMIT 8
")->fetchAll();

$topMaterials = [];
foreach ($tmRows as $r) {
    $topMaterials[] = [
        'item_name' => $r['item_name'],
        'total'     => money_str($r['total']),
    ];
}

// Top payees (top 8; category labor OR other, payee NOT NULL).
$tpRows = $pdo->query("
    SELECT payee, SUM(amount) AS total
    FROM expenses
    WHERE category IN ('labor', 'other') AND payee IS NOT NULL
    GROUP BY payee
    ORDER BY total DESC
    LIMIT 8
")->fetchAll();

$topPayees = [];
foreach ($tpRows as $r) {
    $topPayees[] = [
        'payee' => $r['payee'],
        'total' => money_str($r['total']),
    ];
}

// --- Bank balance aggregates (each SUM in its own simple query — never JOIN'd) ---

// total_in: SUM(incomes.amount)
$totalIn = $pdo->query('SELECT COALESCE(SUM(amount), 0) AS s FROM incomes')->fetch()['s'];

// outgoing components — each from its own table
$sumExpenses = $pdo->query('SELECT COALESCE(SUM(amount), 0) AS s FROM expenses')->fetch()['s'];
$sumPayroll  = $pdo->query('SELECT COALESCE(SUM(amount), 0) AS s FROM payroll_entries')->fetch()['s'];
$sumLoans    = $pdo->query('SELECT COALESCE(SUM(amount), 0) AS s FROM worker_loans')->fetch()['s'];
$sumAdvances = $pdo->query('SELECT COALESCE(SUM(amount), 0) AS s FROM cash_advances')->fetch()['s'];

// Loan repayments are cash coming back IN, so they offset the loans outgoing.
// Guard the new loan_payments table so an un-migrated DB doesn't 500 the dashboard.
$hasLoanPayments = table_exists($pdo, 'loan_payments');
$sumLoanPayments = $hasLoanPayments
    ? $pdo->query('SELECT COALESCE(SUM(amount), 0) AS s FROM loan_payments')->fetch()['s']
    : '0';

// Net loan cost out = principal loaned − repayments collected, CLAMPED per loan so an
// over-repaid loan can't credit phantom cash (matches the per-loan Outstanding on the
// Loans page). With no repayments table, net == gross.
if ($hasLoanPayments) {
    $loansNet = $pdo->query("
        SELECT COALESCE(SUM(GREATEST(wl.amount - COALESCE(lp.total, 0), 0)), 0) AS s
        FROM worker_loans wl
        LEFT JOIN (SELECT loan_id, SUM(amount) AS total FROM loan_payments GROUP BY loan_id) lp
               ON lp.loan_id = wl.id
    ")->fetch()['s'];
    $loansNet = number_format((float) $loansNet, 2, '.', '');
} else {
    $loansNet = number_format((float) $sumLoans, 2, '.', '');
}

// Integer-centavo math avoids float drift on DECIMAL strings — no bcmath extension needed.
$outCentavos = centavos($sumExpenses) + centavos($sumPayroll) + centavos($loansNet) + centavos($sumAdvances);
$totalOut    = pesos_str($outCentavos);
$bankBalance = pesos_str(centavos($totalIn) - $outCentavos);

$outBreakdown = [
    'expenses'        => money_str($sumExpenses),
    'payroll'         => money_str($sumPayroll),
    'loans'           => money_str($loansNet),       // net of repayments
    'loans_gross'     => money_str($sumLoans),
    'loan_repayments' => money_str($sumLoanPayments),
    'advances'        => money_str($sumAdvances),
];

// Income timeline (income_date NOT NULL only).
$itlRows = $pdo->query("
    SELECT
        DATE_FORMAT(income_date, '%Y-%m') AS month,
        COALESCE(SUM(amount), 0) AS total
    FROM incomes
    WHERE income_date IS NOT NULL
    GROUP BY DATE_FORMAT(income_date, '%Y-%m')
    ORDER BY month ASC
")->fetchAll();

$incomeTimeline = [];
foreach ($itlRows as $r) {
    $incomeTimeline[] = [
        'month' => $r['month'],
        'total' => money_str($r['total']),
    ];
}

// Recent 10 incomes (nulls last, then date DESC, then id DESC).
$riRows = $pdo->query("
    SELECT
        i.id, i.project_id, i.income_date, i.amount, i.payer, i.method, i.reference, i.note,
        p.name AS project_name, p.slug AS project_slug
    FROM incomes i
    LEFT JOIN projects p ON p.id = i.project_id
    ORDER BY i.income_date IS NULL, i.income_date DESC, i.id DESC
    LIMIT 10
")->fetchAll();

$recentIncomes = [];
foreach ($riRows as $r) {
    $recentIncomes[] = [
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
    ];
}

json_out([
    'grand_total'     => $grandTotal,
    'category_split'  => $categorySplit,
    'active_projects' => $activeProjects,
    'project_count'   => $projectCount,
    'projects'        => $projects,
    'timeline'        => $timeline,
    'recent'          => $recent,
    'top_materials'   => $topMaterials,
    'top_payees'      => $topPayees,
    'bank_balance'    => money_str($bankBalance),
    'total_in'        => money_str($totalIn),
    'total_out'       => money_str($totalOut),
    'out_breakdown'   => $outBreakdown,
    'income_timeline' => $incomeTimeline,
    'recent_incomes'  => $recentIncomes,
]);
