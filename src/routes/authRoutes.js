const express = require("express");

const {
  verifyWidgetToken,
} = require("../controllers/authController");

const router = express.Router();

router.post("/verify-widget", verifyWidgetToken);

module.exports = router;