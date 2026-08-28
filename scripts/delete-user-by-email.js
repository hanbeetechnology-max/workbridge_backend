import "dotenv/config";
import { query } from "../src/db/client.js";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/delete-user-by-email.js someone@example.com");
  process.exit(1);
}

const { rowCount } = await query(`DELETE FROM users WHERE email = $1`, [email]);
console.log(rowCount > 0 ? `Deleted ${rowCount} account(s) with email ${email}.` : `No account found with email ${email}.`);
process.exit(0);
