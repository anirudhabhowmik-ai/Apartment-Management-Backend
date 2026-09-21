// src/routes/manageAccountProfileRoutes.js
const express = require("express");
const router = express.Router({ mergeParams: true });

const requireAuth = require("../middleware/authMiddleware");
const manageAccountProfileController = require("../controllers/manageAccountProfileController");

router.use(requireAuth);

// ===========================================================================
// Account profile
// ===========================================================================

router.get(
  "/accounts/:accountId/profile",
  manageAccountProfileController.getAccountProfile,
);

router.patch(
  "/accounts/:accountId/profile",
  manageAccountProfileController.updateAccountProfile,
);

// ===========================================================================
// Phone change flow (owner-only, OTP verified)
//
// Used by the Account Profile screen when the owner edits the phone row.
// Three calls in sequence:
//
//   1. GET  .../phone/change-preview    → which linked profiles exist
//                                         (member row? staff row?)
//   2. GET  .../phone/check-owner       → does the entered number already
//                                         belong to another user?
//                                         (drives the merge alert)
//   3. POST .../phone/request-otp       → send OTP to the new number
//   4. POST .../phone/verify-otp        → confirm; either a plain SIM
//                                         change or a user merge
// ===========================================================================

router.get(
  "/accounts/:accountId/profile/phone/change-preview",
  manageAccountProfileController.getPhoneChangePreview,
);

router.get(
  "/accounts/:accountId/profile/phone/check-owner",
  manageAccountProfileController.checkPhoneOwner,
);

router.post(
  "/accounts/:accountId/profile/phone/request-otp",
  manageAccountProfileController.requestPhoneChangeOtp,
);

router.post(
  "/accounts/:accountId/profile/phone/verify-otp",
  manageAccountProfileController.verifyPhoneChangeOtp,
);

// ===========================================================================
// Admin directory (owner + admins)
// ===========================================================================

router.get(
  "/accounts/:accountId/admins",
  manageAccountProfileController.listAdmins,
);

module.exports = router;