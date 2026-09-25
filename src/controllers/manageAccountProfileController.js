// src/controllers/manageAccountProfileController.js
const { pool } = require("../config/database");
const crypto = require("crypto");
const { writeAudit } = require("./auditController");

const OTP_TTL_MS = 10 * 60 * 1000;

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpSms(phone, code, purpose) {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[OTP] ${purpose} → +91${phone}: ${code}`);
    return { ok: true };
  }
  console.warn("[otp] sendOtpSms called in production but no provider configured");
  return { ok: false };
}

async function issueOtp(phone, purpose) {
  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await pool.query(
    `DELETE FROM otp_verifications
      WHERE phone=$1 AND purpose=$2 AND (consumed=TRUE OR expires_at < NOW())`,
    [phone, purpose]);

  await pool.query(
    `UPDATE otp_verifications SET consumed=TRUE
      WHERE phone=$1 AND purpose=$2 AND consumed=FALSE`,
    [phone, purpose]);

  await pool.query(
    `INSERT INTO otp_verifications (phone, code_hash, purpose, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [phone, codeHash, purpose, expiresAt]);

  const result = await sendOtpSms(phone, code, purpose);
  if (!result.ok) {
    await pool.query(
      `UPDATE otp_verifications SET consumed=TRUE
        WHERE phone=$1 AND purpose=$2 AND consumed=FALSE`,
      [phone, purpose]);
    const err = new Error("otp_send_failed");
    err.code = "otp_send_failed";
    throw err;
  }
  return { sent: true };
}

async function consumeOtp(phone, purpose, code) {
  if (!phone || !code) return false;
  const codeHash = hashCode(code);
  const { rows } = await pool.query(
    `SELECT id FROM otp_verifications
      WHERE phone=$1 AND purpose=$2 AND code_hash=$3
        AND consumed=FALSE AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    [phone, purpose, codeHash]);
  if (!rows.length) return false;
  await pool.query(`UPDATE otp_verifications SET consumed=TRUE WHERE id=$1`, [rows[0].id]);
  return true;
}

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
    `SELECT 1 FROM accounts WHERE id=$1 AND created_by=$2`,
    [accountId, userId]);
  if (ownerRows.length) return "owner";

  const { rows } = await pool.query(
    `SELECT role FROM account_members
       WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
    [accountId, userId]);
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

async function mergeUsers(client, survivorId, sourceId) {
  if (survivorId === sourceId) return;

  await client.query(
    `UPDATE users AS tgt
        SET photo_url = COALESCE(NULLIF(tgt.photo_url, ''), src.photo_url),
            name = COALESCE(NULLIF(tgt.name, ''), src.name),
            updated_at = NOW()
       FROM users AS src
      WHERE tgt.id=$1 AND src.id=$2
        AND (
          (tgt.photo_url IS NULL OR tgt.photo_url = '') OR
          (tgt.name IS NULL OR tgt.name = '')
        )`,
    [survivorId, sourceId]);

  const simpleFkTables = [
    { table: "members", column: "created_by" },
    { table: "members", column: "user_id" },
    { table: "staff", column: "created_by" },
    { table: "staff", column: "user_id" },
  ];

  for (const { table, column } of simpleFkTables) {
    await client.query(
      `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
      [survivorId, sourceId]);
  }

  await client.query(
    `UPDATE account_members am SET user_id = $1
     WHERE am.user_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM account_members am2
          WHERE am2.account_id = am.account_id
            AND am2.user_id = $1 AND am2.role = am.role
       )`,
    [survivorId, sourceId]);

  await client.query(`DELETE FROM account_members WHERE user_id = $1`, [sourceId]);
  await client.query(`DELETE FROM users WHERE id = $1`, [sourceId]);
}

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

const getAccountProfile = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows } = await pool.query(
      `SELECT id, name, photo_url, type, created_by, created_at, updated_at
         FROM accounts WHERE id = $1`,
      [accountId]);

    if (!rows.length) return fail(res, 404, "not_found", "Account not found");

    const account = mapAccountRow(rows[0]);
    let ownerName = "Owner";
    let ownerPhone = null;

    const { rows: ownerUser } = await pool.query(
      `SELECT phone FROM users WHERE id = $1`, [account.ownerId]);

    if (ownerUser.length && ownerUser[0].phone) {
      ownerPhone = normalizePhone(ownerUser[0].phone);
      if (ownerPhone) {
        const { rows: memberRows } = await pool.query(
          `SELECT name FROM members
            WHERE account_id=$1
              AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10)=$2 LIMIT 1`,
          [accountId, ownerPhone]);
        if (memberRows.length && memberRows[0].name) ownerName = memberRows[0].name;
      }
    }

    return res.json({
      account,
      viewerRole: role,
      canEdit: isOwner(role),
      owner: { id: account.ownerId, name: ownerName, phone: ownerPhone },
    });
  } catch (err) {
    console.error("getAccountProfile error:", err);
    return fail(res, 500, "server_error", "Failed to load account profile");
  }
};

const updateAccountProfile = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");
    if (!isOwner(role)) {
      return fail(res, 403, "forbidden", "Only the account owner can edit the account profile");
    }

    const { name, photoUrl } = req.body || {};
    const updates = {};

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return fail(res, 400, "invalid_input", "Name cannot be empty");
      if (trimmed.length > 150) return fail(res, 400, "invalid_input", "Name is too long (max 150)");
      updates.name = trimmed;
    }
    if (photoUrl !== undefined) updates.photo_url = toNullableString(photoUrl);

    if (Object.keys(updates).length === 0) {
      return fail(res, 400, "invalid_input", "No permitted fields to update");
    }

    const keys = Object.keys(updates);
    const values = keys.map((k) => updates[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");

    await client.query("BEGIN");

    const { rows: beforeRows } = await client.query(
      `SELECT id, name, photo_url, type, created_by, created_at, updated_at
         FROM accounts WHERE id = $1`,
      [accountId]);
    const before = beforeRows[0] ?? null;

    const { rows } = await client.query(
      `UPDATE accounts SET ${setClause}, updated_at = NOW()
        WHERE id = $${keys.length + 1}
        RETURNING id, name, photo_url, type, created_by, created_at, updated_at`,
      [...values, accountId]);

    if (!rows.length) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found", "Account not found");
    }

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: "owner",
      entityType: "account",
      entityId: accountId,
      action: "update",
      before,
      after: rows[0],
      visibility: "public",
    });

    await client.query("COMMIT");
    return res.json(mapAccountRow(rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("updateAccountProfile error:", err);
    return fail(res, 500, "server_error", "Failed to update account profile");
  } finally {
    client.release();
  }
};

const getPhoneChangePreview = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");
    if (!isOwner(role)) return fail(res, 403, "forbidden", "Only the account owner can change the ownership phone");

    const { rows: accountRows } = await pool.query(
      `SELECT a.created_by, u.phone AS owner_phone
         FROM accounts a JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId]);
    if (!accountRows.length) return fail(res, 404, "not_found", "Account not found");

    const currentPhone = normalizePhone(accountRows[0].owner_phone);
    if (!currentPhone) {
      return res.json({
        currentPhone: null,
        linkedMember: { exists: false },
        linkedStaff: { exists: false },
      });
    }

    const { rows: memberRows } = await pool.query(
      `SELECT id, name, role, wing, flat_number FROM members
        WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
      [accountId, userId]);
    const { rows: staffRows } = await pool.query(
      `SELECT id, name, role FROM staff
        WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
      [accountId, userId]);

    const linkedMember = memberRows.length ? {
      exists: true, id: memberRows[0].id, name: memberRows[0].name,
      role: memberRows[0].role, wing: memberRows[0].wing,
      flatNumber: memberRows[0].flat_number,
    } : { exists: false };

    const linkedStaff = staffRows.length ? {
      exists: true, id: staffRows[0].id, name: staffRows[0].name,
      role: staffRows[0].role,
    } : { exists: false };

    return res.json({ currentPhone, linkedMember, linkedStaff });
  } catch (err) {
    console.error("getPhoneChangePreview error:", err);
    return fail(res, 500, "server_error", "Failed to load phone change preview");
  }
};

const checkPhoneOwner = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const phoneRaw = req.query?.phone ?? req.body?.phone;
    const newPhone = normalizePhone(phoneRaw);

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");
    if (!newPhone) return fail(res, 400, "invalid_input", "Enter a valid 10-digit phone number");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");
    if (!isOwner(role)) return fail(res, 403, "forbidden", "Only the account owner can change the ownership phone");

    const { rows: targetRows } = await pool.query(
      `SELECT id, name, photo_url FROM users
        WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10)=$1 AND id <> $2 LIMIT 1`,
      [newPhone, userId]);
    if (!targetRows.length) return res.json({ exists: false });

    const target = targetRows[0];
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(DISTINCT acc_id)::int AS account_count FROM (
         SELECT account_id AS acc_id FROM account_members
          WHERE user_id=$1 AND status='active'
         UNION
         SELECT id AS acc_id FROM accounts WHERE created_by=$1
       ) sub`,
      [target.id]);
    const accountCount = countRows[0]?.account_count ?? 0;

    const { rows: accountRows } = await pool.query(
      `SELECT name FROM (
         SELECT a.name FROM accounts a
           JOIN account_members am ON am.account_id = a.id
            AND am.user_id=$1 AND am.status='active'
         UNION
         SELECT a.name FROM accounts a WHERE a.created_by=$1
       ) sub
       WHERE name IS NOT NULL AND name <> ''
       ORDER BY name LIMIT 5`,
      [target.id]);

    return res.json({
      exists: true,
      userId: target.id,
      name: target.name ?? null,
      photoUrl: target.photo_url ?? null,
      accountCount,
      accountNames: accountRows.map((r) => r.name),
    });
  } catch (err) {
    console.error("checkPhoneOwner error:", err);
    return fail(res, 500, "server_error", "Failed to check phone owner");
  }
};

const requestPhoneChangeOtp = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");
    if (!isOwner(role)) return fail(res, 403, "forbidden", "Only the account owner can change the ownership phone");

    const newPhone = normalizePhone(phone);
    if (!newPhone) return fail(res, 400, "invalid_input", "Enter a valid 10-digit phone number");

    const { rows: accountRows } = await pool.query(
      `SELECT a.created_by, u.phone AS owner_phone
         FROM accounts a JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId]);
    if (!accountRows.length) return fail(res, 404, "not_found", "Account not found");

    const currentOwnerPhone = normalizePhone(accountRows[0].owner_phone);
    if (currentOwnerPhone && currentOwnerPhone === newPhone) {
      return fail(res, 400, "invalid_input", "This is already the current owner's number");
    }

    try {
      await issueOtp(newPhone, "ownership_transfer");
    } catch (err) {
      if (err.code === "otp_send_failed") {
        return fail(res, 502, "otp_send_failed", "Could not send OTP. Try again.");
      }
      throw err;
    }

    return res.json({
      sent: true, phone: newPhone,
      message: `OTP sent to +91${newPhone}`,
    });
  } catch (err) {
    console.error("requestPhoneChangeOtp error:", err);
    return fail(res, 500, "server_error", "Failed to send OTP");
  }
};

const verifyPhoneChangeOtp = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone, otp, updateMemberPhone, updateStaffPhone, mergeConfirmed } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");
    if (!isOwner(role)) return fail(res, 403, "forbidden", "Only the account owner can change the ownership phone");

    const newPhone = normalizePhone(phone);
    if (!newPhone) return fail(res, 400, "invalid_input", "Enter a valid 10-digit phone number");
    if (!otp || String(otp).length !== 6) {
      return fail(res, 400, "invalid_input", "Enter the 6-digit OTP");
    }

    const ok = await consumeOtp(newPhone, "ownership_transfer", String(otp));
    if (!ok) return fail(res, 400, "invalid_otp", "Invalid or expired OTP");

    const { rows: accountRows } = await client.query(
      `SELECT a.id, a.created_by, u.phone AS owner_phone
         FROM accounts a JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId]);
    if (!accountRows.length) return fail(res, 404, "not_found", "Account not found");

    const ownerUserId = accountRows[0].created_by;
    const oldPhone = normalizePhone(accountRows[0].owner_phone);

    if (ownerUserId !== userId) {
      return fail(res, 409, "conflict", "Ownership changed since this request started. Please reload.");
    }

    const { rows: targetRows } = await client.query(
      `SELECT id, name, photo_url FROM users
        WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10)=$1 AND id <> $2 LIMIT 1`,
      [newPhone, userId]);

    if (targetRows.length) {
      if (mergeConfirmed !== true) {
        return fail(res, 409, "merge_required",
          "This number belongs to another login. Confirm the merge to continue.");
      }

      const targetUserId = targetRows[0].id;

      await client.query("BEGIN");

      await mergeUsers(client, targetUserId, userId);

      await client.query(
        `UPDATE users SET last_account_id=$1, updated_at=NOW() WHERE id=$2`,
        [accountId, targetUserId]);

      await writeAudit(client, {
        accountId,
        actorUserId: targetUserId,
        actorRole: "system",
        targetUserId: userId,
        entityType: "user",
        entityId: userId,
        action: "merge_users",
        before: { phone: oldPhone },
        after: { phone: newPhone, mergedInto: targetUserId },
        metadata: { reason: "phone_change_merge" },
        visibility: "admin",
      });

      await client.query("COMMIT");

      return res.json({
        success: true, requiresLogout: true, merged: true,
        mergedIntoUserId: targetUserId, newPhone, accountId,
        message: "Accounts merged. Please sign in again with the number you entered.",
      });
    }

    const wantsMemberUpdate = toBoolean(updateMemberPhone);
    const wantsStaffUpdate = toBoolean(updateStaffPhone);

    await client.query("BEGIN");

    let memberUpdated = false;
    if (wantsMemberUpdate) {
      const { rows: existingMember } = await client.query(
        `SELECT id FROM members
          WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
        [accountId, userId]);

      if (existingMember.length) {
        const { rows: conflictMember } = await client.query(
          `SELECT id FROM members
            WHERE account_id=$1
              AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10)=$2
              AND id <> $3 LIMIT 1`,
          [accountId, newPhone, existingMember[0].id]);

        if (conflictMember.length) {
          await client.query("ROLLBACK");
          return fail(res, 409, "conflict",
            "Another member already uses this phone number in this account.");
        }

        await client.query(
          `UPDATE members SET phone=$1, updated_at=NOW() WHERE id=$2`,
          [newPhone, existingMember[0].id]);
        memberUpdated = true;
      }
    }

    let staffUpdated = false;
    if (wantsStaffUpdate) {
      const { rows: existingStaff } = await client.query(
        `SELECT id FROM staff
          WHERE account_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
        [accountId, userId]);

      if (existingStaff.length) {
        const { rows: conflictStaff } = await client.query(
          `SELECT id FROM staff
            WHERE account_id=$1
              AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10)=$2
              AND id <> $3 LIMIT 1`,
          [accountId, newPhone, existingStaff[0].id]);

        if (conflictStaff.length) {
          await client.query("ROLLBACK");
          return fail(res, 409, "conflict",
            "Another staff member already uses this phone number in this account.");
        }

        await client.query(
          `UPDATE staff SET phone=$1, updated_at=NOW() WHERE id=$2`,
          [newPhone, existingStaff[0].id]);
        staffUpdated = true;
      }
    }

    await client.query(
      `UPDATE users SET phone=$1, updated_at=NOW() WHERE id=$2`,
      [`91${newPhone}`, userId]);

    if (oldPhone) {
      await client.query(
        `UPDATE invitations SET invited_phone=$1
          WHERE RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10)=$2
            AND status='pending'`,
        [`91${newPhone}`, oldPhone]);
    }

    await writeAudit(client, {
      accountId,
      actorUserId: userId,
      actorRole: "owner",
      targetUserId: userId,
      entityType: "user",
      entityId: userId,
      action: "phone_changed",
      before: { phone: oldPhone },
      after: { phone: newPhone },
      metadata: { memberUpdated, staffUpdated },
      visibility: "self",
    });

    await client.query("COMMIT");

    return res.json({
      success: true, requiresLogout: true, merged: false,
      newPhone, accountId, memberUpdated, staffUpdated,
      message: "Phone number updated. Please sign in again with your new number.",
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("verifyPhoneChangeOtp error:", err);
    return fail(res, 500, "server_error", "Failed to update phone number");
  } finally {
    client.release();
  }
};

const listAdmins = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated", "Authentication required");

    const role = await getRoleForAccount(userId, accountId);
    if (!role) return fail(res, 403, "forbidden", "You do not have access to this account");

    const { rows: accountRows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id=$1`, [accountId]);
    if (!accountRows.length) return fail(res, 404, "not_found", "Account not found");

    const ownerUserId = accountRows[0].created_by;
    const { rows: ownerUserRows } = await pool.query(
      `SELECT phone FROM users WHERE id=$1`, [ownerUserId]);

    let ownerPhone = null;
    let ownerName = "Owner";

    if (ownerUserRows.length && ownerUserRows[0].phone) {
      ownerPhone = normalizePhone(ownerUserRows[0].phone);
      if (ownerPhone) {
        const { rows: memberRows } = await pool.query(
          `SELECT name FROM members
            WHERE account_id=$1
              AND RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10)=$2 LIMIT 1`,
          [accountId, ownerPhone]);
        if (memberRows.length && memberRows[0].name) ownerName = memberRows[0].name;
      }
    }

    const { rows: adminRows } = await pool.query(
      `SELECT u.id AS user_id, u.phone AS user_phone,
              COALESCE(m.name, '') AS name
         FROM account_members am
         JOIN users u ON u.id = am.user_id
         LEFT JOIN members m
           ON m.account_id = am.account_id
          AND RIGHT(REGEXP_REPLACE(m.phone,'\\D','','g'),10)
              = RIGHT(REGEXP_REPLACE(u.phone,'\\D','','g'),10)
        WHERE am.account_id=$1 AND am.status='active' AND am.role='admin'
        ORDER BY COALESCE(m.name, u.phone)`,
      [accountId]);

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

module.exports = {
  getAccountProfile,
  updateAccountProfile,
  getPhoneChangePreview,
  checkPhoneOwner,
  requestPhoneChangeOtp,
  verifyPhoneChangeOtp,
  listAdmins,
};