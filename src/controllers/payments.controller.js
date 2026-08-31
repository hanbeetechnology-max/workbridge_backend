import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { transaction } from "../db/client.js";
import { requireReverify } from "../middleware/guard.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as subscriptionPaymentsRepo from "../repositories/subscription_payments.repository.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import * as razorpayService from "../services/razorpay.service.js";
import * as cashfreeService from "../services/cashfree.service.js";
import { confirmPaymentByOrderId } from "../services/paymentConfirmation.service.js";

// Canonical prices — the ONLY place a subscription's real charge is
// decided; never trusted from the client. Must match the tier cards shown
// in BusinessPayments.jsx's SubscriptionTab / WorkerWallet.jsx's
// subscription tab exactly, but is deliberately a separate, server-owned
// copy rather than something the frontend could influence.
const SUBSCRIPTION_PRICES = {
  business: {
    GROWTH: { MONTHLY: 499, YEARLY: 4999 },
    ENTERPRISE: { MONTHLY: 1499, YEARLY: 14999 },
  },
  worker: {
    PRO: { MONTHLY: 99, YEARLY: 999 },
    ELITE: { MONTHLY: 199, YEARLY: 1999 },
  },
};

const GENERIC_SUBSCRIPTION_PRICES = { PLUS: 99, PRO: 199 };

// Compatibility endpoint for clients that use the canonical payment contract.
// Project checkout remains the preferred escrow path because it atomically
// records PENDING_FUNDS and the project/order association.
export const createOrder = asyncHandler(async (req, res) => {
  const { type, tier, projectId, budget } = req.body ?? {};
  let amountInRupees;
  let notes;

  if (type === "SUBSCRIPTION") {
    amountInRupees = GENERIC_SUBSCRIPTION_PRICES[tier];
    if (!amountInRupees) throw ApiError.badRequest("Subscription tier must be PLUS or PRO.");
    notes = { userId: req.user.id, type, tier };
  } else if (type === "ESCROW") {
    if (req.user.role !== "business") throw ApiError.forbidden("Only businesses can fund escrow.");
    if (!projectId && (!Number.isFinite(Number(budget)) || Number(budget) <= 0)) {
      throw ApiError.badRequest("A positive budget or projectId is required.");
    }
    const project = projectId ? await projectsRepo.findById(projectId) : null;
    if (projectId && !project) throw ApiError.notFound("Project not found.");
    if (project && project.business_id !== req.user.id) throw ApiError.forbidden("Only the project owner can fund escrow.");
    if (project && project.status !== "ACCEPTED") {
      throw ApiError.badRequest(`Cannot fund escrow for a project in status ${project.status} — expected ACCEPTED.`);
    }
    amountInRupees = Number(project?.budget ?? budget) * 1.08;
    notes = { userId: req.user.id, type, ...(projectId ? { projectId } : {}) };
  } else {
    throw ApiError.badRequest("Payment type must be SUBSCRIPTION or ESCROW.");
  }

  const amount = Math.round(amountInRupees * 100);
  const receipt = `rcpt_${Date.now()}`;
  // req.user is only { id, role } from the JWT — never the full profile
  // (see guard.js) — so a real fetch is required for Cashfree to get the
  // customer's actual name/email/phone instead of its generic placeholders.
  const user = await usersRepo.findById(req.user.id);
  const order = await cashfreeService.createOrder({
    amountRupees: amountInRupees,
    receipt,
    customer: { id: user.id, name: user.name, email: user.email, phone: user.phone },
    returnUrl: `${process.env.FRONTEND_URL}/pricing?order_id={order_id}`,
    notes,
  });

  if (type === "ESCROW" && projectId) {
    await transaction(async (client) => {
      const lockedProject = await projectsRepo.findByIdForUpdate(client, projectId);
      if (!lockedProject || lockedProject.business_id !== req.user.id || lockedProject.status !== "ACCEPTED") {
        throw ApiError.badRequest("This project is no longer ready for checkout.");
      }
      await projectsRepo.setRazorpayOrder(client, projectId, { orderId: order.orderId, businessFeePct: 8 });
      await projectsRepo.updateStatus(projectId, "PENDING_FUNDS", client);
    });
  }

  if (type === "SUBSCRIPTION") {
    await subscriptionPaymentsRepo.insert({
      userId: req.user.id,
      tier,
      billingPeriod: "MONTHLY",
      amount: amount / 100,
      razorpayOrderId: order.orderId,
    });
  }

  res.status(201).json({
    data: { orderId: order.orderId, paymentSessionId: order.paymentSessionId, environment: order.environment, amount: order.amount, currency: order.currency },
  });
});

// POST /api/payments/route-account — worker-only. Creates a Razorpay Route
// linked account for this worker's payout destination. Only the returned
// acc_XXXX id (plus status/email) is ever persisted — the raw bank account
// number/IFSC the worker submitted go straight through to Razorpay in the
// outbound request and are never written to any WorkBridge table (see
// Privacy Policy §7 — WorkBridge stores a reference id, not bank details).
//
// tnc_accepted: true inside createLinkedAccount is the worker's one real
// consent moment — pushing money via IMPS/NEFT (how every Route transfer
// moves) never requires a per-transfer approval from the receiving side,
// unlike pulling money (an eMandate), which this is not.
export const createRouteAccount = asyncHandler(async (req, res) => {
  const { email, phone, beneficiaryName, legalBusinessName, bankAccountNumber, bankIfsc } = req.body;

  // Same reverify gate as savePayoutDetails above — only linking a
  // DIFFERENT account after one already exists needs a fresh password
  // re-proof, not the first-ever link.
  const existing = await usersRepo.findById(req.user.id);
  if (existing?.razorpay_account_id) requireReverify(req);

  const account = await razorpayService.createLinkedAccount({
    email,
    phone,
    beneficiaryName,
    legalBusinessName,
    bankAccountNumber,
    bankIfsc,
  });

  const updated = await usersRepo.setRazorpayAccount(req.user.id, {
    accountId: account.id,
    status: "PENDING",
    email,
  });
  if (!updated) throw ApiError.internal("Could not save the linked account — please try again.");

  res.status(201).json({
    data: {
      razorpayAccountId: account.id,
      status: "PENDING",
      // Real Route linked accounts need KYC (PAN/address proof) to reach
      // ACTIVE — Razorpay's own hosted onboarding page handles document
      // upload/validation rather than WorkBridge re-implementing that
      // compliance surface itself.
      onboardingUrl: account.onboarding_url ?? null,
    },
  });
});

// POST /api/payments/payout-account — worker-only. Saves the worker's
// default payout destination (bank account+IFSC or a UPI VPA) so
// completeProject/resolveDispute can pay them directly via RazorpayX at
// completion, without needing the Razorpay Route linked-account flow
// (createRouteAccount above), which stays blocked pending RBI review. Raw
// bank details ARE persisted here (unlike Route, which never sees them
// after handing them to Razorpay) since WorkBridge itself calls the
// RazorpayX payout API with them directly — same shape/trust level as
// withdrawal_requests.payout_details already stores per-withdrawal.
export const savePayoutDetails = asyncHandler(async (req, res) => {
  const { payoutMethod, payoutDetails } = req.body;

  // Only a CHANGE to an already-saved destination needs a fresh password
  // re-proof — the first-ever save has nothing real to protect yet, and
  // requiring one there would just be friction with no security benefit.
  const existing = await usersRepo.findById(req.user.id);
  if (existing?.payout_details) requireReverify(req);

  const updated = await usersRepo.setPayoutDetails(req.user.id, { payoutMethod, payoutDetails });
  if (!updated) throw ApiError.internal("Could not save payout details — please try again.");
  res.json({ data: { payoutMethod: updated.payout_method, payoutDetails: updated.payout_details } });
});

// GET /api/payments/payout-account — worker-only, current saved destination.
export const getPayoutDetails = asyncHandler(async (req, res) => {
  const user = await usersRepo.findById(req.user.id);
  res.json({ data: { payoutMethod: user.payout_method, payoutDetails: user.payout_details } });
});

// GET /api/payments/route-account — worker-only. DB-cached, kept current
// by the account.* webhook events (webhook.controller.js) rather than a
// live Razorpay API call on every page load.
export const getRouteAccount = asyncHandler(async (req, res) => {
  const user = await usersRepo.findById(req.user.id);
  res.json({
    data: {
      razorpayAccountId: user.razorpay_account_id,
      status: user.razorpay_account_status,
    },
  });
});

// POST /api/payments/subscription-checkout — either role. Body: { tier,
// billingPeriod }. Manual pay-per-period, not a recurring auto-charge — a
// plain one-time Razorpay order per period, reusing the exact same
// order-creation + webhook-confirmation path project checkout uses (see
// createCheckoutOrder in projects.controller.js and handlePaymentCaptured
// in webhook.controller.js, extended below to also recognize subscription
// orders). Nothing here unlocks the tier's actual perks yet — those
// remain placeholder/coming-soon in the UI on purpose (see PricingPage.jsx);
// this only makes the payment itself real, so upgrading isn't blocked on
// perks being fully built.
export const createSubscriptionCheckout = asyncHandler(async (req, res) => {
  const { tier, billingPeriod } = req.body ?? {};
  const roleTable = SUBSCRIPTION_PRICES[req.user.role];
  const tierPrices = roleTable?.[tier];
  const amount = tierPrices?.[billingPeriod];
  if (!amount) {
    throw ApiError.badRequest(`No such ${req.user.role} subscription tier/period: ${tier}/${billingPeriod}.`);
  }

  // req.user is only { id, role } — decoded straight from the JWT (see
  // guard.js), never the full profile — so req.user.name/email/phone are
  // always undefined. A real fetch is required to hand Cashfree the
  // customer's actual details instead of silently falling back to its
  // generic placeholder phone/email on every single checkout.
  const user = await usersRepo.findById(req.user.id);

  const order = await cashfreeService.createOrder({
    amountRupees: amount,
    receipt: `sub_${req.user.id}_${Date.now()}`,
    customer: { id: user.id, name: user.name, email: user.email, phone: user.phone },
    returnUrl: `${process.env.FRONTEND_URL}/pricing?order_id={order_id}`,
    notes: { userId: req.user.id, tier, billingPeriod },
  });

  await subscriptionPaymentsRepo.insert({
    userId: req.user.id,
    tier,
    billingPeriod,
    amount,
    razorpayOrderId: order.orderId,
  });

  res.status(201).json({
    data: { orderId: order.orderId, paymentSessionId: order.paymentSessionId, environment: order.environment, amount, currency: "INR" },
  });
});

// GET /api/payments/subscription-status — current cached tier/expiry (see
// users.subscription_tier/subscription_expires_at, kept current by the
// webhook the moment a payment is confirmed).
export const getSubscriptionStatus = asyncHandler(async (req, res) => {
  const user = await usersRepo.findById(req.user.id);
  const expiresAt = user.subscription_expires_at;
  const isActive = user.subscription_tier !== "FREE" && expiresAt && new Date(expiresAt) > new Date();
  res.json({
    data: {
      tier: isActive ? user.subscription_tier : "FREE",
      expiresAt: isActive ? expiresAt : null,
    },
  });
});

// POST /api/payments/verify — recomputes the Checkout success-callback's
// HMAC signature. A signature that verifies is real cryptographic proof
// Razorpay itself issued this payment (only Razorpay and WorkBridge know
// RAZORPAY_KEY_SECRET) — not a client claim — so on success this grants
// FUNDS_SECURED / confirms the subscription immediately via the exact same
// confirmPaymentByOrderId path the webhook uses, for a fast UI instead of
// waiting on the webhook round-trip. The webhook still runs independently
// afterwards as an idempotent backstop (e.g. the tab closes before this
// call fires) — confirmPaymentByOrderId's internal PENDING-only guards make
// calling it twice for the same order a safe no-op the second time.
export const verifyPayment = asyncHandler(async (req, res) => {
  const { orderId, paymentId, signature } = req.body;
  const verified = razorpayService.verifyCheckoutSignature({ orderId, paymentId, signature });
  if (verified) await confirmPaymentByOrderId({ orderId, paymentId });
  res.json({ data: { verified } });
});

export const verifyPaymentContract = asyncHandler(async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body ?? {};
  const verified = razorpayService.verifyCheckoutSignature({ orderId, paymentId, signature });
  if (verified) await confirmPaymentByOrderId({ orderId, paymentId });
  res.json({ data: { verified } });
});
