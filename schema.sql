-- WorkBridge — PostgreSQL Schema
-- Design notes at the bottom of this file explain the non-obvious calls.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";   -- case-insensitive email uniqueness/lookups

-- ─── Enums ──────────────────────────────────────────────────────────────────

CREATE TYPE user_role AS ENUM ('worker', 'business', 'admin');

-- Mirrors the frontend's PROJECT_STATUS_FLOW exactly (utils/projectStatus.js),
-- plus two terminal states the demo build never modeled: CANCELLED/DISPUTED.
CREATE TYPE project_status AS ENUM (
  'OPEN',              -- public job post, no worker assigned yet — see job_candidates
  'INVITED',           -- business has proposed/invited, worker hasn't responded
  'ACCEPTED',           -- worker accepted (or business hired) but no funds moved yet
  'PENDING_FUNDS',      -- business submitted transfer proof (see fundEscrow); only WorkBridge staff verifying it grants FUNDS_SECURED
  'FUNDS_SECURED',
  'WORK_IN_PROGRESS',
  'FILES_SUBMITTED',
  'PENDING_RELEASE',   -- business requested release (see requestRelease); only WorkBridge staff can complete the payout from here
  'COMPLETED',
  'CANCELLED',
  'DISPUTED'
);

CREATE TYPE transaction_type AS ENUM (
  'FUNDS_SECURED',          -- business's payment moves into holding
  'PLATFORM_FEE',           -- WorkBridge's cut withheld from the worker's payout (7%)
  'PLATFORM_FEE_BUSINESS',  -- WorkBridge's cut collected from the business at checkout (8%)
  'PAYOUT',                 -- worker's earnings released to their wallet or bank
  'WITHDRAWAL',      -- worker cashes out of WorkBridge to their bank/UPI
  'REFUND'
);

CREATE TYPE transaction_direction AS ENUM ('credit', 'debit');

-- Named funds_status, not escrow_status — WorkBridge product copy never
-- uses "escrow" (funds/secured/protection instead); kept consistent here
-- even though this is an internal schema term, not user-facing text.
CREATE TYPE funds_status AS ENUM ('HELD', 'RELEASED', 'REFUNDED');

-- Razorpay Route linked-account state for a worker's payout destination —
-- see migrations/040_razorpay_route.sql. (Route itself is unused — Cashfree
-- has no equivalent concept — but this column/type still exists on the
-- live database from before that migration, so the name stays as-is.)
CREATE TYPE razorpay_account_status AS ENUM
  ('NOT_LINKED', 'PENDING', 'ACTIVE', 'NEEDS_CLARIFICATION', 'REJECTED');

-- Manual pay-per-period subscriptions (not recurring auto-charge — see
-- migrations/041_subscription_payments.sql). GROWTH/ENTERPRISE are
-- business tiers, PRO/ELITE are worker tiers; one enum covers both since a
-- payment row is scoped to one user whose role already determines which
-- subset is valid (enforced in payments.controller.js, not the DB).
CREATE TYPE subscription_tier AS ENUM ('FREE', 'GROWTH', 'ENTERPRISE', 'PRO', 'ELITE');
CREATE TYPE subscription_billing_period AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE subscription_payment_status AS ENUM ('PENDING', 'PAID', 'FAILED');

-- A job post's minimum qualification level — paired with education_notes
-- (free text like "Computer Science or equivalent") since real education
-- requirements vary too much for a fixed enum alone to capture.
CREATE TYPE education_level AS ENUM ('ANY', 'HIGH_SCHOOL', 'DIPLOMA', 'BACHELORS', 'MASTERS', 'PHD');

-- MASTER_ECONOMY_PLAN.md's Two-Door Reveal — 'hidden' until a worker
-- reaches Door A (first completed job) or Door B (5 consecutive
-- rejections); the app layer flips this, not the schema.
CREATE TYPE standing_door_state AS ENUM ('hidden', 'win', 'span');

-- ─── updated_at trigger ─────────────────────────────────────────────────────
-- Applied to all 4 tables below so "updated_at" is a real audit fact, not a
-- column the application has to remember to touch by hand.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 1. users ───────────────────────────────────────────────────────────────
-- One table for all three roles rather than three separate profile tables —
-- worker/business-specific fields that don't apply to every role live in
-- `profile` (JSONB) instead of a long list of always-nullable columns.
-- Contact fields (email/phone) live here but are NEVER selected into a
-- public-facing response without an auth check — see public_user_profiles
-- view below, which is the only thing an unauthenticated API route should
-- ever query.

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role              user_role NOT NULL,
  name              TEXT NOT NULL,
  email             CITEXT NOT NULL UNIQUE,
  phone             TEXT,
  password_hash     TEXT NOT NULL,
  -- Google's stable "sub" claim, set the first time this person uses
  -- "Continue with Google" (POST /api/auth/google) — nullable since most
  -- accounts still sign up with a password, UNIQUE so one Google account
  -- can never link to two different users. password_hash still gets a
  -- random, never-typeable bcrypt hash for these accounts rather than
  -- going nullable — see migrations/029_google_oauth.sql.
  google_id         TEXT UNIQUE,
  -- False only for the brand-new-Google-signup branch of googleAuth()
  -- (see migrations/038_password_flag.sql) — those accounts' password_hash
  -- is the random, never-typeable value above, so "Change Password"'s
  -- current-password check can never succeed for them by construction.
  -- Settings' Security tab reads this to show a "Set Password" flow instead
  -- (skips the current-password field entirely) rather than an impossible one.
  has_usable_password BOOLEAN NOT NULL DEFAULT true,
  avatar_url        TEXT,
  title             TEXT,                          -- e.g. "Full-Stack Developer" (worker) / "Retail" (business industry)
  verified          BOOLEAN NOT NULL DEFAULT FALSE, -- ID-verified worker / payment-verified business
  -- Registration-OTP confirmed — NOT the same flag as `verified` above (see
  -- migrations/005_email_verified.sql). Defaults TRUE for fresh-install/seed
  -- rows; only POST /api/auth/register explicitly sets this FALSE for a new
  -- signup awaiting its OTP.
  email_verified    BOOLEAN NOT NULL DEFAULT TRUE,
  -- Real account ban — set FALSE by Security Monitor's "Ban User" action
  -- (admin.controller.js's resolveBlockedAttempt). Checked at login
  -- (auth.controller.js) and on every authenticated request (guard.js), so
  -- a ban actually stops someone, not just future logins.
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  -- The Dual-Ban Moderation Engine's softer sibling to is_active above — a
  -- full ban (is_active = false) invalidates the session and blocks login
  -- entirely, which traps a business's escrowed funds mid-project if the
  -- real issue was only chat behavior. is_chat_banned only ever gates
  -- sending a chat message (messages.controller.js's assertNotChatBanned);
  -- it never touches login, submissions, or payouts. See migrations/032_chat_ban.sql.
  is_chat_banned    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Real, server-persisted Onboarding Wizard completion flag — not a
  -- localStorage-only flag, so it doesn't reappear on a different device.
  -- See migrations/033_onboarding.sql.
  has_completed_onboarding BOOLEAN NOT NULL DEFAULT FALSE,
  -- Per-category push notification preferences (Settings > Notifications).
  -- See migrations/039_notification_prefs.sql.
  notification_prefs JSONB NOT NULL DEFAULT '{"chat": true, "projects": true, "payments": true}'::jsonb,
  -- Razorpay Route linked account — a worker's payout destination. Only
  -- the acc_XXXX id/status/email are ever stored; raw bank details go
  -- straight to Razorpay and are never persisted here. See
  -- migrations/040_razorpay_route.sql. Unused (Route stays disabled —
  -- Cashfree has no equivalent), kept as-is to match the live database.
  razorpay_account_id     TEXT UNIQUE,
  razorpay_account_status razorpay_account_status NOT NULL DEFAULT 'NOT_LINKED',
  razorpay_account_email  TEXT,
  razorpay_linked_at      TIMESTAMPTZ,
  -- Cached current-plan lookup for the manual pay-per-period subscription
  -- flow — see migrations/041_subscription_payments.sql.
  subscription_tier       subscription_tier NOT NULL DEFAULT 'FREE',
  subscription_expires_at TIMESTAMPTZ,
  -- Minimal real Support-tier RBAC — meaningless for worker/business rows,
  -- only ever checked when role = 'admin'. Defaults TRUE so every admin
  -- account keeps the full access it already had; a super admin dials an
  -- individual admin's rights back via Team Access. See
  -- migrations/034_admin_permissions.sql.
  can_ban_users     BOOLEAN NOT NULL DEFAULT TRUE,
  can_release_funds BOOLEAN NOT NULL DEFAULT TRUE,
  behavior_score    SMALLINT,                       -- 0–1000 trust metric; workers/businesses only
  rating            NUMERIC(3, 2),                  -- cached avg of reviews.rating for this user
  reviews_count     INTEGER NOT NULL DEFAULT 0,
  wallet_balance    NUMERIC(12, 2) NOT NULL DEFAULT 0, -- cached; transactions is the source of truth (see notes)
  profile           JSONB NOT NULL DEFAULT '{}',     -- role-specific extras: skills[], hourly_rate, company_size, etc.
  -- MASTER_ECONOMY_PLAN.md Phase 1 — the Worker Economy data foundation.
  -- Conceptually worker-only, but left unrestricted by role at the schema
  -- level (same precedent as wallet_balance above) — the business-side
  -- Ledger/XP track is a later phase, not modeled here yet. No app logic
  -- reads/writes these yet, and they're deliberately absent from
  -- public_user_profiles below — the Two-Door Reveal's entire point is
  -- that xp/current_level stay hidden until standing_door leaves 'hidden'.
  xp                INTEGER NOT NULL DEFAULT 0,
  current_level     INTEGER NOT NULL DEFAULT 1,
  bridge_tokens     INTEGER NOT NULL DEFAULT 0,
  current_streak    INTEGER NOT NULL DEFAULT 0,
  -- Set on every successful login (see users.repository.js's recordLogin);
  -- compared against now() there to decide whether current_streak
  -- increments, resets to 1, or holds steady on a same-day repeat login.
  last_login_at     TIMESTAMPTZ,
  standing_door     standing_door_state NOT NULL DEFAULT 'hidden',
  -- The single badge (a MILESTONES level from WorkerMilestones.jsx) a
  -- worker has chosen to show as a small overlay icon on their avatar —
  -- always exactly one, never a 3-badge loadout. Masked to NULL in
  -- public_user_profiles below until standing_door leaves 'hidden', same
  -- Two-Door Reveal gate as xp/current_level.
  pinned_milestone_level INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Admin accounts don't carry a Behavior Score — it's a worker/business
  -- trust metric, meaningless for platform staff.
  CONSTRAINT chk_admin_has_no_behavior_score
    CHECK (role <> 'admin' OR behavior_score IS NULL),

  CONSTRAINT chk_behavior_score_range
    CHECK (behavior_score IS NULL OR behavior_score BETWEEN 0 AND 1000),

  CONSTRAINT chk_rating_range
    CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),

  CONSTRAINT chk_xp_non_negative CHECK (xp >= 0),
  CONSTRAINT chk_current_level_min CHECK (current_level >= 1),
  CONSTRAINT chk_bridge_tokens_non_negative CHECK (bridge_tokens >= 0),
  CONSTRAINT chk_current_streak_non_negative CHECK (current_streak >= 0),

  CONSTRAINT chk_pinned_milestone_level
    CHECK (pinned_milestone_level IS NULL OR pinned_milestone_level IN (5, 10, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 175, 200))
);

CREATE INDEX idx_users_role ON users (role);

-- Originally the registration-OTP store; superseded there by
-- pending_signups below (which holds the OTP alongside the rest of a
-- not-yet-verified signup). Repurposed for password-reset codes instead of
-- standing up a near-identical second table — see auth.repository.js's
-- createPasswordResetOtp/findLatestPasswordResetOtp/deletePasswordResetOtp.
CREATE TABLE IF NOT EXISTS auth_otps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier   TEXT NOT NULL,
  role         user_role NOT NULL,
  otp_code     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_otps_identifier_role ON auth_otps (identifier, role);
CREATE INDEX IF NOT EXISTS idx_auth_otps_expires_at ON auth_otps (expires_at);

-- Holds signup details temporarily between POST /api/auth/register and a
-- successful POST /api/auth/verify-otp — see migrations/006_pending_signups.sql
-- for the full rationale (the real `users` row is only created once
-- verification succeeds, so an abandoned signup never touches `users`).
CREATE TABLE IF NOT EXISTS pending_signups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          CITEXT NOT NULL UNIQUE,
  role           user_role NOT NULL,
  name           TEXT NOT NULL,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  otp_code       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(), -- doubles as "OTP last (re)sent at"
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_signups_email ON pending_signups (email);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The only view an unauthenticated (or cross-user) API route should read
-- from — email and phone are structurally absent, not just filtered by the
-- application layer, so a forgotten `WHERE` clause can't leak them.
-- `profile` IS included — it's the free-form public professional info
-- (skills/hourly_rate/bio/location, set via PATCH /api/profiles/me), not
-- PII, and BusinessWorkers.jsx's browse-workers listing needs it.
CREATE VIEW public_user_profiles AS
  SELECT id, role, name, avatar_url, title, verified, behavior_score,
         rating, reviews_count, created_at, profile,
         -- Two-Door Reveal gate — see the xp/current_level note above; a
         -- pinned badge is a proxy for the same hidden progress, so it
         -- stays masked to NULL until standing_door leaves 'hidden'.
         CASE WHEN standing_door <> 'hidden' THEN pinned_milestone_level ELSE NULL END AS pinned_milestone_level
  FROM users;

-- ─── 2. projects ────────────────────────────────────────────────────────────
-- The canonical replacement for the frontend's invitesDb + businessThreadsDb
-- split — one row per project, always linked to exactly one worker and one
-- business (never nullable; a project can't exist without both parties,
-- unlike the old "qa" pre-hire threads which only had a business + candidate
-- with no committed worker yet — model those as INVITED/ACCEPTED status
-- instead of a nullable worker_id).

CREATE TABLE projects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Nullable: an OPEN job post has no worker yet — see job_candidates for
  -- how one eventually gets assigned (application accepted, or a direct
  -- invite accepted). Every other status always carries a real worker_id.
  worker_id         UUID REFERENCES users(id) ON DELETE RESTRICT,
  title             TEXT NOT NULL,
  description       TEXT,
  budget            NUMERIC(12, 2) NOT NULL CHECK (budget > 0),
  -- Deprecated in favor of business_fee_pct/worker_fee_pct below — kept,
  -- untouched, only for historical rows created before the disclosed
  -- split; no code path reads it anymore. See migrations/040_razorpay_route.sql.
  platform_fee_pct  NUMERIC(5, 2) NOT NULL DEFAULT 15.00,
  -- The disclosed split: business pays budget+business_fee_pct at
  -- checkout, worker receives budget-worker_fee_pct at payout.
  business_fee_pct  NUMERIC(5, 2) NOT NULL DEFAULT 8.00,
  worker_fee_pct    NUMERIC(5, 2) NOT NULL DEFAULT 7.00,
  -- 'RAZORPAY' is the actual live value — Cashfree's pay-in flow reuses it
  -- (and the razorpay_order_id/payment_id/refund_id columns below)
  -- unchanged rather than a schema migration; see cashfree.service.js.
  funding_method    TEXT NOT NULL DEFAULT 'RAZORPAY'
    CHECK (funding_method IN ('RAZORPAY', 'MANUAL_BANK_TRANSFER')),
  razorpay_order_id     TEXT UNIQUE,
  razorpay_payment_id   TEXT,
  razorpay_transfer_id  TEXT,
  razorpay_refund_id    TEXT,
  -- Self-serve "Raise a Dispute" context — see migrations/046_dispute_raise.sql.
  dispute_reason      TEXT,
  dispute_raised_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  disputed_at         TIMESTAMPTZ,
  -- The accused party's one-shot structured response, plus evidence images
  -- for both sides — see migrations/048_dispute_rebuttal_evidence.sql.
  dispute_evidence          JSONB NOT NULL DEFAULT '[]'::jsonb,
  dispute_rebuttal          TEXT,
  dispute_rebuttal_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  dispute_rebuttal_at       TIMESTAMPTZ,
  dispute_rebuttal_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  status            project_status NOT NULL DEFAULT 'INVITED',
  deadline          DATE,
  -- Distinct from `deadline` above (the DELIVERY date) — application_deadline
  -- is when an OPEN post stops accepting new applicants; estimated_duration
  -- is a free-text expectation of how long the work itself should take
  -- once assigned (e.g. "3 Days", "2 Weeks"), shown on job cards.
  application_deadline TIMESTAMPTZ,
  estimated_duration   TEXT,
  -- Real, structured job requirements — Required Skills used to just get
  -- folded into `description` as a comma-separated blob; experience/
  -- education had no representation at all. See migrations/018_job_qualifications.sql.
  min_experience_years SMALLINT CHECK (min_experience_years >= 0),
  max_experience_years SMALLINT CHECK (max_experience_years >= 0),
  education_level      education_level NOT NULL DEFAULT 'ANY',
  education_notes      TEXT,
  required_skills      TEXT[] NOT NULL DEFAULT '{}',
  -- Real effect (no subscription gating — deferred): urgent posts sort
  -- first on the Job Board and are visible to Silver-tier+ workers
  -- immediately, with a short public delay for everyone else. See
  -- migrations/019_urgent_matching.sql.
  is_urgent         BOOLEAN NOT NULL DEFAULT false,
  -- migrations/036_budget_negotiation.sql — the worker's pending counter-
  -- offer while status = ACCEPTED (pre-funding). Set together; cleared
  -- together whether the business accepts (into `budget`) or declines.
  proposed_budget   NUMERIC(12, 2),
  proposed_by       UUID REFERENCES users(id),
  -- Set once the "deadline in 1 day" push reminder actually fires (see
  -- services/deadlineReminders.js) so the periodic scheduler doesn't
  -- re-notify the same project every time it runs.
  deadline_reminder_sent_at TIMESTAMPTZ,
  -- Append-only FSM history, e.g. [{"status": "FUNDS_SECURED", "at": "..."}].
  -- A normalized project_timeline_events table (project_id, status,
  -- occurred_at) would be the more correct audit-trail design — recommended
  -- if you want real per-event querying/indexing later; kept as JSONB here
  -- to stay within the 4 core tables asked for.
  timeline          JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_worker_business_distinct CHECK (worker_id <> business_id),
  CONSTRAINT chk_experience_range
    CHECK (max_experience_years IS NULL OR min_experience_years IS NULL OR max_experience_years >= min_experience_years)
);

CREATE INDEX idx_projects_business_id ON projects (business_id);
CREATE INDEX idx_projects_worker_id   ON projects (worker_id);
CREATE INDEX idx_projects_status      ON projects (status);
CREATE INDEX idx_projects_is_urgent   ON projects (is_urgent) WHERE is_urgent = true;

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Enforces "strictly links to a Worker and a Business" at the data layer,
-- not just by column naming — a plain FK can't check the referenced row's
-- role, so this needs a trigger.
CREATE OR REPLACE FUNCTION enforce_project_participant_roles()
RETURNS TRIGGER AS $$
DECLARE
  business_role user_role;
  worker_role   user_role;
BEGIN
  SELECT role INTO business_role FROM users WHERE id = NEW.business_id;
  IF business_role IS DISTINCT FROM 'business' THEN
    RAISE EXCEPTION 'projects.business_id (%) must reference a user with role = business', NEW.business_id;
  END IF;

  -- worker_id is only ever NULL for an OPEN post — nothing to check yet.
  IF NEW.worker_id IS NOT NULL THEN
    SELECT role INTO worker_role FROM users WHERE id = NEW.worker_id;
    IF worker_role IS DISTINCT FROM 'worker' THEN
      RAISE EXCEPTION 'projects.worker_id (%) must reference a user with role = worker', NEW.worker_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_projects_enforce_roles
  BEFORE INSERT OR UPDATE OF business_id, worker_id ON projects
  FOR EACH ROW EXECUTE FUNCTION enforce_project_participant_roles();

-- ─── 3. transactions ────────────────────────────────────────────────────────
-- The wallet ledger — every credit/debit against a worker's wallet_balance
-- (and, for FUNDS_SECURED/PLATFORM_FEE rows, the business's payment) is a
-- row here. business_id/worker_id are denormalized off `projects` for query
-- convenience (list a user's transactions without a join) but project_id
-- remains the source of truth for which project they belong to.

CREATE TABLE transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: a WITHDRAWAL is a worker cashing out their own wallet, not
  -- tied to any one project or business. Every other transaction type
  -- (FUNDS_SECURED/PLATFORM_FEE/PAYOUT/REFUND) is project-scoped and must
  -- carry both — enforced by chk_project_scoped_unless_withdrawal below.
  project_id        UUID REFERENCES projects(id) ON DELETE RESTRICT,
  worker_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  business_id       UUID REFERENCES users(id) ON DELETE RESTRICT,
  type              transaction_type NOT NULL,
  direction         transaction_direction NOT NULL,
  amount            NUMERIC(12, 2) NOT NULL CHECK (amount > 0), -- always positive; direction carries the sign
  currency          CHAR(3) NOT NULL DEFAULT 'INR',
  funds_status      funds_status,
  reference_note    TEXT,
  -- Distinguishes a worker's real bank payout (Route transfer) from an
  -- in-app wallet credit awaiting manual withdrawal — completeProject
  -- picks between them per-project. See migrations/040_razorpay_route.sql.
  -- RAZORPAYX_PAYOUT — a direct RazorpayX payout to the worker's saved
  -- bank/UPI details (see users.payout_method/payout_details above),
  -- distinct from RAZORPAY_ROUTE_AUTO. See migrations/044_worker_payout_account.sql.
  -- Both labels are stale (actual payouts run through Cashfree now — see
  -- cashfree.service.js) but reused unchanged rather than migrated.
  settlement_method TEXT NOT NULL DEFAULT 'WALLET'
    CHECK (settlement_method IN ('WALLET', 'RAZORPAY_ROUTE_AUTO', 'WALLET_PENDING_MANUAL', 'RAZORPAYX_PAYOUT')),
  -- Set once staff actually wire a WALLET_PENDING_MANUAL payout by hand
  -- (NEFT/RTGS) — see migrations/047_manual_payout_tracking.sql. Keeps
  -- settlement_method itself as the honest historical record (it wasn't
  -- auto-settled via Cashfree) while still letting the Admin Panel clear it
  -- off the "who do I owe money to" list.
  manual_payout_completed_at TIMESTAMPTZ,
  manual_payout_note         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_project_scoped_unless_withdrawal
    CHECK (type = 'WITHDRAWAL' OR (project_id IS NOT NULL AND business_id IS NOT NULL))
);

CREATE INDEX idx_transactions_project_id  ON transactions (project_id);
CREATE INDEX idx_transactions_settlement_method ON transactions (settlement_method) WHERE settlement_method = 'WALLET_PENDING_MANUAL';
CREATE INDEX idx_transactions_worker_id   ON transactions (worker_id);
CREATE INDEX idx_transactions_business_id ON transactions (business_id);
CREATE INDEX idx_transactions_created_at  ON transactions (created_at DESC);

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 3b. withdrawal_requests ────────────────────────────────────────────────
-- A worker's cash-out request, with its own real lifecycle — PENDING the
-- moment they request it (wallet_balance is debited immediately, so the
-- same funds can't be withdrawn twice), then APPROVED (staff actually sent
-- the money — a real transactions.WITHDRAWAL row is written at that point)
-- or REJECTED (staff couldn't complete it — wallet_balance is refunded).
-- See migrations/016_withdrawal_requests.sql.

CREATE TYPE withdrawal_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE payout_method AS ENUM ('UPI', 'BANK_TRANSFER');

-- A worker's saved default payout destination — added after this enum
-- since users is created above, before payout_method exists. Lets
-- completeProject/resolveDispute pay a worker directly (via Cashfree
-- Payouts now — see cashfree.service.js) at completion without the (still
-- RBI-blocked) Route linked-account flow.
-- See migrations/044_worker_payout_account.sql.
ALTER TABLE users ADD COLUMN payout_method payout_method;
ALTER TABLE users ADD COLUMN payout_details TEXT;

CREATE TABLE withdrawal_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       UUID NOT NULL REFERENCES users(id),
  amount          NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payout_method   payout_method NOT NULL,
  payout_details  TEXT NOT NULL,
  status          withdrawal_status NOT NULL DEFAULT 'PENDING',
  admin_note      TEXT,
  resolved_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX idx_withdrawal_requests_status ON withdrawal_requests (status, created_at);
CREATE INDEX idx_withdrawal_requests_worker ON withdrawal_requests (worker_id, created_at DESC);

-- ─── 4. reviews ─────────────────────────────────────────────────────────────
-- The Success Hub's rating/review submission — one row per (project,
-- reviewer). A completed project produces up to two rows: worker rates
-- business, business rates worker.

CREATE TABLE reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  reviewer_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewee_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rating            SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  feedback          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_reviewer_reviewee_distinct CHECK (reviewer_id <> reviewee_id),
  CONSTRAINT uq_one_review_per_project_per_reviewer UNIQUE (project_id, reviewer_id)
);

CREATE INDEX idx_reviews_project_id  ON reviews (project_id);
CREATE INDEX idx_reviews_reviewee_id ON reviews (reviewee_id);

CREATE TRIGGER trg_reviews_updated_at
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 5. platform_logs ───────────────────────────────────────────────────────
-- The admin audit trail — every admin "Execute" action (verify, resolve
-- dispute) writes one row here, inside the SAME transaction as the action
-- itself, so a failed log write rolls back the whole action instead of
-- leaving an un-audited state change. See migrations/002_platform_logs.sql
-- for the incremental version of this same addition.

CREATE TYPE platform_log_action AS ENUM (
  'VERIFY_APPROVED',
  'VERIFY_REJECTED',
  'DISPUTE_RAISED',
  'DISPUTE_REBUTTAL_SUBMITTED',
  'DISPUTE_REFUNDED',
  'DISPUTE_RELEASED',
  'DISPUTE_SPLIT',
  'SUBMISSION_APPROVED',
  'SUBMISSION_REJECTED',
  'SECURITY_REDACTED_AND_SENT',
  'SECURITY_USER_BANNED',
  'SECURITY_WARNING_SENT',
  'SECURITY_DISMISSED',
  'SECURITY_USER_UNBANNED',
  'SECURITY_POINTS_DEDUCTED',
  'SECURITY_CHAT_BANNED',
  'SECURITY_CHAT_UNBANNED',
  'PERMISSIONS_UPDATED',
  'ADMIN_ADDED',
  'ADMIN_REMOVED'
);

CREATE TABLE platform_logs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action             platform_log_action NOT NULL,
  target_user_id     UUID REFERENCES users(id) ON DELETE RESTRICT,
  target_project_id  UUID REFERENCES projects(id) ON DELETE RESTRICT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_logs_admin_id ON platform_logs (admin_id);
CREATE INDEX idx_platform_logs_target_project_id ON platform_logs (target_project_id);

CREATE TRIGGER trg_platform_logs_updated_at
  BEFORE UPDATE ON platform_logs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 6. submissions ─────────────────────────────────────────────────────────
-- The Trust Checker — every deliverable either participant shares on a
-- project (a worker's finished-work link/image, or a business's reference
-- material) sits in PENDING_REVIEW until an admin looks at it. The
-- counterparty never sees a submission until it's APPROVED — enforced by
-- the API layer (submissions.controller.js), since a plain SELECT can't
-- express "unless you're the submitter."
--
-- `url` (type='link') is the primary path — Google Drive/Dropbox/OneDrive/
-- any URL — since there's no object-storage (S3/GCS) integration yet.
-- `image_data` (type='image') is a small direct upload, stored as a data URL
-- the same way users.avatar_url is; it is NOT a general file-upload
-- mechanism and is capped client+server-side at a few MB, never 50-500MB —
-- that scale of binary needs real object storage, not a Postgres TEXT column.

CREATE TYPE submission_type AS ENUM ('link', 'image');
CREATE TYPE submission_status AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

CREATE TABLE submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  submitted_by      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type              submission_type NOT NULL,
  url               TEXT,
  image_data        TEXT,
  caption           TEXT,
  status            submission_status NOT NULL DEFAULT 'PENDING_REVIEW',
  reviewed_by       UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_submission_content CHECK (
    (type = 'link' AND url IS NOT NULL) OR (type = 'image' AND image_data IS NOT NULL)
  )
);

CREATE INDEX idx_submissions_project_id ON submissions (project_id);
CREATE INDEX idx_submissions_status ON submissions (status);

CREATE TRIGGER trg_submissions_updated_at
  BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 6b. chat_threads ───────────────────────────────────────────────────────
-- One row per (business, worker) pair — a persistent conversation that
-- spans every project they've ever done together, rather than a fresh chat
-- per project. Created lazily the moment a project between the two first
-- gets a real worker_id — a direct invite (projects.controller.js's
-- createProject) or an accepted open-post candidacy
-- (job_candidates.controller.js's respondToCandidate) — mirroring
-- messages.controller.js's mustBeParticipant, which has always allowed chat
-- as soon as a real worker_id exists, not just after acceptance. Reused for
-- every project after that. See migrations/031_chat_threads.sql.

CREATE TABLE chat_threads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  worker_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_chat_threads_business_worker UNIQUE (business_id, worker_id)
);

CREATE INDEX idx_chat_threads_business_id ON chat_threads (business_id);
CREATE INDEX idx_chat_threads_worker_id ON chat_threads (worker_id);

CREATE TRIGGER trg_chat_threads_updated_at
  BEFORE UPDATE ON chat_threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 7. messages ────────────────────────────────────────────────────────────
-- Real-time chat. Originally strictly per-project (invite through
-- completion); migrations/031_chat_threads.sql layered a persistent
-- per-relationship thread_id on top without breaking the original shape —
-- project_id stays populated for every message the per-project
-- /api/projects/:id/messages routes write (unchanged behavior), while
-- thread_id additionally points at the (business, worker) pair's one
-- continuous conversation across every project they've ever done together,
-- which the newer /api/threads/:id routes read from. A message either
-- carries text (body) or wraps a shared file (submission_id, reusing the
-- existing Trust Checker moderation pipeline — see messages.repository.js
-- for how visibility mirrors submissions' own "submitter sees any status,
-- counterparty only sees APPROVED" rule).

CREATE TABLE messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: a message sent through the thread-wide route with no single
  -- project in mind (general conversation, not a deliverable) has no
  -- project_id at all. Still set for every per-project-route message and for
  -- any attachment (a deliverable always belongs to exactly one project).
  project_id        UUID REFERENCES projects(id) ON DELETE CASCADE,
  sender_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body              TEXT,
  submission_id     UUID REFERENCES submissions(id) ON DELETE SET NULL,
  -- Message Monitor's "Warn" action (admin.controller.js's moderateUser) —
  -- a real, permanent chat message both sides see, rendered as a system
  -- banner (not attributed to either participant) instead of a normal
  -- bubble. sender_id is still the issuing admin's id (FK requires a real
  -- user), this flag is what tells ChatThread.jsx to render it differently.
  is_system_notice  BOOLEAN NOT NULL DEFAULT FALSE,
  -- The (business, worker) pair's persistent conversation this message
  -- belongs to — see chat_threads below. Backfilled for every pre-existing
  -- message by migrations/031_chat_threads.sql; every new message gets one
  -- resolved server-side (messages.controller.js), never client-supplied.
  thread_id         UUID REFERENCES chat_threads(id) ON DELETE CASCADE,
  -- WhatsApp-style "reply to this message" — see migrations/045_message_reply.sql.
  reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_message_content CHECK (body IS NOT NULL OR submission_id IS NOT NULL)
);

CREATE INDEX idx_messages_project_id_created_at ON messages (project_id, created_at);
CREATE INDEX idx_messages_thread_id_created_at ON messages (thread_id, created_at);
CREATE INDEX idx_messages_reply_to_message_id ON messages (reply_to_message_id);

-- ─── 7b. user_blocks ────────────────────────────────────────────────────────
-- WhatsApp-style blocking: either participant on a chat can block the
-- other — blocks messaging in BOTH directions, reversible any time by the
-- blocker. A plain user-to-user relationship, not scoped to one project.
-- See migrations/017_user_blocks.sql.

CREATE TABLE user_blocks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_blocks UNIQUE (blocker_id, blocked_id),
  CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id)
);

CREATE INDEX idx_user_blocks_blocker ON user_blocks (blocker_id);
CREATE INDEX idx_user_blocks_blocked ON user_blocks (blocked_id);

-- ─── 7c. support_threads / support_messages ─────────────────────────────────
-- Real-time Customer Care — one continuous support conversation per user
-- with WorkBridge staff, separate from project chat since it isn't scoped
-- to any one project. See migrations/020_support_threads.sql.

CREATE TYPE support_status AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE support_threads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status      support_status NOT NULL DEFAULT 'OPEN',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_support_threads_user UNIQUE (user_id)
);

CREATE TABLE support_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sender_role  user_role NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_messages_thread_id ON support_messages (thread_id, created_at);
CREATE INDEX idx_support_threads_status ON support_threads (status, updated_at DESC);

CREATE TRIGGER trg_support_threads_updated_at
  BEFORE UPDATE ON support_threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 8. job_candidates ──────────────────────────────────────────────────────
-- The Open Job Board — a project can start life unassigned (worker_id
-- NULL, status OPEN), visible to every worker on the public feed. Workers
-- apply, or a business can directly invite one specific worker to an
-- already-open post without creating a second project — both paths are
-- "candidacies" against the SAME open project row, and the project itself
-- is only ever assigned a worker at the moment one candidacy is accepted
-- (by whichever side didn't initiate it: the business accepts an
-- application, the worker accepts an invite). Nothing about a pending
-- candidacy mutates the project row, so the public feed (WHERE status =
-- 'OPEN') stays accurate for every candidate still deciding — including an
-- invited worker who hasn't responded yet.

CREATE TYPE job_candidate_source AS ENUM ('APPLICATION', 'INVITE');
CREATE TYPE job_candidate_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CLOSED');

CREATE TABLE job_candidates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  worker_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source        job_candidate_source NOT NULL,
  status        job_candidate_status NOT NULL DEFAULT 'PENDING',
  message       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);

CREATE INDEX idx_job_candidates_project_id ON job_candidates (project_id);
CREATE INDEX idx_job_candidates_worker_id  ON job_candidates (worker_id);

-- Only an outstanding PENDING candidacy blocks a duplicate — once a prior
-- one is DECLINED or CLOSED, the same worker can be invited/apply again on
-- a job post that's still open (see migrations/025_reinvite_after_decision.sql).
CREATE UNIQUE INDEX uq_job_candidate_project_worker_pending
  ON job_candidates (project_id, worker_id)
  WHERE status = 'PENDING';
CREATE INDEX idx_job_candidates_status     ON job_candidates (status);

CREATE TRIGGER trg_job_candidates_updated_at
  BEFORE UPDATE ON job_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 9. blocked_message_attempts ────────────────────────────────────────────
-- Chat's contact-info filter (utils/contactFilter.js) hard-blocks a message
-- before it's ever stored — nothing "slips through" to review after the
-- fact. This is the one place that attempt is recorded anyway, purely for
-- Security Monitor (admin.controller.js) to spot someone repeatedly trying
-- to move a conversation off-platform. The blocked text itself is stored
-- here (nowhere else) — visible only to admins, never to the counterparty.

CREATE TYPE blocked_attempt_status AS ENUM ('PENDING', 'REDACTED_AND_SENT', 'BANNED', 'WARNED', 'DISMISSED');

CREATE TABLE blocked_message_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable for the same reason messages.project_id is — an attempt made
  -- through the thread-wide route isn't necessarily about one project.
  -- thread_id (see chat_threads above) is the one that's always set.
  project_id        UUID REFERENCES projects(id) ON DELETE RESTRICT,
  thread_id         UUID REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempted_text    TEXT NOT NULL,
  status            blocked_attempt_status NOT NULL DEFAULT 'PENDING',
  resolved_by       UUID REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at       TIMESTAMPTZ,
  resolution_note   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blocked_attempts_project_id ON blocked_message_attempts (project_id);
CREATE INDEX idx_blocked_attempts_thread_id  ON blocked_message_attempts (thread_id);
CREATE INDEX idx_blocked_attempts_sender_id  ON blocked_message_attempts (sender_id);
CREATE INDEX idx_blocked_attempts_status     ON blocked_message_attempts (status);

-- ─── Level/tier config ────────────────────────────────────────────────────
-- Tier names by level threshold, used for the Silver-tier urgent-job gate
-- and tier-name UI copy. The platform fee is flat (see projects.platform_fee_pct
-- default) and is not tier-dependent — this table carries no fee column.
CREATE TABLE gamification_config (
  level_threshold   INTEGER PRIMARY KEY,
  tier_name         VARCHAR(50) NOT NULL,

  CONSTRAINT chk_level_threshold_min CHECK (level_threshold >= 1)
);

INSERT INTO gamification_config (level_threshold, tier_name) VALUES
  (1,   'Standard'),
  (50,  'Silver'),
  (100, 'Gold'),
  (150, 'Platinum'),
  (200, 'Diamond');

-- MASTER_ECONOMY_PLAN.md Part 1/Part 11 — the real per-event Ledger, the
-- actual source of truth a Ledger UI reads from (not just the running
-- totals on users.xp/bridge_tokens).
CREATE TABLE ledger_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type  TEXT NOT NULL,
  xp_delta    INTEGER NOT NULL DEFAULT 0,
  token_delta INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_events_user_id_created_at ON ledger_events (user_id, created_at DESC);

-- migrations/016_withdrawal_requests.sql added these two values to
-- platform_log_action — the only piece of migrations 015-020 that wasn't
-- already folded into this file's main body (withdrawal_requests,
-- user_blocks, support_threads/messages, and the projects table's
-- qualification/urgency columns above are all already current — see each
-- section's own "See migrations/0XX_....sql" comment).
ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'WITHDRAWAL_APPROVED';
ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'WITHDRAWAL_REJECTED';

-- migrations/021_perk_purchases.sql — turns Business Perks Shop / Worker
-- Token Shop "Purchase" into a real, Ledger-backed spend (see
-- perks.controller.js). One row per redemption, with a resolved expiry for
-- time-boxed tiers; null expires_at is a one-time/no-window perk.
--
-- migrations/035_perk_effects.sql added target_type/target_id (most perks
-- boost a specific job post / application / dispute / withdrawal, not the
-- whole account — an untyped reference resolved by perk_id in application
-- code, same shape as ledger_events.event_type) and consumed_at (the "used"
-- signal a one-time perk needs — expires_at IS NULL alone can't tell "still
-- available" from "already used").
CREATE TABLE perk_purchases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  perk_id      TEXT NOT NULL,
  tier_id      TEXT NOT NULL,
  label        TEXT NOT NULL,
  token_cost   INTEGER NOT NULL CHECK (token_cost > 0),
  expires_at   TIMESTAMPTZ,
  target_type  TEXT,
  target_id    UUID,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_perk_purchases_user_id_created_at ON perk_purchases (user_id, created_at DESC);
CREATE INDEX idx_perk_purchases_target ON perk_purchases (perk_id, target_id) WHERE target_id IS NOT NULL;

-- migrations/022_escrow_funding.sql — closes a real gap: ACCEPTED ->
-- FUNDS_SECURED used to be an instant, unverified status flip (see
-- projects.controller.js's old secureFunds). Now the business submits real
-- transfer proof (UTR + screenshot), landing the project in PENDING_FUNDS;
-- only WorkBridge staff verifying it (resolveEscrowFunding in
-- admin.controller.js) grants FUNDS_SECURED and writes the real ledger
-- row. Same human-in-the-loop shape as PENDING_RELEASE/completeProject.
ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'ESCROW_FUNDING_APPROVED';
ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'ESCROW_FUNDING_REJECTED';

-- migrations/023_impersonation_audit.sql — backs POST /api/admin/impersonate
-- (admin.controller.js), an admin-only, audited "log in as this user"
-- capability for support/debugging. Every session writes a real row here
-- before the short-lived elevated JWT is ever issued.
ALTER TYPE platform_log_action ADD VALUE IF NOT EXISTS 'IMPERSONATION_STARTED';

CREATE TABLE escrow_funding_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  business_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount          NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  utr_reference   TEXT NOT NULL,
  screenshot_url  TEXT NOT NULL,
  status          withdrawal_status NOT NULL DEFAULT 'PENDING',
  admin_note      TEXT,
  resolved_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX idx_escrow_funding_requests_status  ON escrow_funding_requests (status, created_at);
CREATE INDEX idx_escrow_funding_requests_project ON escrow_funding_requests (project_id);

-- One row per browser/device a user has granted Notification permission
-- and subscribed to push on (see push.service.js / routes/push.routes.js).
CREATE TABLE push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_subscriptions_user_id ON push_subscriptions (user_id);

-- Persists the exact same events push notifications already fire for
-- (buildProjectPushCopy in realtime/events.js) — the notification
-- bell/drawer's real history, sourced from the same copy generation so the
-- two can never say different things about the same event.
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  type        TEXT NOT NULL, -- 'SYSTEM' | 'PAYMENT' | 'PROJECT'
  url         TEXT,          -- click-through target, same one push already used
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_id_created_at ON notifications (user_id, created_at DESC);

-- migrations/035_perk_effects.sql — Skill Bridge Profile Audit (worker
-- perk): same "self-reported request, real WorkBridge action grants it"
-- shape as escrow_funding_requests/withdrawal_requests, but the real
-- outcome is a written review, not an approve/reject state machine — its
-- own small status enum instead of reusing withdrawal_status.
CREATE TYPE audit_status AS ENUM ('PENDING', 'REVIEWED');

CREATE TABLE profile_audit_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purchase_id UUID REFERENCES perk_purchases(id) ON DELETE SET NULL,
  status      audit_status NOT NULL DEFAULT 'PENDING',
  admin_note  TEXT,
  resolved_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_profile_audit_requests_status ON profile_audit_requests (status, created_at);
CREATE INDEX idx_profile_audit_requests_worker ON profile_audit_requests (worker_id, created_at DESC);

-- Idempotency + audit trail for incoming Razorpay webhook deliveries —
-- Razorpay retries aggressively on anything but a fast 200, and the same
-- event can arrive more than once; razorpay_event_id is the dedupe key.
-- See migrations/040_razorpay_route.sql.
CREATE TABLE razorpay_webhook_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  razorpay_event_id TEXT NOT NULL UNIQUE,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  processed_at      TIMESTAMPTZ,
  processing_error  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_razorpay_webhook_events_type ON razorpay_webhook_events (event_type, created_at DESC);

-- Manual pay-per-period subscription payments — a plain one-time Razorpay
-- Checkout charge per billing period, NOT a recurring auto-charge (that
-- would need a UPI Autopay/NACH e-mandate, a separate regulated flow).
-- See migrations/041_subscription_payments.sql.
CREATE TABLE subscription_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tier                subscription_tier NOT NULL,
  billing_period      subscription_billing_period NOT NULL,
  amount              NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  razorpay_order_id   TEXT UNIQUE,
  razorpay_payment_id TEXT,
  status              subscription_payment_status NOT NULL DEFAULT 'PENDING',
  period_start        TIMESTAMPTZ,
  period_end          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscription_payments_user ON subscription_payments (user_id, created_at DESC);

-- ─── Design notes ───────────────────────────────────────────────────────────
--
-- 1. wallet_balance is a cache, transactions is the ledger of record.
--    Keep them in sync inside the same DB transaction that inserts a PAYOUT
--    row (application-level, or a trigger on transactions if you want the
--    DB to own it) — never let a client write wallet_balance directly.
--
-- 2. RESTRICT (not CASCADE) on every FK to users/projects. A marketplace's
--    financial and review history should never silently disappear because
--    someone deleted a user or project row — soft-delete (an is_active /
--    deleted_at column) is the right pattern here, not hard DELETE.
--
-- 3. NUMERIC(12,2) everywhere money appears — max ₹9,999,999,999.99, two
--    decimal places, exact (no float rounding error). Never FLOAT/DOUBLE
--    for currency, per the brief.
--
-- 4. Security: public_user_profiles is the only view with no email/phone
--    columns at all — structural, not a WHERE clause an engineer could
--    forget. Any endpoint serving profile data to someone who isn't the
--    user themselves (or an authenticated admin) should query this view,
--    not the users table directly.
