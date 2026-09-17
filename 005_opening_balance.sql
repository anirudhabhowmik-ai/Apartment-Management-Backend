-- =============================================================================
-- opening_balance.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS account_opening_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL UNIQUE
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,

    updated_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opening_balance_account_id
    ON account_opening_balances(account_id);