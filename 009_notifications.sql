-- 0009_notifications.sql
-- Notifications projection over audit_log.
-- One row per (audit event, recipient user).
--
-- NOTE: audit_log.id is BIGINT in this project, so notifications.audit_log_id
-- must be BIGINT as well (not UUID).

-- If you already created an older version of notifications with the wrong
-- type, drop it first. Safe because the table is empty.
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS notification_preferences CASCADE;

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- No FK here — accounts/users live in the same DB but adding FKs makes
  -- this file non-idempotent when run against a partially-set-up DB.
  -- The app validates ownership in code.
  account_id      UUID NOT NULL,
  user_id         UUID NOT NULL,

  -- BIGINT, matching audit_log.id
  audit_log_id    BIGINT,

  entity_type     TEXT NOT NULL,
  entity_id       UUID,
  action          TEXT NOT NULL,

  title           TEXT NOT NULL,
  body            TEXT,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,

  read_at         TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  pushed_at       TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT notifications_audit_user_unique UNIQUE (audit_log_id, user_id)
);

CREATE INDEX idx_notifications_user_created
  ON notifications (user_id, created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL AND dismissed_at IS NULL;

CREATE INDEX idx_notifications_account
  ON notifications (account_id, created_at DESC);

CREATE TABLE notification_preferences (
  user_id         UUID NOT NULL,
  preference_key  TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preference_key)
);