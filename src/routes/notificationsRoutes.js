// src/routes/notificationsRoutes.js
const express = require("express");
const auth = require("../middleware/authMiddleware");
const {
  listNotifications,
  markRead,
  markAllRead,
  dismiss,
} = require("../controllers/notificationController");

const router = express.Router();

// All notification routes require authentication.
router.use(auth);

// GET /notifications
//   ?accountId=<uuid>   optional — filter to a single account
//   ?before=<iso>       optional — cursor for pagination
//   ?limit=<n>          optional — default 30, max 100
//   ?unreadOnly=true    optional — only unread
router.get("/", listNotifications);

// POST /notifications/read-all
//   ?accountId=<uuid>   optional — only mark this account's notifications read
router.post("/read-all", markAllRead);

// POST /notifications/:id/read
router.post("/:id/read", markRead);

// DELETE /notifications/:id  (soft-dismiss)
router.delete("/:id", dismiss);

module.exports = router;