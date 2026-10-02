-- Access tokens issued before this time (unix milliseconds) are rejected. Bumped when a user is
-- deactivated, changes their password or signs out everywhere.
ALTER TABLE users ADD COLUMN sessions_valid_after INTEGER NOT NULL DEFAULT 0;
