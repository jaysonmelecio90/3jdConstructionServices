<?php
// api/auth.php — session authentication.
//   POST {action:'login', email, password}  -> set session, return user
//   POST {action:'logout'} | GET ?action=logout -> destroy session
//   GET  ?action=me                          -> current user or 401
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

start_app_session();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';

$body = [];
if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    $decoded = $raw ? json_decode($raw, true) : null;
    if (is_array($decoded)) {
        $body = $decoded;
        if (isset($body['action'])) {
            $action = $body['action'];
        }
    }
}

if ($action === 'me') {
    $u = current_user();
    if ($u === null) {
        json_out(['error' => 'unauthenticated'], 401);
    }
    json_out(['user' => $u]);
}

if ($action === 'logout') {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
    json_out(['ok' => true]);
}

if ($action === 'login') {
    if ($method !== 'POST') {
        json_out(['error' => 'method not allowed'], 405);
    }
    $email = isset($body['email']) ? trim((string) $body['email']) : '';
    $password = isset($body['password']) ? (string) $body['password'] : '';
    if ($email === '' || $password === '') {
        json_out(['error' => 'email and password are required'], 422);
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT id, name, email, password_hash, role FROM users WHERE email = ? LIMIT 1');
    $stmt->execute([$email]);
    $row = $stmt->fetch();

    if (!$row || !password_verify($password, $row['password_hash'])) {
        json_out(['error' => 'invalid email or password'], 401);
    }

    // Refresh session id on privilege change.
    session_regenerate_id(true);
    $user = [
        'id'    => (int) $row['id'],
        'name'  => $row['name'],
        'email' => $row['email'],
        'role'  => $row['role'],
    ];
    $_SESSION['user'] = $user;
    // Credentials expire 1 month after sign-in (absolute window from login).
    $_SESSION['login_at']   = time();
    $_SESSION['expires_at'] = time() + SESSION_LIFETIME;
    json_out(['ok' => true, 'user' => $user, 'expires_at' => $_SESSION['expires_at']]);
}

json_out(['error' => 'unknown action'], 400);
