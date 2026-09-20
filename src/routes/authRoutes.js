// src/routes/authRoutes.js
const express = require("express");

const {
  verifyWidgetToken,
  getMe,
  updateMe,
  requestPhoneChange,
  confirmPhoneChange,
} = require("../controllers/authController");

const authenticate = require("../middleware/authMiddleware");

const router = express.Router();

// Public — login
router.post("/verify-widget", verifyWidgetToken);

// Authenticated — profile
router.get("/me", authenticate, getMe);
router.put("/me", authenticate, updateMe);

// Authenticated — phone change (OTP-verified)
router.post("/request-phone-change", authenticate, requestPhoneChange);
router.post("/confirm-phone-change", authenticate, confirmPhoneChange);

module.exports = router;