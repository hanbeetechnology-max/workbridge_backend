import { Router } from "express";
import { guard, requireRole } from "../middleware/guard.js";
import { validate } from "../middleware/validate.js";
import {
  createProjectSchema,
  listProjectsQuerySchema,
  updateProjectStatusSchema,
  proposeBudgetSchema,
  disputeRebuttalSchema,
} from "../validators/projects.validators.js";
import {
  cancelAndRefund,
  completeProject,
  createCheckoutOrder,
  createProject,
  fundEscrow,
  getProject,
  listOpenProjects,
  listFeaturedEmployers,
  getProjectShortlist,
  broadcastProject,
  listProjects,
  requestRelease,
  updateProjectStatus,
  proposeBudget,
  resolveBudgetProposal,
  raiseDisputeRebuttal,
} from "../controllers/projects.controller.js";
import { createSubmission, listSubmissions } from "../controllers/submissions.controller.js";
import { createSubmissionSchema } from "../validators/submissions.validators.js";
import { listMessages, sendAttachmentMessage, sendMessage } from "../controllers/messages.controller.js";
import { sendAttachmentMessageSchema, sendMessageSchema } from "../validators/messages.validators.js";
import { createCandidate, listCandidatesForProject } from "../controllers/job_candidates.controller.js";
import { createCandidateSchema } from "../validators/job_candidates.validators.js";

export const projectsRouter = Router();

projectsRouter.use(guard);

// Registered before "/:id" — otherwise Express would match "open" as an
// :id and route it into getProject instead of the job board feed below.
projectsRouter.get("/open", requireRole("worker"), listOpenProjects);
projectsRouter.get("/featured-employers", requireRole("worker"), listFeaturedEmployers);

projectsRouter.get("/", validate(listProjectsQuerySchema, "query"), listProjects);
projectsRouter.post("/", requireRole("business"), validate(createProjectSchema), createProject);
projectsRouter.get("/:id", getProject);
projectsRouter.patch("/:id", validate(updateProjectStatusSchema), updateProjectStatus);
// The accused party's one-shot structured response to a dispute — its own
// route rather than another generic-PATCH branch, same reasoning as
// fund-escrow/checkout/request-release below (real validation + audit log,
// not just a status string).
projectsRouter.post("/:id/dispute/rebuttal", validate(disputeRebuttalSchema), raiseDisputeRebuttal);

// Real effects of the "AI Shortlist" / "Enterprise Broadcast" perks —
// gated behind an active purchase targeting this exact project (checked
// inside each controller via perkPurchasesRepo.findActive).
projectsRouter.get("/:id/shortlist", requireRole("business"), getProjectShortlist);
projectsRouter.post("/:id/broadcast", requireRole("business"), broadcastProject);

// The Open Job Board's apply/invite step — either a worker applying to an
// OPEN post or the owning business inviting a specific worker to it (see
// job_candidates.controller.js's createCandidate for how source is decided
// server-side from req.user.role, never trusted from the client).
projectsRouter.post("/:id/candidates", validate(createCandidateSchema), createCandidate);
projectsRouter.get("/:id/candidates", listCandidatesForProject);

// Both deliberately their own routes rather than PATCH /:id { status: ... },
// since each does far more than a status update (ledger side effects,
// atomically). Keeping them distinct endpoints makes that contract visible
// in the route table, not buried in an if-branch inside the generic PATCH
// handler.
projectsRouter.post("/:id/fund-escrow", requireRole("business"), fundEscrow);
// Real Razorpay Checkout — the primary funding path; fund-escrow above
// stays as the manual bank-transfer fallback (see createCheckoutOrder's
// own comment in projects.controller.js for why both coexist).
projectsRouter.post("/:id/checkout", requireRole("business"), createCheckoutOrder);
// The business only ever *requests* a release now — the actual payout
// (completeProject) requires WorkBridge staff to act on it from the Admin
// Panel's Fund Releases tab, so this route is admin-only, not business.
projectsRouter.post("/:id/request-release", requireRole("business"), requestRelease);
projectsRouter.post("/:id/complete", requireRole("admin"), completeProject);
// The Ghosting Failsafe — business-only, instant, deadline-gated (see
// cancelAndRefund's own comment for why this stays out of admin's hands).
projectsRouter.post("/:id/cancel-refund", requireRole("business"), cancelAndRefund);

// Budget negotiation — the posted budget used to be fixed once live; the
// assigned worker can now propose a real counter-offer (worker-only,
// ACCEPTED-only) and the business accepts/declines it (business-only).
projectsRouter.post("/:id/propose-budget", requireRole("worker"), validate(proposeBudgetSchema), proposeBudget);
projectsRouter.post("/:id/resolve-budget", requireRole("business"), resolveBudgetProposal);

// The Trust Checker — either participant can submit a deliverable (link or
// small image); every submission starts PENDING_REVIEW (see
// submissions.controller.js's listSubmissions for the visibility rule).
projectsRouter.post("/:id/submissions", validate(createSubmissionSchema), createSubmission);
projectsRouter.get("/:id/submissions", listSubmissions);

// The real-time chat thread — one continuous conversation per project (see
// messages table's comment in schema.sql). Attachment messages reuse the
// Trust Checker moderation pipeline (messages.controller.js's
// sendAttachmentMessage creates the underlying submission + message row
// together), so listMessages applies the same visibility rule as
// listSubmissions above.
projectsRouter.get("/:id/messages", listMessages);
projectsRouter.post("/:id/messages", validate(sendMessageSchema), sendMessage);
projectsRouter.post("/:id/messages/attachment", validate(sendAttachmentMessageSchema), sendAttachmentMessage);
