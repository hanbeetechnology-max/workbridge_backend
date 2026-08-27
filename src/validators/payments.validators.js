import { z } from "zod";

export const verifyPaymentSchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
});

// IFSC: 4 letters (bank code) + 0 + 6 alphanumerics (branch code) — the
// standard Indian bank format Razorpay itself validates against.
const ifscSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid IFSC code (e.g. HDFC0001234)");

export const subscriptionCheckoutSchema = z.object({
  tier: z.enum(["GROWTH", "ENTERPRISE", "PRO", "ELITE"]),
  billingPeriod: z.enum(["MONTHLY", "YEARLY"]),
});

// UPI VPA (e.g. name@bank) or a "accountNumber · ifsc" string — same free-form
// shape wallet.controller.js's withdraw already accepts for payoutDetails,
// validated loosely here since the real check (does this account exist) can
// only happen at Razorpay's end when a payout is actually attempted.
export const payoutAccountSchema = z.object({
  payoutMethod: z.enum(["UPI", "BANK_TRANSFER"]),
  payoutDetails: z.string().trim().min(3).max(200),
});

export const linkRouteAccountSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^\d{10}$/, "Enter a valid 10-digit phone number"),
  beneficiaryName: z.string().trim().min(2).max(120),
  legalBusinessName: z.string().trim().max(120).optional(),
  bankAccountNumber: z.string().trim().regex(/^\d{9,18}$/, "Enter a valid bank account number"),
  bankIfsc: ifscSchema,
});
