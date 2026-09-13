require("dotenv").config();

const fs = require("fs");
const path = require("path");
const pool = require("../src/config/database");

async function migrate() {
  const client = await pool.connect();

  try {
    console.log("🔄 Running database migrations...");

    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const migrationsDir = path.join(__dirname, "..", "migrations");

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const result = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file]
      );

      if (result.rows.length > 0) {
        console.log(`⏭️ Skipping ${file}`);
        continue;
      }

      console.log(`▶️ Running ${file}`);

      const sql = fs.readFileSync(
        path.join(migrationsDir, file),
        "utf8"
      );

      await client.query(sql);

      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file]
      );

      console.log(`✅ Completed ${file}`);
    }

    await client.query("COMMIT");

    console.log("🎉 Database migrations completed successfully!");
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("❌ Migration failed:", error.message);

    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();