import { Router } from "express";
import { guard } from "../middleware/guard.js";
import { validate } from "../middleware/validate.js";
import { authLimiter } from "../middleware/rateLimit.js";
import {
  registerSchema,
  loginSchema,
  googleAuthSchema,
  verifyOtpSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  notificationPrefsSchema,
  deactivateSelfSchema,
} from "../validators/auth.validators.js";
import {
  register,
  login,
  googleAuth,
  verifyOtp,
  resendOtp,
  forgotPassword,
  resetPassword,
  changePassword,
  updateNotificationPrefs,
  deactivateSelf,
  me,
} from "../controllers/auth.controller.js";

export const authRouter = Router();

// authLimiter — the real credential/OTP-guessing surface. Tight enough to
// actually stop brute-forcing a password or a 6-digit OTP, loose enough
// that a real user fumbling their password a few times never hits it.
// Not applied to /google or /me — those aren't guessable-secret endpoints.
authRouter.use(
  ["/register", "/verify-otp", "/resend-otp", "/login", "/forgot-password", "/reset-password"],
  authLimiter
);

// OTP only ever happens once, at registration, to verify the email address —
// sign-in is password-only (see login()'s email_verified guard).
authRouter.post("/register", validate(registerSchema), register);
authRouter.post("/verify-otp", validate(verifyOtpSchema), verifyOtp);
authRouter.post("/resend-otp", validate(resendOtpSchema), resendOtp);
authRouter.post("/login", validate(loginSchema), login);
authRouter.post("/google", validate(googleAuthSchema), googleAuth);

// Password recovery — the one gap left by dropping OTP-per-login. Public,
// same as register/login.
authRouter.post("/forgot-password", validate(forgotPasswordSchema), forgotPassword);
authRouter.post("/reset-password", validate(resetPasswordSchema), resetPassword);

authRouter.get("/me", guard, me);

// Settings page — Security & Auth (change password) and Danger Zone
// (self-deactivation). Both require a valid session, unlike the
// forgot/reset-password pair above. An impersonated session can't reach
// these anyway — guard.js now blocks every non-GET request while
// impersonating, not just these two.
authRouter.post("/change-password", guard, validate(changePasswordSchema), changePassword);
authRouter.patch("/notification-prefs", guard, validate(notificationPrefsSchema), updateNotificationPrefs);
authRouter.patch("/deactivate-self", guard, validate(deactivateSelfSchema), deactivateSelf);
