const { Pool, types } = require("pg");

// ---------------------------------------------------------------
// Type parsers
//
// pg's default parser converts a Postgres DATE (OID 1082) into a
// JavaScript Date at LOCAL midnight. When that Date is then sent
// through res.json(), toISOString() renders it in UTC — which rolls
// the calendar day back by one for any positive UTC offset (e.g.
// IST = UTC+05:30). Return the raw string instead so the exact
// value Postgres stored reaches the client untouched.
//
// Must be registered BEFORE the Pool is created.
// ---------------------------------------------------------------
types.setTypeParser(1082, (val) => val);   // DATE          → "YYYY-MM-DD"
types.setTypeParser(1114, (val) => val);   // TIMESTAMP     → "YYYY-MM-DD HH:MM:SS"

// ---------------------------------------------------------------
// Validate environment configuration
// ---------------------------------------------------------------
if (process.env.DATABASE_URL) {
  console.log("ℹ️  Using DATABASE_URL for PostgreSQL connection");
} else {
  if (!process.env.DB_HOST) {
    console.error("❌ DB_HOST is not defined in .env");
  }
  if (!process.env.DB_USER) {
    console.error("❌ DB_USER is not defined in .env");
  }
  if (!process.env.DB_PASSWORD) {
    console.error("❌ DB_PASSWORD is not defined in .env");
  }
  if (!process.env.DB_NAME) {
    console.error("❌ DB_NAME is not defined in .env");
  }
}

// ---------------------------------------------------------------
// Build pool config — prefer DATABASE_URL, fall back to fields
// ---------------------------------------------------------------
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
    }
  : {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl:
        process.env.DB_SSL === "true"
          ? { rejectUnauthorized: false }
          : false,
      max: 20,
    };

const pool = new Pool(poolConfig);

pool.on("connect", () => {
  console.log("✅ PostgreSQL connected");
});

pool.on("error", (error) => {
  console.error("❌ Unexpected PostgreSQL error:", error);
});

// ---------------------------------------------------------------
// Startup connectivity test
// ---------------------------------------------------------------
const testDatabaseConnection = async () => {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log(
      "✅ Database connection successful:",
      result.rows[0].now,
    );
    return true;
  } catch (error) {
    console.error("❌ Error connecting to database:", error);
    return false;
  }
};

module.exports = {
  pool,
  testDatabaseConnection,
};