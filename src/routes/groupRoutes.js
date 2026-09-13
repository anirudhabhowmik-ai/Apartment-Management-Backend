const express = require('express');
const router = express.Router({ mergeParams: true });
const auth = require('../middleware/auth');
const groupController = require('../controllers/groupController');

// GET /api/accounts/:accountId/groups - Get all groups
router.get('/', auth, groupController.getGroups);

// POST /api/accounts/:accountId/groups - Create group
router.post('/', auth, groupController.createGroup);

// PUT /api/groups/:id - Update group
router.put('/:id', auth, groupController.updateGroup);

// DELETE /api/groups/:id - Delete group
router.delete('/:id', auth, groupController.deleteGroup);

module.exports = router;