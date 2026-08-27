import { transaction } from "../db/client.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import * as webhookEventsRepo from "../repositories/razorpay_webhook_events.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as razorpayService from "../services/razorpay.service.js";
import { emitProjectEvent } from "../realtime/events.js";
import { confirmPaymentByOrderId } from "../services/paymentConfirmation.service.js";

// payment.captured can confirm either kind of order this app creates — a
// project checkout (createCheckoutOrder) or a subscription checkout
// (createSubscriptionCheckout), both in payments.controller.js/
// projects.controller.js. confirmPaymentByOrderId (shared with the
// signature-verified /verify endpoint — see paymentConfirmation.service.js)
// tries the project lookup first and falls back to the subscription one —
// a given order_id only ever matches one of them. This handler is
// idempotent against a duplicate delivery reaching here despite
// razorpay_webhook_events' own dedupe: only a PENDING_FUNDS project /
// PENDING subscription payment actually transitions, anything else is a
// no-op inside the shared confirm functions.
async function handlePaymentCaptured(payload) {
  const payment = payload?.payload?.payment?.entity;
  if (!payment?.order_id) return;
  await confirmPaymentByOrderId({ orderId: payment.order_id, paymentId: payment.id });
}

// payment.failed — reverts a PENDING_FUNDS project back to ACCEPTED so the
// business sees a real "try again" state instead of being stuck behind an
// order that will never capture.
async function handlePaymentFailed(payload) {
  const payment = payload?.payload?.payment?.entity;
  if (!payment?.order_id) return;

  const result = await transaction(async (client) => {
    const project = await projectsRepo.findByRazorpayOrderId(client, payment.order_id);
    if (!project || project.status !== "PENDING_FUNDS") return null;

    return await projectsRepo.updateStatus(project.id, "ACCEPTED", client);
  });

  if (!result) return;
  emitProjectEvent(result, "STATUS_CHANGED", { status: "ACCEPTED", actorRole: "system", note: "Payment failed — try again" });
}

// refund.processed — cancelAndRefund/resolveDispute already write the
// REFUND ledger row and razorpay_refund_id synchronously, at the moment
// they *call* createRefund — this event is Razorpay's own confirmation
// that the refund settled, and needs no further write on WorkBridge's
// side. The event itself is still durably recorded by razorpay_webhook_
// events (see insertIfNew below) even though this handler is a no-op;
// kept as an explicit case (not silently falling through to "no handler")
// so the intent is visible in EVENT_HANDLERS below.
function handleRefundProcessed() {}

// account.instantly_activated / account.activated_kyc_pending — the real
// event names in Razorpay's current webhook catalog (no generic
// "account.activated"/"account.rejected" exist there). Keeps a worker's
// razorpay_account_status current without WorkBridge ever polling
// Razorpay for it; completeProject's Route-transfer eligibility check
// reads this same column, and only ACTIVE counts as eligible —
// activated_kyc_pending means the account can exist but full KYC isn't
// done yet, so it's treated as still-PENDING here rather than trusted for
// an automatic payout. There's no rejection event in this catalog at
// all — REJECTED (still a valid razorpay_account_status value) is set
// manually by staff if Razorpay's own dashboard shows a failed account,
// not driven by any webhook.
async function handleAccountStatusEvent(payload, status) {
  const accountId = payload?.payload?.account?.entity?.id ?? payload?.account_id;
  if (!accountId) return;
  await usersRepo.updateRazorpayAccountStatusByAccountId(accountId, status);
}

const EVENT_HANDLERS = {
  "payment.captured": handlePaymentCaptured,
  // Razorpay can deliver either event as the successful-order notification.
  // payment.captured carries the payment entity; order.paid may only carry
  // the order, so resolve its captured payment from Razorpay when needed.
  "order.paid": async (payload) => {
    if (payload?.payload?.payment?.entity) {
      await handlePaymentCaptured(payload);
      return;
    }
    const orderId = payload?.payload?.order?.entity?.id;
    if (!orderId) return;
    const payments = await razorpayService.fetchOrderPayments(orderId);
    const payment = payments?.items?.find((item) => item.status === "captured") ?? payments?.items?.[0];
    if (payment) await handlePaymentCaptured({ payload: { payment: { entity: payment } } });
  },
  "payment.failed": handlePaymentFailed,
  "refund.processed": handleRefundProcessed,
  "account.instantly_activated": (payload) => handleAccountStatusEvent(payload, "ACTIVE"),
  "account.activated_kyc_pending": (payload) => handleAccountStatusEvent(payload, "PENDING"),
};

// POST /api/payments/webhook — mounted directly on `app` (not under
// apiRouter/guard, see app.js) with express.raw() ahead of the global
// express.json() specifically for this path, since signature verification
// needs the exact original bytes Razorpay signed, not a re-serialized
// JSON.parse/stringify round-trip of them.
export const handleRazorpayWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody = req.body; // Buffer, thanks to express.raw()

  if (!razorpayService.verifyWebhookSignature(rawBody, signature)) {
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  const payload = JSON.parse(rawBody.toString("utf8"));
  const eventId = payload?.id;
  const eventType = payload?.event;

  if (!eventId || !eventType) {
    res.status(400).json({ error: "Malformed webhook payload" });
    return;
  }

  // Idempotency — a duplicate delivery of an already-seen event (Razorpay
  // retries aggressively on anything but a fast 200) becomes a no-op read
  // here, before any ledger write is even attempted.
  const inserted = await webhookEventsRepo.insertIfNew({ eventId, eventType, payload });
  if (!inserted) {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    const handler = EVENT_HANDLERS[eventType];
    if (handler) await handler(payload);
    await webhookEventsRepo.markProcessed(eventId);
  } catch (err) {
    // Logged, not re-thrown — a 200 here is deliberate even on internal
    // failure, so Razorpay doesn't enter a retry storm. processing_error
    // keeps the durable raw payload queryable/replayable by staff.
    console.error(`[razorpay webhook] ${eventType} (${eventId}) failed:`, err);
    await webhookEventsRepo.markProcessed(eventId, err?.message ?? String(err));
  }

  res.json({ received: true });
});
