// src/middleware/accountAccess.js
const { query } = require("../config/database");

const requireAccountRole = (...allowedRoles) => {
  return async (req, res, next) => {
    const accountId = req.params.accountId || req.params.id;
    if (!accountId) {
      return res
        .status(400)
        .json({ success: false, message: "accountId missing" });
    }

    try {
      const result = await query(
        `SELECT id, role, staff_title
           FROM memberships
          WHERE user_id = $1 AND account_id = $2`,
        [req.user.id, accountId],
      );

      if (result.rows.length === 0) {
        return res.status(403).json({
          success: false,
          message: "You are not a member of this account",
        });
      }

      const membership = result.rows[0];

      if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role)) {
        return res.status(403).json({
          success: false,
          message: `Requires one of: ${allowedRoles.join(", ")}`,
        });
      }

      req.membership = membership;
      req.accountId = accountId;
      return next();
    } catch (err) {
      console.error("requireAccountRole error:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  };
};

module.exports = { requireAccountRole };