// src/controllers/accountController.js
const { query, pool } = require("../config/database");

/**
 * GET /api/accounts
 * List all accounts the current user is a member of.
 * Matches both accepted grants (by user_id) and accepted grants by
 * invited_phone, so a user invited by phone sees the account.
 */
const listAccounts = async (req, res) => {
  try {
    const result = await query(
      `SELECT
         a.id, a.type, a.name, a.photo_uri,
         a.owner_id, a.created_at, a.updated_at,
         ag.role, ag.staff_title, ag.accepted_at
       FROM access_grants ag
       JOIN accounts a ON a.id = ag.account_id
       WHERE a.is_active = true
         AND ag.accepted_at IS NOT NULL
         AND (
           ag.user_id = $1
           OR ag.invited_phone = $2
         )
       ORDER BY ag.created_at ASC`,
      [req.user.id, req.user.phone],
    );

    return res.json({
      success: true,
      accounts: result.rows.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        photoUri: r.photo_uri,
        ownerId: r.owner_id,
        role: r.role,
        staffTitle: r.staff_title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("listAccounts error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * POST /api/accounts
 * Create a new account (apartment or home).
 * Creator becomes the owner (owner_id) AND gets an admin grant.
 *
 * Body: { type: "apartment" | "home", name: string, photoUri?: string }
 */
const createAccount = async (req, res) => {
  const { type, name, photoUri } = req.body;

  if (!type || !["apartment", "home"].includes(type)) {
    return res.status(400).json({
      success: false,
      message: "type must be 'apartment' or 'home'",
    });
  }
  if (!name || !String(name).trim()) {
    return res
      .status(400)
      .json({ success: false, message: "name is required" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Create the account
    const accountResult = await client.query(
      `INSERT INTO accounts
         (type, name, photo_uri, owner_id, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       RETURNING id, type, name, photo_uri, owner_id, created_at, updated_at`,
      [type, String(name).trim(), photoUri || null, req.user.id],
    );

    const account = accountResult.rows[0];

    // 2. Insert the admin access grant for the creator.
    //    accepted_at = NOW() so it's immediately active.
    //    user_id is set — the creator exists.
    await client.query(
      `INSERT INTO access_grants
         (id, account_id, user_id, invited_phone, role, status, created_at, accepted_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, 'admin', 'accepted', NOW(), NOW())`,
      [account.id, req.user.id, req.user.phone],
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      account: {
        id: account.id,
        type: account.type,
        name: account.name,
        photoUri: account.photo_uri,
        ownerId: account.owner_id,
        role: "admin",
        createdAt: account.created_at,
        updatedAt: account.updated_at,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createAccount error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create account" });
  } finally {
    client.release();
  }
};

/**
 * GET /api/accounts/:id
 * Get a single account the user has access to.
 */
const getAccount = async (req, res) => {
  try {
    const result = await query(
      `SELECT
         a.id, a.type, a.name, a.photo_uri,
         a.owner_id, a.created_at, a.updated_at,
         ag.role, ag.staff_title
       FROM access_grants ag
       JOIN accounts a ON a.id = ag.account_id
       WHERE a.id = $1
         AND a.is_active = true
         AND (
           ag.user_id = $2
           OR ag.invited_phone = $3
         )
         AND ag.accepted_at IS NOT NULL
       LIMIT 1`,
      [req.params.id, req.user.id, req.user.phone],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    const r = result.rows[0];

    return res.json({
      success: true,
      account: {
        id: r.id,
        type: r.type,
        name: r.name,
        photoUri: r.photo_uri,
        ownerId: r.owner_id,
        role: r.role,
        staffTitle: r.staff_title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
    });
  } catch (err) {
    console.error("getAccount error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * PATCH /api/accounts/:id
 * Update name / photo. Admin only (guard is applied at the route).
 *
 * Body: { name?: string, photoUri?: string }
 */
const updateAccount = async (req, res) => {
  const { name, photoUri } = req.body;

  try {
    const result = await query(
      `UPDATE accounts
         SET name       = COALESCE($1, name),
             photo_uri  = COALESCE($2, photo_uri),
             updated_at = NOW()
       WHERE id = $3
       RETURNING id, type, name, photo_uri, owner_id, created_at, updated_at`,
      [name || null, photoUri || null, req.params.id],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }

    const r = result.rows[0];

    return res.json({
      success: true,
      account: {
        id: r.id,
        type: r.type,
        name: r.name,
        photoUri: r.photo_uri,
        ownerId: r.owner_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
    });
  } catch (err) {
    console.error("updateAccount error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update account" });
  }
};

/**
 * GET /api/accounts/:id/members
 * List the members (people with accepted access) of an account.
 * Admin only.
 */
const listMembers = async (req, res) => {
  try {
    const result = await query(
      `SELECT
         ag.id AS grant_id, ag.role, ag.staff_title,
         ag.accepted_at, ag.created_at,
         u.id AS user_id, u.phone, u.full_name, u.email
       FROM access_grants ag
       LEFT JOIN users u ON u.id = ag.user_id
       WHERE ag.account_id = $1
         AND ag.accepted_at IS NOT NULL
       ORDER BY ag.created_at ASC`,
      [req.params.id],
    );

    return res.json({
      success: true,
      members: result.rows.map((r) => ({
        grantId: r.grant_id,
        userId: r.user_id,
        phone: r.phone,
        name: r.full_name,
        email: r.email,
        role: r.role,
        staffTitle: r.staff_title,
        acceptedAt: r.accepted_at,
        joinedAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("listMembers error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  listAccounts,
  createAccount,
  getAccount,
  updateAccount,
  listMembers,
};