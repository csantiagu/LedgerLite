-- Where an invoice came from. Invoices imported from QuickBooks keep their original number and
-- PDF, are never redrawn, and (like every non-draft invoice) can't be edited, only voided.
ALTER TABLE invoices ADD COLUMN source TEXT NOT NULL DEFAULT 'ledgerlite'
  CHECK (source IN ('ledgerlite', 'quickbooks'));
