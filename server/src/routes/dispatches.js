const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction, hasScreenAction } = require("../auth/authorization");
const { createOwnedAttachment } = require("../services/attachmentOwnership");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { getDistributorIdForUser } = require("../services/mailAccounts");
const { generateQuotePdfBuffer } = require("../pdf/quotePdf");
const { renderDispatchHtml, renderPackingListHtml } = require("../pdf/dispatchPdf");
const { enrichCompanyProfileAssets, getCompanyProfile } = require("../services/companyProfile");
const { syncStockForDispatch } = require("../services/stockLedger");
const { getCustomerCreditSnapshot, getCreditControlDecision } = require("../services/creditControl");
const { notifyDispatchNeedsInvoice } = require("../services/notifications");
const {
  EWAY_THRESHOLD_INR,
  normalizeTransportMode,
  deriveStateCodeFromGstin,
  isInterstate,
  computeConsignmentValue,
  evaluateEwayCompliance,
} = require("../services/ewayCompliance");
const {
  updateEwayVehicle: gspUpdateEwayVehicle,
  EinvoiceNotConfiguredError,
  GspTransportError,
} = require("../services/einvoice/gspAdapter");
const { buildEwayVehicleUpdatePayload } = require("../services/einvoice/ewayPayload");
const { logEinvoiceEvent } = require("../services/einvoice");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** SQL laterals for consignment value (invoice preferred, else SO qty prorate). */
const EWAY_VALUE_LATERALS = `
  left join lateral (
    select ci.grand_total_base
    from customer_invoices ci
    where ci.sales_order_id = d.sales_order_id
      and ci.invoice_status <> 'cancelled'
    order by ci.id desc
    limit 1
  ) inv on true
  left join lateral (
    select
      coalesce((select sum(dl.qty_dispatch) from dispatch_lines dl where dl.dispatch_id = d.id), 0) as qty_dispatched,
      coalesce((select sum(sol.qty) from sales_order_lines sol where sol.sales_order_id = d.sales_order_id), 0) as qty_ordered
  ) qty on true
`;

/** Simplified SQL mirror of evaluateEwayCompliance for buckets/metrics — JS remains source of truth. */
const EWAY_INCOMPLETE_SQL = `
  (
    d.dispatch_status in ('ready', 'dispatched', 'delivered')
    and coalesce(inv.grand_total_base, so.grand_total_base, 0) >= ${EWAY_THRESHOLD_INR}
    and (
      coalesce(trim(d.eway_bill_no), '') = ''
      or coalesce(trim(d.transport_mode), '') = ''
      or d.approx_distance_km is null
      or d.approx_distance_km <= 0
      or (
        coalesce(d.transport_mode, 'road') = 'road'
        and coalesce(trim(d.vehicle_no), '') = ''
      )
      or (
        coalesce(d.transport_mode, '') in ('rail', 'air', 'ship')
        and coalesce(trim(d.lr_no), '') = ''
      )
    )
  )
`;

function buildEwayBlock(dispatch, { sellerProfile = null } = {}) {
  const { value, basis } = computeConsignmentValue({
    invoiceGrandTotalBase: dispatch.invoice_grand_total_base,
    salesOrderGrandTotalBase: dispatch.so_grand_total_base ?? dispatch.grand_total_base,
    qtyDispatched: dispatch.qty_dispatched,
    qtyOrdered: dispatch.qty_ordered,
  });
  const interstate = isInterstate({
    sellerStateCode: sellerProfile?.state_code || deriveStateCodeFromGstin(sellerProfile?.gstin),
    shipToGstin: dispatch.ship_to_gstin,
    buyerGstin: dispatch.customer_gstin,
    sellerState: sellerProfile?.state,
    buyerState: dispatch.customer_state || dispatch.state,
  });
  return evaluateEwayCompliance({
    dispatch,
    consignmentValue: value,
    consignmentValueBasis: basis,
    isInterstate: interstate,
  });
}

async function loadConsignmentValueForDispatch(client, salesOrderId, dispatchId) {
  const r = await client.query(
    `
      select
        inv.grand_total_base as invoice_grand_total_base,
        so.grand_total_base as so_grand_total_base,
        coalesce((select sum(dl.qty_dispatch) from dispatch_lines dl where dl.dispatch_id = $2), 0) as qty_dispatched,
        coalesce((select sum(sol.qty) from sales_order_lines sol where sol.sales_order_id = $1), 0) as qty_ordered
      from sales_orders so
      left join lateral (
        select ci.grand_total_base
        from customer_invoices ci
        where ci.sales_order_id = so.id
          and ci.invoice_status <> 'cancelled'
        order by ci.id desc
        limit 1
      ) inv on true
      where so.id = $1
      limit 1
    `,
    [Number(salesOrderId), Number(dispatchId)]
  );
  return r.rows[0] || {};
}

async function syncInvoiceEwayFromDispatch(client, { salesOrderId, previousEwayBillNo, nextEwayBillNo, nextEwayBillDate, nextEwayValidTill }) {
  const nextNo = emptyToNull(nextEwayBillNo);
  if (!nextNo) return; // never propagate clears to invoice
  const prevNo = emptyToNull(previousEwayBillNo);
  await client.query(
    `
      update customer_invoices
      set eway_bill_no = $2,
          eway_bill_date = $3,
          eway_valid_till = $4,
          updated_at = now()
      where sales_order_id = $1
        and invoice_status <> 'cancelled'
        and (
          eway_bill_no is null
          or ($5::text is not null and eway_bill_no = $5)
        )
    `,
    [Number(salesOrderId), nextNo, nextEwayBillDate || null, nextEwayValidTill || null, prevNo]
  );
}

async function getDispatchReadiness(client, salesOrderId) {
  const r = await client.query(
    `
      with line_totals as (
        select sales_order_id, coalesce(sum(qty), 0) as qty_ordered
        from sales_order_lines
        where sales_order_id = $1
        group by sales_order_id
      ),
      dispatch_totals as (
        select d.sales_order_id, coalesce(sum(dl.qty_dispatch), 0) as qty_dispatched
        from dispatches d
        join dispatch_lines dl on dl.dispatch_id = d.id
        where d.sales_order_id = $1
          and d.dispatch_status <> 'cancelled'
        group by d.sales_order_id
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
          coalesce(sum(distinct coalesce(sb.stock_qty, 0)), 0) as fg_stock_qty
        from job_cards jc
        left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jc.finished_good_product_id
        where jc.sales_order_id = $1
          and jc.job_type = 'manufacturing'
        group by jc.sales_order_id
      )
      select
        so.id,
        so.order_status,
        coalesce(lt.qty_ordered, 0) as qty_ordered,
        coalesce(dt.qty_dispatched, 0) as qty_dispatched,
        greatest(coalesce(lt.qty_ordered, 0) - coalesce(dt.qty_dispatched, 0), 0) as qty_dispatch_remaining,
        coalesce(fg.linked_job_count, 0) as linked_job_count,
        coalesce(fg.open_job_count, 0) as open_job_count,
        coalesce(fg.final_receipt_gap_count, 0) as final_receipt_gap_count,
        coalesce(fg.fg_stock_qty, 0) as fg_stock_qty
      from sales_orders so
      left join line_totals lt on lt.sales_order_id = so.id
      left join dispatch_totals dt on dt.sales_order_id = so.id
      left join fg_summary fg on fg.sales_order_id = so.id
      where so.id = $1
      limit 1
    `,
    [Number(salesOrderId)]
  );
  const row = r.rows[0] || null;
  if (!row) {
    return {
      ready_for_dispatch: false,
      production_blocked: false,
      linked_job_count: 0,
      blockers: ["Sales order not found"],
    };
  }

  const qtyDispatchRemaining = qty(row.qty_dispatch_remaining);
  const linkedJobCount = Number(row.linked_job_count || 0);
  const openJobCount = Number(row.open_job_count || 0);
  const finalReceiptGapCount = Number(row.final_receipt_gap_count || 0);
  const fgStockQty = qty(row.fg_stock_qty);
  const productionBlocked = qtyDispatchRemaining > 0 && linkedJobCount > 0 && (openJobCount > 0 || finalReceiptGapCount > 0);
  const readyForDispatch =
    qtyDispatchRemaining > 0 &&
    linkedJobCount > 0 &&
    openJobCount <= 0 &&
    finalReceiptGapCount <= 0 &&
    fgStockQty + 0.0001 >= qtyDispatchRemaining;
  const blockers = [];
  if (productionBlocked) {
    if (openJobCount > 0) blockers.push(`${openJobCount} open manufacturing job(s)`);
    if (finalReceiptGapCount > 0) blockers.push(`${finalReceiptGapCount} FG receipt gap(s)`);
  } else if (linkedJobCount > 0 && !readyForDispatch) {
    if (fgStockQty + 0.0001 < qtyDispatchRemaining) blockers.push("Finished-good stock is below remaining dispatch qty");
    if (qtyDispatchRemaining <= 0) blockers.push("Nothing left to dispatch");
  }

  return {
    ready_for_dispatch: readyForDispatch,
    production_blocked: productionBlocked,
    linked_job_count: linkedJobCount,
    open_job_count: openJobCount,
    final_receipt_gap_count: finalReceiptGapCount,
    fg_stock_qty: fgStockQty,
    qty_dispatch_remaining: qtyDispatchRemaining,
    blockers,
  };
}

function userCanAccessCompanyId(req, companyId) {
  if (!companyId) return false;
  if (req.user?.group_name === "SuperAdmin") return true;
  const companies = Array.isArray(req.user?.companies) ? req.user.companies : [];
  return companies.some((c) => Number(c.company_id) === Number(companyId));
}

function safeFileSegment(value) {
  return String(value || "dispatch")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function canAccessDispatch(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "dispatches")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

function canAccessSalesOrder(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "sales_orders")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function getSalesOrderForDispatch(client, salesOrderId, distributorId = null) {
  const params = [Number(salesOrderId)];
  const distributorFilter =
    Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? ` and so.distributor_id = $2` : "";
  if (distributorFilter) params.push(Number(distributorId));
  const r = await client.query(
    `
      select
        so.*,
        co.company_code,
        c.customer_name,
        c.address_line1,
        c.address_line2,
        c.address_line3,
        c.city,
        c.state,
        c.pincode,
        c.gstin as customer_gstin,
        sts.site_name as ship_to_site_name,
        sts.site_code as ship_to_site_code,
        sts.site_type as ship_to_site_type
      from sales_orders so
      left join companies co on co.id = so.company_id
      join customers c on c.id = so.customer_id
      left join customer_sites sts on sts.id = so.ship_to_customer_site_id
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

async function getDispatchedQtyMap(client, salesOrderId, { excludeDispatchId = null } = {}) {
  const params = [Number(salesOrderId)];
  let excludeSql = "";
  if (Number.isFinite(Number(excludeDispatchId)) && Number(excludeDispatchId) > 0) {
    params.push(Number(excludeDispatchId));
    excludeSql = ` and d.id <> $${params.length}`;
  }
  const r = await client.query(
    `
      select
        dl.sales_order_line_id,
        coalesce(sum(dl.qty_dispatch), 0) as qty_dispatched
      from dispatch_lines dl
      join dispatches d on d.id = dl.dispatch_id
      where d.sales_order_id = $1
        and d.dispatch_status <> 'cancelled'
        ${excludeSql}
      group by dl.sales_order_line_id
    `,
    params
  );
  return new Map(r.rows.map((row) => [Number(row.sales_order_line_id), qty(row.qty_dispatched)]));
}

async function buildDispatchProgressLines(client, salesOrderId, { excludeDispatchId = null } = {}) {
  const [lines, dispatchedQtyMap] = await Promise.all([
    getSalesOrderLines(client, salesOrderId),
    getDispatchedQtyMap(client, salesOrderId, { excludeDispatchId }),
  ]);
  return lines.map((line) => {
    const orderedQty = qty(line.qty);
    const dispatchedQty = qty(dispatchedQtyMap.get(Number(line.id)));
    return {
      ...line,
      qty_ordered: orderedQty,
      qty_previously_dispatched: dispatchedQty,
      qty_remaining_dispatch: Math.max(orderedQty - dispatchedQty, 0),
    };
  });
}

function enrichDispatchLines(lines, progressLinesBySoLineId) {
  return lines.map((line) => {
    const progress = progressLinesBySoLineId.get(Number(line.sales_order_line_id));
    const orderedQty = qty(progress?.qty_ordered ?? line.qty_ordered);
    const previousQty = qty(progress?.qty_previously_dispatched);
    const currentQty = qty(line.qty_dispatch);
    return {
      ...line,
      qty_ordered: orderedQty,
      qty_previously_dispatched: previousQty,
      qty_remaining_before_dispatch: Math.max(orderedQty - previousQty, 0),
      qty_remaining_after_dispatch: Math.max(orderedQty - previousQty - currentQty, 0),
    };
  });
}

async function getDispatchHeaderOrNull(client, dispatchId, distributorId = null) {
  const params = [Number(dispatchId)];
  const distributorFilter =
    Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? ` and d.distributor_id = $2` : "";
  if (distributorFilter) params.push(Number(distributorId));
  const r = await client.query(
    `
      select
        d.*,
        co.company_code,
        c.customer_name,
        c.address_line1,
        c.address_line2,
        c.address_line3,
        c.city,
        c.state,
        c.pincode,
        c.gstin as customer_gstin,
        so.so_number,
        so.order_status,
        so.intercompany_counterparty_company_id,
        so.intercompany_purchase_order_id,
        icco.company_code as intercompany_company_code,
        icco.display_name as intercompany_company_name,
        grn.grn_number as intercompany_grn_number,
        grn.company_id as intercompany_goods_receipt_company_id,
        so.order_currency_id,
        curr.currency_code as order_currency_code,
        so.end_customer_name
      from dispatches d
      left join companies co on co.id = d.company_id
      join customers c on c.id = d.customer_id
      join sales_orders so on so.id = d.sales_order_id
      left join companies icco on icco.id = so.intercompany_counterparty_company_id
      left join goods_receipts grn on grn.id = d.intercompany_goods_receipt_id
      left join currencies curr on curr.id = so.order_currency_id
      where d.id = $1
      ${distributorFilter}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

async function getDispatchLines(client, dispatchId) {
  const r = await client.query(
    `
      select
        dl.*,
        pg.group_name as product_group_name
      from dispatch_lines dl
      left join sales_order_lines sol on sol.id = dl.sales_order_line_id
      left join products p on p.id = sol.product_id
      left join product_groups pg on pg.id = p.group_id
      where dl.dispatch_id = $1
      order by dl.line_no asc, dl.id asc
    `,
    [dispatchId]
  );
  return r.rows;
}

async function getPurchaseOrderHeaderOrNull(client, purchaseOrderId, companyId) {
  const r = await client.query(
    `
      select *
      from purchase_orders
      where id = $1 and company_id = $2
      limit 1
    `,
    [Number(purchaseOrderId), Number(companyId)]
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
    [Number(purchaseOrderId)]
  );
  return r.rows;
}

async function getReceivedQtyMap(client, purchaseOrderId, { excludeGoodsReceiptId = null } = {}) {
  const params = [Number(purchaseOrderId)];
  let excludeSql = "";
  if (Number.isFinite(Number(excludeGoodsReceiptId)) && Number(excludeGoodsReceiptId) > 0) {
    params.push(Number(excludeGoodsReceiptId));
    excludeSql = ` and gr.id <> $${params.length}`;
  }

  const r = await client.query(
    `
      select
        l.purchase_order_line_id,
        coalesce(sum(l.qty_received), 0) as qty_received
      from goods_receipt_lines l
      join goods_receipts gr on gr.id = l.goods_receipt_id
      where gr.purchase_order_id = $1
        and gr.receipt_status <> 'cancelled'
        and l.purchase_order_line_id is not null
        ${excludeSql}
      group by l.purchase_order_line_id
    `,
    params
  );
  return new Map(r.rows.map((row) => [Number(row.purchase_order_line_id), qty(row.qty_received)]));
}

async function getIntercompanyGoodsReceiptOrNull(client, goodsReceiptId, companyId) {
  const r = await client.query(
    `
      select *
      from goods_receipts
      where id = $1 and company_id = $2
      limit 1
    `,
    [Number(goodsReceiptId), Number(companyId)]
  );
  return r.rows[0] || null;
}

async function upsertIntercompanyGoodsReceiptForDispatch(client, req, dispatch, dispatchLines) {
  if (!dispatch) return null;

  const status = String(dispatch.dispatch_status || "").toLowerCase();
  if (!["dispatched", "delivered"].includes(status)) return null;

  const buyerCompanyId = Number(dispatch.intercompany_counterparty_company_id);
  const purchaseOrderId = Number(dispatch.intercompany_purchase_order_id);
  if (!Number.isFinite(buyerCompanyId) || buyerCompanyId <= 0) return null;
  if (!Number.isFinite(purchaseOrderId) || purchaseOrderId <= 0) return null;

  if (!userCanAccessCompanyId(req, buyerCompanyId)) {
    return { error: "INTERCOMPANY_ACCESS_DENIED" };
  }

  const po = await getPurchaseOrderHeaderOrNull(client, purchaseOrderId, buyerCompanyId);
  if (!po) return { error: "INTERCOMPANY_PO_NOT_FOUND" };

  const poLines = await getPurchaseOrderLines(client, purchaseOrderId);
  const poLineByNo = new Map(poLines.map((row) => [Number(row.line_no), row]));

  const existingLinkRes = await client.query(`select intercompany_goods_receipt_id from dispatches where id = $1 limit 1`, [dispatch.id]);
  const existingGoodsReceiptId = Number(existingLinkRes.rows[0]?.intercompany_goods_receipt_id) || null;

  let goodsReceiptId = existingGoodsReceiptId;
  let goodsReceipt = null;
  if (goodsReceiptId) {
    goodsReceipt = await getIntercompanyGoodsReceiptOrNull(client, goodsReceiptId, buyerCompanyId);
    if (!goodsReceipt) goodsReceiptId = null;
  }

  if (!goodsReceiptId) {
    const existingByDispatch = await client.query(
      `select id from goods_receipts where company_id = $1 and intercompany_dispatch_id = $2 limit 1`,
      [buyerCompanyId, dispatch.id]
    );
    const foundId = Number(existingByDispatch.rows[0]?.id) || null;
    if (foundId) {
      goodsReceiptId = foundId;
      goodsReceipt = await getIntercompanyGoodsReceiptOrNull(client, goodsReceiptId, buyerCompanyId);
    }
  }

  if (goodsReceipt && String(goodsReceipt.receipt_status || "").toLowerCase() !== "draft") {
    return { ok: true, goods_receipt_id: goodsReceipt.id };
  }

  if (!goodsReceiptId) {
    const numRes = await client.query(`select next_company_document_number($1,'GRN') as grn_number`, [buyerCompanyId]);
    const grnNumber = numRes.rows[0]?.grn_number;
    if (!grnNumber) return { error: "NUMBERING_FAILED" };

    const insertRes = await client.query(
      `
        insert into goods_receipts (
          company_id,
          grn_number,
          vendor_id,
          purchase_order_id,
          receipt_status,
          receipt_date,
          remarks,
          created_by,
          intercompany_dispatch_id
        )
        values ($1,$2,$3,$4,'draft',current_date,$5,$6,$7)
        returning id
      `,
      [buyerCompanyId, grnNumber, po.vendor_id, purchaseOrderId, `Intercompany from ${dispatch.dispatch_number}`, req.user.id, dispatch.id]
    );
    goodsReceiptId = insertRes.rows[0]?.id;
  } else {
    await client.query(
      `
        update goods_receipts
        set vendor_id = $2,
            purchase_order_id = $3,
            intercompany_dispatch_id = $4,
            updated_at = now()
        where id = $1 and company_id = $5
      `,
      [goodsReceiptId, po.vendor_id, purchaseOrderId, dispatch.id, buyerCompanyId]
    );
    await client.query(`delete from goods_receipt_lines where goods_receipt_id = $1`, [goodsReceiptId]);
  }

  const receivedMap = await getReceivedQtyMap(client, purchaseOrderId, { excludeGoodsReceiptId: goodsReceiptId });
  let lineNo = 1;
  for (const dl of dispatchLines) {
    const poLine = poLineByNo.get(Number(dl.line_no));
    if (!poLine) continue;
    const ordered = qty(poLine.qty);
    const already = qty(receivedMap.get(Number(poLine.id)));
    const remaining = Math.max(ordered - already, 0);
    const nextQty = Math.min(qty(dl.qty_dispatch), remaining);
    if (nextQty <= 0.0000001) continue;

    await client.query(
      `
        insert into goods_receipt_lines (
          goods_receipt_id,
          purchase_order_line_id,
          line_no,
          product_id,
          item_code,
          item_name,
          line_description,
          hsn_no,
          uom,
          qty_received,
          gst_pct
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        goodsReceiptId,
        poLine.id,
        lineNo,
        poLine.product_id || null,
        poLine.item_code || null,
        poLine.item_name || null,
        poLine.line_description || null,
        poLine.hsn_no || null,
        poLine.uom || null,
        nextQty,
        poLine.gst_pct || 0,
      ]
    );
    lineNo += 1;
  }

  const lineCountRes = await client.query(`select count(*)::int as c from goods_receipt_lines where goods_receipt_id = $1`, [goodsReceiptId]);
  const c = Number(lineCountRes.rows[0]?.c || 0);
  if (c <= 0) return { error: "NOTHING_TO_RECEIVE" };

  await client.query(
    `
      update dispatches
      set intercompany_goods_receipt_id = $2,
          updated_at = now()
      where id = $1
    `,
    [dispatch.id, goodsReceiptId]
  );

  return { ok: true, goods_receipt_id: goodsReceiptId };
}

router.get("/", requireScreenAction("dispatches", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const qText = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim() : "";

    const params = [];
    const where = [];
    if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
      params.push(Number(distributorId));
      where.push(`d.distributor_id = $${params.length}`);
    } else {
      params.push(activeCompanyId);
      where.push(`d.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "dispatches")) {
      params.push(Number(req.user.id));
      where.push(`d.created_by = $${params.length}`);
    }

    if (status) {
      params.push(status);
      where.push(`d.dispatch_status = $${params.length}`);
    }
    if (qText) {
      params.push(`%${qText}%`);
      where.push(`(d.dispatch_number ilike $${params.length} or c.customer_name ilike $${params.length} or so.so_number ilike $${params.length})`);
    }
    if (bucket === "dispatched_not_invoiced") {
      params.push(["dispatched", "delivered"]);
      where.push(`d.dispatch_status = any($${params.length}::text[])`);
      where.push(
        `not exists (
          select 1
          from customer_invoices ci
          where ci.sales_order_id = d.sales_order_id
            and ci.invoice_status <> 'cancelled'
        )`
      );
    }
    if (bucket === "ready_missing_transporter") {
      where.push(`d.dispatch_status = 'ready'`);
      where.push(`coalesce(trim(d.transporter_name), '') = ''`);
    }
    if (bucket === "ready_to_dispatch") {
      where.push(`d.dispatch_status = 'ready'`);
      where.push(`coalesce(trim(d.transporter_name), '') <> ''`);
    }
    if (bucket === "in_transit") {
      where.push(`d.dispatch_status = 'dispatched'`);
    }
    if (bucket === "dispatched_missing_docs") {
      params.push(["dispatched", "delivered"]);
      where.push(`d.dispatch_status = any($${params.length}::text[])`);
      where.push(
        `(
          coalesce(trim(d.lr_no), '') = ''
          or coalesce(trim(d.vehicle_no), '') = ''
          or coalesce(trim(d.eway_bill_no), trim(d.eway_ref), '') = ''
        )`
      );
    }
    if (bucket === "docs_pending") {
      where.push(
        `(
          (d.dispatch_status = 'ready' and coalesce(trim(d.transporter_name), '') = '')
          or (d.dispatch_status in ('dispatched','delivered') and (
            coalesce(trim(d.lr_no), '') = ''
            or coalesce(trim(d.vehicle_no), '') = ''
            or coalesce(trim(d.eway_bill_no), trim(d.eway_ref), '') = ''
          ))
        )`
      );
    }
    if (bucket === "eway_warning") {
      // Simplified SQL mirror of evaluateEwayCompliance — JS eway block is source of truth for chips.
      where.push(`d.dispatch_status in ('ready','dispatched','delivered')`);
      where.push(
        `(
          coalesce(inv.grand_total_base, so.grand_total_base, 0) >= ${EWAY_THRESHOLD_INR}
          and (
            coalesce(trim(d.eway_bill_no), '') = ''
            or coalesce(trim(d.transport_mode), '') = ''
            or d.approx_distance_km is null
            or d.approx_distance_km <= 0
            or (coalesce(d.transport_mode, 'road') = 'road' and coalesce(trim(d.vehicle_no), '') = '')
            or (coalesce(d.transport_mode, '') in ('rail','air','ship') and coalesce(trim(d.lr_no), '') = '')
          )
        )`
      );
    }
    if (bucket === "eway_expired") {
      where.push(`d.dispatch_status = 'dispatched'`);
      where.push(`d.eway_valid_till is not null`);
      where.push(`d.eway_valid_till < now()`);
    }
    if (bucket === "packing_list_pending") {
      params.push(["dispatched", "delivered"]);
      where.push(`d.dispatch_status = any($${params.length}::text[])`);
      where.push(`coalesce(trim(d.packing_list_no), '') = ''`);
    }
    if (bucket === "pod_pending") {
      where.push(`d.dispatch_status = 'delivered'`);
      where.push(`d.pod_attachment_id is null`);
    }
    if (bucket === "freight_pending") {
      where.push(`d.dispatch_status = 'delivered'`);
      where.push(`(coalesce(trim(d.freight_bill_no), '') = '' or coalesce(d.freight_amount, 0) <= 0)`);
    }

    const r = await pool.query(
      `
        select
          d.id,
          d.dispatch_number,
          d.dispatch_status,
          d.dispatch_date,
          d.sales_order_id,
          d.transporter_name,
          d.transporter_id,
          d.lr_no,
          d.lr_date,
          d.vehicle_no,
          d.vehicle_type,
          d.transport_mode,
          d.approx_distance_km,
          d.eway_ref,
          d.eway_bill_no,
          d.eway_bill_date,
          d.eway_valid_till,
          d.ship_to_gstin,
          d.dispatch_from_pincode,
          d.tracking_ref,
          d.packing_list_no,
          d.freight_bill_no,
          d.freight_amount,
          d.pod_attachment_id,
          d.consignee_name,
          c.customer_name,
          c.gstin as customer_gstin,
          c.state as customer_state,
          so.so_number,
          so.grand_total_base as so_grand_total_base,
          inv.grand_total_base as invoice_grand_total_base,
          qty.qty_dispatched,
          qty.qty_ordered,
          (
            d.dispatch_status in ('dispatched', 'delivered')
            and not exists (
              select 1
              from customer_invoices ci
              where ci.sales_order_id = d.sales_order_id
                and ci.invoice_status <> 'cancelled'
            )
          ) as needs_invoice
        from dispatches d
        join customers c on c.id = d.customer_id
        join sales_orders so on so.id = d.sales_order_id
        ${EWAY_VALUE_LATERALS}
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by d.created_at desc, d.id desc
      `,
      params
    );

    let sellerProfile = null;
    if (!isDistributor && activeCompanyId) {
      sellerProfile = await getCompanyProfile(pool, activeCompanyId);
    }

    const dispatches = r.rows.map((row) => ({
      ...row,
      eway: buildEwayBlock(row, { sellerProfile }),
    }));

    return res.json({ ok: true, dispatches });
  } catch (err) {
    return next(err);
  }
});

router.get("/shipment-control-summary", requireScreenAction("dispatches", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const params = [];
    const where = [];
    if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
      params.push(Number(distributorId));
      where.push(`d.distributor_id = $${params.length}`);
    } else {
      params.push(activeCompanyId);
      where.push(`d.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "dispatches")) {
      params.push(Number(req.user.id));
      where.push(`d.created_by = $${params.length}`);
    }

    const r = await pool.query(
      `
        select
          count(*)::int as total,
          sum(case when d.dispatch_status = 'draft' then 1 else 0 end)::int as draft,
          sum(case when d.dispatch_status = 'ready' then 1 else 0 end)::int as ready,
          sum(case when d.dispatch_status = 'dispatched' then 1 else 0 end)::int as dispatched,
          sum(case when d.dispatch_status = 'delivered' then 1 else 0 end)::int as delivered,
          sum(case when d.dispatch_status = 'cancelled' then 1 else 0 end)::int as cancelled,
          sum(case when d.dispatch_status = 'ready' and coalesce(trim(d.transporter_name), '') = '' then 1 else 0 end)::int as ready_missing_transporter,
          sum(case when d.dispatch_status = 'ready' and coalesce(trim(d.transporter_name), '') <> '' then 1 else 0 end)::int as ready_to_dispatch,
          sum(case when d.dispatch_status = 'dispatched' then 1 else 0 end)::int as in_transit,
          sum(
            case
              when d.dispatch_status in ('dispatched','delivered')
                and (
                  coalesce(trim(d.lr_no), '') = ''
                  or coalesce(trim(d.vehicle_no), '') = ''
                  or coalesce(trim(d.eway_bill_no), trim(d.eway_ref), '') = ''
                )
              then 1
              else 0
            end
          )::int as dispatched_missing_docs,
          sum(
            case
              when d.dispatch_status in ('dispatched','delivered')
                and not exists (
                  select 1
                  from customer_invoices ci
                  where ci.sales_order_id = d.sales_order_id
                    and ci.invoice_status <> 'cancelled'
                )
              then 1
              else 0
            end
          )::int as dispatched_not_invoiced,
          sum(
            case
              when (d.dispatch_status = 'ready' and coalesce(trim(d.transporter_name), '') = '')
                or (d.dispatch_status in ('dispatched','delivered') and (
                  coalesce(trim(d.lr_no), '') = ''
                  or coalesce(trim(d.vehicle_no), '') = ''
                  or coalesce(trim(d.eway_bill_no), trim(d.eway_ref), '') = ''
                ))
              then 1
              else 0
            end
          )::int as docs_pending
          ,
          sum(
            case
              when d.dispatch_status in ('dispatched','delivered')
                and coalesce(trim(d.packing_list_no), '') = ''
              then 1
              else 0
            end
          )::int as packing_list_pending,
          sum(case when d.dispatch_status = 'delivered' and d.pod_attachment_id is null then 1 else 0 end)::int as pod_pending,
          sum(
            case
              when d.dispatch_status = 'delivered'
                and (coalesce(trim(d.freight_bill_no), '') = '' or coalesce(d.freight_amount, 0) <= 0)
              then 1
              else 0
            end
          )::int as freight_pending,
          sum(
            case
              when ${EWAY_INCOMPLETE_SQL}
              then 1
              else 0
            end
          )::int as eway_warning,
          sum(
            case
              when d.dispatch_status = 'dispatched'
                and d.eway_valid_till is not null
                and d.eway_valid_till < now()
              then 1
              else 0
            end
          )::int as eway_expired
        from dispatches d
        join sales_orders so on so.id = d.sales_order_id
        ${EWAY_VALUE_LATERALS}
        ${where.length ? `where ${where.join(" and ")}` : ""}
      `,
      params
    );

    return res.json({ ok: true, summary: r.rows[0] || null });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireScreenAction("dispatches", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    const header = await getDispatchHeaderOrNull(pool, id, distributorId);
    if (!header) return res.status(404).json({ ok: false });
    if (!canAccessDispatch(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, header)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const progressLines = await buildDispatchProgressLines(pool, header.sales_order_id, { excludeDispatchId: id });
    const progressMap = new Map(progressLines.map((line) => [Number(line.id), line]));
    const lines = enrichDispatchLines(await getDispatchLines(pool, id), progressMap);
    const creditControl = await getCustomerCreditSnapshot(pool, {
      customerId: header.customer_id,
      companyId: header.company_id,
      distributorId: isDistributor ? distributorId : header.distributor_id,
    });
    let needsInvoice = false;
    if (["dispatched", "delivered"].includes(String(header.dispatch_status || "").toLowerCase()) && header.sales_order_id) {
      const invoiceCheck = await pool.query(
        `
          select 1
          from customer_invoices ci
          where ci.sales_order_id = $1
            and ci.invoice_status <> 'cancelled'
          limit 1
        `,
        [Number(header.sales_order_id)]
      );
      needsInvoice = !invoiceCheck.rows?.[0];
    }
    const valueRow = await loadConsignmentValueForDispatch(pool, header.sales_order_id, id);
    const sellerProfile = await getCompanyProfile(pool, header.company_id);
    const eway = buildEwayBlock(
      {
        ...header,
        ...valueRow,
        customer_state: header.state,
      },
      { sellerProfile }
    );
    return res.json({
      ok: true,
      dispatch: header,
      lines,
      needs_invoice: needsInvoice,
      eway,
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

router.get("/:id/pdf", requireScreenAction("dispatches", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    const dispatch = await getDispatchHeaderOrNull(pool, id, distributorId);
    if (!dispatch) return res.status(404).json({ ok: false });
    if (!canAccessDispatch(req, dispatch)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, dispatch)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const [progressLines, rawLines, sellerProfile] = await Promise.all([
      buildDispatchProgressLines(pool, dispatch.sales_order_id, { excludeDispatchId: id }),
      getDispatchLines(pool, id),
      getCompanyProfile(pool, dispatch.company_id),
    ]);
    const progressMap = new Map(progressLines.map((line) => [Number(line.id), line]));
    const lines = enrichDispatchLines(rawLines, progressMap);
    const pdf = await generateQuotePdfBuffer(
      renderDispatchHtml({
        dispatch,
        lines,
        sellerProfile: enrichCompanyProfileAssets(sellerProfile),
      })
    );
    const fileName = `${safeFileSegment(dispatch.dispatch_number || `dispatch_${id}`)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(pdf);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/packing-list/pdf", requireScreenAction("dispatches", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    const dispatch = await getDispatchHeaderOrNull(pool, id, distributorId);
    if (!dispatch) return res.status(404).json({ ok: false });
    if (!canAccessDispatch(req, dispatch)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, dispatch)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const [progressLines, rawLines, sellerProfile] = await Promise.all([
      buildDispatchProgressLines(pool, dispatch.sales_order_id, { excludeDispatchId: id }),
      getDispatchLines(pool, id),
      getCompanyProfile(pool, dispatch.company_id),
    ]);
    const progressMap = new Map(progressLines.map((line) => [Number(line.id), line]));
    const lines = enrichDispatchLines(rawLines, progressMap);
    const pdf = await generateQuotePdfBuffer(
      renderPackingListHtml({
        dispatch,
        lines,
        sellerProfile: enrichCompanyProfileAssets(sellerProfile),
      })
    );
    const baseName = safeFileSegment(dispatch.packing_list_no || dispatch.dispatch_number || `packing_list_${id}`);
    const fileName = `${baseName}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(pdf);
  } catch (err) {
    return next(err);
  }
});

function safeDispatchAssetSegment(v) {
  const s = String(v || "");
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned || "file";
}

function ensureDispatchAssetsDir(type) {
  const t = safeDispatchAssetSegment(type);
  const d = path.resolve(__dirname, "..", "..", "storage", "dispatches", t);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function isPODUpload(file) {
  if (!file) return false;
  const name = typeof file.originalname === "string" ? file.originalname.toLowerCase() : "";
  const mime = typeof file.mimetype === "string" ? file.mimetype.toLowerCase() : "";
  if (mime === "application/pdf") return true;
  if (mime.startsWith("image/")) return true;
  if (name.endsWith(".pdf")) return true;
  if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return true;
  return false;
}

router.post("/:id/pod", requireScreenAction("dispatches", "can_edit"), upload.single("file"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });
    const file = req.file;
    if (!isPODUpload(file)) return res.status(400).json({ ok: false, error: "INVALID_FILE_TYPE" });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    await client.query("begin");
    const dispatch = await getDispatchHeaderOrNull(client, id, distributorId);
    if (!dispatch) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessDispatch(req, dispatch)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, dispatch)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const dir = ensureDispatchAssetsDir("pod");
    const ext = (() => {
      const name = typeof file.originalname === "string" ? file.originalname.toLowerCase() : "";
      if (name.endsWith(".pdf")) return ".pdf";
      if (name.endsWith(".png")) return ".png";
      if (name.endsWith(".jpg")) return ".jpg";
      if (name.endsWith(".jpeg")) return ".jpeg";
      if (String(file.mimetype || "").toLowerCase() === "application/pdf") return ".pdf";
      if (String(file.mimetype || "").toLowerCase() === "image/png") return ".png";
      if (String(file.mimetype || "").toLowerCase() === "image/jpeg") return ".jpg";
      return "";
    })();

    const fileNameBase = safeDispatchAssetSegment(dispatch.dispatch_number || `dispatch_${id}`);
    const storedFileName = `${fileNameBase}_pod_${Date.now()}${ext}`;
    const absFilePath = path.join(dir, storedFileName);
    fs.writeFileSync(absFilePath, file.buffer);

    const attach = await createOwnedAttachment(client, {
      fileName: file.originalname || storedFileName,
      filePath: absFilePath,
      mimeType: file.mimetype || "application/octet-stream",
      fileSizeBytes: file.size || file.buffer.length || 0,
      uploadedBy: req.user.id,
      companyId: dispatch.company_id,
      ownerType: "dispatch_pod",
      ownerId: id,
    });
    const attachmentId = Number(attach?.id || 0);
    if (!attachmentId) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "ATTACHMENT_CREATE_FAILED" });
    }

    await client.query(`update dispatches set pod_attachment_id = $2, updated_at = now() where id = $1`, [id, attachmentId]);
    await client.query("commit");

    const nextDispatch = await getDispatchHeaderOrNull(pool, id, distributorId);
    return res.json({ ok: true, dispatch: nextDispatch, attachment_id: attachmentId });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id/pod", requireScreenAction("dispatches", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    const dispatch = await getDispatchHeaderOrNull(pool, id, distributorId);
    if (!dispatch) return res.status(404).json({ ok: false });
    if (!canAccessDispatch(req, dispatch)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, dispatch)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const attachmentId = Number(dispatch.pod_attachment_id || 0);
    if (!attachmentId) return res.status(404).json({ ok: false, error: "POD_NOT_AVAILABLE" });

    const r = await pool.query(`select id, file_name, file_path, mime_type from attachments where id = $1 limit 1`, [attachmentId]);
    const row = r.rows[0] || null;
    if (!row?.file_path || !fs.existsSync(row.file_path)) return res.status(404).json({ ok: false, error: "POD_FILE_MISSING" });

    const fileName = row.file_name || `pod_${id}`;
    res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileSegment(fileName)}"`);
    return res.status(200).send(fs.readFileSync(row.file_path));
  } catch (err) {
    return next(err);
  }
});

router.post("/from-sales-order/:id", requireScreenAction("dispatches", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const salesOrderId = Number(req.params.id);
    if (!Number.isFinite(salesOrderId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    await client.query("begin");
    const order = await getSalesOrderForDispatch(client, salesOrderId, distributorId);
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
    if (!["confirmed", "closed"].includes(String(order.order_status || "").trim().toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ORDER_NOT_READY_FOR_DISPATCH" });
    }

    try {
      const { assertSiteReadinessApprovedForDispatch } = require("../services/commissioningGates");
      await assertSiteReadinessApprovedForDispatch(client, salesOrderId);
    } catch (gateErr) {
      await client.query("rollback");
      if (gateErr?.status) {
        return res.status(gateErr.status).json({
          ok: false,
          error: gateErr.code || gateErr.message,
          detail: gateErr.detail || null,
        });
      }
      throw gateErr;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const force = body.force === true || body.force === "true" || body.force === 1 || body.force === "1";
    const forceReason = typeof body.force_reason === "string" ? body.force_reason.trim() : "";
    const readiness = await getDispatchReadiness(client, salesOrderId);
    const manufacturingGate =
      Number(readiness.linked_job_count || 0) > 0 && (readiness.production_blocked || !readiness.ready_for_dispatch);
    if (manufacturingGate) {
      const canOverride =
        req.user.group_name === "SuperAdmin" || hasScreenAction(req, "dispatches", "can_approve");
      if (!force || !canOverride || forceReason.length < 3) {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: "ORDER_NOT_READY",
          detail: readiness.blockers.join("; ") || "Production or FG readiness is blocking dispatch.",
          readiness,
          override_allowed: canOverride,
        });
      }
      process.stderr.write(
        `[dispatch-override] so=${salesOrderId} user=${req.user.id} reason=${forceReason.replace(/\s+/g, " ").slice(0, 200)}\n`
      );
    }

    const lines = await buildDispatchProgressLines(client, salesOrderId);
    const creatableLines = lines.filter((line) => qty(line.qty_remaining_dispatch) > 0);
    if (!lines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_LINES" });
    }
    if (!creatableLines.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "FULLY_DISPATCHED" });
    }

    const companyId = requireResolvedCompanyId(req, order.company_id);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    const sellerProfile = await getCompanyProfile(client, companyId);
    const numRes = await client.query(`select next_company_document_number($1, 'DISP') as dispatch_number`, [companyId]);
    const dispatchNumber = numRes.rows[0]?.dispatch_number;
    const fallbackCustomerAddress = [order.address_line1, order.address_line2, order.address_line3, order.city, order.state, order.pincode]
      .filter(Boolean)
      .join(", ");
    const shipToName = order.ship_to_name || order.ship_to_site_name || order.end_customer_name || order.customer_name;
    const shipToAddress = order.ship_to_address || fallbackCustomerAddress || null;

    const headerRes = await client.query(
      `
        insert into dispatches (
          dispatch_number, company_id, sales_order_id, customer_id, distributor_id, dispatch_status, dispatch_date,
          consignee_name, consignee_address, bill_to_name, bill_to_address, ship_to_customer_site_id, ship_to_name, ship_to_address,
          ship_to_gstin, dispatch_from_pincode, transport_mode, created_by
        )
        values ($1,$2,$3,$4,$5,'draft',current_date,$6,$7,$8,$9,$10,$11,$12,$13,$14,'road',$15)
        returning id
      `,
      [
        dispatchNumber,
        companyId,
        salesOrderId,
        order.customer_id,
        order.distributor_id || null,
        shipToName || order.customer_name,
        shipToAddress || null,
        order.bill_to_name || order.customer_name,
        order.bill_to_address || fallbackCustomerAddress || null,
        order.ship_to_customer_site_id || null,
        shipToName || order.customer_name,
        shipToAddress || null,
        order.customer_gstin || null,
        sellerProfile?.pincode || order.pincode || null,
        req.user.id,
      ]
    );
    const dispatchId = headerRes.rows[0]?.id;

    for (const line of creatableLines) {
      await client.query(
        `
          insert into dispatch_lines (
            dispatch_id, sales_order_line_id, line_no, item_code, item_name, line_description, qty_ordered, qty_dispatch, gst_pct
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          dispatchId,
          line.id,
          line.line_no,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.qty_ordered,
          line.qty_remaining_dispatch,
          line.gst_pct,
        ]
      );
    }

    await client.query("commit");
    const dispatch = await getDispatchHeaderOrNull(client, dispatchId);
    const progressLines = await buildDispatchProgressLines(client, salesOrderId, { excludeDispatchId: dispatchId });
    const progressMap = new Map(progressLines.map((line) => [Number(line.id), line]));
    const dispatchLines = enrichDispatchLines(await getDispatchLines(client, dispatchId), progressMap);
    return res.status(201).json({ ok: true, dispatch, lines: dispatchLines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id", requireScreenAction("dispatches", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const dispatchId = Number(req.params.id);
    if (!Number.isFinite(dispatchId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const status = typeof body.dispatch_status === "string" ? body.dispatch_status.trim().toLowerCase() : "draft";
    if (!["draft", "ready", "dispatched", "delivered", "cancelled"].includes(status)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    await client.query("begin");
    const header = await getDispatchHeaderOrNull(client, dispatchId, distributorId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessDispatch(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    if (["ready", "dispatched", "delivered"].includes(status)) {
      const creditControl = await getCustomerCreditSnapshot(client, {
        customerId: header.customer_id,
        companyId: header.company_id,
        distributorId: isDistributor ? distributorId : header.distributor_id,
      });
      const decision = getCreditControlDecision(creditControl, "dispatch_release");
      if (decision?.block) {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: decision.code || "CREDIT_CONTROL_BLOCKED",
          detail: decision.message || "Credit control blocked dispatch release.",
          credit_control: creditControl,
        });
      }
    }

    const previousEwayBillNo = header.eway_bill_no || null;
    const nextEwayBillNo = emptyToNull(body.eway_bill_no);
    const nextEwayBillDate = emptyToNull(body.eway_bill_date);
    const nextEwayValidTill = emptyToNull(body.eway_valid_till);
    const transportMode = normalizeTransportMode(body.transport_mode);
    const vehicleTypeRaw = emptyToNull(body.vehicle_type);
    const vehicleType = transportMode === "road" ? (vehicleTypeRaw === "O" ? "O" : vehicleTypeRaw === "R" ? "R" : null) : null;
    const ewayRefWriteThrough = nextEwayBillNo || emptyToNull(body.eway_ref);

    await client.query(
      `
        update dispatches
        set dispatch_status = $2,
            dispatch_date = coalesce($3, dispatch_date),
            transporter_name = $4,
            lr_no = $5,
            vehicle_no = $6,
            eway_ref = $7,
            tracking_ref = $8,
            consignee_name = $9,
            consignee_address = $10,
            bill_to_name = $11,
            bill_to_address = $12,
            ship_to_name = $13,
            ship_to_address = $14,
            remarks = $15,
            packing_list_no = $16,
            packing_list_date = $17,
            no_of_packages = $18,
            gross_weight = $19,
            net_weight = $20,
            packing_remarks = $21,
            freight_amount = $22,
            freight_bill_no = $23,
            freight_bill_date = $24,
            freight_paid_by = $25,
            eway_bill_no = $26,
            eway_bill_date = $27,
            eway_valid_till = $28,
            transporter_id = $29,
            transport_mode = $30,
            vehicle_type = $31,
            approx_distance_km = $32,
            ship_to_gstin = $33,
            lr_date = $34,
            dispatch_from_pincode = $35,
            updated_at = now()
        where id = $1
      `,
      [
        dispatchId,
        status,
        body.dispatch_date || null,
        emptyToNull(body.transporter_name),
        emptyToNull(body.lr_no),
        emptyToNull(body.vehicle_no),
        ewayRefWriteThrough,
        emptyToNull(body.tracking_ref),
        emptyToNull(body.ship_to_name || body.consignee_name),
        emptyToNull(body.ship_to_address || body.consignee_address),
        emptyToNull(body.bill_to_name),
        emptyToNull(body.bill_to_address),
        emptyToNull(body.ship_to_name || body.consignee_name),
        emptyToNull(body.ship_to_address || body.consignee_address),
        emptyToNull(body.remarks),
        emptyToNull(body.packing_list_no),
        emptyToNull(body.packing_list_date),
        optionalNumber(body.no_of_packages),
        optionalNumber(body.gross_weight),
        optionalNumber(body.net_weight),
        emptyToNull(body.packing_remarks),
        optionalNumber(body.freight_amount),
        emptyToNull(body.freight_bill_no),
        emptyToNull(body.freight_bill_date),
        emptyToNull(body.freight_paid_by),
        nextEwayBillNo,
        nextEwayBillDate,
        nextEwayValidTill,
        emptyToNull(body.transporter_id),
        transportMode,
        vehicleType,
        optionalNumber(body.approx_distance_km),
        emptyToNull(body.ship_to_gstin),
        emptyToNull(body.lr_date),
        emptyToNull(body.dispatch_from_pincode),
      ]
    );

    if (nextEwayBillNo) {
      await syncInvoiceEwayFromDispatch(client, {
        salesOrderId: header.sales_order_id,
        previousEwayBillNo,
        nextEwayBillNo,
        nextEwayBillDate,
        nextEwayValidTill,
      });
    }

    const progressLines = await buildDispatchProgressLines(client, header.sales_order_id, { excludeDispatchId: dispatchId });
    const progressMap = new Map(progressLines.map((line) => [Number(line.id), line]));
    const lines = Array.isArray(body.lines) ? body.lines : [];
    for (const line of lines) {
      const id = Number(line.id);
      const qtyDispatch = Number(line.qty_dispatch || 0);
      const soLineId = Number(line.sales_order_line_id);
      const progress = progressMap.get(soLineId);
      const qtyOrdered = qty(progress?.qty_ordered);
      const qtyRemaining = qty(progress?.qty_remaining_dispatch);
      if (!Number.isFinite(id)) continue;
      if (!Number.isFinite(qtyDispatch) || qtyDispatch < 0 || qtyDispatch > qtyRemaining) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_DISPATCH_QTY" });
      }
      await client.query(
        `update dispatch_lines set qty_dispatch = $2, updated_at = now() where id = $1 and dispatch_id = $3`,
        [id, qtyDispatch, dispatchId]
      );
    }

    const companyRes = await client.query(`select company_id from dispatches where id = $1 limit 1`, [dispatchId]);
    const companyId = Number(companyRes.rows[0]?.company_id) || null;
    await syncStockForDispatch(client, companyId, dispatchId, status);

    const nextDispatchLines = await getDispatchLines(client, dispatchId);
    const icRes = await upsertIntercompanyGoodsReceiptForDispatch(client, req, { ...header, dispatch_status: status }, nextDispatchLines);
    if (icRes?.error === "INTERCOMPANY_ACCESS_DENIED") {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "INTERCOMPANY_ACCESS_DENIED" });
    }
    if (icRes?.error === "NOTHING_TO_RECEIVE") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NOTHING_TO_RECEIVE" });
    }
    await client.query("commit");
    const dispatch = await getDispatchHeaderOrNull(client, dispatchId);
    const prevStatus = String(header.dispatch_status || "").toLowerCase();
    if (status === "dispatched" && prevStatus !== "dispatched" && dispatch?.sales_order_id) {
      const invCheck = await client.query(
        `
          select count(*)::int as invoice_count
          from customer_invoices
          where sales_order_id = $1
            and invoice_status <> 'cancelled'
        `,
        [Number(dispatch.sales_order_id)]
      );
      if (Number(invCheck.rows[0]?.invoice_count || 0) <= 0) {
        notifyDispatchNeedsInvoice({
          dispatchId,
          dispatchNumber: dispatch.dispatch_number,
          salesOrderId: dispatch.sales_order_id,
          companyId: dispatch.company_id,
          actorUserId: req.user.id,
          createdByUserId: dispatch.created_by || header.created_by || null,
          customerName: dispatch.customer_name || "",
        }).catch(() => {});
      }
    }
    const nextProgressLines = await buildDispatchProgressLines(client, header.sales_order_id, { excludeDispatchId: dispatchId });
    const nextProgressMap = new Map(nextProgressLines.map((line) => [Number(line.id), line]));
    const dispatchLines = enrichDispatchLines(await getDispatchLines(client, dispatchId), nextProgressMap);
    const creditControl = await getCustomerCreditSnapshot(client, {
      customerId: dispatch?.customer_id,
      companyId: dispatch?.company_id,
      distributorId: isDistributor ? distributorId : dispatch?.distributor_id,
    });
    const valueRow = await loadConsignmentValueForDispatch(client, header.sales_order_id, dispatchId);
    const sellerProfile = await getCompanyProfile(client, dispatch?.company_id);
    const eway = buildEwayBlock(
      {
        ...dispatch,
        ...valueRow,
        customer_state: dispatch?.state,
      },
      { sellerProfile }
    );
    if (["ready", "dispatched", "delivered"].includes(status) && eway.severity === "warning") {
      const codes = (eway.warnings || []).map((w) => w.code).join(",");
      process.stderr.write(
        `[eway-warning] dispatch=${dispatchId} so=${header.sales_order_id} user=${req.user.id} value=${eway.consignment_value} codes=${codes}\n`
      );
    }
    return res.json({
      ok: true,
      dispatch,
      lines: dispatchLines,
      eway,
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

router.post("/:id/eway/update-vehicle", requireScreenAction("dispatches", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const dispatchId = Number(req.params.id);
    if (!Number.isFinite(dispatchId) || dispatchId <= 0) {
      client.release();
      return res.status(400).json({ ok: false, error: "INVALID_ID" });
    }

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) {
      client.release();
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) {
      client.release();
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const header = await getDispatchHeaderOrNull(client, dispatchId, distributorId);
    if (!header) {
      client.release();
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessDispatch(req, header)) {
      client.release();
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, header)) {
      client.release();
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const nextVehicleNo = emptyToNull(body.vehicle_no) || emptyToNull(header.vehicle_no);
    if (!emptyToNull(header.eway_bill_no)) {
      client.release();
      return res.status(409).json({ ok: false, error: "NO_EWAY_ON_DISPATCH" });
    }
    if (!nextVehicleNo) {
      client.release();
      return res.status(400).json({ ok: false, error: "VEHICLE_NO_REQUIRED" });
    }

    const transportMode = normalizeTransportMode(body.transport_mode || header.transport_mode) || "road";
    const vehicleTypeRaw = emptyToNull(body.vehicle_type) || emptyToNull(header.vehicle_type);
    const vehicleType = transportMode === "road" ? (vehicleTypeRaw === "O" ? "O" : "R") : null;
    const approxDistance =
      optionalNumber(body.approx_distance_km) ?? optionalNumber(header.approx_distance_km);

    const dispatchForPayload = {
      ...header,
      vehicle_no: nextVehicleNo,
      transport_mode: transportMode,
      vehicle_type: vehicleType,
      approx_distance_km: approxDistance,
      transporter_id: emptyToNull(body.transporter_id) || header.transporter_id,
      transporter_name: emptyToNull(body.transporter_name) || header.transporter_name,
      lr_no: emptyToNull(body.lr_no) || header.lr_no,
      lr_date: body.lr_date || header.lr_date,
      dispatch_from_pincode: emptyToNull(body.dispatch_from_pincode) || header.dispatch_from_pincode,
      dispatch_from_place: emptyToNull(body.dispatch_from_place) || null,
    };

    const payload = buildEwayVehicleUpdatePayload({
      dispatch: dispatchForPayload,
      reasonCode: body.reason_code || "1",
      remark: body.remark || "Vehicle changed",
    });

    await client.query("begin");
    let result;
    let linkedInvoiceId = null;
    try {
      const invLookup = await client.query(
        `
          select id
          from customer_invoices
          where sales_order_id = $1
            and invoice_status <> 'cancelled'
            and (
              eway_bill_no is null
              or eway_bill_no = $2
            )
          order by id desc
          limit 1
        `,
        [header.sales_order_id, header.eway_bill_no]
      );
      linkedInvoiceId = invLookup.rows[0]?.id || null;

      result = await gspUpdateEwayVehicle(client, {
        companyId: header.company_id,
        payload,
      });
    } catch (err) {
      if (linkedInvoiceId) {
        await logEinvoiceEvent(client, {
          companyId: header.company_id,
          invoiceId: linkedInvoiceId,
          eventType: "eway_generate",
          requestPayload: { action: "VEHEWB", dispatch_id: dispatchId, payload },
          responsePayload: err.details || null,
          status: "failed",
          error: err.message,
          userId: req.user.id,
        }).catch(() => {});
      }
      await client.query("rollback");
      if (err instanceof EinvoiceNotConfiguredError || err?.code === "NOT_CONFIGURED") {
        return res.status(501).json({ ok: false, error: "NOT_CONFIGURED", detail: err.message });
      }
      if (err instanceof GspTransportError || err?.name === "GspTransportError") {
        return res.status(err.status || 502).json({
          ok: false,
          error: err.code || "GSP_ERROR",
          detail: err.message,
          details: err.details || null,
        });
      }
      throw err;
    }

    await client.query(
      `
        update dispatches
        set vehicle_no = $2,
            transport_mode = $3,
            vehicle_type = $4,
            approx_distance_km = coalesce($5, approx_distance_km),
            transporter_id = coalesce($6, transporter_id),
            transporter_name = coalesce($7, transporter_name),
            lr_no = coalesce($8, lr_no),
            lr_date = coalesce($9::date, lr_date),
            eway_valid_till = coalesce($10::timestamptz, eway_valid_till),
            updated_at = now()
        where id = $1
      `,
      [
        dispatchId,
        nextVehicleNo,
        transportMode,
        vehicleType,
        approxDistance,
        emptyToNull(body.transporter_id) || null,
        emptyToNull(body.transporter_name) || null,
        emptyToNull(body.lr_no) || null,
        body.lr_date || null,
        result.validTill || null,
      ]
    );

    // Soft-refresh invoice valid_till when linked and EBN matches.
    await client.query(
      `
        update customer_invoices
        set eway_valid_till = coalesce($3::timestamptz, eway_valid_till),
            updated_at = now()
        where sales_order_id = $1
          and invoice_status <> 'cancelled'
          and eway_bill_no = $2
      `,
      [header.sales_order_id, header.eway_bill_no, result.validTill || null]
    );

    if (linkedInvoiceId) {
      await logEinvoiceEvent(client, {
        companyId: header.company_id,
        invoiceId: linkedInvoiceId,
        eventType: "eway_generate",
        requestPayload: { action: "VEHEWB", dispatch_id: dispatchId, payload },
        responsePayload: { eway_bill_no: result.ewayBillNo, mocked: Boolean(result.mocked), raw: result.raw },
        status: "success",
        userId: req.user.id,
      }).catch(() => {});
    }

    await client.query("commit");

    const next = await getDispatchHeaderOrNull(pool, dispatchId, distributorId);
    return res.json({
      ok: true,
      dispatch: next,
      gsp: {
        provider: result.provider,
        mocked: Boolean(result.mocked),
        eway_bill_no: result.ewayBillNo,
        valid_till: result.validTill || null,
      },
    });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/intercompany/upsert-grn", requireScreenAction("dispatches", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const dispatchId = Number(req.params.id);
    if (!Number.isFinite(dispatchId) || dispatchId <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    await client.query("begin");

    const header = await getDispatchHeaderOrNull(client, dispatchId, distributorId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessDispatch(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const status = String(header.dispatch_status || "").toLowerCase();
    if (!["dispatched", "delivered"].includes(status)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "DISPATCH_NOT_READY_FOR_GRN" });
    }
    if (!header.intercompany_counterparty_company_id || !header.intercompany_purchase_order_id) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "INTERCOMPANY_NOT_CONFIGURED" });
    }

    const lines = await getDispatchLines(client, dispatchId);
    const r = await upsertIntercompanyGoodsReceiptForDispatch(client, req, header, lines);
    if (r?.error === "INTERCOMPANY_ACCESS_DENIED") {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "INTERCOMPANY_ACCESS_DENIED" });
    }
    if (!r) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "DISPATCH_NOT_READY_FOR_GRN" });
    }
    if (r?.error) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: r.error });
    }

    await client.query("commit");
    return res.status(201).json({ ok: true, goods_receipt_id: r.goods_receipt_id });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
