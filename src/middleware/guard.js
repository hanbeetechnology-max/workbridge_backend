import jwt from "jsonwebtoken";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as usersRepo from "../repositories/users.repository.js";

// Shared by the HTTP `guard` below and the Socket.IO auth handshake
// (realtime/socket.js) — one place decides what a valid token is.
export function verifyAccessToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, mustGetJwtSecret());
  } catch {
    throw ApiError.unauthorized("Invalid or expired token.");
  }

  if (!payload?.sub || !payload?.role) {
    throw ApiError.unauthorized("Token payload is missing required claims (sub, role).");
  }

  // impersonatorId only ever appears on a short-lived token issued by POST
  // /api/admin/impersonate (admin.controller.js) — it's baked into the
  // signed payload, never something a client can set itself, so its mere
  // presence here is proof "an admin is driving this account right now."
  // Only spread onto req.user when actually present, not as an explicit
  // `undefined` key on every normal request.
  return { id: payload.sub, role: payload.role, ...(payload.impersonatorId ? { impersonatorId: payload.impersonatorId } : {}) };
}

// Verifies the Bearer JWT and attaches { id, role } to req.user. Applied to
// every router except /api/profiles (public profiles are the one resource
// that's readable unauthenticated — see routes/profiles.routes.js).
//
// Token payload contract (issued at login, not built here — out of scope
// for this skeleton): { sub: userId, role: "worker" | "business" | "admin" }
export const guard = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw ApiError.unauthorized("Missing or malformed Authorization header — expected 'Bearer <token>'.");
  }

  req.user = verifyAccessToken(token);

  // A ban (Security Monitor's "Ban User" action) needs to stop someone
  // immediately, not just block their next login — an already-issued JWT
  // stays cryptographically valid until it expires, so this is checked on
  // every request, not only at sign-in.
  const active = await usersRepo.isActive(req.user.id);
  if (!active) {
    throw ApiError.forbidden("This account has been suspended.");
  }

  // Impersonation ("See what they see" — POST /api/admin/impersonate) is
  // for support debugging, never for acting on someone's behalf. This used
  // to be an opt-in middleware (blockDuringImpersonation) applied to just 3
  // routes — a real gap, since block/unblock, raising a dispute, escrow
  // funding, and everything else were left completely unprotected. Now it's
  // the default for every guarded route: an impersonated session can GET
  // anything (see exactly what the user sees) but can never write anything.
  // Starting/ending impersonation itself is unaffected — POST
  // /api/admin/impersonate is called by the real admin's own (not yet
  // impersonated) session, and ending it is a pure client-side token swap
  // with no API call at all (see AuthContext.jsx's endImpersonation).
  if (req.user.impersonatorId && req.method !== "GET" && req.method !== "HEAD") {
    throw ApiError.forbidden("This action isn't available during an impersonated session — you can look, but not act on this account's behalf.");
  }

  next();
});

// requireRole("business") — use after `guard` on routes only one role may
// call (e.g. only a business can post a job or release a payment).
export function requireRole(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user) {
      throw ApiError.unauthorized("guard middleware must run before requireRole.");
    }
    if (!allowedRoles.includes(req.user.role)) {
      throw ApiError.forbidden(`This action requires one of: ${allowedRoles.join(", ")}.`);
    }
    next();
  };
}

// requireReverify — gates a sensitive CHANGE (e.g. updating an
// already-saved payout destination) behind a fresh password re-proof, on
// top of the normal `guard` session check. Expects an X-Reverify-Token
// header, issued by POST /api/auth/verify-password after the user just
// typed their password again. Only meant for a subset of a route's calls
// (e.g. "changing" vs "first-time adding" a payout destination) — callers
// check that distinction themselves before invoking this, it isn't wired
// into the router chain unconditionally.
export function requireReverify(req) {
  const token = req.headers["x-reverify-token"];
  if (!token) {
    throw ApiError.unauthorized("Please verify your password before changing this — it looks like you haven't yet.");
  }

  let payload;
  try {
    payload = jwt.verify(token, mustGetJwtSecret());
  } catch {
    throw ApiError.unauthorized("Password verification expired — please verify your password again.");
  }

  if (payload?.purpose !== "reverify" || payload?.sub !== req.user.id) {
    throw ApiError.unauthorized("Invalid password verification — please verify your password again.");
  }
}

function mustGetJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw ApiError.internal("JWT_SECRET is not configured on the server.");
  }
  return secret;
}
