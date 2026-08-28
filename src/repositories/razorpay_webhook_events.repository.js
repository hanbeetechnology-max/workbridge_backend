import { query } from "../db/client.js";

// ON CONFLICT DO NOTHING on CashFree_event_id (UNIQUE) is the real
// idempotency guard — CashFree retries webhook delivery aggressively, and
// this makes a duplicate delivery a no-op read instead of a second
// processing attempt. Returns null (not the existing row) on a duplicate
// so the caller can tell "already seen" apart from "brand new."
export async function insertIfNew({ eventId, eventType, payload }) {
  const { rows } = await query(
    `INSERT INTO CashFree_webhook_events (CashFree_event_id, event_type, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (CashFree_event_id) DO NOTHING
     RETURNING *`,
    [eventId, eventType, JSON.stringify(payload)]
  );
  return rows[0] ?? null;
}

export async function markProcessed(eventId, error = null) {
  await query(
    `UPDATE CashFree_webhook_events SET processed_at = now(), processing_error = $2 WHERE CashFree_event_id = $1`,
    [eventId, error]
  );
}
