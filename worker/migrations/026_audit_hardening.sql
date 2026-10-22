-- The audit log is append-only: a change recorded there can't be edited or removed afterwards,
-- by the app or by anyone with a SQL console on the database.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- A line a person can read in the history ("Voided INV-2026-0012"), so the list doesn't need the JSON
ALTER TABLE audit_log ADD COLUMN summary TEXT;

-- One record's history, newest first
CREATE INDEX idx_audit_log_resource_time ON audit_log(resource_type, resource_id, created_at);
