<?php
// api/clients.php — Client Directory CRUD.
//   GET     -> list (optional ?q= search name/company, ?status=); each row carries project_count
//   POST    -> add      (JSON body; name required)
//   PUT     -> edit     (JSON body, requires id; falls back to existing values)
//   DELETE  -> remove   (?id= or JSON body { id }); detaches projects (client_id -> NULL) first
// Same-origin, session auth (consistent with the rest of the data API).
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$pdo = db();

$STATUSES = ['active', 'inactive'];

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

/** Shape a raw joined row into the canonical client object. */
function shape_client(array $r): array
{
    return [
        'id'            => (int) $r['id'],
        'name'          => $r['name'],
        'company'       => $r['company'],
        'phone'         => $r['phone'],
        'email'         => $r['email'],
        'address'       => $r['address'],
        'notes'         => $r['notes'],
        'status'        => $r['status'],
        'created_at'    => $r['created_at'],
        'project_count' => (int) $r['project_count'],
    ];
}

/** SELECT one shaped client by id (with project_count). */
function fetch_client(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare("
        SELECT c.id, c.name, c.company, c.phone, c.email, c.address, c.notes,
               c.status, c.created_at,
               COUNT(p.id) AS project_count
        FROM clients c
        LEFT JOIN projects p ON p.client_id = c.id
        WHERE c.id = ?
        GROUP BY c.id, c.name, c.company, c.phone, c.email, c.address, c.notes,
                 c.status, c.created_at
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? shape_client($row) : null;
}

// ===========================================================================
// GET — list
// ===========================================================================
if ($method === 'GET') {
    $where = [];
    $args = [];

    if (isset($_GET['q']) && trim((string) $_GET['q']) !== '') {
        $where[] = '(c.name LIKE ? OR c.company LIKE ?)';
        $like = '%' . trim((string) $_GET['q']) . '%';
        $args[] = $like;
        $args[] = $like;
    }
    if (isset($_GET['status']) && in_array($_GET['status'], $STATUSES, true)) {
        $where[] = 'c.status = ?';
        $args[] = $_GET['status'];
    }

    $sql = "
        SELECT c.id, c.name, c.company, c.phone, c.email, c.address, c.notes,
               c.status, c.created_at,
               COUNT(p.id) AS project_count
        FROM clients c
        LEFT JOIN projects p ON p.client_id = c.id
    ";
    if ($where) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= "
        GROUP BY c.id, c.name, c.company, c.phone, c.email, c.address, c.notes,
                 c.status, c.created_at
        ORDER BY c.name ASC
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($args);

    $items = [];
    foreach ($stmt->fetchAll() as $r) {
        $items[] = shape_client($r);
    }

    json_out(['items' => $items]);
}

// ===========================================================================
// POST — add
// ===========================================================================
if ($method === 'POST') {
    $b = read_json_body();

    $name    = nstr($b['name'] ?? null);
    $company = nstr($b['company'] ?? null);
    $phone   = nstr($b['phone'] ?? null);
    $email   = nstr($b['email'] ?? null);
    $address = nstr($b['address'] ?? null);
    $notes   = nstr($b['notes'] ?? null);
    $status  = (isset($b['status']) && in_array($b['status'], $STATUSES, true)) ? $b['status'] : 'active';

    if ($name === null) {
        json_out(['error' => 'name is required'], 422);
    }

    $stmt = $pdo->prepare("
        INSERT INTO clients (name, company, phone, email, address, notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([$name, $company, $phone, $email, $address, $notes, $status]);
    $id = (int) $pdo->lastInsertId();

    json_out(['ok' => true, 'item' => fetch_client($pdo, $id)], 201);
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

    $existing = fetch_client($pdo, $id);
    if (!$existing) {
        json_out(['error' => 'not found'], 404);
    }

    // Apply provided fields, falling back to current values.
    $name    = array_key_exists('name', $b) ? nstr($b['name']) : $existing['name'];
    $company = array_key_exists('company', $b) ? nstr($b['company']) : $existing['company'];
    $phone   = array_key_exists('phone', $b) ? nstr($b['phone']) : $existing['phone'];
    $email   = array_key_exists('email', $b) ? nstr($b['email']) : $existing['email'];
    $address = array_key_exists('address', $b) ? nstr($b['address']) : $existing['address'];
    $notes   = array_key_exists('notes', $b) ? nstr($b['notes']) : $existing['notes'];
    $status  = (isset($b['status']) && in_array($b['status'], $STATUSES, true)) ? $b['status'] : $existing['status'];

    if ($name === null) {
        json_out(['error' => 'name is required'], 422);
    }

    $stmt = $pdo->prepare("
        UPDATE clients
        SET name = ?, company = ?, phone = ?, email = ?, address = ?, notes = ?, status = ?
        WHERE id = ?
    ");
    $stmt->execute([$name, $company, $phone, $email, $address, $notes, $status, $id]);

    json_out(['ok' => true, 'item' => fetch_client($pdo, $id)]);
}

// ===========================================================================
// DELETE — remove (detach projects first, then delete)
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

    // Leave no dangling references: null out projects pointing at this client first.
    $detach = $pdo->prepare('UPDATE projects SET client_id = NULL WHERE client_id = ?');
    $detach->execute([$id]);

    $stmt = $pdo->prepare('DELETE FROM clients WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id, 'deleted' => $stmt->rowCount()]);
}

json_out(['error' => 'method not allowed'], 405);
