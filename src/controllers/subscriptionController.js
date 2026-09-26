// src/controllers/subscriptionController.js
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { pool } = require("../config/database");
const {
  PLANS, planPrice, isValidPlan, isValidPeriod,
} = require("../config/plans");
const { getSubscriptionForAccount } = require("../utils/subscription");
const { writeAudit } = require("./auditController");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;
const fail = (res, s, code, msg) => res.status(s).json({ code, message: msg });

async function getRoleForAccount(userId, accountId) {
  const { rows: o } = await pool.query(
    `SELECT 1 FROM accounts WHERE id = $1 AND created_by = $2`,
    [accountId, userId],
  );
  if (o.length) return "owner";
  const { rows } = await pool.query(
    `SELECT role FROM account_members
      WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
    [accountId, userId],
  );
  return rows.length ? rows[0].role : null;
}

// ===========================================================================
// GET /api/accounts/:accountId/subscription
// ===========================================================================
const getSubscription = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    if (!userId) return fail(res, 401, "unauthenticated", "Auth required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "no_account_access", "No access");

    // Staff cannot see subscription
    if (role === "staff_visibility") {
      return fail(res, 403, "forbidden", "Staff cannot view subscription");
    }

    const sub = await getSubscriptionForAccount(pool, accountId);

    const [{ rows: m }, { rows: s }, { rows: a }] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS n FROM members
          WHERE account_id=$1 AND status='active'`,
        [accountId],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM staff
          WHERE account_id=$1 AND status='active'`,
        [accountId],
      ),
      pool.query(
        `SELECT COUNT(DISTINCT user_id)::int AS n FROM account_members
          WHERE account_id=$1 AND role='admin' AND status='active'`,
        [accountId],
      ),
    ]);

    return res.json({
      plan_id: sub.planId,
      billing_period: sub.period,
      status: sub.status,
      is_trial: sub.isTrial,
      trial_ends_at: sub.trialEndsAt,
      effective_plan_id: sub.effectivePlanId,
      usage: {
        properties: m[0].n,
        staff_roles: s[0].n,
        admins: a[0].n,
      },
      limits: {
        properties:
          sub.limits.members === Infinity ? null : sub.limits.members,
        staff_roles:
          sub.limits.staff === Infinity ? null : sub.limits.staff,
        admins: sub.limits.admins === Infinity ? null : sub.limits.admins,
      },
      can_manage: role === "owner" || role === "admin",
      plans: Object.values(PLANS).map((p) => ({
        id: p.id,
        name: p.name,
        monthlyPrice: p.monthlyPrice,
        yearlyPrice: p.yearlyPrice,
        features: p.features,
      })),
    });
  } catch (err) {
    console.error("getSubscription error:", err);
    return fail(res, 500, "server_error", "Failed to load subscription");
  }
};

// ===========================================================================
// POST /api/accounts/:accountId/subscription
// ===========================================================================
const updateSubscription = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const {
      plan_id, billing_period,
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
    } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated", "Auth required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can manage subscriptions");
    }
    if (!isValidPlan(plan_id)) return fail(res, 400, "invalid_plan", "Invalid plan");
    if (!isValidPeriod(billing_period)) {
      return fail(res, 400, "invalid_period", "Invalid period");
    }

    // Free plan: no payment needed
    if (plan_id === "free") {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO account_subscriptions
           (account_id, plan_id, billing_period, status,
            current_period_end, updated_at)
         VALUES ($1, 'free', $2, 'cancelled', NULL, NOW())
         ON CONFLICT (account_id) DO UPDATE SET
           plan_id='free',
           billing_period=EXCLUDED.billing_period,
           status='cancelled',
           current_period_end=NULL,
           razorpay_payment_id=NULL,
           razorpay_order_id=NULL,
           updated_at=NOW()`,
        [accountId, billing_period],
      );
      await writeAudit(client, {
        accountId, actorUserId: userId, actorRole: role,
        entityType: "subscription", entityId: accountId, action: "cancelled",
        metadata: { plan_id: "free", billing_period }, visibility: "public",
      });
      await client.query("COMMIT");
      return res.json({ success: true, plan_id: "free", billing_period });
    }

    // Paid plan: verify payment signature
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return fail(res, 400, "payment_required", "Payment details required");
    }
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expected !== razorpay_signature) {
      return fail(res, 400, "invalid_signature", "Signature verification failed");
    }

    const amount = planPrice(plan_id, billing_period);
    const interval = billing_period === "yearly" ? "1 year" : "1 month";

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO account_subscriptions
         (account_id, plan_id, billing_period, status,
          current_period_start, current_period_end,
          razorpay_payment_id, razorpay_order_id, updated_at)
       VALUES ($1, $2, $3, 'active', NOW(),
               NOW() + INTERVAL '${interval}', $4, $5, NOW())
       ON CONFLICT (account_id) DO UPDATE SET
         plan_id=EXCLUDED.plan_id,
         billing_period=EXCLUDED.billing_period,
         status='active',
         current_period_start=NOW(),
         current_period_end=NOW() + INTERVAL '${interval}',
         razorpay_payment_id=EXCLUDED.razorpay_payment_id,
         razorpay_order_id=EXCLUDED.razorpay_order_id,
         updated_at=NOW()`,
      [accountId, plan_id, billing_period, razorpay_payment_id, razorpay_order_id],
    );
    await writeAudit(client, {
      accountId, actorUserId: userId, actorRole: role,
      entityType: "subscription", entityId: accountId, action: "plan_changed",
      after: { plan_id, billing_period },
      metadata: { plan_id, billing_period, amount, razorpay_payment_id },
      visibility: "public",
    });
    await client.query("COMMIT");

    const sub = await getSubscriptionForAccount(pool, accountId);
    return res.json({
      success: true,
      plan_id: sub.planId,
      billing_period: sub.period,
      status: sub.status,
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("updateSubscription error:", err);
    return fail(res, 500, "server_error", "Failed to update subscription");
  } finally {
    client.release();
  }
};

// ===========================================================================
// POST /api/payment/create-order
// ===========================================================================
const createOrder = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, plan_id, billing_period } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated", "Auth required");
    if (!accountId) return fail(res, 400, "invalid_input", "accountId required");

    const role = await getRoleForAccount(userId, accountId);
    if (role !== "owner" && role !== "admin") {
      return fail(res, 403, "forbidden", "Only owners and admins can pay");
    }
    if (!isValidPlan(plan_id) || plan_id === "free") {
      return fail(res, 400, "invalid_plan", "Invalid paid plan");
    }
    if (!isValidPeriod(billing_period)) {
      return fail(res, 400, "invalid_period", "Invalid period");
    }

    const amount = planPrice(plan_id, billing_period);
    if (amount <= 0) {
      return fail(res, 400, "invalid_amount", "Amount must be positive");
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: `acc_${accountId}_${Date.now()}`,
      notes: { accountId, plan_id, billing_period, userId },
    });

    return res.json({
      success: true,
      orderId: order.id,
      amount,
      currency: "INR",
    });
  } catch (err) {
    console.error("createOrder error:", err);
    return fail(res, 500, "server_error", "Failed to create order");
  }
};

// ===========================================================================
// POST /api/payment/verify
// ===========================================================================
const verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
    } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return fail(res, 400, "invalid_input", "Missing payment fields");
    }
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expected !== razorpay_signature) {
      return fail(res, 400, "invalid_signature", "Signature mismatch");
    }
    return res.json({
      success: true,
      message: "Payment verified",
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
    });
  } catch (err) {
    console.error("verifyPayment error:", err);
    return fail(res, 500, "server_error", "Failed to verify payment");
  }
};

module.exports = {
  getSubscription,
  updateSubscription,
  createOrder,
  verifyPayment,
};