// src/utils/accessSync.js
//
// Shared helpers for keeping account_members in sync with the members
// and staff tables.
//
// Two rules:
//
//   1. grantRoleWithImpliedRoles:
//      When an admin invitation is accepted, also activate
//      member_visibility / staff_visibility for whichever members /
//      staff rows exist for that phone at accept time.
//
//   2. isEligibleForAutoGrant:
//      When a members / staff row is created, auto-grant the matching
//      visibility ONLY if the user is the account owner OR holds an
//      active admin role on that account. Everyone else goes through
//      the invitation flow.

const normalizePhone = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
};

async function findUserIdByPhone(client, phone) {
  const ten = normalizePhone(phone);
  if (!ten) return null;
  const { rows } = await client.query(
    `SELECT id FROM users
       WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $1
       LIMIT 1`,
    [ten]
  );
  return rows.length ? rows[0].id : null;
}

async function activateAccessRole(client, accountId, userId, role) {
  if (!userId) return;
  await client.query(
    `INSERT INTO account_members (account_id, user_id, role, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (account_id, user_id, role)
     DO UPDATE SET status = 'active', updated_at = NOW()`,
    [accountId, userId, role]
  );
}

async function deactivateAccessRole(client, accountId, userId, role) {
  if (!userId) return;
  await client.query(
    `UPDATE account_members
        SET status = 'inactive', updated_at = NOW()
      WHERE account_id = $1
        AND user_id = $2
        AND role = $3`,
    [accountId, userId, role]
  );
  await client.query(
    `UPDATE invitations
        SET status = 'revoked', responded_at = NOW()
      WHERE account_id = $1
        AND accepted_by = $2
        AND role = $3
        AND status = 'accepted'`,
    [accountId, userId, role]
  );
}

async function hasActiveMemberRow(client, accountId, phone) {
  const ten = normalizePhone(phone);
  if (!ten) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM members
      WHERE account_id = $1
        AND status = 'active'
        AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
      LIMIT 1`,
    [accountId, ten]
  );
  return rows.length > 0;
}

async function hasActiveStaffRow(client, accountId, phone) {
  const ten = normalizePhone(phone);
  if (!ten) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM staff
      WHERE account_id = $1
        AND status = 'active'
        AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
      LIMIT 1`,
    [accountId, ten]
  );
  return rows.length > 0;
}

/**
 * True when the user is:
 *   - the account owner (accounts.created_by = userId), OR
 *   - an active admin on this account.
 *
 * Used to decide whether a member/staff row creation should also
 * auto-grant the matching visibility without an invitation.
 */
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
    [accountId, userId]
  );
  return rows.length > 0;
}

/**
 * Grant `role` to `userId` on `accountId`. If `role` is 'admin', also
 * activate member_visibility and staff_visibility for whichever live
 * members / staff rows exist for `phone`.
 */
async function grantRoleWithImpliedRoles(
  client,
  accountId,
  userId,
  role,
  phone
) {
  await activateAccessRole(client, accountId, userId, role);

  if (role !== "admin") return;

  const ten = normalizePhone(phone);
  if (!ten) return;

  if (await hasActiveMemberRow(client, accountId, ten)) {
    await activateAccessRole(client, accountId, userId, "member_visibility");
  }
  if (await hasActiveStaffRow(client, accountId, ten)) {
    await activateAccessRole(client, accountId, userId, "staff_visibility");
  }
}

module.exports = {
  normalizePhone,
  findUserIdByPhone,
  activateAccessRole,
  deactivateAccessRole,
  hasActiveMemberRow,
  hasActiveStaffRow,
  isEligibleForAutoGrant,
  grantRoleWithImpliedRoles,
};