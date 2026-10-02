ALTER TABLE transactions ADD COLUMN bank_account_id TEXT REFERENCES bank_accounts(id);
CREATE INDEX idx_transactions_account ON transactions(bank_account_id);
