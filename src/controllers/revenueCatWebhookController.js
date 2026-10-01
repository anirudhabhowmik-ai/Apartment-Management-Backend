// src/controllers/revenueCatWebhookController.js
const { pool } = require("../config/database");
const { writeAudit } = require("./auditController");

// ============================================================================
// RevenueCat Webhook Handler
// ============================================================================
// Configure this URL in RevenueCat dashboard:
//   Project → Integrations → Webhooks
//   URL: https://your-backend.com/api/webhooks/revenuecat
//   Authorization header value: shared secret (set REVENUECAT_WEBHOOK_SECRET)
// ============================================================================

const HANDLED_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "CANCELLATION",
  "UNCANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
  "SUBSCRIBER_ALIAS",
  "TRANSFER",
]);

// ============================================================================
// Map RevenueCat product IDs → internal plan IDs
// ============================================================================
//
// Google Play now requires a base plan, so RevenueCat reports product IDs
// in the format  "<subscriptionId>:<basePlanId>"  — e.g. "pro_monthly:pro-monthly".
//
// Older / Test Store setups report just "pro_monthly".
//
// This map supports BOTH formats so the webhook never silently drops an event.
// ============================================================================
const PRODUCT_TO_PLAN = {
  // ── Play Store format (with base plan) ──────────────────────────────
  "pro_monthly:pro-monthly":             { planId: "pro",      period: "monthly" },
  "pro_yearly:pro-yearly":               { planId: "pro",      period: "yearly"  },
  "business_monthly:business-monthly":   { planId: "business", period: "monthly" },
  "business_yearly:business-yearly":     { planId: "business", period: "yearly"  },

  // ── Fallback (Test Store / legacy format) ───────────────────────────
  pro_monthly:      { planId: "pro",      period: "monthly" },
  pro_yearly:       { planId: "pro",      period: "yearly"  },
  business_monthly: { planId: "business", period: "monthly" },
  business_yearly:  { planId: "business", period: "yearly"  },
};

// ============================================================================
// Entitlement IDs → plan IDs
// ============================================================================
const ENTITLEMENT_TO_PLAN = {
  pro: "pro",
  business: "business",
};

// ============================================================================
// Helper: resolve a product ID (any format) to { planId, period }
// ============================================================================
function resolveProduct(productId, entitlements) {
  // 1. Exact match
  if (productId && PRODUCT_TO_PLAN[productId]) {
    return PRODUCT_TO_PLAN[productId];
  }

  // 2. If productId contains ":", try the part before the colon
  if (productId && productId.includes(":")) {
    const baseId = productId.split(":")[0];
    if (PRODUCT_TO_PLAN[baseId]) {
      return PRODUCT_TO_PLAN[baseId];
    }
  }

  // 3. Fall back to entitlements
  if (Array.isArray(entitlements) && entitlements.length > 0) {
    for (const e of entitlements) {
      if (ENTITLEMENT_TO_PLAN[e]) {
        return { planId: ENTITLEMENT_TO_PLAN[e], period: "monthly" };
      }
    }
  }

  return null;
}

// ============================================================================
// Main webhook handler
// ============================================================================
const handleRevenueCatWebhook = async (req, res) => {
  const client = await pool.connect();
  try {
    // ── 1. Verify auth ────────────────────────────────────────────────────
    const expectedSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
    const providedAuth = req.headers["authorization"] || "";
    if (expectedSecret && providedAuth !== expectedSecret) {
      console.warn("[revenuecat] webhook rejected: bad auth header");
      return res.status(401).json({ success: false, error: "unauthorized" });
    }

    // ── 2. Parse event ────────────────────────────────────────────────────
    const body = req.body || {};
    const event = body.event || body;
    if (!event || typeof event !== "object") {
      return res.status(400).json({ success: false, error: "invalid_payload" });
    }

    const type         = event.type;
    const appUserId    = event.app_user_id || null;
    const productId    = event.product_id || null;
    const entitlements = Array.isArray(event.entitlement_ids) ? event.entitlement_ids : [];
    const expirationMs = event.expiration_at_ms || null;
    const purchasedMs  = event.purchased_at_ms || null;
    const store        = event.store || null;
    const environment  = event.environment || null;

    console.log(
      `[revenuecat] event=${type} user=${appUserId} product=${productId} entitlements=${entitlements.join(",")}`,
    );

    // ── 3. Ignore unhandled event types ───────────────────────────────────
    if (!HANDLED_EVENTS.has(type)) {
      console.log(`[revenuecat] ignoring event type: ${type}`);
      return res.json({ success: true, ignored: true });
    }

    // ── 4. Need an app_user_id ────────────────────────────────────────────
    if (!appUserId) {
      console.warn("[revenuecat] event has no app_user_id");
      return res.json({ success: true, ignored: true });
    }

    // ── 5. Find the account for this user ─────────────────────────────────
    const { rows: userRows } = await client.query(
      `SELECT id, last_account_id FROM users WHERE id = $1 LIMIT 1`,
      [appUserId],
    );
    if (!userRows.length) {
      console.warn(`[revenuecat] unknown user: ${appUserId}`);
      return res.json({ success: true, ignored: true });
    }

    let accountId = userRows[0].last_account_id;
    if (!accountId) {
      const { rows: ownedRows } = await client.query(
        `SELECT id FROM accounts
          WHERE created_by = $1 AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`,
        [appUserId],
      );
      if (ownedRows.length) accountId = ownedRows[0].id;
    }
    if (!accountId) {
      console.warn(`[revenuecat] no account for user: ${appUserId}`);
      return res.json({ success: true, ignored: true });
    }

    // ── 6. Resolve plan + period ──────────────────────────────────────────
    const resolved = resolveProduct(productId, entitlements);
    const targetPlanId = resolved ? resolved.planId : null;
    const targetPeriod = resolved ? resolved.period : null;

    // ── 7. Handle each event type ─────────────────────────────────────────
    await client.query("BEGIN");

    if (
      type === "INITIAL_PURCHASE" ||
      type === "RENEWAL" ||
      type === "UNCANCELLATION" ||
      type === "PRODUCT_CHANGE"
    ) {
      if (!targetPlanId) {
        await client.query("ROLLBACK");
        console.warn(
          `[revenuecat] could not map product "${productId}" or entitlements [${entitlements.join(",")}] to a plan`,
        );
        return res.json({ success: true, ignored: true });
      }

      const periodEnd   = expirationMs ? new Date(expirationMs).toISOString() : null;
      const periodStart = purchasedMs  ? new Date(purchasedMs).toISOString()  : new Date().toISOString();

      await client.query(
        `INSERT INTO account_subscriptions
           (account_id, plan_id, billing_period, status,
            current_period_start, current_period_end,
            razorpay_payment_id, updated_at)
         VALUES ($1, $2, $3, 'active', $4, $5, NULL, NOW())
         ON CONFLICT (account_id) DO UPDATE SET
           plan_id = EXCLUDED.plan_id,
           billing_period = EXCLUDED.billing_period,
           status = 'active',
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           updated_at = NOW()`,
        [accountId, targetPlanId, targetPeriod, periodStart, periodEnd],
      );

      await writeAudit(client, {
        accountId,
        actorUserId: appUserId,
        actorRole: "system",
        entityType: "subscription",
        entityId: accountId,
        action: "plan_changed",
        after: {
          plan_id: targetPlanId,
          billing_period: targetPeriod,
          source: "revenuecat",
          event_type: type,
          store,
          environment,
          product_id: productId,
        },
        metadata: { source: "revenuecat", event_type: type, product_id: productId },
        visibility: "public",
      });

      console.log(
        `[revenuecat] account ${accountId} → ${targetPlanId} (${targetPeriod}), expires ${periodEnd}`,
      );
    } else if (type === "CANCELLATION") {
      // Keep access until period end; EXPIRATION will downgrade later.
      await client.query(
        `UPDATE account_subscriptions SET updated_at = NOW() WHERE account_id = $1`,
        [accountId],
      );
      await writeAudit(client, {
        accountId,
        actorUserId: appUserId,
        actorRole: "system",
        entityType: "subscription",
        entityId: accountId,
        action: "cancelled",
        metadata: {
          source: "revenuecat",
          event_type: "CANCELLATION",
          note: "access_kept_until_period_end",
        },
        visibility: "public",
      });
      console.log(`[revenuecat] account ${accountId} cancelled — will expire at period end`);
    } else if (type === "EXPIRATION") {
      await client.query(
        `UPDATE account_subscriptions
            SET plan_id = 'free',
                billing_period = 'monthly',
                status = 'active',
                current_period_start = NULL,
                current_period_end = NULL,
                updated_at = NOW()
          WHERE account_id = $1`,
        [accountId],
      );
      await writeAudit(client, {
        accountId,
        actorUserId: appUserId,
        actorRole: "system",
        entityType: "subscription",
        entityId: accountId,
        action: "cancelled",
        metadata: {
          source: "revenuecat",
          event_type: "EXPIRATION",
          note: "downgraded_to_free",
        },
        visibility: "public",
      });
      console.log(`[revenuecat] account ${accountId} expired → downgraded to free`);
    } else if (type === "BILLING_ISSUE") {
      await writeAudit(client, {
        accountId,
        actorUserId: appUserId,
        actorRole: "system",
        entityType: "subscription",
        entityId: accountId,
        action: "billing_issue",
        metadata: { source: "revenuecat", event_type: "BILLING_ISSUE", product_id: productId },
        visibility: "admin",
      });
      console.log(`[revenuecat] account ${accountId} billing issue`);
    }

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[revenuecat] webhook error:", err);
    return res.status(500).json({ success: false, error: "server_error" });
  } finally {
    client.release();
  }
};

module.exports = { handleRevenueCatWebhook };