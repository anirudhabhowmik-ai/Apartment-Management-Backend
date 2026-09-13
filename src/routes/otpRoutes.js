const express = require('express');
const router = express.Router();
const otpController = require('../controllers/otpController');

// POST /api/otp/send - Send OTP
router.post('/send', otpController.sendOtp);

module.exports = router;