const express = require('express');
const router = express.Router({ mergeParams: true });
const auth = require('../middleware/auth');
const memberController = require('../controllers/memberController');

// GET /api/groups/:groupId/members - Get all members
router.get('/', auth, memberController.getMembers);

// GET /api/members/:id - Get single member
router.get('/:id', auth, memberController.getMember);

// POST /api/groups/:groupId/members - Create member
router.post('/', auth, memberController.createMember);

// PUT /api/members/:id - Update member
router.put('/:id', auth, memberController.updateMember);

// DELETE /api/members/:id - Delete member
router.delete('/:id', auth, memberController.deleteMember);

// PATCH /api/members/:id/status - Update member status
router.patch('/:id/status', auth, memberController.updateMemberStatus);

module.exports = router;