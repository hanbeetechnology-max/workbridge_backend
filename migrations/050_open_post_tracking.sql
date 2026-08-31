-- Real effect of the business subscription tiers' "N job posts/month"
-- limit (BusinessPayments.jsx's SubscriptionTab / projects.controller.js's
-- createProject). worker_id alone can't answer "was this originally an
-- open job-board post" — it starts NULL for an open post but gets SET the
-- moment someone's hired, which would make a filled post silently stop
-- counting toward the month it was actually posted in. This column is set
-- once at creation and never changes, so the monthly count stays accurate
-- regardless of what happens to the post afterward.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS posted_as_open BOOLEAN NOT NULL DEFAULT FALSE;
-- Backfill: every existing project that started OPEN (worker_id was null
-- at some point, i.e., it EVER had an OPEN entry in its timeline, or is
-- currently OPEN) is treated as having been an open post — a one-time,
-- approximate correction for historical rows; every new project going
-- forward gets this set correctly at INSERT time by the application code.
UPDATE projects SET posted_as_open = TRUE
WHERE status = 'OPEN' OR timeline @> '[{"status": "OPEN"}]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_projects_business_open_created ON projects (business_id, posted_as_open, created_at);
