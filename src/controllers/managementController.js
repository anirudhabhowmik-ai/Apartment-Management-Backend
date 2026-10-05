// src/controllers/managementController.js
const { pool } = require("../config/database");
const {
  isEligibleForAutoGrant,
  ensureUserForPhone,
  deactivateAccessRole,
} = require("../utils/accessSync");
const { writeAudit } = require("./auditController");
const {
  upsertExpenseReminder,
  cancelExpenseReminder,
} = require("../services/push");

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

const MAX_BILL_ATTACHMENTS = 2;

const normalizeBillAttachments = (raw) => {
  if (raw === null || raw === undefined) return [];
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const uri =
      typeof item.uri === "string" ? item.uri
        : typeof item.url === "string" ? item.url : "";
    if (!uri) continue;
    out.push({
      uri,
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim() : "Bill attachment",
      ...(typeof item.mimeType === "string" && item.mimeType.trim()
        ? { mimeType: item.mimeType.trim() } : {}),
    });
    if (out.length >= MAX_BILL_ATTACHMENTS) break;
  }
  return out;
};

function normalizeRole(raw) {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (!s) return "";
  return s.replace(/\s+/g, " ").replace(/[\u0000-\u001F]/g, "").toLowerCase();
}

// ─── NEW: vehicle helpers ─────────────────────────────────────────────────
const VALID_VEHICLE_TYPES = new Set(["car", "bike", "other"]);

function normalizeVehicleNumber(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeVehicleType(raw) {
  const s = String(raw ?? "").toLowerCase().trim();
  return VALID_VEHICLE_TYPES.has(s) ? s : "car";
}

/**
 * Validate + clean a client-provided vehicles array.
 * Returns { ok: true, value: [...] } or { ok: false, error: "..." }.
 *
 * Each entry becomes: { id?: uuid, number: "KA01AB1234", type: "car"|"bike"|"other" }
 */
function normalizeVehiclesInput(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "vehicles must be an array" };
  }
  if (raw.length === 0) return { ok: true, value: [] };

  const out = [];
  const seen = new Set();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const number = normalizeVehicleNumber(
      item.number ?? item.vehicle_number ?? "",
    );
    if (!number) {
      return { ok: false, error: "Every vehicle must have a number" };
    }
    if (number.length < 5 || number.length > 15) {
      return {
        ok: false,
        error: `"${number}" doesn't look like a valid vehicle plate`,
      };
    }
    if (seen.has(number)) {
      return { ok: false, error: `Duplicate vehicle number: ${number}` };
    }
    seen.add(number);

    const idRaw = item.id ?? null;
    const id =
      typeof idRaw === "string" && idRaw.trim().length > 0
        ? idRaw.trim()
        : null;

    out.push({
      id,
      number,
      type: normalizeVehicleType(item.type ?? item.vehicle_type),
    });
  }

  return { ok: true, value: out };
}

/**
 * Load active vehicles for a member, shaped the way the frontend expects.
 */
async function loadVehiclesForMember(client, memberId) {
  const { rows } = await client.query(
    `SELECT id, vehicle_number, vehicle_type, owner_name, flat_number, wing,
            owner_phone, registered_by_guard, status, created_at, updated_at
       FROM vehicles
      WHERE member_id = $1 AND status = 'active'
      ORDER BY created_at ASC`,
    [memberId],
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.vehicle_number,
    type: r.vehicle_type,
    owner_name: r.owner_name,
    flat_number: r.flat_number,
    wing: r.wing,
    owner_phone: r.owner_phone,
    registered_by_guard: !!r.registered_by_guard,
  }));
}

/**
 * Replace the vehicles list for a member.
 *
 * Rules:
 *   - vehicles[] with an `id` that already belongs to this member → UPDATE.
 *   - vehicles[] without an `id` → INSERT.
 *   - Any active vehicle for this member that is NOT in the incoming list →
 *     soft-delete (status='inactive').
 *
 * Caller must be inside a transaction.
 */
async function replaceMemberVehicles(
  client,
  accountId,
  memberId,
  vehicles,
  identity,
  actorUserId,
) {
  const { rows: existing } = await client.query(
    `SELECT id, vehicle_number FROM vehicles
      WHERE member_id = $1 AND status = 'active'`,
    [memberId],
  );
  const existingById = new Map(existing.map((r) => [r.id, r.vehicle_number]));
  const incomingIds = new Set(
    vehicles.map((v) => v.id).filter((x) => typeof x === "string" && x.length > 0),
  );

  // Soft-delete vehicles that disappeared
  const toDeactivate = existing
    .filter((r) => !incomingIds.has(r.id))
    .map((r) => r.id);
  if (toDeactivate.length > 0) {
    await client.query(
      `UPDATE vehicles SET status = 'inactive', updated_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [toDeactivate],
    );
  }

  for (const v of vehicles) {
    if (v.id && existingById.has(v.id)) {
      // UPDATE — keep the row but refresh number/type + denormalized identity
      await client.query(
        `UPDATE vehicles SET
           vehicle_number = $1,
           vehicle_type   = $2,
           owner_name     = $3,
           flat_number    = $4,
           wing           = $5,
           owner_phone    = $6,
           status         = 'active',
           updated_at     = NOW()
         WHERE id = $7 AND member_id = $8 AND account_id = $9`,
        [
          v.number,
          v.type,
          identity.name,
          identity.flatNumber,
          identity.wing,
          identity.phone,
          v.id,
          memberId,
          accountId,
        ],
      );
    } else {
      // INSERT — new vehicle, but watch for an account-wide number conflict
      // (someone else already registered this plate).
      const { rows: clash } = await client.query(
        `SELECT id, member_id FROM vehicles
          WHERE account_id = $1 AND vehicle_number = $2
            AND status = 'active' LIMIT 1`,
        [accountId, v.number],
      );
      if (clash.length > 0 && clash[0].member_id !== memberId) {
        const err = new Error(
          `Vehicle ${v.number} is already registered to another flat`,
        );
        err.code = "vehicle_conflict";
        throw err;
      }

      await client.query(
        `INSERT INTO vehicles
           (account_id, member_id, user_id, vehicle_number,
            owner_name, flat_number, wing, owner_phone, vehicle_type,
            registered_by_guard, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,'active',$10)
         ON CONFLICT (account_id, vehicle_number)
         DO UPDATE SET
           member_id      = EXCLUDED.member_id,
           user_id        = EXCLUDED.user_id,
           owner_name     = EXCLUDED.owner_name,
           flat_number    = EXCLUDED.flat_number,
           wing           = EXCLUDED.wing,
           owner_phone    = EXCLUDED.owner_phone,
           vehicle_type   = EXCLUDED.vehicle_type,
           status         = 'active',
           updated_at     = NOW()`,
        [
          accountId,
          memberId,
          identity.userId,
          v.number,
          identity.name,
          identity.flatNumber,
          identity.wing,
          identity.phone,
          v.type,
          actorUserId,
        ],
      );
    }
  }
}
// ─── END NEW helpers ──────────────────────────────────────────────────────

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
       WHERE account_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [accountId, userId],
  );
  return rows.length ? rows[0].role : null;
}

function normalizeMonth(raw) {
  if (typeof raw === "string" && /^\d{4}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 7);
}

async function hasActiveAccountMemberRow(client, accountId, userId) {
  if (!accountId || !userId) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
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
    // ─── NEW: vehicle list (populated by listMembers/getMember) ─────────
    vehicles: Array.isArray(row.vehicles) ? row.vehicles : [],
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_access: !!row.has_access,
    due_amount: payment ? computeMemberDue(row, payment) : computeMemberDue(row, null),
    due_month: payment?.month ?? null,
    monthly_payments: payment ? { [payment.month]: mapMemberPaymentRow(payment) } : {},
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
    monthly_payments: payment ? { [payment.month]: mapStaffPaymentRow(payment) } : {},
    attendance_for_month: attendance
      ? {
          statuses: attendance.statuses,
          paidDays: attendance.paid_days,
          calculatedSalary:
            attendance.calculated_salary != null
              ? Number(attendance.calculated_salary) : null,
        }
      : null,
  };
}

function computeMemberDue(memberRow, paymentRow) {
  const base = Number(memberRow?.maintenance_amount) || 0;
  const additional = paymentRow?.additional_amount != null ? Number(paymentRow.additional_amount) : 0;
  const deduction = paymentRow?.deduction_amount != null ? Number(paymentRow.deduction_amount) : 0;
  return Math.max(0, base + additional - deduction);
}

function computeStaffDue(staffRow, attendanceRow, paymentRow) {
  const monthly = Number(staffRow?.monthly_salary) || 0;
  const effectiveBase = attendanceRow?.calculated_salary != null
    ? Number(attendanceRow.calculated_salary) : monthly;
  const additional = paymentRow?.additional_amount != null ? Number(paymentRow.additional_amount) : 0;
  const deduction = paymentRow?.deduction_amount != null ? Number(paymentRow.deduction_amount) : 0;
  return Math.max(0, effectiveBase + additional - deduction);
}

function mapMemberPaymentRow(p) {
  return {
    status: p.status,
    paidDate: p.paid_date,
    additionalAmount: p.additional_amount != null ? Number(p.additional_amount) : null,
    additionalNote: p.additional_note,
    deductionAmount: p.deduction_amount != null ? Number(p.deduction_amount) : null,
    deductionNote: p.deduction_note,
    netAmount: p.net_amount != null ? Number(p.net_amount) : null,
  };
}

function mapStaffPaymentRow(p) {
  return {
    status: p.status,
    paidDate: p.paid_date,
    additionalAmount: p.additional_amount != null ? Number(p.additional_amount) : null,
    additionalNote: p.additional_note,
    deductionAmount: p.deduction_amount != null ? Number(p.deduction_amount) : null,
    deductionNote: p.deduction_note,
    netAmount: p.net_amount != null ? Number(p.net_amount) : null,
  };
}

async function syncMemberAccessOnCreate(client, accountId, memberRow) {
  if (!memberRow?.user_id) return;
  if (!(await isEligibleForAutoGrant(client, accountId, memberRow.user_id))) return;

  const { rows: existingAdmin } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id=$1 AND user_id=$2 AND role='admin' AND status='active' LIMIT 1`,
    [accountId, memberRow.user_id]);
  if (existingAdmin.length) return;

  const { rows: existingMember } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id=$1 AND user_id=$2 AND role='member_visibility' AND status='active' LIMIT 1`,
    [accountId, memberRow.user_id]);
  if (existingMember.length) return;

  await client.query(
    `INSERT INTO account_members (account_id, user_id, role, status)
     VALUES ($1, $2, 'member_visibility', 'active')
     ON CONFLICT (account_id, user_id, role)
     DO UPDATE SET status='active', updated_at=NOW()`,
    [accountId, memberRow.user_id]);
}

async function syncStaffAccessOnCreate(client, accountId, staffRow) {
  if (!staffRow?.user_id) return;
  if (!(await isEligibleForAutoGrant(client, accountId, staffRow.user_id))) return;

  const { rows: existingAdmin } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id=$1 AND user_id=$2 AND role='admin' AND status='active' LIMIT 1`,
    [accountId, staffRow.user_id]);
  if (existingAdmin.length) return;

  const { rows: existingStaff } = await client.query(
    `SELECT 1 FROM account_members
       WHERE account_id=$1 AND user_id=$2 AND role='staff_visibility' AND status='active' LIMIT 1`,
    [accountId, staffRow.user_id]);
  if (existingStaff.length) return;

  await client.query(
    `INSERT INTO account_members (account_id, user_id, role, status)
     VALUES ($1, $2, 'staff_visibility', 'active')
     ON CONFLICT (account_id, user_id, role)
     DO UPDATE SET status='active', updated_at=NOW()`,
    [accountId, staffRow.user_id]);
}

// ===========================================================================
// listAccountPeople
// ===========================================================================
const listAccountPeople = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const map = new Map();

    const { rows: ownerRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM accounts a JOIN users u ON u.id = a.created_by WHERE a.id = $1`,
      [accountId]);
    for (const r of ownerRows) {
      if (!r.user_id) continue;
      map.set(r.user_id, {
        user_id: r.user_id, name: r.name ?? "", phone: r.phone ?? null,
        photo_url: r.photo_url ?? null, kind: "owner",
      });
    }

    const { rows: adminRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM account_members am JOIN users u ON u.id = am.user_id
        WHERE am.account_id=$1 AND am.role='admin' AND am.status='active'`,
      [accountId]);
    for (const r of adminRows) {
      if (!r.user_id || map.has(r.user_id)) continue;
      map.set(r.user_id, {
        user_id: r.user_id, name: r.name ?? "", phone: r.phone ?? null,
        photo_url: r.photo_url ?? null, kind: "admin",
      });
    }

    const { rows: memberRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id=$1 AND m.status='active'`,
      [accountId]);
    for (const r of memberRows) {
      if (!r.user_id || map.has(r.user_id)) continue;
      map.set(r.user_id, {
        user_id: r.user_id, name: r.name ?? "", phone: r.phone ?? null,
        photo_url: r.photo_url ?? null, kind: "member",
      });
    }

    const { rows: staffRows } = await pool.query(
      `SELECT u.id AS user_id, u.name, u.phone, u.photo_url
         FROM staff s JOIN users u ON u.id = s.user_id
        WHERE s.account_id=$1 AND s.status='active'`,
      [accountId]);
    for (const r of staffRows) {
      if (!r.user_id || map.has(r.user_id)) continue;
      map.set(r.user_id, {
        user_id: r.user_id, name: r.name ?? "", phone: r.phone ?? null,
        photo_url: r.photo_url ?? null, kind: "staff",
      });
    }

    const result = Array.from(map.values())
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

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

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const month = normalizeMonth(req.query?.month);

    const { rows } = await pool.query(
      `SELECT m.id, m.account_id, m.user_id, m.role,
              m.wing, m.flat_number, m.area_sqft, m.parking_available,
              m.maintenance_amount, m.status, m.created_by,
              m.created_at, m.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (SELECT 1 FROM account_members am
                       WHERE am.account_id = m.account_id
                         AND am.user_id = m.user_id
                         AND am.status = 'active') AS has_access
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id=$1 AND m.status='active'
        ORDER BY m.flat_number, u.name`,
      [accountId]);

    // ─── NEW: batch-load vehicles for all members in one query ──────────
    const memberIds = rows.map((r) => r.id);
    const vehiclesByMember = new Map();
    if (memberIds.length > 0) {
      const { rows: vehicleRows } = await pool.query(
        `SELECT id, member_id, vehicle_number, vehicle_type,
                owner_name, flat_number, wing, owner_phone, registered_by_guard
           FROM vehicles
          WHERE account_id = $1
            AND member_id = ANY($2::uuid[])
            AND status = 'active'
          ORDER BY created_at ASC`,
        [accountId, memberIds],
      );
      for (const v of vehicleRows) {
        if (!vehiclesByMember.has(v.member_id)) {
          vehiclesByMember.set(v.member_id, []);
        }
        vehiclesByMember.get(v.member_id).push({
          id: v.id,
          number: v.vehicle_number,
          type: v.vehicle_type,
          owner_name: v.owner_name,
          flat_number: v.flat_number,
          wing: v.wing,
          owner_phone: v.owner_phone,
          registered_by_guard: !!v.registered_by_guard,
        });
      }
    }

    const { rows: payRows } = await pool.query(
      `SELECT mmp.member_id, mmp.month, mmp.status, mmp.paid_date,
              mmp.additional_amount, mmp.additional_note,
              mmp.deduction_amount, mmp.deduction_note, mmp.net_amount
         FROM member_monthly_payments mmp
         JOIN members m ON m.id = mmp.member_id
        WHERE m.account_id=$1 AND mmp.month=$2`,
      [accountId, month]);

    const paymentByMember = new Map();
    for (const p of payRows) paymentByMember.set(p.member_id, p);

    const result = rows.map((m) =>
      shapeMemberRow(
        { ...m, vehicles: vehiclesByMember.get(m.id) ?? [] },
        paymentByMember.get(m.id) ?? null,
      ),
    );

    if (role === "owner" || role === "admin") return res.json(result);

    const { rows: privilegedRows } = await pool.query(
      `SELECT a.created_by AS user_id
         FROM accounts a
        WHERE a.id = $1
        UNION
       SELECT am.user_id
         FROM account_members am
        WHERE am.account_id = $1
          AND am.role = 'admin'
          AND am.status = 'active'`,
      [accountId],
    );
    const privilegedUserIds = new Set(
      privilegedRows.map((r) => r.user_id).filter(Boolean),
    );

    const callerPhone = getUserPhone(req);
    const { rows: allowed } = await pool.query(
      `SELECT member_id FROM member_phone_visibility
        WHERE account_id=$1 AND viewer_user_id=$2`,
      [accountId, userId]);
    const allowedMemberIds = new Set(allowed.map((r) => r.member_id));

    const masked = result.map((m) => {
      const memberPhone = (m.phone || "").replace(/\D/g, "").slice(-10);
      const isSelf = callerPhone && callerPhone === memberPhone;
      const isPrivileged = m.user_id && privilegedUserIds.has(m.user_id);
      const canSee = isSelf || isPrivileged || allowedMemberIds.has(m.id);
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

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows } = await pool.query(
      `SELECT m.id, m.account_id, m.user_id, m.role,
              m.wing, m.flat_number, m.area_sqft, m.parking_available,
              m.maintenance_amount, m.status, m.created_by,
              m.created_at, m.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (SELECT 1 FROM account_members am
                       WHERE am.account_id = m.account_id
                         AND am.user_id = m.user_id
                         AND am.status = 'active') AS has_access
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.id=$1 AND m.account_id=$2 AND m.status='active'`,
      [id, accountId]);

    if (!rows.length) return fail(res, 404, "not_found", "Member not found");

    // ─── NEW: load vehicles for this member ─────────────────────────────
    const vehicles = await loadVehiclesForMember({ query: pool.query.bind(pool) }, id);
    const member = shapeMemberRow({ ...rows[0], vehicles }, null);

    if (role === "owner" || role === "admin") return res.json(member);

    const callerPhone = getUserPhone(req);
    const memberPhone = (member.phone || "").replace(/\D/g, "").slice(-10);
    const isSelf = callerPhone && callerPhone === memberPhone;
    if (isSelf) return res.json(member);

    const { rows: allowed } = await pool.query(
      `SELECT 1 FROM member_phone_visibility
        WHERE member_id=$1 AND viewer_user_id=$2 LIMIT 1`,
      [member.id, userId]);
    if (allowed.length) return res.json(member);

    return res.json({ ...member, phone: null });
  } catch (err) {
    console.error("getMember error:", err);
    return fail(res, 500, "server_error", "Failed to load member");
  }
};

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

    if (!flat_number) return fail(res, 400, "invalid_input", "Flat number is required");

    const memberRole = normalizeRole(rawMemberRole);
    if (!memberRole) return fail(res, 400, "invalid_input", "Member role is required");
    if (memberRole.length > 60) return fail(res, 400, "invalid_input", "Member role is too long");

    // ─── NEW: validate vehicles up-front so we don't open a transaction ─
    const vehiclesCheck = normalizeVehiclesInput(body.vehicles);
    if (!vehiclesCheck.ok) {
      return fail(res, 400, "invalid_input", vehiclesCheck.error);
    }
    const incomingVehicles = vehiclesCheck.value;

    if (parking_available && incomingVehicles.length === 0) {
      return fail(res, 400, "invalid_input",
        "Add at least one vehicle number since parking is available");
    }

    await client.query("BEGIN");

    let targetUserId = null;
    let targetName = "";
    let targetPhone = "";

    if (mode === "existing") {
      targetUserId = body.user_id || null;
      if (!targetUserId) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input", "user_id is required for mode=existing");
      }
      const { rows: u } = await client.query(
        `SELECT id, name, phone FROM users WHERE id=$1 LIMIT 1`, [targetUserId]);
      if (!u.length) {
        await client.query("ROLLBACK");
        return fail(res, 404, "not_found", "Person not found");
      }
      targetName = u[0].name ?? "";
      targetPhone = (u[0].phone ?? "").replace(/\D/g, "").slice(-10);
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
      targetName = name;
      targetPhone = phone;

      if (photo_url !== null && photo_url !== undefined) {
        await client.query(
          `UPDATE users SET photo_url = COALESCE(photo_url, $1), updated_at = NOW()
            WHERE id = $2`,
          [photo_url, targetUserId]);
      }
    }

    const { rows } = await client.query(
      `INSERT INTO members
         (account_id, user_id, role, wing, flat_number,
          area_sqft, parking_available, maintenance_amount,
          status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)
       RETURNING id`,
      [accountId, targetUserId, memberRole, wing, flat_number,
       area_sqft, parking_available, maintenance_amount, userId]);

    const memberId = rows[0].id;

    // ─── NEW: persist vehicles if parking_available ─────────────────────
    if (parking_available && incomingVehicles.length > 0) {
      try {
        await replaceMemberVehicles(
          client,
          accountId,
          memberId,
          incomingVehicles,
          {
            name: targetName,
            flatNumber: flat_number,
            wing,
            phone: targetPhone,
            userId: targetUserId,
          },
          userId,
        );
      } catch (vehErr) {
        await client.query("ROLLBACK");
        if (vehErr?.code === "vehicle_conflict") {
          return fail(res, 409, "vehicle_conflict", vehErr.message);
        }
        throw vehErr;
      }
    }

    const { rows: joined } = await client.query(
      `SELECT m.id, m.account_id, m.user_id, m.role,
              m.wing, m.flat_number, m.area_sqft, m.parking_available,
              m.maintenance_amount, m.status, m.created_by,
              m.created_at, m.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (SELECT 1 FROM account_members am
                       WHERE am.account_id = m.account_id
                         AND am.user_id = m.user_id
                         AND am.status = 'active') AS has_access
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.id = $1`,
      [memberId]);

    await syncMemberAccessOnCreate(client, accountId, joined[0]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId: joined[0].user_id,
      entityType: "member",
      entityId: memberId,
      action: "create",
      after: joined[0],
      metadata: {
        role: memberRole,
        flat_number,
        vehicles: incomingVehicles.map((v) => v.number),
      },
      visibility: "admin",
    });

    await client.query("COMMIT");

    // Return the final shape (with vehicles) using the same connection pool
    const vehicles = await loadVehiclesForMember(
      { query: pool.query.bind(pool) },
      memberId,
    );
    return res.status(201).json(
      shapeMemberRow({ ...joined[0], vehicles }, null),
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createMember error:", err);
    return fail(res, 500, "server_error", "Failed to create member");
  } finally {
    client.release();
  }
};

const updateMember = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows } = await client.query(
      `SELECT id, user_id FROM members
        WHERE id=$1 AND account_id=$2 AND status='active'`,
      [id, accountId]);
    if (!rows.length) return fail(res, 404, "not_found", "Member not found");

    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can edit members");
    }

    const targetUserId = rows[0].user_id;
    const identityLocked = await hasActiveAccountMemberRow(client, accountId, targetUserId);

    const hasName = Object.prototype.hasOwnProperty.call(req.body, "name");
    const hasPhone = Object.prototype.hasOwnProperty.call(req.body, "phone");
    const hasPhoto = Object.prototype.hasOwnProperty.call(req.body, "photo_url");

    if (identityLocked && (hasName || hasPhone || hasPhoto)) {
      return fail(res, 403, "user_identity_locked",
        "This person has joined the app. Their name, phone and photo can only be changed by them.");
    }

    const newName = hasName ? String(req.body.name ?? "").trim() || null : null;
    const newPhone = hasPhone ? normalizePhone(req.body.phone) : null;
    const newPhoto = hasPhoto
      ? req.body.photo_url === null ? null : String(req.body.photo_url)
      : undefined;

    if (hasName && !newName) return fail(res, 400, "invalid_input", "Name cannot be empty");
    if (hasPhone && !newPhone) return fail(res, 400, "invalid_input", "A valid 10-digit phone is required");

    const allowedFields = ["role", "wing", "flat_number", "area_sqft", "parking_available", "maintenance_amount"];
    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
    }

    if (updates.role !== undefined) {
      const roleStr = normalizeRole(updates.role);
      if (!roleStr) return fail(res, 400, "invalid_input", "Role cannot be empty");
      if (roleStr.length > 60) return fail(res, 400, "invalid_input", "Role is too long");
      updates.role = roleStr;
    }

    // ─── NEW: parse incoming vehicles once ──────────────────────────────
    const hasVehiclesField = Object.prototype.hasOwnProperty.call(req.body, "vehicles");
    let incomingVehicles = [];
    if (hasVehiclesField) {
      const check = normalizeVehiclesInput(req.body.vehicles);
      if (!check.ok) {
        return fail(res, 400, "invalid_input", check.error);
      }
      incomingVehicles = check.value;
    }

    const nothingToUpdate =
      Object.keys(updates).length === 0 && !hasName && !hasPhone && !hasPhoto && !hasVehiclesField;
    if (nothingToUpdate) return fail(res, 400, "invalid_input", "No permitted fields to update");

    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query(
      `SELECT m.id, m.account_id, m.user_id, m.role,
              m.wing, m.flat_number, m.area_sqft, m.parking_available,
              m.maintenance_amount, m.status,
              u.name, u.phone, u.photo_url
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.id = $1`,
      [id]);
    const beforeSnapshot = beforeRows[0] ?? null;

    if (!identityLocked && (hasName || hasPhone || hasPhoto)) {
      if (hasPhone) {
        const { rows: conflict } = await client.query(
          `SELECT id FROM users WHERE phone=$1 AND id <> $2 LIMIT 1`,
          [`91${newPhone}`, targetUserId]);
        let conflictRows = conflict;
        if (!conflictRows.length) {
          const { rows: alt } = await client.query(
            `SELECT id FROM users WHERE phone=$1 AND id <> $2 LIMIT 1`,
            [newPhone, targetUserId]);
          conflictRows = alt;
        }
        if (conflictRows.length) {
          await client.query("ROLLBACK");
          return fail(res, 409, "phone_in_use", "This phone number already belongs to another user.");
        }
      }

      const setParts = [];
      const values = [];
      if (hasName) { values.push(newName); setParts.push(`name = $${values.length}`); }
      if (hasPhone) { values.push(`91${newPhone}`); setParts.push(`phone = $${values.length}`); }
      if (hasPhoto) { values.push(newPhoto); setParts.push(`photo_url = $${values.length}`); }
      values.push(targetUserId);

      await client.query(
        `UPDATE users SET ${setParts.join(", ")}, updated_at = NOW()
          WHERE id = $${values.length}`,
        values);
    }

    if (Object.keys(updates).length > 0) {
      const keys = Object.keys(updates);
      const values = keys.map((k) => updates[k]);
      const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
      await client.query(
        `UPDATE members SET ${setClause}, updated_at = NOW()
          WHERE id = $${keys.length + 1} AND account_id = $${keys.length + 2}`,
        [...values, id, accountId]);
    } else if (!identityLocked && (hasName || hasPhone || hasPhoto)) {
      await client.query(
        `UPDATE members SET updated_at = NOW() WHERE id = $1 AND account_id = $2`,
        [id, accountId]);
    }

    // ─── NEW: sync vehicles if the client sent a vehicles[] array ──────
    if (hasVehiclesField) {
      // Determine the effective parking state
      const effectiveParking =
        updates.parking_available !== undefined
          ? !!updates.parking_available
          : !!beforeSnapshot?.parking_available;

      if (!effectiveParking && incomingVehicles.length > 0) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input",
          "Cannot register vehicles when parking is not available");
      }
      if (effectiveParking && incomingVehicles.length === 0) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input",
          "Add at least one vehicle number since parking is available");
      }

      // Identity for denormalized fields (fall back to current row)
      const identity = {
        name: newName ?? beforeSnapshot?.name ?? "",
        flatNumber:
          updates.flat_number !== undefined
            ? String(updates.flat_number ?? "")
            : (beforeSnapshot?.flat_number ?? ""),
        wing:
          updates.wing !== undefined
            ? (updates.wing ?? null)
            : (beforeSnapshot?.wing ?? null),
        phone: newPhone ?? ((beforeSnapshot?.phone ?? "").replace(/\D/g, "").slice(-10)),
        userId: targetUserId,
      };

      try {
        await replaceMemberVehicles(
          client,
          accountId,
          id,
          incomingVehicles,
          identity,
          userId,
        );
      } catch (vehErr) {
        await client.query("ROLLBACK");
        if (vehErr?.code === "vehicle_conflict") {
          return fail(res, 409, "vehicle_conflict", vehErr.message);
        }
        throw vehErr;
      }
    }

    const { rows: joined } = await client.query(
      `SELECT m.id, m.account_id, m.user_id, m.role,
              m.wing, m.flat_number, m.area_sqft, m.parking_available,
              m.maintenance_amount, m.status, m.created_by,
              m.created_at, m.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (SELECT 1 FROM account_members am
                       WHERE am.account_id = m.account_id
                         AND am.user_id = m.user_id
                         AND am.status = 'active') AS has_access
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.id = $1`,
      [id]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId,
      entityType: "member",
      entityId: id,
      action: "update",
      before: beforeSnapshot,
      after: joined[0],
      metadata: {
        fields: Object.keys(updates),
        identityFields: [
          hasName && "name",
          hasPhone && "phone",
          hasPhoto && "photo_url",
        ].filter(Boolean),
        vehiclesChanged: hasVehiclesField,
      },
      visibility: "participants",
    });

    await client.query("COMMIT");

    const vehicles = await loadVehiclesForMember(
      { query: pool.query.bind(pool) },
      id,
    );
    return res.json(shapeMemberRow({ ...joined[0], vehicles }, null));
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

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can delete members");
    }

    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE members SET status='inactive', updated_at=NOW()
        WHERE id=$1 AND account_id=$2 AND status='active'
        RETURNING user_id, name`,
      [id, accountId]);

    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Member not found");
    }

    // ─── NEW: soft-delete the member's vehicles too ────────────────────
    await client.query(
      `UPDATE vehicles SET status='inactive', updated_at=NOW()
        WHERE account_id=$1 AND member_id=$2 AND status='active'`,
      [accountId, id],
    );

    const targetUserId = updated.rows[0]?.user_id;

    if (targetUserId) {
      const { rows: stillMember } = await client.query(
        `SELECT 1 FROM members WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
        [accountId, targetUserId]);
      if (!stillMember.length) {
        const { rows: stillStaff } = await client.query(
          `SELECT 1 FROM staff WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
          [accountId, targetUserId]);
        if (!stillStaff.length) {
          const { rows: isAdmin } = await client.query(
            `SELECT 1 FROM account_members
              WHERE account_id=$1 AND user_id=$2 AND role='admin' AND status='active' LIMIT 1`,
            [accountId, targetUserId]);
          if (!isAdmin.length) {
            await deactivateAccessRole(client, accountId, targetUserId, "member_visibility");
          }
        }
      }
    }

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId,
      entityType: "member",
      entityId: id,
      action: "delete",
      after: { status: "inactive", name: updated.rows[0].name },
      metadata: { softDelete: true },
      visibility: "participants",
    });

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

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows: memberRows } = await pool.query(
      `SELECT m.id, u.phone, u.id AS user_id
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.id=$1 AND m.account_id=$2 AND m.status='active'`,
      [memberId, accountId]);
    if (!memberRows.length) return fail(res, 404, "not_found", "Member not found");

    const targetMember = memberRows[0];
    const targetPhone = (targetMember.phone || "").replace(/\D/g, "").slice(-10);
    const callerPhone = getUserPhone(req);
    const callerIsTarget = callerPhone && callerPhone === targetPhone;

    if (!callerIsTarget && role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "You cannot manage this member's phone visibility");
    }

    const { rows: people } = await pool.query(
      `SELECT u.id AS user_id, u.phone AS user_phone, u.name AS user_name,
              u.photo_url AS user_photo_url, am.role AS role,
              CASE WHEN m.id IS NOT NULL THEN 'member'
                   WHEN s.id IS NOT NULL THEN 'staff'
                   ELSE 'unknown' END AS person_type,
              m.id AS member_id, s.id AS staff_id
         FROM account_members am
         JOIN users u ON u.id = am.user_id
         LEFT JOIN members m ON m.user_id = u.id AND m.account_id = am.account_id AND m.status='active'
         LEFT JOIN staff s ON s.user_id = u.id AND s.account_id = am.account_id AND s.status='active'
        WHERE am.account_id=$1 AND am.status='active' AND u.id <> $2
        ORDER BY CASE am.role
                   WHEN 'admin' THEN 1
                   WHEN 'member_visibility' THEN 2
                   WHEN 'staff_visibility' THEN 3
                   ELSE 4 END,
                 COALESCE(u.name, '')`,
      [accountId, targetMember.user_id]);

    const { rows: existing } = await pool.query(
      `SELECT viewer_user_id FROM member_phone_visibility WHERE member_id=$1`,
      [memberId]);
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

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    if (!Array.isArray(viewer_user_ids)) {
      return fail(res, 400, "invalid_input", "viewer_user_ids must be an array");
    }

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows: memberRows } = await client.query(
      `SELECT m.id, u.phone FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.id=$1 AND m.account_id=$2 AND m.status='active'`,
      [memberId, accountId]);
    if (!memberRows.length) return fail(res, 404, "not_found", "Member not found");

    const targetPhone = (memberRows[0].phone || "").replace(/\D/g, "").slice(-10);
    const callerPhone = getUserPhone(req);
    const callerIsTarget = callerPhone && callerPhone === targetPhone;

    if (!callerIsTarget && role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "You cannot manage this member's phone visibility");
    }

    await client.query("BEGIN");
    await client.query(`DELETE FROM member_phone_visibility WHERE member_id = $1`, [memberId]);

    if (viewer_user_ids.length > 0) {
      await client.query(
        `INSERT INTO member_phone_visibility (account_id, member_id, viewer_user_id)
         SELECT $1, $2, u.id FROM users u
           JOIN account_members am ON am.user_id = u.id AND am.account_id = $1 AND am.status='active'
          WHERE u.id = ANY($3::uuid[])`,
        [accountId, memberId, viewer_user_ids]);
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
const listStaff = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const month = normalizeMonth(req.query?.month);

    const { rows } = await pool.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (SELECT 1 FROM account_members am
                       WHERE am.account_id = s.account_id
                         AND am.user_id = s.user_id
                         AND am.status = 'active') AS has_access
         FROM staff s JOIN users u ON u.id = s.user_id
        WHERE s.account_id=$1 AND s.status='active'
        ORDER BY u.name`,
      [accountId]);

    const { rows: payRows } = await pool.query(
      `SELECT smp.staff_id, smp.month, smp.status, smp.paid_date,
              smp.additional_amount, smp.additional_note,
              smp.deduction_amount, smp.deduction_note, smp.net_amount
         FROM staff_monthly_payments smp
         JOIN staff s ON s.id = smp.staff_id
        WHERE s.account_id=$1 AND smp.month=$2`,
      [accountId, month]);
    const paymentByStaff = new Map();
    for (const p of payRows) paymentByStaff.set(p.staff_id, p);

    const { rows: attRows } = await pool.query(
      `SELECT sa.staff_id, sa.month, sa.statuses, sa.paid_days, sa.calculated_salary
         FROM staff_attendance sa JOIN staff s ON s.id = sa.staff_id
        WHERE s.account_id=$1 AND sa.month=$2`,
      [accountId, month]);
    const attendanceByStaff = new Map();
    for (const a of attRows) attendanceByStaff.set(a.staff_id, a);

    const result = rows.map((s) =>
      shapeStaffRow(s, paymentByStaff.get(s.id) ?? null, attendanceByStaff.get(s.id) ?? null));

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

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows } = await pool.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (SELECT 1 FROM account_members am
                       WHERE am.account_id = s.account_id
                         AND am.user_id = s.user_id
                         AND am.status = 'active') AS has_access
         FROM staff s JOIN users u ON u.id = s.user_id
        WHERE s.id=$1 AND s.account_id=$2 AND s.status='active'`,
      [id, accountId]);

    if (!rows.length) return fail(res, 404, "not_found", "Staff not found");
    return res.json(shapeStaffRow(rows[0], null, null));
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

    const body = req.body || {};
    const mode = body.mode === "existing" ? "existing" : "new";

    const { role: rawStaffRole, monthly_salary = 0 } = body;

    const staffRole = normalizeRole(rawStaffRole);
    if (!staffRole) return fail(res, 400, "invalid_input", "Role is required");
    if (staffRole.length > 60) return fail(res, 400, "invalid_input", "Role is too long");

    await client.query("BEGIN");

    let targetUserId = null;

    if (mode === "existing") {
      targetUserId = body.user_id || null;
      if (!targetUserId) {
        await client.query("ROLLBACK");
        return fail(res, 400, "invalid_input", "user_id is required for mode=existing");
      }
      const { rows: u } = await client.query(
        `SELECT id FROM users WHERE id=$1 LIMIT 1`, [targetUserId]);
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
          `UPDATE users SET photo_url = COALESCE(photo_url, $1), updated_at = NOW()
            WHERE id = $2`,
          [photo_url, targetUserId]);
      }
    }

    const { rows } = await client.query(
      `INSERT INTO staff
         (account_id, user_id, role, monthly_salary, status, created_by)
       VALUES ($1,$2,$3,$4,'active',$5)
       RETURNING id`,
      [accountId, targetUserId, staffRole, monthly_salary, userId]);

    const staffId = rows[0].id;

    const { rows: joined } = await client.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (SELECT 1 FROM account_members am
                       WHERE am.account_id = s.account_id
                         AND am.user_id = s.user_id
                         AND am.status = 'active') AS has_access
         FROM staff s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [staffId]);

    await syncStaffAccessOnCreate(client, accountId, joined[0]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId: joined[0].user_id,
      entityType: "staff",
      entityId: staffId,
      action: "create",
      after: joined[0],
      metadata: { role: staffRole, monthly_salary },
      visibility: "admin",
    });

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

const updateStaff = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows } = await client.query(
      `SELECT id, user_id FROM staff
        WHERE id=$1 AND account_id=$2 AND status='active'`,
      [id, accountId]);
    if (!rows.length) return fail(res, 404, "not_found", "Staff not found");

    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can edit staff");
    }

    const targetUserId = rows[0].user_id;
    const identityLocked = await hasActiveAccountMemberRow(client, accountId, targetUserId);

    const hasName = Object.prototype.hasOwnProperty.call(req.body, "name");
    const hasPhone = Object.prototype.hasOwnProperty.call(req.body, "phone");
    const hasPhoto = Object.prototype.hasOwnProperty.call(req.body, "photo_url");

    if (identityLocked && (hasName || hasPhone || hasPhoto)) {
      return fail(res, 403, "user_identity_locked",
        "This person has joined the app. Their name, phone and photo can only be changed by them.");
    }

    const newName = hasName ? String(req.body.name ?? "").trim() || null : null;
    const newPhone = hasPhone ? normalizePhone(req.body.phone) : null;
    const newPhoto = hasPhoto
      ? req.body.photo_url === null ? null : String(req.body.photo_url)
      : undefined;

    if (hasName && !newName) return fail(res, 400, "invalid_input", "Name cannot be empty");
    if (hasPhone && !newPhone) return fail(res, 400, "invalid_input", "A valid 10-digit phone is required");

    const allowedFields = ["role", "monthly_salary"];
    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
    }

    if (updates.role !== undefined) {
      const roleStr = normalizeRole(updates.role);
      if (!roleStr) return fail(res, 400, "invalid_input", "Role cannot be empty");
      if (roleStr.length > 60) return fail(res, 400, "invalid_input", "Role is too long");
      updates.role = roleStr;
    }

    const nothingToUpdate =
      Object.keys(updates).length === 0 && !hasName && !hasPhone && !hasPhoto;
    if (nothingToUpdate) return fail(res, 400, "invalid_input", "No permitted fields to update");

    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query(
      `SELECT s.id, s.account_id, s.user_id, s.role, s.monthly_salary, s.status,
              u.name, u.phone, u.photo_url
         FROM staff s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [id]);
    const beforeSnapshot = beforeRows[0] ?? null;

    if (!identityLocked && (hasName || hasPhone || hasPhoto)) {
      if (hasPhone) {
        const { rows: conflict } = await client.query(
          `SELECT id FROM users WHERE phone=$1 AND id <> $2 LIMIT 1`,
          [`91${newPhone}`, targetUserId]);
        let conflictRows = conflict;
        if (!conflictRows.length) {
          const { rows: alt } = await client.query(
            `SELECT id FROM users WHERE phone=$1 AND id <> $2 LIMIT 1`,
            [newPhone, targetUserId]);
          conflictRows = alt;
        }
        if (conflictRows.length) {
          await client.query("ROLLBACK");
          return fail(res, 409, "phone_in_use", "This phone number already belongs to another user.");
        }
      }

      const setParts = [];
      const values = [];
      if (hasName) { values.push(newName); setParts.push(`name = $${values.length}`); }
      if (hasPhone) { values.push(`91${newPhone}`); setParts.push(`phone = $${values.length}`); }
      if (hasPhoto) { values.push(newPhoto); setParts.push(`photo_url = $${values.length}`); }
      values.push(targetUserId);

      await client.query(
        `UPDATE users SET ${setParts.join(", ")}, updated_at = NOW()
          WHERE id = $${values.length}`,
        values);
    }

    if (Object.keys(updates).length > 0) {
      const keys = Object.keys(updates);
      const values = keys.map((k) => updates[k]);
      const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
      await client.query(
        `UPDATE staff SET ${setClause}, updated_at = NOW()
          WHERE id = $${keys.length + 1} AND account_id = $${keys.length + 2}`,
        [...values, id, accountId]);
    } else if (!identityLocked && (hasName || hasPhone || hasPhoto)) {
      await client.query(
        `UPDATE staff SET updated_at = NOW() WHERE id = $1 AND account_id = $2`,
        [id, accountId]);
    }

    const { rows: joined } = await client.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              u.name, u.phone, u.photo_url,
              EXISTS (SELECT 1 FROM account_members am
                       WHERE am.account_id = s.account_id
                         AND am.user_id = s.user_id
                         AND am.status = 'active') AS has_access
         FROM staff s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [id]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId,
      entityType: "staff",
      entityId: id,
      action: "update",
      before: beforeSnapshot,
      after: joined[0],
      metadata: { fields: Object.keys(updates) },
      visibility: "participants",
    });

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

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can delete staff");
    }

    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE staff SET status='inactive', updated_at=NOW()
        WHERE id=$1 AND account_id=$2 AND status='active'
        RETURNING user_id, name`,
      [id, accountId]);

    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Staff not found");
    }

    const targetUserId = updated.rows[0]?.user_id;

    if (targetUserId) {
      const { rows: stillStaff } = await client.query(
        `SELECT 1 FROM staff WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
        [accountId, targetUserId]);
      if (!stillStaff.length) {
        const { rows: stillMember } = await client.query(
          `SELECT 1 FROM members WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
          [accountId, targetUserId]);
        if (!stillMember.length) {
          const { rows: isAdmin } = await client.query(
            `SELECT 1 FROM account_members
              WHERE account_id=$1 AND user_id=$2 AND role='admin' AND status='active' LIMIT 1`,
            [accountId, targetUserId]);
          if (!isAdmin.length) {
            await deactivateAccessRole(client, accountId, targetUserId, "staff_visibility");
          }
        }
      }
    }

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId,
      entityType: "staff",
      entityId: id,
      action: "delete",
      after: { status: "inactive", name: updated.rows[0].name },
      metadata: { softDelete: true },
      visibility: "participants",
    });

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

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return fail(res, 400, "invalid_input", "Month must be in YYYY-MM format");
    }
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows } = await pool.query(
      `SELECT staff_id, month, statuses, paid_days, calculated_salary, updated_at
         FROM staff_attendance
        WHERE staff_id=$1 AND account_id=$2 AND month=$3`,
      [staffId, accountId, month]);

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
    const { statuses, calculated_salary: calculatedSalaryOverride } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
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
      `SELECT id, monthly_salary, user_id FROM staff
        WHERE id=$1 AND account_id=$2 AND status='active'`,
      [staffId, accountId]);
    if (!staffRows.length) return fail(res, 404, "not_found", "Staff not found");

    const baseSalary = Number(staffRows[0].monthly_salary) || 0;
    const targetUserId = staffRows[0].user_id;

    const [y, m] = month.split("-").map(Number);
    const totalDays = new Date(y, m, 0).getDate();

    let paidDays = 0;
    for (let day = 1; day <= totalDays; day++) {
      const key = `${month}-${String(day).padStart(2, "0")}`;
      const explicit = statuses[key];
      const status = explicit ?? (new Date(y, m - 1, day).getDay() % 6 === 0 ? "weekend" : "present");
      if (status !== "absent") paidDays++;
    }

    const autoCalculated = totalDays > 0 ? Math.round((baseSalary / totalDays) * paidDays) : 0;

    let calculatedSalary = autoCalculated;
    if (calculatedSalaryOverride !== undefined && calculatedSalaryOverride !== null) {
      const n = Number(calculatedSalaryOverride);
      if (Number.isFinite(n) && n >= 0) calculatedSalary = Math.round(n);
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO staff_attendance
         (account_id, staff_id, month, statuses, paid_days, calculated_salary, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
       ON CONFLICT (staff_id, month) DO UPDATE SET
         statuses = EXCLUDED.statuses,
         paid_days = EXCLUDED.paid_days,
         calculated_salary = EXCLUDED.calculated_salary,
         updated_at = NOW()
       RETURNING *`,
      [accountId, staffId, month, JSON.stringify(statuses), paidDays, calculatedSalary, userId]);

    await client.query("COMMIT");

    const attendanceRow = rows[0];

    const { rows: payRows } = await pool.query(
      `SELECT additional_amount, deduction_amount
         FROM staff_monthly_payments
        WHERE staff_id=$1 AND month=$2`,
      [staffId, month]);
    const paymentRow = payRows[0] ?? null;

    const dueAmount = computeStaffDue({ monthly_salary: baseSalary }, attendanceRow, paymentRow);

    return res.json({ ...attendanceRow, due_amount: dueAmount, due_month: month });
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

    const rawMonth = req.params.month ?? req.body?.month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(rawMonth)) {
      return fail(res, 400, "invalid_input", "Month must be in YYYY-MM format");
    }
    const month = rawMonth;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can update payments");
    }

    const { rows: memberRows } = await client.query(
      `SELECT id, maintenance_amount, user_id FROM members
        WHERE id=$1 AND account_id=$2 AND status='active'`,
      [memberId, accountId]);
    if (!memberRows.length) return fail(res, 404, "not_found", "Member not found");

    const targetUserId = memberRows[0].user_id;
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
    const netAmount = Math.max(0, baseAmount + additionalNumber - deductionNumber);

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO member_monthly_payments
         (member_id, month, status, paid_date,
          additional_amount, additional_note,
          deduction_amount, deduction_note, net_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (member_id, month) DO UPDATE SET
         status = EXCLUDED.status,
         paid_date = EXCLUDED.paid_date,
         additional_amount = EXCLUDED.additional_amount,
         additional_note = EXCLUDED.additional_note,
         deduction_amount = EXCLUDED.deduction_amount,
         deduction_note = EXCLUDED.deduction_note,
         net_amount = EXCLUDED.net_amount,
         updated_at = NOW()
       RETURNING *`,
      [memberId, month, status, paidDate,
       additionalAmount, additionalNote,
       deductionAmount, deductionNote, netAmount]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId,
      entityType: "member",
      entityId: memberId,
      action: status === "paid" ? "payment_paid" : "payment_due",
      after: rows[0],
      metadata: { month, netAmount, status },
      visibility: "participants",
    });

    await client.query("COMMIT");

    const paymentRow = rows[0];
    const dueAmount = computeMemberDue(memberRows[0], paymentRow);

    return res.json({ ...paymentRow, due_amount: dueAmount, due_month: month });
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

    const rawMonth = req.params.month ?? req.body?.month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(rawMonth)) {
      return fail(res, 400, "invalid_input", "Month must be in YYYY-MM format");
    }
    const month = rawMonth;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can update payments");
    }

    const { rows: staffRows } = await client.query(
      `SELECT id, monthly_salary, user_id FROM staff
        WHERE id=$1 AND account_id=$2 AND status='active'`,
      [staffId, accountId]);
    if (!staffRows.length) return fail(res, 404, "not_found", "Staff not found");

    const staffRow = staffRows[0];
    const targetUserId = staffRow.user_id;
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
        WHERE staff_id=$1 AND account_id=$2 AND month=$3`,
      [staffId, accountId, month]);
    const attendanceRow = attendanceRows[0] ?? null;

    const monthlySalary = Number(staffRow.monthly_salary) || 0;
    const attendanceBase = attendanceRow?.calculated_salary != null
      ? Number(attendanceRow.calculated_salary) : null;

    const effectiveBase = attendanceBase != null ? attendanceBase : monthlySalary;

    const additionalAmount = toNullableAmount(body.additionalAmount);
    const additionalNote = toNullableNote(body.additionalNote);
    const deductionAmount = toNullableAmount(body.deductionAmount);
    const deductionNote = toNullableNote(body.deductionNote);

    const additionalNumber = additionalAmount ?? 0;
    const deductionNumber = deductionAmount ?? 0;

    const netAmount = Math.max(0, effectiveBase + additionalNumber - deductionNumber);

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO staff_monthly_payments
         (staff_id, month, status, paid_date,
          additional_amount, additional_note,
          deduction_amount, deduction_note, net_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (staff_id, month) DO UPDATE SET
         status = EXCLUDED.status,
         paid_date = EXCLUDED.paid_date,
         additional_amount = EXCLUDED.additional_amount,
         additional_note = EXCLUDED.additional_note,
         deduction_amount = EXCLUDED.deduction_amount,
         deduction_note = EXCLUDED.deduction_note,
         net_amount = EXCLUDED.net_amount,
         updated_at = NOW()
       RETURNING *`,
      [staffId, month, status, paidDate,
       additionalAmount, additionalNote,
       deductionAmount, deductionNote, netAmount]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId,
      entityType: "staff",
      entityId: staffId,
      action: status === "paid" ? "payment_paid" : "payment_due",
      after: rows[0],
      metadata: { month, netAmount, status },
      visibility: "participants",
    });

    await client.query("COMMIT");

    return res.json({ ...rows[0], due_amount: netAmount, due_month: month });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("upsertStaffPayment error:", err);
    return fail(res, 500, "server_error", "Failed to save staff payment");
  } finally {
    client.release();
  }
};

// ===========================================================================
// EXPENSES
// ===========================================================================
const listExpenses = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows } = await pool.query(
      `SELECT id, account_id, category, title, amount, transaction_type,
              status, reminder_enabled, expense_date,
              description, bill_attachments, created_by, created_at, updated_at
         FROM expenses
        WHERE account_id=$1
        ORDER BY expense_date DESC, created_at DESC`,
      [accountId]);

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
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows } = await pool.query(
      `SELECT id, account_id, category, title, amount, transaction_type,
              status, reminder_enabled, expense_date,
              description, bill_attachments, created_by, created_at, updated_at
         FROM expenses
        WHERE id=$1 AND account_id=$2`,
      [id, accountId]);

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
      category, title, amount, transaction_type = "expense",
      status = "paid", reminder_enabled = false,
      expense_date, description = null, bill_attachments = [],
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
    if (Array.isArray(bill_attachments) && bill_attachments.length > MAX_BILL_ATTACHMENTS) {
      return fail(res, 400, "too_many_attachments",
        `You can attach at most ${MAX_BILL_ATTACHMENTS} files.`);
    }

    const safeBillAttachments = normalizeBillAttachments(bill_attachments);

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO expenses
         (account_id, category, title, amount, transaction_type, status,
          reminder_enabled, expense_date, description, bill_attachments, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, CURRENT_DATE),$9,$10,$11)
       RETURNING *`,
      [accountId, category, title.trim(), amount, transaction_type, status,
       reminder_enabled, expense_date || null, description,
       JSON.stringify(safeBillAttachments), userId]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "expense",
      entityId: rows[0].id,
      action: "create",
      after: rows[0],
      metadata: { category, title, amount, transaction_type },
      visibility: "public",
    });

    if (rows[0].reminder_enabled && rows[0].status === "due") {
      await upsertExpenseReminder(client, {
        accountId,
        expenseId: rows[0].id,
        expenseDate: rows[0].expense_date,
        payload: {
          title: rows[0].title,
          amount: Number(rows[0].amount),
          transaction_type: rows[0].transaction_type,
          category: rows[0].category,
        },
      });
    } else {
      await cancelExpenseReminder(client, rows[0].id);
    }

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

    const allowedFields = ["category", "title", "amount", "transaction_type",
      "status", "reminder_enabled", "expense_date", "description", "bill_attachments"];

    if (Object.prototype.hasOwnProperty.call(req.body, "bill_attachments") &&
        Array.isArray(req.body.bill_attachments) &&
        req.body.bill_attachments.length > MAX_BILL_ATTACHMENTS) {
      return fail(res, 400, "too_many_attachments",
        `You can attach at most ${MAX_BILL_ATTACHMENTS} files.`);
    }

    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = key === "bill_attachments"
          ? JSON.stringify(normalizeBillAttachments(req.body[key]))
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

    const { rows: beforeRows } = await client.query(
      `SELECT * FROM expenses WHERE id=$1 AND account_id=$2`,
      [id, accountId]);
    const before = beforeRows[0] ?? null;

    const updated = await client.query(
      `UPDATE expenses SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1} AND account_id = $${keys.length + 2}
        RETURNING *`,
      [...values, id, accountId]);

    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Expense not found");
    }

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "expense",
      entityId: id,
      action: "update",
      before,
      after: updated.rows[0],
      metadata: { fields: keys },
      visibility: "public",
    });

    const after = updated.rows[0];
    if (after.reminder_enabled && after.status === "due") {
      await upsertExpenseReminder(client, {
        accountId,
        expenseId: after.id,
        expenseDate: after.expense_date,
        payload: {
          title: after.title,
          amount: Number(after.amount),
          transaction_type: after.transaction_type,
          category: after.category,
        },
      });
    } else {
      await cancelExpenseReminder(client, after.id);
    }

    await client.query("COMMIT");
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
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can delete expenses");
    }

    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query(
      `SELECT * FROM expenses WHERE id=$1 AND account_id=$2`,
      [id, accountId]);
    const before = beforeRows[0] ?? null;

    const result = await client.query(
      `DELETE FROM expenses WHERE id=$1 AND account_id=$2`,
      [id, accountId]);

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Expense not found");
    }

    await cancelExpenseReminder(client, id);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "expense",
      entityId: id,
      action: "delete",
      before,
      metadata: { category: before?.category, title: before?.title, amount: before?.amount },
      visibility: "public",
    });

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deleteExpense error:", err);
    return fail(res, 500, "server_error", "Failed to delete expense");
  } finally {
    client.release();
  }
};

// ===========================================================================
// ─── NEW: VEHICLES + GATE ENTRY ─────────────────────────────────────────
// ===========================================================================

/**
 * GET /management/:accountId/vehicles/lookup?number=KA01AB1234
 *
 * Returns:
 *   { found: true, owner: {...} }              — one match
 *   { found: true, matches: [...] }            — multiple matches (rare)
 *   { found: false }                           — none
 *
 * Access: any active member of the account (owner, admin, or staff).
 */
const lookupVehicle = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const raw =
      (req.query?.number ?? req.query?.vehicle_number ?? req.body?.number ?? "");
    const number = normalizeVehicleNumber(raw);
    if (!number) {
      return fail(res, 400, "invalid_input", "Vehicle number is required");
    }

    const { rows } = await pool.query(
      `SELECT id, member_id, user_id, vehicle_number, owner_name, flat_number,
              wing, owner_phone, vehicle_type, registered_by_guard,
              created_at, updated_at
         FROM vehicles
        WHERE account_id = $1 AND vehicle_number = $2 AND status = 'active'
        ORDER BY created_at ASC`,
      [accountId, number]);

    if (rows.length === 0) {
      return res.json({
        found: false,
        vehicle_number: number,
      });
    }

    const shaped = rows.map((r) => ({
      vehicle_id: r.id,
      member_id: r.member_id,
      user_id: r.user_id,
      vehicle_number: r.vehicle_number,
      owner_name: r.owner_name || "",
      flat_number: r.flat_number || "",
      wing: r.wing,
      owner_phone: r.owner_phone || "",
      vehicle_type: r.vehicle_type,
      registered_by_guard: !!r.registered_by_guard,
    }));

    return res.json({
      found: true,
      vehicle_number: number,
      owner: shaped[0],      // convenience: first match
      matches: shaped,       // all matches (usually just one)
    });
  } catch (err) {
    console.error("lookupVehicle error:", err);
    return fail(res, 500, "server_error", "Failed to look up vehicle");
  }
};

/**
 * POST /management/:accountId/vehicles
 *
 * Guard-side registration. Body:
 *   { vehicleNumber, name, flatNumber, phone, wing?, type? }
 *
 * Any active member (owner/admin/staff) can register a vehicle. The
 * record is marked registered_by_guard = TRUE.
 */
const registerVehicle = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const body = req.body || {};
    const number = normalizeVehicleNumber(
      body.vehicleNumber ?? body.vehicle_number ?? body.number ?? "",
    );
    const name = String(body.name ?? "").trim();
    const flatNumber = String(body.flatNumber ?? body.flat_number ?? "").trim();
    const wing = body.wing ? String(body.wing).trim() : null;
    const phone = normalizePhone(body.phone ?? body.ownerPhone ?? body.owner_phone);
    const type = normalizeVehicleType(body.type ?? body.vehicle_type);

    if (!number) return fail(res, 400, "invalid_input", "Vehicle number is required");
    if (number.length < 5 || number.length > 15) {
      return fail(res, 400, "invalid_input", "Vehicle number is not valid");
    }
    if (!name) return fail(res, 400, "invalid_input", "Owner name is required");
    if (!flatNumber) return fail(res, 400, "invalid_input", "Flat number is required");
    if (!phone) return fail(res, 400, "invalid_input", "A valid 10-digit phone is required");

    await client.query("BEGIN");

    // Reuse an existing row for this account+number if one exists (even
    // inactive), so we don't fight the unique constraint.
    const { rows: existing } = await client.query(
      `SELECT id, status FROM vehicles
        WHERE account_id = $1 AND vehicle_number = $2`,
      [accountId, number],
    );

    let vehicleId;
    if (existing.length > 0) {
      vehicleId = existing[0].id;
      await client.query(
        `UPDATE vehicles SET
           owner_name = $1,
           flat_number = $2,
           wing = $3,
           owner_phone = $4,
           vehicle_type = $5,
           registered_by_guard = TRUE,
           status = 'active',
           updated_at = NOW()
         WHERE id = $6`,
        [name, flatNumber, wing, phone, type, vehicleId],
      );
    } else {
      const { rows } = await client.query(
        `INSERT INTO vehicles
           (account_id, member_id, user_id, vehicle_number,
            owner_name, flat_number, wing, owner_phone, vehicle_type,
            registered_by_guard, status, created_by)
         VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, TRUE, 'active', $8)
         RETURNING id`,
        [accountId, number, name, flatNumber, wing, phone, type, userId],
      );
      vehicleId = rows[0].id;
    }

    // Best-effort: try to match a member row so future lookups can link back.
    const { rows: memberMatch } = await client.query(
      `SELECT m.id, m.user_id
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id = $1
          AND m.flat_number = $2
          AND m.status = 'active'
          AND (u.phone LIKE $3 OR u.phone LIKE $4)
        LIMIT 1`,
      [accountId, flatNumber, `%${phone}`, `91${phone}`],
    );
    if (memberMatch.length > 0) {
      await client.query(
        `UPDATE vehicles SET member_id = $1, user_id = $2, updated_at = NOW()
          WHERE id = $3`,
        [memberMatch[0].id, memberMatch[0].user_id, vehicleId],
      );
    }

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "vehicle",
      entityId: vehicleId,
      action: "create",
      after: {
        vehicle_number: number,
        owner_name: name,
        flat_number: flatNumber,
        owner_phone: phone,
        registered_by_guard: true,
      },
      metadata: { source: "guard_registration" },
      visibility: "public",
    });

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      vehicle: {
        vehicle_id: vehicleId,
        vehicle_number: number,
        owner_name: name,
        flat_number: flatNumber,
        wing,
        owner_phone: phone,
        vehicle_type: type,
        registered_by_guard: true,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("registerVehicle error:", err);
    return fail(res, 500, "server_error", "Failed to register vehicle");
  } finally {
    client.release();
  }
};

/**
 * POST /management/:accountId/gate-entries
 *
 * Body: { vehicleNumber, direction: "in" | "out" }
 *
 * Looks up the vehicle to snapshot owner info, then logs the entry.
 * Any active member can log.
 */
const createGateEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const body = req.body || {};
    const number = normalizeVehicleNumber(
      body.vehicleNumber ?? body.vehicle_number ?? body.number ?? "",
    );
    const directionRaw = String(body.direction ?? "in").toLowerCase().trim();
    const direction = directionRaw === "out" ? "out" : "in";

    if (!number) return fail(res, 400, "invalid_input", "Vehicle number is required");

    // Optional: allow the client to pass a snapshot when it already looked up
    // the vehicle (avoids a second read). If missing we do the lookup here.
    let vehicleId = null;
    let memberId = null;
    let ownerName = null;
    let flatNumber = null;
    let ownerPhone = null;
    let registered = false;

    const passedOwner = body.owner && typeof body.owner === "object" ? body.owner : null;

    if (passedOwner) {
      vehicleId = passedOwner.vehicle_id ?? null;
      memberId = passedOwner.member_id ?? null;
      ownerName = passedOwner.owner_name ?? null;
      flatNumber = passedOwner.flat_number ?? null;
      ownerPhone = passedOwner.owner_phone ?? null;
      registered = true;
    } else {
      const { rows } = await pool.query(
        `SELECT id, member_id, owner_name, flat_number, owner_phone
           FROM vehicles
          WHERE account_id = $1 AND vehicle_number = $2 AND status = 'active'
          LIMIT 1`,
        [accountId, number],
      );
      if (rows.length > 0) {
        vehicleId = rows[0].id;
        memberId = rows[0].member_id;
        ownerName = rows[0].owner_name;
        flatNumber = rows[0].flat_number;
        ownerPhone = rows[0].owner_phone;
        registered = true;
      }
    }

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO gate_entries
         (account_id, vehicle_number, vehicle_id, member_id,
          owner_name, flat_number, owner_phone, registered, direction, scanned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, scanned_at`,
      [
        accountId,
        number,
        vehicleId,
        memberId,
        ownerName,
        flatNumber,
        ownerPhone,
        registered,
        direction,
        userId,
      ],
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      entry_id: rows[0].id,
      scanned_at: rows[0].scanned_at,
      registered,
      vehicle_number: number,
      direction,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createGateEntry error:", err);
    return fail(res, 500, "server_error", "Failed to log gate entry");
  } finally {
    client.release();
  }
};

/**
 * GET /management/:accountId/gate-entries?limit=50
 */
const listGateEntries = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const limitRaw = Number(req.query?.limit ?? 50);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;

    const { rows } = await pool.query(
      `SELECT id, vehicle_number, vehicle_id, member_id,
              owner_name, flat_number, owner_phone,
              registered, direction, scanned_by, scanned_at
         FROM gate_entries
        WHERE account_id = $1
        ORDER BY scanned_at DESC
        LIMIT $2`,
      [accountId, limit],
    );

    return res.json(rows);
  } catch (err) {
    console.error("listGateEntries error:", err);
    return fail(res, 500, "server_error", "Failed to load gate entries");
  }
};

module.exports = {
  listAccountPeople,
  listMembers, getMember, createMember, updateMember, deleteMember,
  getPhoneVisibility, updatePhoneVisibility,
  listStaff, getStaff, createStaff, updateStaff, deleteStaff,
  getStaffAttendance, upsertStaffAttendance,
  upsertMemberPayment, upsertStaffPayment,
  listExpenses, getExpense, createExpense, updateExpense, deleteExpense,
  // ─── NEW ────────────────────────────────────────────────────────────
  lookupVehicle,
  registerVehicle,
  createGateEntry,
  listGateEntries,
};