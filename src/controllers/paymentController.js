const Razorpay = require("razorpay");
const crypto = require("crypto");

if (
  !process.env.RAZORPAY_KEY_ID ||
  !process.env.RAZORPAY_KEY_SECRET
) {
  console.error(
    "❌ Razorpay credentials are missing in .env",
  );
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * POST /api/payment/create-order
 */
const createOrder = async (req, res) => {
  try {
    const { amount, planName } = req.body;

    console.log(
      "Create Razorpay order request:",
      {
        amount,
        planName,
      },
    );

    // Validate amount
    if (
      amount === undefined ||
      amount === null ||
      Number.isNaN(Number(amount)) ||
      Number(amount) <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid payment amount.",
      });
    }

    // Validate plan
    if (
      !planName ||
      typeof planName !== "string"
    ) {
      return res.status(400).json({
        success: false,
        error: "Plan name is required.",
      });
    }

    const amountInPaise = Math.round(
      Number(amount) * 100,
    );

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `sub_${Date.now()}`,
      notes: {
        planName,
      },
    });

    console.log(
      "✅ Razorpay order created:",
      order.id,
    );

    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: Number(amount),
      currency: "INR",
    });
  } catch (error) {
    console.error(
      "❌ Razorpay create order error:",
      error,
    );

    return res.status(500).json({
      success: false,
      error:
        error?.error?.description ||
        error?.description ||
        error?.message ||
        "Unable to create Razorpay order.",
    });
  }
};

/**
 * POST /api/payment/verify
 */
const verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Missing Razorpay payment verification details.",
      });
    }

    const generatedSignature =
      crypto
        .createHmac(
          "sha256",
          process.env.RAZORPAY_KEY_SECRET,
        )
        .update(
          `${razorpay_order_id}|${razorpay_payment_id}`,
        )
        .digest("hex");

    if (
      generatedSignature !==
      razorpay_signature
    ) {
      console.error(
        "❌ Invalid Razorpay signature",
      );

      return res.status(400).json({
        success: false,
        error:
          "Payment verification failed.",
      });
    }

    console.log(
      "✅ Razorpay payment verified:",
      razorpay_payment_id,
    );

    return res.status(200).json({
      success: true,
      message:
        "Payment verified successfully.",
      paymentId:
        razorpay_payment_id,
      orderId:
        razorpay_order_id,
    });
  } catch (error) {
    console.error(
      "❌ Razorpay verification error:",
      error,
    );

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Payment verification failed.",
    });
  }
};

module.exports = {
  createOrder,
  verifyPayment,
};