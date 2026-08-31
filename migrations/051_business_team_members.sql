-- Real Enterprise-tier "Multi-User Access for your HR team" perk. A team
-- member is a normal users row (own email/password/login) that points back
-- at the real business account via business_owner_id — see auth.controller.js's
-- login()/issueToken(), which issue that team member a session token whose
-- `sub` is the OWNER's id (with a separate `teamMemberId` claim for their
-- own real identity). Every existing business feature (jobs, candidates,
-- chats, subscription, verification) keeps using req.user.id unchanged and
-- transparently operates as the shared business — only the handful of
-- "this is MY OWN login" endpoints (auth.controller.js/profiles.controller.js)
-- needed to change to resolve the real individual instead.
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_users_business_owner_id ON users (business_owner_id) WHERE business_owner_id IS NOT NULL;
