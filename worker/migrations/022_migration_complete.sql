-- When the owner marked the QuickBooks migration finished. While it's NULL, Find match can also
-- offer paid imported invoices so old bank receipts can be linked to their QuickBooks payment;
-- once set, bank lines can only be matched to open invoices and bills.
ALTER TABLE company_settings ADD COLUMN migration_completed_at TEXT;
