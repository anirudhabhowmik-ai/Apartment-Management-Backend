// src/controllers/accountController.js
const { pool } = require("../config/database");

// ---------------------------------------------------------------------------
// Helper — resolve the caller's user id from the request.
// ---------------------------------------------------------------------------
const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const fail = (res, status, code) => res.status(status).json({ code });

// ---------------------------------------------------------------------------
// POST /accounts
//
// Creates an account and inserts the owner into account_members with the
// role `admin`. Ownership itself is derived from accounts.created_by, never
// stored on account_members.
// ---------------------------------------------------------------------------
const createAccount = async (req, res) => {
  const client = await pool.connect();

  try {
    const { name, type } = req.body;
    const photo_url = req.body.photo_url ?? req.body.photoUrl ?? null;

    if (!name || !type) return fail(res, 400, "invalid_input");

    if (!["apartment", "home"].includes(type)) {
      return fail(res, 400, "invalid_type");
    }

    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated");

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

    // Owner is an admin on their own account. `owner` is never stored as a
    // role value — it's derived from accounts.created_by at read time.
    await client.query(
      `
      INSERT INTO account_members (account_id, user_id, role, status)
      VALUES ($1, $2, 'admin', 'active')
      `,
      [account.id, userId],
    );

    await client.query(
      `UPDATE users SET last_account_id = $1, updated_at = NOW() WHERE id = $2`,
      [account.id, userId],
    );

    await client.query("COMMIT");

    // Return the account with the derived owner role so the frontend
    // renders the Owner badge immediately.
    return res.status(201).json({ ...account, role: "owner" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create account error:", error);

    if (error.code === "23505") {
      return fail(res, 409, "duplicate");
    }

    return fail(res, 500, "server_error");
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
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated");

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
    return fail(res, 500, "server_error");
  }
};

// ---------------------------------------------------------------------------
// PATCH /accounts/:id
// Body: { name?, photo_url? }
// Owner or admin only.
// ---------------------------------------------------------------------------
const updateAccount = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: permRows } = await pool.query(
      `SELECT am.role, a.created_by
         FROM account_members am
         JOIN accounts a ON a.id = am.account_id
        WHERE am.account_id = $1
          AND am.user_id = $2
          AND am.status = 'active'
        LIMIT 1`,
      [id, userId],
    );

    if (!permRows.length) return fail(res, 403, "forbidden");

    const isOwner = permRows[0].created_by === userId;
    const isAdmin = permRows[0].role === "admin";
    if (!isOwner && !isAdmin) return fail(res, 403, "forbidden");

    const allowed = ["name", "photo_url"];
    const updates = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return fail(res, 400, "invalid_input");
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

    if (updated.rowCount === 0) return fail(res, 404, "not_found");

    return res.status(200).json(updated.rows[0]);
  } catch (error) {
    console.error("Update account error:", error);
    return fail(res, 500, "server_error");
  }
};

// ---------------------------------------------------------------------------
// DELETE /accounts/:id
// Owner only. Cascades to account_members, invitations, members, staff.
// ---------------------------------------------------------------------------
const deleteAccount = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id = $1`,
      [id],
    );
    if (!rows.length) return fail(res, 404, "not_found");
    if (rows[0].created_by !== userId) {
      return fail(res, 403, "owner_required");
    }

    await pool.query(`DELETE FROM accounts WHERE id = $1`, [id]);

    // If the user's last_account_id pointed at the deleted account, clear it.
    await pool.query(
      `UPDATE users SET last_account_id = NULL
        WHERE id = $1 AND last_account_id = $2`,
      [userId, id],
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("Delete account error:", error);
    return fail(res, 500, "server_error");
  }
};

// ---------------------------------------------------------------------------
// POST /accounts/:id/transfer-ownership
// Body: { newOwnerUserId: string }
// Owner only. Atomically moves `created_by`, keeps the old owner as admin,
// ensures the new owner has an admin row.
// ---------------------------------------------------------------------------
const transferOwnership = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    const { newOwnerUserId } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated");
    if (!newOwnerUserId) return fail(res, 400, "invalid_input");

    const { rows: accRows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id = $1`,
      [id],
    );
    if (!accRows.length) return fail(res, 404, "not_found");
    if (accRows[0].created_by !== userId) {
      return fail(res, 403, "owner_required");
    }
    if (newOwnerUserId === userId) {
      return fail(res, 400, "invalid_input");
    }

    // The new owner must already have some active row on this account.
    const { rows: newOwnerRows } = await pool.query(
      `SELECT 1 FROM account_members
        WHERE account_id = $1 AND user_id = $2 AND status = 'active'
        LIMIT 1`,
      [id, newOwnerUserId],
    );
    if (!newOwnerRows.length) {
      return fail(res, 400, "invalid_input");
    }

    await client.query("BEGIN");

    await client.query(
      `UPDATE accounts SET created_by = $1, updated_at = NOW() WHERE id = $2`,
      [newOwnerUserId, id],
    );

    // Old owner keeps admin.
    await client.query(
      `INSERT INTO account_members (account_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (account_id, user_id, role)
       DO UPDATE SET status = 'active', updated_at = NOW()`,
      [id, userId],
    );

    // New owner must have admin too.
    await client.query(
      `INSERT INTO account_members (account_id, user_id, role, status)
       VALUES ($1, $2, 'admin', 'active')
       ON CONFLICT (account_id, user_id, role)
       DO UPDATE SET status = 'active', updated_at = NOW()`,
      [id, newOwnerUserId],
    );

    await client.query("COMMIT");

    return res.json({ success: true, newOwnerUserId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Transfer ownership error:", error);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// PATCH /accounts/me/last-account
// ---------------------------------------------------------------------------
const setLastAccount = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.body;

    if (!userId) return fail(res, 401, "unauthenticated");

    if (accountId !== null && typeof accountId !== "string") {
      return fail(res, 400, "invalid_input");
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

        if (!ownerRows.length) return fail(res, 403, "forbidden");
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
    return fail(res, 500, "server_error");
  }
};

module.exports = {
  createAccount,
  listAccounts,
  updateAccount,
  deleteAccount,
  transferOwnership,
  setLastAccount,
};