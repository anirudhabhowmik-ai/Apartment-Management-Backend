// src/middleware/authMiddleware.js
const jwt = require("jsonwebtoken");

const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      success: false,
      message: "Missing or invalid Authorization header",
    });
  }

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key",
    );

    // ----------------------------------------------------------------
    // The JWT payload was signed with `userId` in authController.js.
    // We also fall back to `id` in case older tokens used that key.
    // ----------------------------------------------------------------
    const userId = payload.userId ?? payload.id;

    if (!userId) {
      console.error(
        "[requireAuth] token payload missing userId. Payload:",
        payload,
      );
      return res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
    }

    req.user = {
      userId,
      id: userId,               // duplicate for compatibility
      phone: payload.phone ?? null,
    };

    return next();
  } catch (err) {
    console.error("[requireAuth] jwt.verify failed:", err.message);
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

// Export the function directly. Also keep the named export for compatibility.
module.exports = requireAuth;
module.exports.requireAuth = requireAuth;