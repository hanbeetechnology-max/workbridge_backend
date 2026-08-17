import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required to run this migration.");
  process.exit(1);
}

const dbHost = new URL(databaseUrl).hostname;
const isLocalDb = dbHost === "localhost" || dbHost === "127.0.0.1" || !dbHost.includes(".");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

try {
  const migrationPath = path.resolve(__dirname, "../migrations/037_flat_platform_fee.sql");
  const sql = readFileSync(migrationPath, "utf8");

  console.log(`Applying migrations/037_flat_platform_fee.sql to ${dbHost}...`);
  await pool.query(sql);
  console.log("Migration applied successfully — platform fee is now a flat 15% (projects.platform_fee_pct default), gamification_config.platform_fee_pct dropped.");
} catch (err) {
  console.error("Migration failed:");
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
