/**
 * Import a Clan CustomerMaster export (.xlsx) into one company (default AI).
 *
 * Policy:
 *  - New customer codes are inserted and linked to the company ("owned").
 *  - Existing codes: only empty fields are filled; names and Josh edits are never overwritten.
 *  - Every code in the file is linked to the company. Customers that already have documents
 *    in another company keep (or get) a "shared" link there so they don't disappear from it.
 *  - Known test rows are skipped entirely.
 *  - Name/GSTIN duplicates are imported and written to a review CSV for Duplicate Watch / merge.
 *
 * Dry run by default (runs in a transaction and rolls back). Add --apply to commit.
 *
 *   node scripts/import-clan-customers.js ../CustomerMaster_AI_28-Sep-2026.xlsx --company=AI
 *   node scripts/import-clan-customers.js ../CustomerMaster_AI_28-Sep-2026.xlsx --company=AI --apply
 *
 * Only local Postgres is allowed unless --allow-host=<host> names the DATABASE_URL host.
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "../.env");
const localEnvPath = path.join(__dirname, "../.env.local");
require("dotenv").config({ path: envPath });
if (fs.existsSync(localEnvPath)) {
  require("dotenv").config({ path: envPath, override: true });
  require("dotenv").config({ path: localEnvPath, override: true });
}

const XLSX = require("xlsx");
const { Pool } = require("pg");

const SKIP_TEST_CODES = new Set([
  "C11274", // ABCD Test
  "C12146", // ABCD Test
  "C12231", // ABCD Test
  "C12687", // xyz
  "C12236", // sds
  "C12114", // TEST COMPANY
  "C11757", // xyz test
  "C11403", // usama test
  "C11289", // abc test
  "C11290", // test 1
  "C11300", // test 1234
  "C11465", // abc
  "C11649", // XYX
  "C11749", // sda
]);

function parseArgs(argv) {
  const args = { file: null, company: "AI", apply: false, allowHost: null, report: null };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--company=")) args.company = a.slice(10).trim();
    else if (a.startsWith("--allow-host=")) args.allowHost = a.slice(13).trim();
    else if (a.startsWith("--report=")) args.report = a.slice(9).trim();
    else if (!a.startsWith("--")) args.file = a;
  }
  return args;
}

function assertSafeHost(connectionString, allowHost) {
  let host = "";
  try {
    host = new URL(connectionString).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new Error("DATABASE_URL is missing or invalid.");
  }
  const local = ["127.0.0.1", "localhost", "::1"];
  if (local.includes(host)) return host;
  if (allowHost && allowHost === host) return host;
  throw new Error(`Refusing to run against DATABASE_URL host "${host}". Pass --allow-host=${host} to confirm.`);
}

const text = (v) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s || null;
};
const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(m\/s|ms|mr|mrs|dr)\.?\s+/g, " ")
    .replace(/\b(private|pvt|limited|ltd|llp|co|company|the)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const normGstin = (s) => {
  const g = String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return g.length === 15 ? g : null;
};
const normPan = (s) => {
  const p = String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p) ? p : null;
};
const normEmail = (s) => {
  const e = String(s || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

function mapRow(r) {
  return {
    code: text(r.CustomerCode),
    name: text(r.CustomerName),
    address_line1: text(r.AddressLine1),
    address_line2: text(r.AddressLine2),
    city: text(r.CityName),
    state: text(r.StateName),
    pincode: text(r.PinCode),
    phone: text(r.PhoneNo),
    fax: text(r.Fax),
    email: normEmail(r["Email ID"]),
    website: text(r.Website),
    tinno: text(r.TINNO),
    gstin: normGstin(r["GST IN"]),
    pan: normPan(r.PAN),
    customer_type: text(r["Customer Type"]),
    account_manager: text(r.AccountManager),
    in_case_of_hospital: /^y/i.test(String(r.InCaseofHospital || "").trim()),
    is_active: /^y/i.test(String(r.Active || "").trim()),
  };
}

const FILL_FIELDS = [
  "address_line1",
  "address_line2",
  "city",
  "state",
  "pincode",
  "phone",
  "fax",
  "email",
  "website",
  "tinno",
  "gstin",
  "pan",
  "customer_type",
  "account_manager",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) throw new Error("Usage: node scripts/import-clan-customers.js <CustomerMaster.xlsx> [--company=AI] [--apply]");
  const filePath = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const host = assertSafeHost(process.env.DATABASE_URL, args.allowHost);

  const wb = XLSX.readFile(filePath);
  const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  const rows = rawRows.map(mapRow);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" || process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
  });
  const client = await pool.connect();
  const stats = {
    rows: rows.length,
    skipped_blank: 0,
    skipped_test: 0,
    skipped_duplicate_code_in_file: 0,
    inserted: 0,
    existing: 0,
    existing_filled: 0,
    fields_filled: 0,
    company_id_set: 0,
    links_added: 0,
    shared_links_added_other_company: 0,
    new_inactive: 0,
    filled_by_field: {},
  };
  const review = [];

  try {
    const company = (
      await client.query(`select id, company_code from companies where upper(company_code) = upper($1) or id::text = $1`, [args.company])
    ).rows[0];
    if (!company) throw new Error(`Company "${args.company}" not found.`);

    await client.query("begin");

    const existingRes = await client.query(`select * from customers where customer_code = any($1::text[])`, [
      rows.map((r) => r.code).filter(Boolean),
    ]);
    const existingByCode = new Map(existingRes.rows.map((c) => [c.customer_code, c]));

    const allDb = (await client.query(`select id, customer_code, customer_name, gstin from customers where merged_into_customer_id is null`)).rows;
    const dbByName = new Map();
    const dbByGstin = new Map();
    for (const c of allDb) {
      const n = normName(c.customer_name);
      if (n && !dbByName.has(n)) dbByName.set(n, c);
      const g = normGstin(c.gstin);
      if (g && !dbByGstin.has(g)) dbByGstin.set(g, c);
    }

    const seen = new Set();
    const touchedIds = [];
    for (const r of rows) {
      if (!r.code || !r.name) {
        stats.skipped_blank += 1;
        continue;
      }
      if (SKIP_TEST_CODES.has(r.code)) {
        stats.skipped_test += 1;
        continue;
      }
      if (seen.has(r.code)) {
        stats.skipped_duplicate_code_in_file += 1;
        continue;
      }
      seen.add(r.code);

      const existing = existingByCode.get(r.code);
      if (!existing) {
        const nameHit = dbByName.get(normName(r.name));
        const gstHit = r.gstin ? dbByGstin.get(r.gstin) : null;
        const ins = await client.query(
          `
            insert into customers (
              customer_code, customer_name, address_line1, address_line2, city, state, pincode,
              phone, fax, email, website, tinno, gstin, pan, customer_type, account_manager,
              in_case_of_hospital, is_active, company_id, updated_at
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
            returning id
          `,
          [
            r.code, r.name, r.address_line1, r.address_line2, r.city, r.state, r.pincode,
            r.phone, r.fax, r.email, r.website, r.tinno, r.gstin, r.pan, r.customer_type, r.account_manager,
            r.in_case_of_hospital, r.is_active, company.id,
          ]
        );
        const id = ins.rows[0].id;
        touchedIds.push(id);
        stats.inserted += 1;
        if (!r.is_active) stats.new_inactive += 1;
        if (gstHit) review.push({ reason: "new code, GSTIN already in Josh", code: r.code, name: r.name, match_code: gstHit.customer_code, match_name: gstHit.customer_name });
        else if (nameHit) review.push({ reason: "new code, same name already in Josh", code: r.code, name: r.name, match_code: nameHit.customer_code, match_name: nameHit.customer_name });
        const n = normName(r.name);
        if (n && !dbByName.has(n)) dbByName.set(n, { id, customer_code: r.code, customer_name: r.name });
        if (r.gstin && !dbByGstin.has(r.gstin)) dbByGstin.set(r.gstin, { id, customer_code: r.code, customer_name: r.name });
        continue;
      }

      stats.existing += 1;
      touchedIds.push(existing.id);
      if (normName(existing.customer_name) !== normName(r.name)) {
        review.push({ reason: "name differs (Josh name kept)", code: r.code, name: r.name, match_code: existing.customer_code, match_name: existing.customer_name });
      }
      const sets = [];
      const vals = [];
      for (const f of FILL_FIELDS) {
        const cur = existing[f];
        const blank = cur === null || cur === undefined || String(cur).trim() === "";
        if (blank && r[f]) {
          vals.push(r[f]);
          sets.push(`${f} = $${vals.length}`);
          stats.filled_by_field[f] = (stats.filled_by_field[f] || 0) + 1;
        }
      }
      if (!existing.in_case_of_hospital && r.in_case_of_hospital) sets.push("in_case_of_hospital = true");
      if (existing.company_id === null || existing.company_id === undefined) {
        vals.push(company.id);
        sets.push(`company_id = $${vals.length}`);
        stats.company_id_set += 1;
      }
      if (sets.length) {
        vals.push(existing.id);
        await client.query(`update customers set ${sets.join(", ")}, updated_at = now() where id = $${vals.length}`, vals);
        const filled = sets.filter((s) => !s.startsWith("company_id")).length;
        if (filled) {
          stats.existing_filled += 1;
          stats.fields_filled += filled;
        }
      }
    }

    const linkRes = await client.query(
      `
        insert into customer_company_links (customer_id, company_id, ownership_type, is_active, updated_at)
        select unnest($1::int[]), $2, 'owned', true, now()
        on conflict (customer_id, company_id) do update
          set is_active = true, updated_at = now()
          where customer_company_links.is_active = false
        returning (xmax = 0) as inserted
      `,
      [touchedIds, company.id]
    );
    stats.links_added = linkRes.rows.filter((r) => r.inserted).length;

    const sharedRes = await client.query(
      `
        with docs as (
          select customer_id, company_id from quote_headers where customer_id = any($1::int[]) and company_id is not null
          union select customer_id, company_id from sales_orders where customer_id = any($1::int[]) and company_id is not null
          union select customer_id, company_id from customer_invoices where customer_id = any($1::int[]) and company_id is not null
        )
        insert into customer_company_links (customer_id, company_id, ownership_type, is_active, updated_at)
        select distinct d.customer_id, d.company_id, 'shared', true, now()
        from docs d
        where d.company_id <> $2
        on conflict (customer_id, company_id) do nothing
        returning id
      `,
      [touchedIds, company.id]
    );
    stats.shared_links_added_other_company = sharedRes.rowCount;

    const byName = new Map();
    for (const r of rows) {
      if (!r.code || !r.name || SKIP_TEST_CODES.has(r.code)) continue;
      const n = normName(r.name);
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(r);
    }
    for (const [, group] of byName) {
      if (group.length < 2) continue;
      const [first, ...rest] = group;
      for (const r of rest) {
        review.push({ reason: "same name on multiple Clan codes (possible sites)", code: r.code, name: r.name, match_code: first.code, match_name: first.name });
      }
    }

    if (args.apply) await client.query("commit");
    else await client.query("rollback");

    const reportPath =
      args.report || path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.duplicate-review.csv`);
    const header = ["reason", "code", "name", "match_code", "match_name"];
    fs.writeFileSync(reportPath, [header.join(","), ...review.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n"));

    console.log(JSON.stringify({ mode: args.apply ? "APPLIED" : "DRY RUN (rolled back)", host, company: company.company_code, ...stats, review_rows: review.length, review_csv: reportPath }, null, 2));
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("IMPORT FAILED:", err.message);
  process.exit(1);
});
