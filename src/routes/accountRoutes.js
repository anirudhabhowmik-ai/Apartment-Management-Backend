const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const { createAccount } = require("../controllers/accountController");

router.post("/", authMiddleware, createAccount);

module.exports = router;