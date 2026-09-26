-- 0009_notifications.sql
-- Notifications projection over audit_log.
-- One row per (audit event, recipient user).
--
-- NOTE: audit_log.id is BIGINT in this project, so notifications.audit_log_id
-- must be BIGINT as well (not UUID).
--
-- This file also owns the rest of the notification subsystem:
--   • notifications            — inbox + push delivery log
--   • notification_preferences — per-user opt-in/out
--   • user_push_tokens         — Expo push tokens, one row per device per user
--   • scheduled_reminders      — deferred reminders that enqueue notifications
--
-- Depends on (must exist first):
--   • users      (auth.sql)
--   • accounts   (account.sql)
--   • audit_log  (audit.sql)   ← notifications.audit_log_id references it by convention
-- =============================================================================

-- If you already created an older version of notifications with the wrong
-- type, drop it first. Safe because the table is empty.
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS notification_preferences CASCADE;

-- -----------------------------------------------------------------------------
-- 1. NOTIFICATIONS — inbox + push delivery log
-- -----------------------------------------------------------------------------
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

-- Feeds the push worker: find rows that haven't been delivered yet.
CREATE INDEX idx_notifications_pending_push
  ON notifications (created_at)
  WHERE pushed_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2. NOTIFICATION PREFERENCES — per-user opt-in/out per key
-- -----------------------------------------------------------------------------
CREATE TABLE notification_preferences (
  user_id         UUID NOT NULL,
  preference_key  TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preference_key)
);

-- -----------------------------------------------------------------------------
-- 3. USER PUSH TOKENS — one row per device per user
--
-- Expo push tokens are device-scoped, not user-scoped. A user signed in on
-- two phones has two rows. On logout, DELETE the row for that token.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_push_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    TEXT CHECK (platform IN ('ios', 'android', 'web') OR platform IS NULL),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user
  ON user_push_tokens(user_id);

-- -----------------------------------------------------------------------------
-- 4. SCHEDULED REMINDERS — generic "fire at time T" queue
--
-- Today only entity_type='expense' is used. The shape supports member dues,
-- staff salary, calendar events, etc. without schema changes.
--
-- A reminder, when due, enqueues one or more `notifications` rows. Those rows
-- are then delivered as push by the worker (they have pushed_at IS NULL).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_reminders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  entity_type  TEXT NOT NULL,
  entity_id    UUID NOT NULL,

  remind_at    TIMESTAMPTZ NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,

  sent_at      TIMESTAMPTZ,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active reminder per entity (upsert target)
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_reminders_entity
  ON scheduled_reminders(entity_type, entity_id);

-- Fast lookup for the cron worker
CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_due
  ON scheduled_reminders(remind_at)
  WHERE sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_account
  ON scheduled_reminders(account_id);