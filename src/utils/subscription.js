// src/utils/subscription.js
const { TRIAL_PLAN_ID, planLimits } = require("../config/plans");

function resolveSubscription(row) {
  const now = Date.now();

  if (!row) {
    return {
      planId: "free", period: "monthly", status: "trialing",
      isTrial: true, trialEndsAt: null,
      effectivePlanId: TRIAL_PLAN_ID, limits: planLimits(TRIAL_PLAN_ID),
    };
  }

  const trialEnds = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
  const trialActive = trialEnds > now;

  // Trialing with no paid plan → Pro limits
  if (trialActive && (row.plan_id === "free" || row.status === "trialing")) {
    return {
      planId: row.plan_id, period: row.billing_period, status: "trialing",
      isTrial: true, trialEndsAt: row.trial_ends_at,
      effectivePlanId: TRIAL_PLAN_ID, limits: planLimits(TRIAL_PLAN_ID),
    };
  }

  // Trial ended, still free → expired, Free limits
  if (!trialActive && row.plan_id === "free") {
    return {
      planId: "free", period: row.billing_period, status: "expired",
      isTrial: false, trialEndsAt: row.trial_ends_at,
      effectivePlanId: "free", limits: planLimits("free"),
    };
  }

  // Paid plan
  return {
    planId: row.plan_id, period: row.billing_period,
    status: row.status === "cancelled" ? "cancelled" : "active",
    isTrial: false, trialEndsAt: row.trial_ends_at,
    effectivePlanId: row.plan_id, limits: planLimits(row.plan_id),
  };
}

async function getSubscriptionForAccount(client, accountId) {
  const { rows } = await client.query(
    `SELECT * FROM account_subscriptions WHERE account_id = $1`,
    [accountId],
  );
  if (rows.length) return resolveSubscription(rows[0]);

  const { rows: created } = await client.query(
    `INSERT INTO account_subscriptions (account_id)
     VALUES ($1)
     ON CONFLICT (account_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [accountId],
  );
  return resolveSubscription(created[0]);
}

// Top-N usable members by created_at ASC (each row = one property/flat).
// Returns null when limit is Infinity (no restriction).
async function getUsableMemberIds(client, accountId, limit) {
  if (limit === Infinity) return null;
  const { rows } = await client.query(
    `SELECT id FROM members
      WHERE account_id = $1 AND status = 'active'
      ORDER BY created_at ASC, id ASC
      LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((r) => r.id);
}

async function getUsableStaffIds(client, accountId, limit) {
  if (limit === Infinity) return null;
  const { rows } = await client.query(
    `SELECT id FROM staff
      WHERE account_id = $1 AND status = 'active'
      ORDER BY created_at ASC, id ASC
      LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((r) => r.id);
}

module.exports = {
  resolveSubscription,
  getSubscriptionForAccount,
  getUsableMemberIds,
  getUsableStaffIds,
};