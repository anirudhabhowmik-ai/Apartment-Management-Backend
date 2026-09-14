const pool = require("../config/database");

const createAccount = async (req, res) => {
    const client = await pool.connect();

    try {
        const { name, photoUrl, type } = req.body;

        if (!name || !type) {
            return res.status(400).json({
                success: false,
                message: "Account name and type are required",
            });
        }

        if (!["apartment", "home"].includes(type)) {
            return res.status(400).json({
                success: false,
                message: "Invalid account type",
            });
        }

        const userId = req.user.userId;

        await client.query("BEGIN");

        // Create account
        const accountResult = await client.query(
            `
            INSERT INTO accounts (
                name,
                photo_url,
                type,
                created_by
            )
            VALUES ($1, $2, $3, $4)
            RETURNING id, name, photo_url, type, created_by, created_at
            `,
            [name, photoUrl || null, type, userId]
        );

        const account = accountResult.rows[0];

        // Make creator the account owner
        await client.query(
            `
            INSERT INTO account_members (
                account_id,
                user_id,
                role,
                status
            )
            VALUES ($1, $2, 'owner', 'active')
            `,
            [account.id, userId]
        );

        await client.query("COMMIT");

        return res.status(201).json({
            success: true,
            message: "Account created successfully",
            account,
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error("Create account error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to create account",
        });

    } finally {
        client.release();
    }
};

module.exports = {
    createAccount,
};