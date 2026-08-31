import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as usersRepo from "../repositories/users.repository.js";
import { toTeamMemberSelf } from "./auth.controller.js";

// GET /api/profiles/:id — the ONE unauthenticated read in this API.
// Queries public_user_profiles (schema.sql), a view with no email/phone
// columns at all — there's no field to accidentally leak here even if this
// controller's SELECT * were sloppy, because those columns don't exist in
// the view's result set.
export const getPublicProfile = asyncHandler(async (req, res) => {
  const profile = await usersRepo.findPublicProfileById(req.params.id);
  if (!profile) throw ApiError.notFound("Profile not found.");
  res.json({ data: profile });
});

// GET /api/profiles?role=worker — the browse-workers listing
// (BusinessWorkers.jsx). Same public_user_profiles view as the single-id
// route, so no PII is ever in the result set.
export const listPublicProfiles = asyncHandler(async (req, res) => {
  const profiles = await usersRepo.listPublicProfiles({ role: req.query.role });
  res.json({ data: profiles });
});

// PATCH /api/profiles/me — behind `guard`. req.user.id only; there is no
// :id param here, so a caller can never edit anyone else's profile.
export const updateOwnProfile = asyncHandler(async (req, res) => {
  const { avatarUrl, title, phone, name, profilePatch, hasCompletedOnboarding } = req.body;
  const selfId = req.user.teamMemberId ?? req.user.id;
  const hasProfilePatch = profilePatch && Object.keys(profilePatch).length > 0;

  // Personal identity (name/phone/avatar/title) always belongs to the real
  // individual — a team member must never silently overwrite the owner's.
  // profilePatch (company bio/industry/tagline for a business, or a
  // worker's own skills/rate) is the shared business identity, so for a
  // team member it's routed to the owner's row instead of their own.
  const selfUpdated = await usersRepo.updateSelf(selfId, { avatarUrl, title, phone, name, hasCompletedOnboarding });
  if (!selfUpdated) throw ApiError.notFound("User not found.");

  if (!req.user.teamMemberId) {
    const finalRow = hasProfilePatch ? await usersRepo.updateSelf(selfId, { profilePatch }) : selfUpdated;
    const { password_hash, ...safe } = finalRow;
    res.json({ data: safe });
    return;
  }

  const owner = hasProfilePatch
    ? await usersRepo.updateSelf(req.user.id, { profilePatch })
    : await usersRepo.findById(req.user.id);
  res.json({ data: toTeamMemberSelf(owner, selfUpdated) });
});

// PATCH /api/profiles/me/badge — self only, same as updateOwnProfile above.
// pinBadgeSchema already confirmed `level` is null or a real MILESTONES
// level; the one thing only the DB can answer — has this caller actually
// reached that level — is checked here against their real current_level
// (never trust the client's own claim of what level it is).
export const setPinnedBadge = asyncHandler(async (req, res) => {
  const { level } = req.body;
  const selfId = req.user.teamMemberId ?? req.user.id;

  if (level !== null) {
    const user = await usersRepo.findById(selfId);
    if (!user) throw ApiError.notFound("User not found.");
    if (user.current_level < level) {
      throw ApiError.badRequest(`You haven't reached Level ${level} yet.`);
    }
  }

  const updated = await usersRepo.setPinnedBadge(selfId, level);
  if (!updated) throw ApiError.notFound("User not found.");
  res.json({ data: { pinnedMilestoneLevel: updated.pinned_milestone_level } });
});
