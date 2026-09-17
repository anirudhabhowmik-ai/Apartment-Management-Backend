// src/routes/calendarRoutes.js
const express = require("express");
const router = express.Router({ mergeParams: true });

const requireAuth = require("../middleware/authMiddleware");
const calendarController = require("../controllers/calendarController");

// All calendar routes require a valid JWT.
router.use(requireAuth);

// List & create
router.get(
  "/accounts/:accountId/calendar/events",
  calendarController.listEvents
);
router.post(
  "/accounts/:accountId/calendar/events",
  calendarController.createEvent
);

// Single event
router.get(
  "/accounts/:accountId/calendar/events/:id",
  calendarController.getEvent
);
router.patch(
  "/accounts/:accountId/calendar/events/:id",
  calendarController.updateEvent
);
router.delete(
  "/accounts/:accountId/calendar/events/:id",
  calendarController.deleteEvent
);

// Approval workflow (owner / admin only — enforced in controller)
router.post(
  "/accounts/:accountId/calendar/events/:id/approve",
  calendarController.approveEvent
);
router.post(
  "/accounts/:accountId/calendar/events/:id/reject",
  calendarController.rejectEvent
);

// RSVP (upsert)
router.post(
  "/accounts/:accountId/calendar/events/:id/respond",
  calendarController.respondToEvent
);

module.exports = router;