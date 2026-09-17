CREATE TABLE IF NOT EXISTS account_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    role VARCHAR(20) NOT NULL
        CHECK (role IN ('owner', 'admin', 'member', 'staff')),

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),

    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_members_account_id
ON account_members(account_id);

CREATE INDEX IF NOT EXISTS idx_account_members_user_id
ON account_members(user_id);