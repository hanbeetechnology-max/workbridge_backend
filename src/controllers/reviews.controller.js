import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import * as projectsRepo from "../repositories/projects.repository.js";
import * as reviewsRepo from "../repositories/reviews.repository.js";
import { emitProjectEvent } from "../realtime/events.js";

// POST /api/reviews — the Success Hub's rating submission. reviewerId is
// always req.user.id; revieweeId is derived from the project (the *other*
// participant), never taken from the request body — a caller can't rate
// someone who isn't actually the other side of this project.
export const createReview = asyncHandler(async (req, res) => {
  const { projectId, rating, feedback } = req.body;

  const project = await projectsRepo.findById(projectId);
  if (!project) throw ApiError.notFound("Project not found.");

  if (project.status !== "COMPLETED") {
    throw ApiError.badRequest("Reviews can only be submitted for a COMPLETED project.");
  }

  let revieweeId;
  if (req.user.id === project.worker_id) {
    revieweeId = project.business_id;
  } else if (req.user.id === project.business_id) {
    revieweeId = project.worker_id;
  } else {
    throw ApiError.forbidden("You are not a participant on this project.");
  }

  const existing = await reviewsRepo.findByProjectAndReviewer(projectId, req.user.id);
  if (existing) {
    throw ApiError.conflict("You've already reviewed this project.");
  }

  const review = await reviewsRepo.create({
    projectId,
    reviewerId: req.user.id,
    revieweeId,
    rating,
    feedback,
  });
  await reviewsRepo.recomputeRatingAggregate(revieweeId);

  emitProjectEvent(project, "REVIEW_SUBMITTED", { reviewId: review.id, reviewerId: req.user.id, senderId: req.user.id, revieweeId, rating });

  res.status(201).json({ data: review });
});

// PATCH /api/reviews/:projectId — edits the caller's own already-submitted
// review for this project. Unlike createReview, this is expected to be
// called repeatedly (a reviewer changing their mind), so there's no
// conflict check — it just requires a review to already exist.
export const updateReview = asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const { rating, feedback } = req.body;

  const existing = await reviewsRepo.findByProjectAndReviewer(projectId, req.user.id);
  if (!existing) throw ApiError.notFound("You haven't reviewed this project yet.");

  const review = await reviewsRepo.update({ projectId, reviewerId: req.user.id, rating, feedback });
  await reviewsRepo.recomputeRatingAggregate(existing.reviewee_id);
  res.json({ data: review });
});

// GET /api/reviews?revieweeId= — public list of reviews a user has
// received (same trust-signal category as public_user_profiles.rating).
export const listReviews = asyncHandler(async (req, res) => {
  const reviews = await reviewsRepo.listForReviewee(req.query.revieweeId);
  res.json({ data: reviews });
});

// GET /api/reviews/featured — the public Testimonials page: a handful of
// real, substantive reviews platform-wide (not scoped to one reviewee),
// plus real aggregate stats. Both are genuine DB facts — however small the
// platform's real numbers are today, they're never backfilled with
// invented ones.
export const listFeaturedReviews = asyncHandler(async (_req, res) => {
  const [reviews, stats] = await Promise.all([reviewsRepo.listFeatured(), reviewsRepo.getPublicStats()]);
  res.json({ data: { reviews, stats } });
});
