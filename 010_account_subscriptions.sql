-- sql/010_account_subscriptions.sql
--
-- Adds per-account subscription state and (optional) payment history.
-- Safe to run multiple times: uses IF NOT EXISTS and ON CONFLICT DO NOTHING.

-- ─── Subscription state (one row per account) ─────────────────────────────
CREATE TABLE IF NOT EXISTS account_subscriptions (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL DEFAULT 'free',
  billing_period TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'trialing',   -- trialing | active | cancelled | expired
  trial_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  razorpay_payment_id TEXT,
  razorpay_order_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_subscriptions_status
  ON account_subscriptions(status);

CREATE INDEX IF NOT EXISTS idx_account_subscriptions_trial_ends
  ON account_subscriptions(trial_ends_at);

-- ─── Backfill: give every existing account a 90-day trial from creation ───
INSERT INTO account_subscriptions (account_id, trial_started_at, trial_ends_at)
SELECT id, created_at, created_at + INTERVAL '90 days'
  FROM accounts
ON CONFLICT (account_id) DO NOTHING;

-- ─── Optional: payment history (nice for support / receipts) ──────────────
CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  razorpay_signature TEXT,
  status TEXT NOT NULL DEFAULT 'success',    -- success | failed | refunded
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_account
  ON subscription_payments(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_razorpay
  ON subscription_payments(razorpay_payment_id);