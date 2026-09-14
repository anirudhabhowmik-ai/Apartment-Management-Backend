// src/middleware/authMiddleware.js
const jwt = require("jsonwebtoken");

const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res
      .status(401)
      .json({ success: false, message: "Missing or invalid Authorization header" });
  }

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key",
    );
    req.user = { id: payload.id, phone: payload.phone };
    return next();
  } catch (err) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
};

module.exports = { requireAuth };