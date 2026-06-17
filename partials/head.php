<?php
/**
 * Shared page shell for the JS-rendered SPA pages.
 *
 * Each page sets a few variables, then includes this file:
 *   $TITLE   — title segment shown before "· 3J & D Construction"  (required)
 *   $MODULES — page-specific JS modules under assets/js/ (e.g. ['dashboard.js'])
 *   $CHART   — set false to skip Chart.js (defaults to true)
 *
 * The visible UI is built client-side by shell.js + the page module(s), so this
 * file emits the whole document and shows only a loading spinner in <body>.
 */
if (!isset($TITLE))   { $TITLE = '3J & D Construction'; }
if (!isset($MODULES)) { $MODULES = []; }
if (!isset($CHART))   { $CHART = true; }
$ttl = htmlspecialchars($TITLE, ENT_QUOTES, 'UTF-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title><?= $ttl ?> &middot; 3J &amp; D Construction</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%23F59E0B'/%3E%3Cg fill='none' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 18h14'/%3E%3Cpath d='M7 18V8l5-3v13'/%3E%3Cpath d='M17 18v-7l-5-3'/%3E%3C/g%3E%3C/svg%3E" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" />
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet" />
  <link rel="stylesheet" href="assets/css/app.css" />
  <script>(function(){try{var t=localStorage.getItem("tjd-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-bs-theme",t);}catch(e){}})();</script>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" defer></script>
<?php if ($CHART): ?>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" defer></script>
<?php endif; ?>
  <script src="assets/js/api.js" defer></script>
  <script src="assets/js/shell.js" defer></script>
<?php foreach ($MODULES as $m): ?>
  <script src="assets/js/<?= htmlspecialchars($m, ENT_QUOTES, 'UTF-8') ?>" defer></script>
<?php endforeach; ?>
</head>
<body>
  <div class="d-flex vh-100 align-items-center justify-content-center text-secondary">
    <div class="spinner-border text-warning" role="status"><span class="visually-hidden">Loading&hellip;</span></div>
  </div>
</body>
</html>
