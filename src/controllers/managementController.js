// @ts-nocheck
// src/controllers/managementController.js
const { pool } = require("../config/database");
const {
  isEligibleForAutoGrant,
  ensureUserForPhone,
  deactivateAccessRole,
} = require("../utils/accessSync");

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const getUserPhone = (req) => {
  const raw = req.user?.phone ?? null;
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const normalizePhone = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
};

const toNullableAmount = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const truncated = Math.trunc(n);
  return truncated > 0 ? truncated : null;
};

const toNullableNote = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
};

const fail = (res, status, code, message) =>
  res.status(status).json({ code, message });

async function getRoleForAccount(userId, accountId) {
  const { rows: ownerRows } = await pool.query(
    `SELECT 1 FROM accounts WHERE id = $1 AND created_by = $2`,
    [accountId, userId],
  );
  if (ownerRows.length) return "owner";

  const { rows } = await pool.query(
    `SELECT role FROM account_members
       WHERE account_id = $1 AND user_id = $2 AND status = 'active'
       LIMIT 1`,
    [accountId, userId],
  );
  return rows.length ? rows[0].role : null;
}

function normalizeMonth(raw) {
  if (typeof raw === "string" && /^\d{4}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// Identity lock helper
//
// A member/staff row's identity (name, phone, photo) is locked to the
// owner/admin when the linked user has an ACTIVE account_members row for
// this account. That means they've accepted an invitation and "joined".
// ---------------------------------------------------------------------------

async function hasActiveAccountMemberRow(client, accountId, userId) {
  if (!accountId || !userId) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id = $1
         AND user_id    = $2
         AND status     = 'active'
       LIMIT 1`,
    [accountId, userId],
  );
  return rows.length > 0;
}

function shapeMemberRow(row, payment) {
  return {
    id: row.id,
    account_id: row.account_id,
    user_id: row.user_id,
    name: row.name ?? "",
    phone: row.phone ?? "",
    photo_url: row.photo_url ?? null,
    role: row.role,
    wing: row.wing ?? null,
    flat_number: row.flat_number,
    area_sqft: row.area_sqft ?? null,
    parking_available: !!row.parking_available,
    maintenance_amount: Number(row.maintenance_amount) || 0,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_access: !!row.has_access,
    due_amount: payment
      ? computeMemberDue(row, payment)
      : computeMemberDue(row, null),
    due_month: payment?.month ?? null,
    monthly_payments: payment
      ? { [payment.month]: mapMemberPaymentRow(payment) }
      : {},
  };
}

function shapeStaffRow(row, payment, attendance) {
  return {
    id: row.id,
    account_id: row.account_id,
    user_id: row.user_id,
    name: row.name ?? "",
    phone: row.phone ?? "",
    photo_url: row.photo_url ?? null,
    role: row.role,
    monthly_salary: Number(row.monthly_salary) || 0,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_access: !!row.has_access,
    due_amount: computeStaffDue(row, attendance, payment),
    due_month: payment?.month ?? attendance?.month ?? null,
    monthly_payments: payment
      ? { [payment.month]: mapStaffPaymentRow(payment) }
      : {},
    attendance_for_month: attendance
      ? {
          statuses: attendance.statuses,
          paidDays: attendance.paid_days,
          calculatedSalary:
            attendance.calculated_salary != null
              ? Number(attendance.calculated_salary)
              : null,
        }
      : null,
  };
}

function computeMemberDue(memberRow, paymentRow) {
  const base = Number(memberRow?.maintenance_amount) || 0;
  const additional =
    paymentRow?.additional_amount != null
      ? Number(paymentRow.additional_amount)
      : 0;
  const deduction =
    paymentRow?.deduction_amount != null
      ? Number(paymentRow.deduction_amount)
      : 0;
  return Math.max(0, base + additional - deduction);
}

function computeStaffDue(staffRow, attendanceRow, paymentRow) {
  const monthly = Number(staffRow?.monthly_salary) || 0;
  const effectiveBase =
    attendanceRow?.calculated_salary != null
      ? Number(attendanceRow.calculated_salary)
      : monthly;
  const additional =
    paymentRow?.additional_amount != null
      ? Number(paymentRow.additional_amount)
      : 0;
  const deduction =
    paymentRow?.deduction_amount != null
      ? Number(paymentRow.deduction_amount)
      : 0;
  return Math.max(0, effectiveBase + additional - deduction);
}

function mapMemberPaymentRow(p) {
  return {
    status: p.status,
    paidDate: p.paid_date,
    additionalAmount:
      p.additional_amount != null ? Number(p.additional_amount) : null,
    additionalNote: p.additional_note,
    deductionAmount:
      p.deduction_amount != null ? Number(p.deduction_amount) : null,
    deductionNote: p.deduction_note,
    netAmount: p.net_amount != null ? Number(p.net_amount) : null,
  };
}

function mapStaffPaymentRow(p) {
  return {
    status: p.status,
    paidDate: p.paid_date,
    additionalAmount:
      p.additional_amount != null ? Number(p.additional_amount) : null,
    additionalNote: p.additional_note,
    deductionAmount:
      p.deduction_amount != null ? Number(p.deduction_amount) : null,
    deductionNote: p.deduction_note,
    netAmount: p.net_amount != null ? Number(p.net_amount) : null,
  };
}

async function syncMemberAccessOnCreate(client, accountId, memberRow) {
  if (!memberRow?.user_id) return;
  if (!(await isEligibleForAutoGrant(client, accountId, memberRow.user_id)))
    return;

  const { rows: existingAdmin } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'
       LIMIT 1`,
    [accountId, memberRow.user_id],
  );
  if (existingAdmin.length) return;

  const { rows: existingMember } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id = $1 AND user_id = $2 AND role = 'member_visibility' AND status = 'active'
       LIMIT 1`,
    [accountId, memberRow.user_id],
  );
  if (existingMember.length) return;

  await client.query(
    `INSERT INTO account_members (account_id, user_id, role, status)
     VALUES ($1, $2, 'member_visibility', 'active')
     ON CONFLICT (account_id, user_id, role)
     DO UPDATE SET status = 'active', updated_at = NOW()`,
    [accountId, memberRow.user_id],
  );
}

async function syncStaffAccessOnCreate(client, accountId, staffRow) {
  if (!staffRow?.user_id) return;
  if (!(await isEligibleForAutoGrant(client, accountId, staffRow.user_id)))
    return;

  const { rows: existingAdmin } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'
       LIMIT 1`,
    [accountId, staffRow.user_id],
  );
  if (existingAdmin.length) return;

  const { rows: existingStaff } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id = $1 AND user_id = $2 AND role = 'staff_visibility' AND status = 'active'
       LIMIT 1`,
    [accountId, staffRow.user_id],
  );
  if (existingStaff.length) return;

  await client.query(
    `INSERT INTO account_members (account_id, user_id, role, status)
     VALUES ($1, $2, 'staff_visibility', 'active')
     ON CONFLICT (account_id, user_id, role)
     DO UPDATE SET status = 'active', updated_at = NOW()`,
    [accountId, staffRow.user_id],
  );
}

// ===========================================================================
// listAccountPeople
// ===========================================================================

const listAccountPeople = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const map = new Map();

    const { rows: ownerRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId],
    );
    for (const r of ownerRows) {
      if (!r.user_id) continue;
      map.set(r.user_id, {
        user_id: r.user_id,
        name: r.name ?? "",
        phone: r.phone ?? null,
        photo_url: r.photo_url ?? null,
        kind: "owner",
      });
    }

    const { rows: adminRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM account_members am
         JOIN users u ON u.id = am.user_id
        WHERE am.account_id = $1
          AND am.role       = 'admin'
          AND am.status     = 'active'`,
      [accountId],
    );
    for (const r of adminRows) {
      if (!r.user_id) continue;
      if (map.has(r.user_id)) continue;
      map.set(r.user_id, {
        user_id: r.user_id,
        name: r.name ?? "",
        phone: r.phone ?? null,
        photo_url: r.photo_url ?? null,
        kind: "admin",
      });
    }

    const { rows: memberRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM members m
         JOIN users u ON u.id = m.user_id
        WHERE m.account_id = $1
          AND m.status     = 'active'`,
      [accountId],
    );
    for (const r of memberRows) {
      if (!r.user_id) continue;
      if (map.has(r.user_id)) continue;
      map.set(r.user_id, {
        user_id: r.user_id,
        name: r.name ?? "",
        phone: r.phone ?? null,
        photo_url: r.photo_url ?? null,
        kind: "member",
      });
    }

    const { rows: staffRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.account_id = $1
          AND s.status     = 'active'`,
      [accountId],
    );
    for (const r of staffRows) {
      if (!r.user_id) continue;
      if (map.has(r.user_id)) continue;
      map.set(r.user_id, {
        user_id: r.user_id,
        name: r.name ?? "",
        phone: r.phone ?? null,
        photo_url: r.photo_url ?? null,
        kind: "staff",
      });
    }

    const result = Array.from(map.values()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name)),
    );

    return res.json(result);
  } catch (err) {
    console.error("listAccountPeople error:", err);
    return fail(res, 500, "server_error", "Failed to load people");
  }
};

// ===========================================================================
// MEMBERS
// ===========================================================================

const listMembers = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const month = normalizeMonth(req.query?.month);

    const { rows } = await pool.query(
      `SELECT m.id, m.account_id, m.user_id, m.role,
              m.wing, m.flat_number, m.area_sqft, m.parking_available,
              m.maintenance_amount, m.status, m.created_by,
              m.created_at, m.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (
                SELECT 1 FROM account_members am
                 WHERE am.account_id = m.account_id
                   AND am.user_id    = m.user_id
                   AND am.status     = 'active'
              ) AS has_access
         FROM members m
         JOIN users u ON u.id = m.user_id
        WHERE m.account_id = $1
        ORDER BY m.flat_number, u.name`,
      [accountId],
    );

    const { rows: payRows } = await pool.query(
      `SELECT mmp.member_id, mmp.month, mmp.status, mmp.paid_date,
              mmp.additional_amount, mmp.additional_note,
              mmp.deduction_amount, mmp.deduction_note, mmp.net_amount
         FROM member_monthly_payments mmp
         JOIN members m ON m.id = mmp.member_id
        WHERE m.account_id = $1
          AND mmp.month = $2`,
      [accountId, month],
    );

    const paymentByMember = new Map();
    for (const p of payRows) paymentByMember.set(p.member_id, p);

    const result = rows.map((m) =>
      shapeMemberRow(m, paymentByMember.get(m.id) ?? null),
    );

    if (role === "owner" || role === "admin") return res.json(result);

    const callerPhone = getUserPhone(req);
    const { rows: allowed } = await pool.query(
      `SELECT member_id FROM member_phone_visibility
        WHERE account_id = $1 AND viewer_user_id = $2`,
      [accountId, userId],
    );
    const allowedMemberIds = new Set(allowed.map((r) => r.member_id));

    const masked = result.map((m) => {
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

const getMember = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const { rows } = await pool.query(
      `SELECT m.id, m.account_id, m.user_id, m.role,
              m.wing, m.flat_number, m.area_sqft, m.parking_available,
              m.maintenance_amount, m.status, m.created_by,
              m.created_at, m.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (
                SELECT 1 FROM account_members am
                 WHERE am.account_id = m.account_id
                   AND am.user_id    = m.user_id
                   AND am.status     = 'active'
              ) AS has_access
         FROM members m
         JOIN users u ON u.id = m.user_id
        WHERE m.id = $1
          AND m.account_id = $2
          AND m.status = 'active'`,
      [id, accountId],
    );

    if (!rows.length) return fail(res, 404, "not_found", "Member not found");
    const member = shapeMemberRow(rows[0], null);

    if (role === "owner" || role === "admin") return res.json(member);

    const callerPhone = getUserPhone(req);
    const memberPhone = (member.phone || "").replace(/\D/g, "").slice(-10);
    const isSelf = callerPhone && callerPhone === memberPhone;
    if (isSelf) return res.json(member);

    const { rows: allowed } = await pool.query(
      `SELECT 1 FROM member_phone_visibility
        WHERE member_id = $1 AND viewer_user_id = $2 LIMIT 1`,
      [member.id, userId],
    );
    if (allowed.length) return res.json(member);

    return res.json({ ...member, phone: null });
  } catch (err) {
    console.error("getMember error:", err);
    return fail(res, 500, "server_error", "Failed to load member");
  }
};

// ===========================================================================
// createMember
// ===========================================================================
const createMember = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can add members");
    }

    const body = req.body || {};
    const mode = body.mode === "existing" ? "existing" : "new";

    const {
      role: rawMemberRole,
      wing = null,
      flat_number,
      area_sqft = null,
      parking_available = false,
      maintenance_amount = 0,
    } = body;

    if (!flat_number) {
      return fail(res, 400, "invalid_input", "Flat number is required");
    }

    const memberRole = String(rawMemberRole || "").trim();
    if (!memberRole) {
      return fail(res, 400, "invalid_input", "Member role is required");
    }
    if (memberRole.length > 60) {
      return fail(res, 400, "invalid_input", "Member role is too long");
    }

    await client.query("BEGIN");

    let targetUserId = null;

    if (mode === "existing") {
      targetUserId = body.user_id || null;
      if (!targetUserId) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input", "user_id is required for mode=existing");
      }
      const { rows: u } = await client.query(
        `SELECT id FROM users WHERE id = $1 LIMIT 1`,
        [targetUserId],
      );
      if (!u.length) {
        await client.query("ROLLBACK");
        return fail(res, 404, "not_found", "Person not found");
      }
    } else {
      const name = (body.name || "").trim();
      const phone = normalizePhone(body.phone);
      const photo_url = body.photo_url ?? null;

      if (!name) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input", "Name is required");
      }
      if (!phone) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input", "A valid 10-digit phone is required");
      }

      targetUserId = await ensureUserForPhone(client, phone, name);

      if (photo_url !== null && photo_url !== undefined) {
        await client.query(
          `UPDATE users
              SET photo_url = COALESCE(photo_url, $1), updated_at = NOW()
            WHERE id = $2`,
          [photo_url, targetUserId],
        );
      }
    }

    const { rows } = await client.query(
      `INSERT INTO members
         (account_id, user_id, role, wing, flat_number,
          area_sqft, parking_available, maintenance_amount,
          status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)
       RETURNING id`,
      [
        accountId,
        targetUserId,
        memberRole,
        wing,
        flat_number,
        area_sqft,
        parking_available,
        maintenance_amount,
        userId,
      ],
    );

    const memberId = rows[0].id;

    const { rows: joined } = await client.query(
      `SELECT m.id, m.account_id, m.user_id, m.role,
              m.wing, m.flat_number, m.area_sqft, m.parking_available,
              m.maintenance_amount, m.status, m.created_by,
              m.created_at, m.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (
                SELECT 1 FROM account_members am
                 WHERE am.account_id = m.account_id
                   AND am.user_id    = m.user_id
                   AND am.status     = 'active'
              ) AS has_access
         FROM members m
         JOIN users u ON u.id = m.user_id
        WHERE m.id = $1`,
      [memberId],
    );

    await syncMemberAccessOnCreate(client, accountId, joined[0]);

    await client.query("COMMIT");

    return res.status(201).json(shapeMemberRow(joined[0], null));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createMember error:", err);
    return fail(res, 500, "server_error", "Failed to create member");
  } finally {
    client.release();
  }
};

// ===========================================================================
// updateMember
//
// Admin/owner can edit every field.
//
// Exception: if the target user has an ACTIVE account_members row, the
// identity fields (name, phone, photo) are locked — only the user
// themselves can change them (via the profile editor).
// ===========================================================================
const updateMember = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const { rows } = await client.query(
      `SELECT id, user_id FROM members
        WHERE id = $1 AND account_id = $2 AND status = 'active'`,
      [id, accountId],
    );
    if (!rows.length) return fail(res, 404, "not_found", "Member not found");

    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can edit members");
    }

    const targetUserId = rows[0].user_id;

    // ── Is this person's identity locked? ──
    const identityLocked = await hasActiveAccountMemberRow(
      client,
      accountId,
      targetUserId,
    );

    // ── Identity fields (name, phone, photo_url) ──
    const hasName = Object.prototype.hasOwnProperty.call(req.body, "name");
    const hasPhone = Object.prototype.hasOwnProperty.call(req.body, "phone");
    const hasPhoto = Object.prototype.hasOwnProperty.call(req.body, "photo_url");

    if (identityLocked && (hasName || hasPhone || hasPhoto)) {
      return fail(
        res,
        403,
        "user_identity_locked",
        "This person has joined the app. Their name, phone and photo can only be changed by them.",
      );
    }

    const newName = hasName
      ? String(req.body.name ?? "").trim() || null
      : null;
    const newPhone = hasPhone ? normalizePhone(req.body.phone) : null;
    const newPhoto = hasPhoto
      ? req.body.photo_url === null
        ? null
        : String(req.body.photo_url)
      : undefined;

    if (hasName && !newName) {
      return fail(res, 400, "invalid_input", "Name cannot be empty");
    }
    if (hasPhone && !newPhone) {
      return fail(res, 400, "invalid_input", "A valid 10-digit phone is required");
    }

    // ── Non-identity member fields ──
    const allowedFields = [
      "role",
      "wing",
      "flat_number",
      "area_sqft",
      "parking_available",
      "maintenance_amount",
    ];

    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = req.body[key];
      }
    }

    if (updates.role !== undefined) {
      const roleStr = String(updates.role || "").trim();
      if (!roleStr) {
        return fail(res, 400, "invalid_input", "Role cannot be empty");
      }
      if (roleStr.length > 60) {
        return fail(res, 400, "invalid_input", "Role is too long");
      }
      updates.role = roleStr;
    }

    const nothingToUpdate =
      Object.keys(updates).length === 0 &&
      !hasName &&
      !hasPhone &&
      !hasPhoto;

    if (nothingToUpdate) {
      return fail(res, 400, "invalid_input", "No permitted fields to update");
    }

    await client.query("BEGIN");

    // ── Write identity changes to the shared users row ──
    if (!identityLocked && (hasName || hasPhone || hasPhoto)) {
      // Phone collision check.
      if (hasPhone) {
        const { rows: conflict } = await client.query(
          `SELECT id FROM users WHERE phone = $1 AND id <> $2 LIMIT 1`,
          [`91${newPhone}`, targetUserId],
        );
        // Also try the bare 10-digit variant in case the column stores
        // either form historically.
        let conflictRows = conflict;
        if (!conflictRows.length) {
          const { rows: alt } = await client.query(
            `SELECT id FROM users WHERE phone = $1 AND id <> $2 LIMIT 1`,
            [newPhone, targetUserId],
          );
          conflictRows = alt;
        }
        if (conflictRows.length) {
          await client.query("ROLLBACK");
          return fail(
            res,
            409,
            "phone_in_use",
            "This phone number already belongs to another user.",
          );
        }
      }

      const setParts = [];
      const values = [];
      if (hasName) {
        values.push(newName);
        setParts.push(`name = $${values.length}`);
      }
      if (hasPhone) {
        // Store in E.164-ish form `91XXXXXXXXXX` to match the rest of
        // the codebase (authController.normalizePhone).
        values.push(`91${newPhone}`);
        setParts.push(`phone = $${values.length}`);
      }
      if (hasPhoto) {
        values.push(newPhoto);
        setParts.push(`photo_url = $${values.length}`);
      }
      values.push(targetUserId);

      await client.query(
        `UPDATE users
            SET ${setParts.join(", ")}, updated_at = NOW()
          WHERE id = $${values.length}`,
        values,
      );
    }

    // ── Non-identity member fields ──
    if (Object.keys(updates).length > 0) {
      const keys = Object.keys(updates);
      const values = keys.map((k) => updates[k]);
      const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

      await client.query(
        `UPDATE members
            SET ${setClause}, updated_at = NOW()
          WHERE id = $${keys.length + 1}
            AND account_id = $${keys.length + 2}`,
        [...values, id, accountId],
      );
    } else if (!identityLocked && (hasName || hasPhone || hasPhoto)) {
      await client.query(
        `UPDATE members SET updated_at = NOW()
          WHERE id = $1 AND account_id = $2`,
        [id, accountId],
      );
    }

    const { rows: joined } = await client.query(
      `SELECT m.id, m.account_id, m.user_id, m.role,
              m.wing, m.flat_number, m.area_sqft, m.parking_available,
              m.maintenance_amount, m.status, m.created_by,
              m.created_at, m.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (
                SELECT 1 FROM account_members am
                 WHERE am.account_id = m.account_id
                   AND am.user_id    = m.user_id
                   AND am.status     = 'active'
              ) AS has_access
         FROM members m
         JOIN users u ON u.id = m.user_id
        WHERE m.id = $1`,
      [id],
    );

    await client.query("COMMIT");
    return res.json(shapeMemberRow(joined[0], null));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateMember error:", err);
    return fail(res, 500, "server_error", "Failed to update member");
  } finally {
    client.release();
  }
};

const deleteMember = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can delete members");
    }

    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE members
          SET status = 'inactive', updated_at = NOW()
        WHERE id = $1 AND account_id = $2 AND status = 'active'
        RETURNING user_id`,
      [id, accountId],
    );

    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Member not found");
    }

    const targetUserId = updated.rows[0]?.user_id;

    if (targetUserId) {
      const { rows: stillMember } = await client.query(
        `SELECT 1 FROM members WHERE account_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
        [accountId, targetUserId],
      );
      if (!stillMember.length) {
        const { rows: stillStaff } = await client.query(
          `SELECT 1 FROM staff WHERE account_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
          [accountId, targetUserId],
        );
        if (!stillStaff.length) {
          const { rows: isAdmin } = await client.query(
            `SELECT 1 FROM account_members
              WHERE account_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'
              LIMIT 1`,
            [accountId, targetUserId],
          );
          if (!isAdmin.length) {
            await deactivateAccessRole(client, accountId, targetUserId, "member_visibility");
          }
        }
      }
    }

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deleteMember error:", err);
    return fail(res, 500, "server_error", "Failed to delete member");
  } finally {
    client.release();
  }
};

const getPhoneVisibility = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id: memberId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const { rows: memberRows } = await pool.query(
      `SELECT m.id, u.phone, u.id AS user_id
         FROM members m
         JOIN users u ON u.id = m.user_id
        WHERE m.id = $1 AND m.account_id = $2 AND m.status = 'active'`,
      [memberId, accountId],
    );
    if (!memberRows.length) return fail(res, 404, "not_found", "Member not found");

    const targetMember = memberRows[0];
    const targetPhone = (targetMember.phone || "").replace(/\D/g, "").slice(-10);
    const callerPhone = getUserPhone(req);
    const callerIsTarget = callerPhone && callerPhone === targetPhone;

    if (!callerIsTarget && role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "You cannot manage this member's phone visibility");
    }

    const { rows: people } = await pool.query(
      `SELECT
          u.id            AS user_id,
          u.phone         AS user_phone,
          u.name          AS user_name,
          u.photo_url     AS user_photo_url,
          am.role         AS role,
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
           ON m.user_id = u.id
          AND m.account_id = am.account_id
          AND m.status = 'active'
         LEFT JOIN staff s
           ON s.user_id = u.id
          AND s.account_id = am.account_id
          AND s.status = 'active'
        WHERE am.account_id = $1
          AND am.status = 'active'
          AND u.id <> $2
        ORDER BY
          CASE am.role
            WHEN 'admin' THEN 1
            WHEN 'member_visibility' THEN 2
            WHEN 'staff_visibility' THEN 3
            ELSE 4
          END,
          COALESCE(u.name, '')`,
      [accountId, targetMember.user_id],
    );

    const { rows: existing } = await pool.query(
      `SELECT viewer_user_id FROM member_phone_visibility WHERE member_id = $1`,
      [memberId],
    );
    const allowedSet = new Set(existing.map((r) => r.viewer_user_id));

    const result = people.map((p) => {
      const isAdmin = p.role === "admin";
      return {
        user_id: p.user_id,
        name: p.user_name || "(unnamed)",
        role: p.role,
        person_type: p.person_type,
        member_id: p.member_id,
        staff_id: p.staff_id,
        enabled: isAdmin ? true : allowedSet.has(p.user_id),
        locked: isAdmin,
        note: isAdmin ? "Admin can view by default" : null,
      };
    });

    return res.json(result);
  } catch (err) {
    console.error("getPhoneVisibility error:", err);
    return fail(res, 500, "server_error", "Failed to load phone visibility");
  }
};

const updatePhoneVisibility = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id: memberId } = req.params;
    const { viewer_user_ids } = req.body;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    if (!Array.isArray(viewer_user_ids)) {
      return fail(res, 400, "invalid_input", "viewer_user_ids must be an array");
    }

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const { rows: memberRows } = await client.query(
      `SELECT m.id, u.phone
         FROM members m
         JOIN users u ON u.id = m.user_id
        WHERE m.id = $1 AND m.account_id = $2 AND m.status = 'active'`,
      [memberId, accountId],
    );
    if (!memberRows.length) return fail(res, 404, "not_found", "Member not found");

    const targetPhone = (memberRows[0].phone || "").replace(/\D/g, "").slice(-10);
    const callerPhone = getUserPhone(req);
    const callerIsTarget = callerPhone && callerPhone === targetPhone;

    if (!callerIsTarget && role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "You cannot manage this member's phone visibility");
    }

    await client.query("BEGIN");
    await client.query(`DELETE FROM member_phone_visibility WHERE member_id = $1`, [
      memberId,
    ]);

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
        [accountId, memberId, viewer_user_ids],
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

const listStaff = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const month = normalizeMonth(req.query?.month);

    const { rows } = await pool.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (
                SELECT 1 FROM account_members am
                 WHERE am.account_id = s.account_id
                   AND am.user_id    = s.user_id
                   AND am.status     = 'active'
              ) AS has_access
         FROM staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.account_id = $1
        ORDER BY u.name`,
      [accountId],
    );

    const { rows: payRows } = await pool.query(
      `SELECT smp.staff_id, smp.month, smp.status, smp.paid_date,
              smp.additional_amount, smp.additional_note,
              smp.deduction_amount, smp.deduction_note, smp.net_amount
         FROM staff_monthly_payments smp
         JOIN staff s ON s.id = smp.staff_id
        WHERE s.account_id = $1
          AND smp.month = $2`,
      [accountId, month],
    );
    const paymentByStaff = new Map();
    for (const p of payRows) paymentByStaff.set(p.staff_id, p);

    const { rows: attRows } = await pool.query(
      `SELECT sa.staff_id, sa.month, sa.statuses, sa.paid_days,
              sa.calculated_salary
         FROM staff_attendance sa
         JOIN staff s ON s.id = sa.staff_id
        WHERE s.account_id = $1
          AND sa.month = $2`,
      [accountId, month],
    );
    const attendanceByStaff = new Map();
    for (const a of attRows) attendanceByStaff.set(a.staff_id, a);

    const result = rows.map((s) =>
      shapeStaffRow(
        s,
        paymentByStaff.get(s.id) ?? null,
        attendanceByStaff.get(s.id) ?? null,
      ),
    );

    return res.json(result);
  } catch (err) {
    console.error("listStaff error:", err);
    return fail(res, 500, "server_error", "Failed to load staff");
  }
};

const getStaff = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const { rows } = await pool.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (
                SELECT 1 FROM account_members am
                 WHERE am.account_id = s.account_id
                   AND am.user_id    = s.user_id
                   AND am.status     = 'active'
              ) AS has_access
         FROM staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1
          AND s.account_id = $2
          AND s.status = 'active'`,
      [id, accountId],
    );

    if (!rows.length) return fail(res, 404, "not_found", "Staff not found");
    return res.json(shapeStaffRow(rows[0], null, null));
  } catch (err) {
    console.error("getStaff error:", err);
    return fail(res, 500, "server_error", "Failed to load staff");
  }
};

// ===========================================================================
// createStaff
// ===========================================================================
const createStaff = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can add staff");
    }

    const body = req.body || {};
    const mode = body.mode === "existing" ? "existing" : "new";

    const { role: rawStaffRole, monthly_salary = 0 } = body;

    const staffRole = String(rawStaffRole || "").trim();
    if (!staffRole) {
      return fail(res, 400, "invalid_input", "Role is required");
    }
    if (staffRole.length > 60) {
      return fail(res, 400, "invalid_input", "Role is too long");
    }

    await client.query("BEGIN");

    let targetUserId = null;

    if (mode === "existing") {
      targetUserId = body.user_id || null;
      if (!targetUserId) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input", "user_id is required for mode=existing");
      }
      const { rows: u } = await client.query(
        `SELECT id FROM users WHERE id = $1 LIMIT 1`,
        [targetUserId],
      );
      if (!u.length) {
        await client.query("ROLLBACK");
        return fail(res, 404, "not_found", "Person not found");
      }
    } else {
      const name = (body.name || "").trim();
      const phone = normalizePhone(body.phone);
      const photo_url = body.photo_url ?? null;

      if (!name) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input", "Name is required");
      }
      if (!phone) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input", "A valid 10-digit phone is required");
      }

      targetUserId = await ensureUserForPhone(client, phone, name);

      if (photo_url !== null && photo_url !== undefined) {
        await client.query(
          `UPDATE users
              SET photo_url = COALESCE(photo_url, $1), updated_at = NOW()
            WHERE id = $2`,
          [photo_url, targetUserId],
        );
      }
    }

    const { rows } = await client.query(
      `INSERT INTO staff
         (account_id, user_id, role, monthly_salary, status, created_by)
       VALUES ($1,$2,$3,$4,'active',$5)
       RETURNING id`,
      [accountId, targetUserId, staffRole, monthly_salary, userId],
    );

    const staffId = rows[0].id;

    const { rows: joined } = await client.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (
                SELECT 1 FROM account_members am
                 WHERE am.account_id = s.account_id
                   AND am.user_id    = s.user_id
                   AND am.status     = 'active'
              ) AS has_access
         FROM staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [staffId],
    );

    await syncStaffAccessOnCreate(client, accountId, joined[0]);

    await client.query("COMMIT");

    return res.status(201).json(shapeStaffRow(joined[0], null, null));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createStaff error:", err);
    return fail(res, 500, "server_error", "Failed to create staff");
  } finally {
    client.release();
  }
};

// ===========================================================================
// updateStaff
//
// Same identity-lock rules as updateMember.
// ===========================================================================
const updateStaff = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const { rows } = await client.query(
      `SELECT id, user_id FROM staff
        WHERE id = $1 AND account_id = $2 AND status = 'active'`,
      [id, accountId],
    );
    if (!rows.length) return fail(res, 404, "not_found", "Staff not found");

    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can edit staff");
    }

    const targetUserId = rows[0].user_id;

    const identityLocked = await hasActiveAccountMemberRow(
      client,
      accountId,
      targetUserId,
    );

    const hasName = Object.prototype.hasOwnProperty.call(req.body, "name");
    const hasPhone = Object.prototype.hasOwnProperty.call(req.body, "phone");
    const hasPhoto = Object.prototype.hasOwnProperty.call(req.body, "photo_url");

    if (identityLocked && (hasName || hasPhone || hasPhoto)) {
      return fail(
        res,
        403,
        "user_identity_locked",
        "This person has joined the app. Their name, phone and photo can only be changed by them.",
      );
    }

    const newName = hasName
      ? String(req.body.name ?? "").trim() || null
      : null;
    const newPhone = hasPhone ? normalizePhone(req.body.phone) : null;
    const newPhoto = hasPhoto
      ? req.body.photo_url === null
        ? null
        : String(req.body.photo_url)
      : undefined;

    if (hasName && !newName) {
      return fail(res, 400, "invalid_input", "Name cannot be empty");
    }
    if (hasPhone && !newPhone) {
      return fail(res, 400, "invalid_input", "A valid 10-digit phone is required");
    }

    const allowedFields = ["role", "monthly_salary"];
    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = req.body[key];
      }
    }

    if (updates.role !== undefined) {
      const roleStr = String(updates.role || "").trim();
      if (!roleStr) {
        return fail(res, 400, "invalid_input", "Role cannot be empty");
      }
      if (roleStr.length > 60) {
        return fail(res, 400, "invalid_input", "Role is too long");
      }
      updates.role = roleStr;
    }

    const nothingToUpdate =
      Object.keys(updates).length === 0 &&
      !hasName &&
      !hasPhone &&
      !hasPhoto;

    if (nothingToUpdate) {
      return fail(res, 400, "invalid_input", "No permitted fields to update");
    }

    await client.query("BEGIN");

    if (!identityLocked && (hasName || hasPhone || hasPhoto)) {
      if (hasPhone) {
        const { rows: conflict } = await client.query(
          `SELECT id FROM users WHERE phone = $1 AND id <> $2 LIMIT 1`,
          [`91${newPhone}`, targetUserId],
        );
        let conflictRows = conflict;
        if (!conflictRows.length) {
          const { rows: alt } = await client.query(
            `SELECT id FROM users WHERE phone = $1 AND id <> $2 LIMIT 1`,
            [newPhone, targetUserId],
          );
          conflictRows = alt;
        }
        if (conflictRows.length) {
          await client.query("ROLLBACK");
          return fail(
            res,
            409,
            "phone_in_use",
            "This phone number already belongs to another user.",
          );
        }
      }

      const setParts = [];
      const values = [];
      if (hasName) {
        values.push(newName);
        setParts.push(`name = $${values.length}`);
      }
      if (hasPhone) {
        values.push(`91${newPhone}`);
        setParts.push(`phone = $${values.length}`);
      }
      if (hasPhoto) {
        values.push(newPhoto);
        setParts.push(`photo_url = $${values.length}`);
      }
      values.push(targetUserId);

      await client.query(
        `UPDATE users
            SET ${setParts.join(", ")}, updated_at = NOW()
          WHERE id = $${values.length}`,
        values,
      );
    }

    if (Object.keys(updates).length > 0) {
      const keys = Object.keys(updates);
      const values = keys.map((k) => updates[k]);
      const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

      await client.query(
        `UPDATE staff
            SET ${setClause}, updated_at = NOW()
          WHERE id = $${keys.length + 1}
            AND account_id = $${keys.length + 2}`,
        [...values, id, accountId],
      );
    } else if (!identityLocked && (hasName || hasPhone || hasPhoto)) {
      await client.query(
        `UPDATE staff SET updated_at = NOW()
          WHERE id = $1 AND account_id = $2`,
        [id, accountId],
      );
    }

    const { rows: joined } = await client.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (
                SELECT 1 FROM account_members am
                 WHERE am.account_id = s.account_id
                   AND am.user_id    = s.user_id
                   AND am.status     = 'active'
              ) AS has_access
         FROM staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [id],
    );

    await client.query("COMMIT");
    return res.json(shapeStaffRow(joined[0], null, null));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateStaff error:", err);
    return fail(res, 500, "server_error", "Failed to update staff");
  } finally {
    client.release();
  }
};

const deleteStaff = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can delete staff");
    }

    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE staff
          SET status = 'inactive', updated_at = NOW()
        WHERE id = $1 AND account_id = $2 AND status = 'active'
        RETURNING user_id`,
      [id, accountId],
    );

    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Staff not found");
    }

    const targetUserId = updated.rows[0]?.user_id;

    if (targetUserId) {
      const { rows: stillStaff } = await client.query(
        `SELECT 1 FROM staff WHERE account_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
        [accountId, targetUserId],
      );
      if (!stillStaff.length) {
        const { rows: stillMember } = await client.query(
          `SELECT 1 FROM members WHERE account_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
          [accountId, targetUserId],
        );
        if (!stillMember.length) {
          const { rows: isAdmin } = await client.query(
            `SELECT 1 FROM account_members
              WHERE account_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'
              LIMIT 1`,
            [accountId, targetUserId],
          );
          if (!isAdmin.length) {
            await deactivateAccessRole(client, accountId, targetUserId, "staff_visibility");
          }
        }
      }
    }

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deleteStaff error:", err);
    return fail(res, 500, "server_error", "Failed to delete staff");
  } finally {
    client.release();
  }
};

const getStaffAttendance = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id: staffId, month } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return fail(res, 400, "invalid_input", "Month must be in YYYY-MM format");
    }
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const { rows } = await pool.query(
      `SELECT staff_id, month, statuses, paid_days,
              calculated_salary, updated_at
         FROM staff_attendance
        WHERE staff_id = $1 AND account_id = $2 AND month = $3`,
      [staffId, accountId, month],
    );

    if (!rows.length) return res.json(null);
    return res.json(rows[0]);
  } catch (err) {
    console.error("getStaffAttendance error:", err);
    return fail(res, 500, "server_error", "Failed to load attendance");
  }
};

const upsertStaffAttendance = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id: staffId, month } = req.params;
    const { statuses, calculated_salary: calculatedSalaryOverride } =
      req.body || {};

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return fail(res, 400, "invalid_input", "Month must be in YYYY-MM format");
    }
    if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
      return fail(res, 400, "invalid_input", "statuses object is required");
    }

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can save attendance");
    }

    const validStatuses = new Set(["present", "absent", "holiday", "weekend"]);
    for (const [day, value] of Object.entries(statuses)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return fail(res, 400, "invalid_input", `Invalid date key: ${day}`);
      }
      if (!validStatuses.has(value)) {
        return fail(res, 400, "invalid_input", `Invalid status: ${value}`);
      }
    }

    const { rows: staffRows } = await client.query(
      `SELECT id, monthly_salary FROM staff
        WHERE id = $1 AND account_id = $2 AND status = 'active'`,
      [staffId, accountId],
    );
    if (!staffRows.length) return fail(res, 404, "not_found", "Staff not found");

    const baseSalary = Number(staffRows[0].monthly_salary) || 0;

    const [y, m] = month.split("-").map(Number);
    const totalDays = new Date(y, m, 0).getDate();

    let paidDays = 0;
    for (let day = 1; day <= totalDays; day++) {
      const key = `${month}-${String(day).padStart(2, "0")}`;
      const explicit = statuses[key];
      const status =
        explicit ??
        (new Date(y, m - 1, day).getDay() % 6 === 0 ? "weekend" : "present");
      if (status !== "absent") paidDays++;
    }

    const autoCalculated =
      totalDays > 0 ? Math.round((baseSalary / totalDays) * paidDays) : 0;

    let calculatedSalary = autoCalculated;
    if (
      calculatedSalaryOverride !== undefined &&
      calculatedSalaryOverride !== null
    ) {
      const n = Number(calculatedSalaryOverride);
      if (Number.isFinite(n) && n >= 0) calculatedSalary = Math.round(n);
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO staff_attendance
         (account_id, staff_id, month, statuses, paid_days, calculated_salary, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
       ON CONFLICT (staff_id, month) DO UPDATE SET
         statuses          = EXCLUDED.statuses,
         paid_days         = EXCLUDED.paid_days,
         calculated_salary = EXCLUDED.calculated_salary,
         updated_at        = NOW()
       RETURNING *`,
      [
        accountId,
        staffId,
        month,
        JSON.stringify(statuses),
        paidDays,
        calculatedSalary,
        userId,
      ],
    );

    await client.query("COMMIT");

    const attendanceRow = rows[0];

    const { rows: payRows } = await pool.query(
      `SELECT additional_amount, deduction_amount
         FROM staff_monthly_payments
        WHERE staff_id = $1 AND month = $2`,
      [staffId, month],
    );
    const paymentRow = payRows[0] ?? null;

    const dueAmount = computeStaffDue(
      { monthly_salary: baseSalary },
      attendanceRow,
      paymentRow,
    );

    return res.json({
      ...attendanceRow,
      due_amount: dueAmount,
      due_month: month,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("upsertStaffAttendance error:", err);
    return fail(res, 500, "server_error", "Failed to save attendance");
  } finally {
    client.release();
  }
};

const upsertMemberPayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id: memberId } = req.params;

    const rawMonth =
      req.params.month ?? req.body?.month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(rawMonth)) {
      return fail(res, 400, "invalid_input", "Month must be in YYYY-MM format");
    }
    const month = rawMonth;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can update payments");
    }

    const { rows: memberRows } = await client.query(
      `SELECT id, maintenance_amount FROM members
        WHERE id = $1 AND account_id = $2 AND status = 'active'`,
      [memberId, accountId],
    );
    if (!memberRows.length) return fail(res, 404, "not_found", "Member not found");

    const body = req.body || {};

    const toDateOrNull = (v) => {
      if (!v) return null;
      const s = String(v).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
      return s;
    };

    const status = body.status;
    if (status !== "paid" && status !== "due") {
      return fail(res, 400, "invalid_input", "Status must be 'paid' or 'due'");
    }

    const paidDate = toDateOrNull(body.paidDate);
    const baseAmount = Number(memberRows[0].maintenance_amount) || 0;

    const additionalAmount = toNullableAmount(body.additionalAmount);
    const additionalNote = toNullableNote(body.additionalNote);
    const deductionAmount = toNullableAmount(body.deductionAmount);
    const deductionNote = toNullableNote(body.deductionNote);

    const additionalNumber = additionalAmount ?? 0;
    const deductionNumber = deductionAmount ?? 0;
    const netAmount = Math.max(
      0,
      baseAmount + additionalNumber - deductionNumber,
    );

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO member_monthly_payments
         (member_id, month, status, paid_date,
          additional_amount, additional_note,
          deduction_amount, deduction_note, net_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (member_id, month) DO UPDATE SET
         status            = EXCLUDED.status,
         paid_date         = EXCLUDED.paid_date,
         additional_amount = EXCLUDED.additional_amount,
         additional_note   = EXCLUDED.additional_note,
         deduction_amount  = EXCLUDED.deduction_amount,
         deduction_note    = EXCLUDED.deduction_note,
         net_amount        = EXCLUDED.net_amount,
         updated_at        = NOW()
       RETURNING *`,
      [
        memberId,
        month,
        status,
        paidDate,
        additionalAmount,
        additionalNote,
        deductionAmount,
        deductionNote,
        netAmount,
      ],
    );

    await client.query("COMMIT");

    const paymentRow = rows[0];
    const dueAmount = computeMemberDue(memberRows[0], paymentRow);

    return res.json({
      ...paymentRow,
      due_amount: dueAmount,
      due_month: month,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("upsertMemberPayment error:", err);
    return fail(res, 500, "server_error", "Failed to save member payment");
  } finally {
    client.release();
  }
};

const upsertStaffPayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id: staffId } = req.params;

    const rawMonth =
      req.params.month ?? req.body?.month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(rawMonth)) {
      return fail(res, 400, "invalid_input", "Month must be in YYYY-MM format");
    }
    const month = rawMonth;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can update payments");
    }

    const { rows: staffRows } = await client.query(
      `SELECT id, monthly_salary FROM staff
        WHERE id = $1 AND account_id = $2 AND status = 'active'`,
      [staffId, accountId],
    );
    if (!staffRows.length) return fail(res, 404, "not_found", "Staff not found");

    const staffRow = staffRows[0];
    const body = req.body || {};

    const toDateOrNull = (v) => {
      if (!v) return null;
      const s = String(v).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
      return s;
    };

    const status = body.status;
    if (status !== "paid" && status !== "due") {
      return fail(res, 400, "invalid_input", "Status must be 'paid' or 'due'");
    }

    const paidDate = toDateOrNull(body.paidDate);

    const { rows: attendanceRows } = await client.query(
      `SELECT calculated_salary FROM staff_attendance
        WHERE staff_id = $1 AND account_id = $2 AND month = $3`,
      [staffId, accountId, month],
    );
    const attendanceRow = attendanceRows[0] ?? null;

    const monthlySalary = Number(staffRow.monthly_salary) || 0;
    const attendanceBase =
      attendanceRow?.calculated_salary != null
        ? Number(attendanceRow.calculated_salary)
        : null;

    const effectiveBase =
      attendanceBase != null ? attendanceBase : monthlySalary;

    const additionalAmount = toNullableAmount(body.additionalAmount);
    const additionalNote = toNullableNote(body.additionalNote);
    const deductionAmount = toNullableAmount(body.deductionAmount);
    const deductionNote = toNullableNote(body.deductionNote);

    const additionalNumber = additionalAmount ?? 0;
    const deductionNumber = deductionAmount ?? 0;

    const netAmount = Math.max(
      0,
      effectiveBase + additionalNumber - deductionNumber,
    );

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO staff_monthly_payments
         (staff_id, month, status, paid_date,
          additional_amount, additional_note,
          deduction_amount, deduction_note, net_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (staff_id, month) DO UPDATE SET
         status            = EXCLUDED.status,
         paid_date         = EXCLUDED.paid_date,
         additional_amount = EXCLUDED.additional_amount,
         additional_note   = EXCLUDED.additional_note,
         deduction_amount  = EXCLUDED.deduction_amount,
         deduction_note    = EXCLUDED.deduction_note,
         net_amount        = EXCLUDED.net_amount,
         updated_at        = NOW()
       RETURNING *`,
      [
        staffId,
        month,
        status,
        paidDate,
        additionalAmount,
        additionalNote,
        deductionAmount,
        deductionNote,
        netAmount,
      ],
    );

    await client.query("COMMIT");

    return res.json({
      ...rows[0],
      due_amount: netAmount,
      due_month: month,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("upsertStaffPayment error:", err);
    return fail(res, 500, "server_error", "Failed to save staff payment");
  } finally {
    client.release();
  }
};

const listExpenses = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const { rows } = await pool.query(
      `SELECT id, account_id, category, title, amount, transaction_type,
              status, reminder_enabled, expense_date,
              description, bill_attachments, created_by, created_at, updated_at
         FROM expenses
        WHERE account_id = $1
        ORDER BY expense_date DESC, created_at DESC`,
      [accountId],
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

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "no_account_access",
        "You no longer have access to this account",
      );

    const { rows } = await pool.query(
      `SELECT id, account_id, category, title, amount, transaction_type,
              status, reminder_enabled, expense_date,
              description, bill_attachments, created_by, created_at, updated_at
         FROM expenses
        WHERE id = $1 AND account_id = $2`,
      [id, accountId],
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

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
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
          reminder_enabled, expense_date, description, bill_attachments, created_by)
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
      ],
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

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
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
      [...values, id, accountId],
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

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can delete expenses");
    }

    const result = await pool.query(
      `DELETE FROM expenses WHERE id = $1 AND account_id = $2`,
      [id, accountId],
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

module.exports = {
  listAccountPeople,

  listMembers,
  getMember,
  createMember,
  updateMember,
  deleteMember,

  getPhoneVisibility,
  updatePhoneVisibility,

  listStaff,
  getStaff,
  createStaff,
  updateStaff,
  deleteStaff,

  getStaffAttendance,
  upsertStaffAttendance,

  upsertMemberPayment,
  upsertStaffPayment,

  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
};