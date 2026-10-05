const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { evaluateApprovalPermission, insertApprovalHistory, resolveApprovalState } = require("../services/approvalPolicy");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");

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

function canAccessPurchaseInvoice(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "purchase_invoices")) return true;
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

/** Posted GRN received qty and non-cancelled invoiced qty per PO line. */
async function getPoLineReceivableMaps(client, purchaseOrderId, { excludePurchaseInvoiceId = null } = {}) {
  const receivedRes = await client.query(
    `
      select
        grl.purchase_order_line_id,
        coalesce(sum(grl.qty_received), 0) as qty_received
      from goods_receipt_lines grl
      join goods_receipts gr on gr.id = grl.goods_receipt_id
      where gr.purchase_order_id = $1
        and gr.receipt_status = 'posted'
        and grl.purchase_order_line_id is not null
      group by grl.purchase_order_line_id
    `,
    [Number(purchaseOrderId)]
  );

  const invoiceParams = [Number(purchaseOrderId)];
  let excludeSql = "";
  if (Number.isFinite(Number(excludePurchaseInvoiceId)) && Number(excludePurchaseInvoiceId) > 0) {
    invoiceParams.push(Number(excludePurchaseInvoiceId));
    excludeSql = ` and pi.id <> $${invoiceParams.length}`;
  }

  const invoicedRes = await client.query(
    `
      select
        pil.purchase_order_line_id,
        coalesce(sum(pil.qty), 0) as qty_invoiced
      from purchase_invoice_lines pil
      join purchase_invoices pi on pi.id = pil.purchase_invoice_id
      where pi.purchase_order_id = $1
        and pi.invoice_status <> 'cancelled'
        and pil.purchase_order_line_id is not null
        ${excludeSql}
      group by pil.purchase_order_line_id
    `,
    invoiceParams
  );

  return {
    receivedMap: new Map(receivedRes.rows.map((row) => [Number(row.purchase_order_line_id), qty(row.qty_received)])),
    invoicedMap: new Map(invoicedRes.rows.map((row) => [Number(row.purchase_order_line_id), qty(row.qty_invoiced)])),
  };
}

function calculateInvoiceLineAmounts(lines) {
  return lines.map((line) => {
    const invoiceQty = qty(line.qty);
    const unitPriceBase = money(line.unit_price_base);
    const unitPriceInvoice = money(line.unit_price_invoice);
    const gstPct = qty(line.gst_pct);
    const lineTotalBase = money(invoiceQty * unitPriceBase);
    const lineTotalInvoice = money(invoiceQty * unitPriceInvoice);
    const taxBase = money((lineTotalBase * gstPct) / 100);
    const taxInvoice = money((lineTotalInvoice * gstPct) / 100);
    return {
      ...line,
      qty: invoiceQty,
      unit_price_base: unitPriceBase,
      unit_price_invoice: unitPriceInvoice,
      gst_pct: gstPct,
      line_total_base: lineTotalBase,
      line_total_invoice: lineTotalInvoice,
      tax_total_base: taxBase,
      tax_total_invoice: taxInvoice,
    };
  });
}

function calculateInvoiceTotals(lines) {
  const normalized = calculateInvoiceLineAmounts(lines);
  return normalized.reduce(
    (acc, line) => {
      acc.subtotal_base = money(acc.subtotal_base + line.line_total_base);
      acc.subtotal_invoice = money(acc.subtotal_invoice + line.line_total_invoice);
      acc.tax_total_base = money(acc.tax_total_base + line.tax_total_base);
      acc.tax_total_invoice = money(acc.tax_total_invoice + line.tax_total_invoice);
      acc.grand_total_base = money(acc.grand_total_base + line.line_total_base + line.tax_total_base);
      acc.grand_total_invoice = money(acc.grand_total_invoice + line.line_total_invoice + line.tax_total_invoice);
      return acc;
    },
    {
      subtotal_base: 0,
      subtotal_invoice: 0,
      tax_total_base: 0,
      tax_total_invoice: 0,
      grand_total_base: 0,
      grand_total_invoice: 0,
    }
  );
}

async function getPurchaseInvoiceHeaderOrNull(client, invoiceId, companyId) {
  const r = await client.query(
    `
      select
        pi.*,
        v.vendor_code,
        v.company_name as vendor_name,
        po.po_number,
        curr.currency_code as invoice_currency_code
      from purchase_invoices pi
      join vendors v on v.id = pi.vendor_id
      left join purchase_orders po on po.id = pi.purchase_order_id
      left join currencies curr on curr.id = pi.invoice_currency_id
      where pi.id = $1 and pi.company_id = $2
      limit 1
    `,
    [invoiceId, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getPurchaseInvoiceLines(client, invoiceId) {
  const r = await client.query(
    `
      select
        pil.*,
        pg.group_name as product_group_name
      from purchase_invoice_lines pil
      left join products p on p.id = pil.product_id
      left join product_groups pg on pg.id = p.group_id
      where pil.purchase_invoice_id = $1
      order by pil.line_no asc
    `,
    [invoiceId]
  );
  return r.rows;
}

async function getPurchaseOrderHeaderOrNull(client, purchaseOrderId) {
  const r = await client.query(
    `
      select
        po.*,
        v.company_name as vendor_name
      from purchase_orders po
      join vendors v on v.id = po.vendor_id
      where po.id = $1
      limit 1
    `,
    [purchaseOrderId]
  );
  return r.rows[0] || null;
}

async function getPurchaseOrderLines(client, purchaseOrderId) {
  const r = await client.query(
    `
      select *
      from purchase_order_lines
      where purchase_order_id = $1
      order by line_no asc
    `,
    [purchaseOrderId]
  );
  return r.rows;
}

async function getPurchaseInvoiceControlSummary(client, req, companyId) {
  const params = [Number(companyId)];
  const invoiceWhere = [`pi.company_id = $1`];
  if (ownRecordsOnly(req, "purchase_invoices")) {
    params.push(Number(req.user.id));
    invoiceWhere.push(`pi.created_by = $${params.length}`);
  }

  const activePaymentWhere = [`vp.company_id = $1`, `vp.payment_status in ('draft', 'submitted', 'approved')`];

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
      active_payments as (
        select
          vp.vendor_id,
          vp.payment_currency_id as currency_id,
          count(*)::int as active_payment_count
        from vendor_payments vp
        where ${activePaymentWhere.join(" and ")}
        group by vp.vendor_id, vp.payment_currency_id
      ),
      invoice_rows as (
        select
          pi.id,
          pi.vendor_id,
          pi.invoice_currency_id as currency_id,
          pi.invoice_status,
          pi.purchase_order_id,
          (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pp.allocated_amount, 0)) as outstanding_invoice,
          greatest((current_date - pi.invoice_date::date), 0)::int as ageing_days,
          coalesce(pm.is_qty_mismatch, false) as is_match_blocked,
          coalesce(ap.active_payment_count, 0) as active_payment_count
        from purchase_invoices pi
        left join posted_payments pp on pp.purchase_invoice_id = pi.id
        left join posted_returns prt on prt.purchase_invoice_id = pi.id
        left join po_match pm on pm.purchase_order_id = pi.purchase_order_id
        left join active_payments ap on ap.vendor_id = pi.vendor_id and ap.currency_id = pi.invoice_currency_id
        where ${invoiceWhere.join(" and ")}
      )
      select
        count(*) filter (where invoice_status = 'draft')::int as draft_count,
        count(*) filter (where invoice_status = 'submitted')::int as submitted_count,
        count(*) filter (where purchase_order_id is null and invoice_status <> 'cancelled')::int as manual_count,
        count(*) filter (where invoice_status = 'submitted' and ageing_days > 2)::int as approval_aged_count,
        count(*) filter (where invoice_status = 'posted' and outstanding_invoice > 0.0001 and is_match_blocked)::int as match_blocked_count,
        coalesce(sum(case when invoice_status = 'posted' and outstanding_invoice > 0.0001 and is_match_blocked then outstanding_invoice else 0 end), 0) as match_blocked_amount,
        count(*) filter (where invoice_status = 'posted' and outstanding_invoice > 0.0001 and ageing_days > 30)::int as overdue_unpaid_count,
        coalesce(sum(case when invoice_status = 'posted' and outstanding_invoice > 0.0001 and ageing_days > 30 then outstanding_invoice else 0 end), 0) as overdue_unpaid_amount,
        count(*) filter (where invoice_status = 'posted' and outstanding_invoice > 0.0001 and not is_match_blocked and active_payment_count = 0)::int as payment_ready_count,
        coalesce(sum(case when invoice_status = 'posted' and outstanding_invoice > 0.0001 and not is_match_blocked and active_payment_count = 0 then outstanding_invoice else 0 end), 0) as payment_ready_amount
      from invoice_rows
    `,
    params
  );

  const row = r.rows[0] || {};
  return {
    draft_count: Number(row.draft_count || 0),
    submitted_count: Number(row.submitted_count || 0),
    manual_count: Number(row.manual_count || 0),
    approval_aged_count: Number(row.approval_aged_count || 0),
    match_blocked_count: Number(row.match_blocked_count || 0),
    match_blocked_amount: money(row.match_blocked_amount),
    overdue_unpaid_count: Number(row.overdue_unpaid_count || 0),
    overdue_unpaid_amount: money(row.overdue_unpaid_amount),
    payment_ready_count: Number(row.payment_ready_count || 0),
    payment_ready_amount: money(row.payment_ready_amount),
  };
}

async function getPurchaseInvoiceControlQueue(client, req, companyId, { bucket = "draft", q = "", limit = 120 } = {}) {
  const normalizedBucket = normalizeText(bucket).toLowerCase() || "draft";
  const normalizedQuery = normalizeText(q);
  const normalizedLimit = normalizeLimit(limit, 120, 300);

  const params = [Number(companyId)];
  const invoiceWhere = [`pi.company_id = $1`];
  if (ownRecordsOnly(req, "purchase_invoices")) {
    params.push(Number(req.user.id));
    invoiceWhere.push(`pi.created_by = $${params.length}`);
  }
  if (normalizedQuery) {
    params.push(`%${normalizedQuery}%`);
    invoiceWhere.push(`(pi.purchase_invoice_number ilike $${params.length} or coalesce(pi.vendor_invoice_no, '') ilike $${params.length} or v.company_name ilike $${params.length} or coalesce(po.po_number, '') ilike $${params.length})`);
  }

  let finalFilter = `invoice_status = 'draft'`;
  if (normalizedBucket === "submitted") {
    finalFilter = `invoice_status = 'submitted'`;
  } else if (normalizedBucket === "manual") {
    finalFilter = `purchase_order_id is null and invoice_status <> 'cancelled'`;
  } else if (normalizedBucket === "approval_aged") {
    finalFilter = `invoice_status = 'submitted' and ageing_days > 2`;
  } else if (normalizedBucket === "match_blocked") {
    finalFilter = `invoice_status = 'posted' and outstanding_invoice > 0.0001 and is_match_blocked`;
  } else if (normalizedBucket === "overdue_unpaid") {
    finalFilter = `invoice_status = 'posted' and outstanding_invoice > 0.0001 and ageing_days > 30`;
  } else if (normalizedBucket === "payment_ready") {
    finalFilter = `invoice_status = 'posted' and outstanding_invoice > 0.0001 and not is_match_blocked and active_payment_count = 0`;
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
      active_payments as (
        select
          vp.vendor_id,
          vp.payment_currency_id as currency_id,
          count(*)::int as active_payment_count,
          count(*) filter (where vp.payment_status = 'draft')::int as draft_payment_count,
          count(*) filter (where vp.payment_status = 'submitted')::int as submitted_payment_count,
          count(*) filter (where vp.payment_status = 'approved')::int as approved_payment_count
        from vendor_payments vp
        where vp.company_id = $1
          and vp.payment_status in ('draft', 'submitted', 'approved')
        group by vp.vendor_id, vp.payment_currency_id
      )
      invoice_rows as (
        select
          pi.id,
          pi.purchase_invoice_number,
          pi.invoice_status,
          pi.invoice_date,
          pi.vendor_invoice_no,
          pi.purchase_order_id,
          pi.current_approval_level,
          pi.required_approval_level,
          pi.submitted_at,
          pi.approved_at,
          pi.created_at,
          pi.grand_total_invoice,
          v.company_name as vendor_name,
          po.po_number,
          curr.currency_code as invoice_currency_code,
          created_user.full_name as created_by_name,
          submitted_user.full_name as submitted_by_name,
          approved_user.full_name as approved_by_name,
          (pi.grand_total_invoice - coalesce(prt.debit_note_amount, 0) - coalesce(pp.allocated_amount, 0)) as outstanding_invoice,
          greatest((current_date - pi.invoice_date::date), 0)::int as ageing_days,
          coalesce(pm.is_qty_mismatch, false) as is_match_blocked,
          coalesce(ap.active_payment_count, 0) as active_payment_count,
          coalesce(ap.draft_payment_count, 0) as draft_payment_count,
          coalesce(ap.submitted_payment_count, 0) as submitted_payment_count,
          coalesce(ap.approved_payment_count, 0) as approved_payment_count
        from purchase_invoices pi
        join vendors v on v.id = pi.vendor_id
        left join purchase_orders po on po.id = pi.purchase_order_id
        left join currencies curr on curr.id = pi.invoice_currency_id
        left join erp_users created_user on created_user.id = pi.created_by
        left join erp_users submitted_user on submitted_user.id = pi.submitted_by
        left join erp_users approved_user on approved_user.id = pi.approved_by
        left join posted_payments pp on pp.purchase_invoice_id = pi.id
        left join posted_returns prt on prt.purchase_invoice_id = pi.id
        left join po_match pm on pm.purchase_order_id = pi.purchase_order_id
        left join active_payments ap on ap.vendor_id = pi.vendor_id and ap.currency_id = pi.invoice_currency_id
        where ${invoiceWhere.join(" and ")}
      )
      select *
      from invoice_rows
      where ${finalFilter}
      order by
        case
          when invoice_status = 'submitted' then 0
          when invoice_status = 'draft' then 1
          when is_match_blocked then 2
          else 3
        end,
        ageing_days desc,
        created_at desc,
        id desc
      limit ${normalizedLimit}
    `,
    params
  );

  return {
    bucket: normalizedBucket,
    rows: r.rows.map((row) => ({
      ...row,
      grand_total_invoice: money(row.grand_total_invoice),
      outstanding_invoice: money(row.outstanding_invoice),
    })),
  };
}

router.get("/bootstrap", requireScreenAction("purchase_invoices", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const [vendorsRes, currenciesRes, purchaseOrdersRes] = await Promise.all([
      pool.query(
        `
          select id, vendor_code, company_name, gstin, is_active
          from vendors
          where company_id = $1
            and is_active = true
          order by company_name asc
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
          select
            po.id,
            po.po_number,
            po.po_status,
            po.po_date,
            v.company_name as vendor_name
          from purchase_orders po
          join vendors v on v.id = po.vendor_id and v.company_id = po.company_id
          where po.company_id = $1 and po.po_status <> 'cancelled'
          order by po.created_at desc, po.id desc
          limit 250
        `,
        [companyId]
      ),
    ]);

    return res.json({
      ok: true,
      vendors: vendorsRes.rows,
      currencies: currenciesRes.rows,
      purchase_orders: purchaseOrdersRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/control-summary", requireScreenAction("purchase_invoices", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const summary = await getPurchaseInvoiceControlSummary(pool, req, companyId);
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/control-queue", requireScreenAction("purchase_invoices", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const queue = await getPurchaseInvoiceControlQueue(pool, req, companyId, {
      bucket: req.query.bucket,
      q: req.query.q,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...queue });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-lookup", requireScreenAction("purchase_invoices", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.json({ ok: true, products: [] });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const products = await lookupProducts(pool, { companyId, q, mode: "purchase", limit: 25 });
    return res.json({ ok: true, products });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("purchase_invoices", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [];

    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    where.push(`pi.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "purchase_invoices")) {
      params.push(Number(req.user.id));
      where.push(`pi.created_by = $${params.length}`);
    }

    const r = await pool.query(
      `
        select
          pi.id,
          pi.purchase_invoice_number,
          pi.invoice_status,
          pi.invoice_date,
          pi.vendor_invoice_no,
          pi.grand_total_invoice,
          v.company_name as vendor_name,
          po.po_number,
          curr.currency_code as invoice_currency_code
        from purchase_invoices pi
        join vendors v on v.id = pi.vendor_id and v.company_id = pi.company_id
        left join purchase_orders po on po.id = pi.purchase_order_id
        left join currencies curr on curr.id = pi.invoice_currency_id
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by pi.created_at desc, pi.id desc
      `,
      params
    );

    return res.json({ ok: true, purchase_invoices: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/from-po/:id", requireScreenAction("purchase_invoices", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const purchaseOrderId = Number(req.params.id);
    if (!Number.isFinite(purchaseOrderId)) return res.status(400).json({ ok: false });

    await client.query("begin");

    const poLock = await client.query(
      `select id from purchase_orders where id = $1 limit 1 for update`,
      [purchaseOrderId]
    );
    if (!poLock.rows[0]?.id) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }

    const po = await getPurchaseOrderHeaderOrNull(client, purchaseOrderId);
    if (!po) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    const companyId = requireResolvedCompanyId(req, po.company_id);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    if (!canAccessCompanyContext(req, po)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    await client.query(`select id from purchase_order_lines where purchase_order_id = $1 for update`, [purchaseOrderId]);

    const poLines = await getPurchaseOrderLines(client, purchaseOrderId);
    if (!poLines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_LINES" });
    }

    const { receivedMap, invoicedMap } = await getPoLineReceivableMaps(client, purchaseOrderId);
    const receivableLines = poLines
      .map((line) => {
        const received = qty(receivedMap.get(Number(line.id)));
        const invoiced = qty(invoicedMap.get(Number(line.id)));
        const qtyReceivable = Math.max(received - invoiced, 0);
        return { ...line, qty_receivable: qtyReceivable };
      })
      .filter((line) => qty(line.qty_receivable) > 0.0001);

    if (!receivableLines.length) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "NOTHING_TO_INVOICE",
        message: "No posted GRN quantity remains to invoice for this PO.",
      });
    }

    const numRes = await client.query(`select next_company_document_number($1,'PINV') as purchase_invoice_number`, [companyId]);
    const purchaseInvoiceNumber = numRes.rows[0]?.purchase_invoice_number;

    const currencyId = Number.isFinite(Number(po.order_currency_id)) ? Number(po.order_currency_id) : await getDefaultCurrencyId(client);
    if (!Number.isFinite(currencyId) || currencyId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    const linesPayload = calculateInvoiceLineAmounts(
      receivableLines.map((line) => ({
        purchase_order_line_id: line.id,
        line_no: line.line_no,
        product_id: line.product_id,
        item_code: line.item_code,
        item_name: line.item_name,
        line_description: line.line_description,
        hsn_no: line.hsn_no,
        uom: line.uom,
        qty: line.qty_receivable,
        unit_price_base: line.unit_price_order,
        unit_price_invoice: line.unit_price_order,
        gst_pct: line.gst_pct,
      }))
    );

    const totals = calculateInvoiceTotals(linesPayload);

    const headerRes = await client.query(
      `
        insert into purchase_invoices (
          company_id,
          purchase_invoice_number,
          vendor_id,
          purchase_order_id,
          invoice_status,
          invoice_date,
          vendor_invoice_no,
          base_currency_id,
          invoice_currency_id,
          subtotal_base,
          subtotal_invoice,
          tax_total_base,
          tax_total_invoice,
          grand_total_base,
          grand_total_invoice,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,'draft',current_date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        returning id
      `,
      [
        companyId,
        purchaseInvoiceNumber,
        po.vendor_id,
        purchaseOrderId,
        null,
        currencyId,
        currencyId,
        totals.subtotal_base,
        totals.subtotal_invoice,
        totals.tax_total_base,
        totals.tax_total_invoice,
        totals.grand_total_base,
        totals.grand_total_invoice,
        null,
        req.user.id,
      ]
    );
    const invoiceId = headerRes.rows[0]?.id;

    for (const line of linesPayload) {
      await client.query(
        `
          insert into purchase_invoice_lines (
            purchase_invoice_id,
            purchase_order_line_id,
            line_no,
            product_id,
            item_code,
            item_name,
            line_description,
            hsn_no,
            uom,
            qty,
            unit_price_base,
            unit_price_invoice,
            gst_pct,
            line_total_base,
            line_total_invoice
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `,
        [
          invoiceId,
          line.purchase_order_line_id,
          line.line_no,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.hsn_no || null,
          line.uom || null,
          line.qty,
          line.unit_price_base,
          line.unit_price_invoice,
          line.gst_pct,
          line.line_total_base,
          line.line_total_invoice,
        ]
      );
    }

    await client.query("commit");
    const invoice = await getPurchaseInvoiceHeaderOrNull(client, invoiceId, companyId);
    const invoiceLines = await getPurchaseInvoiceLines(client, invoiceId);
    return res.status(201).json({ ok: true, purchase_invoice: invoice, lines: invoiceLines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/", requireScreenAction("purchase_invoices", "can_create"), async (req, res, next) => {
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

    const currencyId = Number.isFinite(Number(body.invoice_currency_id)) ? Number(body.invoice_currency_id) : await getDefaultCurrencyId(client);
    if (!Number.isFinite(currencyId) || currencyId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    const numRes = await client.query(`select next_company_document_number($1,'PINV') as purchase_invoice_number`, [companyId]);
    const purchaseInvoiceNumber = numRes.rows[0]?.purchase_invoice_number;

    const headerRes = await client.query(
      `
        insert into purchase_invoices (
          company_id,
          purchase_invoice_number,
          vendor_id,
          purchase_order_id,
          invoice_status,
          invoice_date,
          vendor_invoice_no,
          base_currency_id,
          invoice_currency_id,
          subtotal_base,
          subtotal_invoice,
          tax_total_base,
          tax_total_invoice,
          grand_total_base,
          grand_total_invoice,
          remarks,
          created_by
        )
        values ($1,$2,$3,null,'draft',current_date,$4,$5,$6,0,0,0,0,0,0,$7,$8)
        returning id
      `,
      [companyId, purchaseInvoiceNumber, vendorId, body.vendor_invoice_no || null, currencyId, currencyId, body.remarks || null, req.user.id]
    );
    await client.query("commit");

    const invoiceId = headerRes.rows[0]?.id;
    const invoice = await getPurchaseInvoiceHeaderOrNull(client, invoiceId, companyId);
    const lines = await getPurchaseInvoiceLines(client, invoiceId);
    return res.status(201).json({ ok: true, purchase_invoice: invoice, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("purchase_invoices", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const invoice = await getPurchaseInvoiceHeaderOrNull(pool, id, companyId);
    if (!invoice) return res.status(404).json({ ok: false });
    if (!canAccessCompanyContext(req, invoice)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessPurchaseInvoice(req, invoice)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const lines = await getPurchaseInvoiceLines(pool, id);
    return res.json({ ok: true, purchase_invoice: invoice, lines });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("purchase_invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isFinite(invoiceId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    let status = typeof body.invoice_status === "string" ? body.invoice_status.trim().toLowerCase() : "draft";
    if (!["draft", "submitted", "approved", "posted", "cancelled"].includes(status)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");

    const invoice = await getPurchaseInvoiceHeaderOrNull(client, invoiceId, companyId);
    if (!invoice) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessCompanyContext(req, invoice)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessPurchaseInvoice(req, invoice)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const requestedLines = Array.isArray(body.lines) ? body.lines : [];
    const currentStatus = String(invoice.invoice_status || "draft").toLowerCase();
    if (requestedLines.length && currentStatus !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "INVOICE_NOT_EDITABLE" });
    }

    const isSuper = req.user.group_name === "SuperAdmin";
    const canApprove = isSuper || hasScreenAction(req, "purchase_invoices", "can_approve");
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

    let approvalCurrentLevel = Number(invoice.current_approval_level || 0);
    let approvalRequiredLevel = Number(invoice.required_approval_level || 0);
    let approveBy = status === "approved" && currentStatus !== "approved" ? req.user.id : null;
    let approvalDecision = null;

    const vendorId =
      body.vendor_id === undefined || body.vendor_id === null || body.vendor_id === "" ? null : Number(body.vendor_id);
    if (vendorId !== null && (!Number.isFinite(vendorId) || vendorId <= 0)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });
    }

    if (vendorId !== null && Number(vendorId) !== Number(invoice.vendor_id)) {
      const vendorRes = await client.query(`select id from vendors where id = $1 and company_id = $2 and is_active = true limit 1`, [vendorId, invoice.company_id]);
      if (!vendorRes.rows[0]?.id) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "VENDOR_NOT_FOUND" });
      }
    }

    if (requestedLines.length) {
      const currentLines = await getPurchaseInvoiceLines(client, invoiceId);
      const currentLineMap = new Map(currentLines.map((line) => [Number(line.id), line]));
      const updatedLines = [];

      for (const line of requestedLines) {
        const id = Number(line.id);
        const current = currentLineMap.get(id);
        if (!current) continue;

        const nextQty = qty(line.qty);
        const nextUnit = money(line.unit_price_invoice);
        const nextGst = qty(line.gst_pct);

        if (nextQty <= 0) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_INVOICE_QTY" });
        }
        if (nextUnit < 0 || nextGst < 0 || nextGst > 100) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_PRICE" });
        }

        updatedLines.push({
          ...current,
          qty: nextQty,
          unit_price_base: nextUnit,
          unit_price_invoice: nextUnit,
          gst_pct: nextGst,
        });
      }

      const normalized = calculateInvoiceLineAmounts(updatedLines);
      for (const line of normalized) {
        await client.query(
          `
            update purchase_invoice_lines
            set qty = $2,
                unit_price_base = $3,
                unit_price_invoice = $4,
                gst_pct = $5,
                line_total_base = $6,
                line_total_invoice = $7
            where id = $1 and purchase_invoice_id = $8
          `,
          [
            line.id,
            line.qty,
            line.unit_price_base,
            line.unit_price_invoice,
            line.gst_pct,
            line.line_total_base,
            line.line_total_invoice,
            invoiceId,
          ]
        );
      }

      const totals = calculateInvoiceTotals(normalized);
      if (status === "submitted" && currentStatus !== "submitted") {
        const state = await resolveApprovalState(client, "purchase_invoice", {
          id: invoiceId,
          vendor_id: vendorId === null ? invoice.vendor_id : vendorId,
          total_amount: totals.grand_total_invoice,
          current_approval_level: 0,
        }, companyId);
        approvalCurrentLevel = 0;
        approvalRequiredLevel = state.requiredLevel;
      } else if (status === "draft") {
        approvalCurrentLevel = 0;
        approvalRequiredLevel = 0;
      } else if (status === "approved" && currentStatus !== "approved") {
        const state = await resolveApprovalState(client, "purchase_invoice", {
          id: invoiceId,
          vendor_id: vendorId === null ? invoice.vendor_id : vendorId,
          total_amount: totals.grand_total_invoice,
          current_approval_level: invoice.current_approval_level,
          required_approval_level: invoice.required_approval_level,
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
          update purchase_invoices
          set vendor_id = $2,
              invoice_status = $3,
              invoice_date = coalesce($4, invoice_date),
              vendor_invoice_no = $5,
              remarks = $6,
              subtotal_base = $7,
              subtotal_invoice = $8,
              tax_total_base = $9,
              tax_total_invoice = $10,
              grand_total_base = $11,
              grand_total_invoice = $12,
              current_approval_level = $13,
              required_approval_level = $14,
              submitted_by = case when $15::boolean then null when $16::integer is not null then $16 else submitted_by end,
              submitted_at = case when $15::boolean then null when $16::integer is not null then now() else submitted_at end,
              approved_by = case when $15::boolean then null when $17::integer is not null then $17 else approved_by end,
              approved_at = case when $15::boolean then null when $17::integer is not null then now() else approved_at end,
              updated_at = now()
          where id = $1 and company_id = $18
        `,
        [
          invoiceId,
          vendorId === null ? invoice.vendor_id : vendorId,
          status,
          body.invoice_date || null,
          body.vendor_invoice_no || null,
          body.remarks || null,
          totals.subtotal_base,
          totals.subtotal_invoice,
          totals.tax_total_base,
          totals.tax_total_invoice,
          totals.grand_total_base,
          totals.grand_total_invoice,
          approvalCurrentLevel,
          approvalRequiredLevel,
          clearWorkflow,
          submitBy,
          approveBy,
          companyId,
        ]
      );
    } else {
      if (status === "submitted" && currentStatus !== "submitted") {
        const state = await resolveApprovalState(client, "purchase_invoice", {
          id: invoiceId,
          vendor_id: vendorId === null ? invoice.vendor_id : vendorId,
          total_amount: invoice.grand_total_invoice,
          current_approval_level: 0,
        }, companyId);
        approvalCurrentLevel = 0;
        approvalRequiredLevel = state.requiredLevel;
      } else if (status === "draft") {
        approvalCurrentLevel = 0;
        approvalRequiredLevel = 0;
      } else if (status === "approved" && currentStatus !== "approved") {
        const state = await resolveApprovalState(client, "purchase_invoice", {
          id: invoiceId,
          vendor_id: vendorId === null ? invoice.vendor_id : vendorId,
          total_amount: invoice.grand_total_invoice,
          current_approval_level: invoice.current_approval_level,
          required_approval_level: invoice.required_approval_level,
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
          update purchase_invoices
          set vendor_id = $2,
              invoice_status = $3,
              invoice_date = coalesce($4, invoice_date),
              vendor_invoice_no = $5,
              remarks = $6,
              current_approval_level = $7,
              required_approval_level = $8,
              submitted_by = case when $9::boolean then null when $10::integer is not null then $10 else submitted_by end,
              submitted_at = case when $9::boolean then null when $10::integer is not null then now() else submitted_at end,
              approved_by = case when $9::boolean then null when $11::integer is not null then $11 else approved_by end,
              approved_at = case when $9::boolean then null when $11::integer is not null then now() else approved_at end,
              updated_at = now()
          where id = $1 and company_id = $12
        `,
        [
          invoiceId,
          vendorId === null ? invoice.vendor_id : vendorId,
          status,
          body.invoice_date || null,
          body.vendor_invoice_no || null,
          body.remarks || null,
          approvalCurrentLevel,
          approvalRequiredLevel,
          clearWorkflow,
          submitBy,
          approveBy,
          companyId,
        ]
      );
    }

    const actionRemarks = typeof body.approval_remarks === "string" ? body.approval_remarks.trim().slice(0, 500) : "";
    const requestedApproval = typeof body.invoice_status === "string" && body.invoice_status.trim().toLowerCase() === "approved" && currentStatus !== "approved";
    if (currentStatus !== status) {
      if (status === "submitted") {
        await insertApprovalHistory(client, {
          docType: "purchase_invoice",
          docId: invoiceId,
          action: "submitted",
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (status === "draft") {
        await insertApprovalHistory(client, {
          docType: "purchase_invoice",
          docId: invoiceId,
          action: "sent_back",
          actionLevel: Math.max(0, Number(invoice.current_approval_level || 0)),
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (status === "posted") {
        await insertApprovalHistory(client, {
          docType: "purchase_invoice",
          docId: invoiceId,
          action: "posted",
          actionLevel: approvalCurrentLevel,
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      }
    }
    if (requestedApproval) {
      await insertApprovalHistory(client, {
        docType: "purchase_invoice",
        docId: invoiceId,
        action: "approved",
        actionLevel: approvalDecision?.requiresPolicy ? approvalDecision.nextLevel : 0,
        policyId: approvalDecision?.nextPolicy?.id || null,
        remarks: actionRemarks || null,
        actedBy: req.user.id,
      });
    }

    await client.query("commit");
    const nextInvoice = await getPurchaseInvoiceHeaderOrNull(client, invoiceId, companyId);
    const nextLines = await getPurchaseInvoiceLines(client, invoiceId);
    return res.json({ ok: true, purchase_invoice: nextInvoice, lines: nextLines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
