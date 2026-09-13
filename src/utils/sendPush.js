const { Expo } = require("expo-server-sdk");

const expo = new Expo();

/**
 * Send a push notification via Expo's push service.
 *
 * @param {string} pushToken  Expo push token (ExponentPushToken[...])
 * @param {string} title
 * @param {string} body
 * @param {object} data       Optional JSON-serializable payload
 */
async function sendPush(pushToken, title, body, data = {}) {
  if (!pushToken) {
    console.warn("sendPush: no pushToken provided, skipping.");
    return;
  }

  if (!Expo.isExpoPushToken(pushToken)) {
    console.error(`sendPush: invalid Expo push token: ${pushToken}`);
    return;
  }

  const messages = [
    {
      to: pushToken,
      sound: "default",
      title,
      body,
      data,
    },
  ];

  try {
    const tickets = await expo.sendPushNotificationsAsync(messages);
    console.log("Push ticket:", tickets);
  } catch (err) {
    console.error("sendPush error:", err);
  }
}

module.exports = { sendPush };