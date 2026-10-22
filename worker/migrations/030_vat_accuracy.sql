-- Sales to customers outside the UK: services there are outside the scope of UK VAT, so their
-- invoices carry no VAT but still count as sales in box 6 of the VAT return.
ALTER TABLE clients ADD COLUMN vat_treatment TEXT NOT NULL DEFAULT 'standard'
  CHECK (vat_treatment IN ('standard', 'outside_scope'));
ALTER TABLE invoices ADD COLUMN vat_treatment TEXT NOT NULL DEFAULT 'standard'
  CHECK (vat_treatment IN ('standard', 'outside_scope'));

-- Credit notes are invoices with kind = 'credit_note': amounts stay positive and the kind gives the
-- sign. One credits the invoice in credits_invoice_id; the part applied to that invoice's balance
-- is in credit_allocations (and in both rows' amount_paid), the rest is refunded as a payment on the
-- credit note (money out).
ALTER TABLE invoices ADD COLUMN kind TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'credit_note'));
ALTER TABLE invoices ADD COLUMN credits_invoice_id TEXT REFERENCES invoices(id);
ALTER TABLE invoices ADD COLUMN credit_reason TEXT;
CREATE INDEX idx_invoices_credits ON invoices(credits_invoice_id);

CREATE TABLE credit_allocations (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  credit_note_id TEXT NOT NULL REFERENCES invoices(id),
  invoice_id     TEXT NOT NULL REFERENCES invoices(id),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_credit_allocations_note ON credit_allocations(credit_note_id);
CREATE INDEX idx_credit_allocations_invoice ON credit_allocations(invoice_id);

ALTER TABLE company_settings ADD COLUMN credit_note_prefix TEXT NOT NULL DEFAULT 'CN';
ALTER TABLE company_settings ADD COLUMN credit_note_next_sequence INTEGER NOT NULL DEFAULT 1;
-- How VAT is accounted for: 'standard' (by invoice and bill date, HMRC's default) or 'cash' (when paid)
ALTER TABLE company_settings ADD COLUMN vat_scheme TEXT NOT NULL DEFAULT 'standard'
  CHECK (vat_scheme IN ('standard', 'cash'));

-- Where a category's bank lines go in the VAT return: purchases (boxes 4 and 7), sales (boxes 1
-- and 6), or neither (money that isn't a supply: transfers, loans, tax, wages, invoice receipts).
ALTER TABLE expense_categories ADD COLUMN vat_box TEXT NOT NULL DEFAULT 'purchases'
  CHECK (vat_box IN ('purchases', 'sales', 'excluded'));
UPDATE expense_categories SET vat_box = 'sales' WHERE LOWER(name) IN ('sales income', 'sales');
UPDATE expense_categories SET vat_box = 'excluded' WHERE LOWER(name) IN (
  'transfer between accounts', 'director''s loan', 'loan', 'vat payments / refunds', 'corporation tax',
  'debtors control account', 'salaries & wages', 'salary', 'paye & ni', 'pension contributions',
  'bank interest received'
);
