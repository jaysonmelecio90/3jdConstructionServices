<?php
// api/settings.php — company profile (single row, id = 1).
//   GET (require_login)  -> { settings: { company_name, legal_name, address,
//                                          phone, email, currency, tagline } }
//   PUT (require_admin)  { company_name, legal_name, address, phone, email,
//                          currency, tagline }
//                        -> UPDATE row id = 1; returns { ok, settings }.
// company_name is required on PUT.
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$pdo = db();

/** Read a JSON request body into an array (empty array if none/invalid). */
function settings_read_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/** Trim a scalar to a string ('' when null). */
function settings_str($v): string
{
    if ($v === null) {
        return '';
    }
    return trim((string) $v);
}

/** Fetch the single settings row (id = 1), shaped; null if missing. */
function settings_fetch(PDO $pdo): ?array
{
    $stmt = $pdo->prepare(
        'SELECT company_name, legal_name, address, phone, email, currency, tagline
         FROM company_settings WHERE id = 1 LIMIT 1'
    );
    $stmt->execute();
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    return [
        'company_name' => (string) ($row['company_name'] ?? ''),
        'legal_name'   => (string) ($row['legal_name'] ?? ''),
        'address'      => (string) ($row['address'] ?? ''),
        'phone'        => (string) ($row['phone'] ?? ''),
        'email'        => (string) ($row['email'] ?? ''),
        'currency'     => (string) ($row['currency'] ?? ''),
        'tagline'      => (string) ($row['tagline'] ?? ''),
    ];
}

// ===========================================================================
// GET — read company profile
// ===========================================================================
if ($method === 'GET') {
    $settings = settings_fetch($pdo);
    if ($settings === null) {
        // Default empty shape so the UI always has a profile to bind to.
        $settings = [
            'company_name' => '',
            'legal_name'   => '',
            'address'      => '',
            'phone'        => '',
            'email'        => '',
            'currency'     => 'PHP',
            'tagline'      => '',
        ];
    }
    json_out(['settings' => $settings]);
}

// ===========================================================================
// PUT — update company profile (admin only)
// ===========================================================================
if ($method === 'PUT') {
    require_admin();

    $b = settings_read_body();

    $companyName = settings_str($b['company_name'] ?? null);
    if ($companyName === '') {
        json_out(['error' => 'company name is required'], 422);
    }

    $legalName = settings_str($b['legal_name'] ?? null);
    $address   = settings_str($b['address'] ?? null);
    $phone     = settings_str($b['phone'] ?? null);
    $email     = settings_str($b['email'] ?? null);
    $currency  = settings_str($b['currency'] ?? null);
    $tagline   = settings_str($b['tagline'] ?? null);

    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_out(['error' => 'enter a valid email address'], 422);
    }
    if ($currency === '') {
        $currency = 'PHP';
    }

    // Upsert the single row (id = 1) so this works even before seeding.
    $stmt = $pdo->prepare(
        'INSERT INTO company_settings
            (id, company_name, legal_name, address, phone, email, currency, tagline)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            company_name = VALUES(company_name),
            legal_name   = VALUES(legal_name),
            address      = VALUES(address),
            phone        = VALUES(phone),
            email        = VALUES(email),
            currency     = VALUES(currency),
            tagline      = VALUES(tagline)'
    );
    $stmt->execute([$companyName, $legalName, $address, $phone, $email, $currency, $tagline]);

    json_out(['ok' => true, 'settings' => settings_fetch($pdo)]);
}

json_out(['error' => 'method not allowed'], 405);
