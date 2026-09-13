const express = require("express");

const {
  registerToken,
} = require("../controllers/notificationController");

// Adjust this path to match your actual auth middleware
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/**
 * POST /api/notifications/register-token
 *
 * Saves the device's Expo push token for the authenticated user.
 */
router.post("/register-token", authMiddleware, registerToken);

module.exports = router;