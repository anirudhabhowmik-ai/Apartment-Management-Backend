// src/controllers/managementController.js
const { pool } = require("../config/database");
const {
  isEligibleForAutoGrant,
  findUserIdByPhone,
  findExistingDirectoryEntry,
  deactivateAccessRole,
} = require("../utils/accessSync");
const { writeAudit } = require("./auditController");
const {
  upsertExpenseReminder,
  cancelExpenseReminder,
  notifyMemberForGate,
  sendGateNotification,
} = require("../services/push");
const crypto = require("crypto");

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

const VALID_VEHICLE_TYPES = new Set(["car", "bike", "other"]);

function normalizeVehicleNumber(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeVehicleType(raw) {
  const s = String(raw ?? "").toLowerCase().trim();
  return VALID_VEHICLE_TYPES.has(s) ? s : "car";
}

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

const MAX_GROUP_SIZE = 20;

function normalizeGuestRow(g) {
  if (!g || typeof g !== "object") return null;

  const name = String(g.name ?? g.visitorName ?? "").trim();
  if (!name || name.length > 200) return null;

  const phone = normalizePhone(g.phone ?? g.visitorPhone);

  let vehicle = null;
  const v = g.vehicle ?? null;
  if (v && typeof v === "object") {
    const number = normalizeVehicleNumber(v.number ?? v.vehicle_number ?? "");
    if (number.length >= 5 && number.length <= 15) {
      vehicle = {
        number,
        type: normalizeVehicleType(v.type ?? v.vehicle_type),
      };
    }
  } else if (typeof g.vehicleNumber === "string" && g.vehicleNumber.length > 0) {
    const number = normalizeVehicleNumber(g.vehicleNumber);
    if (number.length >= 5 && number.length <= 15) {
      vehicle = { number, type: normalizeVehicleType(g.vehicleType) };
    }
  }

  return { name, phone: phone || null, vehicle };
}

function normalizeGuestsGroup(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seenNames = new Set();
  for (const item of raw) {
    const row = normalizeGuestRow(item);
    if (!row) continue;
    const key = row.name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    out.push(row);
    if (out.length >= MAX_GROUP_SIZE) break;
  }
  return out;
}

function normalizeVehiclesPayloadInput(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const number = normalizeVehicleNumber(
      item.number ?? item.vehicle_number ?? "",
    );
    if (!number || seen.has(number)) continue;
    if (number.length < 5 || number.length > 15) continue;
    seen.add(number);
    out.push({
      number,
      type: normalizeVehicleType(item.type ?? item.vehicle_type),
    });
    if (out.length >= 5) break;
  }
  return out;
}

function deriveVehicleList(guests) {
  const out = [];
  const seen = new Set();
  for (const g of guests) {
    if (!g.vehicle) continue;
    if (seen.has(g.vehicle.number)) continue;
    seen.add(g.vehicle.number);
    out.push(g.vehicle);
  }
  return out;
}

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

// ─────────────────────────────────────────────────────────────────────────
// Flat uniqueness helpers
// ─────────────────────────────────────────────────────────────────────────

function normalizeFlatKeyValue(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/\s+/g, " ");
  return s.length === 0 ? null : s;
}

async function findFlatConflict(
  client,
  accountId,
  flatNumber,
  wing,
  excludeMemberId = null,
) {
  const flatKey = normalizeFlatKeyValue(flatNumber);
  if (!flatKey) return null;

  const wingKey = normalizeFlatKeyValue(wing);
  const runner = client || pool;

  const { rows } = await runner.query(
    `SELECT m.id, m.flat_number, m.wing, m.name
       FROM members m
      WHERE m.account_id = $1
        AND m.status = 'active'
        AND LOWER(TRIM(m.flat_number)) = LOWER($2)
        AND (
              ($3::text IS NULL AND (m.wing IS NULL OR TRIM(m.wing) = ''))
           OR ($3::text IS NOT NULL AND LOWER(TRIM(m.wing)) = LOWER($3))
        )
        AND ($4::uuid IS NULL OR m.id <> $4::uuid)
      LIMIT 1`,
    [accountId, flatKey, wingKey, excludeMemberId],
  );

  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Resolve an "existing" selection coming from the picker.
// ---------------------------------------------------------------------------
async function resolveExistingSelection(client, accountId, rawUserId) {
  if (!rawUserId || typeof rawUserId !== "string") {
    const err = new Error("user_id is required for mode=existing");
    err.code = "invalid_input";
    throw err;
  }

  if (rawUserId.startsWith("pending:")) {
    const parts = rawUserId.split(":");
    const sourceKind = parts[1];
    const sourceId = parts[2];

    if (!sourceId || (sourceKind !== "member" && sourceKind !== "staff")) {
      const err = new Error("Invalid pending id");
      err.code = "invalid_input";
      throw err;
    }

    const table = sourceKind === "member" ? "members" : "staff";
    const { rows } = await client.query(
      `SELECT id, user_id, name, phone, photo_url
         FROM ${table}
        WHERE id = $1 AND account_id = $2 AND status = 'active'
        LIMIT 1`,
      [sourceId, accountId],
    );
    const row = rows[0];
    if (!row) {
      const err = new Error("Directory entry not found");
      err.code = "not_found";
      throw err;
    }

    const phone = (row.phone ?? "").replace(/\D/g, "").slice(-10) || null;

    let linkedUserId = row.user_id;
    if (!linkedUserId && phone) {
      linkedUserId = await findUserIdByPhone(client, phone);
    }

    return {
      userId: linkedUserId,
      name: row.name ?? "",
      phone: phone ?? "",
      photoUrl: row.photo_url ?? null,
    };
  }

  const { rows: u } = await client.query(
    `SELECT id, name, phone, photo_url FROM users WHERE id=$1 LIMIT 1`,
    [rawUserId],
  );
  const user = u[0];
  if (!user) {
    const err = new Error("Person not found");
    err.code = "not_found";
    throw err;
  }

  return {
    userId: user.id,
    name: user.name ?? "",
    phone: (user.phone ?? "").replace(/\D/g, "").slice(-10),
    photoUrl: user.photo_url ?? null,
  };
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
      `SELECT m.user_id, m.name, m.phone, m.photo_url
         FROM members m
        WHERE m.account_id=$1 AND m.status='active' AND m.user_id IS NOT NULL`,
      [accountId]);
    for (const r of memberRows) {
      if (!r.user_id || map.has(r.user_id)) continue;
      map.set(r.user_id, {
        user_id: r.user_id, name: r.name ?? "", phone: r.phone ?? null,
        photo_url: r.photo_url ?? null, kind: "member",
      });
    }

    const { rows: staffRows } = await pool.query(
      `SELECT s.user_id, s.name, s.phone, s.photo_url
         FROM staff s
        WHERE s.account_id=$1 AND s.status='active' AND s.user_id IS NOT NULL`,
      [accountId]);
    for (const r of staffRows) {
      if (!r.user_id || map.has(r.user_id)) continue;
      map.set(r.user_id, {
        user_id: r.user_id, name: r.name ?? "", phone: r.phone ?? null,
        photo_url: r.photo_url ?? null, kind: "staff",
      });
    }

    {
      const { rows: pendingMembers } = await pool.query(
        `SELECT id::text AS member_id, name, phone, photo_url
           FROM members
          WHERE account_id = $1
            AND status     = 'active'
            AND user_id IS NULL
          ORDER BY created_at ASC`,
        [accountId]);

      for (const r of pendingMembers) {
        const key = `pending:member:${r.member_id}`;
        if (map.has(key)) continue;
        map.set(key, {
          user_id: key,
          name: r.name ?? "",
          phone: r.phone ?? null,
          photo_url: r.photo_url ?? null,
          kind: "member",
          pending: true,
        });
      }
    }

    {
      const { rows: pendingStaff } = await pool.query(
        `SELECT id::text AS staff_id, name, phone, photo_url
           FROM staff
          WHERE account_id = $1
            AND status     = 'active'
            AND user_id IS NULL
          ORDER BY created_at ASC`,
        [accountId]);

      for (const r of pendingStaff) {
        const key = `pending:staff:${r.staff_id}`;
        if (map.has(key)) continue;
        map.set(key, {
          user_id: key,
          name: r.name ?? "",
          phone: r.phone ?? null,
          photo_url: r.photo_url ?? null,
          kind: "staff",
          pending: true,
        });
      }
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
//
// The LATERAL subquery now falls back to phone matching when the directory
// row still has user_id = NULL. This is the fix that makes an admin-created
// "AB" row display as "Anirudha" the moment the real user joins the property.
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
              COALESCE(joined.name,      m.name)      AS name,
              COALESCE(joined.phone,     m.phone)     AS phone,
              COALESCE(joined.photo_url, m.photo_url) AS photo_url,
              (joined.user_id IS NOT NULL) AS has_access
         FROM members m
         LEFT JOIN LATERAL (
           SELECT u.id AS user_id, u.name, u.phone, u.photo_url
             FROM account_members am
             JOIN users u ON u.id = am.user_id
            WHERE am.account_id = m.account_id
              AND am.status     = 'active'
              AND (
                (m.user_id IS NOT NULL AND am.user_id = m.user_id)
                OR (
                  m.user_id IS NULL
                  AND m.phone IS NOT NULL
                  AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone,''),'\\D','','g'),10)
                    = RIGHT(REGEXP_REPLACE(COALESCE(m.phone,''),'\\D','','g'),10)
                )
              )
            LIMIT 1
         ) joined ON TRUE
        WHERE m.account_id=$1 AND m.status='active'
        ORDER BY m.flat_number, COALESCE(joined.name, m.name)`,
      [accountId]);

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
        [accountId, memberIds]);
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
      [accountId]);
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
              COALESCE(joined.name,      m.name)      AS name,
              COALESCE(joined.phone,     m.phone)     AS phone,
              COALESCE(joined.photo_url, m.photo_url) AS photo_url,
              (joined.user_id IS NOT NULL) AS has_access
         FROM members m
         LEFT JOIN LATERAL (
           SELECT u.id AS user_id, u.name, u.phone, u.photo_url
             FROM account_members am
             JOIN users u ON u.id = am.user_id
            WHERE am.account_id = m.account_id
              AND am.status     = 'active'
              AND (
                (m.user_id IS NOT NULL AND am.user_id = m.user_id)
                OR (
                  m.user_id IS NULL
                  AND m.phone IS NOT NULL
                  AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone,''),'\\D','','g'),10)
                    = RIGHT(REGEXP_REPLACE(COALESCE(m.phone,''),'\\D','','g'),10)
                )
              )
            LIMIT 1
         ) joined ON TRUE
        WHERE m.id=$1 AND m.account_id=$2 AND m.status='active'`,
      [id, accountId]);

    if (!rows.length) return fail(res, 404, "not_found", "Member not found");

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

    {
      const flatConflict = await findFlatConflict(
        client, accountId, flat_number, wing, null,
      );
      if (flatConflict) {
        await client.query("ROLLBACK");
        return fail(
          res,
          409,
          "flat_already_registered",
          `Flat ${flatConflict.flat_number} is already registered${
            flatConflict.name ? ` to ${flatConflict.name}` : ""
          }. Delete the existing record first.`,
        );
      }
    }

    let targetUserId = null;
    let targetName = "";
    let targetPhone = "";
    let targetPhotoUrl = null;

    if (mode === "existing") {
      try {
        const resolved = await resolveExistingSelection(
          client, accountId, body.user_id,
        );
        targetUserId = resolved.userId;
        targetName = resolved.name;
        targetPhone = resolved.phone;
        targetPhotoUrl = resolved.photoUrl;
      } catch (e) {
        await client.query("ROLLBACK");
        const status = e?.code === "not_found" ? 404 : 400;
        return fail(res, status, e?.code ?? "invalid_input", e?.message ?? "Invalid selection");
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

      targetName = name;
      targetPhone = phone;
      targetPhotoUrl = photo_url;

      targetUserId = await findUserIdByPhone(client, phone);
    }

    if (targetPhone) {
      const existingEntry = await findExistingDirectoryEntry(
        client, accountId, targetPhone, null,
      );
      if (
        existingEntry &&
        existingEntry.name &&
        existingEntry.name.trim().toLowerCase() !==
          String(targetName || "").trim().toLowerCase()
      ) {
        await client.query("ROLLBACK");
        return fail(
          res,
          409,
          "phone_name_mismatch",
          `${targetPhone} is already in this property as "${existingEntry.name}" (${existingEntry.kind}). Use that name, or edit the existing entry.`,
        );
      }
    }

    const { rows } = await client.query(
      `INSERT INTO members
         (account_id, user_id, role, wing, flat_number,
          area_sqft, parking_available, maintenance_amount,
          name, phone, photo_url,
          status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)
       RETURNING id`,
      [
        accountId, targetUserId, memberRole, wing, flat_number,
        area_sqft, parking_available, maintenance_amount,
        targetName, targetPhone, targetPhotoUrl, userId,
      ]);

    const memberId = rows[0].id;

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
              COALESCE(joined.name,      m.name)      AS name,
              COALESCE(joined.phone,     m.phone)     AS phone,
              COALESCE(joined.photo_url, m.photo_url) AS photo_url,
              (joined.user_id IS NOT NULL) AS has_access
         FROM members m
         LEFT JOIN LATERAL (
           SELECT u.id AS user_id, u.name, u.phone, u.photo_url
             FROM account_members am
             JOIN users u ON u.id = am.user_id
            WHERE am.account_id = m.account_id
              AND am.status     = 'active'
              AND (
                (m.user_id IS NOT NULL AND am.user_id = m.user_id)
                OR (
                  m.user_id IS NULL
                  AND m.phone IS NOT NULL
                  AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone,''),'\\D','','g'),10)
                    = RIGHT(REGEXP_REPLACE(COALESCE(m.phone,''),'\\D','','g'),10)
                )
              )
            LIMIT 1
         ) joined ON TRUE
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
      `SELECT id, user_id, name, phone FROM members
        WHERE id=$1 AND account_id=$2 AND status='active'`,
      [id, accountId]);
    if (!rows.length) return fail(res, 404, "not_found", "Member not found");

    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can edit members");
    }

    const hasName = Object.prototype.hasOwnProperty.call(req.body, "name");
    const hasPhone = Object.prototype.hasOwnProperty.call(req.body, "phone");
    const hasPhoto = Object.prototype.hasOwnProperty.call(req.body, "photo_url");

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
              m.name, m.phone, m.photo_url
         FROM members m
        WHERE m.id = $1`,
      [id]);
    const beforeSnapshot = beforeRows[0] ?? null;

    if (
      Object.prototype.hasOwnProperty.call(req.body, "flat_number") ||
      Object.prototype.hasOwnProperty.call(req.body, "wing")
    ) {
      const nextFlat =
        updates.flat_number !== undefined
          ? updates.flat_number
          : beforeSnapshot?.flat_number ?? null;

      const nextWing =
        updates.wing !== undefined
          ? updates.wing
          : beforeSnapshot?.wing ?? null;

      const flatChanged =
        normalizeFlatKeyValue(nextFlat) !==
        normalizeFlatKeyValue(beforeSnapshot?.flat_number);
      const wingChanged =
        normalizeFlatKeyValue(nextWing) !==
        normalizeFlatKeyValue(beforeSnapshot?.wing);

      if (flatChanged || wingChanged) {
        const flatConflict = await findFlatConflict(
          client, accountId, nextFlat, nextWing, id,
        );
        if (flatConflict) {
          await client.query("ROLLBACK");
          return fail(
            res,
            409,
            "flat_already_registered",
            `Flat ${flatConflict.flat_number} is already registered${
              flatConflict.name ? ` to ${flatConflict.name}` : ""
            }. Delete the existing record first.`,
          );
        }
      }
    }

    if (hasPhone || hasName) {
      const effectivePhone = hasPhone ? newPhone : beforeSnapshot?.phone;
      const effectiveName = hasName ? newName : beforeSnapshot?.name;
      if (effectivePhone) {
        const existingEntry = await findExistingDirectoryEntry(
          client, accountId, effectivePhone, id,
        );
        if (
          existingEntry &&
          existingEntry.name &&
          existingEntry.name.trim().toLowerCase() !==
            String(effectiveName || "").trim().toLowerCase()
        ) {
          await client.query("ROLLBACK");
          return fail(
            res,
            409,
            "phone_name_mismatch",
            `${effectivePhone} is already in this property as "${existingEntry.name}" (${existingEntry.kind}). Use that name, or edit the existing entry.`,
          );
        }
      }
    }

    const setParts = [];
    const values = [];
    const push = (col, val) => {
      values.push(val);
      setParts.push(`${col} = $${values.length}`);
    };

    for (const key of Object.keys(updates)) push(key, updates[key]);
    if (hasName) push("name", newName);
    if (hasPhone) push("phone", newPhone);
    if (hasPhoto) push("photo_url", newPhoto);

    if (hasPhone) {
      const linkedUserId = await findUserIdByPhone(client, newPhone);
      push("user_id", linkedUserId);
    }

    if (setParts.length > 0) {
      values.push(id);
      values.push(accountId);
      await client.query(
        `UPDATE members SET ${setParts.join(", ")}, updated_at = NOW()
          WHERE id = $${values.length - 1} AND account_id = $${values.length}`,
        values,
      );
    }

    if (hasVehiclesField) {
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
        userId: beforeSnapshot?.user_id ?? null,
      };

      try {
        await replaceMemberVehicles(
          client, accountId, id, incomingVehicles, identity, userId,
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
              COALESCE(joined.name,      m.name)      AS name,
              COALESCE(joined.phone,     m.phone)     AS phone,
              COALESCE(joined.photo_url, m.photo_url) AS photo_url,
              (joined.user_id IS NOT NULL) AS has_access
         FROM members m
         LEFT JOIN LATERAL (
           SELECT u.id AS user_id, u.name, u.phone, u.photo_url
             FROM account_members am
             JOIN users u ON u.id = am.user_id
            WHERE am.account_id = m.account_id
              AND am.status     = 'active'
              AND (
                (m.user_id IS NOT NULL AND am.user_id = m.user_id)
                OR (
                  m.user_id IS NULL
                  AND m.phone IS NOT NULL
                  AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone,''),'\\D','','g'),10)
                    = RIGHT(REGEXP_REPLACE(COALESCE(m.phone,''),'\\D','','g'),10)
                )
              )
            LIMIT 1
         ) joined ON TRUE
        WHERE m.id = $1`,
      [id]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId: joined[0].user_id,
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

    const { rows: existing } = await client.query(
      `SELECT m.user_id, m.flat_number, m.wing, m.name
         FROM members m
        WHERE m.id = $1 AND m.account_id = $2 AND m.status = 'active'`,
      [id, accountId]);

    if (!existing.length) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Member not found");
    }

    const targetUserId = existing[0].user_id ?? null;
    const targetName = existing[0].name ?? null;
    const flatNumber = existing[0].flat_number ?? null;
    const wingRaw = existing[0].wing ?? null;

    const updated = await client.query(
      `UPDATE members SET status='inactive', updated_at=NOW()
        WHERE id=$1 AND account_id=$2 AND status='active'`,
      [id, accountId]);

    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Member not found");
    }

    await client.query(
      `UPDATE vehicles SET status='inactive', updated_at=NOW()
        WHERE account_id=$1 AND member_id=$2 AND status='active'`,
      [accountId, id]);

    if (flatNumber) {
      const wingKey =
        wingRaw && String(wingRaw).trim() !== ""
          ? String(wingRaw).trim()
          : null;

      const cancelSql = `
        UPDATE %TABLE%
           SET status = 'cancelled', updated_at = NOW()
         WHERE account_id = $1
           AND status <> 'cancelled'
           AND (
                 member_id = $2
              OR (
                   LOWER(TRIM(flat_number)) = LOWER(TRIM($3))
                   AND (
                         $4::text IS NULL
                      OR wing IS NULL
                      OR TRIM(wing) = ''
                      OR LOWER(TRIM(wing)) = LOWER($4)
                   )
                 )
           )`;

      await client.query(cancelSql.replace("%TABLE%", "gate_invites"), [
        accountId, id, flatNumber, wingKey,
      ]);
      await client.query(cancelSql.replace("%TABLE%", "gate_authorizations"), [
        accountId, id, flatNumber, wingKey,
      ]);
    }

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
      after: { status: "inactive", name: targetName },
      metadata: { softDelete: true, flat_number: flatNumber, wing: wingRaw },
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
      `SELECT id, user_id, phone FROM members
        WHERE id=$1 AND account_id=$2 AND status='active'`,
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
        WHERE am.account_id=$1 AND am.status='active'
        ORDER BY CASE am.role
                   WHEN 'admin' THEN 1
                   WHEN 'member_visibility' THEN 2
                   WHEN 'staff_visibility' THEN 3
                   ELSE 4 END,
                 COALESCE(u.name, '')`,
      [accountId]);

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
      `SELECT id, phone FROM members
        WHERE id=$1 AND account_id=$2 AND status='active'`,
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
              COALESCE(joined.name,      s.name)      AS name,
              COALESCE(joined.phone,     s.phone)     AS phone,
              COALESCE(joined.photo_url, s.photo_url) AS photo_url,
              (joined.user_id IS NOT NULL) AS has_access
         FROM staff s
         LEFT JOIN LATERAL (
           SELECT u.id AS user_id, u.name, u.phone, u.photo_url
             FROM account_members am
             JOIN users u ON u.id = am.user_id
            WHERE am.account_id = s.account_id
              AND am.status     = 'active'
              AND (
                (s.user_id IS NOT NULL AND am.user_id = s.user_id)
                OR (
                  s.user_id IS NULL
                  AND s.phone IS NOT NULL
                  AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone,''),'\\D','','g'),10)
                    = RIGHT(REGEXP_REPLACE(COALESCE(s.phone,''),'\\D','','g'),10)
                )
              )
            LIMIT 1
         ) joined ON TRUE
        WHERE s.account_id=$1 AND s.status='active'
        ORDER BY COALESCE(joined.name, s.name)`,
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
              COALESCE(joined.name,      s.name)      AS name,
              COALESCE(joined.phone,     s.phone)     AS phone,
              COALESCE(joined.photo_url, s.photo_url) AS photo_url,
              (joined.user_id IS NOT NULL) AS has_access
         FROM staff s
         LEFT JOIN LATERAL (
           SELECT u.id AS user_id, u.name, u.phone, u.photo_url
             FROM account_members am
             JOIN users u ON u.id = am.user_id
            WHERE am.account_id = s.account_id
              AND am.status     = 'active'
              AND (
                (s.user_id IS NOT NULL AND am.user_id = s.user_id)
                OR (
                  s.user_id IS NULL
                  AND s.phone IS NOT NULL
                  AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone,''),'\\D','','g'),10)
                    = RIGHT(REGEXP_REPLACE(COALESCE(s.phone,''),'\\D','','g'),10)
                )
              )
            LIMIT 1
         ) joined ON TRUE
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
    let targetName = "";
    let targetPhone = "";
    let targetPhotoUrl = null;

    if (mode === "existing") {
      try {
        const resolved = await resolveExistingSelection(
          client, accountId, body.user_id,
        );
        targetUserId = resolved.userId;
        targetName = resolved.name;
        targetPhone = resolved.phone;
        targetPhotoUrl = resolved.photoUrl;
      } catch (e) {
        await client.query("ROLLBACK");
        const status = e?.code === "not_found" ? 404 : 400;
        return fail(res, status, e?.code ?? "invalid_input", e?.message ?? "Invalid selection");
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

      targetName = name;
      targetPhone = phone;
      targetPhotoUrl = photo_url;

      targetUserId = await findUserIdByPhone(client, phone);
    }

    if (targetPhone) {
      const existingEntry = await findExistingDirectoryEntry(
        client, accountId, targetPhone, null,
      );
      if (
        existingEntry &&
        existingEntry.name &&
        existingEntry.name.trim().toLowerCase() !==
          String(targetName || "").trim().toLowerCase()
      ) {
        await client.query("ROLLBACK");
        return fail(
          res,
          409,
          "phone_name_mismatch",
          `${targetPhone} is already in this property as "${existingEntry.name}" (${existingEntry.kind}). Use that name, or edit the existing entry.`,
        );
      }
    }

    const { rows } = await client.query(
      `INSERT INTO staff
         (account_id, user_id, role, monthly_salary,
          name, phone, photo_url,
          status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)
       RETURNING id`,
      [
        accountId, targetUserId, staffRole, monthly_salary,
        targetName, targetPhone, targetPhotoUrl, userId,
      ]);

    const staffId = rows[0].id;

    const { rows: joined } = await client.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              COALESCE(joined.name,      s.name)      AS name,
              COALESCE(joined.phone,     s.phone)     AS phone,
              COALESCE(joined.photo_url, s.photo_url) AS photo_url,
              (joined.user_id IS NOT NULL) AS has_access
         FROM staff s
         LEFT JOIN LATERAL (
           SELECT u.id AS user_id, u.name, u.phone, u.photo_url
             FROM account_members am
             JOIN users u ON u.id = am.user_id
            WHERE am.account_id = s.account_id
              AND am.status     = 'active'
              AND (
                (s.user_id IS NOT NULL AND am.user_id = s.user_id)
                OR (
                  s.user_id IS NULL
                  AND s.phone IS NOT NULL
                  AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone,''),'\\D','','g'),10)
                    = RIGHT(REGEXP_REPLACE(COALESCE(s.phone,''),'\\D','','g'),10)
                )
              )
            LIMIT 1
         ) joined ON TRUE
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
      `SELECT id, user_id, name, phone FROM staff
        WHERE id=$1 AND account_id=$2 AND status='active'`,
      [id, accountId]);
    if (!rows.length) return fail(res, 404, "not_found", "Staff not found");

    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can edit staff");
    }

    const hasName = Object.prototype.hasOwnProperty.call(req.body, "name");
    const hasPhone = Object.prototype.hasOwnProperty.call(req.body, "phone");
    const hasPhoto = Object.prototype.hasOwnProperty.call(req.body, "photo_url");

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
              s.name, s.phone, s.photo_url
         FROM staff s
        WHERE s.id = $1`,
      [id]);
    const beforeSnapshot = beforeRows[0] ?? null;

    if (hasPhone || hasName) {
      const effectivePhone = hasPhone ? newPhone : beforeSnapshot?.phone;
      const effectiveName = hasName ? newName : beforeSnapshot?.name;
      if (effectivePhone) {
        const existingEntry = await findExistingDirectoryEntry(
          client, accountId, effectivePhone, id,
        );
        if (
          existingEntry &&
          existingEntry.name &&
          existingEntry.name.trim().toLowerCase() !==
            String(effectiveName || "").trim().toLowerCase()
        ) {
          await client.query("ROLLBACK");
          return fail(
            res,
            409,
            "phone_name_mismatch",
            `${effectivePhone} is already in this property as "${existingEntry.name}" (${existingEntry.kind}). Use that name, or edit the existing entry.`,
          );
        }
      }
    }

    const setParts = [];
    const values = [];
    const push = (col, val) => {
      values.push(val);
      setParts.push(`${col} = $${values.length}`);
    };

    for (const key of Object.keys(updates)) push(key, updates[key]);
    if (hasName) push("name", newName);
    if (hasPhone) push("phone", newPhone);
    if (hasPhoto) push("photo_url", newPhoto);

    if (hasPhone) {
      const linkedUserId = await findUserIdByPhone(client, newPhone);
      push("user_id", linkedUserId);
    }

    if (setParts.length > 0) {
      values.push(id);
      values.push(accountId);
      await client.query(
        `UPDATE staff SET ${setParts.join(", ")}, updated_at = NOW()
          WHERE id = $${values.length - 1} AND account_id = $${values.length}`,
        values,
      );
    }

    const { rows: joined } = await client.query(
      `SELECT s.id, s.account_id, s.user_id, s.role,
              s.monthly_salary, s.status, s.created_by,
              s.created_at, s.updated_at,
              COALESCE(joined.name,      s.name)      AS name,
              COALESCE(joined.phone,     s.phone)     AS phone,
              COALESCE(joined.photo_url, s.photo_url) AS photo_url,
              (joined.user_id IS NOT NULL) AS has_access
         FROM staff s
         LEFT JOIN LATERAL (
           SELECT u.id AS user_id, u.name, u.phone, u.photo_url
             FROM account_members am
             JOIN users u ON u.id = am.user_id
            WHERE am.account_id = s.account_id
              AND am.status     = 'active'
              AND (
                (s.user_id IS NOT NULL AND am.user_id = s.user_id)
                OR (
                  s.user_id IS NULL
                  AND s.phone IS NOT NULL
                  AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone,''),'\\D','','g'),10)
                    = RIGHT(REGEXP_REPLACE(COALESCE(s.phone,''),'\\D','','g'),10)
                )
              )
            LIMIT 1
         ) joined ON TRUE
        WHERE s.id = $1`,
      [id]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId: joined[0].user_id,
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

    const { rows: existing } = await client.query(
      `SELECT s.user_id, s.name
         FROM staff s
        WHERE s.id = $1 AND s.account_id = $2 AND s.status = 'active'`,
      [id, accountId]);

    if (!existing.length) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Staff not found");
    }

    const targetUserId = existing[0].user_id ?? null;
    const targetName = existing[0].name ?? null;

    const updated = await client.query(
      `UPDATE staff SET status='inactive', updated_at=NOW()
        WHERE id=$1 AND account_id=$2 AND status='active'`,
      [id, accountId]);

    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Staff not found");
    }

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
      after: { status: "inactive", name: targetName },
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
// VEHICLES
// ===========================================================================

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
      return res.json({ found: false, vehicle_number: number });
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
      owner: shaped[0],
      matches: shaped,
    });
  } catch (err) {
    console.error("lookupVehicle error:", err);
    return fail(res, 500, "server_error", "Failed to look up vehicle");
  }
};

const checkVehicleConflict = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const raw =
      req.query?.number ?? req.query?.vehicle_number ?? "";
    const number = normalizeVehicleNumber(raw);
    if (!number || number.length < 5) {
      return fail(res, 400, "invalid_input", "Vehicle number is required");
    }

    const excludeId = req.query?.excludeId ? String(req.query.excludeId).trim() : null;
    const excludeType = req.query?.excludeType ? String(req.query.excludeType).trim() : null;

    const { rows: veh } = await pool.query(
      `SELECT id, owner_name, flat_number, wing
         FROM vehicles
        WHERE account_id = $1 AND vehicle_number = $2 AND status = 'active'
        LIMIT 1`,
      [accountId, number]);

    if (veh.length > 0) {
      const ownerName = veh[0].owner_name || "a resident";
      const flatLabel =
        veh[0].wing && veh[0].flat_number
          ? `${veh[0].wing} · ${veh[0].flat_number}`
          : veh[0].flat_number || "";
      return res.json({
        conflict: true,
        source: "registered",
        message: `${number} is registered to ${ownerName}${
          flatLabel ? ` (${flatLabel})` : ""
        }.`,
        ownerName,
        flatLabel,
      });
    }

    const { rows: auth } = await pool.query(
      `SELECT id, visitor_name, flat_number, wing, valid_until
         FROM gate_authorizations
        WHERE account_id = $1
          AND status = 'active'
          AND valid_until >= NOW()
          AND (
                vehicle_number = $2
             OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(vehicles) AS v
                   WHERE v->>'number' = $2
                )
          )
          AND ($3::uuid IS NULL OR id <> $3::uuid)
        ORDER BY valid_until DESC
        LIMIT 1`,
      [accountId, number, excludeType === "authorization" ? excludeId : null]);

    if (auth.length > 0) {
      const a = auth[0];
      const flatLabel =
        a.wing && a.flat_number ? `${a.wing} · ${a.flat_number}` : a.flat_number || "";
      const ownerName = a.visitor_name || "another resident";
      return res.json({
        conflict: true,
        source: "pass",
        message: `${number} is already on an active pass for ${ownerName}${
          flatLabel ? ` (${flatLabel})` : ""
        }.`,
        ownerName,
        flatLabel,
      });
    }

    const { rows: inv } = await pool.query(
      `SELECT id, guest_name, flat_number, wing, valid_until
         FROM gate_invites
        WHERE account_id = $1
          AND status = 'active'
          AND valid_until >= NOW()
          AND (
                vehicle_number = $2
             OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(vehicles) AS v
                   WHERE v->>'number' = $2
                )
          )
          AND ($3::uuid IS NULL OR id <> $3::uuid)
        ORDER BY valid_until DESC
        LIMIT 1`,
      [accountId, number, excludeType === "invite" ? excludeId : null]);

    if (inv.length > 0) {
      const i = inv[0];
      const flatLabel =
        i.wing && i.flat_number ? `${i.wing} · ${i.flat_number}` : i.flat_number || "";
      const ownerName = i.guest_name || "another resident";
      return res.json({
        conflict: true,
        source: "invite",
        message: `${number} is already on an active QR invite for ${ownerName}${
          flatLabel ? ` (${flatLabel})` : ""
        }.`,
        ownerName,
        flatLabel,
      });
    }

    return res.json({ conflict: false });
  } catch (err) {
    console.error("checkVehicleConflict error:", err);
    return fail(res, 500, "server_error", "Failed to check vehicle conflict");
  }
};

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
      body.vehicleNumber ?? body.vehicle_number ?? body.number ?? "");
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

    const { rows: existing } = await client.query(
      `SELECT id, status FROM vehicles
        WHERE account_id = $1 AND vehicle_number = $2`,
      [accountId, number]);

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
        [name, flatNumber, wing, phone, type, vehicleId]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO vehicles
           (account_id, member_id, user_id, vehicle_number,
            owner_name, flat_number, wing, owner_phone, vehicle_type,
            registered_by_guard, status, created_by)
         VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, TRUE, 'active', $8)
         RETURNING id`,
        [accountId, number, name, flatNumber, wing, phone, type, userId]);
      vehicleId = rows[0].id;
    }

    const { rows: memberMatch } = await client.query(
      `SELECT id, user_id FROM members
        WHERE account_id = $1
          AND flat_number = $2
          AND status = 'active'
          AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'\\D','','g'),10) = $3
        LIMIT 1`,
      [accountId, flatNumber, phone]);

    if (memberMatch.length > 0) {
      await client.query(
        `UPDATE vehicles SET member_id = $1, user_id = $2, updated_at = NOW()
          WHERE id = $3`,
        [memberMatch[0].id, memberMatch[0].user_id, vehicleId]);
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

// ===========================================================================
// GATE ENTRIES
// ===========================================================================

const createGateEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const body = req.body || {};
    const modeRaw = String(body.mode ?? "manual").toLowerCase().trim();
    const isPassScan = modeRaw === "pass_scan";

    if (isPassScan) {
      const inviteId = body.inviteId ?? body.invite_id ?? null;
      const code = body.code ? String(body.code).trim() : null;

      if (!inviteId && !code) {
        return fail(res, 400, "invalid_input",
          "inviteId or code is required for pass_scan");
      }

      if (code && !inviteId) {
        const { rows: inv } = await pool.query(
          `SELECT id FROM gate_invites WHERE code = $1 AND account_id = $2 LIMIT 1`,
          [code, accountId]);
        if (inv.length) {
          return res.json({
            mode: "pass_scan",
            kind: "invite",
            verified: true,
            inviteId: inv[0].id,
          });
        }
        return fail(res, 404, "not_found", "This code doesn't match any pass");
      }

      if (inviteId) {
        const { rows } = await pool.query(
          `SELECT id, guest_name, guest_phone, guest_count, vehicle_number,
                  vehicles, wing, flat_number, valid_from, valid_until,
                  code, status
             FROM gate_invites
            WHERE id = $1 AND account_id = $2 LIMIT 1`,
          [inviteId, accountId]);
        if (!rows.length) return fail(res, 404, "not_found", "Invite not found");

        const inv = rows[0];
        if (inv.status === "cancelled") {
          return fail(res, 410, "invite_cancelled", "This invite was cancelled");
        }
        const until = new Date(inv.valid_until);
        if (!isNaN(until.getTime()) && until.getTime() < Date.now()) {
          return res.json({ mode: "pass_scan", kind: "invite", verified: false, reason: "expired", invite: inv });
        }
        return res.json({
          mode: "pass_scan",
          kind: "invite",
          verified: true,
          invite: inv,
        });
      }
    }

    const number = normalizeVehicleNumber(
      body.vehicleNumber ?? body.vehicle_number ?? body.number ?? "");
    const directionRaw = String(body.direction ?? "in").toLowerCase().trim();
    const direction = directionRaw === "out" ? "out" : "in";

    const visitorTypeRaw = String(
      body.visitorType ?? body.visitor_type ?? "visitor",
    ).toLowerCase().trim();
    const visitorType = ["resident", "visitor", "invited_guest", "delivery", "cab", "service", "other"]
      .includes(visitorTypeRaw)
      ? visitorTypeRaw
      : "visitor";

    const visitorName = body.visitorName
      ? String(body.visitorName).trim()
      : body.visitor_name
        ? String(body.visitor_name).trim()
        : null;

    const visitorPhone = normalizePhone(
      body.visitorPhone ?? body.visitor_phone);

    const purpose = body.purpose ? String(body.purpose).trim().toLowerCase() : null;

    const vehicleTypeRaw = body.vehicleType ?? body.vehicle_type;
    const vehicleType = vehicleTypeRaw
      ? normalizeVehicleType(vehicleTypeRaw)
      : null;

    const autoApprove = body.autoApprove !== false && !body.requiresApproval;

    let guestsIn = normalizeGuestsGroup(body.guests);

    if (guestsIn.length === 0 && visitorName) {
      guestsIn = [
        {
          name: visitorName,
          phone: visitorPhone || null,
          vehicle: number
            ? { number, type: vehicleType || "car" }
            : null,
        },
      ];
    }

    if (guestsIn.length === 0 && Array.isArray(body.vehicles)) {
      const v0 = normalizeVehiclesPayloadInput(body.vehicles)[0];
      if (v0) {
        guestsIn = [{ name: "Unknown visitor", phone: null, vehicle: v0 }];
      }
    }

    const vehiclesIn = deriveVehicleList(guestsIn);

    const headGuest = guestsIn[0] || null;
    const headName = headGuest?.name || visitorName || null;
    const headPhone = headGuest?.phone || visitorPhone || null;
    const headVehicle = headGuest?.vehicle || null;

    const primaryVehicle = headVehicle?.number || number || "NO-VEHICLE";
    const primaryVehicleType = headVehicle?.type || vehicleType || null;

    let vehicleId = null;
    let memberId = null;
    let memberUserId = null;
    let ownerName = headName;
    let flatNumber = body.flatNumber ?? body.flat_number ?? null;
    let ownerPhone = headPhone;

    if (primaryVehicle && primaryVehicle !== "NO-VEHICLE") {
      const { rows } = await pool.query(
        `SELECT id, member_id, owner_name, flat_number, owner_phone
           FROM vehicles
          WHERE account_id = $1 AND vehicle_number = $2 AND status = 'active'
          LIMIT 1`,
        [accountId, primaryVehicle]);
      if (rows.length > 0) {
        vehicleId = rows[0].id;
        memberId = rows[0].member_id;
        ownerName = ownerName || rows[0].owner_name;
        flatNumber = flatNumber || rows[0].flat_number;
        ownerPhone = ownerPhone || rows[0].owner_phone;
      }
    }

    if (!memberId && flatNumber) {
      const { rows: mm } = await pool.query(
        `SELECT m.id, m.user_id
           FROM members m
          WHERE m.account_id = $1
            AND m.flat_number = $2
            AND ($3::text IS NULL OR m.wing = $3)
            AND m.status = 'active'
          LIMIT 1`,
        [accountId, flatNumber, body.wing ?? body.wing_number ?? null]);
      if (mm.length > 0) {
        memberId = mm[0].id;
        memberUserId = mm[0].user_id;
      }
    } else if (memberId) {
      const { rows: m } = await pool.query(
        `SELECT user_id FROM members WHERE id = $1 LIMIT 1`,
        [memberId]);
      if (m.length > 0) memberUserId = m[0].user_id;
    }

    const status = autoApprove ? "auto_approved" : "pending_approval";

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO gate_entries
         (account_id, vehicle_number, vehicle_id, member_id,
          owner_name, flat_number, owner_phone, registered, direction, scanned_by,
          visitor_type, visitor_name, visitor_phone, purpose, vehicle_type,
          invite_id, authorization_id, rejected, notified, status,
          guests, vehicles, scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21::jsonb, $22::jsonb, NOW())
       RETURNING id, scanned_at, status`,
      [
        accountId,
        primaryVehicle,
        vehicleId,
        memberId,
        ownerName,
        flatNumber,
        ownerPhone,
        false,
        direction,
        userId,
        visitorType,
        headName,
        headPhone,
        purpose,
        primaryVehicleType,
        null,
        null,
        false,
        false,
        status,
        JSON.stringify(guestsIn),
        JSON.stringify(vehiclesIn),
      ]);

    const entryId = rows[0].id;

    if (memberUserId) {
      const total = guestsIn.length;
      const vehicleCount = vehiclesIn.length;

      const guestLabel =
        total === 0
          ? "A visitor"
          : total === 1
            ? headName || "A visitor"
            : `${headName || "A visitor"} + ${total - 1} more`;

      const vehicleLabel =
        vehicleCount === 0
          ? ""
          : vehicleCount === 1
            ? ` (vehicle ${vehiclesIn[0].number})`
            : ` (${vehicleCount} vehicles)`;

      const flatLabel = flatNumber
        ? (body.wing ? `${body.wing} · ${flatNumber}` : flatNumber)
        : "your flat";

      const title = autoApprove
        ? "Visitor allowed by guard"
        : total <= 1
          ? "Visitor at gate"
          : "Group at gate";

      const bodyText = autoApprove
        ? `${guestLabel}${vehicleLabel} is entering ${flatLabel}.`
        : `${guestLabel}${vehicleLabel} is at the gate for ${flatLabel}. Tap to allow or deny.`;

      try {
        await notifyMemberForGate(memberUserId, {
          title,
          body: bodyText,
          entryId,
          accountId,
          visitorName: headName,
          vehicleNumber: primaryVehicle,
          flatNumber,
          guestCount: total || 1,
          vehicles: vehiclesIn.map((v) => v.number),
        });
        await client.query(
          `UPDATE gate_entries SET notified = TRUE WHERE id = $1`,
          [entryId]);
      } catch (e) {
        console.warn("[gate] notify failed:", e.message);
      }
    }

    await client.query("COMMIT");

    return res.status(201).json({
      mode: "manual",
      success: true,
      entry_id: entryId,
      scanned_at: rows[0].scanned_at,
      status: rows[0].status,
      vehicle_number: primaryVehicle,
      direction,
      guest_count: guestsIn.length,
      vehicle_count: vehiclesIn.length,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createGateEntry error:", err);
    return fail(res, 500, "server_error", "Failed to log gate entry");
  } finally {
    client.release();
  }
};

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

    const dateRaw = req.query?.date ? String(req.query.date).trim() : null;
    const useDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw);

    const VALID_STATUSES = new Set([
      "auto_approved",
      "invite_approved",
      "pass_approved",
      "pending_approval",
      "approved",
      "approved_by_guard_override",
      "rejected",
    ]);
    const statusRaw = req.query?.status ? String(req.query.status).trim() : null;
    const useStatus = statusRaw && VALID_STATUSES.has(statusRaw);

    const flatRaw = req.query?.flatNumber ? String(req.query.flatNumber).trim() : null;
    const wingRaw = req.query?.wing ? String(req.query.wing).trim() : null;

    const params = [accountId];
    const conditions = [`account_id = $1`];

    if (useStatus) {
      params.push(statusRaw);
      conditions.push(`status = $${params.length}`);
    }

    if (useDate) {
      params.push(dateRaw);
      conditions.push(
        `(
           CASE
             WHEN pg_typeof(scanned_at) = 'timestamp with time zone'::regtype
               THEN (scanned_at AT TIME ZONE 'Asia/Kolkata')::date
             ELSE
               (scanned_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
           END
         ) = $${params.length}::date`);
    } else if (!useStatus) {
      conditions.push(
        `(
           CASE
             WHEN pg_typeof(scanned_at) = 'timestamp with time zone'::regtype
               THEN (scanned_at AT TIME ZONE 'Asia/Kolkata')::date
             ELSE
               (scanned_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
           END
         ) = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`);
    }

    if (flatRaw) {
      params.push(flatRaw);
      conditions.push(`flat_number = $${params.length}`);
    }

    if (wingRaw) {
      params.push(wingRaw);
      conditions.push(`wing = $${params.length}`);
    }

    params.push(limit);
    const limitIdx = params.length;

    const { rows } = await pool.query(
      `SELECT id, vehicle_number, vehicle_id, member_id,
              owner_name, flat_number, owner_phone,
              registered, direction, scanned_by, scanned_at,
              visitor_type, visitor_name, visitor_phone, purpose,
              vehicle_type, invite_id, authorization_id,
              rejected, notified, status,
              guests, vehicles
         FROM gate_entries
        WHERE ${conditions.join(" AND ")}
        ORDER BY scanned_at DESC
        LIMIT $${limitIdx}`,
      params);

    return res.json(rows);
  } catch (err) {
    console.error("listGateEntries error:", err);
    return fail(res, 500, "server_error", "Failed to load gate entries");
  }
};

const INVITE_EDIT_WINDOW_MS = 5 * 60 * 1000;
const VALID_PURPOSES = new Set(["guest", "delivery", "cab", "service", "other"]);

const updateGateEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) {
      return fail(res, 403, "no_account_access",
        "You no longer have access to this account");
    }

    const { rows: entryRows } = await client.query(
      `SELECT id, invite_id, authorization_id, status, rejected,
              scanned_by, scanned_at, visitor_name, member_id
         FROM gate_entries
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]);
    if (!entryRows.length) return fail(res, 404, "not_found", "Entry not found");

    const entry = entryRows[0];
    const isInvited = !!(entry.invite_id || entry.authorization_id);
    const body = req.body || {};

    if (isInvited) {
      const nextStatus = String(body.status ?? "").toLowerCase().trim();
      if (nextStatus !== "approved" && nextStatus !== "rejected") {
        return fail(res, 400, "invalid_input",
          "Invited entries can only be approved or rejected");
      }

      const scannedAt = new Date(entry.scanned_at).getTime();
      if (!Number.isFinite(scannedAt) ||
          Date.now() - scannedAt > INVITE_EDIT_WINDOW_MS) {
        return fail(res, 410, "edit_window_expired",
          "The 5-minute action window has expired.");
      }

      if (entry.status !== "pending_approval") {
        return fail(res, 409, "invalid_state",
          `This entry is already ${String(entry.status).replace(/_/g, " ")}`);
      }

      await client.query("BEGIN");

      await client.query(
        `UPDATE gate_entries
            SET status = $1,
                rejected = $2,
                approved_by = $3,
                approved_at = NOW(),
                responded_at = NOW()
          WHERE id = $4 AND account_id = $5`,
        [nextStatus, nextStatus === "rejected", userId, id, accountId]);

      await writeAudit(client, {
        accountId,
        actorUserId: userId,
        actorRole: role,
        entityType: "gate_entry",
        entityId: id,
        action: nextStatus === "approved" ? "gate_approved" : "gate_rejected",
        after: { status: nextStatus },
        metadata: { via: "guard_edit" },
        visibility: "participants",
      });

      await client.query("COMMIT");

      if (entry.scanned_by && entry.scanned_by !== userId) {
        try {
          await sendGateNotification([entry.scanned_by], {
            title: nextStatus === "approved" ? "Entry approved" : "Entry rejected",
            body: `${entry.visitor_name || "Visitor"} was ${
              nextStatus === "approved" ? "allowed in" : "denied entry"
            }.`,
            data: {
              type: "gate_status",
              entryId: id,
              accountId,
              status: nextStatus,
            },
          });
        } catch (e) {
          console.warn("[gate] guard notify failed:", e.message);
        }
      }

      return res.json({ success: true, status: nextStatus });
    }

    const hasDirection = Object.prototype.hasOwnProperty.call(body, "direction");
    const hasWing = Object.prototype.hasOwnProperty.call(body, "wing");
    const hasFlat =
      Object.prototype.hasOwnProperty.call(body, "flatNumber") ||
      Object.prototype.hasOwnProperty.call(body, "flat_number");
    const hasPurpose = Object.prototype.hasOwnProperty.call(body, "purpose");
    const hasGuests = Object.prototype.hasOwnProperty.call(body, "guests");
    const hasVisitorName =
      Object.prototype.hasOwnProperty.call(body, "visitor_name") ||
      Object.prototype.hasOwnProperty.call(body, "visitorName");
    const hasVisitorPhone =
      Object.prototype.hasOwnProperty.call(body, "visitor_phone") ||
      Object.prototype.hasOwnProperty.call(body, "visitorPhone");

    if (!hasDirection && !hasWing && !hasFlat && !hasPurpose &&
        !hasGuests && !hasVisitorName && !hasVisitorPhone) {
      return fail(res, 400, "invalid_input", "No editable fields provided");
    }

    let newFlat;
    if (hasFlat) {
      newFlat = String(body.flatNumber ?? body.flat_number ?? "").trim();
      if (!newFlat) {
        return fail(res, 400, "invalid_input", "Flat number cannot be empty");
      }
    }

    let newWing;
    if (hasWing) {
      const w = body.wing;
      newWing = w == null || String(w).trim() === "" ? null : String(w).trim();
    }

    let newDirection;
    if (hasDirection) {
      newDirection = String(body.direction ?? "in").toLowerCase() === "out"
        ? "out" : "in";
    }

    let newPurpose;
    if (hasPurpose) {
      if (body.purpose == null || String(body.purpose).trim() === "") {
        newPurpose = null;
      } else {
        const p = String(body.purpose).trim().toLowerCase();
        if (!VALID_PURPOSES.has(p)) {
          return fail(res, 400, "invalid_input", "Invalid purpose");
        }
        newPurpose = p;
      }
    }

    let newVisitorName;
    if (hasVisitorName) {
      newVisitorName = String(body.visitor_name ?? body.visitorName ?? "").trim();
      if (!newVisitorName) {
        return fail(res, 400, "invalid_input", "Visitor name cannot be empty");
      }
      if (newVisitorName.length > 200) {
        return fail(res, 400, "invalid_input", "Visitor name is too long");
      }
    }

    let newVisitorPhone;
    if (hasVisitorPhone) {
      const raw = body.visitor_phone ?? body.visitorPhone;
      newVisitorPhone = raw == null || String(raw).trim() === ""
        ? null
        : normalizePhone(raw);
    }

    let guestsIn = null;
    if (hasGuests) {
      guestsIn = normalizeGuestsGroup(body.guests);
      if (guestsIn.length === 0) {
        return fail(res, 400, "invalid_input",
          "At least one guest name is required");
      }
    }

    await client.query("BEGIN");

    const sets = [];
    const values = [];
    const push = (col, val) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };

    if (hasDirection) push("direction", newDirection);
    if (hasPurpose) push("purpose", newPurpose);
    if (hasWing) push("wing", newWing);
    if (hasFlat) push("flat_number", newFlat);

    if (hasVisitorName && !guestsIn) {
      push("visitor_name", newVisitorName);
      push("owner_name", newVisitorName);
    }
    if (hasVisitorPhone && !guestsIn) {
      push("visitor_phone", newVisitorPhone);
    }

    if (guestsIn) {
      const head = guestsIn[0] || null;
      const vehiclesList = deriveVehicleList(guestsIn);

      const primaryVehicle =
        head?.vehicle?.number ||
        (vehiclesList[0]?.number ?? "NO-VEHICLE");
      const primaryVehicleType =
        head?.vehicle?.type || vehiclesList[0]?.type || null;

      let vehicleId = null;
      let memberId = null;
      let ownerName = head?.name ?? newVisitorName ?? null;
      let ownerPhone = head?.phone ?? newVisitorPhone ?? null;

      if (primaryVehicle && primaryVehicle !== "NO-VEHICLE") {
        const { rows: vrows } = await client.query(
          `SELECT id, member_id, owner_name, flat_number, owner_phone
             FROM vehicles
            WHERE account_id = $1 AND vehicle_number = $2 AND status = 'active'
            LIMIT 1`,
          [accountId, primaryVehicle]);
        if (vrows.length) {
          vehicleId = vrows[0].id;
          memberId = vrows[0].member_id;
          ownerName = ownerName || vrows[0].owner_name;
          ownerPhone = ownerPhone || vrows[0].owner_phone;
        }
      }

      const flatForLookup = hasFlat ? newFlat : null;
      if (!memberId && flatForLookup) {
        const wingForLookup = hasWing ? newWing : null;
        const { rows: mm } = await client.query(
          `SELECT id, user_id
             FROM members
            WHERE account_id = $1
              AND flat_number = $2
              AND ($3::text IS NULL OR wing = $3)
              AND status = 'active'
            LIMIT 1`,
          [accountId, flatForLookup, wingForLookup]);
        if (mm.length) memberId = mm[0].id;
      }

      push("guests", JSON.stringify(guestsIn));
      push("vehicles", JSON.stringify(vehiclesList));
      push("visitor_name", head?.name ?? newVisitorName ?? null);
      push("visitor_phone", head?.phone ?? newVisitorPhone ?? null);
      push("owner_name", ownerName);
      push("owner_phone", ownerPhone);
      push("vehicle_number", primaryVehicle);
      push("vehicle_type", primaryVehicleType);
      push("vehicle_id", vehicleId);
      push("member_id", memberId);
    }

    if (sets.length === 0) {
      await client.query("ROLLBACK");
      return fail(res, 400, "invalid_input", "No editable fields provided");
    }

    values.push(id);
    values.push(accountId);

    const { rows: updated } = await client.query(
      `UPDATE gate_entries
          SET ${sets.join(", ")}
        WHERE id = $${values.length - 1} AND account_id = $${values.length}
        RETURNING *`,
      values);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_entry",
      entityId: id,
      action: "update",
      after: updated[0],
      metadata: {
        via: "guard_edit",
        fields: sets.map((s) => s.split(" ")[0]),
      },
      visibility: "participants",
    });

    await client.query("COMMIT");
    return res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateGateEntry error:", err);
    return fail(res, 500, "server_error", "Failed to update gate entry");
  } finally {
    client.release();
  }
};

const approveGateEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows: entryRows } = await client.query(
      `SELECT ge.id, ge.member_id, ge.status, ge.scanned_by,
              ge.visitor_name, ge.flat_number,
              m.user_id AS member_user_id
         FROM gate_entries ge
         LEFT JOIN members m ON m.id = ge.member_id
        WHERE ge.id = $1 AND ge.account_id = $2`,
      [id, accountId]);
    if (!entryRows.length) return fail(res, 404, "not_found", "Entry not found");

    const entry = entryRows[0];
    const isPrivileged = role === "owner" || role === "admin";
    const isTarget = entry.member_user_id === userId;

    if (!isPrivileged && !isTarget) {
      return fail(res, 403, "forbidden", "You can only approve entries for your own flat");
    }
    if (entry.status !== "pending_approval") {
      return fail(res, 409, "invalid_state",
        `This entry is already ${entry.status.replace(/_/g, " ")}`);
    }

    await client.query("BEGIN");

    await client.query(
      `UPDATE gate_entries
          SET status = 'approved',
              approved_by = $1,
              approved_at = NOW(),
              responded_at = NOW()
        WHERE id = $2 AND account_id = $3`,
      [userId, id, accountId]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_entry",
      entityId: id,
      action: "gate_approved",
      after: { status: "approved" },
      visibility: "participants",
    });

    await client.query("COMMIT");

    if (entry.scanned_by) {
      try {
        await sendGateNotification([entry.scanned_by], {
          title: "Entry approved",
          body: `${entry.visitor_name || "Visitor"} was allowed in by the resident.`,
          data: {
            type: "gate_status",
            entryId: id,
            accountId,
            status: "approved",
          },
        });
      } catch (e) {
        console.warn("[gate] guard notify failed:", e.message);
      }
    }

    return res.json({ success: true, status: "approved" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("approveGateEntry error:", err);
    return fail(res, 500, "server_error", "Failed to approve entry");
  } finally {
    client.release();
  }
};

const rejectGateEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows: entryRows } = await client.query(
      `SELECT ge.id, ge.member_id, ge.status, ge.scanned_by,
              ge.visitor_name, ge.flat_number,
              m.user_id AS member_user_id
         FROM gate_entries ge
         LEFT JOIN members m ON m.id = ge.member_id
        WHERE ge.id = $1 AND ge.account_id = $2`,
      [id, accountId]);
    if (!entryRows.length) return fail(res, 404, "not_found", "Entry not found");

    const entry = entryRows[0];
    const isPrivileged = role === "owner" || role === "admin";
    const isTarget = entry.member_user_id === userId;

    if (!isPrivileged && !isTarget) {
      return fail(res, 403, "forbidden", "You can only reject entries for your own flat");
    }
    if (entry.status !== "pending_approval") {
      return fail(res, 409, "invalid_state",
        `This entry is already ${entry.status.replace(/_/g, " ")}`);
    }

    await client.query("BEGIN");

    await client.query(
      `UPDATE gate_entries
          SET status = 'rejected',
              rejected = TRUE,
              approved_by = $1,
              approved_at = NOW(),
              responded_at = NOW()
        WHERE id = $2 AND account_id = $3`,
      [userId, id, accountId]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_entry",
      entityId: id,
      action: "gate_rejected",
      after: { status: "rejected" },
      visibility: "participants",
    });

    await client.query("COMMIT");

    if (entry.scanned_by) {
      try {
        await sendGateNotification([entry.scanned_by], {
          title: "Entry rejected",
          body: `${entry.visitor_name || "Visitor"} was denied entry by the resident.`,
          data: {
            type: "gate_status",
            entryId: id,
            accountId,
            status: "rejected",
          },
        });
      } catch (e) {
        console.warn("[gate] guard notify failed:", e.message);
      }
    }

    return res.json({ success: true, status: "rejected" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("rejectGateEntry error:", err);
    return fail(res, 500, "server_error", "Failed to reject entry");
  } finally {
    client.release();
  }
};

const overrideGateEntry = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows: entryRows } = await client.query(
      `SELECT id, status, scanned_by, visitor_name FROM gate_entries
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]);
    if (!entryRows.length) return fail(res, 404, "not_found", "Entry not found");
    if (entryRows[0].status !== "pending_approval") {
      return fail(res, 409, "invalid_state",
        `This entry is already ${entryRows[0].status.replace(/_/g, " ")}`);
    }

    await client.query("BEGIN");

    await client.query(
      `UPDATE gate_entries
          SET status = 'approved_by_guard_override',
              approved_by = $1,
              approved_at = NOW(),
              responded_at = NOW()
        WHERE id = $2 AND account_id = $3`,
      [userId, id, accountId]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_entry",
      entityId: id,
      action: "gate_guard_override",
      after: { status: "approved_by_guard_override" },
      visibility: "participants",
    });

    await client.query("COMMIT");

    return res.json({ success: true, status: "approved_by_guard_override" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("overrideGateEntry error:", err);
    return fail(res, 500, "server_error", "Failed to override entry");
  } finally {
    client.release();
  }
};

const getGateEntryStatus = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows } = await pool.query(
      `SELECT id, status, approved_at, responded_at
         FROM gate_entries
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]);
    if (!rows.length) return fail(res, 404, "not_found", "Entry not found");

    return res.json(rows[0]);
  } catch (err) {
    console.error("getGateEntryStatus error:", err);
    return fail(res, 500, "server_error", "Failed to load entry status");
  }
};

// ===========================================================================
// GATE FLATS
// ===========================================================================

const listGateFlats = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const q = String(req.query?.q ?? "").trim();
    const pattern = q ? `%${q}%` : null;

    const { rows } = await pool.query(
      `SELECT m.id::text AS member_id,
              m.wing,
              m.flat_number,
              COALESCE(u.name,  m.name)  AS resident_name,
              COALESCE(u.phone, m.phone) AS resident_phone
         FROM members m
         LEFT JOIN LATERAL (
           SELECT uu.name, uu.phone
             FROM account_members am
             JOIN users uu ON uu.id = am.user_id
            WHERE am.account_id = m.account_id
              AND am.status     = 'active'
              AND (
                (m.user_id IS NOT NULL AND am.user_id = m.user_id)
                OR (
                  m.user_id IS NULL
                  AND m.phone IS NOT NULL
                  AND RIGHT(REGEXP_REPLACE(COALESCE(uu.phone,''),'\\D','','g'),10)
                    = RIGHT(REGEXP_REPLACE(COALESCE(m.phone,''),'\\D','','g'),10)
                )
              )
            LIMIT 1
         ) u ON TRUE
        WHERE m.account_id = $1
          AND m.status = 'active'
          AND ($2::text IS NULL
               OR m.name ILIKE $2
               OR u.name ILIKE $2
               OR m.flat_number ILIKE $2
               OR m.wing ILIKE $2)
        ORDER BY m.wing NULLS FIRST, m.flat_number, COALESCE(u.name, m.name)`,
      [accountId, pattern]);

    return res.json(rows);
  } catch (err) {
    console.error("listGateFlats error:", err);
    return fail(res, 500, "server_error", "Failed to load flats");
  }
};

// ===========================================================================
// GATE PASSES search
// ===========================================================================

const searchGatePasses = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const q = String(req.query?.q ?? "").trim();
    const flatNumberParam = req.query?.flatNumber
      ? String(req.query.flatNumber).trim()
      : null;
    const wingParam = req.query?.wing
      ? String(req.query.wing).trim()
      : null;

    if (!flatNumberParam && q.length < 2) {
      return fail(res, 400, "invalid_input", "Enter at least 2 characters");
    }

    const pattern = `%${q || ""}%`;
    const digits = (q || "").replace(/\D/g, "");
    const phonePattern = digits.length >= 3 ? `%${digits}%` : pattern;

    const { rows: authRows } = await pool.query(
      `SELECT ga.id::text AS id,
              'authorization'::text AS kind,
              ga.category AS purpose,
              ga.pass_mode,
              ga.visitor_name,
              ga.visitor_phone,
              ga.vehicle_number,
              ga.vehicles,
              ga.guest_count,
              ga.wing,
              ga.flat_number,
              ga.valid_from,
              ga.valid_until,
              ga.status,
              NULL::text AS code,
              ga.created_at,
              COALESCE(m.user_id, m2.user_id) AS member_user_id,
              COALESCE(m.name, m2.name)       AS member_name,
              COALESCE(m.phone, m2.phone)     AS member_phone,
              (SELECT COUNT(*)::int FROM gate_entries ge
                 WHERE ge.account_id = ga.account_id
                   AND ge.authorization_id = ga.id
                   AND ge.status <> 'rejected'
                   AND ge.status <> 'pending_approval') AS used_count
         FROM gate_authorizations ga
         LEFT JOIN members m ON m.id = ga.member_id
         LEFT JOIN members m2
                ON ga.member_id IS NULL
               AND m2.account_id = ga.account_id
               AND m2.flat_number = ga.flat_number
               AND (ga.wing IS NULL OR m2.wing = ga.wing OR m2.wing IS NULL)
               AND m2.status = 'active'
        WHERE ga.account_id = $1
          AND ga.status IN ('active', 'used', 'approved')
          AND ga.valid_until >= NOW()
          AND (
                COALESCE(m.name, m2.name) ILIKE $2
             OR COALESCE(m.phone, m2.phone) ILIKE $3
             OR ga.flat_number ILIKE $2
             OR ga.visitor_name ILIKE $2
          )
          AND ($4::text IS NULL OR ga.flat_number = $4)
          AND (
                $5::text IS NULL
             OR ga.wing = $5
             OR ga.wing IS NULL
             OR TRIM(ga.wing) = ''
             OR ga.wing ILIKE $5 || '%'
          )
        ORDER BY ga.valid_until ASC
        LIMIT 30`,
      [accountId, pattern, phonePattern, flatNumberParam, wingParam]);

    const { rows: invRows } = await pool.query(
      `SELECT gi.id::text AS id,
              'invite'::text AS kind,
              gi.purpose,
              NULL::text AS pass_mode,
              gi.guest_name   AS visitor_name,
              gi.guest_phone  AS visitor_phone,
              gi.vehicle_number,
              gi.vehicles,
              gi.guest_count,
              gi.wing,
              gi.flat_number,
              gi.valid_from,
              gi.valid_until,
              gi.status,
              gi.code,
              gi.created_at,
              COALESCE(m.user_id, m2.user_id) AS member_user_id,
              COALESCE(m.name, m2.name)       AS member_name,
              COALESCE(m.phone, m2.phone)     AS member_phone,
              (SELECT COUNT(*)::int FROM gate_entries ge
                 WHERE ge.account_id = gi.account_id
                   AND ge.invite_id = gi.id
                   AND ge.status <> 'rejected'
                   AND ge.status <> 'pending_approval') AS used_count
         FROM gate_invites gi
         LEFT JOIN members m ON m.id = gi.member_id
         LEFT JOIN members m2
                ON gi.member_id IS NULL
               AND m2.account_id = gi.account_id
               AND m2.flat_number = gi.flat_number
               AND (gi.wing IS NULL OR m2.wing = gi.wing OR m2.wing IS NULL)
               AND m2.status = 'active'
        WHERE gi.account_id = $1
          AND gi.status IN ('active', 'used', 'approved')
          AND gi.valid_until >= NOW()
          AND (
                COALESCE(m.name, m2.name) ILIKE $2
             OR COALESCE(m.phone, m2.phone) ILIKE $3
             OR gi.flat_number ILIKE $2
             OR gi.guest_name ILIKE $2
          )
          AND ($4::text IS NULL OR gi.flat_number = $4)
          AND (
                $5::text IS NULL
             OR gi.wing = $5
             OR gi.wing IS NULL
             OR TRIM(gi.wing) = ''
             OR gi.wing ILIKE $5 || '%'
          )
        ORDER BY gi.valid_until ASC
        LIMIT 30`,
      [accountId, pattern, phonePattern, flatNumberParam, wingParam]);

    const all = [...authRows, ...invRows].sort((a, b) => {
      const at = new Date(a.valid_until).getTime();
      const bt = new Date(b.valid_until).getTime();
      return at - bt;
    });

    return res.json(all);
  } catch (err) {
    console.error("searchGatePasses error:", err);
    return fail(
      res,
      500,
      "server_error",
      `Failed to search passes: ${err.message || err.toString()}`,
    );
  }
};

const getPassHistory = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, kind, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    if (kind !== "invite" && kind !== "authorization") {
      return fail(res, 400, "invalid_input", "kind must be invite or authorization");
    }

    const col = kind === "invite" ? "invite_id" : "authorization_id";
    const { rows } = await pool.query(
      `SELECT id, visitor_name, visitor_phone, vehicle_number, direction,
              status, rejected, scanned_at, guests, vehicles, purpose
         FROM gate_entries
        WHERE account_id = $1 AND ${col} = $2
        ORDER BY scanned_at DESC
        LIMIT 200`,
      [accountId, id]);
    return res.json(rows);
  } catch (err) {
    console.error("getPassHistory error:", err);
    return fail(res, 500, "server_error", "Failed to load history");
  }
};

const logPassAction = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const body = req.body || {};
    const kindRaw = String(body.kind ?? "").toLowerCase().trim();
    const passId = String(body.passId ?? "").trim();
    const action = String(body.action ?? "").toLowerCase().trim();

    if (!passId) return fail(res, 400, "invalid_input", "passId is required");
    if (action !== "in" && action !== "reject") {
      return fail(res, 400, "invalid_input", "action must be in or reject");
    }

    const order =
      kindRaw === "invite"
        ? ["gate_invites", "gate_authorizations"]
        : kindRaw === "authorization"
          ? ["gate_authorizations", "gate_invites"]
          : ["gate_invites", "gate_authorizations"];

    let pass = null;
    let foundTable = null;
    for (const t of order) {
      const { rows } = await client.query(
        `SELECT * FROM ${t} WHERE id = $1 AND account_id = $2 LIMIT 1`,
        [passId, accountId]);
      if (rows.length) {
        pass = rows[0];
        foundTable = t;
        break;
      }
    }

    if (!pass) {
      return fail(
        res,
        404,
        "not_found",
        `Pass not found (kind=${kindRaw || "unknown"}, id=${passId})`);
    }

    if (pass.status === "cancelled") {
      return fail(res, 410, "pass_cancelled", "This pass has been cancelled");
    }

    const isInvite = foundTable === "gate_invites";
    const visitorName = isInvite ? pass.guest_name : pass.visitor_name;
    const visitorPhone = isInvite ? pass.guest_phone : pass.visitor_phone;
    const purpose = isInvite ? pass.purpose : pass.category;

    const vehiclesArr =
      Array.isArray(pass.vehicles) && pass.vehicles.length
        ? pass.vehicles
        : pass.vehicle_number
          ? [{ number: pass.vehicle_number, type: "car" }]
          : [];

    const primaryVehicle =
      vehiclesArr[0]?.number || pass.vehicle_number || "NO-VEHICLE";
    const primaryType = vehiclesArr[0]?.type || null;

    let memberId = pass.member_id || null;
    if (!memberId && pass.flat_number) {
      const { rows: mm } = await client.query(
        `SELECT id FROM members
          WHERE account_id = $1
            AND flat_number = $2
            AND ($3::text IS NULL OR wing = $3)
            AND status = 'active'
          LIMIT 1`,
        [accountId, pass.flat_number, pass.wing ?? null]);
      if (mm.length) memberId = mm[0].id;
    }

    let vehicleId = null;
    if (primaryVehicle && primaryVehicle !== "NO-VEHICLE") {
      const { rows: v } = await client.query(
        `SELECT id FROM vehicles
          WHERE account_id = $1 AND vehicle_number = $2 AND status = 'active'
          LIMIT 1`,
        [accountId, primaryVehicle]);
      if (v.length) vehicleId = v[0].id;
    }

    const rejected = action === "reject";
    const status = rejected ? "rejected" : "invite_approved";

    const guestsJson = [
      {
        name: visitorName || "Guest",
        phone: visitorPhone || null,
        vehicle: vehiclesArr[0]
          ? { number: vehiclesArr[0].number, type: vehiclesArr[0].type || "car" }
          : null,
      },
    ];

    await client.query("BEGIN");

    const { rows: inserted } = await client.query(
      `INSERT INTO gate_entries
         (account_id, vehicle_number, vehicle_id, member_id,
          owner_name, flat_number, owner_phone, registered, direction, scanned_by,
          visitor_type, visitor_name, visitor_phone, purpose, vehicle_type,
          invite_id, authorization_id, rejected, notified, status,
          guests, vehicles, scanned_at,
          approved_by, approved_at, responded_at)
       VALUES ($1,$2,$3,$4,
               $5,$6,$7,$8,$9,$10,
               $11,$12,$13,$14,$15,
               $16,$17,$18,$19,$20,
               $21::jsonb, $22::jsonb, NOW(),
               $23, NOW(), NOW())
       RETURNING id, scanned_at, status`,
      [
        accountId,
        primaryVehicle,
        vehicleId,
        memberId,
        visitorName,
        pass.flat_number || null,
        visitorPhone || null,
        false,
        "in",
        userId,
        isInvite ? "invited_guest" : "visitor",
        visitorName || null,
        visitorPhone || null,
        purpose || null,
        primaryType,
        isInvite ? passId : null,
        isInvite ? null : passId,
        rejected,
        false,
        status,
        JSON.stringify(guestsJson),
        JSON.stringify(vehiclesArr),
        userId,
      ]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_entry",
      entityId: inserted[0].id,
      action: rejected ? "gate_rejected" : "gate_approved",
      after: { status },
      metadata: {
        via: "guard_pass_search",
        kind: isInvite ? "invite" : "authorization",
        passId,
      },
      visibility: "participants",
    });

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      entry_id: inserted[0].id,
      status: inserted[0].status,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("logPassAction error:", err);
    return fail(res, 500, "server_error", "Failed to log pass action");
  } finally {
    client.release();
  }
};

// ===========================================================================
// GATE AUTHORIZATIONS
// ===========================================================================

const OPEN_CATEGORIES = new Set(["delivery", "cab", "service", "other"]);

const createAuthorization = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const body = req.body || {};
    const category = String(body.category ?? "").toLowerCase().trim();
    const validCategories = ["delivery", "helper", "guest", "cab", "service", "other"];
    if (!validCategories.includes(category)) {
      return fail(res, 400, "invalid_input", "Invalid category");
    }

    const passMode = OPEN_CATEGORIES.has(category) ? "open" : "named";

    const memberId = body.memberId ?? body.member_id ?? null;
    const wing = body.wing ? String(body.wing).trim() : null;
    const flatNumber = String(body.flatNumber ?? body.flat_number ?? "").trim();
    if (!flatNumber) return fail(res, 400, "invalid_input", "Flat number is required");

    let visitorName = body.visitorName ? String(body.visitorName).trim() : null;
    if (passMode === "named" && !visitorName) {
      return fail(res, 400, "invalid_input",
        "Visitor name is required for this category");
    }
    if (visitorName && visitorName.length > 200) {
      return fail(res, 400, "invalid_input", "Visitor name is too long");
    }

    const visitorPhone = normalizePhone(body.visitorPhone);

    let vehiclesIn = normalizeVehiclesPayloadInput(body.vehicles);

    if (vehiclesIn.length === 0) {
      const legacy = normalizeVehicleNumber(
        body.vehicleNumber ?? body.vehicle_number ?? "");
      if (legacy && legacy.length >= 5 && legacy.length <= 15) {
        vehiclesIn = [{ number: legacy, type: "car" }];
      }
    }

    const primaryVehicle = vehiclesIn[0]?.number ?? null;

    const validFromRaw = body.validFrom ?? body.valid_from ?? null;
    const validUntilRaw = body.validUntil ?? body.valid_until ?? null;
    if (!validUntilRaw) return fail(res, 400, "invalid_input", "validUntil is required");

    const validFrom = validFromRaw ? new Date(validFromRaw) : new Date();
    const validUntil = new Date(validUntilRaw);
    if (isNaN(validFrom.getTime()) || isNaN(validUntil.getTime())) {
      return fail(res, 400, "invalid_input", "Invalid validity window");
    }

    const guestCountRaw = Number(body.guestCount ?? body.guest_count ?? 1);
    const guestCount = Number.isFinite(guestCountRaw)
      ? Math.max(1, Math.min(20, Math.trunc(guestCountRaw)))
      : 1;

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO gate_authorizations
         (account_id, member_id, wing, flat_number, created_by,
          category, pass_mode, visitor_name, visitor_phone, vehicle_number,
          vehicles,
          guest_count, valid_from, valid_until, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               $11::jsonb,
               $12,$13,$14,'active')
       RETURNING *`,
      [
        accountId,
        memberId,
        wing,
        flatNumber,
        userId,
        category,
        passMode,
        visitorName,
        visitorPhone,
        primaryVehicle,
        JSON.stringify(vehiclesIn),
        guestCount,
        validFrom.toISOString(),
        validUntil.toISOString(),
      ]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_authorization",
      entityId: rows[0].id,
      action: "create",
      after: rows[0],
      metadata: {
        category,
        passMode,
        flatNumber,
        visitorName,
        vehicles: vehiclesIn.map((v) => v.number),
      },
      visibility: "participants",
    });

    await client.query("COMMIT");
    return res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createAuthorization error:", err);
    return fail(res, 500, "server_error", "Failed to create pass");
  } finally {
    client.release();
  }
};

const listAuthorizations = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const isPrivileged = role === "owner" || role === "admin";

    let query;
    let params;
    if (isPrivileged) {
      query = `
        SELECT *
          FROM gate_authorizations
         WHERE account_id = $1
         ORDER BY
           CASE WHEN status = 'active' THEN 0 ELSE 1 END,
           valid_until DESC`;
      params = [accountId];
    } else {
      query = `
        SELECT *
          FROM gate_authorizations
         WHERE account_id = $1 AND created_by = $2
         ORDER BY
           CASE WHEN status = 'active' THEN 0 ELSE 1 END,
           valid_until DESC`;
      params = [accountId, userId];
    }

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error("listAuthorizations error:", err);
    return fail(res, 500, "server_error", "Failed to load passes");
  }
};

const deleteAuthorization = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows: existing } = await client.query(
      `SELECT id, created_by FROM gate_authorizations
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]);
    if (!existing.length) return fail(res, 404, "not_found", "Pass not found");

    const isOwner = role === "owner" || role === "admin";
    if (!isOwner && existing[0].created_by !== userId) {
      return fail(res, 403, "forbidden", "You can only cancel your own passes");
    }

    await client.query("BEGIN");

    await client.query(
      `UPDATE gate_authorizations
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_authorization",
      entityId: id,
      action: "delete",
      after: { status: "cancelled" },
      visibility: "participants",
    });

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deleteAuthorization error:", err);
    return fail(res, 500, "server_error", "Failed to cancel pass");
  } finally {
    client.release();
  }
};

const updateAuthorization = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows: existing } = await client.query(
      `SELECT id, created_by, pass_mode FROM gate_authorizations
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]);
    if (!existing.length) return fail(res, 404, "not_found", "Pass not found");

    const isOwner = role === "owner" || role === "admin";
    if (!isOwner && existing[0].created_by !== userId) {
      return fail(res, 403, "forbidden", "You can only edit your own passes");
    }

    const body = req.body || {};

    let visitorName = null;
    if (Object.prototype.hasOwnProperty.call(body, "visitorName")) {
      const v = body.visitorName;
      visitorName = v == null || String(v).trim() === "" ? null : String(v).trim();
      if (visitorName && visitorName.length > 200) {
        return fail(res, 400, "invalid_input", "Visitor name is too long");
      }
    }

    let visitorPhone;
    if (Object.prototype.hasOwnProperty.call(body, "visitorPhone")) {
      const raw = body.visitorPhone;
      visitorPhone = raw == null || String(raw).trim() === ""
        ? null
        : normalizePhone(raw);
    }

    let vehiclesIn;
    let primaryVehicle;
    if (Object.prototype.hasOwnProperty.call(body, "vehicles")) {
      vehiclesIn = normalizeVehiclesPayloadInput(body.vehicles);
      if (vehiclesIn.length === 0) {
        const legacy = normalizeVehicleNumber(
          body.vehicleNumber ?? body.vehicle_number ?? "");
        if (legacy && legacy.length >= 5 && legacy.length <= 15) {
          vehiclesIn = [{ number: legacy, type: "car" }];
        }
      }
      primaryVehicle = vehiclesIn[0]?.number ?? null;
    }

    let validFrom = null;
    if (Object.prototype.hasOwnProperty.call(body, "validFrom")) {
      const d = new Date(body.validFrom);
      if (isNaN(d.getTime())) {
        return fail(res, 400, "invalid_input", "Invalid validFrom");
      }
      validFrom = d;
    }

    let validUntil = null;
    if (Object.prototype.hasOwnProperty.call(body, "validUntil")) {
      const d = new Date(body.validUntil);
      if (isNaN(d.getTime())) {
        return fail(res, 400, "invalid_input", "Invalid validUntil");
      }
      validUntil = d;
    }

    let guestCount;
    if (Object.prototype.hasOwnProperty.call(body, "guestCount")) {
      const n = Number(body.guestCount);
      guestCount = Number.isFinite(n) ? Math.max(1, Math.min(20, Math.trunc(n))) : 1;
    }

    await client.query("BEGIN");

    const sets = [];
    const values = [];
    const push = (col, val) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };

    if (visitorName !== null || Object.prototype.hasOwnProperty.call(body, "visitorName")) {
      push("visitor_name", visitorName);
    }
    if (Object.prototype.hasOwnProperty.call(body, "visitorPhone")) {
      push("visitor_phone", visitorPhone);
    }
    if (Object.prototype.hasOwnProperty.call(body, "vehicles")) {
      push("vehicles", JSON.stringify(vehiclesIn));
      push("vehicle_number", primaryVehicle);
    }
    if (validFrom) push("valid_from", validFrom.toISOString());
    if (validUntil) push("valid_until", validUntil.toISOString());
    if (guestCount !== undefined) push("guest_count", guestCount);

    if (sets.length === 0) {
      await client.query("ROLLBACK");
      return fail(res, 400, "invalid_input", "No editable fields provided");
    }

    sets.push("updated_at = NOW()");
    values.push(id);
    values.push(accountId);

    const { rows: updated } = await client.query(
      `UPDATE gate_authorizations
          SET ${sets.join(", ")}
        WHERE id = $${values.length - 1} AND account_id = $${values.length}
        RETURNING *`,
      values);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_authorization",
      entityId: id,
      action: "update",
      after: updated[0],
      metadata: { fields: sets.map((s) => s.split(" ")[0]) },
      visibility: "participants",
    });

    await client.query("COMMIT");
    return res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateAuthorization error:", err);
    return fail(res, 500, "server_error", "Failed to update pass");
  } finally {
    client.release();
  }
};

const matchAuthorization = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const body = req.body || {};
    const flatNumber = String(body.flatNumber ?? body.flat_number ?? "").trim();
    if (!flatNumber) {
      return fail(res, 400, "invalid_input", "Flat number is required");
    }

    const wing = body.wing ? String(body.wing).trim() : null;
    const category = body.category
      ? String(body.category).toLowerCase().trim()
      : null;
    const visitorName = body.visitorName
      ? String(body.visitorName).trim().toLowerCase()
      : null;
    const vehicleNumber = body.vehicleNumber
      ? normalizeVehicleNumber(body.vehicleNumber)
      : null;

    const { rows } = await pool.query(
      `SELECT *
         FROM gate_authorizations
        WHERE account_id = $1
          AND flat_number = $2
          AND status = 'active'
          AND valid_from <= NOW()
          AND valid_until >= NOW()
          AND ($3::text IS NULL OR wing = $3)
          AND ($4::text IS NULL OR category = $4)
          AND (
                pass_mode = 'open'
             OR (pass_mode = 'named' AND
                 ($5::text IS NULL OR LOWER(visitor_name) = $5))
          )
          AND (vehicle_number IS NULL OR $6::text IS NULL OR vehicle_number = $6)
        ORDER BY
          CASE WHEN pass_mode = 'named' THEN 0 ELSE 1 END,
          valid_until ASC
        LIMIT 5`,
      [accountId, flatNumber, wing, category, visitorName, vehicleNumber]);

    if (rows.length === 0) {
      return res.json({ matched: false });
    }

    return res.json({
      matched: true,
      authorization: rows[0],
    });
  } catch (err) {
    console.error("matchAuthorization error:", err);
    return fail(res, 500, "server_error", "Failed to match authorization");
  }
};

// ===========================================================================
// GATE INVITES
// ===========================================================================

function generateInviteCode() {
  return "gti_" + crypto.randomBytes(8).toString("hex");
}

const createInvite = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const body = req.body || {};
    const memberId = body.memberId ?? body.member_id ?? null;
    const wing = body.wing ? String(body.wing).trim() : null;
    const flatNumber = String(body.flatNumber ?? body.flat_number ?? "").trim();
    if (!flatNumber) return fail(res, 400, "invalid_input", "Flat number is required");

    const guestName = String(body.guestName ?? body.guest_name ?? "").trim();
    if (!guestName) return fail(res, 400, "invalid_input", "Guest name is required");
    if (guestName.length > 200) return fail(res, 400, "invalid_input", "Guest name is too long");

    const guestPhone = normalizePhone(body.guestPhone ?? body.guest_phone);

    const purposeRaw = String(body.purpose ?? "guest").toLowerCase().trim();
    const purpose = ["guest", "delivery", "cab", "service", "other"].includes(purposeRaw)
      ? purposeRaw
      : "guest";

    const guestCountRaw = Number(body.guestCount ?? body.guest_count ?? 1);
    const guestCount = Number.isFinite(guestCountRaw)
      ? Math.max(1, Math.min(20, Math.trunc(guestCountRaw)))
      : 1;

    let vehiclesIn = normalizeVehiclesPayloadInput(body.vehicles);

    if (vehiclesIn.length === 0) {
      const legacy = normalizeVehicleNumber(
        body.vehicleNumber ?? body.vehicle_number ?? "");
      if (legacy && legacy.length >= 5 && legacy.length <= 15) {
        vehiclesIn = [{ number: legacy, type: "car" }];
      }
    }

    const primaryVehicle = vehiclesIn[0]?.number ?? null;

    const validFromRaw = body.validFrom ?? body.valid_from ?? null;
    const validUntilRaw = body.validUntil ?? body.valid_until ?? null;
    if (!validUntilRaw) return fail(res, 400, "invalid_input", "validUntil is required");

    const validFrom = validFromRaw ? new Date(validFromRaw) : new Date();
    const validUntil = new Date(validUntilRaw);
    if (isNaN(validFrom.getTime()) || isNaN(validUntil.getTime())) {
      return fail(res, 400, "invalid_input", "Invalid validity window");
    }
    if (validUntil.getTime() <= validFrom.getTime()) {
      return fail(res, 400, "invalid_input", "validUntil must be after validFrom");
    }

    const code = generateInviteCode();

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO gate_invites
         (account_id, created_by, member_id, wing, flat_number,
          guest_name, guest_phone, purpose, guest_count, vehicle_number,
          vehicles,
          valid_from, valid_until, code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,'active')
       RETURNING *`,
      [
        accountId,
        userId,
        memberId,
        wing,
        flatNumber,
        guestName,
        guestPhone,
        purpose,
        guestCount,
        primaryVehicle,
        JSON.stringify(vehiclesIn),
        validFrom.toISOString(),
        validUntil.toISOString(),
        code,
      ]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_invite",
      entityId: rows[0].id,
      action: "create",
      after: rows[0],
      metadata: { guestName, flatNumber, purpose, vehicles: vehiclesIn.map((v) => v.number) },
      visibility: "participants",
    });

    await client.query("COMMIT");
    return res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createInvite error:", err);
    return fail(res, 500, "server_error", "Failed to create invite");
  } finally {
    client.release();
  }
};

const listInvites = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const isPrivileged = role === "owner" || role === "admin";

    let query;
    let params;
    if (isPrivileged) {
      query = `
        SELECT *
          FROM gate_invites
         WHERE account_id = $1
         ORDER BY
           CASE WHEN status = 'active' THEN 0 ELSE 1 END,
           valid_until DESC`;
      params = [accountId];
    } else {
      query = `
        SELECT *
          FROM gate_invites
         WHERE account_id = $1 AND created_by = $2
         ORDER BY
           CASE WHEN status = 'active' THEN 0 ELSE 1 END,
           valid_until DESC`;
      params = [accountId, userId];
    }

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error("listInvites error:", err);
    return fail(res, 500, "server_error", "Failed to load invites");
  }
};

const getInvite = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows } = await pool.query(
      `SELECT * FROM gate_invites WHERE id = $1 AND account_id = $2`,
      [id, accountId]);
    if (!rows.length) return fail(res, 404, "not_found", "Invite not found");

    const invite = rows[0];
    const isPrivileged = role === "owner" || role === "admin";
    if (!isPrivileged && invite.created_by !== userId) {
      return fail(res, 403, "forbidden", "You don't have access to this invite");
    }

    return res.json(invite);
  } catch (err) {
    console.error("getInvite error:", err);
    return fail(res, 500, "server_error", "Failed to load invite");
  }
};

const lookupInviteByCode = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, code } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const cleanCode = String(code ?? "").trim();
    if (!cleanCode) return fail(res, 400, "invalid_input", "Code is required");

    const { rows } = await pool.query(
      `SELECT * FROM gate_invites WHERE code = $1 AND account_id = $2 LIMIT 1`,
      [cleanCode, accountId]);

    if (!rows.length) {
      return fail(res, 404, "not_found", "This QR doesn't match any invite");
    }

    const invite = rows[0];

    if (invite.status === "cancelled") {
      return fail(res, 410, "invite_cancelled", "This invite was cancelled");
    }
    if (invite.status === "used") {
      return res.status(200).json({ ...invite, _warning: "already_used" });
    }

    const now = new Date();
    const until = new Date(invite.valid_until);
    if (!isNaN(until.getTime()) && until.getTime() < now.getTime()) {
      return res.status(200).json({ ...invite, _warning: "expired" });
    }

    let vehicles = Array.isArray(invite.vehicles) ? invite.vehicles : [];
    if (vehicles.length === 0 && invite.vehicle_number) {
      vehicles = [{ number: invite.vehicle_number, type: "car" }];
    }

    return res.json({ ...invite, vehicles });
  } catch (err) {
    console.error("lookupInviteByCode error:", err);
    return fail(res, 500, "server_error", "Failed to look up invite");
  }
};

const deleteInvite = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows: existing } = await client.query(
      `SELECT id, created_by FROM gate_invites
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]);
    if (!existing.length) return fail(res, 404, "not_found", "Invite not found");

    const isOwner = role === "owner" || role === "admin";
    if (!isOwner && existing[0].created_by !== userId) {
      return fail(res, 403, "forbidden", "You can only cancel your own invites");
    }

    await client.query("BEGIN");

    await client.query(
      `UPDATE gate_invites
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_invite",
      entityId: id,
      action: "delete",
      after: { status: "cancelled" },
      visibility: "participants",
    });

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("deleteInvite error:", err);
    return fail(res, 500, "server_error", "Failed to cancel invite");
  } finally {
    client.release();
  }
};

const updateInvite = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "You no longer have access to this account");

    const { rows: existing } = await client.query(
      `SELECT id, created_by FROM gate_invites
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]);
    if (!existing.length) return fail(res, 404, "not_found", "Invite not found");

    const isOwner = role === "owner" || role === "admin";
    if (!isOwner && existing[0].created_by !== userId) {
      return fail(res, 403, "forbidden", "You can only edit your own invites");
    }

    const body = req.body || {};

    let purpose;
    if (Object.prototype.hasOwnProperty.call(body, "purpose")) {
      const purposeRaw = String(body.purpose ?? "").toLowerCase().trim();
      const validPurposes = ["guest", "delivery", "cab", "service", "other"];
      if (!validPurposes.includes(purposeRaw)) {
        return fail(res, 400, "invalid_input", "Invalid purpose");
      }
      purpose = purposeRaw;
    }

    let guestName = null;
    if (Object.prototype.hasOwnProperty.call(body, "guestName")) {
      const v = body.guestName;
      guestName = v == null || String(v).trim() === "" ? null : String(v).trim();
      if (guestName && guestName.length > 200) {
        return fail(res, 400, "invalid_input", "Guest name is too long");
      }
    }

    let guestPhone;
    if (Object.prototype.hasOwnProperty.call(body, "guestPhone")) {
      const raw = body.guestPhone;
      guestPhone = raw == null || String(raw).trim() === ""
        ? null
        : normalizePhone(raw);
    }

    let vehiclesIn;
    let primaryVehicle;
    if (Object.prototype.hasOwnProperty.call(body, "vehicles")) {
      vehiclesIn = normalizeVehiclesPayloadInput(body.vehicles);
      if (vehiclesIn.length === 0) {
        const legacy = normalizeVehicleNumber(
          body.vehicleNumber ?? body.vehicle_number ?? "");
        if (legacy && legacy.length >= 5 && legacy.length <= 15) {
          vehiclesIn = [{ number: legacy, type: "car" }];
        }
      }
      primaryVehicle = vehiclesIn[0]?.number ?? null;
    }

    let validFrom = null;
    if (Object.prototype.hasOwnProperty.call(body, "validFrom")) {
      const d = new Date(body.validFrom);
      if (isNaN(d.getTime())) {
        return fail(res, 400, "invalid_input", "Invalid validFrom");
      }
      validFrom = d;
    }

    let validUntil = null;
    if (Object.prototype.hasOwnProperty.call(body, "validUntil")) {
      const d = new Date(body.validUntil);
      if (isNaN(d.getTime())) {
        return fail(res, 400, "invalid_input", "Invalid validUntil");
      }
      validUntil = d;
    }

    let guestCount;
    if (Object.prototype.hasOwnProperty.call(body, "guestCount")) {
      const n = Number(body.guestCount);
      guestCount = Number.isFinite(n) ? Math.max(1, Math.min(20, Math.trunc(n))) : 1;
    }

    await client.query("BEGIN");

    const sets = [];
    const values = [];
    const push = (col, val) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };

    if (purpose !== undefined) {
      push("purpose", purpose);
    }

    if (Object.prototype.hasOwnProperty.call(body, "guestName")) {
      push("guest_name", guestName);
    }
    if (Object.prototype.hasOwnProperty.call(body, "guestPhone")) {
      push("guest_phone", guestPhone);
    }
    if (Object.prototype.hasOwnProperty.call(body, "vehicles")) {
      push("vehicles", JSON.stringify(vehiclesIn));
      push("vehicle_number", primaryVehicle);
    }
    if (validFrom) push("valid_from", validFrom.toISOString());
    if (validUntil) push("valid_until", validUntil.toISOString());
    if (guestCount !== undefined) push("guest_count", guestCount);

    if (sets.length === 0) {
      await client.query("ROLLBACK");
      return fail(res, 400, "invalid_input", "No editable fields provided");
    }

    sets.push("updated_at = NOW()");
    values.push(id);
    values.push(accountId);

    const { rows: updated } = await client.query(
      `UPDATE gate_invites
          SET ${sets.join(", ")}
        WHERE id = $${values.length - 1} AND account_id = $${values.length}
        RETURNING *`,
      values);

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      entityType: "gate_invite",
      entityId: id,
      action: "update",
      after: updated[0],
      metadata: { fields: sets.map((s) => s.split(" ")[0]) },
      visibility: "participants",
    });

    await client.query("COMMIT");
    return res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateInvite error:", err);
    return fail(res, 500, "server_error", "Failed to update invite");
  } finally {
    client.release();
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
  lookupVehicle,
  checkVehicleConflict,
  registerVehicle,
  createGateEntry,
  listGateEntries,
  updateGateEntry,
  approveGateEntry,
  rejectGateEntry,
  overrideGateEntry,
  getGateEntryStatus,
  listGateFlats,
  searchGatePasses,
  getPassHistory,
  logPassAction,
  createAuthorization,
  listAuthorizations,
  updateAuthorization,
  deleteAuthorization,
  matchAuthorization,
  createInvite,
  listInvites,
  updateInvite,
  getInvite,
  lookupInviteByCode,
  deleteInvite,
};