// src/routes/invitationRoutes.js
const express = require("express");
const {
  listMyInvitations,
  createInvitation,
  acceptInvitation,
  rejectInvitation,
  revokeInvitation,
} = require("../controllers/invitationController");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(requireAuth);

router.get("/", listMyInvitations);
router.post("/", createInvitation);          // admin check inside controller
router.post("/:id/accept", acceptInvitation);
router.post("/:id/reject", rejectInvitation);
router.delete("/:id", revokeInvitation);

module.exports = router;