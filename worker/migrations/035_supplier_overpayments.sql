-- Extra paid to a supplier, above what a bill still owed. It is not an expense and not VAT:
-- the supplier owes it back. A later money-in line matched to it (transaction_matches.overpayment_id)
-- clears it. The hold on the money-out line also uses overpayment_id, with bill_id left empty so
-- it explains the bank line without paying the bill a second time.
CREATE TABLE supplier_overpayments (
  id               TEXT PRIMARY KEY,
  vendor_id        TEXT NOT NULL REFERENCES vendors(id),
  bill_id          TEXT NOT NULL REFERENCES bills(id),
  transaction_id   TEXT NOT NULL REFERENCES transactions(id),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  amount_refunded  INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0 AND amount_refunded <= amount),
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_supplier_overpayments_bill ON supplier_overpayments(bill_id);
CREATE INDEX idx_supplier_overpayments_txn ON supplier_overpayments(transaction_id);

ALTER TABLE transaction_matches ADD COLUMN overpayment_id TEXT REFERENCES supplier_overpayments(id);
CREATE INDEX idx_txn_matches_overpayment ON transaction_matches(overpayment_id);
CREATE UNIQUE INDEX idx_txn_matches_one_overpayment
  ON transaction_matches(transaction_id, overpayment_id) WHERE overpayment_id IS NOT NULL;
