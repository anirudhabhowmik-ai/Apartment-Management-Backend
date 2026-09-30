// src/controllers/auditController.js
const { pool } = require("../config/database");
const { projectNotifications } = require("./notificationController");
const { getSubscriptionForAccount } = require("../utils/subscription");

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
// Plan gate — history is a paid feature.
// ---------------------------------------------------------------------------
async function canAccessHistory(accountId) {
  try {
    const sub = await getSubscriptionForAccount(pool, accountId);
    return sub.effectivePlanId !== "free" || sub.isTrial === true;
  } catch (err) {
    console.warn("canAccessHistory failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Friendly role label — tenant-aware
// ---------------------------------------------------------------------------
function humanRole(role, isHome = false) {
  if (!role) return "access";
  switch (String(role)) {
    case "owner":              return "owner access";
    case "admin":              return "admin access";
    case "member_visibility":  return isHome ? "tenant access" : "member access";
    case "staff_visibility":   return "staff access";
    case "ownership_transfer": return "ownership";
    default:                   return String(role).replace(/_/g, " ");
  }
}

function joinedLabel(role, isHome = false) {
  if (!role) return "a member";
  switch (String(role)) {
    case "admin":              return "an admin";
    case "member_visibility":  return isHome ? "a tenant" : "a member";
    case "staff_visibility":   return "a staff member";
    case "ownership_transfer": return "the owner";
    default:                   return String(role).replace(/_/g, " ");
  }
}

// ---------------------------------------------------------------------------
// Human-readable summary builder — tenant-aware
// ---------------------------------------------------------------------------
function buildSummary(e, isHome = false) {
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

  const roleLabel = humanRole(role, isHome);
  const memberNoun = isHome ? "room rent" : "property";
  const paymentNoun = isHome ? "rent" : "maintenance";

  const map = {
    "account.create": () => `${actor} created the account`,
    "account.update": () => `${actor} updated the account`,
    "account.delete": () => `${actor} deleted the account`,
    "account.transfer_ownership": () =>
      target
        ? `${actor} transferred ownership to ${target}`
        : `${actor} transferred ownership`,

    "member.create": () =>
      isSamePerson
        ? `${actor} added their own ${memberNoun}`
        : `${actor} added ${memberNoun} for ${targetForBody}`,
    "member.update": () =>
      isSamePerson
        ? `${actor} updated their own ${memberNoun} details`
        : `${actor} updated ${targetForBody}'s ${memberNoun} details`,
    "member.delete": () =>
      isSamePerson
        ? `${actor} removed their own ${memberNoun}`
        : `${actor} removed ${memberNoun} from ${targetForBody}`,

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

    "member.payment_paid": () =>
      isSamePerson
        ? `${actor} marked their own ${paymentNoun} as PAID`
        : `${actor} marked ${paymentNoun} PAID for ${targetForBody}`,
    "member.payment_due": () =>
      isSamePerson
        ? `${actor} marked their own ${paymentNoun} as DUE`
        : `${actor} marked ${paymentNoun} DUE for ${targetForBody}`,
    "staff.payment_paid": () =>
      isSamePerson
        ? `${actor} marked their own salary as PAID`
        : `${actor} marked salary PAID for ${targetForBody}`,
    "staff.payment_due": () =>
      isSamePerson
        ? `${actor} marked their own salary as DUE`
        : `${actor} marked salary DUE for ${targetForBody}`,

    "expense.create": () => `${actor} added an expense`,
    "expense.update": () => `${actor} updated an expense`,
    "expense.delete": () => `${actor} deleted an expense`,

    "account_member.role_granted": () =>
      isSamePerson
        ? `${actor} granted themselves ${roleLabel}`
        : `${actor} granted ${roleLabel} to ${targetForBody}`,
    "account_member.role_revoked": () =>
      isSamePerson
        ? `${actor} revoked their own ${roleLabel}`
        : `${actor} removed ${roleLabel} from ${targetForBody}`,

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
// Resolve a user's name
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
// Look up account type once per writeAudit call
// ---------------------------------------------------------------------------
async function resolveIsHomeAccount(client, accountId) {
  if (!accountId) return false;
  try {
    const { rows } = await client.query(
      `SELECT type FROM accounts WHERE id = $1`,
      [accountId],
    );
    return String(rows[0]?.type ?? "").toLowerCase() === "home";
  } catch {
    return false;
  }
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

  const isHome = await resolveIsHomeAccount(client, accountId);

  const summary =
    providedSummary ||
    buildSummary(
      {
        entityType,
        action,
        actorName,
        targetName,
        actorUserId,
        targetUserId,
        metadata,
      },
      isHome,
    );

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
      isHome,
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
// Shared SELECT
//
// NOTE: `audit_log` does NOT have a `target_user_id` column. The target user
// is resolved at query time via the `tu` lateral join and aliased as
// `tu.id AS target_user_id` in the SELECT list.
//
// This means we cannot reference `al.target_user_id` anywhere. Any filter
// that needs the resolved target user must reference `tu.id` instead — which
// works because PostgreSQL allows lateral-join aliases in the WHERE clause.
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
    SELECT u.id, u.name, u.phone, u.photo_url
      FROM users u
     WHERE al.entity_type = 'account_member' AND u.id = al.entity_id
    UNION ALL
    SELECT u.id, u.name, u.phone, u.photo_url
      FROM users u
     WHERE al.entity_type = 'user' AND u.id = al.entity_id

    UNION ALL
    SELECT u.id, u.name, u.phone, u.photo_url
      FROM members m JOIN users u ON u.id = m.user_id
     WHERE al.entity_type = 'member' AND m.id = al.entity_id
    UNION ALL
    SELECT u.id, u.name, u.phone, u.photo_url
      FROM staff s JOIN users u ON u.id = s.user_id
     WHERE al.entity_type = 'staff' AND s.id = al.entity_id

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
// SQL fragment: hide self-service role grants that duplicate an
// invitation.accept row.
//
// When someone accepts an invitation, the backend writes BOTH:
//   1. invitation.accept           → "X accepted invitation for tenant access"
//   2. account_member.role_granted → "X granted themselves tenant access"
//
// We suppress the self-grant on the server so every client gets clean data.
//
// IMPORTANT: audit_log has NO target_user_id column. The resolved target
// user id comes from the lateral join alias `tu.id` — which is why we
// reference `tu.id` here, NOT `al.target_user_id`.
//
// Self-grant detection:
//   • actor_user_id equals the resolved target user id (tu.id), OR
//   • actor_user_id equals the user_id stored in the `after` JSONB
//     (used as a fallback when the lateral join couldn't resolve tu.id).
// ---------------------------------------------------------------------------
const SELF_GRANT_FILTER = `
  NOT (
    al.entity_type = 'account_member'
    AND al.action = 'role_granted'
    AND al.actor_user_id IS NOT NULL
    AND (
      (tu.id IS NOT NULL AND al.actor_user_id = tu.id)
      OR (al.after->>'user_id' IS NOT NULL
          AND al.actor_user_id::text = al.after->>'user_id')
    )
  )
`;

// ---------------------------------------------------------------------------
// GET /history — OWNER / ADMIN only
// ---------------------------------------------------------------------------
const getAccountHistory = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden");
    if (!isAdminLike(role)) return fail(res, 403, "forbidden");

    const allowed = await canAccessHistory(accountId);
    if (!allowed) {
      return fail(
        res,
        403,
        "history_requires_plan",
        "History is available on paid plans. Upgrade to view history.",
      );
    }

    const entityType = req.query.entityType || null;
    const entityId   = req.query.entityId   || null;
    const before     = req.query.before     || null;
    const limit      = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const params = [accountId];
    let where = `al.account_id = $1`;

    // Hide duplicate self-service role grants.
    where += ` AND ${SELF_GRANT_FILTER}`;

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
// GET /history/me — MEMBER or STAFF. Tenant-aware.
// ---------------------------------------------------------------------------
const getMyHistory = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden");

    const allowed = await canAccessHistory(accountId);
    if (!allowed) {
      return fail(
        res,
        403,
        "history_requires_plan",
        "History is available on paid plans. Upgrade to view history.",
      );
    }

    const { rows: acctRows } = await pool.query(
      `SELECT type FROM accounts WHERE id = $1`,
      [accountId],
    );
    const accountType = String(acctRows[0]?.type ?? "").toLowerCase();
    const isHome = accountType === "home";
    const isTenantViewer = isHome && role === "member_visibility";

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

    // Hide duplicate self-service role grants.
    where += ` AND ${SELF_GRANT_FILTER}`;

    if (isTenantViewer) {
      params.push(userId);
      const uidIdx = params.length;
      where += ` AND (
        al.entity_type NOT IN (
          'expense',
          'opening_balance',
          'subscription'
        )
        AND NOT (
          al.entity_type = 'member'
          AND al.action LIKE 'payment_%'
          AND al.entity_id NOT IN (
            SELECT id FROM members WHERE user_id = $${uidIdx}
          )
        )
        AND NOT (
          al.entity_type = 'staff'
          AND al.action LIKE 'payment_%'
          AND al.entity_id NOT IN (
            SELECT id FROM staff WHERE user_id = $${uidIdx}
          )
        )
      )`;
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