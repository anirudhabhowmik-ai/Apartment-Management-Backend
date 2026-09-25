-- ===========================================================================
-- AUDIT LOG — FULL SETUP (normalized)
-- Safe to re-run. Every statement is idempotent.
--
-- audit_log stores ONLY:
--   * IDs (actor_user_id, and entity_id which resolves the target)
--   * a frozen actor_role (the role the actor had at action time)
--   * a frozen summary string
--   * the before/after JSONB and metadata
--
-- Names, phones, and photos are fetched fresh from the users table at
-- read time via JOIN. They are NEVER stored here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Base table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID,
  actor_user_id UUID,
  actor_role    TEXT,
  entity_type   TEXT NOT NULL,
  entity_id     UUID,
  action        TEXT NOT NULL,
  before        JSONB,
  after         JSONB,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Make sure the two columns the current code requires exist.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS summary    TEXT;

-- If the table still has legacy identity-snapshot columns, drop them.
-- This is what keeps audit_log lean going forward.
ALTER TABLE audit_log
  DROP COLUMN IF EXISTS actor_name,
  DROP COLUMN IF EXISTS actor_phone,
  DROP COLUMN IF EXISTS actor_photo,
  DROP COLUMN IF EXISTS target_user_id,
  DROP COLUMN IF EXISTS target_name,
  DROP COLUMN IF EXISTS target_phone,
  DROP COLUMN IF EXISTS target_photo;

-- ---------------------------------------------------------------------------
-- 2. Visibility constraint.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_visibility_check'
  ) THEN
    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_visibility_check
      CHECK (visibility IN ('admin', 'public', 'self', 'participants'));
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 3. Indexes.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS audit_log_account_entity_idx
  ON audit_log (account_id, entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_account_vis_idx
  ON audit_log (account_id, visibility, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_actor_idx
  ON audit_log (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_created_idx
  ON audit_log (created_at DESC);

-- Drop the old target_user_idx if it exists (column no longer present).
DROP INDEX IF EXISTS audit_log_target_user_idx;

-- ---------------------------------------------------------------------------
-- 4. Ownership transfer trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ownership_transfers (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         UUID NOT NULL,
  previous_owner_id  UUID,
  new_owner_id       UUID NOT NULL,
  invitation_id      UUID,
  transferred_by     UUID,
  transferred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ownership_transfers_account_idx
  ON ownership_transfers (account_id, transferred_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Cleanup: remove legacy attendance rows (no longer logged).
-- ---------------------------------------------------------------------------
DELETE FROM audit_log
 WHERE entity_type = 'staff'
   AND action = 'attendance_marked';

-- ---------------------------------------------------------------------------
-- 6. Sanity checks.
-- ---------------------------------------------------------------------------
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'audit_log'
 ORDER BY ordinal_position;
-- Expected columns:
--   id, account_id, actor_user_id, actor_role, entity_type, entity_id,
--   action, before, after, metadata, created_at, visibility, summary

SELECT COUNT(*) AS attendance_rows_left
  FROM audit_log
 WHERE entity_type = 'staff' AND action = 'attendance_marked';
-- Expected: 0