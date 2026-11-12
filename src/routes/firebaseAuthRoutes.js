// routes/firebaseAuthRoutes.js
const express = require('express');
const router = express.Router();
const { getAuth } = require('firebase-admin/auth');
const { pool } = require('../config/database'); // Ensure this path is correct
const jwt = require('jsonwebtoken');

router.post('/firebase-login', async (req, res) => {
    const { idToken } = req.body;

    if (!idToken) {
        return res.status(400).json({ success: false, message: "Missing ID Token" });
    }

    try {
        // 1. Verify the token securely with Google
        const decodedToken = await getAuth().verifyIdToken(idToken);
        
        // 2. Extract the verified phone number
        const phone = decodedToken.phone_number; 

        if (!phone) {
             return res.status(400).json({ success: false, message: "No phone number attached to this token." });
        }

        // 3. Check your Neon database
        // Note: If your users table has a different name, update 'users' here
        let userResult = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        let user;

        if (userResult.rows.length === 0) {
            // Create user if they don't exist
            const newUser = await pool.query(
                'INSERT INTO users (phone) VALUES ($1) RETURNING *',
                [phone]
            );
            user = newUser.rows[0];
        } else {
            user = userResult.rows[0];
        }

        // 4. Generate your app's JWT token
        // Make sure JWT_SECRET is in your Render environment variables
        const token = jwt.sign(
            { id: user.id }, 
            process.env.JWT_SECRET || 'fallback_secret_change_me', 
            { expiresIn: '7d' }
        );

        // 5. Send response back to frontend
        res.json({
            success: true,
            user: { id: user.id, phone: user.phone },
            token: token,
            message: "Logged in successfully"
        });

    } catch (error) {
        console.error("Firebase verify error:", error);
        res.status(401).json({ success: false, message: "Invalid or expired token." });
    }
});

module.exports = router;