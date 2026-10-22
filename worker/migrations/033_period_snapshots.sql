-- The VAT return figures of each quarter as they stood when it was locked, so a later change to a
-- reviewed quarter (a backdated credit note, VAT-only invoice or void, which stay allowed) shows up
-- against what was submitted. Locking again after an unlock takes a fresh snapshot.
CREATE TABLE period_snapshots (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  period_lock_id TEXT NOT NULL REFERENCES period_locks(id),
  period_start   TEXT NOT NULL,
  period_end     TEXT NOT NULL,
  scheme         TEXT NOT NULL CHECK (scheme IN ('standard', 'cash')),
  boxes          TEXT NOT NULL,   -- JSON: box1 … box9 in pence
  taken_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_period_snapshots_period ON period_snapshots(period_end, taken_at);
