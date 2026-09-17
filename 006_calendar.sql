-- =============================================================================
-- calendar.sql
--
-- Society calendar: notices, event bookings, approval workflow, RSVP responses.
--
-- Depends on (must exist first):
--   • users            (auth.sql)
--   • accounts         (account.sql)
--   • account_members  (roles.sql)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. CALENDAR EVENTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    title VARCHAR(200) NOT NULL,
    description TEXT,

    type VARCHAR(20) NOT NULL DEFAULT 'event'
        CHECK (type IN ('notice', 'event')),

    resource VARCHAR(100),          -- venue name, NULL for notices

    event_date DATE NOT NULL,
    start_time VARCHAR(20),         -- free-text "6:00 PM" (matches UI)
    end_time   VARCHAR(20),

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),

    is_important BOOLEAN NOT NULL DEFAULT FALSE,
    rsvp_enabled BOOLEAN NOT NULL DEFAULT FALSE,

    -- Poster (denormalized snapshot)
    created_by_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,
    created_by_name VARCHAR(150),
    created_by_phone VARCHAR(20),
    created_by_role VARCHAR(20)
        CHECK (created_by_role IN ('admin', 'owner', 'member')),

    -- Approver (denormalized snapshot)
    approved_by_id UUID
        REFERENCES users(id)
        ON DELETE SET NULL,
    approved_by_name VARCHAR(150),
    approved_by_phone VARCHAR(20),
    approved_by_role VARCHAR(20)
        CHECK (approved_by_role IN ('admin', 'owner')),

    rejection_reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_account
    ON calendar_events(account_id);

CREATE INDEX IF NOT EXISTS idx_calendar_events_account_date
    ON calendar_events(account_id, event_date);

CREATE INDEX IF NOT EXISTS idx_calendar_events_account_status
    ON calendar_events(account_id, status);

CREATE INDEX IF NOT EXISTS idx_calendar_events_created_by
    ON calendar_events(created_by_id);

CREATE INDEX IF NOT EXISTS idx_calendar_events_type
    ON calendar_events(account_id, type);

-- -----------------------------------------------------------------------------
-- 2. CALENDAR EVENT RESPONSES  (RSVP accept/reject)
-- One row per user per event.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_event_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    event_id UUID NOT NULL
        REFERENCES calendar_events(id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    name VARCHAR(150),
    phone VARCHAR(20),
    role VARCHAR(20)
        CHECK (role IN ('admin', 'owner', 'member')),

    response VARCHAR(20) NOT NULL
        CHECK (response IN ('accept', 'reject')),

    reason TEXT,        -- for reject
    note TEXT,          -- for accept

    responded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_responses_event
    ON calendar_event_responses(event_id);

CREATE INDEX IF NOT EXISTS idx_calendar_responses_user
    ON calendar_event_responses(user_id);