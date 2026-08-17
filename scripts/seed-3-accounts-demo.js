// backend/scripts/seed-3-accounts-demo.js
// Fills in the 3 real accounts used for manual testing (admin/worker/
// business, all sharing phone 9342804230) with realistic profile content
// and one project per project_status enum value — so every status badge,
// timeline state, and admin queue (Disputes/Content Review/Transaction
// History) has real data to click through, instead of a wall of "no data"
// empty states.
//
// Unlike seed-retailx-demo.js, this does NOT create the users — they must
// already exist (created for real via the signup + OTP flow). This script
// only looks them up by email and adds projects/profile content around them.
//
// Run from the backend/ directory so dotenv/config picks up backend/.env:
//   node scripts/seed-3-accounts-demo.js
// Against production, override DATABASE_URL the same way earlier
// migrations were run:
//   $env:DATABASE_URL = "<production connection string>"; node scripts/seed-3-accounts-demo.js

import "dotenv/config";
import { query, transaction } from "../src/db/client.js";
import * as usersRepo from "../src/repositories/users.repository.js";
import * as transactionsRepo from "../src/repositories/transactions.repository.js";
import * as submissionsRepo from "../src/repositories/submissions.repository.js";
import * as reviewsRepo from "../src/repositories/reviews.repository.js";

const WORKER_EMAIL = "arun0362004@gmail.com";
const BUSINESS_EMAIL = "markantan01031952@gmail.com";
const FEE_PCT = 15;

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Mirrors seed-retailx-demo.js's timelineFor — both `at` and `timestamp`
// keys, since some frontend components read one, some the other.
function timelineFor(statusesWithAge) {
  return statusesWithAge.map(([status, ageDays]) => {
    const at = daysAgo(ageDays).toISOString();
    return { status, at, timestamp: at };
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// One entry per project_status enum value (schema.sql) — INVITED through
// DISPUTED — each with a plausible staggered timeline (oldest event = when
// the invite went out) and a deadline a bit past the most recent event.
const PROJECTS = [
  {
    status: "INVITED",
    title: "Landing Page Redesign for Product Launch",
    description: "Redesign the marketing landing page ahead of a new product launch — mobile-first, with a focus on conversion.",
    budget: 18000,
    timeline: timelineFor([["INVITED", 1]]),
    deadlineDays: -20, // 20 days from now
  },
  {
    status: "ACCEPTED",
    title: "Inventory Dashboard — Bug Fixes & Polish",
    description: "Fix a handful of reported bugs in the internal inventory dashboard and tidy up the UI before the next release.",
    budget: 24000,
    timeline: timelineFor([["INVITED", 6], ["ACCEPTED", 4]]),
    deadlineDays: -16,
  },
  {
    status: "FUNDS_SECURED",
    title: "Customer Support Chatbot Integration",
    description: "Integrate a support chatbot into the existing help center, including intent training on our most common tickets.",
    budget: 32000,
    timeline: timelineFor([["INVITED", 10], ["ACCEPTED", 8], ["FUNDS_SECURED", 6]]),
    deadlineDays: -12,
  },
  {
    status: "WORK_IN_PROGRESS",
    title: "Mobile App Onboarding Flow Redesign",
    description: "Redesign the first-run onboarding flow for the mobile app to reduce drop-off in the first three screens.",
    budget: 28000,
    timeline: timelineFor([["INVITED", 14], ["ACCEPTED", 12], ["FUNDS_SECURED", 10], ["WORK_IN_PROGRESS", 5]]),
    deadlineDays: -8,
  },
  {
    status: "FILES_SUBMITTED",
    title: "SEO Audit & Content Strategy Rollout",
    description: "Full SEO audit of the marketing site plus a 90-day content strategy roadmap.",
    budget: 15000,
    timeline: timelineFor([["INVITED", 16], ["ACCEPTED", 14], ["FUNDS_SECURED", 12], ["WORK_IN_PROGRESS", 6], ["FILES_SUBMITTED", 1]]),
    deadlineDays: -2,
    submission: {
      type: "link",
      url: "https://drive.google.com/drive/folders/dev-seo-audit-draft",
      caption: "Initial audit + content roadmap for review — happy to adjust anything before this is final.",
    },
  },
  {
    status: "COMPLETED",
    title: "E-Commerce Checkout Performance Overhaul",
    description: "Cut checkout page load time and reduce cart abandonment on the storefront's payment step.",
    budget: 45000,
    timeline: timelineFor([["INVITED", 24], ["ACCEPTED", 21], ["FUNDS_SECURED", 18], ["WORK_IN_PROGRESS", 12], ["FILES_SUBMITTED", 4], ["COMPLETED", 2]]),
    deadlineDays: 4,
    submission: {
      type: "link",
      url: "https://drive.google.com/drive/folders/dev-checkout-final-delivery",
      caption: "Final build + handoff notes — checkout load time down ~40% in staging.",
    },
    review: {
      rating: 5,
      feedback: "Delivered ahead of schedule and the performance numbers speak for themselves. Would hire again.",
    },
  },
  {
    status: "CANCELLED",
    title: "Internal Analytics Widget",
    description: "A small embeddable analytics widget for the internal admin tools — cancelled by mutual agreement after scope changed.",
    budget: 9000,
    timeline: timelineFor([["INVITED", 20], ["ACCEPTED", 18], ["CANCELLED", 15]]),
    deadlineDays: -5,
  },
  {
    status: "DISPUTED",
    title: "Brand Identity & Logo Refresh",
    description: "Refresh the brand's visual identity — new logo, color system, and a short usage guide.",
    budget: 20000,
    timeline: timelineFor([["INVITED", 19], ["ACCEPTED", 17], ["FUNDS_SECURED", 15], ["WORK_IN_PROGRESS", 9], ["FILES_SUBMITTED", 3], ["DISPUTED", 1]]),
    deadlineDays: -1,
  },
];

async function main() {
  const worker = await usersRepo.findByEmail(WORKER_EMAIL);
  const business = await usersRepo.findByEmail(BUSINESS_EMAIL);

  if (!worker) throw new Error(`No user found for ${WORKER_EMAIL} — sign up (and verify) this account first.`);
  if (!business) throw new Error(`No user found for ${BUSINESS_EMAIL} — sign up (and verify) this account first.`);
  if (worker.role !== "worker") throw new Error(`${WORKER_EMAIL} exists but is role="${worker.role}", expected "worker".`);
  if (business.role !== "business") throw new Error(`${BUSINESS_EMAIL} exists but is role="${business.role}", expected "business".`);

  await usersRepo.updateSelf(worker.id, {
    title: "Full-Stack Developer",
    profilePatch: {
      bio: "Full-stack developer focused on fast, reliable delivery — React/Node on the web, with a soft spot for performance work.",
      location: "Chennai, India",
      hourlyRate: 850,
      skills: ["React", "Node.js", "PostgreSQL", "REST APIs", "Performance Tuning"],
    },
  });
  await usersRepo.updateSelf(business.id, {
    title: "Retail & E-Commerce",
    profilePatch: {
      industry: "Retail & E-Commerce",
      location: "Bengaluru, India",
    },
  });
  console.log(`Updated profile content for ${WORKER_EMAIL} and ${BUSINESS_EMAIL}.`);

  const { rows: adminRows } = await query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  const adminId = adminRows[0]?.id ?? null;

  for (const spec of PROJECTS) {
    const { rows: existing } = await query(
      `SELECT id FROM projects WHERE business_id = $1 AND worker_id = $2 AND title = $3`,
      [business.id, worker.id, spec.title]
    );
    if (existing.length > 0) {
      console.log(`Already seeded — "${spec.title}" (${spec.status}) exists. Skipping.`);
      continue;
    }

    const budget = spec.budget;
    const fee = round2(budget * (FEE_PCT / 100));
    const earnings = round2(budget - fee);
    const deadline = daysAgo(spec.deadlineDays).toISOString().slice(0, 10);

    const project = await transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO projects
           (business_id, worker_id, title, description, budget, platform_fee_pct, status, deadline, timeline)
         VALUES ($1, $2, $3, $4, $5, $6, $7::project_status, $8, $9::jsonb)
         RETURNING *`,
        [business.id, worker.id, spec.title, spec.description, budget, FEE_PCT, spec.status, deadline, JSON.stringify(spec.timeline)]
      );
      const insertedProject = rows[0];

      const needsFundsHeld = ["FUNDS_SECURED", "WORK_IN_PROGRESS", "FILES_SUBMITTED", "DISPUTED", "COMPLETED"].includes(spec.status);
      if (needsFundsHeld) {
        await transactionsRepo.insert(
          {
            projectId: insertedProject.id,
            workerId: worker.id,
            businessId: business.id,
            type: "FUNDS_SECURED",
            direction: "debit",
            amount: budget,
            fundsStatus: "HELD",
            referenceNote: `Funds secured – ${spec.title}`,
          },
          client
        );
      }

      if (spec.status === "COMPLETED") {
        await transactionsRepo.insert(
          {
            projectId: insertedProject.id,
            workerId: worker.id,
            businessId: business.id,
            type: "PAYOUT",
            direction: "credit",
            amount: earnings,
            fundsStatus: "RELEASED",
            referenceNote: `Payment released – ${spec.title}`,
          },
          client
        );
        await transactionsRepo.insert(
          {
            projectId: insertedProject.id,
            workerId: worker.id,
            businessId: business.id,
            type: "PLATFORM_FEE",
            direction: "debit",
            amount: fee,
            referenceNote: `Platform fee – ${spec.title}`,
          },
          client
        );
        await usersRepo.incrementWalletBalance(client, worker.id, earnings);
      }

      return insertedProject;
    });

    // Submissions/reviews run after commit — submissionsRepo/reviewsRepo have
    // no `client` param, so they can't run inside the not-yet-committed
    // transaction above without hitting the project_id FK before it's visible
    // (same reasoning as seed-retailx-demo.js).
    if (spec.submission) {
      const submission = await submissionsRepo.create({
        projectId: project.id,
        submittedBy: worker.id,
        type: spec.submission.type,
        url: spec.submission.url,
        caption: spec.submission.caption,
      });
      if (spec.status === "COMPLETED") {
        await submissionsRepo.review({ query }, submission.id, {
          status: "APPROVED",
          reviewedBy: adminId,
          rejectionReason: null,
        });
      }
    }

    if (spec.review) {
      // Business rates worker — populates WorkerProfile's "Client Reviews"
      // section, which reads reviews where revieweeId = the worker (see
      // GET /api/reviews?revieweeId=).
      await reviewsRepo.create({
        projectId: project.id,
        reviewerId: business.id,
        revieweeId: worker.id,
        rating: spec.review.rating,
        feedback: spec.review.feedback,
      });
    }

    console.log(`Seeded "${spec.title}" (${project.id}) — ${spec.status}, ₹${budget}.`);
  }

  console.log("\nDone. Sign in as either account to see these projects across every status.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
