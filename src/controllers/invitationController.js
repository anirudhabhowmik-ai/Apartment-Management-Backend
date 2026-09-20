// @ts-nocheck
// src/controllers/invitationController.js
const { pool } = require("../config/database");
const { grantRoleWithImpliedRoles } = require("../utils/accessSync");

// ===========================================================================
// HELPERS
// ===========================================================================

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const normalizePhone = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
};

const fail = (res, status, code) => res.status(status).json({ code });

const VALID_ROLES = ["admin", "member_visibility", "staff_visibility"];

/**
 * Roles the caller actually holds on this account.
 * "owner" is derived from accounts.created_by, not from account_members.
 */
async function getRolesForAccount(userId, accountId) {
  const { rows: ownerRows } = await pool.query(
    `SELECT 1 FROM accounts WHERE id = $1 AND created_by = $2`,
    [accountId, userId],
  );
  if (ownerRows.length) return ["owner"];

  const { rows: amRows } = await pool.query(
    `SELECT role FROM account_members
       WHERE account_id = $1
         AND user_id    = $2
         AND status     = 'active'`,
    [accountId, userId],
  );

  return amRows.map((r) => r.role);
}

const hasOwnerOrAdmin = (roles) =>
  roles.includes("owner") || roles.includes("admin");

const isOwner = (roles) => roles.includes("owner");

// ===========================================================================
// PREFLIGHT
// ===========================================================================

const preflight = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone: rawPhone, role } = req.query;

    if (!userId) return fail(res, 401, "unauthenticated");

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    if (!VALID_ROLES.includes(role)) return fail(res, 400, "invalid_input");

    const phone = normalizePhone(rawPhone);
    if (!phone) return fail(res, 400, "invalid_input");

    // Owner self-check
    const { rows: ownerRows } = await pool.query(
      `SELECT u.phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId],
    );
    if (ownerRows.length && normalizePhone(ownerRows[0].phone) === phone) {
      return res.json({ kind: "self" });
    }

    // Already-joined user?
    const { rows: userRows } = await pool.query(
      `SELECT id FROM users
        WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $1
        LIMIT 1`,
      [phone],
    );

    if (userRows.length) {
      const targetUserId = userRows[0].id;
      const { rows: existing } = await pool.query(
        `SELECT role FROM account_members
          WHERE account_id = $1
            AND user_id    = $2
            AND status     = 'active'`,
        [accountId, targetUserId],
      );
      const targetRoles = existing.map((r) => r.role);

      if (targetRoles.includes("admin")) {
        return res.json({ kind: "already_admin" });
      }
      if (
        role === "member_visibility" &&
        targetRoles.includes("member_visibility")
      ) {
        return res.json({ kind: "already_member" });
      }
      if (
        role === "staff_visibility" &&
        targetRoles.includes("staff_visibility")
      ) {
        return res.json({ kind: "already_staff" });
      }
    }

    // Pending invitation for this phone + role?
    const { rows: pendingRows } = await pool.query(
      `SELECT id, role FROM invitations
        WHERE account_id = $1
          AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
          AND status = 'pending'`,
      [accountId, phone],
    );
    if (pendingRows.find((r) => r.role === role)) {
      return res.json({ kind: "pending" });
    }

    // Promoting a lower-role member to admin?
    if (role === "admin") {
      const { rows: acceptedLowerRoles } = await pool.query(
        `SELECT role, invited_name
           FROM invitations
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
            AND role IN ('member_visibility', 'staff_visibility')
            AND status = 'accepted'
          ORDER BY responded_at DESC NULLS LAST
          LIMIT 1`,
        [accountId, phone],
      );

      if (acceptedLowerRoles.length) {
        return res.json({
          kind: "member_to_admin",
          memberName: acceptedLowerRoles[0].invited_name ?? null,
        });
      }
    }

    return res.json({ kind: "ok" });
  } catch (err) {
    console.error("invitation preflight error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// CREATE
// ===========================================================================

const createInvitation = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone: rawPhone, name, role, targetMemberId, targetStaffId } =
      req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated");

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    if (!VALID_ROLES.includes(role)) return fail(res, 400, "invalid_input");

    if (role === "admin" && !isOwner(requesterRoles)) {
      return fail(res, 403, "owner_required");
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) return fail(res, 400, "invalid_input");

    // Owner cannot invite themselves.
    const { rows: ownerRows } = await pool.query(
      `SELECT u.phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId],
    );
    if (ownerRows.length && normalizePhone(ownerRows[0].phone) === phone) {
      return fail(res, 400, "invalid_input");
    }

    await client.query("BEGIN");

    // Admin invite supersedes any pending lower-role invite for the same phone.
    if (role === "admin") {
      await client.query(
        `UPDATE invitations
            SET status = 'cancelled',
                responded_at = COALESCE(responded_at, NOW())
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
            AND role IN ('member_visibility', 'staff_visibility')
            AND status = 'pending'`,
        [accountId, phone],
      );
    }

    try {
      const { rows } = await client.query(
        `INSERT INTO invitations
           (account_id, invited_by, invited_phone, invited_name, role,
            target_member_id, target_staff_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, account_id, invited_phone, invited_name, role,
                   status, created_at`,
        [
          accountId,
          userId,
          phone,
          name || null,
          role,
          targetMemberId || null,
          targetStaffId || null,
        ],
      );
      await client.query("COMMIT");
      return res.status(201).json(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      if (e.code === "23505") return fail(res, 409, "conflict");
      throw e;
    }
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("createInvitation error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// LIST
// ===========================================================================

const listInvitations = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { status } = req.query;

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (requesterRoles.length === 0) return fail(res, 403, "forbidden");

    const params = [accountId];
    let where = `WHERE i.account_id = $1`;
    if (status) {
      params.push(status);
      where += ` AND i.status = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT
         i.id,
         i.account_id,
         i.invited_phone,
         i.invited_name,
         i.role,
         i.status,
         i.target_member_id,
         i.target_staff_id,
         i.created_at,
         i.responded_at,
         i.dismissed_at,
         i.accepted_by,
         u.phone     AS invited_by_phone,
         a.name      AS account_name,
         a.photo_url AS account_photo_url
       FROM invitations i
       LEFT JOIN users    u ON u.id = i.invited_by
       LEFT JOIN accounts a ON a.id = i.account_id
       ${where}
       ORDER BY i.created_at DESC`,
      params,
    );

    // Phones that must not appear in any grant-access picker:
    //   - the account owner
    //   - anyone with an active admin row on this account
    const { rows: excludedRows } = await pool.query(
      `SELECT RIGHT(REGEXP_REPLACE(u.phone,'\\D','','g'),10) AS phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1

        UNION

       SELECT RIGHT(REGEXP_REPLACE(u.phone,'\\D','','g'),10) AS phone
         FROM account_members am
         JOIN users u ON u.id = am.user_id
        WHERE am.account_id = $1
          AND am.role       = 'admin'
          AND am.status     = 'active'`,
      [accountId],
    );

    const excluded_phones = excludedRows
      .map((r) => r.phone)
      .filter((p) => typeof p === "string" && p.length === 10);

    return res.json({
      success: true,
      count: rows.length,
      invitations: rows,
      excluded_phones,
    });
  } catch (err) {
    console.error("listInvitations error:", err);
    return res.status(500).json({
      success: false,
      code: "server_error",
      detail: err.message,
    });
  }
};

// ===========================================================================
// DELETE / DISMISS
// ===========================================================================

const deleteInvitation = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    const { rowCount } = await pool.query(
      `DELETE FROM invitations WHERE id = $1 AND account_id = $2`,
      [id, accountId],
    );
    if (!rowCount) return fail(res, 404, "not_found");

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteInvitation error:", err);
    return fail(res, 500, "server_error");
  }
};

const dismissInvitation = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (requesterRoles.length === 0) return fail(res, 403, "forbidden");

    const { rowCount } = await pool.query(
      `UPDATE invitations
          SET dismissed_at = NOW()
        WHERE id = $1 AND account_id = $2`,
      [id, accountId],
    );
    if (!rowCount) return fail(res, 404, "not_found");

    return res.json({ success: true });
  } catch (err) {
    console.error("dismissInvitation error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// MY INVITATIONS
// ===========================================================================

const listMyInvitations = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: userRows } = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) return fail(res, 404, "not_found");

    const phone = normalizePhone(userRows[0].phone);
    if (!phone) return res.json({ invitations: [] });

    const { rows } = await pool.query(
      `SELECT
         i.id, i.account_id, i.role, i.status,
         i.invited_name, i.created_at,
         a.name      AS account_name,
         a.photo_url AS account_photo_url,
         u.phone     AS invited_by_phone
       FROM invitations i
       JOIN accounts a ON a.id = i.account_id
       JOIN users u    ON u.id = i.invited_by
       WHERE RIGHT(REGEXP_REPLACE(i.invited_phone,'\\D','','g'),10) = $1
         AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [phone],
    );

    return res.json({ invitations: rows });
  } catch (err) {
    console.error("listMyInvitations error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// ACCEPT
//
// On accept:
//   1. Upsert account_members with the invited role (exclusive).
//   2. Mark the invitation accepted.
//   3. If the user still has no name, seed it from invited_name.
//   4. If admin, cancel any pending lower-role invites for the same phone.
// ===========================================================================

const acceptInvitation = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: userRows } = await client.query(
      `SELECT id, phone, name FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) return fail(res, 404, "not_found");
    const myPhone = normalizePhone(userRows[0].phone);

    const { rows: invRows } = await client.query(
      `SELECT * FROM invitations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!invRows.length) return fail(res, 404, "not_found");

    const inv = invRows[0];
    if (inv.status !== "pending") return fail(res, 409, "conflict");

    const invPhone = normalizePhone(inv.invited_phone);
    if (!invPhone || !myPhone || invPhone !== myPhone) {
      return fail(res, 403, "forbidden");
    }

    await client.query("BEGIN");

    // 1. Grant role (exclusive).
    await grantRoleWithImpliedRoles(client, inv.account_id, userId, inv.role);

    // 2. Mark invitation accepted.
    await client.query(
      `UPDATE invitations
          SET status = 'accepted', accepted_by = $1, responded_at = NOW()
        WHERE id = $2`,
      [userId, id],
    );

    // 3. Seed users.name from the invitation if the user has none.
    if (
      inv.invited_name &&
      (!userRows[0].name || String(userRows[0].name).trim() === "")
    ) {
      await client.query(
        `UPDATE users
            SET name = $1, updated_at = NOW()
          WHERE id = $2`,
        [inv.invited_name, userId],
      );
    }

    // 4. Admin supersedes lower-role invites for the same phone.
    if (inv.role === "admin") {
      await client.query(
        `UPDATE invitations
            SET status = 'cancelled',
                responded_at = COALESCE(responded_at, NOW())
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
            AND role IN ('member_visibility', 'staff_visibility')
            AND status = 'pending'
            AND id <> $3`,
        [inv.account_id, myPhone, id],
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      invitationId: id,
      accountId: inv.account_id,
      role: inv.role,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("acceptInvitation error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// REJECT
// ===========================================================================

const rejectInvitation = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    const { rows: userRows } = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) return fail(res, 404, "not_found");
    const myPhone = normalizePhone(userRows[0].phone);

    const { rows } = await pool.query(
      `SELECT * FROM invitations WHERE id = $1`,
      [id],
    );
    if (!rows.length) return fail(res, 404, "not_found");

    const inv = rows[0];
    const invPhone = normalizePhone(inv.invited_phone);
    if (!invPhone || !myPhone || invPhone !== myPhone) {
      return fail(res, 403, "forbidden");
    }
    if (inv.status !== "pending") return fail(res, 409, "conflict");

    await pool.query(
      `UPDATE invitations
          SET status = 'rejected', responded_at = NOW()
        WHERE id = $1`,
      [id],
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("rejectInvitation error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// ADMIN LINKED PROFILES
//
// Returns the member/staff rows associated with an accepted admin invite.
// Uses user_id joins — members/staff no longer carry phone.
// ===========================================================================

const getAdminLinkedProfiles = async (req, res) => {
  try {
    const requesterId = getUserId(req);
    const { accountId, invitationId } = req.params;

    const requesterRoles = await getRolesForAccount(requesterId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    const { rows: invRows } = await pool.query(
      `SELECT id, invited_phone, accepted_by, invited_name, role, status
         FROM invitations
        WHERE id = $1 AND account_id = $2`,
      [invitationId, accountId],
    );
    if (!invRows.length) return fail(res, 404, "not_found");

    const inv = invRows[0];
    if (inv.role !== "admin") return fail(res, 400, "invalid_input");
    if (inv.status !== "accepted") return fail(res, 409, "conflict");

    let memberId = null;
    let memberName = null;
    let staffId = null;
    let staffName = null;

    if (inv.accepted_by) {
      const { rows: m } = await pool.query(
        `SELECT m.id, u.name
           FROM members m
           JOIN users u ON u.id = m.user_id
          WHERE m.account_id = $1
            AND m.user_id = $2
            AND m.status = 'active'
          LIMIT 1`,
        [accountId, inv.accepted_by],
      );
      if (m.length) {
        memberId = m[0].id;
        memberName = m[0].name;
      }

      const { rows: s } = await pool.query(
        `SELECT s.id, u.name
           FROM staff s
           JOIN users u ON u.id = s.user_id
          WHERE s.account_id = $1
            AND s.user_id = $2
            AND s.status = 'active'
          LIMIT 1`,
        [accountId, inv.accepted_by],
      );
      if (s.length) {
        staffId = s[0].id;
        staffName = s[0].name;
      }
    }

    return res.json({
      invitationId: inv.id,
      userId: inv.accepted_by,
      invitedName: inv.invited_name,
      hasMember: !!memberId,
      memberId,
      memberName,
      hasStaff: !!staffId,
      staffId,
      staffName,
    });
  } catch (err) {
    console.error("getAdminLinkedProfiles error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// PREVIEW REVOKE
// ===========================================================================

const previewRevoke = async (req, res) => {
  try {
    const requesterId = getUserId(req);
    const { accountId, userId: targetUserId } = req.params;

    const requesterRoles = await getRolesForAccount(requesterId, accountId);
    if (!isOwner(requesterRoles)) return fail(res, 403, "owner_required");

    if (!targetUserId) return fail(res, 400, "invalid_input");

    const { rows: ownerRows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id = $1`,
      [accountId],
    );
    if (ownerRows.length && ownerRows[0].created_by === targetUserId) {
      return fail(res, 400, "invalid_input");
    }

    const { rows: userRows } = await pool.query(
      `SELECT phone, name FROM users WHERE id = $1`,
      [targetUserId],
    );
    const phone = userRows.length ? normalizePhone(userRows[0].phone) : null;

    const { rows: adminRows } = await pool.query(
      `SELECT 1 FROM account_members
        WHERE account_id = $1
          AND user_id    = $2
          AND role       = 'admin'
          AND status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );

    let memberProfile = null;
    let staffProfile = null;

    const { rows: m } = await pool.query(
      `SELECT m.id, m.wing, m.flat_number, m.role, u.name
         FROM members m
         JOIN users u ON u.id = m.user_id
        WHERE m.account_id = $1
          AND m.user_id    = $2
          AND m.status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );
    if (m.length) {
      memberProfile = {
        id: m[0].id,
        name: m[0].name,
        wing: m[0].wing || null,
        flatNumber: m[0].flat_number || null,
        role: m[0].role || null,
      };
    }

    const { rows: s } = await pool.query(
      `SELECT s.id, s.role, u.name
         FROM staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.account_id = $1
          AND s.user_id    = $2
          AND s.status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );
    if (s.length) {
      staffProfile = {
        id: s[0].id,
        name: s[0].name,
        role: s[0].role || null,
      };
    }

    return res.json({
      userId: targetUserId,
      phone,
      isAdmin: adminRows.length > 0,
      memberProfile,
      staffProfile,
    });
  } catch (err) {
    console.error("previewRevoke error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// REVOKE
// ===========================================================================

const revokeAccess = async (req, res) => {
  const client = await pool.connect();
  try {
    const requesterId = getUserId(req);
    const { accountId, userId: targetUserId } = req.params;
    const { role: rawRole } = req.query;
    const body = req.body || {};

    const requesterRoles = await getRolesForAccount(requesterId, accountId);
    if (!isOwner(requesterRoles)) return fail(res, 403, "owner_required");

    if (rawRole && rawRole !== "admin") {
      return fail(res, 403, "forbidden");
    }

    const { rows: ownerRows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id = $1`,
      [accountId],
    );
    if (ownerRows.length && ownerRows[0].created_by === targetUserId) {
      return fail(res, 400, "invalid_input");
    }

    const { rows: userRows } = await client.query(
      `SELECT phone FROM users WHERE id = $1`,
      [targetUserId],
    );
    const phone = userRows.length ? normalizePhone(userRows[0].phone) : null;

    // Detect if the target still has active member / staff rows.
    const { rows: memberRows } = await client.query(
      `SELECT 1 FROM members
        WHERE account_id = $1
          AND user_id    = $2
          AND status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );
    const { rows: staffRows } = await client.query(
      `SELECT 1 FROM staff
        WHERE account_id = $1
          AND user_id    = $2
          AND status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );

    const hasMemberRow = memberRows.length > 0;
    const hasStaffRow = staffRows.length > 0;

    const keepMemberVisibility =
      body.keepMemberVisibility === undefined
        ? hasMemberRow
        : body.keepMemberVisibility === true;

    const keepStaffVisibility =
      body.keepStaffVisibility === undefined
        ? hasStaffRow
        : body.keepStaffVisibility === true;

    await client.query("BEGIN");

    // 1. Deactivate the admin role.
    const { rowCount: adminDeactivated } = await client.query(
      `UPDATE account_members
          SET status = 'inactive', updated_at = NOW()
        WHERE account_id = $1
          AND user_id    = $2
          AND role       = 'admin'
          AND status     = 'active'`,
      [accountId, targetUserId],
    );

    if (!adminDeactivated) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found");
    }

    const kept = [];
    const revoked = [];

    // 2. Member visibility
    if (keepMemberVisibility && hasMemberRow) {
      await client.query(
        `INSERT INTO account_members (account_id, user_id, role, status)
         VALUES ($1, $2, 'member_visibility', 'active')
         ON CONFLICT (account_id, user_id, role)
         DO UPDATE SET status = 'active', updated_at = NOW()`,
        [accountId, targetUserId],
      );
      kept.push("member_visibility");
    } else {
      await client.query(
        `UPDATE account_members
            SET status = 'inactive', updated_at = NOW()
          WHERE account_id = $1
            AND user_id    = $2
            AND role       = 'member_visibility'
            AND status     = 'active'`,
        [accountId, targetUserId],
      );
      await client.query(
        `UPDATE invitations
            SET status = 'revoked', responded_at = NOW()
          WHERE account_id  = $1
            AND accepted_by = $2
            AND role        = 'member_visibility'
            AND status      = 'accepted'`,
        [accountId, targetUserId],
      );
      revoked.push("member_visibility");
    }

    // 3. Staff visibility
    if (keepStaffVisibility && hasStaffRow) {
      await client.query(
        `INSERT INTO account_members (account_id, user_id, role, status)
         VALUES ($1, $2, 'staff_visibility', 'active')
         ON CONFLICT (account_id, user_id, role)
         DO UPDATE SET status = 'active', updated_at = NOW()`,
        [accountId, targetUserId],
      );
      kept.push("staff_visibility");
    } else {
      await client.query(
        `UPDATE account_members
            SET status = 'inactive', updated_at = NOW()
          WHERE account_id = $1
            AND user_id    = $2
            AND role       = 'staff_visibility'
            AND status     = 'active'`,
        [accountId, targetUserId],
      );
      await client.query(
        `UPDATE invitations
            SET status = 'revoked', responded_at = NOW()
          WHERE account_id  = $1
            AND accepted_by = $2
            AND role        = 'staff_visibility'
            AND status      = 'accepted'`,
        [accountId, targetUserId],
      );
      revoked.push("staff_visibility");
    }

    // 4. Mark the admin invitation as revoked.
    await client.query(
      `UPDATE invitations
          SET status = 'revoked', responded_at = NOW()
        WHERE account_id  = $1
          AND accepted_by = $2
          AND role        = 'admin'
          AND status      = 'accepted'`,
      [accountId, targetUserId],
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      removed: "admin",
      kept,
      revoked,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("revokeAccess error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

module.exports = {
  preflight,
  createInvitation,
  listInvitations,
  deleteInvitation,
  dismissInvitation,
  listMyInvitations,
  acceptInvitation,
  rejectInvitation,
  getAdminLinkedProfiles,
  previewRevoke,
  revokeAccess,
};