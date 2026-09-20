// src/controllers/authController.js
const { pool } = require("../config/database");
const jwt = require("jsonwebtoken");

const MSG91_VERIFY_ACCESS_TOKEN_URL =
  "https://control.msg91.com/api/v5/widget/verifyAccessToken";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normalizePhone(phone) {
  if (!phone) return null;

  let value = String(phone).trim().replace(/\s+/g, "");

  if (value.startsWith("+")) value = value.substring(1);

  if (value.startsWith("0") && value.length === 11) {
    value = "91" + value.substring(1);
  }

  if (value.length === 10) {
    value = "91" + value;
  }

  return value;
}

function normalizeTenDigit(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
}

function createAppToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      id: user.id,
      phone: user.phone,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    },
  );
}

function extractMsg91Phone(data) {
  if (!data || typeof data !== "object") return null;

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
    if (!value) continue;
    const normalized = normalizePhone(value);
    if (normalized && /^91[6-9]\d{9}$/.test(normalized)) {
      return normalized;
    }
  }

  return null;
}

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const fail = (res, status, code, message) =>
  res.status(status).json({ code, message });

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    name: row.name ?? null,
    photoUrl: row.photo_url ?? null,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

async function verifyMsg91AccessToken(accessToken, submittedPhone) {
  if (!process.env.MSG91_AUTHKEY) {
    throw new Error("MSG91_AUTHKEY is missing.");
  }

  const res = await fetch(MSG91_VERIFY_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      authkey: process.env.MSG91_AUTHKEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ "access-token": accessToken }),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok || !data) {
    return { ok: false, reason: "msg91_rejected" };
  }

  const verified = extractMsg91Phone(data);
  if (verified && verified !== submittedPhone) {
    return { ok: false, reason: "phone_mismatch" };
  }

  return { ok: true };
}

// =============================================================================
// POST /api/auth/verify-widget
// =============================================================================

async function verifyWidgetToken(req, res) {
  console.log("🔵 verifyWidgetToken CALLED:", new Date().toISOString());

  try {
    const { phone, accessToken } = req.body;

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

    const verification = await verifyMsg91AccessToken(
      accessToken,
      normalizedPhone,
    );

    if (!verification.ok) {
      console.error(
        "MSG91 access token verification failed:",
        verification.reason,
      );
      return res.status(401).json({
        success: false,
        message: "MSG91 access token verification failed.",
      });
    }

    const userResult = await pool.query(
      `
      SELECT id, phone, name, photo_url, is_active,
             last_login_at, last_account_id, created_at, updated_at
        FROM users
       WHERE phone = $1
       LIMIT 1
      `,
      [normalizedPhone],
    );

    let user;

    if (userResult.rows.length === 0) {
      const ten = normalizeTenDigit(normalizedPhone);

      let seededName = null;
      if (ten) {
        const { rows: invRows } = await pool.query(
          `
          SELECT invited_name
            FROM invitations
           WHERE RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $1
             AND invited_name IS NOT NULL
             AND invited_name <> ''
             AND status IN ('pending', 'accepted')
           ORDER BY created_at DESC
           LIMIT 1
          `,
          [ten],
        );
        seededName = invRows.length ? invRows[0].invited_name : null;
      }

      const insertResult = await pool.query(
        `
        INSERT INTO users (phone, name, is_active, last_login_at)
        VALUES ($1, $2, true, NOW())
        RETURNING id, phone, name, photo_url, is_active,
                  last_login_at, last_account_id, created_at, updated_at
        `,
        [normalizedPhone, seededName],
      );

      user = insertResult.rows[0];
      console.log("New application user created:", user.id);
    } else {
      user = userResult.rows[0];

      if (!user.is_active) {
        return res.status(403).json({
          success: false,
          message: "This account is inactive.",
        });
      }

      if (!user.name || String(user.name).trim() === "") {
        const ten = normalizeTenDigit(normalizedPhone);
        if (ten) {
          const { rows: invRows } = await pool.query(
            `
            SELECT invited_name
              FROM invitations
             WHERE RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $1
               AND invited_name IS NOT NULL
               AND invited_name <> ''
               AND status IN ('pending', 'accepted')
             ORDER BY created_at DESC
             LIMIT 1
            `,
            [ten],
          );
          if (invRows.length && invRows[0].invited_name) {
            const seeded = invRows[0].invited_name;
            const updated = await pool.query(
              `
              UPDATE users
                 SET name = $1, updated_at = NOW()
               WHERE id = $2
               RETURNING id, phone, name, photo_url, is_active,
                         last_login_at, last_account_id, created_at, updated_at
              `,
              [seeded, user.id],
            );
            user = updated.rows[0];
          }
        }
      }

      const updateResult = await pool.query(
        `
        UPDATE users
           SET last_login_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING id, phone, name, photo_url, is_active,
                   last_login_at, last_account_id, created_at, updated_at
        `,
        [user.id],
      );

      user = updateResult.rows[0];
      console.log("Existing user login:", user.id);
    }

    const token = createAppToken(user);

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token,
      user: mapUserRow(user),
    });
  } catch (error) {
    console.error("verifyWidgetToken error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong during authentication.",
    });
  }
}

// =============================================================================
// GET /me
// =============================================================================

const getMe = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const { rows } = await pool.query(
      `
      SELECT id, phone, name, photo_url, is_active,
             last_login_at, last_account_id, created_at, updated_at
        FROM users
       WHERE id = $1
       LIMIT 1
      `,
      [userId],
    );

    if (!rows.length) {
      return fail(res, 404, "not_found", "User not found");
    }

    return res.json({ user: mapUserRow(rows[0]) });
  } catch (err) {
    console.error("getMe error:", err);
    return fail(res, 500, "server_error", "Failed to load profile");
  }
};

// =============================================================================
// PUT /me
// Body: { name?, photo_url? }
// Phone is NOT editable here.
// =============================================================================

const updateMe = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const body = req.body || {};

    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const rawPhoto = Object.prototype.hasOwnProperty.call(body, "photo_url")
      ? body.photo_url
      : Object.prototype.hasOwnProperty.call(body, "photoUrl")
        ? body.photoUrl
        : undefined;
    const hasPhoto = rawPhoto !== undefined;

    if (!hasName && !hasPhoto) {
      return fail(res, 400, "invalid_input", "No permitted fields to update");
    }

    const updates = {};

    if (hasName) {
      const trimmed =
        body.name === null || body.name === undefined
          ? null
          : String(body.name).trim();
      updates.name = trimmed ? trimmed : null;
    }

    if (hasPhoto) {
      updates.photo_url = rawPhoto === null ? null : String(rawPhoto);
    }

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

    const result = await pool.query(
      `
      UPDATE users
         SET ${setClause}, updated_at = NOW()
       WHERE id = $${keys.length + 1}
       RETURNING id, phone, name, photo_url, is_active,
                 last_login_at, last_account_id, created_at, updated_at
      `,
      [...values, userId],
    );

    if (!result.rowCount) {
      return fail(res, 404, "not_found", "User not found");
    }

    return res.json({ user: mapUserRow(result.rows[0]) });
  } catch (err) {
    console.error("updateMe error:", err);
    return fail(res, 500, "server_error", "Failed to update profile");
  }
};

// =============================================================================
// POST /request-phone-change
// Body: { newPhone: "9876543210" }
//
// Pre-check only. No write. The client then runs the MSG91 widget for the
// new number and calls /confirm-phone-change with the access token.
// =============================================================================

const requestPhoneChange = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const body = req.body || {};
    const raw = body.newPhone ?? body.new_phone ?? body.phone;
    const ten = normalizeTenDigit(raw);

    if (!ten) {
      return fail(
        res,
        400,
        "invalid_input",
        "A valid 10-digit phone number is required",
      );
    }

    const normalized = `91${ten}`;

    const { rows: currentRows } = await pool.query(
      `SELECT phone FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!currentRows.length) {
      return fail(res, 404, "not_found", "User not found");
    }
    const currentPhone = normalizePhone(currentRows[0].phone);

    if (currentPhone === normalized) {
      return fail(
        res,
        400,
        "same_phone",
        "This is already your current phone number",
      );
    }

    const { rows: existingRows } = await pool.query(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [normalized],
    );
    if (existingRows.length) {
      return fail(
        res,
        409,
        "phone_taken",
        "This phone number is already linked to another account",
      );
    }

    return res.json({
      success: true,
      phone: ten,
      message: "Verify the new number with the OTP to complete the change.",
    });
  } catch (err) {
    console.error("requestPhoneChange error:", err);
    return fail(res, 500, "server_error", "Failed to start phone change");
  }
};

// =============================================================================
// POST /confirm-phone-change
// Body: { newPhone: "9876543210", accessToken: "MSG91_ACCESS_TOKEN" }
//
// Verifies the OTP-verified MSG91 token, updates users.phone, re-points
// any still-pending invitations addressed to the old number.
//
// IMPORTANT: Does NOT return a new JWT. Instead returns
// { success: true, requiresLogout: true, newPhone }. The client signs
// the user out so that whoever now controls the new number must
// authenticate fresh.
//
// account_members rows are keyed by user_id and are NOT touched.
// Accepted invitations are keyed by accepted_by and are left alone.
// =============================================================================

const confirmPhoneChange = async (req, res) => {
  const client = await pool.connect();

  try {
    const userId = getUserId(req);
    if (!userId) {
      client.release();
      return fail(res, 401, "unauthenticated", "Authentication required");
    }

    const body = req.body || {};
    const raw = body.newPhone ?? body.new_phone ?? body.phone;
    const accessToken = body.accessToken ?? body.access_token ?? null;

    const ten = normalizeTenDigit(raw);
    if (!ten) {
      client.release();
      return fail(
        res,
        400,
        "invalid_input",
        "A valid 10-digit phone number is required",
      );
    }
    if (!accessToken) {
      client.release();
      return fail(res, 400, "invalid_input", "MSG91 access token is required");
    }

    const normalized = `91${ten}`;

    const { rows: currentRows } = await client.query(
      `SELECT id, phone FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!currentRows.length) {
      client.release();
      return fail(res, 404, "not_found", "User not found");
    }

    const current = currentRows[0];
    const currentPhone = normalizePhone(current.phone);

    if (currentPhone === normalized) {
      client.release();
      return fail(
        res,
        400,
        "same_phone",
        "This is already your current phone number",
      );
    }

    const { rows: existingRows } = await client.query(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [normalized],
    );
    if (existingRows.length) {
      client.release();
      return fail(
        res,
        409,
        "phone_taken",
        "This phone number is already linked to another account",
      );
    }

    const verification = await verifyMsg91AccessToken(accessToken, normalized);
    if (!verification.ok) {
      client.release();
      console.error(
        "confirmPhoneChange: MSG91 verification failed:",
        verification.reason,
      );
      return fail(
        res,
        401,
        "verification_failed",
        "Phone verification failed. Please try again.",
      );
    }

    await client.query("BEGIN");

    await client.query(
      `
      UPDATE users
         SET phone = $1, updated_at = NOW()
       WHERE id = $2
      `,
      [normalized, userId],
    );

    if (currentPhone) {
      await client.query(
        `
        UPDATE invitations
           SET invited_phone = $1
         WHERE RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
           AND status = 'pending'
        `,
        [normalized, normalizeTenDigit(currentPhone)],
      );
    }

    await client.query("COMMIT");

    // IMPORTANT: no new JWT. The client must log out.
    return res.json({
      success: true,
      requiresLogout: true,
      newPhone: ten,
      message:
        "Phone number updated. Please sign in again with your new number.",
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("confirmPhoneChange error:", err);
    return fail(res, 500, "server_error", "Failed to update phone number");
  } finally {
    client.release();
  }
};

module.exports = {
  verifyWidgetToken,
  getMe,
  updateMe,
  requestPhoneChange,
  confirmPhoneChange,
};