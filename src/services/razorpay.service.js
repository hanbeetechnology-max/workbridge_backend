import crypto from "node:crypto";
import Razorpay from "razorpay";
import { ApiError } from "../utils/ApiError.js";

// Unlike push/email (silent no-op without config — see push.service.js),
// a missing Razorpay key must fail loud: every caller here is moving real
// money, so a misconfigured server should refuse the action outright
// rather than pretend to have taken it.
function mustGetConfig() {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) {
    throw ApiError.internal("Razorpay is not configured on this server.");
  }
  return { keyId, keySecret };
}

let client = null;
function getClient() {
  if (!client) {
    const { keyId, keySecret } = mustGetConfig();
    client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return client;
}

export function getPublicKeyId() {
  return mustGetConfig().keyId;
}

// The Razorpay SDK throws a raw {statusCode, error: {code, description,
// ...}} object, not an Error — left as-is, errorHandler.js treats anything
// that isn't an ApiError as "unexpected" and hides it behind a generic
// "Internal server error" (deliberate, so real bugs never leak internals
// to a client). Razorpay's own `description` is safe and useful to show
// (e.g. "Route feature not enabled for the merchant"), so every SDK call
// in this file is wrapped through here to turn that shape into a proper
// ApiError instead — this is the one, narrow exception to the generic
// handler's leak-prevention, not a change to that handler's behavior for
// every other error type in the app.
async function callRazorpay(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.error?.description) {
      const statusCode = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
      throw new ApiError(statusCode, err.error.description, { razorpayCode: err.error.code });
    }
    throw err;
  }
}

// receipt is our own project id — lets us find the order back from
// Razorpay's dashboard without a second lookup table.
export async function createOrder({ amountPaise, receipt, notes }) {
  return callRazorpay(() =>
    getClient().orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes,
    })
  );
}

export async function fetchOrderPayments(orderId) {
  return callRazorpay(() => getClient().orders.fetchPayments(orderId));
}

// Creates a Route linked account for a worker's payout destination.
// tnc_accepted: true is the worker's one real consent moment (see
// payments.controller.js) — pushing money via IMPS/NEFT never requires a
// per-transfer approval from the receiving side, only this one-time
// authorization to use the account as a payout destination at all.
export async function createLinkedAccount({ email, phone, legalBusinessName, beneficiaryName, bankAccountNumber, bankIfsc }) {
  return callRazorpay(() =>
    getClient().accounts.create({
      email,
      phone,
      type: "route",
      legal_business_name: legalBusinessName || beneficiaryName,
      business_type: "individual",
      contact_name: beneficiaryName,
      profile: {
        category: "professional_services",
        subcategory: "freelancer",
        addresses: { registered: {} },
      },
      bank_account: {
        name: beneficiaryName,
        ifsc: bankIfsc,
        account_number: bankAccountNumber,
      },
      tnc_accepted: true,
    })
  );
}

export async function fetchLinkedAccount(accountId) {
  return callRazorpay(() => getClient().accounts.fetch(accountId));
}

async function razorpayXRequest(path, body, idempotencyKey) {
  const keyId = process.env.RAZORPAYX_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAYX_KEY_SECRET?.trim();
  if (!keyId || !keySecret || !process.env.RAZORPAYX_ACCOUNT_NUMBER?.trim()) {
    throw ApiError.internal("RazorpayX payouts are not configured on this server.");
  }
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
      // RazorpayX's own idempotency mechanism — a retried call with the
      // same key (network timeout, a duplicate click, this dev server's
      // node --watch restarting mid-request) returns the ORIGINAL payout
      // instead of creating a second real one. Without this, every retry
      // was a genuinely new payout at Razorpay even when our own database
      // write afterward failed and the request looked "still pending" —
      // exactly what caused two real ₹1,000 test payouts for one request.
      ...(idempotencyKey ? { "X-Payout-Idempotency": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status >= 400 && response.status < 500 ? response.status : 502, payload?.error?.description || "RazorpayX payout failed.");
  }
  return payload;
}

export async function createRazorpayXPayout({ requestId, amountRupees, payoutMethod, payoutDetails, worker }) {
  // Mocks only when explicitly requested (RAZORPAYX_MOCK=true) or when
  // RazorpayX simply isn't configured on this machine — no longer gated on
  // NODE_ENV, since local dev now runs against Razorpay's real sandbox
  // (rzp_test_... keys, no real money moves) rather than always
  // simulating. A dev without RazorpayX credentials set still gets a safe
  // fallback instead of a hard crash.
  const hasCredentials = Boolean(
    process.env.RAZORPAYX_KEY_ID?.trim() && process.env.RAZORPAYX_KEY_SECRET?.trim() && process.env.RAZORPAYX_ACCOUNT_NUMBER?.trim()
  );
  const mockEnabled = process.env.RAZORPAYX_MOCK === "true" || !hasCredentials;
  if (mockEnabled) {
    return {
      id: `pout_mock_${requestId}_${Date.now()}`,
      status: "processed",
      amount: Math.round(Number(amountRupees) * 100),
      currency: "INR",
      mock: true,
    };
  }

  const contact = await razorpayXRequest("contacts", {
    name: worker.name,
    email: worker.email,
    contact: worker.phone,
    type: "employee",
    // RazorpayX caps reference_id at 40 chars — a bare UUID is 36, so any
    // added prefix (`worker_...`) pushed this over the limit and every
    // payout attempt failed with "reference id may not be greater than 40
    // characters." Kept short enough to leave room for callers who append
    // their own prefix elsewhere.
    reference_id: worker.id,
  });

  const details = String(payoutDetails).split(/[·,|]/).map((part) => part.trim()).filter(Boolean);
  const fundAccount = payoutMethod === "UPI"
    ? await razorpayXRequest("fund_accounts", {
        contact_id: contact.id,
        account_type: "vpa",
        vpa: { address: String(payoutDetails).trim() },
      })
    : await razorpayXRequest("fund_accounts", {
        contact_id: contact.id,
        account_type: "bank_account",
        bank_account: { name: worker.name, ifsc: details.at(-1), account_number: details[0] },
      });

  // requestId doubles as both reference_id (Razorpay's own display/lookup
  // field) and the idempotency key (the actual dedup mechanism) — it's
  // stable per real-world request (a withdrawal request's id, or
  // `${projectId}:payout`), so a retry of the SAME request reuses the SAME
  // key and Razorpay returns the original payout instead of creating one.
  const idempotencyKey = String(requestId).slice(0, 40);
  return razorpayXRequest(
    "payouts",
    {
      account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER.trim(),
      fund_account_id: fundAccount.id,
      amount: Math.round(Number(amountRupees) * 100),
      currency: "INR",
      mode: payoutMethod === "UPI" ? "UPI" : "IMPS",
      purpose: "payout",
      queue_if_low_balance: true,
      reference_id: idempotencyKey,
    },
    idempotencyKey
  );
}

// One payment can only ever be split by Route transfers once — this is
// the same call used for a normal payout (completeProject), a disputed
// release (resolveDispute), the only difference being which project's
// paymentId/amount the caller passes in. idempotencyKey is the caller's
// own stable string (e.g. `${projectId}:payout`) so a retried call after a
// network timeout can never create a second real transfer for the same
// project — Razorpay dedupes on this key server-side.
export async function createTransfer({ paymentId, accountId, amountPaise, notes, idempotencyKey }) {
  return callRazorpay(() =>
    getClient().payments.transfer(paymentId, {
      transfers: [
        {
          account: accountId,
          amount: amountPaise,
          currency: "INR",
          notes,
          on_hold: false,
        },
      ],
    }, idempotencyKey ? { "X-Razorpay-Idempotency-Key": idempotencyKey } : undefined)
  );
}

export async function createRefund({ paymentId, amountPaise, notes, idempotencyKey }) {
  return callRazorpay(() =>
    getClient().payments.refund(paymentId, {
      amount: amountPaise,
      notes,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    })
  );
}

// Verifies the X-Razorpay-Signature header against the RAW request body
// bytes (see app.js's express.raw() carve-out for this one route) — must
// be the exact bytes Razorpay signed, not a JSON.stringify of the parsed
// body, which can differ in whitespace/key order and silently fail
// verification. Timing-safe compare, not ===, so this can't leak the
// expected signature via response-time side channel.
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret || !signatureHeader) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// checkout.js's handler callback (order_id + payment_id + signature) is
// UI-optimistic only (see payments.controller.js) — this lets the
// frontend show "Payment confirmed" instantly without ever being trusted
// to grant FUNDS_SECURED itself; only the webhook does that.
export function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const { keySecret } = mustGetConfig();
  const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature ?? "", "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
