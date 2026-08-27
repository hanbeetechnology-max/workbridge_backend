import { asyncHandler } from "../utils/asyncHandler.js";
import { transaction } from "../db/client.js";
import * as cashfreeService from "../services/cashfree.service.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import { emitProjectEvent } from "../realtime/events.js";
import { confirmPaymentByOrderId } from "../services/paymentConfirmation.service.js";

// PAYMENT_SUCCESS_WEBHOOK — same shared confirmation path the (now
// unused-for-Cashfree, still Razorpay-shaped) verify endpoints used to
// call, so a project or subscription reaches the exact same
// FUNDS_SECURED/PAID state regardless of which gateway paid for it.
async function handlePaymentSuccess(payload) {
  const order = payload?.data?.order;
  const payment = payload?.data?.payment;
  if (!order?.order_id || payment?.payment_status !== "SUCCESS") return;
  await confirmPaymentByOrderId({ orderId: order.order_id, paymentId: String(payment.cf_payment_id) });
}

// PAYMENT_FAILED_WEBHOOK / PAYMENT_USER_DROPPED_WEBHOOK — reverts a
// PENDING_FUNDS project back to ACCEPTED, same reasoning as
// webhook.controller.js's handlePaymentFailed for Razorpay: a business
// sees a real "try again" state instead of being stuck behind a checkout
// that will never complete.
async function handlePaymentFailed(payload) {
  const order = payload?.data?.order;
  if (!order?.order_id) return;

  const result = await transaction(async (client) => {
    const project = await projectsRepo.findByRazorpayOrderId(client, order.order_id);
    if (!project || project.status !== "PENDING_FUNDS") return null;
    return projectsRepo.updateStatus(project.id, "ACCEPTED", client);
  });

  if (!result) return;
  emitProjectEvent(result, "STATUS_CHANGED", { status: "ACCEPTED", actorRole: "system", note: "Payment failed — try again" });
}

const EVENT_HANDLERS = {
  PAYMENT_SUCCESS_WEBHOOK: handlePaymentSuccess,
  PAYMENT_FAILED_WEBHOOK: handlePaymentFailed,
  PAYMENT_USER_DROPPED_WEBHOOK: handlePaymentFailed,
};

// POST /api/webhooks/cashfree — Payment Gateway (pay-in) events only.
// Cashfree Payouts fires to a SEPARATE webhook, configured in a different
// section of the Cashfree dashboard (Payouts > Developers > Webhooks) —
// see cashfreePayoutWebhook.controller.js for that one. Mounted directly
// on `app` with express.raw() ahead of the global express.json() (see
// app.js), same reasoning as webhook.controller.js's Razorpay handler:
// signature verification needs the exact original bytes Cashfree signed.
export const handleCashfreeWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];
  const rawBody = req.body; // Buffer, thanks to express.raw()

  if (!cashfreeService.verifyWebhookSignature(rawBody, signature, timestamp)) {
    console.error("[cashfree webhook] signature verification failed");
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  const payload = JSON.parse(rawBody.toString("utf8"));
  const eventType = payload?.type;

  try {
    const handler = EVENT_HANDLERS[eventType];
    if (handler) await handler(payload);
    else console.log(`[cashfree webhook] no handler for event type: ${eventType}`);
  } catch (err) {
    // Logged, not re-thrown — a 200 here is deliberate even on internal
    // failure, so Cashfree doesn't enter a retry storm. Same convention as
    // webhook.controller.js's Razorpay handler.
    console.error(`[cashfree webhook] ${eventType} failed:`, err);
  }

  res.json({ received: true });
});
