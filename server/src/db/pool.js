const { Pool } = require("pg");

const sslEnabled =
  process.env.DATABASE_SSL === "true" || process.env.PGSSLMODE === "require";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };

