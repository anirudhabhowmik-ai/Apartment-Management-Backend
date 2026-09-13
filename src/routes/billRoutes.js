const express = require('express');
const router = express.Router({ mergeParams: true });
const auth = require('../middleware/auth');
const billController = require('../controllers/billController');

// GET /api/accounts/:accountId/bills - Get all bills
router.get('/', auth, billController.getBills);

// GET /api/bills/:id - Get single bill
router.get('/:id', auth, billController.getBill);

// POST /api/accounts/:accountId/bills - Create bill
router.post('/', auth, billController.createBill);

// PUT /api/bills/:id - Update bill
router.put('/:id', auth, billController.updateBill);

// DELETE /api/bills/:id - Delete bill
router.delete('/:id', auth, billController.deleteBill);

module.exports = router;