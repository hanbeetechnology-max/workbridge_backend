import { transaction } from "../db/client.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import * as candidatesRepo from "../repositories/job_candidates.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as threadsRepo from "../repositories/threads.repository.js";
import { emitProjectEvent, emitToUser } from "../realtime/events.js";

const UNIQUE_VIOLATION = "23505";

// POST /api/projects/:id/candidates — either a worker applying to an OPEN
// post (source=APPLICATION, workerId forced to req.user.id) or the
// business that owns it inviting one specific worker directly
// (source=INVITE, workerId required in the body). Which one it is comes
// entirely from req.user.role — the client never gets to choose source.
export const createCandidate = asyncHandler(async (req, res) => {
  const project = await projectsRepo.findById(req.params.id);
  if (!project) throw ApiError.notFound("Project not found.");
  if (project.status !== "OPEN") {
    throw ApiError.badRequest("This job is no longer accepting applications or invites.");
  }

  let workerId;
  let source;

  if (req.user.role === "worker") {
    source = "APPLICATION";
    workerId = req.user.id;
  } else if (req.user.role === "business") {
    if (project.business_id !== req.user.id) {
      throw ApiError.forbidden("You can only invite workers to your own job posts.");
    }
    if (!req.body.workerId) {
      throw ApiError.badRequest("workerId is required when a business invites a worker.");
    }
    const invitedWorker = await usersRepo.findById(req.body.workerId);
    if (!invitedWorker || invitedWorker.role !== "worker") {
      throw ApiError.badRequest("workerId must reference an existing worker.");
    }
    source = "INVITE";
    workerId = req.body.workerId;
  } else {
    throw ApiError.forbidden("Only a worker or a business may act on a job post.");
  }

  let candidate;
  try {
    // Only an APPLICATION (the worker's own choice to engage with the quiz
    // or skip it) ever adjusts Behavior Score — an INVITE is the business's
    // action, not the worker's, so quizAnswered is never sent/read for it.
    const quizAnswered = source === "APPLICATION" ? req.body.quizAnswered : undefined;

    candidate = await transaction(async (client) => {
      const created = await candidatesRepo.create(
        {
          projectId: project.id,
          workerId,
          source,
          message: req.body.message,
        },
        client
      );

      if (typeof quizAnswered === "boolean") {
        await usersRepo.adjustBehaviorScore(client, workerId, quizAnswered ? 15 : -5);
      }

      return created;
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw ApiError.conflict(
        source === "APPLICATION" ? "You've already applied to this job." : "This worker has already been invited to this job."
      );
    }
    throw err;
  }

  // A new direct invite notifies the worker being invited — a project
  // being posted specifically for them is worth a push. A new application
  // deliberately does NOT notify the business here: with a busy job post
  // getting many applicants, a push per applicant reads as noise rather
  // than signal — the business already sees the running count live on
  // their Applicants tab, and gets notified for real once a candidate is
  // actually accepted (CANDIDATE_ACCEPTED below).
  if (source !== "APPLICATION") {
    emitToUser(workerId, "CANDIDATE_CREATED", {
      candidateId: candidate.id,
      projectId: project.id,
      projectTitle: project.title,
      source,
    });
  }

  res.status(201).json({ data: candidate });
});

// GET /api/projects/:id/candidates — the business reviewing everyone who's
// applied or been invited on their own OPEN post.
export const listCandidatesForProject = asyncHandler(async (req, res) => {
  const project = await projectsRepo.findById(req.params.id);
  if (!project) throw ApiError.notFound("Project not found.");
  if (project.business_id !== req.user.id && req.user.role !== "admin") {
    throw ApiError.forbidden("You can only view candidates on your own job posts.");
  }

  const candidates = await candidatesRepo.listForProject(project.id);
  res.json({ data: candidates });
});

// GET /api/candidates/mine — a worker's own pending/decided candidacies
// (jobs they applied to, invites sent to them) — the "My Applications &
// Invites" view.
export const listMyCandidates = asyncHandler(async (req, res) => {
  const candidates = await candidatesRepo.listForWorker(req.user.id);
  res.json({ data: candidates });
});

// GET /api/candidates/pending-invited-workers — the business's own
// worker-invite badge state: which workers already have an outstanding
// PENDING invite from this business, across all of their own OPEN posts.
export const getPendingInvitedWorkers = asyncHandler(async (req, res) => {
  const workerIds = await candidatesRepo.listPendingInvitedWorkerIdsForBusiness(req.user.id);
  res.json({ data: workerIds });
});

// GET /api/candidates/stats — the Hustle Stats card's data: how many jobs
// this worker has applied to this week/month (Worker Dashboard "Momentum").
export const getMyCandidateStats = asyncHandler(async (req, res) => {
  const stats = await candidatesRepo.countApplicationsByPeriod(req.user.id);
  res.json({ data: stats });
});

// PATCH /api/candidates/:id — accept or decline a candidacy. Who's allowed
// to respond depends on source: an INVITE is the business's move already
// made, so only the invited worker can accept/decline it; an APPLICATION is
// the worker's move already made, so only the business reviews it.
// Accepting either one assigns the project (OPEN -> ACCEPTED, worker_id
// set) and closes every sibling candidacy on that project as CLOSED — see
// job_candidates.repository.js's closeOthersForProject.
export const respondToCandidate = asyncHandler(async (req, res) => {
  const { accept } = req.body;

  const result = await transaction(async (client) => {
    const candidate = await candidatesRepo.findByIdForUpdate(client, req.params.id);
    if (!candidate) throw ApiError.notFound("Candidacy not found.");

    const project = await projectsRepo.findByIdForUpdate(client, candidate.project_id);
    if (!project) throw ApiError.notFound("Project not found.");

    const isInviteResponder = candidate.source === "INVITE" && candidate.worker_id === req.user.id;
    const isApplicationResponder = candidate.source === "APPLICATION" && project.business_id === req.user.id;
    if (!isInviteResponder && !isApplicationResponder) {
      throw ApiError.forbidden("You are not able to respond to this.");
    }

    if (candidate.status !== "PENDING") {
      throw ApiError.badRequest(`This was already ${candidate.status.toLowerCase()}.`);
    }
    if (project.status !== "OPEN") {
      throw ApiError.badRequest("This job is no longer open — it was already filled.");
    }

    if (!accept) {
      const declined = await candidatesRepo.updateStatus(client, candidate.id, "DECLINED");
      return { declined, project, candidate };
    }

    await candidatesRepo.updateStatus(client, candidate.id, "ACCEPTED");
    const assignedProject = await projectsRepo.assignWorker(client, project.id, candidate.worker_id, "ACCEPTED");
    const closedCandidates = await candidatesRepo.closeOthersForProject(client, project.id, candidate.id);
    // The persistent (business, worker) chat thread — see
    // chat_threads/threads.repository.js. This is the other of the two
    // places a project ever gets a real worker_id (see createProject's
    // direct-invite path for the first) — created here, inside the same
    // transaction as the acceptance itself, and reused for every future
    // project between this same pair.
    await threadsRepo.getOrCreateThread(project.business_id, candidate.worker_id, client);

    return { assignedProject, closedCandidates, candidate };
  });

  if (!accept) {
    // A declined INVITE (business's move) or a declined APPLICATION (the
    // business rejecting one applicant) — either way, the job stays OPEN
    // and only the other side of this one candidacy needs to hear about it.
    if (result.candidate.source === "INVITE") {
      emitToUser(result.project.business_id, "CANDIDATE_DECLINED", {
        candidateId: result.candidate.id,
        projectId: result.project.id,
        projectTitle: result.project.title,
      });
    } else {
      emitToUser(result.candidate.worker_id, "CANDIDATE_DECLINED", {
        candidateId: result.candidate.id,
        projectId: result.project.id,
        projectTitle: result.project.title,
      });
    }
    return res.json({ data: result.declined });
  }

  // Both real participants now exist on the project — this reaches them
  // through the normal project rooms, same as every other status change.
  emitProjectEvent(result.assignedProject, "CANDIDATE_ACCEPTED", {
    candidateId: result.candidate.id,
    senderId: req.user.id,
  });

  // Everyone else who applied or was invited lost out to this acceptance —
  // none of them are project participants, so each gets a direct nudge.
  for (const closed of result.closedCandidates) {
    emitToUser(closed.worker_id, "JOB_FILLED", {
      candidateId: closed.id,
      projectId: result.assignedProject.id,
      projectTitle: result.assignedProject.title,
    });
  }

  res.json({ data: result.assignedProject });
});
