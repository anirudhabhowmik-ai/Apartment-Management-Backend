const { pool } = require("../config/database");

/**
 * POST /api/notifications/register-token
 *
 * Body: { pushToken: string, platform: "ios" | "android" }
 * Auth: Bearer JWT (req.user.id set by auth middleware)
 */
const registerToken = async (req, res) => {
  try {
    const { pushToken, platform } = req.body;

    // Adjust to match whatever your auth middleware sets on req
    const userId = req.user?.id || req.userId || req.user?.userId;

    console.log("Register push token request:", {
      userId,
      pushToken,
      platform,
    });

    if (!pushToken) {
      return res.status(400).json({
        success: false,
        error: "pushToken is required.",
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized.",
      });
    }

    await pool.query(
      `UPDATE users
          SET push_token = $1,
              push_platform = $2,
              push_token_updated_at = NOW()
        WHERE id = $3`,
      [pushToken, platform || null, userId],
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("registerToken error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};

module.exports = { registerToken };