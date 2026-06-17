# CD Engineering — Project Management

A Flask web app that replaces the legacy `Proposal Submital Fee.xlsm` workbook
with a real database-backed system for managing clients, architects, and
project proposals. Uses **MySQL / MariaDB** for storage.

## Features

- **Login / register** — users authenticate before accessing anything
- **Dashboard** — at-a-glance counts plus total billed / collected / outstanding
- **Clients** — building owners (the "Owner" column from the workbook)
- **Architects** — the firm contacts who hire you, grouped by company
- **Proposals** — full proposal lifecycle (Draft → Submitted → Approved → Paid),
  with auto-populated default scope-of-work text matching your existing letters
- **Printable proposal letter** view, ready to print or save as PDF
- **Excel import** — seeds the database from your existing `.xlsm` summary sheet

## Prerequisites

- Python 3.10+
- MySQL or MariaDB (XAMPP works — defaults assume it)

## Setup

### 1. Install Python dependencies

```powershell
python -m pip install -r requirements.txt
```

### 2. Make sure MySQL/MariaDB is running

If you use XAMPP, open the XAMPP Control Panel and start **MySQL**, or run:

```powershell
& "C:\xampp\mysql\bin\mysqld.exe" --defaults-file="C:\xampp\mysql\bin\my.ini" --standalone
```

### 3. Create the database

```powershell
& "C:\xampp\mysql\bin\mysql.exe" -u root -e "CREATE DATABASE IF NOT EXISTS cdengineering CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### 4. Configure connection (.env)

Copy `.env.example` to `.env` and fill in your MySQL credentials:

```ini
SECRET_KEY=your-long-random-secret
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DB=cdengineering
```

A `.env` is already included with XAMPP-friendly defaults (root, no password).

### 5. Create the tables

```powershell
python -c "from app import app; from extensions import db; ctx=app.app_context(); ctx.push(); db.create_all(); print('OK')"
```

### 6. (Optional) Seed from your existing workbook

```powershell
python import_excel.py "D:/My Drive/5. DESIGN DOCS/Project Proposal/2025 - Proposal Submital Fee .xlsm"
```

### 7. Run

```powershell
python app.py
```

Open <http://127.0.0.1:5000> and register the first account — it becomes
the **admin**.

## Project layout

```
CDEngineering/
├── app.py                  # Flask app factory + entrypoint
├── config.py               # Reads .env, builds MySQL URI
├── extensions.py           # db, login_manager
├── models.py               # User, Company, Architect, Client, Proposal
├── forms.py                # WTForms definitions
├── blueprints/
│   ├── auth.py             # /login, /logout, /register
│   ├── dashboard.py        # /  (home)
│   ├── clients.py          # /clients/...
│   ├── architects.py       # /architects/...
│   └── proposals.py        # /proposals/...
├── templates/              # Jinja2 HTML
├── static/style.css
├── import_excel.py         # Workbook → DB seeder
├── .env.example
├── .gitignore
└── requirements.txt
```

## Switching MySQL servers / users

Just edit `.env` — there's no other configuration. The connection string is
built as:

```
mysql+pymysql://USER[:PASSWORD]@HOST:PORT/DB?charset=utf8mb4
```

Or set `DATABASE_URL` directly to override everything.

## Notes

- Driver: **PyMySQL** (pure Python, no compile required on Windows).
- `pool_pre_ping` is on, so dropped MySQL connections recover automatically.
- Self-service registration is open by default — close it (or gate behind
  an admin) in `blueprints/auth.py` once your team is signed up.
- Set a real `SECRET_KEY` in `.env` before deploying anywhere shared.
