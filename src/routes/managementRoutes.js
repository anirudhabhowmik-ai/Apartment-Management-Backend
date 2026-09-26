// src/routes/managementRoutes.js
const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const c = require("../controllers/managementController");
const {
  attachSubscription,
  enforceMemberLimit,
  enforceStaffLimit,
  enforceMemberWritable,
  enforceStaffWritable,
} = require("../middleware/enforcePlanLimits");

router.use(authenticate);

// Cache the resolved subscription on req for all account-scoped routes below.
// This is a single DB read per request, reused by all enforce* middlewares.
router.use("/:accountId", attachSubscription);

// ---------------- People (owner + admins + members + staff) ----------------
router.get("/:accountId/people", c.listAccountPeople);

// ---------------- Members ----------------
router.get("/:accountId/members", c.listMembers);
router.get("/:accountId/members/:id", c.getMember);
router.post("/:accountId/members", enforceMemberLimit, c.createMember);
router.patch("/:accountId/members/:id", enforceMemberWritable, c.updateMember);
router.delete("/:accountId/members/:id", enforceMemberWritable, c.deleteMember);

// ---------------- Member Payments ----------------
router.put(
  "/:accountId/members/:id/payments/:month",
  enforceMemberWritable,
  c.upsertMemberPayment,
);

// ---------------- Staff ----------------
router.get("/:accountId/staff", c.listStaff);
router.get("/:accountId/staff/:id", c.getStaff);
router.post("/:accountId/staff", enforceStaffLimit, c.createStaff);
router.patch("/:accountId/staff/:id", enforceStaffWritable, c.updateStaff);
router.delete("/:accountId/staff/:id", enforceStaffWritable, c.deleteStaff);

// ---------------- Staff Attendance ----------------
// Attendance is a sub-resource of staff; guard it the same as staff writes
router.get("/:accountId/staff/:id/attendance/:month", c.getStaffAttendance);
router.put(
  "/:accountId/staff/:id/attendance/:month",
  enforceStaffWritable,
  c.upsertStaffAttendance,
);

// ---------------- Staff Payments ----------------
router.put(
  "/:accountId/staff/:id/payments/:month",
  enforceStaffWritable,
  c.upsertStaffPayment,
);

// ---------------- Expenses ----------------
// Expenses are NOT part of the plan limits — no middleware needed
router.get("/:accountId/expenses", c.listExpenses);
router.get("/:accountId/expenses/:id", c.getExpense);
router.post("/:accountId/expenses", c.createExpense);
router.patch("/:accountId/expenses/:id", c.updateExpense);
router.delete("/:accountId/expenses/:id", c.deleteExpense);

module.exports = router;