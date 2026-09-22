// @ts-nocheck
// src/controllers/invitationController.js
const { pool } = require("../config/database");
const { grantRoleWithImpliedRoles } = require("../utils/accessSync");

// ===========================================================================
// HELPERS
// ===========================================================================

const getUserId = (req) =>
  req.user?.userId ?? req.user?.id ?? req.userId ?? null;

const normalizePhone = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
};

const fail = (res, status, code) => res.status(status).json({ code });

const VALID_ROLES = [
  "admin",
  "member_visibility",
  "staff_visibility",
  "ownership_transfer",
];

const ADMIN_LIKE_ROLES = ["admin", "ownership_transfer"];

const LOWER_ROLES = ["member_visibility", "staff_visibility"];
const EXCLUSIVE_ROLES = ["admin", "ownership_transfer"];

const ROLE_RANK = {
  member_visibility: 1,
  staff_visibility: 1,
  admin: 2,
  ownership_transfer: 3,
};

const CONTINUATION_ROLES = ["admin", "member_visibility", "staff_visibility"];

const isContinuationRow = (row) =>
  row &&
  row.status === "pending" &&
  row.accepted_by != null &&
  row.accepted_by === row.invited_by;

const isLowerRole = (r) => LOWER_ROLES.includes(r);
const isExclusiveRole = (r) => EXCLUSIVE_ROLES.includes(r);

async function getRolesForAccount(userId, accountId) {
  const { rows: ownerRows } = await pool.query(
    `SELECT 1 FROM accounts WHERE id = $1 AND created_by = $2`,
    [accountId, userId],
  );
  if (ownerRows.length) return ["owner"];

  const { rows: amRows } = await pool.query(
    `SELECT role FROM account_members
       WHERE account_id = $1
         AND user_id    = $2
         AND status     = 'active'`,
    [accountId, userId],
  );

  return amRows.map((r) => r.role);
}

const hasOwnerOrAdmin = (roles) =>
  roles.includes("owner") || roles.includes("admin");

const isOwner = (roles) => roles.includes("owner");

// ===========================================================================
// PREFLIGHT
// ===========================================================================

const preflight = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone: rawPhone, role } = req.query;

    if (!userId) return fail(res, 401, "unauthenticated");

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    if (!VALID_ROLES.includes(role)) return fail(res, 400, "invalid_input");

    const phone = normalizePhone(rawPhone);
    if (!phone) return fail(res, 400, "invalid_input");

    const { rows: ownerRows } = await pool.query(
      `SELECT u.phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId],
    );
    const ownerPhone = ownerRows.length
      ? normalizePhone(ownerRows[0].phone)
      : null;

    if (ownerPhone && ownerPhone === phone) {
      return res.json({ kind: "self" });
    }

    const { rows: userRows } = await pool.query(
      `SELECT id FROM users
        WHERE RIGHT(REGEXP_REPLACE(phone,'\\D','','g'),10) = $1
        LIMIT 1`,
      [phone],
    );

    if (userRows.length) {
      const targetUserId = userRows[0].id;
      const { rows: existing } = await pool.query(
        `SELECT role FROM account_members
          WHERE account_id = $1
            AND user_id    = $2
            AND status     = 'active'`,
        [accountId, targetUserId],
      );
      const targetRoles = existing.map((r) => r.role);

      if (role === "admin") {
        if (targetRoles.includes("admin")) {
          return res.json({ kind: "already_admin" });
        }
      }

      if (role === "member_visibility") {
        if (
          targetRoles.includes("member_visibility") ||
          targetRoles.includes("admin")
        ) {
          return res.json({ kind: "already_member" });
        }
      }

      if (role === "staff_visibility") {
        if (
          targetRoles.includes("staff_visibility") ||
          targetRoles.includes("admin")
        ) {
          return res.json({ kind: "already_staff" });
        }
      }

      if (role === "ownership_transfer") {
        const hasAnyRole =
          targetRoles.includes("admin") ||
          targetRoles.includes("member_visibility") ||
          targetRoles.includes("staff_visibility");

        if (hasAnyRole) {
          return res.json({
            kind: "member_to_admin",
            memberName: null,
          });
        }
      }
    }

    const { rows: pendingRows } = await pool.query(
      `SELECT id, role, invited_by, accepted_by, status
         FROM invitations
        WHERE account_id = $1
          AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
          AND status = 'pending'
        ORDER BY created_at DESC`,
      [accountId, phone],
    );

    const realPendingRows = pendingRows.filter((r) => !isContinuationRow(r));

    if (realPendingRows.length) {
      const sameRolePending = realPendingRows.find((r) => r.role === role);

      if (sameRolePending) {
        return res.json({ kind: "pending" });
      }

      if (isLowerRole(role)) {
        const onlyLowerPending = realPendingRows.every((r) =>
          isLowerRole(r.role),
        );
        if (onlyLowerPending) {
          return res.json({ kind: "ok" });
        }
      }

      if (isExclusiveRole(role)) {
        const top = realPendingRows[0];
        return res.json({
          kind: "member_to_admin",
          memberName: top.invited_name ?? null,
        });
      }
    }

    if (role === "admin") {
      const { rows: acceptedLowerRoles } = await pool.query(
        `SELECT role, invited_name
           FROM invitations
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
            AND role IN ('member_visibility', 'staff_visibility')
            AND status = 'accepted'
          ORDER BY responded_at DESC NULLS LAST
          LIMIT 1`,
        [accountId, phone],
      );

      if (acceptedLowerRoles.length) {
        return res.json({
          kind: "member_to_admin",
          memberName: acceptedLowerRoles[0].invited_name ?? null,
        });
      }
    }

    return res.json({ kind: "ok" });
  } catch (err) {
    console.error("invitation preflight error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// CREATE
// ===========================================================================

const createInvitation = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const {
      phone: rawPhone,
      name,
      role,
      targetMemberId,
      targetStaffId,
      predecessorContinuationRoles,
    } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated");

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    if (!VALID_ROLES.includes(role)) return fail(res, 400, "invalid_input");

    if (ADMIN_LIKE_ROLES.includes(role) && !isOwner(requesterRoles)) {
      return fail(res, 403, "owner_required");
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) return fail(res, 400, "invalid_input");

    const { rows: ownerRows } = await pool.query(
      `SELECT u.phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId],
    );
    if (ownerRows.length && normalizePhone(ownerRows[0].phone) === phone) {
      return fail(res, 400, "invalid_input");
    }

    await client.query("BEGIN");

    if (role === "ownership_transfer") {
      const { rows: otherPending } = await client.query(
        `SELECT id, invited_phone, invited_by, accepted_by, status
           FROM invitations
          WHERE account_id = $1
            AND role       = 'ownership_transfer'
            AND status     = 'pending'
          FOR UPDATE`,
        [accountId],
      );

      for (const row of otherPending) {
        if (isContinuationRow(row)) continue;
        const existingPhone = normalizePhone(row.invited_phone);
        if (existingPhone && existingPhone !== phone) {
          await client.query("ROLLBACK");
          return res.status(409).json({ code: "ownership_pending_other" });
        }
      }
    }

    const { rows: pendingRows } = await client.query(
      `SELECT id, role, invited_name, invited_by, accepted_by, status,
              target_member_id, target_staff_id
         FROM invitations
        WHERE account_id = $1
          AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
          AND status = 'pending'
        ORDER BY created_at DESC
        FOR UPDATE`,
      [accountId, phone],
    );

    const realPending = pendingRows.filter((r) => !isContinuationRow(r));

    const sameRoleRow = realPending.find((r) => r.role === role);
    if (sameRoleRow) {
      if (role === "ownership_transfer") {
        await syncContinuationRows(
          client,
          accountId,
          userId,
          sameRoleRow.id,
          predecessorContinuationRoles,
        );
      }

      const { rows: sameRows } = await client.query(
        `SELECT id, account_id, invited_phone, invited_name, role,
                status, created_at
           FROM invitations
          WHERE id = $1`,
        [sameRoleRow.id],
      );

      await client.query("COMMIT");
      return res.status(200).json(sameRows[0]);
    }

    if (isLowerRole(role)) {
      const exclusiveRows = realPending.filter((r) => isExclusiveRole(r.role));
      for (const ex of exclusiveRows) {
        await client.query(
          `UPDATE invitations
              SET status = 'cancelled',
                  responded_at = COALESCE(responded_at, NOW())
            WHERE id = $1`,
          [ex.id],
        );

        if (ex.role === "ownership_transfer") {
          await deleteContinuationRowsForOwner(client, accountId, userId);
        }
      }

      await client.query(
        `UPDATE invitations
            SET status = 'cancelled',
                responded_at = COALESCE(responded_at, NOW())
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
            AND role = $3
            AND status IN ('rejected','revoked','cancelled')`,
        [accountId, phone, role],
      );

      try {
        const { rows } = await client.query(
          `INSERT INTO invitations
             (account_id, invited_by, invited_phone, invited_name, role,
              target_member_id, target_staff_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, account_id, invited_phone, invited_name, role,
                     status, created_at`,
          [
            accountId,
            userId,
            phone,
            name || null,
            role,
            targetMemberId || null,
            targetStaffId || null,
          ],
        );

        await client.query("COMMIT");
        return res.status(201).json(rows[0]);
      } catch (e) {
        await client.query("ROLLBACK");
        if (e.code === "23505") return fail(res, 409, "conflict");
        throw e;
      }
    }

    if (isExclusiveRole(role)) {
      for (const other of realPending) {
        await client.query(
          `UPDATE invitations
              SET status = 'cancelled',
                  responded_at = COALESCE(responded_at, NOW())
            WHERE id = $1`,
          [other.id],
        );

        if (other.role === "ownership_transfer") {
          await deleteContinuationRowsForOwner(client, accountId, userId);
        }
      }

      await client.query(
        `UPDATE invitations
            SET status = 'cancelled',
                responded_at = COALESCE(responded_at, NOW())
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
            AND role = $3
            AND status IN ('rejected','revoked','cancelled')`,
        [accountId, phone, role],
      );

      try {
        const { rows } = await client.query(
          `INSERT INTO invitations
             (account_id, invited_by, invited_phone, invited_name, role,
              target_member_id, target_staff_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, account_id, invited_phone, invited_name, role,
                     status, created_at`,
          [
            accountId,
            userId,
            phone,
            name || null,
            role,
            targetMemberId || null,
            targetStaffId || null,
          ],
        );

        const newInvitation = rows[0];

        if (role === "ownership_transfer") {
          await syncContinuationRows(
            client,
            accountId,
            userId,
            newInvitation.id,
            predecessorContinuationRoles,
          );
        }

        await client.query("COMMIT");
        return res.status(201).json(newInvitation);
      } catch (e) {
        await client.query("ROLLBACK");
        if (e.code === "23505") return fail(res, 409, "conflict");
        throw e;
      }
    }

    await client.query("ROLLBACK");
    return fail(res, 400, "invalid_input");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("createInvitation error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// CONTINUATION HELPERS
// ===========================================================================

async function deleteContinuationRowsForOwner(client, accountId, ownerUserId) {
  await client.query(
    `DELETE FROM invitations
      WHERE account_id   = $1
        AND invited_by   = $2
        AND accepted_by  = $2
        AND status       = 'pending'
        AND role IN ('admin','member_visibility','staff_visibility')`,
    [accountId, ownerUserId],
  );
}

async function syncContinuationRows(
  client,
  accountId,
  ownerUserId,
  ownershipInvitationId,
  requestedRoles,
) {
  await deleteContinuationRowsForOwner(client, accountId, ownerUserId);

  const contRoles = Array.isArray(requestedRoles)
    ? requestedRoles.filter((r) => CONTINUATION_ROLES.includes(r))
    : [];

  if (contRoles.length === 0) return;

  const { rows: meRows } = await client.query(
    `SELECT phone, name FROM users WHERE id = $1`,
    [ownerUserId],
  );
  if (!meRows.length) return;

  const mePhone = normalizePhone(meRows[0].phone);
  const meName = meRows[0].name ?? null;
  if (!mePhone) return;

  for (const contRole of contRoles) {
    await client.query(
      `INSERT INTO invitations
         (account_id, invited_by, invited_phone, invited_name, role,
          status, accepted_by, responded_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $2, NULL)`,
      [accountId, ownerUserId, mePhone, meName, contRole],
    );
  }
}

// ===========================================================================
// LIST  — CHANGED
//
// Response now includes:
//   excluded_phones: [...ownerPhones, ...adminPhones]  (backward compat)
//   owner_phones:    [...]
//   admin_phones:    [...]
//   admins:          [{ user_id, name, phone, photo_url }]  ← NEW
//
// The `admins` array is used by the ownership-transfer picker so an old
// owner who only kept `admin` (and has no `members` row) can still be
// selected as an ownership target.
// ===========================================================================

const listInvitations = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { status } = req.query;

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (requesterRoles.length === 0) return fail(res, 403, "forbidden");

    let grantRows = [];
    if (!status || status === "accepted") {
      const { rows } = await pool.query(
        `SELECT
           COALESCE(i.id, am.id)              AS id,
           am.account_id,
           REGEXP_REPLACE(COALESCE(u.phone,''), '\\D', '', 'g') AS invited_phone,
           u.name                             AS invited_name,
           am.role,
           'accepted'                         AS status,
           i.target_member_id,
           i.target_staff_id,
           COALESCE(i.created_at, am.created_at)     AS created_at,
           COALESCE(i.responded_at, am.updated_at)   AS responded_at,
           i.dismissed_at,
           am.user_id                         AS accepted_by,
           owner.phone                        AS invited_by_phone,
           a.name                             AS account_name,
           a.photo_url                        AS account_photo_url,
           u.name                             AS accepted_user_name,
           u.photo_url                        AS accepted_user_photo_url,
           u.name                             AS invitee_user_name,
           u.photo_url                        AS invitee_user_photo_url,
           (
             am.role IN ('member_visibility','staff_visibility')
             AND i.id IS NOT NULL
             AND i.dismissed_at IS NULL
           )                                  AS can_dismiss
         FROM account_members am
         JOIN users    u     ON u.id  = am.user_id
         JOIN accounts a     ON a.id  = am.account_id
         LEFT JOIN users owner ON owner.id = a.created_by
         LEFT JOIN LATERAL (
           SELECT inv.id, inv.target_member_id, inv.target_staff_id,
                  inv.created_at, inv.responded_at, inv.dismissed_at
             FROM invitations inv
            WHERE inv.account_id  = am.account_id
              AND inv.accepted_by = am.user_id
              AND inv.role        = am.role
              AND inv.status      = 'accepted'
            ORDER BY inv.responded_at DESC NULLS LAST, inv.created_at DESC
            LIMIT 1
         ) i ON TRUE
         WHERE am.account_id = $1
           AND am.status     = 'active'
           AND am.user_id   <> a.created_by
         ORDER BY COALESCE(i.created_at, am.created_at) DESC`,
        [accountId],
      );
      grantRows = rows;
    }

    const invitesParams = [accountId];
    let invitesWhere = `WHERE i.account_id = $1
                          AND i.status <> 'accepted'
                          AND NOT (
                            i.status = 'pending'
                            AND i.accepted_by IS NOT NULL
                            AND i.accepted_by = i.invited_by
                          )`;

    if (status && status !== "accepted") {
      invitesParams.push(status);
      invitesWhere += ` AND i.status = $${invitesParams.length}`;
    } else if (status === "accepted") {
      invitesWhere = `WHERE 1 = 0`;
    }

    const { rows: inviteRows } = await pool.query(
      `SELECT
         i.id,
         i.account_id,
         i.invited_phone,
         i.invited_name,
         i.role,
         i.status,
         i.target_member_id,
         i.target_staff_id,
         i.created_at,
         i.responded_at,
         i.dismissed_at,
         i.accepted_by,
         u.phone                 AS invited_by_phone,
         a.name                  AS account_name,
         a.photo_url             AS account_photo_url,
         au.name                 AS accepted_user_name,
         au.photo_url            AS accepted_user_photo_url,
         iu.name                 AS invitee_user_name,
         iu.photo_url            AS invitee_user_photo_url,
         FALSE                   AS can_dismiss
       FROM invitations i
       LEFT JOIN users    u  ON u.id  = i.invited_by
       LEFT JOIN users    au ON au.id = i.accepted_by
       LEFT JOIN users    iu ON RIGHT(REGEXP_REPLACE(COALESCE(iu.phone,''),'\\D','','g'),10)
                             = RIGHT(REGEXP_REPLACE(i.invited_phone,'\\D','','g'),10)
       LEFT JOIN accounts a  ON a.id  = i.account_id
       ${invitesWhere}
       ORDER BY i.created_at DESC`,
      invitesParams,
    );

    const rows = [...grantRows, ...inviteRows];

    // ── Owner phones ──
    const { rows: ownerRowsExcluded } = await pool.query(
      `SELECT RIGHT(REGEXP_REPLACE(u.phone,'\\D','','g'),10) AS phone
         FROM accounts a
         JOIN users u ON u.id = a.created_by
        WHERE a.id = $1`,
      [accountId],
    );

    // ── Admin records (also used as ownership candidates by the frontend) ──
    // Excludes the current owner because you can't transfer ownership to
    // the person who already owns the account.
    const { rows: adminRows } = await pool.query(
      `SELECT
         RIGHT(REGEXP_REPLACE(u.phone,'\\D','','g'),10) AS phone,
         u.id        AS user_id,
         u.name      AS name,
         u.photo_url AS photo_url
         FROM account_members am
         JOIN users u ON u.id = am.user_id
         JOIN accounts a ON a.id = am.account_id
        WHERE am.account_id = $1
          AND am.role       = 'admin'
          AND am.status     = 'active'
          AND u.id         <> a.created_by`,
      [accountId],
    );

    const owner_phones = ownerRowsExcluded
      .map((r) => r.phone)
      .filter((p) => typeof p === "string" && p.length === 10);

    const admin_phones = adminRows
      .map((r) => r.phone)
      .filter((p) => typeof p === "string" && p.length === 10);

    const admins = adminRows
      .filter((r) => typeof r.phone === "string" && r.phone.length === 10)
      .map((r) => ({
        user_id: r.user_id,
        name: r.name ?? "",
        phone: r.phone,
        photo_url: r.photo_url ?? null,
      }));

    const excluded_phones = Array.from(
      new Set([...owner_phones, ...admin_phones]),
    );

    return res.json({
      success: true,
      count: rows.length,
      invitations: rows,
      excluded_phones,
      owner_phones,
      admin_phones,
      admins,
    });
  } catch (err) {
    console.error("listInvitations error:", err);
    return res.status(500).json({
      success: false,
      code: "server_error",
      detail: err.message,
    });
  }
};

// ===========================================================================
// DELETE / DISMISS
// ===========================================================================

const deleteInvitation = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    await client.query("BEGIN");

    const { rows: invRows } = await client.query(
      `SELECT id, role, invited_by, accepted_by, status
         FROM invitations
        WHERE id = $1 AND account_id = $2
        FOR UPDATE`,
      [id, accountId],
    );
    if (!invRows.length) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found");
    }

    const inv = invRows[0];

    if (inv.role === "ownership_transfer") {
      await deleteContinuationRowsForOwner(
        client,
        accountId,
        inv.invited_by,
      );
    }

    await client.query(
      `DELETE FROM invitations WHERE id = $1 AND account_id = $2`,
      [id, accountId],
    );

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("deleteInvitation error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// DELETE BATCH
// ===========================================================================

const deleteInvitationsBatch = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];

    if (!userId) return fail(res, 401, "unauthenticated");
    if (ids.length === 0) return fail(res, 400, "invalid_input");

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    await client.query("BEGIN");

    const { rows: invRows } = await client.query(
      `SELECT id, role, invited_by, accepted_by, status
         FROM invitations
        WHERE account_id = $1
          AND id = ANY($2::uuid[])
        FOR UPDATE`,
      [accountId, ids],
    );

    if (!invRows.length) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found");
    }

    const ownershipInvites = invRows.filter(
      (r) => r.role === "ownership_transfer",
    );
    for (const inv of ownershipInvites) {
      await deleteContinuationRowsForOwner(
        client,
        accountId,
        inv.invited_by,
      );
    }

    const { rowCount } = await client.query(
      `DELETE FROM invitations
        WHERE account_id = $1
          AND id = ANY($2::uuid[])`,
      [accountId, ids],
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      deleted: rowCount,
      ids: invRows.map((r) => r.id),
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("deleteInvitationsBatch error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

const dismissInvitation = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId, id } = req.params;

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (requesterRoles.length === 0) return fail(res, 403, "forbidden");

    const { rowCount: direct } = await pool.query(
      `UPDATE invitations
          SET dismissed_at = NOW()
        WHERE id = $1 AND account_id = $2`,
      [id, accountId],
    );
    if (direct > 0) return res.json({ success: true });

    const { rows: amRows } = await pool.query(
      `SELECT user_id, role FROM account_members
        WHERE id = $1 AND account_id = $2
        LIMIT 1`,
      [id, accountId],
    );
    if (!amRows.length) return fail(res, 404, "not_found");

    const { user_id: targetUserId, role } = amRows[0];

    const { rowCount: fallback } = await pool.query(
      `UPDATE invitations
          SET dismissed_at = NOW()
        WHERE account_id  = $1
          AND accepted_by = $2
          AND role        = $3
          AND status      = 'accepted'
          AND dismissed_at IS NULL`,
      [accountId, targetUserId, role],
    );

    return res.json({ success: true, updated: fallback });
  } catch (err) {
    console.error("dismissInvitation error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// MY INVITATIONS
// ===========================================================================

const listMyInvitations = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: userRows } = await pool.query(
      `SELECT phone FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) return fail(res, 404, "not_found");

    const phone = normalizePhone(userRows[0].phone);
    if (!phone) return res.json({ invitations: [] });

    const { rows } = await pool.query(
      `SELECT
         i.id, i.account_id, i.role, i.status,
         i.invited_name, i.created_at,
         a.name      AS account_name,
         a.photo_url AS account_photo_url,
         u.phone     AS invited_by_phone,
         (
           SELECT am.role
             FROM account_members am
            WHERE am.account_id = i.account_id
              AND am.user_id    = $2
              AND am.status     = 'active'
            ORDER BY CASE am.role
                       WHEN 'admin'              THEN 1
                       WHEN 'member_visibility'  THEN 2
                       WHEN 'staff_visibility'   THEN 3
                       ELSE 4
                     END
            LIMIT 1
         ) AS current_role
       FROM invitations i
       JOIN accounts a ON a.id = i.account_id
       JOIN users u    ON u.id = i.invited_by
       WHERE RIGHT(REGEXP_REPLACE(i.invited_phone,'\\D','','g'),10) = $1
         AND i.status = 'pending'
         AND NOT (
           i.accepted_by IS NOT NULL
           AND i.accepted_by = i.invited_by
         )
       ORDER BY i.created_at DESC`,
      [phone, userId],
    );

    return res.json({ invitations: rows });
  } catch (err) {
    console.error("listMyInvitations error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// ACCEPT
// ===========================================================================

const acceptInvitation = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: userRows } = await client.query(
      `SELECT id, phone, name FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) return fail(res, 404, "not_found");
    const myPhone = normalizePhone(userRows[0].phone);

    const { rows: invRows } = await client.query(
      `SELECT * FROM invitations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!invRows.length) return fail(res, 404, "not_found");

    const inv = invRows[0];

    if (isContinuationRow(inv)) return fail(res, 400, "invalid_input");
    if (inv.status !== "pending") return fail(res, 409, "conflict");

    const invPhone = normalizePhone(inv.invited_phone);
    if (!invPhone || !myPhone || invPhone !== myPhone) {
      return fail(res, 403, "forbidden");
    }

    await client.query("BEGIN");

    if (inv.role === "ownership_transfer") {
      const { rows: accRows } = await client.query(
        `SELECT created_by FROM accounts WHERE id = $1`,
        [inv.account_id],
      );
      const previousOwnerId = accRows[0]?.created_by ?? null;

      const { rows: existingUser } = await client.query(
        `SELECT id FROM users WHERE id = $1`,
        [userId],
      );
      let newOwnerId = userId;
      if (!existingUser.length) {
        const { rows: inserted } = await client.query(
          `INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING id`,
          [myPhone, inv.invited_name ?? null],
        );
        newOwnerId = inserted[0].id;
      }

      const { rows: contRows } = await client.query(
        `SELECT id, role
           FROM invitations
          WHERE account_id  = $1
            AND status      = 'pending'
            AND invited_by  = $2
            AND accepted_by = $2
            AND role IN ('admin','member_visibility','staff_visibility')
          FOR UPDATE`,
        [inv.account_id, previousOwnerId],
      );

      await client.query(
        `UPDATE accounts
            SET created_by = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [newOwnerId, inv.account_id],
      );

      await grantRoleWithImpliedRoles(
        client,
        inv.account_id,
        newOwnerId,
        "admin",
      );

      if (previousOwnerId && previousOwnerId !== newOwnerId) {
        await client.query(
          `UPDATE account_members
              SET status = 'inactive', updated_at = NOW()
            WHERE account_id = $1
              AND user_id    = $2
              AND status     = 'active'`,
          [inv.account_id, previousOwnerId],
        );
      }

      for (const c of contRows) {
        if (!previousOwnerId) continue;
        await client.query(
          `INSERT INTO account_members (account_id, user_id, role, status)
           VALUES ($1, $2, $3, 'active')
           ON CONFLICT (account_id, user_id, role)
           DO UPDATE SET status = 'active', updated_at = NOW()`,
          [inv.account_id, previousOwnerId, c.role],
        );
      }

      if (previousOwnerId) {
        await client.query(
          `DELETE FROM invitations
            WHERE account_id  = $1
              AND status      = 'pending'
              AND invited_by  = $2
              AND accepted_by = $2
              AND role IN ('admin','member_visibility','staff_visibility')`,
          [inv.account_id, previousOwnerId],
        );
      }

      await client.query(
        `UPDATE invitations
            SET status = 'accepted', accepted_by = $1, responded_at = NOW()
          WHERE id = $2`,
        [newOwnerId, id],
      );

      await client.query(
        `UPDATE invitations
            SET status = 'cancelled',
                responded_at = COALESCE(responded_at, NOW())
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
            AND status = 'pending'
            AND id <> $3
            AND NOT (
              accepted_by IS NOT NULL
              AND accepted_by = invited_by
            )`,
        [inv.account_id, myPhone, id],
      );

      if (
        inv.invited_name &&
        (!userRows[0].name || String(userRows[0].name).trim() === "")
      ) {
        await client.query(
          `UPDATE users
              SET name = $1, updated_at = NOW()
            WHERE id = $2`,
          [inv.invited_name, newOwnerId],
        );
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        invitationId: id,
        accountId: inv.account_id,
        role: inv.role,
        ownershipTransferred: true,
        newOwnerId,
        previousOwnerId,
      });
    }

    // Non-ownership branch
    await grantRoleWithImpliedRoles(client, inv.account_id, userId, inv.role);

    await client.query(
      `UPDATE invitations
          SET status = 'accepted', accepted_by = $1, responded_at = NOW()
        WHERE id = $2`,
      [userId, id],
    );

    if (
      inv.invited_name &&
      (!userRows[0].name || String(userRows[0].name).trim() === "")
    ) {
      await client.query(
        `UPDATE users
            SET name = $1, updated_at = NOW()
          WHERE id = $2`,
        [inv.invited_name, userId],
      );
    }

    if (inv.role === "admin") {
      await client.query(
        `UPDATE invitations
            SET status = 'cancelled',
                responded_at = COALESCE(responded_at, NOW())
          WHERE account_id = $1
            AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
            AND role IN ('member_visibility', 'staff_visibility')
            AND status = 'pending'
            AND id <> $3
            AND NOT (
              accepted_by IS NOT NULL
              AND accepted_by = invited_by
            )`,
        [inv.account_id, myPhone, id],
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      invitationId: id,
      accountId: inv.account_id,
      role: inv.role,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("acceptInvitation error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// REJECT
// ===========================================================================

const rejectInvitation = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) return fail(res, 401, "unauthenticated");

    const { rows: userRows } = await client.query(
      `SELECT phone FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) return fail(res, 404, "not_found");
    const myPhone = normalizePhone(userRows[0].phone);

    const { rows } = await client.query(
      `SELECT * FROM invitations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!rows.length) return fail(res, 404, "not_found");

    const inv = rows[0];

    if (isContinuationRow(inv)) return fail(res, 400, "invalid_input");

    const invPhone = normalizePhone(inv.invited_phone);
    if (!invPhone || !myPhone || invPhone !== myPhone) {
      return fail(res, 403, "forbidden");
    }
    if (inv.status !== "pending") return fail(res, 409, "conflict");

    await client.query("BEGIN");

    if (inv.role === "ownership_transfer") {
      await deleteContinuationRowsForOwner(
        client,
        inv.account_id,
        inv.invited_by,
      );
    }

    await client.query(
      `UPDATE invitations
          SET status = 'rejected', responded_at = NOW()
        WHERE id = $1`,
      [id],
    );

    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("rejectInvitation error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// ADMIN LINKED PROFILES
// ===========================================================================

const getAdminLinkedProfiles = async (req, res) => {
  try {
    const requesterId = getUserId(req);
    const { accountId, invitationId } = req.params;

    const requesterRoles = await getRolesForAccount(requesterId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    const { rows: invRows } = await pool.query(
      `SELECT id, invited_phone, accepted_by, invited_name, role, status
         FROM invitations
        WHERE id = $1 AND account_id = $2`,
      [invitationId, accountId],
    );
    if (!invRows.length) return fail(res, 404, "not_found");

    const inv = invRows[0];
    if (inv.role !== "admin" && inv.role !== "ownership_transfer") {
      return fail(res, 400, "invalid_input");
    }
    if (inv.status !== "accepted") return fail(res, 409, "conflict");

    let memberId = null;
    let memberName = null;
    let staffId = null;
    let staffName = null;

    if (inv.accepted_by) {
      const { rows: m } = await pool.query(
        `SELECT m.id, u.name
           FROM members m
           JOIN users u ON u.id = m.user_id
          WHERE m.account_id = $1
            AND m.user_id = $2
            AND m.status = 'active'
          LIMIT 1`,
        [accountId, inv.accepted_by],
      );
      if (m.length) {
        memberId = m[0].id;
        memberName = m[0].name;
      }

      const { rows: s } = await pool.query(
        `SELECT s.id, u.name
           FROM staff s
           JOIN users u ON u.id = s.user_id
          WHERE s.account_id = $1
            AND s.user_id = $2
            AND s.status = 'active'
          LIMIT 1`,
        [accountId, inv.accepted_by],
      );
      if (s.length) {
        staffId = s[0].id;
        staffName = s[0].name;
      }
    }

    return res.json({
      invitationId: inv.id,
      userId: inv.accepted_by,
      invitedName: inv.invited_name,
      hasMember: !!memberId,
      memberId,
      memberName,
      hasStaff: !!staffId,
      staffId,
      staffName,
    });
  } catch (err) {
    console.error("getAdminLinkedProfiles error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// PREVIEW REVOKE
// ===========================================================================

const previewRevoke = async (req, res) => {
  try {
    const requesterId = getUserId(req);
    const { accountId, userId: targetUserId } = req.params;

    const requesterRoles = await getRolesForAccount(requesterId, accountId);

    const selfPreview = requesterId === targetUserId;
    if (!isOwner(requesterRoles) && !selfPreview) {
      return fail(res, 403, "owner_required");
    }

    if (!targetUserId) return fail(res, 400, "invalid_input");

    const { rows: ownerRows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id = $1`,
      [accountId],
    );
    if (ownerRows.length && ownerRows[0].created_by === targetUserId) {
      return fail(res, 400, "invalid_input");
    }

    const { rows: userRows } = await pool.query(
      `SELECT phone, name FROM users WHERE id = $1`,
      [targetUserId],
    );
    const phone = userRows.length ? normalizePhone(userRows[0].phone) : null;
    const name = userRows.length ? userRows[0].name : null;

    const { rows: adminRows } = await pool.query(
      `SELECT 1 FROM account_members
        WHERE account_id = $1
          AND user_id    = $2
          AND role       = 'admin'
          AND status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );

    let memberProfile = null;
    let staffProfile = null;

    const { rows: m } = await pool.query(
      `SELECT m.id, m.wing, m.flat_number, m.role, u.name
         FROM members m
         JOIN users u ON u.id = m.user_id
        WHERE m.account_id = $1
          AND m.user_id    = $2
          AND m.status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );
    if (m.length) {
      memberProfile = {
        id: m[0].id,
        name: m[0].name,
        wing: m[0].wing || null,
        flatNumber: m[0].flat_number || null,
        role: m[0].role || null,
      };
    }

    const { rows: s } = await pool.query(
      `SELECT s.id, s.role, u.name
         FROM staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.account_id = $1
          AND s.user_id    = $2
          AND s.status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );
    if (s.length) {
      staffProfile = {
        id: s[0].id,
        name: s[0].name,
        role: s[0].role || null,
      };
    }

    return res.json({
      userId: targetUserId,
      phone,
      name,
      isAdmin: adminRows.length > 0,
      memberProfile,
      staffProfile,
    });
  } catch (err) {
    console.error("previewRevoke error:", err);
    return fail(res, 500, "server_error");
  }
};

// ===========================================================================
// REVOKE
// ===========================================================================

const revokeAccess = async (req, res) => {
  const client = await pool.connect();
  try {
    const requesterId = getUserId(req);
    const { accountId, userId: targetUserId } = req.params;
    const { role: rawRole } = req.query;
    const body = req.body || {};

    const requesterRoles = await getRolesForAccount(requesterId, accountId);

    const selfRevoking = requesterId === targetUserId;
    if (!isOwner(requesterRoles) && !selfRevoking) {
      return fail(res, 403, "owner_required");
    }

    const roleToRevoke = rawRole || "admin";
    if (
      !["admin", "member_visibility", "staff_visibility", "all"].includes(
        roleToRevoke,
      )
    ) {
      return fail(res, 400, "invalid_input");
    }

    const { rows: ownerRows } = await pool.query(
      `SELECT created_by FROM accounts WHERE id = $1`,
      [accountId],
    );
    if (ownerRows.length && ownerRows[0].created_by === targetUserId) {
      return fail(res, 400, "invalid_input");
    }

    const { rows: memberRows } = await client.query(
      `SELECT 1 FROM members
        WHERE account_id = $1
          AND user_id    = $2
          AND status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );
    const { rows: staffRows } = await client.query(
      `SELECT 1 FROM staff
        WHERE account_id = $1
          AND user_id    = $2
          AND status     = 'active'
        LIMIT 1`,
      [accountId, targetUserId],
    );

    const hasMemberRow = memberRows.length > 0;
    const hasStaffRow = staffRows.length > 0;

    await client.query("BEGIN");

    const kept = [];
    const revoked = [];

    if (roleToRevoke === "all") {
      const { rows: deactivatedRows } = await client.query(
        `UPDATE account_members
            SET status = 'inactive', updated_at = NOW()
          WHERE account_id = $1
            AND user_id    = $2
            AND status     = 'active'
          RETURNING role`,
        [accountId, targetUserId],
      );

      if (deactivatedRows.length === 0) {
        await client.query("ROLLBACK");
        return fail(res, 404, "not_found");
      }

      await client.query(
        `UPDATE invitations
            SET status = 'revoked',
                responded_at = NOW()
          WHERE account_id  = $1
            AND accepted_by = $2
            AND status      = 'accepted'`,
        [accountId, targetUserId],
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        removed: "all",
        kept: [],
        revoked: deactivatedRows.map((r) => r.role),
      });
    }

    if (roleToRevoke === "member_visibility") {
      const { rowCount: deactivated } = await client.query(
        `UPDATE account_members
            SET status = 'inactive', updated_at = NOW()
          WHERE account_id = $1
            AND user_id    = $2
            AND role       = 'member_visibility'
            AND status     = 'active'`,
        [accountId, targetUserId],
      );

      if (!deactivated) {
        await client.query("ROLLBACK");
        return fail(res, 404, "not_found");
      }

      await client.query(
        `UPDATE invitations
            SET status = 'revoked', responded_at = NOW()
          WHERE account_id  = $1
            AND accepted_by = $2
            AND role        = 'member_visibility'
            AND status      = 'accepted'`,
        [accountId, targetUserId],
      );

      await client.query("COMMIT");
      return res.json({
        success: true,
        removed: "member_visibility",
        kept: [],
        revoked: ["member_visibility"],
      });
    }

    if (roleToRevoke === "staff_visibility") {
      const { rowCount: deactivated } = await client.query(
        `UPDATE account_members
            SET status = 'inactive', updated_at = NOW()
          WHERE account_id = $1
            AND user_id    = $2
            AND role       = 'staff_visibility'
            AND status     = 'active'`,
        [accountId, targetUserId],
      );

      if (!deactivated) {
        await client.query("ROLLBACK");
        return fail(res, 404, "not_found");
      }

      await client.query(
        `UPDATE invitations
            SET status = 'revoked', responded_at = NOW()
          WHERE account_id  = $1
            AND accepted_by = $2
            AND role        = 'staff_visibility'
            AND status      = 'accepted'`,
        [accountId, targetUserId],
      );

      await client.query("COMMIT");
      return res.json({
        success: true,
        removed: "staff_visibility",
        kept: [],
        revoked: ["staff_visibility"],
      });
    }

    const keepMemberVisibility =
      body.keepMemberVisibility === undefined
        ? hasMemberRow
        : body.keepMemberVisibility === true;

    const keepStaffVisibility =
      body.keepStaffVisibility === undefined
        ? hasStaffRow
        : body.keepStaffVisibility === true;

    const { rowCount: adminDeactivated } = await client.query(
      `UPDATE account_members
          SET status = 'inactive', updated_at = NOW()
        WHERE account_id = $1
          AND user_id    = $2
          AND role       = 'admin'
          AND status     = 'active'`,
      [accountId, targetUserId],
    );

    if (!adminDeactivated) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found");
    }

    await client.query(
      `UPDATE invitations
          SET status = 'revoked', responded_at = NOW()
        WHERE account_id  = $1
          AND accepted_by = $2
          AND role        = 'admin'
          AND status      = 'accepted'`,
      [accountId, targetUserId],
    );

    if (keepMemberVisibility && hasMemberRow) {
      await client.query(
        `INSERT INTO account_members (account_id, user_id, role, status)
         VALUES ($1, $2, 'member_visibility', 'active')
         ON CONFLICT (account_id, user_id, role)
         DO UPDATE SET status = 'active', updated_at = NOW()`,
        [accountId, targetUserId],
      );
      await client.query(
        `UPDATE invitations
            SET dismissed_at = NULL
          WHERE account_id  = $1
            AND accepted_by = $2
            AND role        = 'member_visibility'
            AND dismissed_at IS NOT NULL`,
        [accountId, targetUserId],
      );
      kept.push("member_visibility");
    } else {
      await client.query(
        `UPDATE account_members
            SET status = 'inactive', updated_at = NOW()
          WHERE account_id = $1
            AND user_id    = $2
            AND role       = 'member_visibility'
            AND status     = 'active'`,
        [accountId, targetUserId],
      );
      await client.query(
        `UPDATE invitations
            SET status = 'revoked', responded_at = NOW()
          WHERE account_id  = $1
            AND accepted_by = $2
            AND role        = 'member_visibility'
            AND status      = 'accepted'`,
        [accountId, targetUserId],
      );
      revoked.push("member_visibility");
    }

    if (keepStaffVisibility && hasStaffRow) {
      await client.query(
        `INSERT INTO account_members (account_id, user_id, role, status)
         VALUES ($1, $2, 'staff_visibility', 'active')
         ON CONFLICT (account_id, user_id, role)
         DO UPDATE SET status = 'active', updated_at = NOW()`,
        [accountId, targetUserId],
      );
      await client.query(
        `UPDATE invitations
            SET dismissed_at = NULL
          WHERE account_id  = $1
            AND accepted_by = $2
            AND role        = 'staff_visibility'
            AND dismissed_at IS NOT NULL`,
        [accountId, targetUserId],
      );
      kept.push("staff_visibility");
    } else {
      await client.query(
        `UPDATE account_members
            SET status = 'inactive', updated_at = NOW()
          WHERE account_id = $1
            AND user_id    = $2
            AND role       = 'staff_visibility'
            AND status     = 'active'`,
        [accountId, targetUserId],
      );
      await client.query(
        `UPDATE invitations
            SET status = 'revoked', responded_at = NOW()
          WHERE account_id  = $1
            AND accepted_by = $2
            AND role        = 'staff_visibility'
            AND status      = 'accepted'`,
        [accountId, targetUserId],
      );
      revoked.push("staff_visibility");
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      removed: "admin",
      kept,
      revoked,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("revokeAccess error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

// ===========================================================================
// RENAME PERSON ON ACCOUNT
// ===========================================================================

const renamePersonOnAccount = async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const { phone: rawPhone, name: rawName } = req.body || {};

    if (!userId) return fail(res, 401, "unauthenticated");

    const requesterRoles = await getRolesForAccount(userId, accountId);
    if (!hasOwnerOrAdmin(requesterRoles)) return fail(res, 403, "forbidden");

    const phone = normalizePhone(rawPhone);
    if (!phone) return fail(res, 400, "invalid_input");

    const cleanName = String(rawName || "").trim();
    if (!cleanName) return fail(res, 400, "invalid_input");

    await client.query("BEGIN");

    const { rows: userRows } = await client.query(
      `SELECT id, name FROM users
        WHERE RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'\\D','','g'),10) = $1`,
      [phone],
    );

    if (userRows.length > 0) {
      const userIds = userRows.map((r) => r.id);

      await client.query(
        `UPDATE users
            SET name = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[])`,
        [cleanName, userIds],
      );

      const membersResult = await client.query(
        `UPDATE members
            SET updated_at = NOW()
          WHERE account_id = $1
            AND user_id    = ANY($2::uuid[])
            AND status     = 'active'`,
        [accountId, userIds],
      );

      const staffResult = await client.query(
        `UPDATE staff
            SET updated_at = NOW()
          WHERE account_id = $1
            AND user_id    = ANY($2::uuid[])
            AND status     = 'active'`,
        [accountId, userIds],
      );

      const invitationsResult = await client.query(
        `UPDATE invitations
            SET invited_name = $1
          WHERE account_id = $2
            AND status     = 'pending'
            AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $3`,
        [cleanName, accountId, phone],
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        name: cleanName,
        users_updated: userIds.length,
        members_updated: membersResult.rowCount,
        staff_updated: staffResult.rowCount,
        invitations_updated: invitationsResult.rowCount,
      });
    }

    const { rows: memberMatches } = await client.query(
      `SELECT id FROM members
        WHERE account_id = $1
          AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'\\D','','g'),10) = $2
        LIMIT 1`,
      [accountId, phone],
    );

    const { rows: staffMatches } = await client.query(
      `SELECT id FROM staff
        WHERE account_id = $1
          AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'\\D','','g'),10) = $2
        LIMIT 1`,
      [accountId, phone],
    );

    const { rows: pendingInvites } = await client.query(
      `SELECT id FROM invitations
        WHERE account_id = $1
          AND status     = 'pending'
          AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $2
        LIMIT 1`,
      [accountId, phone],
    );

    if (
      memberMatches.length === 0 &&
      staffMatches.length === 0 &&
      pendingInvites.length === 0
    ) {
      await client.query("ROLLBACK");
      return fail(res, 404, "not_found");
    }

    const invitationsResult = await client.query(
      `UPDATE invitations
          SET invited_name = $1
        WHERE account_id = $2
          AND status     = 'pending'
          AND RIGHT(REGEXP_REPLACE(invited_phone,'\\D','','g'),10) = $3`,
      [cleanName, accountId, phone],
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      name: cleanName,
      users_updated: 0,
      members_updated: 0,
      staff_updated: 0,
      invitations_updated: invitationsResult.rowCount,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("renamePersonOnAccount error:", err);
    return fail(res, 500, "server_error");
  } finally {
    client.release();
  }
};

module.exports = {
  preflight,
  createInvitation,
  listInvitations,
  deleteInvitation,
  deleteInvitationsBatch,
  dismissInvitation,
  listMyInvitations,
  acceptInvitation,
  rejectInvitation,
  getAdminLinkedProfiles,
  previewRevoke,
  revokeAccess,
  renamePersonOnAccount,
};