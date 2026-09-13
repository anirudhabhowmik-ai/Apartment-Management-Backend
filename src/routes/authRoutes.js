// src/routes/authRoutes.js
const express = require("express");
const {
  sendOtp,
  verifyOTP,
  getCurrentUser,
  updateUser,
  logout,
} = require("../controllers/authController");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOTP);
router.get("/me", requireAuth, getCurrentUser);
router.patch("/me", requireAuth, updateUser);
router.post("/logout", requireAuth, logout);

module.exports = router;