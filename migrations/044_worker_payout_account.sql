-- A worker's saved payout destination (bank account or UPI VPA), used to
-- pay them directly via RazorpayX at project completion (see
-- projects.controller.js's completeProject / admin.controller.js's
-- resolveDispute) without requiring the Razorpay Route linked-account flow
-- (razorpay_account_id/status), which stays blocked pending RBI review.
-- Same shape as withdrawal_requests.payout_method/payout_details — this is
-- just a persisted default so a worker doesn't have to retype it on every
-- single project completion.
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_method payout_method NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_details TEXT NULL;

-- RAZORPAYX_PAYOUT — a direct RazorpayX payout at completion/dispute-release
-- time (see above), distinct from RAZORPAY_ROUTE_AUTO (a Route
-- payment-linked transfer, which stays unused while Route is blocked).
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_settlement_method_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_settlement_method_check
  CHECK (settlement_method IN ('WALLET', 'RAZORPAY_ROUTE_AUTO', 'WALLET_PENDING_MANUAL', 'RAZORPAYX_PAYOUT'));
