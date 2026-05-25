CREATE TABLE bank_imports (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  filename    TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  imported_by TEXT NOT NULL REFERENCES users(id),
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_count   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'processing'
              CHECK (status IN ('processing','complete','error'))
);

CREATE TABLE transactions (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  import_id           TEXT REFERENCES bank_imports(id),
  date                TEXT NOT NULL,
  description         TEXT NOT NULL,
  amount              INTEGER NOT NULL,
  balance             INTEGER,
  reference           TEXT,
  match_type          TEXT CHECK (match_type IN ('invoice','bill','manual',NULL)),
  matched_invoice_id  TEXT REFERENCES invoices(id),
  matched_bill_id     TEXT REFERENCES bills(id),
  expense_category_id TEXT REFERENCES expense_categories(id),
  notes               TEXT,
  flagged             INTEGER NOT NULL DEFAULT 0,
  accountant_notes    TEXT,
  is_reconciled       INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_import ON transactions(import_id);
CREATE INDEX idx_transactions_reconciled ON transactions(is_reconciled);
CREATE INDEX idx_transactions_flagged ON transactions(flagged);
