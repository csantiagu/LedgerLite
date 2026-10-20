-- One live VAT-only invoice per sale. Voided ones drop out of the index, so a replacement can be raised.
CREATE UNIQUE INDEX idx_invoices_one_live_vat
  ON invoices(vat_for_invoice_id)
  WHERE vat_for_invoice_id IS NOT NULL AND status != 'void';

-- Lines posted before VAT was recorded have a null rate. Profit and loss treated that as
-- "no VAT", while the accountant export called it "VAT not set". Store the category's usual
-- rate where it has one, and no VAT otherwise, so both reports agree. A line still in
-- For Review is left unset, so it is still asked before it is posted.
UPDATE transactions
SET vat_rate = COALESCE(
  (SELECT default_vat_rate FROM expense_categories WHERE id = transactions.expense_category_id),
  0
)
WHERE is_reconciled = 1
  AND vat_rate IS NULL
  AND expense_category_id IS NOT NULL;
