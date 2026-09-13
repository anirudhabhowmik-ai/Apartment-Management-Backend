// src/routes/accessRoutes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const accessController = require('../controllers/accessController');

// All routes require authentication
router.use(auth);

// Get pending invitations for current user
router.get('/invitations', accessController.getPendingInvitations);

// Get user's accessible accounts
router.get('/my', accessController.getMyAccessGrants);

// Get access grants for a specific account
router.get('/account/:accountId', accessController.getAccessGrants);

// Create access grant (invite user)
router.post('/', accessController.createAccessGrant);

// Accept/Reject access grant
router.put('/:grantId/accept', accessController.acceptAccessGrant);
router.delete('/:grantId/reject', accessController.rejectAccessGrant);

// Remove access grant
router.delete('/:grantId', accessController.removeAccessGrant);

module.exports = router;