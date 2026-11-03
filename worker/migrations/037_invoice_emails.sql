-- Emailing invoices through Resend. Finalising an invoice doesn't send it: emailing is a separate,
-- optional step, and every email sent is kept here.

-- Who the email is from (the address must be on a domain verified in Resend) and the template the
-- Email invoice form starts from. NULL subject/body = the built-in default (services/invoiceEmail.ts).
ALTER TABLE company_settings ADD COLUMN email_from_name TEXT;
ALTER TABLE company_settings ADD COLUMN email_from_address TEXT;
ALTER TABLE company_settings ADD COLUMN invoice_email_subject TEXT;
ALTER TABLE company_settings ADD COLUMN invoice_email_body TEXT;

CREATE TABLE invoice_emails (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id),
  to_email    TEXT NOT NULL,
  cc          TEXT,                 -- comma-separated, or NULL
  subject     TEXT NOT NULL,
  resend_id   TEXT,                 -- Resend's message id
  sent_by     TEXT NOT NULL REFERENCES users(id),
  sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoice_emails_invoice ON invoice_emails(invoice_id, sent_at);
-- A repeated send (same idempotency key) gets the same id back from Resend: record it once
CREATE UNIQUE INDEX idx_invoice_emails_resend ON invoice_emails(resend_id);
