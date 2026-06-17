<?php
/**
 * Server-side auth guard for protected pages.
 *
 * Include at the very TOP of every login-required page, before any output:
 *
 *     require __DIR__ . '/partials/guard.php';
 *
 * When there is no valid session it redirects to login.php, carrying the
 * originally-requested page (and its query string) in ?next= so the user lands
 * back where they aimed after signing in. current_user() also enforces the
 * 30-day credential-expiry window (see api/util.php).
 */
require_once __DIR__ . '/../api/util.php';

if (current_user() === null) {
    $page = basename($_SERVER['SCRIPT_NAME'] ?? 'index.php');
    $qs   = $_SERVER['QUERY_STRING'] ?? '';
    $next = $page . ($qs !== '' ? '?' . $qs : '');
    header('Location: login.php?next=' . rawurlencode($next));
    exit;
}
