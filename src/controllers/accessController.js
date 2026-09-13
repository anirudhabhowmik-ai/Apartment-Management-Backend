// src/controllers/accessController.js
const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// CREATE ACCESS GRANT (Invite user to account)
// ============================================================

const createAccessGrant = async (req, res) => {
    try {
        const { accountId, userId, role } = req.body;
        const ownerId = req.user.id;

        if (!accountId || !userId || !role) {
            return res.status(400).json({
                success: false,
                message: 'Account ID, User ID, and Role are required'
            });
        }

        // Check if account exists and user is the owner
        const accountCheck = await query(
            `SELECT * FROM accounts WHERE id = $1 AND owner_id = $2`,
            [accountId, ownerId]
        );

        if (accountCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Account not found or you are not the owner'
            });
        }

        // Check if user exists
        const userCheck = await query(
            `SELECT * FROM users WHERE id = $1`,
            [userId]
        );

        if (userCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Check if grant already exists
        const existingGrant = await query(
            `SELECT * FROM access_grants WHERE account_id = $1 AND user_id = $2`,
            [accountId, userId]
        );

        if (existingGrant.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'User already has access to this account'
            });
        }

        const grantId = uuidv4();

        await query(
            `INSERT INTO access_grants (id, account_id, user_id, role, created_at) 
             VALUES ($1, $2, $3, $4, NOW())`,
            [grantId, accountId, userId, role]
        );

        const result = await query(
            `SELECT * FROM access_grants WHERE id = $1`,
            [grantId]
        );

        res.json({
            success: true,
            grant: result.rows[0]
        });

    } catch (error) {
        console.error('Create access grant error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create access grant'
        });
    }
};

// ============================================================
// GET ACCESS GRANTS BY ACCOUNT
// ============================================================

const getAccessGrants = async (req, res) => {
    try {
        const { accountId } = req.params;
        const userId = req.user.id;

        // Check if user has access to this account
        const accountCheck = await query(
            `SELECT * FROM accounts WHERE id = $1 AND owner_id = $2`,
            [accountId, userId]
        );

        if (accountCheck.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this account'
            });
        }

        const result = await query(
            `SELECT ag.*, u.full_name, u.phone, u.email 
             FROM access_grants ag
             JOIN users u ON ag.user_id = u.id
             WHERE ag.account_id = $1
             ORDER BY ag.created_at DESC`,
            [accountId]
        );

        res.json({
            success: true,
            grants: result.rows
        });

    } catch (error) {
        console.error('Get access grants error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get access grants'
        });
    }
};

// ============================================================
// GET USER'S ACCESSIBLE ACCOUNTS
// ============================================================

const getMyAccessGrants = async (req, res) => {
    try {
        const userId = req.user.id;

        const result = await query(
            `SELECT ag.*, a.name as account_name, a.type, a.photo_uri
             FROM access_grants ag
             JOIN accounts a ON ag.account_id = a.id
             WHERE ag.user_id = $1 AND ag.accepted_at IS NOT NULL
             ORDER BY ag.created_at DESC`,
            [userId]
        );

        res.json({
            success: true,
            grants: result.rows
        });

    } catch (error) {
        console.error('Get my access grants error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get access grants'
        });
    }
};

// ============================================================
// ACCEPT ACCESS GRANT
// ============================================================

const acceptAccessGrant = async (req, res) => {
    try {
        const { grantId } = req.params;
        const userId = req.user.id;

        const result = await query(
            `UPDATE access_grants 
             SET accepted_at = NOW()
             WHERE id = $1 AND user_id = $2 AND accepted_at IS NULL
             RETURNING *`,
            [grantId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Access grant not found or already accepted'
            });
        }

        res.json({
            success: true,
            grant: result.rows[0]
        });

    } catch (error) {
        console.error('Accept access grant error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to accept access grant'
        });
    }
};

// ============================================================
// REJECT ACCESS GRANT
// ============================================================

const rejectAccessGrant = async (req, res) => {
    try {
        const { grantId } = req.params;
        const userId = req.user.id;

        const result = await query(
            `DELETE FROM access_grants 
             WHERE id = $1 AND user_id = $2 AND accepted_at IS NULL
             RETURNING id`,
            [grantId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Access grant not found or already accepted'
            });
        }

        res.json({
            success: true,
            message: 'Access grant rejected'
        });

    } catch (error) {
        console.error('Reject access grant error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reject access grant'
        });
    }
};

// ============================================================
// REMOVE ACCESS GRANT
// ============================================================

const removeAccessGrant = async (req, res) => {
    try {
        const { grantId } = req.params;
        const userId = req.user.id;

        // Check if user is the owner of the account
        const grantCheck = await query(
            `SELECT ag.*, a.owner_id 
             FROM access_grants ag
             JOIN accounts a ON ag.account_id = a.id
             WHERE ag.id = $1`,
            [grantId]
        );

        if (grantCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Access grant not found'
            });
        }

        const grant = grantCheck.rows[0];

        // Only owner can remove access
        if (grant.owner_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to remove this access'
            });
        }

        await query(
            `DELETE FROM access_grants WHERE id = $1`,
            [grantId]
        );

        res.json({
            success: true,
            message: 'Access removed successfully'
        });

    } catch (error) {
        console.error('Remove access grant error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove access'
        });
    }
};

// ============================================================
// GET PENDING INVITATIONS FOR USER
// ============================================================

const getPendingInvitations = async (req, res) => {
    try {
        const userId = req.user.id;

        const result = await query(
            `SELECT ag.*, a.name as account_name, a.type, a.photo_uri,
                    u.full_name as invited_by_name
             FROM access_grants ag
             JOIN accounts a ON ag.account_id = a.id
             JOIN users u ON a.owner_id = u.id
             WHERE ag.user_id = $1 AND ag.accepted_at IS NULL
             ORDER BY ag.created_at DESC`,
            [userId]
        );

        res.json({
            success: true,
            invitations: result.rows
        });

    } catch (error) {
        console.error('Get pending invitations error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get invitations'
        });
    }
};

// ============================================================
// EXPORT ALL FUNCTIONS
// ============================================================

module.exports = {
    createAccessGrant,
    getAccessGrants,
    getMyAccessGrants,
    acceptAccessGrant,
    rejectAccessGrant,
    removeAccessGrant,
    getPendingInvitations
};