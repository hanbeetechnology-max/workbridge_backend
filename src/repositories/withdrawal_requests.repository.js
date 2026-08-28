import { query } from "../db/client.js";

export async function insert(client, { workerId, amount, payoutMethod, payoutDetails }) {
  const { rows } = await client.query(
    `INSERT INTO withdrawal_requests (worker_id, amount, payout_method, payout_details)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [workerId, amount, payoutMethod, payoutDetails]
  );
  return rows[0];
}

export async function findById(id) {
  const { rows } = await query(`SELECT * FROM withdrawal_requests WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// FOR UPDATE — locks the row so two concurrent resolve attempts on the same
// request can't both succeed (mirrors projects.repository.js's
// findByIdForUpdate, same reasoning).
export async function findByIdForUpdate(client, id) {
  const { rows } = await client.query(`SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ?? null;
}

export async function markResolved(client, id, { status, adminNote, resolvedBy, payoutId }) {
  const { rows } = await client.query(
    `UPDATE withdrawal_requests
     SET status = $2, admin_note = $3, resolved_by = $4, razorpay_payout_id = $5, resolved_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, status, adminNote ?? null, resolvedBy, payoutId ?? null]
  );
  return rows[0] ?? null;
}

// Admin's "Withdrawals" queue — oldest first, same convention as
// admin.repository.js's listPendingReleases.
export async function listPending() {
  const { rows } = await query(
    `SELECT wr.*, w.name AS worker_name,
            EXISTS (
              SELECT 1 FROM perk_purchases pp
              WHERE pp.perk_id = 'withdrawal-fast-track' AND pp.target_id = wr.id
                AND pp.consumed_at IS NULL AND (pp.expires_at IS NULL OR pp.expires_at > now())
            ) AS has_fast_track
     FROM withdrawal_requests wr
     JOIN public_user_profiles w ON w.id = wr.worker_id
     WHERE wr.status = 'PENDING'
     ORDER BY has_fast_track DESC, wr.created_at ASC`
  );
  return rows;
}

export async function listForWorker(workerId) {
  const { rows } = await query(
    `SELECT * FROM withdrawal_requests WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [workerId]
  );
  return rows;
}
