import crypto from "node:crypto";
import { ApiError } from "../utils/ApiError.js";

// Cashfree — replacing CashFree for both pay-in (Payment Gateway Orders
// API) and payout (Payouts v2). These are two SEPARATE Cashfree products
// with their own separate credential pairs — confirmed 2026-08-27 when
// the PG credentials 404'd against the Payouts API. Both use the same
// simple x-client-id/x-client-secret header auth (no separate OAuth token
// step, unlike Payouts v1).
function mustGetPgConfig() {
  const appId = process.env.CASHFREE_APP_ID?.trim();
  const secretKey = process.env.CASHFREE_SECRET_KEY?.trim();
  if (!appId || !secretKey) {
    throw ApiError.internal("Cashfree is not configured on this server.");
  }
  // Cashfree's own sandbox PG App IDs are prefixed "TEST...", which is
  // reliable enough to pick sandbox vs production without a separate flag.
  const isSandbox = appId.startsWith("TEST");
  return {
    appId,
    secretKey,
    baseUrl: isSandbox ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg",
  };
}

function mustGetPayoutConfig() {
  const appId = process.env.CASHFREE_PAYOUT_CLIENT_ID?.trim();
  const secretKey = process.env.CASHFREE_PAYOUT_CLIENT_SECRET?.trim();
  if (!appId || !secretKey) {
    throw ApiError.internal("Cashfree Payouts is not configured on this server.");
  }
  // Unlike PG, the Payouts sandbox Client ID has no TEST prefix to key
  // off of — CASHFREE_PAYOUT_ENV is the actual sandbox/production switch.
  const isSandbox = (process.env.CASHFREE_PAYOUT_ENV?.trim() || "TEST").toUpperCase() !== "PRODUCTION";
  return {
    appId,
    secretKey,
    baseUrl: isSandbox ? "https://sandbox.cashfree.com/payout" : "https://api.cashfree.com/payout",
  };
}

const API_VERSION = "2023-08-01";

async function cashfreeRequest(config, path, { method = "POST", body } = {}) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-version": API_VERSION,
      "x-client-id": config.appId,
      "x-client-secret": config.secretKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message || payload?.error_description || "Cashfree request failed.";
    // 409 on beneficiary creation ("already exists") is a normal, expected
    // outcome for createOrFindBeneficiary below — that caller inspects
    // err.statusCode itself rather than this throwing having special-cased
    // it, so every other caller still gets a real, loud failure.
    throw new ApiError(response.status >= 400 && response.status < 500 ? response.status : 502, message, {
      cashfreeCode: payload?.code,
    });
  }
  return payload;
}

// ── Payment Gateway (pay-in) ────────────────────────────────────────────

// receipt is our own order id (project id, or a subscription receipt
// string) — Cashfree accepts a caller-supplied order_id; passing our own
// lets us find the order back without a second lookup table, same reason
// CashFree's createOrder used `receipt` for this.
export async function createOrder({ amountRupees, receipt, customer, returnUrl, notes }) {
  const order = await cashfreeRequest(mustGetPgConfig(), "/orders", {
    body: {
      order_id: receipt,
      order_amount: Number(amountRupees),
      order_currency: "INR",
      customer_details: {
        customer_id: customer?.id ?? receipt,
        customer_name: customer?.name || undefined,
        customer_email: customer?.email || "noreply@hanbee.in",
        customer_phone: customer?.phone || "9999999999",
      },
      order_meta: {
        return_url: returnUrl,
      },
      order_note: notes ? JSON.stringify(notes) : undefined,
    },
  });
  return {
    orderId: order.order_id,
    cfOrderId: order.cf_order_id,
    paymentSessionId: order.payment_session_id,
    orderStatus: order.order_status,
    amount: order.order_amount,
    currency: order.order_currency,
  };
}

// Re-fetches an existing order to hand back a fresh payment_session_id —
// used by the idempotent-retry path (a reload/double-click on "Pay" after
// an order already exists for this project) instead of minting a second
// Cashfree order for the same checkout attempt.
export async function getOrder(orderId) {
  const order = await cashfreeRequest(mustGetPgConfig(), `/orders/${encodeURIComponent(orderId)}`, {
    method: "GET",
  });
  return {
    orderId: order.order_id,
    paymentSessionId: order.payment_session_id,
    orderStatus: order.order_status,
    amount: order.order_amount,
    currency: order.order_currency,
  };
}

export async function createRefund({ orderId, refundId, amountRupees, note }) {
  return cashfreeRequest(mustGetPgConfig(), `/orders/${encodeURIComponent(orderId)}/refunds`, {
    body: {
      refund_id: refundId,
      refund_amount: Number(amountRupees),
      refund_note: note,
    },
  });
}

// Cashfree signs every webhook (both PG and Payouts) the same way: base64
// of HMAC-SHA256 over (timestamp + rawBody) using the secret key —
// confirmed from Cashfree's own docs.cashfree.com signature-verification
// pages, not guessed. Verified against the exact raw bytes (see
// app.js's express.raw() carve-out for /api/webhooks/cashfree), the same
// reason CashFree.service.js's verifyWebhookSignature needs the raw body
// rather than a re-serialized JSON.parse/stringify round-trip.
export function verifyWebhookSignature(rawBody, signatureHeader, timestampHeader) {
  const { secretKey } = mustGetPgConfig();
  if (!signatureHeader || !timestampHeader) return false;

  const signedPayload = timestampHeader + rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", secretKey).update(signedPayload).digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// ── Payouts v2 (payout) ─────────────────────────────────────────────────

// beneficiary_id is deterministic (the worker's own user id) rather than
// a separately-generated/stored id — Payouts v2 treats "create" as
// idempotent-by-id in practice (409 beneficiary_id_already_exists is the
// normal, expected outcome on every call after the first for the same
// worker), so no new DB column is needed to remember a beneficiary
// reference; it's just re-derived from worker.id every time.
export async function createOrFindBeneficiary({ workerId, name, email, phone, payoutMethod, payoutDetails }) {
  const isUpi = payoutMethod === "UPI";
  const details = isUpi ? null : String(payoutDetails).split(/[·,|]/).map((part) => part.trim()).filter(Boolean);

  try {
    await cashfreeRequest(mustGetPayoutConfig(), "/beneficiary", {
      body: {
        beneficiary_id: workerId,
        beneficiary_name: name,
        beneficiary_instrument_details: isUpi
          ? { vpa: String(payoutDetails).trim() }
          : { bank_account_number: details[0], bank_ifsc: details.at(-1) },
        beneficiary_contact_details: {
          beneficiary_email: email || undefined,
          beneficiary_phone: phone || undefined,
        },
      },
    });
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 409) {
      return workerId; // already exists — same beneficiary_id is reusable as-is
    }
    throw err;
  }
  return workerId;
}

// requestId doubles as the transfer_id Cashfree dedupes retries on (a
// second call with the same transfer_id for a project that already
// transferred returns the original transfer rather than creating a real
// second payout) — same stable-id-as-idempotency-key shape
// CashFree.service.js's createCashFreeXPayout used.
export async function createTransfer({ requestId, amountRupees, beneficiaryId }) {
  const transfer = await cashfreeRequest(mustGetPayoutConfig(), "/transfers", {
    body: {
      transfer_id: String(requestId).slice(0, 40),
      transfer_amount: Number(amountRupees),
      beneficiary_details: { beneficiary_id: beneficiaryId },
    },
  });
  return { id: transfer.cf_transfer_id ?? transfer.transfer_id, status: transfer.status };
}

// Full end-to-end payout, matching CashFree.service.js's
// createCashFreeXPayout call signature/return shape exactly ({ id,
// status } or throws) — every existing call site (admin.controller.js x2,
// projects.controller.js's completeProject) keeps working unchanged.
export async function createCashfreePayout({ requestId, amountRupees, payoutMethod, payoutDetails, worker }) {
  const beneficiaryId = await createOrFindBeneficiary({
    workerId: worker.id,
    name: worker.name,
    email: worker.email,
    phone: worker.phone,
    payoutMethod,
    payoutDetails,
  });
  return createTransfer({ requestId, amountRupees, beneficiaryId });
}
