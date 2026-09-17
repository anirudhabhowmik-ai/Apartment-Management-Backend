// src/controllers/manageAccountProfileController.js
const { pool } = require("../config/database");
const crypto = require("crypto");

// ===========================================================================
// GENERIC HELPERS
// ===========================================================================

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const getUserPhone = (req) => {
  const raw = req.user?.phone ?? null;
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const normalizePhone = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
};

async function getRoleForAccount(userId, accountId) {
  const { rows: ownerRows } = await pool.query(
    `SELECT 1 FROM accounts WHERE id = $1 AND created_by = $2`,
    [accountId, userId]
  );
  if (ownerRows.length) return "owner";

  const { rows } = await pool.query(
    `SELECT role FROM account_members
       WHERE account_id = $1
         AND user_id = $2
         AND status = 'active'
       LIMIT 1`,
    [accountId, userId]
  );

  return rows.length ? rows[0].role : null;
}

const fail = (res, status, code, message) =>
  res.status(status).json({ code, message });

const isOwner = (role) => role === "owner";

const toNullableString = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
};

const toBoolean = (v) => v === true || v === "true" || v === 1 || v === "1";

// ===========================================================================
// OTP HELPERS
// ===========================================================================

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

async function issueOtp(phone, purpose) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await pool.query(
    `UPDATE otp_verifications
        SET consumed = TRUE
      WHERE phone = $1 AND purpose = $2 AND consumed = FALSE`,
    [phone, purpose]
  );

  await pool.query(
    `INSERT INTO otp_verifications (phone, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [phone, codeHash, purpose, expiresAt]
  );

  if (process.env.NODE_ENV !== "production") {
    console.log(`[OTP] ${purpose} → +91${phone}: ${code}`);
  }

  return { sent: true };
}

async function consumeOtp(phone, purpose, code) {
  if (!phone || !code) return false;
  const codeHash = hashCode(code);

  const { rows } = await pool.query(
    `SELECT id
       FROM otp_verifications
      WHERE phone = $1
        AND purpose = $2
        AND code_hash = $3
        AND consumed = FALSE
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [phone, purpose, codeHash]
  );

  if (!rows.length) return false;

  await pool.query(
    `UPDATE otp_verifications SET consumed = TRUE WHERE id = $1`,
    [rows[0].id]
  );

  return true;
}

// ===========================================================================
// SERIALIZERS
// ===========================================================================

function mapAccountRow(a) {
  return {
    id: a.id,
    name: a.name,
    photoUrl: a.photo_url ?? undefined,
    type: a.type,
    ownerId: a.created_by,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

// ===========================================================================
// GET /accounts/:accountId/profile
// ===========================================================================

const getAccountProfile = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await pool.query(
      `SELECT id, name, photo_url, type, created_by, created_at, updated_at
         FROM accounts
        WHERE id = $1`,
      [accountId]
    );

    if (!rows.length) return fail(res, 404, "not_found", "Account not found");

    const account = mapAccountRow(rows[0]);

    let ownerName = "Owner";
    let ownerPhone = null;

    const { rows: ownerUser } = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [account.ownerId]
    );

    if (ownerUser.length && ownerUser[0].phone) {
      ownerPhone = normalizePhone(ownerUser[0].phone);

      if (ownerPhone) {
        const { rows: memberRows } = await pool.query(
          `SELECT name FROM members
            WHERE account_id = $1
              AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
            LIMIT 1`,
          [accountId, ownerPhone]
        );
        if (memberRows.length && memberRows[0].name) {
          ownerName = memberRows[0].name;
        }
      }
    }

    return res.json({
      account,
      viewerRole: role,
      canEdit: isOwner(role),
      owner: {
        id: account.ownerId,
        name: ownerName,
        phone: ownerPhone,
      },
    });
  } catch (err) {
    console.error("getAccountProfile error:", err);
    return fail(res, 500, "server_error", "Failed to load account profile");
  }
};

// ===========================================================================
// PATCH /accounts/:accountId/profile
// ===========================================================================

const updateAccountProfile = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    if (!isOwner(role)) {
      return fail(
        res,
        403,
        "forbidden",
        "Only the account owner can edit the account profile"
      );
    }

    const { name, photoUrl } = req.body || {};
    const updates = {};

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed)
        return fail(res, 400, "invalid_input", "Name cannot be empty");
      if (trimmed.length > 150)
        return fail(res, 400, "invalid_input", "Name is too long (max 150)");
      updates.name = trimmed;
    }

    if (photoUrl !== undefined) {
      updates.photo_url = toNullableString(photoUrl);
    }

    if (Object.keys(updates).length === 0) {
      return fail(res, 400, "invalid_input", "No permitted fields to update");
    }

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE accounts
          SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1}
        RETURNING id, name, photo_url, type, created_by, created_at, updated_at`,
      [...values, accountId]
    );

    await client.query("COMMIT");

    if (!rows.length) return fail(res, 404, "not_found", "Account not found");

    return res.json(mapAccountRow(rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateAccountProfile error:", err);
    return fail(res, 500, "server_error", "Failed to update account profile");
  } finally {
    client.release();
  }
};

// ===========================================================================
// GET /accounts/:accountId/profile/phone/change-preview
//
// Owner-only. Tells the frontend which linked profiles exist for the CURRENT
// owner phone (member / staff) so the client can ask:
//   "Do you want to update your Member profile too? [Yes/No]"
//   "Do you want to update your Staff profile too? [Yes/No]"
//
// Response:
//   {
//     currentPhone: "9876543210",
//     linkedMember: { exists: true,  id, name, flat_number?, role? },
//     linkedStaff:  { exists: false },
//   }
// ===========================================================================

const getPhoneChangePreview = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    if (!isOwner(role)) {
      return fail(
        res,
        403,
        "forbidden",
        "Only the account owner can change the ownership phone"
      );
    }

    // Resolve the owner's current phone.
    const { rows: accountRows } = await pool.query(
      `SELECT a.created_by, u.phone AS owner_phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId]
    );
    if (!accountRows.length)
      return fail(res, 404, "not_found", "Account not found");

    const currentPhone = normalizePhone(accountRows[0].owner_phone);
    if (!currentPhone) {
      return res.json({
        currentPhone: null,
        linkedMember: { exists: false },
        linkedStaff: { exists: false },
      });
    }

    // Check the members table.
    const { rows: memberRows } = await pool.query(
      `SELECT id, name, role, wing, flat_number
         FROM members
        WHERE account_id = $1
          AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
        LIMIT 1`,
      [accountId, currentPhone]
    );

    // Check the staff table.
    const { rows: staffRows } = await pool.query(
      `SELECT id, name, role
         FROM staff
        WHERE account_id = $1
          AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
        LIMIT 1`,
      [accountId, currentPhone]
    );

    const linkedMember = memberRows.length
      ? {
          exists: true,
          id: memberRows[0].id,
          name: memberRows[0].name,
          role: memberRows[0].role,
          wing: memberRows[0].wing,
          flatNumber: memberRows[0].flat_number,
        }
      : { exists: false };

    const linkedStaff = staffRows.length
      ? {
          exists: true,
          id: staffRows[0].id,
          name: staffRows[0].name,
          role: staffRows[0].role,
        }
      : { exists: false };

    return res.json({
      currentPhone,
      linkedMember,
      linkedStaff,
    });
  } catch (err) {
    console.error("getPhoneChangePreview error:", err);
    return fail(res, 500, "server_error", "Failed to load phone change preview");
  }
};

// ===========================================================================
// POST /accounts/:accountId/profile/phone/request-otp
// ===========================================================================

const requestPhoneChangeOtp = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone } = req.body || {};

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    if (!isOwner(role)) {
      return fail(
        res,
        403,
        "forbidden",
        "Only the account owner can change the ownership phone"
      );
    }

    const newPhone = normalizePhone(phone);
    if (!newPhone) {
      return fail(res, 400, "invalid_input", "Enter a valid 10-digit phone number");
    }

    const { rows: accountRows } = await pool.query(
      `SELECT a.created_by, u.phone AS owner_phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId]
    );
    if (!accountRows.length)
      return fail(res, 404, "not_found", "Account not found");

    const currentOwnerPhone = normalizePhone(accountRows[0].owner_phone);
    if (currentOwnerPhone && currentOwnerPhone === newPhone) {
      return fail(
        res,
        400,
        "invalid_input",
        "This is already the current owner's number"
      );
    }

    await issueOtp(newPhone, "ownership_transfer");

    return res.json({
      sent: true,
      phone: newPhone,
      message: `OTP sent to +91${newPhone}`,
    });
  } catch (err) {
    console.error("requestPhoneChangeOtp error:", err);
    return fail(res, 500, "server_error", "Failed to send OTP");
  }
};

// ===========================================================================
// POST /accounts/:accountId/profile/phone/verify-otp
//
// Owner-only. Verifies OTP for the new phone, then atomically:
//   1. (Optional) Updates members.phone for the old phone → new phone.
//   2. (Optional) Updates staff.phone for the old phone → new phone.
//   3. Upserts the new phone as a `users` row.
//   4. Upserts `account_members` for the new owner as `owner` + `active`.
//   5. Downgrades the old owner to `admin` (still active).
//   6. Sets `accounts.created_by` to the new user.
//   7. Returns `{ requiresLogout: true }`.
//
// Body: {
//   phone: "9876543210",
//   otp: "123456",
//   updateMemberPhone?: boolean,  // only honoured if a member row exists
//   updateStaffPhone?: boolean,   // only honoured if a staff row exists
// }
// ===========================================================================

const verifyPhoneChangeOtp = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone, otp, updateMemberPhone, updateStaffPhone } = req.body || {};

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    if (!isOwner(role)) {
      return fail(
        res,
        403,
        "forbidden",
        "Only the account owner can transfer ownership"
      );
    }

    const newPhone = normalizePhone(phone);
    if (!newPhone) {
      return fail(res, 400, "invalid_input", "Enter a valid 10-digit phone number");
    }

    if (!otp || String(otp).length !== 6) {
      return fail(res, 400, "invalid_input", "Enter the 6-digit OTP");
    }

    // 1. Verify OTP.
    const ok = await consumeOtp(newPhone, "ownership_transfer", String(otp));
    if (!ok) {
      return fail(res, 400, "invalid_otp", "Invalid or expired OTP");
    }

    // 2. Re-check ownership + get the old owner's phone (for member/staff sync).
    const { rows: accountRows } = await client.query(
      `SELECT a.id, a.created_by, a.name, u.phone AS owner_phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId]
    );
    if (!accountRows.length)
      return fail(res, 404, "not_found", "Account not found");

    const oldOwnerUserId = accountRows[0].created_by;
    const oldPhone = normalizePhone(accountRows[0].owner_phone);

    if (oldOwnerUserId !== userId) {
      return fail(
        res,
        409,
        "conflict",
        "Ownership changed since this request started. Please reload."
      );
    }

    const wantsMemberUpdate = toBoolean(updateMemberPhone);
    const wantsStaffUpdate = toBoolean(updateStaffPhone);

    await client.query("BEGIN");

    // 3. Optional: sync the OLD phone → NEW phone in members.
    //    Only runs if the owner actually has a member row for this account.
    let memberUpdated = false;
    if (wantsMemberUpdate && oldPhone) {
      const { rows: existingMember } = await client.query(
        `SELECT id FROM members
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
          LIMIT 1`,
        [accountId, oldPhone]
      );

      if (existingMember.length) {
        // Guard: don't stomp a different member that already owns the new
        // phone number in this account.
        const { rows: conflictMember } = await client.query(
          `SELECT id FROM members
            WHERE account_id = $1
              AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
              AND id <> $3
            LIMIT 1`,
          [accountId, newPhone, existingMember[0].id]
        );

        if (conflictMember.length) {
          await client.query("ROLLBACK");
          return fail(
            res,
            409,
            "conflict",
            "Another member already uses this phone number in this account."
          );
        }

        await client.query(
          `UPDATE members
              SET phone = $1, updated_at = NOW()
            WHERE id = $2`,
          [newPhone, existingMember[0].id]
        );
        memberUpdated = true;
      }
    }

    // 4. Optional: sync the OLD phone → NEW phone in staff.
    let staffUpdated = false;
    if (wantsStaffUpdate && oldPhone) {
      const { rows: existingStaff } = await client.query(
        `SELECT id FROM staff
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
          LIMIT 1`,
        [accountId, oldPhone]
      );

      if (existingStaff.length) {
        const { rows: conflictStaff } = await client.query(
          `SELECT id FROM staff
            WHERE account_id = $1
              AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
              AND id <> $3
            LIMIT 1`,
          [accountId, newPhone, existingStaff[0].id]
        );

        if (conflictStaff.length) {
          await client.query("ROLLBACK");
          return fail(
            res,
            409,
            "conflict",
            "Another staff member already uses this phone number in this account."
          );
        }

        await client.query(
          `UPDATE staff
              SET phone = $1, updated_at = NOW()
            WHERE id = $2`,
          [newPhone, existingStaff[0].id]
        );
        staffUpdated = true;
      }
    }

    // 5. Find or create the new user.
    const { rows: newUserRows } = await client.query(
      `SELECT id FROM users
        WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $1
        LIMIT 1`,
      [newPhone]
    );

    let newUserId;
    if (newUserRows.length) {
      newUserId = newUserRows[0].id;
      await client.query(
        `UPDATE users SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
        [newUserId]
      );
    } else {
      const { rows: inserted } = await client.query(
        `INSERT INTO users (phone, is_active)
         VALUES ($1, TRUE)
         RETURNING id`,
        [`+91${newPhone}`]
      );
      newUserId = inserted[0].id;
    }

    // 6. New user becomes owner in account_members.
    await client.query(
      `INSERT INTO account_members (account_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')
       ON CONFLICT (account_id, user_id)
       DO UPDATE SET role = 'owner', status = 'active', updated_at = NOW()`,
      [accountId, newUserId]
    );

    // 7. Old owner is downgraded to admin.
    if (oldOwnerUserId !== newUserId) {
      await client.query(
        `INSERT INTO account_members (account_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active')
         ON CONFLICT (account_id, user_id)
         DO UPDATE SET role = 'admin', status = 'active', updated_at = NOW()`,
        [accountId, oldOwnerUserId]
      );
    }

    // 8. Transfer ownership.
    await client.query(
      `UPDATE accounts
          SET created_by = $1, updated_at = NOW()
        WHERE id = $2`,
      [newUserId, accountId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      requiresLogout: true,
      newOwner: {
        id: newUserId,
        phone: newPhone,
      },
      accountId,
      memberUpdated,
      staffUpdated,
      message:
        "Ownership transferred. Please sign in again with the new number.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("verifyPhoneChangeOtp error:", err);
    return fail(res, 500, "server_error", "Failed to transfer ownership");
  } finally {
    client.release();
  }
};

// ===========================================================================
// GET /accounts/:accountId/admins
// ===========================================================================

const listAdmins = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId)
      return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role)
      return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows: accountRows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id = $1`,
      [accountId]
    );
    if (!accountRows.length)
      return fail(res, 404, "not_found", "Account not found");

    const ownerUserId = accountRows[0].created_by;

    const { rows: ownerUserRows } = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [ownerUserId]
    );

    let ownerPhone = null;
    let ownerName = "Owner";

    if (ownerUserRows.length && ownerUserRows[0].phone) {
      ownerPhone = normalizePhone(ownerUserRows[0].phone);

      if (ownerPhone) {
        const { rows: memberRows } = await pool.query(
          `SELECT name FROM members
            WHERE account_id = $1
              AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $2
            LIMIT 1`,
          [accountId, ownerPhone]
        );
        if (memberRows.length && memberRows[0].name) {
          ownerName = memberRows[0].name;
        }
      }
    }

    const { rows: adminRows } = await pool.query(
      `SELECT
          u.id                 AS user_id,
          u.phone              AS user_phone,
          COALESCE(m.name, '') AS name
         FROM account_members am
         JOIN users u ON u.id = am.user_id
         LEFT JOIN members m
           ON m.account_id = am.account_id
          AND RIGHT(REGEXP_REPLACE(m.phone,'\\D','','g'),10)
              = RIGHT(REGEXP_REPLACE(u.phone,'\\D','','g'),10)
        WHERE am.account_id = $1
          AND am.status = 'active'
          AND am.role = 'admin'
        ORDER BY COALESCE(m.name, u.phone)`,
      [accountId]
    );

    const admins = adminRows.map((r) => ({
      id: r.user_id,
      name: r.name || "Admin",
      phone: normalizePhone(r.user_phone),
      role: "admin",
    }));

    return res.json({
      owner: ownerPhone
        ? { id: ownerUserId, name: ownerName, phone: ownerPhone, role: "owner" }
        : null,
      admins,
    });
  } catch (err) {
    console.error("listAdmins error:", err);
    return fail(res, 500, "server_error", "Failed to load admins");
  }
};

// ===========================================================================

module.exports = {
  getAccountProfile,
  updateAccountProfile,
  getPhoneChangePreview,
  requestPhoneChangeOtp,
  verifyPhoneChangeOtp,
  listAdmins,
};