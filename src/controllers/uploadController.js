// src/controllers/uploadController.js
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || "uploads";
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "http://localhost:3000";

/**
 * Adapter: writes a buffer to disk and returns a public URL.
 * To swap to S3/R2, replace the body of this function.
 */
const saveFile = async ({ buffer, ext }) => {
  const dir = path.join(UPLOAD_ROOT, "accounts");
  await fs.mkdir(dir, { recursive: true });
  const filename = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buffer);
  return `${PUBLIC_BASE_URL}/uploads/accounts/${filename}`;
};

/**
 * POST /uploads/account-photo
 * Expects multipart/form-data with field "file".
 * Requires multer middleware on the route.
 */
const uploadAccountPhoto = async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "file is required" });
    }

    // Basic validation
    if (!/^image\/(jpeg|png|webp)$/.test(req.file.mimetype)) {
      return res
        .status(400)
        .json({ success: false, message: "Unsupported image type" });
    }

    const ext =
      req.file.mimetype === "image/png"
        ? ".png"
        : req.file.mimetype === "image/webp"
          ? ".webp"
          : ".jpg";

    const url = await saveFile({ buffer: req.file.buffer, ext });

    return res.json({ success: true, url });
  } catch (err) {
    console.error("uploadAccountPhoto error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Upload failed" });
  }
};

module.exports = { uploadAccountPhoto };