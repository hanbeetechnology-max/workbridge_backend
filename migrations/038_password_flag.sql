-- Tracks whether a user has a real, typeable password. Google-only signups
-- get a random never-typeable password_hash (see migrations/029_google_oauth.sql)
-- so their "current password" can never be entered correctly — Settings'
-- Security tab uses this flag to switch to a "Set Password" flow (no
-- current-password field) for those accounts instead.
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_usable_password BOOLEAN NOT NULL DEFAULT true;
