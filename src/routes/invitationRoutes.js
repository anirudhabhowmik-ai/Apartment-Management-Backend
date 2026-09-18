// src/routes/invitationRoutes.js
const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/authMiddleware");
const invitationController = require("../controllers/invitationController");

router.use(requireAuth);

// ── Account-scoped (owner/admin unless noted) ────────────────
router.get(
  "/accounts/:accountId/invitations/preflight",
  invitationController.preflight
);
router.post(
  "/accounts/:accountId/invitations",
  invitationController.createInvitation
);
router.get(
  "/accounts/:accountId/invitations",
  invitationController.listInvitations
);
router.delete(
  "/accounts/:accountId/invitations/:id",
  invitationController.deleteInvitation
);
router.post(
  "/accounts/:accountId/invitations/:id/dismiss",
  invitationController.dismissInvitation
);

// Owner-only inside the controller
router.delete(
  "/accounts/:accountId/access/:userId",
  invitationController.revokeAccess
);
router.get(
  "/accounts/:accountId/invitations/:invitationId/admin-linked",
  invitationController.getAdminLinkedProfiles
);

// ── Recipient-scoped (any logged-in user) ────────────────────
router.get("/me/invitations", invitationController.listMyInvitations);
router.post("/invitations/:id/accept", invitationController.acceptInvitation);
router.post("/invitations/:id/reject", invitationController.rejectInvitation);

module.exports = router;