import bcrypt from "bcryptjs";
import { transaction } from "../db/client.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as usersRepo from "../repositories/users.repository.js";

// Real Enterprise-tier "Multi-User Access for your HR team" perk
// (migrations/051_business_team_members.sql). req.user.id is always the
// business's real id here — for a team member it's already resolved to
// the OWNER's id by guard.js (see auth.controller.js's issueToken), so
// "only the owner can add/remove" is exactly `!req.user.teamMemberId`: a
// team member's token always carries that claim, the owner's never does.

function assertOwner(req) {
  if (req.user.teamMemberId) {
    throw ApiError.forbidden("Only the business owner can manage team members.");
  }
}

async function assertEnterpriseActive(ownerId) {
  const owner = await usersRepo.findById(ownerId);
  const active = owner?.subscription_tier === "ENTERPRISE" && owner?.subscription_expires_at && new Date(owner.subscription_expires_at) > new Date();
  if (!active) {
    throw ApiError.forbidden("Multi-user access is an Enterprise plan perk — upgrade to add team members.");
  }
}

// GET /api/business/team — visible to the owner and every team member
// (full access includes seeing who else is on the team), not just the owner.
export const listTeam = asyncHandler(async (req, res) => {
  const data = await usersRepo.listTeamMembers(req.user.id);
  res.json({ data });
});

// POST /api/business/team — body: { name, email, password, phone? }.
// Owner-only, and only while Enterprise is actually active (re-checked
// here, not just trusted from the pricing page) — no seat cap.
export const addTeamMember = asyncHandler(async (req, res) => {
  assertOwner(req);
  await assertEnterpriseActive(req.user.id);

  const { name, email, password, phone } = req.body ?? {};
  if (!name || !String(name).trim()) throw ApiError.badRequest("Name is required.");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw ApiError.badRequest("A valid email is required.");
  if (!password || String(password).length < 8) throw ApiError.badRequest("Password must be at least 8 characters.");

  const existing = await usersRepo.findByEmail(email);
  if (existing) throw ApiError.badRequest(`An account with email ${email} already exists.`);

  const passwordHash = await bcrypt.hash(password, 10);
  const created = await transaction((client) =>
    usersRepo.insertTeamMember(client, {
      ownerId: req.user.id,
      name: String(name).trim(),
      email,
      phone,
      passwordHash,
    })
  );

  res.status(201).json({ data: created });
});

// DELETE /api/business/team/:id — deactivates a team member (same
// users.is_active mechanism Security Monitor's Ban User / admin Team
// Access' Remove already use — reversible by direct DB access, not a hard
// delete). Owner-only, per the explicit rule: a team member can't remove
// anyone, only the real owner can remove anyone.
export const removeTeamMember = asyncHandler(async (req, res) => {
  assertOwner(req);
  const { id } = req.params;

  const updated = await transaction((client) => usersRepo.setTeamMemberActive(client, id, req.user.id, false));
  if (!updated) throw ApiError.notFound("Team member not found.");

  res.json({ data: updated });
});
