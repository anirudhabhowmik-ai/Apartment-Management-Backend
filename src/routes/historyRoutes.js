const express = require('express');
const router = express.Router({ mergeParams: true });
const auth = require('../middleware/auth');
const historyController = require('../controllers/historyController');

// GET /api/accounts/:accountId/history - Get all history
router.get('/', auth, historyController.getHistory);

// GET /api/accounts/:accountId/history/summary - Get history summary
router.get('/summary', auth, historyController.getHistorySummary);

// GET /api/accounts/:accountId/history/type/:type - Get history by type
router.get('/type/:type', auth, historyController.getHistoryByType);

module.exports = router;