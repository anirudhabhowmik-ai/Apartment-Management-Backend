// src/controllers/authController.js
const { query } = require("../config/database");
const jwt = require("jsonwebtoken");

const MSG91_AUTH_KEY = process.env.MSG91_AUTHKEY;

/**
 * Verify MSG91 Widget access token.
 * The widget (mobile) sends OTP and verifies it with MSG91.
 * On success it hands the app an accessToken. The app sends that
 * token to us, and we confirm with MSG91 that it's valid.
 */
const verifyMSG91AccessToken = async (accessToken) => {
  if (!MSG91_AUTH_KEY) {
    throw new Error("MSG91_AUTHKEY is not configured on server");
  }
  if (!accessToken) {
    throw new Error("MSG91 access token is missing");
  }

  const response = await fetch(
    "https://control.msg91.com/api/v5/widget/verifyAccessToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        authkey: MSG91_AUTH_KEY,
        "access-token": accessToken,
      }).toString(),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || "MSG91 access token verification failed",
    );
  }

  if (
    data?.type === "error" ||
    String(data?.code) === "418" ||
    data?.message === "AuthenticationFailure"
  ) {
    throw new Error(data?.message || "MSG91 authentication failed");
  }

  return data;
};

/**
 * Normalize phone number to 91XXXXXXXXXX
 */
const normalizePhone = (raw) => {
  let clean = String(raw || "").replace(/\D/g, "");
  if (clean.length === 10) clean = `91${clean}`;
  if (clean.length !== 12 || !clean.startsWith("91")) return null;
  return clean;
};

/**
 * sendOtp — OTP sending is handled by the MSG91 Widget on the client.
 * This endpoint exists only to keep the frontend's sendOtp() shape intact.
 */
const sendOtp = async (req, res) => {
  return res.status(410).json({
    success: false,
    message: "OTP sending is handled by the MSG91 OTP Widget.",
  });
};

/**
 * verifyOTP — exchange a MSG91 access token for an app session.
 *
 * Body: { phone: "91XXXXXXXXXX" | "XXXXXXXXXX", accessToken: "..." }
 *
 * Response:
 *   {
 *     success: true,
 *     token,
 *     user: { id, phone, name, email, is_active },
 *     accounts: [ { id, type, name, photoUri, role, staffTitle } ]
 *   }
 */
const verifyOTP = async (req, res) => {
  try {
    const { phone, accessToken } = req.body;

    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: "Phone number is required" });
    }
    if (!accessToken) {
      return res
        .status(400)
        .json({ success: false, message: "MSG91 access token is required" });
    }

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid phone number" });
    }

    // Confirm the widget token with MSG91
    try {
      await verifyMSG91AccessToken(accessToken);
    } catch (msg91Error) {
      console.error("MSG91 token rejected:", msg91Error.message);
      return res.status(401).json({
        success: false,
        message: "MSG91 OTP verification failed. Please request a new OTP.",
      });
    }

    // Find or create the user
    const userResult = await query(
      `SELECT * FROM users WHERE phone = $1`,
      [cleanPhone],
    );

    let user = userResult.rows[0];

    if (!user) {
      const insert = await query(
        `INSERT INTO users (phone, is_active, created_at, updated_at)
         VALUES ($1, true, NOW(), NOW())
         RETURNING *`,
        [cleanPhone],
      );
      user = insert.rows[0];
    } else if (user.is_active === false) {
      return res.status(403).json({
        success: false,
        message:
          "Your account is inactive. Please contact the administrator.",
      });
    }

    // Fetch accounts (via access_grants). We include invited_phone match
    // so a user who was invited by phone but has no explicit user_id link
    // still sees the invitation — this is the phone-keyed behaviour the
    // frontend expects.
    const accountsResult = await query(
      `SELECT
         a.id, a.type, a.name, a.photo_uri,
         ag.role, ag.staff_title, ag.accepted_at, ag.created_at AS grant_created_at
       FROM access_grants ag
       JOIN accounts a ON a.id = ag.account_id
       WHERE a.is_active = true
         AND ag.accepted_at IS NOT NULL
         AND (
           ag.user_id = $1
           OR ag.invited_phone = $2
         )
       ORDER BY ag.created_at ASC`,
      [user.id, cleanPhone],
    );

    const accounts = accountsResult.rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      photoUri: r.photo_uri,
      role: r.role,
      staffTitle: r.staff_title,
    }));

    // Issue the app session JWT
    const jwtSecret = process.env.JWT_SECRET || "your-secret-key";
    const jwtExpiresIn = process.env.JWT_EXPIRES_IN || "7d";

    const token = jwt.sign(
      {
        id: user.id,
        phone: user.phone,
        // NO global role here — roles are per-account now
      },
      jwtSecret,
      { expiresIn: jwtExpiresIn },
    );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.full_name || null,
        email: user.email || null,
        is_active: user.is_active,
      },
      accounts,
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error. Please try again." });
  }
};

/**
 * getCurrentUser — returns the logged-in user and their accounts.
 */
const getCurrentUser = async (req, res) => {
  try {
    const userResult = await query(
      `SELECT id, phone, full_name, email, is_active, created_at, updated_at
         FROM users
        WHERE id = $1`,
      [req.user.id],
    );

    if (userResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const user = userResult.rows[0];

    const accountsResult = await query(
      `SELECT
         a.id, a.type, a.name, a.photo_uri,
         ag.role, ag.staff_title
       FROM access_grants ag
       JOIN accounts a ON a.id = ag.account_id
       WHERE a.is_active = true
         AND ag.accepted_at IS NOT NULL
         AND (
           ag.user_id = $1
           OR ag.invited_phone = $2
         )`,
      [user.id, user.phone],
    );

    return res.json({
      success: true,
      user,
      accounts: accountsResult.rows.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        photoUri: r.photo_uri,
        role: r.role,
        staffTitle: r.staff_title,
      })),
    });
  } catch (error) {
    console.error("Get current user error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * updateUser
 */
const updateUser = async (req, res) => {
  try {
    const { full_name, email } = req.body;
    const userId = req.user.id;

    const result = await query(
      `UPDATE users
         SET full_name = COALESCE($1, full_name),
             email     = COALESCE($2, email),
             updated_at = NOW()
       WHERE id = $3
       RETURNING id, phone, full_name, email, is_active, created_at, updated_at`,
      [full_name, email, userId],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    return res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error("Update user error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update user" });
  }
};

/**
 * logout — JWT is stateless, so this is just an acknowledgement.
 */
const logout = async (req, res) => {
  return res.json({ success: true, message: "Logged out successfully" });
};

module.exports = {
  sendOtp,
  verifyOTP,
  getCurrentUser,
  updateUser,
  logout,
};