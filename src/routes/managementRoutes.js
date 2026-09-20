// src/routes/managementRoutes.js
const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const c = require("../controllers/managementController");

router.use(authenticate);

// ---------------- People (owner + admins + members + staff) ----------------
router.get("/:accountId/people", c.listAccountPeople);

// ---------------- Members ----------------
router.get("/:accountId/members", c.listMembers);
router.get("/:accountId/members/:id", c.getMember);
router.post("/:accountId/members", c.createMember);
router.patch("/:accountId/members/:id", c.updateMember);
router.delete("/:accountId/members/:id", c.deleteMember);

// ---------------- Member Payments ----------------
router.put("/:accountId/members/:id/payments/:month", c.upsertMemberPayment);

// ---------------- Staff ----------------
router.get("/:accountId/staff", c.listStaff);
router.get("/:accountId/staff/:id", c.getStaff);
router.post("/:accountId/staff", c.createStaff);
router.patch("/:accountId/staff/:id", c.updateStaff);
router.delete("/:accountId/staff/:id", c.deleteStaff);

// ---------------- Staff Attendance ----------------
router.get("/:accountId/staff/:id/attendance/:month", c.getStaffAttendance);
router.put("/:accountId/staff/:id/attendance/:month", c.upsertStaffAttendance);

// ---------------- Staff Payments ----------------
router.put("/:accountId/staff/:id/payments/:month", c.upsertStaffPayment);

// ---------------- Expenses ----------------
router.get("/:accountId/expenses", c.listExpenses);
router.get("/:accountId/expenses/:id", c.getExpense);
router.post("/:accountId/expenses", c.createExpense);
router.patch("/:accountId/expenses/:id", c.updateExpense);
router.delete("/:accountId/expenses/:id", c.deleteExpense);

module.exports = router;