const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// GET ALL GROUPS FOR AN ACCOUNT
// ============================================================
const getGroups = async (req, res) => {
    try {
        const { accountId } = req.params;
        const userId = req.user.id;

        // Check access
        const accessResult = await query(
            `SELECT a.* FROM accounts a
             LEFT JOIN access_grants ag ON a.id = ag.account_id
             WHERE a.id = $1 AND (a.owner_id = $2 OR ag.user_id = $2)`,
            [accountId, userId]
        );

        if (accessResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const result = await query(
            `SELECT g.*, 
                    (SELECT COUNT(*) FROM members WHERE group_id = g.id) as member_count
             FROM groups g
             WHERE g.account_id = $1
             ORDER BY g.created_at DESC`,
            [accountId]
        );

        res.json({ success: true, groups: result.rows });
    } catch (error) {
        console.error('Get groups error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// CREATE GROUP
// ============================================================
const createGroup = async (req, res) => {
    try {
        const { accountId } = req.params;
        const { name, type } = req.body;
        const userId = req.user.id;

        // Check if user owns the account
        const accountResult = await query(
            `SELECT * FROM accounts WHERE id = $1 AND owner_id = $2`,
            [accountId, userId]
        );

        if (accountResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You do not own this account' });
        }

        const id = uuidv4();
        await query(
            `INSERT INTO groups (id, account_id, name, type) VALUES ($1, $2, $3, $4)`,
            [id, accountId, name, type]
        );

        const result = await query(`SELECT * FROM groups WHERE id = $1`, [id]);

        // Add to history
        const historyId = uuidv4();
        await query(
            `INSERT INTO history (id, account_id, type, title, description, marked_by, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                historyId,
                accountId,
                'member_added',
                'Group Created',
                `Created ${type} group: ${name}`,
                req.user.name || 'Admin',
                JSON.stringify({ type })
            ]
        );

        res.status(201).json({ success: true, group: result.rows[0] });
    } catch (error) {
        console.error('Create group error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// UPDATE GROUP
// ============================================================
const updateGroup = async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        const userId = req.user.id;

        const result = await query(
            `UPDATE groups SET 
                name = COALESCE($1, name),
                updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2 AND account_id IN (SELECT id FROM accounts WHERE owner_id = $3)
             RETURNING *`,
            [name, id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You do not own this group' });
        }

        res.json({ success: true, group: result.rows[0] });
    } catch (error) {
        console.error('Update group error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// DELETE GROUP
// ============================================================
const deleteGroup = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        // Get group info for history
        const groupResult = await query(
            `SELECT * FROM groups WHERE id = $1 AND account_id IN (SELECT id FROM accounts WHERE owner_id = $2)`,
            [id, userId]
        );

        if (groupResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You do not own this group' });
        }

        const group = groupResult.rows[0];

        await query(`DELETE FROM groups WHERE id = $1`, [id]);

        // Add to history
        const historyId = uuidv4();
        await query(
            `INSERT INTO history (id, account_id, type, title, description, marked_by, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                historyId,
                group.account_id,
                'member_removed',
                'Group Deleted',
                `Deleted ${group.type} group: ${group.name}`,
                req.user.name || 'Admin',
                JSON.stringify({ type: group.type })
            ]
        );

        res.json({ success: true, message: 'Group deleted successfully' });
    } catch (error) {
        console.error('Delete group error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = {
    getGroups,
    createGroup,
    updateGroup,
    deleteGroup,
};