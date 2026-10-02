CREATE TABLE bank_accounts (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name         TEXT NOT NULL,
  bank_name    TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'current'
               CHECK (account_type IN ('current','savings','credit','other')),
  last_four    TEXT,
  currency     TEXT NOT NULL DEFAULT 'GBP',
  csv_format   TEXT NOT NULL
               CHECK (csv_format IN ('barclays','hsbc','lloyds','natwest','monzo','starling')),
  notes        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
