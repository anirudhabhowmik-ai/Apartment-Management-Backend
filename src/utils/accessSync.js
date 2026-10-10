// src/utils/accessSync.js
const { pool } = require("../config/database");

const normalizePhone = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
};

// -----------------------------------------------------------------------------
// Users lookup
// -----------------------------------------------------------------------------

/**
 * Pure lookup: return users.id for a phone, or null.
 * Never creates a users row. Never writes to users.*
 *
 * This is the ONLY function admin-side code should use when it wants to
 * opportunistically link a members/staff row to an existing user.
 */
async function findUserIdByPhone(client, phone) {
  const ten = normalizePhone(phone);
  if (!ten) return null;
  const runner = client || pool;
  const { rows } = await runner.query(
    `SELECT id FROM users
       WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $1
       LIMIT 1`,
    [ten],
  );
  return rows.length ? rows[0].id : null;
}

/**
 * Backwards-compatible alias. Kept so existing callers don't break on import.
 *
 * ⚠️ Behaviour change from the previous version:
 *   - Does NOT create a users row when the phone is unknown.
 *   - Does NOT seed users.name from the admin-supplied `fallbackName`.
 *
 * Admin-created members/staff rows are now the only place an unverified name
 * is stored. `users` is written only when the real person logs in.
 *
 * The `fallbackName` argument is accepted and ignored so we don't have to
 * touch every call site in one commit.
 */
async function ensureUserForPhone(client, phone, _fallbackName) {
  return findUserIdByPhone(client, phone);
}

// -----------------------------------------------------------------------------
// Per-account directory checks (used by createMember / createStaff)
// -----------------------------------------------------------------------------

/**
 * Return the first active members/staff row in `accountId` that already has
 * the given phone, optionally excluding a row by id.
 *
 * Used to enforce the rule:
 *   one phone  →  one name  within a single property.
 *
 * Returns { kind: 'member'|'staff', id, name } or null.
 */
async function findExistingDirectoryEntry(client, accountId, phone, excludeId = null) {
  const ten = normalizePhone(phone);
  if (!ten || !accountId) return null;
  const runner = client || pool;

  const { rows } = await runner.query(
    `SELECT kind, id, name FROM (
       SELECT 'member'::text AS kind, id, name
         FROM members
        WHERE account_id = $1
          AND status     = 'active'
          AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'\\D','','g'),10) = $2
       UNION ALL
       SELECT 'staff'::text AS kind, id, name
         FROM staff
        WHERE account_id = $1
          AND status     = 'active'
          AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'\\D','','g'),10) = $2
     ) x
     WHERE ($3::uuid IS NULL OR id <> $3::uuid)
     ORDER BY name NULLS FIRST
     LIMIT 1`,
    [accountId, ten, excludeId],
  );

  return rows[0] ?? null;
}

// -----------------------------------------------------------------------------
// Membership checks (by user_id)
// -----------------------------------------------------------------------------

async function hasActiveMemberRow(client, accountId, userId) {
  if (!userId) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM members
      WHERE account_id = $1
        AND user_id    = $2
        AND status     = 'active'
      LIMIT 1`,
    [accountId, userId],
  );
  return rows.length > 0;
}

async function hasActiveStaffRow(client, accountId, userId) {
  if (!userId) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM staff
      WHERE account_id = $1
        AND user_id    = $2
        AND status     = 'active'
      LIMIT 1`,
    [accountId, userId],
  );
  return rows.length > 0;
}

// -----------------------------------------------------------------------------
// Role grant / revoke
// -----------------------------------------------------------------------------

async function deactivateAccessRole(client, accountId, userId, role) {
  if (!userId) return;

  await client.query(
    `UPDATE account_members
        SET status = 'inactive', updated_at = NOW()
      WHERE account_id = $1
        AND user_id    = $2
        AND role       = $3`,
    [accountId, userId, role],
  );

  await client.query(
    `UPDATE invitations
        SET status = 'revoked', responded_at = NOW()
      WHERE account_id  = $1
        AND accepted_by = $2
        AND role        = $3
        AND status      = 'accepted'`,
    [accountId, userId, role],
  );
}

/**
 * Grant a role for (account, user) respecting coexistence rules:
 *
 *   ┌──────────────────────┬──────────────────────────────────────────────┐
 *   │ New role             │ Behaviour                                    │
 *   ├──────────────────────┼──────────────────────────────────────────────┤
 *   │ member_visibility    │ Adds/activates member. Does NOT touch staff. │
 *   │ staff_visibility     │ Adds/activates staff. Does NOT touch member. │
 *   │ admin                │ Deactivates every other active role for the  │
 *   │                      │ user (member, staff, member+staff), then     │
 *   │                      │ activates admin. Admin is exclusive.         │
 *   │ ownership_transfer   │ Same as admin — deactivates everything else. │
 *   └──────────────────────┴──────────────────────────────────────────────┘
 */
const LOWER_ROLES = new Set(["member_visibility", "staff_visibility"]);
const EXCLUSIVE_ROLES = new Set(["admin", "ownership_transfer"]);

async function grantRoleWithImpliedRoles(client, accountId, userId, role) {
  if (!userId || !role) return;

  // ── 1. Exclusive roles evict every other active role for this user. ──
  if (EXCLUSIVE_ROLES.has(role)) {
    await client.query(
      `UPDATE account_members
          SET status = 'inactive', updated_at = NOW()
        WHERE account_id = $1
          AND user_id    = $2
          AND status     = 'active'
          AND role      <> $3`,
      [accountId, userId, role],
    );
  }

  // ── 2. Activate the target role.
  //
  //       For member / staff this is purely additive — no other active
  //       rows are touched, so member and staff coexist.
  await client.query(
    `INSERT INTO account_members (account_id, user_id, role, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (account_id, user_id, role)
     DO UPDATE SET status = 'active', updated_at = NOW()`,
    [accountId, userId, role],
  );
}

// -----------------------------------------------------------------------------
// Auto-grant eligibility
// -----------------------------------------------------------------------------

async function isEligibleForAutoGrant(client, accountId, userId) {
  if (!userId) return false;

  const { rows } = await client.query(
    `SELECT 1
       FROM accounts a
      WHERE a.id = $1 AND a.created_by = $2

      UNION ALL

      SELECT 1
       FROM account_members am
      WHERE am.account_id = $1
        AND am.user_id    = $2
        AND am.role       = 'admin'
        AND am.status     = 'active'
      LIMIT 1`,
    [accountId, userId],
  );

  return rows.length > 0;
}

module.exports = {
  normalizePhone,
  findUserIdByPhone,
  ensureUserForPhone,          // lookup-only alias
  findExistingDirectoryEntry,  // new — phone-name consistency check
  hasActiveMemberRow,
  hasActiveStaffRow,
  deactivateAccessRole,
  grantRoleWithImpliedRoles,
  isEligibleForAutoGrant,
  LOWER_ROLES,
  EXCLUSIVE_ROLES,
};