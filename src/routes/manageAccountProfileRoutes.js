// src/routes/manageAccountProfileRoutes.js
const express = require("express");
const router = express.Router({ mergeParams: true });

const requireAuth = require("../middleware/authMiddleware");
const manageAccountProfileController = require("../controllers/manageAccountProfileController");

router.use(requireAuth);

// Account profile
router.get(
  "/accounts/:accountId/profile",
  manageAccountProfileController.getAccountProfile
);
router.patch(
  "/accounts/:accountId/profile",
  manageAccountProfileController.updateAccountProfile
);

// Phone change = ownership transfer (owner-only, OTP verified)
router.get(
  "/accounts/:accountId/profile/phone/change-preview",
  manageAccountProfileController.getPhoneChangePreview
);
router.post(
  "/accounts/:accountId/profile/phone/request-otp",
  manageAccountProfileController.requestPhoneChangeOtp
);
router.post(
  "/accounts/:accountId/profile/phone/verify-otp",
  manageAccountProfileController.verifyPhoneChangeOtp
);

// Admin directory (owner + admins)
router.get(
  "/accounts/:accountId/admins",
  manageAccountProfileController.listAdmins
);

module.exports = router;