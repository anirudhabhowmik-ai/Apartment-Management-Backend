// src/config/plans.js
const PLANS = {
  free: {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    yearlyPrice: 0,
    limits: { members: 10, admins: 1, staff: 1 },
    features: [
      "Up to 10 properties",
      "1 Admin",
      "1 Staff role",
      "Basic support",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPrice: 199,
    yearlyPrice: 1990,
    limits: { members: 30, admins: 2, staff: 2 },
    features: [
      "Up to 30 properties",
      "2 Admins",
      "2 Staff roles",
      "History access",
      "Priority support",
    ],
  },
  business: {
    id: "business",
    name: "Business",
    monthlyPrice: 999,
    yearlyPrice: 8990,
    limits: { members: Infinity, admins: Infinity, staff: Infinity },
    features: [
      "Unlimited properties",
      "Unlimited Admins",
      "Unlimited Staff roles",
      "Full feature access",
      "Advanced bill generation",
      "History access",
      "Advanced analytics",
      "Priority support",
    ],
  },
};

const TRIAL_DAYS = 90;
const TRIAL_PLAN_ID = "pro"; // trial grants Pro-level limits

function planPrice(planId, period) {
  const p = PLANS[planId];
  if (!p) return 0;
  return period === "yearly" ? p.yearlyPrice : p.monthlyPrice;
}
function planLimits(planId) {
  return (PLANS[planId] || PLANS.free).limits;
}
function isValidPlan(id) {
  return Object.prototype.hasOwnProperty.call(PLANS, id);
}
function isValidPeriod(p) {
  return p === "monthly" || p === "yearly";
}

module.exports = {
  PLANS, TRIAL_DAYS, TRIAL_PLAN_ID,
  planPrice, planLimits, isValidPlan, isValidPeriod,
};