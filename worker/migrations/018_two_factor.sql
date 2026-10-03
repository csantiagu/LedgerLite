-- Two-factor login with an authenticator app (TOTP, RFC 6238).
-- Secrets are stored encrypted with the ENCRYPTION_KEY secret (services/secretBox.ts).
ALTER TABLE users ADD COLUMN totp_secret TEXT;          -- set once 2FA is confirmed
ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;  -- set while 2FA is being set up
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0; -- stops a code being used twice

CREATE TABLE recovery_codes (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_recovery_codes_user ON recovery_codes(user_id);
