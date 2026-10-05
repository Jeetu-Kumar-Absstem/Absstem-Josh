#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const {
  importLegacySalesOrdersFromFile,
  resolveCompanyId,
} = require("../src/services/legacySalesOrderImport");

function parseArgs(argv) {
  const out = {
    file: path.resolve(__dirname, "../../SalesOrderReport_02-Sep-2026.xlsx"),
    company: "AI",
    apply: false,
    updateExisting: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      out.apply = true;
      continue;
    }
    if (token === "--no-update") {
      out.updateExisting = false;
      continue;
    }
    if (token.startsWith("--file=")) {
      out.file = path.resolve(token.slice("--file=".length));
      continue;
    }
    if (token === "--file" && argv[i + 1]) {
      out.file = path.resolve(argv[++i]);
      continue;
    }
    if (token.startsWith("--company=")) {
      out.company = token.slice("--company=".length).trim() || out.company;
      continue;
    }
    if (token === "--company" && argv[i + 1]) {
      out.company = argv[++i].trim() || out.company;
    }
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.file)) {
    console.error(`File not found: ${args.file}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(args.file);
  if (!args.apply) {
    const { parseSalesOrderReportRows } = require("../src/services/legacySalesOrderImport");
    const rows = parseSalesOrderReportRows(buffer, path.basename(args.file));
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          company: args.company,
          file: args.file,
          rows_parsed: rows.length,
          with_job_no: rows.filter((row) => row.job_no).length,
          sample: rows.slice(0, 5).map((row) => ({
            so_number: row.so_number,
            customer: row.customer_name,
            customer_code: row.customer_code,
            job_no: row.job_no,
            status: row.order_status,
          })),
        },
        null,
        2
      )
    );
    console.log("\nRe-run with --apply to import.");
    return;
  }

  const client = await pool.connect();
  try {
    const companyId = await resolveCompanyId(client, args.company);
    if (!companyId) {
      console.error(`Company not found: ${args.company}`);
      process.exit(1);
    }

    await client.query("begin");
    const summary = await importLegacySalesOrdersFromFile(client, {
      companyId,
      fileBuffer: buffer,
      fileName: path.basename(args.file),
      userId: null,
      updateExisting: args.updateExisting,
    });
    await client.query("commit");
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failed > 0) {
      const failures = summary.results.filter((row) => !row.ok).slice(0, 20);
      console.error(`Import completed with ${summary.failed} failed row(s):`);
      console.error(JSON.stringify(failures, null, 2));
      process.exit(1);
    }
  } catch (err) {
    try {
      await client.query("rollback");
    } catch (_rollbackErr) {
      /* ignore */
    }
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
