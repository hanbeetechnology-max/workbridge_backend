import { z } from "zod";

// Deliberately excludes "admin" — public registration can never create an
// admin account. registerAdminSchema below is the one deliberate exception,
// on its own dedicated, unlinked route — see auth.controller.js's
// registerAdmin.
export const registerSchema = z.object({
  role: z.enum(["worker", "business"]),
  name: z.string().trim().min(2).max(200),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().regex(/^\d{10}$/, "Enter exactly 10 numeric digits").optional(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// No `role` field — registerAdmin hardcodes "admin" server-side, never
// trusted from the client, same as every other role-sensitive endpoint in
// this file.
export const registerAdminSchema = z.object({
  name: z.string().trim().min(2).max(200),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, "Password is required"),
});

// role is only actually used the first time this Google account is seen
// (see auth.controller.js's googleAuth) — optional here so a returning
// user's request doesn't need it, but still restricted to worker|business
// so this endpoint can never be used to create an admin either.
export const googleAuthSchema = z.object({
  credential: z.string().min(20, "Missing Google credential."),
  role: z.enum(["worker", "business"]).optional(),
});

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.");

export const verifyOtpSchema = z.object({
  email: emailSchema,
  otp: z.string().trim().regex(/^[0-9]{6}$/, "Enter the 6-digit code."),
});

export const resendOtpSchema = z.object({
  email: emailSchema,
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  email: emailSchema,
  otp: z.string().trim().regex(/^[0-9]{6}$/, "Enter the 6-digit code."),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

// Settings page's Security & Auth tab — a logged-in password change,
// distinct from the forgot-password/reset-password OTP flow above.
// currentPassword is optional here — Google-only accounts (no real password
// ever set, see has_usable_password) hit this same endpoint to SET their
// first password instead of changing one; the controller decides whether to
// require/verify it based on that flag.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

// Settings > Notifications — only these three keys exist as toggles today
// (see events.js's pushCategoryFor); .partial() so a client can send just
// the one category it changed.
export const notificationPrefsSchema = z
  .object({ chat: z.boolean(), projects: z.boolean(), payments: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Provide at least one preference to update.");

// Settings page's Danger Zone — self-service deactivation (not permanent
// deletion, see usersRepo.setActive's callers). Requires typing a literal
// confirmation phrase so it can't be triggered by an accidental click.
export const deactivateSelfSchema = z.object({
  confirmation: z.literal("DEACTIVATE", { message: 'Type "DEACTIVATE" to confirm.' }),
});
