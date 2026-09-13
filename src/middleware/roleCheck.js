const { query } = require('../config/database');

// ============================================================
// CHECK IF USER HAS SPECIFIC ROLE
// ============================================================
const hasRole = (allowedRoles) => {
    return async (req, res, next) => {
        try {
            const userId = req.user.id;
            const accountId = req.params.accountId || req.body.accountId || req.query.accountId;

            if (!accountId) {
                return res.status(400).json({ success: false, message: 'Account ID is required' });
            }

            // Check if user is the OWNER (has full access)
            const ownerResult = await query(
                `SELECT * FROM accounts WHERE id = $1 AND owner_id = $2`,
                [accountId, userId]
            );

            if (ownerResult.rows.length > 0) {
                req.userRole = 'owner';
                req.isOwner = true;
                return next();
            }

            // Check access grants for this account
            const grantResult = await query(
                `SELECT * FROM access_grants 
                 WHERE account_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
                [accountId, userId]
            );

            if (grantResult.rows.length === 0) {
                return res.status(403).json({ 
                    success: false, 
                    message: 'You do not have access to this property' 
                });
            }

            const userRole = grantResult.rows[0].role;

            // If allowedRoles is 'all', any role is fine
            if (allowedRoles.includes('all')) {
                req.userRole = userRole;
                req.grantId = grantResult.rows[0].id;
                return next();
            }

            // Check if user has one of the allowed roles
            if (!allowedRoles.includes(userRole)) {
                return res.status(403).json({ 
                    success: false, 
                    message: `Insufficient permissions. Required: ${allowedRoles.join(', ')}` 
                });
            }

            req.userRole = userRole;
            req.grantId = grantResult.rows[0].id;
            next();
        } catch (error) {
            console.error('Role check error:', error);
            res.status(500).json({ success: false, message: 'Server error' });
        }
    };
};

// ============================================================
// CHECK IF USER CAN VIEW (Member, Staff, Admin, Owner)
// ============================================================
const canView = hasRole(['member', 'staff', 'admin', 'owner']);

// ============================================================
// CHECK IF USER CAN MANAGE (Admin, Owner)
// ============================================================
const canManage = hasRole(['admin', 'owner']);

// ============================================================
// CHECK IF USER IS OWNER
// ============================================================
const isOwner = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const accountId = req.params.accountId || req.body.accountId;

        const result = await query(
            `SELECT * FROM accounts WHERE id = $1 AND owner_id = $2`,
            [accountId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Only the property owner can perform this action' });
        }

        req.isOwner = true;
        req.userRole = 'owner';
        next();
    } catch (error) {
        console.error('Is owner check error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// CHECK IF USER CAN VIEW FINANCE (Member, Admin, Owner)
// ============================================================
const canViewFinance = hasRole(['member', 'admin', 'owner']);

// ============================================================
// CHECK IF USER CAN VIEW ATTENDANCE (Staff, Admin, Owner)
// ============================================================
const canViewAttendance = hasRole(['staff', 'admin', 'owner']);

// ============================================================
// CHECK IF USER CAN MANAGE STAFF (Admin, Owner)
// ============================================================
const canManageStaff = hasRole(['admin', 'owner']);

// ============================================================
// CHECK GROUP ACCESS
// ============================================================
const hasGroupAccess = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const groupId = req.params.groupId || req.body.groupId;

        if (!groupId) {
            return res.status(400).json({ success: false, message: 'Group ID is required' });
        }

        const result = await query(
            `SELECT g.*, a.owner_id, ag.role 
             FROM groups g
             JOIN accounts a ON g.account_id = a.id
             LEFT JOIN access_grants ag ON a.id = ag.account_id AND ag.user_id = $2
             WHERE g.id = $1 AND (a.owner_id = $2 OR ag.user_id = $2)`,
            [groupId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Access denied to this group' });
        }

        req.group = result.rows[0];
        next();
    } catch (error) {
        console.error('Group access error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = {
    hasRole,
    canView,
    canManage,
    isOwner,
    canViewFinance,
    canViewAttendance,
    canManageStaff,
    hasGroupAccess,
};