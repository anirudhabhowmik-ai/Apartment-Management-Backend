// src/controllers/accountController.js
const { pool } = require("../config/database");

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

    // Remember this as the user's last-selected account.
    await client.query(
      `UPDATE users SET last_account_id = $1, updated_at = NOW() WHERE id = $2`,
      [account.id, userId],
    );

    await client.query("COMMIT");

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
// Returns { accounts, lastAccountId }
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
        a.updated_at,
        am.role
      FROM accounts a
      INNER JOIN account_members am ON am.account_id = a.id
      WHERE am.user_id = $1
        AND am.status = 'active'
      ORDER BY a.created_at DESC
      `,
      [userId],
    );

    const { rows: userRows } = await pool.query(
      `SELECT last_account_id FROM users WHERE id = $1`,
      [userId],
    );

    return res.status(200).json({
      accounts: result.rows,
      lastAccountId: userRows[0]?.last_account_id ?? null,
    });
  } catch (error) {
    console.error("List accounts error:", error);
    return res.status(500).json({
      code: "server_error",
      message: "Failed to load accounts",
    });
  }
};

// ---------------------------------------------------------------------------
// PATCH /accounts/:id
// Body: { name?: string, photo_url?: string | null }
// Only owner/admin on that account can edit.
// ---------------------------------------------------------------------------
const updateAccount = async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id ?? req.userId;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        code: "unauthenticated",
        message: "Authentication required",
      });
    }

    // Verify the caller has permission (owner/admin on the account).
    const { rows: permRows } = await pool.query(
      `SELECT am.role, a.created_by
         FROM account_members am
         JOIN accounts a ON a.id = am.account_id
        WHERE am.account_id = $1 AND am.user_id = $2 AND am.status = 'active'
        LIMIT 1`,
      [id, userId],
    );

    if (!permRows.length) {
      return res.status(403).json({
        code: "forbidden",
        message: "You do not have access to this account",
      });
    }

    const isOwnerOrAdmin =
      permRows[0].created_by === userId ||
      permRows[0].role === "owner" ||
      permRows[0].role === "admin";

    if (!isOwnerOrAdmin) {
      return res.status(403).json({
        code: "forbidden",
        message: "Only owners and admins can edit the account",
      });
    }

    const allowed = ["name", "photo_url"];
    const updates = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        code: "invalid_input",
        message: "No permitted fields to update",
      });
    }

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

    const updated = await pool.query(
      `UPDATE accounts
          SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1}
        RETURNING id, name, photo_url, type, created_by, created_at, updated_at`,
      [...values, id],
    );

    if (updated.rowCount === 0) {
      return res.status(404).json({
        code: "not_found",
        message: "Account not found",
      });
    }

    return res.status(200).json(updated.rows[0]);
  } catch (error) {
    console.error("Update account error:", error);
    return res.status(500).json({
      code: "server_error",
      message: "Failed to update account",
    });
  }
};

// ---------------------------------------------------------------------------
// PATCH /accounts/me/last-account
// Body: { accountId: string | null }
// ---------------------------------------------------------------------------
const setLastAccount = async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id ?? req.userId;
    const { accountId } = req.body;

    if (!userId) {
      return res.status(401).json({
        code: "unauthenticated",
        message: "Authentication required",
      });
    }

    if (accountId !== null && typeof accountId !== "string") {
      return res.status(400).json({
        code: "invalid_input",
        message: "accountId must be a string or null",
      });
    }

    if (accountId) {
      const { rows: memberRows } = await pool.query(
        `SELECT 1 FROM account_members
           WHERE account_id = $1 AND user_id = $2 AND status = 'active'
          LIMIT 1`,
        [accountId, userId],
      );

      if (!memberRows.length) {
        const { rows: ownerRows } = await pool.query(
          `SELECT 1 FROM accounts
             WHERE id = $1 AND created_by = $2
            LIMIT 1`,
          [accountId, userId],
        );

        if (!ownerRows.length) {
          return res.status(403).json({
            code: "forbidden",
            message: "You do not have access to that account",
          });
        }
      }
    }

    await pool.query(
      `UPDATE users SET last_account_id = $1, updated_at = NOW() WHERE id = $2`,
      [accountId, userId],
    );

    return res.status(200).json({
      success: true,
      last_account_id: accountId,
    });
  } catch (error) {
    console.error("setLastAccount error:", error);
    return res.status(500).json({
      code: "server_error",
      message: "Failed to save last account",
    });
  }
};

module.exports = {
  createAccount,
  listAccounts,
  updateAccount,
  setLastAccount,
};