// src/routes/pushRoutes.js
const express = require("express");
const auth = require("../middleware/authMiddleware");
const { pool } = require("../config/database");
const { savePushToken, deletePushToken } = require("../services/push");

const router = express.Router();
router.use(auth);

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

// ---------------------------------------------------------------------------
// POST /push/register  { token, platform }
// ---------------------------------------------------------------------------
router.post("/register", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        code: "unauthenticated",
        message: "Authentication required",
      });
    }

    const { token, platform } = req.body || {};
    if (!token || typeof token !== "string") {
      return res.status(400).json({
        code: "invalid_input",
        message: "token is required",
      });
    }

    await savePushToken(userId, token, platform);
    return res.json({ success: true });
  } catch (e) {
    console.error("savePushToken error:", e);
    return res.status(500).json({
      code: "server_error",
      message: "Failed to save push token",
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE /push/register  { token }
// ---------------------------------------------------------------------------
router.delete("/register", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        code: "unauthenticated",
        message: "Authentication required",
      });
    }

    const { token } = req.body || {};
    if (token) await deletePushToken(userId, token);
    return res.json({ success: true });
  } catch (e) {
    console.error("deletePushToken error:", e);
    return res.status(500).json({
      code: "server_error",
      message: "Failed to delete push token",
    });
  }
});

// ---------------------------------------------------------------------------
// GET /push/preferences
//   Returns { enabled: boolean }
//   Defaults to true if the user has never toggled.
// ---------------------------------------------------------------------------
router.get("/preferences", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        code: "unauthenticated",
        message: "Authentication required",
      });
    }

    const { rows } = await pool.query(
      `SELECT enabled FROM notification_preferences
        WHERE user_id = $1 AND preference_key = 'push_enabled'
        LIMIT 1`,
      [userId],
    );

    const enabled = rows.length > 0 ? rows[0].enabled : true;
    return res.json({ enabled });
  } catch (e) {
    console.error("getPushPreference error:", e);
    return res.status(500).json({
      code: "server_error",
      message: "Failed to load preference",
    });
  }
});

// ---------------------------------------------------------------------------
// POST /push/preferences  { enabled: boolean }
// ---------------------------------------------------------------------------
router.post("/preferences", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        code: "unauthenticated",
        message: "Authentication required",
      });
    }

    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        code: "invalid_input",
        message: "enabled must be a boolean",
      });
    }

    await pool.query(
      `INSERT INTO notification_preferences (user_id, preference_key, enabled, updated_at)
       VALUES ($1, 'push_enabled', $2, NOW())
       ON CONFLICT (user_id, preference_key)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [userId, enabled],
    );

    return res.json({ success: true, enabled });
  } catch (e) {
    console.error("savePushPreference error:", e);
    return res.status(500).json({
      code: "server_error",
      message: "Failed to save preference",
    });
  }
});

module.exports = router;