-- ============================================================
-- 1. Invitations table
-- ============================================================
CREATE TABLE IF NOT EXISTS invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invited_by        UUID NOT NULL REFERENCES users(id),
  invited_phone     TEXT NOT NULL,                    -- normalized 10-digit
  invited_name      TEXT,
  role              TEXT NOT NULL
                      CHECK (role IN ('admin','member_visibility','staff_visibility')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','accepted','rejected','revoked','cancelled')),
  target_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
  target_staff_id   UUID REFERENCES staff(id)   ON DELETE SET NULL,
  accepted_by       UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at      TIMESTAMPTZ,
  dismissed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_invitations_account  ON invitations(account_id);
CREATE INDEX IF NOT EXISTS idx_invitations_phone    ON invitations(invited_phone);
CREATE INDEX IF NOT EXISTS idx_invitations_status   ON invitations(status);

-- Prevent duplicate pending invites for same phone + role on same account
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_invite
  ON invitations(account_id, invited_phone, role)
  WHERE status = 'pending';