// src/controllers/invitationController.js
const { pool } = require("../config/database");

// ===========================================================================
// HELPERS
// ===========================================================================

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const normalizePhone = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
};

const fail = (res, status, code) =>
  res.status(status).json({ code });

async function getRoleForAccount(userId, accountId) {
  const { rows: ownerRows } = await pool.query(
    `SELECT 1 FROM accounts WHERE id = $1 AND created_by = $2`,
    [accountId, userId]
  );
  if (ownerRows.length) return "owner";

  const { rows } = await pool.query(
    `SELECT role FROM account_members
       WHERE account_id = $1
         AND user_id = $2
         AND status = 'active'
       LIMIT 1`,
    [accountId, userId]
  );
  return rows.length ? rows[0].role : null;
}

const isOwnerOrAdmin = (role) => role === "owner" || role === "admin";

// role → map of what to check for "already has this access"
const ROLE_ALREADY = {
  admin:              ["admin"],
  member_visibility:  ["admin", "member_visibility"],
  staff_visibility:   ["staff_visibility"],
};

// ===========================================================================
// PREFLIGHT — GET /accounts/:accountId/invitations/preflight?phone=&role=
//
// Tells the frontend what will happen BEFORE the user taps "send invite".
// ===========================================================================

const preflight = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone: rawPhone, role } = req.query;

    if (!userId) return fail(res, 401, "unauthenticated");

    const requesterRole = await getRoleForAccount(userId, accountId);
    if (!isOwnerOrAdmin(requesterRole)) {
      return fail(res, 403, "forbidden");
    }

    if (!["admin", "member_visibility", "staff_visibility"].includes(role)) {
      return fail(res, 400, "invalid_input");
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) return fail(res, 400, "invalid_input");

    // 1. Is it the owner's own number?
    const { rows: ownerRows } = await pool.query(
      `SELECT u.phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId]
    );
    if (
      ownerRows.length &&
      normalizePhone(ownerRows[0].phone) === phone
    ) {
      return res.json({ kind: "self" });
    }

    // 2. Does the phone already have the requested role (or a superseding one)?
    const { rows: userRows } = await pool.query(
      `SELECT id FROM users
        WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $1
        LIMIT 1`,
      [phone]
    );

    if (userRows.length) {
      const targetUserId = userRows[0].id;
      const checkRoles = ROLE_ALREADY[role];

      const { rows: existing } = await pool.query(
        `SELECT role FROM account_members
          WHERE account_id = $1
            AND user_id = $2
            AND status = 'active'
            AND role = ANY($3::text[])`,
        [accountId, targetUserId, checkRoles]
      );

      if (existing.length) {
        const r = existing[0].role;
        if (r === "admin") {
          return res.json({ kind: "already_admin" });
        }
        if (r === "member_visibility" && role === "member_visibility") {
          return res.json({ kind: "already_member" });
        }
        if (r === "staff_visibility") {
          return res.json({ kind: "already_staff" });
        }
      }
    }

    // 3. Pending invite already?
    const { rows: pendingRows } = await pool.query(
      `SELECT id FROM invitations
        WHERE account_id = $1
          AND invited_phone = $2
          AND role = $3
          AND status = 'pending'
        LIMIT 1`,
      [accountId, phone, role]
    );
    if (pendingRows.length) {
      return res.json({ kind: "pending" });
    }

    // 4. Is this a staff member being invited as member_visibility?
    if (role === "member_visibility") {
      const { rows: staffRows } = await pool.query(
        `SELECT id FROM staff
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
          LIMIT 1`,
        [accountId, phone]
      );
      if (staffRows.length) {
        return res.json({ kind: "staff_number" });
      }
    }

    // 5. Is this an existing member being invited as admin?
    if (role === "admin") {
      const { rows: memberRows } = await pool.query(
        `SELECT id, name FROM members
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
          LIMIT 1`,
        [accountId, phone]
      );
      if (memberRows.length) {
        return res.json({
          kind: "member_to_admin",
          memberId: memberRows[0].id,
          memberName: memberRows[0].name,
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
// CREATE — POST /accounts/:accountId/invitations
// Body: { phone, name?, role, targetMemberId?, targetStaffId? }
// ===========================================================================

const createInvitation = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone: rawPhone, name, role, targetMemberId, targetStaffId } =
      req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated");

    const requesterRole = await getRoleForAccount(userId, accountId);
    if (!isOwnerOrAdmin(requesterRole)) {
      return fail(res, 403, "forbidden");
    }

    if (!["admin", "member_visibility", "staff_visibility"].includes(role)) {
      return fail(res, 400, "invalid_input");
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) return fail(res, 400, "invalid_input");

    // Prevent owner inviting themselves
    const { rows: ownerRows } = await pool.query(
      `SELECT u.phone FROM accounts a JOIN users u ON u.id = a.created_by WHERE a.id = $1`,
      [accountId]
    );
    if (ownerRows.length && normalizePhone(ownerRows[0].phone) === phone) {
      return fail(res, 400, "invalid_input");
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO invitations
           (account_id, invited_by, invited_phone, invited_name, role,
            target_member_id, target_staff_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, account_id, invited_phone, invited_name, role, status, created_at`,
        [
          accountId,
          userId,
          phone,
          name || null,
          role,
          targetMemberId || null,
          targetStaffId || null,
        ]
      );
      return res.status(201).json(rows[0]);
    } catch (e) {
      if (e.code === "23505") {
        return fail(res, 409, "conflict");
      }
      throw e;
    }
  } catch (err) {
    console.error("createInvitation error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// LIST — GET /accounts/:accountId/invitations
// ===========================================================================

const listInvitations = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { status } = req.query; // optional filter

    const requesterRole = await getRoleForAccount(userId, accountId);
    if (!requesterRole) return fail(res, 403, "forbidden");

    const params = [accountId];
    let where = `WHERE i.account_id = $1`;
    if (status) {
      params.push(status);
      where += ` AND i.status = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT
         i.id, i.account_id,
         i.invited_phone, i.invited_name,
         i.role, i.status,
         i.target_member_id, i.target_staff_id,
         i.created_at, i.responded_at, i.dismissed_at,
         u.phone AS invited_by_phone,
         a.name  AS account_name,
         a.photo_url AS account_photo_url
       FROM invitations i
       JOIN users u    ON u.id = i.invited_by
       JOIN accounts a ON a.id = i.account_id
       ${where}
       ORDER BY i.created_at DESC`,
      params
    );

    return res.json({ invitations: rows });
  } catch (err) {
    console.error("listInvitations error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// DELETE — DELETE /accounts/:accountId/invitations/:id
// ===========================================================================

const deleteInvitation = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    const requesterRole = await getRoleForAccount(userId, accountId);
    if (!isOwnerOrAdmin(requesterRole)) {
      return fail(res, 403, "forbidden");
    }

    const { rowCount } = await pool.query(
      `DELETE FROM invitations WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!rowCount) return fail(res, 404, "not_found");

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteInvitation error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// DISMISS — POST /accounts/:accountId/invitations/:id/dismiss
//
// Soft "close icon" hide for accepted cards on owner profile.
// ===========================================================================

const dismissInvitation = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    const requesterRole = await getRoleForAccount(userId, accountId);
    if (!requesterRole) return fail(res, 403, "forbidden");

    const { rowCount } = await pool.query(
      `UPDATE invitations
          SET dismissed_at = NOW()
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!rowCount) return fail(res, 404, "not_found");

    return res.json({ success: true });
  } catch (err) {
    console.error("dismissInvitation error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// MY INVITATIONS — GET /me/invitations
//
// For the member's home banner.
// ===========================================================================

const listMyInvitations = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: userRows } = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRows.length) return fail(res, 404, "not_found");

    const phone = normalizePhone(userRows[0].phone);

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
       WHERE i.invited_phone = $1
         AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [phone]
    );

    return res.json({ invitations: rows });
  } catch (err) {
    console.error("listMyInvitations error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// ACCEPT — POST /invitations/:id/accept
// ===========================================================================

const acceptInvitation = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: userRows } = await client.query(
      `SELECT id, phone FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRows.length) return fail(res, 404, "not_found");
    const myPhone = normalizePhone(userRows[0].phone);

    const { rows: invRows } = await client.query(
      `SELECT * FROM invitations WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!invRows.length) return fail(res, 404, "not_found");

    const inv = invRows[0];
    if (inv.status !== "pending") {
      return fail(res, 409, "conflict");
    }
    if (inv.invited_phone !== myPhone) {
      return fail(res, 403, "forbidden");
    }

    await client.query("BEGIN");

    // Upsert account_members with the invitation's role.
    // Single-role-per-account model: this replaces any existing role.
    await client.query(
      `INSERT INTO account_members (account_id, user_id, role, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (account_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = NOW()`,
      [inv.account_id, userId, inv.role]
    );

    await client.query(
      `UPDATE invitations
          SET status = 'accepted', accepted_by = $1, responded_at = NOW()
        WHERE id = $2`,
      [userId, id]
    );

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
// REJECT — POST /invitations/:id/reject
// ===========================================================================

const rejectInvitation = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    const { rows: userRows } = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRows.length) return fail(res, 404, "not_found");
    const myPhone = normalizePhone(userRows[0].phone);

    const { rows } = await pool.query(
      `SELECT * FROM invitations WHERE id = $1`,
      [id]
    );
    if (!rows.length) return fail(res, 404, "not_found");

    const inv = rows[0];
    if (inv.invited_phone !== myPhone) {
      return fail(res, 403, "forbidden");
    }
    if (inv.status !== "pending") {
      return fail(res, 409, "conflict");
    }

    await pool.query(
      `UPDATE invitations
          SET status = 'rejected', responded_at = NOW()
        WHERE id = $1`,
      [id]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("rejectInvitation error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// REVOKE — DELETE /accounts/:accountId/access/:userId
// ===========================================================================

const revokeAccess = async (req, res) => {
  try {
    const requesterId = getUserId(req);
    const { accountId, userId: targetUserId } = req.params;

    const requesterRole = await getRoleForAccount(requesterId, accountId);
    if (!isOwnerOrAdmin(requesterRole)) {
      return fail(res, 403, "forbidden");
    }

    // Can't revoke owner
    const { rows: ownerRows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id = $1`,
      [accountId]
    );
    if (ownerRows.length && ownerRows[0].created_by === targetUserId) {
      return fail(res, 400, "invalid_input");
    }

    const { rowCount } = await pool.query(
      `UPDATE account_members
          SET status = 'inactive', updated_at = NOW()
        WHERE account_id = $1 AND user_id = $2`,
      [accountId, targetUserId]
    );
    if (!rowCount) return fail(res, 404, "not_found");

    // Mark the corresponding invitation as revoked
    await pool.query(
      `UPDATE invitations
          SET status = 'revoked', responded_at = NOW()
        WHERE account_id = $1
          AND accepted_by = $2
          AND status = 'accepted'`,
      [accountId, targetUserId]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("revokeAccess error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================

module.exports = {
  preflight,
  createInvitation,
  listInvitations,
  deleteInvitation,
  dismissInvitation,
  listMyInvitations,
  acceptInvitation,
  rejectInvitation,
  revokeAccess,
};