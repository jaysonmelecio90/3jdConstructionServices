<?php
// api/users.php — user management (admin only for every method).
//   GET    -> { users: [ { id, name, email, role, created_at } ] }  (no hash)
//   POST   { name, email, password, role }
//          -> create user; email unique (409); role in (admin,staff);
//             422 validation; returns { ok, user } with 201.
//   DELETE (?id= or { id })
//          -> delete user; 422 if last admin or if id == current user;
//             404 if not found; returns { ok, id }.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

$me = require_admin();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$pdo = db();

$ROLES = ['admin', 'staff'];

/** Read a JSON request body into an array (empty array if none/invalid). */
function users_read_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/** Fetch one shaped user (no password hash) by id; null if missing. */
function users_fetch(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare(
        'SELECT id, name, email, role, created_at FROM users WHERE id = ? LIMIT 1'
    );
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    return [
        'id'         => (int) $row['id'],
        'name'       => (string) $row['name'],
        'email'      => (string) $row['email'],
        'role'       => (string) $row['role'],
        'created_at' => $row['created_at'],
    ];
}

/** Count admins (optionally excluding one id). */
function users_admin_count(PDO $pdo, int $excludeId = 0): int
{
    $stmt = $pdo->prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND id <> ?");
    $stmt->execute([$excludeId]);
    return (int) $stmt->fetchColumn();
}

// ===========================================================================
// GET — list users
// ===========================================================================
if ($method === 'GET') {
    $stmt = $pdo->query(
        'SELECT id, name, email, role, created_at
         FROM users
         ORDER BY (role = "admin") DESC, name ASC, id ASC'
    );
    $users = [];
    foreach ($stmt->fetchAll() as $row) {
        $users[] = [
            'id'         => (int) $row['id'],
            'name'       => (string) $row['name'],
            'email'      => (string) $row['email'],
            'role'       => (string) $row['role'],
            'created_at' => $row['created_at'],
        ];
    }
    json_out(['users' => $users]);
}

// ===========================================================================
// POST — create user
// ===========================================================================
if ($method === 'POST') {
    $b = users_read_body();

    $name     = isset($b['name']) ? trim((string) $b['name']) : '';
    $email    = isset($b['email']) ? trim((string) $b['email']) : '';
    $password = isset($b['password']) ? (string) $b['password'] : '';
    $role     = isset($b['role']) ? trim((string) $b['role']) : '';

    if ($name === '') {
        json_out(['error' => 'name is required'], 422);
    }
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_out(['error' => 'a valid email is required'], 422);
    }
    if (strlen($password) < 6) {
        json_out(['error' => 'password must be at least 6 characters'], 422);
    }
    if (!in_array($role, $ROLES, true)) {
        json_out(['error' => 'role must be admin or staff'], 422);
    }

    // Unique email check.
    $chk = $pdo->prepare('SELECT 1 FROM users WHERE email = ? LIMIT 1');
    $chk->execute([$email]);
    if ($chk->fetchColumn()) {
        json_out(['error' => 'a user with that email already exists'], 409);
    }

    $hash = password_hash($password, PASSWORD_DEFAULT);

    $stmt = $pdo->prepare(
        'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
    );
    $stmt->execute([$name, $email, $hash, $role]);
    $id = (int) $pdo->lastInsertId();

    json_out(['ok' => true, 'user' => users_fetch($pdo, $id)], 201);
}

// ===========================================================================
// DELETE — remove user
// ===========================================================================
if ($method === 'DELETE') {
    $id = 0;
    if (isset($_GET['id']) && $_GET['id'] !== '') {
        $id = (int) $_GET['id'];
    } else {
        $b = users_read_body();
        $id = isset($b['id']) ? (int) $b['id'] : 0;
    }
    if ($id <= 0) {
        json_out(['error' => 'id is required'], 422);
    }

    $target = users_fetch($pdo, $id);
    if (!$target) {
        json_out(['error' => 'not found'], 404);
    }

    // Cannot delete yourself.
    if ($id === (int) ($me['id'] ?? 0)) {
        json_out(['error' => 'you cannot delete your own account'], 422);
    }

    // Cannot remove the last remaining admin.
    if ($target['role'] === 'admin' && users_admin_count($pdo, $id) === 0) {
        json_out(['error' => 'cannot delete the last admin'], 422);
    }

    $stmt = $pdo->prepare('DELETE FROM users WHERE id = ?');
    $stmt->execute([$id]);

    json_out(['ok' => true, 'id' => $id]);
}

json_out(['error' => 'method not allowed'], 405);
