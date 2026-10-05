#!/usr/bin/env node
/**
 * Import Accounts-filled allocation workbook.
 *
 * Sheets used:
 *   Allocations     → receipt_number + invoice_number + allocate_amount
 *   Invoice_SO_Map  → invoice_number + so_number (optional)
 *
 *   node scripts/import-accounts-allocation-workbook.js --company=AI --file=storage/filled.xlsx
 *   node scripts/import-accounts-allocation-workbook.js --company=AI --file=storage/filled.xlsx --apply
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

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function clean(v) {
  return String(v ?? "").trim();
}

function sheetRows(wb, name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

async function findReceipt(client, companyId, receiptNumber, tallyVoucherNumber) {
  const rn = clean(receiptNumber);
  const tv = clean(tallyVoucherNumber);
  const r = await client.query(
    `
      select id, receipt_number, customer_id, receipt_amount_invoice, unallocated_amount_invoice
      from customer_receipts
      where company_id = $1
        and receipt_status <> 'cancelled'
        and (
          ($2 <> '' and lower(trim(receipt_number)) = lower(trim($2)))
          or ($3 <> '' and lower(trim(coalesce(tally_voucher_number,''))) = lower(trim($3)))
        )
      order by id asc
      limit 1
    `,
    [companyId, rn, tv]
  );
  return r.rows[0] || null;
}

async function findInvoice(client, companyId, invoiceNumber) {
  const inv = clean(invoiceNumber);
  if (!inv) return null;
  const r = await client.query(
    `
      select id, invoice_number, customer_id, grand_total_invoice,
             coalesce(balance_due, grand_total_invoice) as balance_due, invoice_status
      from customer_invoices
      where company_id = $1
        and invoice_status not in ('cancelled', 'draft')
        and (
          lower(trim(invoice_number)) = lower(trim($2))
          or lower(trim(coalesce(tally_voucher_number,''))) = lower(trim($2))
        )
      order by id asc
      limit 1
    `,
    [companyId, inv]
  );
  return r.rows[0] || null;
}

async function refreshReceiptTotals(client, receiptId) {
  const sum = await client.query(
    `
      select
        coalesce(sum(allocated_base),0)::float8 as allocated_base,
        coalesce(sum(allocated_invoice),0)::float8 as allocated_invoice
      from customer_receipt_allocations
      where customer_receipt_id = $1
    `,
    [receiptId]
  );
  const receipt = await client.query(
    `select receipt_amount_base, receipt_amount_invoice from customer_receipts where id = $1`,
    [receiptId]
  );
  const allocatedBase = money(sum.rows[0]?.allocated_base);
  const allocatedInvoice = money(sum.rows[0]?.allocated_invoice);
  const receiptBase = money(receipt.rows[0]?.receipt_amount_base);
  const receiptInvoice = money(receipt.rows[0]?.receipt_amount_invoice);
  await client.query(
    `
      update customer_receipts
      set
        allocated_amount_base = $2,
        allocated_amount_invoice = $3,
        unallocated_amount_base = $4,
        unallocated_amount_invoice = $5,
        updated_at = now()
      where id = $1
    `,
    [
      receiptId,
      allocatedBase,
      allocatedInvoice,
      money(Math.max(0, receiptBase - allocatedBase)),
      money(Math.max(0, receiptInvoice - allocatedInvoice)),
    ]
  );
}

async function syncPaid(client, invoiceIds) {
  const ids = [...new Set((invoiceIds || []).map((n) => Number(n)).filter((n) => n > 0))];
  if (!ids.length) return 0;
  const r = await client.query(
    `
      with alloc as (
        select
          ci.id,
          coalesce(ci.grand_total_invoice, 0) as grand,
          coalesce(sum(cra.allocated_invoice), 0) as allocated
        from customer_invoices ci
        left join customer_receipt_allocations cra on cra.customer_invoice_id = ci.id
        where ci.id = any($1::int[])
          and ci.invoice_status not in ('draft', 'cancelled')
        group by ci.id, ci.grand_total_invoice
      )
      update customer_invoices ci
      set
        invoice_status = case
          when alloc.grand - alloc.allocated <= 0.0001 then 'paid'
          when ci.invoice_status = 'paid' then 'issued'
          else ci.invoice_status
        end,
        paid_amount = least(alloc.grand, alloc.allocated),
        balance_due = greatest(alloc.grand - alloc.allocated, 0),
        updated_at = now()
      from alloc
      where ci.id = alloc.id
      returning ci.id
    `,
    [ids]
  );
  return r.rowCount || 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || !fs.existsSync(args.file)) {
    console.error("Usage: node scripts/import-accounts-allocation-workbook.js --company=AI --file=storage/filled.xlsx [--apply]");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const wb = XLSX.readFile(args.file);
  const allocationRows = sheetRows(wb, "Allocations");
  const soMapRows = sheetRows(wb, "Invoice_SO_Map");

  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);

    const planned = [];
    for (const row of allocationRows) {
      const invoiceNumber = clean(row.invoice_number);
      if (!invoiceNumber) continue;
      const allocateAmount = money(row.allocate_amount);
      if (allocateAmount <= 0) {
        planned.push({ ok: false, reason: "INVALID_AMOUNT", row });
        continue;
      }
      planned.push({
        ok: true,
        receipt_number: clean(row.receipt_number),
        tally_voucher_number: clean(row.tally_voucher_number),
        invoice_number: invoiceNumber,
        allocate_amount: allocateAmount,
        notes: clean(row.notes),
      });
    }

    const soLinks = soMapRows
      .map((row) => ({
        invoice_number: clean(row.invoice_number),
        so_number: clean(row.so_number),
        job_no: clean(row.job_no) || null,
        customer_po_number: clean(row.customer_po_number) || null,
      }))
      .filter((row) => row.invoice_number && row.so_number);

    console.log(
      JSON.stringify(
        {
          mode: args.apply ? "APPLY" : "DRY_RUN",
          company: company.company_code,
          file: args.file,
          allocation_rows_to_import: planned.filter((p) => p.ok).length,
          allocation_rows_invalid: planned.filter((p) => !p.ok).length,
          invoice_so_links: soLinks.length,
          sample_allocations: planned.filter((p) => p.ok).slice(0, 20),
          sample_so_links: soLinks.slice(0, 20),
        },
        null,
        2
      )
    );

    if (!args.apply) return;

    await client.query("begin");
    const results = [];
    const touchedInvoices = [];
    const touchedReceipts = new Set();

    for (const row of planned.filter((p) => p.ok)) {
      const receipt = await findReceipt(client, company.id, row.receipt_number, row.tally_voucher_number);
      if (!receipt) {
        results.push({ ok: false, reason: "RECEIPT_NOT_FOUND", ...row });
        continue;
      }
      const invoice = await findInvoice(client, company.id, row.invoice_number);
      if (!invoice) {
        results.push({ ok: false, reason: "INVOICE_NOT_FOUND", ...row });
        continue;
      }
      if (receipt.customer_id && invoice.customer_id && Number(receipt.customer_id) !== Number(invoice.customer_id)) {
        results.push({
          ok: false,
          reason: "CUSTOMER_MISMATCH",
          receipt_customer_id: receipt.customer_id,
          invoice_customer_id: invoice.customer_id,
          ...row,
        });
        continue;
      }

      // Upsert allocation (add to existing if same pair exists)
      const existing = await client.query(
        `
          select id, allocated_invoice
          from customer_receipt_allocations
          where customer_receipt_id = $1 and customer_invoice_id = $2
          limit 1
        `,
        [receipt.id, invoice.id]
      );

      if (existing.rows[0]) {
        const nextAmt = money(Number(existing.rows[0].allocated_invoice) + row.allocate_amount);
        await client.query(
          `
            update customer_receipt_allocations
            set allocated_base = $2, allocated_invoice = $2
            where id = $1
          `,
          [existing.rows[0].id, nextAmt]
        );
      } else {
        await client.query(
          `
            insert into customer_receipt_allocations (
              customer_receipt_id, customer_invoice_id, allocated_base, allocated_invoice
            )
            values ($1, $2, $3, $3)
          `,
          [receipt.id, invoice.id, row.allocate_amount]
        );
      }

      touchedReceipts.add(receipt.id);
      touchedInvoices.push(invoice.id);
      results.push({
        ok: true,
        receipt_number: receipt.receipt_number,
        invoice_number: invoice.invoice_number,
        allocate_amount: row.allocate_amount,
      });
    }

    for (const receiptId of touchedReceipts) {
      await refreshReceiptTotals(client, receiptId);
      // Guard: do not allow negative unallocated
      const check = await client.query(
        `select receipt_number, unallocated_amount_invoice from customer_receipts where id = $1`,
        [receiptId]
      );
      if (money(check.rows[0]?.unallocated_amount_invoice) < -0.01) {
        throw new Error(
          `Over-allocation on ${check.rows[0].receipt_number}: unallocated=${check.rows[0].unallocated_amount_invoice}`
        );
      }
    }

    const paidSynced = await syncPaid(client, touchedInvoices);

    let soLinkResult = null;
    if (soLinks.length) {
      soLinkResult = await linkInvoicesToSalesOrders(client, { companyId: company.id, rows: soLinks });
    }

    await client.query("commit");
    console.log(
      JSON.stringify(
        {
          ok: true,
          applied_allocations: results.filter((r) => r.ok).length,
          failed_allocations: results.filter((r) => !r.ok).length,
          paid_status_synced: paidSynced,
          so_links_ok: Array.isArray(soLinkResult) ? soLinkResult.filter((r) => r.ok).length : 0,
          so_links_failed: Array.isArray(soLinkResult) ? soLinkResult.filter((r) => !r.ok).length : 0,
          failures: results.filter((r) => !r.ok).slice(0, 40),
          sample_ok: results.filter((r) => r.ok).slice(0, 20),
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
