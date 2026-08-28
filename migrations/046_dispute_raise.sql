-- Self-serve "Raise a Dispute" — until now DISPUTED was a real project
-- status with a full admin resolution flow (admin.controller.js's
-- resolveDispute) but nothing anywhere ever actually set a project TO
-- DISPUTED. This adds the missing trigger side: who raised it, why, and
-- when, so admin has real context instead of just a bare status flip.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dispute_raised_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;

ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'DISPUTE_RAISED';
