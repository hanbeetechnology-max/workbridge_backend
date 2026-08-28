-- WALLET_PENDING_MANUAL admin visibility — until now a transaction settled
-- this way (Cashfree Payouts unavailable/not yet live at completion time,
-- see projects.controller.js's completeProject) was invisible anywhere in
-- the Admin Panel; the only way to find one was a direct DB query. These
-- columns let staff mark one as actually wired by hand (NEFT/RTGS) without
-- losing the historical fact that it wasn't auto-settled via Cashfree.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS manual_payout_completed_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS manual_payout_note TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_settlement_method ON transactions (settlement_method) WHERE settlement_method = 'WALLET_PENDING_MANUAL';
