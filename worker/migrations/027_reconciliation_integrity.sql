-- The same statement file can't be imported twice into one account, unless the earlier import
-- was undone. The hash is of the file's bytes.
ALTER TABLE bank_imports ADD COLUMN file_sha256 TEXT;
-- Set when an import is undone: its lines are removed and the file may be imported again
ALTER TABLE bank_imports ADD COLUMN undone_at TEXT;
ALTER TABLE bank_imports ADD COLUMN undone_by TEXT REFERENCES users(id);
CREATE UNIQUE INDEX idx_bank_imports_one_file
  ON bank_imports(bank_account_id, file_sha256)
  WHERE file_sha256 IS NOT NULL AND undone_at IS NULL;

-- Finds lines already in the books for an account on a date (duplicate checks on import)
CREATE INDEX idx_transactions_account_date ON transactions(bank_account_id, date);

-- One match per bank line and invoice/bill. Matching again updates that match. Suggestions that
-- duplicate another match are dropped first; any other duplicate makes this migration fail
-- loudly, rather than losing a posted payment.
DELETE FROM transaction_matches WHERE status = 'suggested' AND id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY transaction_id, COALESCE(invoice_id, bill_id)
      ORDER BY CASE status WHEN 'posted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, created_at
    ) AS n
    FROM transaction_matches
  ) WHERE n > 1
);
CREATE UNIQUE INDEX idx_txn_matches_one_invoice
  ON transaction_matches(transaction_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX idx_txn_matches_one_bill
  ON transaction_matches(transaction_id, bill_id) WHERE bill_id IS NOT NULL;
