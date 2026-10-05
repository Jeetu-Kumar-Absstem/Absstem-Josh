#!/usr/bin/env node
/**
 * Export department workbooks for remaining O2C chain gaps.
 *
 *   node scripts/export-department-o2c-workbooks.js --company=AI
 *   node scripts/export-department-o2c-workbooks.js --company=AI --out-dir=storage
 *
 * Writes three files:
 *   1) {CO}-Accounts-receipt-allocations-YYYY-MM-DD.xlsx   → Accounts
 *   2) {CO}-Sales-invoice-so-map-YYYY-MM-DD.xlsx           → Sales
 *   3) {CO}-Sales-so-lines-YYYY-MM-DD.xlsx                 → Sales / Commercial
 */
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const { resolveCompanyId } = require("../src/services/o2cChainRepair");

function parseArgs(argv) {
  const out = { company: "AI", outDir: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--company=")) out.company = token.slice("--company=".length).trim() || out.company;
    if (token === "--company" && argv[i + 1]) out.company = String(argv[++i]).trim() || out.company;
    if (token.startsWith("--out-dir=")) out.outDir = path.resolve(token.slice("--out-dir=".length));
    if (token === "--out-dir" && argv[i + 1]) out.outDir = path.resolve(argv[++i]);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);

    const stamp = new Date().toISOString().slice(0, 10);
    const outDir = args.outDir || path.resolve(__dirname, "../storage");
    const prefix = path.join(outDir, `${company.company_code}`);

    // --- shared queries ---
    const receipts = await client.query(
      `
        select
          cr.receipt_number, cr.tally_voucher_number, cr.receipt_date,
          cr.receipt_amount_invoice, cr.unallocated_amount_invoice,
          c.customer_code, c.customer_name
        from customer_receipts cr
        left join customers c on c.id = cr.customer_id
        where cr.company_id = $1
          and cr.receipt_status <> 'cancelled'
          and coalesce(cr.unallocated_amount_invoice, 0) > 0.01
        order by cr.receipt_date asc, cr.id asc
      `,
      [company.id]
    );

    const openInvoices = await client.query(
      `
        select
          ci.invoice_number, ci.tally_voucher_number, ci.invoice_date,
          c.customer_code, c.customer_name,
          ci.grand_total_invoice,
          coalesce(ci.paid_amount, 0) as paid_amount,
          coalesce(ci.balance_due, ci.grand_total_invoice) as balance_due,
          so.so_number, ci.job_no, ci.customer_po_number, ci.invoice_status
        from customer_invoices ci
        left join customers c on c.id = ci.customer_id
        left join sales_orders so on so.id = ci.sales_order_id
        where ci.company_id = $1
          and ci.invoice_status not in ('cancelled', 'draft')
          and coalesce(ci.balance_due, ci.grand_total_invoice) > 0.01
        order by c.customer_name asc, ci.invoice_date asc
      `,
      [company.id]
    );

    const unlinkedInvoices = await client.query(
      `
        select
          ci.invoice_number, ci.tally_voucher_number, ci.invoice_date,
          c.customer_code, c.customer_name,
          ci.grand_total_invoice,
          coalesce(ci.balance_due, ci.grand_total_invoice) as balance_due,
          ci.customer_po_number, ci.job_no
        from customer_invoices ci
        left join customers c on c.id = ci.customer_id
        where ci.company_id = $1
          and ci.invoice_status not in ('cancelled', 'draft')
          and ci.sales_order_id is null
        order by ci.invoice_date asc, ci.id asc
      `,
      [company.id]
    );

    const shellSos = await client.query(
      `
        select
          so.so_number, so.order_date, so.order_status,
          c.customer_code, c.customer_name,
          so.customer_po_number, so.customer_po_date, so.job_no,
          so.grand_total_order,
          (select count(*)::int from customer_invoices ci
             where ci.sales_order_id = so.id and ci.invoice_status <> 'cancelled') as invoice_count
        from sales_orders so
        left join customers c on c.id = so.customer_id
        where so.company_id = $1
          and lower(so.order_status) <> 'cancelled'
          and not exists (select 1 from sales_order_lines sol where sol.sales_order_id = so.id)
        order by so.order_date asc nulls last, so.id asc
      `,
      [company.id]
    );

    const soCatalog = await client.query(
      `
        select so.so_number, c.customer_code, c.customer_name, so.job_no, so.customer_po_number,
               so.order_date, so.grand_total_order,
               (select count(*)::int from sales_order_lines sol where sol.sales_order_id = so.id) as line_count
        from sales_orders so
        left join customers c on c.id = so.customer_id
        where so.company_id = $1
          and lower(so.order_status) <> 'cancelled'
        order by so.so_number asc
      `,
      [company.id]
    );

    const products = await client.query(
      `
        select p.item_code, p.item_name, p.hsn_no, p.gst_pct, p.uom
        from products p
        where coalesce(p.is_active, true) = true
        order by p.item_code asc
        limit 5000
      `
    );

    // ========== 1) ACCOUNTS ==========
    const accountsAllocations = receipts.rows.map((r) => ({
      receipt_number: r.receipt_number,
      tally_voucher_number: r.tally_voucher_number || "",
      receipt_date: r.receipt_date ? String(r.receipt_date).slice(0, 10) : "",
      customer_code: r.customer_code || "",
      customer_name: r.customer_name || "",
      receipt_amount: money(r.receipt_amount_invoice),
      unallocated_amount: money(r.unallocated_amount_invoice),
      invoice_number: "",
      allocate_amount: money(r.unallocated_amount_invoice),
      notes: "",
    }));

    const accountsPath = writeBook(`${prefix}-Accounts-receipt-allocations-${stamp}.xlsx`, [
      {
        name: "Instructions",
        aoa: [
          ["Department: Accounts"],
          [`Company: ${company.company_code}`],
          [`Generated: ${new Date().toISOString()}`],
          [],
          ["Fill sheet Allocations: invoice_number + allocate_amount."],
          ["Split a receipt: copy the row and split amounts (sum ≤ unallocated_amount)."],
          ["Leave invoice_number blank to skip."],
          ["Do not rename column headers."],
          [],
          ["Import:"],
          [
            "node scripts/import-accounts-allocation-workbook.js --company=AI --file=... --apply",
          ],
        ],
      },
      { name: "Allocations", rows: accountsAllocations },
      {
        name: "Unallocated_Receipts",
        rows: receipts.rows.map((r) => ({
          receipt_number: r.receipt_number,
          tally_voucher_number: r.tally_voucher_number || "",
          receipt_date: r.receipt_date ? String(r.receipt_date).slice(0, 10) : "",
          customer_code: r.customer_code || "",
          customer_name: r.customer_name || "",
          receipt_amount: money(r.receipt_amount_invoice),
          unallocated_amount: money(r.unallocated_amount_invoice),
        })),
      },
      {
        name: "Open_Invoices",
        rows: openInvoices.rows.map((inv) => ({
          invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : "",
          customer_code: inv.customer_code || "",
          customer_name: inv.customer_name || "",
          grand_total: money(inv.grand_total_invoice),
          paid_amount: money(inv.paid_amount),
          balance_due: money(inv.balance_due),
          so_number: inv.so_number || "",
          job_no: inv.job_no || "",
          customer_po_number: inv.customer_po_number || "",
        })),
      },
    ]);

    // ========== 2) SALES – invoice ↔ SO + header enrich ==========
    const invoiceSoRows = unlinkedInvoices.rows.map((inv) => ({
      invoice_number: inv.invoice_number,
      tally_voucher_number: inv.tally_voucher_number || "",
      invoice_date: inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : "",
      customer_code: inv.customer_code || "",
      customer_name: inv.customer_name || "",
      grand_total: money(inv.grand_total_invoice),
      balance_due: money(inv.balance_due),
      customer_po_number: inv.customer_po_number || "",
      job_no: inv.job_no || "",
      so_number: "",
      notes: "",
    }));

    const soHeaderRows = shellSos.rows.map((so) => ({
      so_number: so.so_number,
      order_date: so.order_date ? String(so.order_date).slice(0, 10) : "",
      customer_code: so.customer_code || "",
      customer_name: so.customer_name || "",
      customer_po_number: so.customer_po_number || "",
      customer_po_date: so.customer_po_date ? String(so.customer_po_date).slice(0, 10) : "",
      job_no: so.job_no || "",
      invoice_count: so.invoice_count,
      notes: "",
    }));

    // Also include ALL SOs with blank job_no for header fill (not only shells)
    const blankJobSos = await client.query(
      `
        select
          so.so_number, so.order_date,
          c.customer_code, c.customer_name,
          so.customer_po_number, so.customer_po_date, so.job_no,
          so.grand_total_order
        from sales_orders so
        left join customers c on c.id = so.customer_id
        where so.company_id = $1
          and lower(so.order_status) <> 'cancelled'
          and (
            coalesce(trim(so.job_no), '') = ''
            or coalesce(trim(so.customer_po_number), '') = ''
          )
        order by so.order_date asc nulls last, so.id asc
      `,
      [company.id]
    );

    const soHeaderFill = blankJobSos.rows.map((so) => ({
      so_number: so.so_number,
      order_date: so.order_date ? String(so.order_date).slice(0, 10) : "",
      customer_code: so.customer_code || "",
      customer_name: so.customer_name || "",
      customer_po_number: so.customer_po_number || "",
      customer_po_date: so.customer_po_date ? String(so.customer_po_date).slice(0, 10) : "",
      job_no: so.job_no || "",
      grand_total_order: money(so.grand_total_order),
      notes: "",
    }));

    const salesMapPath = writeBook(`${prefix}-Sales-invoice-so-map-${stamp}.xlsx`, [
      {
        name: "Instructions",
        aoa: [
          ["Department: Sales"],
          [`Company: ${company.company_code}`],
          [`Generated: ${new Date().toISOString()}`],
          [],
          ["Sheet Invoice_SO_Map: fill so_number for each unlinked invoice."],
          ["Match by customer + PO / job_no where possible. Use SO_Catalog for valid so_numbers."],
          ["Sheet SO_Headers: fill missing job_no and/or customer_po_number / customer_po_date."],
          [],
          ["Import:"],
          [
            "node scripts/import-sales-chain-workbook.js --company=AI --file=... --apply",
          ],
        ],
      },
      { name: "Invoice_SO_Map", rows: invoiceSoRows },
      { name: "SO_Headers", rows: soHeaderFill },
      {
        name: "SO_Catalog",
        rows: soCatalog.rows.map((so) => ({
          so_number: so.so_number,
          customer_code: so.customer_code || "",
          customer_name: so.customer_name || "",
          job_no: so.job_no || "",
          customer_po_number: so.customer_po_number || "",
          order_date: so.order_date ? String(so.order_date).slice(0, 10) : "",
          grand_total_order: money(so.grand_total_order),
          line_count: so.line_count,
        })),
      },
      {
        name: "Shell_SOs_No_Lines",
        rows: soHeaderRows,
      },
    ]);

    // ========== 3) SALES / COMMERCIAL – SO lines ==========
    // One starter blank line row per shell SO (they copy for more lines)
    const soLineStarter = shellSos.rows.map((so) => ({
      so_number: so.so_number,
      customer_code: so.customer_code || "",
      customer_name: so.customer_name || "",
      line_no: 1,
      item_code: "",
      item_name: "",
      line_description: "",
      hsn_no: "",
      qty: 1,
      unit_price: "",
      gst_pct: 18,
      uom: "NOS",
      notes: "",
    }));

    const soLinesPath = writeBook(`${prefix}-Sales-so-lines-${stamp}.xlsx`, [
      {
        name: "Instructions",
        aoa: [
          ["Department: Sales / Commercial"],
          [`Company: ${company.company_code}`],
          [`Generated: ${new Date().toISOString()}`],
          [],
          ["These SOs have no line items (shells). Fill SO_Lines."],
          ["Required: so_number, item_name (or item_code), qty, unit_price."],
          ["Optional: item_code (from Products sheet), hsn_no, gst_pct, uom, line_description."],
          ["Multiple lines: copy the so_number row and set line_no 1,2,3…"],
          ["line_total is calculated on import as qty × unit_price."],
          ["Import only writes lines onto SOs that currently have ZERO lines."],
          [],
          ["Import:"],
          [
            "node scripts/import-sales-so-lines-workbook.js --company=AI --file=... --apply",
          ],
        ],
      },
      { name: "SO_Lines", rows: soLineStarter },
      {
        name: "Shell_SOs",
        rows: shellSos.rows.map((so) => ({
          so_number: so.so_number,
          order_date: so.order_date ? String(so.order_date).slice(0, 10) : "",
          customer_code: so.customer_code || "",
          customer_name: so.customer_name || "",
          customer_po_number: so.customer_po_number || "",
          job_no: so.job_no || "",
          invoice_count: so.invoice_count,
          current_grand_total: money(so.grand_total_order),
        })),
      },
      {
        name: "Products",
        rows: products.rows.map((p) => ({
          item_code: p.item_code || "",
          item_name: p.item_name || "",
          hsn_no: p.hsn_no || "",
          gst_pct: p.gst_pct != null ? Number(p.gst_pct) : "",
          uom: p.uom || "NOS",
        })),
      },
    ]);

    console.log(
      JSON.stringify(
        {
          ok: true,
          company: company.company_code,
          generated: stamp,
          workbooks: [
            {
              department: "Accounts",
              file: accountsPath,
              fill_sheet: "Allocations",
              rows: accountsAllocations.length,
              import: "import-accounts-allocation-workbook.js",
            },
            {
              department: "Sales",
              file: salesMapPath,
              fill_sheets: ["Invoice_SO_Map", "SO_Headers"],
              unlinked_invoices: invoiceSoRows.length,
              so_headers_missing_fields: soHeaderFill.length,
              import: "import-sales-chain-workbook.js",
            },
            {
              department: "Sales / Commercial",
              file: soLinesPath,
              fill_sheet: "SO_Lines",
              shell_sos: shellSos.rows.length,
              import: "import-sales-so-lines-workbook.js",
            },
          ],
        },
        null,
        2
      )
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
