import { query } from "../db/client.js";

// Every function here is a thin wrapper around one SQL statement against
// schema.sql's `projects` table. Functions that accept `client` run inside
// an active transaction (see db/client.js's transaction()); the rest use
// the plain pool via `query`.

export async function findById(id, client = { query }) {
  const { rows } = await client.query(`SELECT * FROM projects WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Single-project fetch joined to both participants' public profiles — same
// join list() already does, just scoped to one row. Used by GET /:id.
// worker is a LEFT JOIN — an OPEN post has no worker yet, and this still
// needs to return that row (with worker_name null) rather than hiding it.
export async function findByIdJoined(id) {
  const { rows } = await query(
    `SELECT p.*, w.name AS worker_name,
            COALESCE(NULLIF(b.profile->>'companyName', ''), b.name) AS business_name
     FROM projects p
     LEFT JOIN public_user_profiles w ON w.id = p.worker_id
     JOIN public_user_profiles b ON b.id = p.business_id
     WHERE p.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

// Deadline is DATE (day granularity, no time-of-day) — "1 day out" means
// deadline = tomorrow exactly, not a rolling 24h window. Only still-active,
// pre-delivery statuses are worth reminding about; a project already
// FILES_SUBMITTED or beyond has nothing left to be "on time" for, and
// CANCELLED/DISPUTED/COMPLETED obviously don't need one either. Filters out
// anything already reminded via deadline_reminder_sent_at so the periodic
// scheduler (services/deadlineReminders.js) never re-notifies the same
// project on its next tick.
const DEADLINE_REMINDER_STATUSES = ["ACCEPTED", "PENDING_FUNDS", "FUNDS_SECURED", "WORK_IN_PROGRESS"];

export async function listDueForDeadlineReminder() {
  const { rows } = await query(
    `SELECT * FROM projects
     WHERE deadline = (CURRENT_DATE + INTERVAL '1 day')::date
       AND status = ANY($1)
       AND deadline_reminder_sent_at IS NULL`,
    [DEADLINE_REMINDER_STATUSES]
  );
  return rows;
}

export async function markDeadlineReminderSent(id) {
  await query(`UPDATE projects SET deadline_reminder_sent_at = now() WHERE id = $1`, [id]);
}

export async function findByIdForUpdate(client, id) {
  // FOR UPDATE row-locks this project row for the duration of the
  // transaction, so a second concurrent "complete" call on the same
  // project blocks until the first one commits/rolls back instead of
  // racing it — required for strict consistency on the payout path.
  const { rows } = await client.query(`SELECT * FROM projects WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ?? null;
}

export async function list({ businessId, workerId, status, page, pageSize, viewerId }) {
  const conditions = [];
  const params = [];

  if (businessId) {
    params.push(businessId);
    conditions.push(`p.business_id = $${params.length}`);
  }
  if (workerId) {
    params.push(workerId);
    conditions.push(`p.worker_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // How many approved deliverables are sitting on this project that the
  // viewer didn't submit themselves — the one client-visible signal for
  // "there's something to look at here" without building a full read/unread
  // tracking system. IS DISTINCT FROM (not !=) so a null viewerId (shouldn't
  // happen — every caller is authenticated) still counts safely instead of
  // comparing against NULL and silently returning zero rows.
  params.push(viewerId ?? null);
  const viewerParamIndex = params.length;

  params.push(pageSize, (page - 1) * pageSize);

  // Joined so the frontend never has to do an N+1 lookup just to show who
  // a project is with — the public_user_profiles view (not the raw users
  // table) keeps this join from ever leaking email/phone. worker is a LEFT
  // JOIN — an OPEN post (worker_id NULL) must still show up in the
  // business's own project list, just with worker_name null.
  const { rows } = await query(
    `SELECT p.*, w.name AS worker_name, w.avatar_url AS worker_avatar_url,
            COALESCE(NULLIF(b.profile->>'companyName', ''), b.name) AS business_name,
            b.avatar_url AS business_avatar_url,
            (SELECT count(*)::int FROM submissions s
             WHERE s.project_id = p.id
               AND s.status = 'APPROVED'
               AND s.submitted_by IS DISTINCT FROM $${viewerParamIndex}
            ) AS new_deliverables_count,
            (SELECT s.type FROM submissions s
             WHERE s.project_id = p.id
               AND s.status = 'APPROVED'
             ORDER BY s.created_at DESC
             LIMIT 1
            ) AS latest_deliverable_type,
            EXISTS (
              SELECT 1 FROM perk_purchases pp
              WHERE pp.perk_id = 'momentum-shield' AND pp.target_id = p.id
                AND pp.consumed_at IS NULL AND (pp.expires_at IS NULL OR pp.expires_at > now())
            ) AS has_momentum_shield
     FROM projects p
     LEFT JOIN public_user_profiles w ON w.id = p.worker_id
     JOIN public_user_profiles b ON b.id = p.business_id
     ${where}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

// The public Job Board feed — every OPEN, unassigned post, newest first.
// Any authenticated worker may browse this (no ownership filter, unlike
// list() above) — see job_candidates.controller.js's listOpenProjects.
// viewerLevel is the requesting worker's real current_level (passed by
// listOpenProjects) — Urgent Matching's real effect: urgent posts sort
// first for everyone, but only Silver-tier+ workers (the real threshold
// from gamification_config, not a hardcoded guess) see one immediately;
// everyone else sees it once it's been public for 3 hours. No subscription
// check here — that track is deferred, so "top worker" is decided purely
// by the real, already-existing tier system.
//
// application_deadline (once passed) drops a post from THIS feed only —
// the business still sees it on their own side (listByBusiness/list()
// below have no such filter, since it's their post regardless of whether
// new applicants can still reach it) and it stays OPEN/postable-to until
// they act on it. createCandidate in job_candidates.controller.js is the
// matching server-side enforcement for a worker trying to apply directly
// by project id after the deadline, in case this feed's filter is bypassed.
export async function listOpen(viewerLevel = 0) {
  const { rows } = await query(
    `SELECT p.*, COALESCE(NULLIF(b.profile->>'companyName', ''), b.name) AS business_name,
            b.rating AS business_rating,
            (SELECT count(*)::int FROM job_candidates c
             WHERE c.project_id = p.id AND c.source = 'APPLICATION'
            ) AS applicant_count,
            (SELECT pp.expires_at FROM perk_purchases pp
             WHERE pp.perk_id = 'flash-post' AND pp.target_id = p.id
               AND pp.consumed_at IS NULL AND (pp.expires_at IS NULL OR pp.expires_at > now())
             ORDER BY pp.expires_at DESC NULLS LAST LIMIT 1
            ) AS flash_post_expires_at
     FROM projects p
     JOIN public_user_profiles b ON b.id = p.business_id
     WHERE p.status = 'OPEN'
       AND (p.application_deadline IS NULL OR p.application_deadline > now())
       AND (
         p.is_urgent = false
         OR $1 >= (SELECT level_threshold FROM gamification_config WHERE tier_name = 'Silver')
         OR p.created_at <= now() - interval '3 hours'
       )
     ORDER BY p.is_urgent DESC,
       EXISTS (
         SELECT 1 FROM perk_purchases pp
         WHERE pp.perk_id = 'flash-post' AND pp.target_id = p.id
           AND pp.consumed_at IS NULL AND (pp.expires_at IS NULL OR pp.expires_at > now())
       ) DESC,
       p.created_at DESC
     LIMIT 100`,
    [viewerLevel]
  );
  return rows;
}

// Real effect of the business subscription tiers' "N posts/month" limit
// (BusinessPayments.jsx's SubscriptionTab) — calendar-month count of OPEN
// job-board posts only (workerId omitted at creation — see createProject).
// A direct invite (a specific worker you already found via Find Workers)
// doesn't count — it's naturally self-limiting already, and the tier's
// real differentiator is broadcast reach on the job board, not 1:1
// outreach. Uses posted_as_open (set once at INSERT, immutable) rather
// than worker_id, which changes the moment a candidate is accepted — an
// OPEN post that gets filled must still count toward the month it was
// actually posted in. Calendar month in the DB's own timezone
// (date_trunc), not a rolling 30 days — resets on the 1st, same as every
// other "N/month" quota.
export async function countOpenPostsThisMonth(businessId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM projects
     WHERE business_id = $1 AND posted_as_open = TRUE AND created_at >= date_trunc('month', now())`,
    [businessId]
  );
  return rows[0].count;
}

// workerId is nullable — a business "casting the net" post is created with
// workerId omitted (status defaults to OPEN below); the existing direct-
// invite flow still passes a real workerId (status defaults to INVITED,
// same as before this feature existed). posted_as_open is derived from
// workerId at this one moment and never changes afterward, even once the
// post gets filled and worker_id is set — see countOpenPostsThisMonth.
export async function create({
  businessId,
  workerId,
  title,
  description,
  budget,
  deadline,
  status,
  applicationDeadline,
  estimatedDuration,
  minExperienceYears,
  maxExperienceYears,
  educationLevel,
  educationNotes,
  requiredSkills,
  isUrgent,
}) {
  const resolvedStatus = status ?? (workerId ? "INVITED" : "OPEN");
  const postedAsOpen = !workerId;
  const { rows } = await query(
    `INSERT INTO projects (
       business_id, worker_id, title, description, budget, deadline, status, application_deadline, estimated_duration,
       min_experience_years, max_experience_years, education_level, education_notes, required_skills, is_urgent, posted_as_open
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::project_status, $8, $9, $10, $11, $12::education_level, $13, $14, $15, $16)
     RETURNING *`,
    [
      businessId,
      workerId ?? null,
      title,
      description ?? null,
      budget,
      deadline ?? null,
      resolvedStatus,
      applicationDeadline ?? null,
      estimatedDuration ?? null,
      minExperienceYears ?? null,
      maxExperienceYears ?? null,
      educationLevel ?? "ANY",
      educationNotes ?? null,
      requiredSkills ?? [],
      isUrgent ?? false,
      postedAsOpen,
    ]
  );
  return rows[0];
}

// The moment a job_candidates row is accepted (job_candidates.controller.js)
// — assigns the project's worker_id and moves it out of OPEN in one
// statement, same timeline-append pattern as updateStatus.
export async function assignWorker(client, projectId, workerId, status) {
  const { rows } = await client.query(
    `UPDATE projects
     SET worker_id = $2,
         status = $3::project_status,
         timeline = timeline || jsonb_build_object('status', $3::text, 'at', now())
     WHERE id = $1
     RETURNING *`,
    [projectId, workerId, status]
  );
  return rows[0] ?? null;
}

// The worker's real counter-offer on the posted budget — only meaningful
// pre-funding (see projects.controller.js's proposeBudget for the real
// ACCEPTED-only gate). Overwrites any earlier still-pending proposal
// rather than stacking them; there's only ever one live counter-offer.
export async function proposeBudget(client, id, { proposedBudget, proposedBy }) {
  const { rows } = await client.query(
    `UPDATE projects SET proposed_budget = $2, proposed_by = $3 WHERE id = $1 RETURNING *`,
    [id, proposedBudget, proposedBy]
  );
  return rows[0] ?? null;
}

// approve: true moves the real budget column to match what was proposed
// (this is the only place `budget` ever changes after posting); false just
// clears the proposal, leaving the original budget untouched. Either way
// the proposal itself is spent — a declined offer doesn't linger for a
// second look later.
export async function resolveBudgetProposal(client, id, approve) {
  const { rows } = await client.query(
    approve
      ? `UPDATE projects SET budget = proposed_budget, proposed_budget = NULL, proposed_by = NULL WHERE id = $1 RETURNING *`
      : `UPDATE projects SET proposed_budget = NULL, proposed_by = NULL WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

// The webhook's entry point — every Razorpay event carries the order id,
// never our own project id, so this is how a payment.captured/failed
// event finds its way back to the right row.
export async function findByRazorpayOrderId(client, orderId) {
  const { rows } = await client.query(`SELECT * FROM projects WHERE razorpay_order_id = $1 FOR UPDATE`, [orderId]);
  return rows[0] ?? null;
}

// fundEscrow's counterpart to setRazorpayOrder below — records that THIS
// project's PENDING_FUNDS came from the manual UTR/screenshot path, not a
// Razorpay Checkout order. Without this, funding_method silently keeps its
// schema default of 'RAZORPAY' even for a manually-funded project, which
// broke the funding_method-based copy in InvoicePage.jsx/BusinessProjects.jsx
// (both assumed a manually-funded project would say so).
export async function setManualFundingMethod(client, id) {
  const { rows } = await client.query(
    `UPDATE projects SET funding_method = 'MANUAL_BANK_TRANSFER' WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

// POST /api/projects/:id/checkout — persists the order id server-computed
// at checkout time, before any money has actually moved (status only
// flips to FUNDS_SECURED later, once the webhook confirms payment.captured
// — see payments.controller.js / webhook.controller.js).
export async function setRazorpayOrder(client, id, { orderId, businessFeePct }) {
  const { rows } = await client.query(
    `UPDATE projects
     SET razorpay_order_id = $2, business_fee_pct = $3, funding_method = 'RAZORPAY'
     WHERE id = $1
     RETURNING *`,
    [id, orderId, businessFeePct]
  );
  return rows[0] ?? null;
}

// The webhook's only write to the projects row on payment.captured —
// separate from updateStatus above so the payment_id can be set in the
// same statement as the status flip, atomically.
export async function markFundsSecured(client, id, { paymentId }) {
  const { rows } = await client.query(
    `UPDATE projects
     SET status = 'FUNDS_SECURED'::project_status,
         razorpay_payment_id = $2,
         timeline = timeline || jsonb_build_object('status', 'FUNDS_SECURED', 'at', now())
     WHERE id = $1
     RETURNING *`,
    [id, paymentId]
  );
  return rows[0] ?? null;
}

export async function setRazorpayTransfer(client, id, transferId) {
  const { rows } = await client.query(
    `UPDATE projects SET razorpay_transfer_id = $2 WHERE id = $1 RETURNING *`,
    [id, transferId]
  );
  return rows[0] ?? null;
}

export async function setRazorpayRefund(client, id, refundId) {
  const { rows } = await client.query(
    `UPDATE projects SET razorpay_refund_id = $2 WHERE id = $1 RETURNING *`,
    [id, refundId]
  );
  return rows[0] ?? null;
}

// Same status-flip + timeline entry as updateStatus, plus the dedicated
// dispute_reason/dispute_raised_by/disputed_at columns (migrations/
// 046_dispute_raise.sql) — a clean, queryable field for AdminDisputesTab
// instead of digging a reason out of the timeline JSONB blob.
export async function raiseDispute(client, id, { reason, raisedBy, evidence }) {
  const { rows } = await client.query(
    `UPDATE projects
     SET status = 'DISPUTED'::project_status,
         dispute_reason = $2,
         dispute_raised_by = $3,
         dispute_evidence = $4::jsonb,
         disputed_at = now(),
         timeline = timeline || jsonb_build_object('status', 'DISPUTED', 'at', now(), 'note', $2::text)
     WHERE id = $1
     RETURNING *`,
    [id, reason, raisedBy, JSON.stringify(evidence ?? [])]
  );
  return rows[0] ?? null;
}

// The accused party's one-shot structured response — see
// migrations/048_dispute_rebuttal_evidence.sql. Guarded to only ever write
// once (WHERE dispute_rebuttal_by IS NULL) so a second call can never
// silently overwrite an existing rebuttal; the controller checks this too,
// but the DB is the real guard against a race between two rapid requests.
export async function submitDisputeRebuttal(client, id, { statement, submittedBy, evidence }) {
  const { rows } = await client.query(
    `UPDATE projects
     SET dispute_rebuttal = $2,
         dispute_rebuttal_by = $3,
         dispute_rebuttal_evidence = $4::jsonb,
         dispute_rebuttal_at = now()
     WHERE id = $1 AND status = 'DISPUTED' AND dispute_rebuttal_by IS NULL
     RETURNING *`,
    [id, statement, submittedBy, JSON.stringify(evidence ?? [])]
  );
  return rows[0] ?? null;
}

export async function updateStatus(id, status, client = { query }, note = null) {
  const timelineEntry = note
    ? `jsonb_build_object('status', $2::text, 'at', now(), 'note', $3::text)`
    : `jsonb_build_object('status', $2::text, 'at', now())`;
  const params = note ? [id, status, note] : [id, status];

  const { rows } = await client.query(
    `UPDATE projects
     SET status = $2::project_status,
         timeline = timeline || ${timelineEntry}::jsonb
     WHERE id = $1
     RETURNING *`,
    params
  );
  return rows[0] ?? null;
}
