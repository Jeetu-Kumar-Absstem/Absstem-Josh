const express = require("express");
const fs = require("fs");
const path = require("path");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");
const { syncStockForJobCard } = require("../services/stockLedger");
const { generateQuotePdfBuffer } = require("../pdf/quotePdf");

const router = express.Router();

/** Manufacturing always; service/installation MRNs only after submit/approve. */
function storesEligibleJobTypeSql(alias = "jc") {
  return `(
    ${alias}.job_type = 'manufacturing'
    OR (
      ${alias}.job_type in ('service', 'installation')
      AND lower(coalesce(${alias}.job_status, 'draft')) in ('submitted', 'approved', 'open')
    )
  )`;
}

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(4));
}

function isIntLike(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.floor(n) === n;
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function normalizeLimit(value, fallback = 60, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function getDaysSince(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(Math.floor((Date.now() - d.getTime()) / 86400000), 0);
}

function canAccessJobCard(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "job_cards")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function getProductLookup(client, companyId, q, { manufacturedOnly = false } = {}) {
  const mode = manufacturedOnly ? "manufacture" : "stock";
  return lookupProducts(client, { companyId, q, mode, limit: 100, includeStockQty: true });
}

async function getManufacturingBoms(client, companyId) {
  const r = await client.query(
    `
      select
        mb.id,
        mb.bom_code,
        mb.finished_good_product_id,
        mb.revision_no,
        p.item_code as finished_good_item_code,
        p.item_name as finished_good_item_name
      from manufacturing_boms mb
      join products p on p.id = mb.finished_good_product_id
      where mb.company_id = $1
        and mb.is_active = true
      order by p.item_code asc, mb.revision_no desc, mb.id desc
      limit 300
    `,
    [Number(companyId)]
  );
  return r.rows;
}

async function getManufacturingSalesOrderLines(client, companyId, req) {
  const params = [Number(companyId)];
  let ownFilter = "";
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    ownFilter = ` and so.created_by = $${params.length}`;
  }
  const r = await client.query(
    `
      select
        sol.id,
        sol.sales_order_id,
        sol.product_id,
        sol.line_no,
        sol.qty,
        sol.item_code,
        sol.item_name,
        so.so_number,
        so.order_date,
        c.customer_name
      from sales_order_lines sol
      join sales_orders so on so.id = sol.sales_order_id
      join customers c on c.id = so.customer_id
      join products p on p.id = sol.product_id
      left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = so.company_id
      where so.company_id = $1
        and so.order_status in ('confirmed', 'closed')
        and p.is_active = true
        and coalesce(cpp.is_manufactured, p.is_manufactured, false) = true
        and coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) = 'manufacture'
        ${ownFilter}
      order by so.id desc, sol.line_no asc
      limit 300
    `,
    params
  );
  return r.rows;
}

async function getBomLinesByBomId(client, bomId) {
  const r = await client.query(
    `
      select
        bl.*,
        p.serial_no_required
      from manufacturing_bom_lines bl
      left join products p on p.id = bl.component_product_id
      where bl.bom_id = $1
      order by bl.line_no asc
    `,
    [Number(bomId)]
  );
  return r.rows;
}

async function getLatestBomForFinishedGood(client, companyId, finishedGoodProductId) {
  const r = await client.query(
    `
      select id
      from manufacturing_boms
      where company_id = $1
        and finished_good_product_id = $2
        and is_active = true
      order by revision_no desc, id desc
      limit 1
    `,
    [Number(companyId), Number(finishedGoodProductId)]
  );
  return r.rows[0]?.id || null;
}

async function getFinishedGoodOrNull(client, companyId, productId) {
  const r = await client.query(
    `
      select
        p.id,
        p.item_code,
        p.item_name,
        p.uom,
        coalesce(cpp.is_manufactured, p.is_manufactured, false) as is_manufactured,
        coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
        coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) as sourcing_mode,
        cpp.intercompany_source_company_id,
        coalesce(cp.company_name, c.display_name, c.legal_name, c.company_code) as intercompany_source_company_name
      from products p
      left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $2
      left join company_profiles_v2 cp on cp.company_id = cpp.intercompany_source_company_id
      left join companies c on c.id = cpp.intercompany_source_company_id
      where p.id = $1
      limit 1
    `,
    [Number(productId), Number(companyId)]
  );
  return r.rows[0] || null;
}

async function resolveManufacturingCreateContext(client, companyId, body) {
  const salesOrderLineId = Number(body.sales_order_line_id) || null;
  let salesOrderId = null;
  let finishedGoodProductId = Number(body.finished_good_product_id) || null;
  let plannedOutputQty = money(body.planned_output_qty || 0);

  if (salesOrderLineId) {
    const soLineRes = await client.query(
      `
        select
          sol.id,
          sol.sales_order_id,
          sol.product_id,
          sol.qty,
          so.company_id,
          so.order_status
        from sales_order_lines sol
        join sales_orders so on so.id = sol.sales_order_id
        where sol.id = $1
        limit 1
      `,
      [salesOrderLineId]
    );
    const soLine = soLineRes.rows[0] || null;
    if (!soLine) {
      const err = new Error("INVALID_SALES_ORDER_LINE");
      err.status = 400;
      throw err;
    }
    if (Number(soLine.company_id) !== Number(companyId)) {
      const err = new Error("SALES_ORDER_COMPANY_MISMATCH");
      err.status = 409;
      throw err;
    }
    if (!["confirmed", "closed"].includes(String(soLine.order_status || "").toLowerCase())) {
      const err = new Error("SALES_ORDER_NOT_READY");
      err.status = 409;
      throw err;
    }
    salesOrderId = Number(soLine.sales_order_id);
    finishedGoodProductId = Number(soLine.product_id);
    if (plannedOutputQty <= 0) plannedOutputQty = money(soLine.qty);
  }

  if (!finishedGoodProductId || finishedGoodProductId <= 0) {
    const err = new Error("INVALID_FINISHED_GOOD");
    err.status = 400;
    throw err;
  }
  if (plannedOutputQty <= 0) plannedOutputQty = 1;

  const fg = await getFinishedGoodOrNull(client, companyId, finishedGoodProductId);
  if (!fg) {
    const err = new Error("INVALID_FINISHED_GOOD");
    err.status = 400;
    throw err;
  }
  if (String(fg.sourcing_mode || "").trim().toLowerCase() === "buy_intercompany") {
    const err = new Error("PRODUCT_INTERCOMPANY_SUPPLIED");
    err.status = 409;
    throw err;
  }
  if (fg.is_manufactured !== true) {
    const err = new Error("PRODUCT_NOT_MARKED_MANUFACTURED");
    err.status = 400;
    throw err;
  }
  if (!fg.mfg_job_prefix) {
    const err = new Error("PRODUCT_MFG_PREFIX_MISSING");
    err.status = 400;
    throw err;
  }

  let bomId = Number(body.bom_id) || null;
  if (!bomId) bomId = await getLatestBomForFinishedGood(client, companyId, finishedGoodProductId);

  const actualOutputQty = money(body.actual_output_qty || 0);
  if (actualOutputQty > plannedOutputQty) {
    const err = new Error("OUTPUT_EXCEEDS_PLANNED");
    err.status = 400;
    throw err;
  }

  return {
    salesOrderId,
    salesOrderLineId,
    finishedGoodProductId,
    plannedOutputQty,
    actualOutputQty,
    bomId,
    fg,
  };
}

function isServiceMrnJobType(jobType) {
  return ["service", "installation"].includes(String(jobType || "").toLowerCase());
}

function isStoresIssueAllowedStatus(jobStatus) {
  return ["approved", "open"].includes(String(jobStatus || "").toLowerCase());
}

async function resolveServiceTicketLink(client, companyId, serviceTicketIdRaw, serviceTicketVisitIdRaw) {
  const serviceTicketId = serviceTicketIdRaw ? Number(serviceTicketIdRaw) : null;
  const serviceTicketVisitId = serviceTicketVisitIdRaw ? Number(serviceTicketVisitIdRaw) : null;
  if (!serviceTicketId) {
    if (serviceTicketVisitId) {
      const err = new Error("SERVICE_TICKET_REQUIRED_FOR_VISIT");
      err.status = 400;
      throw err;
    }
    return { serviceTicketId: null, serviceTicketVisitId: null, ticket: null };
  }
  if (!Number.isFinite(serviceTicketId) || serviceTicketId <= 0) {
    const err = new Error("INVALID_SERVICE_TICKET");
    err.status = 400;
    throw err;
  }
  const ticketRes = await client.query(
    `
      select id, company_id, ticket_number, complaint_type, site_name, created_by, customer_id
      from service_tickets
      where id = $1
      limit 1
    `,
    [serviceTicketId]
  );
  const ticket = ticketRes.rows[0] || null;
  if (!ticket) {
    const err = new Error("SERVICE_TICKET_NOT_FOUND");
    err.status = 404;
    throw err;
  }
  if (Number(ticket.company_id) !== Number(companyId)) {
    const err = new Error("SERVICE_TICKET_COMPANY_MISMATCH");
    err.status = 403;
    throw err;
  }
  if (serviceTicketVisitId) {
    if (!Number.isFinite(serviceTicketVisitId) || serviceTicketVisitId <= 0) {
      const err = new Error("INVALID_SERVICE_TICKET_VISIT");
      err.status = 400;
      throw err;
    }
    const visitRes = await client.query(
      `
        select id, ticket_id
        from service_ticket_visits
        where id = $1
        limit 1
      `,
      [serviceTicketVisitId]
    );
    const visit = visitRes.rows[0] || null;
    if (!visit || Number(visit.ticket_id) !== Number(serviceTicketId)) {
      const err = new Error("SERVICE_TICKET_VISIT_NOT_FOUND");
      err.status = 404;
      throw err;
    }
  }
  return {
    serviceTicketId,
    serviceTicketVisitId: serviceTicketVisitId || null,
    ticket,
  };
}

async function getJobCardHeaderOrNull(client, id) {
  const r = await client.query(
    `
      select
        jc.*,
        swc.case_number as service_case_number,
        c.customer_name as service_customer_name,
        st.ticket_number as service_ticket_number,
        stc.customer_name as service_ticket_customer_name,
        soc.customer_name as sales_order_customer_name,
        u.full_name as created_by_name,
        so.so_number,
        sol.line_no as sales_order_line_no,
        fg.item_code as finished_good_item_code,
        fg.item_name as finished_good_item_name,
        fg.uom as finished_good_uom,
        coalesce(fgsb.stock_qty, 0) as finished_good_stock_qty,
        mb.bom_code,
        coalesce((select sum(qty_requested) from job_card_lines where job_card_id = jc.id), 0) as total_requested_qty,
        coalesce((select sum(qty) from job_card_movements where job_card_id = jc.id and movement_type = 'issue'), 0) as total_issued_qty,
        coalesce((select sum(qty) from job_card_movements where job_card_id = jc.id and movement_type = 'return'), 0) as total_returned_qty,
        coalesce((select sum(qty_consumed) from job_card_lines where job_card_id = jc.id), 0) as total_consumed_qty
      from job_cards jc
      left join service_warranty_cases swc on swc.id = jc.service_warranty_case_id
      left join customers c on c.id = swc.customer_id
      left join service_tickets st on st.id = jc.service_ticket_id
      left join customers stc on stc.id = st.customer_id
      left join erp_users u on u.id = jc.created_by
      left join sales_orders so on so.id = jc.sales_order_id
      left join customers soc on soc.id = so.customer_id
      left join sales_order_lines sol on sol.id = jc.sales_order_line_id
      left join products fg on fg.id = jc.finished_good_product_id
      left join stock_balances fgsb on fgsb.company_id = jc.company_id and fgsb.product_id = jc.finished_good_product_id
      left join manufacturing_boms mb on mb.id = jc.bom_id
      where jc.id = $1
      limit 1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function getJobCardLines(client, id) {
  const r = await client.query(
    `
      select
        jcl.*,
        coalesce(sb.stock_qty, 0) as current_stock_qty,
        coalesce(sum(case when jcm.movement_type = 'issue' then jcm.qty else 0 end), 0) as qty_issued,
        coalesce(sum(case when jcm.movement_type = 'return' then jcm.qty else 0 end), 0) as qty_returned
      from job_card_lines jcl
      join job_cards jc on jc.id = jcl.job_card_id
      left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jcl.product_id
      left join job_card_movements jcm on jcm.job_card_line_id = jcl.id
      where jcl.job_card_id = $1
      group by jcl.id, sb.stock_qty
      order by jcl.line_no asc
    `,
    [id]
  );
  return r.rows.map((row) => {
    const issued = money(row.qty_issued);
    const returned = money(row.qty_returned);
    return {
      ...row,
      qty_issued: issued,
      qty_returned: returned,
      qty_outstanding: money(issued - returned),
    };
  });
}

async function getJobCardMovements(client, id) {
  const r = await client.query(
    `
      select
        jcm.*,
        jcl.line_no,
        jcl.item_code,
        jcl.item_name,
        u.full_name as created_by_name,
        coalesce(array_remove(array_agg(jcms.serial_no order by jcms.serial_no), null), '{}') as serials
      from job_card_movements jcm
      join job_card_lines jcl on jcl.id = jcm.job_card_line_id
      left join job_card_movement_serials jcms on jcms.job_card_movement_id = jcm.id
      left join erp_users u on u.id = jcm.created_by
      where jcm.job_card_id = $1
      group by jcm.id, jcl.line_no, jcl.item_code, jcl.item_name, u.full_name
      order by jcm.movement_date desc, jcm.id desc
    `,
    [id]
  );
  return r.rows.map((row) => ({
    ...row,
    serials: Array.isArray(row.serials) ? row.serials.filter(Boolean) : [],
  }));
}

function enrichShortageActionRow(row) {
  const currentPendingIssueQty = Math.max(money(row.qty_requested) - (money(row.qty_issued) - money(row.qty_returned)), 0);
  const shortageDemandQty = money(row.shortage_qty || 0) > 0 ? money(row.shortage_qty) : currentPendingIssueQty;
  const procurementRaised = Boolean(row.purchase_requisition_id);
  const fullyOrdered = procurementRaised && money(row.requisition_qty_pending) <= 0 && money(row.requisition_qty_ordered) > 0;
  const fullyReceived = money(row.goods_receipt_qty_received) >= shortageDemandQty && money(row.goods_receipt_qty_received) > 0;
  const materiallyCovered = currentPendingIssueQty > 0 && money(row.current_stock_qty) >= currentPendingIssueQty;
  const readyForReissue = materiallyCovered && currentPendingIssueQty > 0;
  const autoClosed = String(row.action_type || "").toLowerCase() === "resolved" || currentPendingIssueQty <= 0;
  const lifecycleLabels = [];
  if (autoClosed) lifecycleLabels.push(currentPendingIssueQty <= 0 ? "Issue Closed" : "Resolved");
  else if (readyForReissue) lifecycleLabels.push("Ready for Re-Issue");
  if (procurementRaised) lifecycleLabels.push("Procurement Raised");
  if (fullyOrdered) lifecycleLabels.push("Fully Ordered");
  if (fullyReceived) lifecycleLabels.push("Fully Received");
  if (!procurementRaised && currentPendingIssueQty > 0) lifecycleLabels.push("Procurement Not Raised");
  const actionDate = row.action_date ? new Date(row.action_date) : null;
  const ageDays = actionDate && !Number.isNaN(actionDate.getTime()) ? Math.max(Math.floor((Date.now() - actionDate.getTime()) / 86400000), 0) : 0;
  let queueReason = "Review the shortage and take the next supply action.";
  let recommendedAction = "review_shortage";
  let recommendedActionLabel = "Review shortage";
  let attentionLevel = "medium";

  if (readyForReissue && !autoClosed) {
    queueReason = `${currentPendingIssueQty.toFixed(4)} is now materially covered and the line can move back to stores issue.`;
    recommendedAction = "reissue_material";
    recommendedActionLabel = "Re-issue now";
    attentionLevel = "high";
  } else if (String(row.action_type || "").toLowerCase() === "blocked" && !autoClosed) {
    queueReason = `Supply is blocked while ${currentPendingIssueQty.toFixed(4)} is still pending on this line.`;
    recommendedAction = "review_block";
    recommendedActionLabel = "Review block";
    attentionLevel = "high";
  } else if (!procurementRaised && !autoClosed) {
    queueReason = `Procurement is not raised yet for ${shortageDemandQty.toFixed(4)} of shortage demand.`;
    recommendedAction = "raise_procurement";
    recommendedActionLabel = "Raise procurement";
    attentionLevel = "high";
  } else if (procurementRaised && !fullyReceived && !autoClosed) {
    queueReason = fullyOrdered
      ? "Supply is ordered but not yet fully received back into stock."
      : "Procurement is in flight but the shortage is still open.";
    recommendedAction = fullyOrdered ? "follow_up_receipt" : "follow_up_procurement";
    recommendedActionLabel = fullyOrdered ? "Follow up receipt" : "Follow up procurement";
    attentionLevel = "medium";
  }

  return {
    ...row,
    current_pending_issue_qty: currentPendingIssueQty,
    shortage_demand_qty: shortageDemandQty,
    shortage_age_days: ageDays,
    shortage_flags: {
      procurement_raised: procurementRaised,
      fully_ordered: fullyOrdered,
      fully_received: fullyReceived,
      materially_covered: materiallyCovered,
      ready_for_reissue: readyForReissue,
      auto_closed: autoClosed,
    },
    shortage_lifecycle_labels: lifecycleLabels,
    queue_reason: queueReason,
    recommended_action: recommendedAction,
    recommended_action_label: recommendedActionLabel,
    attention_level: attentionLevel,
    age_days: ageDays,
  };
}

function matchesStoresShortageBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return true;
  if (key === "not_raised") return !row.shortage_flags?.procurement_raised && !row.shortage_flags?.auto_closed;
  if (key === "raised") return row.shortage_flags?.procurement_raised && !row.shortage_flags?.auto_closed;
  if (key === "fully_ordered") return row.shortage_flags?.fully_ordered && !row.shortage_flags?.auto_closed;
  if (key === "fully_received") return row.shortage_flags?.fully_received && !row.shortage_flags?.auto_closed;
  if (key === "ready_for_reissue") return row.shortage_flags?.ready_for_reissue && !row.shortage_flags?.auto_closed;
  if (key === "blocked") return String(row.action_type || "").toLowerCase() === "blocked" && !row.shortage_flags?.auto_closed;
  if (key === "follow_up") return String(row.action_type || "").toLowerCase() === "follow_up" && !row.shortage_flags?.auto_closed;
  return true;
}

async function getJobCardShortageActions(client, id) {
  const r = await client.query(
    `
      select
        jsa.*,
        jcl.line_no,
        jcl.item_code,
        jcl.item_name,
        jcl.qty_requested,
        coalesce(issue_stats.issue_qty, 0) as qty_issued,
        coalesce(return_stats.return_qty, 0) as qty_returned,
        coalesce(sb.stock_qty, 0) as current_stock_qty,
        u.full_name as created_by_name,
        pr.id as purchase_requisition_id,
        pr.requisition_number,
        pr.requisition_status,
        prl.qty_requested as requisition_qty_requested,
        coalesce(po_stats.qty_ordered, 0) as requisition_qty_ordered,
        greatest(coalesce(prl.qty_requested, 0) - coalesce(po_stats.qty_ordered, 0), 0) as requisition_qty_pending,
        coalesce(po_stats.po_count, 0)::int as purchase_order_count,
        coalesce(gr_stats.qty_received, 0) as goods_receipt_qty_received,
        greatest(coalesce(po_stats.qty_ordered, 0) - coalesce(gr_stats.qty_received, 0), 0) as goods_receipt_qty_pending,
        coalesce(gr_stats.gr_count, 0)::int as goods_receipt_count,
        latest_po.purchase_order_id,
        latest_po.po_number,
        latest_po.po_status,
        latest_gr.goods_receipt_id,
        latest_gr.grn_number,
        latest_gr.receipt_status
      from job_card_line_shortage_actions jsa
      join job_card_lines jcl on jcl.id = jsa.job_card_line_id
      left join lateral (
        select coalesce(sum(qty), 0) as issue_qty
        from job_card_movements
        where job_card_line_id = jcl.id and movement_type = 'issue'
      ) issue_stats on true
      left join lateral (
        select coalesce(sum(qty), 0) as return_qty
        from job_card_movements
        where job_card_line_id = jcl.id and movement_type = 'return'
      ) return_stats on true
      left join job_cards jc on jc.id = jsa.job_card_id
      left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jcl.product_id
      left join purchase_requisition_lines prl on prl.source_shortage_action_id = jsa.id
      left join purchase_requisitions pr on pr.id = prl.purchase_requisition_id
      left join lateral (
        select
          coalesce(sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end), 0) as qty_ordered,
          count(distinct case when po.po_status <> 'cancelled' then po.id else null end) as po_count
        from purchase_order_lines pol
        join purchase_orders po on po.id = pol.purchase_order_id
        where pol.purchase_requisition_line_id = prl.id
      ) po_stats on true
      left join lateral (
        select
          po.id as purchase_order_id,
          po.po_number,
          po.po_status
        from purchase_order_lines pol
        join purchase_orders po on po.id = pol.purchase_order_id
        where pol.purchase_requisition_line_id = prl.id
          and po.po_status <> 'cancelled'
        order by po.created_at desc, po.id desc
        limit 1
      ) latest_po on true
      left join lateral (
        select
          coalesce(sum(case when gr.receipt_status <> 'cancelled' then grl.qty_received else 0 end), 0) as qty_received,
          count(distinct case when gr.receipt_status <> 'cancelled' then gr.id else null end) as gr_count
        from purchase_order_lines pol
        join goods_receipt_lines grl on grl.purchase_order_line_id = pol.id
        join goods_receipts gr on gr.id = grl.goods_receipt_id
        where pol.purchase_requisition_line_id = prl.id
      ) gr_stats on true
      left join lateral (
        select
          gr.id as goods_receipt_id,
          gr.grn_number,
          gr.receipt_status
        from purchase_order_lines pol
        join goods_receipt_lines grl on grl.purchase_order_line_id = pol.id
        join goods_receipts gr on gr.id = grl.goods_receipt_id
        where pol.purchase_requisition_line_id = prl.id
          and gr.receipt_status <> 'cancelled'
        order by gr.created_at desc, gr.id desc
        limit 1
      ) latest_gr on true
      left join erp_users u on u.id = jsa.created_by
      where jsa.job_card_id = $1
      order by jsa.action_date desc, jsa.id desc
    `,
    [id]
  );
  return r.rows.map((row) => enrichShortageActionRow(row));
}

async function queryStoresShortageRows(client, req, { q = "", limit = 300 } = {}) {
  const params = [];
  const filters = [
    storesEligibleJobTypeSql("jc"),
    `lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')`,
  ];
  const activeCompanyId = getActiveCompanyId(req);
  if (activeCompanyId) {
    params.push(Number(activeCompanyId));
    filters.push(`jc.company_id = $${params.length}`);
  }
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    filters.push(`jc.created_by = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      jc.job_card_number ilike $${idx}
      or coalesce(jc.job_id, '') ilike $${idx}
      or coalesce(so.so_number, '') ilike $${idx}
      or coalesce(c.customer_name, '') ilike $${idx}
      or coalesce(st.ticket_number, '') ilike $${idx}
      or coalesce(stc.customer_name, '') ilike $${idx}
      or coalesce(fg.item_code, '') ilike $${idx}
      or coalesce(fg.item_name, '') ilike $${idx}
      or coalesce(jcl.item_code, '') ilike $${idx}
      or coalesce(jcl.item_name, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const r = await client.query(
    `
      select
        jsa.*,
        jc.job_card_number,
        jc.job_id,
        jc.job_status,
        jc.job_type,
        jc.created_by,
        fg.item_code as finished_good_item_code,
        fg.item_name as finished_good_item_name,
        so.so_number,
        coalesce(c.customer_name, stc.customer_name) as customer_name,
        st.ticket_number as service_ticket_number,
        jcl.line_no,
        jcl.item_code,
        jcl.item_name,
        jcl.qty_requested,
        coalesce(issue_stats.issue_qty, 0) as qty_issued,
        coalesce(return_stats.return_qty, 0) as qty_returned,
        coalesce(sb.stock_qty, 0) as current_stock_qty,
        u.full_name as created_by_name,
        pr.id as purchase_requisition_id,
        pr.requisition_number,
        pr.requisition_status,
        prl.qty_requested as requisition_qty_requested,
        coalesce(po_stats.qty_ordered, 0) as requisition_qty_ordered,
        greatest(coalesce(prl.qty_requested, 0) - coalesce(po_stats.qty_ordered, 0), 0) as requisition_qty_pending,
        coalesce(po_stats.po_count, 0)::int as purchase_order_count,
        coalesce(gr_stats.qty_received, 0) as goods_receipt_qty_received,
        greatest(coalesce(po_stats.qty_ordered, 0) - coalesce(gr_stats.qty_received, 0), 0) as goods_receipt_qty_pending,
        coalesce(gr_stats.gr_count, 0)::int as goods_receipt_count,
        latest_po.purchase_order_id,
        latest_po.po_number,
        latest_po.po_status,
        latest_gr.goods_receipt_id,
        latest_gr.grn_number,
        latest_gr.receipt_status
      from job_card_line_shortage_actions jsa
      join job_cards jc on jc.id = jsa.job_card_id
      join job_card_lines jcl on jcl.id = jsa.job_card_line_id
      left join products fg on fg.id = jc.finished_good_product_id
      left join sales_orders so on so.id = jc.sales_order_id
      left join customers c on c.id = so.customer_id
      left join service_tickets st on st.id = jc.service_ticket_id
      left join customers stc on stc.id = st.customer_id
      left join lateral (
        select coalesce(sum(qty), 0) as issue_qty
        from job_card_movements
        where job_card_line_id = jcl.id and movement_type = 'issue'
      ) issue_stats on true
      left join lateral (
        select coalesce(sum(qty), 0) as return_qty
        from job_card_movements
        where job_card_line_id = jcl.id and movement_type = 'return'
      ) return_stats on true
      left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jcl.product_id
      left join purchase_requisition_lines prl on prl.source_shortage_action_id = jsa.id
      left join purchase_requisitions pr on pr.id = prl.purchase_requisition_id
      left join lateral (
        select
          coalesce(sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end), 0) as qty_ordered,
          count(distinct case when po.po_status <> 'cancelled' then po.id else null end) as po_count
        from purchase_order_lines pol
        join purchase_orders po on po.id = pol.purchase_order_id
        where pol.purchase_requisition_line_id = prl.id
      ) po_stats on true
      left join lateral (
        select po.id as purchase_order_id, po.po_number, po.po_status
        from purchase_order_lines pol
        join purchase_orders po on po.id = pol.purchase_order_id
        where pol.purchase_requisition_line_id = prl.id
          and po.po_status <> 'cancelled'
        order by po.created_at desc, po.id desc
        limit 1
      ) latest_po on true
      left join lateral (
        select
          coalesce(sum(case when gr.receipt_status <> 'cancelled' then grl.qty_received else 0 end), 0) as qty_received,
          count(distinct case when gr.receipt_status <> 'cancelled' then gr.id else null end) as gr_count
        from purchase_order_lines pol
        join goods_receipt_lines grl on grl.purchase_order_line_id = pol.id
        join goods_receipts gr on gr.id = grl.goods_receipt_id
        where pol.purchase_requisition_line_id = prl.id
      ) gr_stats on true
      left join lateral (
        select gr.id as goods_receipt_id, gr.grn_number, gr.receipt_status
        from purchase_order_lines pol
        join goods_receipt_lines grl on grl.purchase_order_line_id = pol.id
        join goods_receipts gr on gr.id = grl.goods_receipt_id
        where pol.purchase_requisition_line_id = prl.id
          and gr.receipt_status <> 'cancelled'
        order by gr.created_at desc, gr.id desc
        limit 1
      ) latest_gr on true
      left join erp_users u on u.id = jsa.created_by
      ${where}
      order by jsa.action_date asc, jsa.id asc
      limit ${normalizeLimit(limit, 300, 1000)}
    `,
    params
  );
  return r.rows.map((row) => enrichShortageActionRow(row));
}

async function getStoresShortageDashboard(client, req, { q = "", bucket = "all" } = {}) {
  const rows = await queryStoresShortageRows(client, req, { q, limit: 300 });
  const openRows = rows.filter((row) => !row.shortage_flags?.auto_closed);
  const actionableRows = [...openRows].sort((a, b) => {
    const rank = (row) => {
      if (row.shortage_flags?.ready_for_reissue) return 0;
      if (!row.shortage_flags?.procurement_raised) return 1;
      if (row.shortage_flags?.procurement_raised && !row.shortage_flags?.fully_ordered) return 2;
      if (row.shortage_flags?.fully_ordered && !row.shortage_flags?.fully_received) return 3;
      return 4;
    };
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return Number(b.shortage_age_days || 0) - Number(a.shortage_age_days || 0);
  });
  const filteredRows = actionableRows.filter((row) => matchesStoresShortageBucket(row, bucket));
  return {
    rows: filteredRows.slice(0, 20),
    summary: {
      total: openRows.length,
      procurementNotRaised: openRows.filter((row) => !row.shortage_flags?.procurement_raised).length,
      procurementRaised: openRows.filter((row) => row.shortage_flags?.procurement_raised).length,
      procurementInFlight: openRows.filter(
        (row) => row.shortage_flags?.procurement_raised && !row.shortage_flags?.fully_received && !row.shortage_flags?.ready_for_reissue
      ).length,
      fullyOrdered: openRows.filter((row) => row.shortage_flags?.fully_ordered).length,
      fullyReceived: openRows.filter((row) => row.shortage_flags?.fully_received).length,
      readyForReissue: openRows.filter((row) => row.shortage_flags?.ready_for_reissue).length,
      blocked: openRows.filter((row) => String(row.action_type || "").toLowerCase() === "blocked").length,
      followUp: openRows.filter((row) => String(row.action_type || "").toLowerCase() === "follow_up").length,
      oldestAgeDays: openRows.reduce((max, row) => Math.max(max, Number(row.shortage_age_days || 0)), 0),
    },
  };
}

async function queryMaterialReadinessFgRows(client, companyId, { q = "" } = {}) {
  const params = [Number(companyId)];
  const filters = [
    `p.is_active = true`,
    `(
      coalesce(p.is_manufactured, false) = true
      or p.mfg_job_prefix is not null
      or coalesce(bc.total_bom_count, 0) > 0
    )`,
  ];
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      p.item_code ilike $${idx}
      or p.item_name ilike $${idx}
      or coalesce(p.mfg_job_prefix, '') ilike $${idx}
      or coalesce(lab.bom_code, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const r = await client.query(
    `
      with bom_counts as (
        select
          mb.finished_good_product_id,
          count(*)::int as total_bom_count,
          count(*) filter (where mb.is_active = true)::int as active_bom_count
        from manufacturing_boms mb
        where mb.company_id = $1
        group by mb.finished_good_product_id
      ),
      latest_active_bom as (
        select distinct on (mb.finished_good_product_id)
          mb.finished_good_product_id,
          mb.id as bom_id,
          mb.bom_code,
          mb.revision_no,
          coalesce(lines.line_count, 0) as line_count
        from manufacturing_boms mb
        left join (
          select bom_id, count(*)::int as line_count
          from manufacturing_bom_lines
          group by bom_id
        ) lines on lines.bom_id = mb.id
        where mb.company_id = $1
          and mb.is_active = true
        order by mb.finished_good_product_id, mb.revision_no desc, mb.updated_at desc, mb.id desc
      ),
      open_job_stats as (
        select
          jc.finished_good_product_id,
          count(*)::int as open_job_count,
          coalesce(sum(case when coalesce(stats.pending_issue_qty, 0) > 0 then 1 else 0 end), 0)::int as jobs_pending_material,
          coalesce(sum(stats.pending_issue_qty), 0) as pending_issue_qty
        from job_cards jc
        left join lateral (
          select
            coalesce(sum(greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0)), 0) as pending_issue_qty
          from job_card_lines jcl
          left join lateral (
            select coalesce(sum(qty), 0) as issue_qty
            from job_card_movements
            where job_card_line_id = jcl.id and movement_type = 'issue'
          ) issue_stats on true
          left join lateral (
            select coalesce(sum(qty), 0) as return_qty
            from job_card_movements
            where job_card_line_id = jcl.id and movement_type = 'return'
          ) return_stats on true
          where jcl.job_card_id = jc.id
        ) stats on true
        where jc.company_id = $1
          and jc.job_type = 'manufacturing'
          and lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')
          and jc.finished_good_product_id is not null
        group by jc.finished_good_product_id
      )
      select
        p.id,
        p.item_code,
        p.item_name,
        p.uom,
        coalesce(p.is_manufactured, false) as is_manufactured,
        p.mfg_job_prefix,
        coalesce(bc.total_bom_count, 0) as total_bom_count,
        coalesce(bc.active_bom_count, 0) as active_bom_count,
        lab.bom_id as latest_active_bom_id,
        lab.bom_code as latest_active_bom_code,
        lab.revision_no as latest_active_revision_no,
        coalesce(lab.line_count, 0) as latest_active_line_count,
        coalesce(js.open_job_count, 0) as open_job_count,
        coalesce(js.jobs_pending_material, 0) as jobs_pending_material,
        coalesce(js.pending_issue_qty, 0) as pending_issue_qty
      from products p
      left join bom_counts bc on bc.finished_good_product_id = p.id
      left join latest_active_bom lab on lab.finished_good_product_id = p.id
      left join open_job_stats js on js.finished_good_product_id = p.id
      ${where}
      order by p.item_code asc, p.id asc
    `,
    params
  );

  return r.rows.map((row) => {
    const prefix = normalizeText(row.mfg_job_prefix);
    const latestLineCount = Number(row.latest_active_line_count || 0);
    const activeBomCount = Number(row.active_bom_count || 0);
    const readyForJob = row.is_manufactured === true && Boolean(prefix) && activeBomCount > 0 && latestLineCount > 0;
    let readinessStatus = "ready";
    let readinessNote = "Ready for job creation.";

    if (!row.is_manufactured) {
      readinessStatus = "missing_fg_flag";
      readinessNote = "Mark as Manufactured FG in Product Master.";
    } else if (!prefix) {
      readinessStatus = "missing_prefix";
      readinessNote = "Assign manufacturing JobID prefix in Product Master.";
    } else if (activeBomCount <= 0) {
      readinessStatus = "missing_active_bom";
      readinessNote = "Create or activate a BOM.";
    } else if (latestLineCount <= 0) {
      readinessStatus = "empty_bom";
      readinessNote = "Active BOM has no component lines.";
    }

    return {
      ...row,
      ready_for_job: readyForJob,
      readiness_status: readinessStatus,
      readiness_note: readinessNote,
    };
  });
}

function getMaterialReadinessFgBucket(row) {
  const status = String(row?.readiness_status || "").toLowerCase();
  if (status === "missing_prefix") return "missing_prefix";
  if (["missing_active_bom", "empty_bom"].includes(status)) return "bom_gaps";
  if (status !== "ready") return "fg_setup_gaps";
  return "ready";
}

function getMaterialReadinessShortageBucket(row) {
  if (row?.shortage_flags?.ready_for_reissue) return "ready_reissue";
  if (String(row?.action_type || "").toLowerCase() === "blocked") return "blocked_supply";
  if (!row?.shortage_flags?.procurement_raised) return "shortage_not_raised";
  if (row?.shortage_flags?.procurement_raised && !row?.shortage_flags?.fully_received) return "procurement_in_flight";
  return "other";
}

function getMaterialReadinessQueueRank(row) {
  const bucket = String(row?.bucket || "").toLowerCase();
  if (bucket === "ready_reissue") return 0;
  if (bucket === "shortage_not_raised") return 1;
  if (bucket === "blocked_supply") return 2;
  if (bucket === "procurement_in_flight") return 3;
  if (bucket === "missing_prefix") return 4;
  if (bucket === "bom_gaps") return 5;
  if (bucket === "fg_setup_gaps") return 6;
  return 7;
}

async function getMaterialReadinessSummary(client, req, { q = "" } = {}) {
  const companyId = getActiveCompanyId(req);
  const fgRows = companyId ? await queryMaterialReadinessFgRows(client, companyId, { q }) : [];
  const shortageRows = await queryStoresShortageRows(client, req, { q, limit: 400 });
  const fgGaps = fgRows.filter((row) => !row.ready_for_job);
  const openShortages = shortageRows.filter((row) => !row.shortage_flags?.auto_closed);
  return {
    fgCandidates: fgRows.length,
    fgReady: fgRows.filter((row) => row.ready_for_job).length,
    fgSetupGaps: fgGaps.length,
    missingPrefix: fgGaps.filter((row) => row.readiness_status === "missing_prefix").length,
    bomGaps: fgGaps.filter((row) => ["missing_active_bom", "empty_bom"].includes(String(row.readiness_status || "").toLowerCase())).length,
    shortageNotRaised: openShortages.filter((row) => getMaterialReadinessShortageBucket(row) === "shortage_not_raised").length,
    procurementInFlight: openShortages.filter((row) => getMaterialReadinessShortageBucket(row) === "procurement_in_flight").length,
    blockedSupply: openShortages.filter((row) => getMaterialReadinessShortageBucket(row) === "blocked_supply").length,
    readyForReissue: openShortages.filter((row) => getMaterialReadinessShortageBucket(row) === "ready_reissue").length,
    openManufacturingJobs: fgRows.reduce((sum, row) => sum + Number(row.open_job_count || 0), 0),
    jobsPendingMaterial: fgRows.reduce((sum, row) => sum + Number(row.jobs_pending_material || 0), 0),
    pendingIssueQty: money(fgRows.reduce((sum, row) => sum + money(row.pending_issue_qty || 0), 0)),
    oldestShortageAgeDays: openShortages.reduce((max, row) => Math.max(max, Number(row.shortage_age_days || 0)), 0),
  };
}

async function getMaterialReadinessQueue(client, req, { q = "", bucket = "all", limit = 60 } = {}) {
  const companyId = getActiveCompanyId(req);
  const fgRows = companyId ? await queryMaterialReadinessFgRows(client, companyId, { q }) : [];
  const shortageRows = await queryStoresShortageRows(client, req, { q, limit: 400 });
  const normalizedBucket = String(bucket || "all").trim().toLowerCase() || "all";

  const fgQueue = fgRows
    .filter((row) => !row.ready_for_job)
    .map((row) => ({
      ...row,
      row_type: "fg_readiness",
      product_id: Number(row.id),
      bucket: getMaterialReadinessFgBucket(row),
      ...buildMaterialReadinessFgMetadata(row),
    }));
  const shortageQueue = shortageRows
    .filter((row) => !row.shortage_flags?.auto_closed)
    .map((row) => ({
      ...row,
      row_type: "shortage_action",
      bucket: getMaterialReadinessShortageBucket(row),
    }))
    .filter((row) => row.bucket !== "other");

  const combined = [...fgQueue, ...shortageQueue]
    .filter((row) => {
      if (normalizedBucket === "all") return true;
      if (normalizedBucket === "fg_setup_gaps") return row.row_type === "fg_readiness";
      return row.bucket === normalizedBucket;
    })
    .sort((a, b) => {
      const rankDiff = getMaterialReadinessQueueRank(a) - getMaterialReadinessQueueRank(b);
      if (rankDiff !== 0) return rankDiff;
      if (a.row_type === "shortage_action" && b.row_type === "shortage_action") {
        return Number(b.shortage_age_days || 0) - Number(a.shortage_age_days || 0);
      }
      if (a.row_type === "fg_readiness" && b.row_type === "fg_readiness") {
        const pendingDiff = Number(b.jobs_pending_material || 0) - Number(a.jobs_pending_material || 0);
        if (pendingDiff !== 0) return pendingDiff;
        return String(a.item_code || "").localeCompare(String(b.item_code || ""));
      }
      return a.row_type === "shortage_action" ? -1 : 1;
    });

  return combined.slice(0, normalizeLimit(limit, 60, 200));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTravelerDate(value) {
  if (!value) return "NA";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "NA";
  return dt.toLocaleDateString("en-GB");
}

function formatTravelerQty(value) {
  return money(value).toFixed(4);
}

function safeFileSegment(value) {
  return String(value || "")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function buildManufacturingPrintFileName(header, kind, extension = "pdf") {
  const base = safeFileSegment(header?.job_card_number || `job_card_${header?.id || "document"}`);
  const jobIdPart = header?.job_id ? `_${safeFileSegment(header.job_id)}` : "";
  const docPart = kind === "issue_slip" ? "issue_slip" : "traveler";
  return `${base}${jobIdPart}_${docPart}.${extension}`;
}

function buildBulkManufacturingFileName(kind, extension = "pdf") {
  const stamp = new Date().toISOString().slice(0, 10);
  return `manufacturing_${safeFileSegment(kind)}_${stamp}.${extension}`;
}

function buildManufacturingPdfHtml(innerHtml) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      @page { size: A4; margin: 12mm; }
      html, body { margin: 0; padding: 0; background: #ffffff; }
      body { font-family: Arial, Helvetica, sans-serif; color: #162033; }
      .page {
        width: 100%;
        min-height: auto;
        margin: 0;
        background: #fff;
        padding: 0;
      }
      .print-actions { display: none !important; }
    </style>
  </head>
  <body>${innerHtml}</body>
</html>`;
}

function extractBodyHtml(html) {
  const match = String(html || "").match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return match ? match[1] : String(html || "");
}

function renderCombinedManufacturingDocumentsHtml(title, documents) {
  const sections = documents
    .map(
      (doc) => `
        <section class="bulk-page">
          ${extractBodyHtml(doc.html)}
        </section>
      `
    )
    .join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page { size: A4; margin: 10mm; }
      html, body { margin: 0; padding: 0; background: #ffffff; }
      body { font-family: Arial, Helvetica, sans-serif; color: #162033; }
      .bulk-page { page-break-after: always; break-after: page; }
      .bulk-page:last-child { page-break-after: auto; break-after: auto; }
      .print-actions { display: none !important; }
    </style>
  </head>
  <body>${sections}</body>
</html>`;
}

async function generateManufacturingDocumentPdf({ header, html, kind }) {
  const pdf = await generateQuotePdfBuffer(buildManufacturingPdfHtml(html));
  const fileName = buildManufacturingPrintFileName(header, kind, "pdf");
  const storageDir = path.resolve(__dirname, "..", "..", "storage", "manufacturing");
  fs.mkdirSync(storageDir, { recursive: true });
  const absFilePath = path.join(storageDir, fileName);
  fs.writeFileSync(absFilePath, pdf);
  return { pdf, fileName, absFilePath };
}

async function generateBulkManufacturingPdf({ html, kind }) {
  const pdf = await generateQuotePdfBuffer(html);
  const fileName = buildBulkManufacturingFileName(kind, "pdf");
  const storageDir = path.resolve(__dirname, "..", "..", "storage", "manufacturing");
  fs.mkdirSync(storageDir, { recursive: true });
  const absFilePath = path.join(storageDir, fileName);
  fs.writeFileSync(absFilePath, pdf);
  return { pdf, fileName, absFilePath };
}

function parseIdListParam(value) {
  const parts = Array.isArray(value) ? value.flatMap((item) => String(item || "").split(",")) : String(value || "").split(",");
  return [...new Set(parts.map((item) => Number(item.trim())).filter((item) => Number.isFinite(item) && item > 0))];
}

async function resolveManufacturingPrintContext(req, id) {
  const header = await getJobCardHeaderOrNull(pool, id);
  if (!header) {
    const err = new Error("NOT_FOUND");
    err.status = 404;
    throw err;
  }
  if (!canAccessJobCard(req, header)) {
    const err = new Error("FORBIDDEN");
    err.status = 403;
    throw err;
  }
  if (!canAccessCompanyContext(req, header)) {
    const err = new Error("COMPANY_CONTEXT_MISMATCH");
    err.status = 403;
    throw err;
  }
  if (String(header.job_type || "").toLowerCase() !== "manufacturing") {
    const err = new Error("PRINT_ONLY_FOR_MANUFACTURING");
    err.status = 409;
    throw err;
  }
  const [lines, movements] = await Promise.all([getJobCardLines(pool, id), getJobCardMovements(pool, id)]);
  return { header, lines, movements };
}

async function resolveManufacturingPrintContexts(req, ids) {
  const resolvedIds = parseIdListParam(ids);
  const contexts = await Promise.all(resolvedIds.map((id) => resolveManufacturingPrintContext(req, id)));
  return contexts;
}

function renderManufacturingTravelerHtml(header, lines, movements) {
  const mode = header?.sales_order_line_id ? "SO-linked manufacturing" : "Standalone manufacturing";
  const issueMovements = movements.filter((row) => String(row.movement_type || "").toLowerCase() === "issue");
  const returnMovements = movements.filter((row) => String(row.movement_type || "").toLowerCase() === "return");
  const totalOutstanding = lines.reduce((sum, line) => sum + money(line.qty_outstanding), 0);
  const materialRows = lines.length
    ? lines
        .map(
          (line) => `
            <tr>
              <td>${escapeHtml(line.line_no || "")}</td>
              <td>
                <div class="strong">${escapeHtml(line.item_code || "")}</div>
                <div class="muted">${escapeHtml(line.item_name || "")}</div>
              </td>
              <td>${escapeHtml(line.uom || "")}</td>
              <td class="num">${formatTravelerQty(line.qty_requested)}</td>
              <td class="num">${formatTravelerQty(line.qty_issued)}</td>
              <td class="num">${formatTravelerQty(line.qty_returned)}</td>
              <td class="num">${formatTravelerQty(line.qty_outstanding)}</td>
              <td class="num">${formatTravelerQty(line.current_stock_qty)}</td>
              <td>${escapeHtml(line.remarks || "")}</td>
            </tr>
          `
        )
        .join("")
    : `
      <tr>
        <td colspan="9" class="empty">No material lines loaded on this manufacturing job.</td>
      </tr>
    `;

  const movementRows = movements.length
    ? movements
        .map(
          (move) => `
            <tr>
              <td>${escapeHtml(move.line_no || "")}</td>
              <td>${escapeHtml(String(move.movement_type || "").toUpperCase())}</td>
              <td>${formatTravelerDate(move.movement_date)}</td>
              <td class="num">${formatTravelerQty(move.qty)}</td>
              <td>${escapeHtml(move.reference_no || "")}</td>
              <td>${escapeHtml(move.created_by_name || "")}</td>
              <td>${escapeHtml((move.serials || []).join(", "))}</td>
              <td>${escapeHtml(move.remarks || "")}</td>
            </tr>
          `
        )
        .join("")
    : `
      <tr>
        <td colspan="8" class="empty">No issue or return movements recorded yet.</td>
      </tr>
    `;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(header.job_card_number || "Manufacturing Traveler")}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
        --ink: #162033;
        --muted: #5a6475;
        --line: #d9dfeb;
        --soft: #f5f7fb;
        --soft-2: #eef3ff;
        --accent: #234a8f;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #eef2f7;
        color: var(--ink);
        font-family: Arial, Helvetica, sans-serif;
      }
      .page {
        width: 210mm;
        min-height: 297mm;
        margin: 0 auto;
        background: #fff;
        padding: 16mm 14mm 18mm;
      }
      .header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        border-bottom: 2px solid var(--ink);
        padding-bottom: 10px;
      }
      .eyebrow {
        font-size: 11px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 6px;
      }
      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
      }
      .subhead {
        margin-top: 6px;
        font-size: 13px;
        color: var(--muted);
        line-height: 1.5;
      }
      .badge {
        display: inline-block;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--soft-2);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
      }
      .grid {
        display: grid;
        gap: 10px;
      }
      .summary {
        grid-template-columns: repeat(4, minmax(0, 1fr));
        margin-top: 14px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        background: var(--soft);
      }
      .label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .value {
        margin-top: 5px;
        font-size: 16px;
        font-weight: 700;
      }
      .section {
        margin-top: 16px;
      }
      .section h2 {
        margin: 0 0 8px;
        font-size: 15px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .info-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }
      .info-block {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
      }
      .kv {
        display: grid;
        grid-template-columns: 120px minmax(0, 1fr);
        gap: 8px;
        font-size: 12px;
        line-height: 1.6;
      }
      .kv b {
        color: var(--muted);
        font-weight: 600;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th, td {
        border: 1px solid var(--line);
        padding: 8px 7px;
        vertical-align: top;
      }
      th {
        background: var(--soft);
        text-align: left;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .num {
        text-align: right;
        white-space: nowrap;
      }
      .muted {
        color: var(--muted);
      }
      .strong {
        font-weight: 700;
      }
      .empty {
        text-align: center;
        color: var(--muted);
        padding: 14px;
      }
      .footer-grid {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: 12px;
        margin-top: 16px;
      }
      .notes {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        min-height: 96px;
      }
      .sign-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }
      .sign-box {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        min-height: 96px;
      }
      .sign-line {
        margin-top: 46px;
        border-top: 1px solid var(--line);
        padding-top: 6px;
        font-size: 12px;
        color: var(--muted);
      }
      .print-actions {
        display: flex;
        gap: 8px;
        margin-top: 14px;
      }
      .print-actions button {
        border: 1px solid var(--line);
        background: #fff;
        border-radius: 999px;
        padding: 8px 14px;
        cursor: pointer;
        font-size: 12px;
      }
      @media print {
        body {
          background: #fff;
        }
        .page {
          width: auto;
          min-height: auto;
          margin: 0;
          padding: 0;
        }
        .print-actions {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <div>
          <div class="eyebrow">Shop Floor Traveler</div>
          <h1>${escapeHtml(header.job_card_number || "")}${header.job_id ? ` / ${escapeHtml(header.job_id)}` : ""}</h1>
          <div class="subhead">
            ${escapeHtml(mode)} | Finished Good ${escapeHtml(header.finished_good_item_code || "")} ${header.finished_good_item_name ? `- ${escapeHtml(header.finished_good_item_name)}` : ""}
          </div>
        </div>
        <div style="text-align:right">
          <div class="badge">${escapeHtml(String(header.job_status || "draft").toUpperCase())}</div>
          <div class="print-actions">
            <button onclick="window.print()">Print</button>
            <button onclick="window.close()">Close</button>
          </div>
        </div>
      </div>

      <div class="grid summary">
        <div class="card"><div class="label">Planned Output</div><div class="value">${formatTravelerQty(header.planned_output_qty)}</div></div>
        <div class="card"><div class="label">Actual Output</div><div class="value">${formatTravelerQty(header.actual_output_qty)}</div></div>
        <div class="card"><div class="label">Issue Moves</div><div class="value">${issueMovements.length}</div></div>
        <div class="card"><div class="label">Outstanding RM</div><div class="value">${formatTravelerQty(totalOutstanding)}</div></div>
      </div>

      <div class="section">
        <h2>Manufacturing Context</h2>
        <div class="info-grid">
          <div class="info-block">
            <div class="kv"><b>Job Date</b><span>${formatTravelerDate(header.job_date)}</span></div>
            <div class="kv"><b>Receipt Date</b><span>${formatTravelerDate(header.finished_good_receipt_date)}</span></div>
            <div class="kv"><b>BOM</b><span>${escapeHtml(header.bom_code || "Auto / latest active BOM")}</span></div>
            <div class="kv"><b>Created By</b><span>${escapeHtml(header.created_by_name || "")}</span></div>
          </div>
          <div class="info-block">
            <div class="kv"><b>Sales Order</b><span>${escapeHtml(header.so_number || "NA")}</span></div>
            <div class="kv"><b>SO Line</b><span>${escapeHtml(header.sales_order_line_no || "NA")}</span></div>
            <div class="kv"><b>Customer</b><span>${escapeHtml(header.sales_order_customer_name || header.service_customer_name || "NA")}</span></div>
            <div class="kv"><b>FG Stock</b><span>${formatTravelerQty(header.finished_good_stock_qty)}</span></div>
          </div>
          <div class="info-block">
            <div class="kv"><b>Technician</b><span>${escapeHtml(header.technician_name || "NA")}</span></div>
            <div class="kv"><b>Department</b><span>${escapeHtml(header.department || "NA")}</span></div>
            <div class="kv"><b>Site</b><span>${escapeHtml(header.site_name || "NA")}</span></div>
            <div class="kv"><b>Remarks</b><span>${escapeHtml(header.remarks || "NA")}</span></div>
          </div>
        </div>
      </div>

      <div class="section">
        <h2>Material Plan / Issue Slip</h2>
        <table>
          <thead>
            <tr>
              <th style="width:42px;">Ln</th>
              <th>Item</th>
              <th style="width:64px;">UOM</th>
              <th style="width:82px;">Requested</th>
              <th style="width:82px;">Issued</th>
              <th style="width:82px;">Returned</th>
              <th style="width:92px;">Outstanding</th>
              <th style="width:88px;">Stock</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>${materialRows}</tbody>
        </table>
      </div>

      <div class="section">
        <h2>Movement Register</h2>
        <table>
          <thead>
            <tr>
              <th style="width:42px;">Ln</th>
              <th style="width:80px;">Type</th>
              <th style="width:82px;">Date</th>
              <th style="width:82px;">Qty</th>
              <th style="width:120px;">Reference</th>
              <th style="width:120px;">By</th>
              <th>Serials</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>${movementRows}</tbody>
        </table>
      </div>

      <div class="footer-grid">
        <div class="notes">
          <div class="strong">Shop Notes</div>
          <div class="muted" style="margin-top:8px; line-height:1.7;">
            Total issue qty: ${formatTravelerQty(header.total_issued_qty)} | Total return qty: ${formatTravelerQty(header.total_returned_qty)} | Total consumed qty: ${formatTravelerQty(header.total_consumed_qty)}<br />
            Use this sheet for traveler reference, material issue confirmation, and hand-signoff on the floor.
          </div>
        </div>
        <div class="sign-grid">
          <div class="sign-box"><div class="sign-line">Store / Issue</div></div>
          <div class="sign-box"><div class="sign-line">Production</div></div>
          <div class="sign-box"><div class="sign-line">Supervisor</div></div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function renderManufacturingIssueSlipHtml(header, lines) {
  const mode = header?.sales_order_line_id ? "SO-linked manufacturing" : "Standalone manufacturing";
  const totalOutstanding = lines.reduce((sum, line) => sum + money(line.qty_outstanding), 0);
  const materialRows = lines.length
    ? lines
        .map(
          (line) => `
            <tr>
              <td>${escapeHtml(line.line_no || "")}</td>
              <td>
                <div class="strong">${escapeHtml(line.item_code || "")}</div>
                <div class="muted">${escapeHtml(line.item_name || "")}</div>
              </td>
              <td>${escapeHtml(line.uom || "")}</td>
              <td class="num">${formatTravelerQty(line.qty_requested)}</td>
              <td class="num">${formatTravelerQty(line.qty_issued)}</td>
              <td class="num">${formatTravelerQty(line.qty_returned)}</td>
              <td class="num">${formatTravelerQty(line.qty_outstanding)}</td>
              <td class="num">${formatTravelerQty(line.current_stock_qty)}</td>
              <td>${escapeHtml(line.remarks || "")}</td>
              <td class="sign"></td>
            </tr>
          `
        )
        .join("")
    : `
      <tr>
        <td colspan="10" class="empty">No material lines loaded on this manufacturing job.</td>
      </tr>
    `;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(header.job_card_number || "Issue Slip")}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
        --ink: #162033;
        --muted: #5a6475;
        --line: #d9dfeb;
        --soft: #f5f7fb;
        --soft-2: #eef3ff;
        --accent: #234a8f;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #eef2f7;
        color: var(--ink);
        font-family: Arial, Helvetica, sans-serif;
      }
      .page {
        width: 210mm;
        min-height: 297mm;
        margin: 0 auto;
        background: #fff;
        padding: 16mm 14mm 18mm;
      }
      .header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        border-bottom: 2px solid var(--ink);
        padding-bottom: 10px;
      }
      .eyebrow {
        font-size: 11px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 6px;
      }
      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
      }
      .subhead {
        margin-top: 6px;
        font-size: 13px;
        color: var(--muted);
        line-height: 1.5;
      }
      .badge {
        display: inline-block;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--soft-2);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
      }
      .grid {
        display: grid;
        gap: 10px;
      }
      .summary {
        grid-template-columns: repeat(4, minmax(0, 1fr));
        margin-top: 14px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        background: var(--soft);
      }
      .label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .value {
        margin-top: 5px;
        font-size: 16px;
        font-weight: 700;
      }
      .section {
        margin-top: 16px;
      }
      .section h2 {
        margin: 0 0 8px;
        font-size: 15px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th, td {
        border: 1px solid var(--line);
        padding: 8px 7px;
        vertical-align: top;
      }
      th {
        background: var(--soft);
        text-align: left;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .num {
        text-align: right;
        white-space: nowrap;
      }
      .muted {
        color: var(--muted);
      }
      .strong {
        font-weight: 700;
      }
      .empty {
        text-align: center;
        color: var(--muted);
        padding: 14px;
      }
      .sign {
        min-width: 52px;
      }
      .footer-grid {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: 12px;
        margin-top: 16px;
      }
      .notes {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        min-height: 96px;
      }
      .sign-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .sign-box {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        min-height: 96px;
      }
      .sign-line {
        margin-top: 46px;
        border-top: 1px solid var(--line);
        padding-top: 6px;
        font-size: 12px;
        color: var(--muted);
      }
      .print-actions {
        display: flex;
        gap: 8px;
        margin-top: 14px;
      }
      .print-actions button {
        border: 1px solid var(--line);
        background: #fff;
        border-radius: 999px;
        padding: 8px 14px;
        cursor: pointer;
        font-size: 12px;
      }
      @media print {
        body {
          background: #fff;
        }
        .page {
          width: auto;
          min-height: auto;
          margin: 0;
          padding: 0;
        }
        .print-actions {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <div>
          <div class="eyebrow">Material Issue Slip</div>
          <h1>${escapeHtml(header.job_card_number || "")}${header.job_id ? ` / ${escapeHtml(header.job_id)}` : ""}</h1>
          <div class="subhead">
            ${escapeHtml(mode)} | Finished Good ${escapeHtml(header.finished_good_item_code || "")} ${header.finished_good_item_name ? `- ${escapeHtml(header.finished_good_item_name)}` : ""}
          </div>
        </div>
        <div style="text-align:right">
          <div class="badge">${escapeHtml(String(header.job_status || "draft").toUpperCase())}</div>
          <div class="print-actions">
            <button onclick="window.print()">Print</button>
            <button onclick="window.close()">Close</button>
          </div>
        </div>
      </div>

      <div class="grid summary">
        <div class="card"><div class="label">Planned Output</div><div class="value">${formatTravelerQty(header.planned_output_qty)}</div></div>
        <div class="card"><div class="label">Issue Total</div><div class="value">${formatTravelerQty(header.total_issued_qty)}</div></div>
        <div class="card"><div class="label">Return Total</div><div class="value">${formatTravelerQty(header.total_returned_qty)}</div></div>
        <div class="card"><div class="label">Outstanding RM</div><div class="value">${formatTravelerQty(totalOutstanding)}</div></div>
      </div>

      <div class="section">
        <h2>Issue Lines</h2>
        <table>
          <thead>
            <tr>
              <th style="width:42px;">Ln</th>
              <th>Item</th>
              <th style="width:64px;">UOM</th>
              <th style="width:82px;">Requested</th>
              <th style="width:82px;">Issued</th>
              <th style="width:82px;">Returned</th>
              <th style="width:92px;">Outstanding</th>
              <th style="width:88px;">Stock</th>
              <th>Remarks</th>
              <th style="width:70px;">Sign</th>
            </tr>
          </thead>
          <tbody>${materialRows}</tbody>
        </table>
      </div>

      <div class="footer-grid">
        <div class="notes">
          <div class="strong">Store Notes</div>
          <div class="muted" style="margin-top:8px; line-height:1.7;">
            Customer: ${escapeHtml(header.sales_order_customer_name || header.service_customer_name || "NA")} | SO: ${escapeHtml(header.so_number || "NA")} | BOM: ${escapeHtml(header.bom_code || "Auto / latest active BOM")}<br />
            Issue against this slip and sign each line where required.
          </div>
        </div>
        <div class="sign-grid">
          <div class="sign-box"><div class="sign-line">Store / Issue</div></div>
          <div class="sign-box"><div class="sign-line">Production</div></div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function renderStoresPickListHtml(groupedRows, { groupBy = "fg", title = "Stores Pick List", summary = null } = {}) {
  const groups = Array.isArray(groupedRows) ? groupedRows : [];
  const sectionHtml = groups.length
    ? groups
        .map((group) => {
          const rowsHtml = (group.rows || [])
            .map(
              (row) => `
                <tr>
                  <td>${escapeHtml(row.job_card_number || "")}${row.job_id ? `<div class="muted">${escapeHtml(row.job_id)}</div>` : ""}</td>
                  <td>${escapeHtml(row.finished_good_item_code || "")}<div class="muted">${escapeHtml(row.finished_good_item_name || "")}</div></td>
                  <td>${escapeHtml(row.item_code || "")}<div class="muted">${escapeHtml(row.item_name || "")}</div></td>
                  <td>${escapeHtml(row.uom || "")}</td>
                  <td class="num">${formatTravelerQty(row.pending_qty)}</td>
                  <td class="num">${formatTravelerQty(row.current_stock_qty)}</td>
                  <td>${escapeHtml(row.so_number || "NA")}</td>
                  <td>${escapeHtml(row.customer_name || "NA")}</td>
                  <td>${escapeHtml(row.remarks || "")}</td>
                </tr>
              `
            )
            .join("");
          return `
            <section class="group">
              <div class="group-head">
                <div>
                  <div class="group-title">${escapeHtml(group.label || "Ungrouped")}</div>
                  <div class="group-subtitle">${escapeHtml(group.subtitle || "")}</div>
                </div>
                <div class="group-metrics">
                  <span>Jobs ${escapeHtml(group.jobCount || 0)}</span>
                  <span>Lines ${escapeHtml(group.lineCount || 0)}</span>
                  <span>Pending ${formatTravelerQty(group.pendingQty)}</span>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th style="width:120px;">Job</th>
                    <th>Finished Good</th>
                    <th>Component</th>
                    <th style="width:60px;">UOM</th>
                    <th style="width:92px;">Pending</th>
                    <th style="width:92px;">Stock</th>
                    <th style="width:90px;">SO</th>
                    <th style="width:120px;">Customer</th>
                    <th>Remarks</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </section>
          `;
        })
        .join("")
    : `<div class="empty">No pending stores lines available for this pick list.</div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
        --ink: #162033;
        --muted: #5a6475;
        --line: #d9dfeb;
        --soft: #f5f7fb;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #eef2f7;
        color: var(--ink);
        font-family: Arial, Helvetica, sans-serif;
      }
      .page {
        width: 210mm;
        min-height: 297mm;
        margin: 0 auto;
        background: #fff;
        padding: 16mm 14mm 18mm;
      }
      .header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        border-bottom: 2px solid var(--ink);
        padding-bottom: 10px;
      }
      .eyebrow {
        font-size: 11px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 6px;
      }
      h1 { margin: 0; font-size: 24px; line-height: 1.2; }
      .subhead { margin-top: 6px; font-size: 13px; color: var(--muted); line-height: 1.5; }
      .print-actions { display: flex; gap: 8px; margin-top: 14px; }
      .print-actions button {
        border: 1px solid var(--line);
        background: #fff;
        border-radius: 999px;
        padding: 8px 14px;
        cursor: pointer;
        font-size: 12px;
      }
      .summary {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin-top: 14px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        background: var(--soft);
      }
      .label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .value {
        margin-top: 5px;
        font-size: 16px;
        font-weight: 700;
      }
      .group { margin-top: 16px; }
      .group-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        margin-bottom: 8px;
      }
      .group-title { font-size: 15px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
      .group-subtitle { margin-top: 4px; font-size: 12px; color: var(--muted); }
      .group-metrics {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        font-size: 12px;
        color: var(--muted);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th, td {
        border: 1px solid var(--line);
        padding: 8px 7px;
        vertical-align: top;
      }
      th {
        background: var(--soft);
        text-align: left;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .num { text-align: right; white-space: nowrap; }
      .muted { color: var(--muted); font-size: 11px; margin-top: 2px; }
      .empty {
        margin-top: 18px;
        text-align: center;
        color: var(--muted);
        padding: 18px;
        border: 1px dashed var(--line);
        border-radius: 14px;
      }
      @media print {
        body { background: #fff; }
        .page { width: auto; min-height: auto; margin: 0; padding: 0; }
        .print-actions { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <div>
          <div class="eyebrow">Stores Pick List</div>
          <h1>${escapeHtml(title)}</h1>
          <div class="subhead">
            Grouped by ${groupBy === "so" ? "Sales Order" : "Finished Good"} for open manufacturing jobs that still need material issue.
          </div>
        </div>
        <div class="print-actions">
          <button onclick="window.print()">Print</button>
          <button onclick="window.close()">Close</button>
        </div>
      </div>
      <div class="summary">
        <div class="card"><div class="label">Groups</div><div class="value">${summary?.groups || groups.length}</div></div>
        <div class="card"><div class="label">Jobs</div><div class="value">${summary?.jobs || 0}</div></div>
        <div class="card"><div class="label">Lines</div><div class="value">${summary?.lines || 0}</div></div>
        <div class="card"><div class="label">Pending Qty</div><div class="value">${formatTravelerQty(summary?.pendingQty || 0)}</div></div>
      </div>
      ${sectionHtml}
    </div>
  </body>
</html>`;
}

function enrichManufacturingAuditRow(row) {
  const status = String(row.job_status || "").toLowerCase();
  const isFinalStatus = ["closed", "posted"].includes(status);
  const hasFinishedGood = Boolean(row.finished_good_product_id);
  const hasBom = Boolean(row.bom_id);
  const hasPlannedOutput = qty(row.planned_output_qty) > 0;
  const hasActualOutput = qty(row.actual_output_qty) > 0;
  const hasReceiptDate = Boolean(row.finished_good_receipt_date);
  const hasMovements = Number(row.movement_count || 0) > 0;
  const pendingIssue = qty(row.pending_issue_qty) > 0;
  const lowStock = Number(row.low_stock_line_count || 0) > 0;
  const criticalReady = hasFinishedGood && hasBom && hasPlannedOutput && hasActualOutput && hasReceiptDate;
  const readyToClosePost = !isFinalStatus && criticalReady;
  const finalStatusRisk = isFinalStatus && !criticalReady;
  const missingOutput = !hasActualOutput;
  const missingReceiptDate = hasActualOutput && !hasReceiptDate;
  const missingBom = !hasBom;
  const noMovements = !hasMovements;
  const auditLabels = [];
  if (readyToClosePost) auditLabels.push("Ready to Close/Post");
  if (finalStatusRisk) auditLabels.push("Final Status Risk");
  if (missingOutput) auditLabels.push("Missing Output");
  if (missingReceiptDate) auditLabels.push("Missing Receipt Date");
  if (missingBom) auditLabels.push("Missing BOM");
  if (noMovements) auditLabels.push("No Movements");
  if (pendingIssue) auditLabels.push("Pending RM");
  if (lowStock) auditLabels.push("Low Stock");
  return {
    ...row,
    manufacturing_mode: row.sales_order_line_id ? "so_linked" : "standalone",
    audit_flags: {
      attention: finalStatusRisk || missingOutput || missingReceiptDate || missingBom || noMovements || pendingIssue || lowStock,
      ready_to_close_post: readyToClosePost,
      final_status_risk: finalStatusRisk,
      missing_output: missingOutput,
      missing_receipt_date: missingReceiptDate,
      missing_bom: missingBom,
      no_movements: noMovements,
      pending_issue: pendingIssue,
      low_stock: lowStock,
    },
    audit_labels: auditLabels,
  };
}

function matchesManufacturingAuditException(row, exception = "all") {
  const key = String(exception || "all").trim().toLowerCase();
  if (!key || key === "all") return true;
  if (key === "attention") return row.audit_flags?.attention === true;
  if (key === "ready") return row.audit_flags?.ready_to_close_post === true;
  if (key === "final_risk") return row.audit_flags?.final_status_risk === true;
  if (key === "missing_output") return row.audit_flags?.missing_output === true;
  if (key === "missing_receipt") return row.audit_flags?.missing_receipt_date === true;
  if (key === "missing_bom") return row.audit_flags?.missing_bom === true;
  if (key === "no_movements") return row.audit_flags?.no_movements === true;
  if (key === "pending_issue") return row.audit_flags?.pending_issue === true;
  if (key === "low_stock") return row.audit_flags?.low_stock === true;
  return true;
}

function getProductionExecutionBucket(row) {
  const status = String(row?.job_status || "").toLowerCase();
  const isFinalStatus = ["closed", "posted"].includes(status);
  if (row?.audit_flags?.final_status_risk) return "final_status_risk";
  if (row?.audit_flags?.ready_to_close_post) return "ready_to_close";
  if (!isFinalStatus && qty(row?.actual_output_qty) > 0 && row?.audit_flags?.missing_receipt_date) return "receipt_missing";
  if (!isFinalStatus && qty(row?.actual_output_qty) > 0) return "output_pending_close";
  if (!isFinalStatus && row?.audit_flags?.no_movements) return "stalled_wip";
  if (!isFinalStatus && row?.audit_flags?.pending_issue) return "pending_rm";
  return "other";
}

function matchesProductionExecutionBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getProductionExecutionBucket(row) !== "other";
  return getProductionExecutionBucket(row) === key;
}

function getProductionExecutionRank(row) {
  const bucket = getProductionExecutionBucket(row);
  if (bucket === "final_status_risk") return 0;
  if (bucket === "ready_to_close") return 1;
  if (bucket === "receipt_missing") return 2;
  if (bucket === "output_pending_close") return 3;
  if (bucket === "stalled_wip") return 4;
  if (bucket === "pending_rm") return 5;
  return 6;
}

function buildProductionExecutionMetadata(row) {
  const bucket = getProductionExecutionBucket(row);
  const jobDate = row?.job_date ? new Date(row.job_date) : null;
  const lastMovementDate = row?.last_movement_date ? new Date(row.last_movement_date) : null;
  const ageSource = lastMovementDate && !Number.isNaN(lastMovementDate.getTime()) ? lastMovementDate : jobDate;
  const ageDays = ageSource && !Number.isNaN(ageSource.getTime()) ? Math.max(Math.floor((Date.now() - ageSource.getTime()) / 86400000), 0) : 0;
  const actualOutputQty = money(row?.actual_output_qty || 0);
  const pendingIssueQty = money(row?.pending_issue_qty || 0);
  const lowStockLineCount = Number(row?.low_stock_line_count || 0);

  if (bucket === "final_status_risk") {
    return {
      queue_reason: "Job is already in final status while one or more manufacturing completion fields are still incomplete.",
      recommended_action: "review_final_status",
      recommended_action_label: "Review final status",
      attention_level: "high",
      age_days: ageDays,
    };
  }

  if (bucket === "ready_to_close") {
    return {
      queue_reason: "Job has finished good, BOM, planned output, actual output, and receipt date in place for the closing step.",
      recommended_action: "close_or_post_job",
      recommended_action_label: "Close or post job",
      attention_level: "medium",
      age_days: ageDays,
    };
  }

  if (bucket === "receipt_missing") {
    return {
      queue_reason: `Actual output of ${actualOutputQty.toFixed(4)} is recorded, but the finished-good receipt date is still missing.`,
      recommended_action: "update_receipt",
      recommended_action_label: "Update receipt",
      attention_level: "high",
      age_days: ageDays,
    };
  }

  if (bucket === "output_pending_close") {
    return {
      queue_reason: `Job has output posted at ${actualOutputQty.toFixed(4)} and should move to the final close or post step.`,
      recommended_action: "complete_closure",
      recommended_action_label: "Complete closure",
      attention_level: "medium",
      age_days: ageDays,
    };
  }

  if (bucket === "stalled_wip") {
    return {
      queue_reason: ageDays > 0 ? `No material or production movement is logged for ${ageDays} day(s).` : "No material or production movement is logged yet.",
      recommended_action: "start_production",
      recommended_action_label: "Start production",
      attention_level: "medium",
      age_days: ageDays,
    };
  }

  if (bucket === "pending_rm") {
    return {
      queue_reason:
        lowStockLineCount > 0
          ? `${pendingIssueQty.toFixed(4)} of pending raw material is still open and ${lowStockLineCount} line(s) are currently low on stock.`
          : `${pendingIssueQty.toFixed(4)} of pending raw material still needs issue before production can move ahead.`,
      recommended_action: lowStockLineCount > 0 ? "review_shortage" : "issue_material",
      recommended_action_label: lowStockLineCount > 0 ? "Review shortage" : "Issue material",
      attention_level: "high",
      age_days: ageDays,
    };
  }

  return {
    queue_reason: "Review the manufacturing job and take the next production step.",
    recommended_action: "open_job",
    recommended_action_label: "Open job",
    attention_level: "low",
    age_days: ageDays,
  };
}

function buildFgReceiptReconciliationMetadata(row) {
  const bucket = getFgReceiptReconciliationBucket(row);
  const ageDays = getDaysSince(row?.receipt_last_movement_date || row?.finished_good_receipt_date || row?.job_date);
  const actualOutputQty = money(row?.actual_output_qty || 0);
  const postedQty = money(row?.receipt_posted_qty || 0);
  const gapQty = Math.abs(money(row?.receipt_qty_gap || 0));

  if (bucket === "receipt_not_reflected") {
    return {
      queue_reason: `FG receipt is not reflected in stock even though ${actualOutputQty.toFixed(4)} of output is already recorded.`,
      recommended_action: "review_fg_receipt",
      recommended_action_label: "Review FG receipt",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "receipt_qty_mismatch") {
    return {
      queue_reason: `Posted FG quantity of ${postedQty.toFixed(4)} differs from the recorded output by ${gapQty.toFixed(4)}.`,
      recommended_action: "resolve_qty_gap",
      recommended_action_label: "Resolve qty gap",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "receipt_date_mismatch") {
    return {
      queue_reason: "The FG receipt date and the stock-ledger movement date do not match for this job.",
      recommended_action: "review_receipt_date",
      recommended_action_label: "Review receipt date",
      attention_level: "medium",
      age_days: ageDays,
    };
  }
  if (bucket === "premature_receipt") {
    return {
      queue_reason: "FG receipt hit stock before the manufacturing completion flow was properly aligned.",
      recommended_action: "review_premature_receipt",
      recommended_action_label: "Review premature receipt",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "final_without_output") {
    return {
      queue_reason: "Job is already in final status but no actual output is recorded.",
      recommended_action: "review_final_output",
      recommended_action_label: "Review final output",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "awaiting_final_post") {
    return {
      queue_reason: `Output of ${actualOutputQty.toFixed(4)} is recorded and is waiting for the FG receipt / final posting step.`,
      recommended_action: "post_fg_receipt",
      recommended_action_label: "Post FG receipt",
      attention_level: "medium",
      age_days: ageDays,
    };
  }
  return {
    queue_reason: "Review FG receipt reconciliation for this job.",
    recommended_action: "open_job",
    recommended_action_label: "Open job",
    attention_level: "low",
    age_days: ageDays,
  };
}

function buildConsumptionVarianceMetadata(row) {
  const bucket = getConsumptionVarianceBucket(row);
  const ageDays = getDaysSince(row?.last_line_movement_date || row?.job_date);

  if (bucket === "consumed_without_issue") {
    return {
      queue_reason: `Consumption exceeds net issued quantity by ${money(row?.consumed_without_issue_qty || 0).toFixed(4)}.`,
      recommended_action: "review_excess_consumption",
      recommended_action_label: "Review excess consume",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "low_stock_blocked") {
    return {
      queue_reason: `Pending issue of ${money(row?.pending_issue_qty || 0).toFixed(4)} is blocked by low stock.`,
      recommended_action: "review_shortage",
      recommended_action_label: "Review shortage",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "pending_issue") {
    return {
      queue_reason: `${money(row?.pending_issue_qty || 0).toFixed(4)} is still pending for issue on this line.`,
      recommended_action: "issue_material",
      recommended_action_label: "Issue material",
      attention_level: "medium",
      age_days: ageDays,
    };
  }
  if (bucket === "issued_not_consumed") {
    return {
      queue_reason: `${money(row?.issued_not_consumed_qty || 0).toFixed(4)} is issued but not yet consumed on the line.`,
      recommended_action: "review_line_balance",
      recommended_action_label: "Review line balance",
      attention_level: "medium",
      age_days: ageDays,
    };
  }
  if (bucket === "no_issue_logged") {
    return {
      queue_reason: "No issue movement is logged yet against the requested line quantity.",
      recommended_action: "start_issue",
      recommended_action_label: "Start issue",
      attention_level: "medium",
      age_days: ageDays,
    };
  }
  if (bucket === "return_logged") {
    return {
      queue_reason: `${money(row?.qty_returned || 0).toFixed(4)} is returned and the net line balance needs confirmation.`,
      recommended_action: "review_returns",
      recommended_action_label: "Review returns",
      attention_level: "low",
      age_days: ageDays,
    };
  }
  return {
    queue_reason: "Review the line-level material variance and take the next stores action.",
    recommended_action: "open_job",
    recommended_action_label: "Open job",
    attention_level: "low",
    age_days: ageDays,
  };
}

function buildCompletionDispatchReadinessMetadata(row) {
  const bucket = getCompletionDispatchReadinessBucket(row);
  const ageDays = getDaysSince(row?.receipt_last_movement_date || row?.finished_good_receipt_date || row?.job_date);
  const remainingQty = money(row?.qty_dispatch_remaining || 0);

  if (bucket === "awaiting_completion") {
    return {
      queue_reason: `Sales demand still has ${remainingQty.toFixed(4)} pending, but manufacturing completion is not yet in place.`,
      recommended_action: "complete_job",
      recommended_action_label: "Complete job",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "fg_not_received") {
    return {
      queue_reason: `Dispatch still needs ${remainingQty.toFixed(4)}, but FG receipt is not yet reflected into stock.`,
      recommended_action: "update_fg_receipt",
      recommended_action_label: "Update FG receipt",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "receipt_mismatch") {
    return {
      queue_reason: "FG receipt exists, but the quantity or date alignment still blocks dispatch readiness.",
      recommended_action: "review_fg_reconciliation",
      recommended_action_label: "Review FG reconciliation",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "stock_short") {
    return {
      queue_reason: `Dispatch still needs ${remainingQty.toFixed(4)}, but FG stock is not sufficient yet.`,
      recommended_action: "review_fg_stock",
      recommended_action_label: "Review FG stock",
      attention_level: "medium",
      age_days: ageDays,
    };
  }
  if (bucket === "ready_for_dispatch") {
    return {
      queue_reason: `FG is ready and ${remainingQty.toFixed(4)} can move into the dispatch flow.`,
      recommended_action: "prepare_dispatch",
      recommended_action_label: "Prepare dispatch",
      attention_level: "low",
      age_days: ageDays,
    };
  }
  return {
    queue_reason: "Review the job and dispatch readiness before the next fulfillment step.",
    recommended_action: "open_job",
    recommended_action_label: "Open job",
    attention_level: "low",
    age_days: ageDays,
  };
}

function buildPlanningReleaseMetadata(row) {
  const bucket = getPlanningReleaseBucket(row);
  const ageDays = getDaysSince(row?.order_date);
  const productionGapQty = money(row?.production_gap_qty || 0);

  if (bucket === "release_blocked_setup") {
    return {
      queue_reason: `Manufacturing demand of ${productionGapQty.toFixed(4)} is blocked because FG setup is incomplete.`,
      recommended_action: "complete_fg_setup",
      recommended_action_label: "Complete FG setup",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "ready_for_release") {
    return {
      queue_reason: `FG setup is ready and ${productionGapQty.toFixed(4)} is waiting to be released into a manufacturing job.`,
      recommended_action: "release_job",
      recommended_action_label: "Release job",
      attention_level: "medium",
      age_days: ageDays,
    };
  }
  if (bucket === "released_material_blocked") {
    return {
      queue_reason: `Job is already released, but ${money(row?.pending_issue_qty || 0).toFixed(4)} of raw material is still pending.`,
      recommended_action: "review_material_issue",
      recommended_action_label: "Review material issue",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "released_in_execution") {
    return {
      queue_reason: `Released manufacturing demand of ${productionGapQty.toFixed(4)} is already in execution and should be monitored forward.`,
      recommended_action: "monitor_execution",
      recommended_action_label: "Monitor execution",
      attention_level: "low",
      age_days: ageDays,
    };
  }
  return {
    queue_reason: "Review this manufacturing demand and take the next release step.",
    recommended_action: "open_so",
    recommended_action_label: "Open SO",
    attention_level: "low",
    age_days: ageDays,
  };
}

function buildPlanningCapacityMetadata(row) {
  const ageDays = getDaysSince(row?.job_date || row?.order_date);

  if (row?.row_type === "demand") {
    if (row?.capacity_flags?.setup_blocked) {
      return {
        queue_reason: `Estimated load of ${money(row?.estimated_hours || 0).toFixed(4)} hour(s) is blocked because FG setup is incomplete.`,
        recommended_action: "complete_fg_setup",
        recommended_action_label: "Complete FG setup",
        attention_level: "high",
        age_days: ageDays,
      };
    }
    if (row?.capacity_flags?.ready_for_release) {
      return {
        queue_reason: `Estimated load of ${money(row?.estimated_hours || 0).toFixed(4)} hour(s) is ready for manufacturing release.`,
        recommended_action: "release_job",
        recommended_action_label: "Release job",
        attention_level: "medium",
        age_days: ageDays,
      };
    }
  } else {
    if (row?.capacity_flags?.overdue) {
      return {
        queue_reason: `Job is overdue with ${money(row?.estimated_hours || 0).toFixed(4)} estimated hour(s) still open.`,
        recommended_action: "clear_overdue_job",
        recommended_action_label: "Clear overdue job",
        attention_level: "high",
        age_days: ageDays,
      };
    }
    if (row?.capacity_flags?.due_7d) {
      return {
        queue_reason: `Job is due within 7 days and still carries ${money(row?.estimated_hours || 0).toFixed(4)} estimated hour(s).`,
        recommended_action: "plan_this_week",
        recommended_action_label: "Plan this week",
        attention_level: "medium",
        age_days: ageDays,
      };
    }
    if (row?.capacity_flags?.unassigned_department) {
      return {
        queue_reason: `Job still has ${money(row?.estimated_hours || 0).toFixed(4)} estimated hour(s) remaining without a department assignment.`,
        recommended_action: "assign_department",
        recommended_action_label: "Assign department",
        attention_level: "high",
        age_days: ageDays,
      };
    }
    if (row?.capacity_flags?.future) {
      return {
        queue_reason: `Future manufacturing backlog of ${money(row?.estimated_hours || 0).toFixed(4)} estimated hour(s) should be reviewed for load balancing.`,
        recommended_action: "review_future_load",
        recommended_action_label: "Review future load",
        attention_level: "low",
        age_days: ageDays,
      };
    }
  }

  return {
    queue_reason: "Review manufacturing load and take the next planning action.",
    recommended_action: row?.row_type === "demand" ? "open_so" : "open_job",
    recommended_action_label: row?.row_type === "demand" ? "Open SO" : "Open job",
    attention_level: "low",
    age_days: ageDays,
  };
}

function buildProductionCostMetadata(row) {
  const bucket = getProductionCostBucket(row);
  const ageDays = getDaysSince(row?.last_movement_date || row?.job_date || row?.updated_at);

  if (bucket === "issued_no_output") {
    return {
      queue_reason: `Material worth ${money(row?.material_actual_value || 0).toFixed(4)} is already issued, but no output is booked yet.`,
      recommended_action: "review_output_posting",
      recommended_action_label: "Review output posting",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "over_issue_vs_bom") {
    return {
      queue_reason: `Material issue exceeds BOM expectation by ${money(row?.material_variance_output || 0).toFixed(4)} for the current output.`,
      recommended_action: "review_over_issue",
      recommended_action_label: "Review over-issue",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "under_issue_vs_bom") {
    return {
      queue_reason: `Material issue is below BOM expectation by ${Math.abs(money(row?.material_variance_output || 0)).toFixed(4)} for the recorded output.`,
      recommended_action: "review_under_issue",
      recommended_action_label: "Review under-issue",
      attention_level: "medium",
      age_days: ageDays,
    };
  }
  if (bucket === "stalled_wip_value") {
    return {
      queue_reason: `Open WIP of ${money(row?.total_absorbed_value || 0).toFixed(4)} is stale and has not moved for ${ageDays ?? 0} day(s).`,
      recommended_action: "review_stalled_wip",
      recommended_action_label: "Review stalled WIP",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "margin_at_risk") {
    return {
      queue_reason: `Absorbed manufacturing cost is already eroding margin by ${Math.abs(money(row?.margin_vs_sales_order || 0)).toFixed(4)} against the sales order value.`,
      recommended_action: "review_margin_risk",
      recommended_action_label: "Review margin risk",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  if (bucket === "ready_cost_review") {
    return {
      queue_reason: "Job is complete and ready for cost absorption review.",
      recommended_action: "review_job_cost",
      recommended_action_label: "Review job cost",
      attention_level: "low",
      age_days: ageDays,
    };
  }
  return {
    queue_reason: "Review the production cost position for this job.",
    recommended_action: "open_job",
    recommended_action_label: "Open job",
    attention_level: "low",
    age_days: ageDays,
  };
}

function buildStoresPendingIssueMetadata(row) {
  const ageDays = getDaysSince(row?.last_movement_date || row?.job_date);
  if (Number(row?.low_stock_line_count || 0) > 0) {
    return {
      queue_reason: `${money(row?.pending_issue_qty || 0).toFixed(4)} is pending across ${Number(row?.pending_line_count || 0)} line(s), with low stock on ${Number(row?.low_stock_line_count || 0)} line(s).`,
      recommended_action: "review_shortage",
      recommended_action_label: "Review shortage",
      attention_level: "high",
      age_days: ageDays,
    };
  }
  return {
    queue_reason: `${money(row?.pending_issue_qty || 0).toFixed(4)} is ready for issue across ${Number(row?.pending_line_count || 0)} pending line(s).`,
    recommended_action: "quick_issue",
    recommended_action_label: "Quick issue",
    attention_level: "medium",
    age_days: ageDays,
  };
}

function buildMaterialReadinessFgMetadata(row) {
  const status = String(row?.readiness_status || "").toLowerCase();
  let queueReason = row?.readiness_note || "Manufacturing setup needs review.";
  let recommendedAction = "review_fg_setup";
  let recommendedActionLabel = "Review FG setup";
  let attentionLevel = "medium";

  if (status === "missing_fg_flag") {
    queueReason = "Product is being treated as a manufacturing FG candidate but is not marked as manufactured in Product Master.";
    recommendedAction = "mark_manufactured_fg";
    recommendedActionLabel = "Mark manufactured FG";
    attentionLevel = "high";
  } else if (status === "missing_prefix") {
    queueReason = "Manufacturing JobID prefix is missing for this FG, so new jobs cannot be numbered correctly.";
    recommendedAction = "set_job_prefix";
    recommendedActionLabel = "Set JobID prefix";
    attentionLevel = "high";
  } else if (status === "missing_active_bom" || status === "empty_bom") {
    queueReason =
      Number(row?.jobs_pending_material || 0) > 0
        ? `FG setup is incomplete while ${Number(row?.jobs_pending_material || 0)} open job(s) are already waiting on this FG.`
        : "FG setup is incomplete because the active BOM is missing or has no component lines.";
    recommendedAction = "complete_bom_setup";
    recommendedActionLabel = "Complete BOM setup";
    attentionLevel = "high";
  }

  return {
    queue_reason: queueReason,
    recommended_action: recommendedAction,
    recommended_action_label: recommendedActionLabel,
    attention_level: attentionLevel,
  };
}

function sameDateKey(a, b) {
  if (!a || !b) return false;
  const aKey = new Date(a);
  const bKey = new Date(b);
  if (Number.isNaN(aKey.getTime()) || Number.isNaN(bKey.getTime())) return false;
  return aKey.toISOString().slice(0, 10) === bKey.toISOString().slice(0, 10);
}

function getFgReceiptReconciliationBucket(row) {
  if (row?.fg_receipt_flags?.receipt_not_reflected) return "receipt_not_reflected";
  if (row?.fg_receipt_flags?.receipt_qty_mismatch) return "receipt_qty_mismatch";
  if (row?.fg_receipt_flags?.receipt_date_mismatch) return "receipt_date_mismatch";
  if (row?.fg_receipt_flags?.premature_receipt) return "premature_receipt";
  if (row?.fg_receipt_flags?.final_without_output) return "final_without_output";
  if (row?.fg_receipt_flags?.awaiting_final_post) return "awaiting_final_post";
  return "other";
}

function matchesFgReceiptReconciliationBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getFgReceiptReconciliationBucket(row) !== "other";
  return getFgReceiptReconciliationBucket(row) === key;
}

function getFgReceiptReconciliationRank(row) {
  const bucket = getFgReceiptReconciliationBucket(row);
  if (bucket === "receipt_not_reflected") return 0;
  if (bucket === "receipt_qty_mismatch") return 1;
  if (bucket === "receipt_date_mismatch") return 2;
  if (bucket === "premature_receipt") return 3;
  if (bucket === "final_without_output") return 4;
  if (bucket === "awaiting_final_post") return 5;
  return 6;
}

function getConsumptionVarianceBucket(row) {
  if (row?.variance_flags?.consumed_without_issue) return "consumed_without_issue";
  if (row?.variance_flags?.low_stock_blocked) return "low_stock_blocked";
  if (row?.variance_flags?.pending_issue) return "pending_issue";
  if (row?.variance_flags?.issued_not_consumed) return "issued_not_consumed";
  if (row?.variance_flags?.no_issue_logged) return "no_issue_logged";
  if (row?.variance_flags?.return_logged) return "return_logged";
  return "other";
}

function matchesConsumptionVarianceBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getConsumptionVarianceBucket(row) !== "other";
  return getConsumptionVarianceBucket(row) === key;
}

function getConsumptionVarianceRank(row) {
  const bucket = getConsumptionVarianceBucket(row);
  if (bucket === "consumed_without_issue") return 0;
  if (bucket === "low_stock_blocked") return 1;
  if (bucket === "pending_issue") return 2;
  if (bucket === "issued_not_consumed") return 3;
  if (bucket === "no_issue_logged") return 4;
  if (bucket === "return_logged") return 5;
  return 6;
}

function getCompletionDispatchReadinessBucket(row) {
  if (qty(row?.qty_dispatch_remaining) <= 0) return "other";
  if (row?.dispatch_readiness_flags?.awaiting_completion) return "awaiting_completion";
  if (row?.dispatch_readiness_flags?.fg_not_received) return "fg_not_received";
  if (row?.dispatch_readiness_flags?.receipt_mismatch) return "receipt_mismatch";
  if (row?.dispatch_readiness_flags?.stock_short) return "stock_short";
  if (row?.dispatch_readiness_flags?.ready_for_dispatch) return "ready_for_dispatch";
  return "other";
}

function matchesCompletionDispatchReadinessBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getCompletionDispatchReadinessBucket(row) !== "other";
  return getCompletionDispatchReadinessBucket(row) === key;
}

function getCompletionDispatchReadinessRank(row) {
  const bucket = getCompletionDispatchReadinessBucket(row);
  if (bucket === "awaiting_completion") return 0;
  if (bucket === "fg_not_received") return 1;
  if (bucket === "receipt_mismatch") return 2;
  if (bucket === "stock_short") return 3;
  if (bucket === "ready_for_dispatch") return 4;
  return 5;
}

function getPlanningReleaseBucket(row) {
  if (row?.release_flags?.release_blocked_setup) return "release_blocked_setup";
  if (row?.release_flags?.ready_for_release) return "ready_for_release";
  if (row?.release_flags?.released_material_blocked) return "released_material_blocked";
  if (row?.release_flags?.released_in_execution) return "released_in_execution";
  return "other";
}

function matchesPlanningReleaseBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getPlanningReleaseBucket(row) !== "other";
  return getPlanningReleaseBucket(row) === key;
}

function getPlanningReleaseRank(row) {
  const bucket = getPlanningReleaseBucket(row);
  if (bucket === "release_blocked_setup") return 0;
  if (bucket === "ready_for_release") return 1;
  if (bucket === "released_material_blocked") return 2;
  if (bucket === "released_in_execution") return 3;
  return 4;
}

async function queryManufacturingAuditBaseRows(client, req, { status = "all", mode = "all", q = "", limit = 400 } = {}) {
  const params = [];
  const filters = [`jc.job_type = 'manufacturing'`];
  const activeCompanyId = getActiveCompanyId(req);
  if (activeCompanyId) {
    params.push(Number(activeCompanyId));
    filters.push(`jc.company_id = $${params.length}`);
  }
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    filters.push(`jc.created_by = $${params.length}`);
  }
  if (status !== "all") {
    params.push(String(status).toLowerCase());
    filters.push(`lower(coalesce(jc.job_status, 'draft')) = $${params.length}`);
  }
  if (mode === "so_linked") filters.push(`jc.sales_order_line_id is not null`);
  if (mode === "standalone") filters.push(`jc.sales_order_line_id is null`);
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      jc.job_card_number ilike $${idx}
      or coalesce(jc.job_id, '') ilike $${idx}
      or coalesce(so.so_number, '') ilike $${idx}
      or coalesce(c.customer_name, '') ilike $${idx}
      or coalesce(fg.item_code, '') ilike $${idx}
      or coalesce(fg.item_name, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 400, 1), 5000);
  const r = await client.query(
    `
      select
        jc.id,
        jc.job_card_number,
        jc.job_id,
        jc.job_status,
        jc.job_date,
        jc.finished_good_product_id,
        jc.bom_id,
        jc.sales_order_line_id,
        jc.finished_good_receipt_date,
        jc.planned_output_qty,
        jc.actual_output_qty,
        so.so_number,
        so.order_date as sales_order_date,
        c.customer_name,
        fg.item_code as finished_good_item_code,
        fg.item_name as finished_good_item_name,
        stats.total_requested_qty,
        stats.issue_qty as total_issued_qty,
        stats.return_qty as total_returned_qty,
        stats.pending_issue_qty,
        stats.pending_line_count,
        stats.low_stock_line_count,
        coalesce((select count(*) from job_card_movements where job_card_id = jc.id), 0)::int as movement_count,
        (select max(movement_date) from job_card_movements where job_card_id = jc.id) as last_movement_date
      from job_cards jc
      left join sales_orders so on so.id = jc.sales_order_id
      left join customers c on c.id = so.customer_id
      left join products fg on fg.id = jc.finished_good_product_id
      left join lateral (
        select
          coalesce(sum(jcl.qty_requested), 0) as total_requested_qty,
          coalesce(sum(coalesce(issue_stats.issue_qty, 0)), 0) as issue_qty,
          coalesce(sum(coalesce(return_stats.return_qty, 0)), 0) as return_qty,
          coalesce(sum(greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0)), 0) as pending_issue_qty,
          coalesce(sum(case when greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0) > 0 then 1 else 0 end), 0)::int as pending_line_count,
          coalesce(sum(case when coalesce(sb.stock_qty, 0) < greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0) then 1 else 0 end), 0)::int as low_stock_line_count
        from job_card_lines jcl
        left join lateral (
          select coalesce(sum(qty), 0) as issue_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'issue'
        ) issue_stats on true
        left join lateral (
          select coalesce(sum(qty), 0) as return_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'return'
        ) return_stats on true
        left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jcl.product_id
        where jcl.job_card_id = jc.id
      ) stats on true
      ${where}
      order by coalesce(jc.finished_good_receipt_date, jc.job_date, jc.created_at::date) desc, jc.id desc
      limit ${safeLimit}
    `,
    params
  );
  return r.rows.map((row) => enrichManufacturingAuditRow(row));
}

async function getManufacturingAuditRows(client, req, { status = "all", mode = "all", q = "", exception = "all" } = {}) {
  const baseRows = await queryManufacturingAuditBaseRows(client, req, { status, mode, q, limit: 400 });
  const rows = baseRows.filter((row) => matchesManufacturingAuditException(row, exception));
  return {
    rows,
    summary: {
      total: rows.length,
      scopeTotal: baseRows.length,
      open: rows.filter((row) => ["draft", "submitted", "approved", "open"].includes(String(row.job_status || "").toLowerCase())).length,
      postedOrClosed: rows.filter((row) => ["closed", "posted"].includes(String(row.job_status || "").toLowerCase())).length,
      soLinked: rows.filter((row) => row.manufacturing_mode === "so_linked").length,
      standalone: rows.filter((row) => row.manufacturing_mode === "standalone").length,
      withOutput: rows.filter((row) => qty(row.actual_output_qty) > 0).length,
      exceptionCounts: {
        attention: baseRows.filter((row) => row.audit_flags?.attention).length,
        ready: baseRows.filter((row) => row.audit_flags?.ready_to_close_post).length,
        final_risk: baseRows.filter((row) => row.audit_flags?.final_status_risk).length,
        missing_output: baseRows.filter((row) => row.audit_flags?.missing_output).length,
        missing_receipt: baseRows.filter((row) => row.audit_flags?.missing_receipt_date).length,
        missing_bom: baseRows.filter((row) => row.audit_flags?.missing_bom).length,
        no_movements: baseRows.filter((row) => row.audit_flags?.no_movements).length,
        pending_issue: baseRows.filter((row) => row.audit_flags?.pending_issue).length,
        low_stock: baseRows.filter((row) => row.audit_flags?.low_stock).length,
      },
    },
  };
}

async function getManufacturingAuditIds(client, req, { status = "all", mode = "all", q = "", exception = "all", limit = 5000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 5000);
  const rows = await queryManufacturingAuditBaseRows(client, req, { status, mode, q, limit: safeLimit });
  const filtered = rows.filter((row) => matchesManufacturingAuditException(row, exception));
  return {
    ids: filtered.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0),
    limited: rows.length >= safeLimit,
  };
}

async function getProductionExecutionSummary(client, req, { q = "" } = {}) {
  const baseRows = await queryManufacturingAuditBaseRows(client, req, { status: "all", mode: "all", q, limit: 600 });
  const openRows = baseRows.filter((row) => ["draft", "submitted", "approved", "open"].includes(String(row.job_status || "").toLowerCase()));
  const finalRows = baseRows.filter((row) => ["closed", "posted"].includes(String(row.job_status || "").toLowerCase()));
  return {
    totalManufacturingJobs: baseRows.length,
    openJobs: openRows.length,
    finalJobs: finalRows.length,
    readyToClose: openRows.filter((row) => row.audit_flags?.ready_to_close_post).length,
    outputPendingClose: openRows.filter((row) => qty(row.actual_output_qty) > 0).length,
    receiptMissing: openRows.filter((row) => row.audit_flags?.missing_receipt_date).length,
    stalledWip: openRows.filter((row) => row.audit_flags?.no_movements).length,
    pendingRm: openRows.filter((row) => row.audit_flags?.pending_issue).length,
    lowStock: openRows.filter((row) => row.audit_flags?.low_stock).length,
    finalStatusRisk: finalRows.filter((row) => row.audit_flags?.final_status_risk).length,
    withOutput: baseRows.filter((row) => qty(row.actual_output_qty) > 0).length,
    outputQtyInOpenJobs: money(openRows.reduce((sum, row) => sum + money(row.actual_output_qty || 0), 0)),
  };
}

async function getProductionExecutionQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const baseRows = await queryManufacturingAuditBaseRows(client, req, { status: "all", mode: "all", q, limit: 600 });
  const rows = baseRows
    .map((row) => ({
      ...row,
      execution_bucket: getProductionExecutionBucket(row),
      ...buildProductionExecutionMetadata(row),
    }))
    .filter((row) => matchesProductionExecutionBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getProductionExecutionRank(a) - getProductionExecutionRank(b);
      if (rankDiff !== 0) return rankDiff;
      const outputDiff = money(b.actual_output_qty || 0) - money(a.actual_output_qty || 0);
      if (outputDiff !== 0) return outputDiff;
      const pendingDiff = money(b.pending_issue_qty || 0) - money(a.pending_issue_qty || 0);
      if (pendingDiff !== 0) return pendingDiff;
      const lastMoveA = a.last_movement_date ? new Date(a.last_movement_date).getTime() : 0;
      const lastMoveB = b.last_movement_date ? new Date(b.last_movement_date).getTime() : 0;
      return lastMoveA - lastMoveB;
    });
  return rows.slice(0, normalizeLimit(limit, 80, 200));
}

async function queryFgReceiptReconciliationRows(client, req, { q = "", limit = 500 } = {}) {
  const companyId = getActiveCompanyId(req);
  if (!companyId) return [];
  const baseRows = await queryManufacturingAuditBaseRows(client, req, { status: "all", mode: "all", q, limit });
  const jobCardIds = baseRows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
  const fgProductIds = Array.from(
    new Set(baseRows.map((row) => Number(row.finished_good_product_id)).filter((id) => Number.isFinite(id) && id > 0))
  );

  const receiptMap = new Map();
  if (jobCardIds.length) {
    const receiptRes = await client.query(
      `
        select
          sm.ref_id as job_card_id,
          count(*)::int as receipt_movement_count,
          coalesce(sum(sm.qty_signed), 0) as receipt_posted_qty,
          max(sm.movement_date) as receipt_last_movement_date
        from stock_movements sm
        where sm.company_id = $1
          and sm.ref_type = 'MANUFACTURING_RECEIPT'
          and sm.ref_id = any($2::int[])
        group by sm.ref_id
      `,
      [Number(companyId), jobCardIds]
    );
    for (const row of receiptRes.rows) {
      receiptMap.set(Number(row.job_card_id), row);
    }
  }

  const stockQtyMap = new Map();
  if (fgProductIds.length) {
    const stockRes = await client.query(
      `
        select product_id, stock_qty
        from stock_balances
        where company_id = $1
          and product_id = any($2::int[])
      `,
      [Number(companyId), fgProductIds]
    );
    for (const row of stockRes.rows) {
      stockQtyMap.set(Number(row.product_id), money(row.stock_qty || 0));
    }
  }

  return baseRows.map((row) => {
    const status = String(row.job_status || "").toLowerCase();
    const isFinalStatus = ["closed", "posted"].includes(status);
    const actualOutputQty = money(row.actual_output_qty || 0);
    const receiptMovement = receiptMap.get(Number(row.id)) || null;
    const receiptPostedQty = money(receiptMovement?.receipt_posted_qty || 0);
    const receiptMovementCount = Number(receiptMovement?.receipt_movement_count || 0);
    const receiptLastMovementDate = receiptMovement?.receipt_last_movement_date || null;
    const fgStockQty = money(stockQtyMap.get(Number(row.finished_good_product_id)) || 0);
    const receiptQtyGap = money(actualOutputQty - receiptPostedQty);
    const hasPostedReceipt = receiptMovementCount > 0 && receiptPostedQty > 0;
    const awaitingFinalPost = !isFinalStatus && actualOutputQty > 0;
    const receiptNotReflected = isFinalStatus && actualOutputQty > 0 && !hasPostedReceipt;
    const receiptQtyMismatch = isFinalStatus && actualOutputQty > 0 && hasPostedReceipt && Math.abs(receiptQtyGap) > 0.0001;
    const receiptDateMismatch =
      isFinalStatus &&
      actualOutputQty > 0 &&
      hasPostedReceipt &&
      Boolean(row.finished_good_receipt_date) &&
      !sameDateKey(row.finished_good_receipt_date, receiptLastMovementDate);
    const prematureReceipt = !isFinalStatus && hasPostedReceipt;
    const finalWithoutOutput = isFinalStatus && actualOutputQty <= 0;
    const reconciled =
      isFinalStatus &&
      actualOutputQty > 0 &&
      hasPostedReceipt &&
      Math.abs(receiptQtyGap) <= 0.0001 &&
      (!row.finished_good_receipt_date || sameDateKey(row.finished_good_receipt_date, receiptLastMovementDate));
    const labels = [];
    if (receiptNotReflected) labels.push("Receipt Not Reflected");
    if (receiptQtyMismatch) labels.push("Receipt Qty Mismatch");
    if (receiptDateMismatch) labels.push("Receipt Date Mismatch");
    if (prematureReceipt) labels.push("Premature Receipt");
    if (finalWithoutOutput) labels.push("Final Without Output");
    if (awaitingFinalPost) labels.push("Awaiting Final Post");
    if (reconciled) labels.push("Reconciled");
    return {
      ...row,
      fg_stock_qty: fgStockQty,
      receipt_posted_qty: receiptPostedQty,
      receipt_movement_count: receiptMovementCount,
      receipt_last_movement_date: receiptLastMovementDate,
      receipt_qty_gap: receiptQtyGap,
      fg_receipt_flags: {
        awaiting_final_post: awaitingFinalPost,
        receipt_not_reflected: receiptNotReflected,
        receipt_qty_mismatch: receiptQtyMismatch,
        receipt_date_mismatch: receiptDateMismatch,
        premature_receipt: prematureReceipt,
        final_without_output: finalWithoutOutput,
        reconciled,
      },
      fg_receipt_labels: labels,
    };
  });
}

async function getFgReceiptReconciliationSummary(client, req, { q = "" } = {}) {
  const rows = await queryFgReceiptReconciliationRows(client, req, { q, limit: 600 });
  return {
    totalManufacturingJobs: rows.length,
    awaitingFinalPost: rows.filter((row) => row.fg_receipt_flags?.awaiting_final_post).length,
    receiptNotReflected: rows.filter((row) => row.fg_receipt_flags?.receipt_not_reflected).length,
    receiptQtyMismatch: rows.filter((row) => row.fg_receipt_flags?.receipt_qty_mismatch).length,
    receiptDateMismatch: rows.filter((row) => row.fg_receipt_flags?.receipt_date_mismatch).length,
    prematureReceipt: rows.filter((row) => row.fg_receipt_flags?.premature_receipt).length,
    finalWithoutOutput: rows.filter((row) => row.fg_receipt_flags?.final_without_output).length,
    reconciled: rows.filter((row) => row.fg_receipt_flags?.reconciled).length,
    openOutputQty: money(
      rows.filter((row) => row.fg_receipt_flags?.awaiting_final_post).reduce((sum, row) => sum + money(row.actual_output_qty || 0), 0)
    ),
    postedReceiptQty: money(rows.reduce((sum, row) => sum + money(row.receipt_posted_qty || 0), 0)),
  };
}

async function getFgReceiptReconciliationQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryFgReceiptReconciliationRows(client, req, { q, limit: 600 });
  return rows
    .map((row) => ({
      ...row,
      ...buildFgReceiptReconciliationMetadata(row),
    }))
    .filter((row) => matchesFgReceiptReconciliationBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getFgReceiptReconciliationRank(a) - getFgReceiptReconciliationRank(b);
      if (rankDiff !== 0) return rankDiff;
      const gapDiff = Math.abs(money(b.receipt_qty_gap || 0)) - Math.abs(money(a.receipt_qty_gap || 0));
      if (gapDiff !== 0) return gapDiff;
      const outputDiff = money(b.actual_output_qty || 0) - money(a.actual_output_qty || 0);
      if (outputDiff !== 0) return outputDiff;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

async function queryConsumptionVarianceRows(client, req, { q = "", limit = 600 } = {}) {
  const params = [];
  const filters = [
    `jc.job_type = 'manufacturing'`,
    `lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')`,
  ];
  const activeCompanyId = getActiveCompanyId(req);
  if (activeCompanyId) {
    params.push(Number(activeCompanyId));
    filters.push(`jc.company_id = $${params.length}`);
  }
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    filters.push(`jc.created_by = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      jc.job_card_number ilike $${idx}
      or coalesce(jc.job_id, '') ilike $${idx}
      or coalesce(so.so_number, '') ilike $${idx}
      or coalesce(c.customer_name, '') ilike $${idx}
      or coalesce(fg.item_code, '') ilike $${idx}
      or coalesce(fg.item_name, '') ilike $${idx}
      or coalesce(jcl.item_code, '') ilike $${idx}
      or coalesce(jcl.item_name, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);
  const r = await client.query(
    `
      select
        jc.id as job_card_id,
        jc.job_card_number,
        jc.job_id,
        jc.job_status,
        jc.job_date,
        jc.sales_order_line_id,
        jc.actual_output_qty,
        so.so_number,
        c.customer_name,
        fg.item_code as finished_good_item_code,
        fg.item_name as finished_good_item_name,
        jcl.id as job_card_line_id,
        jcl.line_no,
        jcl.product_id,
        jcl.item_code,
        jcl.item_name,
        jcl.uom,
        jcl.qty_requested,
        jcl.qty_consumed,
        coalesce(issue_stats.issue_qty, 0) as qty_issued,
        coalesce(return_stats.return_qty, 0) as qty_returned,
        coalesce(sb.stock_qty, 0) as current_stock_qty,
        (select max(movement_date) from job_card_movements where job_card_line_id = jcl.id) as last_line_movement_date
      from job_cards jc
      join job_card_lines jcl on jcl.job_card_id = jc.id
      left join sales_orders so on so.id = jc.sales_order_id
      left join customers c on c.id = so.customer_id
      left join products fg on fg.id = jc.finished_good_product_id
      left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jcl.product_id
      left join lateral (
        select coalesce(sum(qty), 0) as issue_qty
        from job_card_movements
        where job_card_line_id = jcl.id and movement_type = 'issue'
      ) issue_stats on true
      left join lateral (
        select coalesce(sum(qty), 0) as return_qty
        from job_card_movements
        where job_card_line_id = jcl.id and movement_type = 'return'
      ) return_stats on true
      ${where}
      order by coalesce(jc.job_date, jc.created_at::date) desc, jc.id desc, jcl.line_no asc
      limit ${safeLimit}
    `,
    params
  );

  return r.rows.map((row) => {
    const qtyRequested = money(row.qty_requested || 0);
    const qtyConsumed = money(row.qty_consumed || 0);
    const qtyIssued = money(row.qty_issued || 0);
    const qtyReturned = money(row.qty_returned || 0);
    const netIssuedQty = money(qtyIssued - qtyReturned);
    const pendingIssueQty = money(Math.max(qtyRequested - netIssuedQty, 0));
    const issuedNotConsumedQty = money(Math.max(netIssuedQty - qtyConsumed, 0));
    const consumedWithoutIssueQty = money(Math.max(qtyConsumed - netIssuedQty, 0));
    const overRequestedQty = money(Math.max(netIssuedQty - qtyRequested, 0));
    const noIssueLogged = qtyRequested > 0 && qtyIssued <= 0 && qtyConsumed <= 0;
    const lowStockBlocked = pendingIssueQty > 0 && money(row.current_stock_qty || 0) < pendingIssueQty;
    const pendingIssue = pendingIssueQty > 0 && !lowStockBlocked;
    const issuedNotConsumed = issuedNotConsumedQty > 0.0001;
    const consumedWithoutIssue = consumedWithoutIssueQty > 0.0001;
    const returnLogged = qtyReturned > 0;
    const varianceLabels = [];
    if (consumedWithoutIssue) varianceLabels.push("Consumed > Net Issued");
    if (lowStockBlocked) varianceLabels.push("Low Stock Block");
    if (pendingIssue) varianceLabels.push("Pending Issue");
    if (issuedNotConsumed) varianceLabels.push("Issued Not Consumed");
    if (noIssueLogged) varianceLabels.push("No Issue Logged");
    if (returnLogged) varianceLabels.push("Return Logged");
    if (overRequestedQty > 0.0001) varianceLabels.push("Net Issue > Requested");
    return {
      ...row,
      manufacturing_mode: row.sales_order_line_id ? "so_linked" : "standalone",
      net_issued_qty: netIssuedQty,
      pending_issue_qty: pendingIssueQty,
      issued_not_consumed_qty: issuedNotConsumedQty,
      consumed_without_issue_qty: consumedWithoutIssueQty,
      over_requested_qty: overRequestedQty,
      variance_flags: {
        low_stock_blocked: lowStockBlocked,
        pending_issue: pendingIssue,
        issued_not_consumed: issuedNotConsumed,
        consumed_without_issue: consumedWithoutIssue,
        no_issue_logged: noIssueLogged,
        return_logged: returnLogged,
      },
      variance_labels: varianceLabels,
    };
  });
}

async function getConsumptionVarianceSummary(client, req, { q = "" } = {}) {
  const rows = await queryConsumptionVarianceRows(client, req, { q, limit: 800 });
  const activeRows = rows.filter((row) => getConsumptionVarianceBucket(row) !== "other");
  return {
    totalLines: rows.length,
    activeSignals: activeRows.length,
    lowStockBlocked: rows.filter((row) => row.variance_flags?.low_stock_blocked).length,
    pendingIssue: rows.filter((row) => row.variance_flags?.pending_issue).length,
    issuedNotConsumed: rows.filter((row) => row.variance_flags?.issued_not_consumed).length,
    consumedWithoutIssue: rows.filter((row) => row.variance_flags?.consumed_without_issue).length,
    noIssueLogged: rows.filter((row) => row.variance_flags?.no_issue_logged).length,
    returnLogged: rows.filter((row) => row.variance_flags?.return_logged).length,
    pendingIssueQty: money(rows.reduce((sum, row) => sum + money(row.pending_issue_qty || 0), 0)),
    issuedNotConsumedQty: money(rows.reduce((sum, row) => sum + money(row.issued_not_consumed_qty || 0), 0)),
    consumedWithoutIssueQty: money(rows.reduce((sum, row) => sum + money(row.consumed_without_issue_qty || 0), 0)),
    returnedQty: money(rows.reduce((sum, row) => sum + money(row.qty_returned || 0), 0)),
  };
}

async function getConsumptionVarianceQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryConsumptionVarianceRows(client, req, { q, limit: 800 });
  return rows
    .map((row) => ({
      ...row,
      ...buildConsumptionVarianceMetadata(row),
    }))
    .filter((row) => matchesConsumptionVarianceBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getConsumptionVarianceRank(a) - getConsumptionVarianceRank(b);
      if (rankDiff !== 0) return rankDiff;
      const severityA =
        money(a.consumed_without_issue_qty || 0) +
        money(a.pending_issue_qty || 0) +
        money(a.issued_not_consumed_qty || 0) +
        money(a.qty_returned || 0);
      const severityB =
        money(b.consumed_without_issue_qty || 0) +
        money(b.pending_issue_qty || 0) +
        money(b.issued_not_consumed_qty || 0) +
        money(b.qty_returned || 0);
      if (severityB !== severityA) return severityB - severityA;
      return Number(b.job_card_id || 0) - Number(a.job_card_id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

async function queryCompletionDispatchReadinessRows(client, req, { q = "", limit = 600 } = {}) {
  const fgRows = await queryFgReceiptReconciliationRows(client, req, { q, limit });
  const soLinkedRows = fgRows.filter((row) => Number(row.sales_order_line_id || 0) > 0);
  const salesOrderLineIds = Array.from(
    new Set(soLinkedRows.map((row) => Number(row.sales_order_line_id)).filter((id) => Number.isFinite(id) && id > 0))
  );

  const dispatchQtyMap = new Map();
  if (salesOrderLineIds.length) {
    const dispatchRes = await client.query(
      `
        select
          dl.sales_order_line_id,
          coalesce(sum(dl.qty_dispatch), 0) as qty_dispatched
        from dispatch_lines dl
        join dispatches d on d.id = dl.dispatch_id
        where d.dispatch_status <> 'cancelled'
          and dl.sales_order_line_id = any($1::int[])
        group by dl.sales_order_line_id
      `,
      [salesOrderLineIds]
    );
    for (const row of dispatchRes.rows) {
      dispatchQtyMap.set(Number(row.sales_order_line_id), money(row.qty_dispatched || 0));
    }
  }

  const salesOrderLineMetaMap = new Map();
  if (salesOrderLineIds.length) {
    const solRes = await client.query(
      `
        select
          sol.id,
          sol.sales_order_id,
          sol.qty as qty_ordered,
          sol.line_no as sales_order_line_no
        from sales_order_lines sol
        where sol.id = any($1::int[])
      `,
      [salesOrderLineIds]
    );
    for (const row of solRes.rows) {
      salesOrderLineMetaMap.set(Number(row.id), row);
    }
  }

  return soLinkedRows.map((row) => {
    const salesLine = salesOrderLineMetaMap.get(Number(row.sales_order_line_id)) || null;
    const qtyOrdered = money(salesLine?.qty_ordered || 0);
    const qtyDispatched = money(dispatchQtyMap.get(Number(row.sales_order_line_id)) || 0);
    const qtyDispatchRemaining = money(Math.max(qtyOrdered - qtyDispatched, 0));
    const fgStockQty = money(row.fg_stock_qty || 0);
    const actualOutputQty = money(row.actual_output_qty || 0);
    const awaitingCompletion = actualOutputQty <= 0 || ["draft", "submitted", "approved", "open"].includes(String(row.job_status || "").toLowerCase());
    const fgNotReceived =
      qtyDispatchRemaining > 0 &&
      (row.fg_receipt_flags?.awaiting_final_post === true || row.fg_receipt_flags?.receipt_not_reflected === true);
    const receiptMismatch =
      qtyDispatchRemaining > 0 &&
      (row.fg_receipt_flags?.receipt_qty_mismatch === true ||
        row.fg_receipt_flags?.receipt_date_mismatch === true ||
        row.fg_receipt_flags?.final_without_output === true);
    const stockShort = qtyDispatchRemaining > 0 && !fgNotReceived && !receiptMismatch && fgStockQty + 0.0001 < qtyDispatchRemaining;
    const readyForDispatch =
      qtyDispatchRemaining > 0 &&
      row.fg_receipt_flags?.reconciled === true &&
      fgStockQty + 0.0001 >= qtyDispatchRemaining;
    const readinessLabels = [];
    if (awaitingCompletion) readinessLabels.push("Awaiting Completion");
    if (fgNotReceived) readinessLabels.push("FG Not Received");
    if (receiptMismatch) readinessLabels.push("Receipt Mismatch");
    if (stockShort) readinessLabels.push("FG Stock Short");
    if (readyForDispatch) readinessLabels.push("Ready for Dispatch");
    return {
      ...row,
      sales_order_id: Number(salesLine?.sales_order_id || row.sales_order_id || 0) || null,
      sales_order_line_no: Number(salesLine?.sales_order_line_no || 0) || null,
      qty_ordered: qtyOrdered,
      qty_dispatched: qtyDispatched,
      qty_dispatch_remaining: qtyDispatchRemaining,
      dispatch_readiness_flags: {
        awaiting_completion: awaitingCompletion && qtyDispatchRemaining > 0,
        fg_not_received: fgNotReceived,
        receipt_mismatch: receiptMismatch,
        stock_short: stockShort,
        ready_for_dispatch: readyForDispatch,
      },
      dispatch_readiness_labels: readinessLabels,
    };
  });
}

async function getCompletionDispatchReadinessSummary(client, req, { q = "" } = {}) {
  const rows = await queryCompletionDispatchReadinessRows(client, req, { q, limit: 700 });
  const actionable = rows.filter((row) => getCompletionDispatchReadinessBucket(row) !== "other");
  return {
    soLinkedJobs: rows.length,
    actionableJobs: actionable.length,
    awaitingCompletion: rows.filter((row) => row.dispatch_readiness_flags?.awaiting_completion).length,
    fgNotReceived: rows.filter((row) => row.dispatch_readiness_flags?.fg_not_received).length,
    receiptMismatch: rows.filter((row) => row.dispatch_readiness_flags?.receipt_mismatch).length,
    stockShort: rows.filter((row) => row.dispatch_readiness_flags?.stock_short).length,
    readyForDispatch: rows.filter((row) => row.dispatch_readiness_flags?.ready_for_dispatch).length,
    dispatchRemainingQty: money(rows.reduce((sum, row) => sum + money(row.qty_dispatch_remaining || 0), 0)),
    readyDispatchQty: money(
      rows.filter((row) => row.dispatch_readiness_flags?.ready_for_dispatch).reduce((sum, row) => sum + money(row.qty_dispatch_remaining || 0), 0)
    ),
  };
}

async function getCompletionDispatchReadinessQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryCompletionDispatchReadinessRows(client, req, { q, limit: 700 });
  return rows
    .map((row) => ({
      ...row,
      ...buildCompletionDispatchReadinessMetadata(row),
    }))
    .filter((row) => matchesCompletionDispatchReadinessBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getCompletionDispatchReadinessRank(a) - getCompletionDispatchReadinessRank(b);
      if (rankDiff !== 0) return rankDiff;
      const remainingDiff = money(b.qty_dispatch_remaining || 0) - money(a.qty_dispatch_remaining || 0);
      if (remainingDiff !== 0) return remainingDiff;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

async function queryPlanningReleaseRows(client, req, { q = "", limit = 600 } = {}) {
  const companyId = getActiveCompanyId(req);
  if (!companyId) return [];
  const params = [Number(companyId)];
  const filters = [
    `so.company_id = $1`,
    `so.order_status = 'confirmed'`,
    `coalesce(p.is_manufactured, false) = true`,
  ];
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      so.so_number ilike $${idx}
      or c.customer_name ilike $${idx}
      or coalesce(p.item_code, '') ilike $${idx}
      or coalesce(p.item_name, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);

  const r = await client.query(
    `
      with dispatch_totals as (
        select
          dl.sales_order_line_id,
          coalesce(sum(case when d.dispatch_status <> 'cancelled' then dl.qty_dispatch else 0 end), 0) as qty_dispatched
        from dispatch_lines dl
        join dispatches d on d.id = dl.dispatch_id
        where dl.sales_order_line_id is not null
        group by dl.sales_order_line_id
      ),
      bom_counts as (
        select
          mb.finished_good_product_id,
          count(*)::int as total_bom_count,
          count(*) filter (where mb.is_active = true)::int as active_bom_count
        from manufacturing_boms mb
        where mb.company_id = $1
        group by mb.finished_good_product_id
      ),
      latest_active_bom as (
        select distinct on (mb.finished_good_product_id)
          mb.finished_good_product_id,
          mb.id as bom_id,
          coalesce(lines.line_count, 0) as line_count
        from manufacturing_boms mb
        left join (
          select bom_id, count(*)::int as line_count
          from manufacturing_bom_lines
          group by bom_id
        ) lines on lines.bom_id = mb.id
        where mb.company_id = $1
          and mb.is_active = true
        order by mb.finished_good_product_id, mb.revision_no desc, mb.updated_at desc, mb.id desc
      ),
      job_stats as (
        select
          jc.sales_order_line_id,
          count(*)::int as linked_job_count,
          count(*) filter (where lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open'))::int as open_job_count,
          coalesce(sum(pending.pending_issue_qty), 0) as pending_issue_qty
        from job_cards jc
        left join lateral (
          select
            coalesce(sum(greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0)), 0) as pending_issue_qty
          from job_card_lines jcl
          left join lateral (
            select coalesce(sum(qty), 0) as issue_qty
            from job_card_movements
            where job_card_line_id = jcl.id and movement_type = 'issue'
          ) issue_stats on true
          left join lateral (
            select coalesce(sum(qty), 0) as return_qty
            from job_card_movements
            where job_card_line_id = jcl.id and movement_type = 'return'
          ) return_stats on true
          where jcl.job_card_id = jc.id
        ) pending on true
        where jc.company_id = $1
          and jc.sales_order_line_id is not null
        group by jc.sales_order_line_id
      )
      select
        so.id as sales_order_id,
        so.so_number,
        so.order_date,
        c.customer_name,
        sol.id as sales_order_line_id,
        sol.line_no as sales_order_line_no,
        sol.qty as qty_ordered,
        coalesce(dt.qty_dispatched, 0) as qty_dispatched,
        greatest(sol.qty - coalesce(dt.qty_dispatched, 0), 0) as qty_dispatch_remaining,
        p.id as finished_good_product_id,
        p.item_code as finished_good_item_code,
        p.item_name as finished_good_item_name,
        p.mfg_job_prefix,
        coalesce(sb.stock_qty, 0) as fg_stock_qty,
        coalesce(p.is_manufactured, false) as is_manufactured,
        coalesce(bc.active_bom_count, 0) as active_bom_count,
        coalesce(lab.line_count, 0) as latest_active_line_count,
        coalesce(js.linked_job_count, 0) as linked_job_count,
        coalesce(js.open_job_count, 0) as open_job_count,
        coalesce(js.pending_issue_qty, 0) as pending_issue_qty
      from sales_order_lines sol
      join sales_orders so on so.id = sol.sales_order_id
      join customers c on c.id = so.customer_id
      join products p on p.id = sol.product_id
      left join dispatch_totals dt on dt.sales_order_line_id = sol.id
      left join stock_balances sb on sb.company_id = so.company_id and sb.product_id = sol.product_id
      left join bom_counts bc on bc.finished_good_product_id = p.id
      left join latest_active_bom lab on lab.finished_good_product_id = p.id
      left join job_stats js on js.sales_order_line_id = sol.id
      ${where}
      order by so.order_date asc, so.id desc, sol.line_no asc
      limit ${safeLimit}
    `,
    params
  );

  return r.rows.map((row) => {
    const prefix = normalizeText(row.mfg_job_prefix);
    const fgStockQty = money(row.fg_stock_qty || 0);
    const dispatchRemaining = money(row.qty_dispatch_remaining || 0);
    const productionGapQty = money(Math.max(dispatchRemaining - fgStockQty, 0));
    const activeBomCount = Number(row.active_bom_count || 0);
    const latestActiveLineCount = Number(row.latest_active_line_count || 0);
    const readyForJob = row.is_manufactured === true && Boolean(prefix) && activeBomCount > 0 && latestActiveLineCount > 0;
    const linkedJobCount = Number(row.linked_job_count || 0);
    const openJobCount = Number(row.open_job_count || 0);
    const pendingIssueQty = money(row.pending_issue_qty || 0);
    const releaseBlockedSetup = productionGapQty > 0 && linkedJobCount <= 0 && !readyForJob;
    const readyForRelease = productionGapQty > 0 && linkedJobCount <= 0 && readyForJob;
    const releasedMaterialBlocked = productionGapQty > 0 && openJobCount > 0 && pendingIssueQty > 0.0001;
    const releasedInExecution = productionGapQty > 0 && openJobCount > 0 && pendingIssueQty <= 0.0001;
    return {
      ...row,
      fg_stock_qty: fgStockQty,
      qty_dispatch_remaining: dispatchRemaining,
      pending_issue_qty: pendingIssueQty,
      production_gap_qty: productionGapQty,
      release_flags: {
        release_blocked_setup: releaseBlockedSetup,
        ready_for_release: readyForRelease,
        released_material_blocked: releasedMaterialBlocked,
        released_in_execution: releasedInExecution,
      },
      release_ready_for_job: readyForJob,
    };
  });
}

async function getPlanningReleaseSummary(client, req, { q = "" } = {}) {
  const rows = await queryPlanningReleaseRows(client, req, { q, limit: 800 });
  return {
    manufacturingDemandLines: rows.length,
    releaseBlockedSetup: rows.filter((row) => row.release_flags?.release_blocked_setup).length,
    readyForRelease: rows.filter((row) => row.release_flags?.ready_for_release).length,
    releasedMaterialBlocked: rows.filter((row) => row.release_flags?.released_material_blocked).length,
    releasedInExecution: rows.filter((row) => row.release_flags?.released_in_execution).length,
    productionGapQty: money(rows.reduce((sum, row) => sum + money(row.production_gap_qty || 0), 0)),
    readyReleaseQty: money(rows.filter((row) => row.release_flags?.ready_for_release).reduce((sum, row) => sum + money(row.production_gap_qty || 0), 0)),
  };
}

async function getPlanningReleaseQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryPlanningReleaseRows(client, req, { q, limit: 800 });
  return rows
    .map((row) => ({
      ...row,
      ...buildPlanningReleaseMetadata(row),
    }))
    .filter((row) => matchesPlanningReleaseBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getPlanningReleaseRank(a) - getPlanningReleaseRank(b);
      if (rankDiff !== 0) return rankDiff;
      const gapDiff = money(b.production_gap_qty || 0) - money(a.production_gap_qty || 0);
      if (gapDiff !== 0) return gapDiff;
      return Number(b.sales_order_id || 0) - Number(a.sales_order_id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

function getPlanningCapacityBucket(row) {
  if (row?.capacity_flags?.setup_blocked) return "capacity_setup_blocked";
  if (row?.capacity_flags?.ready_for_release) return "capacity_ready_for_release";
  if (row?.capacity_flags?.overdue) return "capacity_overdue";
  if (row?.capacity_flags?.due_7d) return "capacity_due_7d";
  if (row?.capacity_flags?.unassigned_department) return "capacity_unassigned_department";
  if (row?.capacity_flags?.future) return "capacity_future";
  return "other";
}

function matchesPlanningCapacityBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getPlanningCapacityBucket(row) !== "other";
  return getPlanningCapacityBucket(row) === key;
}

function getPlanningCapacityRank(row) {
  const bucket = getPlanningCapacityBucket(row);
  if (bucket === "capacity_overdue") return 0;
  if (bucket === "capacity_due_7d") return 1;
  if (bucket === "capacity_ready_for_release") return 2;
  if (bucket === "capacity_setup_blocked") return 3;
  if (bucket === "capacity_unassigned_department") return 4;
  if (bucket === "capacity_future") return 5;
  return 99;
}

async function queryPlanningCapacityBacklogRows(client, req, { q = "", limit = 600 } = {}) {
  const companyId = getActiveCompanyId(req);
  if (!companyId) return [];
  const params = [Number(companyId)];
  const filters = [
    `jc.company_id = $1`,
    `jc.job_type = 'manufacturing'`,
    `lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')`,
  ];
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    filters.push(`jc.created_by = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      jc.job_card_number ilike $${idx}
      or coalesce(jc.job_id, '') ilike $${idx}
      or coalesce(so.so_number, '') ilike $${idx}
      or coalesce(c.customer_name, '') ilike $${idx}
      or coalesce(fg.item_code, '') ilike $${idx}
      or coalesce(fg.item_name, '') ilike $${idx}
      or coalesce(jc.department, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);
  const profile = (await getProductionCostProfile(client, companyId)) || { default_labor_hours_per_output: 0 };
  const hoursPerOutput = money(profile.default_labor_hours_per_output || 0);
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const r = await client.query(
    `
      select
        jc.id,
        jc.job_card_number,
        jc.job_id,
        jc.job_status,
        jc.job_date,
        jc.department,
        jc.sales_order_id,
        jc.sales_order_line_id,
        jc.planned_output_qty,
        jc.actual_output_qty,
        so.so_number,
        c.customer_name,
        fg.id as finished_good_product_id,
        fg.item_code as finished_good_item_code,
        fg.item_name as finished_good_item_name,
        fg.uom as finished_good_uom
      from job_cards jc
      left join sales_orders so on so.id = jc.sales_order_id
      left join customers c on c.id = so.customer_id
      left join products fg on fg.id = jc.finished_good_product_id
      ${where}
      order by jc.job_date asc nulls last, jc.id desc
      limit ${safeLimit}
    `,
    params
  );

  return r.rows
    .map((row) => {
      const planned = money(row.planned_output_qty || 0);
      const actual = money(row.actual_output_qty || 0);
      const remaining = money(Math.max(planned - actual, 0));
      const estHours = money(remaining * hoursPerOutput);
      const dept = normalizeText(row.department);
      const jobDate = row.job_date ? new Date(row.job_date) : null;
      const daysDiff =
        jobDate && !Number.isNaN(jobDate.getTime())
          ? Math.floor((new Date(jobDate.getFullYear(), jobDate.getMonth(), jobDate.getDate()).getTime() - todayMid.getTime()) / 86400000)
          : null;
      const overdue = typeof daysDiff === "number" ? daysDiff < 0 : false;
      const due7d = typeof daysDiff === "number" ? daysDiff >= 0 && daysDiff <= 7 : false;
      const future = typeof daysDiff === "number" ? daysDiff > 7 : false;
      const unassignedDepartment = !dept;
      return {
        ...row,
        row_type: "job",
        remaining_output_qty: remaining,
        estimated_hours: estHours,
        planning_hours_per_output: hoursPerOutput,
        capacity_flags: {
          overdue,
          due_7d: due7d,
          future,
          unassigned_department: unassignedDepartment,
        },
      };
    })
    .filter((row) => money(row.remaining_output_qty || 0) > 0.0001);
}

async function queryPlanningCapacityDemandRows(client, req, { q = "", limit = 600 } = {}) {
  const companyId = getActiveCompanyId(req);
  if (!companyId) return [];
  const profile = (await getProductionCostProfile(client, companyId)) || { default_labor_hours_per_output: 0 };
  const hoursPerOutput = money(profile.default_labor_hours_per_output || 0);
  const demand = await queryPlanningReleaseRows(client, req, { q, limit });
  return demand
    .filter((row) => money(row.production_gap_qty || 0) > 0.0001)
    .map((row) => {
      const gapQty = money(row.production_gap_qty || 0);
      const estHours = money(gapQty * hoursPerOutput);
      return {
        ...row,
        row_type: "demand",
        estimated_hours: estHours,
        planning_hours_per_output: hoursPerOutput,
        capacity_flags: {
          setup_blocked: Boolean(row.release_flags?.release_blocked_setup),
          ready_for_release: Boolean(row.release_flags?.ready_for_release),
        },
      };
    });
}

async function getPlanningCapacitySummary(client, req, { q = "" } = {}) {
  const [demand, backlog] = await Promise.all([
    queryPlanningCapacityDemandRows(client, req, { q, limit: 800 }),
    queryPlanningCapacityBacklogRows(client, req, { q, limit: 800 }),
  ]);
  const setupBlocked = demand.filter((row) => row.capacity_flags?.setup_blocked);
  const readyForRelease = demand.filter((row) => row.capacity_flags?.ready_for_release);
  const overdue = backlog.filter((row) => row.capacity_flags?.overdue);
  const due7d = backlog.filter((row) => row.capacity_flags?.due_7d);
  const future = backlog.filter((row) => row.capacity_flags?.future);
  const unassigned = backlog.filter((row) => row.capacity_flags?.unassigned_department);
  const sumHours = (rows) => money(rows.reduce((sum, row) => sum + money(row.estimated_hours || 0), 0));
  return {
    demandLines: demand.length,
    backlogJobs: backlog.length,
    setupBlockedCount: setupBlocked.length,
    readyForReleaseCount: readyForRelease.length,
    overdueJobs: overdue.length,
    due7dJobs: due7d.length,
    futureJobs: future.length,
    unassignedDeptJobs: unassigned.length,
    setupBlockedHours: sumHours(setupBlocked),
    readyForReleaseHours: sumHours(readyForRelease),
    backlogHours: sumHours(backlog),
    overdueHours: sumHours(overdue),
    due7dHours: sumHours(due7d),
    futureHours: sumHours(future),
    unassignedDeptHours: sumHours(unassigned),
    totalHours: money(sumHours(backlog) + sumHours(setupBlocked) + sumHours(readyForRelease)),
  };
}

async function getPlanningCapacityQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const key = String(bucket || "all").trim().toLowerCase();
  const isDemand = ["capacity_setup_blocked", "capacity_ready_for_release"].includes(key);
  const rows = isDemand
    ? await queryPlanningCapacityDemandRows(client, req, { q, limit: 800 })
    : await queryPlanningCapacityBacklogRows(client, req, { q, limit: 800 });

  return rows
    .map((row) => ({
      ...row,
      ...buildPlanningCapacityMetadata(row),
    }))
    .filter((row) => matchesPlanningCapacityBucket(row, key))
    .sort((a, b) => {
      const rankDiff = getPlanningCapacityRank(a) - getPlanningCapacityRank(b);
      if (rankDiff !== 0) return rankDiff;
      const hoursDiff = money(b.estimated_hours || 0) - money(a.estimated_hours || 0);
      if (hoursDiff !== 0) return hoursDiff;
      if (a.row_type === "demand" && b.row_type === "demand") {
        return Number(a.sales_order_line_id || 0) - Number(b.sales_order_line_id || 0);
      }
      return Number(a.id || 0) - Number(b.id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

function getProductionCostBucket(row) {
  if (row.cost_flags?.issued_no_output) return "issued_no_output";
  if (row.cost_flags?.over_issue_vs_bom) return "over_issue_vs_bom";
  if (row.cost_flags?.under_issue_vs_bom) return "under_issue_vs_bom";
  if (row.cost_flags?.stalled_wip_value) return "stalled_wip_value";
  if (row.cost_flags?.margin_at_risk) return "margin_at_risk";
  if (row.cost_flags?.ready_cost_review) return "ready_cost_review";
  return "other";
}

function matchesProductionCostBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getProductionCostBucket(row) !== "other";
  return getProductionCostBucket(row) === key;
}

function getProductionCostRank(row) {
  const bucket = getProductionCostBucket(row);
  switch (bucket) {
    case "issued_no_output":
      return 1;
    case "margin_at_risk":
      return 2;
    case "over_issue_vs_bom":
      return 3;
    case "stalled_wip_value":
      return 4;
    case "under_issue_vs_bom":
      return 5;
    case "ready_cost_review":
      return 6;
    default:
      return 99;
  }
}

async function getProductionCostProfile(client, companyId) {
  const cid = Number(companyId) || 0;
  if (!cid) return null;
  await client.query(`insert into production_cost_profiles (company_id) values ($1) on conflict (company_id) do nothing`, [cid]);
  const r = await client.query(
    `
      select
        company_id,
        material_rate_basis,
        default_labor_hours_per_output,
        default_labor_hour_rate,
        default_overhead_rate_per_output,
        remarks,
        updated_at
      from production_cost_profiles
      where company_id = $1
      limit 1
    `,
    [cid]
  );
  return r.rows[0] || null;
}

async function queryProductionCostRows(client, req, { q = "", limit = 600, jobCardId = null } = {}) {
  const companyId = getActiveCompanyId(req);
  if (!companyId) return [];
  const profile = (await getProductionCostProfile(client, companyId)) || {
    material_rate_basis: "latest_purchase_invoice",
    default_labor_hours_per_output: 0,
    default_labor_hour_rate: 0,
    default_overhead_rate_per_output: 0,
  };
  const params = [Number(companyId)];
  const filters = [`jc.company_id = $1`, `jc.job_type = 'manufacturing'`];
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    filters.push(`jc.created_by = $${params.length}`);
  }
  if (jobCardId) {
    params.push(Number(jobCardId));
    filters.push(`jc.id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      jc.job_card_number ilike $${idx}
      or coalesce(jc.job_id, '') ilike $${idx}
      or coalesce(so.so_number, '') ilike $${idx}
      or coalesce(c.customer_name, '') ilike $${idx}
      or coalesce(fg.item_code, '') ilike $${idx}
      or coalesce(fg.item_name, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);
  const preferPurchaseInvoice = String(profile.material_rate_basis || "latest_purchase_invoice") !== "purchase_order_estimate";

  const r = await client.query(
    `
      with movement_totals as (
        select
          jcm.job_card_line_id,
          coalesce(sum(case when jcm.movement_type = 'issue' then jcm.qty else 0 end), 0) as issue_qty,
          coalesce(sum(case when jcm.movement_type = 'return' then jcm.qty else 0 end), 0) as return_qty
        from job_card_movements jcm
        join job_cards jc on jc.id = jcm.job_card_id
        where jc.company_id = $1
        group by jcm.job_card_line_id
      ),
      latest_pi_rate as (
        select distinct on (pil.product_id)
          pil.product_id,
          pil.unit_price_base as unit_rate
        from purchase_invoice_lines pil
        join purchase_invoices pi on pi.id = pil.purchase_invoice_id
        where pi.company_id = $1
          and pi.invoice_status = 'posted'
          and pil.product_id is not null
        order by pil.product_id, pi.invoice_date desc, pil.id desc
      ),
      latest_po_rate as (
        select distinct on (pol.product_id)
          pol.product_id,
          pol.unit_price_base as unit_rate
        from purchase_order_lines pol
        join purchase_orders po on po.id = pol.purchase_order_id
        where po.company_id = $1
          and po.po_status in ('confirmed', 'closed')
          and pol.product_id is not null
        order by pol.product_id, po.po_date desc, pol.id desc
      ),
      line_costs as (
        select
          jcl.job_card_id,
          sum(greatest(coalesce(mt.issue_qty, 0) - coalesce(mt.return_qty, 0), 0)) as net_issue_qty,
          sum(
            greatest(coalesce(mt.issue_qty, 0) - coalesce(mt.return_qty, 0), 0)
            * coalesce(${preferPurchaseInvoice ? "lpi.unit_rate, lpo.unit_rate" : "lpo.unit_rate, lpi.unit_rate"}, 0)
          ) as material_actual_value
        from job_card_lines jcl
        left join movement_totals mt on mt.job_card_line_id = jcl.id
        left join latest_pi_rate lpi on lpi.product_id = jcl.product_id
        left join latest_po_rate lpo on lpo.product_id = jcl.product_id
        group by jcl.job_card_id
      ),
      bom_unit_costs as (
        select
          mb.id as bom_id,
          sum(
            mbl.qty_per
            * coalesce(${preferPurchaseInvoice ? "lpi.unit_rate, lpo.unit_rate" : "lpo.unit_rate, lpi.unit_rate"}, 0)
          ) as bom_unit_material_cost
        from manufacturing_boms mb
        join manufacturing_bom_lines mbl on mbl.bom_id = mb.id
        left join latest_pi_rate lpi on lpi.product_id = mbl.component_product_id
        left join latest_po_rate lpo on lpo.product_id = mbl.component_product_id
        where mb.company_id = $1
        group by mb.id
      ),
      invoice_totals as (
        select
          il.sales_order_line_id,
          coalesce(sum(case when ci.invoice_status = 'posted' then il.line_total_base else 0 end), 0) as invoiced_line_value_base
        from invoice_lines il
        join customer_invoices ci on ci.id = il.customer_invoice_id
        where il.sales_order_line_id is not null
          and ci.company_id = $1
        group by il.sales_order_line_id
      )
      select
        jc.id,
        jc.job_card_number,
        jc.job_id,
        jc.job_status,
        jc.job_date,
        jc.created_at,
        jc.updated_at,
        jc.sales_order_id,
        jc.sales_order_line_id,
        jc.bom_id,
        jc.planned_output_qty,
        jc.actual_output_qty,
        jc.finished_good_receipt_date,
        jc.actual_labor_hours,
        jc.labor_hour_rate,
        jc.overhead_absorption_amount,
        so.so_number,
        sol.line_no as sales_order_line_no,
        sol.line_total_base as sales_order_line_value_base,
        c.customer_name,
        fg.item_code as finished_good_item_code,
        fg.item_name as finished_good_item_name,
        fg.uom as finished_good_uom,
        coalesce(lc.net_issue_qty, 0) as net_issue_qty,
        coalesce(lc.material_actual_value, 0) as material_actual_value,
        coalesce(buc.bom_unit_material_cost, 0) as bom_unit_material_cost,
        coalesce(it.invoiced_line_value_base, 0) as invoiced_line_value_base,
        (select max(movement_date) from job_card_movements where job_card_id = jc.id) as last_movement_date
      from job_cards jc
      left join sales_orders so on so.id = jc.sales_order_id
      left join sales_order_lines sol on sol.id = jc.sales_order_line_id
      left join customers c on c.id = so.customer_id
      left join products fg on fg.id = jc.finished_good_product_id
      left join line_costs lc on lc.job_card_id = jc.id
      left join bom_unit_costs buc on buc.bom_id = jc.bom_id
      left join invoice_totals it on it.sales_order_line_id = jc.sales_order_line_id
      ${where}
      order by jc.job_date desc, jc.id desc
      limit ${safeLimit}
    `,
    params
  );

  return r.rows.map((row) => {
    const actualOutputQty = money(row.actual_output_qty || 0);
    const plannedOutputQty = money(row.planned_output_qty || 0);
    const materialActualValue = money(row.material_actual_value || 0);
    const bomUnitMaterialCost = money(row.bom_unit_material_cost || 0);
    const expectedMaterialForOutput = money(bomUnitMaterialCost * actualOutputQty);
    const expectedMaterialForPlanned = money(bomUnitMaterialCost * plannedOutputQty);
    const materialVarianceOutput = money(materialActualValue - expectedMaterialForOutput);
    const materialVariancePlanned = money(materialActualValue - expectedMaterialForPlanned);
    const useActualLabor = money(row.actual_labor_hours || 0) > 0 || money(row.labor_hour_rate || 0) > 0;
    const laborHoursApplied = useActualLabor
      ? money(row.actual_labor_hours || 0)
      : money(actualOutputQty * money(profile.default_labor_hours_per_output || 0));
    const laborRateApplied = useActualLabor ? money(row.labor_hour_rate || 0) : money(profile.default_labor_hour_rate || 0);
    const laborAbsorbedValue = money(laborHoursApplied * laborRateApplied);
    const overheadAbsorbedValue =
      money(row.overhead_absorption_amount || 0) > 0
        ? money(row.overhead_absorption_amount || 0)
        : money(actualOutputQty * money(profile.default_overhead_rate_per_output || 0));
    const totalAbsorbedValue = money(materialActualValue + laborAbsorbedValue + overheadAbsorbedValue);
    const lineValueBase = money(row.sales_order_line_value_base || 0);
    const invoicedValueBase = money(row.invoiced_line_value_base || 0);
    const marginVsSalesOrder = money(lineValueBase - totalAbsorbedValue);
    const marginVsInvoiced = money(invoicedValueBase - totalAbsorbedValue);
    const varianceTolerance = Math.max(1, expectedMaterialForOutput * 0.1);
    const status = String(row.job_status || "").toLowerCase();
    const lastMovementDate = row.last_movement_date ? new Date(row.last_movement_date) : null;
    const staleDays =
      lastMovementDate && !Number.isNaN(lastMovementDate.getTime())
        ? Math.max(Math.floor((Date.now() - lastMovementDate.getTime()) / 86400000), 0)
        : 999;
    const openStatus = ["draft", "open", "submitted", "approved"].includes(status);
    const issuedNoOutput = materialActualValue > 0.0001 && actualOutputQty <= 0.0001;
    const overIssueVsBom = actualOutputQty > 0.0001 && materialVarianceOutput > varianceTolerance;
    const underIssueVsBom = actualOutputQty > 0.0001 && materialVarianceOutput < -varianceTolerance;
    const stalledWipValue = openStatus && totalAbsorbedValue > 0.0001 && staleDays >= 5;
    const marginAtRisk = lineValueBase > 0.0001 && marginVsSalesOrder < 0;
    const readyCostReview = ["closed", "posted"].includes(status) && totalAbsorbedValue > 0.0001;
    const materialAbsorptionRatio =
      expectedMaterialForOutput > 0.0001 ? money(materialActualValue / expectedMaterialForOutput) : 0;

    return {
      ...row,
      profile_material_rate_basis: profile.material_rate_basis || "latest_purchase_invoice",
      net_issue_qty: money(row.net_issue_qty || 0),
      material_actual_value: materialActualValue,
      bom_unit_material_cost: bomUnitMaterialCost,
      expected_material_value_output: expectedMaterialForOutput,
      expected_material_value_planned: expectedMaterialForPlanned,
      material_variance_output: materialVarianceOutput,
      material_variance_planned: materialVariancePlanned,
      labor_hours_applied: laborHoursApplied,
      labor_rate_applied: laborRateApplied,
      labor_absorbed_value: laborAbsorbedValue,
      overhead_absorbed_value: overheadAbsorbedValue,
      total_absorbed_value: totalAbsorbedValue,
      sales_order_line_value_base: lineValueBase,
      invoiced_line_value_base: invoicedValueBase,
      margin_vs_sales_order: marginVsSalesOrder,
      margin_vs_invoiced: marginVsInvoiced,
      material_absorption_ratio: materialAbsorptionRatio,
      cost_flags: {
        issued_no_output: issuedNoOutput,
        over_issue_vs_bom: overIssueVsBom,
        under_issue_vs_bom: underIssueVsBom,
        stalled_wip_value: stalledWipValue,
        margin_at_risk: marginAtRisk,
        ready_cost_review: readyCostReview,
      },
    };
  });
}

async function getProductionCostControlSummary(client, req, { q = "" } = {}) {
  const rows = await queryProductionCostRows(client, req, { q, limit: 800 });
  return {
    jobCount: rows.length,
    issuedNoOutput: rows.filter((row) => row.cost_flags?.issued_no_output).length,
    overIssueVsBom: rows.filter((row) => row.cost_flags?.over_issue_vs_bom).length,
    underIssueVsBom: rows.filter((row) => row.cost_flags?.under_issue_vs_bom).length,
    stalledWipValueJobs: rows.filter((row) => row.cost_flags?.stalled_wip_value).length,
    marginAtRisk: rows.filter((row) => row.cost_flags?.margin_at_risk).length,
    materialActualValue: money(rows.reduce((sum, row) => sum + money(row.material_actual_value || 0), 0)),
    expectedMaterialValue: money(rows.reduce((sum, row) => sum + money(row.expected_material_value_output || 0), 0)),
    laborAbsorbedValue: money(rows.reduce((sum, row) => sum + money(row.labor_absorbed_value || 0), 0)),
    overheadAbsorbedValue: money(rows.reduce((sum, row) => sum + money(row.overhead_absorbed_value || 0), 0)),
    totalAbsorbedValue: money(rows.reduce((sum, row) => sum + money(row.total_absorbed_value || 0), 0)),
    negativeMarginValue: money(
      rows
        .filter((row) => money(row.margin_vs_sales_order || 0) < 0)
        .reduce((sum, row) => sum + Math.abs(money(row.margin_vs_sales_order || 0)), 0)
    ),
  };
}

async function getProductionCostControlQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryProductionCostRows(client, req, { q, limit: 800 });
  return rows
    .map((row) => ({
      ...row,
      ...buildProductionCostMetadata(row),
    }))
    .filter((row) => matchesProductionCostBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getProductionCostRank(a) - getProductionCostRank(b);
      if (rankDiff !== 0) return rankDiff;
      const valueDiff = money(b.total_absorbed_value || 0) - money(a.total_absorbed_value || 0);
      if (valueDiff !== 0) return valueDiff;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

async function getStoresPendingIssueRows(client, req, { q = "" } = {}) {
  const params = [];
  const filters = [
    storesEligibleJobTypeSql("jc"),
    `lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')`,
  ];
  const activeCompanyId = getActiveCompanyId(req);
  if (activeCompanyId) {
    params.push(Number(activeCompanyId));
    filters.push(`jc.company_id = $${params.length}`);
  }
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    filters.push(`jc.created_by = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      jc.job_card_number ilike $${idx}
      or coalesce(jc.job_id, '') ilike $${idx}
      or coalesce(so.so_number, '') ilike $${idx}
      or coalesce(c.customer_name, '') ilike $${idx}
      or coalesce(st.ticket_number, '') ilike $${idx}
      or coalesce(stc.customer_name, '') ilike $${idx}
      or coalesce(fg.item_code, '') ilike $${idx}
      or coalesce(fg.item_name, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const r = await client.query(
    `
      select
        jc.id,
        jc.job_card_number,
        jc.job_id,
        jc.job_status,
        jc.job_type,
        jc.job_date,
        jc.sales_order_line_id,
        jc.planned_output_qty,
        jc.actual_output_qty,
        so.so_number,
        coalesce(c.customer_name, stc.customer_name) as customer_name,
        st.ticket_number as service_ticket_number,
        fg.item_code as finished_good_item_code,
        fg.item_name as finished_good_item_name,
        stats.total_requested_qty,
        stats.net_issued_qty,
        stats.pending_issue_qty,
        stats.pending_line_count,
        stats.low_stock_line_count,
        (select max(movement_date) from job_card_movements where job_card_id = jc.id) as last_movement_date
      from job_cards jc
      left join sales_orders so on so.id = jc.sales_order_id
      left join customers c on c.id = so.customer_id
      left join service_tickets st on st.id = jc.service_ticket_id
      left join customers stc on stc.id = st.customer_id
      left join products fg on fg.id = jc.finished_good_product_id
      left join lateral (
        select
          coalesce(sum(jcl.qty_requested), 0) as total_requested_qty,
          coalesce(sum(coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0) as net_issued_qty,
          coalesce(sum(greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0)), 0) as pending_issue_qty,
          coalesce(sum(case when greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0) > 0 then 1 else 0 end), 0)::int as pending_line_count,
          coalesce(sum(case when coalesce(sb.stock_qty, 0) < greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0) then 1 else 0 end), 0)::int as low_stock_line_count
        from job_card_lines jcl
        left join lateral (
          select coalesce(sum(qty), 0) as issue_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'issue'
        ) issue_stats on true
        left join lateral (
          select coalesce(sum(qty), 0) as return_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'return'
        ) return_stats on true
        left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jcl.product_id
        where jcl.job_card_id = jc.id
      ) stats on true
      ${where}
        and coalesce(stats.pending_issue_qty, 0) > 0
      order by coalesce(jc.job_date, jc.created_at::date) desc, jc.id desc
      limit 200
    `,
    params
  );
  const rows = r.rows.map((row) => ({
    ...row,
    manufacturing_mode: row.sales_order_line_id ? "so_linked" : "standalone",
    ...buildStoresPendingIssueMetadata(row),
  }));
  return {
    rows,
    summary: {
      total: rows.length,
      pendingIssueQty: rows.reduce((sum, row) => sum + qty(row.pending_issue_qty), 0),
      pendingLines: rows.reduce((sum, row) => sum + Number(row.pending_line_count || 0), 0),
      lowStockJobs: rows.filter((row) => Number(row.low_stock_line_count || 0) > 0).length,
      soLinked: rows.filter((row) => row.manufacturing_mode === "so_linked").length,
      standalone: rows.filter((row) => row.manufacturing_mode === "standalone").length,
    },
  };
}

async function getStoresPendingIssueIds(client, req, { q = "", limit = 5000 } = {}) {
  const params = [];
  const filters = [
    storesEligibleJobTypeSql("jc"),
    `lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')`,
  ];
  const activeCompanyId = getActiveCompanyId(req);
  if (activeCompanyId) {
    params.push(Number(activeCompanyId));
    filters.push(`jc.company_id = $${params.length}`);
  }
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    filters.push(`jc.created_by = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      jc.job_card_number ilike $${idx}
      or coalesce(jc.job_id, '') ilike $${idx}
      or coalesce(so.so_number, '') ilike $${idx}
      or coalesce(c.customer_name, '') ilike $${idx}
      or coalesce(st.ticket_number, '') ilike $${idx}
      or coalesce(stc.customer_name, '') ilike $${idx}
      or coalesce(fg.item_code, '') ilike $${idx}
      or coalesce(fg.item_name, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 5000);
  const r = await client.query(
    `
      select jc.id
      from job_cards jc
      left join sales_orders so on so.id = jc.sales_order_id
      left join customers c on c.id = so.customer_id
      left join service_tickets st on st.id = jc.service_ticket_id
      left join customers stc on stc.id = st.customer_id
      left join products fg on fg.id = jc.finished_good_product_id
      left join lateral (
        select
          coalesce(sum(greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0)), 0) as pending_issue_qty
        from job_card_lines jcl
        left join lateral (
          select coalesce(sum(qty), 0) as issue_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'issue'
        ) issue_stats on true
        left join lateral (
          select coalesce(sum(qty), 0) as return_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'return'
        ) return_stats on true
        where jcl.job_card_id = jc.id
      ) stats on true
      ${where}
        and coalesce(stats.pending_issue_qty, 0) > 0
      order by coalesce(jc.job_date, jc.created_at::date) desc, jc.id desc
      limit ${safeLimit}
    `,
    params
  );
  return {
    ids: r.rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0),
    limited: r.rows.length >= safeLimit,
  };
}

async function getStoresPendingIssueSummary(client, req, { q = "" } = {}) {
  const params = [];
  const filters = [
    storesEligibleJobTypeSql("jc"),
    `lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')`,
  ];
  const activeCompanyId = getActiveCompanyId(req);
  if (activeCompanyId) {
    params.push(Number(activeCompanyId));
    filters.push(`jc.company_id = $${params.length}`);
  }
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    filters.push(`jc.created_by = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      jc.job_card_number ilike $${idx}
      or coalesce(jc.job_id, '') ilike $${idx}
      or coalesce(so.so_number, '') ilike $${idx}
      or coalesce(c.customer_name, '') ilike $${idx}
      or coalesce(st.ticket_number, '') ilike $${idx}
      or coalesce(stc.customer_name, '') ilike $${idx}
      or coalesce(fg.item_code, '') ilike $${idx}
      or coalesce(fg.item_name, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const r = await client.query(
    `
      select
        count(*)::int as total,
        coalesce(sum(coalesce(stats.pending_issue_qty, 0)), 0) as pending_issue_qty,
        coalesce(sum(coalesce(stats.pending_line_count, 0)), 0)::int as pending_line_count,
        coalesce(sum(case when coalesce(stats.low_stock_line_count, 0) > 0 then 1 else 0 end), 0)::int as low_stock_jobs,
        coalesce(sum(case when jc.sales_order_line_id is not null then 1 else 0 end), 0)::int as so_linked,
        coalesce(sum(case when jc.sales_order_line_id is null then 1 else 0 end), 0)::int as standalone
      from job_cards jc
      left join sales_orders so on so.id = jc.sales_order_id
      left join customers c on c.id = so.customer_id
      left join service_tickets st on st.id = jc.service_ticket_id
      left join customers stc on stc.id = st.customer_id
      left join products fg on fg.id = jc.finished_good_product_id
      left join lateral (
        select
          coalesce(sum(greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0)), 0) as pending_issue_qty,
          coalesce(sum(case when greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0) > 0 then 1 else 0 end), 0)::int as pending_line_count,
          coalesce(sum(case when coalesce(sb.stock_qty, 0) < greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0) then 1 else 0 end), 0)::int as low_stock_line_count
        from job_card_lines jcl
        left join lateral (
          select coalesce(sum(qty), 0) as issue_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'issue'
        ) issue_stats on true
        left join lateral (
          select coalesce(sum(qty), 0) as return_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'return'
        ) return_stats on true
        left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jcl.product_id
        where jcl.job_card_id = jc.id
      ) stats on true
      ${where}
        and coalesce(stats.pending_issue_qty, 0) > 0
    `,
    params
  );
  const row = r.rows[0] || {};
  return {
    total: Number(row.total || 0),
    pendingIssueQty: qty(row.pending_issue_qty),
    pendingLines: Number(row.pending_line_count || 0),
    lowStockJobs: Number(row.low_stock_jobs || 0),
    soLinked: Number(row.so_linked || 0),
    standalone: Number(row.standalone || 0),
  };
}

async function getStoresPickListData(client, req, { q = "", ids = [], groupBy = "fg" } = {}) {
  const params = [];
  const filters = [
    storesEligibleJobTypeSql("jc"),
    `lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')`,
  ];
  const activeCompanyId = getActiveCompanyId(req);
  if (activeCompanyId) {
    params.push(Number(activeCompanyId));
    filters.push(`jc.company_id = $${params.length}`);
  }
  if (ownRecordsOnly(req, "job_cards")) {
    params.push(Number(req.user.id));
    filters.push(`jc.created_by = $${params.length}`);
  }
  const normalizedIds = parseIdListParam(ids);
  if (normalizedIds.length) {
    params.push(normalizedIds);
    filters.push(`jc.id = any($${params.length}::int[])`);
  } else if (q) {
    params.push(`%${q}%`);
    const idx = params.length;
    filters.push(`(
      jc.job_card_number ilike $${idx}
      or coalesce(jc.job_id, '') ilike $${idx}
      or coalesce(so.so_number, '') ilike $${idx}
      or coalesce(c.customer_name, '') ilike $${idx}
      or coalesce(st.ticket_number, '') ilike $${idx}
      or coalesce(stc.customer_name, '') ilike $${idx}
      or coalesce(fg.item_code, '') ilike $${idx}
      or coalesce(fg.item_name, '') ilike $${idx}
    )`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const r = await client.query(
    `
      select
        jc.id as job_card_id,
        jc.job_card_number,
        jc.job_id,
        jc.job_date,
        jc.job_type,
        jc.sales_order_line_id,
        so.so_number,
        coalesce(c.customer_name, stc.customer_name) as customer_name,
        st.ticket_number as service_ticket_number,
        fg.item_code as finished_good_item_code,
        fg.item_name as finished_good_item_name,
        jcl.line_no,
        jcl.item_code,
        jcl.item_name,
        jcl.uom,
        jcl.remarks,
        coalesce(sb.stock_qty, 0) as current_stock_qty,
        greatest(
          coalesce(jcl.qty_requested, 0) - (
            coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)
          ),
          0
        ) as pending_qty
      from job_cards jc
      join job_card_lines jcl on jcl.job_card_id = jc.id
      left join sales_orders so on so.id = jc.sales_order_id
      left join customers c on c.id = so.customer_id
      left join service_tickets st on st.id = jc.service_ticket_id
      left join customers stc on stc.id = st.customer_id
      left join products fg on fg.id = jc.finished_good_product_id
      left join stock_balances sb on sb.company_id = jc.company_id and sb.product_id = jcl.product_id
      left join lateral (
        select coalesce(sum(qty), 0) as issue_qty
        from job_card_movements
        where job_card_line_id = jcl.id and movement_type = 'issue'
      ) issue_stats on true
      left join lateral (
        select coalesce(sum(qty), 0) as return_qty
        from job_card_movements
        where job_card_line_id = jcl.id and movement_type = 'return'
      ) return_stats on true
      ${where}
        and greatest(
          coalesce(jcl.qty_requested, 0) - (
            coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)
          ),
          0
        ) > 0
      order by coalesce(so.so_number, jc.job_card_number), fg.item_code, jc.id, jcl.line_no
      limit 1000
    `,
    params
  );
  const rows = r.rows.map((row) => ({
    ...row,
    pending_qty: money(row.pending_qty),
    current_stock_qty: money(row.current_stock_qty),
    manufacturing_mode: row.sales_order_line_id ? "so_linked" : "standalone",
  }));
  const groupMap = new Map();
  for (const row of rows) {
    const key =
      groupBy === "so"
        ? row.so_number || `NO_SO_${row.job_card_id}`
        : row.finished_good_item_code || `NO_FG_${row.job_card_id}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        label:
          groupBy === "so"
            ? row.so_number || "No Sales Order"
            : `${row.finished_good_item_code || "No FG"}${row.finished_good_item_name ? ` • ${row.finished_good_item_name}` : ""}`,
        subtitle:
          groupBy === "so"
            ? row.customer_name || "No customer"
            : row.so_number
              ? `SO ${row.so_number}${row.customer_name ? ` • ${row.customer_name}` : ""}`
              : row.customer_name || "Standalone manufacturing",
        rows: [],
        jobIds: new Set(),
        lineCount: 0,
        pendingQty: 0,
      });
    }
    const group = groupMap.get(key);
    group.rows.push(row);
    group.jobIds.add(Number(row.job_card_id));
    group.lineCount += 1;
    group.pendingQty += money(row.pending_qty);
  }
  const groups = Array.from(groupMap.values()).map((group) => ({
    ...group,
    jobCount: group.jobIds.size,
    pendingQty: money(group.pendingQty),
  }));
  return {
    rows,
    groups,
    summary: {
      groups: groups.length,
      jobs: [...new Set(rows.map((row) => Number(row.job_card_id)))].length,
      lines: rows.length,
      pendingQty: money(rows.reduce((sum, row) => sum + money(row.pending_qty), 0)),
    },
  };
}

async function getStoresBatchIssuePlan(client, req, { ids = [] } = {}) {
  const normalizedIds = parseIdListParam(ids);
  if (!normalizedIds.length) {
    return {
      jobs: [],
      summary: {
        selectedJobs: 0,
        jobs: 0,
        lines: 0,
        pendingQty: 0,
        lowStockJobs: 0,
      },
    };
  }
  const data = await getStoresPickListData(client, req, { ids: normalizedIds, groupBy: "fg" });
  const orderMap = new Map(normalizedIds.map((id, index) => [Number(id), index]));
  const jobMap = new Map();
  for (const row of data.rows) {
    const jobId = Number(row.job_card_id);
    if (!jobMap.has(jobId)) {
      jobMap.set(jobId, {
        job_card_id: jobId,
        job_card_number: row.job_card_number,
        job_id: row.job_id,
        job_date: row.job_date,
        manufacturing_mode: row.manufacturing_mode,
        so_number: row.so_number,
        customer_name: row.customer_name,
        finished_good_item_code: row.finished_good_item_code,
        finished_good_item_name: row.finished_good_item_name,
        lines: [],
        pending_qty: 0,
        low_stock_line_count: 0,
      });
    }
    const job = jobMap.get(jobId);
    const currentStockQty = money(row.current_stock_qty);
    const pendingQty = money(row.pending_qty);
    const lowStock = currentStockQty < pendingQty;
    job.lines.push({
      line_no: row.line_no,
      item_code: row.item_code,
      item_name: row.item_name,
      uom: row.uom,
      pending_qty: pendingQty,
      current_stock_qty: currentStockQty,
      low_stock: lowStock,
    });
    job.pending_qty = money(job.pending_qty + pendingQty);
    if (lowStock) job.low_stock_line_count += 1;
  }
  const jobs = Array.from(jobMap.values())
    .map((job) => ({
      ...job,
      pending_line_count: job.lines.length,
    }))
    .sort((a, b) => {
      const left = orderMap.has(Number(a.job_card_id)) ? orderMap.get(Number(a.job_card_id)) : Number.MAX_SAFE_INTEGER;
      const right = orderMap.has(Number(b.job_card_id)) ? orderMap.get(Number(b.job_card_id)) : Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return Number(a.job_card_id) - Number(b.job_card_id);
    });
  return {
    jobs,
    summary: {
      selectedJobs: normalizedIds.length,
      jobs: jobs.length,
      lines: jobs.reduce((sum, job) => sum + Number(job.pending_line_count || 0), 0),
      pendingQty: money(jobs.reduce((sum, job) => sum + money(job.pending_qty), 0)),
      lowStockJobs: jobs.filter((job) => Number(job.low_stock_line_count || 0) > 0).length,
    },
  };
}

async function normalizeJobCardLines(client, rawLines) {
  const lines = Array.isArray(rawLines) ? rawLines.filter((line) => line && Number(line.product_id) > 0) : [];
  const productIds = [...new Set(lines.map((line) => Number(line.product_id)))];
  if (!productIds.length) return [];

  const productRes = await client.query(
    `
      select id, item_code, item_name, uom, coalesce(serial_no_required, false) as serial_no_required
      from products
      where id = any($1::int[])
    `,
    [productIds]
  );
  const productMap = new Map(productRes.rows.map((row) => [Number(row.id), row]));
  if (productMap.size !== productIds.length) {
    const err = new Error("INVALID_PRODUCT");
    err.status = 400;
    throw err;
  }

  return lines.map((line, index) => {
    const product = productMap.get(Number(line.product_id));
    const qtyRequested = money(line.qty_requested);
    const qtyConsumed = money(line.qty_consumed);
    if (qtyRequested < 0 || qtyConsumed < 0) {
      const err = new Error("INVALID_QTY");
      err.status = 400;
      throw err;
    }
    return {
      line_no: index + 1,
      product_id: Number(line.product_id),
      item_code: product.item_code || null,
      item_name: product.item_name || null,
      uom: product.uom || null,
      serial_no_required: product.serial_no_required === true,
      qty_requested: qtyRequested,
      qty_consumed: qtyConsumed,
      remarks: normalizeText(line.remarks),
    };
  });
}

router.get("/bootstrap", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const params = [];
    let ownFilter = "";
    if (ownRecordsOnly(req, "job_cards")) {
      params.push(Number(req.user.id));
      ownFilter = ` and swc.created_by = $${params.length}`;
    }
    const serviceCasesRes = await pool.query(
      `
        select
          swc.id,
          swc.case_number,
          swc.case_status,
          c.customer_name
        from service_warranty_cases swc
        join customers c on c.id = swc.customer_id
        where swc.case_status <> 'cancelled'
        ${ownFilter}
        order by swc.created_at desc, swc.id desc
        limit 200
      `,
      params
    );

    const [finishedGoods, boms, salesOrderLines] = await Promise.all([
      getProductLookup(pool, companyId, "", { manufacturedOnly: true }),
      getManufacturingBoms(pool, companyId),
      getManufacturingSalesOrderLines(pool, companyId, req),
    ]);

    return res.json({
      ok: true,
      service_cases: serviceCasesRes.rows,
      finished_goods: finishedGoods,
      boms,
      sales_order_lines: salesOrderLines,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-lookup", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const products = await getProductLookup(pool, companyId, q);
    return res.json({ ok: true, products });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const filters = [];
    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    filters.push(`jc.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "job_cards")) {
      params.push(Number(req.user.id));
      filters.push(`jc.created_by = $${params.length}`);
    }
    const where = filters.length ? `where ${filters.join(" and ")}` : "";
    const r = await pool.query(
      `
        select
          jc.id,
          jc.job_card_number,
          jc.job_id,
          jc.job_status,
          jc.job_date,
          jc.job_type,
          jc.service_ticket_id,
          jc.service_ticket_visit_id,
          swc.case_number as service_case_number,
          c.customer_name as service_customer_name,
          st.ticket_number as service_ticket_number,
          stc.customer_name as service_ticket_customer_name,
          so.so_number,
          fg.item_code as finished_good_item_code,
          fg.item_name as finished_good_item_name,
          coalesce((select sum(qty_requested) from job_card_lines where job_card_id = jc.id), 0) as total_requested_qty,
          coalesce((select sum(qty) from job_card_movements where job_card_id = jc.id and movement_type = 'issue'), 0) as total_issued_qty,
          coalesce((select sum(qty) from job_card_movements where job_card_id = jc.id and movement_type = 'return'), 0) as total_returned_qty,
          jc.planned_output_qty,
          jc.actual_output_qty
        from job_cards jc
        left join service_warranty_cases swc on swc.id = jc.service_warranty_case_id
        left join customers c on c.id = swc.customer_id
        left join service_tickets st on st.id = jc.service_ticket_id
        left join customers stc on stc.id = st.customer_id
        left join sales_orders so on so.id = jc.sales_order_id
        left join products fg on fg.id = jc.finished_good_product_id
        ${where}
        order by jc.created_at desc, jc.id desc
      `,
      params
    );
    return res.json({ ok: true, job_cards: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/manufacturing-audit", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "all";
    const mode = typeof req.query.mode === "string" ? req.query.mode.trim().toLowerCase() : "all";
    const exception = typeof req.query.exception === "string" ? req.query.exception.trim().toLowerCase() : "all";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const data = await getManufacturingAuditRows(pool, req, { status, mode, q, exception });
    return res.json({ ok: true, rows: data.rows, summary: data.summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/manufacturing-audit-ids", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "all";
    const mode = typeof req.query.mode === "string" ? req.query.mode.trim().toLowerCase() : "all";
    const exception = typeof req.query.exception === "string" ? req.query.exception.trim().toLowerCase() : "all";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const data = await getManufacturingAuditIds(pool, req, { status, mode, q, exception });
    return res.json({ ok: true, ids: data.ids, limited: data.limited });
  } catch (err) {
    return next(err);
  }
});

router.get("/production-execution-summary", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getProductionExecutionSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/production-execution-queue", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getProductionExecutionQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/fg-receipt-reconciliation-summary", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getFgReceiptReconciliationSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/fg-receipt-reconciliation-queue", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getFgReceiptReconciliationQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/consumption-variance-summary", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getConsumptionVarianceSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/consumption-variance-queue", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getConsumptionVarianceQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/completion-dispatch-readiness-summary", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getCompletionDispatchReadinessSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/completion-dispatch-readiness-queue", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getCompletionDispatchReadinessQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/planning-release-summary", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getPlanningReleaseSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/planning-release-queue", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getPlanningReleaseQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/planning-capacity-summary", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getPlanningCapacitySummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/planning-capacity-queue", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getPlanningCapacityQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/cost-control-summary", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getProductionCostControlSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/cost-control-queue", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getProductionCostControlQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/cost-profile", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const profile = await getProductionCostProfile(pool, companyId);
    return res.json({ ok: true, profile });
  } catch (err) {
    return next(err);
  }
});

router.put("/cost-profile", requireScreenAction("job_cards", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const materialRateBasis =
      typeof body.material_rate_basis === "string" ? body.material_rate_basis.trim().toLowerCase() : "latest_purchase_invoice";
    if (!["latest_purchase_invoice", "purchase_order_estimate"].includes(materialRateBasis)) {
      return res.status(400).json({ ok: false, error: "INVALID_MATERIAL_RATE_BASIS" });
    }
    const defaultLaborHoursPerOutput = money(body.default_labor_hours_per_output || 0);
    const defaultLaborHourRate = money(body.default_labor_hour_rate || 0);
    const defaultOverheadRatePerOutput = money(body.default_overhead_rate_per_output || 0);
    if (defaultLaborHoursPerOutput < 0 || defaultLaborHourRate < 0 || defaultOverheadRatePerOutput < 0) {
      return res.status(400).json({ ok: false, error: "INVALID_COST_PROFILE_VALUES" });
    }
    await client.query(
      `
        insert into production_cost_profiles (
          company_id,
          material_rate_basis,
          default_labor_hours_per_output,
          default_labor_hour_rate,
          default_overhead_rate_per_output,
          remarks,
          updated_by,
          updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,now())
        on conflict (company_id) do update
        set material_rate_basis = excluded.material_rate_basis,
            default_labor_hours_per_output = excluded.default_labor_hours_per_output,
            default_labor_hour_rate = excluded.default_labor_hour_rate,
            default_overhead_rate_per_output = excluded.default_overhead_rate_per_output,
            remarks = excluded.remarks,
            updated_by = excluded.updated_by,
            updated_at = now()
      `,
      [
        Number(companyId),
        materialRateBasis,
        defaultLaborHoursPerOutput,
        defaultLaborHourRate,
        defaultOverheadRatePerOutput,
        normalizeText(body.remarks),
        req.user.id,
      ]
    );
    const profile = await getProductionCostProfile(client, companyId);
    return res.json({ ok: true, profile });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/stores-pending", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const data = await getStoresPendingIssueRows(pool, req, { q });
    return res.json({ ok: true, rows: data.rows, summary: data.summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/stores-pending-ids", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const data = await getStoresPendingIssueIds(pool, req, { q });
    return res.json({ ok: true, ids: data.ids, limited: data.limited });
  } catch (err) {
    return next(err);
  }
});

router.get("/stores-pending-summary", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getStoresPendingIssueSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/stores-shortage-dashboard", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const data = await getStoresShortageDashboard(pool, req, { q, bucket });
    return res.json({ ok: true, rows: data.rows, summary: data.summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/material-readiness-summary", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getMaterialReadinessSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/material-readiness-queue", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 60, 200);
    const rows = await getMaterialReadinessQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/stores-batch-issue-plan", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const ids = parseIdListParam(req.query.ids);
    const data = await getStoresBatchIssuePlan(pool, req, { ids });
    return res.json({ ok: true, jobs: data.jobs, summary: data.summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/bulk-print-html", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const ids = parseIdListParam(req.query.ids);
    const doc = String(req.query.doc || "traveler").trim().toLowerCase();
    if (!ids.length) return res.status(400).json({ ok: false, error: "IDS_REQUIRED" });
    if (!["traveler", "issue_slip"].includes(doc)) return res.status(400).json({ ok: false, error: "INVALID_DOCUMENT" });
    const contexts = await resolveManufacturingPrintContexts(req, ids);
    const html = renderCombinedManufacturingDocumentsHtml(
      doc === "issue_slip" ? "Manufacturing Issue Slip Pack" : "Manufacturing Traveler Pack",
      contexts.map((ctx) => ({
        html: doc === "issue_slip" ? renderManufacturingIssueSlipHtml(ctx.header, ctx.lines) : renderManufacturingTravelerHtml(ctx.header, ctx.lines, ctx.movements),
      }))
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (err) {
    if (err?.message === "PRINT_ONLY_FOR_MANUFACTURING") return res.status(409).json({ ok: false, error: "BULK_PRINT_ONLY_FOR_MANUFACTURING" });
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.message });
    return next(err);
  }
});

router.get("/bulk-print-pdf", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const ids = parseIdListParam(req.query.ids);
    const doc = String(req.query.doc || "traveler").trim().toLowerCase();
    if (!ids.length) return res.status(400).json({ ok: false, error: "IDS_REQUIRED" });
    if (!["traveler", "issue_slip"].includes(doc)) return res.status(400).json({ ok: false, error: "INVALID_DOCUMENT" });
    const contexts = await resolveManufacturingPrintContexts(req, ids);
    const html = renderCombinedManufacturingDocumentsHtml(
      doc === "issue_slip" ? "Manufacturing Issue Slip Pack" : "Manufacturing Traveler Pack",
      contexts.map((ctx) => ({
        html: doc === "issue_slip" ? renderManufacturingIssueSlipHtml(ctx.header, ctx.lines) : renderManufacturingTravelerHtml(ctx.header, ctx.lines, ctx.movements),
      }))
    );
    const artifact = await generateBulkManufacturingPdf({ html, kind: doc === "issue_slip" ? "bulk_issue_slip" : "bulk_traveler" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.fileName}"`);
    return res.status(200).send(artifact.pdf);
  } catch (err) {
    if (err?.message === "PRINT_ONLY_FOR_MANUFACTURING") return res.status(409).json({ ok: false, error: "BULK_PRINT_ONLY_FOR_MANUFACTURING" });
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.message });
    return next(err);
  }
});

router.get("/stores-pick-list", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const ids = parseIdListParam(req.query.ids);
    const groupBy = String(req.query.group_by || "fg").trim().toLowerCase() === "so" ? "so" : "fg";
    const data = await getStoresPickListData(pool, req, { q, ids, groupBy });
    const html = renderStoresPickListHtml(data.groups, {
      groupBy,
      title: groupBy === "so" ? "Stores Pick List By SO" : "Stores Pick List By FG",
      summary: data.summary,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (err) {
    return next(err);
  }
});

router.get("/stores-pick-list-pdf", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const ids = parseIdListParam(req.query.ids);
    const groupBy = String(req.query.group_by || "fg").trim().toLowerCase() === "so" ? "so" : "fg";
    const data = await getStoresPickListData(pool, req, { q, ids, groupBy });
    const html = renderStoresPickListHtml(data.groups, {
      groupBy,
      title: groupBy === "so" ? "Stores Pick List By SO" : "Stores Pick List By FG",
      summary: data.summary,
    });
    const artifact = await generateBulkManufacturingPdf({
      html: buildManufacturingPdfHtml(extractBodyHtml(html)),
      kind: groupBy === "so" ? "stores_pick_list_so" : "stores_pick_list_fg",
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.fileName}"`);
    return res.status(200).send(artifact.pdf);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/traveler", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const { header, lines, movements } = await resolveManufacturingPrintContext(req, id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(renderManufacturingTravelerHtml(header, lines, movements));
  } catch (err) {
    if (err?.message === "PRINT_ONLY_FOR_MANUFACTURING") return res.status(409).json({ ok: false, error: "TRAVELER_ONLY_FOR_MANUFACTURING" });
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.message });
    return next(err);
  }
});

router.get("/:id/issue-slip", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const { header, lines } = await resolveManufacturingPrintContext(req, id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(renderManufacturingIssueSlipHtml(header, lines));
  } catch (err) {
    if (err?.message === "PRINT_ONLY_FOR_MANUFACTURING") return res.status(409).json({ ok: false, error: "ISSUE_SLIP_ONLY_FOR_MANUFACTURING" });
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.message });
    return next(err);
  }
});

router.get("/:id/traveler-pdf", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const { header, lines, movements } = await resolveManufacturingPrintContext(req, id);
    const html = renderManufacturingTravelerHtml(header, lines, movements);
    const artifact = await generateManufacturingDocumentPdf({ header, html, kind: "traveler" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.fileName}"`);
    return res.status(200).send(artifact.pdf);
  } catch (err) {
    if (err?.message === "PRINT_ONLY_FOR_MANUFACTURING") return res.status(409).json({ ok: false, error: "TRAVELER_ONLY_FOR_MANUFACTURING" });
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.message });
    return next(err);
  }
});

router.get("/:id/issue-slip-pdf", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const { header, lines } = await resolveManufacturingPrintContext(req, id);
    const html = renderManufacturingIssueSlipHtml(header, lines);
    const artifact = await generateManufacturingDocumentPdf({ header, html, kind: "issue_slip" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.fileName}"`);
    return res.status(200).send(artifact.pdf);
  } catch (err) {
    if (err?.message === "PRINT_ONLY_FOR_MANUFACTURING") return res.status(409).json({ ok: false, error: "ISSUE_SLIP_ONLY_FOR_MANUFACTURING" });
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.message });
    return next(err);
  }
});

router.post("/", requireScreenAction("job_cards", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const jobType = typeof body.job_type === "string" ? body.job_type.trim().toLowerCase() : "service";
    if (!["service", "installation", "internal_issue", "manufacturing"].includes(jobType)) {
      return res.status(400).json({ ok: false, error: "INVALID_JOB_TYPE" });
    }

    await client.query("begin");
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const numRes = await client.query(`select next_company_document_number($1, 'JCB') as job_card_number`, [companyId]);
    const jobCardNumber = numRes.rows[0]?.job_card_number;
    if (!jobCardNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "NUMBERING_FAILED" });
    }

    let insertValues = {
      jobCardNumber,
      companyId,
      jobDate: body.job_date || null,
      jobType,
      serviceWarrantyCaseId: body.service_warranty_case_id ? Number(body.service_warranty_case_id) : null,
      serviceTicketId: null,
      serviceTicketVisitId: null,
      technicianName: normalizeText(body.technician_name),
      department: normalizeText(body.department),
      siteName: normalizeText(body.site_name),
      remarks: normalizeText(body.remarks),
      createdBy: req.user.id,
      salesOrderId: null,
      salesOrderLineId: null,
      finishedGoodProductId: null,
      bomId: null,
      jobId: null,
      jobPrefix: null,
      plannedOutputQty: 1,
      actualOutputQty: 0,
      finishedGoodReceiptDate: null,
    };

    if (isServiceMrnJobType(jobType) || body.service_ticket_id || body.service_ticket_visit_id) {
      const link = await resolveServiceTicketLink(client, companyId, body.service_ticket_id, body.service_ticket_visit_id);
      insertValues.serviceTicketId = link.serviceTicketId;
      insertValues.serviceTicketVisitId = link.serviceTicketVisitId;
      if (link.ticket && !insertValues.siteName) {
        insertValues.siteName = normalizeText(link.ticket.site_name);
      }
    }

    const preloadLines = [];
    if (jobType === "manufacturing") {
      const ctx = await resolveManufacturingCreateContext(client, companyId, body);
      const seqRes = await client.query(
        `select next_company_running_sequence($1, $2, $3, 4) as job_id`,
        [companyId, `JOBID_${ctx.fg.mfg_job_prefix}`, ctx.fg.mfg_job_prefix]
      );
      const jobId = seqRes.rows[0]?.job_id;
      if (!jobId) {
        await client.query("rollback");
        return res.status(500).json({ ok: false, error: "JOB_ID_NUMBERING_FAILED" });
      }

      insertValues = {
        ...insertValues,
        salesOrderId: ctx.salesOrderId,
        salesOrderLineId: ctx.salesOrderLineId,
        finishedGoodProductId: ctx.finishedGoodProductId,
        bomId: ctx.bomId,
        jobId,
        jobPrefix: ctx.fg.mfg_job_prefix,
        plannedOutputQty: ctx.plannedOutputQty,
        actualOutputQty: ctx.actualOutputQty,
        finishedGoodReceiptDate: body.finished_good_receipt_date || body.job_date || null,
      };

      if (ctx.bomId) {
        const bomLines = await getBomLinesByBomId(client, ctx.bomId);
        for (const line of bomLines) {
          preloadLines.push({
            product_id: Number(line.component_product_id),
            item_code: line.item_code || null,
            item_name: line.item_name || null,
            uom: line.uom || null,
            serial_no_required: line.serial_no_required === true,
            qty_requested: money(qty(line.qty_per) * ctx.plannedOutputQty),
            qty_consumed: 0,
            remarks: normalizeText(line.remarks),
          });
        }
      }
    }

    const insertRes = await client.query(
      `
        insert into job_cards (
          job_card_number,
          company_id,
          job_status,
          job_date,
          job_type,
          service_warranty_case_id,
          service_ticket_id,
          service_ticket_visit_id,
          technician_name,
          department,
          site_name,
          remarks,
          created_by,
          sales_order_id,
          sales_order_line_id,
          finished_good_product_id,
          bom_id,
          job_id,
          job_prefix,
          planned_output_qty,
          actual_output_qty,
          finished_good_receipt_date
        )
        values ($1,$2,'draft',coalesce($3, current_date),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        returning id
      `,
      [
        insertValues.jobCardNumber,
        insertValues.companyId,
        insertValues.jobDate,
        insertValues.jobType,
        insertValues.serviceWarrantyCaseId,
        insertValues.serviceTicketId,
        insertValues.serviceTicketVisitId,
        insertValues.technicianName,
        insertValues.department,
        insertValues.siteName,
        insertValues.remarks,
        insertValues.createdBy,
        insertValues.salesOrderId,
        insertValues.salesOrderLineId,
        insertValues.finishedGoodProductId,
        insertValues.bomId,
        insertValues.jobId,
        insertValues.jobPrefix,
        insertValues.plannedOutputQty,
        insertValues.actualOutputQty,
        insertValues.finishedGoodReceiptDate,
      ]
    );
    const id = insertRes.rows[0]?.id;

    for (let i = 0; i < preloadLines.length; i += 1) {
      const line = preloadLines[i];
      await client.query(
        `
          insert into job_card_lines (
            job_card_id,
            line_no,
            product_id,
            item_code,
            item_name,
            uom,
            serial_no_required,
            qty_requested,
            qty_consumed,
            remarks
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [id, i + 1, line.product_id, line.item_code, line.item_name, line.uom, line.serial_no_required, line.qty_requested, line.qty_consumed, line.remarks]
      );
    }

    await client.query("commit");
    const header = await getJobCardHeaderOrNull(client, id);
    const lines = await getJobCardLines(client, id);
    const movements = await getJobCardMovements(client, id);
    return res.status(201).json({ ok: true, job_card: header, lines, movements });
  } catch (err) {
    await client.query("rollback");
    if (err?.message) {
      const status = Number(err.status || 400);
      if (status >= 400 && status < 500) return res.status(status).json({ ok: false, error: err.message });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/from-service-case/:id", requireScreenAction("job_cards", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const serviceCaseId = Number(req.params.id);
    if (!Number.isFinite(serviceCaseId) || serviceCaseId <= 0) return res.status(400).json({ ok: false, error: "INVALID_SERVICE_CASE" });

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const caseRes = await client.query(`select id, created_by from service_warranty_cases where id = $1 limit 1`, [serviceCaseId]);
    const serviceCase = caseRes.rows[0] || null;
    if (!serviceCase) return res.status(404).json({ ok: false, error: "SERVICE_CASE_NOT_FOUND" });
    if (ownRecordsOnly(req, "job_cards") && req.user.group_name !== "SuperAdmin" && Number(serviceCase.created_by) !== Number(req.user.id)) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const body = { ...(req.body || {}), service_warranty_case_id: serviceCaseId };
    const jobType = typeof body.job_type === "string" ? body.job_type.trim().toLowerCase() : "service";
    if (!["service", "installation", "internal_issue"].includes(jobType)) {
      return res.status(400).json({ ok: false, error: "INVALID_JOB_TYPE" });
    }

    await client.query("begin");
    const numRes = await client.query(`select next_company_document_number($1, 'JCB') as job_card_number`, [companyId]);
    const jobCardNumber = numRes.rows[0]?.job_card_number;
    const insertRes = await client.query(
      `
        insert into job_cards (
          job_card_number,
          company_id,
          job_status,
          job_date,
          job_type,
          service_warranty_case_id,
          technician_name,
          department,
          site_name,
          remarks,
          created_by
        )
        values ($1,$2,'draft',coalesce($3, current_date),$4,$5,$6,$7,$8,$9,$10)
        returning id
      `,
      [
        jobCardNumber,
        companyId,
        body.job_date || null,
        jobType,
        serviceCaseId,
        normalizeText(body.technician_name),
        normalizeText(body.department),
        normalizeText(body.site_name),
        normalizeText(body.remarks),
        req.user.id,
      ]
    );
    const id = insertRes.rows[0]?.id;
    await client.query("commit");
    const header = await getJobCardHeaderOrNull(client, id);
    const lines = await getJobCardLines(client, id);
    const movements = await getJobCardMovements(client, id);
    return res.status(201).json({ ok: true, job_card: header, lines, movements });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/from-service-ticket/:id", requireScreenAction("job_cards", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const serviceTicketId = Number(req.params.id);
    if (!Number.isFinite(serviceTicketId) || serviceTicketId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_SERVICE_TICKET" });
    }

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const link = await resolveServiceTicketLink(client, companyId, serviceTicketId, body.service_ticket_visit_id || body.visit_id);
    if (ownRecordsOnly(req, "job_cards") && req.user.group_name !== "SuperAdmin" && Number(link.ticket.created_by) !== Number(req.user.id)) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const complaintType = String(link.ticket.complaint_type || "").toLowerCase();
    const defaultJobType = complaintType === "installation" || complaintType === "commissioning" ? "installation" : "service";
    const jobType = typeof body.job_type === "string" ? body.job_type.trim().toLowerCase() : defaultJobType;
    if (!["service", "installation"].includes(jobType)) {
      return res.status(400).json({ ok: false, error: "INVALID_JOB_TYPE" });
    }

    const requestedStatus = typeof body.job_status === "string" ? body.job_status.trim().toLowerCase() : "submitted";
    const jobStatus = ["draft", "submitted"].includes(requestedStatus) ? requestedStatus : "submitted";

    await client.query("begin");
    const numRes = await client.query(`select next_company_document_number($1, 'JCB') as job_card_number`, [companyId]);
    const jobCardNumber = numRes.rows[0]?.job_card_number;
    if (!jobCardNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "NUMBERING_FAILED" });
    }

    const insertRes = await client.query(
      `
        insert into job_cards (
          job_card_number,
          company_id,
          job_status,
          job_date,
          job_type,
          service_ticket_id,
          service_ticket_visit_id,
          technician_name,
          department,
          site_name,
          remarks,
          created_by
        )
        values ($1,$2,$3,coalesce($4, current_date),$5,$6,$7,$8,$9,$10,$11,$12)
        returning id
      `,
      [
        jobCardNumber,
        companyId,
        jobStatus,
        body.job_date || null,
        jobType,
        link.serviceTicketId,
        link.serviceTicketVisitId,
        normalizeText(body.technician_name),
        normalizeText(body.department),
        normalizeText(body.site_name) || normalizeText(link.ticket.site_name),
        normalizeText(body.remarks) || `MRN for service ticket ${link.ticket.ticket_number}`,
        req.user.id,
      ]
    );
    const id = insertRes.rows[0]?.id;
    await client.query("commit");
    const header = await getJobCardHeaderOrNull(client, id);
    const lines = await getJobCardLines(client, id);
    const movements = await getJobCardMovements(client, id);
    return res.status(201).json({ ok: true, job_card: header, lines, movements });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.message) {
      const status = Number(err.status || 400);
      if (status >= 400 && status < 500) return res.status(status).json({ ok: false, error: err.message });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const header = await getJobCardHeaderOrNull(pool, id);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessJobCard(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, header)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    const [lines, movements, shortageActions] = await Promise.all([
      getJobCardLines(pool, id),
      getJobCardMovements(pool, id),
      getJobCardShortageActions(pool, id),
    ]);
    return res.json({ ok: true, job_card: header, lines, movements, shortage_actions: shortageActions });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/costing", requireScreenAction("job_cards", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const header = await getJobCardHeaderOrNull(pool, id);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessJobCard(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, header)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    const [profile, costRow] = await Promise.all([
      getProductionCostProfile(pool, header.company_id),
      queryProductionCostRows(pool, req, { jobCardId: id, limit: 1 }),
    ]);
    return res.json({ ok: true, profile, costing: costRow[0] || null });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id/costing", requireScreenAction("job_cards", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const actualLaborHours = money(body.actual_labor_hours || 0);
    const laborHourRate = money(body.labor_hour_rate || 0);
    const overheadAbsorptionAmount = money(body.overhead_absorption_amount || 0);
    if (actualLaborHours < 0 || laborHourRate < 0 || overheadAbsorptionAmount < 0) {
      return res.status(400).json({ ok: false, error: "INVALID_COST_VALUES" });
    }
    await client.query("begin");
    const header = await getJobCardHeaderOrNull(client, id);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessJobCard(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (String(header.job_type || "").toLowerCase() !== "manufacturing") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "COSTING_ONLY_FOR_MANUFACTURING" });
    }
    await client.query(
      `
        update job_cards
        set actual_labor_hours = $2,
            labor_hour_rate = $3,
            overhead_absorption_amount = $4,
            updated_at = now()
        where id = $1
      `,
      [id, actualLaborHours, laborHourRate, overheadAbsorptionAmount]
    );
    await client.query("commit");
    const [profile, costRow] = await Promise.all([
      getProductionCostProfile(client, header.company_id),
      queryProductionCostRows(client, req, { jobCardId: id, limit: 1 }),
    ]);
    return res.json({ ok: true, profile, costing: costRow[0] || null });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/shortage-actions", requireScreenAction("job_cards", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const lineId = Number(body.job_card_line_id || body.line_id);
    const actionType = typeof body.action_type === "string" ? body.action_type.trim().toLowerCase() : "";
    const shortageQtyRaw = body.shortage_qty;
    const shortageQty =
      shortageQtyRaw === "" || shortageQtyRaw === null || shortageQtyRaw === undefined ? null : money(shortageQtyRaw);
    if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ ok: false, error: "INVALID_LINE_ID" });
    if (!["shortage_reported", "blocked", "follow_up", "resolved"].includes(actionType)) {
      return res.status(400).json({ ok: false, error: "INVALID_SHORTAGE_ACTION_TYPE" });
    }
    if (shortageQty !== null && shortageQty < 0) return res.status(400).json({ ok: false, error: "INVALID_SHORTAGE_QTY" });

    await client.query("begin");
    const header = await getJobCardHeaderOrNull(client, id);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessJobCard(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (String(header.job_type || "").toLowerCase() !== "manufacturing" && !isServiceMrnJobType(header.job_type)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "SHORTAGE_ONLY_FOR_MANUFACTURING_OR_SERVICE_MRN" });
    }
    if (!["draft", "open", "submitted", "approved"].includes(String(header.job_status || "").toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "JOB_CARD_NOT_OPEN" });
    }

    const lines = await getJobCardLines(client, id);
    const line = lines.find((row) => Number(row.id) === lineId);
    if (!line) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "LINE_NOT_FOUND" });
    }

    const pendingQty = money(money(line.qty_requested) - money(line.qty_issued) + money(line.qty_returned));
    if (pendingQty <= 0) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NO_PENDING_STORES_QTY" });
    }
    if (shortageQty !== null && shortageQty > pendingQty) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "SHORTAGE_QTY_EXCEEDS_PENDING" });
    }

    await client.query(
      `
        insert into job_card_line_shortage_actions (
          job_card_id,
          job_card_line_id,
          action_type,
          action_date,
          shortage_qty,
          reference_no,
          expected_date,
          remarks,
          created_by,
          updated_at
        )
        values ($1,$2,$3,coalesce($4, current_date),$5,$6,$7,$8,$9,now())
      `,
      [
        id,
        lineId,
        actionType,
        body.action_date || null,
        shortageQty,
        normalizeText(body.reference_no),
        normalizeText(body.expected_date),
        normalizeText(body.remarks),
        req.user.id,
      ]
    );

    await client.query(`update job_cards set updated_at = now() where id = $1`, [id]);
    await client.query("commit");

    const [nextHeader, nextLines, shortageActions] = await Promise.all([
      getJobCardHeaderOrNull(client, id),
      getJobCardLines(client, id),
      getJobCardShortageActions(client, id),
    ]);
    return res.status(201).json({ ok: true, job_card: nextHeader, lines: nextLines, shortage_actions: shortageActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id", requireScreenAction("job_cards", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const jobStatus = typeof body.job_status === "string" ? body.job_status.trim().toLowerCase() : "draft";
    const jobType = typeof body.job_type === "string" ? body.job_type.trim().toLowerCase() : "service";
    if (!["draft", "open", "closed", "cancelled", "submitted", "approved", "posted"].includes(jobStatus)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }
    if (!["service", "installation", "internal_issue", "manufacturing"].includes(jobType)) {
      return res.status(400).json({ ok: false, error: "INVALID_JOB_TYPE" });
    }

    await client.query("begin");
    const header = await getJobCardHeaderOrNull(client, id);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessJobCard(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const currentStatus = String(header.job_status || "").toLowerCase();
    if (
      jobStatus === "approved" &&
      currentStatus !== "approved" &&
      isServiceMrnJobType(jobType || header.job_type) &&
      !hasScreenAction(req, "job_cards", "can_approve")
    ) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "APPROVAL_FORBIDDEN" });
    }

    const editingLines = Array.isArray(body.lines);
    if (editingLines && ["closed", "cancelled", "posted"].includes(currentStatus)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "JOB_CARD_NOT_EDITABLE" });
    }

    let manufacturingUpdate = {
      salesOrderId: header.sales_order_id ? Number(header.sales_order_id) : null,
      salesOrderLineId: header.sales_order_line_id ? Number(header.sales_order_line_id) : null,
      finishedGoodProductId: header.finished_good_product_id ? Number(header.finished_good_product_id) : null,
      bomId: header.bom_id ? Number(header.bom_id) : null,
      plannedOutputQty: money(header.planned_output_qty || 1),
      actualOutputQty: money(header.actual_output_qty || 0),
      finishedGoodReceiptDate: body.finished_good_receipt_date || header.finished_good_receipt_date || null,
    };

    if (jobType === "manufacturing") {
      if (body.sales_order_line_id || body.finished_good_product_id || body.bom_id || body.planned_output_qty || body.actual_output_qty || header.job_type !== "manufacturing") {
        const ctx = await resolveManufacturingCreateContext(client, Number(header.company_id), {
          sales_order_line_id: body.sales_order_line_id || header.sales_order_line_id,
          finished_good_product_id: body.finished_good_product_id || header.finished_good_product_id,
          bom_id: body.bom_id || header.bom_id,
          planned_output_qty: body.planned_output_qty ?? header.planned_output_qty,
          actual_output_qty: body.actual_output_qty ?? header.actual_output_qty,
        });
        manufacturingUpdate = {
          salesOrderId: ctx.salesOrderId,
          salesOrderLineId: ctx.salesOrderLineId,
          finishedGoodProductId: ctx.finishedGoodProductId,
          bomId: ctx.bomId,
          plannedOutputQty: ctx.plannedOutputQty,
          actualOutputQty: ctx.actualOutputQty,
          finishedGoodReceiptDate: body.finished_good_receipt_date || header.finished_good_receipt_date || null,
        };
      }
    } else {
      manufacturingUpdate = {
        salesOrderId: null,
        salesOrderLineId: null,
        finishedGoodProductId: null,
        bomId: null,
        plannedOutputQty: 1,
        actualOutputQty: 0,
        finishedGoodReceiptDate: null,
      };
    }

    await client.query(
      `
        update job_cards
        set job_status = $2,
            job_date = coalesce($3, job_date),
            job_type = $4,
            technician_name = $5,
            department = $6,
            site_name = $7,
            remarks = $8,
            sales_order_id = $9,
            sales_order_line_id = $10,
            finished_good_product_id = $11,
            bom_id = $12,
            planned_output_qty = $13,
            actual_output_qty = $14,
            finished_good_receipt_date = $15,
            updated_at = now()
        where id = $1
      `,
      [
        id,
        jobStatus,
        body.job_date || null,
        jobType,
        normalizeText(body.technician_name),
        normalizeText(body.department),
        normalizeText(body.site_name),
        normalizeText(body.remarks),
        manufacturingUpdate.salesOrderId,
        manufacturingUpdate.salesOrderLineId,
        manufacturingUpdate.finishedGoodProductId,
        manufacturingUpdate.bomId,
        manufacturingUpdate.plannedOutputQty,
        manufacturingUpdate.actualOutputQty,
        manufacturingUpdate.finishedGoodReceiptDate,
      ]
    );

    if (editingLines) {
      const normalized = await normalizeJobCardLines(client, body.lines);
      await client.query(`delete from job_card_movement_serials where job_card_movement_id in (select id from job_card_movements where job_card_id = $1)`, [id]);
      await client.query(`delete from job_card_movements where job_card_id = $1`, [id]);
      await client.query(`delete from job_card_lines where job_card_id = $1`, [id]);

      for (const line of normalized) {
        await client.query(
          `
            insert into job_card_lines (
              job_card_id,
              line_no,
              product_id,
              item_code,
              item_name,
              uom,
              serial_no_required,
              qty_requested,
              qty_consumed,
              remarks
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          `,
          [id, line.line_no, line.product_id, line.item_code, line.item_name, line.uom, line.serial_no_required, line.qty_requested, line.qty_consumed, line.remarks]
        );
      }
    }

    const companyId = Number(header.company_id) || null;
    await syncStockForJobCard(client, companyId, id);

    const nextLines = await getJobCardLines(client, id);
    const invalidConsumed = nextLines.find((line) => money(line.qty_consumed) > money(line.qty_outstanding));
    if (invalidConsumed) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "CONSUMPTION_EXCEEDS_OUTSTANDING" });
    }

    await client.query("commit");
    const nextHeader = await getJobCardHeaderOrNull(client, id);
    const movements = await getJobCardMovements(client, id);
    return res.json({ ok: true, job_card: nextHeader, lines: nextLines, movements });
  } catch (err) {
    await client.query("rollback");
    if (err?.message) {
      const status = Number(err.status || 400);
      if (status >= 400 && status < 500) return res.status(status).json({ ok: false, error: err.message });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/movements", requireScreenAction("job_cards", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const lineId = Number(body.job_card_line_id || body.line_id);
    const movementType = typeof body.movement_type === "string" ? body.movement_type.trim().toLowerCase() : "";
    const movementQty = money(body.qty);
    if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ ok: false, error: "INVALID_LINE_ID" });
    if (!["issue", "return"].includes(movementType)) return res.status(400).json({ ok: false, error: "INVALID_MOVEMENT_TYPE" });
    if (movementQty <= 0) return res.status(400).json({ ok: false, error: "INVALID_QTY" });

    await client.query("begin");
    const header = await getJobCardHeaderOrNull(client, id);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessJobCard(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!["draft", "open", "submitted", "approved"].includes(String(header.job_status || "").toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "JOB_CARD_NOT_OPEN" });
    }
    if (
      movementType === "issue" &&
      isServiceMrnJobType(header.job_type) &&
      !isStoresIssueAllowedStatus(header.job_status)
    ) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ISSUE_REQUIRES_APPROVAL" });
    }

    const lines = await getJobCardLines(client, id);
    const line = lines.find((row) => Number(row.id) === lineId);
    if (!line) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "LINE_NOT_FOUND" });
    }

    if (movementType === "issue" && money(line.qty_requested) > 0 && money(line.qty_issued + movementQty) > money(line.qty_requested)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "ISSUE_EXCEEDS_REQUESTED" });
    }
    if (movementType === "return" && money(movementQty) > money(line.qty_outstanding)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "RETURN_EXCEEDS_OUTSTANDING" });
    }

    const rawSerials = Array.isArray(body.serials) ? body.serials : [];
    const serials = rawSerials.map((item) => String(item || "").trim()).filter(Boolean);
    if (new Set(serials).size !== serials.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DUPLICATE_SERIALS" });
    }
    if (line.serial_no_required === true) {
      if (!isIntLike(movementQty)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "SERIAL_QTY_NOT_INTEGER" });
      }
      if (serials.length !== Number(movementQty)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "SERIAL_COUNT_MISMATCH" });
      }
    }

    const insertMove = await client.query(
      `
        insert into job_card_movements (
          job_card_id,
          job_card_line_id,
          movement_type,
          movement_date,
          qty,
          reference_no,
          remarks,
          created_by
        )
        values ($1,$2,$3,coalesce($4, current_date),$5,$6,$7,$8)
        returning id
      `,
      [id, lineId, movementType, body.movement_date || null, movementQty, normalizeText(body.reference_no), normalizeText(body.remarks), req.user.id]
    );
    const movementId = insertMove.rows[0]?.id;
    for (const serialNo of serials) {
      await client.query(`insert into job_card_movement_serials (job_card_movement_id, serial_no) values ($1,$2)`, [movementId, serialNo]);
    }

    const companyId = Number(header.company_id) || null;
    await syncStockForJobCard(client, companyId, id);

    const nextLines = await getJobCardLines(client, id);
    const invalidConsumed = nextLines.find((row) => money(row.qty_consumed) > money(row.qty_outstanding));
    if (invalidConsumed) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "CONSUMPTION_EXCEEDS_OUTSTANDING" });
    }

    await client.query("commit");
    const nextHeader = await getJobCardHeaderOrNull(client, id);
    const movements = await getJobCardMovements(client, id);
    return res.status(201).json({ ok: true, job_card: nextHeader, lines: nextLines, movements });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_SERIALS" });
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
