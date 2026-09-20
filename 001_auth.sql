-- =============================================================================
-- auth.sql
--
-- users — auth identity table.
--
--   phone       — required, login identifier, UNIQUE
--   name        — optional, editable via PUT /me
--   photo_url   — optional, editable via PUT /me
--   is_active   — account status
--   last_login_at, last_account_id — session hints
--
-- Login is by phone only. name and photo_url are never required.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. Create the table (fresh install)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    phone VARCHAR(15) UNIQUE NOT NULL,

    name TEXT,
    photo_url TEXT,

    is_active BOOLEAN NOT NULL DEFAULT true,

    last_login_at TIMESTAMPTZ,
    last_account_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 2. Existing installs: add the two new columns if they are missing.
--    Safe to re-run.
-- -----------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS name TEXT,
    ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- -----------------------------------------------------------------------------
-- 3. Indexes
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_phone
    ON users(phone);

CREATE INDEX IF NOT EXISTS idx_users_last_account_id
    ON users(last_account_id);

-- -----------------------------------------------------------------------------
-- 4. Deferred FK on last_account_id
--    accounts is created in a later file, so we attach the constraint
--    conditionally.
-- -----------------------------------------------------------------------------
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

-- =============================================================================
-- Verify:
-- \d users
-- SELECT id, phone, name, photo_url, is_active FROM users LIMIT 20;
-- =============================================================================