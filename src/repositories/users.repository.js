import { query } from "../db/client.js";

export async function findById(id) {
  const { rows } = await query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// CITEXT on users.email makes this comparison case-insensitive at the DB
// level already — no need to lower() here.
export async function findByEmail(email) {
  const { rows } = await query(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows[0] ?? null;
}

export async function findByPhone(phone) {
  const { rows } = await query(`SELECT * FROM users WHERE phone = $1 LIMIT 1`, [phone]);
  return rows[0] ?? null;
}

// POST /api/auth/google's fast path — an account that's already used
// "Continue with Google" before is looked up by Google's stable "sub"
// claim, not email (an email match still runs first-time to link an
// existing password account instead of erroring — see auth.controller.js).
export async function findByGoogleId(googleId) {
  const { rows } = await query(`SELECT * FROM users WHERE google_id = $1`, [googleId]);
  return rows[0] ?? null;
}

// Links a Google account to an existing (password-created) user the first
// time they use "Continue with Google" with the same email — after this,
// findByGoogleId finds them directly.
export async function linkGoogleId(id, googleId) {
  const { rows } = await query(`UPDATE users SET google_id = $2 WHERE id = $1 RETURNING *`, [id, googleId]);
  return rows[0] ?? null;
}

// Settings > Notifications — merges the given keys into the existing JSONB
// rather than replacing it wholesale, so toggling one category can never
// silently reset the others to their defaults.
export async function updateNotificationPrefs(id, prefsPatch) {
  const { rows } = await query(
    `UPDATE users SET notification_prefs = notification_prefs || $2::jsonb WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(prefsPatch)]
  );
  return rows[0] ?? null;
}

// Lightweight — only the one column guard.js and the login flow actually
// need, so a banned-user check doesn't pull the whole row on every request.
export async function isActive(id) {
  const { rows } = await query(`SELECT is_active FROM users WHERE id = $1`, [id]);
  return rows[0]?.is_active ?? false;
}

// Same lightweight shape as isActive above — only checked at chat-send time
// (messages.controller.js's assertNotChatBanned), never on every request the
// way isActive is via guard.js, since a chat ban only ever matters when
// actually trying to send a message.
export async function isChatBanned(id) {
  const { rows } = await query(`SELECT is_chat_banned FROM users WHERE id = $1`, [id]);
  return rows[0]?.is_chat_banned ?? false;
}

// Security Monitor's "Ban User"/"Unban User" actions (admin.controller.js's
// resolveBlockedAttempt and moderateMessageSender) — the only writer of
// this column.
export async function setActive(client, id, active) {
  const { rows } = await client.query(
    `UPDATE users SET is_active = $2 WHERE id = $1 RETURNING *`,
    [id, active]
  );
  return rows[0] ?? null;
}

// The Dual-Ban Moderation Engine's "Ban Chat"/"Unban Chat" actions
// (admin.controller.js's moderateUser/moderateMessageSender) — the softer
// sibling to setActive above. Only ever read by
// messages.controller.js's assertNotChatBanned, never by guard.js — unlike
// is_active, this doesn't need checking on every request, only when
// actually trying to send a chat message.
export async function setChatBanned(client, id, banned) {
  const { rows } = await client.query(
    `UPDATE users SET is_chat_banned = $2 WHERE id = $1 RETURNING *`,
    [id, banned]
  );
  return rows[0] ?? null;
}

// Minimal real Support-tier RBAC (see migrations/034_admin_permissions.sql)
// — a partial update so passing only one flag leaves the other untouched;
// admin.controller.js's updateAdminPermissions is the only writer.
export async function setAdminPermissions(client, id, { canBanUsers, canReleaseFunds }) {
  const { rows } = await client.query(
    `UPDATE users
     SET can_ban_users = COALESCE($2, can_ban_users),
         can_release_funds = COALESCE($3, can_release_funds)
     WHERE id = $1
     RETURNING id, name, role, can_ban_users, can_release_funds`,
    [id, canBanUsers ?? null, canReleaseFunds ?? null]
  );
  return rows[0] ?? null;
}

// Message Monitor's "Deduct Points" action. behavior_score is nullable
// (nobody writes it yet elsewhere), so an unset score is treated as a clean
// 1000 — "full trust until proven otherwise" — the same semantic the 0-1000
// scale/marketing copy ("Behavior Score makes strong delivery visible")
// implies. delta is negative for a deduction; clamped to the schema's
// 0-1000 CHECK range either way.
export async function adjustBehaviorScore(client, id, delta) {
  const { rows } = await client.query(
    `UPDATE users
     SET behavior_score = LEAST(1000, GREATEST(0, COALESCE(behavior_score, 1000) + $2))
     WHERE id = $1
     RETURNING *`,
    [id, delta]
  );
  return rows[0] ?? null;
}

// Only ever called with role 'worker' | 'business' — see
// auth.validators.js's registerSchema, which excludes 'admin' at the
// boundary so this repo function never has to re-check it.
//
// emailVerified defaults true (matching the column default) so every
// existing caller — create-admin.js, the RetailX/Priya seed script — keeps
// working unchanged. POST /api/auth/verify-otp is the only caller that
// passes true explicitly and deliberately — a `users` row for a fresh
// signup is only ever created there, once the OTP check already succeeded
// (see pending_signups / auth.controller.js), so it's always verified from
// the moment it exists.
export async function create({ role, name, email, phone, passwordHash, emailVerified = true, googleId = null, avatarUrl = null, hasUsablePassword = true }) {
  const { rows } = await query(
    `INSERT INTO users (role, name, email, phone, password_hash, email_verified, google_id, avatar_url, has_usable_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [role, name, email, phone ?? null, passwordHash, emailVerified, googleId, avatarUrl, hasUsablePassword]
  );
  return rows[0];
}

export async function findPublicProfileById(id) {
  const { rows } = await query(`SELECT * FROM public_user_profiles WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Browse-workers listing (BusinessWorkers.jsx) — ranked by rating then
// review count, both NULLS LAST since a brand-new worker has neither yet.
export async function listPublicProfiles({ role }) {
  const { rows } = await query(
    `SELECT * FROM public_user_profiles
     WHERE role = $1
     ORDER BY rating DESC NULLS LAST, reviews_count DESC
     LIMIT 100`,
    [role]
  );
  return rows;
}

// Real effect of the "Featured Employer Spotlight" perk — WorkerJobFeed.jsx's
// strip of businesses actively spending Corporate Credits to be seen. Scoped
// to the business's currently-open posts so a worker clicking through
// always lands somewhere real to apply, never a company with nothing live.
export async function listFeaturedEmployers() {
  const { rows } = await query(
    `SELECT DISTINCT ON (b.id) b.id, b.avatar_url,
            COALESCE(NULLIF(b.profile->>'companyName', ''), b.name) AS business_name,
            pp.expires_at,
            (SELECT count(*)::int FROM projects p WHERE p.business_id = b.id AND p.status = 'OPEN') AS open_job_count
     FROM perk_purchases pp
     JOIN public_user_profiles b ON b.id = pp.user_id
     WHERE pp.perk_id = 'featured-employer'
       AND pp.consumed_at IS NULL
       AND (pp.expires_at IS NULL OR pp.expires_at > now())
     ORDER BY b.id, pp.expires_at DESC NULLS FIRST`
  );
  return rows;
}

// The caller's own profile edit (PATCH /api/profiles/me) — title/phone
// overwrite when provided, profilePatch is shallow-merged into the existing
// `profile` JSONB via Postgres's `||` so an edit to one field (e.g. bio)
// never clobbers sibling fields (e.g. skills) the caller didn't send.
//
// avatarUrl is three-state, not two: undefined ("key omitted — leave
// avatar_url alone"), null ("client explicitly wants to reset to the
// default avatar"), or a URL string ("set it"). COALESCE can't tell the
// first two apart since both arrive as SQL NULL, so avatarUrl's presence is
// checked in JS and passed as a separate boolean flag instead.
export async function updateSelf(id, { avatarUrl, title, phone, name, profilePatch, hasCompletedOnboarding }) {
  const avatarProvided = avatarUrl !== undefined;
  const { rows } = await query(
    `UPDATE users
     SET avatar_url = CASE WHEN $2 THEN $3 ELSE avatar_url END,
         title = COALESCE($4, title),
         phone = COALESCE($5, phone),
         name = COALESCE($6, name),
         profile = profile || $7::jsonb,
         has_completed_onboarding = COALESCE($8, has_completed_onboarding)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      avatarProvided,
      avatarUrl ?? null,
      title ?? null,
      phone ?? null,
      name ?? null,
      JSON.stringify(profilePatch ?? {}),
      hasCompletedOnboarding ?? null,
    ]
  );
  return rows[0] ?? null;
}

// PATCH /api/profiles/me/badge — the only writer of pinned_milestone_level.
// Eligibility (level must be one of MILESTONE_LEVELS and <= the caller's
// own current_level) is checked in the controller before this runs, so
// this stays a plain, trusted write — pass null to unpin.
export async function setPinnedBadge(id, level) {
  const { rows } = await query(
    `UPDATE users SET pinned_milestone_level = $2 WHERE id = $1 RETURNING *`,
    [id, level]
  );
  return rows[0] ?? null;
}

// POST /api/auth/reset-password's only DB write — the reset OTP itself is
// verified by the caller (auth.controller.js) before this ever runs.
// Also flips has_usable_password to true — both call sites (Settings'
// Change/Set Password and the OTP-based Forgot Password flow) end with the
// user holding a real, typeable password, even if they started from a
// Google-only account that never had one.
export async function updatePassword(id, passwordHash) {
  const { rows } = await query(
    `UPDATE users SET password_hash = $2, has_usable_password = true WHERE id = $1 RETURNING *`,
    [id, passwordHash]
  );
  return rows[0] ?? null;
}

// The Daily Streak Engine's only writer of current_streak/last_login_at.
// One atomic UPDATE (no read-then-write, no transaction needed) so two
// near-simultaneous logins for the same user can't race each other into an
// inconsistent streak. Calendar-day comparison is done in UTC explicitly —
// TIMESTAMPTZ::date alone would follow the DB session's timezone, which
// isn't guaranteed consistent across connections/environments.
// - No prior login (brand new user's first real login) -> streak starts at 1.
// - Last login was exactly yesterday (UTC) -> streak continues, +1.
// - Last login was already today (UTC) -> unchanged; logging in twice in
//   one day isn't two days of engagement.
// - Anything else (a gap of 2+ days, or a clock oddity) -> streak resets to 1.
export async function recordLogin(id) {
  const { rows } = await query(
    `UPDATE users
     SET current_streak = CASE
           WHEN last_login_at IS NULL THEN 1
           WHEN (last_login_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date THEN current_streak
           WHEN (last_login_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date - INTERVAL '1 day' THEN current_streak + 1
           ELSE 1
         END,
         last_login_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

// Row-locks the wallet owner's user row so a concurrent withdrawal/payout
// can't read a stale balance while this one is in flight.
export async function findForUpdate(client, id) {
  const { rows } = await client.query(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ?? null;
}

// POST /api/payments/route-account — persists only the acc_XXXX id Razorpay
// hands back, never the raw bank account number/IFSC the worker submitted
// (those go straight through to Razorpay's own createLinkedAccount call
// and are never written to any WorkBridge table).
export async function setRazorpayAccount(userId, { accountId, status, email }, client = { query }) {
  const { rows } = await client.query(
    `UPDATE users
     SET razorpay_account_id = $2, razorpay_account_status = $3::razorpay_account_status,
         razorpay_account_email = $4, razorpay_linked_at = now()
     WHERE id = $1
     RETURNING *`,
    [userId, accountId, status, email]
  );
  return rows[0] ?? null;
}

// Webhook-driven (account.activated / account.under_review /
// account.needs_clarification) — keeps status current without WorkBridge
// ever having to poll Razorpay for it.
export async function updateRazorpayAccountStatusByAccountId(accountId, status) {
  const { rows } = await query(
    `UPDATE users SET razorpay_account_status = $2::razorpay_account_status WHERE razorpay_account_id = $1 RETURNING *`,
    [accountId, status]
  );
  return rows[0] ?? null;
}

// A worker's saved payout destination — lets completeProject/resolveDispute
// pay them directly via RazorpayX at completion without retyping bank/UPI
// details each time (see migrations/044_worker_payout_account.sql). Same
// payout_method/payout_details shape as withdrawal_requests, just persisted
// as a default here instead of per-request.
export async function setPayoutDetails(userId, { payoutMethod, payoutDetails }) {
  const { rows } = await query(
    `UPDATE users SET payout_method = $2::payout_method, payout_details = $3 WHERE id = $1 RETURNING *`,
    [userId, payoutMethod, payoutDetails]
  );
  return rows[0] ?? null;
}

// The webhook's cached-lookup write, kept in sync the same moment a
// subscription_payments row is marked PAID — see that table's own comment
// on why this cache exists (avoids a join on every page load).
export async function setSubscription(client, userId, { tier, expiresAt }) {
  const { rows } = await client.query(
    `UPDATE users SET subscription_tier = $2::subscription_tier, subscription_expires_at = $3 WHERE id = $1 RETURNING *`,
    [userId, tier, expiresAt]
  );
  return rows[0] ?? null;
}

export async function incrementWalletBalance(client, userId, delta) {
  const { rows } = await client.query(
    `UPDATE users SET wallet_balance = wallet_balance + $2 WHERE id = $1 RETURNING *`,
    [userId, delta]
  );
  return rows[0] ?? null;
}

// MASTER_ECONOMY_PLAN.md's Core Loop — awards xp (and optionally
// bridge_tokens) to a user inside the caller's transaction, then persists
// the recalculated current_level in the same statement so xp and
// current_level can never drift out of sync with each other. currentLevel
// is passed in (from utils/gamification.js's calculateLevel) rather than
// computed here — this repo function stays a pure DB write, same as
// incrementWalletBalance above; the level math lives in one place only.
// standingDoor is optional — pass it to flip the Two-Door Reveal state
// (e.g. "win" on a completed project); omit it to leave standing_door
// untouched (COALESCE keeps the existing value when null is passed).
export async function awardXp(client, userId, { xpDelta, tokenDelta = 0, currentLevel, standingDoor }) {
  const { rows } = await client.query(
    `UPDATE users
     SET xp = xp + $2,
         bridge_tokens = bridge_tokens + $3,
         current_level = $4,
         standing_door = COALESCE($5::standing_door_state, standing_door)
     WHERE id = $1
     RETURNING *`,
    [userId, xpDelta, tokenDelta, currentLevel, standingDoor ?? null]
  );
  return rows[0] ?? null;
}
