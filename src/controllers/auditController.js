// src/controllers/auditController.js
const { pool } = require("../config/database");

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
  if (!role) return "a role";
  switch (role) {
    case "owner":              return "Owner";
    case "admin":              return "Admin";
    case "member_visibility":  return "Member";
    case "staff_visibility":   return "Staff";
    case "ownership_transfer": return "Ownership Transfer";
    default:                   return role;
  }
}

// ---------------------------------------------------------------------------
// Human-readable summary builder
// ---------------------------------------------------------------------------
function buildSummary(e) {
  const actor = e.actorName || "Someone";
  const target = e.targetName || null;
  const role = e.metadata?.role;
  const kind = e.metadata?.kind;
  const k = `${e.entityType}.${e.action}`;

  const map = {
    "account.create": () => `${actor} created the account`,
    "account.update": () => `${actor} updated the account`,
    "account.delete": () => `${actor} deleted the account`,
    "account.transfer_ownership": () =>
      `${actor} transferred ownership${target ? ` to ${target}` : ""}`,

    "member.create": () =>
      `${actor} added property for ${target ?? "a member"}`,
    "member.update": () => `${actor} updated ${target ?? "a member"}'s details`,
    "member.delete": () =>
      `${actor} removed property from ${target ?? "a member"}`,

    "staff.create": () =>
      `${actor} added staff role for ${target ?? "a staff member"}`,
    "staff.update": () => `${actor} updated ${target ?? "a staff member"}'s details`,
    "staff.delete": () =>
      `${actor} removed staff role from ${target ?? "a staff member"}`,

    "member.payment_paid": () =>
      `${actor} marked maintenance PAID for ${target ?? "a member"}`,
    "member.payment_due": () =>
      `${actor} marked maintenance DUE for ${target ?? "a member"}`,
    "staff.payment_paid": () =>
      `${actor} marked salary PAID for ${target ?? "a staff member"}`,
    "staff.payment_due": () =>
      `${actor} marked salary DUE for ${target ?? "a staff member"}`,

    "expense.create": () => `${actor} added an expense`,
    "expense.update": () => `${actor} updated an expense`,
    "expense.delete": () => `${actor} deleted an expense`,

    "account_member.role_granted": () =>
      `${actor} granted ${humanRole(role)} access to ${target ?? "a user"}`,
    "account_member.role_revoked": () =>
      `${actor} removed ${humanRole(role)} access from ${target ?? "a user"}`,

    "invitation.create": () =>
      `${actor} invited ${target ?? "a user"} for ${humanRole(role)} access`,
    "invitation.delete": () =>
      `${actor} cancelled invitation for ${target ?? "a user"}`,
    "invitation.reject": () =>
      `${target ?? "A user"} rejected the invitation`,
    "invitation.accept": () =>
      `${target ?? actor} accepted invitation for ${humanRole(role)} access`,

    "calendar_event.create":  () => `${actor} posted ${kind ?? "an event"}`,
    "calendar_event.update":  () => `${actor} updated ${kind ?? "an event"}`,
    "calendar_event.approve": () => `${actor} approved ${kind ?? "an event"}`,
    "calendar_event.reject":  () => `${actor} rejected ${kind ?? "an event"}`,
    "calendar_event.delete":  () => `${actor} deleted ${kind ?? "an event"}`,

    "opening_balance.update": () => `${actor} updated opening balance`,
    "opening_balance.create": () => `${actor} added opening balance`,

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
    buildSummary({ entityType, action, actorName, targetName, metadata });

  await client.query(
    `INSERT INTO audit_log
       (account_id, actor_user_id, actor_role,
        entity_type, entity_id, action,
        before, after, metadata,
        visibility, summary)
     VALUES ($1,$2,$3,
             $4,$5,$6,
             $7,$8,$9,
             $10,$11)`,
    [
      accountId, actorUserId, actorRole,
      entityType, entityId, action,
      before ? JSON.stringify(scrubForAudit(before)) : null,
      after ? JSON.stringify(scrubForAudit(after)) : null,
      metadata ? JSON.stringify(scrubForAudit(metadata)) : null,
      visibility, summary,
    ],
  );
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
//
// Target resolution order:
//   1. account_member / user → entity_id IS the user id
//   2. member / staff       → entity_id → join table → user_id
//   3. invitation           → after.phone OR after.acceptedBy
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
//
// Visibility rules:
//   * visibility = 'public' → everyone sees it (account events, invitations,
//     calendar, admin grants)
//   * visibility IN ('self','participants') → only if the caller is the
//     actor or the target
//   * member / staff entity rows → always visible to the person themselves
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
      -- 1. Everyone in the account sees public events.
      al.visibility = 'public'

      -- 2. Row-specific events: caller is actor or target.
      OR al.actor_user_id = $2
      OR (al.entity_type IN ('account_member','user') AND al.entity_id = $2)
      OR (al.entity_type = 'member' AND al.entity_id IN (
            SELECT id FROM members WHERE user_id = $2
          ))
      OR (al.entity_type = 'staff' AND al.entity_id IN (
            SELECT id FROM staff WHERE user_id = $2
          ))

      -- 3. Participant/self events where caller is actor or target.
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