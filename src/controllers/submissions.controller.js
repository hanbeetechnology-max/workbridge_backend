import { transaction } from "../db/client.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import * as submissionsRepo from "../repositories/submissions.repository.js";
import * as adminRepo from "../repositories/admin.repository.js";
import { emitProjectEvent } from "../realtime/events.js";

async function mustBeParticipant(req, projectId) {
  const project = await projectsRepo.findById(projectId);
  if (!project) throw ApiError.notFound("Project not found.");

  const isParticipant = project.worker_id === req.user.id || project.business_id === req.user.id;
  if (!isParticipant && req.user.role !== "admin") {
    throw ApiError.forbidden("You are not a participant on this project.");
  }
  return project;
}

// POST /api/projects/:id/submissions — either participant can submit a
// deliverable (a worker's finished-work link/image, or a business's
// reference material). Always lands in PENDING_REVIEW — see listSubmissions
// for why the counterparty can't see it yet.
export const createSubmission = asyncHandler(async (req, res) => {
  const project = await mustBeParticipant(req, req.params.id);

  const { type, url, imageData, caption } = req.body;
  const submission = await submissionsRepo.create({
    projectId: req.params.id,
    submittedBy: req.user.id,
    type,
    url,
    imageData,
    caption,
  });

  // A heads-up only — PENDING_REVIEW content itself stays invisible to the
  // other participant until admin approves (listSubmissions below still
  // enforces that), same visibility rule this event doesn't bypass.
  emitProjectEvent(project, "SUBMISSION_CREATED", {
    submissionId: submission.id,
    submittedBy: req.user.id,
    senderId: req.user.id,
  });

  res.status(201).json({ data: submission });
});

// GET /api/projects/:id/submissions — the Trust Checker's visibility rule:
// the submitter sees their own submission at any status; the OTHER
// participant only ever sees APPROVED ones (PENDING_REVIEW/REJECTED are
// invisible to them, not just unlabeled) — admins see everything.
export const listSubmissions = asyncHandler(async (req, res) => {
  await mustBeParticipant(req, req.params.id);

  const all = await submissionsRepo.listForProject(req.params.id);
  const visible =
    req.user.role === "admin"
      ? all
      : all.filter((s) => s.submitted_by === req.user.id || s.status === "APPROVED");

  res.json({ data: visible });
});

// ─── Admin moderation ─────────────────────────────────────────────────────

// GET /api/admin/submissions
export const listPendingSubmissions = asyncHandler(async (_req, res) => {
  const data = await submissionsRepo.listPendingReview();
  res.json({ data });
});

// GET /api/admin/submissions/history — everything already approved/rejected,
// so an admin can confirm what actually happened after an item leaves the
// pending queue instead of it just disappearing.
export const listReviewedSubmissions = asyncHandler(async (_req, res) => {
  const data = await submissionsRepo.listReviewed();
  res.json({ data });
});

// GET /api/admin/submissions/cancelled — submissions still PENDING_REVIEW
// whose project was cancelled before anyone reviewed them. Excluded from
// listPendingSubmissions above (nothing left to action), shown here
// instead of just vanishing from the queue with no record.
export const listCancelledSubmissions = asyncHandler(async (_req, res) => {
  const data = await submissionsRepo.listCancelled();
  res.json({ data });
});

// PATCH /api/admin/submissions/:id — body: { approved: boolean, rejectionReason? }
export const reviewSubmission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { approved, rejectionReason } = req.body;

  const result = await transaction(async (client) => {
    const submission = await submissionsRepo.findById(id);
    if (!submission) throw ApiError.notFound("Submission not found.");
    if (submission.status !== "PENDING_REVIEW") {
      throw ApiError.badRequest(`This submission was already ${submission.status.toLowerCase()}.`);
    }

    const updated = await submissionsRepo.review(client, id, {
      status: approved ? "APPROVED" : "REJECTED",
      reviewedBy: req.user.id,
      rejectionReason: approved ? null : rejectionReason,
    });

    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: approved ? "SUBMISSION_APPROVED" : "SUBMISSION_REJECTED",
      targetProjectId: submission.project_id,
      notes: approved
        ? `Approved a ${submission.type} submission`
        : `Rejected a ${submission.type} submission${rejectionReason ? `: ${rejectionReason}` : ""}`,
    });

    const project = await projectsRepo.findById(submission.project_id, client);
    return { submission: updated, project };
  });

  emitProjectEvent(result.project, "SUBMISSION_REVIEWED", {
    submissionId: result.submission.id,
    status: result.submission.status,
    submittedBy: result.submission.submitted_by,
  });

  // Wire shape to the caller is unchanged — still just the submission row.
  res.json({ data: result.submission });
});
