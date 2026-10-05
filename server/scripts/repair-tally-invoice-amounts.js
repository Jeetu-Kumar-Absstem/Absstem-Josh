#!/usr/bin/env node
/**
 * Repair Josh invoice grand totals to match Accounts' Tally reconciliation sheet.
 * Does NOT re-import the full Tally batch.
 *
 * Usage (inside API container or with DATABASE_URL):
 *   node scripts/repair-tally-invoice-amounts.js              # dry-run
 *   node scripts/repair-tally-invoice-amounts.js --apply      # write
 *   node scripts/repair-tally-invoice-amounts.js --company=AI --apply
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { pool } = require("../src/db/pool");
const {
  buildInvoiceLinesFromTallyVoucher,
  computeTallySalesInvoiceTotals,
} = require("../src/services/tallyEngine");

/** Ritika Yadav sheet — Josh vs Tally (AI company). */
const CORRECTIONS = [
  { invoice_number: "INV-AI/26-27/046", tally_amount: 8850 },
  { invoice_number: "INV-AI/26-27/027", tally_amount: 118848 },
  { invoice_number: "INV-AI/26-27/024", tally_amount: 39577 },
  { invoice_number: "INV-AI/26-27/020", tally_amount: 66080 },
  { invoice_number: "INV-AI/26-27/018", tally_amount: 66080 },
  { invoice_number: "INV-AI/26-27/015", tally_amount: 9912 },
  { invoice_number: "INV-AI/25-26/078", tally_amount: 12390 },
  { invoice_number: "INV-AI/25-26/050", tally_amount: 8850 },
  { invoice_number: "INV-AI/25-26/048", tally_amount: 8850 },
  { invoice_number: "INV-AI/25-26/031", tally_amount: 23600 },
  { invoice_number: "INV-AI/25-26/026", tally_amount: 35400 },
  { invoice_number: "INV-AI/25-26/016", tally_amount: 8850 },
  { invoice_number: "INV-AI/24-25/058", tally_amount: 194700 },
  { invoice_number: "INV-AI/24-25/031", tally_amount: 97350 },
  { invoice_number: "INV-AI/24-25/027", tally_amount: 17700 },
  { invoice_number: "INV-AI/24-25/024", tally_amount: 7965 },
  { invoice_number: "INV-AI/24-25/007", tally_amount: 97350 },
  { invoice_number: "INV-AI/23-24/046", tally_amount: 1416000 },
  { invoice_number: "INV-AI/23-24/040", tally_amount: 97350 },
  { invoice_number: "INV-AI/23-24/023", tally_amount: 97350 },
  { invoice_number: "INV-AI/23-24/016", tally_amount: 47200 },
  { invoice_number: "INV-AI/23-24/013", tally_amount: 985300 },
  { invoice_number: "INV-AI/23-24/011", tally_amount: 97350 },
  { invoice_number: "INV-AI/23-24/009", tally_amount: 495384 },
  { invoice_number: "INV-AI/23-24/004", tally_amount: 97350 },
  { invoice_number: "INV-AI/23-24/003", tally_amount: 11800 },
  { invoice_number: "INV-AI/22-23/015", tally_amount: 1220120 },
  { invoice_number: "INV-AI/22-23/014", tally_amount: 59590 },
  { invoice_number: "INV-AI/22-23/011", tally_amount: 850780 },
  { invoice_number: "INV-AI/22-23/05", tally_amount: 1373520 },
  { invoice_number: "INV-AI/22-23/04", tally_amount: 654900 },
  { invoice_number: "INV-AI/22-23/02", tally_amount: 59000 },
];

function parseArgs(argv) {
  const out = { apply: false, company: "AI" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") out.apply = true;
    if (token.startsWith("--company=")) out.company = token.slice("--company=".length).trim() || out.company;
    if (token === "--company" && argv[i + 1]) out.company = String(argv[++i]).trim() || out.company;
  }
  return out;
}

function money2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeInvoiceKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\/0+(\d+)$/i, "/$1");
}

function invoiceNumberCandidates(invoiceNumber) {
  const raw = String(invoiceNumber || "").trim();
  const candidates = new Set([raw]);
  const m = raw.match(/^(.*\/)(\d+)$/i);
  if (m) {
    const serial = m[2];
    candidates.add(`${m[1]}${serial}`);
    if (serial.length < 3) candidates.add(`${m[1]}${serial.padStart(3, "0")}`);
    candidates.add(`${m[1]}${String(Number(serial))}`);
  }
  // Sheet had INV-Ai/... once
  candidates.add(raw.replace(/^INV-AI\//i, "INV-Ai/"));
  candidates.add(raw.replace(/^INV-Ai\//i, "INV-AI/"));
  return [...candidates];
}

async function resolveCompanyId(client, companyCode) {
  const r = await client.query(
    `
      select id, company_code
      from companies
      where lower(company_code) = lower($1)
      limit 1
    `,
    [companyCode]
  );
  return r.rows[0] || null;
}

async function findInvoice(client, companyId, invoiceNumber) {
  const candidates = invoiceNumberCandidates(invoiceNumber);
  const r = await client.query(
    `
      select
        id, invoice_number, customer_id, invoice_status,
        subtotal_invoice, tax_total_invoice, grand_total_invoice,
        paid_amount, balance_due,
        cgst_amount, sgst_amount, igst_amount, is_interstate,
        tally_voucher_number, invoice_source
      from customer_invoices
      where company_id = $1
        and (
          lower(trim(invoice_number)) = any($2::text[])
          or lower(trim(coalesce(tally_voucher_number, ''))) = any($2::text[])
        )
      order by id asc
      limit 1
    `,
    [companyId, candidates.map((c) => c.toLowerCase())]
  );
  return r.rows[0] || null;
}

async function loadReconRaw(client, companyId, invoice) {
  const keys = [
    invoice.tally_voucher_number,
    invoice.invoice_number,
    ...invoiceNumberCandidates(invoice.invoice_number),
  ]
    .filter(Boolean)
    .map((k) => String(k).trim());

  const r = await client.query(
    `
      select voucher_number, tally_amount, josh_amount, variance, voucher_details, reconciliation_status
      from tally_voucher_reconciliations
      where company_id = $1
        and lower(trim(voucher_number)) = any($2::text[])
      order by id desc
      limit 1
    `,
    [companyId, keys.map((k) => k.toLowerCase())]
  );
  const row = r.rows[0] || null;
  if (!row) return null;
  const details = row.voucher_details && typeof row.voucher_details === "object" ? row.voucher_details : {};
  return { row, raw: details };
}

async function getAllocatedInvoice(client, invoiceId) {
  const r = await client.query(
    `
      select coalesce(sum(allocated_invoice), 0)::float8 as allocated
      from customer_receipt_allocations
      where customer_invoice_id = $1
    `,
    [invoiceId]
  );
  return money2(r.rows[0]?.allocated || 0);
}

function planFromVoucherRaw(raw, tallyAmount) {
  const lineDrafts = buildInvoiceLinesFromTallyVoucher(raw);
  const totals = computeTallySalesInvoiceTotals(
    { ...raw, amount: tallyAmount > 0 ? tallyAmount : raw.amount },
    lineDrafts
  );
  // Force Accounts' Tally amount as authoritative grand total.
  const grandTotal = money2(tallyAmount);
  let computedTax = money2(totals.computedTax);
  if (computedTax > grandTotal) computedTax = money2(Math.max(0, grandTotal - totals.subtotal));
  let subtotal = money2(Math.max(0, grandTotal - computedTax));
  if (Math.abs(totals.subtotal + computedTax - grandTotal) <= 0.05) {
    subtotal = money2(totals.subtotal);
  }
  return {
    mode: "voucher_rebuild",
    lineDrafts,
    subtotal,
    computedTax,
    grandTotal,
    cgst: totals.cgst,
    sgst: totals.sgst,
    igst: totals.igst,
    isInterstate: totals.isInterstate,
  };
}

function planFromHeaderOnly(invoice, tallyAmount) {
  const josh = money2(invoice.grand_total_invoice);
  const grandTotal = money2(tallyAmount);
  let tax = money2(invoice.tax_total_invoice);
  if (tax > grandTotal) tax = 0;

  // Classic double-count: Josh ≈ Tally + tax (inclusive base used as subtotal)
  const classicDouble =
    tax > 0 && Math.abs(josh - (grandTotal + tax)) <= 1.0;

  if (classicDouble) {
    return {
      mode: "fix_double_tax",
      lineDrafts: null,
      subtotal: money2(grandTotal - tax),
      computedTax: tax,
      grandTotal,
      cgst: money2(invoice.is_interstate ? 0 : tax / 2),
      sgst: money2(invoice.is_interstate ? 0 : tax / 2),
      igst: money2(invoice.is_interstate ? tax : 0),
      isInterstate: Boolean(invoice.is_interstate),
      scaleSingleLine: true,
    };
  }

  // Under/over: keep tax if plausible; set subtotal = grand - tax; balance with adj line later
  if (tax <= 0 || tax >= grandTotal) {
    // Preserve previous tax ratio if possible
    const prevSub = money2(invoice.subtotal_invoice);
    const prevGrand = josh > 0 ? josh : prevSub;
    const ratio = prevGrand > 0 ? tax / prevGrand : 0;
    tax = money2(grandTotal * ratio);
  }
  const subtotal = money2(Math.max(0, grandTotal - tax));
  return {
    mode: josh > grandTotal ? "fix_overstatement" : "fix_understatement",
    lineDrafts: null,
    subtotal,
    computedTax: tax,
    grandTotal,
    cgst: money2(invoice.is_interstate ? 0 : tax / 2),
    sgst: money2(invoice.is_interstate ? 0 : tax / 2),
    igst: money2(invoice.is_interstate ? tax : 0),
    isInterstate: Boolean(invoice.is_interstate),
    scaleSingleLine: false,
    addBalancingLine: true,
  };
}

async function replaceLines(client, invoiceId, lineDrafts) {
  await client.query(`delete from invoice_lines where customer_invoice_id = $1`, [invoiceId]);
  for (const line of lineDrafts) {
    await client.query(
      `
        insert into invoice_lines (
          customer_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
          hsn_no, customer_item_code, qty, unit_price_base, unit_price_invoice, gst_pct,
          line_total_base, line_total_invoice, charge_kind, created_at, updated_at
        )
        values ($1, null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $12, $13, now(), now())
      `,
      [
        invoiceId,
        line.line_no,
        line.product_id || null,
        line.item_code || null,
        line.item_name || null,
        line.line_description || line.item_name || null,
        line.hsn_no || null,
        line.customer_item_code || null,
        line.qty ?? 1,
        line.unit_price ?? line.line_total ?? 0,
        line.gst_pct ?? 0,
        line.line_total ?? 0,
        line.charge_kind || null,
      ]
    );
  }
}

async function adjustExistingLines(client, invoiceId, plan) {
  const linesRes = await client.query(
    `
      select id, line_no, item_code, item_name, qty, unit_price_invoice, line_total_invoice, gst_pct, charge_kind
      from invoice_lines
      where customer_invoice_id = $1
      order by line_no asc, id asc
    `,
    [invoiceId]
  );
  const lines = linesRes.rows;
  const currentSum = money2(lines.reduce((s, row) => s + Number(row.line_total_invoice || 0), 0));
  const targetSub = money2(plan.subtotal);

  if (lines.length === 1) {
    const line = lines[0];
    await client.query(
      `
        update invoice_lines
        set
          qty = 1,
          unit_price_base = $2,
          unit_price_invoice = $2,
          line_total_base = $2,
          line_total_invoice = $2,
          updated_at = now()
        where id = $1
      `,
      [line.id, targetSub]
    );
    return;
  }

  const delta = money2(targetSub - currentSum);
  if (Math.abs(delta) < 0.01) return;

  if (plan.addBalancingLine || Math.abs(delta) > 0.01) {
    const nextNo = (lines.reduce((m, row) => Math.max(m, Number(row.line_no) || 0), 0) || 0) + 1;
    await client.query(
      `
        insert into invoice_lines (
          customer_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
          hsn_no, customer_item_code, qty, unit_price_base, unit_price_invoice, gst_pct,
          line_total_base, line_total_invoice, charge_kind, created_at, updated_at
        )
        values ($1, null, $2, null, 'TALLY-ADJ', $3, $3, null, null, 1, $4, $4, 0, $4, $4, null, now(), now())
      `,
      [
        invoiceId,
        nextNo,
        delta >= 0 ? "Tally charges / adjustment (Accounts recon)" : "Tally amount adjustment (Accounts recon)",
        delta,
      ]
    );
  }
}

async function applyPlan(client, invoice, plan, allocated) {
  const paid = money2(Math.max(allocated, Number(invoice.paid_amount || 0)));
  const balanceDue = money2(Math.max(0, plan.grandTotal - paid));

  if (plan.lineDrafts && plan.lineDrafts.length) {
    await replaceLines(client, invoice.id, plan.lineDrafts);
  } else {
    await adjustExistingLines(client, invoice.id, plan);
  }

  await client.query(
    `
      update customer_invoices
      set
        subtotal_base = $2,
        subtotal_invoice = $2,
        tax_total_base = $3,
        tax_total_invoice = $3,
        grand_total_base = $4,
        grand_total_invoice = $4,
        balance_due = $5,
        paid_amount = $6,
        cgst_amount = $7,
        sgst_amount = $8,
        igst_amount = $9,
        is_interstate = $10,
        updated_at = now()
      where id = $1
    `,
    [
      invoice.id,
      plan.subtotal,
      plan.computedTax,
      plan.grandTotal,
      balanceDue,
      paid,
      plan.isInterstate ? 0 : plan.cgst,
      plan.isInterstate ? 0 : plan.sgst,
      plan.isInterstate ? plan.igst || plan.computedTax : 0,
      Boolean(plan.isInterstate),
    ]
  );

  await client.query(
    `
      update tally_voucher_reconciliations
      set
        josh_amount = $2,
        variance = abs(coalesce(tally_amount, $2) - $2),
        reconciliation_status = case
          when abs(coalesce(tally_amount, $2) - $2) <= 0.05 then 'reconciled'
          else 'variance_detected'
        end
      where matched_entity_type = 'customer_invoices'
        and matched_entity_id = $1
    `,
    [invoice.id, plan.grandTotal]
  );

  await client.query(
    `
      update tally_voucher_reconciliations tvr
      set
        josh_amount = $3,
        variance = abs(coalesce(tvr.tally_amount, $3) - $3),
        reconciliation_status = case
          when abs(coalesce(tvr.tally_amount, $3) - $3) <= 0.05 then 'reconciled'
          else 'variance_detected'
        end
      where tvr.company_id = (select company_id from customer_invoices where id = $1)
        and lower(trim(tvr.voucher_number)) = lower(trim($2))
    `,
    [invoice.id, invoice.tally_voucher_number || invoice.invoice_number, plan.grandTotal]
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await pool.connect();
  const results = [];

  try {
    const company = await resolveCompanyId(client, args.company);
    if (!company) {
      throw new Error(`Company not found: ${args.company}`);
    }

    console.log(
      JSON.stringify(
        {
          mode: args.apply ? "APPLY" : "DRY_RUN",
          company_id: company.id,
          company_code: company.company_code,
          count: CORRECTIONS.length,
        },
        null,
        2
      )
    );

    if (args.apply) await client.query("begin");

    for (const row of CORRECTIONS) {
      const invoice = await findInvoice(client, company.id, row.invoice_number);
      if (!invoice) {
        results.push({
          invoice_number: row.invoice_number,
          ok: false,
          error: "NOT_FOUND",
          tally_amount: row.tally_amount,
        });
        continue;
      }

      const joshBefore = money2(invoice.grand_total_invoice);
      const tallyAmount = money2(row.tally_amount);
      if (Math.abs(joshBefore - tallyAmount) <= 0.05) {
        results.push({
          invoice_number: invoice.invoice_number,
          ok: true,
          skipped: true,
          reason: "ALREADY_MATCHES",
          josh_before: joshBefore,
          tally_amount: tallyAmount,
        });
        continue;
      }

      const recon = await loadReconRaw(client, company.id, invoice);
      const hasEntries =
        recon?.raw &&
        (Array.isArray(recon.raw.entries) ||
          Array.isArray(recon.raw.inventory_entries) ||
          recon.raw.amount != null);

      const raw = hasEntries
        ? {
            amount: recon.raw.amount ?? tallyAmount,
            party_name: recon.raw.party_name,
            narration: recon.raw.narration,
            entries: recon.raw.entries || [],
            inventory_entries: recon.raw.inventory_entries || [],
          }
        : null;

      const plan = raw
        ? planFromVoucherRaw(raw, tallyAmount)
        : planFromHeaderOnly(invoice, tallyAmount);

      const allocated = await getAllocatedInvoice(client, invoice.id);
      const delta = money2(tallyAmount - joshBefore);

      if (args.apply) {
        await applyPlan(client, invoice, plan, allocated);
      }

      results.push({
        invoice_number: invoice.invoice_number,
        id: invoice.id,
        ok: true,
        mode: plan.mode,
        josh_before: joshBefore,
        tally_amount: tallyAmount,
        josh_after: plan.grandTotal,
        delta,
        subtotal_after: plan.subtotal,
        tax_after: plan.computedTax,
        allocated,
        used_voucher_details: Boolean(raw),
      });
    }

    if (args.apply) await client.query("commit");

    const summary = {
      mode: args.apply ? "APPLY" : "DRY_RUN",
      repaired: results.filter((r) => r.ok && !r.skipped).length,
      already_ok: results.filter((r) => r.skipped).length,
      missing: results.filter((r) => r.error === "NOT_FOUND").length,
      results,
    };
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    if (args.apply) {
      try {
        await client.query("rollback");
      } catch {
        /* ignore */
      }
    }
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
