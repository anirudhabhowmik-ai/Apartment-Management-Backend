// src/routes/auditRoutes.js
const express = require("express");
const router = express.Router();

const {
  getAccountHistory,
  getMyHistory,
  logSensitiveView,
} = require("../controllers/auditController");

const authenticate = require("../middleware/authMiddleware");

router.get("/accounts/:accountId/history", authenticate, getAccountHistory);
router.get("/accounts/:accountId/history/me", authenticate, getMyHistory);
router.post(
  "/accounts/:accountId/history/sensitive-view",
  authenticate,
  logSensitiveView,
);

module.exports = router;