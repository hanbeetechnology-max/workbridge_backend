import { query } from "../db/client.js";

export async function insert({ userId, tier, billingPeriod, amount, razorpayOrderId }) {
  const { rows } = await query(
    `INSERT INTO subscription_payments (user_id, tier, billing_period, amount, razorpay_order_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, tier, billingPeriod, amount, razorpayOrderId]
  );
  return rows[0];
}

export async function findByRazorpayOrderId(client, orderId) {
  const { rows } = await client.query(`SELECT * FROM subscription_payments WHERE razorpay_order_id = $1 FOR UPDATE`, [orderId]);
  return rows[0] ?? null;
}

export async function markPaid(client, id, { paymentId, periodStart, periodEnd }) {
  const { rows } = await client.query(
    `UPDATE subscription_payments
     SET status = 'PAID', razorpay_payment_id = $2, period_start = $3, period_end = $4, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, paymentId, periodStart, periodEnd]
  );
  return rows[0] ?? null;
}

export async function listForUser(userId) {
  const { rows } = await query(
    `SELECT * FROM subscription_payments WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}
