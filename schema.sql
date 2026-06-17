-- =============================================================================
-- schema.sql  —  CDEngineering construction-expense tracker
-- MySQL 8 / MariaDB 10.4+  •  Engine InnoDB  •  Charset utf8mb4
--
-- Defines the `projects` and `expenses` tables and seeds the 8 canonical
-- projects. Expense rows are NOT seeded here — they are loaded by the C#
-- importer via POST api/import.php.
--
-- Money is stored as DECIMAL (never float). The project seed uses
-- INSERT ... ON DUPLICATE KEY UPDATE so this file is safe to re-run.
-- =============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- Drop existing tables (children first, to respect the FK constraint).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS incomes;
DROP TABLE IF EXISTS cash_advances;
DROP TABLE IF EXISTS loan_payments;
DROP TABLE IF EXISTS worker_loans;
DROP TABLE IF EXISTS payroll_entries;
DROP TABLE IF EXISTS project_workers;
DROP TABLE IF EXISTS workers;
DROP TABLE IF EXISTS material_items;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS clients;

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id         INT          NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  slug       VARCHAR(120) NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_projects_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------
CREATE TABLE expenses (
  id             INT                              NOT NULL AUTO_INCREMENT,
  project_id     INT                              NOT NULL,
  category       ENUM('material','labor','other','family','health') NOT NULL,
  entry_date_raw VARCHAR(64)                      NULL,
  entry_date     DATE                             NULL,
  item_name      VARCHAR(255)                     NULL,
  payee          VARCHAR(255)                     NULL,
  quantity       DECIMAL(12,3)                    NULL,
  unit_price     DECIMAL(12,2)                    NULL,
  amount         DECIMAL(14,2)                    NOT NULL,
  note           VARCHAR(255)                     NULL,
  source_sheet   VARCHAR(64)                      NULL,
  source_row     INT                              NULL,
  created_at     TIMESTAMP                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_expenses_project  (project_id),
  KEY idx_expenses_category (category),
  KEY idx_expenses_date     (entry_date),
  CONSTRAINT fk_expenses_project
    FOREIGN KEY (project_id) REFERENCES projects (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- material_items  —  per-project procurement / material checklist (CRUD UI)
-- ---------------------------------------------------------------------------
CREATE TABLE material_items (
  id          INT           NOT NULL AUTO_INCREMENT,
  project_id  INT           NOT NULL,
  hardware    VARCHAR(255)  NOT NULL,                       -- item / hardware name
  price       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  location    VARCHAR(255)  NULL,                           -- store / site location
  item_date   DATE          NULL,                           -- date listed / needed
  status      ENUM('active','not_active') NOT NULL DEFAULT 'active',
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_material_items_project (project_id),
  KEY idx_material_items_status  (status),
  CONSTRAINT fk_material_items_project
    FOREIGN KEY (project_id) REFERENCES projects (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- clients  —  client / owner directory (CRUD UI); projects link via client_id
-- ---------------------------------------------------------------------------
CREATE TABLE clients (
  id         INT          NOT NULL AUTO_INCREMENT,
  name       VARCHAR(190) NOT NULL,
  company    VARCHAR(190) NULL,
  phone      VARCHAR(60)  NULL,
  email      VARCHAR(190) NULL,
  address    VARCHAR(300) NULL,
  notes      VARCHAR(500) NULL,
  status     ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_clients_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Link projects to a client (nullable; SET NULL when the client is removed),
-- and carry project particulars: location, owner, and agreed contract price.
ALTER TABLE projects
  ADD COLUMN client_id      INT           NULL,
  ADD COLUMN location       VARCHAR(255)  NULL,
  ADD COLUMN owner          VARCHAR(190)  NULL,
  ADD COLUMN contract_price DECIMAL(14,2) NULL,
  ADD KEY idx_projects_client (client_id),
  ADD CONSTRAINT fk_projects_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- workers  —  workforce directory; assigned to projects via project_workers,
--             and paid via payroll_entries (per worker, per day/hour).
-- ---------------------------------------------------------------------------
CREATE TABLE workers (
  id          INT          NOT NULL AUTO_INCREMENT,
  name        VARCHAR(160) NOT NULL,
  designation VARCHAR(120) NULL,
  type        ENUM('field','admin') NOT NULL DEFAULT 'field',  -- field = project worker; admin = overhead/office
  hourly_rate DECIMAL(10,2) NULL,
  daily_rate  DECIMAL(10,2) NULL,
  phone       VARCHAR(60)  NULL,
  email       VARCHAR(190) NULL,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_workers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- project_workers  —  M:N assignment list (which workers are on which jobs).
-- ---------------------------------------------------------------------------
CREATE TABLE project_workers (
  id          INT       NOT NULL AUTO_INCREMENT,
  project_id  INT       NOT NULL,
  worker_id   INT       NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_worker (project_id, worker_id),
  KEY idx_pw_worker (worker_id),
  CONSTRAINT fk_pw_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_pw_worker  FOREIGN KEY (worker_id)  REFERENCES workers(id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- payroll_entries  —  per-project payroll lines covering a date range
--   (period_start … period_end). Each line splits Regular + Overtime:
--     regular_amount  = regular_units  * regular_rate
--     overtime_amount = overtime_units * overtime_rate
--     amount (total)  = regular_amount + overtime_amount   (server-computed)
--   rate_type = 'hourly' -> units = hours; 'daily' -> units = days.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_entries (
  id              INT NOT NULL AUTO_INCREMENT,
  project_id      INT NULL,   -- NULL = admin/overhead payroll, charged to the main account directly
  period_start    DATE NULL,
  period_end      DATE NULL,
  worker_id       INT NOT NULL,
  rate_type       ENUM('hourly','daily') NOT NULL DEFAULT 'daily',
  regular_units   DECIMAL(8,2)  NOT NULL DEFAULT 0,
  regular_rate    DECIMAL(10,2) NOT NULL DEFAULT 0,
  regular_amount  DECIMAL(14,2) NOT NULL DEFAULT 0,
  overtime_units  DECIMAL(8,2)  NOT NULL DEFAULT 0,
  overtime_rate   DECIMAL(10,2) NOT NULL DEFAULT 0,
  overtime_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  note            VARCHAR(255) NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pay_project (project_id),
  KEY idx_pay_worker  (worker_id),
  KEY idx_pay_start   (period_start),
  CONSTRAINT fk_pay_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_worker  FOREIGN KEY (worker_id)  REFERENCES workers(id)  ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- worker_loans  —  small loans / advances to a worker (e.g. petty cash).
--   project_id is OPTIONAL — when set, the loan is charged to that project
--   and reduces its Remaining.
-- ---------------------------------------------------------------------------
CREATE TABLE worker_loans (
  id INT NOT NULL AUTO_INCREMENT,
  worker_id  INT NOT NULL,
  project_id INT NULL,
  loan_date  DATE NULL,
  amount     DECIMAL(10,2) NOT NULL DEFAULT 0,
  note       VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_loans_worker  (worker_id),
  KEY idx_loans_project (project_id),
  KEY idx_loans_date    (loan_date),
  CONSTRAINT fk_loans_worker  FOREIGN KEY (worker_id)  REFERENCES workers(id)  ON DELETE CASCADE,
  CONSTRAINT fk_loans_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- loan_payments  —  manual repayments booked against a worker_loan. A loan's
--                   outstanding balance = worker_loans.amount - SUM(payments).
--                   Each repayment is cash coming back IN, so it reduces the
--                   net loan cost in the dashboard Bank Balance.
-- ---------------------------------------------------------------------------
CREATE TABLE loan_payments (
  id INT NOT NULL AUTO_INCREMENT,
  loan_id      INT NOT NULL,
  payment_date DATE NULL,
  amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  note         VARCHAR(255) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lpay_loan (loan_id),
  KEY idx_lpay_date (payment_date),
  CONSTRAINT fk_lpay_loan FOREIGN KEY (loan_id) REFERENCES worker_loans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- cash_advances  —  a PER-PROJECT advance tied to a payroll period
--                   (period_start … period_end). It is deducted from the
--                   project's OVERALL payroll cost for that cycle (not from
--                   any single worker). worker_id is OPTIONAL — kept only as
--                   a free-text reference for legacy rows; new advances leave
--                   it NULL because an advance is not attributed to a worker.
-- ---------------------------------------------------------------------------
CREATE TABLE cash_advances (
  id INT NOT NULL AUTO_INCREMENT,
  project_id   INT NOT NULL,
  worker_id    INT NULL,   -- NULL = project-level advance (the normal case); not per-worker
  period_start DATE NULL,
  period_end   DATE NULL,
  amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  note         VARCHAR(255) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_adv_project (project_id),
  KEY idx_adv_worker  (worker_id),
  KEY idx_adv_period  (period_start),
  CONSTRAINT fk_adv_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_adv_worker  FOREIGN KEY (worker_id)  REFERENCES workers(id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- incomes  —  money IN (client payments, refunds, etc.). The Dashboard's
--             Bank / Account Balance = SUM(incomes) - all outgoings.
--             project_id is OPTIONAL (not every receipt is project-tied).
-- ---------------------------------------------------------------------------
CREATE TABLE incomes (
  id INT NOT NULL AUTO_INCREMENT,
  project_id  INT NULL,
  income_date DATE NULL,
  amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
  payer       VARCHAR(190) NULL,
  method      VARCHAR(80)  NULL,    -- bank / cash / cheque / GCash / ...
  reference   VARCHAR(120) NULL,    -- cheque #, transfer ref, etc.
  note        VARCHAR(255) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inc_project (project_id),
  KEY idx_inc_date    (income_date),
  CONSTRAINT fk_inc_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Seed: 8 canonical projects (name, slug) per the slugify contract.
-- Idempotent: re-running updates the name but preserves id/created_at.
-- ---------------------------------------------------------------------------
INSERT INTO projects (name, slug) VALUES
  ('JEMUEL',           'jemuel'),
  ('DAUIS',            'dauis'),
  ('NATIVA(CELINA)',   'nativa-celina'),
  ('NATIVA (CALI)',    'nativa-cali'),
  ('CHA2x',            'cha2x'),
  ('BUCAS TAGBILARAN', 'bucas-tagbilaran'),
  ('SUPPLY GALLARES',  'supply-gallares'),
  ('MARKER(CHURCH)',   'marker-church')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ---------------------------------------------------------------------------
-- users  —  app accounts (session auth via api/auth.php; managed in Settings)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INT                      NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120)             NOT NULL,
  email         VARCHAR(190)             NOT NULL,
  password_hash VARCHAR(255)             NOT NULL,
  role          ENUM('admin','staff')    NOT NULL DEFAULT 'staff',
  created_at    TIMESTAMP                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed a default admin (email: admin@3jdconstruction.com  password: admin123).
-- CHANGE THIS PASSWORD after first login (Settings → Users). Hash is bcrypt of 'admin123'.
INSERT INTO users (name, email, password_hash, role) VALUES
  ('Administrator', 'admin@3jdconstruction.com', '$2y$10$IKGbQjixrJfwwPNya.ha1.KZML8fd/8LTLUmQNznGWP/piy5yfo3K', 'admin')
ON DUPLICATE KEY UPDATE email = email;

-- ---------------------------------------------------------------------------
-- company_settings  —  single-row company profile (always id = 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_settings (
  id           INT          NOT NULL DEFAULT 1,
  company_name VARCHAR(200) NOT NULL DEFAULT '',
  legal_name   VARCHAR(200) NOT NULL DEFAULT '',
  address      VARCHAR(300) NOT NULL DEFAULT '',
  phone        VARCHAR(60)  NOT NULL DEFAULT '',
  email        VARCHAR(190) NOT NULL DEFAULT '',
  currency     VARCHAR(10)  NOT NULL DEFAULT 'PHP',
  tagline      VARCHAR(200) NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the single company-profile row (idempotent).
INSERT INTO company_settings (id, company_name, currency, tagline)
VALUES (1, '3J & D Construction', 'PHP', '')
ON DUPLICATE KEY UPDATE id = id;
