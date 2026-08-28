-- Real Team Access management (AdminTeamTab.jsx) — previously that whole
-- screen was local mock state with a success toast and nothing behind it.
-- No new columns needed (reuses users.is_active/can_ban_users/
-- can_release_funds, all already there) — just the audit-log actions for
-- the two real writes this adds: adding a new admin, and removing one.
ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'ADMIN_ADDED';
ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'ADMIN_REMOVED';
