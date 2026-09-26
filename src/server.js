// src/server.js
const app = require("./app");
const { pool } = require("./config/database");
const { startPushWorker } = require("./services/push");

const PORT = process.env.PORT || 5000;

// Test database connection before starting server
pool.connect((err, client, release) => {
  if (err) {
    console.error(
      "❌ Error connecting to database:",
      err.stack,
    );

    process.exit(1);
  }

  console.log(
    "✅ Database connection established",
  );

  release();

  // Start server
  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `🚀 Server running on port ${PORT}`,
      );

      console.log(
        `🌐 Local API: http://localhost:${PORT}`,
      );

      console.log(
        `🌐 Network API: http://192.168.0.109:${PORT}`,
      );

      console.log(
        `Environment: ${
          process.env.NODE_ENV ||
          "development"
        }`,
      );

      // ─── Start the push notification worker ───────────────
      // Runs two cron jobs every minute:
      //   1. Fires due reminders from scheduled_reminders
      //   2. Delivers undelivered notifications via Expo Push
      startPushWorker();
    },
  );
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log(
    "Shutting down gracefully...",
  );

  await pool.end();

  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log(
    "Shutting down gracefully...",
  );

  await pool.end();

  process.exit(0);
});