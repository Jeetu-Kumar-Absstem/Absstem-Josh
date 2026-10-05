#!/usr/bin/env node
/**
 * Import machine serial fill workbook into Josh job_no fields.
 *
 * Reads SO_Machine_Serials (machine_serial_no → job_no) and/or SO_Headers.job_no
 * Optionally Invoice_Machine_Serials.
 *
 *   node scripts/import-machine-serial-job-workbook.js --company=AI --file=...xlsx --apply
 */
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const { resolveCompanyId } = require("../src/services/o2cChainRepair");

function parseArgs(argv) {
  const out = { company: "AI", file: null, apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    else if (token === "--dry-run") out.apply = false;
    else if (token.startsWith("--company=")) out.company = token.slice("--company=".length);
    else if (token === "--company" && argv[i + 1]) out.company = argv[++i];
    else if (token.startsWith("--file=")) out.file = path.resolve(token.slice("--file=".length));
    else if (token === "--file" && argv[i + 1]) out.file = path.resolve(argv[++i]);
  }
  return out;
}

function clean(v) {
  const s = String(v == null ? "" : v).trim();
  return s || null;
}

function sheetRows(wb, name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file || !fs.existsSync(args.file)) {
    throw new Error(`File not found: ${args.file}`);
  }
  const wb = XLSX.readFile(args.file);
  const soMachine = sheetRows(wb, "SO_Machine_Serials");
  const soHeaders = sheetRows(wb, "SO_Headers");
  const invMachine = sheetRows(wb, "Invoice_Machine_Serials");

  const soUpdates = [];
  for (const row of soMachine) {
    const soNumber = clean(row.so_number);
    const serial = clean(row.machine_serial_no) || clean(row.job_no);
    if (!soNumber || !serial) continue;
    soUpdates.push({
      so_number: soNumber,
      job_no: serial,
      customer_po_number: clean(row.customer_po_number),
      customer_po_date: clean(row.customer_po_date),
    });
  }
  for (const row of soHeaders) {
    const soNumber = clean(row.so_number);
    const serial = clean(row.job_no) || clean(row.machine_serial_no);
    if (!soNumber || !serial) continue;
    if (soUpdates.some((u) => u.so_number === soNumber)) continue;
    soUpdates.push({
      so_number: soNumber,
      job_no: serial,
      customer_po_number: clean(row.customer_po_number),
      customer_po_date: clean(row.customer_po_date),
    });
  }

  const invUpdates = [];
  for (const row of invMachine) {
    const invNumber = clean(row.invoice_number);
    const serial = clean(row.machine_serial_no) || clean(row.job_no);
    if (!invNumber || !serial) continue;
    invUpdates.push({ invoice_number: invNumber, job_no: serial });
  }

  const summary = {
    file: args.file,
    apply: args.apply,
    so_updates: soUpdates.length,
    invoice_updates: invUpdates.length,
    sample_so: soUpdates.slice(0, 5),
    sample_inv: invUpdates.slice(0, 5),
  };

  if (!args.apply) {
    console.log(JSON.stringify({ ...summary, mode: "dry-run" }, null, 2));
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);
    await client.query("begin");
    let soUpdated = 0;
    let invUpdated = 0;
    for (const row of soUpdates) {
      const r = await client.query(
        `
          update sales_orders
          set
            job_no = $2,
            customer_po_number = coalesce($3, customer_po_number),
            customer_po_date = coalesce($4::date, customer_po_date),
            updated_at = now()
          where company_id = $1 and so_number = $5
          returning id
        `,
        [company.id, row.job_no, row.customer_po_number, row.customer_po_date, row.so_number]
      );
      if (r.rowCount) {
        soUpdated += 1;
        await client.query(
          `
            update customer_invoices
            set job_no = coalesce(job_no, $2), updated_at = now()
            where company_id = $1 and sales_order_id = $3 and coalesce(trim(job_no), '') = ''
          `,
          [company.id, row.job_no, r.rows[0].id]
        );
      }
    }
    for (const row of invUpdates) {
      const r = await client.query(
        `
          update customer_invoices
          set job_no = $2, updated_at = now()
          where company_id = $1 and invoice_number = $3
          returning id, sales_order_id
        `,
        [company.id, row.job_no, row.invoice_number]
      );
      if (r.rowCount) {
        invUpdated += 1;
        if (r.rows[0].sales_order_id) {
          await client.query(
            `
              update sales_orders
              set job_no = coalesce(job_no, $2), updated_at = now()
              where id = $1 and coalesce(trim(job_no), '') = ''
            `,
            [r.rows[0].sales_order_id, row.job_no]
          );
        }
      }
    }
    await client.query("commit");
    console.log(JSON.stringify({ ...summary, so_updated: soUpdated, invoices_updated: invUpdated }, null, 2));
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
