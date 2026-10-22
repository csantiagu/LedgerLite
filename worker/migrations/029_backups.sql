-- Nightly backups to the BACKUPS R2 bucket (services/backup.ts). Each run is recorded here so the
-- dashboard can show the last good backup without listing the bucket.
CREATE TABLE backup_runs (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  kind        TEXT NOT NULL CHECK (kind IN ('database', 'files')),
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  object_key  TEXT,             -- the database export it wrote (kind = 'database')
  detail      TEXT              -- JSON: row counts and hashes, files copied, or the error
);
CREATE INDEX idx_backup_runs_kind ON backup_runs(kind, started_at);

-- Stored files (receipts, PDFs, logos, statements) already copied to the backup bucket. Keys are
-- never reused (every upload gets a new one), so a copied key never needs copying again.
CREATE TABLE backup_files (
  r2_key    TEXT PRIMARY KEY,
  copied_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 1 when the main bucket didn't have the file: it's reported, and not tried every hour
  missing   INTEGER NOT NULL DEFAULT 0
);
