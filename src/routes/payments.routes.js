import { Router } from "express";
import { guard, requireRole } from "../middleware/guard.js";
import { validate } from "../middleware/validate.js";
import { payoutAccountSchema, subscriptionCheckoutSchema, verifyPaymentSchema } from "../validators/payments.validators.js";
import {
  // createRouteAccount, getRouteAccount — CashFree Route linked-account
  // feature, disabled below. Cashfree has no equivalent (confirmed: only
  // Easy Split is Route-like and neither worker nor business side needs
  // it — see project_cashfree_master_verification_flow memory), and this
  // was already gated "blocked pending RBI review" before the migration.
  createOrder,
  createSubscriptionCheckout,
  getPayoutDetails,
  getSubscriptionStatus,
  savePayoutDetails,
  verifyPayment,
  verifyPaymentContract,
} from "../controllers/payments.controller.js";

// JWT-guarded, unlike webhook.routes.js — everything here is a normal
// authenticated user action, not a CashFree-to-server callback.
export const paymentsRouter = Router();

paymentsRouter.use(guard);

paymentsRouter.post("/create-order", createOrder);
paymentsRouter.post("/verify-payment", verifyPaymentContract);
paymentsRouter.post("/verify", validate(verifyPaymentSchema), verifyPayment);
// paymentsRouter.post("/route-account", requireRole("worker"), validate(linkRouteAccountSchema), createRouteAccount);
// paymentsRouter.get("/route-account", requireRole("worker"), getRouteAccount);
paymentsRouter.post("/payout-account", requireRole("worker"), validate(payoutAccountSchema), savePayoutDetails);
paymentsRouter.get("/payout-account", requireRole("worker"), getPayoutDetails);
// Either role — createSubscriptionCheckout looks the caller's role up from
// req.user.role itself to pick worker vs business tier pricing.
paymentsRouter.post("/subscription-checkout", validate(subscriptionCheckoutSchema), createSubscriptionCheckout);
paymentsRouter.get("/subscription-status", getSubscriptionStatus);
