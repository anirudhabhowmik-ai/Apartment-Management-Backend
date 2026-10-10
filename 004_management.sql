CREATE TABLE IF NOT EXISTS members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    user_id UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    role VARCHAR(60) NOT NULL DEFAULT 'flat'
        CHECK (role IN ('flat', 'shop', 'custom')),

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

CREATE INDEX IF NOT EXISTS idx_members_user_id
    ON members(user_id);

CREATE INDEX IF NOT EXISTS idx_members_flat_number
    ON members(account_id, flat_number);

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

    user_id UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    role VARCHAR(60) NOT NULL
        CHECK (role IN ('sweeper', 'security', 'maintenance', 'gardener',
                        'driver', 'accountant', 'custom')),

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

CREATE INDEX IF NOT EXISTS idx_staff_user_id
    ON staff(user_id);

CREATE INDEX IF NOT EXISTS idx_staff_account_status
    ON staff(account_id, status);


-- -----------------------------------------------------------------------------
-- 3. EXPENSES
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


-- -----------------------------------------------------------------------------
-- 8. VEHICLES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    member_id UUID
        REFERENCES members(id)
        ON DELETE SET NULL,

    user_id UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    vehicle_number VARCHAR(20) NOT NULL,

    owner_name VARCHAR(200) NOT NULL DEFAULT '',
    flat_number VARCHAR(50) NOT NULL DEFAULT '',
    wing VARCHAR(50),
    owner_phone VARCHAR(20) NOT NULL DEFAULT '',

    vehicle_type VARCHAR(20) NOT NULL DEFAULT 'car'
        CHECK (vehicle_type IN ('car', 'bike', 'other')),

    registered_by_guard BOOLEAN NOT NULL DEFAULT FALSE,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),

    created_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (account_id, vehicle_number)
);

CREATE INDEX IF NOT EXISTS idx_vehicles_account_id
    ON vehicles(account_id);

CREATE INDEX IF NOT EXISTS idx_vehicles_member_id
    ON vehicles(member_id);

CREATE INDEX IF NOT EXISTS idx_vehicles_number
    ON vehicles(account_id, vehicle_number);

CREATE INDEX IF NOT EXISTS idx_vehicles_flat
    ON vehicles(account_id, flat_number);


CREATE TABLE IF NOT EXISTS gate_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    member_id UUID
        REFERENCES members(id)
        ON DELETE SET NULL,
    wing VARCHAR(50),
    flat_number VARCHAR(50) NOT NULL,

    created_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    category VARCHAR(30) NOT NULL
        CHECK (category IN ('delivery','helper','guest','cab','service','other')),

    pass_mode VARCHAR(10) NOT NULL DEFAULT 'open'
        CHECK (pass_mode IN ('open','named')),

    visitor_name VARCHAR(200),
    visitor_phone VARCHAR(20),
    vehicle_number VARCHAR(20),
    vehicles JSONB NOT NULL DEFAULT '[]'::jsonb,

    guest_count INTEGER NOT NULL DEFAULT 1,

    valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ NOT NULL,

    used_count  INTEGER NOT NULL DEFAULT 0,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','expired','cancelled')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gate_auth_account_status
    ON gate_authorizations(account_id, status, valid_until);

CREATE INDEX IF NOT EXISTS idx_gate_auth_lookup
    ON gate_authorizations(account_id, flat_number, status);

CREATE INDEX IF NOT EXISTS idx_gate_auth_member
    ON gate_authorizations(member_id, status);

CREATE INDEX IF NOT EXISTS idx_gate_auth_created_by
    ON gate_authorizations(created_by, status);

CREATE INDEX IF NOT EXISTS idx_gate_auth_match
    ON gate_authorizations(account_id, flat_number, category, pass_mode, status);

CREATE INDEX IF NOT EXISTS idx_gate_auth_vehicles_gin
    ON gate_authorizations USING GIN (vehicles jsonb_path_ops);


-- -----------------------------------------------------------------------------
-- 10. GATE INVITES  (QR-code guest invites)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gate_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    created_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    member_id UUID
        REFERENCES members(id)
        ON DELETE SET NULL,
    wing VARCHAR(50),
    flat_number VARCHAR(50) NOT NULL,

    guest_name VARCHAR(200) NOT NULL,
    guest_phone VARCHAR(20),
    purpose VARCHAR(40) NOT NULL DEFAULT 'guest'
        CHECK (purpose IN ('guest','delivery','cab','service','other')),
    guest_count INTEGER NOT NULL DEFAULT 1,
    vehicle_number VARCHAR(20),
    vehicles JSONB NOT NULL DEFAULT '[]'::jsonb,

    valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ NOT NULL,

    code VARCHAR(24) NOT NULL UNIQUE,

    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','used','expired','cancelled')),
    used_at TIMESTAMPTZ,
    used_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gate_invites_account_status
    ON gate_invites(account_id, status, valid_until);

CREATE INDEX IF NOT EXISTS idx_gate_invites_code
    ON gate_invites(code);

CREATE INDEX IF NOT EXISTS idx_gate_invites_created_by
    ON gate_invites(created_by, status);

CREATE INDEX IF NOT EXISTS idx_gate_invites_vehicles_gin
    ON gate_invites USING GIN (vehicles jsonb_path_ops);


-- -----------------------------------------------------------------------------
-- 11. GATE ENTRIES  (log of guard-logged visitors)
--
-- NOTE: defined AFTER gate_authorizations and gate_invites so FKs resolve.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gate_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    vehicle_number VARCHAR(20) NOT NULL,

    vehicle_id UUID
        REFERENCES vehicles(id)
        ON DELETE SET NULL,

    member_id UUID
        REFERENCES members(id)
        ON DELETE SET NULL,

    owner_name VARCHAR(200),
    flat_number VARCHAR(50),
    owner_phone VARCHAR(20),

    registered BOOLEAN NOT NULL DEFAULT FALSE,
    direction VARCHAR(10) NOT NULL DEFAULT 'in'
        CHECK (direction IN ('in', 'out')),

    scanned_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    visitor_type VARCHAR(20) NOT NULL DEFAULT 'resident'
        CHECK (visitor_type IN ('resident','visitor','invited_guest','delivery','cab','service','other')),
    visitor_name VARCHAR(200),
    visitor_phone VARCHAR(20),
    purpose VARCHAR(40),
    vehicle_type VARCHAR(20),

    invite_id UUID
        REFERENCES gate_invites(id) ON DELETE SET NULL,

    authorization_id UUID
        REFERENCES gate_authorizations(id) ON DELETE SET NULL,

    rejected BOOLEAN NOT NULL DEFAULT FALSE,
    notified BOOLEAN NOT NULL DEFAULT FALSE,

    guests   JSONB NOT NULL DEFAULT '[]'::jsonb,
    vehicles JSONB NOT NULL DEFAULT '[]'::jsonb,

    status VARCHAR(30) NOT NULL DEFAULT 'auto_approved'
        CHECK (status IN (
            'auto_approved',
            'invite_approved',
            'pass_approved',
            'pending_approval',
            'approved',
            'approved_by_guard_override',
            'rejected'
        )),

    approved_by UUID
        REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_gate_entries_account_time
    ON gate_entries(account_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_gate_entries_vehicle
    ON gate_entries(account_id, vehicle_number);

CREATE INDEX IF NOT EXISTS idx_gate_entries_invite
    ON gate_entries(invite_id);

CREATE INDEX IF NOT EXISTS idx_gate_entries_authorization
    ON gate_entries(authorization_id);

CREATE INDEX IF NOT EXISTS idx_gate_entries_pending
    ON gate_entries(account_id, status, scanned_at DESC)
    WHERE status = 'pending_approval';

CREATE INDEX IF NOT EXISTS idx_gate_entries_member
    ON gate_entries(account_id, member_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_gate_entries_vehicles_gin
    ON gate_entries USING GIN (vehicles jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_gate_entries_guests_gin
    ON gate_entries USING GIN (guests jsonb_path_ops);


-- =============================================================================
-- 12. IDEMPOTENT MIGRATIONS
--
-- Safe to run against existing databases. Every statement is a no-op if the
-- column / index / constraint already exists.
-- =============================================================================

-- ─── gate_authorizations: pass_mode, vehicles ─────────────────────────────
ALTER TABLE gate_authorizations
    ADD COLUMN IF NOT EXISTS pass_mode VARCHAR(10) NOT NULL DEFAULT 'open'
        CHECK (pass_mode IN ('open','named')),
    ADD COLUMN IF NOT EXISTS vehicles JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_gate_auth_match
    ON gate_authorizations(account_id, flat_number, category, pass_mode, status);

CREATE INDEX IF NOT EXISTS idx_gate_auth_vehicles_gin
    ON gate_authorizations USING GIN (vehicles jsonb_path_ops);

-- ─── gate_entries: authorization_id, guests, vehicles ─────────────────────
ALTER TABLE gate_entries
    ADD COLUMN IF NOT EXISTS authorization_id UUID
        REFERENCES gate_authorizations(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS guests   JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS vehicles JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_gate_entries_authorization
    ON gate_entries(authorization_id);

CREATE INDEX IF NOT EXISTS idx_gate_entries_vehicles_gin
    ON gate_entries USING GIN (vehicles jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_gate_entries_guests_gin
    ON gate_entries USING GIN (guests jsonb_path_ops);

-- ─── gate_invites: vehicles ───────────────────────────────────────────────
ALTER TABLE gate_invites
    ADD COLUMN IF NOT EXISTS vehicles JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_gate_invites_vehicles_gin
    ON gate_invites USING GIN (vehicles jsonb_path_ops);

-- ─── Backfill: single vehicle_number → vehicles[] ─────────────────────────
UPDATE gate_authorizations
   SET vehicles = jsonb_build_array(
         jsonb_build_object('number', vehicle_number, 'type', 'car')
       )
 WHERE jsonb_array_length(vehicles) = 0
   AND vehicle_number IS NOT NULL
   AND vehicle_number <> '';

UPDATE gate_invites
   SET vehicles = jsonb_build_array(
         jsonb_build_object('number', vehicle_number, 'type', 'car')
       )
 WHERE jsonb_array_length(vehicles) = 0
   AND vehicle_number IS NOT NULL
   AND vehicle_number <> '';

UPDATE gate_entries
   SET vehicles = jsonb_build_array(
         jsonb_build_object('number', vehicle_number, 'type', 'car')
       )
 WHERE jsonb_array_length(vehicles) = 0
   AND vehicle_number IS NOT NULL
   AND vehicle_number <> 'NO-VEHICLE';

-- ─── Fix status CHECK on gate_entries (drop + re-add) ─────────────────────
DO $$
DECLARE
  v_constraint_name TEXT;
BEGIN
  SELECT con.conname
    INTO v_constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
   WHERE nsp.nspname = 'public'
     AND rel.relname = 'gate_entries'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%status%';

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE gate_entries DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  ALTER TABLE gate_entries
    ADD CONSTRAINT gate_entries_status_check
    CHECK (status IN (
      'auto_approved',
      'invite_approved',
      'pass_approved',
      'pending_approval',
      'approved',
      'approved_by_guard_override',
      'rejected'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;