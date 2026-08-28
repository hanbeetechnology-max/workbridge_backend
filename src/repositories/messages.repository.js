import { query } from "../db/client.js";

// Plain text message. Attachment messages (submission_id set) go through
// createAttachment below instead, since those need the submission row
// created in the same transaction. threadId is always resolved server-side
// (never client-supplied) before this is called — see
// messages.controller.js. projectId stays optional: set for every message
// written by the per-project routes or an attachment (a deliverable always
// belongs to exactly one project), null for a general message sent through
// the thread-wide route with no single project in mind.
export async function create({ threadId, projectId = null, senderId, body, replyToMessageId = null }) {
  const { rows } = await query(
    `INSERT INTO messages (thread_id, project_id, sender_id, body, reply_to_message_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [threadId, projectId, senderId, body, replyToMessageId]
  );
  return rows[0];
}

// Confirms a message being replied to actually belongs to the same thread
// (or project, for the older per-project routes) the reply is being sent
// into — never trusted blind from the client, same spirit as
// sendThreadAttachmentMessage's projectId check in messages.controller.js.
export async function findByIdInThread(id, threadId) {
  const { rows } = await query(`SELECT id FROM messages WHERE id = $1 AND thread_id = $2`, [id, threadId]);
  return rows[0] ?? null;
}

export async function createLinkedToSubmission(client, { threadId, projectId = null, senderId, body, submissionId }) {
  const { rows } = await client.query(
    `INSERT INTO messages (thread_id, project_id, sender_id, body, submission_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [threadId, projectId, senderId, body ?? null, submissionId]
  );
  return rows[0];
}

// Message Monitor's "Warn" action — a real, permanent message in the
// project's chat, sender_id set to the issuing admin (the FK requires a
// real user) but flagged so ChatThread.jsx renders it as a system banner,
// not attributed to either participant.
export async function createSystemNotice(client, { threadId, projectId = null, adminId, body }) {
  const { rows } = await client.query(
    `INSERT INTO messages (thread_id, project_id, sender_id, body, is_system_notice)
     VALUES ($1, $2, $3, $4, true)
     RETURNING *`,
    [threadId, projectId, adminId, body]
  );
  return rows[0];
}

// Message Monitor's "Ban User"/"Warn" actions need to know who sent a given
// message and on which project, without pulling the whole listForProject
// join for one row.
export async function findById(id) {
  const { rows } = await query(`SELECT id, project_id, thread_id, sender_id, body FROM messages WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Joined to the sender's public profile (name) and, when the message wraps
// a shared file, the submission itself — same shape submissions.repository
// .js's listForProject returns, so the frontend can render an attachment
// bubble with one code path shared with DeliverablesPanel. Visibility
// (submitter sees their own submission at any status; the counterparty only
// once APPROVED) is enforced by the caller, same as listSubmissions in
// submissions.controller.js — not here, to keep that one rule in one place
// conceptually even though it's applied in two controllers.
//
// Deliberately stays scoped to ONE project (unchanged since before the
// thread migration) — this backs the original /api/projects/:id/messages
// routes, which keep behaving exactly as they did before thread_id existed.
// listForThread below is the new, merged-history counterpart.
export async function listForProject(projectId) {
  const { rows } = await query(
    `SELECT m.id, m.project_id, m.thread_id, m.sender_id, m.body, m.created_at, m.is_system_notice,
            u.name AS sender_name,
            s.id AS submission_id, s.type AS submission_type, s.url AS submission_url,
            s.image_data AS submission_image_data, s.caption AS submission_caption,
            s.status AS submission_status, s.submitted_by AS submission_submitted_by,
            s.rejection_reason AS submission_rejection_reason,
            m.reply_to_message_id, ru.name AS reply_to_sender_name, r.body AS reply_to_body,
            (r.submission_id IS NOT NULL) AS reply_to_is_attachment
     FROM messages m
     JOIN public_user_profiles u ON u.id = m.sender_id
     LEFT JOIN submissions s ON s.id = m.submission_id
     LEFT JOIN messages r ON r.id = m.reply_to_message_id
     LEFT JOIN public_user_profiles ru ON ru.id = r.sender_id
     WHERE m.project_id = $1
     ORDER BY m.created_at ASC`,
    [projectId]
  );
  return rows;
}

// The merged relationship history behind /api/threads/:id/messages — every
// message this (business, worker) pair has ever exchanged, across every
// project, in one continuous feed. Same join shape as listForProject.
export async function listForThread(threadId) {
  const { rows } = await query(
    `SELECT m.id, m.project_id, m.thread_id, m.sender_id, m.body, m.created_at, m.is_system_notice,
            u.name AS sender_name,
            s.id AS submission_id, s.type AS submission_type, s.url AS submission_url,
            s.image_data AS submission_image_data, s.caption AS submission_caption,
            s.status AS submission_status, s.submitted_by AS submission_submitted_by,
            s.rejection_reason AS submission_rejection_reason,
            m.reply_to_message_id, ru.name AS reply_to_sender_name, r.body AS reply_to_body,
            (r.submission_id IS NOT NULL) AS reply_to_is_attachment
     FROM messages m
     JOIN public_user_profiles u ON u.id = m.sender_id
     LEFT JOIN submissions s ON s.id = m.submission_id
     LEFT JOIN messages r ON r.id = m.reply_to_message_id
     LEFT JOIN public_user_profiles ru ON ru.id = r.sender_id
     WHERE m.thread_id = $1
     ORDER BY m.created_at ASC`,
    [threadId]
  );
  return rows;
}
