-- VAT on bank lines that aren't paid against an invoice or bill (e.g. the accountant's monthly fee
-- paid by direct debit with no bill entered). The amount on the line is gross; vat_rate says how
-- much of it is VAT. NULL = not chosen yet, 0 = no VAT, 0.20 = 20% VAT included.
-- Lines matched to an invoice/bill take their VAT from that document instead.
ALTER TABLE transactions ADD COLUMN vat_rate REAL CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 1));

-- The VAT a line gets when this category is chosen (by hand or by a rule). NULL = ask each time.
ALTER TABLE expense_categories ADD COLUMN default_vat_rate REAL
  CHECK (default_vat_rate IS NULL OR (default_vat_rate >= 0 AND default_vat_rate <= 1));

-- Categories that never carry VAT: payments to HMRC, wages, loans, transfers, interest, insurance
UPDATE expense_categories SET default_vat_rate = 0
WHERE LOWER(name) IN (
  'vat payments / refunds', 'paye & ni', 'corporation tax', 'salaries & wages',
  'pension contributions', 'director''s loan', 'transfer between accounts',
  'bank interest received', 'insurance', 'client entertainment', 'debtors control account'
);

-- The VAT a rule gives the lines it categorises (overrides the category's). NULL = the category's.
ALTER TABLE categorisation_rules ADD COLUMN vat_rate REAL CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 1));
