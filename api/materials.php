<?php
// api/materials.php — Material List CRUD.
//   GET     -> "collect" (list, optional ?project_id= / ?project_slug= / ?status= / ?q=)
//   POST    -> add      (JSON body)
//   PUT     -> edit     (JSON body, requires id)
//   DELETE  -> remove   (?id= or JSON body { id })
// Same-origin, no bearer (consistent with the read API). Protect the subdomain
// at the host level (e.g. htaccess) if write access must be restricted.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$pdo = db();

$STATUSES = ['active', 'not_active'];

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

/** SELECT one shaped item by id (joined to its project). */
function fetch_item(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT m.id, m.project_id, p.name AS project_name, p.slug AS project_slug,
               m.hardware, m.price, m.location, m.item_date, m.status,
               m.created_at, m.updated_at
        FROM material_items m
        JOIN projects p ON p.id = m.project_id
        WHERE m.id = ?
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_item($row) : null;
}

/** Shape a raw row into the canonical material-item object. */
function shape_item(array $r): array
{
    return [
        'id'           => (int) $r['id'],
        'project_id'   => (int) $r['project_id'],
        'project_name' => $r['project_name'],
        'project_slug' => $r['project_slug'],
        'hardware'     => $r['hardware'],
        'price'        => (string) $r['price'],
        'location'     => $r['location'],
        'item_date'    => $r['item_date'],
        'status'       => $r['status'],
        'created_at'   => $r['created_at'],
        'updated_at'   => $r['updated_at'],
    ];
}

/** Validate that a project id exists. */
function project_exists(PDO $pdo, int $projectId): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM projects WHERE id = ? LIMIT 1');
    $stmt->execute([$projectId]);
    return (bool) $stmt->fetchColumn();
}

// ===========================================================================
// GET — collect (list)
// ===========================================================================
if ($method === 'GET') {
    // -----------------------------------------------------------------------
    // Autocomplete + price-prediction source for the entry form.
    //   ?suggest=1 -> { hardware:[...], suppliers:[...],
    //                   latest:[{hardware,location,price}] }
    // `latest` holds the most recently entered price for each hardware+supplier
    // pair (by max id), so the form can pre-fill the price.
    // -----------------------------------------------------------------------
    if (isset($_GET['suggest'])) {
        $hardware = $pdo->query("
            SELECT DISTINCT hardware FROM material_items
            WHERE hardware <> '' ORDER BY hardware
        ")->fetchAll(PDO::FETCH_COLUMN);
        $suppliers = $pdo->query("
            SELECT DISTINCT location FROM material_items
            WHERE location IS NOT NULL AND location <> '' ORDER BY location
        ")->fetchAll(PDO::FETCH_COLUMN);
        $latestRows = $pdo->query("
            SELECT m.hardware, m.location, m.price
            FROM material_items m
            JOIN (
                SELECT hardware, location, MAX(id) AS max_id
                FROM material_items
                GROUP BY hardware, location
            ) t ON t.max_id = m.id
        ")->fetchAll();
        $latest = [];
        foreach ($latestRows as $r) {
            $latest[] = [
                'hardware' => $r['hardware'],
                'location' => $r['location'],
                'price'    => money_str($r['price']),
            ];
        }
        json_out([
            'hardware'  => $hardware,
            'suppliers' => $suppliers,
            'latest'    => $latest,
        ]);
    }

    $where = [];
    $args = [];

    if (isset($_GET['project_id']) && $_GET['project_id'] !== '') {
        $where[] = 'm.project_id = ?';
        $args[] = (int) $_GET['project_id'];
    } elseif (isset($_GET['project_slug']) && $_GET['project_slug'] !== '') {
        $where[] = 'p.slug = ?';
        $args[] = trim((string) $_GET['project_slug']);
    }
    if (isset($_GET['status']) && in_array($_GET['status'], $STATUSES, true)) {
        $where[] = 'm.status = ?';
        $args[] = $_GET['status'];
    }
    if (isset($_GET['q']) && trim((string) $_GET['q']) !== '') {
        $where[] = '(m.hardware LIKE ? OR m.location LIKE ?)';
        $like = '%' . trim((string) $_GET['q']) . '%';
        $args[] = $like;
        $args[] = $like;
    }

    $sql = "
        SELECT m.id, m.project_id, p.name AS project_name, p.slug AS project_slug,
               m.hardware, m.price, m.location, m.item_date, m.status,
               m.created_at, m.updated_at
        FROM material_items m
        JOIN projects p ON p.id = m.project_id
    ";
    if ($where) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY (m.status = "active") DESC, m.item_date IS NULL, m.item_date DESC, m.id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($args);

    $items = [];
    $count = 0;
    $activeCount = 0;
    $total = 0.0;
    $activeTotal = 0.0;
    foreach ($stmt->fetchAll() as $r) {
        $items[] = shape_item($r);
        $count++;
        $price = (float) $r['price'];
        $total += $price;
        if ($r['status'] === 'active') {
            $activeCount++;
            $activeTotal += $price;
        }
    }

    json_out([
        'items'   => $items,
        'summary' => [
            'count'        => $count,
            'active_count' => $activeCount,
            'total_price'  => number_format($total, 2, '.', ''),
            'active_total' => number_format($activeTotal, 2, '.', ''),
        ],
    ]);
}

// ===========================================================================
// POST — add
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    $projectId = isset($b['project_id']) ? (int) $b['project_id'] : 0;
    $hardware  = nstr($b['hardware'] ?? null);
    $location  = nstr($b['location'] ?? null);
    $itemDate  = valid_date(nstr($b['item_date'] ?? null));
    $status    = (isset($b['status']) && in_array($b['status'], $STATUSES, true)) ? $b['status'] : 'active';
    $price     = isset($b['price']) && $b['price'] !== '' ? round((float) $b['price'], 2) : 0.0;

    if ($hardware === null) {
        json_out(['error' => 'hardware (item name) is required'], 422);
    }
    if ($projectId <= 0 || !project_exists($pdo, $projectId)) {
        json_out(['error' => 'a valid project is required'], 422);
    }
    if ($price < 0) {
        json_out(['error' => 'price cannot be negative'], 422);
    }

    $stmt = $pdo->prepare("
        INSERT INTO material_items (project_id, hardware, price, location, item_date, status)
        VALUES (?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([$projectId, $hardware, $price, $location, $itemDate, $status]);
    $id = (int) $pdo->lastInsertId();

    json_out(['ok' => true, 'item' => fetch_item($pdo, $id)], 201);
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

    $existing = fetch_item($pdo, $id);
    if (!$existing) {
        json_out(['error' => 'not found'], 404);
    }

    // Apply provided fields, falling back to current values.
    $projectId = isset($b['project_id']) ? (int) $b['project_id'] : $existing['project_id'];
    $hardware  = array_key_exists('hardware', $b) ? nstr($b['hardware']) : $existing['hardware'];
    $location  = array_key_exists('location', $b) ? nstr($b['location']) : $existing['location'];
    $itemDate  = array_key_exists('item_date', $b) ? valid_date(nstr($b['item_date'])) : $existing['item_date'];
    $status    = (isset($b['status']) && in_array($b['status'], $STATUSES, true)) ? $b['status'] : $existing['status'];
    $price     = array_key_exists('price', $b) && $b['price'] !== ''
        ? round((float) $b['price'], 2)
        : (float) $existing['price'];

    if ($hardware === null) {
        json_out(['error' => 'hardware (item name) is required'], 422);
    }
    if ($projectId <= 0 || !project_exists($pdo, $projectId)) {
        json_out(['error' => 'a valid project is required'], 422);
    }
    if ($price < 0) {
        json_out(['error' => 'price cannot be negative'], 422);
    }

    $stmt = $pdo->prepare("
        UPDATE material_items
        SET project_id = ?, hardware = ?, price = ?, location = ?, item_date = ?, status = ?
        WHERE id = ?
    ");
    $stmt->execute([$projectId, $hardware, $price, $location, $itemDate, $status, $id]);

    json_out(['ok' => true, 'item' => fetch_item($pdo, $id)]);
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

    $stmt = $pdo->prepare('DELETE FROM material_items WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id, 'deleted' => $stmt->rowCount()]);
}

json_out(['error' => 'method not allowed'], 405);
