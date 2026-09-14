const {pool} = require("../config/database");
const jwt = require("jsonwebtoken");

const MSG91_VERIFY_ACCESS_TOKEN_URL =
  "https://control.msg91.com/api/v5/widget/verifyAccessToken";


function normalizePhone(phone) {
  if (!phone) {
    return null;
  }

  let value = String(phone).trim().replace(/\s+/g, "");

  if (value.startsWith("+")) {
    value = value.substring(1);
  }

  if (value.startsWith("0") && value.length === 11) {
    value = "91" + value.substring(1);
  }

  if (value.length === 10) {
    value = "91" + value;
  }

  return value;
}

/**
 * Create application JWT.
 */
function createAppToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      phone: user.phone,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    }
  );
}

/**
 * POST /api/auth/verify-widget
 *
 * Frontend sends:
 * {
 *   phone: "9876543210",
 *   accessToken: "MSG91_ACCESS_TOKEN"
 * }
 *
 * MSG91 access token is verified server-side.
 * Then the application user is created/found.
 * Finally our own JWT is returned.
 */
async function verifyWidgetToken(req, res) {
  try {
    const { phone, accessToken } = req.body;

    // -----------------------------
    // Validate request
    // -----------------------------
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required.",
      });
    }

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: "MSG91 access token is required.",
      });
    }

    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone || !/^91[6-9]\d{9}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Indian phone number.",
      });
    }

    // -----------------------------
    // Check environment variables
    // -----------------------------
    if (!process.env.MSG91_AUTHKEY) {
      console.error("MSG91_AUTHKEY is missing.");

      return res.status(500).json({
        success: false,
        message: "MSG91 is not configured on the server.",
      });
    }

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is missing.");

      return res.status(500).json({
        success: false,
        message: "JWT is not configured on the server.",
      });
    }

    // -----------------------------
    // Verify MSG91 access token
    // -----------------------------
    const msg91Response = await fetch(MSG91_VERIFY_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        authkey: process.env.MSG91_AUTHKEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "access-token": accessToken,
      }),
    });

    let msg91Data = null;

    try {
      msg91Data = await msg91Response.json();
    } catch (error) {
      msg91Data = null;
    }

    console.log("MSG91 verify access token status:", msg91Response.status);

    if (!msg91Response.ok) {
      console.error("MSG91 access token verification failed:", msg91Data);

      return res.status(401).json({
        success: false,
        message: "MSG91 OTP verification failed.",
      });
    }

    // -----------------------------
    // Find existing user
    // -----------------------------
    let userResult = await pool.query(
      `
      SELECT
        id,
        phone,
        is_active,
        last_login_at,
        created_at,
        updated_at
      FROM users
      WHERE phone = $1
      LIMIT 1
      `,
      [normalizedPhone]
    );

    let user;

    // -----------------------------
    // Create user if new
    // -----------------------------
    if (userResult.rows.length === 0) {
      const insertResult = await pool.query(
        `
        INSERT INTO users (
          phone,
          is_active,
          last_login_at
        )
        VALUES ($1, true, NOW())
        RETURNING
          id,
          phone,
          is_active,
          last_login_at,
          created_at,
          updated_at
        `,
        [normalizedPhone]
      );

      user = insertResult.rows[0];
    } else {
      user = userResult.rows[0];

      // -----------------------------
      // Check active status
      // -----------------------------
      if (!user.is_active) {
        return res.status(403).json({
          success: false,
          message: "This account is inactive.",
        });
      }

      // -----------------------------
      // Update last login
      // -----------------------------
      const updateResult = await pool.query(
        `
        UPDATE users
        SET
          last_login_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          phone,
          is_active,
          last_login_at,
          created_at,
          updated_at
        `,
        [user.id]
      );

      user = updateResult.rows[0];
    }

    // -----------------------------
    // Generate our application JWT
    // -----------------------------
    const token = createAppToken(user);

    // -----------------------------
    // Return login result
    // -----------------------------
    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token,
      user: {
        id: user.id,
        phone: user.phone,
        isActive: user.is_active,
        lastLoginAt: user.last_login_at,
      },
    });
  } catch (error) {
    console.error("verifyWidgetToken error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong during authentication.",
    });
  }
}

module.exports = {
  verifyWidgetToken,
};