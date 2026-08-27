import { asyncHandler } from "../utils/asyncHandler.js";

// POST /api/webhooks/cashfree-payouts — Payouts events only (TRANSFER_SUCCESS,
// TRANSFER_FAILED, TRANSFER_REVERSED, BENEFICIARY_INCIDENT, ...). Configured
// SEPARATELY from the Payment Gateway webhook (cashfreeWebhook.controller.js,
// /api/webhooks/cashfree) — Payouts and PG are different Cashfree products
// with their own dashboards, credentials, and webhook signature schemes.
//
// Deliberately does nothing but log + 200 OK for now, same reason the PG
// webhook started that way: Payouts isn't even reachable with the current
// credentials yet (404 internal_error — see chat, Payouts needs its own
// API keys from a separate dashboard section). Two real unknowns before
// this can be trusted with real logic:
//   1. Signature scheme — Cashfree's own Payouts v1 webhook docs describe
//      a DIFFERENT scheme than the PG one this app already verifies
//      (sort every POST param except `signature`, concatenate the VALUES
//      in key-sorted order, HMAC-SHA256 + base64 — not the timestamp+
//      rawBody JSON scheme cashfree.service.js's verifyWebhookSignature
//      does for PG). Whether that's still current for a V2-configured
//      webhook (the dashboard's Add Webhook flow now offers a version
//      picker) isn't confirmed. Don't guess and ship a verifier that
//      either rejects every real delivery or accepts forged ones —
//      confirm the exact scheme from the Payouts dashboard's own docs
//      once those credentials exist.
//   2. Payload shape — form-encoded POST params (per the v1 docs) vs a
//      JSON body (per PG's shape) isn't confirmed for whatever version
//      actually gets configured.
// Once both are confirmed, wire real verification + TRANSFER_* handling
// here the same way cashfreeWebhook.controller.js does for PG.
export const handleCashfreePayoutWebhook = asyncHandler(async (req, res) => {
  console.log("[cashfree payout webhook] received:", {
    contentType: req.headers["content-type"],
    bodyLength: req.body?.length ?? 0,
    body: req.body?.toString("utf8")?.slice(0, 2000),
  });

  res.json({ received: true });
});
