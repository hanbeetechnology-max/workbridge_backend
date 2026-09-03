import { Router } from "express";
import { guard, requireRole } from "../middleware/guard.js";
import { validate } from "../middleware/validate.js";
import {
  listVerifications,
  verifyUser,
  getPlatformStats,
  listDisputes,
  resolveDispute,
  listAllUsers,
  listTransactions,
  listManualPayouts,
  completeManualPayout,
  listPendingReleases,
  listPendingWithdrawals,
  resolveWithdrawal,
  listPendingEscrowFunding,
  resolveEscrowFunding,
  listPendingAudits,
  resolveAudit,
  impersonateUser,
  listBlockedAttempts,
  resolveBlockedAttempt,
  searchMessages,
  moderateMessageSender,
  listMonitoredBusinesses,
  listWorkersForBusiness,
  moderateUser,
  updateAdminPermissions,
  listTeam,
  addTeamMember,
  removeTeamMember,
} from "../controllers/admin.controller.js";
import { listPendingSubmissions, listReviewedSubmissions, listCancelledSubmissions, reviewSubmission } from "../controllers/submissions.controller.js";
import { reviewSubmissionSchema } from "../validators/submissions.validators.js";

export const adminRouter = Router();

// "Admin Guard" — every route below requires a valid JWT (guard) AND a
// role: "admin" claim (requireRole). This is the same requireRole(...) used
// to gate business-only/worker-only routes elsewhere — a separate bespoke
// adminMiddleware would just duplicate this exact check.
adminRouter.use(guard, requireRole("admin"));

adminRouter.get("/verify", listVerifications);
adminRouter.patch("/verify/:id", verifyUser);

adminRouter.get("/users", listAllUsers);
adminRouter.post("/impersonate", impersonateUser);

adminRouter.get("/stats", getPlatformStats);

adminRouter.get("/disputes", listDisputes);
adminRouter.post("/disputes/:id/resolve", resolveDispute);

adminRouter.get("/transactions", listTransactions);
adminRouter.get("/manual-payouts", listManualPayouts);
adminRouter.post("/manual-payouts/:id/complete", completeManualPayout);
adminRouter.get("/pending-releases", listPendingReleases);

adminRouter.get("/withdrawals", listPendingWithdrawals);
adminRouter.post("/withdrawals/:id/resolve", resolveWithdrawal);

adminRouter.get("/escrow-funding", listPendingEscrowFunding);
adminRouter.post("/escrow-funding/:id/resolve", resolveEscrowFunding);

// Real queue behind the worker "Skill Bridge Profile Audit" perk.
adminRouter.get("/audits", listPendingAudits);
adminRouter.patch("/audits/:id/resolve", resolveAudit);

// Security Monitor — blocked_message_attempts is the only record of a
// contact-info send that got hard-blocked (see messages.controller.js).
adminRouter.get("/blocked-attempts", listBlockedAttempts);
adminRouter.patch("/blocked-attempts/:id", resolveBlockedAttempt);

// Message monitor — full-text search over every real chat message.
adminRouter.get("/messages", searchMessages);
adminRouter.patch("/messages/:id/moderate", moderateMessageSender);
adminRouter.get("/messages/businesses", listMonitoredBusinesses);
adminRouter.get("/messages/businesses/:businessId/workers", listWorkersForBusiness);
adminRouter.patch("/users/:id/moderate", moderateUser);
// Minimal real Support-tier RBAC — a full admin (both flags still true)
// dials another admin's own account down to a restricted subset.
adminRouter.patch("/users/:id/permissions", updateAdminPermissions);
adminRouter.get("/team", listTeam);
adminRouter.post("/team", addTeamMember);
adminRouter.delete("/team/:id", removeTeamMember);

// The Trust Checker's moderation queue.
adminRouter.get("/submissions", listPendingSubmissions);
adminRouter.get("/submissions/history", listReviewedSubmissions);
adminRouter.get("/submissions/cancelled", listCancelledSubmissions);
adminRouter.patch("/submissions/:id", validate(reviewSubmissionSchema), reviewSubmission);
