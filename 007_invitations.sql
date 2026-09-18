-- ============================================================
-- INVITATIONS
-- ============================================================
DROP TABLE IF EXISTS invitations CASCADE;

CREATE TABLE invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invited_by        UUID NOT NULL REFERENCES users(id),
  invited_phone     TEXT NOT NULL,
  invited_name      TEXT,
  role              TEXT NOT NULL
                      CHECK (role IN (
                        'admin',
                        'member_visibility',
                        'staff_visibility'
                      )),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN (
                        'pending',
                        'accepted',
                        'rejected',
                        'revoked',
                        'cancelled'
                      )),
  target_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
  target_staff_id   UUID REFERENCES staff(id)   ON DELETE SET NULL,
  accepted_by       UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at      TIMESTAMPTZ,
  dismissed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_invitations_account ON invitations(account_id);
CREATE INDEX IF NOT EXISTS idx_invitations_phone   ON invitations(invited_phone);
CREATE INDEX IF NOT EXISTS idx_invitations_status  ON invitations(status);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_invite
  ON invitations(account_id, invited_phone, role)
  WHERE status = 'pending';

-- ============================================================
-- ACCOUNT MEMBERS
--
-- One row PER ROLE. A user can be admin AND member AND staff
-- on the same account — that's three rows.
-- ============================================================
DROP TABLE IF EXISTS account_members CASCADE;

CREATE TABLE account_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role        TEXT NOT NULL
                CHECK (role IN (
                  'admin',
                  'member_visibility',
                  'staff_visibility'
                )),
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_account_members_account ON account_members(account_id);
CREATE INDEX IF NOT EXISTS idx_account_members_user    ON account_members(user_id);
CREATE INDEX IF NOT EXISTS idx_account_members_role    ON account_members(account_id, user_id, role);