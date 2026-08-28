-- Real Razorpay Route integration — replaces the simulated flat-15%-hidden
-- fee model with a disclosed split: business pays budget+8% at checkout,
-- worker receives budget-7% at payout, WorkBridge nets 15% automatically.

CREATE TYPE razorpay_account_status AS ENUM
  ('NOT_LINKED', 'PENDING', 'ACTIVE', 'NEEDS_CLARIFICATION', 'REJECTED');

-- Deliberately no bank_account_number/ifsc columns here — Route stores
-- those directly; WorkBridge only ever persists the acc_XXXX id Razorpay
-- hands back, never the raw bank details themselves.
ALTER TABLE users ADD COLUMN razorpay_account_id     TEXT UNIQUE;
ALTER TABLE users ADD COLUMN razorpay_account_status razorpay_account_status NOT NULL DEFAULT 'NOT_LINKED';
ALTER TABLE users ADD COLUMN razorpay_account_email  TEXT;
ALTER TABLE users ADD COLUMN razorpay_linked_at      TIMESTAMPTZ;

-- Replaces the single flat platform_fee_pct (kept, untouched, for
-- historical rows) with an asymmetric two-sided split.
ALTER TABLE projects ADD COLUMN business_fee_pct NUMERIC(5, 2) NOT NULL DEFAULT 8.00;
ALTER TABLE projects ADD COLUMN worker_fee_pct   NUMERIC(5, 2) NOT NULL DEFAULT 7.00;
ALTER TABLE projects ADD COLUMN funding_method   TEXT NOT NULL DEFAULT 'RAZORPAY'
  CHECK (funding_method IN ('RAZORPAY', 'MANUAL_BANK_TRANSFER'));
ALTER TABLE projects ADD COLUMN razorpay_order_id    TEXT UNIQUE;
ALTER TABLE projects ADD COLUMN razorpay_payment_id  TEXT;
ALTER TABLE projects ADD COLUMN razorpay_transfer_id TEXT;
ALTER TABLE projects ADD COLUMN razorpay_refund_id   TEXT;

-- Distinguishes a worker's real bank payout (Route transfer) from an
-- in-app wallet credit awaiting manual withdrawal — completeProject picks
-- between them per-project depending on whether the worker has a linked,
-- ACTIVE Razorpay account at completion time.
ALTER TABLE transactions ADD COLUMN settlement_method TEXT NOT NULL DEFAULT 'WALLET'
  CHECK (settlement_method IN ('WALLET', 'RAZORPAY_ROUTE_AUTO', 'WALLET_PENDING_MANUAL'));

-- The business's disclosed 8% fee, collected at checkout — a separate
-- ledger row from the existing PLATFORM_FEE type, which continues to mean
-- exactly what it means today: the 7% withheld from the worker's payout.
-- Postgres requires a freshly-added enum value to be committed before it
-- can be used in an INSERT — this migration only adds the value, the
-- webhook handler is the first thing that ever writes it.
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'PLATFORM_FEE_BUSINESS';

-- Idempotency + audit trail for incoming Razorpay webhook deliveries —
-- Razorpay retries aggressively on anything but a fast 200, and the same
-- event can arrive more than once; razorpay_event_id is the dedupe key.
CREATE TABLE razorpay_webhook_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  razorpay_event_id TEXT NOT NULL UNIQUE,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  processed_at      TIMESTAMPTZ,
  processing_error  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_razorpay_webhook_events_type ON razorpay_webhook_events (event_type, created_at DESC);
