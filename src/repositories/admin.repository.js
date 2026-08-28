import { query } from "../db/client.js";

// ─── Verification queue ──────────────────────────────────────────────────────

// phone is included here deliberately (unlike public_user_profiles) — this
// route is admin-only (guard + requireRole("admin") in admin.routes.js), and
// support needs a number to actually call while verifying an account.
export async function listPendingVerifications() {
  const { rows } = await query(
    `SELECT id, name, role, title, phone, created_at
     FROM users
     WHERE verified = false AND role IN ('worker', 'business')
     ORDER BY created_at ASC`
  );
  return rows;
}

// Full user directory for the admin "Users" tab — email/phone included for
// the same reason as above (admin-only route). Both verification flags are
// returned since they're different facts: email_verified (registration OTP)
// vs verified (manual ID/payment review, see listPendingVerifications).
export async function listAllUsers() {
  const { rows } = await query(
    `SELECT id, name, email, phone, role, email_verified, verified, is_active, is_chat_banned, created_at,
            can_ban_users, can_release_funds, subscription_tier, subscription_expires_at
     FROM users
     ORDER BY created_at DESC
     LIMIT 200`
  );
  return rows;
}

export async function setUserVerified(client, userId, verified) {
  const { rows } = await client.query(
    `UPDATE users SET verified = $2 WHERE id = $1 RETURNING id, name, role, verified`,
    [userId, verified]
  );
  return rows[0] ?? null;
}

// ─── Message monitor ──────────────────────────────────────────────────────────
// Platform-wide search over every real chat message — not just the ones the
// contact-info filter auto-blocked (that's blocked_message_attempts, a
// separate queue). This is the manual complement: support can search/browse
// full conversations to catch things the filter's evasion-prone regex
// misses (e.g. a phone number split up with commas or odd spacing).

// search: optional case-insensitive substring match against the message
// body. Capped at 200 rows (most-recent-first) — a monitoring tool, not an
// export; support narrows with `search` rather than paging through history.
export async function searchMessages({ search } = {}) {
  const conditions = [];
  const params = [];

  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`m.body ILIKE $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await query(
    `SELECT m.id, m.project_id, m.body, m.created_at,
            sender.id AS sender_id, sender.name AS sender_name, sender.role AS sender_role,
            p.title AS project_title,
            w.name AS worker_name, b.name AS business_name
     FROM messages m
     JOIN users sender ON sender.id = m.sender_id
     JOIN projects p ON p.id = m.project_id
     JOIN users w ON w.id = p.worker_id
     JOIN users b ON b.id = p.business_id
     ${where}
     ORDER BY m.created_at DESC
     LIMIT 200`,
    params
  );
  return rows;
}

// Message Monitor's "Cascading Workspace" — left column. Only businesses
// that have actually hired someone (i.e. have a project) show up here; a
// business with zero projects has no chat to monitor.
export async function listMonitoredBusinesses() {
  const { rows } = await query(
    `SELECT b.id,
            COALESCE(NULLIF(b.profile->>'companyName', ''), b.name) AS business_name,
            count(DISTINCT p.worker_id)::int AS hires
     FROM users b
     JOIN projects p ON p.business_id = b.id
     WHERE b.role = 'business'
     GROUP BY b.id
     ORDER BY business_name ASC`
  );
  return rows;
}

// Middle column — every project (one row per project, not deduped per
// worker) a given business has ever posted, most recent first. A worker
// hired twice by the same business shows up as two cards, each opening its
// own project's thread — the roster is "hires," not "people."
export async function listWorkersForBusiness(businessId) {
  const { rows } = await query(
    `SELECT p.id AS project_id, p.title AS project_title, p.created_at,
            w.id AS worker_id, w.name AS worker_name, w.is_active AS worker_is_active,
            w.is_chat_banned AS worker_is_chat_banned
     FROM projects p
     JOIN users w ON w.id = p.worker_id
     WHERE p.business_id = $1
     ORDER BY p.created_at DESC`,
    [businessId]
  );
  return rows;
}

// ─── KPI engine ───────────────────────────────────────────────────────────────
// Statuses that mean "the business's money is currently held on the
// platform, not yet paid out or cancelled" — i.e. the funds-secured pool.
const FUNDS_HELD_STATUSES = ["FUNDS_SECURED", "WORK_IN_PROGRESS", "FILES_SUBMITTED", "DISPUTED"];

export async function getPlatformStats() {
  const [{ rows: totalUsers }, { rows: jobsToday }, { rows: revenue }, { rows: pool }, { rows: totalProjects }, { rows: pendingVerifications }, { rows: openDisputes }] = await Promise.all([
    query(`SELECT count(*)::int AS count FROM users`),
    query(`SELECT count(*)::int AS count FROM projects WHERE created_at::date = now()::date`),
    // Real WorkBridge revenue is both fee legs of the disclosed 8%/7%
    // split: PLATFORM_FEE_BUSINESS (collected at checkout) +
    // PLATFORM_FEE (withheld at worker payout). Summing only PLATFORM_FEE
    // here would silently under-report revenue by the entire business-side
    // fee — the mistake this query used to make before this fix.
    query(`SELECT COALESCE(sum(amount), 0)::numeric AS total FROM transactions WHERE type IN ('PLATFORM_FEE', 'PLATFORM_FEE_BUSINESS')`),
    query(
      `SELECT COALESCE(sum(budget), 0)::numeric AS total FROM projects WHERE status = ANY($1::project_status[])`,
      [FUNDS_HELD_STATUSES]
    ),
    // The following three power AdminOverviewTab's "Platform KPIs" progress
    // bars (verification backlog %, dispute rate %) with real ratios rather
    // than invented percentages.
    query(`SELECT count(*)::int AS count FROM projects`),
    query(`SELECT count(*)::int AS count FROM users WHERE verified = false AND role IN ('worker', 'business')`),
    query(`SELECT count(*)::int AS count FROM projects WHERE status = 'DISPUTED'`),
  ]);

  return {
    totalUsers: totalUsers[0].count,
    jobsToday: jobsToday[0].count,
    platformRevenue: revenue[0].total,
    fundsSecuredPool: pool[0].total,
    totalProjects: totalProjects[0].count,
    pendingVerifications: pendingVerifications[0].count,
    openDisputes: openDisputes[0].count,
  };
}

export async function getWeeklyRevenue() {
  // One row per of the last 7 days, zero-filled for days with no fee
  // transactions — a chart with gaps in the x-axis reads as broken data.
  const { rows } = await query(
    `SELECT
       to_char(d.day, 'Dy') AS day,
       COALESCE(sum(t.amount), 0)::numeric AS revenue
     FROM generate_series(current_date - interval '6 days', current_date, interval '1 day') AS d(day)
     LEFT JOIN transactions t
       ON t.type IN ('PLATFORM_FEE', 'PLATFORM_FEE_BUSINESS') AND t.created_at::date = d.day
     GROUP BY d.day
     ORDER BY d.day`
  );
  return rows.map((r) => ({ day: r.day, revenue: Number(r.revenue) }));
}

// ─── Disputes ───────────────────────────────────────────────────────────────

export async function listDisputedProjects() {
  const { rows } = await query(
    `SELECT p.*, w.name AS worker_name,
            COALESCE(NULLIF(b.profile->>'companyName', ''), b.name) AS business_name,
            CASE WHEN p.dispute_raised_by = p.worker_id THEN 'worker'
                 WHEN p.dispute_raised_by = p.business_id THEN 'business'
                 ELSE NULL END AS dispute_raised_by_role,
            EXISTS (
              SELECT 1 FROM perk_purchases pp
              WHERE pp.perk_id = 'dispute-fast-track' AND pp.target_id = p.id
                AND pp.consumed_at IS NULL AND (pp.expires_at IS NULL OR pp.expires_at > now())
            ) AS has_fast_track
     FROM projects p
     JOIN public_user_profiles w ON w.id = p.worker_id
     JOIN public_user_profiles b ON b.id = p.business_id
     WHERE p.status = 'DISPUTED'
     ORDER BY has_fast_track DESC, p.updated_at DESC`
  );
  return rows;
}

// ─── Transactions / invoices ──────────────────────────────────────────────────

// One row per project, not per ledger entry — a completed project has 2-3
// transactions rows (FUNDS_SECURED/PAYOUT/PLATFORM_FEE), but the admin
// "Transaction History" table wants one consolidated invoice-style row.
// INVITED/ACCEPTED/CANCELLED never had money move, so they're excluded —
// an "invoice" only exists once funds are at least secured.
export async function listAllInvoices() {
  const { rows } = await query(
    `SELECT p.*, w.name AS worker_name,
            COALESCE(NULLIF(b.profile->>'companyName', ''), b.name) AS business_name
     FROM projects p
     JOIN public_user_profiles w ON w.id = p.worker_id
     JOIN public_user_profiles b ON b.id = p.business_id
     WHERE p.status IN ('FUNDS_SECURED', 'WORK_IN_PROGRESS', 'FILES_SUBMITTED', 'PENDING_RELEASE', 'COMPLETED', 'DISPUTED')
     ORDER BY p.updated_at DESC
     LIMIT 200`
  );
  return rows;
}

// GET /api/admin/manual-payouts — "who do I owe money to" queue: every
// PAYOUT transaction that fell back to WALLET_PENDING_MANUAL (Cashfree
// Payouts unavailable/failed at completion time — see completeProject in
// projects.controller.js) and hasn't been marked as manually wired yet.
// Includes the worker's saved bank/UPI destination directly — that's the
// whole point, no need to click through to their profile to find it.
export async function listPendingManualPayouts() {
  const { rows } = await query(
    `SELECT t.id, t.project_id, t.amount, t.created_at,
            w.name AS worker_name, w.payout_method, w.payout_details,
            p.title AS project_title,
            COALESCE(NULLIF(b.profile->>'companyName', ''), b.name) AS business_name
     FROM transactions t
     JOIN users w ON w.id = t.worker_id
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN public_user_profiles b ON b.id = t.business_id
     WHERE t.settlement_method = 'WALLET_PENDING_MANUAL' AND t.manual_payout_completed_at IS NULL AND t.type = 'PAYOUT'
     ORDER BY t.created_at ASC`
  );
  return rows;
}

// POST /api/admin/manual-payouts/:id/complete — staff confirming they
// actually wired a WALLET_PENDING_MANUAL payout by hand (NEFT/RTGS).
// settlement_method itself is untouched (see schema.sql's comment) — this
// only records that it's been handled, so it drops off the queue above.
export async function completeManualPayout(id, note) {
  const { rows } = await query(
    `UPDATE transactions
     SET manual_payout_completed_at = now(), manual_payout_note = $2
     WHERE id = $1 AND settlement_method = 'WALLET_PENDING_MANUAL'
     RETURNING *`,
    [id, note ?? null]
  );
  return rows[0] ?? null;
}

// ─── Fund releases queue ──────────────────────────────────────────────────────
// A business's "Approve & Release" click only requests a release
// (FILES_SUBMITTED -> PENDING_RELEASE, see requestRelease in
// projects.controller.js) — this is the queue WorkBridge staff actually act
// on to move real money (completeProject), the human-in-the-loop step this
// escrow model requires.
export async function listPendingReleases() {
  const { rows } = await query(
    `SELECT p.*, w.name AS worker_name,
            COALESCE(NULLIF(b.profile->>'companyName', ''), b.name) AS business_name
     FROM projects p
     JOIN public_user_profiles w ON w.id = p.worker_id
     JOIN public_user_profiles b ON b.id = p.business_id
     WHERE p.status = 'PENDING_RELEASE'
     ORDER BY p.updated_at ASC`
  );
  return rows;
}

// ─── Platform audit log ───────────────────────────────────────────────────────

export async function insertPlatformLog(client, { adminId, action, targetUserId, targetProjectId, notes }) {
  const { rows } = await client.query(
    `INSERT INTO platform_logs (admin_id, action, target_user_id, target_project_id, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [adminId, action, targetUserId ?? null, targetProjectId ?? null, notes ?? null]
  );
  return rows[0];
}
