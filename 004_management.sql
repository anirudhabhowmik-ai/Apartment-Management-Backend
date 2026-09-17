-- =============================================================================
-- management.sql
--
-- Everything for member / staff / expense management:
--   • members                     — flat residents
--   • staff                       — workers hired by the society
--   • expenses                    — bills the society pays
--   • member_monthly_payments     — one row per member per month (paid/due)
--   • staff_attendance            — one row per staff per month (attendance)
--   • staff_monthly_payments      — one row per staff per month (paid/due)
--   • member_phone_visibility     — per-member phone visibility allow-list
--
-- Depends on (must exist first):
--   • users            (auth.sql)
--   • accounts         (account.sql)
--   • account_members  (roles.sql)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. MEMBERS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    name VARCHAR(150) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(60) NOT NULL DEFAULT 'owner'
        CHECK (role IN ('owner', 'secretary', 'tenant', 'custom')),
    photo_url TEXT,

    wing VARCHAR(50),
    flat_number VARCHAR(50) NOT NULL,
    area_sqft INTEGER,
    parking_available BOOLEAN NOT NULL DEFAULT FALSE,
    maintenance_amount NUMERIC(12,2) NOT NULL DEFAULT 0,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),

    created_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_account_id
    ON members(account_id);

CREATE INDEX IF NOT EXISTS idx_members_flat_number
    ON members(account_id, flat_number);

CREATE INDEX IF NOT EXISTS idx_members_phone
    ON members(phone);

CREATE INDEX IF NOT EXISTS idx_members_account_status
    ON members(account_id, status);


-- -----------------------------------------------------------------------------
-- 2. STAFF
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    name VARCHAR(150) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(60) NOT NULL
        CHECK (role IN ('sweeper', 'security', 'maintenance', 'gardener',
                        'driver', 'custom')),
    photo_url TEXT,

    monthly_salary NUMERIC(12,2) NOT NULL DEFAULT 0,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),

    created_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_account_id
    ON staff(account_id);

CREATE INDEX IF NOT EXISTS idx_staff_phone
    ON staff(phone);

CREATE INDEX IF NOT EXISTS idx_staff_account_status
    ON staff(account_id, status);


-- -----------------------------------------------------------------------------
-- 3. EXPENSES
-- due_date has been removed. expense_date is the single date column.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    category VARCHAR(60) NOT NULL,
    title VARCHAR(200) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,

    transaction_type VARCHAR(20) NOT NULL DEFAULT 'expense'
        CHECK (transaction_type IN ('expense', 'income')),

    status VARCHAR(20) NOT NULL DEFAULT 'paid'
        CHECK (status IN ('paid', 'due')),

    reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE,

    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,

    description TEXT,

    bill_attachments JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_account_id
    ON expenses(account_id);

CREATE INDEX IF NOT EXISTS idx_expenses_category
    ON expenses(account_id, category);

CREATE INDEX IF NOT EXISTS idx_expenses_status
    ON expenses(account_id, status);

CREATE INDEX IF NOT EXISTS idx_expenses_expense_date
    ON expenses(account_id, expense_date DESC);


-- -----------------------------------------------------------------------------
-- 4. MEMBER MONTHLY PAYMENTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_monthly_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    member_id UUID NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

    month CHAR(7) NOT NULL,
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('paid', 'due')),
    paid_date DATE,

    additional_amount NUMERIC(12,2),
    additional_note TEXT,

    deduction_amount NUMERIC(12,2),
    deduction_note TEXT,

    net_amount NUMERIC(12,2),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (member_id, month),

    CONSTRAINT member_monthly_payments_month_format
        CHECK (month ~ '^\d{4}-\d{2}$')
);

CREATE INDEX IF NOT EXISTS idx_member_monthly_payments_member_id
    ON member_monthly_payments(member_id);

CREATE INDEX IF NOT EXISTS idx_member_monthly_payments_month
    ON member_monthly_payments(month);


-- -----------------------------------------------------------------------------
-- 5. STAFF ATTENDANCE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    staff_id UUID NOT NULL
        REFERENCES staff(id)
        ON DELETE CASCADE,

    month CHAR(7) NOT NULL,

    statuses JSONB NOT NULL DEFAULT '{}'::jsonb,

    paid_days INTEGER NOT NULL DEFAULT 0,

    calculated_salary NUMERIC(12,2) NOT NULL DEFAULT 0,

    created_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (staff_id, month),

    CONSTRAINT staff_attendance_month_format
        CHECK (month ~ '^\d{4}-\d{2}$')
);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_staff_id
    ON staff_attendance(staff_id);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_account_month
    ON staff_attendance(account_id, month);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_month
    ON staff_attendance(month);


-- -----------------------------------------------------------------------------
-- 6. STAFF MONTHLY PAYMENTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_monthly_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    staff_id UUID NOT NULL
        REFERENCES staff(id)
        ON DELETE CASCADE,

    month CHAR(7) NOT NULL,
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('paid', 'due')),
    paid_date DATE,

    additional_amount NUMERIC(12,2),
    additional_note TEXT,

    deduction_amount NUMERIC(12,2),
    deduction_note TEXT,

    net_amount NUMERIC(12,2),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (staff_id, month),

    CONSTRAINT staff_monthly_payments_month_format
        CHECK (month ~ '^\d{4}-\d{2}$')
);

CREATE INDEX IF NOT EXISTS idx_staff_monthly_payments_staff_id
    ON staff_monthly_payments(staff_id);

CREATE INDEX IF NOT EXISTS idx_staff_monthly_payments_month
    ON staff_monthly_payments(month);


-- -----------------------------------------------------------------------------
-- 7. MEMBER PHONE VISIBILITY
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_phone_visibility (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    member_id UUID NOT NULL
        REFERENCES members(id)
        ON DELETE CASCADE,

    viewer_user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (member_id, viewer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_phone_vis_member
    ON member_phone_visibility(member_id);

CREATE INDEX IF NOT EXISTS idx_phone_vis_viewer
    ON member_phone_visibility(viewer_user_id);

CREATE INDEX IF NOT EXISTS idx_phone_vis_account
    ON member_phone_visibility(account_id);