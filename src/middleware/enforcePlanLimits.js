// src/middleware/enforcePlanLimits.js
const { pool } = require("../config/database");
const {
  getSubscriptionForAccount,
  getUsableMemberIds,
  getUsableStaffIds,
} = require("../utils/subscription");

async function attachSubscription(req, res, next) {
  try {
    const accountId = req.params.accountId;
    if (!accountId) return next();
    req.subscription = await getSubscriptionForAccount(pool, accountId);
    next();
  } catch (err) {
    console.error("attachSubscription error:", err);
    next(err);
  }
}

async function enforceMemberLimit(req, res, next) {
  try {
    const accountId = req.params.accountId;
    const sub = req.subscription || (await getSubscriptionForAccount(pool, accountId));
    if (sub.limits.members === Infinity) return next();

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM members
        WHERE account_id=$1 AND status='active'`,
      [accountId],
    );
    if (rows[0].n >= sub.limits.members) {
      const label = sub.limits.members === 1 ? "property" : "properties";
      return res.status(403).json({
        code: "plan_limit_reached",
        message: `Your ${sub.effectivePlanId} plan allows up to ${sub.limits.members} ${label}. Upgrade to add more.`,
        limit: sub.limits.members,
        current: rows[0].n,
      });
    }
    next();
  } catch (err) {
    console.error("enforceMemberLimit error:", err);
    next(err);
  }
}

async function enforceStaffLimit(req, res, next) {
  try {
    const accountId = req.params.accountId;
    const sub = req.subscription || (await getSubscriptionForAccount(pool, accountId));
    if (sub.limits.staff === Infinity) return next();

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM staff
        WHERE account_id=$1 AND status='active'`,
      [accountId],
    );
    if (rows[0].n >= sub.limits.staff) {
      const label = sub.limits.staff === 1 ? "staff role" : "staff roles";
      return res.status(403).json({
        code: "plan_limit_reached",
        message: `Your ${sub.effectivePlanId} plan allows up to ${sub.limits.staff} ${label}. Upgrade to add more.`,
        limit: sub.limits.staff,
        current: rows[0].n,
      });
    }
    next();
  } catch (err) {
    console.error("enforceStaffLimit error:", err);
    next(err);
  }
}

// Writable guard — only top-N rows (by created_at) can be edited.
async function enforceMemberWritable(req, res, next) {
  try {
    const accountId = req.params.accountId;
    const memberId = req.params.id;
    const sub = req.subscription || (await getSubscriptionForAccount(pool, accountId));
    const usable = await getUsableMemberIds(pool, accountId, sub.limits.members);
    if (usable === null) return next();
    if (!usable.includes(memberId)) {
      return res.status(403).json({
        code: "member_read_only",
        message:
          "This property is outside your plan's active limit. Upgrade to make changes.",
      });
    }
    next();
  } catch (err) {
    console.error("enforceMemberWritable error:", err);
    next(err);
  }
}

async function enforceStaffWritable(req, res, next) {
  try {
    const accountId = req.params.accountId;
    const staffId = req.params.id;
    const sub = req.subscription || (await getSubscriptionForAccount(pool, accountId));
    const usable = await getUsableStaffIds(pool, accountId, sub.limits.staff);
    if (usable === null) return next();
    if (!usable.includes(staffId)) {
      return res.status(403).json({
        code: "staff_read_only",
        message:
          "This staff role is outside your plan's active limit. Upgrade to make changes.",
      });
    }
    next();
  } catch (err) {
    console.error("enforceStaffWritable error:", err);
    next(err);
  }
}

module.exports = {
  attachSubscription,
  enforceMemberLimit,
  enforceStaffLimit,
  enforceMemberWritable,
  enforceStaffWritable,
};