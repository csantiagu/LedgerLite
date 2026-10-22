-- VAT quarters: the month any quarter ends in (3 = quarters end Mar, Jun, Sep, Dec)
ALTER TABLE company_settings ADD COLUMN vat_quarter_end_month INTEGER NOT NULL DEFAULT 3
  CHECK (vat_quarter_end_month BETWEEN 1 AND 12);

-- A reviewed VAT quarter. While a lock is active (unlocked_at IS NULL), nothing dated on or before
-- its period_end can change: the lock date is MAX(period_end) of the active locks. Rows are never
-- deleted; unlocking fills in unlocked_*, and locking again adds a new row.
CREATE TABLE period_locks (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  locked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  locked_by     TEXT NOT NULL REFERENCES users(id),
  note          TEXT,
  unlocked_at   TEXT,
  unlocked_by   TEXT REFERENCES users(id),
  unlock_reason TEXT,
  CHECK (period_start <= period_end),
  CHECK ((unlocked_at IS NULL) = (unlock_reason IS NULL))
);
-- One active lock per quarter end
CREATE UNIQUE INDEX idx_period_locks_active ON period_locks(period_end) WHERE unlocked_at IS NULL;
