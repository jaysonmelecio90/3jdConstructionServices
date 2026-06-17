<?php
// GET api/project.php?slug=SLUG -> full project detail payload.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    json_out(['error' => 'method not allowed'], 405);
}

$slug = isset($_GET['slug']) ? trim((string) $_GET['slug']) : '';
if ($slug === '') {
    json_out(['error' => 'not found'], 404);
}

$pdo = db();

// Resolve project.
$stmt = $pdo->prepare('SELECT id, name, slug, location, owner, contract_price FROM projects WHERE slug = ? LIMIT 1');
$stmt->execute([$slug]);
$project = $stmt->fetch();
if (!$project) {
    json_out(['error' => 'not found'], 404);
}
$projectId = (int) $project['id'];

/**
 * Shape a raw expenses row into the canonical expense object.
 */
function expense_row(array $r): array
{
    return [
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
    ];
}

$expCols = 'id, category, entry_date_raw, entry_date, item_name, payee,
            quantity, unit_price, amount, note, source_sheet, source_row';

// KPIs.
$stmt = $pdo->prepare("
    SELECT
        COALESCE(SUM(CASE WHEN category = 'material' THEN amount END), 0) AS material_total,
        COALESCE(SUM(CASE WHEN category = 'labor'    THEN amount END), 0) AS labor_total,
        COALESCE(SUM(CASE WHEN category = 'other'    THEN amount END), 0) AS other_total,
        COALESCE(SUM(amount), 0) AS grand_total,
        COUNT(*) AS expense_count
    FROM expenses WHERE project_id = ?
");
$stmt->execute([$projectId]);
$k = $stmt->fetch();
$kpis = [
    'material_total' => money_str($k['material_total']),
    'labor_total'    => money_str($k['labor_total']),
    'other_total'    => money_str($k['other_total']),
    'grand_total'    => money_str($k['grand_total']),
    'expense_count'  => (int) $k['expense_count'],
];

// Material lines (grouped client-side below), ordered for grouping + per-line ordering.
$stmt = $pdo->prepare("
    SELECT $expCols
    FROM expenses
    WHERE project_id = ? AND category = 'material'
    ORDER BY entry_date IS NULL, entry_date DESC, id DESC
");
$stmt->execute([$projectId]);
$materialRows = $stmt->fetchAll();

// Build groups keyed by item_name (NULL -> empty bucket label preserved as null key handled separately).
$groups = [];      // key => aggregate
$groupOrder = [];  // preserve insertion to keep deterministic before sort
foreach ($materialRows as $r) {
    $key = $r['item_name'] === null ? "\0NULL" : $r['item_name'];
    if (!isset($groups[$key])) {
        $groups[$key] = [
            'item_name'      => $r['item_name'],
            'total_quantity' => '0',
            'subtotal'       => '0',
            'line_count'     => 0,
            'lines'          => [],
            '_qty_sum'       => 0.0,
            '_subtotal_sum'  => 0.0,
        ];
        $groupOrder[] = $key;
    }
    $groups[$key]['lines'][] = expense_row($r);
    $groups[$key]['line_count']++;
    if ($r['quantity'] !== null) {
        $groups[$key]['_qty_sum'] += (float) $r['quantity'];
    }
    $groups[$key]['_subtotal_sum'] += (float) $r['amount'];
}

$materialsGroups = [];
foreach ($groupOrder as $key) {
    $g = $groups[$key];
    $qty = $g['_qty_sum'];
    $sub = $g['_subtotal_sum'];
    $avg = $qty > 0 ? number_format($sub / $qty, 2, '.', '') : null;
    $materialsGroups[] = [
        'item_name'      => $g['item_name'],
        'total_quantity' => number_format($qty, 3, '.', ''),
        'subtotal'       => number_format($sub, 2, '.', ''),
        'avg_unit_price' => $avg,
        'line_count'     => $g['line_count'],
        'lines'          => $g['lines'],
        '_subtotal_sort' => $sub,
    ];
}
// ORDER BY subtotal DESC.
usort($materialsGroups, function ($a, $b) {
    return $b['_subtotal_sort'] <=> $a['_subtotal_sort'];
});
foreach ($materialsGroups as &$g) {
    unset($g['_subtotal_sort']);
}
unset($g);

// Labor lines.
$stmt = $pdo->prepare("
    SELECT $expCols
    FROM expenses
    WHERE project_id = ? AND category = 'labor'
    ORDER BY entry_date IS NULL, entry_date DESC, id DESC
");
$stmt->execute([$projectId]);
$labor = array_map('expense_row', $stmt->fetchAll());

// Other lines.
$stmt = $pdo->prepare("
    SELECT $expCols
    FROM expenses
    WHERE project_id = ? AND category = 'other'
    ORDER BY entry_date IS NULL, entry_date DESC, id DESC
");
$stmt->execute([$projectId]);
$other = array_map('expense_row', $stmt->fetchAll());

$sectionSubtotals = [
    'material' => $kpis['material_total'],
    'labor'    => $kpis['labor_total'],
    'other'    => $kpis['other_total'],
];

// Timeline by month (entry_date NOT NULL only).
$stmt = $pdo->prepare("
    SELECT
        DATE_FORMAT(entry_date, '%Y-%m') AS month,
        COALESCE(SUM(CASE WHEN category = 'material' THEN amount END), 0) AS material,
        COALESCE(SUM(CASE WHEN category = 'labor'    THEN amount END), 0) AS labor,
        COALESCE(SUM(CASE WHEN category = 'other'    THEN amount END), 0) AS other,
        COALESCE(SUM(amount), 0) AS total
    FROM expenses
    WHERE project_id = ? AND entry_date IS NOT NULL
    GROUP BY DATE_FORMAT(entry_date, '%Y-%m')
    ORDER BY month ASC
");
$stmt->execute([$projectId]);
$timeline = [];
foreach ($stmt->fetchAll() as $r) {
    $timeline[] = [
        'month'    => $r['month'],
        'material' => money_str($r['material']),
        'labor'    => money_str($r['labor']),
        'other'    => money_str($r['other']),
        'total'    => money_str($r['total']),
    ];
}

// Top materials (top 5 by SUM(amount) DESC).
$stmt = $pdo->prepare("
    SELECT item_name, SUM(amount) AS total
    FROM expenses
    WHERE project_id = ? AND category = 'material'
    GROUP BY item_name
    ORDER BY total DESC
    LIMIT 5
");
$stmt->execute([$projectId]);
$topMaterials = [];
foreach ($stmt->fetchAll() as $r) {
    $topMaterials[] = [
        'item_name' => $r['item_name'],
        'total'     => money_str($r['total']),
    ];
}

json_out([
    'project' => [
        'id'             => $projectId,
        'name'           => $project['name'],
        'slug'           => $project['slug'],
        'location'       => $project['location'] !== null ? (string) $project['location'] : null,
        'owner'          => $project['owner'] !== null ? (string) $project['owner'] : null,
        'contract_price' => $project['contract_price'] !== null ? money_str($project['contract_price']) : null,
    ],
    'kpis'              => $kpis,
    'materials_groups' => $materialsGroups,
    'labor'            => $labor,
    'other'            => $other,
    'section_subtotals' => $sectionSubtotals,
    'grand_total'      => $kpis['grand_total'],
    'timeline'         => $timeline,
    'top_materials'    => $topMaterials,
]);
