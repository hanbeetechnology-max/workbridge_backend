import { Router } from "express";
import { guard } from "../middleware/guard.js";
import { validate } from "../middleware/validate.js";
import { sendMessageSchema, sendThreadAttachmentMessageSchema } from "../validators/messages.validators.js";
import {
  listMyThreads,
  listThreadMessages,
  sendThreadAttachmentMessage,
  sendThreadMessage,
  startThreadWithWorker,
} from "../controllers/messages.controller.js";

// The entity-wide chat introduced by migrations/031_chat_threads.sql — one
// persistent conversation per (business, worker) pair, spanning every
// project they've ever done together, alongside (not replacing) the
// original per-project routes still mounted under /api/projects/:id/messages.
export const threadsRouter = Router();

threadsRouter.use(guard);

threadsRouter.get("/", listMyThreads);
threadsRouter.post("/with/:userId", startThreadWithWorker);
threadsRouter.get("/:id/messages", listThreadMessages);
threadsRouter.post("/:id/messages", validate(sendMessageSchema), sendThreadMessage);
threadsRouter.post(
  "/:id/messages/attachment",
  validate(sendThreadAttachmentMessageSchema),
  sendThreadAttachmentMessage
);
