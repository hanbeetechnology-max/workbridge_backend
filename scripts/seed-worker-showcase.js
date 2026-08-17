// backend/scripts/seed-worker-showcase.js
// Fleshes out arun0362004@gmail.com's (worker) shareable profile for a
// manual UI pass — corrects both accounts' display names, adds
// education/certifications/portfolio projects to the worker's profile
// JSONB, and creates a few more COMPLETED projects with realistic,
// varied-voice reviews so the "Client Reviews" section isn't just the one
// row seed-3-accounts-demo.js already left behind.
//
// Idempotent the same way seed-3-accounts-demo.js is: projects are
// look-up-by-title before insert, safe to re-run. The name/profile/
// behavior_score updates are plain overwrites, also safe to re-run.
//
// Run from the backend/ directory so dotenv/config picks up backend/.env:
//   node scripts/seed-worker-showcase.js
// Against production, same override as every other one-off script this
// project has used:
//   $env:DATABASE_URL = "<production connection string>"; node scripts/seed-worker-showcase.js

import "dotenv/config";
import { query, transaction } from "../src/db/client.js";
import * as usersRepo from "../src/repositories/users.repository.js";
import * as transactionsRepo from "../src/repositories/transactions.repository.js";
import * as submissionsRepo from "../src/repositories/submissions.repository.js";
import * as reviewsRepo from "../src/repositories/reviews.repository.js";

const WORKER_EMAIL = "arun0362004@gmail.com";
const BUSINESS_EMAIL = "markantan01031952@gmail.com";
const WORKER_NAME = "Arunkumar P";
const BUSINESS_NAME = "Markantan K";
const FEE_PCT = 15;

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function timelineFor(statusesWithAge) {
  return statusesWithAge.map(([status, ageDays]) => {
    const at = daysAgo(ageDays).toISOString();
    return { status, at, timestamp: at };
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

const EDUCATION = [
  { degree: "B.Tech in Computer Science & Engineering", school: "Anna University, Chennai", year: "2019 – 2023" },
  { degree: "Higher Secondary Education (Computer Science)", school: "Chennai Public Higher Secondary School", year: "2017 – 2019" },
];

const CERTIFICATIONS = [
  { name: "Meta Front-End Developer Professional Certificate", issuer: "Coursera", year: "2023" },
  { name: "AWS Certified Cloud Practitioner", issuer: "Amazon Web Services", year: "2024" },
  { name: "Node.js Services Development", issuer: "Udemy", year: "2022" },
  { name: "PostgreSQL for Developers", issuer: "DataCamp", year: "2023" },
];

const PORTFOLIO_PROJECTS = [
  {
    title: "WorkBridge — Freelance Marketplace Platform",
    link: "https://github.com/arunkumar-dev/workbridge",
    description: "Built the backend (Node/Express/PostgreSQL) and a good part of the React frontend for a freelance marketplace — escrow-style payments, real-time chat with moderated file sharing, and an admin review queue.",
  },
  {
    title: "Inventory Analytics Dashboard",
    link: "https://github.com/arunkumar-dev/inventory-dashboard",
    description: "React + Chart.js dashboard for a retail client tracking stock levels and reorder points across 12 warehouses — cut their manual reporting time from a full day to about 10 minutes.",
  },
  {
    title: "Real Estate Listing Portal",
    link: "https://github.com/arunkumar-dev/realestate-portal",
    description: "Full-stack listing site with search/filters, image galleries, and a lead-capture form wired to email — built for a small local agency.",
  },
  {
    title: "Personal Finance Tracker (Side Project)",
    link: "https://github.com/arunkumar-dev/finance-tracker",
    description: "A React Native app with a small Node API to track my own expenses and sync across devices — mostly built to properly learn React Native.",
  },
];

// Additional COMPLETED projects, each with one review — deliberately
// different voice/rating per review so the section doesn't read like
// templated copy-paste.
const REVIEW_PROJECTS = [
  {
    title: "Legacy Codebase Bug Fixes & Stabilization",
    description: "Triage and fix a backlog of 15+ reported bugs in an older Node/Express service before we could safely add new features on top of it.",
    budget: 20000,
    timeline: timelineFor([["INVITED", 26], ["ACCEPTED", 24], ["FUNDS_SECURED", 21], ["WORK_IN_PROGRESS", 14], ["FILES_SUBMITTED", 5], ["COMPLETED", 3]]),
    deadlineDays: 6,
    submission: {
      type: "link",
      url: "https://github.com/arunkumar-dev/legacy-api-fixes",
      caption: "All 15 tracked bugs fixed + regression tests added — PR is merged and deployed.",
    },
    review: {
      rating: 5,
      feedback: "Arun picked up our messy legacy codebase without complaining and had the bug fixes shipped two days early. Clear updates the whole way through, and he flagged a couple of things we hadn't even thought to ask about. Easy yes for round two.",
    },
  },
  {
    title: "Appointment Booking Widget for Clinic Website",
    description: "A drop-in booking widget for a healthcare client's website — slot availability, confirmation emails, and a simple admin view to manage bookings.",
    budget: 26000,
    timeline: timelineFor([["INVITED", 34], ["ACCEPTED", 31], ["FUNDS_SECURED", 27], ["WORK_IN_PROGRESS", 18], ["FILES_SUBMITTED", 8], ["COMPLETED", 6]]),
    deadlineDays: 10,
    submission: {
      type: "link",
      url: "https://github.com/arunkumar-dev/clinic-booking-widget",
      caption: "Final widget + embed snippet and a short README for your team to maintain it.",
    },
    review: {
      rating: 5,
      feedback: "We came to him with a rough idea for a booking widget and he asked exactly the right questions before writing a single line of code. Never had to chase him for a status update — he just sent them.",
    },
  },
  {
    title: "Admin Dashboard Rebuild — React Migration",
    description: "Migrate an old jQuery-based admin dashboard to React, matching existing functionality first before any new features were layered on top.",
    budget: 34000,
    timeline: timelineFor([["INVITED", 45], ["ACCEPTED", 42], ["FUNDS_SECURED", 38], ["WORK_IN_PROGRESS", 25], ["FILES_SUBMITTED", 12], ["COMPLETED", 9]]),
    deadlineDays: 14,
    submission: {
      type: "link",
      url: "https://github.com/arunkumar-dev/admin-dashboard-react",
      caption: "Migrated dashboard, feature-parity checklist attached, plus a short walkthrough recording.",
    },
    review: {
      rating: 4,
      feedback: "Solid work on the dashboard rebuild. There was a short delay around a festival week, but he gave us a heads-up in advance and the final delivery was clean and well documented. Would work with him again.",
    },
  },
];

async function main() {
  const worker = await usersRepo.findByEmail(WORKER_EMAIL);
  const business = await usersRepo.findByEmail(BUSINESS_EMAIL);

  if (!worker) throw new Error(`No user found for ${WORKER_EMAIL}.`);
  if (!business) throw new Error(`No user found for ${BUSINESS_EMAIL}.`);

  await query(`UPDATE users SET name = $2 WHERE id = $1`, [worker.id, WORKER_NAME]);
  await query(`UPDATE users SET name = $2 WHERE id = $1`, [business.id, BUSINESS_NAME]);
  console.log(`Corrected display names: worker -> "${WORKER_NAME}", business -> "${BUSINESS_NAME}".`);

  await usersRepo.updateSelf(worker.id, {
    profilePatch: {
      education: EDUCATION,
      certifications: CERTIFICATIONS,
      projects: PORTFOLIO_PROJECTS,
    },
  });
  // behavior_score isn't part of updateSelf (that's title/phone/avatar/
  // profile only) — a direct update here, just for this demo account.
  await query(`UPDATE users SET behavior_score = 860 WHERE id = $1`, [worker.id]);
  console.log("Added education/certifications/portfolio projects and set behavior_score = 860 for the worker.");

  const { rows: adminRows } = await query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  const adminId = adminRows[0]?.id ?? null;

  for (const spec of REVIEW_PROJECTS) {
    const { rows: existing } = await query(
      `SELECT id FROM projects WHERE business_id = $1 AND worker_id = $2 AND title = $3`,
      [business.id, worker.id, spec.title]
    );
    if (existing.length > 0) {
      console.log(`Already seeded — "${spec.title}" exists. Skipping.`);
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
         VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED'::project_status, $7, $8::jsonb)
         RETURNING *`,
        [business.id, worker.id, spec.title, spec.description, budget, FEE_PCT, deadline, JSON.stringify(spec.timeline)]
      );
      const insertedProject = rows[0];

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

      return insertedProject;
    });

    // Submission + review run after commit — same reasoning as
    // seed-3-accounts-demo.js (they can't run inside the not-yet-committed
    // transaction above without hitting the project_id FK before it's visible).
    const submission = await submissionsRepo.create({
      projectId: project.id,
      submittedBy: worker.id,
      type: spec.submission.type,
      url: spec.submission.url,
      caption: spec.submission.caption,
    });
    await submissionsRepo.review({ query }, submission.id, {
      status: "APPROVED",
      reviewedBy: adminId,
      rejectionReason: null,
    });

    await reviewsRepo.create({
      projectId: project.id,
      reviewerId: business.id,
      revieweeId: worker.id,
      rating: spec.review.rating,
      feedback: spec.review.feedback,
    });

    console.log(`Seeded "${spec.title}" (${project.id}) — COMPLETED, ₹${budget}, ${spec.review.rating}★ review.`);
  }

  // users.rating/reviews_count are a cached aggregate that nothing in the
  // app currently recomputes (see reviews.controller.js's own comment on
  // this) — recomputed here directly so the profile header's rating badge
  // actually reflects the reviews this script (and seed-3-accounts-demo.js
  // before it) left behind.
  await query(
    `UPDATE users u
     SET rating = sub.avg_rating, reviews_count = sub.cnt
     FROM (
       SELECT ROUND(AVG(rating)::numeric, 2) AS avg_rating, COUNT(*) AS cnt
       FROM reviews WHERE reviewee_id = $1
     ) sub
     WHERE u.id = $1`,
    [worker.id]
  );
  console.log("Recomputed users.rating/reviews_count for the worker from the reviews table.");

  console.log("\nDone. Reload the worker's profile (and /profiles/<id>) to see it.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
