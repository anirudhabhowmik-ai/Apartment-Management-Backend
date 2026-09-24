// src/routes/calendarRoutes.js
const express = require("express");
const router = express.Router({ mergeParams: true });

const requireAuth = require("../middleware/authMiddleware");
const calendarController = require("../controllers/calendarController");

router.use(requireAuth);

router.get(
  "/accounts/:accountId/calendar/events",
  calendarController.listEvents
);
router.post(
  "/accounts/:accountId/calendar/events",
  calendarController.createEvent
);

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

router.post(
  "/accounts/:accountId/calendar/events/:id/approve",
  calendarController.approveEvent
);
router.post(
  "/accounts/:accountId/calendar/events/:id/reject",
  calendarController.rejectEvent
);
router.post(
  "/accounts/:accountId/calendar/events/:id/resend",
  calendarController.resendEvent
);

router.post(
  "/accounts/:accountId/calendar/events/:id/respond",
  calendarController.respondToEvent
);

module.exports = router;