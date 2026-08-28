import { z } from "zod";

// Mirrors project_status in schema.sql. PATCH /api/projects/:id is for the
// non-terminal FSM steps only — COMPLETED is reachable exclusively through
// POST /api/projects/:id/complete, PENDING_FUNDS exclusively through POST
// /api/projects/:id/fund-escrow, and FUNDS_SECURED exclusively through the
// admin's POST /api/admin/escrow-funding/:id/resolve, since all three run
// atomic ledger side effects (schema.sql's chk_ constraints don't enforce
// transition order — that's the API's job, not the DB's).
const PATCHABLE_STATUSES = [
  "ACCEPTED",
  "WORK_IN_PROGRESS",
  "FILES_SUBMITTED",
  "CANCELLED",
  "DISPUTED",
];

// The worker's real counter-offer on the posted budget (see
// projects.controller.js's proposeBudget) — same real ₹50,00,000 ceiling
// postJobSchema enforces client-side (Frontend/src/app/utils/formValidation.js),
// mirrored here since a proposal is really just a second real budget write.
export const proposeBudgetSchema = z.object({
  budget: z.number().positive().max(5000000),
});

// workerId omitted entirely posts an OPEN job board listing (see
// projects.repository.js's create) — the existing direct-invite flow still
// passes a real workerId and behaves exactly as before this feature existed.
//
// applicationWindow/estimatedDuration were read by createProject
// (projects.controller.js) and written by projects.repository.js's create,
// but were never actually declared here — z.object().parse() silently
// strips any key not in the schema, so both fields were being dropped
// before the controller ever saw them. Every job post's Application Window
// and Estimated Duration have been silently discarded since they were
// built; adding them here is what actually makes them persist.
export const createProjectSchema = z.object({
  workerId: z.string().uuid().optional(),
  title: z.string().min(3).max(200),
  description: z.string().max(5000).optional(),
  budget: z.number().positive(),
  deadline: z.string().date().optional(), // "YYYY-MM-DD"
  applicationWindow: z.coerce.number().int().min(1).max(90).optional(),
  estimatedDuration: z.string().max(50).optional(),
  // Real, structured job requirements (see migrations/018_job_qualifications.sql)
  // — Required Skills used to just get folded into `description` as a
  // comma-separated blob; experience/education had no representation at all.
  minExperienceYears: z.coerce.number().int().min(0).max(60).optional(),
  maxExperienceYears: z.coerce.number().int().min(0).max(60).optional(),
  educationLevel: z.enum(["ANY", "HIGH_SCHOOL", "DIPLOMA", "BACHELORS", "MASTERS", "PHD"]).optional(),
  educationNotes: z.string().max(300).optional(),
  // A "skill" is a short tag ("React", "Node.js"), not a sentence — word
  // count (not just character length) is what actually catches a pasted
  // paragraph, since a single long compound word could still pass a
  // char-only check. Mirrors the frontend's own check (formValidation.js).
  requiredSkills: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((s) => s.split(/\s+/).filter(Boolean).length <= 5, {
          message: "Each skill must be 5 words or fewer.",
        })
    )
    .max(20)
    .optional(),
  // Real effect now (see migrations/019_urgent_matching.sql) — urgent posts
  // sort first and get early visibility to Silver-tier+ workers. No
  // subscription gating here; that track is deferred.
  isUrgent: z.boolean().optional(),
}).refine(
  (data) => data.maxExperienceYears === undefined || data.minExperienceYears === undefined || data.maxExperienceYears >= data.minExperienceYears,
  { message: "Max experience must be greater than or equal to min experience.", path: ["maxExperienceYears"] }
);

const disputeEvidenceItemSchema = z.object({
  dataUrl: z.string(),
  caption: z.string().max(200).optional(),
});

export const updateProjectStatusSchema = z.object({
  status: z.enum(PATCHABLE_STATUSES),
  // Meaningful for FILES_SUBMITTED -> WORK_IN_PROGRESS (the business
  // explaining what needs fixing) and required — enforced in the
  // controller, not here, since it's the only status-dependent requirement
  // — for -> DISPUTED (the reason an admin needs to actually resolve it).
  // Harmless no-op for every other transition, which simply won't pass one.
  note: z.string().trim().max(1000).optional(),
  // Only meaningful alongside status: "DISPUTED" — real per-item validation
  // (data: URI shape, size cap, max count) happens in
  // utils/disputeEvidence.js, not here; this just has to declare the key
  // exists so zod's .parse() doesn't silently strip it before the
  // controller ever sees it (see messages.validators.js's replyToMessageId
  // for the same class of bug this avoids).
  evidence: z.array(disputeEvidenceItemSchema).max(3).optional(),
});

export const disputeRebuttalSchema = z.object({
  statement: z.string().trim().min(1).max(1000),
  evidence: z.array(disputeEvidenceItemSchema).max(3).optional(),
});

export const listProjectsQuerySchema = z.object({
  status: z.string().optional(),
  role: z.enum(["worker", "business"]).optional(), // "list projects where I am this role"
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
