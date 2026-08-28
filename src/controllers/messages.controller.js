import { transaction } from "../db/client.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { containsContactInfo } from "../utils/contactFilter.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import * as messagesRepo from "../repositories/messages.repository.js";
import * as submissionsRepo from "../repositories/submissions.repository.js";
import * as blockedAttemptsRepo from "../repositories/blocked_attempts.repository.js";
import * as userBlocksRepo from "../repositories/user_blocks.repository.js";
import * as notificationsRepo from "../repositories/notifications.repository.js";
import * as threadsRepo from "../repositories/threads.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import { emitProjectEvent, emitThreadEvent } from "../realtime/events.js";

const CHAT_BAN_MESSAGE =
  "Your chat privileges have been temporarily suspended due to a policy violation. You can still submit active deliverables to receive payment.";

// The Dual-Ban Moderation Engine's soft tier (migrations/032_chat_ban.sql)
// — locks the composer for whichever side is chat-banned, without touching
// login, submissions, or escrow payouts, so a business's funds never get
// trapped mid-project over a chat-only violation. Admin senders (system
// notices) bypass this, same as every other gate below — an admin's own
// warning message is never subject to the ban it's enforcing. Read-only
// routes (listMessages/listThreadMessages) never call this — a chat-banned
// user can still see their own history, just not add to it.
async function assertNotChatBanned(req) {
  if (req.user.role === "admin") return;
  if (await usersRepo.isChatBanned(req.user.id)) {
    throw ApiError.forbidden(CHAT_BAN_MESSAGE);
  }
}

async function mustBeParticipant(req, projectId) {
  const project = await projectsRepo.findById(projectId);
  if (!project) throw ApiError.notFound("Project not found.");

  const isParticipant = project.worker_id === req.user.id || project.business_id === req.user.id;
  if (!isParticipant && req.user.role !== "admin") {
    throw ApiError.forbidden("You are not a participant on this project.");
  }
  return project;
}

// The thread-side counterpart to mustBeParticipant above — same shape, just
// resolving a chat_threads row (a persistent business/worker pair, see
// threads.repository.js) instead of a project.
async function mustBeThreadParticipant(req, threadId) {
  const thread = await threadsRepo.findById(threadId);
  if (!thread) throw ApiError.notFound("Conversation not found.");

  const isParticipant = thread.worker_id === req.user.id || thread.business_id === req.user.id;
  if (!isParticipant && req.user.role !== "admin") {
    throw ApiError.forbidden("You are not a participant in this conversation.");
  }
  return thread;
}

// WhatsApp-style block, enforced server-side (not just a disabled composer
// — see ChatThread.jsx) — blocks in either direction stop a send, same as
// real blocking. Admin senders (system notices) bypass this entirely, same
// as the participant checks above. Takes the other participant's id
// directly so both the project-scoped and thread-scoped callers can share it.
async function assertNotBlocked(req, otherUserId) {
  if (req.user.role === "admin") return;
  if (!otherUserId) return;
  const status = await userBlocksRepo.getStatus(req.user.id, otherUserId);
  if (status.blocked_by_me) throw ApiError.forbidden("You've blocked this user — unblock them to send a message.");
  if (status.blocked_me) throw ApiError.forbidden("You can't message this user.");
}

const CONTACT_INFO_MESSAGE =
  "Sharing phone numbers or email addresses in chat isn't allowed — keep contact details off WorkBridge.";

// Blocked sends previously only surfaced as an inline composer error at the
// moment they happened — easy to miss, and gone the second the sender
// navigates away. This gives them a real, persisted record in their own
// Notification Bell (the same table/drawer real project events use), not
// just a fleeting toast. Fire-and-forget on purpose, same as
// realtime/events.js's fireNotification — a failed insert here must never
// block the 400 rejection that's the actual point of this code path.
async function notifyBlockedAttempt(senderId) {
  try {
    await notificationsRepo.create({
      userId: senderId,
      title: "Message blocked",
      message: CONTACT_INFO_MESSAGE,
      type: "SYSTEM",
      url: null,
    });
  } catch (err) {
    console.error("[messages] Could not persist blocked-attempt notification:", err);
  }
}

// POST /api/projects/:id/messages — a plain text chat message. Unchanged
// behavior from before the entity-thread migration (migrations/031) — still
// gated on and filtered to this one project. Also resolves/creates the
// (business, worker) pair's persistent chat_threads row and stamps it on the
// message, purely so the newer /api/threads/:id routes see this message too
// once a frontend actually reads from there — nothing about this route's own
// response or visibility changes.
export const sendMessage = asyncHandler(async (req, res) => {
  const project = await mustBeParticipant(req, req.params.id);
  const otherUserId = project.worker_id === req.user.id ? project.business_id : project.worker_id;
  await assertNotBlocked(req, otherUserId);
  await assertNotChatBanned(req);

  const thread = project.worker_id
    ? await threadsRepo.getOrCreateThread(project.business_id, project.worker_id)
    : null;

  const { body } = req.body;
  if (containsContactInfo(body)) {
    // The message is never stored — only this record of the attempt, for
    // Security Monitor (admin.controller.js) to review. See
    // schema.sql's blocked_message_attempts comment for why this is the one
    // place blocked content is kept at all.
    await blockedAttemptsRepo.create({
      projectId: req.params.id,
      threadId: thread?.id ?? null,
      senderId: req.user.id,
      attemptedText: body,
    });
    await notifyBlockedAttempt(req.user.id);
    throw ApiError.badRequest(CONTACT_INFO_MESSAGE);
  }

  const message = await messagesRepo.create({
    threadId: thread?.id ?? null,
    projectId: req.params.id,
    senderId: req.user.id,
    body,
  });

  emitProjectEvent(project, "MESSAGE_CREATED", {
    messageId: message.id,
    senderId: req.user.id,
  });

  res.status(201).json({ data: message });
});

// POST /api/projects/:id/messages/attachment — a file/link shared inline in
// chat. Creates the underlying submission (the same Trust Checker
// moderation queue DeliverablesPanel already uses) and the message row that
// surfaces it in the feed in one transaction, so a message can never end up
// pointing at a submission that doesn't exist.
export const sendAttachmentMessage = asyncHandler(async (req, res) => {
  const project = await mustBeParticipant(req, req.params.id);
  const otherUserId = project.worker_id === req.user.id ? project.business_id : project.worker_id;
  await assertNotBlocked(req, otherUserId);
  await assertNotChatBanned(req);

  const thread = project.worker_id
    ? await threadsRepo.getOrCreateThread(project.business_id, project.worker_id)
    : null;

  const { type, url, imageData, caption } = req.body;
  if (containsContactInfo(caption)) {
    await blockedAttemptsRepo.create({
      projectId: req.params.id,
      threadId: thread?.id ?? null,
      senderId: req.user.id,
      attemptedText: caption,
    });
    await notifyBlockedAttempt(req.user.id);
    throw ApiError.badRequest(CONTACT_INFO_MESSAGE);
  }

  const { message, submission } = await transaction(async (client) => {
    const createdSubmission = await submissionsRepo.createWithClient(client, {
      projectId: req.params.id,
      submittedBy: req.user.id,
      type,
      url,
      imageData,
      caption,
    });
    const createdMessage = await messagesRepo.createLinkedToSubmission(client, {
      threadId: thread?.id ?? null,
      projectId: req.params.id,
      senderId: req.user.id,
      body: caption ?? null,
      submissionId: createdSubmission.id,
    });
    return { message: createdMessage, submission: createdSubmission };
  });

  // Two events, not one — DeliverablesPanel listens for SUBMISSION_CREATED
  // (unchanged contract; still fires for every submission no matter where it
  // was created from) and ChatThread listens for MESSAGE_CREATED.
  emitProjectEvent(project, "SUBMISSION_CREATED", {
    submissionId: submission.id,
    submittedBy: req.user.id,
    senderId: req.user.id,
  });
  emitProjectEvent(project, "MESSAGE_CREATED", {
    messageId: message.id,
    senderId: req.user.id,
  });

  res.status(201).json({ data: message });
});

// GET /api/projects/:id/messages — mirrors listSubmissions' visibility rule
// (submissions.controller.js): an attachment message is only visible to the
// counterparty once its submission is APPROVED — PENDING_REVIEW/REJECTED
// stay invisible to them, not just unlabeled. Admins and the sender always
// see it. Plain text messages (no submission_id) never went through
// moderation, so they carry no such gate. Unchanged by the entity-thread
// migration — still filtered to this one project's own history.
export const listMessages = asyncHandler(async (req, res) => {
  await mustBeParticipant(req, req.params.id);

  const all = await messagesRepo.listForProject(req.params.id);
  const visible = filterVisibleMessages(all, req.user);

  res.json({ data: visible });
});

function filterVisibleMessages(messages, user) {
  if (user.role === "admin") return messages;
  return messages.filter(
    (m) => !m.submission_id || m.submission_submitted_by === user.id || m.submission_status === "APPROVED"
  );
}

// GET /api/threads — the merged Negotiations inbox: one row per
// counterparty (spanning every project with them) instead of one per
// project. See threads.repository.js's getUserThreads.
export const listMyThreads = asyncHandler(async (req, res) => {
  const threads = await threadsRepo.getUserThreads(req.user.id);
  res.json({ data: threads });
});

// GET /api/threads/:id/messages — the full relationship history, spanning
// every project this pair has ever worked on together. Same visibility rule
// as the per-project listMessages above.
export const listThreadMessages = asyncHandler(async (req, res) => {
  const thread = await mustBeThreadParticipant(req, req.params.id);
  const all = await messagesRepo.listForThread(thread.id);
  const visible = filterVisibleMessages(all, req.user);

  res.json({ data: visible });
});

// POST /api/threads/:id/messages — a plain text message in the merged
// conversation, not tied to any one project (project_id stays null). This
// is deliberately just talk — structural project actions (uploading a
// deliverable, requesting a fund release) go through
// sendThreadAttachmentMessage below or the existing per-project routes
// instead, never inferred from "whichever project happens to be active."
export const sendThreadMessage = asyncHandler(async (req, res) => {
  const thread = await mustBeThreadParticipant(req, req.params.id);
  const otherUserId = thread.worker_id === req.user.id ? thread.business_id : thread.worker_id;
  await assertNotBlocked(req, otherUserId);
  await assertNotChatBanned(req);

  const { body, replyToMessageId } = req.body;
  if (containsContactInfo(body)) {
    await blockedAttemptsRepo.create({ threadId: thread.id, senderId: req.user.id, attemptedText: body });
    await notifyBlockedAttempt(req.user.id);
    throw ApiError.badRequest(CONTACT_INFO_MESSAGE);
  }

  let replyTo = null;
  if (replyToMessageId) {
    replyTo = await messagesRepo.findByIdInThread(replyToMessageId, thread.id);
    if (!replyTo) throw ApiError.badRequest("That message isn't part of this conversation.");
  }

  const message = await messagesRepo.create({ threadId: thread.id, senderId: req.user.id, body, replyToMessageId: replyTo?.id ?? null });

  emitThreadEvent(thread, "MESSAGE_CREATED", { messageId: message.id, senderId: req.user.id });

  res.status(201).json({ data: message });
});

// POST /api/threads/:id/messages/attachment — a deliverable shared from a
// specific Active Project Card in the merged conversation, not the general
// composer. projectId in the body says which of the (possibly several) live
// projects between this pair it belongs to, and is verified to actually be
// one of them — never trusted blind, since escrow/deliverable review both
// key off project_id and must never attach to the wrong contract.
export const sendThreadAttachmentMessage = asyncHandler(async (req, res) => {
  const thread = await mustBeThreadParticipant(req, req.params.id);
  const otherUserId = thread.worker_id === req.user.id ? thread.business_id : thread.worker_id;
  await assertNotBlocked(req, otherUserId);
  await assertNotChatBanned(req);

  const { type, url, imageData, caption, projectId } = req.body;
  const project = await projectsRepo.findById(projectId);
  if (!project || project.business_id !== thread.business_id || project.worker_id !== thread.worker_id) {
    throw ApiError.badRequest("That project isn't part of this conversation.");
  }

  if (containsContactInfo(caption)) {
    await blockedAttemptsRepo.create({ threadId: thread.id, projectId, senderId: req.user.id, attemptedText: caption });
    await notifyBlockedAttempt(req.user.id);
    throw ApiError.badRequest(CONTACT_INFO_MESSAGE);
  }

  const { message, submission } = await transaction(async (client) => {
    const createdSubmission = await submissionsRepo.createWithClient(client, {
      projectId,
      submittedBy: req.user.id,
      type,
      url,
      imageData,
      caption,
    });
    const createdMessage = await messagesRepo.createLinkedToSubmission(client, {
      threadId: thread.id,
      projectId,
      senderId: req.user.id,
      body: caption ?? null,
      submissionId: createdSubmission.id,
    });
    return { message: createdMessage, submission: createdSubmission };
  });

  // The project itself still gets its own event — DeliverablesPanel and
  // anything else scoped to that one project listens on the project room,
  // not the thread. The thread gets the chat-visible message event.
  emitProjectEvent(project, "SUBMISSION_CREATED", { submissionId: submission.id, submittedBy: req.user.id, senderId: req.user.id });
  emitThreadEvent(thread, "MESSAGE_CREATED", { messageId: message.id, senderId: req.user.id, projectId });

  res.status(201).json({ data: message });
});
