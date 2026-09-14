const { pool } = require("../config/database");
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
 *
 * IMPORTANT:
 * This is our application's JWT.
 * It is NOT the MSG91 access token.
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
 * Check whether MSG91 explicitly rejected the access token.
 *
 * MSG91 can return HTTP 200 while the response body indicates
 * that the token is invalid. Therefore HTTP status alone is NOT
 * enough to authenticate the user.
 */
function isMsg91VerificationFailure(data) {
  if (!data || typeof data !== "object") {
    return true;
  }

  const type = String(data.type || "").trim().toLowerCase();
  const status = String(data.status || "").trim().toLowerCase();
  const message = String(data.message || "").trim().toLowerCase();

  // Explicit failure indicators.
  if (
    type === "error" ||
    type === "fail" ||
    type === "failed" ||
    status === "error" ||
    status === "fail" ||
    status === "failed" ||
    data.hasError === true ||
    data.success === false
  ) {
    return true;
  }

  // Common invalid-token messages.
  if (
    message.includes("invalid") &&
    (message.includes("token") ||
      message.includes("access") ||
      message.includes("jwt"))
  ) {
    return true;
  }

  if (
    message.includes("unauthorized") ||
    message.includes("not authorized") ||
    message.includes("expired token") ||
    message.includes("token expired")
  ) {
    return true;
  }

  return false;
}

/**
 * Try to extract the verified phone number from MSG91 response.
 *
 * Different MSG91 response versions can use different property names,
 * so we check the documented/commonly returned structures without
 * assuming one exact response shape.
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
    if (value) {
      const normalized = normalizePhone(value);

      if (normalized && /^91[6-9]\d{9}$/.test(normalized)) {
        return normalized;
      }
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
 *
 * Flow:
 *
 * 1. Validate request.
 * 2. Verify MSG91 access token on backend.
 * 3. Reject invalid MSG91 token.
 * 4. If MSG91 gives verified phone, compare it with submitted phone.
 * 5. Find/create application user.
 * 6. Generate application JWT.
 * 7. Return application JWT.
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

    if (!normalizedPhone || !/^91[6-9]\d{9}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Indian phone number.",
      });
    }

    // =========================================================
    // 2. Validate server configuration
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

    console.log("Verifying MSG91 access token on server...");

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

    // =========================================================
    // 4. Read MSG91 response
    // =========================================================

    let msg91Data = null;

    try {
      msg91Data = await msg91Response.json();
    } catch (error) {
      console.error("Unable to parse MSG91 response as JSON.");
      msg91Data = null;
    }

    console.log(
      "MSG91 verify access token status:",
      msg91Response.status
    );

    console.log(
      "MSG91 verify access token response:",
      msg91Data
    );

    // =========================================================
    // 5. IMPORTANT SECURITY CHECK
    //
    // Do NOT rely only on msg91Response.ok.
    //
    // MSG91 may return HTTP 200 while the body indicates
    // invalid/failed authentication.
    // =========================================================

    if (!msg91Response.ok) {
      console.error(
        "MSG91 access token verification HTTP failure:",
        msg91Data
      );

      return res.status(401).json({
        success: false,
        message: "MSG91 access token verification failed.",
      });
    }

    if (isMsg91VerificationFailure(msg91Data)) {
      console.error(
        "MSG91 rejected the access token:",
        msg91Data
      );

      return res.status(401).json({
        success: false,
        message: "Invalid or expired MSG91 access token.",
      });
    }

    // =========================================================
    // 6. Verify that MSG91 actually returned a usable response
    // =========================================================

    if (!msg91Data) {
      console.error(
        "MSG91 returned an empty verification response."
      );

      return res.status(401).json({
        success: false,
        message: "MSG91 access token verification failed.",
      });
    }

    // =========================================================
    // 7. If MSG91 returns verified phone information,
    //    compare it with the phone submitted by the client.
    //
    // This prevents:
    //
    // Valid MSG91 token for User A
    // +
    // phone of User B
    // =
    // User B being logged in.
    // =========================================================

    const verifiedMsg91Phone = extractMsg91Phone(msg91Data);

    if (verifiedMsg91Phone) {
      console.log(
        "MSG91 verified phone:",
        verifiedMsg91Phone
      );

      console.log(
        "Submitted phone:",
        normalizedPhone
      );

      if (verifiedMsg91Phone !== normalizedPhone) {
        console.error(
          "MSG91 verified phone does not match submitted phone."
        );

        return res.status(401).json({
          success: false,
          message: "Phone verification mismatch.",
        });
      }
    }

    // =========================================================
    // 8. Find existing application user
    // =========================================================

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

      console.log(
        "New application user created:",
        user.id
      );
    } else {
      // =======================================================
      // Existing user
      // =======================================================

      user = userResult.rows[0];

      // =======================================================
      // 10. Check account active status
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

      console.log(
        "Existing user login:",
        user.id
      );
    }

    // =========================================================
    // 12. Generate OUR application JWT
    // =========================================================

    const token = createAppToken(user);

    // =========================================================
    // 13. Return login result
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
    console.error(
      "verifyWidgetToken error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Something went wrong during authentication.",
    });
  }
}

module.exports = {
  verifyWidgetToken,
};