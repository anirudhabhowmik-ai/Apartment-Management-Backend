// src/routes/revenueCatWebhookRoutes.js
//
// Webhook receiver for RevenueCat.
//
// Mounted at:  POST /api/webhooks/revenuecat
//
// RevenueCat sends an Authorization header with the shared secret you set
// in the RevenueCat dashboard (Integrations → Webhooks). The controller
// compares it against REVENUECAT_WEBHOOK_SECRET from your .env.
//
// Note: RevenueCat sends JSON. We rely on express.json() middleware that's
// already applied globally in app.js, so no special body parser is needed
// here.
// ============================================================================

const express = require("express");
const router = express.Router();
const {
  handleRevenueCatWebhook,
} = require("../controllers/revenueCatWebhookController");

// RevenueCat → POST /api/webhooks/revenuecat
router.post("/revenuecat", handleRevenueCatWebhook);

module.exports = router;