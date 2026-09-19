// src/utils/accessSync.js
//
// Write-time helpers for keeping account_members in sync with the
// underlying members / staff tables.
//
// Rule: granting admin also grants member_visibility and staff_visibility,
// but ONLY where a live members / staff row exists for that phone.
// Revoking admin never touches the base roles.

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
  grantRoleWithImpliedRoles,
};