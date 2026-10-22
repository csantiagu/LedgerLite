-- Where a category's bank lines go in the profit and loss: an expense (money out adds to it, money
-- in such as a supplier refund takes it down), income, or not at all (money that isn't profit or
-- loss: transfers, loans, tax payments, invoice receipts). Separate from vat_box: wages, for
-- example, are an expense but stay out of the VAT return.
ALTER TABLE expense_categories ADD COLUMN pl_line TEXT NOT NULL DEFAULT 'expense'
  CHECK (pl_line IN ('expense', 'income', 'excluded'));
UPDATE expense_categories SET pl_line = 'excluded' WHERE LOWER(name) IN (
  'transfer between accounts', 'director''s loan', 'loan', 'vat payments / refunds', 'corporation tax',
  'debtors control account'
);
UPDATE expense_categories SET pl_line = 'income' WHERE LOWER(name) IN ('sales income', 'sales', 'bank interest received');
