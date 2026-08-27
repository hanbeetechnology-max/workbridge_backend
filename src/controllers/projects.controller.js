import { transaction } from "../db/client.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { canTransition } from "../domain/projectStatus.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import * as transactionsRepo from "../repositories/transactions.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as ledgerEventsRepo from "../repositories/ledger_events.repository.js";
import * as escrowFundingRepo from "../repositories/escrow_funding_requests.repository.js";
import * as threadsRepo from "../repositories/threads.repository.js";
import * as perkPurchasesRepo from "../repositories/perk_purchases.repository.js";
import { emitProjectEvent, emitBroadcast } from "../realtime/events.js";
import { calculateLevel } from "../utils/gamification.js";
import { sendHiredSms } from "../services/sms.service.js";
import * as razorpayService from "../services/razorpay.service.js";
import * as cashfreeService from "../services/cashfree.service.js";

// The first real token-earning trigger — MASTER_ECONOMY_PLAN.md's Ledger
// Tokens (Bridge Tokens) had a column since migration 012 but nothing ever
// credited any; every real account's balance was permanently 0 until this.
const COMPLETION_TOKEN_REWARD = 25;

// The business-side counterpart — first real trigger for a business's own
// Corporate Credits/XP track, previously also permanently 0 for every
// account (see migration 012's note that the business-side Ledger was "a
// later phase, not modeled here yet").
const BUSINESS_COMPLETION_XP_REWARD = 30;
const BUSINESS_COMPLETION_TOKEN_REWARD = 15;

// schema.sql's projects.business_fee_pct/worker_fee_pct defaults — the
// disclosed split that replaced the old flat platform_fee_pct (still on
// the table for historical rows, no longer read by any code path below).
const BUSINESS_FEE_PCT_FALLBACK = 8;
const WORKER_FEE_PCT_FALLBACK = 7;

// GET /api/projects — list projects the caller participates in. "?role=" is
// optional (defaults to both); a caller can never list someone else's
// projects by passing an arbitrary businessId/workerId — those are always
// derived from req.user, not the query string.
export const listProjects = asyncHandler(async (req, res) => {
  const { status, role, page, pageSize } = req.query;

  const filters = { status, page, pageSize, viewerId: req.user.id };
  if (role === "worker" || req.user.role === "worker") filters.workerId = req.user.id;
  if (role === "business" || req.user.role === "business") filters.businessId = req.user.id;
  // Admins with no ?role filter see everything (no workerId/businessId
  // constraint added) — enforce that only admins get this unfiltered view.
  if (req.user.role !== "admin" && !filters.workerId && !filters.businessId) {
    throw ApiError.forbidden("Specify ?role=worker or ?role=business.");
  }

  const projects = await projectsRepo.list(filters);
  res.json({ data: projects, page, pageSize });
});

// GET /api/projects/:id — a single project, joined to both participants'
// public profiles. Only a participant (or admin) may fetch it — same
// participant check as updateProjectStatus.
export const getProject = asyncHandler(async (req, res) => {
  const project = await projectsRepo.findByIdJoined(req.params.id);
  if (!project) throw ApiError.notFound("Project not found.");

  const isParticipant = project.worker_id === req.user.id || project.business_id === req.user.id;
  if (!isParticipant && req.user.role !== "admin") {
    throw ApiError.forbidden("You are not a participant on this project.");
  }

  res.json({ data: project });
});

// GET /api/projects/open — the Job Board feed. Any authenticated worker can
// browse every OPEN, unassigned post — unlike listProjects above, this is
// deliberately NOT scoped to "projects I participate in." The viewer's real
// current_level is looked up here (req.user off the JWT only carries
// {id, role}) so listOpen can decide real Urgent Matching visibility.
export const listOpenProjects = asyncHandler(async (req, res) => {
  const viewer = await usersRepo.findById(req.user.id);
  const projects = await projectsRepo.listOpen(viewer?.current_level ?? 0);
  res.json({ data: projects });
});

// GET /api/projects/featured-employers — the real effect of the "Featured
// Employer Spotlight" perk: businesses with an active, unconsumed purchase,
// scoped to their currently-open posts. Sits next to listOpenProjects since
// it feeds the same Job Board page.
export const listFeaturedEmployers = asyncHandler(async (_req, res) => {
  const employers = await usersRepo.listFeaturedEmployers();
  res.json({ data: employers });
});

// GET /api/projects/:id/shortlist — real effect of the "AI Shortlist"
// perk. "AI" here is a real, deterministic ranking (skill overlap between
// the post's required_skills and each worker's profile.skills, rating as
// the tiebreak), not a fabricated result — same "real data, simple honest
// algorithm" boundary as everywhere else on this platform. Requires an
// active, unconsumed purchase targeting this exact project; the single-use
// tier is spent the moment the shortlist is actually generated.
export const getProjectShortlist = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const project = await projectsRepo.findById(id);
  if (!project) throw ApiError.notFound("Project not found.");
  if (project.business_id !== req.user.id) throw ApiError.forbidden("Not your job post.");

  const purchase = await perkPurchasesRepo.findActive(req.user.id, "ai-shortlist", { targetId: id });
  if (!purchase) throw ApiError.badRequest("Purchase AI Shortlist for this job post first.");

  const workers = await usersRepo.listPublicProfiles({ role: "worker" });
  const requiredSkills = (project.required_skills ?? []).map((s) => s.toLowerCase());
  const shortlist = workers
    .map((w) => {
      const workerSkills = (w.profile?.skills ?? []).map((s) => String(s).toLowerCase());
      const matchScore = requiredSkills.filter((s) => workerSkills.includes(s)).length;
      return { ...w, matchScore };
    })
    .sort((a, b) => b.matchScore - a.matchScore || (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 3);

  if (purchase.tier_id === "single-use") {
    await transaction((client) => perkPurchasesRepo.consume(client, purchase.id));
  }

  res.json({ data: shortlist });
});

// POST /api/projects/:id/broadcast — real effect of the "Enterprise
// Broadcast" perk: a real push + in-app notification (emitBroadcast) sent
// to the platform's top-rated workers, pointing at this exact job post.
// One-time — always consumed once it actually sends.
export const broadcastProject = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const project = await projectsRepo.findById(id);
  if (!project) throw ApiError.notFound("Project not found.");
  if (project.business_id !== req.user.id) throw ApiError.forbidden("Not your job post.");
  if (project.status !== "OPEN") throw ApiError.badRequest("This job post is no longer open.");

  const purchase = await perkPurchasesRepo.findActive(req.user.id, "enterprise-broadcast", { targetId: id });
  if (!purchase) throw ApiError.badRequest("Purchase Enterprise Broadcast for this job post first.");

  const workers = await usersRepo.listPublicProfiles({ role: "worker" });
  const recipients = workers.slice(0, 25);
  emitBroadcast(
    recipients.map((w) => w.id),
    { title: "New job matching top talent", body: `${project.title} was just broadcast to you — check it out on the Job Feed.`, url: "/worker" }
  );

  await transaction((client) => perkPurchasesRepo.consume(client, purchase.id));

  res.json({ data: { notified: recipients.length } });
});

// applicationWindow is now a plain number of days the business chose on
// the Post Job form — resolved to a real future timestamp here, once, so
// there's a single source of truth for the "now + N days" math instead of
// the frontend and backend each computing it independently.
const MIN_APPLICATION_WINDOW_DAYS = 1;
const MAX_APPLICATION_WINDOW_DAYS = 90;

function resolveApplicationDeadline(applicationWindowDays) {
  const days = Number(applicationWindowDays);
  if (!Number.isFinite(days) || days < MIN_APPLICATION_WINDOW_DAYS || days > MAX_APPLICATION_WINDOW_DAYS) {
    return null;
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// POST /api/projects — a business creates a new project. Only a
// business may call this (enforced by requireRole("business") in the
// router) — the caller becomes businessId, never a client-supplied value.
// Omitting workerId posts an OPEN job board listing; passing one keeps the
// original direct-invite behavior (project starts INVITED).
export const createProject = asyncHandler(async (req, res) => {
  const project = await projectsRepo.create({
    businessId: req.user.id,
    workerId: req.body.workerId,
    title: req.body.title,
    description: req.body.description,
    budget: req.body.budget,
    deadline: req.body.deadline,
    applicationDeadline: resolveApplicationDeadline(req.body.applicationWindow),
    estimatedDuration: req.body.estimatedDuration,
    minExperienceYears: req.body.minExperienceYears,
    maxExperienceYears: req.body.maxExperienceYears,
    educationLevel: req.body.educationLevel,
    educationNotes: req.body.educationNotes,
    requiredSkills: req.body.requiredSkills,
    isUrgent: req.body.isUrgent,
  });

  // The worker has never seen this project before now, so they can't have
  // joined its project:<id> room yet — emitProjectEvent still reaches them
  // via their private user:<id> room, joined automatically on connect.
  const joined = await projectsRepo.findByIdJoined(project.id);
  emitProjectEvent(joined, "PROJECT_CREATED", {
    title: project.title,
    budget: Number(project.budget),
    businessName: joined.business_name,
    senderId: req.user.id,
  });

  // High-value event #1 (see sms.service.js) — only the direct-invite path
  // (workerId provided) has anyone to notify; an OPEN job board post has no
  // worker yet. findByIdJoined's worker fields come from public_user_profiles,
  // which excludes phone — a real lookup is needed for that.
  if (joined.worker_id) {
    const worker = await usersRepo.findById(joined.worker_id);
    if (worker?.phone) {
      sendHiredSms(worker.phone, { project_title: project.title, business_name: joined.business_name }).catch((err) =>
        console.error("[sms] sendHiredSms threw:", err)
      );
    }

    // The trust gate for the persistent (business, worker) chat thread (see
    // chat_threads/threads.repository.js) — this direct-invite path assigns
    // a real worker_id from birth (status defaults to INVITED, not OPEN), so
    // messages.controller.js's mustBeParticipant already allows chat before
    // any acceptance. The thread has to exist just as early, or a fresh
    // direct invite would be invisible to the merged Negotiations inbox.
    await threadsRepo.getOrCreateThread(joined.business_id, joined.worker_id);
  }

  res.status(201).json({ data: project });
});

// PATCH /api/projects/:id — advance the FSM by exactly one non-terminal
// step (or cancel/dispute). COMPLETED is deliberately unreachable here —
// see completeProject below for why that has to be its own endpoint.
export const updateProjectStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status: toStatus, note } = req.body;

  const project = await projectsRepo.findById(id);
  if (!project) throw ApiError.notFound("Project not found.");

  const isParticipant = project.worker_id === req.user.id || project.business_id === req.user.id;
  if (!isParticipant && req.user.role !== "admin") {
    throw ApiError.forbidden("You are not a participant on this project.");
  }

  const allowed = canTransition({ fromStatus: project.status, toStatus, actorRole: req.user.role });
  if (!allowed) {
    throw ApiError.badRequest(
      `Cannot move project from ${project.status} to ${toStatus} as ${req.user.role}.`
    );
  }

  const updated = await projectsRepo.updateStatus(id, toStatus, undefined, note);

  // The only realtime emit that fires for a WORKER-initiated change (Start
  // Work, Submit Work) — secureFunds/completeProject below are business-
  // only actions with their own emits.
  emitProjectEvent(updated, "STATUS_CHANGED", { status: toStatus, actorRole: req.user.role, note, senderId: req.user.id });

  res.json({ data: updated });
});

// POST /api/projects/:id/fund-escrow — ACCEPTED -> PENDING_FUNDS, only by
// the business on the project. Body: { utrReference, screenshotUrl }.
//
// This does NOT grant FUNDS_SECURED itself — it only records the business's
// claim that they transferred the money (a real UTR/transaction ID plus a
// screenshot as proof) and moves the project into a "verification pending"
// state. Only WorkBridge staff confirming the transfer actually happened
// (resolveEscrowFunding in admin.controller.js) writes the real
// FUNDS_SECURED ledger row — same human-in-the-loop shape as
// requestRelease/completeProject below. Previously this endpoint
// (secureFunds) flipped straight to FUNDS_SECURED on a bare click with zero
// payment proof required, and that same unverified budget figure is what
// later became the worker's real payout at completeProject — this closes
// that gap.
export const fundEscrow = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { utrReference, screenshotUrl } = req.body ?? {};

  if (!utrReference || !String(utrReference).trim()) {
    throw ApiError.badRequest("A transaction ID / UTR reference is required.");
  }
  if (!screenshotUrl || !String(screenshotUrl).trim()) {
    throw ApiError.badRequest("A payment screenshot is required.");
  }

  const result = await transaction(async (client) => {
    const project = await projectsRepo.findByIdForUpdate(client, id);
    if (!project) throw ApiError.notFound("Project not found.");

    if (project.business_id !== req.user.id) {
      throw ApiError.forbidden("Only the business on this project can fund escrow.");
    }
    if (project.status !== "ACCEPTED") {
      throw ApiError.badRequest(`Cannot fund escrow for a project in status ${project.status} — expected ACCEPTED.`);
    }

    await projectsRepo.updateStatus(id, "PENDING_FUNDS", client);
    const updatedProject = await projectsRepo.setManualFundingMethod(client, id);

    const request = await escrowFundingRepo.insert(client, {
      projectId: id,
      businessId: req.user.id,
      amount: Number(project.budget),
      utrReference: String(utrReference).trim(),
      screenshotUrl,
    });

    return { project: updatedProject, request };
  });

  // Emitted after commit, never before — the business's own tab already has
  // this via the HTTP response; this nudges the worker's open tab live.
  emitProjectEvent(result.project, "STATUS_CHANGED", { status: "PENDING_FUNDS", actorRole: "business", senderId: req.user.id });

  res.status(201).json({ data: result });
});

// POST /api/projects/:id/checkout — ACCEPTED -> PENDING_FUNDS, business-only.
// Real-gateway counterpart to fundEscrow above (that one stays as the
// manual bank-transfer fallback). The amount is always server-computed —
// budget + business_fee_pct — never trusted from the client. Like
// fundEscrow, this does NOT grant FUNDS_SECURED itself; only the
// signature-verified webhook (webhook.controller.js) does that, once
// Razorpay confirms payment.captured — the checkout success callback in
// the browser is UI-optimistic only and is never trusted on its own.
export const createCheckoutOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const project = await projectsRepo.findById(id);
  if (!project) throw ApiError.notFound("Project not found.");
  if (project.business_id !== req.user.id) {
    throw ApiError.forbidden("Only the business on this project can fund it.");
  }

  // Idempotent retry — a reload or double-click on "Pay" after an order
  // was already created (but not yet paid) re-fetches a fresh
  // payment_session_id for that SAME Cashfree order instead of minting a
  // second one. Still written into the razorpay_order_id column/
  // funding_method='RAZORPAY' on purpose — reusing the existing generic
  // "gateway order id" column rather than a schema migration; the label
  // is stale, the column just stores whichever gateway's order id.
  if (project.status === "PENDING_FUNDS" && project.funding_method === "RAZORPAY" && project.razorpay_order_id) {
    const businessFeePct = Number(project.business_fee_pct ?? BUSINESS_FEE_PCT_FALLBACK);
    const amount = round2(Number(project.budget) * (1 + businessFeePct / 100));
    const order = await cashfreeService.getOrder(project.razorpay_order_id);
    res.json({
      data: {
        orderId: order.orderId,
        paymentSessionId: order.paymentSessionId,
        amount,
        currency: "INR",
      },
    });
    return;
  }

  if (project.status !== "ACCEPTED") {
    throw ApiError.badRequest(`Cannot start checkout for a project in status ${project.status} — expected ACCEPTED.`);
  }

  const businessFeePct = Number(project.business_fee_pct ?? BUSINESS_FEE_PCT_FALLBACK);
  const amount = round2(Number(project.budget) * (1 + businessFeePct / 100));

  // Outside any DB lock — this is a network call to Cashfree, and the
  // convention this file follows (see completeProject/cancelAndRefund
  // below) is to never hold a FOR UPDATE row lock across one.
  const order = await cashfreeService.createOrder({
    amountRupees: amount,
    receipt: project.id,
    customer: { id: project.business_id, name: req.user.name, email: req.user.email, phone: req.user.phone },
    returnUrl: `${process.env.FRONTEND_URL}/invoice?projectId=${project.id}&order_id={order_id}`,
    notes: { projectId: project.id, businessId: project.business_id },
  });

  const updatedProject = await transaction(async (client) => {
    // Re-locked, re-checked here — the unlocked read above only decided
    // whether to even call Cashfree; this is the actual guard against a
    // second concurrent checkout attempt winning the race.
    const locked = await projectsRepo.findByIdForUpdate(client, id);
    if (!locked || locked.status !== "ACCEPTED") {
      throw ApiError.badRequest("This project is no longer ready for checkout.");
    }
    await projectsRepo.setRazorpayOrder(client, id, { orderId: order.orderId, businessFeePct });
    return projectsRepo.updateStatus(id, "PENDING_FUNDS", client);
  });

  emitProjectEvent(updatedProject, "STATUS_CHANGED", { status: "PENDING_FUNDS", actorRole: "business", senderId: req.user.id });

  res.status(201).json({
    data: { orderId: order.orderId, paymentSessionId: order.paymentSessionId, amount, currency: "INR" },
  });
});

// POST /api/projects/:id/request-release — business's "Approve & Release"
// action. Only moves FILES_SUBMITTED -> PENDING_RELEASE; no ledger writes,
// no wallet credit — the business is signaling WorkBridge to release funds
// it's holding, not releasing them itself. The actual payout only happens
// when staff act on it via completeProject below, from the Admin Panel's
// Fund Releases tab.
export const requestRelease = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const project = await projectsRepo.findById(id);
  if (!project) throw ApiError.notFound("Project not found.");

  if (project.business_id !== req.user.id) {
    throw ApiError.forbidden("Only the business on this project can request a release.");
  }
  if (project.status !== "FILES_SUBMITTED") {
    throw ApiError.badRequest(`Cannot request release for a project in status ${project.status} — expected FILES_SUBMITTED.`);
  }

  const updated = await projectsRepo.updateStatus(id, "PENDING_RELEASE");

  emitProjectEvent(updated, "STATUS_CHANGED", { status: "PENDING_RELEASE", actorRole: "business", senderId: req.user.id });

  res.json({ data: updated });
});

// POST /api/projects/:id/complete — the Logic Bridge, and the one place
// real money actually moves. Only reachable when PENDING_RELEASE, only by
// WorkBridge staff (admin) — a business's own "Approve & Release" click no
// longer reaches this directly, see requestRelease above. Runs atomically:
// project status -> COMPLETED, a PAYOUT credit + PLATFORM_FEE debit land in
// the ledger, and the worker's wallet_balance is incremented — all inside
// one DB transaction, so a failure at any step rolls back every part of it
// (no "project marked complete but worker never got paid" split-brain state).
export const completeProject = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (req.user.role !== "admin") {
    throw ApiError.forbidden("Only WorkBridge staff can release secured funds.");
  }
  // Minimal real Support-tier RBAC — req.user only carries { id, role }
  // (see guard.js), so the acting admin's own current permission flag is
  // fetched fresh here, same pattern as admin.controller.js's
  // assertAdminPermission. See migrations/034_admin_permissions.sql.
  const actingAdmin = await usersRepo.findById(req.user.id);
  if (!actingAdmin || actingAdmin.can_release_funds === false) {
    throw ApiError.forbidden("Your admin account doesn't have fund-release rights — ask a super admin to grant them from Team Access.");
  }

  const project = await projectsRepo.findById(id);
  if (!project) throw ApiError.notFound("Project not found.");
  if (project.status !== "PENDING_RELEASE") {
    throw ApiError.badRequest(`Cannot complete a project in status ${project.status} — expected PENDING_RELEASE.`);
  }

  // Compute payout — NUMERIC columns come back as strings from pg by
  // default; Number() here, then round to paise/cents in real money math
  // (a real implementation should use a decimal library, not floats —
  // flagged here rather than silently done wrong).
  const budget = Number(project.budget);
  const workerFeePct = Number(project.worker_fee_pct ?? WORKER_FEE_PCT_FALLBACK);
  const fee = round2(budget * (workerFeePct / 100));
  const earnings = round2(budget - fee);

  // Real Route transfer, attempted OUTSIDE any DB lock — a network call to
  // Razorpay has no business holding a FOR UPDATE row open across it.
  // Eligible only if this project was actually funded through real
  // Checkout (razorpay_payment_id — a manually-funded project never has
  // one) and the worker has a fully verified payout destination.
  const worker = await usersRepo.findById(project.worker_id);
  const routeEligible = Boolean(
    project.razorpay_payment_id && worker?.razorpay_account_id && worker.razorpay_account_status === "ACTIVE"
  );

  let settlementMethod = "WALLET";
  let transferId = null;
  let payoutId = null;
  if (routeEligible) {
    try {
      const transfer = await razorpayService.createTransfer({
        paymentId: project.razorpay_payment_id,
        accountId: worker.razorpay_account_id,
        amountPaise: Math.round(earnings * 100),
        notes: { projectId: project.id, kind: "payout" },
        idempotencyKey: `${project.id}:payout`,
      });
      transferId = transfer?.transfers?.[0]?.id ?? transfer?.id ?? null;
      settlementMethod = "RAZORPAY_ROUTE_AUTO";
    } catch (err) {
      // The transfer call failing must never block completion — the
      // worker still gets paid, just into their in-app wallet for now,
      // with a durable log entry so staff can follow up (retry once the
      // underlying issue — expired KYC, a Razorpay-side outage — clears).
      settlementMethod = "WALLET_PENDING_MANUAL";
      console.error(`[razorpay] Route transfer failed for project ${project.id}:`, err);
    }
  } else if (worker?.payout_method && worker?.payout_details) {
    // Route stays blocked pending RBI review (routeEligible above is
    // effectively always false today), so this is the real payout path: a
    // direct RazorpayX payout to the worker's saved bank/UPI destination,
    // from WorkBridge's own already-settled Razorpay balance — the
    // "Separate Collection and Payout" architecture the RBI research
    // confirmed doesn't need the Route turnover/transparency review.
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
      console.error(`[cashfree] Payout failed for project ${project.id}:`, err);
    }
  }

  const result = await transaction(async (client) => {
    // FOR UPDATE — locks the row so two concurrent completion attempts on
    // the same project can't both succeed. Re-checked here, not just
    // trusted from the unlocked read above — this is the real guard
    // against a race.
    const locked = await projectsRepo.findByIdForUpdate(client, id);
    if (!locked) throw ApiError.notFound("Project not found.");
    if (locked.status !== "PENDING_RELEASE") {
      throw ApiError.badRequest(`Cannot complete a project in status ${locked.status} — expected PENDING_RELEASE.`);
    }

    // a. Update project status
    const updatedProject = await projectsRepo.updateStatus(id, "COMPLETED", client);
    if (transferId) await projectsRepo.setRazorpayTransfer(client, id, transferId);

    // b. Insert into the transactions ledger — one row per money movement,
    // not one row with a net amount, so the fee is independently auditable.
    // payoutId (a RazorpayX pout_XXX id) has no dedicated project column
    // like transferId does — folded into referenceNote instead, since it's
    // audit context, not something any other code path looks up by.
    const payoutTxn = await transactionsRepo.insert(
      {
        projectId: id,
        workerId: project.worker_id,
        businessId: project.business_id,
        type: "PAYOUT",
        direction: "credit",
        amount: earnings,
        fundsStatus: "RELEASED",
        referenceNote: payoutId ? `Payment released via RazorpayX (${payoutId}) – ${project.title}` : `Payment released – ${project.title}`,
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

    // c. Update the worker's wallet balance — skipped when the money
    // already left for the worker's real bank via Route or a direct
    // RazorpayX payout; crediting the in-app wallet too would double-count
    // spendable money.
    if (settlementMethod !== "RAZORPAY_ROUTE_AUTO" && settlementMethod !== "RAZORPAYX_PAYOUT") {
      await usersRepo.incrementWalletBalance(client, project.worker_id, earnings);
    }

    // d. MASTER_ECONOMY_PLAN.md's Core Loop — award completion XP inside
    // this same transaction, so a failed payout can never leave XP awarded
    // for a project that didn't actually complete. +50 is a flat first-cut
    // value (Part 4's full design distinguishes on-time/+150 vs early/+200;
    // that distinction isn't wired yet — this is deliberately the simpler
    // version to get the loop working end-to-end first).
    const workerBefore = await usersRepo.findForUpdate(client, project.worker_id);
    const newXp = workerBefore.xp + 50;
    const { currentLevel: newLevel } = calculateLevel(newXp);
    const leveledUp = newLevel > workerBefore.current_level;
    // MASTER_ECONOMY_PLAN.md Part 3 — Door A of the Two-Door Reveal. A
    // completed project always satisfies it, whether the worker was
    // 'hidden' (first-ever completion) or 'span' (previously revealed
    // early via 5 rejections, now upgrading to a real win) — only 'win'
    // itself is a no-op. This was the one piece of the Core Loop that
    // hadn't actually been wired despite being described as working.
    await usersRepo.awardXp(client, project.worker_id, {
      xpDelta: 50,
      tokenDelta: COMPLETION_TOKEN_REWARD,
      currentLevel: newLevel,
      standingDoor: "win",
    });
    await ledgerEventsRepo.create(client, {
      userId: project.worker_id,
      eventType: "PROJECT_COMPLETED",
      xpDelta: 50,
      tokenDelta: COMPLETION_TOKEN_REWARD,
    });

    // MASTER_ECONOMY_PLAN.md Part 7 — the business-side Ledger's first
    // real earning trigger ("project successfully closed without
    // dispute"). completeProject only ever runs on a project that reached
    // COMPLETED normally (a disputed project follows admin.controller.js's
    // resolveDispute instead), so every call here already satisfies
    // "no dispute" — no extra check needed.
    const businessBefore = await usersRepo.findForUpdate(client, project.business_id);
    const newBusinessXp = businessBefore.xp + BUSINESS_COMPLETION_XP_REWARD;
    const { currentLevel: newBusinessLevel } = calculateLevel(newBusinessXp);
    await usersRepo.awardXp(client, project.business_id, {
      xpDelta: BUSINESS_COMPLETION_XP_REWARD,
      tokenDelta: BUSINESS_COMPLETION_TOKEN_REWARD,
      currentLevel: newBusinessLevel,
    });
    await ledgerEventsRepo.create(client, {
      userId: project.business_id,
      eventType: "PROJECT_COMPLETED_NO_DISPUTE",
      xpDelta: BUSINESS_COMPLETION_XP_REWARD,
      tokenDelta: BUSINESS_COMPLETION_TOKEN_REWARD,
    });

    return { project: updatedProject, payout: payoutTxn, earnings, fee, leveledUp, newLevel, newXp, settlementMethod };
  });
  // ^ transaction() commits here if we reached this line, or has already
  // rolled back and re-thrown if anything above threw.

  // leveledUp/newLevel ride along on the same realtime event — the
  // business is who calls this endpoint, so the HTTP response alone would
  // only ever reach their browser. This is the only path that gets the
  // result to the worker's own already-connected socket in real time.
  // xpDelta/tokenDelta are the same fixed constants awardXp already wrote
  // to both ledgers above — real numbers, not recomputed here, just finally
  // included in the payload each side's socket listener reads from
  // (previously the frontend had no way to show what was actually earned,
  // even though it was already sitting in ledger_events).
  emitProjectEvent(result.project, "COMPLETED", {
    earnings: result.earnings,
    fee: result.fee,
    leveledUp: result.leveledUp,
    newLevel: result.newLevel,
    workerXpDelta: 50,
    workerTokenDelta: COMPLETION_TOKEN_REWARD,
    businessXpDelta: BUSINESS_COMPLETION_XP_REWARD,
    businessTokenDelta: BUSINESS_COMPLETION_TOKEN_REWARD,
    senderId: req.user.id,
  });

  res.json({ data: result });
});

// POST /api/projects/:id/propose-budget — the worker's real counter-offer
// on the posted budget. Only while ACCEPTED — once funds are secured the
// escrowed amount is locked, and before ACCEPTED there's no assigned
// worker to negotiate with yet. Overwrites any earlier still-pending
// proposal (see proposeBudget's own comment).
export const proposeBudget = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { budget } = req.body;

  const result = await transaction(async (client) => {
    const project = await projectsRepo.findByIdForUpdate(client, id);
    if (!project) throw ApiError.notFound("Project not found.");
    if (project.worker_id !== req.user.id) {
      throw ApiError.forbidden("Only the assigned worker can propose a new budget.");
    }
    if (project.status !== "ACCEPTED") {
      throw ApiError.badRequest("Budget can only be proposed before funds are secured.");
    }
    return projectsRepo.proposeBudget(client, id, { proposedBudget: budget, proposedBy: req.user.id });
  });

  emitProjectEvent(result, "BUDGET_PROPOSED", { proposedBudget: Number(result.proposed_budget), senderId: req.user.id });
  res.json({ data: result });
});

// POST /api/projects/:id/resolve-budget — body: { approved: boolean }.
// Business-only. approved writes proposed_budget into the real budget
// column (see resolveBudgetProposal); either way the proposal is spent.
export const resolveBudgetProposal = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { approved } = req.body ?? {};
  if (typeof approved !== "boolean") {
    throw ApiError.badRequest("Body must include { approved: boolean }.");
  }

  const result = await transaction(async (client) => {
    const project = await projectsRepo.findByIdForUpdate(client, id);
    if (!project) throw ApiError.notFound("Project not found.");
    if (project.business_id !== req.user.id) {
      throw ApiError.forbidden("Only the business on this project can resolve a budget proposal.");
    }
    if (project.proposed_budget === null) {
      throw ApiError.badRequest("There's no pending budget proposal on this project.");
    }
    return projectsRepo.resolveBudgetProposal(client, id, approved);
  });

  emitProjectEvent(result, "BUDGET_RESOLVED", { approved, budget: Number(result.budget), senderId: req.user.id });
  res.json({ data: result });
});

// POST /api/projects/:id/cancel-refund — the Ghosting Failsafe. A worker who
// accepted work and secured funds but never delivered by the real hard
// deadline (project.deadline) shouldn't leave a business's money stuck in
// limbo waiting for a manual dispute review — this is a deliberately
// instant, business-only self-service refund, consistent with the
// platform's "Instant Escrow" model (no admin gate), NOT routed through
// admin.controller.js's resolveDispute. Only reachable once the deadline
// has actually passed and the worker never reached FILES_SUBMITTED.
export const cancelAndRefund = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Real effect of the worker's "Momentum Shield" perk — an active,
  // unconsumed shield on THIS project blocks the Ghosting Failsafe once.
  // Its own short transaction (separate from the refund transaction below)
  // so consuming the shield actually commits even though the request that
  // triggered it gets rejected — this is the real enforcement boundary, not
  // just the button being hidden client-side (see WorkerTokenShop.jsx /
  // BusinessProjects.jsx).
  const shieldConsumed = await transaction(async (client) => {
    const project = await projectsRepo.findByIdForUpdate(client, id);
    if (!project) return false;
    const shield = await perkPurchasesRepo.findActive(project.worker_id, "momentum-shield", { targetId: id, client });
    if (!shield) return false;
    await perkPurchasesRepo.consume(client, shield.id);
    return true;
  });
  if (shieldConsumed) {
    throw ApiError.forbidden("This project is protected by the worker's Momentum Shield — it can't be cancelled right now.");
  }

  const project = await projectsRepo.findById(id);
  if (!project) throw ApiError.notFound("Project not found.");

  if (project.business_id !== req.user.id) {
    throw ApiError.forbidden("Only the business on this project can cancel and refund it.");
  }
  if (!["FUNDS_SECURED", "WORK_IN_PROGRESS"].includes(project.status)) {
    throw ApiError.badRequest(
      `Cannot cancel & refund a project in status ${project.status} — expected FUNDS_SECURED or WORK_IN_PROGRESS.`
    );
  }
  if (!project.deadline || new Date(project.deadline) > new Date()) {
    throw ApiError.badRequest("Cannot cancel & refund before the delivery deadline has passed.");
  }

  // Real refund, attempted OUTSIDE any DB lock — same reasoning as
  // completeProject's payout call above. Budget-only: the 8% business fee
  // is retained as WorkBridge's non-refundable facilitation fee on a
  // cancelled project (Terms & Conditions §6). No razorpay_order_id means
  // this project was funded through the manual bank-transfer fallback —
  // ledger-only, exactly as before this integration existed. Cashfree's
  // refund API is order-scoped (not payment-scoped like Razorpay's was),
  // so this keys off razorpay_order_id (the reused column — see
  // cashfree.service.js) rather than razorpay_payment_id.
  let refundId = null;
  if (project.razorpay_order_id) {
    // Cashfree's refund_id only allows alphanumeric/underscore/hyphen/dot —
    // no colon, unlike the transfer_id convention used elsewhere.
    const refund = await cashfreeService.createRefund({
      orderId: project.razorpay_order_id,
      refundId: `${project.id}_refund`,
      amountRupees: Number(project.budget),
      note: "cancel_refund",
    });
    refundId = refund?.refund_id ?? null;
  }

  const result = await transaction(async (client) => {
    // Re-locked, re-checked — the unlocked read above only decided
    // whether/how much to refund via Razorpay; this is the real guard
    // against a race (e.g. the project completing normally in between).
    const locked = await projectsRepo.findByIdForUpdate(client, id);
    if (!locked) throw ApiError.notFound("Project not found.");
    if (!["FUNDS_SECURED", "WORK_IN_PROGRESS"].includes(locked.status)) {
      throw ApiError.badRequest(
        `Cannot cancel & refund a project in status ${locked.status} — expected FUNDS_SECURED or WORK_IN_PROGRESS.`
      );
    }

    const updatedProject = await projectsRepo.updateStatus(id, "CANCELLED", client);
    if (refundId) await projectsRepo.setRazorpayRefund(client, id, refundId);

    const refundTxn = await transactionsRepo.insert(
      {
        projectId: id,
        workerId: project.worker_id,
        businessId: project.business_id,
        type: "REFUND",
        direction: "debit",
        amount: Number(project.budget),
        fundsStatus: "REFUNDED",
        referenceNote: `Refunded — deadline passed without delivery – ${project.title}`,
      },
      client
    );

    return { project: updatedProject, transaction: refundTxn };
  });

  emitProjectEvent(result.project, "STATUS_CHANGED", { status: "CANCELLED", actorRole: "business", note: "Deadline missed — refunded", senderId: req.user.id });

  res.json({ data: result });
});

function round2(n) {
  return Math.round(n * 100) / 100;
}
