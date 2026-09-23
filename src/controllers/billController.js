// src/controllers/billController.js
const { pool } = require("../config/database");

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const fail = (res, status, code, message) =>
  res.status(status).json({ code, message: message || code });

async function canManageBills(accountId, userId) {
  const { rows } = await pool.query(
    `SELECT a.created_by, am.role, am.status
       FROM accounts a
       LEFT JOIN account_members am
         ON am.account_id = a.id
        AND am.user_id    = $2
        AND am.status     = 'active'
      WHERE a.id = $1
      LIMIT 1`,
    [accountId, userId],
  );
  if (!rows.length) return false;
  const isOwner = rows[0].created_by === userId;
  const isAdmin = rows[0].role === "admin" && rows[0].status === "active";
  return isOwner || isAdmin;
}

// GET /api/accounts/:accountId/bills/config/:memberType
const getBillConfig = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, memberType } = req.params;
    if (!userId) return fail(res, 401, "unauthenticated");
    if (!["owner", "staff"].includes(memberType)) {
      return fail(res, 400, "invalid_input");
    }
    if (!(await canManageBills(accountId, userId))) {
      return fail(res, 403, "forbidden");
    }

    const { rows } = await pool.query(
      `SELECT config, updated_at
         FROM saved_bill_configs
        WHERE account_id = $1 AND member_type = $2
        LIMIT 1`,
      [accountId, memberType],
    );

    if (!rows.length) return res.json({ config: null });

    return res.json({
      config: rows[0].config,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    console.error("getBillConfig error:", err);
    return fail(res, 500, "server_error");
  }
};

// PUT /api/accounts/:accountId/bills/config/:memberType
// Body: { config: SavedBillConfig }
const saveBillConfig = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, memberType } = req.params;
    if (!userId) return fail(res, 401, "unauthenticated");
    if (!["owner", "staff"].includes(memberType)) {
      return fail(res, 400, "invalid_input");
    }
    if (!(await canManageBills(accountId, userId))) {
      return fail(res, 403, "forbidden");
    }

    const config = req.body?.config;
    if (!config || typeof config !== "object") {
      return fail(res, 400, "invalid_input", "config is required");
    }
    if (!config.templateId || typeof config.templateId !== "string") {
      return fail(res, 400, "invalid_input", "config.templateId required");
    }

    const { rows } = await pool.query(
      `INSERT INTO saved_bill_configs
         (account_id, member_type, config, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, member_type)
       DO UPDATE SET
         config     = EXCLUDED.config,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING config, updated_at`,
      [accountId, memberType, config, userId],
    );

    return res.json({
      config: rows[0].config,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    console.error("saveBillConfig error:", err);
    return fail(res, 500, "server_error");
  }
};

// DELETE /api/accounts/:accountId/bills/config/:memberType
const deleteBillConfig = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, memberType } = req.params;
    if (!userId) return fail(res, 401, "unauthenticated");
    if (!["owner", "staff"].includes(memberType)) {
      return fail(res, 400, "invalid_input");
    }
    if (!(await canManageBills(accountId, userId))) {
      return fail(res, 403, "forbidden");
    }

    await pool.query(
      `DELETE FROM saved_bill_configs
        WHERE account_id = $1 AND member_type = $2`,
      [accountId, memberType],
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("deleteBillConfig error:", err);
    return fail(res, 500, "server_error");
  }
};

module.exports = { getBillConfig, saveBillConfig, deleteBillConfig };