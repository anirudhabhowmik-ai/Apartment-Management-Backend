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
router.use("/:accountId", attachSubscription);

// ---------------- People ----------------
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
router.get("/:accountId/expenses", c.listExpenses);
router.get("/:accountId/expenses/:id", c.getExpense);
router.post("/:accountId/expenses", c.createExpense);
router.patch("/:accountId/expenses/:id", c.updateExpense);
router.delete("/:accountId/expenses/:id", c.deleteExpense);

// ---------------- Vehicles ----------------
// IMPORTANT: /vehicles/lookup must be declared before any /vehicles/:id.
router.get("/:accountId/vehicles/lookup", c.lookupVehicle);
router.get("/:accountId/vehicles/check-conflict", c.checkVehicleConflict);
router.post("/:accountId/vehicles", c.registerVehicle);

// ---------------- Gate Entries ----------------
router.post("/:accountId/gate-entries", c.createGateEntry);
router.get("/:accountId/gate-entries", c.listGateEntries);

// Guard edit / allow / reject (invited entries) or full edit (manual entries)
router.patch("/:accountId/gate-entries/:id", c.updateGateEntry);

// Approval flow (resident side)
router.get("/:accountId/gate-entries/:id/status", c.getGateEntryStatus);
router.post("/:accountId/gate-entries/:id/approve", c.approveGateEntry);
router.post("/:accountId/gate-entries/:id/reject", c.rejectGateEntry);
router.post("/:accountId/gate-entries/:id/override", c.overrideGateEntry);

// ---------------- Gate Flats (searchable dropdown source) ----------------
router.get("/:accountId/gate-flats", c.listGateFlats);

// ---------------- Gate Passes (search by resident + history + action) ----
// IMPORTANT: /search and /action must come BEFORE /:kind/:id/history so the
// literal segments aren't accidentally matched as `kind` params.
router.get("/:accountId/gate-passes/search", c.searchGatePasses);
router.post("/:accountId/gate-passes/action", c.logPassAction);
router.get("/:accountId/gate-passes/:kind/:id/history", c.getPassHistory);

// ---------------- Gate Authorizations ----------------
// IMPORTANT: /match must come BEFORE /:id.
router.post("/:accountId/gate-authorizations/match", c.matchAuthorization);
router.post("/:accountId/gate-authorizations", c.createAuthorization);
router.get("/:accountId/gate-authorizations", c.listAuthorizations);
router.patch(
  "/:accountId/gate-authorizations/:id",
  c.updateAuthorization,
);
router.delete(
  "/:accountId/gate-authorizations/:id",
  c.deleteAuthorization,
);

// ---------------- Gate Invites ----------------
// IMPORTANT: /by-code/:code must come BEFORE /:id.
router.post("/:accountId/gate-invites", c.createInvite);
router.get("/:accountId/gate-invites", c.listInvites);
router.get("/:accountId/gate-invites/by-code/:code", c.lookupInviteByCode);
router.patch(
  "/:accountId/gate-invites/:id",
  c.updateInvite,
);
router.get("/:accountId/gate-invites/:id", c.getInvite);
router.delete("/:accountId/gate-invites/:id", c.deleteInvite);

module.exports = router;