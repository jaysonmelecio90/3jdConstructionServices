# 3J & D Construction — Cost Management SaaS

A login-gated web app for **3J & D Construction Services** to track project
costs end to end: projects, expenses, materials, workers, clients, income,
payroll (regular + overtime with reports), per-project cash advances, worker
loans with repayments, and a dashboard bank balance.

## Stack

- **Backend:** PHP 8 + PDO (MySQL / MariaDB). Pure PHP — **no Composer, no
  `vendor/`, no build step**, no framework.
- **Frontend:** thin `.php` page shells + vanilla JS, styled with Bootstrap 5 +
  Bootstrap Icons + Chart.js (loaded from CDN). Each page sets a title/module
  list and includes shared `partials/` (auth guard + `<head>`); the UI itself is
  rendered client-side. API calls use **relative paths**, so the app runs at a
  domain root or any subfolder.
- **Auth:** PHP sessions (`TJDSESS` cookie). Pages are guarded **server-side**
  via `partials/guard.php` (logged-out visitors are redirected to `login.php`
  before any HTML renders); the JS shell re-checks on load. Login credentials
  expire 30 days after sign-in (enforced server-side in `api/util.php`).
- **Extensions required:** `pdo_mysql` only (plus core `json`). No `bcmath` —
  money math uses exact integer centavos.

## Layout

```
CDEngineering/
├── *.php                  # thin page shells (index, login, projects, payroll, …)
├── partials/
│   ├── guard.php          # server-side auth guard (redirect to login.php)
│   └── head.php           # shared <head> + loading spinner ($TITLE/$MODULES)
├── assets/
│   ├── js/                # shell.js + one module per page
│   └── css/app.css
├── api/                   # PHP endpoints (one per resource)
│   ├── config.example.php # copy to config.php and fill in DB credentials
│   ├── db.php             # PDO singleton
│   └── util.php           # session auth, JSON helpers
└── schema.sql             # full DDL + seed (projects, admin user, settings)
```

> Pure PHP/JS/CSS/Bootstrap — nothing here needs a runtime other than the PHP
> interpreter your Hostinger hPanel plan already provides. Bulk imports POST to
> the `api/import.php` JSON endpoint directly (e.g. via `curl` or any HTTP
> client), so no separate desktop importer is required.

## Run locally (XAMPP on Windows)

1. Start MariaDB (XAMPP Control Panel → MySQL, or `mysqld`).
2. Create a database and import the schema (via phpMyAdmin or CLI):
   ```
   mysql -u root your_db_name < schema.sql
   ```
3. Copy the config template and fill in your DB credentials:
   ```
   cp api/config.example.php api/config.php
   ```
4. Serve the folder:
   ```
   php -S 127.0.0.1:8088 -t .
   ```
5. Open <http://127.0.0.1:8088/> and log in with the seeded admin:
   **admin@3jdconstruction.com / admin123** — change the password in
   Settings → Users after first login.

## Deploy to Hostinger (hPanel shared hosting)

1. **PHP version:** select 8.1+ in *PHP Configuration*. (`pdo_mysql` is on by
   default; no `bcmath` needed.)
2. **Database:** create a MySQL DB + user in hPanel, then import `schema.sql`
   via phpMyAdmin **into a fresh, empty database** (the script drops tables
   first).
3. **Config:** `api/config.php` is gitignored and is **not** deployed — create
   it on the server (copy `api/config.example.php`) with Hostinger's values:
   `DB_HOST = localhost`, the `DB_NAME` / `DB_USER` from hPanel, your
   `DB_PASS`, and a random `IMPORT_TOKEN`.
4. **Files:** deploy the repository contents into `public_html`.
5. **SSL:** enable the free SSL certificate (the session cookie's `secure`
   flag auto-detects HTTPS).
6. **Security:** change the seeded admin password immediately.

No `.htaccess` or URL rewriting is required — the app serves `.php` pages
(`index.php` is the default document) and `api/*.php` endpoints directly.

## Secrets

Never commit real credentials. `api/config.php` holds the DB credentials and
`IMPORT_TOKEN`; it is gitignored and **not** deployed from the repo — create it
on the server from `api/config.example.php`, which is the only tracked template.
