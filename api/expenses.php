<?php
// api/expenses.php — company-wide Expense ledger CRUD.
//   GET     -> list (optional ?project_id= / ?project_slug= / ?category= / ?q= / ?limit=)
//              -> { items:[ <expense> ], summary:{ count,total,material,labor,other } }
//   POST    -> add  (JSON body) -> { ok, item } 201
//   PUT     -> edit (JSON body, requires id; omitted fields fall back to existing)
//   DELETE  -> remove (?id= or JSON body { id }) -> { ok, id }
// Session-based auth (same-origin). Money/qty are returned as STRINGS.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$pdo = db();

$CATEGORIES = ['material', 'labor', 'other', 'family', 'health'];

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

/** Coerce a money/qty input to a normalized decimal string, or null when blank. */
function num_or_null($v, int $places): ?string
{
    if ($v === null || $v === '') {
        return null;
    }
    if (!is_numeric($v)) {
        return null;
    }
    return number_format((float) $v, $places, '.', '');
}

/** Validate that a project id exists. */
function project_exists(PDO $pdo, int $projectId): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM projects WHERE id = ? LIMIT 1');
    $stmt->execute([$projectId]);
    return (bool) $stmt->fetchColumn();
}

/** Shape a raw joined row into the canonical expense object (money/qty as STRINGS). */
function shape_expense(array $r): array
{
    return [
        'id'             => (int) $r['id'],
        'project_id'     => (int) $r['project_id'],
        'project_name'   => $r['project_name'],
        'project_slug'   => $r['project_slug'],
        'category'       => $r['category'],
        'entry_date_raw' => $r['entry_date_raw'],
        'entry_date'     => $r['entry_date'],
        'item_name'      => $r['item_name'],
        'payee'          => $r['payee'],
        'quantity'       => $r['quantity'] === null ? null : (string) $r['quantity'],
        'unit_price'     => $r['unit_price'] === null ? null : (string) $r['unit_price'],
        'amount'         => money_str($r['amount']),
        'note'           => $r['note'],
        'source_sheet'   => $r['source_sheet'],
        'source_row'     => $r['source_row'] === null ? null : (int) $r['source_row'],
    ];
}

/** SELECT one shaped expense by id (joined to its project). */
function fetch_expense(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT e.id, e.project_id, p.name AS project_name, p.slug AS project_slug,
               e.category, e.entry_date_raw, e.entry_date, e.item_name, e.payee,
               e.quantity, e.unit_price, e.amount, e.note, e.source_sheet, e.source_row
        FROM expenses e
        JOIN projects p ON p.id = e.project_id
        WHERE e.id = ?
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_expense($row) : null;
}

// ===========================================================================
// GET — list + summary
// ===========================================================================
if ($method === 'GET') {
    $where = [];
    $args = [];

    if (isset($_GET['project_id']) && $_GET['project_id'] !== '') {
        $where[] = 'e.project_id = ?';
        $args[] = (int) $_GET['project_id'];
    } elseif (isset($_GET['project_slug']) && $_GET['project_slug'] !== '') {
        $where[] = 'p.slug = ?';
        $args[] = trim((string) $_GET['project_slug']);
    }
    if (isset($_GET['category']) && in_array($_GET['category'], $CATEGORIES, true)) {
        $where[] = 'e.category = ?';
        $args[] = $_GET['category'];
    }
    if (isset($_GET['q']) && trim((string) $_GET['q']) !== '') {
        $where[] = '(e.item_name LIKE ? OR e.payee LIKE ? OR e.note LIKE ?)';
        $like = '%' . trim((string) $_GET['q']) . '%';
        $args[] = $like;
        $args[] = $like;
        $args[] = $like;
    }

    $limit = 500;
    if (isset($_GET['limit']) && $_GET['limit'] !== '') {
        $limit = (int) $_GET['limit'];
        if ($limit < 1) {
            $limit = 1;
        }
        if ($limit > 5000) {
            $limit = 5000;
        }
    }

    $sql = "
        SELECT e.id, e.project_id, p.name AS project_name, p.slug AS project_slug,
               e.category, e.entry_date_raw, e.entry_date, e.item_name, e.payee,
               e.quantity, e.unit_price, e.amount, e.note, e.source_sheet, e.source_row
        FROM expenses e
        JOIN projects p ON p.id = e.project_id
    ";
    if ($where) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY e.entry_date IS NULL, e.entry_date DESC, e.id DESC';
    $sql .= ' LIMIT ' . $limit;

    $stmt = $pdo->prepare($sql);
    $stmt->execute($args);

    $items = [];
    $count = 0;
    $total = 0.0;
    $buckets = ['material' => 0.0, 'labor' => 0.0, 'other' => 0.0, 'family' => 0.0, 'health' => 0.0];
    foreach ($stmt->fetchAll() as $r) {
        $items[] = shape_expense($r);
        $count++;
        $amt = (float) $r['amount'];
        $total += $amt;
        if (isset($buckets[$r['category']])) {
            $buckets[$r['category']] += $amt;
        }
    }

    json_out([
        'items'   => $items,
        'summary' => [
            'count'    => $count,
            'total'    => number_format($total, 2, '.', ''),
            'material' => number_format($buckets['material'], 2, '.', ''),
            'labor'    => number_format($buckets['labor'], 2, '.', ''),
            'other'    => number_format($buckets['other'], 2, '.', ''),
            'family'   => number_format($buckets['family'], 2, '.', ''),
            'health'   => number_format($buckets['health'], 2, '.', ''),
        ],
    ]);
}

// ===========================================================================
// POST — add
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    $projectId = isset($b['project_id']) ? (int) $b['project_id'] : 0;
    $category  = (isset($b['category']) && in_array($b['category'], $CATEGORIES, true)) ? $b['category'] : null;
    $entryDate = valid_date(nstr($b['entry_date'] ?? null));
    $entryRaw  = nstr($b['entry_date'] ?? null); // entry_date_raw = the entry_date string (or null)
    $itemName  = nstr($b['item_name'] ?? null);
    $payee     = nstr($b['payee'] ?? null);
    $quantity  = num_or_null($b['quantity'] ?? null, 3);
    $unitPrice = num_or_null($b['unit_price'] ?? null, 2);
    $note      = nstr($b['note'] ?? null);

    if ($projectId <= 0 || !project_exists($pdo, $projectId)) {
        json_out(['error' => 'a valid project is required'], 422);
    }
    if ($category === null) {
        json_out(['error' => 'category must be material, labor, other, family, or health'], 422);
    }
    if (!isset($b['amount']) || $b['amount'] === '' || !is_numeric($b['amount'])) {
        json_out(['error' => 'amount is required and must be numeric'], 422);
    }
    $amount = round((float) $b['amount'], 2);
    if ($amount < 0) {
        json_out(['error' => 'amount cannot be negative'], 422);
    }
    $amount = number_format($amount, 2, '.', '');

    $stmt = $pdo->prepare("
        INSERT INTO expenses
            (project_id, category, entry_date_raw, entry_date, item_name, payee,
             quantity, unit_price, amount, note, source_sheet, source_row)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL)
    ");
    $stmt->execute([$projectId, $category, $entryRaw, $entryDate, $itemName, $payee, $quantity, $unitPrice, $amount, $note]);
    $id = (int) $pdo->lastInsertId();

    // If this is a material expense whose item+supplier isn't yet in the
    // project's Material List, add it there too (keeps the procurement catalog
    // and the price memory in sync with what was actually purchased).
    if ($category === 'material' && $itemName !== null) {
        $exists = $pdo->prepare(
            "SELECT 1 FROM material_items
             WHERE project_id = ? AND hardware = ? AND COALESCE(location, '') = COALESCE(?, '')
             LIMIT 1"
        );
        $exists->execute([$projectId, $itemName, $payee]);
        if (!$exists->fetchColumn()) {
            $insMat = $pdo->prepare(
                "INSERT INTO material_items (project_id, hardware, price, location, item_date, status)
                 VALUES (?, ?, ?, ?, ?, 'active')"
            );
            $insMat->execute([$projectId, $itemName, $unitPrice !== null ? $unitPrice : '0.00', $payee, $entryDate]);
        }
    }

    json_out(['ok' => true, 'item' => fetch_expense($pdo, $id)], 201);
}

// ===========================================================================
// PUT — edit
// ===========================================================================
if ($method === 'PUT') {
    $b = read_json_body();
    $id = isset($b['id']) ? (int) $b['id'] : 0;
    if ($id <= 0) {
        json_out(['error' => 'id is required'], 422);
    }

    $existing = fetch_expense($pdo, $id);
    if (!$existing) {
        json_out(['error' => 'not found'], 404);
    }

    // Apply provided fields, falling back to current values for omitted keys.
    $projectId = array_key_exists('project_id', $b) ? (int) $b['project_id'] : $existing['project_id'];
    $category  = (isset($b['category']) && in_array($b['category'], $CATEGORIES, true))
        ? $b['category']
        : (array_key_exists('category', $b) ? null : $existing['category']);
    if (array_key_exists('entry_date', $b)) {
        $entryRaw  = nstr($b['entry_date']);
        $entryDate = valid_date($entryRaw);
    } else {
        $entryRaw  = $existing['entry_date_raw'];
        $entryDate = $existing['entry_date'];
    }
    $itemName  = array_key_exists('item_name', $b) ? nstr($b['item_name']) : $existing['item_name'];
    $payee     = array_key_exists('payee', $b) ? nstr($b['payee']) : $existing['payee'];
    $quantity  = array_key_exists('quantity', $b) ? num_or_null($b['quantity'], 3) : $existing['quantity'];
    $unitPrice = array_key_exists('unit_price', $b) ? num_or_null($b['unit_price'], 2) : $existing['unit_price'];
    $note      = array_key_exists('note', $b) ? nstr($b['note']) : $existing['note'];

    if ($projectId <= 0 || !project_exists($pdo, $projectId)) {
        json_out(['error' => 'a valid project is required'], 422);
    }
    if ($category === null) {
        json_out(['error' => 'category must be material, labor, other, family, or health'], 422);
    }

    if (array_key_exists('amount', $b)) {
        if ($b['amount'] === '' || !is_numeric($b['amount'])) {
            json_out(['error' => 'amount must be numeric'], 422);
        }
        $amount = round((float) $b['amount'], 2);
    } else {
        $amount = (float) $existing['amount'];
    }
    if ($amount < 0) {
        json_out(['error' => 'amount cannot be negative'], 422);
    }
    $amount = number_format($amount, 2, '.', '');

    $stmt = $pdo->prepare("
        UPDATE expenses
        SET project_id = ?, category = ?, entry_date_raw = ?, entry_date = ?,
            item_name = ?, payee = ?, quantity = ?, unit_price = ?, amount = ?, note = ?
        WHERE id = ?
    ");
    $stmt->execute([$projectId, $category, $entryRaw, $entryDate, $itemName, $payee, $quantity, $unitPrice, $amount, $note, $id]);

    json_out(['ok' => true, 'item' => fetch_expense($pdo, $id)]);
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

    $stmt = $pdo->prepare('DELETE FROM expenses WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id, 'deleted' => $stmt->rowCount()]);
}

json_out(['error' => 'method not allowed'], 405);
