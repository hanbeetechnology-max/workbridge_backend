// backend/scripts/seed-sai-roshan-showcase.js
// Fleshes out sairoshan961@gmail.com's (real, already-signed-up-and-verified
// worker) shareable profile — same idea as seed-worker-showcase.js for
// Arunkumar P, just a different person and a different specialty (UI/UX +
// frontend, not full-stack), so the two profiles look genuinely different
// side by side.
//
// This does NOT create a user — Sai Roshan already exists for real. The
// script only looks him up by email and adds profile content + a few
// COMPLETED projects (with real reviews) against the existing "Markantan K"
// business account around him.
//
// Run from the backend/ directory so dotenv/config picks up backend/.env:
//   node scripts/seed-sai-roshan-showcase.js
// Against production, same DATABASE_URL override as every other script here:
//   $env:DATABASE_URL = "<production connection string>"; node scripts/seed-sai-roshan-showcase.js

import "dotenv/config";
import { query, transaction } from "../src/db/client.js";
import * as usersRepo from "../src/repositories/users.repository.js";
import * as transactionsRepo from "../src/repositories/transactions.repository.js";
import * as submissionsRepo from "../src/repositories/submissions.repository.js";
import * as reviewsRepo from "../src/repositories/reviews.repository.js";

const WORKER_EMAIL = "sairoshan961@gmail.com";
const WORKER_NAME = "Sai Roshan";
const BUSINESS_EMAIL = "markantan01031952@gmail.com"; // existing real "Markantan K" account
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
  { degree: "B.Des in Communication Design", school: "National Institute of Design, Ahmedabad", year: "2018 – 2022" },
  { degree: "Higher Secondary (Commerce)", school: "St. Andrew's Higher Secondary School, Hyderabad", year: "2016 – 2018" },
];

const CERTIFICATIONS = [
  { name: "Google UX Design Professional Certificate", issuer: "Coursera", year: "2022" },
  { name: "Advanced React for Designers", issuer: "Frontend Masters", year: "2023" },
  { name: "Design Systems with Figma", issuer: "Udemy", year: "2023" },
];

const PORTFOLIO_PROJECTS = [
  {
    title: "Mobile Banking App — Onboarding Redesign",
    link: "https://github.com/sairoshan-design/banking-app-onboarding",
    description: "Reworked a banking app's sign-up and KYC flow end to end — cut the average onboarding time by roughly a third based on the client's post-launch analytics.",
  },
  {
    title: "SaaS Dashboard Design System",
    link: "https://github.com/sairoshan-design/saas-design-system",
    description: "A full component library in Figma + a matching React/Tailwind implementation — spacing scale, typography, and reusable chart/table components for a B2B analytics product.",
  },
  {
    title: "D2C Landing Page Conversion Redesign",
    link: "https://github.com/sairoshan-design/landing-conversion-redesign",
    description: "Rebuilt a product landing page around a single clear call-to-action after a round of user testing showed people bouncing before finding the pricing section.",
  },
];

const REVIEW_PROJECTS = [
  {
    title: "Mobile Banking App UI Redesign",
    description: "Redesign the sign-up and account onboarding screens for a banking app to reduce drop-off during KYC.",
    budget: 30000,
    timeline: timelineFor([["INVITED", 30], ["ACCEPTED", 27], ["FUNDS_SECURED", 24], ["WORK_IN_PROGRESS", 15], ["FILES_SUBMITTED", 6], ["COMPLETED", 4]]),
    deadlineDays: 8,
    submission: {
      type: "link",
      url: "https://github.com/sairoshan-design/banking-app-onboarding",
      caption: "Final Figma file + exported assets and a short handoff doc for the dev team.",
    },
    review: {
      rating: 5,
      feedback: "Sai completely reworked our banking app's onboarding flow and the drop-off numbers improved almost immediately after launch. He pushed back politely on a couple of ideas that would've hurt usability, which we appreciated more in hindsight.",
    },
  },
  {
    title: "Design System & Component Library",
    description: "Build a proper design system for our dashboard product — we'd been shipping inconsistent components for a year and it was starting to show.",
    budget: 22000,
    timeline: timelineFor([["INVITED", 40], ["ACCEPTED", 37], ["FUNDS_SECURED", 33], ["WORK_IN_PROGRESS", 22], ["FILES_SUBMITTED", 9], ["COMPLETED", 7]]),
    deadlineDays: 12,
    submission: {
      type: "link",
      url: "https://github.com/sairoshan-design/saas-design-system",
      caption: "Component library + Figma library file, versioned and documented.",
    },
    review: {
      rating: 5,
      feedback: "Handed him a pretty inconsistent product and he came back with a proper design system — spacing, typography, component variants, the works. Our dev team says it's made building new screens much faster.",
    },
  },
  {
    title: "Landing Page Conversion Redesign",
    description: "Our main product landing page wasn't converting — needed a redesign focused on getting people to the pricing section faster.",
    budget: 16000,
    timeline: timelineFor([["INVITED", 20], ["ACCEPTED", 18], ["FUNDS_SECURED", 15], ["WORK_IN_PROGRESS", 9], ["FILES_SUBMITTED", 3], ["COMPLETED", 1]]),
    deadlineDays: 5,
    submission: {
      type: "link",
      url: "https://github.com/sairoshan-design/landing-conversion-redesign",
      caption: "Final page build + before/after notes from the user testing round.",
    },
    review: {
      rating: 4,
      feedback: "Good eye for conversion-focused design. The first draft needed a couple of rounds of feedback before it landed, but he was quick to iterate and the final landing page performs noticeably better than our old one.",
    },
  },
];

async function main() {
  const worker = await usersRepo.findByEmail(WORKER_EMAIL);
  if (!worker) throw new Error(`No user found for ${WORKER_EMAIL} — this account must already exist.`);
  if (worker.role !== "worker") throw new Error(`${WORKER_EMAIL} exists but is role="${worker.role}", expected "worker".`);

  const business = await usersRepo.findByEmail(BUSINESS_EMAIL);
  if (!business) throw new Error(`No business found for ${BUSINESS_EMAIL} — sign up (and verify) this account first.`);

  await query(`UPDATE users SET name = $2 WHERE id = $1`, [worker.id, WORKER_NAME]);

  await usersRepo.updateSelf(worker.id, {
    title: "UI/UX Designer & Frontend Developer",
    profilePatch: {
      bio: "UI/UX designer and frontend developer with a focus on turning messy, inconsistent products into something clean and usable — I like being involved from user research through to the final React build, not just handing off a Figma file.",
      location: "Hyderabad, India",
      hourlyRate: 700,
      skills: ["Figma", "React", "Tailwind CSS", "User Research", "Design Systems"],
      education: EDUCATION,
      certifications: CERTIFICATIONS,
      projects: PORTFOLIO_PROJECTS,
    },
  });
  // behavior_score isn't part of updateSelf (title/phone/avatar/profile
  // only) — a direct update here, same as seed-worker-showcase.js does for
  // Arunkumar.
  await query(`UPDATE users SET behavior_score = 780 WHERE id = $1`, [worker.id]);
  console.log(`Corrected name to "${WORKER_NAME}" and filled in bio/skills/education/certifications/portfolio; behavior_score = 780.`);

  const { rows: adminRows } = await query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  const adminId = adminRows[0]?.id ?? null;

  for (const spec of REVIEW_PROJECTS) {
    const { rows: existingProject } = await query(
      `SELECT id FROM projects WHERE business_id = $1 AND worker_id = $2 AND title = $3`,
      [business.id, worker.id, spec.title]
    );
    if (existingProject.length > 0) {
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
  console.log("Recomputed users.rating/reviews_count from the reviews table.");

  console.log("\nDone. Reload Sai's profile (and /profiles/<his id>) to see it.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
