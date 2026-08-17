-- Incremental migration — see migrations/011_system_notices.sql for the
-- same pattern. Appended to schema.sql so a fresh `npm run migrate` still
-- gets this in one pass.
--
-- Replaces the tiered-by-level platform fee (migrations/012_gamification_
-- foundation.sql) with a single flat rate. gamification_config.platform_fee_pct
-- was never actually read by any query — projects.repository.js only ever
-- reads level_threshold/tier_name from this table (Silver-tier urgent-job
-- gate, tier display name) — so dropping the column removes dead, and now
-- stale, data rather than any live behavior.

ALTER TABLE gamification_config DROP CONSTRAINT chk_platform_fee_pct_range;
ALTER TABLE gamification_config DROP COLUMN platform_fee_pct;

-- The real, only fee rate going forward. Existing rows keep whatever value
-- they were created with; this only changes the default for new projects.
ALTER TABLE projects ALTER COLUMN platform_fee_pct SET DEFAULT 15.00;
