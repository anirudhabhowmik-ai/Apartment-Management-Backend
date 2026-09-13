const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// GET ALL BILLS FOR AN ACCOUNT
// ============================================================
const getBills = async (req, res) => {
    try {
        const { accountId } = req.params;
        const userId = req.user.id;
        const { groupId, memberId, status, startDate, endDate } = req.query;

        // Check access
        const accessResult = await query(
            `SELECT * FROM accounts WHERE id = $1 AND (owner_id = $2)`,
            [accountId, userId]
        );

        if (accessResult.rows.length === 0) {
            const grantResult = await query(
                `SELECT * FROM access_grants WHERE account_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
                [accountId, userId]
            );
            if (grantResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
        }

        let queryText = `
            SELECT b.*, 
                   g.name as group_name, 
                   m.name as member_name,
                   m.role as member_role
            FROM bills b
            LEFT JOIN groups g ON b.group_id = g.id
            LEFT JOIN members m ON b.member_id = m.id
            WHERE b.account_id = $1
        `;
        const queryParams = [accountId];
        let paramIndex = 2;

        if (groupId) {
            queryText += ` AND b.group_id = $${paramIndex}`;
            queryParams.push(groupId);
            paramIndex++;
        }

        if (memberId) {
            queryText += ` AND b.member_id = $${paramIndex}`;
            queryParams.push(memberId);
            paramIndex++;
        }

        if (status) {
            queryText += ` AND b.status = $${paramIndex}`;
            queryParams.push(status);
            paramIndex++;
        }

        if (startDate) {
            queryText += ` AND b.created_at >= $${paramIndex}`;
            queryParams.push(startDate);
            paramIndex++;
        }

        if (endDate) {
            queryText += ` AND b.created_at <= $${paramIndex}`;
            queryParams.push(endDate);
            paramIndex++;
        }

        queryText += ` ORDER BY b.created_at DESC`;

        const result = await query(queryText, queryParams);

        res.json({ success: true, bills: result.rows });
    } catch (error) {
        console.error('Get bills error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// GET SINGLE BILL
// ============================================================
const getBill = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const result = await query(
            `SELECT b.*, g.name as group_name, m.name as member_name 
             FROM bills b
             LEFT JOIN groups g ON b.group_id = g.id
             LEFT JOIN members m ON b.member_id = m.id
             WHERE b.id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Bill not found' });
        }

        const bill = result.rows[0];

        // Check access
        const accessResult = await query(
            `SELECT * FROM accounts WHERE id = $1 AND (owner_id = $2)`,
            [bill.account_id, userId]
        );

        if (accessResult.rows.length === 0) {
            const grantResult = await query(
                `SELECT * FROM access_grants WHERE account_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
                [bill.account_id, userId]
            );
            if (grantResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
        }

        res.json({ success: true, bill });
    } catch (error) {
        console.error('Get bill error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// CREATE BILL
// ============================================================
const createBill = async (req, res) => {
    try {
        const { accountId } = req.params;
        const { 
            groupId, memberId, templateId, billType, 
            amount, dueDate, signatureUrl, description,
            items 
        } = req.body;
        const userId = req.user.id;

        // Check access
        const accessResult = await query(
            `SELECT * FROM accounts WHERE id = $1 AND (owner_id = $2)`,
            [accountId, userId]
        );

        if (accessResult.rows.length === 0) {
            const grantResult = await query(
                `SELECT * FROM access_grants WHERE account_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
                [accountId, userId]
            );
            if (grantResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
        }

        const id = uuidv4();
        await query(
            `INSERT INTO bills (
                id, account_id, group_id, member_id, template_id, 
                bill_type, amount, due_date, signature_url, 
                description, items, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                id, accountId, groupId, memberId, templateId,
                billType, amount, dueDate, signatureUrl,
                description || null,
                items ? JSON.stringify(items) : null,
                'pending'
            ]
        );

        const result = await query(`SELECT * FROM bills WHERE id = $1`, [id]);

        // Add to history
        const historyId = uuidv4();
        const memberName = await query(`SELECT name FROM members WHERE id = $1`, [memberId]);
        await query(
            `INSERT INTO history (id, account_id, type, title, description, amount, marked_by, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                historyId,
                accountId,
                'bill_generated',
                'Bill Generated',
                `Bill generated for ${memberName.rows[0]?.name || 'member'}`,
                amount,
                req.user.name || 'Admin',
                JSON.stringify({ billType, templateId, dueDate })
            ]
        );

        res.status(201).json({ success: true, bill: result.rows[0] });
    } catch (error) {
        console.error('Create bill error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// UPDATE BILL
// ============================================================
const updateBill = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, paidAmount, signatureUrl } = req.body;
        const userId = req.user.id;

        const result = await query(
            `UPDATE bills SET 
                status = COALESCE($1, status),
                paid_amount = COALESCE($2, paid_amount),
                signature_url = COALESCE($3, signature_url),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $4 AND account_id IN (SELECT id FROM accounts WHERE owner_id = $5)
             RETURNING *`,
            [status, paidAmount, signatureUrl, id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You do not own this bill' });
        }

        const bill = result.rows[0];

        // Add to history
        const historyId = uuidv4();
        await query(
            `INSERT INTO history (id, account_id, type, title, description, amount, status, marked_by, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                historyId,
                bill.account_id,
                status === 'paid' ? 'maintenance_paid' : 'amount_changed',
                status === 'paid' ? 'Bill Paid' : 'Bill Updated',
                `Bill ${status === 'paid' ? 'paid' : 'updated'}`,
                bill.amount,
                status,
                req.user.name || 'Admin',
                JSON.stringify({ billId: id, status })
            ]
        );

        res.json({ success: true, bill: result.rows[0] });
    } catch (error) {
        console.error('Update bill error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// DELETE BILL
// ============================================================
const deleteBill = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const result = await query(
            `DELETE FROM bills WHERE id = $1 AND account_id IN (SELECT id FROM accounts WHERE owner_id = $2) RETURNING id`,
            [id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You do not own this bill' });
        }

        res.json({ success: true, message: 'Bill deleted successfully' });
    } catch (error) {
        console.error('Delete bill error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = {
    getBills,
    getBill,
    createBill,
    updateBill,
    deleteBill,
};