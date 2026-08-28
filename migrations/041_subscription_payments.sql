-- Manual pay-per-period subscription payments — a plain one-time Razorpay
-- Checkout charge per billing period, NOT a recurring auto-charge (that
-- would need a UPI Autopay/NACH e-mandate, a separate regulated flow).
-- The user re-visits and pays again each period; nothing auto-bills them.

CREATE TYPE subscription_tier AS ENUM
  ('FREE', 'GROWTH', 'ENTERPRISE', 'PRO', 'ELITE');
-- GROWTH/ENTERPRISE are business tiers, PRO/ELITE are worker tiers — one
-- enum covers both since a payment row is always scoped to one user whose
-- role already determines which subset is valid (enforced in the
-- controller, not the DB).

CREATE TYPE subscription_billing_period AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE subscription_payment_status AS ENUM ('PENDING', 'PAID', 'FAILED');

CREATE TABLE subscription_payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tier               subscription_tier NOT NULL,
  billing_period     subscription_billing_period NOT NULL,
  amount             NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  razorpay_order_id  TEXT UNIQUE,
  razorpay_payment_id TEXT,
  status             subscription_payment_status NOT NULL DEFAULT 'PENDING',
  period_start       TIMESTAMPTZ,
  period_end         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscription_payments_user ON subscription_payments (user_id, created_at DESC);

-- Cached current-plan lookup — the source of truth is the PAID row in
-- subscription_payments with the latest period_end, but this avoids a
-- join on every page load. Kept in sync by the webhook the same moment it
-- marks a subscription_payments row PAID.
ALTER TABLE users ADD COLUMN subscription_tier subscription_tier NOT NULL DEFAULT 'FREE';
ALTER TABLE users ADD COLUMN subscription_expires_at TIMESTAMPTZ;
