// MASTER_ECONOMY_PLAN.md Part 2 — the Exponential XP Math Engine. Pure,
// deterministic math only: no DB access, no side effects. Mirrors the
// exact BASE/GROWTH constants and formula documented there, so every
// number this produces is reproducible by hand from the design doc's own
// sample table (Level 10 ≈ 2,480 cumulative XP, Level 50 ≈ 244,000, Level
// 100 ≈ 1,760,000, etc.).
//
// This is the authoritative place `current_level` gets derived from
// `xp` — whatever backend logic increments a user's xp (the Phase 1
// quality-gate / Momentum event writers, not built yet) should call
// calculateLevel() and persist its currentLevel, rather than each caller
// re-deriving the curve independently.

const BASE = 10;
const GROWTH = 1.85;
const MAX_LEVEL = 200;

// Cumulative XP required to REACH a given level from zero — Total(L) in
// the design doc, a continuous approximation of the discrete per-level
// sum (see Part 2's own caveat). Per-level deltas derived from this may
// differ slightly from Part 2's illustrative ΔXP(L) table for the same
// reason; both are the same intentional approximation, not a bug.
function totalXpForLevel(level) {
  return (BASE / (GROWTH + 1)) * Math.pow(level, GROWTH + 1);
}

// calculateLevel(xp) — inverts totalXpForLevel to answer "given this much
// XP, what level is that?" Returns the level plus the XP thresholds on
// either side of it, so no caller ever has to re-derive the curve itself.
// Clamped to [1, 200] — Level 200 ("Diamond"/"Legend") is a hard prestige
// cap per the design doc, not an open-ended curve.
export function calculateLevel(xp) {
  const safeXp = Math.max(0, Number(xp) || 0);

  const rawLevel = Math.pow(safeXp / (BASE / (GROWTH + 1)), 1 / (GROWTH + 1));
  const currentLevel = Math.min(MAX_LEVEL, Math.max(1, Math.floor(rawLevel)));

  const xpForCurrentLevel = totalXpForLevel(currentLevel);
  const xpForNextLevel = currentLevel >= MAX_LEVEL ? xpForCurrentLevel : totalXpForLevel(currentLevel + 1);

  return { currentLevel, xpForCurrentLevel, xpForNextLevel };
}

// getTierData(level) — the UI Abstraction Ladder (MASTER_ECONOMY_PLAN.md
// Part 5a). Deliberately returns ONLY a display name and a color theme —
// never a fee percentage. The platform fee is flat (projects.platform_fee_pct
// default) and is not tier-dependent; this function must never surface it,
// keeping that separation the entire point of the Abstracted Ladder.
export function getTierData(level) {
  const safeLevel = Math.max(1, Number(level) || 1);

  if (safeLevel >= 200) return { tier: "Diamond", colorTheme: "blue" };
  if (safeLevel >= 150) return { tier: "Platinum", colorTheme: "teal" };
  if (safeLevel >= 100) return { tier: "Gold", colorTheme: "yellow" };
  if (safeLevel >= 50) return { tier: "Silver", colorTheme: "gray" };
  return { tier: "Standard", colorTheme: "slate" };
}

// calculateProgressBar(xp) — 0–100 percentage of the way from the current
// level's floor to the next level's floor. A maxed-out (Level 200) user
// gets a flat 100 rather than a division by zero.
export function calculateProgressBar(xp) {
  const { currentLevel, xpForCurrentLevel, xpForNextLevel } = calculateLevel(xp);

  if (currentLevel >= MAX_LEVEL || xpForNextLevel === xpForCurrentLevel) {
    return 100;
  }

  const safeXp = Math.max(0, Number(xp) || 0);
  const progress = ((safeXp - xpForCurrentLevel) / (xpForNextLevel - xpForCurrentLevel)) * 100;

  return Math.min(100, Math.max(0, progress));
}

// The Enterprise Partner Tier — a SEPARATE track from the worker XP/Level
// system above. Businesses are tiered by total real spend (see
// transactions.repository.js's sumFundsSecuredForBusiness), never XP —
// "Do not use XP for businesses" per the design brief. Thresholds are a
// first-cut illustrative draft, same "not yet validated" status as every
// other number in this file until a payment gateway/real usage data exists
// to tune them against.
const BUSINESS_TIERS = [
  { tier: "Bronze", threshold: 0 },
  { tier: "Silver", threshold: 50000 },
  { tier: "Gold", threshold: 200000 },
];

// Mirrors WorkerMilestones.jsx's MILESTONES level column exactly — the
// only levels a worker can ever pin as their profile badge. Kept here
// (not re-derived) so the backend validation and the frontend badge grid
// can never silently drift apart.
export const MILESTONE_LEVELS = [5, 10, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 175, 200];

export function getBusinessTier(totalSpend) {
  const safeSpend = Math.max(0, Number(totalSpend) || 0);
  let current = BUSINESS_TIERS[0];
  for (const t of BUSINESS_TIERS) {
    if (safeSpend >= t.threshold) current = t;
  }
  const next = BUSINESS_TIERS.find((t) => t.threshold > safeSpend) ?? null;
  return { tier: current.tier, nextTier: next?.tier ?? null, nextThreshold: next?.threshold ?? null };
}
