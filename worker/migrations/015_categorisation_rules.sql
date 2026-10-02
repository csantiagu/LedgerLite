-- Auto-categorisation rules for bank transactions.
-- A rule matches when the transaction description (or reference) contains match_text
-- (case-insensitive) and the direction fits. Lowest priority number wins; ties go to
-- the longest match_text (most specific).
CREATE TABLE categorisation_rules (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  match_text          TEXT NOT NULL,
  direction           TEXT NOT NULL DEFAULT 'any'
                      CHECK (direction IN ('any','in','out')),
  expense_category_id TEXT NOT NULL REFERENCES expense_categories(id),
  explanation         TEXT,             -- copied into transactions.notes when notes is empty
  priority            INTEGER NOT NULL DEFAULT 100,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_by          TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_categorisation_rules_active ON categorisation_rules(is_active);

-- Which rule categorised a transaction (NULL = categorised by hand or not at all)
ALTER TABLE transactions ADD COLUMN categorised_by_rule_id TEXT REFERENCES categorisation_rules(id);

-- Categories a UK limited company's accountant expects to see on bank lines
INSERT OR IGNORE INTO expense_categories (id, name, description) VALUES
  (lower(hex(randomblob(16))), 'VAT Payments / Refunds', 'Quarterly VAT paid to or refunded by HMRC'),
  (lower(hex(randomblob(16))), 'PAYE & NI', 'Monthly PAYE income tax and National Insurance paid to HMRC'),
  (lower(hex(randomblob(16))), 'Corporation Tax', 'Corporation tax paid to HMRC'),
  (lower(hex(randomblob(16))), 'Salaries & Wages', 'Net pay to employees and directors'),
  (lower(hex(randomblob(16))), 'Pension Contributions', 'Workplace pension payments'),
  (lower(hex(randomblob(16))), 'Client Entertainment', 'Meals and hospitality for clients (not VAT-reclaimable)'),
  (lower(hex(randomblob(16))), 'Staff Entertainment', 'Staff events and meals'),
  (lower(hex(randomblob(16))), 'Insurance', 'Business insurance premiums'),
  (lower(hex(randomblob(16))), 'Director''s Loan', 'Money paid to or received from a director personally'),
  (lower(hex(randomblob(16))), 'Transfer Between Accounts', 'Moves between the company''s own bank accounts'),
  (lower(hex(randomblob(16))), 'Sales Income', 'Customer receipts not matched to an invoice'),
  (lower(hex(randomblob(16))), 'Bank Interest Received', 'Interest credited by the bank');
