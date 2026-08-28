import { transaction } from "../db/client.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import * as transactionsRepo from "../repositories/transactions.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as subscriptionPaymentsRepo from "../repositories/subscription_payments.repository.js";
import { emitProjectEvent } from "../realtime/events.js";
import { sendEscrowFundedSms } from "../services/sms.service.js";

function round2(n) {
  return Math.round(n * 100) / 100;
}

const BUSINESS_FEE_PCT_FALLBACK = 8;

// Shared by both confirmation paths that can grant FUNDS_SECURED for a
// captured payment: the signature-verified success callback
// (payments.controller.js's verifyPayment/verifyPaymentContract) and the
// server-to-server webhook (webhook.controller.js). A verified HMAC
// signature is real cryptographic proof Razorpay issued the payment, so
// verify is allowed to grant funds immediately for a fast UI — the webhook
// still runs independently afterwards as an idempotent backstop for the
// case where the browser never calls verify (tab closed, network drop),
// converging on this exact same code so there's one ledger-writing path to
// trust, not two that could drift.
export async function confirmProjectPayment({ orderId, paymentId }) {
  const result = await transaction(async (client) => {
    const project = await projectsRepo.findByRazorpayOrderId(client, orderId);
    if (!project) return null;
    if (project.status !== "PENDING_FUNDS") return { project, alreadyProcessed: true };

    const updatedProject = await projectsRepo.markFundsSecured(client, project.id, { paymentId });

    const budget = Number(project.budget);
    const businessFeePct = Number(project.business_fee_pct ?? BUSINESS_FEE_PCT_FALLBACK);
    const businessFee = round2(budget * (businessFeePct / 100));

    await transactionsRepo.insert(
      {
        projectId: project.id,
        workerId: project.worker_id,
        businessId: project.business_id,
        type: "FUNDS_SECURED",
        direction: "debit",
        amount: budget,
        fundsStatus: "HELD",
        referenceNote: `Funds secured via Razorpay (payment ${paymentId}) – ${project.title}`,
      },
      client
    );
    await transactionsRepo.insert(
      {
        projectId: project.id,
        workerId: project.worker_id,
        businessId: project.business_id,
        type: "PLATFORM_FEE_BUSINESS",
        direction: "debit",
        amount: businessFee,
        referenceNote: `Platform fee (${businessFeePct}%) – ${project.title}`,
      },
      client
    );

    return { project: updatedProject, alreadyProcessed: false };
  });

  if (!result) return false;

  if (!result.alreadyProcessed) {
    emitProjectEvent(result.project, "STATUS_CHANGED", { status: "FUNDS_SECURED", actorRole: "system" });

    if (result.project.worker_id) {
      const worker = await usersRepo.findById(result.project.worker_id);
      if (worker?.phone) {
        sendEscrowFundedSms(worker.phone, {
          project_title: result.project.title,
          amount: Number(result.project.budget),
        }).catch((err) => console.error("[sms] sendEscrowFundedSms threw:", err));
      }
    }
  }

  return true;
}

function computePeriodEnd(billingPeriod, from) {
  const end = new Date(from);
  if (billingPeriod === "YEARLY") end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  return end;
}

export async function confirmSubscriptionPayment({ orderId, paymentId }) {
  return await transaction(async (client) => {
    const subPayment = await subscriptionPaymentsRepo.findByRazorpayOrderId(client, orderId);
    if (!subPayment) return false;
    if (subPayment.status !== "PENDING") return true;

    const now = new Date();
    const periodEnd = computePeriodEnd(subPayment.billing_period, now);

    await subscriptionPaymentsRepo.markPaid(client, subPayment.id, {
      paymentId,
      periodStart: now,
      periodEnd,
    });
    await usersRepo.setSubscription(client, subPayment.user_id, {
      tier: subPayment.tier,
      expiresAt: periodEnd,
    });
    return true;
  });
}

// Tries project confirmation first, then subscription — a given order_id
// only ever belongs to one of the two order kinds this app issues.
export async function confirmPaymentByOrderId({ orderId, paymentId }) {
  const handledProject = await confirmProjectPayment({ orderId, paymentId });
  if (handledProject) return "PROJECT";

  const handledSubscription = await confirmSubscriptionPayment({ orderId, paymentId });
  if (handledSubscription) return "SUBSCRIPTION";

  return null;
}
