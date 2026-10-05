/**
 * O2C chain completeness repairs for Tally + legacy SO parallel ops.
 * A) Receipt Against-Ref allocations
 * B) Invoice ↔ SO linking for remaining unlinked invoices
 * C) SO lines + totals backfill from linked invoice lines
 */
const { applyTallyReceiptBillAllocations } = require("./tallyEngine");
const { linkInvoicesToSalesOrders, normalizeJobNo } = require("./tallyInvoiceEnrichment");

function money2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = new Date(a).getTime() - new Date(b).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / (24 * 3600 * 1000));
}

function isBlankPo(po) {
  const t = String(po || "")
    .replace(/\u0004/g, "")
    .replace(/&#4;/gi, "")
    .trim();
  return !t || /not applicable/i.test(t) || /^n\/a$/i.test(t);
}

async function resolveCompanyId(client, companyCode) {
  const r = await client.query(
    `select id, company_code from companies where lower(company_code) = lower($1) limit 1`,
    [companyCode]
  );
  return r.rows[0] || null;
}

async function syncInvoicePaidFlags(client, invoiceIds) {
  const ids = [...new Set((invoiceIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  if (!ids.length) return 0;
  const r = await client.query(
    `
      with alloc as (
        select
          ci.id,
          ci.invoice_status,
          coalesce(ci.grand_total_invoice, 0) as grand,
          coalesce(sum(cra.allocated_invoice), 0) as allocated
        from customer_invoices ci
        left join customer_receipt_allocations cra on cra.customer_invoice_id = ci.id
        where ci.id = any($1::int[])
          and ci.invoice_status not in ('draft', 'cancelled')
        group by ci.id, ci.invoice_status, ci.grand_total_invoice
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

/** A — allocate tally receipts from voucher Against Ref */
async function repairReceiptAllocations(client, { companyId, apply = false, limit = 5000 } = {}) {
  const receipts = await client.query(
    `
      select
        cr.id,
        cr.receipt_number,
        cr.tally_voucher_number,
        cr.receipt_amount_invoice,
        cr.unallocated_amount_invoice,
        cr.customer_id,
        coalesce(tvr.voucher_details, '{}'::jsonb) as voucher_details
      from customer_receipts cr
      left join lateral (
        select voucher_details
        from tally_voucher_reconciliations tvr
        where tvr.company_id = cr.company_id
          and (
            (tvr.matched_entity_type = 'customer_receipts' and tvr.matched_entity_id = cr.id)
            or (
              lower(trim(tvr.voucher_number)) = lower(trim(coalesce(cr.tally_voucher_number, cr.receipt_number)))
              and lower(tvr.voucher_type) like '%receipt%'
            )
          )
        order by
          case when tvr.matched_entity_type = 'customer_receipts' and tvr.matched_entity_id = cr.id then 0 else 1 end,
          tvr.id desc
        limit 1
      ) tvr on true
      where cr.company_id = $1
        and cr.receipt_source = 'tally_import'
        and cr.receipt_status <> 'cancelled'
        and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001
        and not exists (
          select 1 from customer_receipt_allocations a where a.customer_receipt_id = cr.id
        )
      order by cr.receipt_date asc, cr.id asc
      limit $2
    `,
    [companyId, limit]
  );

  const results = [];
  let appliedRows = 0;
  let skippedNoBills = 0;
  let skippedNoMatch = 0;
  const touchedInvoices = [];

  for (const row of receipts.rows) {
    const raw = row.voucher_details && typeof row.voucher_details === "object" ? row.voucher_details : {};
    if (!raw.voucher_type) raw.voucher_type = "Receipt";
    if (!raw.voucher_number) raw.voucher_number = row.tally_voucher_number || row.receipt_number;

    const preview = await client.query(
      `
        select 1
        where exists (
          select 1
          from jsonb_array_elements(coalesce($1::jsonb->'bill_allocations', '[]'::jsonb)) e
          where lower(coalesce(e->>'bill_type','')) like '%agst%'
             or lower(coalesce(e->>'bill_type','')) like '%against%'
        )
        or exists (
          select 1
          from jsonb_array_elements(coalesce($1::jsonb->'entries', '[]'::jsonb)) ent,
               jsonb_array_elements(coalesce(ent->'bill_allocations', '[]'::jsonb)) e
          where lower(coalesce(e->>'bill_type','')) like '%agst%'
             or lower(coalesce(e->>'bill_type','')) like '%against%'
        )
      `,
      [JSON.stringify(raw)]
    );
    if (!preview.rows.length) {
      skippedNoBills += 1;
      results.push({
        receipt_id: row.id,
        receipt_number: row.receipt_number,
        ok: false,
        reason: "NO_AGAINST_REF",
      });
      continue;
    }

    if (!apply) {
      results.push({
        receipt_id: row.id,
        receipt_number: row.receipt_number,
        ok: true,
        would_apply: true,
        unallocated: Number(row.unallocated_amount_invoice),
      });
      appliedRows += 1;
      continue;
    }

    const alloc = await applyTallyReceiptBillAllocations(client, {
      companyId,
      receiptId: row.id,
      raw,
    });
    if (alloc.applied > 0) {
      appliedRows += 1;
      touchedInvoices.push(...(alloc.invoice_ids || []));
      results.push({
        receipt_id: row.id,
        receipt_number: row.receipt_number,
        ok: true,
        applied: alloc.applied,
        skipped: alloc.skipped,
      });
    } else {
      skippedNoMatch += 1;
      results.push({
        receipt_id: row.id,
        receipt_number: row.receipt_number,
        ok: false,
        reason: alloc.reason || "NO_INVOICE_MATCH",
        skipped: alloc.skipped,
      });
    }
  }

  let paidSynced = 0;
  if (apply && touchedInvoices.length) {
    paidSynced = await syncInvoicePaidFlags(client, touchedInvoices);
  }

  return {
    step: "A_receipt_allocations",
    candidates: receipts.rows.length,
    applied_or_would: appliedRows,
    skipped_no_against_ref: skippedNoBills,
    skipped_no_invoice_match: skippedNoMatch,
    paid_status_synced: paidSynced,
    sample: results.slice(0, 40),
    results_count: results.length,
  };
}

/** B — link remaining invoices to SOs */
async function buildInvoiceSoLinkCandidates(client, { companyId }) {
  const invRes = await client.query(
    `
      select
        ci.id,
        ci.invoice_number,
        ci.tally_voucher_number,
        ci.invoice_date,
        ci.customer_id,
        ci.customer_po_number,
        ci.job_no,
        ci.grand_total_invoice,
        c.customer_name,
        c.customer_code
      from customer_invoices ci
      left join customers c on c.id = ci.customer_id
      where ci.company_id = $1
        and ci.sales_order_id is null
        and ci.invoice_status <> 'cancelled'
      order by ci.invoice_date desc, ci.id desc
    `,
    [companyId]
  );

  const soRes = await client.query(
    `
      select
        so.id,
        so.so_number,
        so.order_date,
        so.order_status,
        so.customer_id,
        so.job_no,
        so.grand_total_order,
        c.customer_name,
        c.customer_code
      from sales_orders so
      left join customers c on c.id = so.customer_id
      where so.company_id = $1
        and lower(so.order_status) <> 'cancelled'
      order by so.order_date asc, so.id asc
    `,
    [companyId]
  );

  const sos = soRes.rows;
  const byNumber = new Map(sos.map((so) => [String(so.so_number || "").trim().toUpperCase(), so]));
  const byCustomer = new Map();
  for (const so of sos) {
    const cid = Number(so.customer_id);
    if (!cid) continue;
    if (!byCustomer.has(cid)) byCustomer.set(cid, []);
    byCustomer.get(cid).push(so);
  }

  const rows = [];
  const review = [];

  for (const inv of invRes.rows) {
    const invKey = String(inv.invoice_number || inv.tally_voucher_number || "").trim();
    if (!invKey) continue;

    // 1) PO number equals SO number
    const po = String(inv.customer_po_number || "").trim();
    if (!isBlankPo(po)) {
      const so = byNumber.get(po.toUpperCase());
      if (so) {
        rows.push({
          invoice_number: invKey,
          so_number: so.so_number,
          customer_po_number: isBlankPo(po) ? null : po,
          customer_po_date: null,
          job_no: normalizeJobNo(inv.job_no) || normalizeJobNo(so.job_no) || null,
          method: "direct_po_is_so",
          confidence: "high",
        });
        continue;
      }
    }

    // 2) Same job_no + same customer
    const job = normalizeJobNo(inv.job_no);
    if (job && inv.customer_id) {
      const matches = (byCustomer.get(Number(inv.customer_id)) || []).filter(
        (so) => normalizeJobNo(so.job_no) === job
      );
      if (matches.length === 1) {
        rows.push({
          invoice_number: invKey,
          so_number: matches[0].so_number,
          customer_po_number: isBlankPo(po) ? null : po,
          customer_po_date: null,
          job_no: job,
          method: "customer_job_no",
          confidence: "high",
        });
        continue;
      }
      if (matches.length > 1) {
        review.push({
          invoice_number: invKey,
          reason: "MULTI_JOB_MATCH",
          candidates: matches.map((m) => m.so_number),
        });
        continue;
      }
    }

    // 3) Same customer + date window [-7, +120]
    if (inv.customer_id && inv.invoice_date) {
      const candidates = (byCustomer.get(Number(inv.customer_id)) || [])
        .map((so) => {
          const delta = daysBetween(inv.invoice_date, so.order_date);
          return { so, delta };
        })
        .filter((row) => row.delta != null && row.delta >= -7 && row.delta <= 120)
        .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));

      if (candidates.length === 1) {
        rows.push({
          invoice_number: invKey,
          so_number: candidates[0].so.so_number,
          customer_po_number: isBlankPo(po) ? null : po,
          customer_po_date: null,
          job_no: normalizeJobNo(inv.job_no) || normalizeJobNo(candidates[0].so.job_no) || null,
          method: "customer_date_unique",
          confidence: "medium",
          date_delta_days: candidates[0].delta,
        });
        continue;
      }
      if (candidates.length > 1) {
        // Prefer confirmed + nearest date if clearly closer
        const best = candidates[0];
        const second = candidates[1];
        if (Math.abs(best.delta) + 14 < Math.abs(second.delta)) {
          rows.push({
            invoice_number: invKey,
            so_number: best.so.so_number,
            customer_po_number: isBlankPo(po) ? null : po,
            customer_po_date: null,
            job_no: normalizeJobNo(inv.job_no) || normalizeJobNo(best.so.job_no) || null,
            method: "customer_date_nearest",
            confidence: "medium",
            date_delta_days: best.delta,
          });
          continue;
        }
        review.push({
          invoice_number: invKey,
          reason: "MULTI_DATE_MATCH",
          candidates: candidates.slice(0, 5).map((c) => ({
            so_number: c.so.so_number,
            delta_days: c.delta,
            job_no: c.so.job_no,
          })),
        });
        continue;
      }
    }

    review.push({
      invoice_number: invKey,
      reason: "NO_MATCH",
      customer_id: inv.customer_id,
      customer_name: inv.customer_name,
      invoice_date: inv.invoice_date,
      customer_po_number: inv.customer_po_number,
      job_no: inv.job_no,
    });
  }

  return { rows, review, unlinked: invRes.rows.length };
}

async function repairInvoiceSoLinks(client, { companyId, apply = false, minConfidence = "medium" } = {}) {
  const { rows, review, unlinked } = await buildInvoiceSoLinkCandidates(client, { companyId });
  const allowed =
    minConfidence === "high"
      ? rows.filter((r) => r.confidence === "high")
      : rows.filter((r) => r.confidence === "high" || r.confidence === "medium");

  if (!apply) {
    return {
      step: "B_invoice_so_links",
      unlinked_invoices: unlinked,
      candidates: allowed.length,
      by_method: allowed.reduce((acc, row) => {
        acc[row.method] = (acc[row.method] || 0) + 1;
        return acc;
      }, {}),
      review_count: review.length,
      sample_links: allowed.slice(0, 30),
      sample_review: review.slice(0, 30),
    };
  }

  const linkResults = await linkInvoicesToSalesOrders(client, { companyId, rows: allowed });
  return {
    step: "B_invoice_so_links",
    unlinked_before: unlinked,
    attempted: allowed.length,
    linked_ok: linkResults.filter((r) => r.ok).length,
    linked_failed: linkResults.filter((r) => !r.ok).length,
    review_remaining_estimate: review.length,
    sample: linkResults.filter((r) => r.ok).slice(0, 30),
    failures: linkResults.filter((r) => !r.ok).slice(0, 20),
  };
}

/** C — backfill SO lines from linked invoices */
async function repairSoLinesFromInvoices(client, { companyId, apply = false, limit = 5000 } = {}) {
  const sos = await client.query(
    `
      select so.id, so.so_number, so.grand_total_order
      from sales_orders so
      where so.company_id = $1
        and lower(so.order_status) <> 'cancelled'
        and not exists (select 1 from sales_order_lines sol where sol.sales_order_id = so.id)
        and exists (
          select 1 from customer_invoices ci
          where ci.sales_order_id = so.id
            and ci.invoice_status <> 'cancelled'
        )
      order by so.id asc
      limit $2
    `,
    [companyId, limit]
  );

  const results = [];
  let would = 0;
  let applied = 0;

  for (const so of sos.rows) {
    const invLines = await client.query(
      `
        select
          ci.id as invoice_id,
          ci.invoice_number,
          ci.subtotal_invoice,
          ci.tax_total_invoice,
          ci.grand_total_invoice,
          il.id as invoice_line_id,
          il.line_no,
          il.product_id,
          il.item_code,
          il.item_name,
          il.line_description,
          il.hsn_no,
          il.customer_item_code,
          il.customer_item_description,
          il.qty,
          il.unit_price_base,
          il.unit_price_invoice,
          il.gst_pct,
          il.line_total_base,
          il.line_total_invoice,
          il.charge_kind
        from customer_invoices ci
        join invoice_lines il on il.customer_invoice_id = ci.id
        where ci.sales_order_id = $1
          and ci.invoice_status <> 'cancelled'
        order by ci.invoice_date asc, ci.id asc, il.line_no asc, il.id asc
      `,
      [so.id]
    );

    if (!invLines.rows.length) {
      results.push({ so_number: so.so_number, ok: false, reason: "NO_INVOICE_LINES" });
      continue;
    }

    const drafts = invLines.rows.map((row, idx) => ({
      line_no: idx + 1,
      product_id: row.product_id,
      item_code: row.item_code,
      item_name: row.item_name || row.item_code || `Line ${idx + 1}`,
      line_description: row.line_description || row.item_name,
      hsn_no: row.hsn_no,
      customer_item_code: row.customer_item_code,
      customer_item_description: row.customer_item_description,
      qty: Number(row.qty) > 0 ? Number(row.qty) : 1,
      unit_price_base: Number(row.unit_price_base || 0),
      unit_price_order: Number(row.unit_price_invoice || 0),
      gst_pct: Number(row.gst_pct || 0),
      line_total_base: Number(row.line_total_base || 0),
      line_total_order: Number(row.line_total_invoice || 0),
      invoice_line_id: row.invoice_line_id,
    }));

    const subtotalOrder = money2(drafts.reduce((s, l) => s + Number(l.line_total_order || 0), 0));
    const taxOrder = money2(
      drafts.reduce((s, l) => s + (Number(l.line_total_order || 0) * Number(l.gst_pct || 0)) / 100, 0)
    );
    const grandOrder = money2(subtotalOrder + taxOrder);
    const subtotalBase = money2(drafts.reduce((s, l) => s + Number(l.line_total_base || 0), 0));
    const taxBase = money2(
      drafts.reduce((s, l) => s + (Number(l.line_total_base || 0) * Number(l.gst_pct || 0)) / 100, 0)
    );
    const grandBase = money2(subtotalBase + taxBase);

    would += 1;
    if (!apply) {
      results.push({
        so_number: so.so_number,
        ok: true,
        would_apply: true,
        line_count: drafts.length,
        grand_total_order: grandOrder,
      });
      continue;
    }

    for (const line of drafts) {
      const ins = await client.query(
        `
          insert into sales_order_lines (
            sales_order_id, line_no, product_id, item_code, item_name, line_description, hsn_no,
            qty, unit_price_base, unit_price_order, gst_pct, line_total_base, line_total_order,
            customer_item_code, customer_item_description
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          returning id
        `,
        [
          so.id,
          line.line_no,
          line.product_id,
          line.item_code,
          line.item_name,
          line.line_description,
          line.hsn_no,
          line.qty,
          line.unit_price_base,
          line.unit_price_order,
          line.gst_pct,
          line.line_total_base,
          line.line_total_order,
          line.customer_item_code,
          line.customer_item_description,
        ]
      );
      const soLineId = ins.rows[0]?.id;
      if (soLineId && line.invoice_line_id) {
        await client.query(
          `update invoice_lines set sales_order_line_id = $2, updated_at = now() where id = $1`,
          [line.invoice_line_id, soLineId]
        );
      }
    }

    await client.query(
      `
        update sales_orders
        set
          subtotal_base = $2,
          subtotal_order = $3,
          tax_total_base = $4,
          tax_total_order = $5,
          grand_total_base = $6,
          grand_total_order = $7,
          updated_at = now()
        where id = $1
      `,
      [so.id, subtotalBase, subtotalOrder, taxBase, taxOrder, grandBase, grandOrder]
    );

    applied += 1;
    results.push({
      so_number: so.so_number,
      ok: true,
      line_count: drafts.length,
      grand_total_order: grandOrder,
    });
  }

  return {
    step: "C_so_lines_backfill",
    shell_sos_with_invoices: sos.rows.length,
    applied_or_would: apply ? applied : would,
    sample: results.slice(0, 40),
    results_count: results.length,
  };
}

async function runO2cRepairs(client, { companyId, apply = false, steps = ["A", "B", "C"] } = {}) {
  const out = {};
  const set = new Set(steps.map((s) => String(s).toUpperCase()));
  if (set.has("A") || set.has("ALL")) {
    out.A = await repairReceiptAllocations(client, { companyId, apply });
  }
  if (set.has("B") || set.has("ALL")) {
    out.B = await repairInvoiceSoLinks(client, { companyId, apply });
  }
  if (set.has("C") || set.has("ALL")) {
    // Re-run C after B so newly linked invoices can feed lines
    out.C = await repairSoLinesFromInvoices(client, { companyId, apply });
  }
  return out;
}

module.exports = {
  resolveCompanyId,
  repairReceiptAllocations,
  repairInvoiceSoLinks,
  repairSoLinesFromInvoices,
  buildInvoiceSoLinkCandidates,
  runO2cRepairs,
};
