const { pool } = require("../config/database");
const jwt = require("jsonwebtoken");

const MSG91_VERIFY_ACCESS_TOKEN_URL =
  "https://control.msg91.com/api/v5/widget/verifyAccessToken";

/**
 * Normalize Indian phone number.
 */
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
 * Create our application JWT.
 *
 * This JWT belongs to our application.
 * It is different from the MSG91 access token.
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
 * Extract a verified phone number if MSG91 returns one.
 */
function extractMsg91Phone(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const candidates = [
    data.phone,
    data.mobile,
    data.identifier,

    data.user?.phone,
    data.user?.mobile,
    data.user?.identifier,

    data.data?.phone,
    data.data?.mobile,
    data.data?.identifier,

    data.data?.user?.phone,
    data.data?.user?.mobile,
    data.data?.user?.identifier,

    data.response?.phone,
    data.response?.mobile,
    data.response?.identifier,
  ];

  for (const value of candidates) {
    if (!value) {
      continue;
    }

    const normalized = normalizePhone(value);

    if (normalized && /^91[6-9]\d{9}$/.test(normalized)) {
      return normalized;
    }
  }

  return null;
}

/**
 * POST /api/auth/verify-widget
 *
 * Frontend sends:
 *
 * {
 *   phone: "9876543210",
 *   accessToken: "MSG91_ACCESS_TOKEN"
 * }
 */
async function verifyWidgetToken(req, res) {
  try {
    const { phone, accessToken } = req.body;

    // =========================================================
    // 1. Validate request
    // =========================================================

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

    if (
      !normalizedPhone ||
      !/^91[6-9]\d{9}$/.test(normalizedPhone)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid Indian phone number.",
      });
    }

    // =========================================================
    // 2. Check server configuration
    // =========================================================

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

    // =========================================================
    // 3. Verify MSG91 access token
    // =========================================================

    const msg91Response = await fetch(
      MSG91_VERIFY_ACCESS_TOKEN_URL,
      {
        method: "POST",

        headers: {
          authkey: process.env.MSG91_AUTHKEY,
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          "access-token": accessToken,
        }),
      }
    );

    // =========================================================
    // 4. Read MSG91 response
    // =========================================================

    let msg91Data = null;

    try {
      msg91Data = await msg91Response.json();
    } catch (error) {
      msg91Data = null;
    }

    // =========================================================
    // 5. Check MSG91 verification result
    // =========================================================

    const msg91VerificationFailed =
      msg91Data?.type === "error" ||
      msg91Data?.message === "AuthenticationFailure" ||
      String(msg91Data?.code) === "418";

    if (!msg91Response.ok || msg91VerificationFailed) {
      return res.status(401).json({
        success: false,
        message: "MSG91 access token verification failed.",
      });
    }

    // =========================================================
    // 6. Empty MSG91 response
    // =========================================================

    if (!msg91Data) {
      return res.status(401).json({
        success: false,
        message: "MSG91 access token verification failed.",
      });
    }

    // =========================================================
    // 7. Verify phone if MSG91 provides it
    // =========================================================

    const verifiedMsg91Phone =
      extractMsg91Phone(msg91Data);

    if (
      verifiedMsg91Phone &&
      verifiedMsg91Phone !== normalizedPhone
    ) {
      return res.status(401).json({
        success: false,
        message: "Phone verification mismatch.",
      });
    }

    // =========================================================
    // 8. Find existing application user
    // =========================================================

    const userResult = await pool.query(
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

    // =========================================================
    // 9. Create user if this is first login
    // =========================================================

    if (userResult.rows.length === 0) {
      const insertResult = await pool.query(
        `
        INSERT INTO users (
          phone,
          is_active,
          last_login_at
        )
        VALUES (
          $1,
          true,
          NOW()
        )
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
      // =======================================================
      // Existing user
      // =======================================================

      user = userResult.rows[0];

      // =======================================================
      // 10. Check account status
      // =======================================================

      if (!user.is_active) {
        return res.status(403).json({
          success: false,
          message: "This account is inactive.",
        });
      }

      // =======================================================
      // 11. Update last login
      // =======================================================

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

    // =========================================================
    // 12. Generate our application JWT
    // =========================================================

    const token = createAppToken(user);

    // =========================================================
    // 13. Return successful authentication
    // =========================================================

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
