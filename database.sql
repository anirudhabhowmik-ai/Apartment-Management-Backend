-- =============================================
-- PROPERTY MANAGEMENT — ACCOUNT-CENTRIC SCHEMA
-- =============================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------
-- USERS (global identity, one per phone)
-- ---------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         VARCHAR(15) UNIQUE NOT NULL,     -- 91XXXXXXXXXX
  full_name     VARCHAR(255),
  email         VARCHAR(255) UNIQUE,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_phone ON users(phone);

-- ---------------------------------------------
-- ACCOUNTS (a property — apartment or home)
-- ---------------------------------------------
CREATE TABLE accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          VARCHAR(20) NOT NULL
                CHECK (type IN ('apartment', 'home')),
  name          VARCHAR(255) NOT NULL,
  photo_url     TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_created_by ON accounts(created_by);
CREATE INDEX idx_accounts_type       ON accounts(type);

-- ---------------------------------------------
-- MEMBERSHIPS (user ↔ account + role)
-- ---------------------------------------------
CREATE TABLE memberships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role          VARCHAR(30) NOT NULL
                CHECK (role IN ('admin', 'member_visibility', 'staff_visibility')),
  staff_title   VARCHAR(30)
                CHECK (staff_title IS NULL OR staff_title IN
                  ('security','sweeper','maintenance','gardener','driver')),
  joined_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, account_id)
);

CREATE INDEX idx_memberships_user    ON memberships(user_id);
CREATE INDEX idx_memberships_account ON memberships(account_id);

-- ---------------------------------------------
-- INVITATIONS (admin → phone, to join an account)
-- ---------------------------------------------
CREATE TABLE invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  invited_phone   VARCHAR(15) NOT NULL,
  role            VARCHAR(30) NOT NULL
                  CHECK (role IN ('admin', 'member_visibility', 'staff_visibility')),
  staff_title     VARCHAR(30)
                  CHECK (staff_title IS NULL OR staff_title IN
                    ('security','sweeper','maintenance','gardener','driver')),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','rejected','revoked','expired')),
  message         TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMP,
  accepted_at     TIMESTAMP,
  rejected_at     TIMESTAMP
);

CREATE INDEX idx_invitations_phone   ON invitations(invited_phone);
CREATE INDEX idx_invitations_account ON invitations(account_id);
CREATE INDEX idx_invitations_status  ON invitations(status);

-- ---------------------------------------------
-- OTP (used only if you send OTP yourself; not required for MSG91 widget)
-- ---------------------------------------------
CREATE TABLE otp_verifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        VARCHAR(15) NOT NULL,
  otp_hash     VARCHAR(255) NOT NULL,
  expires_at   TIMESTAMP NOT NULL,
  is_verified  BOOLEAN NOT NULL DEFAULT false,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otp_phone ON otp_verifications(phone);