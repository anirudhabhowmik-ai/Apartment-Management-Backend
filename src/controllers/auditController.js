// src/controllers/auditController.js
const { pool } = require("../config/database");
const { projectNotifications } = require("./notificationController");

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
const SENSITIVE_KEYS = new Set([
  "password", "password_hash",
  "otp", "code", "code_hash",
  "token", "access_token",
]);

function scrubForAudit(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(scrubForAudit);
  if (typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) out[k] = "[redacted]";
    else if (v && typeof v === "object") out[k] = scrubForAudit(v);
    else out[k] = v;
  }
  return out;
}

const VALID_VISIBILITY = new Set(["admin", "public", "self", "participants"]);

// ---------------------------------------------------------------------------
// Friendly role label
// ---------------------------------------------------------------------------
function humanRole(role) {
  if (!role) return "access";
  switch (String(role)) {
    case "owner":              return "owner access";
    case "admin":              return "admin access";
    case "member_visibility":  return "member access";
    case "staff_visibility":   return "staff access";
    case "ownership_transfer": return "ownership";
    default:                   return String(role).replace(/_/g, " ");
  }
}

function joinedLabel(role) {
  if (!role) return "a member";
  switch (String(role)) {
    case "admin":              return "an admin";
    case "member_visibility":  return "a member";
    case "staff_visibility":   return "a staff member";
    case "ownership_transfer": return "the owner";
    default:                   return String(role).replace(/_/g, " ");
  }
}

// ---------------------------------------------------------------------------
// Human-readable summary builder
//
// History is a shared feed, so we never use "You" here. We use reflexive
// pronouns when the actor is also the target ("Archana granted themselves
// member access" instead of "Archana granted member access to Archana").
// ---------------------------------------------------------------------------
function buildSummary(e) {
  const actor = e.actorName || "Someone";
  const target = e.targetName || null;

  const role = e.metadata?.role;
  const kind = e.metadata?.kind;
  const k = `${e.entityType}.${e.action}`;

  const isSamePerson =
    !!e.actorUserId &&
    !!e.targetUserId &&
    String(e.actorUserId) === String(e.targetUserId);

  const targetForBody = target ?? "someone";

  const roleLabel = humanRole(role);

  const map = {
    // ---- Account ----
    "account.create": () => `${actor} created the account`,
    "account.update": () => `${actor} updated the account`,
    "account.delete": () => `${actor} deleted the account`,
    "account.transfer_ownership": () =>
      target
        ? `${actor} transferred ownership to ${target}`
        : `${actor} transferred ownership`,

    // ---- Members ----
    "member.create": () =>
      `${actor} added property for ${targetForBody}`,
    "member.update": () =>
      isSamePerson
        ? `${actor} updated their own details`
        : `${actor} updated ${targetForBody}'s details`,
    "member.delete": () =>
      isSamePerson
        ? `${actor} removed their own property`
        : `${actor} removed property from ${targetForBody}`,

    // ---- Staff ----
    "staff.create": () =>
      `${actor} added staff role for ${targetForBody}`,
    "staff.update": () =>
      isSamePerson
        ? `${actor} updated their own details`
        : `${actor} updated ${targetForBody}'s details`,
    "staff.delete": () =>
      isSamePerson
        ? `${actor} removed their own staff role`
        : `${actor} removed staff role from ${targetForBody}`,

    // ---- Payments ----
    "member.payment_paid": () =>
      isSamePerson
        ? `${actor} marked their own maintenance as PAID`
        : `${actor} marked maintenance PAID for ${targetForBody}`,
    "member.payment_due": () =>
      isSamePerson
        ? `${actor} marked their own maintenance as DUE`
        : `${actor} marked maintenance DUE for ${targetForBody}`,
    "staff.payment_paid": () =>
      isSamePerson
        ? `${actor} marked their own salary as PAID`
        : `${actor} marked salary PAID for ${targetForBody}`,
    "staff.payment_due": () =>
      isSamePerson
        ? `${actor} marked their own salary as DUE`
        : `${actor} marked salary DUE for ${targetForBody}`,

    // ---- Expenses ----
    "expense.create": () => `${actor} added an expense`,
    "expense.update": () => `${actor} updated an expense`,
    "expense.delete": () => `${actor} deleted an expense`,

    // ---- Account member role changes ----
    "account_member.role_granted": () =>
      isSamePerson
        ? `${actor} granted themselves ${roleLabel}`
        : `${actor} granted ${roleLabel} to ${targetForBody}`,
    "account_member.role_revoked": () =>
      isSamePerson
        ? `${actor} revoked their own ${roleLabel}`
        : `${actor} removed ${roleLabel} from ${targetForBody}`,

    // ---- Invitations ----
    "invitation.create": () =>
      `${actor} invited ${targetForBody} for ${roleLabel}`,
    "invitation.delete": () =>
      `${actor} cancelled invitation for ${targetForBody}`,
    "invitation.reject": () =>
      isSamePerson
        ? `${actor} rejected the invitation`
        : `${targetForBody} rejected the invitation`,
    "invitation.accept": () =>
      isSamePerson
        ? `${actor} accepted the invitation for ${roleLabel}`
        : `${targetForBody} accepted the invitation for ${roleLabel}`,

    // ---- Calendar ----
    "calendar_event.create":  () => `${actor} posted ${kind ?? "an event"}`,
    "calendar_event.update":  () => `${actor} updated ${kind ?? "an event"}`,
    "calendar_event.approve": () => `${actor} approved ${kind ?? "an event"}`,
    "calendar_event.reject":  () => `${actor} rejected ${kind ?? "an event"}`,
    "calendar_event.delete":  () => `${actor} deleted ${kind ?? "an event"}`,

    // ---- Opening balance ----
    "opening_balance.update": () => `${actor} updated opening balance`,
    "opening_balance.create": () => `${actor} added opening balance`,

    // ---- User ----
    "user.merge_users": () => `${actor} merged accounts`,
    "user.phone_changed": () => `${actor} changed their phone number`,
  };

  return map[k] ? map[k]() : `${actor} performed ${k}`;
}

// ---------------------------------------------------------------------------
// Resolve a user's name — used only for composing the summary string.
// ---------------------------------------------------------------------------
async function resolveUserName(client, userId) {
  if (!userId) return null;
  const { rows } = await client.query(
    `SELECT name FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.name ?? null;
}

// ---------------------------------------------------------------------------
// writeAudit — MUST be called inside an open transaction.
// ---------------------------------------------------------------------------
async function writeAudit(client, entry) {
  const {
    accountId = null,
    actorUserId = null,
    actorRole = null,
    targetUserId = null,
    entityType,
    entityId = null,
    action,
    before = null,
    after = null,
    metadata = null,
    visibility = "admin",
    summary: providedSummary = null,
  } = entry || {};

  if (!entityType || !action) {
    throw new Error("writeAudit: entityType and action are required");
  }
  if (!VALID_VISIBILITY.has(visibility)) {
    throw new Error(`writeAudit: invalid visibility "${visibility}"`);
  }

  const actorName = await resolveUserName(client, actorUserId);
  const targetName = targetUserId
    ? await resolveUserName(client, targetUserId)
    : null;

  const summary =
    providedSummary ||
    buildSummary({
      entityType,
      action,
      actorName,
      targetName,
      actorUserId,
      targetUserId,
      metadata,
    });

  const insert = await client.query(
    `INSERT INTO audit_log
       (account_id, actor_user_id, actor_role,
        entity_type, entity_id, action,
        before, after, metadata,
        visibility, summary)
     VALUES ($1,$2,$3,
             $4,$5,$6,
             $7,$8,$9,
             $10,$11)
     RETURNING id`,
    [
      accountId, actorUserId, actorRole,
      entityType, entityId, action,
      before ? JSON.stringify(scrubForAudit(before)) : null,
      after ? JSON.stringify(scrubForAudit(after)) : null,
      metadata ? JSON.stringify(scrubForAudit(metadata)) : null,
      visibility, summary,
    ],
  );

  const auditId = insert.rows[0].id;

  // Project the audit entry into per-user notifications.
  // Runs in the same transaction as the audit insert.
  // Failures here must never break the audit trail or the caller's
  // transaction, so we log and continue.
  try {
    await projectNotifications(client, {
      auditId,
      accountId,
      actorUserId,
      actorRole,
      targetUserId,
      entityType,
      entityId,
      action,
      before,
      after,
      metadata,
      visibility,
      summary,
      actorName,
      targetName,
    });
  } catch (err) {
    console.warn("writeAudit: projectNotifications failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------
const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

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

const isAdminLike = (role) => role === "owner" || role === "admin";

// ---------------------------------------------------------------------------
// Shared SELECT — JOINs users to fetch fresh name/phone/photo.
// ---------------------------------------------------------------------------
const HISTORY_SELECT = `
  SELECT
    al.id,
    al.account_id,
    al.actor_user_id,
    al.actor_role,
    al.entity_type,
    al.entity_id,
    al.action,
    al.before,
    al.after,
    al.metadata,
    al.visibility,
    al.summary,
    al.created_at,

    au.name      AS actor_name,
    au.phone     AS actor_phone,
    au.photo_url AS actor_photo,

    tu.id        AS target_user_id,
    tu.name      AS target_name,
    tu.phone     AS target_phone,
    tu.photo_url AS target_photo
  FROM audit_log al
  LEFT JOIN users au ON au.id = al.actor_user_id
  LEFT JOIN LATERAL (
    -- 1. account_member / user → entity_id IS the user id
    SELECT u.id, u.name, u.phone, u.photo_url
      FROM users u
     WHERE al.entity_type = 'account_member' AND u.id = al.entity_id
    UNION ALL
    SELECT u.id, u.name, u.phone, u.photo_url
      FROM users u
     WHERE al.entity_type = 'user' AND u.id = al.entity_id

    -- 2. member / staff → resolve via their join tables
    UNION ALL
    SELECT u.id, u.name, u.phone, u.photo_url
      FROM members m JOIN users u ON u.id = m.user_id
     WHERE al.entity_type = 'member' AND m.id = al.entity_id
    UNION ALL
    SELECT u.id, u.name, u.phone, u.photo_url
      FROM staff s JOIN users u ON u.id = s.user_id
     WHERE al.entity_type = 'staff' AND s.id = al.entity_id

    -- 3. invitation → match on after.phone or acceptedBy user id
    UNION ALL
    SELECT u.id, u.name, u.phone, u.photo_url
      FROM users u
     WHERE al.entity_type = 'invitation'
       AND (
         (COALESCE(al.after->>'phone', al.metadata->>'phone') IS NOT NULL
          AND RIGHT(REGEXP_REPLACE(u.phone, '\\D', '', 'g'), 10)
            = RIGHT(REGEXP_REPLACE(
                COALESCE(al.after->>'phone', al.metadata->>'phone', ''),
                '\\D', '', 'g'), 10))
         OR (al.after->>'acceptedBy' IS NOT NULL
             AND u.id = (al.after->>'acceptedBy')::uuid)
       )

    LIMIT 1
  ) tu ON TRUE
`;

// ---------------------------------------------------------------------------
// GET /history — OWNER / ADMIN only. Full account history.
// ---------------------------------------------------------------------------
const getAccountHistory = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden");
    if (!isAdminLike(role)) return fail(res, 403, "forbidden");

    const entityType = req.query.entityType || null;
    const entityId   = req.query.entityId   || null;
    const before     = req.query.before     || null;
    const limit      = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const params = [accountId];
    let where = `al.account_id = $1`;

    if (entityType) {
      params.push(entityType);
      where += ` AND al.entity_type = $${params.length}`;
    }
    if (entityId) {
      params.push(entityId);
      where += ` AND al.entity_id = $${params.length}`;
    }
    if (before) {
      params.push(before);
      where += ` AND al.created_at < $${params.length}`;
    }
    params.push(limit);

    const { rows } = await pool.query(
      `${HISTORY_SELECT}
        WHERE ${where}
        ORDER BY al.created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    return res.json({ history: rows });
  } catch (err) {
    console.error("getAccountHistory error:", err);
    return fail(res, 500, "server_error");
  }
};

// ---------------------------------------------------------------------------
// GET /history/me — MEMBER or STAFF.
// ---------------------------------------------------------------------------
const getMyHistory = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden");

    const before = req.query.before || null;
    const limit  = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const params = [accountId, userId];

    let where = `al.account_id = $1 AND (
      al.visibility = 'public'
      OR al.actor_user_id = $2
      OR (al.entity_type IN ('account_member','user') AND al.entity_id = $2)
      OR (al.entity_type = 'member' AND al.entity_id IN (
            SELECT id FROM members WHERE user_id = $2
          ))
      OR (al.entity_type = 'staff' AND al.entity_id IN (
            SELECT id FROM staff WHERE user_id = $2
          ))
      OR (
        al.visibility IN ('self','participants')
        AND (
          al.actor_user_id = $2
          OR (al.entity_type IN ('account_member','user') AND al.entity_id = $2)
          OR (al.entity_type = 'member' AND al.entity_id IN (
                SELECT id FROM members WHERE user_id = $2
              ))
          OR (al.entity_type = 'staff' AND al.entity_id IN (
                SELECT id FROM staff WHERE user_id = $2
              ))
        )
      )
    )`;

    if (before) {
      params.push(before);
      where += ` AND al.created_at < $${params.length}`;
    }
    params.push(limit);

    const { rows } = await pool.query(
      `${HISTORY_SELECT}
        WHERE ${where}
        ORDER BY al.created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    return res.json({ history: rows });
  } catch (err) {
    console.error("getMyHistory error:", err);
    return fail(res, 500, "server_error");
  }
};

// ---------------------------------------------------------------------------
// POST /history/sensitive-view
// ---------------------------------------------------------------------------
const logSensitiveView = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { entityType, entityId, field, targetUserId } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated");
    if (!entityType || !entityId || !field) {
      return fail(res, 400, "invalid_input");
    }

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden");
    if (isAdminLike(role)) {
      return res.json({ success: true, skipped: "admin" });
    }

    await client.query("BEGIN");
    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: role,
      targetUserId: targetUserId ?? null,
      entityType,
      entityId,
      action: "view_sensitive",
      metadata: { field },
      visibility: "admin",
    });
    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("logSensitiveView error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

module.exports = {
  writeAudit,
  getAccountHistory,
  getMyHistory,
  logSensitiveView,
};