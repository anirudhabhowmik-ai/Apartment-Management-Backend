// src/controllers/revenueCatWebhookController.js
const { pool } = require("../config/database");
const { writeAudit } = require("./auditController");

// ============================================================================
// RevenueCat Webhook Handler
// ============================================================================
//
// RevenueCat sends POST requests to this endpoint whenever a subscription
// lifecycle event happens: purchase, renewal, cancellation, refund, etc.
//
// We use these events to keep our `account_subscriptions` table in sync with
// what the user actually has on Google Play / App Store.
//
// Configure this URL in RevenueCat dashboard:
//   Project → Integrations → Webhooks
//   URL: https://your-backend.com/api/webhooks/revenuecat
//   Authorization header value: shared secret (set REVENUECAT_WEBHOOK_SECRET)
// ============================================================================

// RevenueCat event types we care about
const HANDLED_EVENTS = new Set([
  "INITIAL_PURCHASE",     // first successful purchase
  "RENEWAL",              // subscription renewed
  "PRODUCT_CHANGE",       // user upgraded/downgraded a plan
  "CANCELLATION",         // user cancelled (still active until period end)
  "UNCANCELLATION",       // user un-cancelled
  "EXPIRATION",           // subscription ended (no renewal)
  "BILLING_ISSUE",        // payment failed
  "SUBSCRIBER_ALIAS",     // user alias created (ignore but log)
  "TRANSFER",             // subscription moved between users
]);

// ============================================================================
// Map RevenueCat product IDs to your internal plan IDs
// ============================================================================
//
// The product identifiers below MUST match what you create in Google Play
// Console AND what you configure in RevenueCat.
//
// Example: if in Play Console you create a subscription with product ID
// `pro_monthly`, then RevenueCat will report `product_id: "pro_monthly"`
// in the webhook.
// ============================================================================
const PRODUCT_TO_PLAN = {
  pro_monthly: { planId: "pro", period: "monthly" },
  pro_yearly: { planId: "pro", period: "yearly" },
  business_monthly: { planId: "business", period: "monthly" },
  business_yearly: { planId: "business", period: "yearly" },
};

// ============================================================================
// Entitlement IDs — these mirror what you set up in RevenueCat
// ============================================================================
const ENTITLEMENT_TO_PLAN = {
  pro: "pro",
  business: "business",
};

/**
 * RevenueCat sends events shaped like this (simplified):
 * {
 *   "event": {
 *     "type": "INITIAL_PURCHASE",
 *     "app_user_id": "user_uuid_or_custom_id",
 *     "product_id": "pro_monthly",
 *     "entitlement_ids": ["pro"],
 *     "expiration_at_ms": 1735689600000,
 *     "purchased_at_ms": 1704067200000,
 *     "store": "PLAY_STORE",
 *     "environment": "PRODUCTION",  // or "SANDBOX"
 *     ...
 *   },
 *   "api_version": "1.0"
 * }
 */

// ============================================================================
// Main webhook handler
// ============================================================================
const handleRevenueCatWebhook = async (req, res) => {
  const client = await pool.connect();
  try {
    // ── 1. Verify auth ────────────────────────────────────────────────────
    // RevenueCat sends the secret you configured in the webhook settings
    // as the Authorization header (raw value, no Bearer prefix).
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

    const type = event.type;
    const appUserId = event.app_user_id || null;
    const productId = event.product_id || null;
    const entitlements = Array.isArray(event.entitlement_ids)
      ? event.entitlement_ids
      : [];
    const expirationMs = event.expiration_at_ms || null;
    const purchasedMs = event.purchased_at_ms || null;
    const store = event.store || null;
    const environment = event.environment || null;

    console.log(
      `[revenuecat] event=${type} user=${appUserId} product=${productId} entitlements=${entitlements.join(",")}`,
    );

    // ── 3. Ignore unhandled event types (just ack) ────────────────────────
    if (!HANDLED_EVENTS.has(type)) {
      console.log(`[revenuecat] ignoring event type: ${type}`);
      return res.json({ success: true, ignored: true });
    }

    // ── 4. We need to know which account this belongs to ──────────────────
    // The `app_user_id` is what you passed when configuring RevenueCat:
    //   Purchases.configure({ appUserID: <user_id> })
    // So it will be the user's ID from our `users` table.
    //
    // But we need to map user → account. In this app, the subscription is
    // per-account, not per-user. So we need to figure out which account.
    //
    // The `app_user_id` is the user's UUID. We find the account they own
    // (or are admin of) and update that account's subscription.
    if (!appUserId) {
      console.warn("[revenuecat] event has no app_user_id");
      return res.json({ success: true, ignored: true });
    }

    // ── 5. Find the account for this user ─────────────────────────────────
    // We use the user's last_account_id if set, else fall back to the
    // account they own. This matches how the app operates (one active
    // account at a time for subscription purposes).
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
      // Fall back to the account this user owns
      const { rows: ownedRows } = await client.query(
        `SELECT id FROM accounts
          WHERE created_by = $1 AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`,
        [appUserId],
      );
      if (ownedRows.length) {
        accountId = ownedRows[0].id;
      }
    }

    if (!accountId) {
      console.warn(`[revenuecat] no account for user: ${appUserId}`);
      return res.json({ success: true, ignored: true });
    }

    // ── 6. Determine the target plan + period ─────────────────────────────
    let targetPlanId = null;
    let targetPeriod = null;

    if (productId && PRODUCT_TO_PLAN[productId]) {
      targetPlanId = PRODUCT_TO_PLAN[productId].planId;
      targetPeriod = PRODUCT_TO_PLAN[productId].period;
    } else if (entitlements.length > 0) {
      // Fall back to entitlement mapping
      const entitlementId = entitlements[0];
      if (ENTITLEMENT_TO_PLAN[entitlementId]) {
        targetPlanId = ENTITLEMENT_TO_PLAN[entitlementId];
        targetPeriod = "monthly"; // default; product_id should normally win
      }
    }

    // ── 7. Handle each event type ─────────────────────────────────────────
    await client.query("BEGIN");

    if (type === "INITIAL_PURCHASE" || type === "RENEWAL" || type === "UNCANCELLATION" || type === "PRODUCT_CHANGE") {
      if (!targetPlanId) {
        await client.query("ROLLBACK");
        console.warn(
          `[revenuecat] could not map product "${productId}" or entitlements [${entitlements.join(",")}] to a plan`,
        );
        return res.json({ success: true, ignored: true });
      }

      const periodEnd = expirationMs
        ? new Date(expirationMs).toISOString()
        : null;
      const periodStart = purchasedMs
        ? new Date(purchasedMs).toISOString()
        : new Date().toISOString();

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
        metadata: {
          source: "revenuecat",
          event_type: type,
          product_id: productId,
        },
        visibility: "public",
      });

      console.log(
        `[revenuecat] account ${accountId} → ${targetPlanId} (${targetPeriod}), expires ${periodEnd}`,
      );
    } else if (type === "CANCELLATION") {
      // User cancelled. They keep access until current_period_end.
      // We leave plan_id active but mark cancelled_at implicitly via status.
      // Simpler: keep status active, don't downgrade. The EXPIRATION event
      // will fire when the period actually ends, at which point we downgrade.
      await client.query(
        `UPDATE account_subscriptions
            SET updated_at = NOW()
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
          event_type: "CANCELLATION",
          note: "access_kept_until_period_end",
        },
        visibility: "public",
      });

      console.log(
        `[revenuecat] account ${accountId} cancelled — will expire at period end`,
      );
    } else if (type === "EXPIRATION") {
      // Subscription period ended without renewal. Downgrade to Free.
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
      // Payment failed. Leave plan as-is; RevenueCat will retry and either
      // renew (RENEWAL) or expire (EXPIRATION) later. Just log.
      await writeAudit(client, {
        accountId,
        actorUserId: appUserId,
        actorRole: "system",
        entityType: "subscription",
        entityId: accountId,
        action: "billing_issue",
        metadata: {
          source: "revenuecat",
          event_type: "BILLING_ISSUE",
          product_id: productId,
        },
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

module.exports = {
  handleRevenueCatWebhook,
};