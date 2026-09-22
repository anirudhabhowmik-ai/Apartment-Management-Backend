// src/utils/accessSync.js
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
  const { rows } = await client.query(
    `SELECT id FROM users
       WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $1
       LIMIT 1`,
    [ten],
  );
  return rows.length ? rows[0].id : null;
}

/**
 * Return users.id for `phone`, creating the row if it doesn't exist.
 * If the user already exists and has no name, seed it from `fallbackName`.
 * Never grants access — this only touches `users`.
 */
async function ensureUserForPhone(client, phone, fallbackName) {
  const ten = normalizePhone(phone);
  if (!ten) return null;

  const { rows: existing } = await client.query(
    `SELECT id, name FROM users
       WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $1
       LIMIT 1`,
    [ten],
  );

  if (existing.length) {
    const user = existing[0];
    if (fallbackName && (!user.name || String(user.name).trim() === "")) {
      await client.query(
        `UPDATE users
            SET name = $1, updated_at = NOW()
          WHERE id = $2`,
        [fallbackName, user.id],
      );
    }
    return user.id;
  }

  const { rows: created } = await client.query(
    `INSERT INTO users (phone, name, is_active, last_login_at)
     VALUES ($1, $2, true, NULL)
     RETURNING id`,
    [`91${ten}`, fallbackName || null],
  );
  return created[0].id;
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
  ensureUserForPhone,
  hasActiveMemberRow,
  hasActiveStaffRow,
  deactivateAccessRole,
  grantRoleWithImpliedRoles,
  isEligibleForAutoGrant,
  LOWER_ROLES,
  EXCLUSIVE_ROLES,
};