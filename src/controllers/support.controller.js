import { transaction } from "../db/client.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as supportRepo from "../repositories/support.repository.js";
import { emitSupportMessage } from "../realtime/events.js";

// GET /api/support/thread — the caller's own conversation with WorkBridge
// staff. Read-only: doesn't create a thread just from viewing the page —
// that only happens the moment they actually send a first message (below).
export const getMyThread = asyncHandler(async (req, res) => {
  const thread = await supportRepo.getThreadForUser(req.user.id);
  if (!thread) return res.json({ data: { thread: null, messages: [] } });

  const messages = await supportRepo.listMessagesForThread(thread.id);
  res.json({ data: { thread, messages } });
});

// POST /api/support/thread/messages — the caller's own message to support.
// find-or-create means this doubles as "start a conversation" the first
// time it's called, with no separate step.
export const sendMyMessage = asyncHandler(async (req, res) => {
  const { body } = req.body;

  const message = await transaction(async (client) => {
    const thread = await supportRepo.findOrCreateThreadForUser(client, req.user.id);
    const created = await supportRepo.insertMessage(client, {
      threadId: thread.id,
      senderId: req.user.id,
      senderRole: req.user.role,
      body,
    });
    await supportRepo.touchThread(client, thread.id, { reopen: thread.status === "RESOLVED" });
    return { thread, created };
  });

  emitSupportMessage(message.thread, { messageId: message.created.id, senderRole: req.user.role, senderId: req.user.id });

  res.status(201).json({ data: message.created });
});

// GET /api/support/threads — admin's Customer Care inbox: every
// conversation, newest activity first.
export const listThreadsForAdmin = asyncHandler(async (_req, res) => {
  const threads = await supportRepo.listThreadsForAdmin();
  res.json({ data: threads });
});

// GET /api/support/threads/:id/messages — admin reading one conversation.
export const getThreadMessagesForAdmin = asyncHandler(async (req, res) => {
  const thread = await supportRepo.findById(req.params.id);
  if (!thread) throw ApiError.notFound("Support thread not found.");

  const messages = await supportRepo.listMessagesForThread(thread.id);
  res.json({ data: { thread, messages } });
});

// POST /api/support/threads/:id/messages — staff replying. senderRole is
// always 'admin' here (not whatever req.user.role literally is at the
// call site, since only admin-guarded routes reach this) — explicit for
// clarity at the call site.
export const sendAdminMessage = asyncHandler(async (req, res) => {
  const { body } = req.body;
  const thread = await supportRepo.findById(req.params.id);
  if (!thread) throw ApiError.notFound("Support thread not found.");

  const message = await transaction(async (client) => {
    const created = await supportRepo.insertMessage(client, {
      threadId: thread.id,
      senderId: req.user.id,
      senderRole: "admin",
      body,
    });
    await supportRepo.touchThread(client, thread.id, { reopen: thread.status === "RESOLVED" });
    return created;
  });

  emitSupportMessage(thread, { messageId: message.id, senderRole: "admin", senderId: req.user.id });

  res.status(201).json({ data: message });
});

// PATCH /api/support/threads/:id — mark a conversation resolved (or
// explicitly reopen it without waiting for a new message).
export const updateThreadStatus = asyncHandler(async (req, res) => {
  const thread = await supportRepo.findById(req.params.id);
  if (!thread) throw ApiError.notFound("Support thread not found.");

  const updated = await supportRepo.setStatus(req.params.id, req.body.status);
  res.json({ data: updated });
});
