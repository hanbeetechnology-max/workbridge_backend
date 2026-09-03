import { query } from "../db/client.js";

export async function create({ projectId, submittedBy, type, url, imageData, caption }) {
  const { rows } = await query(
    `INSERT INTO submissions (project_id, submitted_by, type, url, image_data, caption)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [projectId, submittedBy, type, url ?? null, imageData ?? null, caption ?? null]
  );
  return rows[0];
}

// Same insert as create() above, but through a transaction's checked-out
// client instead of the pool — for callers (messages.controller.js's
// sendAttachmentMessage) that need the submission row and something else
// (a linked chat message) to commit or roll back together. create() itself
// is left untouched since its only existing caller (submissions.controller
// .js's createSubmission) was never meant to be transactional.
export async function createWithClient(client, { projectId, submittedBy, type, url, imageData, caption }) {
  const { rows } = await client.query(
    `INSERT INTO submissions (project_id, submitted_by, type, url, image_data, caption)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [projectId, submittedBy, type, url ?? null, imageData ?? null, caption ?? null]
  );
  return rows[0];
}

export async function findById(id) {
  const { rows } = await query(`SELECT * FROM submissions WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Joined to the submitter's public profile (name) — every list view (worker,
// business, admin) wants "who sent this," not just a bare user id.
export async function listForProject(projectId) {
  const { rows } = await query(
    `SELECT s.*, u.name AS submitted_by_name
     FROM submissions s
     JOIN public_user_profiles u ON u.id = s.submitted_by
     WHERE s.project_id = $1
     ORDER BY s.created_at DESC`,
    [projectId]
  );
  return rows;
}

// Projects are never hard-deleted (CANCELLED is the real "gone" state —
// see the FSM in domain/projectStatus.js), so a submission made before
// cancellation never disappears on its own; it just sits at
// PENDING_REVIEW forever with nothing left to actually do about it. This
// excludes those (see listCancelled below, which is exactly the
// complement) so the real, actionable queue an admin can still act on
// doesn't get cluttered with dead projects.
export async function listPendingReview() {
  const { rows } = await query(
    `SELECT s.*, u.name AS submitted_by_name, p.title AS project_title,
            p.business_id, p.worker_id
     FROM submissions s
     JOIN public_user_profiles u ON u.id = s.submitted_by
     JOIN projects p ON p.id = s.project_id
     WHERE s.status = 'PENDING_REVIEW' AND p.status != 'CANCELLED'
     ORDER BY s.created_at ASC`
  );
  return rows;
}

// The complement of the filter above — still PENDING_REVIEW, but the
// project it belonged to was cancelled before an admin ever got to it.
// Its own tab (AdminContentReviewTab.jsx) rather than silently vanishing,
// so there's still a record of what was submitted and a real reason it
// was never actioned, instead of it just disappearing from the queue with
// no trace.
export async function listCancelled() {
  const { rows } = await query(
    `SELECT s.*, u.name AS submitted_by_name, p.title AS project_title,
            p.business_id, p.worker_id
     FROM submissions s
     JOIN public_user_profiles u ON u.id = s.submitted_by
     JOIN projects p ON p.id = s.project_id
     WHERE s.status = 'PENDING_REVIEW' AND p.status = 'CANCELLED'
     ORDER BY p.updated_at DESC
     LIMIT 200`
  );
  return rows;
}

// The other half of the moderation queue — what an admin has already
// decided on, newest decision first. Content Review's pending list used to
// be the only view; once an item left PENDING_REVIEW it had nowhere to be
// seen again, so there was no way to confirm what you'd already approved
// or rejected. Capped at 200 — this is a review log, not a full archive.
export async function listReviewed() {
  const { rows } = await query(
    `SELECT s.*, u.name AS submitted_by_name, p.title AS project_title,
            p.business_id, p.worker_id
     FROM submissions s
     JOIN public_user_profiles u ON u.id = s.submitted_by
     JOIN projects p ON p.id = s.project_id
     WHERE s.status IN ('APPROVED', 'REJECTED')
     ORDER BY s.reviewed_at DESC
     LIMIT 200`
  );
  return rows;
}

export async function review(client, id, { status, reviewedBy, rejectionReason }) {
  const { rows } = await client.query(
    `UPDATE submissions
     SET status = $2::submission_status,
         reviewed_by = $3,
         reviewed_at = now(),
         rejection_reason = $4
     WHERE id = $1
     RETURNING *`,
    [id, status, reviewedBy, rejectionReason ?? null]
  );
  return rows[0] ?? null;
}
