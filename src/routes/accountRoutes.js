// src/routes/accountRoutes.js
const express = require("express");
const router = express.Router();

const authMiddlewareModule = require("../middleware/authMiddleware");

const authMiddleware =
  typeof authMiddlewareModule === "function"
    ? authMiddlewareModule
    : authMiddlewareModule.requireAuth ||
      authMiddlewareModule.authMiddleware ||
      authMiddlewareModule.authenticate ||
      authMiddlewareModule.verify;

if (typeof authMiddleware !== "function") {
  throw new Error(
    "authMiddleware could not be resolved to a function. " +
      "Check src/middleware/authMiddleware.js. Keys: " +
      Object.keys(authMiddlewareModule).join(", "),
  );
}

const {
  createAccount,
  listAccounts,
  getAccountPeople,
  updateAccount,
  deleteAccount,
  transferOwnership,
  setLastAccount,
  getMyRole,
} = require("../controllers/accountController");

// ---------------------------------------------------------------------------
// Create + list
// ---------------------------------------------------------------------------
router.post("/", authMiddleware, createAccount);
router.get("/", authMiddleware, listAccounts);

// ---------------------------------------------------------------------------
// Static "me/*" routes — must come BEFORE "/:id" routes.
// ---------------------------------------------------------------------------
router.patch("/me/last-account", authMiddleware, setLastAccount);

// ---------------------------------------------------------------------------
// Account-scoped routes — MUST come before generic "/:id" routes so they
// aren't shadowed by the catch-all handlers below.
// ---------------------------------------------------------------------------

// Caller's current role for this account (used by the tab bar to react to
// role changes without a full logout/login).
router.get("/:id/my-role", authMiddleware, getMyRole);

// People for a specific account (owner + admins).
router.get("/:id/people", authMiddleware, getAccountPeople);

// ---------------------------------------------------------------------------
// Generic "/:id" routes — must come LAST so they don't shadow the specific
// sub-routes above.
// ---------------------------------------------------------------------------

// Edit account (name and/or photo)
router.patch("/:id", authMiddleware, updateAccount);

// Owner-only actions
router.delete("/:id", authMiddleware, deleteAccount);
router.post("/:id/transfer-ownership", authMiddleware, transferOwnership);

module.exports = router;