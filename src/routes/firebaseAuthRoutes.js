// routes/firebaseAuthRoutes.js
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { pool } = require('../config/database'); // Adjust path if needed
const jwt = require('jsonwebtoken'); // Assuming you use jsonwebtoken

router.post('/firebase-login', async (req, res) => {
    const { idToken } = req.body;

    if (!idToken) {
        return res.status(400).json({ success: false, message: "Missing ID Token" });
    }

    try {
        // 1. Verify the token securely with Google
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        
        // 2. Extract the verified phone number (e.g., "+919999999999")
        const phone = decodedToken.phone_number; 

        if (!phone) {
             return res.status(400).json({ success: false, message: "No phone number attached to this token." });
        }

        // 3. Check your Neon database
        // NOTE: Change 'users' to your actual table name if it's different!
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
        // Replace 'process.env.JWT_SECRET' if your secret is named differently
        const token = jwt.sign(
            { id: user.id }, 
            process.env.JWT_SECRET || 'fallback_secret', 
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