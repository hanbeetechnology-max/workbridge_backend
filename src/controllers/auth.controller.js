import bcrypt from "bcryptjs";
import { randomBytes, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { transaction } from "../db/client.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as authRepo from "../repositories/auth.repository.js";
import { sendOtpEmail, sendPasswordResetEmail, isEmailConfigured } from "../services/email.service.js";

const SALT_ROUNDS = 10;
const TOKEN_TTL = "7d";
const OTP_TTL_MINUTES = 10;
const PASSWORD_RESET_TTL_MINUTES = 15;
const OTP_RESEND_SECONDS = 60;

// The caller's own profile — allowed to include email/phone (unlike
// public_user_profiles, which strips them for everyone else) but password_hash
// must never leave this module.
function toSelf(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

// A business team member's row has no verified/subscription_tier/company
// profile of its own — that's all on the OWNER's row, which is what
// req.user.id resolves to for them (see guard.js). Rather than show the
// frontend a team member's own (unverified, FREE-tier, blank-profile) row
// and break every "is this business verified/Enterprise" check across the
// app, this merges the owner's real business state with the team member's
// own personal identity (name/email/phone/avatar — who's actually signed
// in on this device), so the UI stays both correct and personal.
export function toTeamMemberSelf(ownerRow, memberRow) {
  const { password_hash, ...ownerSafe } = ownerRow;
  return {
    ...ownerSafe,
    name: memberRow.name,
    email: memberRow.email,
    phone: memberRow.phone,
    avatar_url: memberRow.avatar_url,
    isTeamMember: true,
    teamMemberId: memberRow.id,
  };
}

function issueToken(user) {
  // A team member's row (migrations/051_business_team_members.sql) signs
  // its session with the OWNER's id as `sub` — every existing business
  // feature keeps using req.user.id unchanged and transparently operates
  // as the shared business. teamMemberId carries the real individual's own
  // id for the few endpoints that must never resolve to the owner (guard.js
  // reads it back into req.user.teamMemberId).
  const claims = user.business_owner_id
    ? { sub: user.business_owner_id, role: user.role, teamMemberId: user.id }
    : { sub: user.id, role: user.role };
  return jwt.sign(claims, mustGetJwtSecret(), { expiresIn: TOKEN_TTL });
}

function generateOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// mode is gone — OTP only ever means "registration email verification" now,
// so the HMAC namespace only needs identifier + role.
function hashOtp(identifier, role, otp) {
  const secret = process.env.OTP_SECRET || mustGetJwtSecret();
  return createHmac("sha256", secret)
    .update(`${identifier}:${role}:${otp}`)
    .digest("hex");
}

function otpMatches(storedHash, candidateHash) {
  const stored = Buffer.from(storedHash, "utf8");
  const candidate = Buffer.from(candidateHash, "utf8");
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

async function assertSignupAvailable({ email, phone }) {
  const [emailUser, phoneUser] = await Promise.all([
    usersRepo.findByEmail(email),
    phone ? usersRepo.findByPhone(phone) : null,
  ]);
  if (emailUser) throw ApiError.conflict("An account with this email already exists.");
  if (phoneUser) throw ApiError.conflict("An account with this phone number already exists.");
}

// Send-or-console-log-or-throw — no DB side effects of its own. Callers
// decide what to clean up if this throws (register wipes the pending
// signup entirely; resendOtp leaves it in place so a signup in progress
// never loses its details just because one delivery attempt failed).
async function deliverOtp({ email, role, otpCode, expiresInMinutes = OTP_TTL_MINUTES, sendFn = sendOtpEmail }) {
  if (isEmailConfigured()) {
    await sendFn({ to: email, otpCode, expiresInMinutes });
  } else if (process.env.NODE_ENV !== "production") {
    console.log(`[auth:otp] ${email} (${role}) -> ${otpCode}`);
  } else {
    throw ApiError.internal("OTP email delivery is not configured.");
  }
}

// POST /api/auth/register — public. role is restricted to worker|business by
// registerSchema; there is no path from this endpoint to an admin account.
//
// Does NOT touch the permanent `users` table yet — signup details + the OTP
// are held in pending_signups until verify-otp succeeds. If this is
// abandoned (tab closed, code never entered), nothing about this person is
// ever stored permanently, and the email/phone stay immediately available
// to register again.
export const register = asyncHandler(async (req, res) => {
  const { role, name, email, phone, password } = req.body;
  await assertSignupAvailable({ email, phone });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

  // A previous abandoned attempt for this exact email is simply replaced.
  await authRepo.deletePendingSignup(email);
  await authRepo.createPendingSignup({
    email,
    role,
    name,
    phone,
    passwordHash,
    otpCode: hashOtp(email, role, otpCode),
    expiresAt,
  });

  try {
    await deliverOtp({ email, role, otpCode });
  } catch (err) {
    await authRepo.deletePendingSignup(email); // a clean retry via register should always just work
    throw err;
  }

  res.status(201).json({
    data: {
      message: `A verification code has been sent to ${email}.`,
      email,
      expiresInSeconds: OTP_TTL_MINUTES * 60,
      resendAfterSeconds: OTP_RESEND_SECONDS,
    },
  });
});

// POST /api/auth/register-admin — public, but deliberately not linked from
// anywhere in the app (no button on /auth or /admin-login points here —
// see AuthPage.jsx/the standalone AdminSignupPage). Same OTP-verified
// pending-signup flow as register() above, hardcoded to role: "admin"
// server-side (never trusted from the client, same as every other
// role-sensitive write in this file) — the one deliberate exception to
// registerSchema's "public registration can never create an admin account"
// comment. verifyOtp below gives every admin created this way zero real
// permissions (can_ban_users/can_release_funds both false) regardless of
// what a CLI-provisioned admin defaults to — a Super Admin has to
// deliberately promote them via PATCH /api/admin/users/:id/permissions
// before they can do anything real.
export const registerAdmin = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  await assertSignupAvailable({ email });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

  await authRepo.deletePendingSignup(email);
  await authRepo.createPendingSignup({
    email,
    role: "admin",
    name,
    phone: undefined,
    passwordHash,
    otpCode: hashOtp(email, "admin", otpCode),
    expiresAt,
  });

  try {
    await deliverOtp({ email, role: "admin", otpCode });
  } catch (err) {
    await authRepo.deletePendingSignup(email);
    throw err;
  }

  res.status(201).json({
    data: {
      message: `A verification code has been sent to ${email}.`,
      email,
      expiresInSeconds: OTP_TTL_MINUTES * 60,
      resendAfterSeconds: OTP_RESEND_SECONDS,
    },
  });
});

// POST /api/auth/resend-otp — public. body: { email }
export const resendOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;

  const pending = await authRepo.findPendingSignup(email);
  if (!pending) {
    const existingUser = await usersRepo.findByEmail(email);
    if (existingUser) throw ApiError.badRequest("This account is already verified — please sign in.");
    throw ApiError.notFound("No pending registration found for this email.");
  }

  const ageSeconds = (Date.now() - new Date(pending.created_at).getTime()) / 1000;
  if (ageSeconds < OTP_RESEND_SECONDS) {
    throw new ApiError(
      429,
      `Please wait ${Math.ceil(OTP_RESEND_SECONDS - ageSeconds)} seconds before requesting another code.`
    );
  }

  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
  await authRepo.refreshPendingSignupOtp(email, { otpCode: hashOtp(email, pending.role, otpCode), expiresAt });

  // Deliberately NOT deleting the pending signup on failure here — the
  // whole point of resend is to retry without losing name/phone/password.
  await deliverOtp({ email, role: pending.role, otpCode });

  res.json({
    data: {
      message: `A verification code has been sent to ${email}.`,
      email,
      expiresInSeconds: OTP_TTL_MINUTES * 60,
      resendAfterSeconds: OTP_RESEND_SECONDS,
    },
  });
});

// POST /api/auth/verify-otp — public. body: { email, otp }. This is the one
// place a fresh signup's `users` row actually gets created — the account
// exists in the permanent table from this moment on, already verified.
export const verifyOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  const pending = await authRepo.findPendingSignup(email);
  if (!pending || new Date(pending.expires_at).getTime() <= Date.now()) {
    if (pending) await authRepo.deletePendingSignup(email);
    throw ApiError.unauthorized("This verification code is invalid or has expired.");
  }

  if (!otpMatches(pending.otp_code, hashOtp(email, pending.role, otp))) {
    throw ApiError.unauthorized("This verification code is invalid or has expired.");
  }

  // Defensive re-check — cheap, and covers the rare case where the email or
  // phone got claimed by someone else between register and this moment.
  await assertSignupAvailable({ email: pending.email, phone: pending.phone });

  let user;
  try {
    user = await usersRepo.create({
      role: pending.role,
      name: pending.name,
      email: pending.email,
      phone: pending.phone,
      passwordHash: pending.password_hash,
      emailVerified: true,
      // Self-registered admins (registerAdmin above) start at zero real
      // permissions — Tier 1, promotable by a Super Admin later. Doesn't
      // affect worker/business (these columns are meaningless for them) or
      // CLI-provisioned admins (create-admin.js writes directly, never
      // goes through this pending-signup/OTP path at all).
      ...(pending.role === "admin" ? { canBanUsers: false, canReleaseFunds: false } : {}),
    });
  } catch (err) {
    if (err.code === "23505") throw ApiError.conflict("An account with this email already exists.");
    throw err;
  }

  await authRepo.deletePendingSignup(email);

  // Starts the Daily Streak Engine at 1 from the very first session, rather
  // than showing "0 Day Streak" until tomorrow's login — see
  // users.repository.js's recordLogin.
  const loggedInUser = await usersRepo.recordLogin(user.id);
  res.status(201).json({ data: { token: issueToken(loggedInUser), user: toSelf(loggedInUser) } });
});

// POST /api/auth/login — public. body: { email, password }. Password only —
// no OTP. Blocked with 403 (distinct from the 401 for bad credentials) until
// email_verified is true, so the registration OTP step isn't purely
// cosmetic — otherwise anyone could register with an email they don't
// control and use the platform without ever proving it.
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await usersRepo.findByEmail(email);
  const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !passwordMatches) {
    throw ApiError.unauthorized("Invalid email or password.");
  }
  if (!user.email_verified) {
    throw ApiError.forbidden("Please verify your email before signing in.");
  }
  if (!user.is_active) {
    throw ApiError.forbidden("This account has been suspended. Contact support if you believe this is a mistake.");
  }

  // The Daily Streak Engine's real trigger — every successful login
  // compares against the previous one and updates current_streak/
  // last_login_at atomically (see users.repository.js's recordLogin).
  const loggedInUser = await usersRepo.recordLogin(user.id);

  // Multi-User Access (migrations/051_business_team_members.sql) is an
  // Enterprise-tier perk, not a permanent grant — re-checked at every
  // login (not on every request; a 7-day token can outlive a same-session
  // downgrade, an accepted tradeoff for not adding a DB round trip to
  // every guarded request) so a lapsed/downgraded plan actually stops new
  // team-member sign-ins rather than silently keeping seats forever.
  if (loggedInUser.business_owner_id) {
    const owner = await usersRepo.findById(loggedInUser.business_owner_id);
    const ownerTierActive =
      owner?.subscription_tier === "ENTERPRISE" && owner?.subscription_expires_at && new Date(owner.subscription_expires_at) > new Date();
    if (!owner || !owner.is_active || !ownerTierActive) {
      throw ApiError.forbidden("Your business's Enterprise plan isn't active — team access is paused. Contact your business owner.");
    }
    res.json({ data: { token: issueToken(loggedInUser), user: toTeamMemberSelf(owner, loggedInUser) } });
    return;
  }

  res.json({ data: { token: issueToken(loggedInUser), user: toSelf(loggedInUser) } });
});

// Built once and reused — verifyIdToken() is cheap to call repeatedly, the
// client itself doesn't need to be. Only constructed when GOOGLE_CLIENT_ID
// is actually set, so a server with it unconfigured never even imports a
// broken client.
let googleClient = null;
function getGoogleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;
  if (!googleClient) googleClient = new OAuth2Client(clientId);
  return googleClient;
}

// A random, cryptographically unguessable password for accounts created via
// Google — password_hash stays NOT NULL (see migrations/029_google_oauth.sql)
// without ever being a real, typeable password; login() can never succeed
// against it because bcrypt.compare needs the original 32 random bytes, not
// just "any string."
async function generateUnusablePasswordHash() {
  return bcrypt.hash(randomBytes(32).toString("hex"), SALT_ROUNDS);
}

// POST /api/auth/google — public. body: { credential, role? }. `credential`
// is the ID token Google Identity Services hands the frontend after the
// user picks an account — verified here server-side against
// GOOGLE_CLIENT_ID, never trusted as-is. `role` is only used the FIRST time
// this Google account (or its email) is seen, to create the right kind of
// account; an existing user's real role always wins, regardless of what the
// frontend sends.
export const googleAuth = asyncHandler(async (req, res) => {
  const client = getGoogleClient();
  if (!client) throw ApiError.internal("Google sign-in is not configured on the server.");

  const { credential, role } = req.body;

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw ApiError.unauthorized("Could not verify that Google sign-in — please try again.");
  }

  if (!payload?.email_verified) {
    throw ApiError.unauthorized("Your Google account's email isn't verified.");
  }

  const email = payload.email.trim().toLowerCase();
  const googleId = payload.sub;

  let user = await usersRepo.findByGoogleId(googleId);

  if (!user) {
    const existingByEmail = await usersRepo.findByEmail(email);
    if (existingByEmail) {
      // Same person, previously signed up with a password — link this
      // Google account to that same row instead of erroring or duplicating.
      user = await usersRepo.linkGoogleId(existingByEmail.id, googleId);
    } else {
      // Brand new account. `role` only matters on this branch — see the
      // function comment above.
      if (role !== "worker" && role !== "business") {
        throw ApiError.badRequest("Choose Freelancer or Business to finish creating your account.");
      }
      const passwordHash = await generateUnusablePasswordHash();
      try {
        user = await usersRepo.create({
          role,
          name: payload.name || email.split("@")[0],
          email,
          phone: null,
          passwordHash,
          emailVerified: true,
          googleId,
          avatarUrl: payload.picture || null,
          hasUsablePassword: false,
        });
      } catch (err) {
        if (err.code === "23505") throw ApiError.conflict("An account with this email already exists.");
        throw err;
      }
    }
  }

  if (!user.is_active) {
    throw ApiError.forbidden("This account has been suspended. Contact support if you believe this is a mistake.");
  }

  const loggedInUser = await usersRepo.recordLogin(user.id);
  res.json({ data: { token: issueToken(loggedInUser), user: toSelf(loggedInUser) } });
});

// POST /api/auth/forgot-password — public. body: { email }. Reuses the
// auth_otps table (unused since sign-in dropped OTP — see auth.repository.js)
// for a 15-minute reset code. Responds with the same generic message
// whether or not the account exists, so this endpoint can't be used to
// confirm which emails are registered.
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const genericResponse = {
    data: {
      message: `If an account exists for ${email}, a password reset code has been sent.`,
      email,
      expiresInSeconds: PASSWORD_RESET_TTL_MINUTES * 60,
      resendAfterSeconds: OTP_RESEND_SECONDS,
    },
  };

  const user = await usersRepo.findByEmail(email);
  if (!user) {
    res.json(genericResponse);
    return;
  }

  const previous = await authRepo.findLatestPasswordResetOtp(email, user.role);
  if (previous) {
    const ageSeconds = (Date.now() - new Date(previous.created_at).getTime()) / 1000;
    if (ageSeconds < OTP_RESEND_SECONDS) {
      throw new ApiError(
        429,
        `Please wait ${Math.ceil(OTP_RESEND_SECONDS - ageSeconds)} seconds before requesting another code.`
      );
    }
  }

  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000).toISOString();

  await authRepo.deletePasswordResetOtp(email, user.role);
  await authRepo.createPasswordResetOtp({ email, role: user.role, code: hashOtp(email, user.role, otpCode), expiresAt });

  await deliverOtp({
    email,
    role: user.role,
    otpCode,
    expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    sendFn: sendPasswordResetEmail,
  });

  res.json(genericResponse);
});

// POST /api/auth/reset-password — public. body: { email, otp, newPassword }.
// Success logs the user in immediately (same auto-login pattern as
// verify-otp) — no separate login step needed after a reset.
export const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;

  const user = await usersRepo.findByEmail(email);
  if (!user) throw ApiError.unauthorized("This code is invalid or has expired.");

  const otpRow = await authRepo.findLatestPasswordResetOtp(email, user.role);
  if (!otpRow || new Date(otpRow.expires_at).getTime() <= Date.now()) {
    await authRepo.deletePasswordResetOtp(email, user.role);
    throw ApiError.unauthorized("This code is invalid or has expired.");
  }

  if (!otpMatches(otpRow.otp_code, hashOtp(email, user.role, otp))) {
    throw ApiError.unauthorized("This code is invalid or has expired.");
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const updatedUser = await usersRepo.updatePassword(user.id, passwordHash);

  await authRepo.deletePasswordResetOtp(email, user.role);
  res.json({ data: { token: issueToken(updatedUser), user: toSelf(updatedUser) } });
});

// GET /api/auth/me — behind `guard`. req.user.id comes from the verified
// JWT, never a client-supplied param. For a business team member,
// req.user.id is the OWNER's id (shared business identity) — this merges
// in their own real name/email/phone (see toTeamMemberSelf) rather than
// showing them the owner's.
export const me = asyncHandler(async (req, res) => {
  if (req.user.teamMemberId) {
    const [owner, member] = await Promise.all([usersRepo.findById(req.user.id), usersRepo.findById(req.user.teamMemberId)]);
    if (!owner || !member) throw ApiError.notFound("User not found.");
    res.json({ data: toTeamMemberSelf(owner, member) });
    return;
  }
  const user = await usersRepo.findById(req.user.id);
  if (!user) throw ApiError.notFound("User not found.");
  res.json({ data: toSelf(user) });
});

// POST /api/auth/change-password — behind `guard`. Settings page's Security
// tab. Distinct from forgot-password/reset-password (those are for a
// logged-out user with no way to prove identity except an emailed code;
// this one already has a valid session, so it proves identity with the
// current password instead).
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  // Always the real logged-in individual's own row — for a team member,
  // req.user.id is the shared business (owner) id, and this must never be
  // able to touch the owner's password (see guard.js/issueToken).
  const selfId = req.user.teamMemberId ?? req.user.id;
  const user = await usersRepo.findById(selfId);
  if (!user) throw ApiError.notFound("User not found.");

  // Google-only accounts (has_usable_password = false) hold a random,
  // never-typeable password_hash (see generateUnusablePasswordHash above) —
  // there is no real "current password" for them to prove, so skip that
  // check entirely rather than reject every value a real user could ever
  // type. The route is already behind `guard`, so the JWT alone is the
  // proof of identity for this one case.
  if (user.has_usable_password) {
    if (!currentPassword) throw ApiError.badRequest("Enter your current password.");
    const matches = await bcrypt.compare(currentPassword, user.password_hash);
    if (!matches) throw ApiError.unauthorized("Current password is incorrect.");
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await usersRepo.updatePassword(user.id, passwordHash);

  res.json({ data: { message: "Password updated." } });
});

const REVERIFY_TTL_MINUTES = 5;

// POST /api/auth/verify-password — behind `guard`. Proves "the person at
// this keyboard right now knows the account password," for gating a
// sensitive change (e.g. a worker's payout destination) beyond just having
// a valid session — a shared/unlocked device has the JWT but not the
// password. Returns a short-lived, single-purpose token the caller then
// attaches (X-Reverify-Token) to the actual change request; middleware.js's
// requireReverify checks it's for THIS user and hasn't expired. Deliberately
// separate from login's password check (a logged-in session, not a
// logged-out one) and from changePassword above (which changes the
// password itself, not a re-proof of the existing one).
export const verifyPasswordForReauth = asyncHandler(async (req, res) => {
  const { password } = req.body ?? {};
  if (!password) throw ApiError.badRequest("Enter your password.");

  // The real logged-in individual's own password (a team member doesn't
  // know the owner's) — but the issued token's `sub` below deliberately
  // stays req.user.id (the shared business id), since that's what
  // requireReverify compares against for the actual business-level action
  // this gates (e.g. changing a saved payout destination).
  const selfId = req.user.teamMemberId ?? req.user.id;
  const user = await usersRepo.findById(selfId);
  if (!user) throw ApiError.notFound("User not found.");

  if (!user.has_usable_password) {
    throw ApiError.badRequest("Your account uses Google Sign-In and has no password to verify — contact support to change this.");
  }

  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) throw ApiError.unauthorized("Incorrect password.");

  const reverifyToken = jwt.sign({ sub: req.user.id, purpose: "reverify" }, mustGetJwtSecret(), { expiresIn: `${REVERIFY_TTL_MINUTES}m` });
  res.json({ data: { reverifyToken, expiresInSeconds: REVERIFY_TTL_MINUTES * 60 } });
});

// PATCH /api/auth/notification-prefs — Settings > Notifications' per-category
// toggles. Merges into the existing JSONB (see usersRepo.updateNotificationPrefs)
// so toggling one category never resets the others.
export const updateNotificationPrefs = asyncHandler(async (req, res) => {
  // Deliberately shared (req.user.id, not the team member's own row) —
  // push subscriptions (push.controller.js) and the notification feed
  // itself (notifications.controller.js) are both keyed by the shared
  // business id, so prefs have to live there too or a team member's
  // toggle would silently do nothing (checked against a row nothing ever
  // reads).
  const updated = await usersRepo.updateNotificationPrefs(req.user.id, req.body);
  const { password_hash, ...safe } = updated;
  res.json({ data: safe });
});

// PATCH /api/auth/deactivate-self — behind `guard`. Settings page's Danger
// Zone. Reuses the exact same users.is_active mechanism Security Monitor's
// admin "Ban User" action uses (usersRepo.setActive) — the only difference
// is who's flipping the switch. Reversible by an admin (Unban), unlike a
// real account deletion, which the schema's ON DELETE RESTRICT foreign keys
// don't actually support.
export const deactivateSelf = asyncHandler(async (req, res) => {
  // Must never resolve to the owner for a team member — req.user.id is the
  // shared business id; deactivating THAT would take down the whole
  // business account, not just this one login. A team member who wants to
  // leave deactivates only their own row.
  const selfId = req.user.teamMemberId ?? req.user.id;
  await transaction((client) => usersRepo.setActive(client, selfId, false));
  res.json({ data: { message: "Account deactivated." } });
});

function mustGetJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw ApiError.internal("JWT_SECRET is not configured on the server.");
  return secret;
}
