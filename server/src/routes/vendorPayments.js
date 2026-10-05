const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { evaluateApprovalPermission, insertApprovalHistory, resolveApprovalState } = require("../services/approvalPolicy");
const { getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { notifyMatchBlocked } = require("../services/notifications");

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

function canAccessVendorPayment(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "vendor_payments")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function getDefaultCurrencyId(client) {
  const r = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
  const id = Number(r.rows[0]?.id);
  if (Number.isFinite(id) && id > 0) return id;
  const fallback = await client.query(`select id from currencies where is_active = true order by currency_code asc limit 1`);
  const fallbackId = Number(fallback.rows[0]?.id);
  return Number.isFinite(fallbackId) && fallbackId > 0 ? fallbackId : null;
}

async function getVendorTdsProfile(client, vendorId, companyId) {
  const r = await client.query(
    `
      select
        v.id,
        v.pan_no,
        v.tds_enabled,
        v.tds_exempt,
        v.lower_deduction_rate,
        v.tds_section_id,
        ts.section_code,
        ts.section_name,
        ts.default_rate,
        ts.threshold_amount
      from vendors v
      left join tds_sections ts on ts.id = v.tds_section_id
      where v.id = $1
        and v.company_id = $2
      limit 1
    `,
    [vendorId, Number(companyId)]
  );
  return r.rows[0] || null;
}

function deriveTdsValues(profile, baseAmount, override = {}) {
  const effectiveBase = money(override.tds_base_amount ?? baseAmount);
  const sectionId =
    override.tds_section_id === undefined || override.tds_section_id === null || override.tds_section_id === ""
      ? Number(profile?.tds_section_id || 0) || null
      : Number(override.tds_section_id);
  const configuredRate = qty(profile?.lower_deduction_rate) > 0 ? qty(profile.lower_deduction_rate) : qty(profile?.default_rate);
  const rate = qty(override.tds_rate ?? configuredRate);
  const thresholdAmount = qty(profile?.threshold_amount);
  const enabled = Boolean(profile?.tds_enabled) && !Boolean(profile?.tds_exempt) && effectiveBase > 0 && effectiveBase >= thresholdAmount;
  const tdsAmount = enabled ? money((effectiveBase * rate) / 100) : 0;
  return {
    tds_section_id: Number.isFinite(Number(sectionId)) && Number(sectionId) > 0 ? Number(sectionId) : null,
    tds_base_amount: effectiveBase,
    tds_rate: enabled ? rate : 0,
    tds_amount: tdsAmount,
  };
}

async function getVendorPaymentHeaderOrNull(client, paymentId, companyId) {
  const r = await client.query(
    `
      select
        vp.*,
        v.vendor_code,
        v.company_name as vendor_name,
        v.pan_no,
        curr.currency_code as payment_currency_code,
        fb.book_name as finance_book_name,
        ts.section_code as tds_section_code,
        ts.section_name as tds_section_name
      from vendor_payments vp
      join vendors v on v.id = vp.vendor_id and v.company_id = vp.company_id
      left join currencies curr on curr.id = vp.payment_currency_id
      left join finance_books fb on fb.id = vp.finance_book_id
      left join tds_sections ts on ts.id = vp.tds_section_id
      where vp.id = $1 and vp.company_id = $2
      limit 1
    `,
    [paymentId, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getPaymentAllocations(client, companyId, paymentId, { excludePaymentId = null } = {}) {
  const outstandingMap = await getVendorInvoiceOutstandingMap(client, companyId, { excludePaymentId });
  const r = await client.query(
    `
      select
        vpa.*,
        pi.purchase_invoice_number,
        pi.invoice_date,
        pi.invoice_status,
        pi.grand_total_invoice,
        curr.currency_code as invoice_currency_code
      from vendor_payment_allocations vpa
      join purchase_invoices pi on pi.id = vpa.purchase_invoice_id
      left join currencies curr on curr.id = pi.invoice_currency_id
      where vpa.vendor_payment_id = $1 and pi.company_id = $2
      order by pi.invoice_date asc, pi.id asc
    `,
    [paymentId, Number(companyId)]
  );

  return r.rows.map((row) => {
    const outstanding = outstandingMap.get(Number(row.purchase_invoice_id)) || {
      allocated: 0,
      outstanding: qty(row.grand_total_invoice),
    };
    return {
      ...row,
      invoice_total: qty(row.grand_total_invoice),
      invoice_allocated_before_current: money(outstanding.allocated),
      invoice_debit_note_before_current: money(outstanding.debit_note_amount),
      invoice_outstanding_before_current: money(outstanding.outstanding),
      invoice_outstanding_after_current: money(outstanding.outstanding - qty(row.allocated_amount)),
    };
  });
}

/**
 * Qty 3-way mismatch for a purchase invoice's PO (same rule as command desk).
 * Manual invoices without PO are never blocked.
 */
async function getMatchBlockedInvoiceIds(client, companyId, invoiceIds) {
  const ids = [...new Set((invoiceIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return new Set();

  const r = await client.query(
    `
      with target as (
        select pi.id, pi.purchase_order_id
        from purchase_invoices pi
        where pi.company_id = $1
          and pi.id = any($2::int[])
          and pi.purchase_order_id is not null
      ),
      grn_posted as (
        select
          grl.purchase_order_line_id,
          coalesce(sum(grl.qty_received), 0) as qty_received_posted
        from goods_receipt_lines grl
        join goods_receipts gr on gr.id = grl.goods_receipt_id
        join target t on t.purchase_order_id = gr.purchase_order_id
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
        join target t on t.purchase_order_id = pi2.purchase_order_id
        where pi2.company_id = $1
          and pi2.invoice_status = 'posted'
          and pil.purchase_order_line_id is not null
        group by pil.purchase_order_line_id
      ),
      po_match as (
        select
          pol.purchase_order_id,
          bool_or(
            coalesce(grn.qty_received_posted, 0) > coalesce(pol.qty, 0)
            or coalesce(inv.qty_invoiced_posted, 0) > coalesce(grn.qty_received_posted, 0)
          ) as is_qty_mismatch
        from purchase_order_lines pol
        join target t on t.purchase_order_id = pol.purchase_order_id
        left join grn_posted grn on grn.purchase_order_line_id = pol.id
        left join inv_posted inv on inv.purchase_order_line_id = pol.id
        group by pol.purchase_order_id
      )
      select t.id as purchase_invoice_id
      from target t
      join po_match pm on pm.purchase_order_id = t.purchase_order_id
      where pm.is_qty_mismatch = true
    `,
    [Number(companyId), ids]
  );

  return new Set(r.rows.map((row) => Number(row.purchase_invoice_id)));
}

async function assertInvoicesNotMatchBlocked(client, companyId, invoiceIds, notifyContext = null) {
  const blocked = await getMatchBlockedInvoiceIds(client, companyId, invoiceIds);
  if (!blocked.size) return null;
  if (notifyContext && typeof notifyContext === "object") {
    notifyMatchBlocked({
      companyId,
      actorUserId: notifyContext.actorUserId || null,
      purchaseInvoiceIds: [...blocked],
      paymentId: notifyContext.paymentId || null,
      vendorName: notifyContext.vendorName || null,
    }).catch(() => {});
  }
  return {
    error: "MATCH_BLOCKED",
    message: "3-way quantity mismatch blocks payment for one or more allocated invoices. Resolve GRN/PI qty or waive via match desk before paying.",
    purchase_invoice_ids: [...blocked],
  };
}

async function getVendorInvoiceOutstandingMap(client, companyId, { vendorId = null, currencyId = null, excludePaymentId = null } = {}) {
  const params = [Number(companyId)];
  const where = [`pi.company_id = $1`];
  if (Number.isFinite(Number(vendorId)) && Number(vendorId) > 0) {
    params.push(Number(vendorId));
    where.push(`pi.vendor_id = $${params.length}`);
  }
  if (Number.isFinite(Number(currencyId)) && Number(currencyId) > 0) {
    params.push(Number(currencyId));
    where.push(`pi.invoice_currency_id = $${params.length}`);
  }
  params.push(Number(excludePaymentId || 0));
  const r = await client.query(
    `
      select
        pi.id as purchase_invoice_id,
        pi.vendor_id,
        pi.purchase_invoice_number,
        pi.invoice_date,
        pi.invoice_status,
        pi.invoice_currency_id,
        pi.grand_total_invoice,
        coalesce(sum(case when vp.payment_status = 'posted' and vp.id <> $${params.length} then vpa.allocated_amount else 0 end), 0) as allocated_amount,
        coalesce((
          select sum(pr.grand_total_invoice)
          from purchase_returns pr
          where pr.purchase_invoice_id = pi.id
            and pr.return_status = 'posted'
            and pr.company_id = $1
        ), 0) as debit_note_amount
      from purchase_invoices pi
      left join vendor_payment_allocations vpa on vpa.purchase_invoice_id = pi.id
      left join vendor_payments vp on vp.id = vpa.vendor_payment_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      group by pi.id
    `,
    params
  );

  return new Map(
    r.rows.map((row) => [
      Number(row.purchase_invoice_id),
      {
        allocated: money(row.allocated_amount),
        debit_note_amount: money(row.debit_note_amount),
        outstanding: money(qty(row.grand_total_invoice) - qty(row.debit_note_amount) - qty(row.allocated_amount)),
      },
    ])
  );
}

async function getOpenInvoicesForVendor(client, companyId, { vendorId, currencyId = null, excludePaymentId = null }) {
  const outstandingMap = await getVendorInvoiceOutstandingMap(client, companyId, { vendorId, currencyId, excludePaymentId });
  const params = [Number(companyId), Number(vendorId)];
  let currencyFilter = "";
  if (Number.isFinite(Number(currencyId)) && Number(currencyId) > 0) {
    params.push(Number(currencyId));
    currencyFilter = ` and pi.invoice_currency_id = $${params.length}`;
  }

  const r = await client.query(
    `
      select
        pi.id,
        pi.purchase_invoice_number,
        pi.invoice_date,
        pi.invoice_status,
        pi.grand_total_invoice,
        curr.currency_code as invoice_currency_code
      from purchase_invoices pi
      left join currencies curr on curr.id = pi.invoice_currency_id
      where pi.company_id = $1 and pi.vendor_id = $2
        and pi.invoice_status <> 'cancelled'
        ${currencyFilter}
      order by pi.invoice_date asc, pi.id asc
    `,
    params
  );

  return r.rows.map((row) => {
    const outstanding = outstandingMap.get(Number(row.id)) || {
      allocated: 0,
      outstanding: qty(row.grand_total_invoice),
    };
    return {
      ...row,
      amount_paid: money(outstanding.allocated),
      amount_debit_noted: money(outstanding.debit_note_amount),
      outstanding: money(outstanding.outstanding),
    };
  });
}

function buildAllocationRows(openInvoices, allocations) {
  const map = new Map();
  for (const row of openInvoices || []) {
    map.set(Number(row.id), {
      purchase_invoice_id: Number(row.id),
      purchase_invoice_number: row.purchase_invoice_number,
      invoice_date: row.invoice_date,
      invoice_status: row.invoice_status,
      invoice_currency_code: row.invoice_currency_code,
      invoice_total: row.grand_total_invoice,
      invoice_outstanding_before_current: row.outstanding,
      allocated_amount: "0",
    });
  }
  for (const row of allocations || []) {
    map.set(Number(row.purchase_invoice_id), {
      purchase_invoice_id: Number(row.purchase_invoice_id),
      purchase_invoice_number: row.purchase_invoice_number,
      invoice_date: row.invoice_date,
      invoice_status: row.invoice_status,
      invoice_currency_code: row.invoice_currency_code,
      invoice_total: row.invoice_total,
      invoice_outstanding_before_current: row.invoice_outstanding_before_current,
      allocated_amount: String(row.allocated_amount ?? 0),
    });
  }
  return Array.from(map.values()).sort((a, b) => String(a.purchase_invoice_number || "").localeCompare(String(b.purchase_invoice_number || "")));
}

async function getPayablesCommandSummary(client, req, companyId) {
  const invoiceParams = [Number(companyId)];
  const invoiceWhere = [`pi.company_id = $1`, `pi.invoice_status = 'posted'`];
  if (ownRecordsOnly(req, "purchase_invoices")) {
    invoiceParams.push(Number(req.user.id));
    invoiceWhere.push(`pi.created_by = $${invoiceParams.length}`);
  }

  const paymentParams = [Number(companyId)];
  const paymentWhere = [`vp.company_id = $1`];
  if (ownRecordsOnly(req, "vendor_payments")) {
    paymentParams.push(Number(req.user.id));
    paymentWhere.push(`vp.created_by = $${paymentParams.length}`);
  }

  const [invoiceSummaryRes, paymentSummaryRes] = await Promise.all([
    client.query(
      `
        with posted_payments as (
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
            (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pp.allocated_amount, 0)) as outstanding_invoice,
            greatest((current_date - pi.invoice_date::date), 0)::int as ageing_days,
            coalesce(pm.is_qty_mismatch, false) as is_match_blocked
          from purchase_invoices pi
          left join posted_payments pp on pp.purchase_invoice_id = pi.id
          left join posted_returns prt on prt.purchase_invoice_id = pi.id
          left join po_match pm on pm.purchase_order_id = pi.purchase_order_id
          where ${invoiceWhere.join(" and ")}
            and (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pp.allocated_amount, 0)) > 0.0001
        ),
        invoice_groups as (
          select
            vendor_id,
            currency_id,
            count(*)::int as invoice_count,
            count(*) filter (where ageing_days > 30)::int as overdue_invoice_count,
            coalesce(sum(outstanding_invoice), 0) as total_outstanding_amount,
            coalesce(sum(case when ageing_days > 30 then outstanding_invoice else 0 end), 0) as overdue_amount,
            coalesce(sum(case when ageing_days <= 30 then outstanding_invoice else 0 end), 0) as current_amount,
            count(*) filter (where is_match_blocked)::int as blocked_match_count,
            coalesce(sum(case when is_match_blocked then outstanding_invoice else 0 end), 0) as blocked_match_amount,
            count(*) filter (where not is_match_blocked)::int as ready_invoice_count,
            coalesce(sum(case when not is_match_blocked then outstanding_invoice else 0 end), 0) as ready_amount
          from invoice_ageing
          group by vendor_id, currency_id
        ),
        active_payments as (
          select
            vp.vendor_id,
            vp.payment_currency_id as currency_id,
            count(*) filter (where vp.payment_status = 'draft')::int as draft_payment_count,
            count(*) filter (where vp.payment_status = 'submitted')::int as submitted_payment_count,
            count(*) filter (where vp.payment_status = 'approved')::int as approved_payment_count
          from vendor_payments vp
          where ${paymentWhere.join(" and ")}
            and vp.payment_status in ('draft', 'submitted', 'approved')
          group by vp.vendor_id, vp.payment_currency_id
        ),
        combined as (
          select
            ig.vendor_id,
            ig.currency_id,
            ig.invoice_count,
            ig.overdue_invoice_count,
            ig.total_outstanding_amount,
            ig.overdue_amount,
            ig.current_amount,
            ig.blocked_match_count,
            ig.blocked_match_amount,
            ig.ready_invoice_count,
            ig.ready_amount,
            coalesce(ap.draft_payment_count, 0) as draft_payment_count,
            coalesce(ap.submitted_payment_count, 0) as submitted_payment_count,
            coalesce(ap.approved_payment_count, 0) as approved_payment_count,
            (coalesce(ap.draft_payment_count, 0) + coalesce(ap.submitted_payment_count, 0) + coalesce(ap.approved_payment_count, 0))::int as active_payment_count
          from invoice_groups ig
          left join active_payments ap
            on ap.vendor_id = ig.vendor_id
           and ap.currency_id = ig.currency_id
        )
        select
          count(*) filter (where overdue_amount > 0.0001)::int as overdue_groups,
          coalesce(sum(case when overdue_amount > 0.0001 then overdue_amount else 0 end), 0) as overdue_amount,
          count(*) filter (
            where ready_amount > 0.0001
              and blocked_match_amount <= 0.0001
              and active_payment_count = 0
          )::int as payment_run_ready_groups,
          coalesce(sum(case
            when ready_amount > 0.0001
              and blocked_match_amount <= 0.0001
              and active_payment_count = 0
            then ready_amount
            else 0
          end), 0) as payment_run_ready_amount,
          count(*) filter (where blocked_match_amount > 0.0001)::int as blocked_match_groups,
          coalesce(sum(case when blocked_match_amount > 0.0001 then blocked_match_amount else 0 end), 0) as blocked_match_amount,
          coalesce(sum(total_outstanding_amount), 0) as total_outstanding_amount,
          coalesce(sum(invoice_count), 0)::int as total_open_invoices
        from combined
      `,
      invoiceParams
    ),
    client.query(
      `
        with payment_allocations as (
          select
            vpa.vendor_payment_id,
            coalesce(sum(vpa.allocated_amount), 0) as allocated_amount
          from vendor_payment_allocations vpa
          group by vpa.vendor_payment_id
        )
        select
          count(*) filter (where vp.payment_status = 'draft')::int as draft_payment_count,
          count(*) filter (where vp.payment_status = 'submitted')::int as submitted_payment_count,
          count(*) filter (where vp.payment_status = 'approved')::int as approved_payment_count,
          count(*) filter (
            where vp.payment_status in ('draft', 'submitted', 'approved')
              and greatest(vp.payment_amount - coalesce(pa.allocated_amount, 0), 0) > 0.0001
          )::int as unallocated_payment_count,
          coalesce(sum(case
            when vp.payment_status in ('draft', 'submitted', 'approved')
              and greatest(vp.payment_amount - coalesce(pa.allocated_amount, 0), 0) > 0.0001
            then greatest(vp.payment_amount - coalesce(pa.allocated_amount, 0), 0)
            else 0
          end), 0) as unallocated_payment_amount
        from vendor_payments vp
        left join payment_allocations pa on pa.vendor_payment_id = vp.id
        where ${paymentWhere.join(" and ")}
      `,
      paymentParams
    ),
  ]);

  const invoiceSummary = invoiceSummaryRes.rows[0] || {};
  const paymentSummary = paymentSummaryRes.rows[0] || {};
  return {
    overdue_groups: Number(invoiceSummary.overdue_groups || 0),
    overdue_amount: money(invoiceSummary.overdue_amount),
    payment_run_ready_groups: Number(invoiceSummary.payment_run_ready_groups || 0),
    payment_run_ready_amount: money(invoiceSummary.payment_run_ready_amount),
    blocked_match_groups: Number(invoiceSummary.blocked_match_groups || 0),
    blocked_match_amount: money(invoiceSummary.blocked_match_amount),
    total_outstanding_amount: money(invoiceSummary.total_outstanding_amount),
    total_open_invoices: Number(invoiceSummary.total_open_invoices || 0),
    draft_payment_count: Number(paymentSummary.draft_payment_count || 0),
    submitted_payment_count: Number(paymentSummary.submitted_payment_count || 0),
    approved_payment_count: Number(paymentSummary.approved_payment_count || 0),
    unallocated_payment_count: Number(paymentSummary.unallocated_payment_count || 0),
    unallocated_payment_amount: money(paymentSummary.unallocated_payment_amount),
  };
}

async function getPayablesCommandQueue(client, req, companyId, { bucket = "payment_run_ready", q = "", limit = 120 } = {}) {
  const normalizedBucket = normalizeText(bucket).toLowerCase();
  const normalizedQuery = normalizeText(q);
  const normalizedLimit = normalizeLimit(limit, 120, 300);

  if (["draft", "submitted", "approved", "unallocated"].includes(normalizedBucket)) {
    const params = [Number(companyId)];
    const where = [`vp.company_id = $1`];
    if (ownRecordsOnly(req, "vendor_payments")) {
      params.push(Number(req.user.id));
      where.push(`vp.created_by = $${params.length}`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(v.company_name ilike $${params.length} or vp.payment_number ilike $${params.length} or coalesce(vp.reference_no, '') ilike $${params.length})`);
    }

    if (normalizedBucket === "draft") {
      params.push("draft");
      where.push(`vp.payment_status = $${params.length}`);
    } else if (normalizedBucket === "submitted") {
      params.push("submitted");
      where.push(`vp.payment_status = $${params.length}`);
    } else if (normalizedBucket === "approved") {
      params.push("approved");
      where.push(`vp.payment_status = $${params.length}`);
    } else {
      where.push(`vp.payment_status in ('draft', 'submitted', 'approved')`);
    }

    const r = await client.query(
      `
        select
          vp.id,
          vp.payment_number,
          vp.payment_status,
          vp.payment_date,
          vp.payment_amount,
          vp.net_payment_amount,
          vp.tds_amount,
          v.company_name as vendor_name,
          curr.currency_code as payment_currency_code,
          coalesce(sum(vpa.allocated_amount), 0) as allocated_amount
        from vendor_payments vp
        join vendors v on v.id = vp.vendor_id and v.company_id = vp.company_id
        left join currencies curr on curr.id = vp.payment_currency_id
        left join vendor_payment_allocations vpa on vpa.vendor_payment_id = vp.id
        where ${where.join(" and ")}
        group by vp.id, v.company_name, curr.currency_code
        ${normalizedBucket === "unallocated" ? "having greatest(vp.payment_amount - coalesce(sum(vpa.allocated_amount), 0), 0) > 0.0001" : ""}
        order by
          case vp.payment_status
            when 'approved' then 0
            when 'submitted' then 1
            when 'draft' then 2
            else 3
          end,
          vp.payment_date asc,
          vp.id desc
        limit ${normalizedLimit}
      `,
      params
    );

    return {
      bucket: normalizedBucket,
      queue_type: "payments",
      rows: r.rows.map((row) => ({
        ...row,
        allocated_amount: money(row.allocated_amount),
        unallocated_amount: money(qty(row.payment_amount) - qty(row.allocated_amount)),
        net_payment_amount: money(row.net_payment_amount),
        tds_amount: money(row.tds_amount),
      })),
    };
  }

  const params = [Number(companyId)];
  const invoiceWhere = [`pi.company_id = $1`, `pi.invoice_status = 'posted'`];
  if (ownRecordsOnly(req, "purchase_invoices")) {
    params.push(Number(req.user.id));
    invoiceWhere.push(`pi.created_by = $${params.length}`);
  }
  if (normalizedQuery) {
    params.push(`%${normalizedQuery}%`);
    invoiceWhere.push(`(v.company_name ilike $${params.length} or pi.purchase_invoice_number ilike $${params.length})`);
  }

  const paymentWhere = [`vp.company_id = $1`];
  if (ownRecordsOnly(req, "vendor_payments")) {
    params.push(Number(req.user.id));
    paymentWhere.push(`vp.created_by = $${params.length}`);
  }

  let finalFilter = "coalesce(ready_amount, 0) > 0.0001 and coalesce(blocked_match_amount, 0) <= 0.0001 and coalesce(active_payment_count, 0) = 0";
  if (normalizedBucket === "overdue") {
    finalFilter = "coalesce(overdue_amount, 0) > 0.0001";
  } else if (normalizedBucket === "blocked_match") {
    finalFilter = "coalesce(blocked_match_amount, 0) > 0.0001";
  }

  const r = await client.query(
    `
      with posted_payments as (
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
          (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pp.allocated_amount, 0)) as outstanding_invoice,
          greatest((current_date - pi.invoice_date::date), 0)::int as ageing_days,
          coalesce(pm.is_qty_mismatch, false) as is_match_blocked
        from purchase_invoices pi
        join vendors v on v.id = pi.vendor_id and v.company_id = pi.company_id
        left join currencies curr on curr.id = pi.invoice_currency_id
        left join posted_payments pp on pp.purchase_invoice_id = pi.id
        left join posted_returns prt on prt.purchase_invoice_id = pi.id
        left join po_match pm on pm.purchase_order_id = pi.purchase_order_id
        where ${invoiceWhere.join(" and ")}
          and (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pp.allocated_amount, 0)) > 0.0001
      ),
      invoice_groups as (
        select
          vendor_id,
          vendor_name,
          currency_id,
          currency_code,
          count(*)::int as invoice_count,
          count(*) filter (where ageing_days > 30)::int as overdue_invoice_count,
          coalesce(sum(outstanding_invoice), 0) as total_outstanding_amount,
          coalesce(sum(case when ageing_days > 30 then outstanding_invoice else 0 end), 0) as overdue_amount,
          coalesce(sum(case when ageing_days <= 30 then outstanding_invoice else 0 end), 0) as current_amount,
          coalesce(max(ageing_days), 0)::int as oldest_ageing_days,
          count(*) filter (where is_match_blocked)::int as blocked_match_count,
          coalesce(sum(case when is_match_blocked then outstanding_invoice else 0 end), 0) as blocked_match_amount,
          count(*) filter (where not is_match_blocked)::int as ready_invoice_count,
          coalesce(sum(case when not is_match_blocked then outstanding_invoice else 0 end), 0) as ready_amount,
          min(invoice_date) as oldest_invoice_date,
          min(purchase_invoice_number) as oldest_invoice_number,
          max(purchase_order_id) filter (where is_match_blocked and purchase_order_id is not null) as blocked_purchase_order_id
        from invoice_ageing
        group by vendor_id, vendor_name, currency_id, currency_code
      ),
      active_payments as (
        select
          vp.vendor_id,
          vp.payment_currency_id as currency_id,
          count(*) filter (where vp.payment_status = 'draft')::int as draft_payment_count,
          count(*) filter (where vp.payment_status = 'submitted')::int as submitted_payment_count,
          count(*) filter (where vp.payment_status = 'approved')::int as approved_payment_count
        from vendor_payments vp
        where ${paymentWhere.join(" and ")}
          and vp.payment_status in ('draft', 'submitted', 'approved')
        group by vp.vendor_id, vp.payment_currency_id
      )
      select
        ig.vendor_id,
        ig.vendor_name,
        ig.currency_id,
        ig.currency_code,
        ig.invoice_count,
        ig.overdue_invoice_count,
        round(ig.total_outstanding_amount::numeric, 2) as total_outstanding_amount,
        round(ig.overdue_amount::numeric, 2) as overdue_amount,
        round(ig.current_amount::numeric, 2) as current_amount,
        ig.oldest_ageing_days,
        ig.blocked_match_count,
        round(ig.blocked_match_amount::numeric, 2) as blocked_match_amount,
        ig.ready_invoice_count,
        round(ig.ready_amount::numeric, 2) as ready_amount,
        ig.oldest_invoice_date,
        ig.oldest_invoice_number,
        ig.blocked_purchase_order_id,
        coalesce(ap.draft_payment_count, 0) as draft_payment_count,
        coalesce(ap.submitted_payment_count, 0) as submitted_payment_count,
        coalesce(ap.approved_payment_count, 0) as approved_payment_count,
        (coalesce(ap.draft_payment_count, 0) + coalesce(ap.submitted_payment_count, 0) + coalesce(ap.approved_payment_count, 0))::int as active_payment_count
      from invoice_groups ig
      left join active_payments ap
        on ap.vendor_id = ig.vendor_id
       and ap.currency_id = ig.currency_id
      where ${finalFilter}
      order by
        case
          when coalesce(ig.overdue_amount, 0) > 0 then 0
          when coalesce(ig.blocked_match_amount, 0) > 0 then 1
          else 2
        end,
        ig.oldest_ageing_days desc,
        ig.total_outstanding_amount desc,
        ig.vendor_name asc
      limit ${normalizedLimit}
    `,
    params
  );

  return {
    bucket: normalizedBucket,
    queue_type: "invoice_groups",
    rows: r.rows.map((row) => ({
      ...row,
      total_outstanding_amount: money(row.total_outstanding_amount),
      overdue_amount: money(row.overdue_amount),
      current_amount: money(row.current_amount),
      blocked_match_amount: money(row.blocked_match_amount),
      ready_amount: money(row.ready_amount),
    })),
  };
}

router.get("/bootstrap", requireScreenAction("vendor_payments", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const [vendorsRes, currenciesRes, financeBooksRes, tdsSectionsRes] = await Promise.all([
      pool.query(
        `
          select
            v.id,
            v.vendor_code,
            v.company_name,
            v.gstin,
            v.pan_no,
            v.tds_enabled,
            v.tds_exempt,
            v.lower_deduction_rate,
            v.tds_section_id,
            ts.section_code,
            ts.section_name,
            ts.default_rate,
            ts.threshold_amount,
            v.is_active
          from vendors v
          left join tds_sections ts on ts.id = v.tds_section_id
          where v.company_id = $1
            and v.is_active = true
          order by v.company_name asc
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, currency_code, currency_name, symbol, decimal_precision
          from currencies
          where is_active = true
          order by currency_code asc
        `
      ),
      pool.query(
        `
          select id, book_code, book_name, book_type, is_active
          from finance_books
          where is_active = true and company_id = $1
          order by book_type asc, book_name asc
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, section_code, section_name, default_rate, threshold_amount
          from tds_sections
          where is_active = true
          order by section_code asc
        `
      ),
    ]);

    return res.json({
      ok: true,
      vendors: vendorsRes.rows,
      currencies: currenciesRes.rows,
      finance_books: financeBooksRes.rows,
      tds_sections: tdsSectionsRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/command-summary", requireScreenAction("vendor_payments", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const summary = await getPayablesCommandSummary(pool, req, companyId);
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/command-queue", requireScreenAction("vendor_payments", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const queue = await getPayablesCommandQueue(pool, req, companyId, {
      bucket: req.query.bucket,
      q: req.query.q,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...queue });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("vendor_payments", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(companyId);
    where.push(`vp.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "vendor_payments")) {
      params.push(Number(req.user.id));
      where.push(`vp.created_by = $${params.length}`);
    }

    const r = await pool.query(
      `
        select
          vp.id,
          vp.payment_number,
          vp.payment_status,
          vp.payment_date,
          vp.payment_amount,
          vp.net_payment_amount,
          vp.tds_amount,
          v.company_name as vendor_name,
          curr.currency_code as payment_currency_code,
          coalesce(sum(case when vp.payment_status = 'posted' then vpa.allocated_amount else 0 end), 0) as allocated_amount
        from vendor_payments vp
        join vendors v on v.id = vp.vendor_id and v.company_id = vp.company_id
        left join currencies curr on curr.id = vp.payment_currency_id
        left join vendor_payment_allocations vpa on vpa.vendor_payment_id = vp.id
        ${where.length ? `where ${where.join(" and ")}` : ""}
        group by vp.id, v.company_name, curr.currency_code
        order by vp.created_at desc, vp.id desc
      `,
      params
    );

    const rows = r.rows.map((row) => ({
      ...row,
      allocated_amount: money(row.allocated_amount),
      unallocated_amount: money(qty(row.payment_amount) - qty(row.allocated_amount)),
      net_payment_amount: money(row.net_payment_amount),
      tds_amount: money(row.tds_amount),
    }));

    return res.json({ ok: true, vendor_payments: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("vendor_payments", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const vendorId = Number(body.vendor_id);
    if (!Number.isFinite(vendorId) || vendorId <= 0) return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");

    const vendorRes = await client.query(`select id from vendors where id = $1 and company_id = $2 and is_active = true limit 1`, [vendorId, companyId]);
    if (!vendorRes.rows[0]?.id) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "VENDOR_NOT_FOUND" });
    }
    const vendorProfile = await getVendorTdsProfile(client, vendorId, companyId);

    const currencyId = Number.isFinite(Number(body.payment_currency_id)) ? Number(body.payment_currency_id) : await getDefaultCurrencyId(client);
    if (!Number.isFinite(currencyId) || currencyId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    const numRes = await client.query(`select next_company_document_number($1,'VPAY') as payment_number`, [companyId]);
    const paymentNumber = numRes.rows[0]?.payment_number;

    const tdsValues = deriveTdsValues(vendorProfile, 0);

    const insertRes = await client.query(
      `
        insert into vendor_payments (
          company_id,
          payment_number,
          vendor_id,
          payment_status,
          payment_date,
          payment_currency_id,
          finance_book_id,
          payment_amount,
          tds_section_id,
          tds_base_amount,
          tds_rate,
          tds_amount,
          net_payment_amount,
          payment_mode,
          reference_no,
          bank_name,
          remarks,
          created_by
        )
        values ($1,$2,$3,'draft',current_date,$4,$5,0,$6,$7,$8,$9,0,$10,$11,$12,$13,$14)
        returning id
      `,
      [
        companyId,
        paymentNumber,
        vendorId,
        currencyId,
        null,
        tdsValues.tds_section_id,
        tdsValues.tds_base_amount,
        tdsValues.tds_rate,
        tdsValues.tds_amount,
        null,
        null,
        null,
        null,
        req.user.id,
      ]
    );

    await client.query("commit");

    const paymentId = insertRes.rows[0]?.id;
    const payment = await getVendorPaymentHeaderOrNull(client, paymentId, companyId);
    const allocations = await getPaymentAllocations(client, companyId, paymentId, { excludePaymentId: paymentId });
    const openInvoices = await getOpenInvoicesForVendor(client, companyId, {
      vendorId: payment.vendor_id,
      currencyId: payment.payment_currency_id,
      excludePaymentId: paymentId,
    });
    return res.status(201).json({
      ok: true,
      vendor_payment: payment,
      allocations,
      open_invoices: openInvoices,
      allocation_rows: buildAllocationRows(openInvoices, allocations),
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/from-invoice/:id", requireScreenAction("vendor_payments", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isFinite(invoiceId)) return res.status(400).json({ ok: false });

    await client.query("begin");

    const invRes = await client.query(
      `
        select
          pi.*,
          curr.currency_code as invoice_currency_code
        from purchase_invoices pi
        left join currencies curr on curr.id = pi.invoice_currency_id
        where pi.id = $1
        limit 1
      `,
      [invoiceId]
    );
    const invoice = invRes.rows[0] || null;
    if (!invoice) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "INVOICE_NOT_FOUND" });
    }
    const companyId = requireResolvedCompanyId(req, invoice.company_id);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    if (Number(invoice.company_id) !== Number(companyId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const outstandingMap = await getVendorInvoiceOutstandingMap(client, companyId);
    const outstanding = outstandingMap.get(Number(invoice.id)) || { outstanding: qty(invoice.grand_total_invoice) };
    if (qty(outstanding.outstanding) <= 0) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "INVOICE_ALREADY_PAID" });
    }

    const matchBlock = await assertInvoicesNotMatchBlocked(client, companyId, [invoiceId], {
      actorUserId: req.user.id,
      vendorName: invoice.vendor_name || null,
    });
    if (matchBlock) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, ...matchBlock });
    }

    const numRes = await client.query(`select next_company_document_number($1,'VPAY') as payment_number`, [companyId]);
    const paymentNumber = numRes.rows[0]?.payment_number;

    const vendorProfile = await getVendorTdsProfile(client, invoice.vendor_id, invoice.company_id);
    const tdsValues = deriveTdsValues(vendorProfile, money(outstanding.outstanding));

    const paymentRes = await client.query(
      `
        insert into vendor_payments (
          company_id,
          payment_number,
          vendor_id,
          payment_status,
          payment_date,
          payment_currency_id,
          payment_amount,
          tds_section_id,
          tds_base_amount,
          tds_rate,
          tds_amount,
          net_payment_amount,
          created_by
        )
        values ($1,$2,$3,'draft',current_date,$4,$5,$6,$7,$8,$9,$10,$11)
        returning id
      `,
      [
        companyId,
        paymentNumber,
        invoice.vendor_id,
        invoice.invoice_currency_id,
        money(outstanding.outstanding),
        tdsValues.tds_section_id,
        tdsValues.tds_base_amount,
        tdsValues.tds_rate,
        tdsValues.tds_amount,
        money(qty(outstanding.outstanding) - qty(tdsValues.tds_amount)),
        req.user.id,
      ]
    );
    const paymentId = paymentRes.rows[0]?.id;

    await client.query(
      `
        insert into vendor_payment_allocations (vendor_payment_id, purchase_invoice_id, allocated_amount)
        values ($1,$2,$3)
      `,
      [paymentId, invoiceId, money(outstanding.outstanding)]
    );

    await client.query("commit");

    const payment = await getVendorPaymentHeaderOrNull(client, paymentId, companyId);
    const allocations = await getPaymentAllocations(client, companyId, paymentId, { excludePaymentId: paymentId });
    const openInvoices = await getOpenInvoicesForVendor(client, companyId, {
      vendorId: payment.vendor_id,
      currencyId: payment.payment_currency_id,
      excludePaymentId: paymentId,
    });
    return res.status(201).json({
      ok: true,
      vendor_payment: payment,
      allocations,
      open_invoices: openInvoices,
      allocation_rows: buildAllocationRows(openInvoices, allocations),
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("vendor_payments", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const payment = await getVendorPaymentHeaderOrNull(pool, id, companyId);
    if (!payment) return res.status(404).json({ ok: false });
    if (!canAccessVendorPayment(req, payment)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const allocations = await getPaymentAllocations(pool, companyId, id, { excludePaymentId: id });
    const openInvoices = await getOpenInvoicesForVendor(pool, companyId, {
      vendorId: payment.vendor_id,
      currencyId: payment.payment_currency_id,
      excludePaymentId: id,
    });

    return res.json({
      ok: true,
      vendor_payment: payment,
      allocations,
      open_invoices: openInvoices,
      allocation_rows: buildAllocationRows(openInvoices, allocations),
    });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("vendor_payments", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const paymentId = Number(req.params.id);
    if (!Number.isFinite(paymentId)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    let status = typeof body.payment_status === "string" ? body.payment_status.trim().toLowerCase() : "draft";
    if (!["draft", "submitted", "approved", "posted", "cancelled"].includes(status)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");

    const payment = await getVendorPaymentHeaderOrNull(client, paymentId, companyId);
    if (!payment) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessVendorPayment(req, payment)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const requestedRows = Array.isArray(body.allocation_rows) ? body.allocation_rows : [];
    const currentStatus = String(payment.payment_status || "draft").toLowerCase();
    if (requestedRows.length && currentStatus !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "PAYMENT_NOT_EDITABLE" });
    }

    const isSuper = req.user.group_name === "SuperAdmin";
    const canApprove = isSuper || hasScreenAction(req, "vendor_payments", "can_approve");
    if (status !== currentStatus) {
      if (status === "submitted") {
        if (currentStatus !== "draft" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "INVALID_TRANSITION" });
        }
      } else if (status === "draft") {
        if (currentStatus !== "submitted" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "INVALID_TRANSITION" });
        }
      } else if (status === "approved") {
        if (!canApprove) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "FORBIDDEN" });
        }
        if (currentStatus !== "submitted" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "NEEDS_SUBMISSION" });
        }
      } else if (status === "posted") {
        if (!canApprove) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "FORBIDDEN" });
        }
        if (currentStatus !== "approved" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "NEEDS_APPROVAL" });
        }
      } else if (status === "cancelled") {
        if (!isSuper && currentStatus === "posted" && !canApprove) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "FORBIDDEN" });
        }
      }
    }

    let approvalCurrentLevel = Number(payment.current_approval_level || 0);
    let approvalRequiredLevel = Number(payment.required_approval_level || 0);
    let approveBy = status === "approved" && currentStatus !== "approved" ? req.user.id : null;
    let approvalDecision = null;

    const vendorId =
      body.vendor_id === undefined || body.vendor_id === null || body.vendor_id === "" ? null : Number(body.vendor_id);
    if (vendorId !== null && (!Number.isFinite(vendorId) || vendorId <= 0)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });
    }

    const currencyId =
      body.payment_currency_id === undefined || body.payment_currency_id === null || body.payment_currency_id === ""
        ? null
        : Number(body.payment_currency_id);
    if (currencyId !== null && (!Number.isFinite(currencyId) || currencyId <= 0)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    const amount = money(body.payment_amount);
    if (amount < 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_AMOUNT" });
    }

    const financeBookId =
      body.finance_book_id === undefined || body.finance_book_id === null || body.finance_book_id === ""
        ? null
        : Number(body.finance_book_id);
    if (financeBookId !== null && (!Number.isFinite(financeBookId) || financeBookId <= 0)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_BOOK" });
    }

    const nextVendorId = vendorId === null ? payment.vendor_id : vendorId;
    const nextCurrencyId = currencyId === null ? payment.payment_currency_id : currencyId;
    const nextFinanceBookId = financeBookId === null ? payment.finance_book_id : financeBookId;

    if (nextFinanceBookId !== null) {
      const bookRes = await client.query(`select id from finance_books where id = $1 and company_id = $2 and is_active = true limit 1`, [
        nextFinanceBookId,
        companyId,
      ]);
      if (!bookRes.rows[0]?.id) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "BOOK_NOT_FOUND" });
      }
    }

    const outstandingMap = await getVendorInvoiceOutstandingMap(client, companyId, {
      vendorId: nextVendorId,
      currencyId: nextCurrencyId,
      excludePaymentId: paymentId,
    });
    const normalized = [];
    for (const row of requestedRows) {
      const invoiceId = Number(row.purchase_invoice_id);
      if (!Number.isFinite(invoiceId) || invoiceId <= 0) continue;
      const allocated = money(row.allocated_amount);
      if (allocated < 0) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_ALLOCATION" });
      }

      const outstanding = outstandingMap.get(invoiceId);
      if (!outstanding) continue;
      if (allocated > qty(outstanding.outstanding)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "ALLOCATION_EXCEEDS_OUTSTANDING" });
      }

      normalized.push({ purchase_invoice_id: invoiceId, allocated_amount: allocated });
    }

    const allocatedInvoiceIds = normalized.filter((row) => qty(row.allocated_amount) > 0).map((row) => row.purchase_invoice_id);
    if (allocatedInvoiceIds.length) {
      const matchBlock = await assertInvoicesNotMatchBlocked(client, companyId, allocatedInvoiceIds, {
        actorUserId: req.user.id,
        paymentId,
        vendorName: payment.vendor_name || null,
      });
      if (matchBlock) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, ...matchBlock });
      }
    } else if (["submitted", "approved", "posted"].includes(status)) {
      const existingAllocRes = await client.query(
        `select purchase_invoice_id from vendor_payment_allocations where vendor_payment_id = $1 and allocated_amount > 0`,
        [paymentId]
      );
      const existingIds = existingAllocRes.rows.map((row) => Number(row.purchase_invoice_id));
      const matchBlock = await assertInvoicesNotMatchBlocked(client, companyId, existingIds, {
        actorUserId: req.user.id,
        paymentId,
        vendorName: payment.vendor_name || null,
      });
      if (matchBlock) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, ...matchBlock });
      }
    }

    const allocatedTotal = money(normalized.reduce((sum, row) => sum + qty(row.allocated_amount), 0));
    if (allocatedTotal > amount) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "ALLOCATION_EXCEEDS_PAYMENT" });
    }

    const vendorProfile = await getVendorTdsProfile(client, nextVendorId, payment.company_id);
    const tdsValues = deriveTdsValues(vendorProfile, amount, {
      tds_section_id: body.tds_section_id,
      tds_base_amount: body.tds_base_amount,
      tds_rate: body.tds_rate,
    });
    const netPaymentAmount = money(amount - qty(tdsValues.tds_amount));
    if (netPaymentAmount < 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_TDS_AMOUNT" });
    }

    if (status === "submitted" && currentStatus !== "submitted") {
      const state = await resolveApprovalState(client, "vendor_payment", {
        id: paymentId,
        vendor_id: nextVendorId,
        total_amount: amount,
        current_approval_level: 0,
      }, companyId);
      approvalCurrentLevel = 0;
      approvalRequiredLevel = state.requiredLevel;
    } else if (status === "draft") {
      approvalCurrentLevel = 0;
      approvalRequiredLevel = 0;
    } else if (status === "approved" && currentStatus !== "approved") {
      const state = await resolveApprovalState(client, "vendor_payment", {
        id: paymentId,
        vendor_id: nextVendorId,
        total_amount: amount,
        current_approval_level: payment.current_approval_level,
        required_approval_level: payment.required_approval_level,
      }, companyId);
      approvalDecision = evaluateApprovalPermission({
        user: req.user,
        state,
        fallbackCanApprove: canApprove,
      });
      if (!approvalDecision.allowed) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
      approvalRequiredLevel = approvalDecision.requiredLevel;
      if (approvalDecision.requiresPolicy && !approvalDecision.finalApproval && !isSuper) {
        status = "submitted";
        approvalCurrentLevel = approvalDecision.nextLevel;
        approveBy = null;
      } else {
        approvalCurrentLevel = approvalDecision.requiredLevel;
      }
    }

    const clearWorkflow = status === "draft";
    const submitBy = status === "submitted" && currentStatus !== "submitted" ? req.user.id : null;

    await client.query(
      `
        update vendor_payments
        set vendor_id = $2,
            payment_status = $3,
            payment_date = coalesce($4, payment_date),
            payment_currency_id = $5,
            finance_book_id = $6,
            payment_amount = $7,
            tds_section_id = $8,
            tds_base_amount = $9,
            tds_rate = $10,
            tds_amount = $11,
            net_payment_amount = $12,
            payment_mode = $13,
            reference_no = $14,
            bank_name = $15,
            remarks = $16,
            current_approval_level = $17,
            required_approval_level = $18,
            submitted_by = case when $19::boolean then null when $20::integer is not null then $20 else submitted_by end,
            submitted_at = case when $19::boolean then null when $20::integer is not null then now() else submitted_at end,
            approved_by = case when $19::boolean then null when $21::integer is not null then $21 else approved_by end,
            approved_at = case when $19::boolean then null when $21::integer is not null then now() else approved_at end,
            updated_at = now()
        where id = $1 and company_id = $22
      `,
      [
        paymentId,
        nextVendorId,
        status,
        body.payment_date || null,
        nextCurrencyId,
        nextFinanceBookId,
        amount,
        tdsValues.tds_section_id,
        tdsValues.tds_base_amount,
        tdsValues.tds_rate,
        tdsValues.tds_amount,
        netPaymentAmount,
        body.payment_mode || null,
        body.reference_no || null,
        body.bank_name || null,
        body.remarks || null,
        approvalCurrentLevel,
        approvalRequiredLevel,
        clearWorkflow,
        submitBy,
        approveBy,
        companyId,
      ]
    );

    if (requestedRows.length) {
      await client.query(`delete from vendor_payment_allocations where vendor_payment_id = $1`, [paymentId]);
      for (const row of normalized) {
        if (qty(row.allocated_amount) <= 0) continue;
        await client.query(
          `
            insert into vendor_payment_allocations (vendor_payment_id, purchase_invoice_id, allocated_amount)
            values ($1,$2,$3)
          `,
          [paymentId, row.purchase_invoice_id, row.allocated_amount]
        );
      }
    }

    const actionRemarks = typeof body.approval_remarks === "string" ? body.approval_remarks.trim().slice(0, 500) : "";
    const requestedApproval = typeof body.payment_status === "string" && body.payment_status.trim().toLowerCase() === "approved" && currentStatus !== "approved";
    if (currentStatus !== status) {
      if (status === "submitted") {
        await insertApprovalHistory(client, {
          docType: "vendor_payment",
          docId: paymentId,
          action: "submitted",
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (status === "draft") {
        await insertApprovalHistory(client, {
          docType: "vendor_payment",
          docId: paymentId,
          action: "sent_back",
          actionLevel: Math.max(0, Number(payment.current_approval_level || 0)),
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (status === "posted") {
        await insertApprovalHistory(client, {
          docType: "vendor_payment",
          docId: paymentId,
          action: "posted",
          actionLevel: approvalCurrentLevel,
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      }
    }
    if (requestedApproval) {
      await insertApprovalHistory(client, {
        docType: "vendor_payment",
        docId: paymentId,
        action: "approved",
        actionLevel: approvalDecision?.requiresPolicy ? approvalDecision.nextLevel : 0,
        policyId: approvalDecision?.nextPolicy?.id || null,
        remarks: actionRemarks || null,
        actedBy: req.user.id,
      });
    }

    await client.query("commit");

    const nextPayment = await getVendorPaymentHeaderOrNull(client, paymentId, companyId);
    const allocations = await getPaymentAllocations(client, companyId, paymentId, { excludePaymentId: paymentId });
    const openInvoices = await getOpenInvoicesForVendor(client, companyId, {
      vendorId: nextPayment.vendor_id,
      currencyId: nextPayment.payment_currency_id,
      excludePaymentId: paymentId,
    });
    return res.json({
      ok: true,
      vendor_payment: nextPayment,
      allocations,
      open_invoices: openInvoices,
      allocation_rows: buildAllocationRows(openInvoices, allocations),
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
