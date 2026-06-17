<?php
// POST api/import.php (Authorization: Bearer <IMPORT_TOKEN>) -> bulk upsert importer.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_out(['error' => 'method not allowed'], 405);
}

// Auth first (401 + exit on failure).
require_token();

// Read + decode body.
$raw = file_get_contents('php://input');
$body = json_decode($raw, true);
if (!is_array($body) || !isset($body['projects']) || !is_array($body['projects'])) {
    json_out(['error' => 'invalid payload'], 400);
}

$validCategories = ['material', 'labor', 'other', 'family', 'health'];

/**
 * Coerce an empty string (or missing) to null; otherwise trimmed string.
 */
function nz($v): ?string
{
    if ($v === null) {
        return null;
    }
    if (is_string($v)) {
        $v = trim($v);
        return $v === '' ? null : $v;
    }
    // Numbers (decimal/int) sent by the C# importer arrive as scalars.
    return (string) $v;
}

$pdo = db();

$upsertProject = $pdo->prepare(
    'INSERT INTO projects (name, slug) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name)'
);
$findProject = $pdo->prepare('SELECT id FROM projects WHERE slug = ? LIMIT 1');
// Replace only ETL-sourced rows; preserve manually-entered expenses (source_sheet = 'manual').
$deleteExpenses = $pdo->prepare("DELETE FROM expenses WHERE project_id = ? AND (source_sheet IS NULL OR source_sheet <> 'manual')");
$insertExpense = $pdo->prepare(
    'INSERT INTO expenses
        (project_id, category, entry_date_raw, entry_date, item_name, payee,
         quantity, unit_price, amount, note, source_sheet, source_row)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

$results = [];
$totalInserted = 0;

$pdo->beginTransaction();
try {
    foreach ($body['projects'] as $proj) {
        if (!is_array($proj)) {
            throw new RuntimeException('invalid project entry');
        }
        $name = isset($proj['name']) ? trim((string) $proj['name']) : '';
        $slug = isset($proj['slug']) ? trim((string) $proj['slug']) : '';
        if ($name === '' || $slug === '') {
            throw new RuntimeException('project name and slug are required');
        }

        // Upsert by slug, resolve id.
        $upsertProject->execute([$name, $slug]);
        $findProject->execute([$slug]);
        $projectRow = $findProject->fetch();
        if (!$projectRow) {
            throw new RuntimeException('failed to resolve project id');
        }
        $projectId = (int) $projectRow['id'];

        // Replace all expenses for this project.
        $deleteExpenses->execute([$projectId]);

        $inserted = 0;
        $expenses = (isset($proj['expenses']) && is_array($proj['expenses'])) ? $proj['expenses'] : [];
        foreach ($expenses as $e) {
            if (!is_array($e)) {
                throw new RuntimeException('invalid expense entry');
            }

            $category = isset($e['category']) ? (string) $e['category'] : '';
            if (!in_array($category, $validCategories, true)) {
                throw new RuntimeException('invalid category: ' . $category);
            }

            // amount is REQUIRED and never null.
            if (!isset($e['amount']) || $e['amount'] === '' || $e['amount'] === null) {
                throw new RuntimeException('amount is required');
            }
            $amount = (string) $e['amount'];

            $entryDateRaw = nz($e['entry_date_raw'] ?? null);
            $entryDate    = nz($e['entry_date'] ?? null); // '' -> null
            $itemName     = nz($e['item_name'] ?? null);
            $payee        = nz($e['payee'] ?? null);
            $quantity     = nz($e['quantity'] ?? null);
            $unitPrice    = nz($e['unit_price'] ?? null);
            $note         = nz($e['note'] ?? null);
            $sourceSheet  = nz($e['source_sheet'] ?? null);

            $sourceRow = null;
            if (isset($e['source_row']) && $e['source_row'] !== '' && $e['source_row'] !== null) {
                $sourceRow = (int) $e['source_row'];
            }

            $insertExpense->execute([
                $projectId,
                $category,
                $entryDateRaw,
                $entryDate,
                $itemName,
                $payee,
                $quantity,
                $unitPrice,
                $amount,
                $note,
                $sourceSheet,
                $sourceRow,
            ]);
            $inserted++;
        }

        $totalInserted += $inserted;
        $results[] = [
            'slug'     => $slug,
            'name'     => $name,
            'inserted' => $inserted,
        ];
    }

    $pdo->commit();
} catch (Throwable $ex) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    json_out(['error' => 'import failed', 'detail' => $ex->getMessage()], 400);
}

json_out([
    'ok'             => true,
    'results'        => $results,
    'total_inserted' => $totalInserted,
]);
