// src/controllers/calendarController.js
const { pool } = require("../config/database");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

// Returns the last 10 digits, used for lookups.
const getUserPhone = (req) => {
  const raw = req.user?.phone ?? null;
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

// Prefix for the phone we actually store in the DB.
const withCountryCode = (tenDigit) =>
  tenDigit && /^[6-9]\d{9}$/.test(tenDigit) ? `91${tenDigit}` : null;

const isUuid = (s) =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

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

const fail = (res, status, code, message) =>
  res.status(status).json({ code, message });

const isAdminLike = (role) => role === "owner" || role === "admin";

const canPostNotices = (role) => role === "owner" || role === "admin";

const toNullableString = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
};

const isValidDateKey = (s) =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const isValidMonth = (s) =>
  typeof s === "string" && /^\d{4}-\d{2}$/.test(s);

// ---------------------------------------------------------------------------
// Role normalization for the DB CHECK constraints.
//
// `account_members.role` can be: 'admin', 'owner', 'member',
// 'member_visibility', 'staff_visibility', 'staff', or anything else a future
// migration adds. But `calendar_events.created_by_role` and
// `calendar_event_responses.role` only accept ('admin', 'owner', 'member').
//
// Anything not admin/owner collapses to 'member'.
// ---------------------------------------------------------------------------

const normalizeCalendarRole = (role) =>
  role === "admin" || role === "owner" ? role : "member";

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

function normalizeAttachments(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const uri = typeof item.uri === "string" ? item.uri.trim() : "";
    if (!uri) continue;

    const entry = { uri };
    entry.name =
      typeof item.name === "string" && item.name.trim()
        ? item.name.trim()
        : "Attachment";
    if (typeof item.mimeType === "string" && item.mimeType.trim()) {
      entry.mimeType = item.mimeType.trim();
    }
    out.push(entry);
    if (out.length >= 20) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row -> API mapper
// ---------------------------------------------------------------------------

function mapEventRow(e, responses = []) {
  return {
    id: e.id,
    accountId: e.account_id,
    title: e.title,
    description: e.description ?? undefined,
    type: e.type,
    resource: e.resource ?? undefined,
    date: e.event_date,
    startTime: e.start_time ?? undefined,
    endTime: e.end_time ?? undefined,
    status: e.status,
    isImportant: !!e.is_important,
    rsvpEnabled: !!e.rsvp_enabled,

    attachments: Array.isArray(e.attachments) ? e.attachments : [],

    createdById: e.created_by_id,
    createdByName: e.created_by_name ?? undefined,
    createdByPhone: e.created_by_phone ?? undefined,
    createdByRole: e.created_by_role ?? undefined,

    approvedById: e.approved_by_id ?? undefined,
    approvedByName: e.approved_by_name ?? undefined,
    approvedByPhone: e.approved_by_phone ?? undefined,
    approvedByRole: e.approved_by_role ?? undefined,
    rejectionReason: e.rejection_reason ?? undefined,

    createdAt: e.created_at,
    updatedAt: e.updated_at,

    responses: responses.map((r) => ({
      userId: r.user_id,
      name: r.name ?? "User",
      phone: r.phone ?? undefined,
      role: r.role ?? undefined,
      response: r.response,
      reason: r.reason ?? undefined,
      note: r.note ?? undefined,
      at: r.responded_at,
    })),
  };
}

const EVENT_COLS = `
  e.id, e.account_id, e.title, e.description, e.type, e.resource,
  e.event_date::text AS event_date, e.start_time, e.end_time,
  e.status, e.is_important, e.rsvp_enabled,
  e.attachments,
  e.created_by_id, e.created_by_name, e.created_by_phone, e.created_by_role,
  e.approved_by_id, e.approved_by_name, e.approved_by_phone, e.approved_by_role,
  e.rejection_reason, e.created_at, e.updated_at
`;

const RESP_COLS = `
  user_id, name, phone, role, response, reason, note, responded_at
`;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchResponses(eventIds) {
  if (!eventIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT event_id, ${RESP_COLS}
       FROM calendar_event_responses
      WHERE event_id = ANY($1::uuid[])`,
    [eventIds]
  );
  const byEvent = new Map();
  for (const r of rows) {
    const list = byEvent.get(r.event_id) ?? [];
    list.push(r);
    byEvent.set(r.event_id, list);
  }
  return byEvent;
}

async function fetchEventWithResponses(eventId) {
  const { rows } = await pool.query(
    `SELECT ${EVENT_COLS} FROM calendar_events e WHERE e.id = $1`,
    [eventId]
  );
  if (!rows.length) return null;
  const byEvent = await fetchResponses([eventId]);
  return mapEventRow(rows[0], byEvent.get(eventId) ?? []);
}

async function resolveDisplayName(client, accountId, phone, fallback) {
  if (!phone) return fallback;
  if (!isUuid(accountId)) return fallback;

  try {
    const { rows } = await client.query(
      `SELECT u.name AS name
         FROM users u
         JOIN members m ON m.user_id = u.id
        WHERE m.account_id = $1
          AND m.status     = 'active'
          AND RIGHT(REGEXP_REPLACE(u.phone, '\\D', '', 'g'), 10) = $2
        LIMIT 1`,
      [accountId, phone]
    );
    if (rows.length && rows[0].name) return rows[0].name;
  } catch (e) {
    console.warn("[resolveDisplayName] members lookup failed:", e.message);
  }

  try {
    const { rows } = await client.query(
      `SELECT u.name AS name
         FROM users u
         JOIN staff s ON s.user_id = u.id
        WHERE s.account_id = $1
          AND s.status     = 'active'
          AND RIGHT(REGEXP_REPLACE(u.phone, '\\D', '', 'g'), 10) = $2
        LIMIT 1`,
      [accountId, phone]
    );
    if (rows.length && rows[0].name) return rows[0].name;
  } catch (e) {
    console.warn("[resolveDisplayName] staff lookup failed:", e.message);
  }

  try {
    const { rows } = await client.query(
      `SELECT name
         FROM users
        WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
        LIMIT 1`,
      [phone]
    );
    if (rows.length && rows[0].name) return rows[0].name;
  } catch (e) {
    console.warn("[resolveDisplayName] users lookup failed:", e.message);
  }

  return fallback;
}

// ===========================================================================
// LIST
// ===========================================================================

const listEvents = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const month = req.query?.month;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    if (!isUuid(userId))
      return fail(res, 400, "invalid_user", "Token userId is not a valid UUID");

    if (!isUuid(accountId))
      return fail(res, 400, "invalid_account", "accountId is not a valid UUID");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "forbidden",
        "You do not have access to this account"
      );

    const validMonth = isValidMonth(month) ? month : null;

    const params = [accountId];
    let where = `e.account_id = $1`;

    if (validMonth) {
      params.push(`${validMonth}-01`);
      where += ` AND e.event_date >= $${params.length}::date
                 AND e.event_date < ($${params.length}::date + INTERVAL '1 month')`;
    }

    params.push(userId);
    const uidIdx = params.length;

    params.push(isAdminLike(role));
    const adminIdx = params.length;

    where += ` AND (
      e.status = 'approved'
      OR e.created_by_id = $${uidIdx}
      OR $${adminIdx}::boolean = TRUE
    )`;

    const { rows } = await pool.query(
      `SELECT ${EVENT_COLS}
         FROM calendar_events e
        WHERE ${where}
        ORDER BY e.event_date ASC, e.created_at ASC`,
      params
    );

    const byEvent = await fetchResponses(rows.map((r) => r.id));
    const events = rows.map((e) => mapEventRow(e, byEvent.get(e.id) ?? []));

    return res.json(events);
  } catch (err) {
    console.error("listEvents error:", err);
    return fail(
      res,
      500,
      "server_error",
      err.message || "Failed to load calendar events"
    );
  }
};

// ===========================================================================
// GET ONE
// ===========================================================================

const getEvent = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    if (!isUuid(userId))
      return fail(res, 400, "invalid_user", "Token userId is not a valid UUID");

    if (!isUuid(accountId))
      return fail(res, 400, "invalid_account", "accountId is not a valid UUID");

    if (!isUuid(id))
      return fail(res, 400, "invalid_event", "event id is not a valid UUID");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "forbidden",
        "You do not have access to this account"
      );

    const { rows } = await pool.query(
      `SELECT ${EVENT_COLS}
         FROM calendar_events e
        WHERE e.id = $1 AND e.account_id = $2`,
      [id, accountId]
    );

    if (!rows.length) return fail(res, 404, "not_found", "Event not found");

    const ev = rows[0];
    const visible =
      ev.status === "approved" ||
      ev.created_by_id === userId ||
      isAdminLike(role);

    if (!visible) return fail(res, 404, "not_found", "Event not found");

    const byEvent = await fetchResponses([id]);
    return res.json(mapEventRow(ev, byEvent.get(id) ?? []));
  } catch (err) {
    console.error("getEvent error:", err);
    return fail(res, 500, "server_error", err.message || "Failed to load event");
  }
};

// ===========================================================================
// CREATE
// ===========================================================================

const createEvent = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const userPhone = getUserPhone(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    if (!isUuid(userId))
      return fail(res, 400, "invalid_user", "Token userId is not a valid UUID");

    if (!isUuid(accountId))
      return fail(res, 400, "invalid_account", "accountId is not a valid UUID");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "forbidden",
        "You do not have access to this account"
      );

    const {
      title,
      description = null,
      type = "event",
      resource = null,
      date,
      startTime = null,
      endTime = null,
      isImportant = false,
      rsvpEnabled = false,
      attachments = [],
    } = req.body || {};

    if (!title || !String(title).trim())
      return fail(res, 400, "invalid_input", "Title is required");

    if (type !== "notice" && type !== "event")
      return fail(res, 400, "invalid_type", "Invalid type");

    if (!isValidDateKey(date))
      return fail(res, 400, "invalid_input", "Date must be YYYY-MM-DD");

    if (type === "event" && !resource)
      return fail(res, 400, "invalid_input", "Venue is required for events");

    if (type === "notice" && !canPostNotices(role))
      return fail(
        res,
        403,
        "forbidden",
        "Only owners and admins can post notices"
      );

    const safeAttachments = normalizeAttachments(attachments) ?? [];

    // DB CHECK: created_by_role IN ('admin', 'owner', 'member').
    // getRoleForAccount() can return 'member_visibility', 'staff_visibility',
    // or 'staff' too. Anything not admin/owner is stored as 'member'.
    const posterRole = normalizeCalendarRole(role);

    let posterName =
      posterRole === "admin"
        ? "Admin"
        : posterRole === "owner"
        ? "Owner"
        : "Member";

    posterName = await resolveDisplayName(
      client,
      accountId,
      userPhone,
      posterName
    );

    // Members' posts go to 'pending' for approval. Owner/admin auto-approve.
    const status = isAdminLike(role) ? "approved" : "pending";

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO calendar_events
         (account_id, title, description, type, resource,
          event_date, start_time, end_time,
          status, is_important, rsvp_enabled,
          attachments,
          created_by_id, created_by_name, created_by_phone, created_by_role)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,
               $12::jsonb,
               $13,$14,$15,$16)
       RETURNING id`,
      [
        accountId,
        String(title).trim(),
        toNullableString(description),
        type,
        type === "event" ? toNullableString(resource) : null,
        date,
        toNullableString(startTime),
        toNullableString(endTime),
        status,
        !!isImportant,
        !!rsvpEnabled,
        JSON.stringify(safeAttachments),
        userId,
        posterName,
        withCountryCode(userPhone),
        posterRole,
      ]
    );

    await client.query("COMMIT");

    const full = await fetchEventWithResponses(rows[0].id);
    return res.status(201).json(full);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createEvent error:", err);
    return fail(res, 500, "server_error", err.message || "Failed to create event");
  } finally {
    client.release();
  }
};

// ===========================================================================
// UPDATE
// ===========================================================================

const updateEvent = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    if (!isUuid(userId))
      return fail(res, 400, "invalid_user", "Token userId is not a valid UUID");

    if (!isUuid(accountId))
      return fail(res, 400, "invalid_account", "accountId is not a valid UUID");

    if (!isUuid(id))
      return fail(res, 400, "invalid_event", "event id is not a valid UUID");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "forbidden",
        "You do not have access to this account"
      );

    const { rows: existingRows } = await client.query(
      `SELECT * FROM calendar_events WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!existingRows.length)
      return fail(res, 404, "not_found", "Event not found");

    const existing = existingRows[0];
    const isAdmin = isAdminLike(role);
    const isOwnPending =
      existing.created_by_id === userId && existing.status === "pending";

    if (!isAdmin && !isOwnPending)
      return fail(res, 403, "forbidden", "You cannot edit this event");

    const body = req.body || {};

    if (body.type === "notice" && !canPostNotices(role))
      return fail(
        res,
        403,
        "forbidden",
        "Only owners and admins can post notices"
      );

    const allowedFields = [
      "title",
      "description",
      "type",
      "resource",
      "start_time",
      "end_time",
      "is_important",
      "rsvp_enabled",
    ];

    const incoming = {};
    if (body.title !== undefined) incoming.title = body.title;
    if (body.description !== undefined) incoming.description = body.description;
    if (body.type !== undefined) incoming.type = body.type;
    if (body.resource !== undefined) incoming.resource = body.resource;
    if (body.startTime !== undefined) incoming.start_time = body.startTime;
    if (body.endTime !== undefined) incoming.end_time = body.endTime;
    if (body.isImportant !== undefined) incoming.is_important = body.isImportant;
    if (body.rsvpEnabled !== undefined) incoming.rsvp_enabled = body.rsvpEnabled;

    const updates = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) {
        updates[key] = incoming[key];
      }
    }

    const hasAttachmentsField = Object.prototype.hasOwnProperty.call(
      body,
      "attachments"
    );
    let attachmentsValue = null;
    if (hasAttachmentsField) {
      attachmentsValue = normalizeAttachments(body.attachments) ?? [];
    }

    let dateValue = null;
    if (body.date !== undefined) {
      if (!isValidDateKey(body.date))
        return fail(res, 400, "invalid_input", "Date must be YYYY-MM-DD");
      dateValue = body.date;
    }

    if (
      Object.keys(updates).length === 0 &&
      !dateValue &&
      !hasAttachmentsField
    ) {
      return fail(res, 400, "invalid_input", "No permitted fields to update");
    }

    if (updates.title !== undefined) {
      if (!String(updates.title).trim())
        return fail(res, 400, "invalid_input", "Title cannot be empty");
      updates.title = String(updates.title).trim();
    }
    if (updates.type !== undefined) {
      if (updates.type !== "notice" && updates.type !== "event")
        return fail(res, 400, "invalid_type", "Invalid type");
    }
    if (updates.description !== undefined)
      updates.description = toNullableString(updates.description);
    if (updates.resource !== undefined)
      updates.resource = toNullableString(updates.resource);
    if (updates.start_time !== undefined)
      updates.start_time = toNullableString(updates.start_time);
    if (updates.end_time !== undefined)
      updates.end_time = toNullableString(updates.end_time);

    const nextType = updates.type ?? existing.type;
    const nextResource =
      updates.resource !== undefined ? updates.resource : existing.resource;
    if (nextType === "event" && !nextResource)
      return fail(res, 400, "invalid_input", "Venue is required for events");

    await client.query("BEGIN");

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);

    if (dateValue) {
      values.push(dateValue);
      sets.push(`event_date = $${values.length}::date`);
    }

    if (hasAttachmentsField) {
      values.push(JSON.stringify(attachmentsValue));
      sets.push(`attachments = $${values.length}::jsonb`);
    }

    sets.push(`updated_at = NOW()`);
    values.push(id);
    values.push(accountId);

    const { rows } = await client.query(
      `UPDATE calendar_events
          SET ${sets.join(", ")}
        WHERE id = $${values.length - 1}
          AND account_id = $${values.length}
        RETURNING id`,
      values
    );

    await client.query("COMMIT");

    const full = await fetchEventWithResponses(rows[0].id);
    return res.json(full);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateEvent error:", err);
    return fail(res, 500, "server_error", err.message || "Failed to update event");
  } finally {
    client.release();
  }
};

// ===========================================================================
// APPROVE / REJECT / RESEND
// ===========================================================================

const approveEvent = async (req, res) => {
  try {
    const userId = getUserId(req);
    const userPhone = getUserPhone(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    if (!isUuid(userId))
      return fail(res, 400, "invalid_user", "Token userId is not a valid UUID");

    if (!isUuid(accountId))
      return fail(res, 400, "invalid_account", "accountId is not a valid UUID");

    if (!isUuid(id))
      return fail(res, 400, "invalid_event", "event id is not a valid UUID");

    const role = await getRoleForAccount(userId, accountId);
    if (!isAdminLike(role))
      return fail(
        res,
        403,
        "forbidden",
        "Only owners and admins can approve events"
      );

    const approverRole = normalizeCalendarRole(role); // 'admin' or 'owner'
    let approverName = role === "admin" ? "Admin" : "Owner";
    approverName = await resolveDisplayName(
      pool,
      accountId,
      userPhone,
      approverName
    );

    const { rows } = await pool.query(
      `UPDATE calendar_events
          SET status = 'approved',
              approved_by_id = $1,
              approved_by_name = $2,
              approved_by_phone = $3,
              approved_by_role = $4,
              rejection_reason = NULL,
              updated_at = NOW()
        WHERE id = $5 AND account_id = $6 AND status = 'pending'
        RETURNING id`,
      [
        userId,
        approverName,
        withCountryCode(userPhone),
        approverRole,
        id,
        accountId,
      ]
    );

    if (!rows.length)
      return fail(res, 404, "not_found", "Pending event not found");

    const full = await fetchEventWithResponses(rows[0].id);
    return res.json(full);
  } catch (err) {
    console.error("approveEvent error:", err);
    return fail(
      res,
      500,
      "server_error",
      err.message || "Failed to approve event"
    );
  }
};

const rejectEvent = async (req, res) => {
  try {
    const userId = getUserId(req);
    const userPhone = getUserPhone(req);
    const { accountId, id } = req.params;
    const reason = toNullableString(req.body?.reason);

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    if (!isUuid(userId))
      return fail(res, 400, "invalid_user", "Token userId is not a valid UUID");

    if (!isUuid(accountId))
      return fail(res, 400, "invalid_account", "accountId is not a valid UUID");

    if (!isUuid(id))
      return fail(res, 400, "invalid_event", "event id is not a valid UUID");

    const role = await getRoleForAccount(userId, accountId);
    if (!isAdminLike(role))
      return fail(
        res,
        403,
        "forbidden",
        "Only owners and admins can reject events"
      );

    const approverRole = normalizeCalendarRole(role);
    let approverName = role === "admin" ? "Admin" : "Owner";
    approverName = await resolveDisplayName(
      pool,
      accountId,
      userPhone,
      approverName
    );

    const { rows } = await pool.query(
      `UPDATE calendar_events
          SET status = 'rejected',
              approved_by_id = $1,
              approved_by_name = $2,
              approved_by_phone = $3,
              approved_by_role = $4,
              rejection_reason = $5,
              updated_at = NOW()
        WHERE id = $6 AND account_id = $7 AND status = 'pending'
        RETURNING id`,
      [
        userId,
        approverName,
        withCountryCode(userPhone),
        approverRole,
        reason,
        id,
        accountId,
      ]
    );

    if (!rows.length)
      return fail(res, 404, "not_found", "Pending event not found");

    const full = await fetchEventWithResponses(rows[0].id);
    return res.json(full);
  } catch (err) {
    console.error("rejectEvent error:", err);
    return fail(res, 500, "server_error", err.message || "Failed to reject event");
  }
};

const resendEvent = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    if (!isUuid(userId))
      return fail(res, 400, "invalid_user", "Token userId is not a valid UUID");

    if (!isUuid(accountId))
      return fail(res, 400, "invalid_account", "accountId is not a valid UUID");

    if (!isUuid(id))
      return fail(res, 400, "invalid_event", "event id is not a valid UUID");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "forbidden",
        "You do not have access to this account"
      );

    const { rows: evRows } = await pool.query(
      `SELECT created_by_id, status FROM calendar_events
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!evRows.length) return fail(res, 404, "not_found", "Event not found");

    const ev = evRows[0];

    if (ev.created_by_id !== userId)
      return fail(res, 403, "forbidden", "You cannot resend this event");

    if (ev.status !== "rejected")
      return fail(
        res,
        400,
        "invalid_state",
        "Only rejected events can be resent"
      );

    const { rows } = await pool.query(
      `UPDATE calendar_events
          SET status = 'pending',
              approved_by_id = NULL,
              approved_by_name = NULL,
              approved_by_phone = NULL,
              approved_by_role = NULL,
              rejection_reason = NULL,
              updated_at = NOW()
        WHERE id = $1 AND account_id = $2
        RETURNING id`,
      [id, accountId]
    );

    const full = await fetchEventWithResponses(rows[0].id);
    return res.json(full);
  } catch (err) {
    console.error("resendEvent error:", err);
    return fail(
      res,
      500,
      "server_error",
      err.message || "Failed to resend event"
    );
  }
};

// ===========================================================================
// DELETE
// ===========================================================================

const deleteEvent = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    if (!isUuid(userId))
      return fail(res, 400, "invalid_user", "Token userId is not a valid UUID");

    if (!isUuid(accountId))
      return fail(res, 400, "invalid_account", "accountId is not a valid UUID");

    if (!isUuid(id))
      return fail(res, 400, "invalid_event", "event id is not a valid UUID");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "forbidden",
        "You do not have access to this account"
      );

    const { rows } = await pool.query(
      `SELECT created_by_id, status FROM calendar_events
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!rows.length) return fail(res, 404, "not_found", "Event not found");

    const ev = rows[0];
    const canDelete =
      isAdminLike(role) ||
      (ev.created_by_id === userId && ev.status !== "approved");

    if (!canDelete)
      return fail(res, 403, "forbidden", "You cannot delete this event");

    await pool.query(
      `DELETE FROM calendar_events WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteEvent error:", err);
    return fail(res, 500, "server_error", err.message || "Failed to delete event");
  }
};

// ===========================================================================
// RSVP
// ===========================================================================

const respondToEvent = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const userPhone = getUserPhone(req);
    const { accountId, id } = req.params;
    const { response, reason, note } = req.body || {};

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    if (!isUuid(userId))
      return fail(res, 400, "invalid_user", "Token userId is not a valid UUID");

    if (!isUuid(accountId))
      return fail(res, 400, "invalid_account", "accountId is not a valid UUID");

    if (!isUuid(id))
      return fail(res, 400, "invalid_event", "event id is not a valid UUID");

    if (response !== "accept" && response !== "reject")
      return fail(
        res,
        400,
        "invalid_input",
        "response must be 'accept' or 'reject'"
      );

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(
        res,
        403,
        "forbidden",
        "You do not have access to this account"
      );

    const { rows: evRows } = await client.query(
      `SELECT rsvp_enabled, created_by_id
         FROM calendar_events
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!evRows.length) return fail(res, 404, "not_found", "Event not found");

    if (!evRows[0].rsvp_enabled)
      return fail(
        res,
        400,
        "invalid_input",
        "RSVP is not enabled for this event"
      );

    if (evRows[0].created_by_id === userId)
      return fail(
        res,
        400,
        "invalid_input",
        "Posters cannot RSVP to their own event"
      );

    let displayName = userPhone
      ? `+91 ${userPhone.slice(0, 5)} ${userPhone.slice(5)}`
      : "User";
    displayName = await resolveDisplayName(
      client,
      accountId,
      userPhone,
      displayName
    );

    // DB CHECK: role IN ('admin', 'owner', 'member').
    const rsvpRole = normalizeCalendarRole(role);

    await client.query("BEGIN");

    await client.query(
      `INSERT INTO calendar_event_responses
         (event_id, user_id, name, phone, role, response, reason, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (event_id, user_id) DO UPDATE SET
         response     = EXCLUDED.response,
         reason       = EXCLUDED.reason,
         note         = EXCLUDED.note,
         name         = EXCLUDED.name,
         phone        = EXCLUDED.phone,
         role         = EXCLUDED.role,
         responded_at = NOW()`,
      [
        id,
        userId,
        displayName,
        withCountryCode(userPhone),
        rsvpRole,
        response,
        response === "reject" ? toNullableString(reason) : null,
        response === "accept" ? toNullableString(note) : null,
      ]
    );

    await client.query("COMMIT");

    const full = await fetchEventWithResponses(id);
    return res.json(full);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("respondToEvent error:", err);
    return fail(
      res,
      500,
      "server_error",
      err.message || "Failed to save response"
    );
  } finally {
    client.release();
  }
};

// ===========================================================================

module.exports = {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  approveEvent,
  rejectEvent,
  resendEvent,
  deleteEvent,
  respondToEvent,
};