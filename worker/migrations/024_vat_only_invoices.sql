-- VAT-only invoices: after VAT registration, the VAT due on sales already invoiced without VAT
-- is charged on a separate invoice with no net amount, only the VAT. It points at the invoice
-- whose sale it charges VAT on, so it never counts as a new sale (net 0 in the P&L).
ALTER TABLE invoices ADD COLUMN vat_for_invoice_id TEXT REFERENCES invoices(id);
CREATE INDEX idx_invoices_vat_for ON invoices(vat_for_invoice_id);
