CREATE TABLE clients (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  address     TEXT,
  tax_id      TEXT,
  currency    TEXT NOT NULL DEFAULT 'GBP',
  notes       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vendors (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  address     TEXT,
  tax_id      TEXT,
  currency    TEXT NOT NULL DEFAULT 'GBP',
  notes       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE expense_categories (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_id   TEXT REFERENCES expense_categories(id),
  is_active   INTEGER NOT NULL DEFAULT 1
);

INSERT INTO expense_categories (id, name) VALUES
  (lower(hex(randomblob(16))), 'Office Supplies'),
  (lower(hex(randomblob(16))), 'Software & Subscriptions'),
  (lower(hex(randomblob(16))), 'Travel & Transport'),
  (lower(hex(randomblob(16))), 'Professional Services'),
  (lower(hex(randomblob(16))), 'Marketing & Advertising'),
  (lower(hex(randomblob(16))), 'Utilities'),
  (lower(hex(randomblob(16))), 'Rent & Office'),
  (lower(hex(randomblob(16))), 'Equipment & Hardware'),
  (lower(hex(randomblob(16))), 'Bank Charges'),
  (lower(hex(randomblob(16))), 'Other');
