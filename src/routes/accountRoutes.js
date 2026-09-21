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
} = require("../controllers/accountController");

// Create + list
router.post("/", authMiddleware, createAccount);
router.get("/", authMiddleware, listAccounts);

// Static "me/*" route — must come BEFORE "/:id" routes.
router.patch("/me/last-account", authMiddleware, setLastAccount);

// People for a specific account (owner + admins).
// Must come BEFORE the generic "/:id" routes so it isn't shadowed.
router.get("/:id/people", authMiddleware, getAccountPeople);

// Edit account (name and/or photo)
router.patch("/:id", authMiddleware, updateAccount);

// Owner-only actions
router.delete("/:id", authMiddleware, deleteAccount);
router.post("/:id/transfer-ownership", authMiddleware, transferOwnership);

module.exports = router;