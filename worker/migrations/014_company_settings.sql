CREATE TABLE IF NOT EXISTS company_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row
  company_name          TEXT,
  company_reg_number    TEXT,
  vat_number            TEXT,
  address               TEXT,
  email                 TEXT,
  phone                 TEXT,
  bank_account_name     TEXT,
  bank_sort_code        TEXT,
  bank_account_number   TEXT,
  bank_name             TEXT,
  logo_r2_key           TEXT,
  logo_filename         TEXT,
  invoice_prefix        TEXT NOT NULL DEFAULT 'INV',
  invoice_next_sequence INTEGER NOT NULL DEFAULT 1,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert singleton row with defaults
INSERT OR IGNORE INTO company_settings (id) VALUES (1);
