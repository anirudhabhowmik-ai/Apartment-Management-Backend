const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// GET ALL ACCESS GRANTS FOR AN ACCOUNT
// ============================================================
const getAccessGrants = async (req, res) => {
    try {
        const { accountId } = req.params;
        const userId = req.user.id;

        // Check if user has access to this account
        const accountResult = await query(
            `SELECT * FROM accounts WHERE id = $1 AND (owner_id = $2)`,
            [accountId, userId]
        );

        if (accountResult.rows.length === 0) {
            // Check if user has access grant
            const grantResult = await query(
                `SELECT * FROM access_grants WHERE account_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
                [accountId, userId]
            );
            if (grantResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
        }

        const result = await query(
            `SELECT ag.*, u.name, u.phone, u.email 
             FROM access_grants ag
             JOIN users u ON ag.user_id = u.id
             WHERE ag.account_id = $1
             ORDER BY ag.created_at DESC`,
            [accountId]
        );

        res.json({ success: true, grants: result.rows });
    } catch (error) {
        console.error('Get access grants error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// CREATE ACCESS GRANT
// ============================================================
const createAccessGrant = async (req, res) => {
    try {
        const { accountId } = req.params;
        const { phone, role } = req.body;
        const userId = req.user.id;

        // Check if user owns the account
        const accountResult = await query(
            `SELECT * FROM accounts WHERE id = $1 AND owner_id = $2`,
            [accountId, userId]
        );

        if (accountResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You do not own this account' });
        }

        // Find user by phone
        const userResult = await query(`SELECT * FROM users WHERE phone = $1`, [phone]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found. Please ask them to sign up first.' });
        }

        const targetUserId = userResult.rows[0].id;

        // Check if grant already exists
        const existingGrant = await query(
            `SELECT * FROM access_grants WHERE account_id = $1 AND user_id = $2`,
            [accountId, targetUserId]
        );

        if (existingGrant.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'User already has access or pending invitation' });
        }

        const id = uuidv4();
        await query(
            `INSERT INTO access_grants (id, account_id, user_id, role) VALUES ($1, $2, $3, $4)`,
            [id, accountId, targetUserId, role]
        );

        const result = await query(
            `SELECT ag.*, u.name, u.phone FROM access_grants ag
             JOIN users u ON ag.user_id = u.id
             WHERE ag.id = $1`,
            [id]
        );

        // Add to history
        const historyId = uuidv4();
        await query(
            `INSERT INTO history (id, account_id, type, title, description, marked_by, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                historyId,
                accountId,
                'member_added',
                'Access Invitation Sent',
                `Invited ${userResult.rows[0].name || phone} as ${role}`,
                req.user.name || 'Admin',
                JSON.stringify({ role, userId: targetUserId, phone })
            ]
        );

        res.status(201).json({ success: true, grant: result.rows[0] });
    } catch (error) {
        console.error('Create access grant error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// UPDATE ACCESS GRANT (Accept/Reject/Change Role)
// ============================================================
const updateAccessGrant = async (req, res) => {
    try {
        const { id } = req.params;
        const { role, acceptedAt } = req.body;
        const userId = req.user.id;

        // Check if user owns the account OR is the target user
        const grantResult = await query(
            `SELECT ag.*, a.owner_id FROM access_grants ag
             JOIN accounts a ON ag.account_id = a.id
             WHERE ag.id = $1`,
            [id]
        );

        if (grantResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Grant not found' });
        }

        const grant = grantResult.rows[0];

        // Allow owner OR the target user to update (for accepting)
        if (grant.owner_id !== userId && grant.user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not have permission' });
        }

        // If target user is accepting, set accepted_at
        if (grant.user_id === userId && acceptedAt) {
            const result = await query(
                `UPDATE access_grants SET accepted_at = $1, updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $2 RETURNING *`,
                [acceptedAt, id]
            );
            
            // Add to history
            const historyId = uuidv4();
            await query(
                `INSERT INTO history (id, account_id, type, title, description, marked_by, details)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    historyId,
                    grant.account_id,
                    'role_changed',
                    'Access Accepted',
                    `${grant.name || 'User'} accepted access invitation`,
                    req.user.name || 'User',
                    JSON.stringify({ role: grant.role })
                ]
            );
            
            return res.json({ success: true, grant: result.rows[0] });
        }

        // Owner updating role
        if (grant.owner_id === userId) {
            const result = await query(
                `UPDATE access_grants SET role = COALESCE($1, role), updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $2 RETURNING *`,
                [role, id]
            );
            
            // Add to history
            const historyId = uuidv4();
            await query(
                `INSERT INTO history (id, account_id, type, title, description, marked_by, details)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    historyId,
                    grant.account_id,
                    'role_changed',
                    'Role Changed',
                    `Updated ${grant.name || 'user'}'s role to ${role}`,
                    req.user.name || 'Admin',
                    JSON.stringify({ role })
                ]
            );
            
            return res.json({ success: true, grant: result.rows[0] });
        }

        res.status(403).json({ success: false, message: 'You do not have permission' });
    } catch (error) {
        console.error('Update access grant error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// DELETE ACCESS GRANT
// ============================================================
const deleteAccessGrant = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const grantResult = await query(
            `SELECT ag.*, a.owner_id FROM access_grants ag
             JOIN accounts a ON ag.account_id = a.id
             WHERE ag.id = $1`,
            [id]
        );

        if (grantResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Grant not found' });
        }

        const grant = grantResult.rows[0];

        if (grant.owner_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this account' });
        }

        await query(`DELETE FROM access_grants WHERE id = $1`, [id]);

        // Add to history
        const historyId = uuidv4();
        await query(
            `INSERT INTO history (id, account_id, type, title, description, marked_by, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                historyId,
                grant.account_id,
                'member_removed',
                'Access Revoked',
                `Revoked access for ${grant.name || 'user'}`,
                req.user.name || 'Admin',
                JSON.stringify({ role: grant.role })
            ]
        );

        res.json({ success: true, message: 'Access grant deleted successfully' });
    } catch (error) {
        console.error('Delete access grant error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = {
    getAccessGrants,
    createAccessGrant,
    updateAccessGrant,
    deleteAccessGrant,
};