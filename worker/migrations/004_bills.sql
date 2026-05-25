CREATE TABLE bills (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  vendor_id         TEXT NOT NULL REFERENCES vendors(id),
  bill_number       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','partial','paid','void')),
  issue_date        TEXT,
  due_date          TEXT,
  currency          TEXT NOT NULL DEFAULT 'GBP',
  subtotal          INTEGER NOT NULL DEFAULT 0,
  tax_amount        INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  amount_paid       INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  attachment_r2_key TEXT,
  flagged           INTEGER NOT NULL DEFAULT 0,
  accountant_notes  TEXT,
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bills_vendor ON bills(vendor_id);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_flagged ON bills(flagged);

CREATE TABLE bill_items (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  bill_id             TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  description         TEXT NOT NULL,
  quantity            REAL NOT NULL DEFAULT 1,
  unit_price          INTEGER NOT NULL,
  tax_rate            REAL NOT NULL DEFAULT 0,
  amount              INTEGER NOT NULL,
  expense_category_id TEXT REFERENCES expense_categories(id),
  sort_order          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE payments_made (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  bill_id      TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  amount       INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  method       TEXT,
  reference    TEXT,
  notes        TEXT,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
