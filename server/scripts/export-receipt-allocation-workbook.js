#!/usr/bin/env node
/**
 * Export an Accounts workbook for receipt → invoice allocation (and optional invoice → SO map).
 *
 *   node scripts/export-receipt-allocation-workbook.js --company=AI
 *   node scripts/export-receipt-allocation-workbook.js --company=AI --out=storage/AI-receipt-allocations.xlsx
 *
 * Sheets:
 *   1) Instructions
 *   2) Allocations          ← Accounts fills invoice_number + allocate_amount
 *   3) Unallocated_Receipts ← reference
 *   4) Open_Invoices        ← reference
 *   5) Invoice_SO_Map       ← optional: fill so_number for unlinked invoices
 */
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const { resolveCompanyId } = require("../src/services/o2cChainRepair");

function parseArgs(argv) {
  const out = {
    company: "AI",
    out: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--company=")) out.company = token.slice("--company=".length).trim() || out.company;
    if (token === "--company" && argv[i + 1]) out.company = String(argv[++i]).trim() || out.company;
    if (token.startsWith("--out=")) out.out = path.resolve(token.slice("--out=".length));
    if (token === "--out" && argv[i + 1]) out.out = path.resolve(argv[++i]);
  }
  return out;
}

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);

    const receipts = await client.query(
      `
        select
          cr.id as receipt_id,
          cr.receipt_number,
          cr.tally_voucher_number,
          cr.receipt_date,
          cr.receipt_amount_invoice,
          cr.unallocated_amount_invoice,
          cr.customer_id,
          c.customer_code,
          c.customer_name
        from customer_receipts cr
        left join customers c on c.id = cr.customer_id
        where cr.company_id = $1
          and cr.receipt_status <> 'cancelled'
          and coalesce(cr.unallocated_amount_invoice, 0) > 0.01
        order by cr.receipt_date asc, cr.id asc
      `,
      [company.id]
    );

    const invoices = await client.query(
      `
        select
          ci.id as invoice_id,
          ci.invoice_number,
          ci.tally_voucher_number,
          ci.invoice_date,
          ci.customer_id,
          c.customer_code,
          c.customer_name,
          ci.grand_total_invoice,
          coalesce(ci.paid_amount, 0) as paid_amount,
          coalesce(ci.balance_due, ci.grand_total_invoice) as balance_due,
          ci.sales_order_id,
          so.so_number,
          ci.job_no,
          ci.customer_po_number,
          ci.invoice_status
        from customer_invoices ci
        left join customers c on c.id = ci.customer_id
        left join sales_orders so on so.id = ci.sales_order_id
        where ci.company_id = $1
          and ci.invoice_status not in ('cancelled', 'draft')
        order by c.customer_name asc, ci.invoice_date asc, ci.id asc
      `,
      [company.id]
    );

    const openInvoices = invoices.rows.filter((row) => money(row.balance_due) > 0.01);
    const unlinkedInvoices = invoices.rows.filter((row) => !row.sales_order_id);

    const allocationRows = receipts.rows.map((r) => ({
      receipt_number: r.receipt_number,
      tally_voucher_number: r.tally_voucher_number || "",
      receipt_date: r.receipt_date ? String(r.receipt_date).slice(0, 10) : "",
      customer_code: r.customer_code || "",
      customer_name: r.customer_name || "",
      receipt_amount: money(r.receipt_amount_invoice),
      unallocated_amount: money(r.unallocated_amount_invoice),
      invoice_number: "", // FILL
      allocate_amount: money(r.unallocated_amount_invoice), // FILL / edit
      notes: "",
    }));

    const invoiceSoRows = unlinkedInvoices.map((inv) => ({
      invoice_number: inv.invoice_number,
      tally_voucher_number: inv.tally_voucher_number || "",
      invoice_date: inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : "",
      customer_code: inv.customer_code || "",
      customer_name: inv.customer_name || "",
      grand_total: money(inv.grand_total_invoice),
      balance_due: money(inv.balance_due),
      customer_po_number: inv.customer_po_number || "",
      job_no: inv.job_no || "",
      so_number: "", // FILL
      notes: "",
    }));

    const instructions = [
      ["Josh – Accounts allocation workbook"],
      [`Company: ${company.company_code}`],
      [`Generated: ${new Date().toISOString()}`],
      [],
      ["How to use"],
      ["1. Open sheet Allocations."],
      ["2. For each receipt, fill invoice_number (exact Josh / Tally invoice number)."],
      ["3. Set allocate_amount (defaults to full unallocated)."],
      ["4. To split one receipt across invoices: copy the receipt row and split amounts (sum must not exceed unallocated_amount)."],
      ["5. Leave invoice_number blank to skip a receipt."],
      ["6. Save as .xlsx and send for import (do not rename column headers)."],
      [],
      ["Note: Invoice ↔ SO linking is owned by Sales (separate workbook)."],
      ["Generate full department pack:"],
      ["node scripts/export-department-o2c-workbooks.js --company=AI"],
      [],
      ["Import command (IT / deploy):"],
      [
        "node scripts/import-accounts-allocation-workbook.js --company=AI --file=storage/AI-accounts-allocations-filled.xlsx --apply",
      ],
      [],
      ["Reference sheets"],
      ["Unallocated_Receipts = current open receipts"],
      ["Open_Invoices = invoices with balance_due > 0 (use these invoice_numbers)"],
      [],
      ["Tips"],
      ["- Match by same customer_name / customer_code first."],
      ["- Prefer oldest open invoice when unsure (FIFO)."],
      ["- Credit notes: skip or confirm with Accounts lead before allocating."],
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), "Instructions");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allocationRows), "Allocations");
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        receipts.rows.map((r) => ({
          receipt_number: r.receipt_number,
          tally_voucher_number: r.tally_voucher_number || "",
          receipt_date: r.receipt_date ? String(r.receipt_date).slice(0, 10) : "",
          customer_code: r.customer_code || "",
          customer_name: r.customer_name || "",
          receipt_amount: money(r.receipt_amount_invoice),
          unallocated_amount: money(r.unallocated_amount_invoice),
        }))
      ),
      "Unallocated_Receipts"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        openInvoices.map((inv) => ({
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
          invoice_status: inv.invoice_status || "",
        }))
      ),
      "Open_Invoices"
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(invoiceSoRows), "Invoice_SO_Map");

    const outPath =
      args.out ||
      path.resolve(
        __dirname,
        "../storage",
        `${company.company_code}-accounts-allocations-${new Date().toISOString().slice(0, 10)}.xlsx`
      );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    XLSX.writeFile(wb, outPath);

    console.log(
      JSON.stringify(
        {
          ok: true,
          company: company.company_code,
          out: outPath,
          unallocated_receipts: receipts.rows.length,
          open_invoices: openInvoices.length,
          unlinked_invoices: unlinkedInvoices.length,
          sheets: ["Instructions", "Allocations", "Unallocated_Receipts", "Open_Invoices", "Invoice_SO_Map"],
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
