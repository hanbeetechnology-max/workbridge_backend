import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { transaction } from "../db/client.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { containsContactInfo } from "../utils/contactFilter.js";
import * as adminRepo from "../repositories/admin.repository.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import * as transactionsRepo from "../repositories/transactions.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as messagesRepo from "../repositories/messages.repository.js";
import * as blockedAttemptsRepo from "../repositories/blocked_attempts.repository.js";
import * as withdrawalRequestsRepo from "../repositories/withdrawal_requests.repository.js";
import * as escrowFundingRepo from "../repositories/escrow_funding_requests.repository.js";
import * as profileAuditRepo from "../repositories/profile_audit_requests.repository.js";
import * as threadsRepo from "../repositories/threads.repository.js";
import { emitProjectEvent } from "../realtime/events.js";
import { sendEscrowFundedSms } from "../services/sms.service.js";
import * as razorpayService from "../services/razorpay.service.js";
import * as cashfreeService from "../services/cashfree.service.js";

const WORKER_FEE_PCT_FALLBACK = 7; // schema.sql's projects.worker_fee_pct default

function round2(n) {
  return Math.round(n * 100) / 100;
}

// req.user only ever carries { id, role } (see guard.js) — the acting
// admin's own permission flags aren't on the JWT, so this fetches their
// current row fresh on every gated action, the same pattern as messages
// .controller.js's assertNotChatBanned. Fails closed: a missing/deleted
// admin row is treated as no permission, not skipped.
async function assertAdminPermission(req, column, message) {
  const actingAdmin = await usersRepo.findById(req.user.id);
  if (!actingAdmin || actingAdmin[column] === false) {
    throw ApiError.forbidden(message);
  }
}

// ─── Verification Center ─────────────────────────────────────────────────────

// GET /api/admin/verify
export const listVerifications = asyncHandler(async (_req, res) => {
  const data = await adminRepo.listPendingVerifications();
  res.json({ data });
});

// GET /api/admin/users — the full user directory for the admin Users tab.
export const listAllUsers = asyncHandler(async (_req, res) => {
  const data = await adminRepo.listAllUsers();
  res.json({ data });
});

// ─── Impersonation ────────────────────────────────────────────────────────────
// POST /api/admin/impersonate — body: { targetUserId }. A real, audited
// "log in as this user" capability for Trust & Safety debugging a live
// support issue ("my Escrow button is broken") without ever asking for a
// password. Every session writes a real platform_logs row BEFORE the
// elevated token is issued — this is deliberately not skippable. The
// issued JWT carries impersonatorId (see guard.js's verifyAccessToken),
// which (a) makes every subsequent API call during the session
// distinguishable from a real login in logs/metrics, and (b) is what
// guard.js checks on every single request to block any non-GET action for
// the rest of this session — see what they see, never act on their behalf.
// Deliberately short-lived (30 min, vs. the normal 7-day session) — a hard
// backstop even if nobody clicks "End Session."
export const impersonateUser = asyncHandler(async (req, res) => {
  const { targetUserId } = req.body ?? {};
  if (!targetUserId) throw ApiError.badRequest("targetUserId is required.");

  const target = await usersRepo.findById(targetUserId);
  if (!target) throw ApiError.notFound("User not found.");
  if (target.role === "admin") {
    throw ApiError.forbidden("Admin accounts can't be impersonated.");
  }

  await transaction(async (client) => {
    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: "IMPERSONATION_STARTED",
      targetUserId: target.id,
      notes: `Started impersonating ${target.name} (${target.role})`,
    });
  });

  const token = jwt.sign(
    { sub: target.id, role: target.role, impersonatorId: req.user.id },
    mustGetJwtSecret(),
    { expiresIn: "30m" }
  );

  const { password_hash, ...safeTarget } = target;
  res.json({ data: { token, user: safeTarget } });
});

function mustGetJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw ApiError.internal("JWT_SECRET is not configured on the server.");
  return secret;
}

// PATCH /api/admin/verify/:id — body: { approved: boolean }
// Approve sets users.is_verified (verified column); Reject leaves it false
// but still writes an audit row, so there's a record even though nothing
// about the user row itself changes. Both wrapped in a transaction with the
// platform_logs insert — a failed log write rolls back the verification too.
export const verifyUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { approved } = req.body ?? {};
  if (typeof approved !== "boolean") {
    throw ApiError.badRequest("Body must include { approved: boolean }.");
  }

  const result = await transaction(async (client) => {
    const user = await usersRepo.findById(id);
    if (!user) throw ApiError.notFound("User not found.");
    if (user.verified) throw ApiError.badRequest("User is already verified.");

    const updated = approved ? await adminRepo.setUserVerified(client, id, true) : user;

    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: approved ? "VERIFY_APPROVED" : "VERIFY_REJECTED",
      targetUserId: id,
      notes: approved ? `Approved verification for ${user.name}` : `Rejected verification for ${user.name}`,
    });

    return updated;
  });

  res.json({ data: result });
});

// ─── Escrow Oversight (KPI Engine) ────────────────────────────────────────────

// GET /api/admin/stats
export const getPlatformStats = asyncHandler(async (_req, res) => {
  const [stats, weeklyRevenue] = await Promise.all([adminRepo.getPlatformStats(), adminRepo.getWeeklyRevenue()]);
  res.json({ data: { ...stats, weeklyRevenue } });
});

// ─── Dispute Management ───────────────────────────────────────────────────────

// GET /api/admin/disputes
export const listDisputes = asyncHandler(async (_req, res) => {
  const data = await adminRepo.listDisputedProjects();
  res.json({ data });
});

// POST /api/admin/disputes/:id/resolve — body: { resolution: "refund" | "release" }
// The "Nuclear Options." Reuses the exact same ledger/wallet primitives as
// POST /api/projects/:id/complete (projects/transactions/users repos), plus
// a platform_logs row — all inside one transaction, so status + ledger +
// wallet + audit log commit together or not at all.
// Real Razorpay counterpart to completeProject/cancelAndRefund in
// projects.controller.js — reuses the exact same eligibility checks and
// razorpay.service.js calls, just triggered from a third place (a support
// agent's dispute decision instead of the normal completion/cancellation
// flow). This closes the gap where the admin panel used to be
// record-keeping-only: clicking "Refund" or "Release" here now actually
// moves the real money at Razorpay, not just this app's own ledger.
export const resolveDispute = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { resolution, note } = req.body ?? {};
  if (resolution !== "refund" && resolution !== "release" && resolution !== "split") {
    throw ApiError.badRequest('Body must include { resolution: "refund" | "release" | "split" }.');
  }

  const project = await projectsRepo.findById(id);
  if (!project) throw ApiError.notFound("Project not found.");
  if (project.status !== "DISPUTED") {
    throw ApiError.badRequest(`Cannot resolve a project in status ${project.status} — expected DISPUTED.`);
  }

  // Most real disputes aren't "one side gets everything" — some work
  // genuinely happened, just not all of it, or not to spec. workerAmount
  // is what the worker actually receives (already the final number admin
  // decided on, not subject to the standard worker_fee_pct deduction —
  // that fee model assumes a clean full completion, which a disputed
  // project by definition wasn't); businessRefundAmount is what goes back.
  // The two don't have to sum to the full budget — WorkBridge can retain
  // the gap as a facilitation fee on a split, same non-refundable-fee
  // principle cancelAndRefund/full-refund already apply — but can never
  // exceed it (that would be paying out money that was never collected).
  let workerAmount = 0;
  let businessRefundAmount = 0;
  if (resolution === "split") {
    workerAmount = Number(req.body.workerAmount);
    businessRefundAmount = Number(req.body.businessRefundAmount);
    if (!(workerAmount >= 0) || !(businessRefundAmount >= 0)) {
      throw ApiError.badRequest("workerAmount and businessRefundAmount must both be real numbers >= 0.");
    }
    if (workerAmount === 0 && businessRefundAmount === 0) {
      throw ApiError.badRequest("At least one of workerAmount or businessRefundAmount must be greater than 0.");
    }
    const budgetCheck = Number(project.budget);
    if (round2(workerAmount + businessRefundAmount) > budgetCheck) {
      throw ApiError.badRequest(`workerAmount + businessRefundAmount can't exceed the project budget (${formatAmount(budgetCheck)}).`);
    }
  }

  // Real Razorpay call, attempted OUTSIDE any DB lock — same reasoning as
  // both functions this mirrors. Neither branch touches Razorpay at all
  // if the project was funded through the manual bank-transfer fallback
  // (no razorpay_payment_id) — ledger-only, exactly as before this
  // integration existed.
  let refundId = null;
  let transferId = null;
  let payoutId = null;
  let settlementMethod = "WALLET";
  const budget = Number(project.budget);
  const workerFeePct = Number(project.worker_fee_pct ?? WORKER_FEE_PCT_FALLBACK);
  const fee = round2(budget * (workerFeePct / 100));
  const earnings = round2(budget - fee);

  if (resolution === "refund" && project.razorpay_order_id) {
    // Budget-only — the 8% business fee is retained as WorkBridge's
    // non-refundable facilitation fee, same policy as cancelAndRefund.
    // Cashfree's refund API is order-scoped (razorpay_order_id, the
    // reused column — see cashfree.service.js), not payment-scoped.
    const refund = await cashfreeService.createRefund({
      orderId: project.razorpay_order_id,
      refundId: `${project.id}_refund`,
      amountRupees: budget,
      note: "dispute_refund",
    });
    refundId = refund?.refund_id ?? null;
  } else if (resolution === "release") {
    const worker = await usersRepo.findById(project.worker_id);
    const routeEligible = Boolean(
      project.razorpay_payment_id && worker?.razorpay_account_id && worker.razorpay_account_status === "ACTIVE"
    );
    if (routeEligible) {
      try {
        const transfer = await razorpayService.createTransfer({
          paymentId: project.razorpay_payment_id,
          accountId: worker.razorpay_account_id,
          amountPaise: Math.round(earnings * 100),
          notes: { projectId: project.id, kind: "dispute_release" },
          idempotencyKey: `${project.id}:payout`,
        });
        transferId = transfer?.transfers?.[0]?.id ?? transfer?.id ?? null;
        settlementMethod = "RAZORPAY_ROUTE_AUTO";
      } catch (err) {
        settlementMethod = "WALLET_PENDING_MANUAL";
        console.error(`[razorpay] Route transfer failed for disputed project ${project.id}:`, err);
      }
    } else if (worker?.payout_method && worker?.payout_details) {
      // Same direct-RazorpayX fallback as completeProject — Route stays
      // blocked pending RBI review, so this is the real payout path today.
      try {
        const payout = await cashfreeService.createCashfreePayout({
          requestId: `${project.id}:payout`,
          amountRupees: earnings,
          payoutMethod: worker.payout_method,
          payoutDetails: worker.payout_details,
          worker,
        });
        payoutId = payout?.id ?? null;
        settlementMethod = "RAZORPAYX_PAYOUT";
      } catch (err) {
        settlementMethod = "WALLET_PENDING_MANUAL";
        console.error(`[cashfree] Payout failed for disputed project ${project.id}:`, err);
      }
    }
  } else if (resolution === "split") {
    // Both sides of a split independently, same real-call-outside-the-lock
    // shape as refund/release above. A split project was funded through
    // Checkout in every real case (nothing to refund otherwise), but the
    // manual-bank-transfer guard stays for consistency with the plain
    // refund branch above.
    if (businessRefundAmount > 0 && project.razorpay_order_id) {
      const refund = await cashfreeService.createRefund({
        orderId: project.razorpay_order_id,
        refundId: `${project.id}_refund`,
        amountRupees: businessRefundAmount,
        note: "dispute_split_refund",
      });
      refundId = refund?.refund_id ?? null;
    }
    if (workerAmount > 0) {
      const worker = await usersRepo.findById(project.worker_id);
      if (worker?.payout_method && worker?.payout_details) {
        try {
          const payout = await cashfreeService.createCashfreePayout({
            requestId: `${project.id}:payout`,
            amountRupees: workerAmount,
            payoutMethod: worker.payout_method,
            payoutDetails: worker.payout_details,
            worker,
          });
          payoutId = payout?.id ?? null;
          settlementMethod = "RAZORPAYX_PAYOUT";
        } catch (err) {
          settlementMethod = "WALLET_PENDING_MANUAL";
          console.error(`[cashfree] Split payout failed for disputed project ${project.id}:`, err);
        }
      } else {
        settlementMethod = "WALLET_PENDING_MANUAL";
      }
    }
  }

  const result = await transaction(async (client) => {
    // Re-locked, re-checked — the unlocked read above only decided
    // whether/how to call Razorpay; this is the real guard against a race.
    const locked = await projectsRepo.findByIdForUpdate(client, id);
    if (!locked) throw ApiError.notFound("Project not found.");
    if (locked.status !== "DISPUTED") {
      throw ApiError.badRequest(`Cannot resolve a project in status ${locked.status} — expected DISPUTED.`);
    }

    if (resolution === "refund") {
      // Nothing was ever paid out at DISPUTED (that only happens at
      // COMPLETED), so refunding just voids the hold — no wallet debit,
      // one REFUND ledger row for the audit trail.
      const updatedProject = await projectsRepo.updateStatus(id, "CANCELLED", client);
      if (refundId) await projectsRepo.setRazorpayRefund(client, id, refundId);

      const refundTxn = await transactionsRepo.insert(
        {
          projectId: id,
          workerId: project.worker_id,
          businessId: project.business_id,
          type: "REFUND",
          direction: "debit",
          amount: budget,
          fundsStatus: "REFUNDED",
          referenceNote: `Dispute resolved — refunded to business – ${project.title}`,
        },
        client
      );

      await adminRepo.insertPlatformLog(client, {
        adminId: req.user.id,
        action: "DISPUTE_REFUNDED",
        targetProjectId: id,
        notes: `Refunded ${formatAmount(budget)} to ${project.business_id}${refundId ? ` (Razorpay refund ${refundId})` : ""}${note ? ` — ${note}` : ""}`,
      });

      return { project: updatedProject, transaction: refundTxn };
    }

    if (resolution === "split") {
      // The project genuinely happened (partially) — COMPLETED, not
      // CANCELLED, matching "release"'s reasoning: some real settlement
      // occurred, this isn't a void.
      const updatedProject = await projectsRepo.updateStatus(id, "COMPLETED", client);
      if (refundId) await projectsRepo.setRazorpayRefund(client, id, refundId);
      if (transferId) await projectsRepo.setRazorpayTransfer(client, id, transferId);

      let refundTxn = null;
      let payoutTxn = null;
      if (businessRefundAmount > 0) {
        refundTxn = await transactionsRepo.insert(
          {
            projectId: id,
            workerId: project.worker_id,
            businessId: project.business_id,
            type: "REFUND",
            direction: "debit",
            amount: businessRefundAmount,
            fundsStatus: "REFUNDED",
            referenceNote: `Dispute split-resolved — ${formatAmount(businessRefundAmount)} refunded to business – ${project.title}`,
          },
          client
        );
      }
      if (workerAmount > 0) {
        payoutTxn = await transactionsRepo.insert(
          {
            projectId: id,
            workerId: project.worker_id,
            businessId: project.business_id,
            type: "PAYOUT",
            direction: "credit",
            amount: workerAmount,
            fundsStatus: "RELEASED",
            referenceNote: payoutId
              ? `Dispute split-resolved — ${formatAmount(workerAmount)} released to freelancer via Cashfree (${payoutId}) – ${project.title}`
              : `Dispute split-resolved — ${formatAmount(workerAmount)} released to freelancer – ${project.title}`,
            settlementMethod,
          },
          client
        );
        if (settlementMethod === "WALLET_PENDING_MANUAL") {
          await usersRepo.incrementWalletBalance(client, project.worker_id, workerAmount);
        }
      }

      await adminRepo.insertPlatformLog(client, {
        adminId: req.user.id,
        action: "DISPUTE_SPLIT",
        targetProjectId: id,
        notes: `Split resolution — ${formatAmount(workerAmount)} to worker, ${formatAmount(businessRefundAmount)} refunded to business${note ? ` — ${note}` : ""}`,
      });

      return { project: updatedProject, refund: refundTxn, payout: payoutTxn, workerAmount, businessRefundAmount, settlementMethod };
    }

    // resolution === "release" — identical math to completeProject.
    const updatedProject = await projectsRepo.updateStatus(id, "COMPLETED", client);
    if (transferId) await projectsRepo.setRazorpayTransfer(client, id, transferId);

    const payoutTxn = await transactionsRepo.insert(
      {
        projectId: id,
        workerId: project.worker_id,
        businessId: project.business_id,
        type: "PAYOUT",
        direction: "credit",
        amount: earnings,
        fundsStatus: "RELEASED",
        referenceNote: payoutId
          ? `Dispute resolved — released to freelancer via RazorpayX (${payoutId}) – ${project.title}`
          : `Dispute resolved — released to freelancer – ${project.title}`,
        settlementMethod,
      },
      client
    );
    await transactionsRepo.insert(
      {
        projectId: id,
        workerId: project.worker_id,
        businessId: project.business_id,
        type: "PLATFORM_FEE",
        direction: "debit",
        amount: fee,
        referenceNote: `Platform fee (${workerFeePct}%) – ${project.title}`,
      },
      client
    );
    if (settlementMethod !== "RAZORPAY_ROUTE_AUTO" && settlementMethod !== "RAZORPAYX_PAYOUT") {
      await usersRepo.incrementWalletBalance(client, project.worker_id, earnings);
    }

    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: "DISPUTE_RELEASED",
      targetProjectId: id,
      notes: `Released ${formatAmount(earnings)} to worker ${project.worker_id}${transferId ? ` (Razorpay transfer ${transferId})` : ""}${note ? ` — ${note}` : ""}`,
    });

    return { project: updatedProject, payout: payoutTxn, earnings, fee, settlementMethod };
  });

  res.json({ data: result });
});

// ─── Transaction History ──────────────────────────────────────────────────────

// GET /api/admin/transactions
export const listTransactions = asyncHandler(async (_req, res) => {
  const data = await adminRepo.listAllInvoices();
  res.json({ data });
});

// GET /api/admin/manual-payouts — the "who do I owe money to" queue.
export const listManualPayouts = asyncHandler(async (_req, res) => {
  const data = await adminRepo.listPendingManualPayouts();
  res.json({ data });
});

// POST /api/admin/manual-payouts/:id/complete — body: { note? }.
export const completeManualPayout = asyncHandler(async (req, res) => {
  const updated = await adminRepo.completeManualPayout(req.params.id, req.body?.note);
  if (!updated) throw ApiError.notFound("Pending manual payout not found (or already marked complete).");
  res.json({ data: updated });
});

// ─── Fund Releases ─────────────────────────────────────────────────────────
// GET /api/admin/pending-releases — the queue behind the "Approve &
// Release" button: a business's click only requests a release (see
// requestRelease in projects.controller.js); staff complete the actual
// payout by calling POST /api/projects/:id/complete (now admin-only),
// reusing that same endpoint rather than duplicating its ledger logic here.
export const listPendingReleases = asyncHandler(async (_req, res) => {
  const data = await adminRepo.listPendingReleases();
  res.json({ data });
});

// ─── Withdrawals ────────────────────────────────────────────────────────────
// GET /api/admin/withdrawals — the queue behind a worker's "Withdraw Funds"
// request (see wallet.controller.js's withdraw): wallet_balance is already
// debited by the time a request lands here, but no real UPI/bank transfer
// has happened yet.
export const listPendingWithdrawals = asyncHandler(async (_req, res) => {
  const data = await withdrawalRequestsRepo.listPending();
  res.json({ data });
});

// POST /api/admin/withdrawals/:id/resolve — body: { approved: boolean, note? }
// approved: staff actually sent the money — write the real transactions.
// WITHDRAWAL row now (this is the only place that row is ever created).
// !approved: staff couldn't complete it (bad UPI id, bank rejected it,
// etc.) — refund wallet_balance so the worker isn't out that money for a
// transfer that never happened.
export const resolveWithdrawal = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { approved, note } = req.body ?? {};
  if (typeof approved !== "boolean") {
    throw ApiError.badRequest("Body must include { approved: boolean }.");
  }

  let razorpayPayout = null;
  if (approved) {
    const request = await withdrawalRequestsRepo.findById(id);
    if (!request) throw ApiError.notFound("Withdrawal request not found.");
    if (request.status !== "PENDING") throw ApiError.badRequest(`Cannot resolve a withdrawal request in status ${request.status} — expected PENDING.`);
    const worker = await usersRepo.findById(request.worker_id);
    if (!worker) throw ApiError.notFound("Worker not found.");
    razorpayPayout = await cashfreeService.createCashfreePayout({
      requestId: id,
      amountRupees: request.amount,
      payoutMethod: request.payout_method,
      payoutDetails: request.payout_details,
      worker,
    });
  }

  const result = await transaction(async (client) => {
    const request = await withdrawalRequestsRepo.findByIdForUpdate(client, id);
    if (!request) throw ApiError.notFound("Withdrawal request not found.");
    if (request.status !== "PENDING") {
      throw ApiError.badRequest(`Cannot resolve a withdrawal request in status ${request.status} — expected PENDING.`);
    }

    const updatedRequest = await withdrawalRequestsRepo.markResolved(client, id, {
      status: approved ? "APPROVED" : "REJECTED",
      adminNote: note,
      resolvedBy: req.user.id,
      payoutId: razorpayPayout?.id,
    });

    if (approved) {
      const txn = await transactionsRepo.insert(
        {
          projectId: null,
          businessId: null,
          workerId: request.worker_id,
          type: "WITHDRAWAL",
          direction: "debit",
          amount: Number(request.amount),
          referenceNote: `Withdrawal to ${request.payout_details}`,
        },
        client
      );

      await adminRepo.insertPlatformLog(client, {
        adminId: req.user.id,
        action: "WITHDRAWAL_APPROVED",
        targetUserId: request.worker_id,
        notes: `Sent ${formatAmount(request.amount)} via ${request.payout_method} to ${request.payout_details}`,
      });

      return { request: updatedRequest, transaction: txn };
    }

    // Rejected — the withdrawn amount never actually left WorkBridge, so it
    // goes back into the worker's spendable balance.
    await usersRepo.incrementWalletBalance(client, request.worker_id, Number(request.amount));

    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: "WITHDRAWAL_REJECTED",
      targetUserId: request.worker_id,
      notes: note || `Refunded ${formatAmount(request.amount)} — withdrawal could not be completed`,
    });

    return { request: updatedRequest };
  });

  res.json({ data: result });
});

function formatAmount(n) {
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

// ─── Escrow Funding ─────────────────────────────────────────────────────────
// The queue behind a business's "Fund Escrow" submission (see
// projects.controller.js's fundEscrow) — the project is already sitting in
// PENDING_FUNDS, but no FUNDS_SECURED ledger row exists yet. Only a
// verified transfer (staff actually checking the UTR/screenshot) creates
// one — same "self-reported request, real WorkBridge action grants it"
// shape as withdrawals above.
export const listPendingEscrowFunding = asyncHandler(async (_req, res) => {
  const data = await escrowFundingRepo.listPending();
  res.json({ data });
});

// POST /api/admin/escrow-funding/:id/resolve — body: { approved: boolean, note? }
// approved: staff confirmed the transfer actually landed — the project
// moves PENDING_FUNDS -> FUNDS_SECURED and the real FUNDS_SECURED ledger
// row is written NOW (not at submission time, since submission is only an
// unverified claim until this point).
// !approved: staff couldn't verify it (UTR doesn't match, screenshot
// doesn't check out, etc.) — the project reverts to ACCEPTED so the
// business can submit a corrected transfer.
export const resolveEscrowFunding = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { approved, note } = req.body ?? {};
  if (typeof approved !== "boolean") {
    throw ApiError.badRequest("Body must include { approved: boolean }.");
  }

  const result = await transaction(async (client) => {
    const request = await escrowFundingRepo.findByIdForUpdate(client, id);
    if (!request) throw ApiError.notFound("Escrow funding request not found.");
    if (request.status !== "PENDING") {
      throw ApiError.badRequest(`Cannot resolve an escrow funding request in status ${request.status} — expected PENDING.`);
    }

    const project = await projectsRepo.findByIdForUpdate(client, request.project_id);
    if (!project) throw ApiError.notFound("Project not found.");
    if (project.status !== "PENDING_FUNDS") {
      throw ApiError.badRequest(`Cannot resolve — project is in status ${project.status}, expected PENDING_FUNDS.`);
    }

    const updatedRequest = await escrowFundingRepo.markResolved(client, id, {
      status: approved ? "APPROVED" : "REJECTED",
      adminNote: note,
      resolvedBy: req.user.id,
    });

    const updatedProject = await projectsRepo.updateStatus(
      request.project_id,
      approved ? "FUNDS_SECURED" : "ACCEPTED",
      client
    );

    let txn = null;
    if (approved) {
      txn = await transactionsRepo.insert(
        {
          projectId: request.project_id,
          workerId: project.worker_id,
          businessId: project.business_id,
          type: "FUNDS_SECURED",
          direction: "debit",
          amount: Number(request.amount),
          fundsStatus: "HELD",
          referenceNote: `Funds secured (verified transfer, UTR ${request.utr_reference}) – ${project.title}`,
        },
        client
      );

      await adminRepo.insertPlatformLog(client, {
        adminId: req.user.id,
        action: "ESCROW_FUNDING_APPROVED",
        targetProjectId: request.project_id,
        notes: `Verified ${formatAmount(request.amount)} transfer (UTR: ${request.utr_reference}) for "${project.title}"`,
      });
    } else {
      await adminRepo.insertPlatformLog(client, {
        adminId: req.user.id,
        action: "ESCROW_FUNDING_REJECTED",
        targetProjectId: request.project_id,
        notes: note || `Could not verify transfer (UTR: ${request.utr_reference}) for "${project.title}"`,
      });
    }

    return { request: updatedRequest, project: updatedProject, transaction: txn };
  });

  emitProjectEvent(result.project, "STATUS_CHANGED", {
    status: result.project.status,
    actorRole: "admin",
  });

  // High-value event #2 (see sms.service.js) — deliberately gated on
  // `approved`, not on this endpoint being called at all: a rejected
  // funding request means the money isn't actually secured, so the worker
  // shouldn't be told it is. This fires here (real WorkBridge staff
  // verification), never at the business's initial fundEscrow submission —
  // that only reaches PENDING_FUNDS, unverified.
  if (approved && result.project.worker_id) {
    const worker = await usersRepo.findById(result.project.worker_id);
    if (worker?.phone) {
      sendEscrowFundedSms(worker.phone, {
        project_title: result.project.title,
        amount: Number(result.request.amount),
      }).catch((err) => console.error("[sms] sendEscrowFundedSms threw:", err));
    }
  }

  res.json({ data: result });
});

// ─── Profile Audits ─────────────────────────────────────────────────────────
// The real queue behind a worker's "Skill Bridge Profile Audit" perk
// purchase (see perks.controller.js's purchasePerk) — same "self-reported
// request, real WorkBridge action grants it" shape as Escrow Funding /
// Withdrawals above, except the real outcome is a written review, not an
// approve/reject decision.
export const listPendingAudits = asyncHandler(async (_req, res) => {
  const data = await profileAuditRepo.listPending();
  res.json({ data });
});

// PATCH /api/admin/audits/:id — body: { note: string }
export const resolveAudit = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { note } = req.body ?? {};
  if (!note || !note.trim()) {
    throw ApiError.badRequest("A written note is required to resolve an audit request.");
  }

  const result = await transaction(async (client) => {
    const request = await profileAuditRepo.findByIdForUpdate(client, id);
    if (!request) throw ApiError.notFound("Audit request not found.");
    if (request.status !== "PENDING") {
      throw ApiError.badRequest(`Cannot resolve an audit request in status ${request.status} — expected PENDING.`);
    }
    return profileAuditRepo.markReviewed(client, id, { adminNote: note.trim(), resolvedBy: req.user.id });
  });

  res.json({ data: result });
});

// ─── Security Monitor ─────────────────────────────────────────────────────────
// Reviews blocked_message_attempts (messages.controller.js writes one every
// time containsContactInfo rejects a send) — the actual message content is
// never stored anywhere else, so this queue is the only record of it.

// GET /api/admin/blocked-attempts
export const listBlockedAttempts = asyncHandler(async (_req, res) => {
  const data = await blockedAttemptsRepo.listPending();
  res.json({ data });
});

// GET /api/admin/messages?search=... — the message monitor. Separate from
// blocked-attempts: this searches every real message ever sent, so support
// can proactively catch contact-info shares the filter's regex misses
// (evasion tricks like commas/odd spacing between digits), not just the
// ones that got auto-blocked.
export const searchMessages = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const data = await adminRepo.searchMessages({ search });
  res.json({ data });
});

// GET /api/admin/messages/businesses — Message Monitor's "Cascading
// Workspace" left column.
export const listMonitoredBusinesses = asyncHandler(async (_req, res) => {
  const data = await adminRepo.listMonitoredBusinesses();
  res.json({ data });
});

// GET /api/admin/messages/businesses/:businessId/workers — middle column.
export const listWorkersForBusiness = asyncHandler(async (req, res) => {
  const data = await adminRepo.listWorkersForBusiness(req.params.businessId);
  res.json({ data });
});

// PATCH /api/admin/users/:id/moderate — the Cascading Workspace's top-bar
// actions (Warn/Deduct/Ban/Unban) on a selected worker/business, independent
// of any single message. Same real effects and same admin-immunity guard as
// moderateMessageSender below; kept separate because there's no message row
// to anchor the log note to here — projectId/note are optional context.
// body: { action: "ban" | "unban" | "warn" | "deduct_points", points?, projectId?, note? }
export const moderateUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action, points, projectId, note } = req.body ?? {};

  const target = await usersRepo.findById(id);
  if (!target) throw ApiError.notFound("User not found.");

  if (action === "ban" || action === "unban" || action === "ban_chat" || action === "unban_chat") {
    await assertAdminPermission(req, "can_ban_users", "Your admin account doesn't have ban rights — ask a super admin to grant them from Team Access.");
  }

  let logAction;
  let logNotes;
  let noticeMessage = null;

  const result = await transaction(async (client) => {
    let updated = target;

    if (action === "ban") {
      if (target.role === "admin") {
        throw ApiError.badRequest("Admin accounts can't be banned from Message Monitor.");
      }
      updated = await usersRepo.setActive(client, target.id, false);
      logAction = "SECURITY_USER_BANNED";
      logNotes = note || `Banned ${target.name} from Message Monitor.`;
    } else if (action === "unban") {
      updated = await usersRepo.setActive(client, target.id, true);
      logAction = "SECURITY_USER_UNBANNED";
      logNotes = note || `Unbanned ${target.name} from Message Monitor.`;
    } else if (action === "ban_chat") {
      // The Dual-Ban Moderation Engine's softer tier — locks their chat
      // composer (messages.controller.js's assertNotChatBanned) without
      // touching login, submissions, or escrow payouts, so a business's
      // funds never get trapped mid-project over a chat-only violation.
      if (target.role === "admin") {
        throw ApiError.badRequest("Admin accounts can't be chat-banned.");
      }
      updated = await usersRepo.setChatBanned(client, target.id, true);
      logAction = "SECURITY_CHAT_BANNED";
      logNotes = note || `Chat-banned ${target.name} from Message Monitor — deliverables and payouts are unaffected.`;
    } else if (action === "unban_chat") {
      updated = await usersRepo.setChatBanned(client, target.id, false);
      logAction = "SECURITY_CHAT_UNBANNED";
      logNotes = note || `Restored chat privileges for ${target.name}.`;
    } else if (action === "warn") {
      // A real, permanent message in the project's own chat — both sides
      // see it, and it stays in the transcript as proof they were told,
      // so a later ban can't be met with "I didn't know the rules."
      if (!projectId) {
        throw ApiError.badRequest("projectId is required to warn a user — the warning is delivered in that project's chat.");
      }
      const warnedProject = await projectsRepo.findById(projectId, client);
      if (!warnedProject) throw ApiError.notFound("Project not found.");
      const noticeText =
        note ||
        `Admin Warning: sharing phone numbers, email addresses, or other contact details in chat is not allowed on WorkBridge. This is a formal warning — continued violations may result in account suspension.`;
      const warningThread = warnedProject.worker_id
        ? await threadsRepo.getOrCreateThread(warnedProject.business_id, warnedProject.worker_id, client)
        : null;
      noticeMessage = await messagesRepo.createSystemNotice(client, {
        threadId: warningThread?.id ?? null,
        projectId,
        adminId: req.user.id,
        body: noticeText,
      });
      logAction = "SECURITY_WARNING_SENT";
      logNotes = `Warned ${target.name} from Message Monitor: "${noticeText}"`;
    } else if (action === "deduct_points") {
      if (target.role === "admin") {
        throw ApiError.badRequest("Admin accounts don't have a behavior score.");
      }
      const amount = Number(points);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw ApiError.badRequest("points must be a positive number.");
      }
      updated = await usersRepo.adjustBehaviorScore(client, target.id, -amount);
      logAction = "SECURITY_POINTS_DEDUCTED";
      logNotes = note || `Deducted ${amount} behavior score points from ${target.name}.`;
    } else {
      throw ApiError.badRequest("action must be one of: ban, unban, ban_chat, unban_chat, warn, deduct_points.");
    }

    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: logAction,
      targetUserId: target.id,
      targetProjectId: projectId || null,
      notes: logNotes,
    });

    return updated;
  });

  // The warning needs to show up live for whoever has that project's chat
  // open right now, not just on their next reload — same event ChatThread
  // already listens for (MESSAGE_CREATED).
  if (noticeMessage) {
    const project = await projectsRepo.findById(projectId);
    if (project) {
      emitProjectEvent(project, "MESSAGE_CREATED", { messageId: noticeMessage.id, senderId: req.user.id });
    }
  }

  res.json({ data: result });
});

// PATCH /api/admin/users/:id/permissions — a full admin (one whose own
// can_ban_users and can_release_funds are both still true) dials another
// admin's account down to a Support-tier subset, or restores it. This is
// the real backend behind the Team Access "Ban Users"/"Force Release
// Escrow" toggles — previously that whole screen was local mock state (see
// AdminTeamTab.jsx) with nothing behind it.
// body: { canBanUsers?: boolean, canReleaseFunds?: boolean }
export const updateAdminPermissions = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { canBanUsers, canReleaseFunds } = req.body ?? {};

  const actingAdmin = await usersRepo.findById(req.user.id);
  if (!actingAdmin || actingAdmin.can_ban_users === false || actingAdmin.can_release_funds === false) {
    throw ApiError.forbidden("Only a full admin account can manage another admin's permissions.");
  }

  const target = await usersRepo.findById(id);
  if (!target) throw ApiError.notFound("User not found.");
  if (target.role !== "admin") {
    throw ApiError.badRequest("Permissions only apply to admin accounts.");
  }
  if (target.id === req.user.id) {
    throw ApiError.badRequest("You can't change your own permissions.");
  }

  const result = await transaction(async (client) => {
    const updated = await usersRepo.setAdminPermissions(client, target.id, { canBanUsers, canReleaseFunds });
    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: "PERMISSIONS_UPDATED",
      targetUserId: target.id,
      targetProjectId: null,
      notes: `Updated permissions for ${target.name} — can_ban_users: ${updated.can_ban_users}, can_release_funds: ${updated.can_release_funds}.`,
    });
    return updated;
  });

  res.json({ data: result });
});

// GET /api/admin/team — the real Team Access roster. Previously
// AdminTeamTab.jsx never called any endpoint at all — every admin here (add,
// remove, permissions) was local-only mock state with a toast claiming
// success. Permissions already had a real endpoint (updateAdminPermissions
// above); this + addTeamMember/removeTeamMember below are what makes the
// rest of that screen real too.
export const listTeam = asyncHandler(async (_req, res) => {
  const data = await usersRepo.listAdmins();
  res.json({ data });
});

// A "Super Admin" in the UI is just the full-permission state
// (can_ban_users && can_release_funds both true, the default for every new
// admin) — there's no separate role value for it in the DB.
function isSuperAdmin(user) {
  return Boolean(user?.can_ban_users && user?.can_release_funds);
}

// POST /api/admin/team — body: { name, email, password, canBanUsers?,
// canReleaseFunds? }. Only a full admin (super admin) can provision another
// admin account — same gate updateAdminPermissions already uses, so someone
// dialed down to a Support-tier subset can't create fresh full-access
// accounts for themselves. Reuses create-admin.js's own validation/insert
// shape (the CLI script stays as the zero-dependency bootstrap path for
// standing up the very first admin; this is the real one for every admin
// after that).
export const addTeamMember = asyncHandler(async (req, res) => {
  const actingAdmin = await usersRepo.findById(req.user.id);
  if (!isSuperAdmin(actingAdmin)) {
    throw ApiError.forbidden("Only a Super Admin can add a new team member.");
  }

  const { name, email, password, phone, canBanUsers = true, canReleaseFunds = true } = req.body ?? {};
  if (!name || !String(name).trim()) throw ApiError.badRequest("Name is required.");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw ApiError.badRequest("A valid email is required.");
  if (!password || String(password).length < 8) throw ApiError.badRequest("Password must be at least 8 characters.");

  const existing = await usersRepo.findByEmail(email);
  if (existing) throw ApiError.badRequest(`An account with email ${email} already exists.`);

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await transaction(async (client) => {
    const created = await usersRepo.insertAdmin(client, {
      name: String(name).trim(),
      email,
      passwordHash,
      phone,
      canBanUsers: Boolean(canBanUsers),
      canReleaseFunds: Boolean(canReleaseFunds),
    });
    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: "ADMIN_ADDED",
      targetUserId: created.id,
      targetProjectId: null,
      notes: `Added ${created.name} <${created.email}> to the admin team${isSuperAdmin(created) ? " as a Super Admin" : ""}.`,
    });
    return created;
  });

  res.status(201).json({ data: result });
});

// DELETE /api/admin/team/:id — deactivates an admin account (same
// users.is_active mechanism Security Monitor's Ban User uses — reversible
// by direct DB access, not a hard delete that would orphan their
// platform_logs/resolved-disputes history). Three real guards: only a Super
// Admin can remove anyone; a Super Admin can never remove another Super
// Admin (per product decision — one full-access admin going rogue or
// getting phished can't unilaterally take out the rest of the team; that
// needs a deliberate permissions dial-down first via updateAdminPermissions,
// which itself requires the target to no longer be full-access); and nobody
// can remove themselves (use Settings, not this).
export const removeTeamMember = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const actingAdmin = await usersRepo.findById(req.user.id);
  if (!isSuperAdmin(actingAdmin)) {
    throw ApiError.forbidden("Only a Super Admin can remove a team member.");
  }
  if (id === req.user.id) {
    throw ApiError.badRequest("You can't remove your own account.");
  }

  const target = await usersRepo.findById(id);
  if (!target || target.role !== "admin") throw ApiError.notFound("Admin not found.");
  if (isSuperAdmin(target)) {
    throw ApiError.forbidden("A Super Admin can't remove another Super Admin — dial down their permissions first.");
  }

  const result = await transaction(async (client) => {
    const updated = await usersRepo.setAdminActive(client, id, false);
    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: "ADMIN_REMOVED",
      targetUserId: id,
      targetProjectId: null,
      notes: `Removed ${target.name} <${target.email}> from the admin team.`,
    });
    return updated;
  });

  res.json({ data: result });
});

// PATCH /api/admin/messages/:id/moderate — Message Monitor's manual
// counterpart to blocked-attempts' resolution actions: support found a real
// contact-info share (or other bad behavior) that evaded the auto-filter
// and is acting on the sender directly off that message.
// body: { action: "ban" | "unban" | "warn" | "deduct_points", points? }
export const moderateMessageSender = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action, points } = req.body ?? {};

  const message = await messagesRepo.findById(id);
  if (!message) throw ApiError.notFound("Message not found.");

  const target = await usersRepo.findById(message.sender_id);
  if (!target) throw ApiError.notFound("Sender not found.");

  if (action === "ban" || action === "unban") {
    await assertAdminPermission(req, "can_ban_users", "Your admin account doesn't have ban rights — ask a super admin to grant them from Team Access.");
  }

  let logAction;
  let logNotes;

  const result = await transaction(async (client) => {
    let updated = target;

    if (action === "ban") {
      if (target.role === "admin") {
        throw ApiError.badRequest("Admin accounts can't be banned from Message Monitor.");
      }
      updated = await usersRepo.setActive(client, target.id, false);
      logAction = "SECURITY_USER_BANNED";
      logNotes = `Banned ${target.name} from Message Monitor for: "${message.body}"`;
    } else if (action === "unban") {
      updated = await usersRepo.setActive(client, target.id, true);
      logAction = "SECURITY_USER_UNBANNED";
      logNotes = `Unbanned ${target.name} from Message Monitor (message: "${message.body}")`;
    } else if (action === "ban_chat") {
      if (target.role === "admin") {
        throw ApiError.badRequest("Admin accounts can't be chat-banned.");
      }
      updated = await usersRepo.setChatBanned(client, target.id, true);
      logAction = "SECURITY_CHAT_BANNED";
      logNotes = `Chat-banned ${target.name} from Message Monitor for: "${message.body}"`;
    } else if (action === "unban_chat") {
      updated = await usersRepo.setChatBanned(client, target.id, false);
      logAction = "SECURITY_CHAT_UNBANNED";
      logNotes = `Restored chat privileges for ${target.name} (message: "${message.body}")`;
    } else if (action === "warn") {
      logAction = "SECURITY_WARNING_SENT";
      logNotes = `Warned ${target.name} from Message Monitor for: "${message.body}"`;
    } else if (action === "deduct_points") {
      if (target.role === "admin") {
        throw ApiError.badRequest("Admin accounts don't have a behavior score.");
      }
      const amount = Number(points);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw ApiError.badRequest("points must be a positive number.");
      }
      updated = await usersRepo.adjustBehaviorScore(client, target.id, -amount);
      logAction = "SECURITY_POINTS_DEDUCTED";
      logNotes = `Deducted ${amount} behavior score points from ${target.name} for: "${message.body}"`;
    } else {
      throw ApiError.badRequest("action must be one of: ban, unban, ban_chat, unban_chat, warn, deduct_points.");
    }

    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: logAction,
      targetUserId: target.id,
      targetProjectId: message.project_id,
      notes: logNotes,
    });

    return updated;
  });

  res.json({ data: result });
});

// PATCH /api/admin/blocked-attempts/:id — body: { action, editedBody?, note? }
// action: "redact_and_send" (creates a real message with the admin's cleaned
// text, on the original sender's behalf) | "ban" (real — sets
// users.is_active false, enforced by guard.js/auth.controller.js) | "warn" |
// "dismiss" (both log-only — no notification system exists to actually
// deliver a warning yet).
export const resolveBlockedAttempt = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action, editedBody, note } = req.body;

  const attempt = await blockedAttemptsRepo.findById(id);
  if (!attempt) throw ApiError.notFound("Blocked attempt not found.");
  if (attempt.status !== "PENDING") {
    throw ApiError.badRequest(`This was already resolved (${attempt.status}).`);
  }

  if (action === "ban") {
    await assertAdminPermission(req, "can_ban_users", "Your admin account doesn't have ban rights — ask a super admin to grant them from Team Access.");
  }

  let sentMessage = null;

  const result = await transaction(async (client) => {
    let status;
    let logAction;
    let logNotes;

    if (action === "redact_and_send") {
      if (!editedBody || !editedBody.trim()) {
        throw ApiError.badRequest("editedBody is required to redact and send.");
      }
      if (containsContactInfo(editedBody)) {
        throw ApiError.badRequest("The edited message still contains contact info — remove it before sending.");
      }
      sentMessage = await messagesRepo.create({
        threadId: attempt.thread_id,
        projectId: attempt.project_id,
        senderId: attempt.sender_id,
        body: editedBody.trim(),
      });
      status = "REDACTED_AND_SENT";
      logAction = "SECURITY_REDACTED_AND_SENT";
      logNotes = `Redacted and forwarded a blocked message on project ${attempt.project_id}`;
    } else if (action === "ban") {
      const target = await usersRepo.findById(attempt.sender_id);
      if (target?.role === "admin") {
        throw ApiError.badRequest("Admin accounts can't be banned from Security Monitor.");
      }
      await usersRepo.setActive(client, attempt.sender_id, false);
      status = "BANNED";
      logAction = "SECURITY_USER_BANNED";
      logNotes = `Banned ${attempt.sender_name} for a blocked contact-info attempt`;
    } else if (action === "warn") {
      status = "WARNED";
      logAction = "SECURITY_WARNING_SENT";
      logNotes = `Warned ${attempt.sender_name} for a blocked contact-info attempt`;
    } else if (action === "dismiss") {
      status = "DISMISSED";
      logAction = "SECURITY_DISMISSED";
      logNotes = "Dismissed a blocked contact-info attempt as a false alarm";
    } else {
      throw ApiError.badRequest("action must be one of: redact_and_send, ban, warn, dismiss.");
    }

    const resolved = await blockedAttemptsRepo.resolve(client, id, {
      status,
      resolvedBy: req.user.id,
      resolutionNote: note,
    });

    await adminRepo.insertPlatformLog(client, {
      adminId: req.user.id,
      action: logAction,
      targetUserId: attempt.sender_id,
      targetProjectId: attempt.project_id,
      notes: logNotes,
    });

    return resolved;
  });

  // Only redact_and_send creates something the sender's own chat needs to
  // see live — ban/warn/dismiss have no realtime-visible side effect for
  // either participant.
  if (sentMessage) {
    const project = await projectsRepo.findById(attempt.project_id);
    if (project) {
      emitProjectEvent(project, "MESSAGE_CREATED", { messageId: sentMessage.id, senderId: attempt.sender_id });
    }
  }

  res.json({ data: result });
});
