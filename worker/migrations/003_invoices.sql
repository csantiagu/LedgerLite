CREATE TABLE invoices (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  client_id       TEXT NOT NULL REFERENCES clients(id),
  invoice_number  TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','partial','paid','void','overdue')),
  issue_date      TEXT NOT NULL,
  due_date        TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'GBP',
  subtotal        INTEGER NOT NULL DEFAULT 0,
  tax_amount      INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  amount_paid     INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  footer_text     TEXT,
  pdf_r2_key      TEXT,
  sent_at         TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);

CREATE TABLE invoice_items (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity    REAL NOT NULL DEFAULT 1,
  unit_price  INTEGER NOT NULL,
  tax_rate    REAL NOT NULL DEFAULT 0,
  amount      INTEGER NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE payments_received (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  invoice_id   TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount       INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  method       TEXT CHECK (method IN ('bank_transfer','card','cash','cheque','other')),
  reference    TEXT,
  notes        TEXT,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payments_received_invoice ON payments_received(invoice_id);
