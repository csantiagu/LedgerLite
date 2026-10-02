CREATE TABLE transaction_matches (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  transaction_id   TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  match_type       TEXT NOT NULL CHECK (match_type IN ('invoice','bill')),
  invoice_id       TEXT REFERENCES invoices(id),
  bill_id          TEXT REFERENCES bills(id),
  allocated_amount INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'suggested'
                   CHECK (status IN ('suggested','pending','posted')),
  posted_by        TEXT REFERENCES users(id),
  posted_at        TEXT,
  payment_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_txn_matches_transaction ON transaction_matches(transaction_id);
CREATE INDEX idx_txn_matches_invoice     ON transaction_matches(invoice_id);
CREATE INDEX idx_txn_matches_bill        ON transaction_matches(bill_id);
CREATE INDEX idx_txn_matches_status      ON transaction_matches(status);
