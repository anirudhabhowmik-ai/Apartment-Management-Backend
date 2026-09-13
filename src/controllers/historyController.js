const { query } = require('../config/database');

// ============================================================
// GET HISTORY FOR AN ACCOUNT
// ============================================================
const getHistory = async (req, res) => {
    try {
        const { accountId } = req.params;
        const userId = req.user.id;
        const { limit = 50, offset = 0, type } = req.query;

        // Check access
        const accountResult = await query(
            `SELECT * FROM accounts WHERE id = $1 AND (owner_id = $2)`,
            [accountId, userId]
        );

        if (accountResult.rows.length === 0) {
            const grantResult = await query(
                `SELECT * FROM access_grants WHERE account_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
                [accountId, userId]
            );
            if (grantResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
        }

        let queryText = `SELECT * FROM history WHERE account_id = $1`;
        const queryParams = [accountId];
        let paramIndex = 2;

        if (type && type !== 'all') {
            queryText += ` AND type = $${paramIndex}`;
            queryParams.push(type);
            paramIndex++;
        }

        queryText += ` ORDER BY timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(parseInt(limit), parseInt(offset));

        const result = await query(queryText, queryParams);

        // Parse details JSON
        const history = result.rows.map(item => ({
            ...item,
            details: item.details ? (typeof item.details === 'string' ? JSON.parse(item.details) : item.details) : {}
        }));

        // Get total count
        let countQuery = `SELECT COUNT(*) FROM history WHERE account_id = $1`;
        const countParams = [accountId];
        if (type && type !== 'all') {
            countQuery += ` AND type = $2`;
            countParams.push(type);
        }
        const countResult = await query(countQuery, countParams);

        res.json({
            success: true,
            history,
            total: parseInt(countResult.rows[0].count),
            limit: parseInt(limit),
            offset: parseInt(offset),
        });
    } catch (error) {
        console.error('Get history error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// GET HISTORY BY TYPE
// ============================================================
const getHistoryByType = async (req, res) => {
    try {
        const { accountId, type } = req.params;
        const userId = req.user.id;
        const { limit = 50, offset = 0 } = req.query;

        // Check access
        const accountResult = await query(
            `SELECT * FROM accounts WHERE id = $1 AND (owner_id = $2)`,
            [accountId, userId]
        );

        if (accountResult.rows.length === 0) {
            const grantResult = await query(
                `SELECT * FROM access_grants WHERE account_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
                [accountId, userId]
            );
            if (grantResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
        }

        const result = await query(
            `SELECT * FROM history 
             WHERE account_id = $1 AND type = $2
             ORDER BY timestamp DESC 
             LIMIT $3 OFFSET $4`,
            [accountId, type, parseInt(limit), parseInt(offset)]
        );

        // Parse details JSON
        const history = result.rows.map(item => ({
            ...item,
            details: item.details ? (typeof item.details === 'string' ? JSON.parse(item.details) : item.details) : {}
        }));

        const countResult = await query(
            `SELECT COUNT(*) FROM history WHERE account_id = $1 AND type = $2`,
            [accountId, type]
        );

        res.json({
            success: true,
            history,
            total: parseInt(countResult.rows[0].count),
            limit: parseInt(limit),
            offset: parseInt(offset),
        });
    } catch (error) {
        console.error('Get history by type error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// GET HISTORY SUMMARY
// ============================================================
const getHistorySummary = async (req, res) => {
    try {
        const { accountId } = req.params;
        const userId = req.user.id;

        // Check access
        const accountResult = await query(
            `SELECT * FROM accounts WHERE id = $1 AND (owner_id = $2)`,
            [accountId, userId]
        );

        if (accountResult.rows.length === 0) {
            const grantResult = await query(
                `SELECT * FROM access_grants WHERE account_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
                [accountId, userId]
            );
            if (grantResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
        }

        const result = await query(
            `SELECT 
                type,
                COUNT(*) as count,
                DATE(timestamp) as date
             FROM history 
             WHERE account_id = $1
             GROUP BY type, DATE(timestamp)
             ORDER BY date DESC`,
            [accountId]
        );

        res.json({ success: true, summary: result.rows });
    } catch (error) {
        console.error('Get history summary error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = {
    getHistory,
    getHistoryByType,
    getHistorySummary,
};