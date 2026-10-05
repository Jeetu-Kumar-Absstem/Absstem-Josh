#!/usr/bin/env node
/**
 * Re-parse Tally XML receipt Against Ref (BILLALLOCATIONS), refresh voucher_details,
 * and allocate unallocated Josh receipts.
 *
 * Important: most Absstem receipt vouchers in Transactions (1).xml have EMPTY
 * BILLALLOCATIONS — re-parse only recovers the few that actually carry Agst Ref.
 *
 *   # copy XML into API container storage first, then:
 *   node scripts/repair-receipt-against-ref-from-xml.js --file=storage/tally-transactions.xml --company=AI
 *   node scripts/repair-receipt-against-ref-from-xml.js --file=storage/tally-transactions.xml --company=AI --apply
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const { parseTallyData, applyTallyReceiptBillAllocations, isTallyReceiptVoucher } = require("../src/services/tallyEngine");
const { resolveCompanyId } = require("../src/services/o2cChainRepair");

function parseArgs(argv) {
  const out = {
    apply: false,
    company: "AI",
    file: path.resolve(__dirname, "../../Transactions (1).xml"),
  };
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

function money2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function agstRows(raw) {
  const rows = [];
  const push = (list) => {
    for (const row of list || []) {
      const billType = String(row.bill_type || "").toLowerCase();
      if (!row.invoice_number) continue;
      if (!(billType.includes("agst") || billType.includes("against"))) continue;
      rows.push({
        invoice_number: String(row.invoice_number).trim(),
        bill_type: row.bill_type || null,
        amount: money2(row.amount),
      });
    }
  };
  push(raw.bill_allocations);
  for (const entry of raw.entries || []) push(entry.bill_allocations);
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.invoice_number.toLowerCase()}|${row.amount.toFixed(2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findJoshReceipt(client, companyId, voucher) {
  const vchNo = String(voucher.voucher_number || "").trim();
  const date = voucher.date || null;
  const amount = money2(voucher.amount);

  if (vchNo) {
    const byNumber = await client.query(
      `
        select id, receipt_number, tally_voucher_number, receipt_amount_invoice, unallocated_amount_invoice, customer_id
        from customer_receipts
        where company_id = $1
          and receipt_source = 'tally_import'
          and receipt_status <> 'cancelled'
          and (
            lower(trim(coalesce(tally_voucher_number,''))) = lower(trim($2))
            or lower(trim(receipt_number)) = lower(trim($2))
          )
        order by id asc
        limit 3
      `,
      [companyId, vchNo]
    );
    if (byNumber.rows.length === 1) return { receipt: byNumber.rows[0], match: "voucher_number" };
    if (byNumber.rows.length > 1 && date) {
      const dated = byNumber.rows.filter((r) => String(r.receipt_date || "").slice(0, 10) === String(date).slice(0, 10));
      // receipt_date may not be in select — requery
    }
    if (byNumber.rows.length > 1) {
      const amtMatch = byNumber.rows.filter((r) => Math.abs(money2(r.receipt_amount_invoice) - amount) < 0.05);
      if (amtMatch.length === 1) return { receipt: amtMatch[0], match: "voucher_number+amount" };
    }
    if (byNumber.rows.length === 1) return { receipt: byNumber.rows[0], match: "voucher_number" };
  }

  if (date && amount > 0) {
    const byDateAmt = await client.query(
      `
        select id, receipt_number, tally_voucher_number, receipt_amount_invoice, unallocated_amount_invoice, customer_id
        from customer_receipts
        where company_id = $1
          and receipt_source = 'tally_import'
          and receipt_status <> 'cancelled'
          and tally_voucher_date = $2::date
          and abs(coalesce(receipt_amount_invoice,0) - $3::numeric) < 0.05
        order by id asc
        limit 5
      `,
      [companyId, date, amount]
    );
    if (byDateAmt.rows.length === 1) return { receipt: byDateAmt.rows[0], match: "date+amount" };
  }

  return { receipt: null, match: null };
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
        invoice_status = case when alloc.grand - alloc.allocated <= 0.0001 then 'paid' else
          case when ci.invoice_status = 'paid' then 'issued' else ci.invoice_status end end,
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
  if (!fs.existsSync(args.file)) {
    console.error(`XML file not found: ${args.file}`);
    console.error("Copy Transactions (1).xml into the API container, e.g.");
    console.error('  docker cp "Transactions (1).xml" josh-api:/app/server/storage/tally-transactions.xml');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) throw new Error(`Company not found: ${args.company}`);

    const parsed = parseTallyData(fs.readFileSync(args.file), path.basename(args.file));
    const receipts = (parsed.vouchers || []).filter((v) => isTallyReceiptVoucher(v.voucher_type));
    const withAgst = [];
    for (const raw of receipts) {
      const bills = agstRows(raw);
      if (bills.length) withAgst.push({ raw, bills });
    }

    console.log(
      JSON.stringify(
        {
          mode: args.apply ? "APPLY" : "DRY_RUN",
          company: company.company_code,
          file: args.file,
          xml_receipts: receipts.length,
          xml_receipts_with_against_ref: withAgst.length,
          note:
            withAgst.length < 20
              ? "Tally XML has Against Ref on only a few receipts; the rest were exported without BILLALLOCATIONS (On Account). Re-parse cannot invent those links."
              : null,
        },
        null,
        2
      )
    );

    if (args.apply) await client.query("begin");

    const results = [];
    const touchedInvoices = [];
    let matched = 0;
    let allocated = 0;
    let unmatched = 0;
    let alreadyAllocated = 0;

    for (const { raw, bills } of withAgst) {
      const found = await findJoshReceipt(client, company.id, raw);
      if (!found.receipt) {
        unmatched += 1;
        results.push({
          ok: false,
          reason: "RECEIPT_NOT_FOUND",
          tally_voucher_number: raw.voucher_number,
          date: raw.date,
          amount: raw.amount,
          bills,
        });
        continue;
      }
      matched += 1;

      const existing = await client.query(
        `select count(*)::int as n from customer_receipt_allocations where customer_receipt_id = $1`,
        [found.receipt.id]
      );
      const hasAlloc = (existing.rows[0]?.n || 0) > 0;

      if (!args.apply) {
        results.push({
          ok: true,
          would_apply: !hasAlloc,
          reason: hasAlloc ? "ALLOCATIONS_EXIST" : "READY",
          match: found.match,
          receipt_id: found.receipt.id,
          receipt_number: found.receipt.receipt_number,
          tally_voucher_number: raw.voucher_number,
          bills,
          unallocated: Number(found.receipt.unallocated_amount_invoice),
        });
        if (hasAlloc) alreadyAllocated += 1;
        continue;
      }

      // Refresh voucher_details on reconciliation row(s)
      await client.query(
        `
          update tally_voucher_reconciliations
          set voucher_details = $3::jsonb
          where company_id = $1
            and (
              (matched_entity_type = 'customer_receipts' and matched_entity_id = $2)
              or (
                lower(trim(voucher_number)) = lower(trim($4))
                and lower(voucher_type) like '%receipt%'
              )
            )
        `,
        [company.id, found.receipt.id, JSON.stringify(raw), raw.voucher_number]
      );

      if (hasAlloc) {
        alreadyAllocated += 1;
        results.push({
          ok: true,
          skipped: true,
          reason: "ALLOCATIONS_EXIST",
          receipt_id: found.receipt.id,
          receipt_number: found.receipt.receipt_number,
          details_refreshed: true,
        });
        continue;
      }

      const alloc = await applyTallyReceiptBillAllocations(client, {
        companyId: company.id,
        receiptId: found.receipt.id,
        raw,
      });
      if (alloc.applied > 0) {
        allocated += 1;
        touchedInvoices.push(...(alloc.invoice_ids || []));
      }
      results.push({
        ok: alloc.applied > 0,
        receipt_id: found.receipt.id,
        receipt_number: found.receipt.receipt_number,
        tally_voucher_number: raw.voucher_number,
        applied: alloc.applied,
        skipped_bills: alloc.skipped,
        bills,
      });
    }

    let paidSynced = 0;
    if (args.apply && touchedInvoices.length) {
      paidSynced = await syncPaid(client, touchedInvoices);
    }
    if (args.apply) await client.query("commit");

    console.log(
      JSON.stringify(
        {
          ok: true,
          matched_josh_receipts: matched,
          unmatched_xml_receipts: unmatched,
          already_had_allocations: alreadyAllocated,
          newly_allocated_receipts: args.apply ? allocated : results.filter((r) => r.would_apply).length,
          paid_status_synced: paidSynced,
          sample: results.slice(0, 30),
          results_count: results.length,
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
