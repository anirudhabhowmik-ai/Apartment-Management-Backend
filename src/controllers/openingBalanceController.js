// src/controllers/openingBalanceController.js
const { pool } = require("../config/database");
const { writeAudit } = require("./auditController");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const fail = (res, status, code, message) =>
  res.status(status).json({ code, message });

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

async function getEditorInfo(userId, accountId) {
  if (!userId || !accountId) return { phone: null, role: null };

  const { rows: ownerRows } = await pool.query(
    `SELECT created_by FROM accounts WHERE id = $1`,
    [accountId]
  );
  const isCreator =
    ownerRows.length > 0 && ownerRows[0].created_by === userId;

  const { rows: userRows } = await pool.query(
    `SELECT phone FROM users WHERE id = $1`,
    [userId]
  );
  const phone = userRows.length ? userRows[0].phone : null;

  if (isCreator) return { phone, role: "owner" };

  const { rows: memberRows } = await pool.query(
    `SELECT role FROM account_members
       WHERE account_id = $1
         AND user_id = $2
         AND status = 'active'
       LIMIT 1`,
    [accountId, userId]
  );

  const role = memberRows.length ? memberRows[0].role : null;
  return { phone, role };
}

async function loadOpeningBalance(accountId) {
  const { rows } = await pool.query(
    `SELECT
        aob.account_id,
        aob.opening_balance,
        aob.updated_by,
        aob.updated_at,
        u.phone AS updated_by_phone
     FROM account_opening_balances aob
     LEFT JOIN users u ON u.id = aob.updated_by
     WHERE aob.account_id = $1`,
    [accountId]
  );

  if (!rows.length) {
    return {
      account_id: accountId,
      opening_balance: 0,
      updated_by: null,
      updated_by_phone: null,
      updated_by_role: null,
      updated_at: null,
    };
  }

  const row = rows[0];
  let editorRole = null;
  if (row.updated_by) {
    try {
      const editor = await getEditorInfo(row.updated_by, accountId);
      editorRole = editor.role;
    } catch (e) {
      console.warn("[opening-balance] editor info lookup failed:", e.message);
    }
  }

  return {
    account_id: row.account_id,
    opening_balance: Number(row.opening_balance) || 0,
    updated_by: row.updated_by,
    updated_by_phone: row.updated_by_phone,
    updated_by_role: editorRole,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET /opening-balance/:accountId
// ---------------------------------------------------------------------------

const getOpeningBalance = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) {
      return fail(res, 401, "unauthenticated", "Authentication required");
    }

    const role = await getRoleForAccount(userId, accountId);
    if (!role) {
      return fail(res, 403, "forbidden", "You do not have access to this account");
    }

    const data = await loadOpeningBalance(accountId);
    const canEdit = role === "owner" || role === "admin";

    return res.json({ ...data, can_edit: canEdit });
  } catch (err) {
    console.error("getOpeningBalance error:", err);
    return fail(res, 500, "server_error", "Failed to load opening balance");
  }
};

// ---------------------------------------------------------------------------
// PUT /opening-balance/:accountId
// ---------------------------------------------------------------------------

const updateOpeningBalance = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) {
      return fail(res, 401, "unauthenticated", "Authentication required");
    }

    const role = await getRoleForAccount(userId, accountId);
    if (!role) {
      return fail(res, 403, "forbidden", "You do not have access to this account");
    }

    if (role !== "owner" && role !== "admin") {
      return fail(
        res,
        403,
        "forbidden",
        "Only owners and admins can change the opening balance"
      );
    }

    const body = req.body || {};
    const raw = body.openingBalance ?? body.opening_balance;

    if (raw === undefined || raw === null || raw === "") {
      return fail(res, 400, "invalid_input", "openingBalance is required");
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return fail(res, 400, "invalid_input", "openingBalance must be a number");
    }

    const value = Math.round(n * 100) / 100;

    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query(
      `SELECT opening_balance FROM account_opening_balances
        WHERE account_id = $1`,
      [accountId]
    );
    const beforeValue = beforeRows[0]?.opening_balance ?? null;

    await client.query(
      `INSERT INTO account_opening_balances
         (account_id, opening_balance, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         opening_balance = EXCLUDED.opening_balance,
         updated_by      = EXCLUDED.updated_by,
         updated_at      = NOW()`,
      [accountId, value, userId]
    );

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "opening_balance",
      entityId: accountId,
      action: beforeValue === null ? "create" : "update",
      before: beforeValue === null ? null : { opening_balance: Number(beforeValue) },
      after: { opening_balance: value },
      metadata: {},
      visibility: "admin",
    });

    await client.query("COMMIT");

    const data = await loadOpeningBalance(accountId);
    return res.json({ ...data, can_edit: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateOpeningBalance error:", err);
    return fail(res, 500, "server_error", "Failed to update opening balance");
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// Schema-aware column detection
// ---------------------------------------------------------------------------

async function detectColumns() {
  const columns = {
    members: {
      maintenance_amount: false,
      monthly_payments: false,
    },
    staff: {
      monthly_salary: false,
      monthly_payments: false,
    },
    expenses: {
      role: false,
      category: false,
      paid_date: false,
      due_date: false,
      expense_date: false,
      transaction_type: false,
    },
  };

  try {
    const { rows: memberCols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'members'`
    );
    const memberSet = new Set(memberCols.map((r) => r.column_name));
    columns.members.maintenance_amount = memberSet.has("maintenance_amount");
    columns.members.monthly_payments = memberSet.has("monthly_payments");
  } catch (e) {
    console.warn("[carried-forward] members column detect failed:", e.message);
  }

  try {
    const { rows: staffCols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'staff'`
    );
    const staffSet = new Set(staffCols.map((r) => r.column_name));
    columns.staff.monthly_salary = staffSet.has("monthly_salary");
    columns.staff.monthly_payments = staffSet.has("monthly_payments");
  } catch (e) {
    console.warn("[carried-forward] staff column detect failed:", e.message);
  }

  try {
    const { rows: expCols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'expenses'`
    );
    const expSet = new Set(expCols.map((r) => r.column_name));
    columns.expenses.role = expSet.has("role");
    columns.expenses.category = expSet.has("category");
    columns.expenses.paid_date = expSet.has("paid_date");
    columns.expenses.due_date = expSet.has("due_date");
    columns.expenses.expense_date = expSet.has("expense_date");
    columns.expenses.transaction_type = expSet.has("transaction_type");
  } catch (e) {
    console.warn("[carried-forward] expenses column detect failed:", e.message);
  }

  return columns;
}

// ---------------------------------------------------------------------------
// GET /opening-balance/:accountId/carried-forward?month=YYYY-MM
// ---------------------------------------------------------------------------

const getCarriedForward = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const month = String(req.query.month || "").trim();

    if (!userId) {
      return fail(res, 401, "unauthenticated", "Authentication required");
    }

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return fail(res, 400, "invalid_input", "month query param must be YYYY-MM");
    }

    const role = await getRoleForAccount(userId, accountId);
    if (!role) {
      return fail(res, 403, "forbidden", "You do not have access to this account");
    }

    const monthStart = `${month}-01`;

    // -------- Opening balance --------
    let openingBalance = 0;
    try {
      const ob = await loadOpeningBalance(accountId);
      openingBalance = Number(ob.opening_balance) || 0;
    } catch (e) {
      console.warn("[carried-forward] opening balance load failed:", e.message);
    }

    const cols = await detectColumns();

    // -------- Maintenance income (JSON) --------
    let maintenanceIncome = 0;
    if (cols.members.monthly_payments) {
      try {
        const maintenanceExpr = cols.members.maintenance_amount
          ? "COALESCE(m.maintenance_amount, 0)"
          : "0";
        const q = `
          SELECT
            COALESCE(SUM(
              CASE
                WHEN (mp.value->>'status') = 'paid'
                 AND (
                   CASE
                     WHEN NULLIF((mp.value->>'paidDate')::text, '') IS NOT NULL
                       THEN ((mp.value->>'paidDate')::text)::date
                     WHEN (mp.key ~ '^\\d{4}-\\d{2}$')
                       THEN ((mp.key || '-01')::date)
                     ELSE NULL
                   END
                 ) IS NOT NULL
                 AND (
                   CASE
                     WHEN NULLIF((mp.value->>'paidDate')::text, '') IS NOT NULL
                       THEN ((mp.value->>'paidDate')::text)::date
                     WHEN (mp.key ~ '^\\d{4}-\\d{2}$')
                       THEN ((mp.key || '-01')::date)
                     ELSE NULL
                   END
                 ) < $2::date
                THEN COALESCE(
                  NULLIF((mp.value->>'netAmount')::numeric, NULL),
                  ${maintenanceExpr}
                    + COALESCE((mp.value->>'additionalAmount')::numeric, 0)
                    - COALESCE((mp.value->>'deductionAmount')::numeric, 0)
                )
                ELSE 0
              END
            ), 0) AS total
          FROM members m
          CROSS JOIN LATERAL jsonb_each(
            COALESCE(m.monthly_payments, '{}'::jsonb)
          ) AS mp(key, value)
          WHERE m.account_id = $1
        `;
        const { rows } = await pool.query(q, [accountId, monthStart]);
        maintenanceIncome = Number(rows[0]?.total) || 0;
      } catch (e) {
        console.warn("[carried-forward] maintenance query failed:", e.message);
      }
    }

    // -------- Salary expense (JSON) --------
    let salaryExpense = 0;
    if (cols.staff.monthly_payments) {
      try {
        const salaryExpr = cols.staff.monthly_salary
          ? "COALESCE(s.monthly_salary, 0)"
          : "0";
        const q = `
          SELECT
            COALESCE(SUM(
              CASE
                WHEN (mp.value->>'status') = 'paid'
                 AND (
                   CASE
                     WHEN NULLIF((mp.value->>'paidDate')::text, '') IS NOT NULL
                       THEN ((mp.value->>'paidDate')::text)::date
                     WHEN (mp.key ~ '^\\d{4}-\\d{2}$')
                       THEN ((mp.key || '-01')::date)
                     ELSE NULL
                   END
                 ) IS NOT NULL
                 AND (
                   CASE
                     WHEN NULLIF((mp.value->>'paidDate')::text, '') IS NOT NULL
                       THEN ((mp.value->>'paidDate')::text)::date
                     WHEN (mp.key ~ '^\\d{4}-\\d{2}$')
                       THEN ((mp.key || '-01')::date)
                     ELSE NULL
                   END
                 ) < $2::date
                THEN COALESCE(
                  NULLIF((mp.value->>'netAmount')::numeric, NULL),
                  ${salaryExpr}
                    + COALESCE((mp.value->>'additionalAmount')::numeric, 0)
                    - COALESCE((mp.value->>'deductionAmount')::numeric, 0)
                )
                ELSE 0
              END
            ), 0) AS total
          FROM staff s
          CROSS JOIN LATERAL jsonb_each(
            COALESCE(s.monthly_payments, '{}'::jsonb)
          ) AS mp(key, value)
          WHERE s.account_id = $1
        `;
        const { rows } = await pool.query(q, [accountId, monthStart]);
        salaryExpense = Number(rows[0]?.total) || 0;
      } catch (e) {
        console.warn("[carried-forward] staff salary query failed:", e.message);
      }
    }

    // -------- Expenses table (non-JSON) --------
    let txIncome = 0;
    let txExpense = 0;
    try {
      const anchorParts = [];
      if (cols.expenses.paid_date) anchorParts.push("paid_date");
      if (cols.expenses.due_date) anchorParts.push("due_date");
      if (cols.expenses.expense_date) anchorParts.push("expense_date");
      const anchorExpr =
        anchorParts.length > 0
          ? `COALESCE(${anchorParts.join(", ")})`
          : "NULL::date";

      const typeExpr = cols.expenses.transaction_type
        ? "COALESCE(transaction_type, 'expense')"
        : "'expense'";

      const q = `
        SELECT
          COALESCE(SUM(
            CASE
              WHEN status = 'paid'
               AND ${anchorExpr} IS NOT NULL
               AND ${anchorExpr} < $2::date
               AND ${typeExpr} = 'income'
              THEN amount ELSE 0
            END
          ), 0) AS income_total,
          COALESCE(SUM(
            CASE
              WHEN status = 'paid'
               AND ${anchorExpr} IS NOT NULL
               AND ${anchorExpr} < $2::date
               AND ${typeExpr} = 'expense'
              THEN amount ELSE 0
            END
          ), 0) AS expense_total
        FROM expenses
        WHERE account_id = $1
      `;
      const { rows } = await pool.query(q, [accountId, monthStart]);
      txIncome = Number(rows[0]?.income_total) || 0;
      txExpense = Number(rows[0]?.expense_total) || 0;
    } catch (e) {
      console.warn("[carried-forward] expenses query failed:", e.message);
    }

    const previousNet =
      maintenanceIncome + txIncome - salaryExpense - txExpense;
    const carriedForward = Number(openingBalance || 0) + previousNet;

    return res.json({
      account_id: accountId,
      month,
      opening_balance: Number(openingBalance) || 0,
      maintenance_income: maintenanceIncome,
      salary_expense: salaryExpense,
      transaction_income: txIncome,
      transaction_expense: txExpense,
      previous_net: Math.round(previousNet * 100) / 100,
      carried_forward: Math.round(carriedForward * 100) / 100,
    });
  } catch (err) {
    console.error("getCarriedForward error:", err);
    return fail(res, 500, "server_error", "Failed to compute carried forward");
  }
};

module.exports = {
  getOpeningBalance,
  updateOpeningBalance,
  getCarriedForward,
};