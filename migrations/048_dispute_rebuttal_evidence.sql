-- Dispute fairness pass: the accused party gets a real, structured chance
-- to respond (one rebuttal, not an open thread — ongoing back-and-forth
-- stays in chat, same boundary the original dispute reason already draws),
-- and both the original claim and the rebuttal can carry evidence images.
-- No object storage exists yet (see project_admin_docs_and_bank_security_plan
-- memory) — same base64-in-Postgres pattern already used for avatar_url,
-- course certificates, and escrow funding screenshots. Capped small
-- (enforced in code, not here) since this is evidence photos, not a
-- document vault.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dispute_evidence JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dispute_rebuttal TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dispute_rebuttal_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dispute_rebuttal_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dispute_rebuttal_evidence JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'DISPUTE_REBUTTAL_SUBMITTED';
ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'DISPUTE_SPLIT';
