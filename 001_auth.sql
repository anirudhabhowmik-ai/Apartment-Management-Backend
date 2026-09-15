CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(15) UNIQUE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login_at TIMESTAMPTZ,
    last_account_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone
ON users(phone);

CREATE INDEX IF NOT EXISTS idx_users_last_account_id
ON users(last_account_id);

-- Deferred FK: accounts is created later (002_accounts.sql), so we
-- attach the constraint here conditionally.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_users_last_account'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT fk_users_last_account
      FOREIGN KEY (last_account_id)
      REFERENCES accounts(id)
      ON DELETE SET NULL;
  END IF;
END $$;