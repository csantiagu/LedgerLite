-- Some purchases are still purchases (box 7) but the VAT on them cannot be reclaimed (not box 4).
-- Client entertainment is the one the books already describe that way.
ALTER TABLE expense_categories ADD COLUMN vat_reclaim INTEGER NOT NULL DEFAULT 1
  CHECK (vat_reclaim IN (0, 1));
UPDATE expense_categories SET vat_reclaim = 0 WHERE LOWER(name) = 'client entertainment';
