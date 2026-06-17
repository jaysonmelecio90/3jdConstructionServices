<?php
// GET api/export.php?type=expenses|materials|projects (optional ?project_slug=)
//   Streams a CSV download (UTF-8 BOM so ₱ opens cleanly in Excel).
//   Reuses the same read tables as summary.php / project.php / materials.php.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    json_out(['error' => 'method not allowed'], 405);
}

$type = isset($_GET['type']) ? trim((string) $_GET['type']) : '';
$validTypes = ['expenses', 'materials', 'projects'];
if (!in_array($type, $validTypes, true)) {
    json_out(['error' => 'bad type'], 400);
}

$pdo = db();

// Optional project filter (expenses/materials only). Resolve slug -> id; 404 if unknown.
$projectId = null;
if (($type === 'expenses' || $type === 'materials')
    && isset($_GET['project_slug']) && trim((string) $_GET['project_slug']) !== '') {
    $slug = trim((string) $_GET['project_slug']);
    $stmt = $pdo->prepare('SELECT id FROM projects WHERE slug = ? LIMIT 1');
    $stmt->execute([$slug]);
    $row = $stmt->fetch();
    if (!$row) {
        json_out(['error' => 'not found'], 404);
    }
    $projectId = (int) $row['id'];
}

/**
 * Send the CSV download headers for the given export type.
 */
function csv_headers(string $type): void
{
    $filename = '3jd-' . $type . '-' . date('Y-m-d') . '.csv';
    if (!headers_sent()) {
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store');
    }
}

// Open the output stream, emit a UTF-8 BOM, return the handle.
csv_headers($type);
$out = fopen('php://output', 'w');
fwrite($out, "\xEF\xBB\xBF"); // UTF-8 BOM for Excel.

if ($type === 'expenses') {
    fputcsv($out, ['Project', 'Category', 'Date', 'Item', 'Payee', 'Quantity', 'Unit Price', 'Amount', 'Note', 'Source']);

    $sql = "
        SELECT p.name AS project_name, e.category,
               e.entry_date_raw, e.entry_date,
               e.item_name, e.payee, e.quantity, e.unit_price, e.amount,
               e.note, e.source_sheet, e.source_row
        FROM expenses e
        JOIN projects p ON p.id = e.project_id
    ";
    $args = [];
    if ($projectId !== null) {
        $sql .= ' WHERE e.project_id = ?';
        $args[] = $projectId;
    }
    $sql .= ' ORDER BY p.name ASC, e.entry_date IS NULL, e.entry_date ASC, e.id ASC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($args);
    while ($r = $stmt->fetch()) {
        $date = $r['entry_date'] !== null ? $r['entry_date'] : (string) $r['entry_date_raw'];
        $source = $r['source_sheet'];
        if ($r['source_row'] !== null) {
            $source = ($source !== null ? $source : '') . ' #' . (int) $r['source_row'];
        }
        fputcsv($out, [
            $r['project_name'],
            $r['category'],
            $date,
            $r['item_name'],
            $r['payee'],
            $r['quantity'] === null ? '' : (string) $r['quantity'],
            $r['unit_price'] === null ? '' : (string) $r['unit_price'],
            (string) $r['amount'],
            $r['note'],
            $source,
        ]);
    }
} elseif ($type === 'materials') {
    fputcsv($out, ['Project', 'Hardware', 'Location', 'Date', 'Price', 'Status']);

    $sql = "
        SELECT p.name AS project_name, m.hardware, m.location, m.item_date, m.price, m.status
        FROM material_items m
        JOIN projects p ON p.id = m.project_id
    ";
    $args = [];
    if ($projectId !== null) {
        $sql .= ' WHERE m.project_id = ?';
        $args[] = $projectId;
    }
    $sql .= ' ORDER BY p.name ASC, (m.status = "active") DESC, m.item_date IS NULL, m.item_date DESC, m.id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($args);
    while ($r = $stmt->fetch()) {
        fputcsv($out, [
            $r['project_name'],
            $r['hardware'],
            $r['location'],
            $r['item_date'],
            (string) $r['price'],
            $r['status'],
        ]);
    }
} else { // projects
    fputcsv($out, ['Project', 'Slug', 'Client', 'Material', 'Labor', 'Other', 'Total', 'Entries']);

    // Client name lives in clients.name, joined via projects.client_id (when the schema has it).
    $hasClientId = false;
    try {
        $col = $pdo->query("SHOW COLUMNS FROM projects LIKE 'client_id'");
        $hasClientId = $col && $col->fetch() ? true : false;
    } catch (Throwable $e) {
        $hasClientId = false;
    }
    if ($hasClientId) {
        $clientSelect = 'c.name AS client';
        $clientJoin   = 'LEFT JOIN clients c ON c.id = p.client_id';
        $groupExtra   = ', c.name';
    } else {
        $clientSelect = 'NULL AS client';
        $clientJoin   = '';
        $groupExtra   = '';
    }

    $sql = "
        SELECT
            p.name AS project_name,
            p.slug,
            $clientSelect,
            COALESCE(SUM(CASE WHEN e.category = 'material' THEN e.amount END), 0) AS material_total,
            COALESCE(SUM(CASE WHEN e.category = 'labor'    THEN e.amount END), 0) AS labor_total,
            COALESCE(SUM(CASE WHEN e.category = 'other'    THEN e.amount END), 0) AS other_total,
            COALESCE(SUM(e.amount), 0) AS grand_total,
            COUNT(e.id) AS expense_count
        FROM projects p
        LEFT JOIN expenses e ON e.project_id = p.id
        $clientJoin
        GROUP BY p.id, p.name, p.slug$groupExtra
        ORDER BY grand_total DESC, p.name ASC
    ";
    $stmt = $pdo->query($sql);
    while ($r = $stmt->fetch()) {
        fputcsv($out, [
            $r['project_name'],
            $r['slug'],
            $r['client'],
            money_str($r['material_total']),
            money_str($r['labor_total']),
            money_str($r['other_total']),
            money_str($r['grand_total']),
            (string) (int) $r['expense_count'],
        ]);
    }
}

fclose($out);
exit;
