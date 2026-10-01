// src/services/otpService.js
// MSG91 OTP backend service.
// Proxies MSG91's v5 SendOTP API so the web browser can call it without CORS issues.
// Mobile uses the MSG91 SDK directly and never hits this file.

const MSG91_AUTHKEY = process.env.MSG91_AUTHKEY;
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;

const MSG91_SEND_URL = "https://control.msg91.com/api/v5/otp";
const MSG91_VERIFY_URL = "https://control.msg91.com/api/v5/otp/verify";

function normalizePhone(phone) {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  if (!/^91[6-9]\d{9}$/.test(digits)) return null;
  return digits;
}

async function sendOTPAndStore(phone) {
  if (!MSG91_AUTHKEY || !MSG91_TEMPLATE_ID) {
    console.error("[otpService] MSG91_AUTHKEY or MSG91_TEMPLATE_ID missing.");
    return { success: false, message: "OTP service is not configured." };
  }

  const digits = normalizePhone(phone);
  if (!digits) {
    return { success: false, message: "Invalid Indian phone number." };
  }

  try {
    const url =
      `${MSG91_SEND_URL}?template_id=${MSG91_TEMPLATE_ID}` +
      `&mobile=${digits}&authkey=${MSG91_AUTHKEY}`;

    const res = await fetch(url, { method: "POST" });
    const data = await res.json().catch(() => null);

    console.log("[otpService] MSG91 send response:", data);

    if (data?.type === "success") {
      return {
        success: true,
        message: data.message || "OTP sent successfully.",
      };
    }

    return {
      success: false,
      message: data?.message || "Failed to send OTP. Please try again.",
    };
  } catch (err) {
    console.error("[otpService] sendOTPAndStore error:", err);
    return { success: false, message: "Failed to send OTP. Please try again." };
  }
}

async function verifyOTPAndGetToken(phone, otp) {
  if (!MSG91_AUTHKEY) {
    return { success: false, message: "OTP service is not configured." };
  }

  const digits = normalizePhone(phone);
  if (!digits) {
    return { success: false, message: "Invalid Indian phone number." };
  }

  const otpStr = String(otp ?? "").trim();
  if (!/^\d{4,6}$/.test(otpStr)) {
    return { success: false, message: "OTP must be 4-6 digits." };
  }

  try {
    const url = `${MSG91_VERIFY_URL}?mobile=${digits}&otp=${otpStr}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { authkey: MSG91_AUTHKEY },
    });
    const data = await res.json().catch(() => null);

    console.log("[otpService] MSG91 verify response:", data);

    if (data?.type === "success") {
      return { success: true, message: data.message };
    }

    return {
      success: false,
      message: data?.message || "Invalid OTP. Please try again.",
    };
  } catch (err) {
    console.error("[otpService] verifyOTPAndGetToken error:", err);
    return {
      success: false,
      message: "Failed to verify OTP. Please try again.",
    };
  }
}

module.exports = { sendOTPAndStore, verifyOTPAndGetToken };