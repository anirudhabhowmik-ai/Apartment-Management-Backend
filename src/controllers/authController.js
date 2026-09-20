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
  if (value.length === 10) value = "91" + value;
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
    { userId: user.id, id: user.id, phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
  );
}

function extractMsg91Phone(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.phone, data.mobile, data.identifier,
    data.user?.phone, data.user?.mobile, data.user?.identifier,
    data.data?.phone, data.data?.mobile, data.data?.identifier,
    data.data?.user?.phone, data.data?.user?.mobile, data.data?.user?.identifier,
    data.response?.phone, data.response?.mobile, data.response?.identifier,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const normalized = normalizePhone(value);
    if (normalized && /^91[6-9]\d{9}$/.test(normalized)) return normalized;
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
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data) return { ok: false, reason: "msg91_rejected" };
  const verified = extractMsg91Phone(data);
  if (verified && verified !== submittedPhone) {
    return { ok: false, reason: "phone_mismatch" };
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// mergeUsers
//
// Folds sourceUserId into targetUserId, then deletes the source row.
// Runs inside an open transaction. Caller has already proven control
// of the source phone via OTP, so this is safe.
// -----------------------------------------------------------------------------

async function mergeUsers(client, targetUserId, sourceUserId) {
  if (targetUserId === sourceUserId) return;

  // Every (table, column) that has a FK to users(id) and should be
  // reassigned to the surviving user. Confirmed against the schema.
  const tablesWithUserFk = [
    { table: "members", column: "created_by" },
    { table: "members", column: "user_id" },
    { table: "staff",   column: "created_by" },
    { table: "staff",   column: "user_id" },
  ];

  for (const { table, column } of tablesWithUserFk) {
    await client.query(
      `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
      [targetUserId, sourceUserId],
    );
  }

  // account_members has a UNIQUE (account_id, user_id, role). If both
  // users are members of the same account with the same role, a naive
  // UPDATE would violate it. Re-point only rows that don't already
  // exist on the target, then delete the rest (they're duplicates).
  await client.query(
    `
    UPDATE account_members am
       SET user_id = $1
     WHERE am.user_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM account_members am2
          WHERE am2.account_id = am.account_id
            AND am2.user_id    = $1
            AND am2.role       = am.role
       )
    `,
    [targetUserId, sourceUserId],
  );

  await client.query(
    `DELETE FROM account_members WHERE user_id = $1`,
    [sourceUserId],
  );

  // Source user's row can now be removed.
  await client.query(`DELETE FROM users WHERE id = $1`, [sourceUserId]);
}

// =============================================================================
// POST /api/auth/verify-widget
// =============================================================================

async function verifyWidgetToken(req, res) {
  try {
    const { phone, accessToken } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: "Phone number is required." });
    }
    if (!accessToken) {
      return res.status(400).json({ success: false, message: "MSG91 access token is required." });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone || !/^91[6-9]\d{9}$/.test(normalizedPhone)) {
      return res.status(400).json({ success: false, message: "Invalid Indian phone number." });
    }

    if (!process.env.MSG91_AUTHKEY) {
      return res.status(500).json({ success: false, message: "MSG91 is not configured on the server." });
    }
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ success: false, message: "JWT is not configured on the server." });
    }

    const verification = await verifyMsg91AccessToken(accessToken, normalizedPhone);
    if (!verification.ok) {
      return res.status(401).json({
        success: false,
        message: "MSG91 access token verification failed.",
      });
    }

    const userResult = await pool.query(
      `SELECT id, phone, name, photo_url, is_active,
              last_login_at, last_account_id, created_at, updated_at
         FROM users WHERE phone = $1 LIMIT 1`,
      [normalizedPhone],
    );

    let user;

    if (userResult.rows.length === 0) {
      const ten = normalizeTenDigit(normalizedPhone);
      let seededName = null;
      if (ten) {
        const { rows: invRows } = await pool.query(
          `SELECT invited_name FROM invitations
            WHERE RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $1
              AND invited_name IS NOT NULL AND invited_name <> ''
              AND status IN ('pending', 'accepted')
            ORDER BY created_at DESC LIMIT 1`,
          [ten],
        );
        seededName = invRows.length ? invRows[0].invited_name : null;
      }

      const insertResult = await pool.query(
        `INSERT INTO users (phone, name, is_active, last_login_at)
         VALUES ($1, $2, true, NOW())
         RETURNING id, phone, name, photo_url, is_active,
                   last_login_at, last_account_id, created_at, updated_at`,
        [normalizedPhone, seededName],
      );
      user = insertResult.rows[0];
    } else {
      user = userResult.rows[0];
      if (!user.is_active) {
        return res.status(403).json({ success: false, message: "This account is inactive." });
      }
      if (!user.name || String(user.name).trim() === "") {
        const ten = normalizeTenDigit(normalizedPhone);
        if (ten) {
          const { rows: invRows } = await pool.query(
            `SELECT invited_name FROM invitations
              WHERE RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $1
                AND invited_name IS NOT NULL AND invited_name <> ''
                AND status IN ('pending', 'accepted')
              ORDER BY created_at DESC LIMIT 1`,
            [ten],
          );
          if (invRows.length && invRows[0].invited_name) {
            const updated = await pool.query(
              `UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2
               RETURNING id, phone, name, photo_url, is_active,
                         last_login_at, last_account_id, created_at, updated_at`,
              [invRows[0].invited_name, user.id],
            );
            user = updated.rows[0];
          }
        }
      }

      const updateResult = await pool.query(
        `UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1
         RETURNING id, phone, name, photo_url, is_active,
                   last_login_at, last_account_id, created_at, updated_at`,
        [user.id],
      );
      user = updateResult.rows[0];
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
      `SELECT id, phone, name, photo_url, is_active,
              last_login_at, last_account_id, created_at, updated_at
         FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows.length) return fail(res, 404, "not_found", "User not found");
    return res.json({ user: mapUserRow(rows[0]) });
  } catch (err) {
    console.error("getMe error:", err);
    return fail(res, 500, "server_error", "Failed to load profile");
  }
};

// =============================================================================
// PUT /me
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
      `UPDATE users SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1}
        RETURNING id, phone, name, photo_url, is_active,
                  last_login_at, last_account_id, created_at, updated_at`,
      [...values, userId],
    );
    if (!result.rowCount) return fail(res, 404, "not_found", "User not found");
    return res.json({ user: mapUserRow(result.rows[0]) });
  } catch (err) {
    console.error("updateMe error:", err);
    return fail(res, 500, "server_error", "Failed to update profile");
  }
};

// =============================================================================
// POST /request-phone-change
// =============================================================================

const requestPhoneChange = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const body = req.body || {};
    const raw = body.newPhone ?? body.new_phone ?? body.phone;
    const ten = normalizeTenDigit(raw);

    if (!ten) {
      return fail(res, 400, "invalid_input", "A valid 10-digit phone number is required");
    }

    const normalized = `91${ten}`;

    const { rows: currentRows } = await pool.query(
      `SELECT phone FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!currentRows.length) return fail(res, 404, "not_found", "User not found");
    const currentPhone = normalizePhone(currentRows[0].phone);

    if (currentPhone === normalized) {
      return fail(res, 400, "same_phone", "This is already your current phone number");
    }

    const { rows: existingRows } = await pool.query(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [normalized],
    );

    const willMerge = existingRows.length > 0;

    return res.json({
      success: true,
      phone: ten,
      willMerge,
      message: willMerge
        ? "This number already belongs to another login. Verify it with OTP to merge the two logins into one."
        : "Verify the new number with the OTP to complete the change.",
    });
  } catch (err) {
    console.error("requestPhoneChange error:", err);
    return fail(res, 500, "server_error", "Failed to start phone change");
  }
};

// =============================================================================
// POST /confirm-phone-change
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
      return fail(res, 400, "invalid_input", "A valid 10-digit phone number is required");
    }
    if (!accessToken) {
      client.release();
      return fail(res, 400, "invalid_input", "MSG91 access token is required");
    }

    const normalized = `91${ten}`;

    // Verify OTP before opening the transaction. Verification is the
    // security gate that makes the merge safe.
    const verification = await verifyMsg91AccessToken(accessToken, normalized);
    if (!verification.ok) {
      client.release();
      console.error("confirmPhoneChange: MSG91 verification failed:", verification.reason);
      return fail(res, 401, "verification_failed", "Phone verification failed. Please try again.");
    }

    await client.query("BEGIN");

    const { rows: currentRows } = await client.query(
      `SELECT id, phone FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!currentRows.length) {
      await client.query("ROLLBACK");
      client.release();
      return fail(res, 404, "not_found", "User not found");
    }

    const current = currentRows[0];
    const currentPhone = normalizePhone(current.phone);

    if (currentPhone === normalized) {
      await client.query("ROLLBACK");
      client.release();
      return fail(res, 400, "same_phone", "This is already your current phone number");
    }

    const { rows: targetRows } = await client.query(
      `SELECT id, phone FROM users WHERE phone = $1 FOR UPDATE`,
      [normalized],
    );

    if (targetRows.length > 0 && targetRows[0].id !== current.id) {
      const sourceUserId = targetRows[0].id;

      // Free the target phone so the current user's UPDATE doesn't
      // collide with the source's UNIQUE phone constraint.
      //
      // users.phone is VARCHAR(15) and NOT NULL. Build a placeholder
      // that fits within 15 chars and cannot collide with a real
      // number (real numbers are "91" + 10 digits = 12 chars, all
      // digits). "merged:" + first 8 chars of the UUID = 15 chars.
      // The row is deleted before COMMIT so the placeholder is never
      // visible outside this transaction.
      const placeholder = `merged:${String(sourceUserId).slice(0, 8)}`;

      await client.query(
        `UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2`,
        [placeholder, sourceUserId],
      );

      // Move every FK reference from the source to the current user,
      // then delete the source user.
      await mergeUsers(client, current.id, sourceUserId);

      // Now claim the target phone for the current user.
      await client.query(
        `UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2`,
        [normalized, current.id],
      );
    } else {
      await client.query(
        `UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2`,
        [normalized, current.id],
      );
    }

    if (currentPhone) {
      await client.query(
        `UPDATE invitations
            SET invited_phone = $1
          WHERE RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
            AND status = 'pending'`,
        [normalized, normalizeTenDigit(currentPhone)],
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      requiresLogout: true,
      newPhone: ten,
      message: "Phone number updated. Please sign in again with your new number.",
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
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