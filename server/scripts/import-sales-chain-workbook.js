#!/usr/bin/env node
/**
 * Import Sales workbook: Invoice_SO_Map + SO_Headers.
 *
 *   node scripts/import-sales-chain-workbook.js --company=AI --file=storage/filled.xlsx
 *   node scripts/import-sales-chain-workbook.js --company=AI --file=storage/filled.xlsx --apply
 */
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const { resolveCompanyId } = require("../src/services/o2cChainRepair");
const { linkInvoicesToSalesOrders } = require("../src/services/tallyInvoiceEnrichment");

function parseArgs(argv) {
  const out = { apply: false, company: "AI", file: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    if (token.startsWith("--company=")) out.company = token.slice("--company=".length).trim() || out.company;
    if (token === "--company" && argv[i + 1]) out.company = String(argv[++i]).trim() || out.company;
    if (token.startsWith("--file=")) out.file = path.resolve(token.slice("--file=".length));
    if (token === "--file" && argv[i + 1]) out.file = path.resolve(argv[++i]);
  }
  return out;
}

function clean(v) {
  return String(v ?? "").trim();
}

function sheetRows(wb, name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function excelDateToIso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    // Excel serial date
    const utc = Math.round((v - 25569) * 86400 * 1000);
    return new Date(utc).toISOString().slice(0, 10);
  }
  const s = clean(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || !fs.existsSync(args.file)) {
    console.error("Usage: node scripts/import-sales-chain-workbook.js --company=AI --file=... [--apply]");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const wb = XLSX.readFile(args.file);
  const soMapRows = sheetRows(wb, "Invoice_SO_Map")
    .map((row) => ({
      invoice_number: clean(row.invoice_number),
      so_number: clean(row.so_number),
      job_no: clean(row.job_no) || null,
      customer_po_number: clean(row.customer_po_number) || null,
      customer_po_date: null,
    }))
    .filter((r) => r.invoice_number && r.so_number);

  const headerRows = sheetRows(wb, "SO_Headers")
    .map((row) => ({
      so_number: clean(row.so_number),
      job_no: clean(row.job_no) || null,
      customer_po_number: clean(row.customer_po_number) || null,
      customer_po_date: excelDateToIso(row.customer_po_date),
      notes: clean(row.notes) || null,
    }))
    .filter(
      (r) =>
        r.so_number &&
        (r.job_no || r.customer_po_number || r.customer_po_date)
    );

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "APPLY" : "DRY_RUN",
        company: args.company,
        file: args.file,
        invoice_so_links: soMapRows.length,
        so_header_updates: headerRows.length,
        sample_links: soMapRows.slice(0, 15),
        sample_headers: headerRows.slice(0, 15),
      },
      null,
      2
    )
  );

  if (!args.apply) {
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);

    await client.query("begin");

    let soLinkResult = [];
    if (soMapRows.length) {
      soLinkResult = await linkInvoicesToSalesOrders(client, {
        companyId: company.id,
        rows: soMapRows,
      });
    }

    const headerResults = [];
    for (const row of headerRows) {
      const existing = await client.query(
        `
          select id, so_number, job_no, customer_po_number, customer_po_date
          from sales_orders
          where company_id = $1 and lower(trim(so_number)) = lower(trim($2))
          limit 1
        `,
        [company.id, row.so_number]
      );
      const so = existing.rows[0];
      if (!so) {
        headerResults.push({ ok: false, reason: "SO_NOT_FOUND", ...row });
        continue;
      }
      await client.query(
        `
          update sales_orders
          set
            job_no = coalesce($2, job_no),
            customer_po_number = coalesce($3, customer_po_number),
            customer_po_date = coalesce($4::date, customer_po_date),
            updated_at = now()
          where id = $1
        `,
        [so.id, row.job_no, row.customer_po_number, row.customer_po_date]
      );
      headerResults.push({ ok: true, so_number: so.so_number });
    }

    await client.query("commit");
    console.log(
      JSON.stringify(
        {
          ok: true,
          so_links_ok: soLinkResult.filter((r) => r.ok).length,
          so_links_failed: soLinkResult.filter((r) => !r.ok).length,
          so_headers_ok: headerResults.filter((r) => r.ok).length,
          so_headers_failed: headerResults.filter((r) => !r.ok).length,
          link_failures: soLinkResult.filter((r) => !r.ok).slice(0, 40),
          header_failures: headerResults.filter((r) => !r.ok).slice(0, 40),
        },
        null,
        2
      )
    );
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
