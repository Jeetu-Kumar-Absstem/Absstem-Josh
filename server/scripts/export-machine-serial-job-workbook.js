#!/usr/bin/env node
/**
 * Export / create Absstem machine-serial (job_no) fill workbook.
 *
 * For Absstem: job_no on SO / Invoice = machine serial number.
 *
 * Blank template (no DB):
 *   node scripts/export-machine-serial-job-workbook.js --blank
 *
 * Live gaps from Josh DB:
 *   node scripts/export-machine-serial-job-workbook.js --company=AI
 *   node scripts/export-machine-serial-job-workbook.js --company=AI --out-dir=storage
 *
 * Import filled file:
 *   node scripts/import-sales-chain-workbook.js --company=AI --file=... --apply
 *
 * Column mapping on import:
 *   machine_serial_no  →  sales_orders.job_no / customer_invoices.job_no
 */
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

function parseArgs(argv) {
  const out = {
    company: "AI",
    outDir: path.resolve(__dirname, "../storage"),
    blank: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--blank") out.blank = true;
    else if (token.startsWith("--company=")) out.company = token.slice("--company=".length);
    else if (token === "--company" && argv[i + 1]) out.company = argv[++i];
    else if (token.startsWith("--out-dir=")) out.outDir = path.resolve(token.slice("--out-dir=".length));
    else if (token === "--out-dir" && argv[i + 1]) out.outDir = path.resolve(argv[++i]);
  }
  return out;
}

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function writeBook(outPath, sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, rows, aoa } of sheets) {
    const ws = aoa ? XLSX.utils.aoa_to_sheet(aoa) : XLSX.utils.json_to_sheet(rows || []);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  XLSX.writeFile(wb, outPath);
  return outPath;
}

function instructionsAoa(companyCode) {
  return [
    ["Absstem — Machine Serial = Job No fill workbook"],
    [`Company: ${companyCode || "AI"}`],
    [`Generated: ${new Date().toISOString()}`],
    [],
    ["RULE"],
    ["For Absstem Industrial, Josh job_no means the machine serial number."],
    ["Fill column machine_serial_no. On import it is stored as job_no on SO and Invoice."],
    ["If one SO has multiple machines, put serials comma-separated: N047,N048"],
    [],
    ["SHEETS"],
    ["SO_Machine_Serials — Sales Orders missing machine serial. Fill machine_serial_no."],
    ["Invoice_Machine_Serials — Invoices missing serial (optional; usually inherits from SO)."],
    ["Examples — sample rows showing format."],
    [],
    ["DO NOT CHANGE"],
    ["so_number / invoice_number — used as match keys."],
    [],
    ["IMPORT (after fill)"],
    ["1) Keep sheet names SO_Headers and Invoice_SO_Map if using the standard importer,"],
    ["   OR use this workbook with import-machine-serial-job-workbook.js"],
    ["2) Preferred: copy machine_serial_no into job_no column (see Converted sheets)"],
    ["3) node scripts/import-sales-chain-workbook.js --company=AI --file=THIS_FILE --apply"],
    [],
    ["Also creates Job Assets later: job_id + serial_no can both equal the same machine serial."],
  ];
}

function blankTemplate(outDir, company) {
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(outDir, `${company}-Machine-Serial-JobNo-TEMPLATE-${stamp}.xlsx`);
  return writeBook(outPath, [
    { name: "Instructions", aoa: instructionsAoa(company) },
    {
      name: "SO_Machine_Serials",
      rows: [
        {
          so_number: "SO/25-26/001",
          order_date: "2025-04-01",
          customer_code: "CUST-XXXX",
          customer_name: "Example Customer Pvt Ltd",
          customer_po_number: "PO-123",
          customer_po_date: "2025-03-15",
          machine_serial_no: "",
          job_no: "",
          notes: "Fill machine_serial_no (same value can be copied to job_no)",
        },
      ],
    },
    {
      name: "Invoice_Machine_Serials",
      rows: [
        {
          invoice_number: "INV/25-26/001",
          invoice_date: "2025-05-01",
          so_number: "SO/25-26/001",
          customer_code: "CUST-XXXX",
          customer_name: "Example Customer Pvt Ltd",
          machine_serial_no: "",
          job_no: "",
          notes: "Optional if SO already has serial",
        },
      ],
    },
    {
      name: "Examples",
      rows: [
        {
          so_number: "SO/24-25/016",
          machine_serial_no: "N047",
          meaning: "Single machine on this SO",
        },
        {
          so_number: "SO/24-25/020",
          machine_serial_no: "N051,N052",
          meaning: "Two machines on one SO — comma-separated",
        },
      ],
    },
    {
      name: "SO_Headers",
      rows: [
        {
          so_number: "SO/25-26/001",
          job_no: "",
          customer_po_number: "",
          customer_po_date: "",
          notes: "Import sheet — put machine serial in job_no",
        },
      ],
    },
  ]);
}

async function liveExport(args) {
  const { pool } = require("../src/db/pool");
  const { resolveCompanyId } = require("../src/services/o2cChainRepair");
  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);
    const stamp = new Date().toISOString().slice(0, 10);

    const soRes = await client.query(
      `
        select
          so.so_number,
          so.order_date,
          c.customer_code,
          c.customer_name,
          so.customer_po_number,
          so.customer_po_date,
          so.job_no,
          so.grand_total_order,
          so.order_status
        from sales_orders so
        left join customers c on c.id = so.customer_id
        where so.company_id = $1
          and lower(coalesce(so.order_status, '')) not in ('cancelled', 'void')
          and coalesce(trim(so.job_no), '') = ''
        order by so.order_date desc nulls last, so.id desc
      `,
      [company.id]
    );

    const invRes = await client.query(
      `
        select
          ci.invoice_number,
          ci.invoice_date,
          so.so_number,
          c.customer_code,
          c.customer_name,
          ci.customer_po_number,
          ci.job_no as invoice_job_no,
          so.job_no as so_job_no,
          coalesce(nullif(ci.grand_total_invoice, 0), ci.grand_total_base, 0) as grand_total
        from customer_invoices ci
        left join customers c on c.id = ci.customer_id
        left join sales_orders so on so.id = ci.sales_order_id
        where ci.company_id = $1
          and lower(coalesce(ci.invoice_status, '')) not in ('cancelled', 'draft', 'void')
          and coalesce(trim(ci.job_no), '') = ''
        order by ci.invoice_date desc nulls last, ci.id desc
      `,
      [company.id]
    );

    const soRows = soRes.rows.map((so) => ({
      so_number: so.so_number,
      order_date: so.order_date ? String(so.order_date).slice(0, 10) : "",
      customer_code: so.customer_code || "",
      customer_name: so.customer_name || "",
      customer_po_number: so.customer_po_number || "",
      customer_po_date: so.customer_po_date ? String(so.customer_po_date).slice(0, 10) : "",
      machine_serial_no: "",
      job_no: so.job_no || "",
      order_status: so.order_status || "",
      grand_total_order: money(so.grand_total_order),
      notes: "",
    }));

    const invRows = invRes.rows.map((inv) => ({
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : "",
      so_number: inv.so_number || "",
      customer_code: inv.customer_code || "",
      customer_name: inv.customer_name || "",
      customer_po_number: inv.customer_po_number || "",
      machine_serial_no: "",
      job_no: inv.invoice_job_no || inv.so_job_no || "",
      so_job_no: inv.so_job_no || "",
      grand_total: money(inv.grand_total),
      notes: "",
    }));

    // Import-ready sheet: importer reads SO_Headers.job_no
    const soHeaders = soRows.map((r) => ({
      so_number: r.so_number,
      job_no: r.machine_serial_no || r.job_no || "",
      customer_po_number: r.customer_po_number,
      customer_po_date: r.customer_po_date,
      notes: "After fill: copy machine_serial_no → job_no on SO_Machine_Serials, or fill job_no here",
    }));

    const outPath = path.join(
      args.outDir,
      `${company.company_code}-Machine-Serial-JobNo-${stamp}.xlsx`
    );
    writeBook(outPath, [
      { name: "Instructions", aoa: instructionsAoa(company.company_code) },
      { name: "SO_Machine_Serials", rows: soRows },
      { name: "Invoice_Machine_Serials", rows: invRows },
      { name: "SO_Headers", rows: soHeaders },
      {
        name: "Examples",
        rows: [
          { so_number: "…", machine_serial_no: "N047", meaning: "One machine" },
          { so_number: "…", machine_serial_no: "N051,N052", meaning: "Multi-machine SO" },
        ],
      },
    ]);
    return {
      outPath,
      so_missing_serial: soRows.length,
      invoice_missing_serial: invRows.length,
      company: company.company_code,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.outDir, { recursive: true });
  if (args.blank) {
    const outPath = blankTemplate(args.outDir, args.company);
    console.log(JSON.stringify({ ok: true, mode: "blank", file: outPath }, null, 2));
    return;
  }
  const result = await liveExport(args);
  console.log(JSON.stringify({ ok: true, mode: "live", ...result }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
