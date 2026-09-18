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
  updateAccount,
  deleteAccount,
  transferOwnership,
  setLastAccount,
} = require("../controllers/accountController");

router.post("/", authMiddleware, createAccount);
router.get("/", authMiddleware, listAccounts);

// Must come BEFORE "/:id" so it doesn't get shadowed.
router.patch("/me/last-account", authMiddleware, setLastAccount);

// Edit account (name and/or photo)
router.patch("/:id", authMiddleware, updateAccount);

// Owner-only actions
router.delete("/:id", authMiddleware, deleteAccount);
router.post("/:id/transfer-ownership", authMiddleware, transferOwnership);

module.exports = router;