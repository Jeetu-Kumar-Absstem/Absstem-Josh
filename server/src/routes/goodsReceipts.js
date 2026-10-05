const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { evaluateApprovalPermission, insertApprovalHistory, resolveApprovalState } = require("../services/approvalPolicy");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");
const { syncStockForGoodsReceipt } = require("../services/stockLedger");
const { createVendorQuick } = require("../services/createVendorQuick");
const { notifyGrnShortClosed } = require("../services/notifications");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(4));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value, fallback = 100, max = 300) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function isIntLike(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.floor(n) === n;
}

function canAccessGoodsReceipt(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "goods_receipts")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function getGoodsReceiptHeaderOrNull(client, id, companyId) {
  const r = await client.query(
    `
      select
        gr.*,
        v.vendor_code,
        v.company_name as vendor_name,
        po.po_number,
        po.po_status,
        po.receipt_short_closed_at,
        po.receipt_short_close_remarks
      from goods_receipts gr
      join vendors v on v.id = gr.vendor_id and v.company_id = gr.company_id
      left join purchase_orders po on po.id = gr.purchase_order_id
      where gr.id = $1 and gr.company_id = $2
      limit 1
    `,
    [id, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getGoodsReceiptLines(client, goodsReceiptId) {
  const r = await client.query(
    `
      select
        grl.*,
        p.serial_no_required,
        pg.group_name as product_group_name,
        sl.location_code,
        sl.location_name
      from goods_receipt_lines grl
      left join products p on p.id = grl.product_id
      left join product_groups pg on pg.id = p.group_id
      left join stock_locations sl on sl.id = grl.location_id
      where grl.goods_receipt_id = $1
      order by grl.line_no asc
    `,
    [goodsReceiptId]
  );
  return r.rows;
}

async function enrichLinesWithPoProgress(client, header, lines) {
  const purchaseOrderId = Number(header?.purchase_order_id);
  if (!Number.isFinite(purchaseOrderId) || purchaseOrderId <= 0) {
    return (lines || []).map((line) => ({
      ...line,
      qty_ordered: null,
      qty_previously_received: null,
      qty_remaining_receive: null,
    }));
  }

  const receivedMap = await getReceivedQtyMap(client, purchaseOrderId, {
    excludeGoodsReceiptId: header?.id,
  });
  const poLines = await getPurchaseOrderLines(client, purchaseOrderId);
  const poLineMap = new Map(poLines.map((line) => [Number(line.id), line]));

  return (lines || []).map((line) => {
    const poLineId = Number(line.purchase_order_line_id);
    const poLine = Number.isFinite(poLineId) ? poLineMap.get(poLineId) : null;
    const ordered = qty(poLine?.qty);
    const previously = Number.isFinite(poLineId) ? qty(receivedMap.get(poLineId)) : 0;
    return {
      ...line,
      qty_ordered: ordered,
      qty_previously_received: previously,
      qty_remaining_receive: Math.max(ordered - previously, 0),
    };
  });
}

async function resolveLocationId(client, companyId, locationId) {
  if (locationId === null || locationId === undefined || locationId === "") return null;
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const r = await client.query(
    `select id from stock_locations where id = $1 and company_id = $2 and is_active = true limit 1`,
    [id, Number(companyId)]
  );
  return r.rows[0]?.id || null;
}

async function getGoodsReceiptSerials(client, goodsReceiptId) {
  const r = await client.query(
    `
      select s.id, s.goods_receipt_line_id, s.serial_no
      from goods_receipt_serials s
      join goods_receipt_lines l on l.id = s.goods_receipt_line_id
      where l.goods_receipt_id = $1
      order by s.id asc
    `,
    [goodsReceiptId]
  );
  const byLineId = new Map();
  for (const row of r.rows) {
    const key = Number(row.goods_receipt_line_id);
    if (!byLineId.has(key)) byLineId.set(key, []);
    byLineId.get(key).push(row.serial_no);
  }
  return byLineId;
}

async function getPurchaseOrderHeaderOrNull(client, purchaseOrderId, companyId) {
  const r = await client.query(
    `
      select
        po.*,
        v.company_name as vendor_name
      from purchase_orders po
      join vendors v on v.id = po.vendor_id and v.company_id = po.company_id
      where po.id = $1
        and po.company_id = $2
      limit 1
    `,
    [purchaseOrderId, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getPurchaseOrderLines(client, purchaseOrderId) {
  const r = await client.query(
    `
      select
        pol.*,
        p.serial_no_required
      from purchase_order_lines pol
      left join products p on p.id = pol.product_id
      where pol.purchase_order_id = $1
      order by pol.line_no asc
    `,
    [purchaseOrderId]
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

async function getReceivingExceptionsSummary(client, req, companyId) {
  const poParams = [Number(companyId)];
  const poWhere = [
    `po.company_id = $1`,
    `po.po_status in ('approved', 'closed')`,
    `po.receipt_short_closed_at is null`,
  ];
  if (ownRecordsOnly(req, "purchase_orders")) {
    poParams.push(Number(req.user.id));
    poWhere.push(`po.created_by = $${poParams.length}`);
  }

  const grnParams = [Number(companyId)];
  const grnWhere = [`gr.company_id = $1`];
  if (ownRecordsOnly(req, "goods_receipts")) {
    grnParams.push(Number(req.user.id));
    grnWhere.push(`gr.created_by = $${grnParams.length}`);
  }

  const qcParams = [Number(companyId)];
  const qcWhere = [`qc.company_id = $1`];
  if (ownRecordsOnly(req, "quality_control")) {
    qcParams.push(Number(req.user.id));
    qcWhere.push(`qc.created_by = $${qcParams.length}`);
  }

  const claimParams = [Number(companyId)];
  const claimWhere = [`sc.company_id = $1`];
  if (ownRecordsOnly(req, "supplier_claims")) {
    claimParams.push(Number(req.user.id));
    claimWhere.push(`sc.created_by = $${claimParams.length}`);
  }

  const claimableParams = [Number(companyId)];
  const claimableWhere = [`qc.company_id = $1`, `qc.qc_status = 'closed'`, `qha.action_type = 'supplier_replacement'`, `scl.id is null`];
  if (ownRecordsOnly(req, "supplier_claims")) {
    claimableParams.push(Number(req.user.id));
    claimableWhere.push(`qc.created_by = $${claimableParams.length}`);
  }

  const [pendingReceiptRes, grnInProgressRes, awaitingQcRes, qcSummaryRes, claimReadyRes, replacementPendingRes, mismatchRiskRes] = await Promise.all([
    client.query(
      `
        with line_received as (
          select
            grl.purchase_order_line_id,
            coalesce(sum(grl.qty_received), 0) as qty_received
          from goods_receipt_lines grl
          join goods_receipts gr on gr.id = grl.goods_receipt_id
          where gr.company_id = $1
            and gr.receipt_status <> 'cancelled'
            and grl.purchase_order_line_id is not null
          group by grl.purchase_order_line_id
        ),
        po_pending as (
          select
            po.id,
            count(*) filter (where greatest(pol.qty - coalesce(lr.qty_received, 0), 0) > 0.0001)::int as pending_lines,
            coalesce(sum(greatest(pol.qty - coalesce(lr.qty_received, 0), 0)), 0) as pending_qty
          from purchase_orders po
          join purchase_order_lines pol on pol.purchase_order_id = po.id
          left join line_received lr on lr.purchase_order_line_id = pol.id
          where ${poWhere.join(" and ")}
          group by po.id
        )
        select
          count(*) filter (where pending_lines > 0)::int as po_count,
          coalesce(sum(case when pending_lines > 0 then pending_qty else 0 end), 0) as pending_qty
        from po_pending
      `,
      poParams
    ),
    client.query(
      `
        select
          count(distinct gr.id)::int as grn_count,
          coalesce(sum(grl.qty_received), 0) as qty_received
        from goods_receipts gr
        left join goods_receipt_lines grl on grl.goods_receipt_id = gr.id
        where ${grnWhere.join(" and ")}
          and gr.receipt_status in ('draft', 'submitted', 'approved')
      `,
      grnParams
    ),
    client.query(
      `
        select
          count(distinct gr.id)::int as grn_count,
          coalesce(sum(grl.qty_received), 0) as qty_received
        from goods_receipts gr
        left join goods_receipt_lines grl on grl.goods_receipt_id = gr.id
        left join quality_controls qc on qc.goods_receipt_id = gr.id
        where ${grnWhere.join(" and ")}
          and gr.receipt_status = 'posted'
          and qc.id is null
      `,
      grnParams
    ),
    client.query(
      `
        with qc_totals as (
          select
            qc.id,
            coalesce(sum(greatest(qcl.qty_on_hold - qcl.qty_replaced - qcl.qty_reworked - qcl.qty_accepted_after_hold, 0)), 0) as pending_hold_qty,
            coalesce(sum(greatest(qcl.qty_rejected - qcl.qty_rtv_created, 0)), 0) as pending_rtv_qty
          from quality_controls qc
          join quality_control_lines qcl on qcl.quality_control_id = qc.id
          where ${qcWhere.join(" and ")}
          group by qc.id
        )
        select
          count(*) filter (where pending_hold_qty > 0.0001)::int as qc_hold_count,
          coalesce(sum(case when pending_hold_qty > 0.0001 then pending_hold_qty else 0 end), 0) as qc_hold_qty,
          count(*) filter (where pending_rtv_qty > 0.0001)::int as rtv_pending_count,
          coalesce(sum(case when pending_rtv_qty > 0.0001 then pending_rtv_qty else 0 end), 0) as rtv_pending_qty
        from qc_totals
      `,
      qcParams
    ),
    client.query(
      `
        select
          count(distinct qc.id)::int as claim_ready_count,
          coalesce(sum(qha.qty), 0) as claim_ready_qty
        from quality_hold_actions qha
        join quality_controls qc on qc.id = qha.quality_control_id
        left join supplier_claim_lines scl on scl.quality_hold_action_id = qha.id
        where ${claimableWhere.join(" and ")}
      `,
      claimableParams
    ),
    client.query(
      `
        with claim_totals as (
          select
            sc.id,
            coalesce(sum(greatest(scl.qty_claimed - scl.qty_received, 0)), 0) as total_pending_qty
          from supplier_claims sc
          left join supplier_claim_lines scl on scl.supplier_claim_id = sc.id
          where ${claimWhere.join(" and ")}
          group by sc.id
        )
        select
          count(*) filter (where total_pending_qty > 0.0001)::int as claim_count,
          coalesce(sum(case when total_pending_qty > 0.0001 then total_pending_qty else 0 end), 0) as pending_qty
        from claim_totals
      `,
      claimParams
    ),
    client.query(
      `
        with grn_posted as (
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
          join purchase_invoices pi on pi.id = pil.purchase_invoice_id
          where pi.company_id = $1
            and pi.invoice_status = 'posted'
            and pil.purchase_order_line_id is not null
          group by pil.purchase_order_line_id
        ),
        mismatch_lines as (
          select
            po.id as purchase_order_id,
            greatest(coalesce(grn.qty_received_posted, 0) - coalesce(pol.qty, 0), 0) as excess_received_qty,
            greatest(coalesce(inv.qty_invoiced_posted, 0) - coalesce(grn.qty_received_posted, 0), 0) as excess_invoiced_qty
          from purchase_orders po
          join purchase_order_lines pol on pol.purchase_order_id = po.id
          left join grn_posted grn on grn.purchase_order_line_id = pol.id
          left join inv_posted inv on inv.purchase_order_line_id = pol.id
          where ${poWhere.join(" and ")}
        )
        select
          count(distinct purchase_order_id) filter (where excess_received_qty > 0.0001 or excess_invoiced_qty > 0.0001)::int as po_count,
          count(*) filter (where excess_received_qty > 0.0001 or excess_invoiced_qty > 0.0001)::int as mismatch_lines,
          coalesce(sum(excess_received_qty + excess_invoiced_qty), 0) as mismatch_qty
        from mismatch_lines
      `,
      poParams
    ),
  ]);

  const pendingReceipt = pendingReceiptRes.rows[0] || {};
  const grnInProgress = grnInProgressRes.rows[0] || {};
  const awaitingQc = awaitingQcRes.rows[0] || {};
  const qcSummary = qcSummaryRes.rows[0] || {};
  const claimReady = claimReadyRes.rows[0] || {};
  const replacementPending = replacementPendingRes.rows[0] || {};
  const mismatchRisk = mismatchRiskRes.rows[0] || {};

  return {
    pending_receipt_count: Number(pendingReceipt.po_count || 0),
    pending_receipt_qty: money(pendingReceipt.pending_qty),
    grn_in_progress_count: Number(grnInProgress.grn_count || 0),
    grn_in_progress_qty: money(grnInProgress.qty_received),
    awaiting_qc_count: Number(awaitingQc.grn_count || 0),
    awaiting_qc_qty: money(awaitingQc.qty_received),
    qc_hold_count: Number(qcSummary.qc_hold_count || 0),
    qc_hold_qty: money(qcSummary.qc_hold_qty),
    rtv_pending_count: Number(qcSummary.rtv_pending_count || 0),
    rtv_pending_qty: money(qcSummary.rtv_pending_qty),
    claim_ready_count: Number(claimReady.claim_ready_count || 0),
    claim_ready_qty: money(claimReady.claim_ready_qty),
    replacement_pending_count: Number(replacementPending.claim_count || 0),
    replacement_pending_qty: money(replacementPending.pending_qty),
    mismatch_risk_count: Number(mismatchRisk.po_count || 0),
    mismatch_risk_lines: Number(mismatchRisk.mismatch_lines || 0),
    mismatch_risk_qty: money(mismatchRisk.mismatch_qty),
  };
}

async function getReceivingExceptionsQueue(client, req, companyId, { bucket = "pending_receipt", q = "", limit = 120 } = {}) {
  const normalizedBucket = normalizeText(bucket).toLowerCase() || "pending_receipt";
  const normalizedQuery = normalizeText(q);
  const normalizedLimit = normalizeLimit(limit, 120, 300);

  if (normalizedBucket === "pending_receipt" || normalizedBucket === "mismatch_risk") {
    const params = [Number(companyId)];
    const poWhere = [`po.company_id = $1`, `po.po_status in ('approved', 'closed')`];
    if (normalizedBucket === "pending_receipt") {
      poWhere.push(`po.receipt_short_closed_at is null`);
    }
    if (ownRecordsOnly(req, "purchase_orders")) {
      params.push(Number(req.user.id));
      poWhere.push(`po.created_by = $${params.length}`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      poWhere.push(`(po.po_number ilike $${params.length} or v.company_name ilike $${params.length})`);
    }

    const filter =
      normalizedBucket === "mismatch_risk"
        ? `mismatch_lines > 0`
        : `pending_qty > 0.0001`;

    const r = await client.query(
      `
        with grn_posted as (
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
          join purchase_invoices pi on pi.id = pil.purchase_invoice_id
          where pi.company_id = $1
            and pi.invoice_status = 'posted'
            and pil.purchase_order_line_id is not null
          group by pil.purchase_order_line_id
        ),
        po_rows as (
          select
            po.id,
            po.po_number,
            po.po_status,
            po.po_date,
            v.company_name as vendor_name,
            count(*) filter (where greatest(pol.qty - coalesce(grn.qty_received_posted, 0), 0) > 0.0001)::int as pending_lines,
            coalesce(sum(greatest(pol.qty - coalesce(grn.qty_received_posted, 0), 0)), 0) as pending_qty,
            coalesce(sum(pol.qty), 0) as ordered_qty,
            coalesce(sum(coalesce(grn.qty_received_posted, 0)), 0) as received_qty,
            count(*) filter (where coalesce(grn.qty_received_posted, 0) > coalesce(pol.qty, 0) or coalesce(inv.qty_invoiced_posted, 0) > coalesce(grn.qty_received_posted, 0))::int as mismatch_lines,
            coalesce(sum(greatest(coalesce(grn.qty_received_posted, 0) - coalesce(pol.qty, 0), 0) + greatest(coalesce(inv.qty_invoiced_posted, 0) - coalesce(grn.qty_received_posted, 0), 0)), 0) as mismatch_qty
          from purchase_orders po
          join vendors v on v.id = po.vendor_id and v.company_id = po.company_id
          join purchase_order_lines pol on pol.purchase_order_id = po.id
          left join grn_posted grn on grn.purchase_order_line_id = pol.id
          left join inv_posted inv on inv.purchase_order_line_id = pol.id
          where ${poWhere.join(" and ")}
          group by po.id, v.company_name
        )
        select *
        from po_rows
        where ${filter}
        order by
          case when mismatch_lines > 0 then 0 else 1 end,
          pending_qty desc,
          po_date asc,
          id desc
        limit ${normalizedLimit}
      `,
      params
    );

    return {
      bucket: normalizedBucket,
      queue_type: "purchase_orders",
      rows: r.rows.map((row) => ({
        ...row,
        pending_qty: money(row.pending_qty),
        ordered_qty: money(row.ordered_qty),
        received_qty: money(row.received_qty),
        mismatch_qty: money(row.mismatch_qty),
      })),
    };
  }

  if (normalizedBucket === "grn_in_progress" || normalizedBucket === "awaiting_qc") {
    const params = [Number(companyId)];
    const grnWhere = [`gr.company_id = $1`];
    if (ownRecordsOnly(req, "goods_receipts")) {
      params.push(Number(req.user.id));
      grnWhere.push(`gr.created_by = $${params.length}`);
    }
    if (normalizedBucket === "grn_in_progress") {
      grnWhere.push(`gr.receipt_status in ('draft', 'submitted', 'approved')`);
    } else {
      grnWhere.push(`gr.receipt_status = 'posted'`);
      grnWhere.push(`qc.id is null`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      grnWhere.push(`(gr.grn_number ilike $${params.length} or v.company_name ilike $${params.length} or coalesce(po.po_number, '') ilike $${params.length})`);
    }
    const r = await client.query(
      `
        select
          gr.id,
          gr.grn_number,
          gr.receipt_status,
          gr.receipt_date,
          gr.purchase_order_id,
          po.po_number,
          v.company_name as vendor_name,
          count(grl.id)::int as line_count,
          coalesce(sum(grl.qty_received), 0) as qty_received
        from goods_receipts gr
        join vendors v on v.id = gr.vendor_id and v.company_id = gr.company_id
        left join purchase_orders po on po.id = gr.purchase_order_id
        left join goods_receipt_lines grl on grl.goods_receipt_id = gr.id
        left join quality_controls qc on qc.goods_receipt_id = gr.id
        where ${grnWhere.join(" and ")}
        group by gr.id, po.po_number, v.company_name
        order by
          case
            when gr.receipt_status = 'submitted' then 0
            when gr.receipt_status = 'approved' then 1
            when gr.receipt_status = 'draft' then 2
            else 3
          end,
          gr.receipt_date asc,
          gr.id desc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      bucket: normalizedBucket,
      queue_type: "goods_receipts",
      rows: r.rows.map((row) => ({
        ...row,
        qty_received: money(row.qty_received),
      })),
    };
  }

  if (normalizedBucket === "qc_hold" || normalizedBucket === "rtv_pending" || normalizedBucket === "claim_ready") {
    const params = [Number(companyId)];
    const qcWhere = [`qc.company_id = $1`];
    if (normalizedBucket === "claim_ready") {
      qcWhere.push(`qc.qc_status = 'closed'`);
    }
    if (ownRecordsOnly(req, normalizedBucket === "claim_ready" ? "supplier_claims" : "quality_control")) {
      params.push(Number(req.user.id));
      qcWhere.push(`qc.created_by = $${params.length}`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      qcWhere.push(`(qc.qc_number ilike $${params.length} or gr.grn_number ilike $${params.length} or v.company_name ilike $${params.length})`);
    }
    const having =
      normalizedBucket === "qc_hold"
        ? `pending_hold_qty > 0.0001`
        : normalizedBucket === "rtv_pending"
          ? `pending_rtv_qty > 0.0001`
          : `claim_ready_qty > 0.0001`;
    const r = await client.query(
      `
        with qc_totals as (
          select
            qc.id,
            qc.qc_number,
            qc.qc_status,
            qc.goods_receipt_id,
            qc.rtv_purchase_return_id,
            gr.grn_number,
            gr.purchase_order_id,
            v.company_name as vendor_name,
            coalesce(sum(greatest(qcl.qty_on_hold - qcl.qty_replaced - qcl.qty_reworked - qcl.qty_accepted_after_hold, 0)), 0) as pending_hold_qty,
            coalesce(sum(greatest(qcl.qty_rejected - qcl.qty_rtv_created, 0)), 0) as pending_rtv_qty
          from quality_controls qc
          join goods_receipts gr on gr.id = qc.goods_receipt_id
          join vendors v on v.id = gr.vendor_id and v.company_id = gr.company_id
          join quality_control_lines qcl on qcl.quality_control_id = qc.id
          where ${qcWhere.join(" and ")}
          group by qc.id, gr.grn_number, v.company_name
        ),
        claimable_actions as (
          select
            qc.id as quality_control_id,
            count(distinct qha.id)::int as claim_ready_actions,
            coalesce(sum(qha.qty), 0) as claim_ready_qty
          from quality_controls qc
          join quality_hold_actions qha on qha.quality_control_id = qc.id
          left join supplier_claim_lines scl on scl.quality_hold_action_id = qha.id
          where qc.company_id = $1
            and qha.action_type = 'supplier_replacement'
            and scl.id is null
          group by qc.id
        )
        select
          qt.*,
          coalesce(ca.claim_ready_actions, 0) as claim_ready_actions,
          coalesce(ca.claim_ready_qty, 0) as claim_ready_qty
        from qc_totals qt
        left join claimable_actions ca on ca.quality_control_id = qt.id
        where 1 = 1
          and ${having}
        order by
          case when qt.pending_hold_qty > 0 then 0 when qt.pending_rtv_qty > 0 then 1 else 2 end,
          qt.pending_hold_qty desc,
          qt.pending_rtv_qty desc,
          coalesce(ca.claim_ready_qty, 0) desc,
          qt.id desc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      bucket: normalizedBucket,
      queue_type: "quality_controls",
      rows: r.rows.map((row) => ({
        ...row,
        pending_hold_qty: money(row.pending_hold_qty),
        pending_rtv_qty: money(row.pending_rtv_qty),
        claim_ready_qty: money(row.claim_ready_qty),
      })),
    };
  }

  const params = [Number(companyId)];
  const claimWhere = [`sc.company_id = $1`];
  if (ownRecordsOnly(req, "supplier_claims")) {
    params.push(Number(req.user.id));
    claimWhere.push(`sc.created_by = $${params.length}`);
  }
  if (normalizedQuery) {
    params.push(`%${normalizedQuery}%`);
    claimWhere.push(`(sc.claim_number ilike $${params.length} or qc.qc_number ilike $${params.length} or gr.grn_number ilike $${params.length} or v.company_name ilike $${params.length})`);
  }
  const r = await client.query(
    `
      select
        sc.id,
        sc.claim_number,
        sc.claim_status,
        sc.quality_control_id,
        qc.qc_number,
        gr.grn_number,
        gr.purchase_order_id,
        v.company_name as vendor_name,
        coalesce(sum(scl.qty_claimed), 0) as total_claimed_qty,
        coalesce(sum(scl.qty_received), 0) as total_received_qty,
        coalesce(sum(greatest(scl.qty_claimed - scl.qty_received, 0)), 0) as total_pending_qty
      from supplier_claims sc
      join quality_controls qc on qc.id = sc.quality_control_id
      join goods_receipts gr on gr.id = qc.goods_receipt_id
      join vendors v on v.id = sc.vendor_id and v.company_id = sc.company_id
      left join supplier_claim_lines scl on scl.supplier_claim_id = sc.id
      where ${claimWhere.join(" and ")}
      group by sc.id, qc.qc_number, gr.grn_number, v.company_name, gr.purchase_order_id
      having coalesce(sum(greatest(scl.qty_claimed - scl.qty_received, 0)), 0) > 0.0001
      order by total_pending_qty desc, sc.id desc
      limit ${normalizedLimit}
    `,
    params
  );
  return {
    bucket: normalizedBucket,
    queue_type: "supplier_claims",
    rows: r.rows.map((row) => ({
      ...row,
      total_claimed_qty: money(row.total_claimed_qty),
      total_received_qty: money(row.total_received_qty),
      total_pending_qty: money(row.total_pending_qty),
    })),
  };
}

router.get("/bootstrap", requireScreenAction("goods_receipts", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const [vendorsRes, purchaseOrdersRes, locationsRes] = await Promise.all([
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
          select
            po.id,
            po.po_number,
            po.po_status,
            po.po_date,
            v.company_name as vendor_name
          from purchase_orders po
          join vendors v on v.id = po.vendor_id and v.company_id = po.company_id
          where po.company_id = $1
            and po.po_status in ('approved', 'closed')
            and po.receipt_short_closed_at is null
          order by po.created_at desc, po.id desc
          limit 250
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, location_code, location_name, location_type
          from stock_locations
          where company_id = $1
            and is_active = true
          order by location_name asc, id asc
        `,
        [companyId]
      ),
    ]);

    return res.json({
      ok: true,
      vendors: vendorsRes.rows,
      purchase_orders: purchaseOrdersRes.rows,
      locations: locationsRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/vendors/quick-create", async (req, res, next) => {
  try {
    const canCreate =
      req.user?.group_name === "SuperAdmin" ||
      hasScreenAction(req, "goods_receipts", "can_create") ||
      hasScreenAction(req, "purchase_orders", "can_create") ||
      hasScreenAction(req, "admin_masters", "can_create") ||
      hasScreenAction(req, "admin_masters", "can_edit");
    if (!canCreate) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const vendor = await createVendorQuick(pool, {
      companyId,
      party: req.body && typeof req.body === "object" ? req.body : {},
    });
    return res.status(201).json({ ok: true, vendor });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_VENDOR" });
    if (err?.message === "COMPANY_NAME_REQUIRED") return res.status(400).json({ ok: false, error: "COMPANY_NAME_REQUIRED" });
    if (err?.message === "COMPANY_NOT_SELECTED") return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    if (err?.message === "INVALID_COMPANY") return res.status(400).json({ ok: false, error: "INVALID_COMPANY" });
    return next(err);
  }
});

router.get("/exceptions-summary", requireScreenAction("goods_receipts", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const summary = await getReceivingExceptionsSummary(pool, req, companyId);
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/exceptions-queue", requireScreenAction("goods_receipts", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const queue = await getReceivingExceptionsQueue(pool, req, companyId, {
      bucket: req.query.bucket,
      q: req.query.q,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...queue });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-lookup", requireScreenAction("goods_receipts", "can_view"), async (req, res, next) => {
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

router.get("/", requireScreenAction("goods_receipts", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [];

    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    where.push(`gr.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "goods_receipts")) {
      params.push(Number(req.user.id));
      where.push(`gr.created_by = $${params.length}`);
    }

    const r = await pool.query(
      `
        select
          gr.id,
          gr.grn_number,
          gr.receipt_status,
          gr.receipt_date,
          v.company_name as vendor_name,
          po.po_number
        from goods_receipts gr
        join vendors v on v.id = gr.vendor_id and v.company_id = gr.company_id
        left join purchase_orders po on po.id = gr.purchase_order_id
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by gr.created_at desc, gr.id desc
      `,
      params
    );

    return res.json({ ok: true, goods_receipts: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("goods_receipts", "can_create"), async (req, res, next) => {
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

    const numRes = await client.query(`select next_company_document_number($1,'GRN') as grn_number`, [companyId]);
    const grnNumber = numRes.rows[0]?.grn_number;

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
          created_by
        )
        values ($1,$2,$3,$4,'draft',current_date,$5,$6)
        returning id
      `,
      [companyId, grnNumber, vendorId, null, body.remarks || null, req.user.id]
    );

    await client.query("commit");
    const id = insertRes.rows[0]?.id;
    const grn = await getGoodsReceiptHeaderOrNull(client, id, companyId);
    const lines = await getGoodsReceiptLines(client, id);
    return res.status(201).json({ ok: true, goods_receipt: grn, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/from-po/:id", requireScreenAction("goods_receipts", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const purchaseOrderId = Number(req.params.id);
    if (!Number.isFinite(purchaseOrderId)) return res.status(400).json({ ok: false });

    await client.query("begin");

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const poLock = await client.query(
      `
        select *
        from purchase_orders
        where id = $1 and company_id = $2
        limit 1
        for update
      `,
      [purchaseOrderId, companyId]
    );
    const po = poLock.rows[0] || null;
    if (!po) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessCompanyContext(req, po)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const poStatus = String(po.po_status || "").toLowerCase();
    if (!["approved", "closed"].includes(poStatus)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "PO_NOT_RECEIVABLE" });
    }
    if (po.receipt_short_closed_at) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "RECEIPT_SHORT_CLOSED" });
    }

    await client.query(`select id from purchase_order_lines where purchase_order_id = $1 for update`, [purchaseOrderId]);

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const headerRemarks = typeof body.remarks === "string" ? body.remarks.trim().slice(0, 2000) || null : null;

    const poLines = await getPurchaseOrderLines(client, purchaseOrderId);
    if (!poLines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_LINES" });
    }

    const receivedMap = await getReceivedQtyMap(client, purchaseOrderId);
    const creatableLines = poLines
      .map((line) => {
        const ordered = qty(line.qty);
        const received = qty(receivedMap.get(Number(line.id)));
        return {
          ...line,
          qty_ordered: ordered,
          qty_previously_received: received,
          qty_remaining_receive: Math.max(ordered - received, 0),
        };
      })
      .filter((line) => qty(line.qty_remaining_receive) > 0);

    if (!creatableLines.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "FULLY_RECEIVED" });
    }

    const numRes = await client.query(`select next_company_document_number($1,'GRN') as grn_number`, [companyId]);
    const grnNumber = numRes.rows[0]?.grn_number;

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
          created_by
        )
        values ($1,$2,$3,$4,'draft',current_date,$5,$6)
        returning id
      `,
      [companyId, grnNumber, po.vendor_id, purchaseOrderId, headerRemarks, req.user.id]
    );
    const goodsReceiptId = insertRes.rows[0]?.id;

    let lineNo = 1;
    for (const line of creatableLines) {
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
          line.id,
          lineNo,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.hsn_no || null,
          line.uom || null,
          qty(line.qty_remaining_receive),
          qty(line.gst_pct),
        ]
      );
      lineNo += 1;
    }

    await client.query("commit");
    const grn = await getGoodsReceiptHeaderOrNull(client, goodsReceiptId, companyId);
    const lines = await getGoodsReceiptLines(client, goodsReceiptId);
    const serialsByLine = await getGoodsReceiptSerials(client, goodsReceiptId);
    const withSerials = lines.map((line) => ({ ...line, serials: serialsByLine.get(Number(line.id)) || [] }));
    const enriched = await enrichLinesWithPoProgress(client, grn, withSerials);
    return res.status(201).json({ ok: true, goods_receipt: grn, lines: enriched });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/short-close-po/:id", requireScreenAction("goods_receipts", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const purchaseOrderId = Number(req.params.id);
    if (!Number.isFinite(purchaseOrderId)) return res.status(400).json({ ok: false, error: "INVALID_PO" });

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const remarks = typeof body.remarks === "string" ? body.remarks.trim().slice(0, 1000) : "";

    await client.query("begin");
    const poLock = await client.query(
      `
        select *
        from purchase_orders
        where id = $1 and company_id = $2
        limit 1
        for update
      `,
      [purchaseOrderId, companyId]
    );
    const po = poLock.rows[0] || null;
    if (!po) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "PO_NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, po)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const poStatus = String(po.po_status || "").toLowerCase();
    if (!["approved", "closed"].includes(poStatus)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "PO_NOT_RECEIVABLE" });
    }
    if (po.receipt_short_closed_at) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ALREADY_SHORT_CLOSED" });
    }

    const receivedMap = await getReceivedQtyMap(client, purchaseOrderId);
    const poLines = await getPurchaseOrderLines(client, purchaseOrderId);
    const pendingQty = poLines.reduce((sum, line) => {
      const ordered = qty(line.qty);
      const received = qty(receivedMap.get(Number(line.id)));
      return sum + Math.max(ordered - received, 0);
    }, 0);
    if (pendingQty <= 0.0001) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NOTHING_TO_SHORT_CLOSE" });
    }

    await client.query(
      `
        update purchase_orders
        set receipt_short_closed_at = now(),
            receipt_short_closed_by = $2,
            receipt_short_close_remarks = $3,
            po_status = case when po_status = 'approved' then 'closed' else po_status end,
            updated_at = now()
        where id = $1 and company_id = $4
      `,
      [purchaseOrderId, req.user.id, remarks || null, companyId]
    );

    await client.query("commit");
    const nextPo = await getPurchaseOrderHeaderOrNull(client, purchaseOrderId, companyId);
    notifyGrnShortClosed({
      purchaseOrderId,
      poNumber: nextPo?.po_number || po.po_number,
      vendorName: nextPo?.vendor_name || null,
      companyId,
      actorUserId: req.user.id,
      createdByUserId: po.created_by || null,
      pendingQtyClosed: pendingQty,
    }).catch(() => {});
    return res.json({
      ok: true,
      purchase_order: nextPo,
      pending_qty_closed: money(pendingQty),
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("goods_receipts", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const header = await getGoodsReceiptHeaderOrNull(pool, id, companyId);
    if (!header) return res.status(404).json({ ok: false });
    if (!canAccessCompanyContext(req, header)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessGoodsReceipt(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const lines = await getGoodsReceiptLines(pool, id);
    const serialsByLine = await getGoodsReceiptSerials(pool, id);
    const withSerials = lines.map((line) => ({ ...line, serials: serialsByLine.get(Number(line.id)) || [] }));
    const enriched = await enrichLinesWithPoProgress(pool, header, withSerials);
    return res.json({
      ok: true,
      goods_receipt: header,
      lines: enriched,
      receipt_short_closed: Boolean(header.receipt_short_closed_at),
    });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("goods_receipts", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    let status = typeof body.receipt_status === "string" ? body.receipt_status.trim().toLowerCase() : "draft";
    if (!["draft", "submitted", "approved", "posted", "cancelled"].includes(status)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const vendorId = body.vendor_id === undefined || body.vendor_id === null || body.vendor_id === "" ? null : Number(body.vendor_id);
    if (vendorId !== null && (!Number.isFinite(vendorId) || vendorId <= 0)) return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });

    await client.query("begin");

    const header = await getGoodsReceiptHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessGoodsReceipt(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const requestedLines = Array.isArray(body.lines) ? body.lines : [];
    const currentStatus = String(header.receipt_status || "draft").toLowerCase();
    if (requestedLines.length && currentStatus !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "RECEIPT_NOT_EDITABLE" });
    }

    const isSuper = req.user.group_name === "SuperAdmin";
    const canApprove = isSuper || hasScreenAction(req, "goods_receipts", "can_approve");
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

    let approvalCurrentLevel = Number(header.current_approval_level || 0);
    let approvalRequiredLevel = Number(header.required_approval_level || 0);
    let approveBy = status === "approved" && currentStatus !== "approved" ? req.user.id : null;
    let approvalDecision = null;

    if (status === "submitted" && currentStatus !== "submitted") {
      const state = await resolveApprovalState(client, "goods_receipt", {
        id,
        vendor_id: vendorId === null ? header.vendor_id : vendorId,
        total_amount: 0,
        current_approval_level: 0,
      }, companyId);
      approvalCurrentLevel = 0;
      approvalRequiredLevel = state.requiredLevel;
    } else if (status === "draft") {
      approvalCurrentLevel = 0;
      approvalRequiredLevel = 0;
    } else if (status === "approved" && currentStatus !== "approved") {
      const state = await resolveApprovalState(client, "goods_receipt", {
        id,
        vendor_id: vendorId === null ? header.vendor_id : vendorId,
        total_amount: 0,
        current_approval_level: header.current_approval_level,
        required_approval_level: header.required_approval_level,
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

    if (requestedLines.length && header.purchase_order_id) {
      const receivedMap = await getReceivedQtyMap(client, header.purchase_order_id, { excludeGoodsReceiptId: id });
      const poLines = await getPurchaseOrderLines(client, header.purchase_order_id);
      const poLineMap = new Map(poLines.map((line) => [Number(line.id), line]));

      for (const line of requestedLines) {
        const grLineId = Number(line.id);
        if (!Number.isFinite(grLineId)) continue;

        const poLineId = line.purchase_order_line_id === null || line.purchase_order_line_id === "" ? null : Number(line.purchase_order_line_id);
        const poLine = poLineId ? poLineMap.get(poLineId) : null;
        if (poLineId && !poLine) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_PO_LINE" });
        }

        const ordered = qty(poLine?.qty);
        const previously = qty(receivedMap.get(Number(poLineId)));
        const remaining = Math.max(ordered - previously, 0);
        const nextQty = qty(line.qty_received);
        if (nextQty < 0 || nextQty > remaining) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_RECEIVE_QTY" });
        }
      }
    }

    await client.query(
      `
        update goods_receipts
        set vendor_id = $2,
            receipt_status = $3,
            receipt_date = coalesce($4, receipt_date),
            remarks = $5,
            current_approval_level = $6,
            required_approval_level = $7,
            submitted_by = case when $8::boolean then null when $9::integer is not null then $9 else submitted_by end,
            submitted_at = case when $8::boolean then null when $9::integer is not null then now() else submitted_at end,
            approved_by = case when $8::boolean then null when $10::integer is not null then $10 else approved_by end,
            approved_at = case when $8::boolean then null when $10::integer is not null then now() else approved_at end,
            updated_at = now()
        where id = $1 and company_id = $11
      `,
      [
        id,
        vendorId === null ? header.vendor_id : vendorId,
        status,
        body.receipt_date || null,
        body.remarks || null,
        approvalCurrentLevel,
        approvalRequiredLevel,
        clearWorkflow,
        submitBy,
        approveBy,
        companyId,
      ]
    );

    if (requestedLines.length) {
      const currentLines = await getGoodsReceiptLines(client, id);
      const currentLineMap = new Map(currentLines.map((line) => [Number(line.id), line]));

      for (const reqLine of requestedLines) {
        const lineId = Number(reqLine.id);
        const current = currentLineMap.get(lineId);
        if (!current) continue;

        const nextQty = qty(reqLine.qty_received);
        if (nextQty < 0) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_RECEIVE_QTY" });
        }

        const serials = Array.isArray(reqLine.serials) ? reqLine.serials : [];
        const needsSerials = current.serial_no_required === true || current.serial_no_required === "true";

        if (needsSerials) {
          if (!isIntLike(nextQty)) {
            await client.query("rollback");
            return res.status(400).json({ ok: false, error: "SERIAL_QTY_NOT_INTEGER" });
          }
          if (serials.length !== Number(nextQty)) {
            await client.query("rollback");
            return res.status(400).json({ ok: false, error: "SERIAL_COUNT_MISMATCH" });
          }
          const cleaned = serials
            .map((s) => String(s || "").trim())
            .filter((s) => s.length > 0)
            .slice(0, 500);
          const unique = new Set(cleaned);
          if (unique.size !== cleaned.length) {
            await client.query("rollback");
            return res.status(400).json({ ok: false, error: "DUPLICATE_SERIALS" });
          }

          await client.query(`delete from goods_receipt_serials where goods_receipt_line_id = $1`, [lineId]);
          for (const serialNo of cleaned) {
            await client.query(
              `insert into goods_receipt_serials (goods_receipt_line_id, serial_no) values ($1,$2)`,
              [lineId, serialNo]
            );
          }
        }

        const nextLocationId = await resolveLocationId(client, companyId, reqLine.location_id);
        if (reqLine.location_id !== null && reqLine.location_id !== undefined && reqLine.location_id !== "" && nextLocationId === null) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_LOCATION" });
        }
        const nextLineRemarks =
          typeof reqLine.line_remarks === "string" ? reqLine.line_remarks.trim().slice(0, 1000) || null : current.line_remarks || null;

        await client.query(
          `
            update goods_receipt_lines
            set qty_received = $2,
                location_id = $3,
                line_remarks = $4,
                updated_at = now()
            where id = $1 and goods_receipt_id = $5
          `,
          [lineId, nextQty, nextLocationId, nextLineRemarks, id]
        );
      }
    }

    const actionRemarks = typeof body.approval_remarks === "string" ? body.approval_remarks.trim().slice(0, 500) : "";
    const requestedApproval = status === "approved" && currentStatus !== "approved";
    if (currentStatus !== status) {
      if (status === "submitted") {
        await insertApprovalHistory(client, {
          docType: "goods_receipt",
          docId: id,
          action: "submitted",
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (status === "draft") {
        await insertApprovalHistory(client, {
          docType: "goods_receipt",
          docId: id,
          action: "sent_back",
          actionLevel: Math.max(0, Number(header.current_approval_level || 0)),
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (status === "posted") {
        await insertApprovalHistory(client, {
          docType: "goods_receipt",
          docId: id,
          action: "posted",
          actionLevel: approvalCurrentLevel,
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (status === "cancelled") {
        await insertApprovalHistory(client, {
          docType: "goods_receipt",
          docId: id,
          action: "cancelled",
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      }
    }
    if (requestedApproval) {
      await insertApprovalHistory(client, {
        docType: "goods_receipt",
        docId: id,
        action: "approved",
        actionLevel: approvalDecision?.requiresPolicy ? approvalDecision.nextLevel : 0,
        policyId: approvalDecision?.nextPolicy?.id || null,
        remarks: actionRemarks || null,
        actedBy: req.user.id,
      });
    }

    const companyRes = await client.query(`select company_id from goods_receipts where id = $1 limit 1`, [id]);
    const syncCompanyId = Number(companyRes.rows[0]?.company_id) || null;
    await syncStockForGoodsReceipt(client, syncCompanyId, id);
    await client.query("commit");

    const nextHeader = await getGoodsReceiptHeaderOrNull(client, id, companyId);
    const nextLines = await getGoodsReceiptLines(client, id);
    const serialsByLine = await getGoodsReceiptSerials(client, id);
    const withSerials = nextLines.map((line) => ({ ...line, serials: serialsByLine.get(Number(line.id)) || [] }));
    const enriched = await enrichLinesWithPoProgress(client, nextHeader, withSerials);
    return res.json({ ok: true, goods_receipt: nextHeader, lines: enriched });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
