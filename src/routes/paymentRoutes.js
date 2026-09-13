const express = require("express");

const {
  createOrder,
  verifyPayment,
} = require("../controllers/paymentController");

const router = express.Router();

/*
 * Create Razorpay order
 *
 * POST /api/payment/create-order
 */
router.post(
  "/create-order",
  createOrder,
);

/*
 * Verify Razorpay payment
 *
 * POST /api/payment/verify
 */
router.post(
  "/verify",
  verifyPayment,
);

module.exports = router;