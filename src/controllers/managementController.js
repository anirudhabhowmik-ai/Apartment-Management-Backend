// src/controllers/managementController.js
const { pool } = require("../config/database");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const getUserPhone = (req) => {
  const raw = req.user?.phone ?? null;
  if (!raw) return null;
  // Normalize to last-10 digits so "919876543210" and "+91 98765 43210"
  // both match "9876543210" on the members/staff side.
  const digits = String(raw).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

/**
 * Resolve the caller's role on the given account.
 *
 * Returns one of:
 *   "owner" | "admin" | "member" | "staff" | null
 */
async function getRoleForAccount(userId, accountId) {
  // Account creator is always treated as owner, even if the row
  // in account_members is missing.
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

/** Simple, consistent error responder. */
const fail = (res, status, code, message) =>
  res.status(status).json({ code, message });

// ===========================================================================
// MEMBERS
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /management/:accountId/members
// owner / admin -> all members on the account
// member        -> only their own row (matched by phone)
// staff         -> 403
// ---------------------------------------------------------------------------
const listMembers = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    if (role === "owner" || role === "admin") {
      const { rows } = await pool.query(
        `SELECT id, account_id, name, phone, role, photo_url,
                wing, flat_number, area_sqft, parking_available,
                maintenance_amount, created_by, created_at, updated_at
           FROM members
          WHERE account_id = $1
          ORDER BY flat_number, name`,
        [accountId]
      );
      return res.json(rows);
    }

    if (role === "member") {
      const phone = getUserPhone(req);
      if (!phone) return res.json([]);

      const { rows } = await pool.query(
        `SELECT id, account_id, name, phone, role, photo_url,
                wing, flat_number, area_sqft, parking_available,
                maintenance_amount, created_by, created_at, updated_at
           FROM members
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2`,
        [accountId, phone]
      );
      return res.json(rows);
    }

    // staff: no access to member list
    return fail(res, 403, "forbidden", "You do not have access to members");
  } catch (err) {
    console.error("listMembers error:", err);
    return fail(res, 500, "server_error", "Failed to load members");
  }
};

// ---------------------------------------------------------------------------
// GET /management/:accountId/members/:id
// ---------------------------------------------------------------------------
const getMember = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await pool.query(
      `SELECT id, account_id, name, phone, role, photo_url,
              wing, flat_number, area_sqft, parking_available,
              maintenance_amount, created_by, created_at, updated_at
         FROM members
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );

    if (!rows.length) return fail(res, 404, "not_found", "Member not found");
    const member = rows[0];

    if (role === "owner" || role === "admin") return res.json(member);

    if (role === "member") {
      const phone = getUserPhone(req);
      const memberPhone = (member.phone || "").replace(/\D/g, "").slice(-10);
      if (phone && phone === memberPhone) return res.json(member);
      return fail(res, 403, "forbidden", "You can only view your own record");
    }

    return fail(res, 403, "forbidden", "You do not have access to this record");
  } catch (err) {
    console.error("getMember error:", err);
    return fail(res, 500, "server_error", "Failed to load member");
  }
};

// ---------------------------------------------------------------------------
// POST /management/:accountId/members
// owner / admin only
// ---------------------------------------------------------------------------
const createMember = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can add members");
    }

    const {
      name,
      phone = null,
      role: memberRole = "owner",
      photo_url = null,
      wing = null,
      flat_number,
      area_sqft = null,
      parking_available = false,
      maintenance_amount = 0,
    } = req.body;

    if (!name || !flat_number) {
      return fail(res, 400, "invalid_input", "Name and flat number are required");
    }

    const validRoles = ["owner", "secretary", "tenant", "custom"];
    if (!validRoles.includes(memberRole)) {
      return fail(res, 400, "invalid_role", "Invalid member role");
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO members
         (account_id, name, phone, role, photo_url, wing, flat_number,
          area_sqft, parking_available, maintenance_amount, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        accountId,
        name.trim(),
        phone,
        memberRole,
        photo_url,
        wing,
        flat_number,
        area_sqft,
        parking_available,
        maintenance_amount,
        userId,
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createMember error:", err);
    return fail(res, 500, "server_error", "Failed to create member");
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// PATCH /management/:accountId/members/:id
// owner / admin -> any field
// member        -> only { name, phone, photo_url }, on their own row
// ---------------------------------------------------------------------------
const updateMember = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    // Fetch the existing member
    const { rows } = await client.query(
      `SELECT * FROM members WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!rows.length) return fail(res, 404, "not_found", "Member not found");
    const existing = rows[0];

    // Determine which fields the caller may change
    let allowedFields;
    if (role === "owner" || role === "admin") {
      allowedFields = [
        "name",
        "phone",
        "role",
        "photo_url",
        "wing",
        "flat_number",
        "area_sqft",
        "parking_available",
        "maintenance_amount",
      ];
    } else if (role === "member") {
      const phone = getUserPhone(req);
      const existingPhone = (existing.phone || "").replace(/\D/g, "").slice(-10);
      if (!phone || phone !== existingPhone) {
        return fail(res, 403, "forbidden", "You can only edit your own record");
      }
      allowedFields = ["name", "phone", "photo_url"];
    } else {
      return fail(res, 403, "forbidden", "You do not have access to this record");
    }

    // Build the SET clause from allowed fields only
    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return fail(res, 400, "invalid_input", "No permitted fields to update");
    }

    // If a non-owner/admin tries to set `role`, reject
    if (
      role !== "owner" &&
      role !== "admin" &&
      Object.prototype.hasOwnProperty.call(updates, "role")
    ) {
      return fail(res, 403, "forbidden", "You cannot change your role");
    }

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const setClause = keys
      .map((k, i) => `${k} = $${i + 1}`)
      .join(", ");

    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE members
          SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1}
          AND account_id = $${keys.length + 2}
        RETURNING *`,
      [...values, id, accountId]
    );

    await client.query("COMMIT");
    return res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateMember error:", err);
    return fail(res, 500, "server_error", "Failed to update member");
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// DELETE /management/:accountId/members/:id
// owner / admin only
// ---------------------------------------------------------------------------
const deleteMember = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can delete members");
    }

    const result = await pool.query(
      `DELETE FROM members WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "not_found", "Member not found");
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteMember error:", err);
    return fail(res, 500, "server_error", "Failed to delete member");
  }
};

// ===========================================================================
// STAFF  (same shape as members)
// ===========================================================================

const listStaff = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    if (role === "owner" || role === "admin") {
      const { rows } = await pool.query(
        `SELECT id, account_id, name, phone, role, photo_url,
                monthly_salary, created_by, created_at, updated_at
           FROM staff
          WHERE account_id = $1
          ORDER BY name`,
        [accountId]
      );
      return res.json(rows);
    }

    if (role === "staff") {
      const phone = getUserPhone(req);
      if (!phone) return res.json([]);

      const { rows } = await pool.query(
        `SELECT id, account_id, name, phone, role, photo_url,
                monthly_salary, created_by, created_at, updated_at
           FROM staff
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2`,
        [accountId, phone]
      );
      return res.json(rows);
    }

    return fail(res, 403, "forbidden", "You do not have access to staff");
  } catch (err) {
    console.error("listStaff error:", err);
    return fail(res, 500, "server_error", "Failed to load staff");
  }
};

const getStaff = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await pool.query(
      `SELECT id, account_id, name, phone, role, photo_url,
              monthly_salary, created_by, created_at, updated_at
         FROM staff
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );

    if (!rows.length) return fail(res, 404, "not_found", "Staff not found");
    const person = rows[0];

    if (role === "owner" || role === "admin") return res.json(person);

    if (role === "staff") {
      const phone = getUserPhone(req);
      const staffPhone = (person.phone || "").replace(/\D/g, "").slice(-10);
      if (phone && phone === staffPhone) return res.json(person);
      return fail(res, 403, "forbidden", "You can only view your own record");
    }

    return fail(res, 403, "forbidden", "You do not have access to this record");
  } catch (err) {
    console.error("getStaff error:", err);
    return fail(res, 500, "server_error", "Failed to load staff");
  }
};

const createStaff = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can add staff");
    }

    const {
      name,
      phone = null,
      role: staffRole,
      photo_url = null,
      monthly_salary = 0,
    } = req.body;

    if (!name || !staffRole) {
      return fail(res, 400, "invalid_input", "Name and role are required");
    }

    const validRoles = ["sweeper", "security", "maintenance", "gardener", "driver", "custom"];
    if (!validRoles.includes(staffRole)) {
      return fail(res, 400, "invalid_role", "Invalid staff role");
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO staff
         (account_id, name, phone, role, photo_url, monthly_salary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [accountId, name.trim(), phone, staffRole, photo_url, monthly_salary, userId]
    );

    await client.query("COMMIT");
    return res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createStaff error:", err);
    return fail(res, 500, "server_error", "Failed to create staff");
  } finally {
    client.release();
  }
};

const updateStaff = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await client.query(
      `SELECT * FROM staff WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!rows.length) return fail(res, 404, "not_found", "Staff not found");
    const existing = rows[0];

    let allowedFields;
    if (role === "owner" || role === "admin") {
      allowedFields = ["name", "phone", "role", "photo_url", "monthly_salary"];
    } else if (role === "staff") {
      const phone = getUserPhone(req);
      const existingPhone = (existing.phone || "").replace(/\D/g, "").slice(-10);
      if (!phone || phone !== existingPhone) {
        return fail(res, 403, "forbidden", "You can only edit your own record");
      }
      allowedFields = ["name", "phone", "photo_url"];
    } else {
      return fail(res, 403, "forbidden", "You do not have access to this record");
    }

    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return fail(res, 400, "invalid_input", "No permitted fields to update");
    }

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE staff
          SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1}
          AND account_id = $${keys.length + 2}
        RETURNING *`,
      [...values, id, accountId]
    );

    await client.query("COMMIT");
    return res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateStaff error:", err);
    return fail(res, 500, "server_error", "Failed to update staff");
  } finally {
    client.release();
  }
};

const deleteStaff = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can delete staff");
    }

    const result = await pool.query(
      `DELETE FROM staff WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "not_found", "Staff not found");
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteStaff error:", err);
    return fail(res, 500, "server_error", "Failed to delete staff");
  }
};

// ===========================================================================
// EXPENSES  (owner / admin only)
// ===========================================================================

const listExpenses = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can view expenses");
    }

    const { rows } = await pool.query(
      `SELECT id, account_id, category, title, amount, transaction_type,
              status, reminder_enabled, expense_date, due_date,
              description, bill_attachments, created_by, created_at, updated_at
         FROM expenses
        WHERE account_id = $1
        ORDER BY expense_date DESC, created_at DESC`,
      [accountId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("listExpenses error:", err);
    return fail(res, 500, "server_error", "Failed to load expenses");
  }
};

const getExpense = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can view expenses");
    }

    const { rows } = await pool.query(
      `SELECT id, account_id, category, title, amount, transaction_type,
              status, reminder_enabled, expense_date, due_date,
              description, bill_attachments, created_by, created_at, updated_at
         FROM expenses
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );

    if (!rows.length) return fail(res, 404, "not_found", "Expense not found");
    return res.json(rows[0]);
  } catch (err) {
    console.error("getExpense error:", err);
    return fail(res, 500, "server_error", "Failed to load expense");
  }
};

const createExpense = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can add expenses");
    }

    const {
      category,
      title,
      amount,
      transaction_type = "expense",
      status = "paid",
      reminder_enabled = false,
      expense_date,
      due_date = null,
      description = null,
      bill_attachments = [],
    } = req.body;

    if (!category || !title || amount == null) {
      return fail(res, 400, "invalid_input", "Category, title and amount are required");
    }

    if (!["expense", "income"].includes(transaction_type)) {
      return fail(res, 400, "invalid_type", "Invalid transaction type");
    }

    if (!["paid", "due"].includes(status)) {
      return fail(res, 400, "invalid_status", "Invalid status");
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO expenses
         (account_id, category, title, amount, transaction_type, status,
          reminder_enabled, expense_date, due_date, description,
          bill_attachments, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, CURRENT_DATE),$9,$10,$11,$12)
       RETURNING *`,
      [
        accountId,
        category,
        title.trim(),
        amount,
        transaction_type,
        status,
        reminder_enabled,
        expense_date || null,
        due_date,
        description,
        JSON.stringify(bill_attachments),
        userId,
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createExpense error:", err);
    return fail(res, 500, "server_error", "Failed to create expense");
  } finally {
    client.release();
  }
};

const updateExpense = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can update expenses");
    }

    const allowedFields = [
      "category",
      "title",
      "amount",
      "transaction_type",
      "status",
      "reminder_enabled",
      "expense_date",
      "due_date",
      "description",
      "bill_attachments",
    ];

    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] =
          key === "bill_attachments" ? JSON.stringify(req.body[key]) : req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return fail(res, 400, "invalid_input", "No fields to update");
    }

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE expenses
          SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1}
          AND account_id = $${keys.length + 2}
        RETURNING *`,
      [...values, id, accountId]
    );

    await client.query("COMMIT");

    if (updated.rowCount === 0) {
      return fail(res, 404, "not_found", "Expense not found");
    }

    return res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateExpense error:", err);
    return fail(res, 500, "server_error", "Failed to update expense");
  } finally {
    client.release();
  }
};

const deleteExpense = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can delete expenses");
    }

    const result = await pool.query(
      `DELETE FROM expenses WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );

    if (result.rowCount === 0) {
      return fail(res, 404, "not_found", "Expense not found");
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteExpense error:", err);
    return fail(res, 500, "server_error", "Failed to delete expense");
  }
};

// ===========================================================================

module.exports = {
  // members
  listMembers,
  getMember,
  createMember,
  updateMember,
  deleteMember,
  // staff
  listStaff,
  getStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  // expenses
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
};