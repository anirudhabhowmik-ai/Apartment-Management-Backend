// src/routes/subscriptionRoutes.js
const express = require("express");
const router = express.Router();
const sub = require("../controllers/subscriptionController");
const auth = require("../middleware/authMiddleware"); // your existing auth

// ── Subscription ──────────────────────────────────────────────────────────
router.get("/accounts/:accountId/subscription", auth, sub.getSubscription);
router.post("/accounts/:accountId/subscription", auth, sub.updateSubscription);

// ── Payment ───────────────────────────────────────────────────────────────
router.post("/payment/create-order", auth, sub.createOrder);
router.post("/payment/verify", auth, sub.verifyPayment);

module.exports = router;