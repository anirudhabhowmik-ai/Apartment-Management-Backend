// @ts-nocheck
// src/controllers/accountController.js
const { pool } = require("../config/database");
const { grantRoleWithImpliedRoles } = require("../utils/accessSync");

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const fail = (res, status, code) => res.status(status).json({ code });

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

    await grantRoleWithImpliedRoles(client, account.id, userId, "admin");

    await client.query(
      `UPDATE users SET last_account_id = $1, updated_at = NOW() WHERE id = $2`,
      [account.id, userId],
    );

    await client.query("COMMIT");

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

// ===========================================================================
// listAccounts
//
// Adds owner_name / owner_phone / owner_photo_url to every row so the
// frontend can render the owner's identity without an extra request.
// ===========================================================================

const listAccounts = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows } = await pool.query(
      `
      SELECT
        sub.id,
        sub.name,
        sub.type,
        sub.photo_url,
        sub.created_by,
        sub.created_at,
        sub.updated_at,
        sub.role,
        sub.owner_name,
        sub.owner_phone,
        sub.owner_photo_url
      FROM (
        SELECT DISTINCT ON (a.id)
          a.id,
          a.name,
          a.type,
          a.photo_url,
          a.created_by,
          a.created_at,
          a.updated_at,
          am.role,
          owner.name      AS owner_name,
          owner.phone     AS owner_phone,
          owner.photo_url AS owner_photo_url,
          CASE
            WHEN a.created_by = $1 THEN 1
            WHEN am.role = 'admin' THEN 2
            WHEN am.role = 'member_visibility' THEN 3
            WHEN am.role = 'staff_visibility' THEN 4
            ELSE 5
          END AS role_priority
        FROM accounts a
        LEFT JOIN account_members am
          ON am.account_id = a.id
         AND am.user_id = $1
         AND am.status = 'active'
        LEFT JOIN users owner
          ON owner.id = a.created_by
        WHERE
          a.created_by = $1

          OR (am.role = 'admin')

          OR (
            am.role = 'member_visibility'
            AND EXISTS (
              SELECT 1 FROM members m
               WHERE m.account_id = a.id
                 AND m.user_id    = $1
                 AND m.status     = 'active'
            )
          )

          OR (
            am.role = 'staff_visibility'
            AND EXISTS (
              SELECT 1 FROM staff s
               WHERE s.account_id = a.id
                 AND s.user_id    = $1
                 AND s.status     = 'active'
            )
          )
        ORDER BY a.id, role_priority
      ) sub
      ORDER BY sub.created_at DESC
      `,
      [userId],
    );

    const { rows: userRowsForLast } = await pool.query(
      `SELECT last_account_id FROM users WHERE id = $1`,
      [userId],
    );

    return res.status(200).json({
      accounts: rows,
      lastAccountId: userRowsForLast[0]?.last_account_id ?? null,
    });
  } catch (error) {
    console.error("List accounts error:", error);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// getAccountPeople
//
// GET /api/accounts/:id/people
//
// Returns:
//   {
//     owner:  { user_id, name, phone, photo_url } | null,
//     admins: [ { user_id, name, phone, photo_url } ]
//   }
//
// Owner is always first in `admins` was NOT included — admins list
// explicitly excludes the owner because the owner is rendered as a
// separate row on the frontend.
//
// Accessible to any active member of the account (owner, admin, member,
// staff). It only exposes public identity (name, phone, photo) — same
// data the invitations list already exposes.
// ===========================================================================

const getAccountPeople = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id: accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    // Confirm the requester has any active role on this account.
    const { rows: memberRows } = await pool.query(
      `SELECT role FROM account_members
        WHERE account_id = $1
          AND user_id    = $2
          AND status     = 'active'
        LIMIT 1`,
      [accountId, userId],
    );

    const isOwner = await pool.query(
      `SELECT 1 FROM accounts WHERE id = $1 AND created_by = $2`,
      [accountId, userId],
    );

    if (memberRows.length === 0 && isOwner.rows.length === 0) {
      return fail(res, 403, "no_account_access");
    }

    const { rows: ownerRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1
        LIMIT 1`,
      [accountId],
    );

    const owner = ownerRows.length
      ? {
          user_id: ownerRows[0].user_id,
          name: ownerRows[0].name ?? "",
          phone: ownerRows[0].phone ?? null,
          photo_url: ownerRows[0].photo_url ?? null,
        }
      : null;

    const { rows: adminRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM account_members am
         JOIN users u ON u.id = am.user_id
         JOIN accounts a ON a.id = am.account_id
        WHERE am.account_id = $1
          AND am.role       = 'admin'
          AND am.status     = 'active'
          AND u.id         <> a.created_by
        ORDER BY COALESCE(u.name, '')`,
      [accountId],
    );

    const admins = adminRows.map((r) => ({
      user_id: r.user_id,
      name: r.name ?? "",
      phone: r.phone ?? null,
      photo_url: r.photo_url ?? null,
    }));

    return res.json({ owner, admins });
  } catch (error) {
    console.error("getAccountPeople error:", error);
    return fail(res, 500, "server_error");
  }
};

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

    await grantRoleWithImpliedRoles(client, id, userId, "admin");
    await grantRoleWithImpliedRoles(client, id, newOwnerUserId, "admin");

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
  getAccountPeople,
  updateAccount,
  deleteAccount,
  transferOwnership,
  setLastAccount,
};