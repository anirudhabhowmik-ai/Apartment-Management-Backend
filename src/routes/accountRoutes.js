// src/routes/accountRoutes.js
const express = require("express");
const router = express.Router();

// ----------------------------------------------------------------
// authMiddleware now exports the function directly, but we
// also handle the object form for compatibility.
// ----------------------------------------------------------------
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
} = require("../controllers/accountController");

router.post("/", authMiddleware, createAccount);
router.get("/", authMiddleware, listAccounts);

module.exports = router;