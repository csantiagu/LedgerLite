-- A 'link' match ties a bank receipt to money already recorded on an invoice imported from
-- QuickBooks (its 'Imported from QuickBooks' payment). Unlike a 'payment' match it never creates
-- a payment or changes amount_paid, so the receipt is explained without being counted twice.
ALTER TABLE transaction_matches ADD COLUMN kind TEXT NOT NULL DEFAULT 'payment'
  CHECK (kind IN ('payment', 'link'));
