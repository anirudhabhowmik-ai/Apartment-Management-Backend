// src/routes/authRoutes.js
const express = require("express");

const {
  verifyWidgetToken,
  reviewerLogin,
  getMe,
  updateMe,
  requestPhoneChange,
  confirmPhoneChange,
} = require("../controllers/authController");

const authenticate = require("../middleware/authMiddleware");

const router = express.Router();

// ================================================================
// PUBLIC ROUTES (no auth required)
// ================================================================

// Normal login via MSG91 widget token
router.post("/verify-widget", verifyWidgetToken);

// Reviewer backdoor — only active when REVIEWER_PHONE and
// REVIEWER_OTP env vars are set on the server.
router.post("/reviewer-login", reviewerLogin);

// Logout — JWT is stateless, so this is a no-op acknowledgement.
// (Client is expected to delete its token.)
router.post("/logout", (req, res) => {
  res.json({ success: true, message: "Logged out." });
});

// ================================================================
// AUTHENTICATED ROUTES
// ================================================================

router.get("/me", authenticate, getMe);
router.put("/me", authenticate, updateMe);

router.post("/request-phone-change", authenticate, requestPhoneChange);
router.post("/confirm-phone-change", authenticate, confirmPhoneChange);

module.exports = router;