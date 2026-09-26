// src/services/push.js
//
// Everything push-notification-related in one place.

const cron = require("node-cron");
const { Expo } = require("expo-server-sdk");
const { pool } = require("../config/database");
const { writeAudit } = require("../controllers/auditController");

const expo = new Expo();

// How many days in a row to remind while an expense is still 'due'.
const MAX_REMINDER_DAYS = 7;

// ============================================================================
// 1. PUSH TOKENS
// ============================================================================

async function savePushToken(userId, token, platform = null) {
  const normalizedPlatform =
    platform === "ios" || platform === "android" || platform === "web"
      ? platform
      : null;

  await pool.query(
    `INSERT INTO user_push_tokens (user_id, token, platform, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, token)
     DO UPDATE SET platform = EXCLUDED.platform, updated_at = NOW()`,
    [userId, token, normalizedPlatform],
  );
}

async function deletePushToken(userId, token) {
  if (!token) return;
  await pool.query(
    `DELETE FROM user_push_tokens WHERE user_id = $1 AND token = $2`,
    [userId, token],
  );
}

// ============================================================================
// 2. DELIVERY WORKER
// ============================================================================

async function deliverPendingNotifications() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: pending } = await client.query(
      `SELECT id, user_id, title, body, data, entity_type, entity_id, action
         FROM notifications
        WHERE pushed_at IS NULL
          AND dismissed_at IS NULL
        ORDER BY created_at
        LIMIT 200
        FOR UPDATE SKIP LOCKED`,
    );

    if (pending.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    const userIds = [...new Set(pending.map((n) => n.user_id))];

    // Only fetch tokens for users who haven't turned push off.
    const { rows: tokenRows } = await client.query(
      `SELECT t.user_id, t.token
         FROM user_push_tokens t
        WHERE t.user_id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM notification_preferences np
             WHERE np.user_id = t.user_id
               AND np.preference_key = 'push_enabled'
               AND np.enabled = FALSE
          )`,
      [userIds],
    );

    const tokensByUser = new Map();
    for (const t of tokenRows) {
      if (!Expo.isExpoPushToken(t.token)) continue;
      if (!tokensByUser.has(t.user_id)) tokensByUser.set(t.user_id, []);
      tokensByUser.get(t.user_id).push(t.token);
    }

    const messages = [];

    for (const n of pending) {
      const tokens = tokensByUser.get(n.user_id) || [];
      for (const token of tokens) {
        messages.push({
          to: token,
          sound: "default",
          title: n.title,
          body: n.body || undefined,
          channelId: "default",
          data: {
            ...(n.data || {}),
            notificationId: n.id,
            entityType: n.entity_type,
            entityId: n.entity_id,
            action: n.action,
          },
        });
      }
    }

    const deadTokens = new Set();
    if (messages.length > 0) {
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          tickets.forEach((ticket, i) => {
            if (
              ticket.status === "error" &&
              ticket.details &&
              ticket.details.error === "DeviceNotRegistered"
            ) {
              deadTokens.add(chunk[i].to);
            }
          });
        } catch (e) {
          console.error("[push] Expo send failed:", e.message);
        }
      }
    }

    if (deadTokens.size > 0) {
      await client.query(
        `DELETE FROM user_push_tokens WHERE token = ANY($1::text[])`,
        [[...deadTokens]],
      );
    }

    await client.query(
      `UPDATE notifications SET pushed_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [pending.map((n) => n.id)],
    );

    await client.query("COMMIT");
    return pending.length;
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[push] deliverPendingNotifications error:", e);
    return 0;
  } finally {
    client.release();
  }
}

// ============================================================================
// 3. REMINDER RUNNER
// ============================================================================

function computeDefaultRemindAt(expenseDateStr) {
  const base = expenseDateStr
    ? new Date(`${expenseDateStr}T09:00:00`)
    : new Date();
  if (isNaN(base.getTime())) return new Date(Date.now() + 60 * 1000);

  const remindAt = new Date(base.getTime() - 24 * 60 * 60 * 1000);
  if (remindAt.getTime() <= Date.now()) {
    return new Date(Date.now() + 60 * 1000);
  }
  return remindAt;
}

function tomorrowNineAM() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(9, 0, 0, 0);
  return t;
}

async function runDueReminders() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: due } = await client.query(
      `SELECT id, account_id, entity_type, entity_id, payload, remind_at
         FROM scheduled_reminders
        WHERE sent_at IS NULL
          AND remind_at <= NOW()
        ORDER BY remind_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED`,
    );

    if (due.length === 0) {
      await client.query("COMMIT");
      return 0;
    }

    for (const r of due) {
      const p = r.payload || {};
      const isIncome = p.transaction_type === "income";

      const title = isIncome ? "Income reminder" : "Payment due reminder";
      const summary = isIncome
        ? `Income pending: ${p.title || "Income"} (₹${p.amount ?? 0})`
        : `Payment due: ${p.title || "Expense"} (₹${p.amount ?? 0})`;

      try {
        await writeAudit(client, {
          accountId: r.account_id,
          actorUserId: null,
          actorRole: "system",
          entityType: r.entity_type,
          entityId: r.entity_id,
          action: "expense_reminder",
          after: { reminder: true, ...p },
          metadata: {
            scheduledReminderId: r.id,
            title,
            summary,
            isIncome,
            notificationTitle: title,
            notificationBody: summary,
          },
          visibility: "admin",
          summary,
        });

        const { rows: statusRows } = await client.query(
          `SELECT status FROM expenses WHERE id = $1`,
          [r.entity_id],
        );
        const stillDue = statusRows[0]?.status === "due";

        const { rows: countRows } = await client.query(
          `SELECT COUNT(*)::int AS c
             FROM audit_log
            WHERE entity_type = 'expense'
              AND entity_id = $1
              AND action = 'expense_reminder'
              AND created_at > NOW() - INTERVAL '${MAX_REMINDER_DAYS} days'`,
          [r.entity_id],
        );
        const remindersSent = countRows[0]?.c ?? 0;

        if (stillDue && remindersSent < MAX_REMINDER_DAYS) {
          await client.query(
            `UPDATE scheduled_reminders
                SET remind_at = $2,
                    updated_at = NOW()
              WHERE id = $1`,
            [r.id, tomorrowNineAM()],
          );
        } else {
          await client.query(
            `UPDATE scheduled_reminders
                SET sent_at = NOW(),
                    updated_at = NOW()
              WHERE id = $1`,
            [r.id],
          );
        }
      } catch (inner) {
        console.error("[push] reminder failed id=", r.id, inner.message);
      }
    }

    await client.query("COMMIT");
    return due.length;
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[push] runDueReminders error:", e);
    return 0;
  } finally {
    client.release();
  }
}

// ============================================================================
// 4. SCHEDULING HELPERS
// ============================================================================

async function upsertExpenseReminder(client, {
  accountId,
  expenseId,
  expenseDate,
  payload,
}) {
  const remindAt = computeDefaultRemindAt(expenseDate);
  await client.query(
    `INSERT INTO scheduled_reminders
       (account_id, entity_type, entity_id, remind_at, payload, updated_at)
     VALUES ($1, 'expense', $2, $3, $4::jsonb, NOW())
     ON CONFLICT (entity_type, entity_id)
     DO UPDATE SET remind_at = EXCLUDED.remind_at,
                   payload   = EXCLUDED.payload,
                   updated_at = NOW()`,
    [accountId, expenseId, remindAt, JSON.stringify(payload)],
  );
}

async function cancelExpenseReminder(client, expenseId) {
  await client.query(
    `DELETE FROM scheduled_reminders
      WHERE entity_type = 'expense' AND entity_id = $1`,
    [expenseId],
  );
}

// ============================================================================
// 5. STARTUP
// ============================================================================

let started = false;

function startPushWorker() {
  if (started) return;
  started = true;

  cron.schedule("*/1 * * * *", () => {
    deliverPendingNotifications().catch((e) =>
      console.error("[push] delivery cron error:", e),
    );
  });

  cron.schedule("*/1 * * * *", () => {
    runDueReminders().catch((e) =>
      console.error("[push] reminder cron error:", e),
    );
  });

  console.log("[push] worker started (delivery + reminders, every 1 min)");
}

module.exports = {
  savePushToken,
  deletePushToken,
  deliverPendingNotifications,
  runDueReminders,
  upsertExpenseReminder,
  cancelExpenseReminder,
  startPushWorker,
};