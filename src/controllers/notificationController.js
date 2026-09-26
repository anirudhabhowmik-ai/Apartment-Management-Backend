// src/controllers/notificationController.js
const { pool } = require("../config/database");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const fail = (res, status, code, message) =>
  res.status(status).json({ code, message });

// ---------------------------------------------------------------------------
// Who is who in an account
// ---------------------------------------------------------------------------
async function getAccountAudience(client, accountId) {
  const { rows: owners } = await client.query(
    `SELECT created_by AS user_id FROM accounts WHERE id = $1`,
    [accountId],
  );
  const { rows: admins } = await client.query(
    `SELECT user_id FROM account_members
      WHERE account_id = $1 AND role = 'admin' AND status = 'active'`,
    [accountId],
  );
  const { rows: members } = await client.query(
    `SELECT user_id FROM account_members
      WHERE account_id = $1 AND role = 'member_visibility' AND status = 'active'`,
    [accountId],
  );
  const { rows: staff } = await client.query(
    `SELECT user_id FROM account_members
      WHERE account_id = $1 AND role = 'staff_visibility' AND status = 'active'`,
    [accountId],
  );

  const ownerIds = owners.map((r) => r.user_id).filter(Boolean);
  const adminIds = admins.map((r) => r.user_id).filter(Boolean);
  const memberIds = members.map((r) => r.user_id).filter(Boolean);
  const staffIds = staff.map((r) => r.user_id).filter(Boolean);

  return {
    owners: ownerIds,
    admins: adminIds,
    members: memberIds,
    staff: staffIds,
    adminLike: [...new Set([...ownerIds, ...adminIds])],
    everyone: [
      ...new Set([...ownerIds, ...adminIds, ...memberIds, ...staffIds]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Rule table — audit entry → recipient ids + category
// ---------------------------------------------------------------------------
async function resolveRecipients(client, entry, audience) {
  const {
    actorUserId, targetUserId,
    entityType, action, metadata = {},
    before, after,
  } = entry;

  const role = metadata?.role;
  const kind = metadata?.kind;
  const type = metadata?.type || after?.type;
  const isNotice = type === "notice" || kind === "a notice";
  const isEvent = !isNotice;

  const add = (...ids) => ids.flat().filter(Boolean);
  const uniq = (arr) => [...new Set(arr)];

  if (
    (entityType === "member" || entityType === "staff") &&
    (action === "payment_paid" || action === "payment_due")
  ) {
    return {
      recipients: uniq(add(targetUserId, audience.adminLike)),
      category: "payment",
      preferenceKey: "payments",
    };
  }

  if (entityType === "calendar_event") {
    if (action === "create") {
      if (isNotice) {
        return {
          recipients: audience.everyone,
          category: "notice",
          preferenceKey: "notices",
        };
      }
      const actorIsAdminLike = audience.adminLike.includes(actorUserId);
      if (actorIsAdminLike) {
        return {
          recipients: audience.everyone,
          category: "event",
          preferenceKey: "events",
        };
      }
      return {
        recipients: audience.adminLike,
        category: "event_approval",
        preferenceKey: "event_approvals",
      };
    }

    if (action === "approve" || action === "reject" || action === "delete") {
      const posterId =
        after?.created_by_id || before?.created_by_id || null;
      let recipients = uniq(add(audience.adminLike, posterId));
      if (action === "approve" && isEvent) {
        recipients = uniq(add(audience.everyone, posterId));
      }
      return {
        recipients,
        category: `event_${action}`,
        preferenceKey: "events",
      };
    }

    if (action === "update") {
      const posterId =
        after?.created_by_id || before?.created_by_id || actorUserId || null;
      return {
        recipients: uniq(add(audience.adminLike, posterId)),
        category: "event_update",
        preferenceKey: "events",
      };
    }
  }

  if (entityType === "invitation") {
    // ── FIX ──
    // Always include the invitee, for ALL roles (admin, ownership, member,
    // staff). Owners/admins still get a copy so they know an invite went out.
    if (action === "create" || action === "delete") {
      return {
        recipients: uniq(add(audience.adminLike, targetUserId)),
        category: "invitation",
        preferenceKey: "invitations",
      };
    }
    if (action === "accept") {
      const isAdminRole =
        role === "admin" || role === "ownership_transfer";
      return {
        recipients: isAdminRole
          ? audience.everyone
          : uniq(add(audience.adminLike, targetUserId)),
        category: "invitation",
        preferenceKey: "invitations",
      };
    }
    if (action === "reject") {
      return {
        recipients: uniq(add(audience.adminLike, targetUserId)),
        category: "invitation",
        preferenceKey: "invitations",
      };
    }
  }

  if (entityType === "account_member") {
    const isAdminRole =
      role === "admin" || role === "ownership_transfer";
    return {
      recipients: isAdminRole
        ? audience.everyone
        : uniq(add(audience.adminLike, targetUserId)),
      category: "role",
      preferenceKey: "role_changes",
    };
  }

  if (entityType === "account" && action === "transfer_ownership") {
    return {
      recipients: audience.everyone,
      category: "account",
      preferenceKey: "account",
    };
  }

  if (
    (entityType === "member" || entityType === "staff") &&
    (action === "create" || action === "update" || action === "delete")
  ) {
    return {
      recipients: audience.adminLike,
      category: "roster",
      preferenceKey: "roster",
    };
  }

  if (entityType === "expense") {
    return {
      recipients: audience.everyone,
      category: "expense",
      preferenceKey: "expenses",
    };
  }

  if (entry.visibility === "public") {
    return {
      recipients: audience.everyone,
      category: "general",
      preferenceKey: "general",
    };
  }
  if (entry.visibility === "admin") {
    return {
      recipients: audience.adminLike,
      category: "general",
      preferenceKey: "general",
    };
  }
  return {
    recipients: uniq(add(actorUserId, targetUserId, audience.adminLike)),
    category: "general",
    preferenceKey: "general",
  };
}

// ---------------------------------------------------------------------------
// Human-readable role labels
// ---------------------------------------------------------------------------
function humanRole(raw) {
  if (!raw) return "access";
  switch (String(raw)) {
    case "admin":              return "admin access";
    case "member_visibility":  return "member access";
    case "staff_visibility":   return "staff access";
    case "ownership_transfer": return "ownership";
    default:                   return String(raw).replace(/_/g, " ");
  }
}

function joinedLabel(raw) {
  if (!raw) return "a member";
  switch (String(raw)) {
    case "admin":              return "an admin";
    case "member_visibility":  return "a member";
    case "staff_visibility":   return "a staff member";
    case "ownership_transfer": return "the owner";
    default:                   return String(raw).replace(/_/g, " ");
  }
}

// ---------------------------------------------------------------------------
// Name resolution — returns "You" when the id matches the viewer
// ---------------------------------------------------------------------------
function nameFor(rawName, subjectUserId, viewerUserId) {
  if (
    subjectUserId &&
    viewerUserId &&
    String(subjectUserId) === String(viewerUserId)
  ) {
    return "You";
  }
  return rawName || "someone";
}

// ---------------------------------------------------------------------------
// Notification content (title/body) — personalized per viewer
// ---------------------------------------------------------------------------
function buildNotificationContent(entry) {
  const viewerUserId = entry.viewerUserId ?? null;

  const actor = nameFor(entry.actorName, entry.actorUserId, viewerUserId);
  const target = nameFor(entry.targetName, entry.targetUserId, viewerUserId);

  const actorIsViewer = !!(
    entry.actorUserId &&
    viewerUserId &&
    String(entry.actorUserId) === String(viewerUserId)
  );

  const targetIsViewer = !!(
    entry.targetUserId &&
    viewerUserId &&
    String(entry.targetUserId) === String(viewerUserId)
  );

  const samePerson = !!(
    entry.actorUserId &&
    entry.targetUserId &&
    String(entry.actorUserId) === String(entry.targetUserId)
  );

  const k = `${entry.entityType}.${entry.action}`;
  const meta = entry.metadata || {};
  const kind = meta.kind ?? "an event";
  const role = humanRole(meta.role);
  const roleJoin = joinedLabel(meta.role);

  const map = {
    // ---- Payments ----
    "member.payment_paid": () =>
      samePerson && actorIsViewer
        ? {
            title: "Maintenance paid",
            body: "You marked your own maintenance as PAID.",
          }
        : samePerson
          ? {
              title: "Maintenance paid",
              body: `${actor} marked their own maintenance as PAID.`,
            }
          : {
              title: "Maintenance paid",
              body: `${actor} marked maintenance PAID for ${target}.`,
            },

    "member.payment_due": () =>
      samePerson && actorIsViewer
        ? {
            title: "Maintenance due",
            body: "You marked your own maintenance as DUE.",
          }
        : samePerson
          ? {
              title: "Maintenance due",
              body: `${actor} marked their own maintenance as DUE.`,
            }
          : {
              title: "Maintenance due",
              body: `${actor} marked maintenance DUE for ${target}.`,
            },

    "staff.payment_paid": () =>
      samePerson && actorIsViewer
        ? {
            title: "Salary paid",
            body: "You marked your own salary as PAID.",
          }
        : samePerson
          ? {
              title: "Salary paid",
              body: `${actor} marked their own salary as PAID.`,
            }
          : {
              title: "Salary paid",
              body: `${actor} marked salary PAID for ${target}.`,
            },

    "staff.payment_due": () =>
      samePerson && actorIsViewer
        ? {
            title: "Salary due",
            body: "You marked your own salary as DUE.",
          }
        : samePerson
          ? {
              title: "Salary due",
              body: `${actor} marked their own salary as DUE.`,
            }
          : {
              title: "Salary due",
              body: `${actor} marked salary DUE for ${target}.`,
            },

    // ---- Calendar events ----
    "calendar_event.create": () => {
      const isNotice = meta.kind === "a notice" || meta.type === "notice";
      return {
        title: isNotice ? "New notice posted" : "New event posted",
        body: isNotice
          ? `${actor} posted a new notice.`
          : `${actor} posted a new event.`,
      };
    },
    "calendar_event.update": () => ({
      title: "Event updated",
      body: `${actor} updated ${kind}.`,
    }),
    "calendar_event.approve": () => ({
      title: "Event approved",
      body: `${actor} approved ${kind}.`,
    }),
    "calendar_event.reject": () => ({
      title: "Event rejected",
      body: `${actor} rejected ${kind}.`,
    }),
    "calendar_event.delete": () => ({
      title: "Event deleted",
      body: `${actor} deleted ${kind}.`,
    }),

    // ---- Invitations ----
    "invitation.create": () =>
      targetIsViewer
        ? {
            title: "New invitation",
            body: `${actor} invited you for ${role}.`,
          }
        : {
            title: "New invitation",
            body: `${actor} invited ${target} for ${role}.`,
          },

    "invitation.accept": () =>
      targetIsViewer
        ? {
            title: "Invitation accepted",
            body: `You joined as ${roleJoin}.`,
          }
        : {
            title: "Invitation accepted",
            body: `${target} joined as ${roleJoin}.`,
          },

    "invitation.reject": () =>
      targetIsViewer
        ? {
            title: "Invitation rejected",
            body: "You rejected the invitation.",
          }
        : {
            title: "Invitation rejected",
            body: `${target} rejected the invitation.`,
          },

    "invitation.delete": () => ({
      title: "Invitation cancelled",
      body: `${actor} cancelled an invitation.`,
    }),

    // ---- Account member role changes ----
    "account_member.role_granted": () => {
      if (samePerson && actorIsViewer) {
        return {
          title: "Access granted",
          body: `You granted yourself ${role}.`,
        };
      }
      if (samePerson) {
        return {
          title: "Access granted",
          body: `${actor} granted themselves ${role}.`,
        };
      }
      if (targetIsViewer) {
        return {
          title: "Access granted",
          body: `${actor} granted you ${role}.`,
        };
      }
      return {
        title: "Access granted",
        body: `${actor} granted ${role} to ${target}.`,
      };
    },

    "account_member.role_revoked": () => {
      if (samePerson && actorIsViewer) {
        return {
          title: "Access removed",
          body: `You revoked your ${role}.`,
        };
      }
      if (samePerson) {
        return {
          title: "Access removed",
          body: `${actor} revoked their ${role}.`,
        };
      }
      if (targetIsViewer) {
        return {
          title: "Access removed",
          body: `${actor} removed your ${role}.`,
        };
      }
      return {
        title: "Access removed",
        body: `${actor} removed ${role} from ${target}.`,
      };
    },

    // ---- Ownership ----
    "account.transfer_ownership": () =>
      targetIsViewer
        ? {
            title: "Ownership transferred",
            body: `${actor} transferred ownership to you.`,
          }
        : {
            title: "Ownership transferred",
            body: `${actor} transferred ownership to ${target}.`,
          },

    // ---- Roster ----
    "member.create": () => ({
      title: "Member added",
      body: `${actor} added ${target}.`,
    }),
    "member.update": () => ({
      title: "Member updated",
      body: `${actor} updated ${target}.`,
    }),
    "member.delete": () => ({
      title: "Member removed",
      body: `${actor} removed ${target}.`,
    }),
    "staff.create": () => ({
      title: "Staff added",
      body: `${actor} added ${target}.`,
    }),
    "staff.update": () => ({
      title: "Staff updated",
      body: `${actor} updated ${target}.`,
    }),
    "staff.delete": () => ({
      title: "Staff removed",
      body: `${actor} removed ${target}.`,
    }),

    // ---- Expenses ----
    "expense.create": () => ({
      title: "Expense added",
      body: `${actor} added an expense.`,
    }),
    "expense.update": () => ({
      title: "Expense updated",
      body: `${actor} updated an expense.`,
    }),
    "expense.delete": () => ({
      title: "Expense deleted",
      body: `${actor} deleted an expense.`,
    }),
  };

  const built = map[k]?.();
  return (
    built || {
      title: "Activity",
      body: entry.summary || `${actor} performed ${k}.`,
    }
  );
}

// ---------------------------------------------------------------------------
// Freshly resolve a user's display name from the DB
// ---------------------------------------------------------------------------
async function freshUserName(client, userId) {
  if (!userId) return null;
  try {
    const { rows } = await client.query(
      `SELECT name FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    return rows[0]?.name ?? null;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// projectNotifications — called from writeAudit inside the same transaction
// ---------------------------------------------------------------------------
async function projectNotifications(client, entry) {
  if (!entry.accountId) return;

  const audience = await getAccountAudience(client, entry.accountId);
  const { recipients, category, preferenceKey } = await resolveRecipients(
    client,
    entry,
    audience,
  );

  if (!recipients || recipients.length === 0) return;

  // Preferences filter (best effort)
  let finalRecipients = recipients;
  try {
    const { rows: optedOut } = await client.query(
      `SELECT user_id FROM notification_preferences
        WHERE user_id = ANY($1::uuid[])
          AND preference_key = $2
          AND enabled = FALSE`,
      [recipients, preferenceKey],
    );
    const optedOutSet = new Set(optedOut.map((r) => r.user_id));
    finalRecipients = recipients.filter((id) => !optedOutSet.has(id));
  } catch (_e) {
    // ignore
  }

  if (finalRecipients.length === 0) return;

  // Resolve fresh names from the DB — never trust anything in metadata.
  const actorName = await freshUserName(client, entry.actorUserId);
  const targetName = await freshUserName(client, entry.targetUserId);

  const data = {
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    category,
    metadata: entry.metadata,
  };

  for (const userId of finalRecipients) {
    const { title, body } = buildNotificationContent({
      ...entry,
      actorName,
      targetName,
      viewerUserId: userId,
    });

    await client.query(
      `INSERT INTO notifications
         (account_id, user_id, audit_log_id, entity_type, entity_id, action,
          title, body, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (audit_log_id, user_id) DO NOTHING`,
      [
        entry.accountId,
        userId,
        entry.auditId ?? null,
        entry.entityType,
        entry.entityId,
        entry.action,
        title,
        body,
        JSON.stringify(data),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
const listNotifications = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const accountId = req.query.accountId || null;
    const before = req.query.before || null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const unreadOnly = req.query.unreadOnly === "true";

    const params = [userId];
    let where = `user_id = $1 AND dismissed_at IS NULL`;

    if (accountId) {
      params.push(accountId);
      where += ` AND account_id = $${params.length}`;
    }
    if (unreadOnly) where += ` AND read_at IS NULL`;
    if (before) {
      params.push(before);
      where += ` AND created_at < $${params.length}`;
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT id, account_id, entity_type, entity_id, action,
              title, body, data, read_at, created_at
         FROM notifications
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS unread
         FROM notifications
        WHERE user_id = $1 AND read_at IS NULL AND dismissed_at IS NULL`,
      [userId],
    );

    return res.json({
      notifications: rows,
      unreadCount: countRows[0]?.unread ?? 0,
    });
  } catch (err) {
    console.error("listNotifications error:", err);
    return fail(res, 500, "server_error", "Failed to load notifications");
  }
};

const markRead = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const { id } = req.params;
    await pool.query(
      `UPDATE notifications SET read_at = NOW()
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
      [id, userId],
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("markRead error:", err);
    return fail(res, 500, "server_error", "Failed to mark as read");
  }
};

const markAllRead = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const accountId = req.query.accountId || null;
    if (accountId) {
      await pool.query(
        `UPDATE notifications SET read_at = NOW()
          WHERE user_id = $1 AND account_id = $2 AND read_at IS NULL`,
        [userId, accountId],
      );
    } else {
      await pool.query(
        `UPDATE notifications SET read_at = NOW()
          WHERE user_id = $1 AND read_at IS NULL`,
        [userId],
      );
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("markAllRead error:", err);
    return fail(res, 500, "server_error", "Failed to mark all as read");
  }
};

const dismiss = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const { id } = req.params;
    await pool.query(
      `UPDATE notifications SET dismissed_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("dismiss error:", err);
    return fail(res, 500, "server_error", "Failed to dismiss notification");
  }
};

module.exports = {
  getAccountAudience,
  resolveRecipients,
  buildNotificationContent,
  projectNotifications,
  listNotifications,
  markRead,
  markAllRead,
  dismiss,
};