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
  // Account creator is always treated as owner.
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
//
// owner / admin -> all members, phones always visible
// member / staff -> all members, but phone is masked unless:
//                     • the caller is the member themselves, OR
//                     • the member has added the caller to their allow-list
// ---------------------------------------------------------------------------
const listMembers = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await pool.query(
      `SELECT id, account_id, name, phone, role, photo_url,
              wing, flat_number, area_sqft, parking_available,
              maintenance_amount, created_by, created_at, updated_at
         FROM members
        WHERE account_id = $1
        ORDER BY flat_number, name`,
      [accountId]
    );

    // Owner and admin: no masking.
    if (role === "owner" || role === "admin") {
      return res.json(rows);
    }

    // Member and staff: mask phones per allow-list.
    const callerPhone = getUserPhone(req);

    const { rows: allowed } = await pool.query(
      `SELECT member_id FROM member_phone_visibility
        WHERE account_id = $1 AND viewer_user_id = $2`,
      [accountId, userId]
    );
    const allowedMemberIds = new Set(allowed.map((r) => r.member_id));

    const masked = rows.map((m) => {
      const memberPhone = (m.phone || "").replace(/\D/g, "").slice(-10);
      const isSelf = callerPhone && callerPhone === memberPhone;
      const canSee = isSelf || allowedMemberIds.has(m.id);
      return canSee ? m : { ...m, phone: null };
    });

    return res.json(masked);
  } catch (err) {
    console.error("listMembers error:", err);
    return fail(res, 500, "server_error", "Failed to load members");
  }
};

// ---------------------------------------------------------------------------
// GET /management/:accountId/members/:id
// Same masking rule as listMembers.
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

    const callerPhone = getUserPhone(req);
    const memberPhone = (member.phone || "").replace(/\D/g, "").slice(-10);
    const isSelf = callerPhone && callerPhone === memberPhone;

    if (isSelf) return res.json(member);

    const { rows: allowed } = await pool.query(
      `SELECT 1 FROM member_phone_visibility
        WHERE member_id = $1 AND viewer_user_id = $2 LIMIT 1`,
      [member.id, userId]
    );

    if (allowed.length) return res.json(member);
    return res.json({ ...member, phone: null });
  } catch (err) {
    console.error("getMember error:", err);
    return fail(res, 500, "server_error", "Failed to load member");
  }
};

// ---------------------------------------------------------------------------
// POST /management/:accountId/members  (owner / admin)
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
//
// owner / admin -> any field
// member        -> own row only, only { name, phone, photo_url }
// staff         -> 403
// ---------------------------------------------------------------------------
const updateMember = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await client.query(
      `SELECT * FROM members WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!rows.length) return fail(res, 404, "not_found", "Member not found");
    const existing = rows[0];

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
// DELETE /management/:accountId/members/:id  (owner / admin)
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
// MEMBER PHONE VISIBILITY
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /management/:accountId/members/:id/phone-visibility
//
// Returns the full toggle list for a member.
// Only the member themselves, or an owner/admin, can call this.
//
// Response: array of
//   {
//     user_id, name, role, person_type, member_id, staff_id,
//     enabled, locked, note
//   }
// ---------------------------------------------------------------------------
const getPhoneVisibility = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id: memberId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows: memberRows } = await pool.query(
      `SELECT id, name, phone FROM members WHERE id = $1 AND account_id = $2`,
      [memberId, accountId]
    );
    if (!memberRows.length) return fail(res, 404, "not_found", "Member not found");

    const targetMember = memberRows[0];
    const targetPhone = (targetMember.phone || "").replace(/\D/g, "").slice(-10);
    const callerPhone = getUserPhone(req);
    const callerIsTarget = callerPhone && callerPhone === targetPhone;

    if (!callerIsTarget && role !== "owner" && role !== "admin") {
      return fail(
        res,
        403,
        "forbidden",
        "You cannot manage this member's phone visibility"
      );
    }

    // Every active user on this account except the target member.
    const { rows: people } = await pool.query(
      `SELECT
          u.id            AS user_id,
          u.phone         AS user_phone,
          am.role         AS role,
          COALESCE(m.name, s.name, '') AS name,
          CASE
            WHEN m.id IS NOT NULL THEN 'member'
            WHEN s.id IS NOT NULL THEN 'staff'
            ELSE 'unknown'
          END             AS person_type,
          m.id            AS member_id,
          s.id            AS staff_id
         FROM account_members am
         JOIN users u ON u.id = am.user_id
         LEFT JOIN members m
           ON m.account_id = am.account_id
          AND RIGHT(REGEXP_REPLACE(m.phone,'\\D','','g'),10)
              = RIGHT(REGEXP_REPLACE(u.phone,'\\D','','g'),10)
         LEFT JOIN staff s
           ON s.account_id = am.account_id
          AND RIGHT(REGEXP_REPLACE(s.phone,'\\D','','g'),10)
              = RIGHT(REGEXP_REPLACE(u.phone,'\\D','','g'),10)
        WHERE am.account_id = $1
          AND am.status = 'active'
          AND RIGHT(REGEXP_REPLACE(u.phone,'\\D','','g'),10) <> $2
        ORDER BY
          CASE am.role
            WHEN 'owner' THEN 1
            WHEN 'admin' THEN 2
            WHEN 'member' THEN 3
            WHEN 'staff' THEN 4
            ELSE 5
          END,
          COALESCE(m.name, s.name, '')`,
      [accountId, targetPhone]
    );

    const { rows: existing } = await pool.query(
      `SELECT viewer_user_id FROM member_phone_visibility WHERE member_id = $1`,
      [memberId]
    );
    const allowedSet = new Set(existing.map((r) => r.viewer_user_id));

    const result = people.map((p) => {
      const isOwnerOrAdmin = p.role === "owner" || p.role === "admin";
      return {
        user_id: p.user_id,
        name: p.name || "(unnamed)",
        role: p.role,
        person_type: p.person_type,
        member_id: p.member_id,
        staff_id: p.staff_id,
        enabled: isOwnerOrAdmin ? true : allowedSet.has(p.user_id),
        locked: isOwnerOrAdmin,
        note: isOwnerOrAdmin
          ? p.role === "owner"
            ? "Owner can view by default"
            : "Admin can view by default"
          : null,
      };
    });

    return res.json(result);
  } catch (err) {
    console.error("getPhoneVisibility error:", err);
    return fail(res, 500, "server_error", "Failed to load phone visibility");
  }
};

// ---------------------------------------------------------------------------
// PUT /management/:accountId/members/:id/phone-visibility
//
// Body: { "viewer_user_ids": ["uuid1", "uuid2", ...] }
// Replaces the entire allow-list for that member.
// ---------------------------------------------------------------------------
const updatePhoneVisibility = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id: memberId } = req.params;
    const { viewer_user_ids } = req.body;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    if (!Array.isArray(viewer_user_ids)) {
      return fail(res, 400, "invalid_input", "viewer_user_ids must be an array");
    }

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows: memberRows } = await client.query(
      `SELECT id, phone FROM members WHERE id = $1 AND account_id = $2`,
      [memberId, accountId]
    );
    if (!memberRows.length) return fail(res, 404, "not_found", "Member not found");

    const targetPhone = (memberRows[0].phone || "").replace(/\D/g, "").slice(-10);
    const callerPhone = getUserPhone(req);
    const callerIsTarget = callerPhone && callerPhone === targetPhone;

    if (!callerIsTarget && role !== "owner" && role !== "admin") {
      return fail(
        res,
        403,
        "forbidden",
        "You cannot manage this member's phone visibility"
      );
    }

    await client.query("BEGIN");

    await client.query(
      `DELETE FROM member_phone_visibility WHERE member_id = $1`,
      [memberId]
    );

    if (viewer_user_ids.length > 0) {
      await client.query(
        `INSERT INTO member_phone_visibility
             (account_id, member_id, viewer_user_id)
         SELECT $1, $2, u.id
           FROM users u
           JOIN account_members am
             ON am.user_id = u.id
            AND am.account_id = $1
            AND am.status = 'active'
          WHERE u.id = ANY($3::uuid[])`,
        [accountId, memberId, viewer_user_ids]
      );
    }

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updatePhoneVisibility error:", err);
    return fail(res, 500, "server_error", "Failed to update phone visibility");
  } finally {
    client.release();
  }
};

// ===========================================================================
// STAFF
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /management/:accountId/staff
// Everyone on the account can view the full staff list (phones visible).
// ---------------------------------------------------------------------------
const listStaff = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await pool.query(
      `SELECT id, account_id, name, phone, role, photo_url,
              monthly_salary, created_by, created_at, updated_at
         FROM staff
        WHERE account_id = $1
        ORDER BY name`,
      [accountId]
    );

    return res.json(rows);
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
    return res.json(rows[0]);
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

    const validRoles = [
      "sweeper",
      "security",
      "maintenance",
      "gardener",
      "driver",
      "custom",
    ];
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
// EXPENSES  (view: all roles; write: owner / admin only)
//
// due_date has been removed. expense_date is the single date column.
// ---------------------------------------------------------------------------

const listExpenses = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await pool.query(
      `SELECT id, account_id, category, title, amount, transaction_type,
              status, reminder_enabled, expense_date,
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
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await pool.query(
      `SELECT id, account_id, category, title, amount, transaction_type,
              status, reminder_enabled, expense_date,
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
          reminder_enabled, expense_date, description,
          bill_attachments, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, CURRENT_DATE),$9,$10,$11)
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
      "description",
      "bill_attachments",
    ];

    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] =
          key === "bill_attachments"
            ? JSON.stringify(req.body[key])
            : req.body[key];
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

  // phone visibility
  getPhoneVisibility,
  updatePhoneVisibility,

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