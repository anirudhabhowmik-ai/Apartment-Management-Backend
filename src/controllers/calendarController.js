// src/controllers/calendarController.js
const { pool } = require("../config/database");

// ---------------------------------------------------------------------------
// Helpers (mirrors managementController.js)
// ---------------------------------------------------------------------------

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const getUserPhone = (req) => {
  const raw = req.user?.phone ?? null;
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

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
// Row → API mapper (matches CalendarEvent on the frontend)
// ---------------------------------------------------------------------------

function mapEventRow(e, responses = []) {
  return {
    id: e.id,
    accountId: e.account_id,
    title: e.title,
    description: e.description ?? undefined,
    type: e.type,
    resource: e.resource ?? undefined,
    date: e.event_date, // already ::text from SQL
    startTime: e.start_time ?? undefined,
    endTime: e.end_time ?? undefined,
    status: e.status,
    isImportant: !!e.is_important,
    rsvpEnabled: !!e.rsvp_enabled,

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

// Shared SELECT list — event_date cast to text so pg returns 'YYYY-MM-DD'
const EVENT_COLS = `
  e.id, e.account_id, e.title, e.description, e.type, e.resource,
  e.event_date::text AS event_date, e.start_time, e.end_time,
  e.status, e.is_important, e.rsvp_enabled,
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

// ===========================================================================
// LIST
// ===========================================================================

const listEvents = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    const month = isValidMonth(req.query?.month) ? req.query.month : null;

    const params = [accountId];
    let where = `e.account_id = $1`;

    if (month) {
      params.push(`${month}-01`);
      where += ` AND e.event_date >= $${params.length}::date
                 AND e.event_date < ($${params.length}::date + INTERVAL '1 month')`;
    }

    // Rejected events are only visible to their creator.
    params.push(userId);
    where += ` AND (e.status <> 'rejected' OR e.created_by_id = $${params.length})`;

    const { rows } = await pool.query(
      `SELECT ${EVENT_COLS}
         FROM calendar_events e
        WHERE ${where}
        ORDER BY e.event_date ASC, e.created_at ASC`,
      params
    );

    const byEvent = await fetchResponses(rows.map((r) => r.id));
    const events = rows.map((e) =>
      mapEventRow(e, byEvent.get(e.id) ?? [])
    );

    return res.json(events);
  } catch (err) {
    console.error("listEvents error:", err);
    return fail(res, 500, "server_error", "Failed to load calendar events");
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

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await pool.query(
      `SELECT ${EVENT_COLS}
         FROM calendar_events e
        WHERE e.id = $1 AND e.account_id = $2`,
      [id, accountId]
    );

    if (!rows.length) return fail(res, 404, "not_found", "Event not found");

    const ev = rows[0];
    // Rejected visible only to creator (and admins/owner — reasonable)
    if (
      ev.status === "rejected" &&
      ev.created_by_id !== userId &&
      !isAdminLike(role)
    ) {
      return fail(res, 404, "not_found", "Event not found");
    }

    const byEvent = await fetchResponses([id]);
    return res.json(mapEventRow(ev, byEvent.get(id) ?? []));
  } catch (err) {
    console.error("getEvent error:", err);
    return fail(res, 500, "server_error", "Failed to load event");
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

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

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
    } = req.body || {};

    if (!title || !String(title).trim()) {
      return fail(res, 400, "invalid_input", "Title is required");
    }
    if (type !== "notice" && type !== "event") {
      return fail(res, 400, "invalid_type", "Invalid type");
    }
    if (!isValidDateKey(date)) {
      return fail(res, 400, "invalid_input", "Date must be YYYY-MM-DD");
    }
    if (type === "event" && !resource) {
      return fail(res, 400, "invalid_input", "Venue is required for events");
    }
    if (type === "notice" && !canPostNotices(role)) {
      return fail(
        res,
        403,
        "forbidden",
        "Only owners and admins can post notices"
      );
    }

    // Poster role snapshot on the event (only admin/owner/member allowed by
    // the DB CHECK constraint). Staff are not allowed to post — treat as member.
    const posterRole = role === "staff" ? "member" : role;

    // Poster name snapshot — try to resolve a member name from phone.
    let posterName = posterRole === "admin" ? "Admin" : "Owner";
    if (posterRole === "member") posterName = "Member";
    if (userPhone) {
      const { rows: nameRows } = await client.query(
        `SELECT name FROM members
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
          LIMIT 1`,
        [accountId, userPhone]
      );
      if (nameRows.length && nameRows[0].name) {
        posterName = nameRows[0].name;
      }
    }

    // Admin/owner posts auto-approve; members go pending.
    const status = isAdminLike(role) ? "approved" : "pending";

    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO calendar_events
         (account_id, title, description, type, resource,
          event_date, start_time, end_time,
          status, is_important, rsvp_enabled,
          created_by_id, created_by_name, created_by_phone, created_by_role)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
        userId,
        posterName,
        userPhone,
        posterRole,
      ]
    );

    await client.query("COMMIT");

    const full = await fetchEventWithResponses(rows[0].id);
    return res.status(201).json(full);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("createEvent error:", err);
    return fail(res, 500, "server_error", "Failed to create event");
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

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows: existingRows } = await client.query(
      `SELECT * FROM calendar_events WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!existingRows.length) return fail(res, 404, "not_found", "Event not found");

    const existing = existingRows[0];
    const isAdmin = isAdminLike(role);
    const isOwnPending =
      existing.created_by_id === userId && existing.status === "pending";

    if (!isAdmin && !isOwnPending) {
      return fail(res, 403, "forbidden", "You cannot edit this event");
    }

    const body = req.body || {};

    // If a non-admin edits an event, only members can't change type to notice.
    if (
      body.type === "notice" &&
      !canPostNotices(role)
    ) {
      return fail(
        res,
        403,
        "forbidden",
        "Only owners and admins can post notices"
      );
    }

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

    // Map frontend camelCase to snake_case.
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

    // Validate date separately (has a ::date cast).
    let dateValue = null;
    if (body.date !== undefined) {
      if (!isValidDateKey(body.date)) {
        return fail(res, 400, "invalid_input", "Date must be YYYY-MM-DD");
      }
      dateValue = body.date;
    }

    if (Object.keys(updates).length === 0 && !dateValue) {
      return fail(res, 400, "invalid_input", "No permitted fields to update");
    }

    if (updates.title !== undefined) {
      if (!String(updates.title).trim()) {
        return fail(res, 400, "invalid_input", "Title cannot be empty");
      }
      updates.title = String(updates.title).trim();
    }
    if (updates.type !== undefined) {
      if (updates.type !== "notice" && updates.type !== "event") {
        return fail(res, 400, "invalid_type", "Invalid type");
      }
    }
    if (updates.description !== undefined)
      updates.description = toNullableString(updates.description);
    if (updates.resource !== undefined)
      updates.resource = toNullableString(updates.resource);
    if (updates.start_time !== undefined)
      updates.start_time = toNullableString(updates.start_time);
    if (updates.end_time !== undefined)
      updates.end_time = toNullableString(updates.end_time);

    // Event type requires a resource.
    const nextType = updates.type ?? existing.type;
    const nextResource =
      updates.resource !== undefined ? updates.resource : existing.resource;
    if (nextType === "event" && !nextResource) {
      return fail(res, 400, "invalid_input", "Venue is required for events");
    }

    await client.query("BEGIN");

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);

    if (dateValue) {
      values.push(dateValue);
      sets.push(`event_date = $${values.length}::date`);
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
    return fail(res, 500, "server_error", "Failed to update event");
  } finally {
    client.release();
  }
};

// ===========================================================================
// APPROVE / REJECT
// ===========================================================================

const approveEvent = async (req, res) => {
  try {
    const userId = getUserId(req);
    const userPhone = getUserPhone(req);
    const { accountId, id } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!isAdminLike(role)) {
      return fail(
        res,
        403,
        "forbidden",
        "Only owners and admins can approve events"
      );
    }

    const approverRole = role; // 'owner' | 'admin'
    let approverName = role === "admin" ? "Admin" : "Owner";
    if (userPhone) {
      const { rows: nameRows } = await pool.query(
        `SELECT name FROM members
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
          LIMIT 1`,
        [accountId, userPhone]
      );
      if (nameRows.length && nameRows[0].name) {
        approverName = nameRows[0].name;
      }
    }

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
      [userId, approverName, userPhone, approverRole, id, accountId]
    );

    if (!rows.length) {
      return fail(res, 404, "not_found", "Pending event not found");
    }

    const full = await fetchEventWithResponses(rows[0].id);
    return res.json(full);
  } catch (err) {
    console.error("approveEvent error:", err);
    return fail(res, 500, "server_error", "Failed to approve event");
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

    const role = await getRoleForAccount(userId, accountId);
    if (!isAdminLike(role)) {
      return fail(
        res,
        403,
        "forbidden",
        "Only owners and admins can reject events"
      );
    }

    const approverRole = role;
    let approverName = role === "admin" ? "Admin" : "Owner";
    if (userPhone) {
      const { rows: nameRows } = await pool.query(
        `SELECT name FROM members
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
          LIMIT 1`,
        [accountId, userPhone]
      );
      if (nameRows.length && nameRows[0].name) {
        approverName = nameRows[0].name;
      }
    }

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
        userPhone,
        approverRole,
        reason,
        id,
        accountId,
      ]
    );

    if (!rows.length) {
      return fail(res, 404, "not_found", "Pending event not found");
    }

    const full = await fetchEventWithResponses(rows[0].id);
    return res.json(full);
  } catch (err) {
    console.error("rejectEvent error:", err);
    return fail(res, 500, "server_error", "Failed to reject event");
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

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

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

    if (!canDelete) {
      return fail(res, 403, "forbidden", "You cannot delete this event");
    }

    await pool.query(
      `DELETE FROM calendar_events WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("deleteEvent error:", err);
    return fail(res, 500, "server_error", "Failed to delete event");
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

    if (response !== "accept" && response !== "reject") {
      return fail(
        res,
        400,
        "invalid_input",
        "response must be 'accept' or 'reject'"
      );
    }

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows: evRows } = await client.query(
      `SELECT rsvp_enabled, created_by_id
         FROM calendar_events
        WHERE id = $1 AND account_id = $2`,
      [id, accountId]
    );
    if (!evRows.length) return fail(res, 404, "not_found", "Event not found");

    if (!evRows[0].rsvp_enabled) {
      return fail(res, 400, "invalid_input", "RSVP is not enabled for this event");
    }
    if (evRows[0].created_by_id === userId) {
      return fail(
        res,
        400,
        "invalid_input",
        "Posters cannot RSVP to their own event"
      );
    }

    // Resolve a display name — prefer member record, fall back to phone.
    let displayName = userPhone ? `+91 ${userPhone.slice(0, 5)} ${userPhone.slice(5)}` : "User";
    if (userPhone) {
      const { rows: nameRows } = await client.query(
        `SELECT name FROM members
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
          LIMIT 1`,
        [accountId, userPhone]
      );
      if (nameRows.length && nameRows[0].name) {
        displayName = nameRows[0].name;
      }
    }

    const rsvpRole =
      role === "owner" || role === "admin" || role === "member"
        ? role
        : "member";

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
        userPhone,
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
    return fail(res, 500, "server_error", "Failed to save response");
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
  deleteEvent,
  respondToEvent,
};