-- A client's company, when the invoice is addressed to a person at a business. Optional:
-- `name` stays the required one (a person, or the business itself when there's no contact).
ALTER TABLE clients ADD COLUMN company_name TEXT;
