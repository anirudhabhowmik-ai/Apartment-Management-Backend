// src/routes/accountRoutes.js
const express = require("express");
const {
  listAccounts,
  createAccount,
  getAccount,
  updateAccount,
  listMembers,
} = require("../controllers/accountController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireAccountRole } = require("../middleware/accountAccess");

const router = express.Router();

router.use(requireAuth);

router.get("/", listAccounts);
router.post("/", createAccount);
router.get("/:id", getAccount);
router.patch("/:id", requireAccountRole("admin"), updateAccount);
router.get("/:id/members", requireAccountRole("admin"), listMembers);

module.exports = router;