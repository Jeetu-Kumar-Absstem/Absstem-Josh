const express = require("express");
const multer = require("multer");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { getDistributorIdForUser } = require("../services/mailAccounts");
const { getCustomerCreditSnapshot, getCreditControlDecision } = require("../services/creditControl");
const { normalizeCustomerPoFields, resolveCustomerItemFields } = require("../services/customerProductMaps");
const { syncLegacySoNumberSequence } = require("../services/legacySoNumbering");
const { importLegacySalesOrdersFromFile } = require("../services/legacySalesOrderImport");
const { loadQuoteScope } = require("../services/quoteTeamScope");
const { normalizePageLimit, normalizePageOffset, buildListMeta } = require("../services/listPaging");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizeLimit(value, fallback = 80, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function getFulfillmentRiskBucket(row) {
  if (row?.fulfillment_flags?.production_blocked) return "production_blocked";
  if (row?.fulfillment_flags?.confirmed_no_dispatch) return "confirmed_no_dispatch";
  if (row?.fulfillment_flags?.ready_for_dispatch) return "ready_for_dispatch";
  if (row?.fulfillment_flags?.dispatched_not_invoiced) return "dispatched_not_invoiced";
  return "other";
}

function matchesFulfillmentRiskBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getFulfillmentRiskBucket(row) !== "other";
  return getFulfillmentRiskBucket(row) === key;
}

function getFulfillmentRiskRank(row) {
  const bucket = getFulfillmentRiskBucket(row);
  if (bucket === "production_blocked") return 0;
  if (bucket === "confirmed_no_dispatch") return 1;
  if (bucket === "ready_for_dispatch") return 2;
  if (bucket === "dispatched_not_invoiced") return 3;
  return 4;
}

function getBillingControlBucket(row) {
  if (row?.billing_flags?.dispatched_no_invoice) return "dispatched_no_invoice";
  if (row?.billing_flags?.draft_pending_issue) return "draft_pending_issue";
  if (row?.billing_flags?.invoice_qty_pending) return "invoice_qty_pending";
  return "other";
}

function matchesBillingControlBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getBillingControlBucket(row) !== "other";
  return getBillingControlBucket(row) === key;
}

function getBillingControlRank(row) {
  const bucket = getBillingControlBucket(row);
  if (bucket === "dispatched_no_invoice") return 0;
  if (bucket === "draft_pending_issue") return 1;
  if (bucket === "invoice_qty_pending") return 2;
  return 3;
}

async function getInvoiceStatusStatsBySalesOrderId(client, salesOrderIds) {
  const ids = Array.isArray(salesOrderIds) ? salesOrderIds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0) : [];
  const unique = Array.from(new Set(ids));
  if (!unique.length) return new Map();
  const r = await client.query(
    `
      select
        ci.sales_order_id,
        count(*)::int as invoice_count,
        sum(case when ci.invoice_status = 'draft' then 1 else 0 end)::int as draft_count,
        sum(case when ci.invoice_status in ('issued','paid') then 1 else 0 end)::int as issued_count,
        max(ci.invoice_date) as last_invoice_date
      from customer_invoices ci
      where ci.sales_order_id = any($1::int[])
        and ci.invoice_status <> 'cancelled'
      group by ci.sales_order_id
    `,
    [unique]
  );
  return new Map(r.rows.map((row) => [Number(row.sales_order_id), row]));
}

function canAccessSalesOrder(req, order) {
  if (!order) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "sales_orders")) return true;
  return Number(order.created_by) === Number(req.user.id);
}

function canAccessQuoteForConversion(req, quote) {
  if (!quote) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "quotes")) return true;
  if (req.quoteScope) {
    const ownerId = Number(quote?.owner_user_id || quote?.created_by);
    return Number.isFinite(ownerId) && req.quoteScope.userIds.has(ownerId);
  }
  return Number(quote.created_by) === Number(req.user.id);
}

function parseTermsSnapshot(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeNullableText(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s || null;
}

function normalizeOrderFlowValue(value, fallback = "direct") {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === "direct" || s === "distributor") return s;
  return fallback;
}

function normalizeFulfillmentModeValue(value, fallback = "direct_customer") {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["direct_customer", "stock_sale", "direct_ship_end_customer"].includes(s)) return s;
  return fallback;
}

function normalizeOptionalDateValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function formatAddressSnapshot(...parts) {
  return parts
    .flat()
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

async function getCustomerHeaderSnapshot(client, customerId) {
  const r = await client.query(
    `
      select id, customer_name, address_line1, address_line2, address_line3, city, state, pincode
      from customers
      where id = $1
      limit 1
    `,
    [Number(customerId)]
  );
  return r.rows[0] || null;
}

async function getDistributorHeaderSnapshot(client, distributorId) {
  const id = Number(distributorId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const r = await client.query(
    `
      select id, company_name
      from distributors
      where id = $1
      limit 1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function getCustomerDispatchSites(client, customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) return [];
  const r = await client.query(
    `
      select
        id,
        site_code,
        site_name,
        site_type,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        can_dispatch,
        is_active
      from customer_sites
      where customer_id = $1
      order by is_default_ship_to desc, is_default_quote_site desc, site_name asc, id asc
    `,
    [id]
  );
  return r.rows;
}

async function getCustomerShipSiteOrNull(client, { customerId, customerSiteId }) {
  const siteId = Number(customerSiteId);
  const customerIdNum = Number(customerId);
  if (!Number.isFinite(siteId) || siteId <= 0) return null;
  if (!Number.isFinite(customerIdNum) || customerIdNum <= 0) return null;
  const r = await client.query(
    `
      select
        id,
        site_name,
        site_code,
        site_type,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        is_active,
        can_dispatch
      from customer_sites
      where id = $1
        and customer_id = $2
      limit 1
    `,
    [siteId, customerIdNum]
  );
  return r.rows[0] || null;
}

async function resolveSalesOrderShipToSiteId(client, { customerId, customerSiteId }) {
  const site = await getCustomerShipSiteOrNull(client, { customerId, customerSiteId });
  if (!site) return null;
  if (!site.is_active) {
    const err = new Error("SHIP_TO_SITE_INACTIVE");
    err.status = 400;
    throw err;
  }
  if (site.can_dispatch === false) {
    const err = new Error("SHIP_TO_SITE_CANNOT_DISPATCH");
    err.status = 400;
    throw err;
  }
  return site.id;
}

async function buildSalesOrderPartySnapshots(
  client,
  { order, orderFlow, fulfillmentMode, shipToCustomerSiteId, billToName, billToAddress, shipToName, shipToAddress, endCustomerName }
) {
  const [customer, distributor, shipSite] = await Promise.all([
    getCustomerHeaderSnapshot(client, order.customer_id),
    getDistributorHeaderSnapshot(client, order.distributor_id),
    getCustomerShipSiteOrNull(client, { customerId: order.customer_id, customerSiteId: shipToCustomerSiteId }),
  ]);

  const customerAddress = formatAddressSnapshot(
    customer?.address_line1,
    customer?.address_line2,
    customer?.address_line3,
    customer?.city,
    customer?.state,
    customer?.pincode
  );
  const siteAddress = formatAddressSnapshot(shipSite?.address_line1, shipSite?.address_line2, shipSite?.city, shipSite?.state, shipSite?.pincode);

  const resolvedBillToName =
    billToName || (orderFlow === "distributor" ? distributor?.company_name || customer?.customer_name : customer?.customer_name) || null;
  const resolvedBillToAddress = billToAddress || (orderFlow === "direct" ? customerAddress : null);

  let resolvedShipToName = shipToName || null;
  let resolvedShipToAddress = shipToAddress || null;
  if (!resolvedShipToName || !resolvedShipToAddress) {
    if (fulfillmentMode === "stock_sale") {
      resolvedShipToName = resolvedShipToName || distributor?.company_name || customer?.customer_name || null;
      resolvedShipToAddress = resolvedShipToAddress || null;
    } else if (shipSite) {
      resolvedShipToName = resolvedShipToName || shipSite.site_name || endCustomerName || customer?.customer_name || null;
      resolvedShipToAddress = resolvedShipToAddress || siteAddress || customerAddress || null;
    } else {
      resolvedShipToName = resolvedShipToName || endCustomerName || customer?.customer_name || null;
      resolvedShipToAddress = resolvedShipToAddress || customerAddress || null;
    }
  }

  return {
    billToName: resolvedBillToName,
    billToAddress: resolvedBillToAddress,
    shipToName: resolvedShipToName,
    shipToAddress: resolvedShipToAddress,
  };
}

async function getSalesOrderHeaderOrNull(client, { salesOrderId, distributorId = null }) {
  const params = [Number(salesOrderId)];
  const distributorFilter =
    Number.isFinite(Number(distributorId)) && Number(distributorId) > 0
      ? ` and so.distributor_id = $2`
      : "";
  if (distributorFilter) params.push(Number(distributorId));

  const r = await client.query(
    `
      select
        so.*,
        co.company_code,
        c.customer_code,
        c.customer_name,
        c.address_line1,
        c.address_line2,
        c.address_line3,
        c.city,
        c.state,
        c.pincode,
        d.company_name as distributor_name,
        base.currency_code as base_currency_code,
        ord.currency_code as order_currency_code,
        i.incoterm_code,
        pt.term_code as payment_term_code,
        pt.term_name as payment_term_name,
        ft.term_code as freight_term_code,
        ft.term_name as freight_term_name,
        pf.term_code as p_and_f_term_code,
        pf.term_name as p_and_f_term_name,
        qr.quote_id,
        qr.revision_no as quote_revision_no,
        qr.revision_status as quote_revision_status,
        qh.quote_number,
        sts.site_name as ship_to_site_name,
        icpo.po_number as intercompany_purchase_order_number,
        icpo.company_id as intercompany_purchase_order_company_id,
        icco.company_code as intercompany_company_code,
        icco.display_name as intercompany_company_name
      from sales_orders so
      left join companies co on co.id = so.company_id
      join customers c on c.id = so.customer_id
      left join distributors d on d.id = so.distributor_id
      left join currencies base on base.id = so.base_currency_id
      left join currencies ord on ord.id = so.order_currency_id
      left join incoterms i on i.id = so.incoterm_id
      left join payment_terms pt on pt.id = so.payment_term_id
      left join freight_terms ft on ft.id = so.freight_term_id
      left join p_and_f_terms pf on pf.id = so.p_and_f_term_id
      left join quote_revisions qr on qr.id = so.quote_revision_id
      left join quote_headers qh on qh.id = qr.quote_id
      left join customer_sites sts on sts.id = so.ship_to_customer_site_id
      left join purchase_orders icpo on icpo.id = so.intercompany_purchase_order_id
      left join companies icco on icco.id = so.intercompany_counterparty_company_id
      where so.id = $1
      ${distributorFilter}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

async function getSalesOrderLines(client, salesOrderId) {
  const r = await client.query(
    `
      select
        sol.*,
        pg.group_name as product_group_name
      from sales_order_lines sol
      left join products p on p.id = sol.product_id
      left join product_groups pg on pg.id = p.group_id
      where sol.sales_order_id = $1
      order by sol.line_no asc
    `,
    [salesOrderId]
  );
  return r.rows;
}

async function getDispatchQtyMap(client, salesOrderId) {
  const r = await client.query(
    `
      select
        dl.sales_order_line_id,
        coalesce(sum(dl.qty_dispatch), 0) as qty_dispatched
      from dispatch_lines dl
      join dispatches d on d.id = dl.dispatch_id
      where d.sales_order_id = $1
        and d.dispatch_status <> 'cancelled'
      group by dl.sales_order_line_id
    `,
    [salesOrderId]
  );
  return new Map(r.rows.map((row) => [Number(row.sales_order_line_id), qty(row.qty_dispatched)]));
}

async function getInvoiceQtyMap(client, salesOrderId) {
  const r = await client.query(
    `
      select
        il.sales_order_line_id,
        coalesce(sum(il.qty), 0) as qty_invoiced
      from invoice_lines il
      join customer_invoices ci on ci.id = il.customer_invoice_id
      where ci.sales_order_id = $1
        and ci.invoice_status <> 'cancelled'
      group by il.sales_order_line_id
    `,
    [salesOrderId]
  );
  return new Map(r.rows.map((row) => [Number(row.sales_order_line_id), qty(row.qty_invoiced)]));
}

async function getSalesOrderDispatchSummaries(client, salesOrderId) {
  const r = await client.query(
    `
      select id, dispatch_number, dispatch_status, dispatch_date
      from dispatches
      where sales_order_id = $1
      order by created_at desc, id desc
    `,
    [salesOrderId]
  );
  return r.rows;
}

async function getSalesOrderInvoiceSummaries(client, salesOrderId) {
  const r = await client.query(
    `
      select id, invoice_number, invoice_status, invoice_date, grand_total_invoice
      from customer_invoices
      where sales_order_id = $1
      order by created_at desc, id desc
    `,
    [salesOrderId]
  );
  return r.rows;
}

async function getSelectedQuoteTerms(client, revisionId) {
  const r = await client.query(
    `
      select sort_order, caption, description
      from quote_revision_terms
      where quote_revision_id = $1 and is_selected = true
      order by sort_order asc, id asc
    `,
    [revisionId]
  );
  return r.rows;
}

async function queryFulfillmentRiskRows(client, req, { q = "", limit = 600 } = {}) {
  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
  if (isDistributor && !distributorId) {
    const err = new Error("DISTRIBUTOR_NOT_LINKED");
    err.status = 400;
    throw err;
  }

  const params = [];
  const filters = [];
  // Number(null) === 0 and isFinite(0) — must require a real distributor id.
  if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
    params.push(Number(distributorId));
    filters.push(`so.distributor_id = $${params.length}`);
  } else {
    const activeCompanyId = getActiveCompanyId(req);
    if (activeCompanyId) {
      params.push(Number(activeCompanyId));
      filters.push(`so.company_id = $${params.length}`);
    }
  }
  if (ownRecordsOnly(req, "sales_orders")) {
    params.push(Number(req.user.id));
    filters.push(`so.created_by = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      so.so_number ilike $${idx}
      or c.customer_name ilike $${idx}
      or qh.quote_number ilike $${idx}
      or coalesce(so.customer_po_number, so.buyer_po_number, '') ilike $${idx}
      or coalesce(fg_summary.finished_good_codes, '') ilike $${idx}
      or exists (
        select 1 from sales_order_lines solq
        where solq.sales_order_id = so.id
          and (
            coalesce(solq.customer_item_code, '') ilike $${idx}
            or coalesce(solq.item_code, '') ilike $${idx}
          )
      )
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);

  const r = await client.query(
    `
      with line_totals as (
        select
          sol.sales_order_id,
          coalesce(sum(sol.qty), 0) as qty_ordered
        from sales_order_lines sol
        group by sol.sales_order_id
      ),
      dispatch_totals as (
        select
          d.sales_order_id,
          coalesce(sum(dl.qty_dispatch), 0) as qty_dispatched
        from dispatches d
        join dispatch_lines dl on dl.dispatch_id = d.id
        where d.dispatch_status <> 'cancelled'
        group by d.sales_order_id
      ),
      invoice_totals as (
        select
          ci.sales_order_id,
          coalesce(sum(il.qty), 0) as qty_invoiced
        from customer_invoices ci
        join invoice_lines il on il.customer_invoice_id = ci.id
        where ci.invoice_status <> 'cancelled'
        group by ci.sales_order_id
      ),
      fg_summary as (
        select
          jc.sales_order_id,
          count(*)::int as linked_job_count,
          count(*) filter (where lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open'))::int as open_job_count,
          count(*) filter (
            where lower(coalesce(jc.job_status, 'draft')) in ('closed', 'posted')
              and (coalesce(jc.actual_output_qty, 0) <= 0 or jc.finished_good_receipt_date is null)
          )::int as final_receipt_gap_count,
          string_agg(distinct coalesce(fg.item_code, ''), ', ') as finished_good_codes,
          coalesce(sum(distinct coalesce(sb.stock_qty, 0)), 0) as fg_stock_qty
        from job_cards jc
        left join products fg on fg.id = jc.finished_good_product_id
        left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jc.finished_good_product_id
        where jc.sales_order_id is not null
          and jc.job_type = 'manufacturing'
        group by jc.sales_order_id
      )
      select
        so.id,
        so.company_id,
        so.so_number,
        so.order_status,
        so.order_date,
        so.created_at,
        so.customer_id,
        so.customer_po_number,
        so.customer_po_date,
        so.buyer_po_number,
        so.buyer_po_date,
        c.customer_name,
        ord.currency_code as order_currency_code,
        qh.quote_number,
        coalesce(lt.qty_ordered, 0) as qty_ordered,
        coalesce(dt.qty_dispatched, 0) as qty_dispatched,
        greatest(coalesce(lt.qty_ordered, 0) - coalesce(dt.qty_dispatched, 0), 0) as qty_dispatch_remaining,
        coalesce(it.qty_invoiced, 0) as qty_invoiced,
        greatest(coalesce(dt.qty_dispatched, 0) - coalesce(it.qty_invoiced, 0), 0) as qty_invoice_remaining,
        coalesce(fg.linked_job_count, 0) as linked_job_count,
        coalesce(fg.open_job_count, 0) as open_job_count,
        coalesce(fg.final_receipt_gap_count, 0) as final_receipt_gap_count,
        coalesce(fg.finished_good_codes, '') as finished_good_codes,
        coalesce(fg.fg_stock_qty, 0) as fg_stock_qty
      from sales_orders so
      left join customers c on c.id = so.customer_id
      left join currencies ord on ord.id = so.order_currency_id
      left join quote_revisions qr on qr.id = so.quote_revision_id
      left join quote_headers qh on qh.id = qr.quote_id
      left join line_totals lt on lt.sales_order_id = so.id
      left join dispatch_totals dt on dt.sales_order_id = so.id
      left join invoice_totals it on it.sales_order_id = so.id
      left join fg_summary fg on fg.sales_order_id = so.id
      ${where}
      order by so.created_at desc, so.id desc
      limit ${safeLimit}
    `,
    params
  );

  return r.rows.map((row) => {
    const qtyDispatched = qty(row.qty_dispatched);
    const qtyDispatchRemaining = qty(row.qty_dispatch_remaining);
    const qtyInvoiceRemaining = qty(row.qty_invoice_remaining);
    const linkedJobCount = Number(row.linked_job_count || 0);
    const openJobCount = Number(row.open_job_count || 0);
    const finalReceiptGapCount = Number(row.final_receipt_gap_count || 0);
    const fgStockQty = qty(row.fg_stock_qty);
    const confirmedNoDispatch =
      String(row.order_status || "").toLowerCase() === "confirmed" &&
      qtyDispatched <= 0.0001 &&
      (qtyDispatchRemaining > 0 || qty(row.qty_ordered) <= 0.0001);
    const productionBlocked = qtyDispatchRemaining > 0 && linkedJobCount > 0 && (openJobCount > 0 || finalReceiptGapCount > 0);
    const readyForDispatch =
      qtyDispatchRemaining > 0 &&
      linkedJobCount > 0 &&
      openJobCount <= 0 &&
      finalReceiptGapCount <= 0 &&
      fgStockQty + 0.0001 >= qtyDispatchRemaining;
    const dispatchedNotInvoiced = qtyDispatched > 0.0001 && qtyInvoiceRemaining > 0.0001;
    const fulfillmentLabels = [];
    if (productionBlocked) fulfillmentLabels.push("Production Blocked");
    if (confirmedNoDispatch) fulfillmentLabels.push("Confirmed No Dispatch");
    if (readyForDispatch) fulfillmentLabels.push("Ready for Dispatch");
    if (dispatchedNotInvoiced) fulfillmentLabels.push("Dispatched Not Invoiced");
    return {
      ...row,
      fulfillment_flags: {
        confirmed_no_dispatch: confirmedNoDispatch,
        production_blocked: productionBlocked,
        ready_for_dispatch: readyForDispatch,
        dispatched_not_invoiced: dispatchedNotInvoiced,
      },
      fulfillment_labels: fulfillmentLabels,
    };
  });
}

async function getFulfillmentRiskSummary(client, req, { q = "" } = {}) {
  const rows = await queryFulfillmentRiskRows(client, req, { q, limit: 800 });
  return {
    ordersInScope: rows.length,
    confirmedNoDispatch: rows.filter((row) => row.fulfillment_flags?.confirmed_no_dispatch).length,
    productionBlocked: rows.filter((row) => row.fulfillment_flags?.production_blocked).length,
    readyForDispatch: rows.filter((row) => row.fulfillment_flags?.ready_for_dispatch).length,
    dispatchedNotInvoiced: rows.filter((row) => row.fulfillment_flags?.dispatched_not_invoiced).length,
    dispatchRemainingQty: rows.reduce((sum, row) => sum + qty(row.qty_dispatch_remaining), 0),
    invoicingPendingQty: rows.reduce((sum, row) => sum + qty(row.qty_invoice_remaining), 0),
  };
}

async function getFulfillmentRiskQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryFulfillmentRiskRows(client, req, { q, limit: 800 });
  return rows
    .filter((row) => matchesFulfillmentRiskBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getFulfillmentRiskRank(a) - getFulfillmentRiskRank(b);
      if (rankDiff !== 0) return rankDiff;
      const remainingDiff = qty(b.qty_dispatch_remaining) - qty(a.qty_dispatch_remaining);
      if (remainingDiff !== 0) return remainingDiff;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

async function queryBillingControlRows(client, req, { q = "", limit = 600 } = {}) {
  const baseRows = await queryFulfillmentRiskRows(client, req, { q, limit });
  const statsMap = await getInvoiceStatusStatsBySalesOrderId(
    client,
    baseRows.map((row) => row.id)
  );
  return baseRows.map((row) => {
    const qtyDispatched = qty(row.qty_dispatched);
    const qtyInvoiceRemaining = qty(row.qty_invoice_remaining);
    const stats = statsMap.get(Number(row.id)) || { invoice_count: 0, draft_count: 0, issued_count: 0, last_invoice_date: null };
    const invoiceCount = Number(stats.invoice_count || 0);
    const draftCount = Number(stats.draft_count || 0);
    const issuedCount = Number(stats.issued_count || 0);
    const dispatchedNoInvoice = qtyDispatched > 0.0001 && invoiceCount <= 0;
    const invoiceQtyPending = qtyDispatched > 0.0001 && qtyInvoiceRemaining > 0.0001;
    const draftPendingIssue = qtyDispatched > 0.0001 && draftCount > 0 && issuedCount <= 0;
    return {
      ...row,
      invoice_status_stats: {
        invoice_count: invoiceCount,
        draft_count: draftCount,
        issued_count: issuedCount,
        last_invoice_date: stats.last_invoice_date,
      },
      billing_flags: {
        dispatched_no_invoice: dispatchedNoInvoice,
        invoice_qty_pending: invoiceQtyPending,
        draft_pending_issue: draftPendingIssue,
      },
    };
  });
}

async function getBillingControlSummary(client, req, { q = "" } = {}) {
  const rows = await queryBillingControlRows(client, req, { q, limit: 800 });
  const inScope = rows.filter((row) => qty(row.qty_dispatched) > 0.0001);
  return {
    ordersInScope: inScope.length,
    dispatchedNoInvoice: inScope.filter((row) => row.billing_flags?.dispatched_no_invoice).length,
    draftPendingIssue: inScope.filter((row) => row.billing_flags?.draft_pending_issue).length,
    invoiceQtyPending: inScope.filter((row) => row.billing_flags?.invoice_qty_pending).length,
    invoicingPendingQty: inScope.reduce((sum, row) => sum + qty(row.qty_invoice_remaining), 0),
  };
}

async function getBillingControlQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryBillingControlRows(client, req, { q, limit: 800 });
  return rows
    .filter((row) => qty(row.qty_dispatched) > 0.0001)
    .filter((row) => matchesBillingControlBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getBillingControlRank(a) - getBillingControlRank(b);
      if (rankDiff !== 0) return rankDiff;
      const remainingDiff = qty(b.qty_invoice_remaining) - qty(a.qty_invoice_remaining);
      if (remainingDiff !== 0) return remainingDiff;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

router.get("/", requireScreenAction("sales_orders", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim() : "";
    const limit = normalizePageLimit(req.query.limit, { fallback: 50, max: 200 });
    const offset = normalizePageOffset(req.query.offset);
    const params = [];
    const where = [];

    // Number(null) === 0 and isFinite(0) — must require a real distributor id,
    // otherwise company users silently filter distributor_id = 0 and see an empty desk.
    if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
      params.push(Number(distributorId));
      where.push(`so.distributor_id = $${params.length}`);
    } else {
      params.push(activeCompanyId);
      where.push(`so.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "sales_orders")) {
      params.push(Number(req.user.id));
      where.push(`so.created_by = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`so.order_status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(so.so_number ilike $${params.length}
          or c.customer_name ilike $${params.length}
          or qh.quote_number ilike $${params.length}
          or coalesce(so.job_no, '') ilike $${params.length}
          or coalesce(so.customer_po_number, so.buyer_po_number, '') ilike $${params.length}
          or exists (
            select 1 from sales_order_lines solq
            where solq.sales_order_id = so.id
              and (
                coalesce(solq.customer_item_code, '') ilike $${params.length}
                or coalesce(solq.item_code, '') ilike $${params.length}
              )
          ))`
      );
    }
    if (bucket === "confirmed_no_dispatch") {
      where.push(`so.order_status = 'confirmed'`);
      where.push(
        `not exists (
          select 1
          from dispatches d
          where d.sales_order_id = so.id
            and d.dispatch_status <> 'cancelled'
        )`
      );
    }

    const { resolveTimelineFromQuery, pushDateRangeFilter } = require("../services/timelineWindow");
    const timeline = resolveTimelineFromQuery(req.query);
    // When searching (SO / job / customer), do not hide matches outside the timeline window.
    if (!q) {
      const soDateFilter = pushDateRangeFilter(
        params,
        "coalesce(so.order_date, so.created_at)",
        timeline.dateFrom,
        timeline.dateTo
      );
      if (soDateFilter) where.push(soDateFilter);
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const countRes = await pool.query(
      `
        select count(*)::int as n
        from sales_orders so
        left join customers c on c.id = so.customer_id
        left join quote_revisions qr on qr.id = so.quote_revision_id
        left join quote_headers qh on qh.id = qr.quote_id
        ${whereSql}
      `,
      params
    );
    const totalCount = Number(countRes.rows[0]?.n || 0);
    const statusCountRes = await pool.query(
      `
        select coalesce(so.order_status, 'unknown') as status, count(*)::int as n
        from sales_orders so
        left join customers c on c.id = so.customer_id
        left join quote_revisions qr on qr.id = so.quote_revision_id
        left join quote_headers qh on qh.id = qr.quote_id
        ${whereSql}
        group by 1
      `,
      params
    );
    const statusCounts = Object.fromEntries(statusCountRes.rows.map((row) => [row.status, Number(row.n) || 0]));

    const listParams = [...params, limit, offset];
    const r = await pool.query(
      `
        select
          so.id,
          so.so_number,
          so.company_id,
          so.order_status,
          so.order_date,
          so.grand_total_order,
          so.created_at,
          so.customer_po_number,
          so.customer_po_date,
          so.buyer_po_number,
          so.buyer_po_date,
          so.job_no,
          so.quote_revision_id,
          c.customer_name,
          c.customer_code,
          ord.currency_code as order_currency_code,
          qh.quote_number
        from sales_orders so
        left join customers c on c.id = so.customer_id
        left join currencies ord on ord.id = so.order_currency_id
        left join quote_revisions qr on qr.id = so.quote_revision_id
        left join quote_headers qh on qh.id = qr.quote_id
        ${whereSql}
        order by so.created_at desc, so.id desc
        limit $${params.length + 1} offset $${params.length + 2}
      `,
      listParams
    );

    const companyScope = activeCompanyId
      ? (
          await pool.query(`select count(*)::int as n from sales_orders where company_id = $1`, [activeCompanyId])
        ).rows[0]
      : null;

    let diag = null;
    if (!r.rows.length && req.user.group_name === "SuperAdmin" && activeCompanyId) {
      const raw = await pool.query(
        `
          select
            count(*)::int as so_count,
            count(*) filter (where so_number ~ '^S[0-9]{8}$')::int as legacy_so_count,
            min(company_id)::int as min_company_id,
            max(company_id)::int as max_company_id
          from sales_orders
        `
      );
      const byCompany = await pool.query(
        `
          select so.company_id, co.company_code, count(*)::int as n
          from sales_orders so
          left join companies co on co.id = so.company_id
          group by so.company_id, co.company_code
          order by n desc
          limit 10
        `
      );
      const sample = await pool.query(
        `
          select id, so_number, company_id, order_status, customer_id, job_no
          from sales_orders
          where company_id = $1
          order by id desc
          limit 5
        `,
        [activeCompanyId]
      );
      diag = {
        active_company_id: activeCompanyId,
        company_scope_count: companyScope?.n ?? 0,
        list_query_count: r.rows.length,
        filters: { status, bucket, q },
        global: raw.rows[0] || null,
        by_company: byCompany.rows,
        sample_for_active_company: sample.rows,
      };
      if ((companyScope?.n || 0) > 0 && !r.rows.length) {
        process.stderr.write(
          `[sales-orders-list] empty list but company ${activeCompanyId} has ${companyScope.n} sales orders\n`
        );
      }
    }

    const list = {
      ...buildListMeta({
        totalCount,
        limit,
        offset,
        returned: r.rows.length,
      }),
      status_counts: statusCounts,
    };

    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      sales_orders: r.rows,
      list,
      company_scope: {
        active_company_id: activeCompanyId,
        db_sales_order_count: companyScope?.n ?? 0,
      },
      ...(diag ? { diag } : {}),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/fulfillment-risk-summary", requireScreenAction("sales_orders", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getFulfillmentRiskSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }
    return next(err);
  }
});

router.get("/fulfillment-risk-queue", requireScreenAction("sales_orders", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getFulfillmentRiskQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }
    return next(err);
  }
});

router.get("/billing-control-summary", requireScreenAction("sales_orders", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getBillingControlSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }
    return next(err);
  }
});

router.get("/billing-control-queue", requireScreenAction("sales_orders", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getBillingControlQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }
    return next(err);
  }
});

router.post(
  "/import-from-report",
  requireScreenAction("sales_orders", "can_edit"),
  upload.single("file"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const activeCompanyId = requireResolvedCompanyId(req);
      if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
      if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: "NO_FILE_UPLOADED" });

      const updateExisting = String(req.body?.update_existing ?? "true").toLowerCase() !== "false";

      await client.query("begin");
      const summary = await importLegacySalesOrdersFromFile(client, {
        companyId: activeCompanyId,
        fileBuffer: req.file.buffer,
        fileName: req.file.originalname || "sales_order_report.xlsx",
        userId: req.user?.id || null,
        updateExisting,
      });
      await client.query("commit");
      return res.json({ ok: true, ...summary });
    } catch (err) {
      try {
        await client.query("rollback");
      } catch (_rollbackErr) {
        /* ignore */
      }
      return next(err);
    } finally {
      client.release();
    }
  }
);

function logFlightDrift(source, err) {
  console.warn(`[so-flight-log] ${source} query failed: ${err?.message || err}`);
}

router.get("/:id/flight-log", requireScreenAction("sales_orders", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const order = await getSalesOrderHeaderOrNull(pool, {
      salesOrderId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!order) return res.status(404).json({ ok: false });
    if (!canAccessSalesOrder(req, order)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, order)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const events = [];
    const pushEvent = (row) => {
      if (!row?.at) return;
      events.push({
        at: row.at,
        kind: row.kind || "event",
        label: row.label || row.kind || "Event",
        detail: row.detail || null,
        page: row.page || null,
        entity_id: row.entity_id != null ? Number(row.entity_id) : null,
      });
    };

    const quoteId = Number(order.quote_id || 0);
    if (Number.isFinite(quoteId) && quoteId > 0) {
      try {
        const quoteRes = await pool.query(
          `select id, quote_number, quote_status, created_at, updated_at from quote_headers where id = $1 limit 1`,
          [quoteId]
        );
        const quote = quoteRes.rows?.[0];
        if (quote) {
          pushEvent({
            at: quote.created_at,
            kind: "quote_created",
            label: "Quote created",
            detail: `${quote.quote_number || `Quote #${quote.id}`} • ${quote.quote_status || "draft"}`,
            page: "quotes",
            entity_id: quote.id,
          });
          if (quote.updated_at && String(quote.updated_at) !== String(quote.created_at)) {
            pushEvent({
              at: quote.updated_at,
              kind: "quote_updated",
              label: "Quote updated",
              detail: `Status ${quote.quote_status || "—"}`,
              page: "quotes",
              entity_id: quote.id,
            });
          }
        }
      } catch (quoteErr) {
        logFlightDrift("quote_headers", quoteErr);
      }
    }

    pushEvent({
      at: order.created_at,
      kind: "sales_order_created",
      label: "Sales order created",
      detail: `${order.so_number || `SO #${order.id}`} • ${order.order_status || "draft"}`,
      page: "sales_orders",
      entity_id: order.id,
    });
    if (String(order.order_status || "").toLowerCase() === "confirmed") {
      pushEvent({
        at: order.confirmed_at || order.updated_at || order.created_at,
        kind: "sales_order_confirmed",
        label: "Sales order confirmed",
        detail: order.so_number || `SO #${order.id}`,
        page: "sales_orders",
        entity_id: order.id,
      });
    } else if (order.updated_at && String(order.updated_at) !== String(order.created_at)) {
      pushEvent({
        at: order.updated_at,
        kind: "sales_order_updated",
        label: "Sales order updated",
        detail: `Status ${order.order_status || "—"}`,
        page: "sales_orders",
        entity_id: order.id,
      });
    }

    if (Number.isFinite(quoteId) && quoteId > 0) {
      try {
        const engRes = await pool.query(
          `
            select id, request_status, request_type, created_at, updated_at
            from engineering_requests
            where quote_header_id = $1
            order by created_at asc, id asc
            limit 20
          `,
          [quoteId]
        );
        for (const row of engRes.rows || []) {
          pushEvent({
            at: row.created_at,
            kind: "engineering_request",
            label: "Engineering request",
            detail: `${row.request_type || "request"} • ${row.request_status || "open"}`,
            page: "engineering",
            entity_id: row.id,
          });
          const engStatus = String(row.request_status || "").toLowerCase();
          if (row.updated_at && String(row.updated_at) !== String(row.created_at) && engStatus !== "open") {
            pushEvent({
              at: row.updated_at,
              kind: "engineering_update",
              label: ["ready", "completed", "closed", "resolved"].includes(engStatus)
                ? "Engineering response ready"
                : "Engineering status changed",
              detail: `${row.request_type || "request"} • ${row.request_status}`,
              page: "engineering",
              entity_id: row.id,
            });
          }
        }
      } catch (engErr) {
        logFlightDrift("engineering_requests", engErr);
      }
    }

    try {
      const jobRes = await pool.query(
        `
          select id, job_card_number, job_status, job_type, created_at, updated_at, finished_good_receipt_date
          from job_cards
          where sales_order_id = $1
          order by created_at asc, id asc
          limit 20
        `,
        [id]
      );
      for (const row of jobRes.rows || []) {
        const jobLabel = row.job_card_number || `Job #${row.id}`;
        pushEvent({
          at: row.created_at,
          kind: "job_card",
          label: "Job card opened",
          detail: `${jobLabel} • ${row.job_type || "job"} • ${row.job_status || "—"}`,
          page: "job_cards",
          entity_id: row.id,
        });
        if (row.finished_good_receipt_date) {
          pushEvent({
            at: row.finished_good_receipt_date,
            kind: "job_card_fg_receipt",
            label: "Finished goods received",
            detail: jobLabel,
            page: "job_cards",
            entity_id: row.id,
          });
        } else if (["completed", "closed"].includes(String(row.job_status || "").toLowerCase()) && row.updated_at) {
          pushEvent({
            at: row.updated_at,
            kind: "job_card_completed",
            label: "Job card completed",
            detail: jobLabel,
            page: "job_cards",
            entity_id: row.id,
          });
        }
      }
    } catch (jobErr) {
      logFlightDrift("job_cards", jobErr);
    }

    const customerId = Number(order.customer_id || 0);
    if (Number.isFinite(customerId) && customerId > 0) {
      try {
        const creditRes = await pool.query(
          `
            select id, release_status, requested_exposure, approved_upto_amount, reason,
                   created_at, approved_at, rejected_at, cancelled_at
            from customer_credit_releases
            where customer_id = $1
              and ($2::int is null or company_id = $2)
              and created_at >= $3::timestamptz - interval '1 day'
            order by created_at asc, id asc
            limit 20
          `,
          [customerId, order.company_id || null, order.created_at]
        );
        for (const row of creditRes.rows || []) {
          const amount = Number(row.requested_exposure || 0);
          pushEvent({
            at: row.created_at,
            kind: "credit_release_requested",
            label: "Credit release requested",
            detail: `${amount ? `Exposure ₹${amount.toLocaleString("en-IN")}` : "Exposure"}${row.reason ? ` • ${row.reason}` : ""}`,
            page: "credit_releases",
            entity_id: row.id,
          });
          if (row.approved_at) {
            const upto = Number(row.approved_upto_amount || 0);
            pushEvent({
              at: row.approved_at,
              kind: "credit_release_approved",
              label: "Credit release approved",
              detail: upto ? `Up to ₹${upto.toLocaleString("en-IN")}` : null,
              page: "credit_releases",
              entity_id: row.id,
            });
          }
          if (row.rejected_at) {
            pushEvent({ at: row.rejected_at, kind: "credit_release_rejected", label: "Credit release rejected", page: "credit_releases", entity_id: row.id });
          }
          if (row.cancelled_at) {
            pushEvent({ at: row.cancelled_at, kind: "credit_release_cancelled", label: "Credit release cancelled", page: "credit_releases", entity_id: row.id });
          }
        }
      } catch (creditErr) {
        logFlightDrift("customer_credit_releases", creditErr);
      }
    }

    try {
      const dispatchRes = await pool.query(
        `
          select id, dispatch_number, dispatch_status, dispatch_date, created_at
          from dispatches
          where sales_order_id = $1
          order by created_at asc, id asc
        `,
        [id]
      );
      for (const row of dispatchRes.rows || []) {
        pushEvent({
          at: row.dispatch_date || row.created_at,
          kind: "dispatch",
          label: "Dispatch document",
          detail: `${row.dispatch_number || `Dispatch #${row.id}`} • ${row.dispatch_status || "draft"}`,
          page: "dispatches",
          entity_id: row.id,
        });
      }
    } catch (dispatchErr) {
      logFlightDrift("dispatches", dispatchErr);
    }

    try {
      const invoiceRes = await pool.query(
        `
          select id, invoice_number, invoice_status, invoice_date, created_at
          from customer_invoices
          where sales_order_id = $1
          order by created_at asc, id asc
        `,
        [id]
      );
      for (const row of invoiceRes.rows || []) {
        pushEvent({
          at: row.invoice_date || row.created_at,
          kind: "invoice",
          label: "Customer invoice",
          detail: `${row.invoice_number || `Invoice #${row.id}`} • ${row.invoice_status || "draft"}`,
          page: "invoices",
          entity_id: row.id,
        });
      }
    } catch (invoiceErr) {
      logFlightDrift("customer_invoices", invoiceErr);
    }

    try {
      const receiptRes = await pool.query(
        `
          select distinct cr.id, cr.receipt_number, cr.receipt_status, cr.receipt_date, cr.created_at
          from customer_receipt_allocations cra
          join customer_invoices ci on ci.id = cra.customer_invoice_id
          join customer_receipts cr on cr.id = cra.customer_receipt_id
          where ci.sales_order_id = $1
          order by cr.created_at asc, cr.id asc
          limit 30
        `,
        [id]
      );
      for (const row of receiptRes.rows || []) {
        pushEvent({
          at: row.receipt_date || row.created_at,
          kind: "receipt",
          label: "Customer receipt",
          detail: `${row.receipt_number || `Receipt #${row.id}`} • ${row.receipt_status || "draft"}`,
          page: "receipts",
          entity_id: row.id,
        });
      }
    } catch (receiptErr) {
      logFlightDrift("customer_receipts", receiptErr);
    }

    events.sort((a, b) => {
      const aTime = new Date(a.at).getTime();
      const bTime = new Date(b.at).getTime();
      if (aTime !== bTime) return aTime - bTime;
      return String(a.kind || "").localeCompare(String(b.kind || ""));
    });

    return res.json({ ok: true, events });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireScreenAction("sales_orders", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const order = await getSalesOrderHeaderOrNull(pool, {
      salesOrderId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!order) return res.status(404).json({ ok: false });
    if (!canAccessSalesOrder(req, order)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, order)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const [rawLines, dispatchQtyMap, invoiceQtyMap, dispatches, invoices] = await Promise.all([
      getSalesOrderLines(pool, id),
      getDispatchQtyMap(pool, id),
      getInvoiceQtyMap(pool, id),
      getSalesOrderDispatchSummaries(pool, id),
      getSalesOrderInvoiceSummaries(pool, id),
    ]);
    const customerSites = await getCustomerDispatchSites(pool, order.customer_id);
    let creditControl = null;
    try {
      creditControl = await getCustomerCreditSnapshot(pool, {
        customerId: order.customer_id,
        companyId: order.company_id,
        distributorId: isDistributor ? distributorId : order.distributor_id,
        pendingSalesOrderAmount: ["confirmed", "closed"].includes(String(order.order_status || "").toLowerCase())
          ? 0
          : Number(order.grand_total_order || 0),
      });
    } catch (creditErr) {
      process.stderr.write(
        `[sales-orders/:id] credit snapshot failed for so=${id}: ${creditErr?.stack || creditErr}\n`
      );
      creditControl = { ready: false, error: String(creditErr?.message || creditErr) };
    }
    const lines = rawLines.map((line) => {
      const orderedQty = qty(line.qty);
      const dispatchedQty = qty(dispatchQtyMap.get(Number(line.id)));
      const invoicedQty = qty(invoiceQtyMap.get(Number(line.id)));
      return {
        ...line,
        qty_dispatched: dispatchedQty,
        qty_dispatch_remaining: Math.max(orderedQty - dispatchedQty, 0),
        qty_invoiced: invoicedQty,
        qty_invoice_remaining: Math.max(orderedQty - invoicedQty, 0),
      };
    });
    return res.json({
      ok: true,
      sales_order: order,
      lines,
      terms: parseTermsSnapshot(order.terms_snapshot),
      dispatches,
      invoices,
      customer_sites: customerSites,
      credit_control: creditControl
        ? {
            ...creditControl,
            decisions: {
              so_confirmation: getCreditControlDecision(creditControl, "so_confirmation"),
              dispatch_release: getCreditControlDecision(creditControl, "dispatch_release"),
            },
          }
        : null,
    });
  } catch (err) {
    return next(err);
  }
});

async function createSalesOrderFromQuote(req, res, next) {
  const client = await pool.connect();
  try {
    const quoteId = Number(req.params.quoteId);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");

    const quoteRes = await client.query(
      `
        select *
        from quote_headers
        where id = $1
        ${Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? "and distributor_id = $2" : ""}
        limit 1
        for update
      `,
      Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? [quoteId, distributorId] : [quoteId]
    );
    const quote = quoteRes.rows[0] || null;
    if (!quote) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!req.quoteScope && req.user.group_name !== "SuperAdmin" && ownRecordsOnly(req, "quotes")) {
      req.quoteScope = await loadQuoteScope(client, req.user.id);
    }
    if (!canAccessQuoteForConversion(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, quote)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const revisionRes = await client.query(
      `
        select *
        from quote_revisions
        where quote_id = $1 and is_latest = true
        order by revision_no desc
        limit 1
        for update
      `,
      [quoteId]
    );
    const revision = revisionRes.rows[0] || null;
    if (!revision) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_REVISION" });
    }
    if (revision.revision_status !== "issued") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QUOTE_NOT_ISSUED" });
    }

    const existingRes = await client.query(
      `select id, so_number from sales_orders where quote_revision_id = $1 limit 1`,
      [revision.id]
    );
    if (existingRes.rows[0]?.id) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "SALES_ORDER_ALREADY_EXISTS",
        sales_order_id: existingRes.rows[0].id,
        so_number: existingRes.rows[0].so_number,
      });
    }

    const linesRes = await client.query(
      `
        select *
        from quote_lines
        where quote_revision_id = $1
        order by line_no asc
      `,
      [revision.id]
    );
    const lines = linesRes.rows.filter((line) => String(line?.scope_type || "included") === "included");
    if (!lines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_LINES" });
    }

    const sumMoney = (rows, key) =>
      rows.reduce((sum, row) => {
        const value = Number(row?.[key]);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
    const subtotalBase = sumMoney(lines, "line_total_base");
    const subtotalOrder = sumMoney(lines, "line_total_quote");
    const taxTotalBase = revision.is_export
      ? 0
      : lines.reduce((sum, row) => {
          const lineTotal = Number(row.line_total_base);
          const gstPct = Number(row.gst_pct);
          if (!Number.isFinite(lineTotal) || !Number.isFinite(gstPct)) return sum;
          return sum + (lineTotal * gstPct) / 100;
        }, 0);
    const taxTotalOrder = revision.is_export
      ? 0
      : lines.reduce((sum, row) => {
          const lineTotal = Number(row.line_total_quote);
          const gstPct = Number(row.gst_pct);
          if (!Number.isFinite(lineTotal) || !Number.isFinite(gstPct)) return sum;
          return sum + (lineTotal * gstPct) / 100;
        }, 0);
    const grandTotalBase = subtotalBase + taxTotalBase;
    const grandTotalOrder = subtotalOrder + taxTotalOrder;

    const terms = await getSelectedQuoteTerms(client, revision.id);
    const companyId = requireResolvedCompanyId(req, quote.company_id);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    await syncLegacySoNumberSequence(client, companyId);
    const numRes = await client.query(`select next_company_document_number($1, 'SO') as so_number`, [companyId]);
    const soNumber = numRes.rows[0]?.so_number;

    const customerPo = normalizeCustomerPoFields(req.body && typeof req.body === "object" ? req.body : {}, quote);

    const orderRes = await client.query(
      `
        insert into sales_orders (
          so_number,
          company_id,
          quote_revision_id,
          customer_id,
          distributor_id,
          order_status,
          base_currency_id,
          order_currency_id,
          order_date,
          subtotal_base,
          subtotal_order,
          tax_total_base,
          tax_total_order,
          grand_total_base,
          grand_total_order,
          created_by,
          attention_to,
          incoterm_id,
          payment_term_id,
          freight_term_id,
          p_and_f_term_id,
          terms_snapshot,
          order_flow,
          fulfillment_mode,
          buyer_po_number,
          buyer_po_date,
          customer_po_number,
          customer_po_date,
          po_exception_reason,
          end_customer_name,
          end_customer_po_number,
          end_customer_po_date,
          ship_to_customer_site_id,
          bill_to_name,
          bill_to_address,
          ship_to_name,
          ship_to_address
        )
        values ($1,$2,$3,$4,$5,'draft',$6,$7,current_date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
        returning id
      `,
      [
        soNumber,
        companyId,
        revision.id,
        quote.customer_id,
        quote.distributor_id || null,
        revision.base_currency_id,
        revision.quote_currency_id,
        subtotalBase,
        subtotalOrder,
        taxTotalBase,
        taxTotalOrder,
        grandTotalBase,
        grandTotalOrder,
        req.user.id,
        quote.attention_to || null,
        revision.incoterm_id || null,
        revision.payment_term_id || null,
        revision.freight_term_id || null,
        revision.p_and_f_term_id || null,
        JSON.stringify(terms),
        normalizeOrderFlowValue(quote.order_flow, quote.distributor_id ? "distributor" : "direct"),
        normalizeFulfillmentModeValue(
          quote.fulfillment_mode,
          quote.distributor_id ? "stock_sale" : "direct_customer"
        ),
        customerPo.customer_po_number,
        customerPo.customer_po_date,
        customerPo.customer_po_number,
        customerPo.customer_po_date,
        normalizeNullableText(quote.po_exception_reason),
        normalizeNullableText(quote.end_customer_name),
        normalizeNullableText(quote.end_customer_po_number),
        quote.end_customer_po_date || null,
        quote.ship_to_customer_site_id || null,
        normalizeNullableText(quote.bill_to_name),
        normalizeNullableText(quote.bill_to_address),
        normalizeNullableText(quote.ship_to_name),
        normalizeNullableText(quote.ship_to_address),
      ]
    );
    const salesOrderId = orderRes.rows[0]?.id;

    for (const line of lines) {
      const customerItem = await resolveCustomerItemFields(client, {
        companyId,
        customerId: quote.customer_id,
        productId: line.product_id,
        customerItemCode: line.customer_item_code,
        customerItemDescription: line.customer_item_description,
      });

      await client.query(
        `
          insert into sales_order_lines (
            sales_order_id,
            line_no,
            product_id,
            item_code,
            item_name,
            line_description,
            hsn_no,
            qty,
            unit_price_base,
            unit_price_order,
            gst_pct,
            line_total_base,
            line_total_order,
            customer_item_code,
            customer_item_description
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `,
        [
          salesOrderId,
          line.line_no,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.hsn_no || null,
          line.qty,
          line.unit_price_base,
          line.unit_price_quote,
          line.gst_pct,
          line.line_total_base,
          line.line_total_quote,
          customerItem.customer_item_code,
          customerItem.customer_item_description,
        ]
      );
    }

    await client.query(
      `
        update quote_headers
        set quote_status = 'converted',
            updated_at = now()
        where id = $1
      `,
      [quoteId]
    );

    if (Number.isFinite(Number(quote.lead_id)) && Number(quote.lead_id) > 0) {
      await client.query(
        `
          update leads
          set status = 'order_won',
              lifecycle_status = 'won',
              sales_activity_status = 'order_closed',
              converted_sales_order_id = coalesce(converted_sales_order_id, $2),
              converted_to_order_at = coalesce(converted_to_order_at, now()),
              converted_quote_id = coalesce(converted_quote_id, $3),
              converted_to_quote_at = coalesce(converted_to_quote_at, now()),
              converted_customer_id = coalesce(converted_customer_id, $4),
              last_sales_engagement_at = now(),
              newsletter_segment = null,
              dormant_since = null,
              updated_at = now()
          where id = $1
        `,
        [quote.lead_id, salesOrderId, quoteId, quote.customer_id || null]
      );
    }

    await client.query(
      `
        update sales_pipelines
        set stage = 'won',
            sales_order_id = $1,
            actual_closing_date = current_date,
            probability_pct = 100,
            updated_at = now()
        where quote_id = $2 and company_id = $3 and stage <> 'won'
      `,
      [salesOrderId, quoteId, companyId]
    );

    await client.query("commit");

    const salesOrder = await getSalesOrderHeaderOrNull(client, { salesOrderId });
    const salesOrderLines = await getSalesOrderLines(client, salesOrderId);
    return res.status(201).json({
      ok: true,
      sales_order: salesOrder,
      lines: salesOrderLines,
      terms,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
}

router.post("/from-quote/:quoteId", requireScreenAction("sales_orders", "can_create"), createSalesOrderFromQuote);

router.put("/:id/clearance", requireScreenAction("sales_orders", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const salesOrderId = Number(req.params.id);
    if (!Number.isFinite(salesOrderId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    await client.query("begin");
    const order = await getSalesOrderHeaderOrNull(client, {
      salesOrderId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!order) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessSalesOrder(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const orderFlow = normalizeOrderFlowValue(body.order_flow, order.distributor_id ? "distributor" : "direct");
    const fulfillmentMode = normalizeFulfillmentModeValue(
      body.fulfillment_mode,
      orderFlow === "distributor" ? "stock_sale" : "direct_customer"
    );
    if (orderFlow === "direct" && fulfillmentMode !== "direct_customer") {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_FULFILLMENT_MODE" });
    }
    if (orderFlow === "distributor" && !["stock_sale", "direct_ship_end_customer"].includes(fulfillmentMode)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_FULFILLMENT_MODE" });
    }
    if (orderFlow === "distributor" && !order.distributor_id) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_REQUIRED" });
    }

    const shipToCustomerSiteId = await resolveSalesOrderShipToSiteId(client, {
      customerId: order.customer_id,
      customerSiteId:
        body.ship_to_customer_site_id === null || body.ship_to_customer_site_id === undefined || body.ship_to_customer_site_id === ""
          ? null
          : Number(body.ship_to_customer_site_id),
    });
    const endCustomerName = normalizeNullableText(body.end_customer_name);
    const partySnapshots = await buildSalesOrderPartySnapshots(client, {
      order,
      orderFlow,
      fulfillmentMode,
      shipToCustomerSiteId,
      billToName: normalizeNullableText(body.bill_to_name),
      billToAddress: normalizeNullableText(body.bill_to_address),
      shipToName: normalizeNullableText(body.ship_to_name),
      shipToAddress: normalizeNullableText(body.ship_to_address),
      endCustomerName,
    });

    const customerPo = normalizeCustomerPoFields(body);

    await client.query(
      `
        update sales_orders
        set
          order_flow = $2,
          fulfillment_mode = $3,
          buyer_po_number = $4,
          buyer_po_date = $5,
          customer_po_number = $4,
          customer_po_date = $5,
          po_exception_reason = $6,
          end_customer_name = $7,
          end_customer_po_number = $8,
          end_customer_po_date = $9,
          ship_to_customer_site_id = $10,
          bill_to_name = $11,
          bill_to_address = $12,
          ship_to_name = $13,
          ship_to_address = $14,
          updated_at = now()
        where id = $1
      `,
      [
        salesOrderId,
        orderFlow,
        fulfillmentMode,
        customerPo.customer_po_number,
        customerPo.customer_po_date,
        normalizeNullableText(body.po_exception_reason),
        endCustomerName,
        normalizeNullableText(body.end_customer_po_number),
        normalizeOptionalDateValue(body.end_customer_po_date),
        shipToCustomerSiteId,
        partySnapshots.billToName,
        partySnapshots.billToAddress,
        partySnapshots.shipToName,
        partySnapshots.shipToAddress,
      ]
    );

    await client.query("commit");

    const updated = await getSalesOrderHeaderOrNull(client, {
      salesOrderId,
      distributorId: isDistributor ? distributorId : null,
    });
    const customerSites = await getCustomerDispatchSites(client, updated.customer_id);
    return res.json({ ok: true, sales_order: updated, customer_sites: customerSites });
  } catch (err) {
    await client.query("rollback");
    if (err?.message === "SHIP_TO_SITE_INACTIVE") {
      return res.status(400).json({ ok: false, error: "SHIP_TO_SITE_INACTIVE" });
    }
    if (err?.message === "SHIP_TO_SITE_CANNOT_DISPATCH") {
      return res.status(400).json({ ok: false, error: "SHIP_TO_SITE_CANNOT_DISPATCH" });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id/status", requireScreenAction("sales_orders", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const nextStatus = typeof body.order_status === "string" ? body.order_status.trim().toLowerCase() : "";
    if (!["draft", "confirmed", "closed", "cancelled"].includes(nextStatus)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");
    const order = await getSalesOrderHeaderOrNull(client, {
      salesOrderId: id,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!order) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessSalesOrder(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    if (nextStatus === "confirmed") {
      const buyerPoNumber = normalizeNullableText(order.buyer_po_number);
      const poExceptionReason = normalizeNullableText(order.po_exception_reason);
      const orderFlow = normalizeOrderFlowValue(order.order_flow, order.distributor_id ? "distributor" : "direct");
      const fulfillmentMode = normalizeFulfillmentModeValue(
        order.fulfillment_mode,
        orderFlow === "distributor" ? "stock_sale" : "direct_customer"
      );
      if (!buyerPoNumber && !poExceptionReason) {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: "ORDER_PO_REQUIRED",
          detail: "Buyer PO number or an approved exception reason is required before confirming the sales order.",
        });
      }
      if (orderFlow === "distributor" && fulfillmentMode === "direct_ship_end_customer" && !normalizeNullableText(order.end_customer_name)) {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: "END_CUSTOMER_REQUIRED",
          detail: "End customer name is required before confirming a direct-ship distributor sales order.",
        });
      }
      if (!normalizeNullableText(order.bill_to_name) || !normalizeNullableText(order.bill_to_address)) {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: "BILL_TO_REQUIRED",
          detail: "Bill-to name and address are required before confirming the sales order.",
        });
      }
      if (!normalizeNullableText(order.ship_to_name) || !normalizeNullableText(order.ship_to_address)) {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: "SHIP_TO_REQUIRED",
          detail: "Ship-to name and address are required before confirming the sales order.",
        });
      }
      const currentStatus = String(order.order_status || "").toLowerCase();
      const creditControl = await getCustomerCreditSnapshot(client, {
        customerId: order.customer_id,
        companyId: order.company_id,
        distributorId: isDistributor ? distributorId : order.distributor_id,
        pendingSalesOrderAmount: ["confirmed", "closed"].includes(currentStatus) ? 0 : Number(order.grand_total_order || 0),
      });
      const decision = getCreditControlDecision(creditControl, "so_confirmation");
      if (decision?.block) {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: decision.code || "CREDIT_CONTROL_BLOCKED",
          detail: decision.message || "Credit control blocked sales-order confirmation.",
          credit_control: creditControl,
        });
      }
    }

    await client.query(`update sales_orders set order_status = $2, updated_at = now() where id = $1`, [id, nextStatus]);
    await client.query("commit");

    const salesOrder = await getSalesOrderHeaderOrNull(client, { salesOrderId: id });
    const lines = await getSalesOrderLines(client, id);
    const creditControl = await getCustomerCreditSnapshot(client, {
      customerId: salesOrder?.customer_id,
      companyId: salesOrder?.company_id,
      distributorId: isDistributor ? distributorId : salesOrder?.distributor_id,
      pendingSalesOrderAmount: ["confirmed", "closed"].includes(String(salesOrder?.order_status || "").toLowerCase()) ? 0 : Number(salesOrder?.grand_total_order || 0),
    });
    return res.json({
      ok: true,
      sales_order: salesOrder,
      lines,
      terms: parseTermsSnapshot(salesOrder?.terms_snapshot),
      credit_control: creditControl
        ? {
            ...creditControl,
            decisions: {
              so_confirmation: getCreditControlDecision(creditControl, "so_confirmation"),
              dispatch_release: getCreditControlDecision(creditControl, "dispatch_release"),
            },
          }
        : null,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id/payment-milestones", requireScreenAction("sales_orders", "can_view"), async (req, res, next) => {
  try {
    const salesOrderId = Number(req.params.id);
    if (!Number.isFinite(salesOrderId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const order = await getSalesOrderHeaderOrNull(pool, {
      salesOrderId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!order) return res.status(404).json({ ok: false });
    if (!canAccessSalesOrder(req, order)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, order)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const r = await pool.query(
      `
        select
          pm.*,
          pi.id as live_proforma_id,
          pi.proforma_number as live_proforma_number,
          pi.proforma_status as live_proforma_status
        from payment_milestones pm
        left join proforma_invoices pi
          on pi.payment_milestone_id = pm.id
          and pi.proforma_status not in ('cancelled', 'expired')
        where pm.sales_order_id = $1
        order by coalesce(pm.sort_order, pm.id) asc, pm.id asc
      `,
      [salesOrderId]
    );
    return res.json({ ok: true, milestones: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/payment-milestones", requireScreenAction("sales_orders", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const salesOrderId = Number(req.params.id);
    if (!Number.isFinite(salesOrderId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const milestones = Array.isArray(body.milestones) ? body.milestones : [];
    if (!milestones.length) return res.status(400).json({ ok: false, error: "MILESTONES_REQUIRED" });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    await client.query("begin");
    const order = await getSalesOrderHeaderOrNull(client, {
      salesOrderId,
      distributorId: isDistributor ? distributorId : null,
    });
    if (!order) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessSalesOrder(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    let totalPct = 0;
    const cleanMilestones = [];
    for (let i = 0; i < milestones.length; i += 1) {
      const m = milestones[i] || {};
      const name = String(m.milestone_name || "").trim();
      if (!name) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "MILESTONE_NAME_REQUIRED" });
      }
      const pct = Number(m.milestone_percent);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_MILESTONE_PERCENT" });
      }
      totalPct += pct;
      cleanMilestones.push({
        milestone_name: name,
        milestone_percent: pct,
        due_date: normalizeOptionalDateValue(m.due_date),
        sort_order: Number.isFinite(Number(m.sort_order)) ? Number(m.sort_order) : i + 1,
      });
    }
    if (totalPct > 100.0001) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "MILESTONE_PERCENT_EXCEEDS_100" });
    }

    // Replace-set is destructive — refuse if any current milestone still has a live (non-cancelled/expired) proforma.
    const liveRes = await client.query(
      `
        select pm.id
        from payment_milestones pm
        join proforma_invoices pi on pi.payment_milestone_id = pm.id
        where pm.sales_order_id = $1
          and pi.proforma_status not in ('cancelled', 'expired')
        limit 1
      `,
      [salesOrderId]
    );
    if (liveRes.rows[0]) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "MILESTONE_HAS_LIVE_PROFORMA" });
    }

    await client.query(`delete from payment_milestones where sales_order_id = $1`, [salesOrderId]);

    const grandTotalBase = qty(order.grand_total_base);
    const grandTotalOrder = qty(order.grand_total_order);
    const inserted = [];
    for (const m of cleanMilestones) {
      const factor = m.milestone_percent / 100;
      const dueTypeRaw = String(m.due_type || "date").trim().toLowerCase();
      const dueType = ["date", "dispatch", "commissioning"].includes(dueTypeRaw) ? dueTypeRaw : "date";
      const nameLooksCommission = /commission/i.test(String(m.milestone_name || ""));
      const effectiveDueType = dueType === "date" && nameLooksCommission ? "commissioning" : dueType;
      const status = effectiveDueType === "commissioning" ? "locked" : "pending";
      const r = await client.query(
        `
          insert into payment_milestones (
            sales_order_id, milestone_name, milestone_percent, milestone_amount_base, milestone_amount_order,
            due_type, due_date, status, sort_order, created_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          returning *
        `,
        [
          salesOrderId,
          m.milestone_name,
          m.milestone_percent,
          Number((grandTotalBase * factor).toFixed(2)),
          Number((grandTotalOrder * factor).toFixed(2)),
          effectiveDueType,
          m.due_date,
          status,
          m.sort_order,
          req.user.id,
        ]
      );
      inserted.push(r.rows[0]);
    }

    await client.query("commit");
    return res.status(200).json({ ok: true, milestones: inserted });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.createSalesOrderFromQuote = createSalesOrderFromQuote;
