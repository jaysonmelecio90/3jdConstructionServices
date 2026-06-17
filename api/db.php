<?php
// PDO singleton. Requires config.php for credentials.
require_once __DIR__ . '/config.php';

/**
 * Return a shared PDO connection.
 * ERRMODE_EXCEPTION, FETCH_ASSOC, emulate prepares OFF, charset in DSN.
 * On connection failure, emit a 500 JSON response and exit.
 */
function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=' . DB_CHARSET;
    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, $options);
    } catch (Throwable $e) {
        // Do not leak credentials/details to the client.
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'database connection failed'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    return $pdo;
}
