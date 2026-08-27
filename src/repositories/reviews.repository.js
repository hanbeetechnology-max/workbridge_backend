import { query } from "../db/client.js";

export async function create({ projectId, reviewerId, revieweeId, rating, feedback }) {
  // uq_one_review_per_project_per_reviewer (schema.sql) turns a duplicate
  // submission into a unique_violation (Postgres error code 23505) — the
  // controller maps that to a 409 Conflict.
  const { rows } = await query(
    `INSERT INTO reviews (project_id, reviewer_id, reviewee_id, rating, feedback)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [projectId, reviewerId, revieweeId, rating, feedback ?? null]
  );
  return rows[0];
}

export async function findByProjectAndReviewer(projectId, reviewerId) {
  const { rows } = await query(
    `SELECT * FROM reviews WHERE project_id = $1 AND reviewer_id = $2`,
    [projectId, reviewerId]
  );
  return rows[0] ?? null;
}

// Edits an already-submitted review in place — the reviewer can change
// their mind about a rating as many times as they want, not just once.
// Scoped to (project_id, reviewer_id) so a caller can only ever update
// their own review, same ownership boundary as create's revieweeId rule.
export async function update({ projectId, reviewerId, rating, feedback }) {
  const { rows } = await query(
    `UPDATE reviews SET rating = $1, feedback = $2
     WHERE project_id = $3 AND reviewer_id = $4
     RETURNING *`,
    [rating, feedback ?? null, projectId, reviewerId]
  );
  return rows[0] ?? null;
}

// users.rating/reviews_count are a cached aggregate, not derived on read —
// every write to the reviews table (create above, update below) must call
// this straight after so the profile header's rating badge never drifts
// out of sync with the reviews actually backing it. Recomputed from the
// real rows rather than incrementally adjusted (e.g. "+1 to the count") so
// it's self-correcting even if a previous write ever missed this call.
export async function recomputeRatingAggregate(revieweeId) {
  await query(
    `UPDATE users u
     SET rating = sub.avg_rating, reviews_count = sub.cnt
     FROM (
       SELECT ROUND(AVG(rating)::numeric, 2) AS avg_rating, COUNT(*) AS cnt
       FROM reviews WHERE reviewee_id = $1
     ) sub
     WHERE u.id = $1`,
    [revieweeId]
  );
}

// Reviews a user has RECEIVED — the trust-page use case (WorkerProfile.jsx's
// reviews section), same "public trust signal" category as
// public_user_profiles.rating/reviews_count, so this is a public read too.
// Joined to public_user_profiles for the reviewer's display name.
export async function listForReviewee(revieweeId) {
  const { rows } = await query(
    `SELECT r.*, p.name AS reviewer_name, p.avatar_url AS reviewer_avatar_url
     FROM reviews r
     JOIN public_user_profiles p ON p.id = r.reviewer_id
     WHERE r.reviewee_id = $1
     ORDER BY r.created_at DESC
     LIMIT 200`,
    [revieweeId]
  );
  return rows;
}

// Platform-wide highlights for the public Testimonials page — same public
// trust-signal category as listForReviewee above, just not scoped to one
// reviewee. Filtered to reviews with substantive feedback text (real
// quotes from real completed projects) so the many blank/placeholder
// reviews don't drown them out — every row returned is a real review,
// nothing here is invented.
//
// DISTINCT ON (r.reviewer_id) caps this at ONE review per reviewer (their
// best: highest-rated, then most recent) before the outer LIMIT — without
// it, a small dataset where one account has completed many projects would
// let that single reviewer fill the entire "Trusted by ambitious teams and
// top talent" section, which reads as fake/repetitive even though every
// row is real. This is a diversity constraint on real data, not
// fabrication — reviewers with only one review still show up exactly as
// before.
export async function listFeatured(limit = 12) {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (r.reviewer_id)
              r.id, r.rating, r.feedback, r.created_at,
              reviewer.name AS reviewer_name, reviewer.role AS reviewer_role,
              reviewee.name AS reviewee_name, reviewee.role AS reviewee_role, reviewee.title AS reviewee_title,
              p.title AS project_title
       FROM reviews r
       JOIN public_user_profiles reviewer ON reviewer.id = r.reviewer_id
       JOIN public_user_profiles reviewee ON reviewee.id = r.reviewee_id
       JOIN projects p ON p.id = r.project_id
       WHERE length(trim(r.feedback)) >= 30
       ORDER BY r.reviewer_id, r.rating DESC, r.created_at DESC
     ) distinct_reviewers
     ORDER BY rating DESC, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// Real, live platform totals for the same page — the small public-safe
// subset of the numbers AdminOverviewTab's KPIs already use (no revenue or
// other internal financial figures).
export async function getPublicStats() {
  const [{ rows: completed }, { rows: workers }, { rows: businesses }, { rows: avgRating }] = await Promise.all([
    query(`SELECT count(*)::int AS count FROM projects WHERE status = 'COMPLETED'`),
    query(`SELECT count(*)::int AS count FROM users WHERE role = 'worker'`),
    query(`SELECT count(*)::int AS count FROM users WHERE role = 'business'`),
    query(`SELECT COALESCE(round(avg(rating)::numeric, 1), 0) AS avg FROM reviews`),
  ]);
  return {
    completedProjects: completed[0].count,
    totalWorkers: workers[0].count,
    totalBusinesses: businesses[0].count,
    averageRating: Number(avgRating[0].avg),
  };
}
