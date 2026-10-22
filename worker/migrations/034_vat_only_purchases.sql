-- VAT that arrives on its own, with no net purchase: a supplier whose VAT registration was backdated
-- charges the VAT on supplies already invoiced without it.
--
-- A bill line can hold just a VAT amount (unit price 0, vat_amount set): the bill is a VAT-only
-- bill, reclaimed in box 4 on its date, never an expense. NULL = VAT worked out from the rate.
ALTER TABLE bill_items ADD COLUMN vat_amount INTEGER CHECK (vat_amount IS NULL OR vat_amount >= 0);

-- A category whose bank lines are entirely VAT (VAT suspense), for VAT paid or received with no
-- invoice or bill to match: money out is reclaimed (box 4), money in is due (box 1). Never in the P&L.
ALTER TABLE expense_categories ADD COLUMN vat_only INTEGER NOT NULL DEFAULT 0 CHECK (vat_only IN (0, 1));

INSERT OR IGNORE INTO expense_categories (id, name, description, default_vat_rate, vat_box, pl_line, vat_only)
VALUES (lower(hex(randomblob(16))), 'VAT Suspense',
  'Payments or receipts that are all VAT, with no bill or invoice to match (e.g. VAT a supplier charged after backdating their registration)',
  0, 'purchases', 'excluded', 1);
UPDATE expense_categories SET vat_only = 1, pl_line = 'excluded', default_vat_rate = 0
WHERE LOWER(name) = 'vat suspense';
