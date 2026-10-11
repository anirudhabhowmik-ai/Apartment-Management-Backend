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
 * FIX: `opts.only` lets a caller restrict the search to a single table:
 *
 *   findExistingDirectoryEntry(client, accountId, phone, null, { only: "staff" })
 *     → only looks in `staff`, ignores `members`
 *   findExistingDirectoryEntry(client, accountId, phone, null, { only: "member" })
 *     → only looks in `members`, ignores `staff`
 *   findExistingDirectoryEntry(client, accountId, phone, null)
 *     → looks in both (legacy cross-table behaviour)
 *
 * This is what unblocks "add staff after delete" when the same phone also
 * exists as an active member row with a different name. Staff and member
 * names are now independent for the same phone; only same-table names must
 * match.
 *
 * Returns { kind: 'member'|'staff', id, name } or null.
 */
async function findExistingDirectoryEntry(
  client,
  accountId,
  phone,
  excludeId = null,
  opts = {},
) {
  const ten = normalizePhone(phone);
  if (!ten || !accountId) return null;
  const runner = client || pool;

  const only =
    opts && (opts.only === "member" || opts.only === "staff")
      ? opts.only
      : null;

  const parts = [];

  if (!only || only === "member") {
    parts.push(`
      SELECT 'member'::text AS kind, id, name
        FROM members
       WHERE account_id = $1
         AND status     = 'active'
         AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'\\D','','g'),10) = $2`);
  }

  if (!only || only === "staff") {
    parts.push(`
      SELECT 'staff'::text AS kind, id, name
        FROM staff
       WHERE account_id = $1
         AND status     = 'active'
         AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'\\D','','g'),10) = $2`);
  }

  // If somehow both branches were skipped, return nothing.
  if (parts.length === 0) return null;

  const inner = parts.join(" UNION ALL ");

  const { rows } = await runner.query(
    `SELECT kind, id, name FROM ( ${inner} ) x
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

const LOWER_ROLES = new Set(["member_visibility", "staff_visibility"]);
const EXCLUSIVE_ROLES = new Set(["admin", "ownership_transfer"]);

async function grantRoleWithImpliedRoles(client, accountId, userId, role) {
  if (!userId || !role) return;

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
  ensureUserForPhone,
  findExistingDirectoryEntry,
  hasActiveMemberRow,
  hasActiveStaffRow,
  deactivateAccessRole,
  grantRoleWithImpliedRoles,
  isEligibleForAutoGrant,
  LOWER_ROLES,
  EXCLUSIVE_ROLES,
};