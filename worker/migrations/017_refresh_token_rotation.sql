-- Refresh tokens are single-use: each refresh revokes the old token and records when it was
-- replaced. A replaced token showing up again later means it was copied, so every session
-- for that user is revoked.
ALTER TABLE refresh_tokens ADD COLUMN replaced_at TEXT;
