// src/controllers/accountController.js
const {pool} = require("../config/database");

// ---------------------------------------------------------------------------
// POST /accounts
// ---------------------------------------------------------------------------
const createAccount = async (req, res) => {
  const client = await pool.connect();

  try {
    const { name, type } = req.body;
    const photo_url = req.body.photo_url ?? req.body.photoUrl ?? null;

    if (!name || !type) {
      return res.status(400).json({
        code: "invalid_input",
        message: "Account name and type are required",
      });
    }

    if (!["apartment", "home"].includes(type)) {
      return res.status(400).json({
        code: "invalid_type",
        message: "Invalid account type",
      });
    }

    // Works with req.user.userId, req.user.id, or req.userId
    const userId = req.user?.userId ?? req.user?.id ?? req.userId;
    if (!userId) {
      return res.status(401).json({
        code: "unauthenticated",
        message: "Authentication required",
      });
    }

    await client.query("BEGIN");

    const accountResult = await client.query(
      `
      INSERT INTO accounts (name, photo_url, type, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, photo_url, type, created_by, created_at, updated_at
      `,
      [name.trim(), photo_url, type, userId],
    );

    const account = accountResult.rows[0];

    await client.query(
      `
      INSERT INTO account_members (account_id, user_id, role, status)
      VALUES ($1, $2, 'owner', 'active')
      `,
      [account.id, userId],
    );

    await client.query("COMMIT");

    // Return the raw account row (frontend mapper reads these fields directly)
    return res.status(201).json(account);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create account error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        code: "duplicate",
        message: "You already have an account with this name",
      });
    }

    return res.status(500).json({
      code: "server_error",
      message: "Failed to create account",
    });
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /accounts
// ---------------------------------------------------------------------------
const listAccounts = async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id ?? req.userId;
    if (!userId) {
      return res.status(401).json({
        code: "unauthenticated",
        message: "Authentication required",
      });
    }

    const result = await pool.query(
      `
      SELECT
        a.id,
        a.name,
        a.type,
        a.photo_url,
        a.created_by,
        a.created_at,
        a.updated_at
      FROM accounts a
      INNER JOIN account_members am ON am.account_id = a.id
      WHERE am.user_id = $1
        AND am.status = 'active'
      ORDER BY a.created_at DESC
      `,
      [userId],
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("List accounts error:", error);
    return res.status(500).json({
      code: "server_error",
      message: "Failed to load accounts",
    });
  }
};

module.exports = {
  createAccount,
  listAccounts,
};