/**
 * Apply migration 190 (Tally INV + Clan QUOTE numbering) against local Postgres.
 * Usage: node scripts/apply-190-numbering.js
 * Requires DATABASE_URL in server/.env.local or environment.
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

function loadEnvLocal() {
  const p = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL missing");
    process.exit(1);
  }
  const sqlPath = path.join(
    __dirname,
    "..",
    "db",
    "migrations",
    "190_tally_inv_clan_quote_numbering_v1.sql"
  );
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("commit");
    console.log("Applied 190_tally_inv_clan_quote_numbering_v1.sql");

    await client.query("begin");
    const co = await client.query(
      `select id, company_code from companies where upper(company_code) in ('AI','AT') order by company_code`
    );
    for (const row of co.rows) {
      const inv = await client.query(`select next_company_document_number($1,'INV') as n`, [row.id]);
      const q = await client.query(`select next_company_document_number($1,'QUOTE') as n`, [row.id]);
      const so = await client.query(`select next_company_document_number($1,'SO') as n`, [row.id]);
      console.log("sample next (rolled back)", row.company_code, {
        inv: inv.rows[0].n,
        quote: q.rows[0].n,
        so: so.rows[0].n,
      });
    }
    await client.query("rollback");
  } catch (err) {
    try {
      await client.query("rollback");
    } catch (_) {}
    console.error(err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
