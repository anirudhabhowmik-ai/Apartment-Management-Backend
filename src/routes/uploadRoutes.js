// src/routes/uploadRoutes.js
const express = require("express");
const multer = require("multer");
const { uploadAccountPhoto } = require("../controllers/uploadController");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

router.post(
  "/account-photo",
  requireAuth,
  upload.single("file"),
  uploadAccountPhoto,
);

module.exports = router;