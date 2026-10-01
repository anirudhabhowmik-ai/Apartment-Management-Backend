// src/controllers/otpController.js
const MSG91_WIDGET_ID = process.env.MSG91_WIDGET_ID;
const MSG91_TOKEN_AUTH = process.env.MSG91_TOKEN_AUTH;

// MSG91 v5 Widget API endpoints
const MSG91_WIDGET_SEND_URL =
  "https://control.msg91.com/api/v5/widget/sendOtpMobile";
const MSG91_WIDGET_VERIFY_URL =
  "https://control.msg91.com/api/v5/widget/verifyOtp";

// ============================================================
// POST /auth/send-widget-otp
// Proxies MSG91 Widget send call. Called only by the web client.
// ============================================================
const sendWidgetOtp = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: "Phone number is required" });
    }

    if (!MSG91_WIDGET_ID || !MSG91_TOKEN_AUTH) {
      console.error(
        "[otpController] MSG91_WIDGET_ID or MSG91_TOKEN_AUTH missing in .env",
      );
      return res
        .status(500)
        .json({ success: false, message: "OTP service is not configured." });
    }

    let digits = String(phone).replace(/\D/g, "");
    if (digits.length === 10) digits = `91${digits}`;

    const response = await fetch(MSG91_WIDGET_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        widgetId: MSG91_WIDGET_ID,
        tokenAuth: MSG91_TOKEN_AUTH,
        identifier: digits,
      }),
    });

    const data = await response.json().catch(() => null);
    console.log("[otpController] MSG91 widget send response:", data);

    if (data?.type === "success") {
      return res.json({
        type: "success",
        success: true,
        message: data.message, // reqId
      });
    }

    return res.status(response.status || 500).json({
      success: false,
      message: data?.message || "Failed to send OTP",
    });
  } catch (error) {
    console.error("Send widget OTP error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to send OTP" });
  }
};

// ============================================================
// POST /auth/verify-widget-otp
// Proxies MSG91 Widget verify call. Returns the access token.
// Called only by the web client.
// ============================================================
const verifyWidgetOtp = async (req, res) => {
  try {
    const { reqId, otp } = req.body;
    if (!reqId || !otp) {
      return res
        .status(400)
        .json({ success: false, message: "reqId and OTP are required" });
    }

    if (!MSG91_WIDGET_ID || !MSG91_TOKEN_AUTH) {
      console.error(
        "[otpController] MSG91_WIDGET_ID or MSG91_TOKEN_AUTH missing in .env",
      );
      return res
        .status(500)
        .json({ success: false, message: "OTP service is not configured." });
    }

    const response = await fetch(MSG91_WIDGET_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        widgetId: MSG91_WIDGET_ID,
        tokenAuth: MSG91_TOKEN_AUTH,
        reqId: String(reqId),
        otp: String(otp),
      }),
    });

    const data = await response.json().catch(() => null);
    console.log("[otpController] MSG91 widget verify response:", data);

    if (data?.type === "success") {
      return res.json({
        type: "success",
        success: true,
        message: data.message, // access token
      });
    }

    return res.status(response.status || 401).json({
      success: false,
      message: data?.message || "Invalid OTP",
    });
  } catch (error) {
    console.error("Verify widget OTP error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to verify OTP" });
  }
};

module.exports = { sendWidgetOtp, verifyWidgetOtp };