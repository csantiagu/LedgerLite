-- Bank lines are reviewed like QuickBooks' bank feed: every imported line waits in For Review
-- (is_reconciled = 0) until the owner posts it, then shows under All Transactions
-- (is_reconciled = 1). These record who posted it and when; undo clears them again.
ALTER TABLE transactions ADD COLUMN reviewed_at TEXT;
ALTER TABLE transactions ADD COLUMN reviewed_by TEXT REFERENCES users(id);
-- 1 when the category was filled in by posting a match (Debtors Control Account for invoices),
-- so undoing or unlinking can clear it again instead of leaving the line explained by it
ALTER TABLE transactions ADD COLUMN category_auto INTEGER NOT NULL DEFAULT 0;

-- Lines already categorised, matched or linked before this change count as posted, unless a
-- match on them is still waiting to be posted: those stay in For Review so it can be
UPDATE transactions SET is_reconciled = 1
WHERE is_reconciled = 0
  AND (expense_category_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM transaction_matches tm
                  WHERE tm.transaction_id = transactions.id AND tm.status = 'posted'))
  AND NOT EXISTS (SELECT 1 FROM transaction_matches tm
                  WHERE tm.transaction_id = transactions.id AND tm.status = 'pending');

UPDATE transactions SET reviewed_at = updated_at WHERE is_reconciled = 1;

-- Debtors Control Account on a matched line was filled in by posting the match
UPDATE transactions SET category_auto = 1
WHERE categorised_by_rule_id IS NULL
  AND expense_category_id IN (SELECT id FROM expense_categories WHERE LOWER(name) = 'debtors control account')
  AND EXISTS (SELECT 1 FROM transaction_matches tm
              WHERE tm.transaction_id = transactions.id AND tm.status = 'posted' AND tm.match_type = 'invoice');

CREATE INDEX idx_transactions_review ON transactions(bank_account_id, is_reconciled, date);
