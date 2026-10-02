ALTER TABLE bank_imports ADD COLUMN bank_account_id TEXT REFERENCES bank_accounts(id);
ALTER TABLE bank_imports ADD COLUMN new_row_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_bank_imports_account ON bank_imports(bank_account_id);
