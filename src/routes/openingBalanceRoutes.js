// src/routes/openingBalanceRoutes.js
const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");

const {
  getOpeningBalance,
  updateOpeningBalance,
  getCarriedForward,
} = require("../controllers/openingBalanceController");

// Mounted at /api/opening-balance in app.js
router.get("/:accountId", authenticate, getOpeningBalance);
router.put("/:accountId", authenticate, updateOpeningBalance);
router.get("/:accountId/carried-forward", authenticate, getCarriedForward);

module.exports = router;