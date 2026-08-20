import { query } from "../db/client.js";

export async function insert(
  { projectId, workerId, businessId, type, direction, amount, fundsStatus, referenceNote },
  client = { query }
) {
  const { rows } = await client.query(
    `INSERT INTO transactions (project_id, worker_id, business_id, type, direction, amount, funds_status, reference_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [projectId, workerId, businessId, type, direction, amount, fundsStatus ?? null, referenceNote ?? null]
  );
  return rows[0];
}

// PLATFORM_FEE rows are excluded — this is the "my own wallet/transaction
// history" endpoint (GET /api/wallet), surfaced directly to the worker or
// business it belongs to. The fee is real and still fully audited (the row
// exists, just never returned here); admin-facing analytics reads it
// straight from the table, unfiltered — see admin.repository.js.
//
// FUNDS_SECURED is also excluded, but only from the WORKER's side of that
// same row (worker_id = $1) — it carries the project's full pre-fee budget,
// and showing it next to the worker's own PAYOUT row (the post-fee 85%) lets
// the exact 15% be derived by subtraction, the same leak the PLATFORM_FEE
// exclusion above exists to prevent. The business's own view of their own
// deposit is unaffected — worker_id and business_id are never the same
// person on one row, so this only ever suppresses the worker's copy.
export async function listForUser(userId, { page, pageSize }) {
  const { rows } = await query(
    `SELECT * FROM transactions
     WHERE (worker_id = $1 OR business_id = $1)
       AND type != 'PLATFORM_FEE'
       AND NOT (type = 'FUNDS_SECURED' AND worker_id = $1)
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, pageSize, (page - 1) * pageSize]
  );
  return rows;
}

// The Enterprise Partner Tier's real basis — total money a business has
// actually committed to escrow (FUNDS_SECURED, the moment it leaves their
// side), not XP. Counts every project regardless of outcome — spend is
// spend whether the project later completes or disputes.
export async function sumFundsSecuredForBusiness(businessId) {
  const { rows } = await query(
    `SELECT COALESCE(sum(amount), 0)::numeric AS total
     FROM transactions
     WHERE business_id = $1 AND type = 'FUNDS_SECURED'`,
    [businessId]
  );
  return Number(rows[0].total);
}
