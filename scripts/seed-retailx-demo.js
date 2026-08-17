// backend/scripts/seed-retailx-demo.js
// Seeds one real, persisted demo scenario — a business ("RetailX Pvt Ltd")
// and a worker ("Priya Sharma") with a COMPLETED project between them, a
// full ledger trail, and an approved deliverable — so logging in for real
// (via POST /api/auth/send-otp + verify-otp, no Resend needed in dev; the
// OTP prints to this same console) shows real data through the already-
// built, already-protected REST API instead of the client-side dev-bypass
// mock in Frontend/src/app/lib/apiClient.js.
//
// Run from the backend/ directory so dotenv/config picks up backend/.env:
//   node scripts/seed-retailx-demo.js [--password "..."]

import "dotenv/config";
import bcrypt from "bcryptjs";
import { query, transaction } from "../src/db/client.js";
import * as usersRepo from "../src/repositories/users.repository.js";
import * as adminRepo from "../src/repositories/admin.repository.js";
import * as transactionsRepo from "../src/repositories/transactions.repository.js";
import * as submissionsRepo from "../src/repositories/submissions.repository.js";

const SALT_ROUNDS = 10;
const BUSINESS_EMAIL = "retailx@workbridge.dev";
const WORKER_EMAIL = "priya.sharma@workbridge.dev";
const PROJECT_TITLE = "E-commerce Storefront Revamp";

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, "");
    args[key] = process.argv[i + 1];
  }
  return args;
}

const { password = "Password123!" } = parseArgs();
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Mirrors apiClient.js's timelineFor/daysAgo shape (both `at` and
// `timestamp` keys — some frontend components read one, some the other).
function timelineFor(statusesWithAge) {
  return statusesWithAge.map(([status, ageDays]) => {
    const at = daysAgo(ageDays).toISOString();
    return { status, at, timestamp: at };
  });
}

async function findOrCreateUser({ role, name, email, phone }) {
  const existing = await usersRepo.findByEmail(email);
  if (existing) return existing;

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  return usersRepo.create({ role, name, email, phone, passwordHash });
}

async function main() {
  const business = await findOrCreateUser({
    role: "business",
    name: "RetailX Pvt Ltd",
    email: BUSINESS_EMAIL,
    phone: "9876500001",
  });
  const worker = await findOrCreateUser({
    role: "worker",
    name: "Priya Sharma",
    email: WORKER_EMAIL,
    phone: "9876500002",
  });

  await adminRepo.setUserVerified({ query }, business.id, true);
  await adminRepo.setUserVerified({ query }, worker.id, true);

  // Cosmetic parity with the client-side mock's numbers — no repo helper
  // touches these three columns since they're normally derived, not
  // directly settable; a one-off raw UPDATE is the deliberate exception
  // here, same as create-admin.js does for anything without a helper.
  await query(`UPDATE users SET behavior_score = 900, rating = 4.6, reviews_count = 18 WHERE id = $1`, [business.id]);
  await query(`UPDATE users SET behavior_score = 840, rating = 4.9, reviews_count = 32 WHERE id = $1`, [worker.id]);

  const { rows: existingProject } = await query(
    `SELECT id FROM projects WHERE business_id = $1 AND worker_id = $2 AND title = $3`,
    [business.id, worker.id, PROJECT_TITLE]
  );
  if (existingProject.length > 0) {
    console.log(`Already seeded — project "${PROJECT_TITLE}" (${existingProject[0].id}) exists. Skipping.`);
    printCredentials();
    process.exit(0);
  }

  const timeline = timelineFor([
    ["INVITED", 21],
    ["ACCEPTED", 18],
    ["FUNDS_SECURED", 15],
    ["WORK_IN_PROGRESS", 10],
    ["FILES_SUBMITTED", 4],
    ["COMPLETED", 2],
  ]);

  const budget = 52000;
  const feePct = 15;
  const fee = Math.round(budget * (feePct / 100));
  const earnings = budget - fee;

  const project = await transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO projects
         (business_id, worker_id, title, description, budget, platform_fee_pct, status, deadline, timeline)
       VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED'::project_status, $7, $8::jsonb)
       RETURNING *`,
      [
        business.id,
        worker.id,
        PROJECT_TITLE,
        "Rebuild the product listing and checkout flow for a retail storefront, improving conversion and mobile performance.",
        budget,
        feePct,
        daysAgo(2).toISOString().slice(0, 10),
        JSON.stringify(timeline),
      ]
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
        referenceNote: `Funds secured – ${PROJECT_TITLE}`,
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
        referenceNote: `Payment released – ${PROJECT_TITLE}`,
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
        referenceNote: `Platform fee – ${PROJECT_TITLE}`,
      },
      client
    );

    await usersRepo.incrementWalletBalance(client, worker.id, earnings);

    return insertedProject;
  });

  // Separate step, after commit: submissionsRepo.create() has no `client`
  // param (always runs through the bare pool), so it can't run inside the
  // same not-yet-committed transaction as the project INSERT without
  // hitting submissions.project_id's FK before that row is visible.
  const submission = await submissionsRepo.create({
    projectId: project.id,
    submittedBy: worker.id,
    type: "link",
    url: "https://drive.google.com/drive/folders/dev-retailx-final-delivery",
    caption: "Final build + handoff docs",
  });

  const { rows: adminRows } = await query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  await submissionsRepo.review({ query }, submission.id, {
    status: "APPROVED",
    reviewedBy: adminRows[0]?.id ?? null,
    rejectionReason: null,
  });

  console.log(`Seeded project "${PROJECT_TITLE}" (${project.id}) — COMPLETED, ₹${budget} (worker earned ₹${earnings}).`);
  console.log(`Seeded 1 approved submission (${submission.id}).`);
  printCredentials();
}

function printCredentials() {
  console.log("\nSign in for real (OTP prints to this console — no Resend needed in dev):");
  console.log(`  Business — ${BUSINESS_EMAIL} / ${password}`);
  console.log(`  Worker   — ${WORKER_EMAIL} / ${password}`);
  console.log("  POST /api/auth/send-otp {mode:'signin', ...} then POST /api/auth/verify-otp with the printed code.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
