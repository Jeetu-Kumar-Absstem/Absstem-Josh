const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { generateQuotePdfBuffer } = require("../pdf/quotePdf");
const { renderVendorStatementHtml } = require("../pdf/receiptPdf");
const { enrichCompanyProfileAssets, getCompanyProfile } = require("../services/companyProfile");
const { getActiveCompanyId } = require("../services/companyContext");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(2));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value, fallback = 100, max = 300) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

async function getVendorHeaderOrNull(client, vendorId, companyId) {
  const r = await client.query(
    `
      select
        v.*
      from vendors v
      where v.id = $1
        and v.company_id = $2
      limit 1
    `,
    [vendorId, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getAgeingSummary(client, companyId, { currencyId = null } = {}) {
  const params = [Number(companyId)];
  const where = [`pi.invoice_status <> 'cancelled'`, `pi.company_id = $1`];
  if (Number.isFinite(Number(currencyId)) && Number(currencyId) > 0) {
    params.push(Number(currencyId));
    where.push(`pi.invoice_currency_id = $${params.length}`);
  }

  const r = await client.query(
    `
      with posted_payments as (
        select
          vpa.purchase_invoice_id,
          coalesce(sum(vpa.allocated_amount), 0) as allocated_amount
        from vendor_payment_allocations vpa
        join vendor_payments vp on vp.id = vpa.vendor_payment_id
        where vp.payment_status = 'posted'
          and vp.company_id = $1
        group by vpa.purchase_invoice_id
      ),
      posted_returns as (
        select
          pr.purchase_invoice_id,
          coalesce(sum(pr.grand_total_invoice), 0) as debit_note_amount
        from purchase_returns pr
        where pr.return_status = 'posted'
          and pr.purchase_invoice_id is not null
          and pr.company_id = $1
        group by pr.purchase_invoice_id
      ),
      invoice_ageing as (
        select
          pi.id,
          pi.vendor_id,
          v.company_name as vendor_name,
          pi.purchase_invoice_number,
          pi.invoice_date,
          curr.currency_code as invoice_currency_code,
          pi.grand_total_invoice,
          coalesce(pp.allocated_amount, 0) as allocated_amount,
          coalesce(prt.debit_note_amount, 0) as debit_note_amount,
          (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pp.allocated_amount, 0)) as outstanding_invoice,
          greatest((current_date - pi.invoice_date::date), 0) as ageing_days
        from purchase_invoices pi
        join vendors v on v.id = pi.vendor_id and v.company_id = pi.company_id
        left join posted_payments pp on pp.purchase_invoice_id = pi.id
        left join posted_returns prt on prt.purchase_invoice_id = pi.id
        left join currencies curr on curr.id = pi.invoice_currency_id
        where ${where.join(" and ")}
      )
      select *
      from invoice_ageing
      where outstanding_invoice > 0.0001
      order by ageing_days desc, invoice_date asc, id asc
    `,
    params
  );

  const invoiceRows = r.rows.map((row) => ({
    ...row,
    outstanding_invoice: money(row.outstanding_invoice),
    allocated_amount: money(row.allocated_amount),
    debit_note_amount: money(row.debit_note_amount),
  }));

  const vendorMap = new Map();
  for (const row of invoiceRows) {
    const key = Number(row.vendor_id);
    if (!vendorMap.has(key)) {
      vendorMap.set(key, {
        vendor_id: key,
        vendor_name: row.vendor_name,
        current_bucket: 0,
        bucket_31_60: 0,
        bucket_61_90: 0,
        bucket_90_plus: 0,
        total_outstanding: 0,
      });
    }
    const item = vendorMap.get(key);
    const amount = qty(row.outstanding_invoice);
    item.total_outstanding = money(item.total_outstanding + amount);
    if (qty(row.ageing_days) <= 30) item.current_bucket = money(item.current_bucket + amount);
    else if (qty(row.ageing_days) <= 60) item.bucket_31_60 = money(item.bucket_31_60 + amount);
    else if (qty(row.ageing_days) <= 90) item.bucket_61_90 = money(item.bucket_61_90 + amount);
    else item.bucket_90_plus = money(item.bucket_90_plus + amount);
  }

  return {
    ageing_vendors: Array.from(vendorMap.values()).sort((a, b) => qty(b.total_outstanding) - qty(a.total_outstanding)),
    ageing_invoices: invoiceRows,
  };
}

async function getVendorStatementData(client, companyId, vendorId, { currencyId = null } = {}) {
  const vendor = await getVendorHeaderOrNull(client, vendorId, companyId);
  if (!vendor) return null;

  const params = [Number(vendorId), Number(companyId)];
  let invoiceCurrencyFilter = "";
  let paymentCurrencyFilter = "";
  let returnCurrencyFilter = "";
  if (Number.isFinite(Number(currencyId)) && Number(currencyId) > 0) {
    params.push(Number(currencyId));
    invoiceCurrencyFilter = ` and pi.invoice_currency_id = $${params.length}`;
    paymentCurrencyFilter = ` and vp.payment_currency_id = $${params.length}`;
    returnCurrencyFilter = ` and pr.return_currency_id = $${params.length}`;
  }

  const [invoiceRowsRes, paymentRowsRes, returnRowsRes] = await Promise.all([
    client.query(
      `
        select
          pi.invoice_date as txn_date,
          'Invoice'::text as txn_type,
          pi.purchase_invoice_number as reference_no,
          (case when pi.purchase_order_id is not null then ('Purchase Order ' || coalesce(po.po_number, '—')) else 'Manual Purchase Invoice' end) as description,
          pi.grand_total_invoice as debit,
          0::numeric as credit,
          curr.currency_code as currency_code
        from purchase_invoices pi
        left join purchase_orders po on po.id = pi.purchase_order_id
        left join currencies curr on curr.id = pi.invoice_currency_id
        where pi.vendor_id = $1
          and pi.company_id = $2
          and pi.invoice_status <> 'cancelled'
          ${invoiceCurrencyFilter}
      `,
      params
    ),
    client.query(
      `
        select
          vp.payment_date as txn_date,
          'Payment'::text as txn_type,
          vp.payment_number as reference_no,
          coalesce(vp.payment_mode, 'Vendor Payment') as description,
          0::numeric as debit,
          vp.payment_amount as credit,
          curr.currency_code as currency_code
        from vendor_payments vp
        left join currencies curr on curr.id = vp.payment_currency_id
        where vp.vendor_id = $1
          and vp.company_id = $2
          and vp.payment_status = 'posted'
          ${paymentCurrencyFilter}
      `,
      params
    ),
    client.query(
      `
        select
          pr.return_date as txn_date,
          'Debit Note'::text as txn_type,
          coalesce(pr.debit_note_number, pr.return_number) as reference_no,
          coalesce(pr.remarks, 'Purchase Return / Debit Note') as description,
          0::numeric as debit,
          pr.grand_total_invoice as credit,
          curr.currency_code as currency_code
        from purchase_returns pr
        left join currencies curr on curr.id = pr.return_currency_id
        where pr.vendor_id = $1
          and pr.company_id = $2
          and pr.return_status = 'posted'
          ${returnCurrencyFilter}
      `,
      params
    ),
  ]);

  const rows = [...invoiceRowsRes.rows, ...paymentRowsRes.rows, ...returnRowsRes.rows]
    .map((row) => ({
      ...row,
      debit: money(row.debit),
      credit: money(row.credit),
    }))
    .sort((a, b) => {
      const aDate = new Date(a.txn_date || 0).getTime();
      const bDate = new Date(b.txn_date || 0).getTime();
      if (aDate !== bDate) return aDate - bDate;
      return String(a.reference_no || "").localeCompare(String(b.reference_no || ""));
    });

  let runningBalance = 0;
  const statementRows = rows.map((row) => {
    runningBalance = money(runningBalance + qty(row.debit) - qty(row.credit));
    return {
      ...row,
      running_balance: runningBalance,
    };
  });

  const currencyCodes = Array.from(new Set(statementRows.map((row) => String(row.currency_code || "").trim()).filter(Boolean)));
  const currencyLabel = currencyCodes.length === 1 ? currencyCodes[0] : currencyCodes.length ? "Mixed" : "INR";

  return {
    vendor,
    statementRows,
    summary: {
      total_invoiced: money(statementRows.reduce((sum, row) => sum + qty(row.debit), 0)),
      total_paid: money(statementRows.reduce((sum, row) => sum + qty(row.credit), 0)),
      outstanding: money(statementRows.length ? statementRows[statementRows.length - 1].running_balance : 0),
    },
    currencyLabel,
    asOfDate: new Date(),
  };
}

async function getVendorReconciliationSummary(client, companyId, { currencyId = null } = {}) {
  const params = [Number(companyId)];
  const invoiceWhere = [`pi.company_id = $1`, `pi.invoice_status = 'posted'`];
  const paymentWhere = [`vp.company_id = $1`, `vp.payment_status = 'posted'`];
  const activePaymentWhere = [`vp.company_id = $1`, `vp.payment_status in ('draft', 'submitted', 'approved')`];
  const returnWhere = [`pr.company_id = $1`, `pr.return_status = 'posted'`];

  if (Number.isFinite(Number(currencyId)) && Number(currencyId) > 0) {
    params.push(Number(currencyId));
    invoiceWhere.push(`pi.invoice_currency_id = $${params.length}`);
    paymentWhere.push(`vp.payment_currency_id = $${params.length}`);
    activePaymentWhere.push(`vp.payment_currency_id = $${params.length}`);
    returnWhere.push(`pr.return_currency_id = $${params.length}`);
  }

  const r = await client.query(
    `
      with posted_allocations as (
        select
          vpa.purchase_invoice_id,
          coalesce(sum(vpa.allocated_amount), 0) as allocated_amount
        from vendor_payment_allocations vpa
        join vendor_payments vp on vp.id = vpa.vendor_payment_id
        where vp.company_id = $1
          and vp.payment_status = 'posted'
        group by vpa.purchase_invoice_id
      ),
      posted_returns as (
        select
          pr.purchase_invoice_id,
          coalesce(sum(pr.grand_total_invoice), 0) as debit_note_amount
        from purchase_returns pr
        where pr.company_id = $1
          and pr.return_status = 'posted'
          and pr.purchase_invoice_id is not null
        group by pr.purchase_invoice_id
      ),
      recent_posted_payments as (
        select
          vp.vendor_id,
          vp.payment_currency_id as currency_id,
          count(*)::int as recent_posted_payment_count,
          coalesce(sum(vp.payment_amount), 0) as recent_posted_payment_amount
        from vendor_payments vp
        where ${paymentWhere.join(" and ")}
          and vp.payment_date >= current_date - interval '30 days'
        group by vp.vendor_id, vp.payment_currency_id
      ),
      active_payments as (
        select
          vp.vendor_id,
          vp.payment_currency_id as currency_id,
          count(*)::int as active_payment_count,
          count(*) filter (where vp.payment_status = 'draft')::int as draft_payment_count,
          count(*) filter (where vp.payment_status = 'submitted')::int as submitted_payment_count,
          count(*) filter (where vp.payment_status = 'approved')::int as approved_payment_count,
          coalesce(sum(vp.payment_amount), 0) as active_payment_amount
        from vendor_payments vp
        where ${activePaymentWhere.join(" and ")}
        group by vp.vendor_id, vp.payment_currency_id
      ),
      recent_posted_returns as (
        select
          pr.vendor_id,
          pr.return_currency_id as currency_id,
          count(*)::int as recent_debit_note_count,
          coalesce(sum(pr.grand_total_invoice), 0) as recent_debit_note_amount
        from purchase_returns pr
        where ${returnWhere.join(" and ")}
          and pr.return_date >= current_date - interval '60 days'
        group by pr.vendor_id, pr.return_currency_id
      ),
      grn_posted as (
        select
          grl.purchase_order_line_id,
          coalesce(sum(grl.qty_received), 0) as qty_received_posted
        from goods_receipt_lines grl
        join goods_receipts gr on gr.id = grl.goods_receipt_id
        where gr.company_id = $1
          and gr.receipt_status = 'posted'
          and grl.purchase_order_line_id is not null
        group by grl.purchase_order_line_id
      ),
      inv_posted as (
        select
          pil.purchase_order_line_id,
          coalesce(sum(pil.qty), 0) as qty_invoiced_posted
        from purchase_invoice_lines pil
        join purchase_invoices pi2 on pi2.id = pil.purchase_invoice_id
        where pi2.company_id = $1
          and pi2.invoice_status = 'posted'
          and pil.purchase_order_line_id is not null
        group by pil.purchase_order_line_id
      ),
      po_match as (
        select
          pol.purchase_order_id,
          bool_or(coalesce(grn.qty_received_posted, 0) > coalesce(pol.qty, 0) or coalesce(inv.qty_invoiced_posted, 0) > coalesce(grn.qty_received_posted, 0)) as is_qty_mismatch
        from purchase_order_lines pol
        left join grn_posted grn on grn.purchase_order_line_id = pol.id
        left join inv_posted inv on inv.purchase_order_line_id = pol.id
        group by pol.purchase_order_id
      ),
      invoice_ageing as (
        select
          pi.vendor_id,
          pi.invoice_currency_id as currency_id,
          (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pa.allocated_amount, 0)) as outstanding_invoice,
          greatest((current_date - pi.invoice_date::date), 0)::int as ageing_days,
          coalesce(pm.is_qty_mismatch, false) as is_match_blocked
        from purchase_invoices pi
        left join posted_allocations pa on pa.purchase_invoice_id = pi.id
        left join posted_returns prt on prt.purchase_invoice_id = pi.id
        left join po_match pm on pm.purchase_order_id = pi.purchase_order_id
        where ${invoiceWhere.join(" and ")}
          and (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pa.allocated_amount, 0)) > 0.0001
      ),
      vendor_groups as (
        select
          ia.vendor_id,
          ia.currency_id,
          count(*)::int as open_invoice_count,
          count(*) filter (where ia.ageing_days > 30)::int as overdue_invoice_count,
          coalesce(sum(ia.outstanding_invoice), 0) as total_outstanding_amount,
          coalesce(sum(case when ia.ageing_days > 30 then ia.outstanding_invoice else 0 end), 0) as overdue_amount,
          coalesce(sum(case when ia.is_match_blocked then ia.outstanding_invoice else 0 end), 0) as blocked_match_amount
        from invoice_ageing ia
        group by ia.vendor_id, ia.currency_id
      ),
      combined as (
        select
          vg.vendor_id,
          vg.currency_id,
          vg.open_invoice_count,
          vg.overdue_invoice_count,
          vg.total_outstanding_amount,
          vg.overdue_amount,
          vg.blocked_match_amount,
          coalesce(rpp.recent_posted_payment_count, 0) as recent_posted_payment_count,
          coalesce(rpp.recent_posted_payment_amount, 0) as recent_posted_payment_amount,
          coalesce(rpr.recent_debit_note_count, 0) as recent_debit_note_count,
          coalesce(rpr.recent_debit_note_amount, 0) as recent_debit_note_amount,
          coalesce(ap.active_payment_count, 0) as active_payment_count,
          coalesce(ap.active_payment_amount, 0) as active_payment_amount
        from vendor_groups vg
        left join recent_posted_payments rpp
          on rpp.vendor_id = vg.vendor_id
         and rpp.currency_id = vg.currency_id
        left join recent_posted_returns rpr
          on rpr.vendor_id = vg.vendor_id
         and rpr.currency_id = vg.currency_id
        left join active_payments ap
          on ap.vendor_id = vg.vendor_id
         and ap.currency_id = vg.currency_id
      )
      select
        count(*)::int as total_vendor_buckets,
        coalesce(sum(total_outstanding_amount), 0) as total_outstanding_amount,
        count(*) filter (
          where overdue_amount > 0.0001
            and recent_posted_payment_amount <= 0.0001
            and recent_debit_note_amount <= 0.0001
            and active_payment_count = 0
            and blocked_match_amount <= 0.0001
        )::int as overdue_no_action_vendors,
        coalesce(sum(case
          when overdue_amount > 0.0001
            and recent_posted_payment_amount <= 0.0001
            and recent_debit_note_amount <= 0.0001
            and active_payment_count = 0
            and blocked_match_amount <= 0.0001
          then overdue_amount else 0 end), 0) as overdue_no_action_amount,
        count(*) filter (where recent_posted_payment_amount > 0.0001)::int as payment_gap_vendors,
        coalesce(sum(case when recent_posted_payment_amount > 0.0001 then recent_posted_payment_amount else 0 end), 0) as payment_gap_amount,
        count(*) filter (where recent_debit_note_amount > 0.0001)::int as debit_note_gap_vendors,
        coalesce(sum(case when recent_debit_note_amount > 0.0001 then recent_debit_note_amount else 0 end), 0) as debit_note_gap_amount,
        count(*) filter (where active_payment_count > 0)::int as active_settlement_vendors,
        coalesce(sum(case when active_payment_count > 0 then active_payment_amount else 0 end), 0) as active_settlement_amount,
        count(*) filter (where blocked_match_amount > 0.0001)::int as match_blocked_vendors,
        coalesce(sum(case when blocked_match_amount > 0.0001 then blocked_match_amount else 0 end), 0) as match_blocked_amount
      from combined
    `,
    params
  );

  const row = r.rows[0] || {};
  return {
    total_vendor_buckets: Number(row.total_vendor_buckets || 0),
    total_outstanding_amount: money(row.total_outstanding_amount),
    overdue_no_action_vendors: Number(row.overdue_no_action_vendors || 0),
    overdue_no_action_amount: money(row.overdue_no_action_amount),
    payment_gap_vendors: Number(row.payment_gap_vendors || 0),
    payment_gap_amount: money(row.payment_gap_amount),
    debit_note_gap_vendors: Number(row.debit_note_gap_vendors || 0),
    debit_note_gap_amount: money(row.debit_note_gap_amount),
    active_settlement_vendors: Number(row.active_settlement_vendors || 0),
    active_settlement_amount: money(row.active_settlement_amount),
    match_blocked_vendors: Number(row.match_blocked_vendors || 0),
    match_blocked_amount: money(row.match_blocked_amount),
  };
}

async function getVendorReconciliationQueue(client, companyId, { currencyId = null, bucket = "overdue_no_action", q = "", limit = 120 } = {}) {
  const normalizedBucket = normalizeText(bucket).toLowerCase() || "overdue_no_action";
  const normalizedQuery = normalizeText(q);
  const normalizedLimit = normalizeLimit(limit, 120, 300);

  const params = [Number(companyId)];
  const invoiceWhere = [`pi.company_id = $1`, `pi.invoice_status = 'posted'`];
  const paymentWhere = [`vp.company_id = $1`, `vp.payment_status = 'posted'`];
  const activePaymentWhere = [`vp.company_id = $1`, `vp.payment_status in ('draft', 'submitted', 'approved')`];
  const returnWhere = [`pr.company_id = $1`, `pr.return_status = 'posted'`];

  if (Number.isFinite(Number(currencyId)) && Number(currencyId) > 0) {
    params.push(Number(currencyId));
    invoiceWhere.push(`pi.invoice_currency_id = $${params.length}`);
    paymentWhere.push(`vp.payment_currency_id = $${params.length}`);
    activePaymentWhere.push(`vp.payment_currency_id = $${params.length}`);
    returnWhere.push(`pr.return_currency_id = $${params.length}`);
  }

  if (normalizedQuery) {
    params.push(`%${normalizedQuery}%`);
    invoiceWhere.push(`(v.company_name ilike $${params.length} or pi.purchase_invoice_number ilike $${params.length})`);
  }

  let finalFilter = `
    overdue_amount > 0.0001
    and recent_posted_payment_amount <= 0.0001
    and recent_debit_note_amount <= 0.0001
    and active_payment_count = 0
    and blocked_match_amount <= 0.0001
  `;
  if (normalizedBucket === "payment_gap") {
    finalFilter = `recent_posted_payment_amount > 0.0001`;
  } else if (normalizedBucket === "debit_note_gap") {
    finalFilter = `recent_debit_note_amount > 0.0001`;
  } else if (normalizedBucket === "active_settlement") {
    finalFilter = `active_payment_count > 0`;
  } else if (normalizedBucket === "match_blocked") {
    finalFilter = `blocked_match_amount > 0.0001`;
  } else if (normalizedBucket === "all") {
    finalFilter = `total_outstanding_amount > 0.0001`;
  }

  const r = await client.query(
    `
      with posted_allocations as (
        select
          vpa.purchase_invoice_id,
          coalesce(sum(vpa.allocated_amount), 0) as allocated_amount
        from vendor_payment_allocations vpa
        join vendor_payments vp on vp.id = vpa.vendor_payment_id
        where vp.company_id = $1
          and vp.payment_status = 'posted'
        group by vpa.purchase_invoice_id
      ),
      posted_returns as (
        select
          pr.purchase_invoice_id,
          coalesce(sum(pr.grand_total_invoice), 0) as debit_note_amount
        from purchase_returns pr
        where pr.company_id = $1
          and pr.return_status = 'posted'
          and pr.purchase_invoice_id is not null
        group by pr.purchase_invoice_id
      ),
      recent_posted_payments as (
        select
          vp.vendor_id,
          vp.payment_currency_id as currency_id,
          count(*)::int as recent_posted_payment_count,
          coalesce(sum(vp.payment_amount), 0) as recent_posted_payment_amount,
          max(vp.payment_date) as latest_payment_date
        from vendor_payments vp
        where ${paymentWhere.join(" and ")}
          and vp.payment_date >= current_date - interval '30 days'
        group by vp.vendor_id, vp.payment_currency_id
      ),
      active_payments as (
        select
          vp.vendor_id,
          vp.payment_currency_id as currency_id,
          count(*)::int as active_payment_count,
          count(*) filter (where vp.payment_status = 'draft')::int as draft_payment_count,
          count(*) filter (where vp.payment_status = 'submitted')::int as submitted_payment_count,
          count(*) filter (where vp.payment_status = 'approved')::int as approved_payment_count,
          coalesce(sum(vp.payment_amount), 0) as active_payment_amount
        from vendor_payments vp
        where ${activePaymentWhere.join(" and ")}
        group by vp.vendor_id, vp.payment_currency_id
      ),
      recent_posted_returns as (
        select
          pr.vendor_id,
          pr.return_currency_id as currency_id,
          count(*)::int as recent_debit_note_count,
          coalesce(sum(pr.grand_total_invoice), 0) as recent_debit_note_amount,
          max(pr.return_date) as latest_debit_note_date
        from purchase_returns pr
        where ${returnWhere.join(" and ")}
          and pr.return_date >= current_date - interval '60 days'
        group by pr.vendor_id, pr.return_currency_id
      ),
      grn_posted as (
        select
          grl.purchase_order_line_id,
          coalesce(sum(grl.qty_received), 0) as qty_received_posted
        from goods_receipt_lines grl
        join goods_receipts gr on gr.id = grl.goods_receipt_id
        where gr.company_id = $1
          and gr.receipt_status = 'posted'
          and grl.purchase_order_line_id is not null
        group by grl.purchase_order_line_id
      ),
      inv_posted as (
        select
          pil.purchase_order_line_id,
          coalesce(sum(pil.qty), 0) as qty_invoiced_posted
        from purchase_invoice_lines pil
        join purchase_invoices pi2 on pi2.id = pil.purchase_invoice_id
        where pi2.company_id = $1
          and pi2.invoice_status = 'posted'
          and pil.purchase_order_line_id is not null
        group by pil.purchase_order_line_id
      ),
      po_match as (
        select
          pol.purchase_order_id,
          bool_or(coalesce(grn.qty_received_posted, 0) > coalesce(pol.qty, 0) or coalesce(inv.qty_invoiced_posted, 0) > coalesce(grn.qty_received_posted, 0)) as is_qty_mismatch
        from purchase_order_lines pol
        left join grn_posted grn on grn.purchase_order_line_id = pol.id
        left join inv_posted inv on inv.purchase_order_line_id = pol.id
        group by pol.purchase_order_id
      ),
      invoice_ageing as (
        select
          pi.id,
          pi.vendor_id,
          v.company_name as vendor_name,
          pi.purchase_invoice_number,
          pi.invoice_date,
          pi.purchase_order_id,
          pi.invoice_currency_id as currency_id,
          curr.currency_code,
          (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pa.allocated_amount, 0)) as outstanding_invoice,
          greatest((current_date - pi.invoice_date::date), 0)::int as ageing_days,
          coalesce(pm.is_qty_mismatch, false) as is_match_blocked
        from purchase_invoices pi
        join vendors v on v.id = pi.vendor_id and v.company_id = pi.company_id
        left join currencies curr on curr.id = pi.invoice_currency_id
        left join posted_allocations pa on pa.purchase_invoice_id = pi.id
        left join posted_returns prt on prt.purchase_invoice_id = pi.id
        left join po_match pm on pm.purchase_order_id = pi.purchase_order_id
        where ${invoiceWhere.join(" and ")}
          and (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pa.allocated_amount, 0)) > 0.0001
      ),
      vendor_groups as (
        select
          ia.vendor_id,
          ia.vendor_name,
          ia.currency_id,
          ia.currency_code,
          count(*)::int as open_invoice_count,
          count(*) filter (where ia.ageing_days > 30)::int as overdue_invoice_count,
          coalesce(sum(ia.outstanding_invoice), 0) as total_outstanding_amount,
          coalesce(sum(case when ia.ageing_days > 30 then ia.outstanding_invoice else 0 end), 0) as overdue_amount,
          coalesce(sum(case when ia.is_match_blocked then ia.outstanding_invoice else 0 end), 0) as blocked_match_amount,
          coalesce(max(ia.ageing_days), 0)::int as oldest_ageing_days,
          min(ia.id) as oldest_invoice_id,
          min(ia.invoice_date) as oldest_invoice_date,
          min(ia.purchase_invoice_number) as oldest_invoice_number
        from invoice_ageing ia
        group by ia.vendor_id, ia.vendor_name, ia.currency_id, ia.currency_code
      )
      select
        vg.vendor_id,
        vg.vendor_name,
        vg.currency_id,
        vg.currency_code,
        vg.open_invoice_count,
        vg.overdue_invoice_count,
        round(vg.total_outstanding_amount::numeric, 2) as total_outstanding_amount,
        round(vg.overdue_amount::numeric, 2) as overdue_amount,
        round(vg.blocked_match_amount::numeric, 2) as blocked_match_amount,
        vg.oldest_ageing_days,
        vg.oldest_invoice_id,
        vg.oldest_invoice_date,
        vg.oldest_invoice_number,
        coalesce(rpp.recent_posted_payment_count, 0) as recent_posted_payment_count,
        round(coalesce(rpp.recent_posted_payment_amount, 0)::numeric, 2) as recent_posted_payment_amount,
        rpp.latest_payment_date,
        coalesce(rpr.recent_debit_note_count, 0) as recent_debit_note_count,
        round(coalesce(rpr.recent_debit_note_amount, 0)::numeric, 2) as recent_debit_note_amount,
        rpr.latest_debit_note_date,
        coalesce(ap.active_payment_count, 0) as active_payment_count,
        coalesce(ap.draft_payment_count, 0) as draft_payment_count,
        coalesce(ap.submitted_payment_count, 0) as submitted_payment_count,
        coalesce(ap.approved_payment_count, 0) as approved_payment_count,
        round(coalesce(ap.active_payment_amount, 0)::numeric, 2) as active_payment_amount
      from vendor_groups vg
      left join recent_posted_payments rpp
        on rpp.vendor_id = vg.vendor_id
       and rpp.currency_id = vg.currency_id
      left join recent_posted_returns rpr
        on rpr.vendor_id = vg.vendor_id
       and rpr.currency_id = vg.currency_id
      left join active_payments ap
        on ap.vendor_id = vg.vendor_id
       and ap.currency_id = vg.currency_id
      where ${finalFilter}
      order by
        vg.overdue_amount desc,
        coalesce(rpp.recent_posted_payment_amount, 0) desc,
        coalesce(rpr.recent_debit_note_amount, 0) desc,
        vg.blocked_match_amount desc,
        coalesce(ap.active_payment_amount, 0) desc,
        vg.vendor_name asc
      limit ${normalizedLimit}
    `,
    params
  );

  return {
    bucket: normalizedBucket,
    rows: r.rows.map((row) => ({
      ...row,
      total_outstanding_amount: money(row.total_outstanding_amount),
      overdue_amount: money(row.overdue_amount),
      blocked_match_amount: money(row.blocked_match_amount),
      recent_posted_payment_amount: money(row.recent_posted_payment_amount),
      recent_debit_note_amount: money(row.recent_debit_note_amount),
      active_payment_amount: money(row.active_payment_amount),
    })),
  };
}

router.get("/", requireScreenAction("vendor_statement", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const currencyId = Number(req.query.currency_id);
    const normalizedCurrencyId = Number.isFinite(currencyId) && currencyId > 0 ? currencyId : null;

    const [vendorsRes, currenciesRes, ageing] = await Promise.all([
      pool.query(
        `
          select id, vendor_code, company_name
          from vendors
          where company_id = $1
            and is_active = true
          order by company_name asc, id asc
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, currency_code
          from currencies
          where is_active = true
          order by currency_code asc, id asc
        `
      ),
      getAgeingSummary(pool, companyId, { currencyId: normalizedCurrencyId }),
    ]);

    return res.json({
      ok: true,
      vendors: vendorsRes.rows,
      currencies: currenciesRes.rows,
      ...ageing,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/reconciliation-summary", requireScreenAction("vendor_statement", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const currencyId = Number(req.query.currency_id);
    const normalizedCurrencyId = Number.isFinite(currencyId) && currencyId > 0 ? currencyId : null;
    const summary = await getVendorReconciliationSummary(pool, companyId, { currencyId: normalizedCurrencyId });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/reconciliation-queue", requireScreenAction("vendor_statement", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const currencyId = Number(req.query.currency_id);
    const normalizedCurrencyId = Number.isFinite(currencyId) && currencyId > 0 ? currencyId : null;
    const queue = await getVendorReconciliationQueue(pool, companyId, {
      currencyId: normalizedCurrencyId,
      bucket: req.query.bucket,
      q: req.query.q,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...queue });
  } catch (err) {
    return next(err);
  }
});

router.get("/vendor/:vendorId/statement", requireScreenAction("vendor_statement", "can_view"), async (req, res, next) => {
  try {
    const vendorId = Number(req.params.vendorId);
    if (!Number.isFinite(vendorId) || vendorId <= 0) return res.status(400).json({ ok: false });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const currencyId = Number(req.query.currency_id);
    const normalizedCurrencyId = Number.isFinite(currencyId) && currencyId > 0 ? currencyId : null;

    const statement = await getVendorStatementData(pool, companyId, vendorId, { currencyId: normalizedCurrencyId });
    if (!statement) return res.status(404).json({ ok: false });

    return res.json({ ok: true, ...statement });
  } catch (err) {
    return next(err);
  }
});

router.get("/vendor/:vendorId/statement/pdf", requireScreenAction("vendor_statement", "can_view"), async (req, res, next) => {
  try {
    const vendorId = Number(req.params.vendorId);
    if (!Number.isFinite(vendorId) || vendorId <= 0) return res.status(400).json({ ok: false });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const currencyId = Number(req.query.currency_id);
    const normalizedCurrencyId = Number.isFinite(currencyId) && currencyId > 0 ? currencyId : null;

    const statement = await getVendorStatementData(pool, companyId, vendorId, { currencyId: normalizedCurrencyId });
    if (!statement) return res.status(404).json({ ok: false });

    const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(pool, companyId));
    const pdf = await generateQuotePdfBuffer(
      renderVendorStatementHtml({
        vendor: statement.vendor,
        statementRows: statement.statementRows,
        summary: statement.summary,
        sellerProfile,
        asOfDate: statement.asOfDate,
        currencyLabel: statement.currencyLabel,
      })
    );

    const safeName = String(statement.vendor.company_name || "Vendor").replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}_Statement.pdf"`);
    return res.send(pdf);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
