// src/controllers/invitationController.js
const { query, pool } = require("../config/database");

const VALID_ROLES = ["admin", "member_visibility", "staff_visibility"];
const VALID_STAFF_TITLES = [
  "security",
  "sweeper",
  "maintenance",
  "gardener",
  "driver",
];

const normalizePhone = (raw) => {
  let clean = String(raw || "").replace(/\D/g, "");
  if (clean.length === 10) clean = `91${clean}`;
  if (clean.length !== 12 || !clean.startsWith("91")) return null;
  return clean;
};

/**
 * GET /invitations
 * My pending invitations (matched by my phone).
 */
const listMyInvitations = async (req, res) => {
  try {
    const phone = req.user.phone;
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: "Your user has no phone" });
    }

    const result = await query(
      `SELECT
         i.id, i.account_id, i.invited_by, i.invited_phone,
         i.role, i.staff_title, i.status, i.message,
         i.created_at, i.expires_at,
         a.name AS account_name, a.type AS account_type, a.photo_url,
         u.phone AS invited_by_phone, u.full_name AS invited_by_name
       FROM invitations i
       JOIN accounts a ON a.id = i.account_id
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.invited_phone = $1
         AND i.status = 'pending'
         AND (i.expires_at IS NULL OR i.expires_at > NOW())
       ORDER BY i.created_at DESC`,
      [phone],
    );

    return res.json({
      success: true,
      invitations: result.rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        accountName: r.account_name,
        accountType: r.account_type,
        photoUri: r.photo_url,
        invitedByPhone: r.invited_by_phone,
        invitedByName: r.invited_by_name,
        role: r.role,
        staffTitle: r.staff_title,
        status: r.status,
        message: r.message,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      })),
    });
  } catch (err) {
    console.error("listMyInvitations error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * POST /invitations  (admin only — enforced via route guard)
 * Body: { accountId, invitedPhone, role, staffTitle?, message? }
 */
const createInvitation = async (req, res) => {
  const { accountId, invitedPhone, role, staffTitle, message } = req.body;

  if (!accountId) {
    return res
      .status(400)
      .json({ success: false, message: "accountId is required" });
  }
  const cleanPhone = normalizePhone(invitedPhone);
  if (!cleanPhone) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid invited phone" });
  }
  if (!VALID_ROLES.includes(role)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid role" });
  }
  if (role === "staff_visibility") {
    if (!staffTitle || !VALID_STAFF_TITLES.includes(staffTitle)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or missing staffTitle" });
    }
  }

  // Admin guard: caller must be admin of accountId
  try {
    const member = await query(
      `SELECT role FROM memberships WHERE user_id = $1 AND account_id = $2`,
      [req.user.id, accountId],
    );
    if (member.rows.length === 0 || member.rows[0].role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can invite members to this account",
      });
    }
  } catch (err) {
    console.error("createInvitation guard error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }

  try {
    // Prevent duplicate pending invitation
    const existing = await query(
      `SELECT id FROM invitations
        WHERE account_id = $1 AND invited_phone = $2 AND status = 'pending'`,
      [accountId, cleanPhone],
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "An invitation is already pending for this phone",
      });
    }

    const result = await query(
      `INSERT INTO invitations
        (account_id, invited_by, invited_phone, role, staff_title, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        accountId,
        req.user.id,
        cleanPhone,
        role,
        role === "staff_visibility" ? staffTitle : null,
        message || null,
      ],
    );

    return res.json({ success: true, invitation: result.rows[0] });
  } catch (err) {
    console.error("createInvitation error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create invitation" });
  }
};

/**
 * POST /invitations/:id/accept
 * Atomic: mark accepted, create membership.
 */
const acceptInvitation = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inv = await client.query(
      `SELECT * FROM invitations WHERE id = $1 FOR UPDATE`,
      [req.params.id],
    );

    if (inv.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Invitation not found" });
    }

    const invitation = inv.rows[0];

    // Must match my phone
    if (invitation.invited_phone !== req.user.phone) {
      await client.query("ROLLBACK");
      return res
        .status(403)
        .json({ success: false, message: "This invitation is not for you" });
    }

    if (invitation.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Invitation already ${invitation.status}`,
      });
    }

    if (invitation.expires_at && new Date(invitation.expires_at) < new Date()) {
      await client.query(
        `UPDATE invitations SET status = 'expired' WHERE id = $1`,
        [invitation.id],
      );
      await client.query("COMMIT");
      return res
        .status(400)
        .json({ success: false, message: "Invitation has expired" });
    }

    // Create membership (idempotent: ON CONFLICT updates role)
    await client.query(
      `INSERT INTO memberships (user_id, account_id, role, staff_title, joined_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, account_id)
       DO UPDATE SET role = EXCLUDED.role, staff_title = EXCLUDED.staff_title`,
      [
        req.user.id,
        invitation.account_id,
        invitation.role,
        invitation.staff_title,
      ],
    );

    await client.query(
      `UPDATE invitations SET status = 'accepted', accepted_at = NOW()
        WHERE id = $1`,
      [invitation.id],
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      accountId: invitation.account_id,
      role: invitation.role,
      staffTitle: invitation.staff_title,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("acceptInvitation error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to accept invitation" });
  } finally {
    client.release();
  }
};

/**
 * POST /invitations/:id/reject
 */
const rejectInvitation = async (req, res) => {
  try {
    const inv = await query(`SELECT * FROM invitations WHERE id = $1`, [
      req.params.id,
    ]);

    if (inv.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Invitation not found" });
    }

    const invitation = inv.rows[0];

    if (invitation.invited_phone !== req.user.phone) {
      return res
        .status(403)
        .json({ success: false, message: "This invitation is not for you" });
    }

    if (invitation.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Invitation already ${invitation.status}`,
      });
    }

    await query(
      `UPDATE invitations SET status = 'rejected', rejected_at = NOW()
        WHERE id = $1`,
      [invitation.id],
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("rejectInvitation error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to reject invitation" });
  }
};

/**
 * DELETE /invitations/:id  (admin only — revoke)
 */
const revokeInvitation = async (req, res) => {
  try {
    const inv = await query(
      `SELECT i.*, m.role AS my_role
         FROM invitations i
         LEFT JOIN memberships m
           ON m.account_id = i.account_id AND m.user_id = $2
        WHERE i.id = $1`,
      [req.params.id, req.user.id],
    );

    if (inv.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Invitation not found" });
    }

    if (inv.rows[0].my_role !== "admin") {
      return res
        .status(403)
        .json({ success: false, message: "Only admins can revoke" });
    }

    await query(
      `UPDATE invitations SET status = 'revoked' WHERE id = $1`,
      [req.params.id],
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("revokeInvitation error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to revoke invitation" });
  }
};

module.exports = {
  listMyInvitations,
  createInvitation,
  acceptInvitation,
  rejectInvitation,
  revokeInvitation,
};