<?php
// Shared helpers: JSON output, auth, money coalesce, global error handlers.
require_once __DIR__ . '/config.php';

date_default_timezone_set('Asia/Manila');

// Login credentials expire 1 month (30 days) after sign-in; the user must
// re-authenticate after that. Enforced server-side in current_user().
const SESSION_LIFETIME = 30 * 24 * 60 * 60; // 2,592,000 seconds

/**
 * Emit a JSON response and stop. Same-origin safe headers.
 */
function json_out($data, int $code = 200): void
{
    if (!headers_sent()) {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        // Same-origin: do not advertise a permissive CORS policy.
        header('X-Content-Type-Options: nosniff');
        header('Vary: Origin');
    }
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Coalesce a possibly-null DECIMAL string to a default string.
 */
function money_str($value, string $default = '0.00'): string
{
    if ($value === null || $value === '') {
        return $default;
    }
    return (string) $value;
}

/**
 * Read the incoming Authorization header across common server setups.
 */
function read_auth_header(): string
{
    // 1) getallheaders() when available (Apache / some FPM setups).
    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        if (is_array($headers)) {
            foreach ($headers as $name => $value) {
                if (strcasecmp($name, 'Authorization') === 0) {
                    return (string) $value;
                }
            }
        }
    }
    // 2) Standard CGI/FPM variable.
    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
        return (string) $_SERVER['HTTP_AUTHORIZATION'];
    }
    // 3) Apache rewrite fallback.
    if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        return (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }
    return '';
}

/**
 * Require a valid Bearer token matching IMPORT_TOKEN. 401 + exit otherwise.
 */
function require_token(): void
{
    $header = trim(read_auth_header());
    $provided = '';
    if (stripos($header, 'Bearer ') === 0) {
        $provided = trim(substr($header, 7));
    }

    if ($provided === '' || !hash_equals((string) IMPORT_TOKEN, $provided)) {
        json_out(['error' => 'unauthorized'], 401);
    }
}

/**
 * Start the app session with hardened cookie params (idempotent).
 */
function start_app_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['SERVER_PORT'] ?? '') === '443');
    // Keep the server-side session file alive for the full credential lifetime so
    // PHP's GC doesn't reap a still-valid login early.
    ini_set('session.gc_maxlifetime', (string) SESSION_LIFETIME);
    session_set_cookie_params([
        'lifetime' => SESSION_LIFETIME,   // persistent cookie (~30 days), not browser-session
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => $https,
    ]);
    session_name('TJDSESS');
    session_start();
}

/**
 * Return the logged-in user array (id,name,email,role) or null.
 */
function current_user(): ?array
{
    start_app_session();
    if (!isset($_SESSION['user']) || !is_array($_SESSION['user'])) {
        return null;
    }
    // Hard expiry: credentials are only valid for SESSION_LIFETIME after login.
    // Absolute window from login time — re-login resets it.
    $expiresAt = $_SESSION['expires_at'] ?? null;
    if ($expiresAt !== null && time() > (int) $expiresAt) {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
        }
        session_destroy();
        return null;
    }
    return $_SESSION['user'];
}

/**
 * Require a logged-in session. 401 + exit otherwise.
 */
function require_login(): array
{
    $u = current_user();
    if ($u === null) {
        json_out(['error' => 'unauthenticated'], 401);
    }
    return $u;
}

/**
 * Require an admin role. 403 + exit otherwise.
 */
function require_admin(): array
{
    $u = require_login();
    if (($u['role'] ?? '') !== 'admin') {
        json_out(['error' => 'forbidden'], 403);
    }
    return $u;
}

// Global exception handler -> 500 JSON.
set_exception_handler(function (Throwable $e): void {
    json_out(['error' => 'server error'], 500);
});

// Fatal-error shutdown handler -> 500 JSON (only when not already a clean response).
register_shutdown_function(function (): void {
    $err = error_get_last();
    if ($err !== null && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode(['error' => 'server error'], JSON_UNESCAPED_UNICODE);
    }
});
