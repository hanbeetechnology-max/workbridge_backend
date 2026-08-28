import { z } from "zod";

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  replyToMessageId: z.string().uuid().optional(),
});

// Same shape as createSubmissionSchema (submissions.validators.js) — a chat
// attachment IS a submission, just also surfaced inline in the message feed.
const MAX_IMAGE_DATA_LENGTH = 11_500_000;

const linkAttachmentSchema = z.object({
  type: z.literal("link"),
  url: z.string().url("Enter a valid link (Google Drive, Dropbox, etc.)"),
  caption: z.string().max(500).optional(),
});

const imageAttachmentSchema = z.object({
  type: z.literal("image"),
  imageData: z
    .string()
    .startsWith("data:image/", "Must be an image file")
    .max(MAX_IMAGE_DATA_LENGTH, "Image is too large — please use a link instead for files over ~8MB"),
  caption: z.string().max(500).optional(),
});

export const sendAttachmentMessageSchema = z.discriminatedUnion("type", [
  linkAttachmentSchema,
  imageAttachmentSchema,
]);

// The thread-wide route's attachment endpoint isn't scoped to one project by
// its URL the way /api/projects/:id/messages/attachment is — a deliverable
// shared from the merged conversation has to say up front which of the
// (possibly several) live projects between this pair it's for.
export const sendThreadAttachmentMessageSchema = z.discriminatedUnion("type", [
  linkAttachmentSchema.extend({ projectId: z.string().uuid() }),
  imageAttachmentSchema.extend({ projectId: z.string().uuid() }),
]);
