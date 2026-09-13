const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// GET ALL MEMBERS FOR A GROUP
// ============================================================
const getMembers = async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user.id;

        // Verify user has access to this group
        const groupResult = await query(
            `SELECT g.*, a.owner_id, a.id as account_id 
             FROM groups g
             JOIN accounts a ON g.account_id = a.id
             LEFT JOIN access_grants ag ON a.id = ag.account_id
             WHERE g.id = $1 AND (a.owner_id = $2 OR ag.user_id = $2)`,
            [groupId, userId]
        );

        if (groupResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const result = await query(
            `SELECT * FROM members WHERE group_id = $1 ORDER BY created_at DESC`,
            [groupId]
        );

        // Parse bill_attachments if they exist
        const members = result.rows.map(member => ({
            ...member,
            bill_attachments: member.bill_attachments ? 
                (typeof member.bill_attachments === 'string' ? 
                    JSON.parse(member.bill_attachments) : 
                    member.bill_attachments) : 
                []
        }));

        res.json({ success: true, members });
    } catch (error) {
        console.error('Get members error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// GET SINGLE MEMBER BY ID
// ============================================================
const getMember = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const result = await query(
            `SELECT m.*, g.name as group_name, g.type as group_type, g.account_id 
             FROM members m
             JOIN groups g ON m.group_id = g.id
             JOIN accounts a ON g.account_id = a.id
             LEFT JOIN access_grants ag ON a.id = ag.account_id
             WHERE m.id = $1 AND (a.owner_id = $2 OR ag.user_id = $2)`,
            [id, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        // Parse bill_attachments
        const member = {
            ...result.rows[0],
            bill_attachments: result.rows[0].bill_attachments ?
                (typeof result.rows[0].bill_attachments === 'string' ?
                    JSON.parse(result.rows[0].bill_attachments) :
                    result.rows[0].bill_attachments) :
                []
        };

        res.json({ success: true, member });
    } catch (error) {
        console.error('Get member error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// CREATE MEMBER
// ============================================================
const createMember = async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user.id;
        const memberData = req.body;

        // Verify access to group
        const groupResult = await query(
            `SELECT g.*, a.owner_id, a.id as account_id 
             FROM groups g
             JOIN accounts a ON g.account_id = a.id
             LEFT JOIN access_grants ag ON a.id = ag.account_id
             WHERE g.id = $1 AND (a.owner_id = $2 OR ag.user_id = $2)`,
            [groupId, userId]
        );

        if (groupResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const id = uuidv4();
        const accountId = groupResult.rows[0].account_id;

        const {
            name, phone, role, photoUri,
            wing, flatNumber, areaSqft, parkingAvailable, maintenanceAmount,
            monthlySalary, amount, status, transactionType, reminderEnabled,
            dueDate, description, billAttachments
        } = memberData;

        // Convert billAttachments to JSON string
        const attachmentsJson = billAttachments ? JSON.stringify(billAttachments) : null;

        await query(
            `INSERT INTO members (
                id, group_id, name, phone, role, photo_uri,
                wing, flat_number, area_sqft, parking_available, maintenance_amount,
                monthly_salary, amount, status, transaction_type, reminder_enabled,
                due_date, description, bill_attachments
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
            [
                id, groupId, name, phone, role, photoUri,
                wing || null, flatNumber || null, 
                areaSqft ? parseInt(areaSqft) : null, 
                parkingAvailable || false, 
                maintenanceAmount ? parseFloat(maintenanceAmount) : null,
                monthlySalary ? parseFloat(monthlySalary) : null,
                amount ? parseFloat(amount) : null,
                status || null,
                transactionType || null,
                reminderEnabled || false,
                dueDate || null,
                description || null,
                attachmentsJson
            ]
        );

        const result = await query(`SELECT * FROM members WHERE id = $1`, [id]);

        // Add to history
        const historyId = uuidv4();
        await query(
            `INSERT INTO history (id, account_id, type, title, description, member_name, marked_by, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                historyId,
                accountId,
                'member_added',
                'Member Added',
                `${name} added as ${role || 'Member'}`,
                name,
                req.user.name || 'Admin',
                JSON.stringify({ role, groupId, type: groupResult.rows[0].type })
            ]
        );

        res.status(201).json({ success: true, member: result.rows[0] });
    } catch (error) {
        console.error('Create member error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// UPDATE MEMBER
// ============================================================
const updateMember = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const memberData = req.body;

        // Verify access
        const checkResult = await query(
            `SELECT m.*, g.account_id, g.type as group_type 
             FROM members m
             JOIN groups g ON m.group_id = g.id
             JOIN accounts a ON g.account_id = a.id
             LEFT JOIN access_grants ag ON a.id = ag.account_id
             WHERE m.id = $1 AND (a.owner_id = $2 OR ag.user_id = $2)`,
            [id, userId]
        );

        if (checkResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const oldData = checkResult.rows[0];
        const accountId = oldData.account_id;

        const {
            name, phone, role, photoUri,
            wing, flatNumber, areaSqft, parkingAvailable, maintenanceAmount,
            monthlySalary, amount, status, transactionType, reminderEnabled,
            dueDate, description, billAttachments
        } = memberData;

        // Convert billAttachments to JSON string
        const attachmentsJson = billAttachments ? JSON.stringify(billAttachments) : null;

        const result = await query(
            `UPDATE members SET
                name = COALESCE($1, name),
                phone = COALESCE($2, phone),
                role = COALESCE($3, role),
                photo_uri = COALESCE($4, photo_uri),
                wing = COALESCE($5, wing),
                flat_number = COALESCE($6, flat_number),
                area_sqft = COALESCE($7, area_sqft),
                parking_available = COALESCE($8, parking_available),
                maintenance_amount = COALESCE($9, maintenance_amount),
                monthly_salary = COALESCE($10, monthly_salary),
                amount = COALESCE($11, amount),
                status = COALESCE($12, status),
                transaction_type = COALESCE($13, transaction_type),
                reminder_enabled = COALESCE($14, reminder_enabled),
                due_date = COALESCE($15, due_date),
                description = COALESCE($16, description),
                bill_attachments = COALESCE($17, bill_attachments),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $18 RETURNING *`,
            [
                name || oldData.name, 
                phone || oldData.phone,
                role || oldData.role,
                photoUri || oldData.photo_uri,
                wing !== undefined ? wing : oldData.wing,
                flatNumber !== undefined ? flatNumber : oldData.flat_number,
                areaSqft !== undefined ? (areaSqft ? parseInt(areaSqft) : null) : oldData.area_sqft,
                parkingAvailable !== undefined ? parkingAvailable : oldData.parking_available,
                maintenanceAmount !== undefined ? (maintenanceAmount ? parseFloat(maintenanceAmount) : null) : oldData.maintenance_amount,
                monthlySalary !== undefined ? (monthlySalary ? parseFloat(monthlySalary) : null) : oldData.monthly_salary,
                amount !== undefined ? (amount ? parseFloat(amount) : null) : oldData.amount,
                status !== undefined ? status : oldData.status,
                transactionType !== undefined ? transactionType : oldData.transaction_type,
                reminderEnabled !== undefined ? reminderEnabled : oldData.reminder_enabled,
                dueDate !== undefined ? dueDate : oldData.due_date,
                description !== undefined ? description : oldData.description,
                attachmentsJson !== null ? attachmentsJson : oldData.bill_attachments,
                id
            ]
        );

        // Add to history if name or role changed
        if (oldData.name !== name && oldData.role !== role) {
            const historyId = uuidv4();
            await query(
                `INSERT INTO history (id, account_id, type, title, description, member_name, marked_by, old_value, new_value, details)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    historyId,
                    accountId,
                    'amount_changed',
                    'Member Updated',
                    `Updated ${oldData.name}`,
                    name || oldData.name,
                    req.user.name || 'Admin',
                    JSON.stringify({ name: oldData.name, role: oldData.role }),
                    JSON.stringify({ name: name || oldData.name, role: role || oldData.role }),
                    JSON.stringify({ groupId: oldData.group_id })
                ]
            );
        }

        res.json({ success: true, member: result.rows[0] });
    } catch (error) {
        console.error('Update member error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// DELETE MEMBER
// ============================================================
const deleteMember = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const checkResult = await query(
            `SELECT m.*, g.account_id FROM members m
             JOIN groups g ON m.group_id = g.id
             JOIN accounts a ON g.account_id = a.id
             LEFT JOIN access_grants ag ON a.id = ag.account_id
             WHERE m.id = $1 AND (a.owner_id = $2 OR ag.user_id = $2)`,
            [id, userId]
        );

        if (checkResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const member = checkResult.rows[0];

        await query(`DELETE FROM members WHERE id = $1`, [id]);

        // Add to history
        const historyId = uuidv4();
        await query(
            `INSERT INTO history (id, account_id, type, title, description, member_name, marked_by, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                historyId,
                member.account_id,
                'member_removed',
                'Member Removed',
                `${member.name} was removed`,
                member.name,
                req.user.name || 'Admin',
                JSON.stringify({ role: member.role })
            ]
        );

        res.json({ success: true, message: 'Member deleted successfully' });
    } catch (error) {
        console.error('Delete member error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ============================================================
// UPDATE MEMBER STATUS (for expense/income)
// ============================================================
const updateMemberStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, paidAmount } = req.body;
        const userId = req.user.id;

        const checkResult = await query(
            `SELECT m.*, g.account_id FROM members m
             JOIN groups g ON m.group_id = g.id
             JOIN accounts a ON g.account_id = a.id
             LEFT JOIN access_grants ag ON a.id = ag.account_id
             WHERE m.id = $1 AND (a.owner_id = $2 OR ag.user_id = $2)`,
            [id, userId]
        );

        if (checkResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const result = await query(
            `UPDATE members SET 
                status = COALESCE($1, status),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 RETURNING *`,
            [status, id]
        );

        // Add to history
        const historyId = uuidv4();
        await query(
            `INSERT INTO history (id, account_id, type, title, description, amount, status, member_name, marked_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                historyId,
                checkResult.rows[0].account_id,
                status === 'paid' ? 'maintenance_paid' : 'maintenance_due',
                status === 'paid' ? 'Payment Received' : 'Payment Due',
                `${checkResult.rows[0].name} marked as ${status}`,
                paidAmount || checkResult.rows[0].amount,
                status,
                checkResult.rows[0].name,
                req.user.name || 'Admin'
            ]
        );

        res.json({ success: true, member: result.rows[0] });
    } catch (error) {
        console.error('Update member status error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = {
    getMembers,
    getMember,
    createMember,
    updateMember,
    deleteMember,
    updateMemberStatus,
};