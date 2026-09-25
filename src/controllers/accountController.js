// src/controllers/accountController.js
const { pool } = require("../config/database");
const { grantRoleWithImpliedRoles } = require("../utils/accessSync");
const { writeAudit } = require("./auditController");

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const fail = (res, status, code) => res.status(status).json({ code });

// ===========================================================================
// createAccount
// ===========================================================================
const createAccount = async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, type } = req.body;
    const photo_url = req.body.photo_url ?? req.body.photoUrl ?? null;

    if (!name || !type) return fail(res, 400, "invalid_input");
    if (!["apartment", "home"].includes(type)) return fail(res, 400, "invalid_type");

    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated");

    await client.query("BEGIN");

    const accountResult = await client.query(
      `INSERT INTO accounts (name, photo_url, type, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, photo_url, type, created_by, created_at, updated_at`,
      [name.trim(), photo_url, type, userId],
    );
    const account = accountResult.rows[0];

    await grantRoleWithImpliedRoles(client, account.id, userId, "admin");

    await client.query(
      `UPDATE users SET last_account_id = $1, updated_at = NOW() WHERE id = $2`,
      [account.id, userId],
    );

    await writeAudit(client, {
      accountId: account.id,
      actorUserId: userId,
      actorRole: "owner",
      entityType: "account",
      entityId: account.id,
      action: "create",
      after: account,
      metadata: { bootstrapOwner: true },
      visibility: "public",
    });

    await client.query("COMMIT");
    return res.status(201).json({ ...account, role: "owner" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create account error:", error);
    if (error.code === "23505") return fail(res, 409, "duplicate");
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// listAccounts
// ===========================================================================
const listAccounts = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows } = await pool.query(
      `
      SELECT
        sub.id, sub.name, sub.type, sub.photo_url,
        sub.created_by, sub.created_at, sub.updated_at,
        sub.role, sub.owner_name, sub.owner_phone, sub.owner_photo_url
      FROM (
        SELECT DISTINCT ON (a.id)
          a.id, a.name, a.type, a.photo_url,
          a.created_by, a.created_at, a.updated_at,
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
          ON am.account_id = a.id AND am.user_id = $1 AND am.status = 'active'
        LEFT JOIN users owner ON owner.id = a.created_by
        WHERE a.status = 'active'
          AND (
            a.created_by = $1
            OR (am.role = 'admin')
            OR (am.role = 'member_visibility' AND EXISTS (
              SELECT 1 FROM members m
               WHERE m.account_id = a.id AND m.user_id = $1 AND m.status = 'active'))
            OR (am.role = 'staff_visibility' AND EXISTS (
              SELECT 1 FROM staff s
               WHERE s.account_id = a.id AND s.user_id = $1 AND s.status = 'active'))
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
// ===========================================================================
const getAccountPeople = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id: accountId } = req.params;
    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: memberRows } = await pool.query(
      `SELECT am.role FROM account_members am
         JOIN accounts a ON a.id = am.account_id
        WHERE am.account_id = $1 AND am.user_id = $2
          AND am.status = 'active' AND a.status = 'active'
        LIMIT 1`,
      [accountId, userId],
    );
    const isOwner = await pool.query(
      `SELECT 1 FROM accounts
        WHERE id = $1 AND created_by = $2 AND status = 'active'`,
      [accountId, userId],
    );
    if (memberRows.length === 0 && isOwner.rows.length === 0) {
      return fail(res, 403, "no_account_access");
    }

    const { rows: ownerRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM accounts a JOIN users u ON u.id = a.created_by
        WHERE a.id = $1 LIMIT 1`,
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
          AND am.role = 'admin' AND am.status = 'active'
          AND u.id <> a.created_by
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

// ===========================================================================
// updateAccount
// ===========================================================================
const updateAccount = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: permRows } = await client.query(
      `SELECT am.role, a.created_by
         FROM account_members am
         JOIN accounts a ON a.id = am.account_id
        WHERE am.account_id = $1 AND am.user_id = $2
          AND am.status = 'active' AND a.status = 'active'
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
    if (Object.keys(updates).length === 0) return fail(res, 400, "invalid_input");

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query(
      `SELECT id, name, photo_url, type, created_by, created_at, updated_at
         FROM accounts WHERE id = $1`,
      [id],
    );
    const before = beforeRows[0] || null;

    const updated = await client.query(
      `UPDATE accounts
          SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1}
        RETURNING id, name, photo_url, type, created_by, created_at, updated_at`,
      [...values, id],
    );

    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found");
    }

    await writeAudit(client, {
      accountId: id,
      actorUserId: userId,
      actorRole: isOwner ? "owner" : "admin",
      entityType: "account",
      entityId: id,
      action: "update",
      before,
      after: updated.rows[0],
      visibility: "public",
    });

    await client.query("COMMIT");
    return res.status(200).json(updated.rows[0]);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Update account error:", error);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// deleteAccount
// ===========================================================================
const deleteAccount = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows } = await client.query(
      `SELECT created_by, status FROM accounts WHERE id = $1`,
      [id],
    );
    if (!rows.length) return fail(res, 404, "not_found");
    if (rows[0].created_by !== userId) return fail(res, 403, "owner_required");
    if (rows[0].status === "inactive") {
      return res.json({ success: true, alreadyInactive: true });
    }

    await client.query("BEGIN");

    await client.query(
      `UPDATE accounts SET status='inactive', deleted_at=NOW(), updated_at=NOW()
        WHERE id = $1`, [id]);
    await client.query(
      `UPDATE account_members SET status='inactive', updated_at=NOW()
        WHERE account_id=$1 AND status='active'`, [id]);
    await client.query(
      `UPDATE members SET status='inactive', updated_at=NOW()
        WHERE account_id=$1 AND status='active'`, [id]);
    await client.query(
      `UPDATE staff SET status='inactive', updated_at=NOW()
        WHERE account_id=$1 AND status='active'`, [id]);
    await client.query(
      `UPDATE invitations SET status='revoked',
              responded_at=COALESCE(responded_at, NOW())
        WHERE account_id=$1 AND status='pending'`, [id]);
    await client.query(
      `UPDATE users SET last_account_id=NULL WHERE last_account_id=$1`, [id]);

    await writeAudit(client, {
      accountId: id,
      actorUserId: userId,
      actorRole: "owner",
      entityType: "account",
      entityId: id,
      action: "delete",
      before: { status: rows[0].status },
      after:  { status: "inactive" },
      metadata: { softDelete: true },
      visibility: "public",
    });

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Delete account error:", error);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// transferOwnership
// ===========================================================================
const transferOwnership = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    const { newOwnerUserId } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated");
    if (!newOwnerUserId) return fail(res, 400, "invalid_input");

    const { rows: accRows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id=$1 AND status='active'`,
      [id],
    );
    if (!accRows.length) return fail(res, 404, "not_found");
    if (accRows[0].created_by !== userId) return fail(res, 403, "owner_required");
    if (newOwnerUserId === userId) return fail(res, 400, "invalid_input");

    const { rows: newOwnerRows } = await pool.query(
      `SELECT 1 FROM account_members
        WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
      [id, newOwnerUserId],
    );
    if (!newOwnerRows.length) return fail(res, 400, "invalid_input");

    await client.query("BEGIN");

    const previousOwnerId = accRows[0].created_by;

    await client.query(
      `UPDATE accounts SET created_by=$1, updated_at=NOW() WHERE id=$2`,
      [newOwnerUserId, id],
    );

    await grantRoleWithImpliedRoles(client, id, userId, "admin");
    await grantRoleWithImpliedRoles(client, id, newOwnerUserId, "admin");

    await client.query(
      `INSERT INTO ownership_transfers
         (account_id, previous_owner_id, new_owner_id, transferred_by)
       VALUES ($1,$2,$3,$4)`,
      [id, previousOwnerId, newOwnerUserId, userId],
    );

    await writeAudit(client, {
      accountId: id,
      actorUserId: userId,
      actorRole: "owner",
      targetUserId: newOwnerUserId,
      entityType: "account",
      entityId: id,
      action: "transfer_ownership",
      before: { created_by: previousOwnerId },
      after:  { created_by: newOwnerUserId },
      metadata: {
        newOwnerUserId,
        previousOwnerId,
        previousOwnerDemotedTo: "admin",
      },
      visibility: "public",
    });

    await client.query("COMMIT");
    return res.json({ success: true, newOwnerUserId });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Transfer ownership error:", error);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// setLastAccount
// ===========================================================================
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
        `SELECT 1 FROM account_members am
           JOIN accounts a ON a.id = am.account_id
          WHERE am.account_id=$1 AND am.user_id=$2
            AND am.status='active' AND a.status='active' LIMIT 1`,
        [accountId, userId],
      );
      if (!memberRows.length) {
        const { rows: ownerRows } = await pool.query(
          `SELECT 1 FROM accounts
            WHERE id=$1 AND created_by=$2 AND status='active' LIMIT 1`,
          [accountId, userId],
        );
        if (!ownerRows.length) return fail(res, 403, "forbidden");
      }
    }

    await pool.query(
      `UPDATE users SET last_account_id=$1, updated_at=NOW() WHERE id=$2`,
      [accountId, userId],
    );

    return res.status(200).json({ success: true, last_account_id: accountId });
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