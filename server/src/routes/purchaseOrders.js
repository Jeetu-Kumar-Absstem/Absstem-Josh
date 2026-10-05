const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { evaluateApprovalPermission, formatPolicyScope, insertApprovalHistory, resolveApprovalState } = require("../services/approvalPolicy");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");
const { createVendorQuick } = require("../services/createVendorQuick");
const { assertVendorApprovedForProducts } = require("../services/componentAvl");
const {
  getPurchaseOrderLandedCostPreview,
  snapshotPurchaseOrderLandedCost,
} = require("../services/landedCost");
const { assertVendorCompliance } = require("../services/vendorPortal");
const { syncLegacySoNumberSequence } = require("../services/legacySoNumbering");

const router = express.Router();

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(value) {
  const n = num(value, 0);
  return Math.round(n * 100) / 100;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value, fallback = 100, max = 300) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function calcTotals(lines) {
  let subtotal = 0;
  let taxTotal = 0;

  for (const line of lines) {
    const qty = num(line.qty, 0);
    const unit = num(line.unit_price_order, 0);
    const gst = num(line.gst_pct, 0);
    const lineSubtotal = money(qty * unit);
    const lineTax = money(lineSubtotal * (gst / 100));
    subtotal += lineSubtotal;
    taxTotal += lineTax;
  }

  subtotal = money(subtotal);
  taxTotal = money(taxTotal);
  const grandTotal = money(subtotal + taxTotal);

  return { subtotal, taxTotal, grandTotal };
}

function canAccessPurchaseOrder(req, order) {
  if (!order) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "purchase_orders")) return true;
  return Number(order.created_by) === Number(req.user.id);
}

async function getApprovalPreview(client, req, order, companyId) {
  if (!order) return null;
  const state = await resolveApprovalState(
    client,
    "purchase_order",
    {
      id: order.id,
      company_id: order.company_id || companyId,
      vendor_id: order.vendor_id,
      total_amount: order.grand_total_order,
      current_approval_level: order.current_approval_level,
      required_approval_level: order.required_approval_level,
      doc_status: order.po_status,
      doc_number: order.po_number,
      doc_date: order.po_date,
    },
    companyId
  );
  const fallbackCanApprove = req.user?.group_name === "SuperAdmin" || hasScreenAction(req, "purchase_orders", "can_approve");
  const decision = evaluateApprovalPermission({
    user: req.user,
    state,
    fallbackCanApprove,
  });
  const normalizedStatus = String(order.po_status || "").toLowerCase();
  return {
    current_level: state.currentLevel,
    required_level: state.requiredLevel,
    next_level: state.requiredLevel > 0 && normalizedStatus === "submitted" ? state.nextLevel : 0,
    next_approver:
      normalizedStatus !== "submitted"
        ? "Submit first"
        : state.nextPolicy
          ? formatPolicyScope(state.nextPolicy)
          : state.requiredLevel > 0
            ? "Final approval"
            : fallbackCanApprove
              ? "Screen approver"
              : "—",
    can_current_user_approve: Boolean(decision.allowed) && normalizedStatus === "submitted",
    can_manage_post_approval: Boolean(fallbackCanApprove),
    requires_policy: state.requiredLevel > 0,
  };
}

async function getDefaultCurrencyId(client) {
  const r = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
  const id = Number(r.rows[0]?.id);
  if (Number.isFinite(id) && id > 0) return id;
  const fallback = await client.query(`select id from currencies where is_active = true order by currency_code asc limit 1`);
  const fallbackId = Number(fallback.rows[0]?.id);
  return Number.isFinite(fallbackId) && fallbackId > 0 ? fallbackId : null;
}

async function getPurchaseOrderHeaderOrNull(client, purchaseOrderId, companyId) {
  const r = await client.query(
    `
      select
        po.*,
        pr.requisition_number,
        v.vendor_code,
        v.company_name as vendor_name,
        soic.so_number as intercompany_sales_order_number,
        cco.company_code as intercompany_company_code,
        cco.display_name as intercompany_company_name,
        base.currency_code as base_currency_code,
        ord.currency_code as order_currency_code
      from purchase_orders po
      left join purchase_requisitions pr on pr.id = po.purchase_requisition_id
      join vendors v on v.id = po.vendor_id
      left join sales_orders soic on soic.id = po.intercompany_sales_order_id
      left join companies cco on cco.id = po.intercompany_counterparty_company_id
      left join currencies base on base.id = po.base_currency_id
      left join currencies ord on ord.id = po.order_currency_id
      where po.id = $1 and po.company_id = $2
      limit 1
    `,
    [purchaseOrderId, Number(companyId)]
  );
  return r.rows[0] || null;
}

function userCanAccessCompanyId(req, companyId) {
  if (!companyId) return false;
  if (req.user?.group_name === "SuperAdmin") return true;
  const companies = Array.isArray(req.user?.companies) ? req.user.companies : [];
  return companies.some((c) => Number(c.company_id) === Number(companyId));
}

async function getIntercompanyPartnerByVendor(client, companyId, vendorId) {
  const r = await client.query(
    `
      select *
      from intercompany_partners
      where company_id = $1
        and vendor_id = $2
        and is_active = true
      order by id asc
      limit 1
    `,
    [Number(companyId), Number(vendorId)]
  );
  return r.rows[0] || null;
}

async function getIntercompanyPartnerByCustomer(client, companyId, counterpartyCompanyId) {
  const r = await client.query(
    `
      select *
      from intercompany_partners
      where company_id = $1
        and counterparty_company_id = $2
        and customer_id is not null
        and is_active = true
      order by id asc
      limit 1
    `,
    [Number(companyId), Number(counterpartyCompanyId)]
  );
  return r.rows[0] || null;
}

async function getPurchaseOrderLines(client, purchaseOrderId) {
  const r = await client.query(
    `
      select
        pol.*,
        pg.group_name as product_group_name
      from purchase_order_lines pol
      left join products p on p.id = pol.product_id
      left join product_groups pg on pg.id = p.group_id
      where pol.purchase_order_id = $1
      order by pol.line_no asc
    `,
    [purchaseOrderId]
  );
  return r.rows;
}

async function getApprovedRequisitions(client, companyId) {
  const r = await client.query(
    `
      with ordered_qty as (
        select
          pol.purchase_requisition_line_id,
          sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
        from purchase_order_lines pol
        join purchase_orders po on po.id = pol.purchase_order_id
        where pol.purchase_requisition_line_id is not null
        group by pol.purchase_requisition_line_id
      ),
      pending as (
        select
          pr.id,
          pr.requisition_number,
          pr.department,
          pr.purpose,
          pr.required_by_date,
          count(*) filter (where prl.qty_requested - coalesce(oq.qty_ordered, 0) > 0.0001) as pending_lines,
          sum(greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0)) as pending_qty
        from purchase_requisitions pr
        join purchase_requisition_lines prl on prl.purchase_requisition_id = pr.id
        left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
        where pr.company_id = $1
          and pr.requisition_status in ('approved', 'closed')
        group by pr.id, pr.requisition_number, pr.department, pr.purpose, pr.required_by_date
      )
      select *
      from pending
      where pending_lines > 0
      order by required_by_date nulls last, requisition_number asc
    `,
    [Number(companyId)]
  );
  return r.rows;
}

async function getProcurementExceptionsSummary(client, req, companyId) {
  const shortageParams = [Number(companyId)];
  const shortageWhere = [`jc.company_id = $1`, `coalesce(jsa.action_type, '') <> 'resolved'`, `prl.id is null`];
  if (ownRecordsOnly(req, "purchase_requisitions")) {
    shortageParams.push(Number(req.user.id));
    shortageWhere.push(`jc.created_by = $${shortageParams.length}`);
  }

  const requisitionParams = [Number(companyId)];
  const requisitionWhere = [`pr.company_id = $1`];
  if (ownRecordsOnly(req, "purchase_requisitions")) {
    requisitionParams.push(Number(req.user.id));
    requisitionWhere.push(`pr.created_by = $${requisitionParams.length}`);
  }

  const poParams = [Number(companyId)];
  const poWhere = [`po.company_id = $1`];
  if (ownRecordsOnly(req, "purchase_orders")) {
    poParams.push(Number(req.user.id));
    poWhere.push(`po.created_by = $${poParams.length}`);
  }

  const [shortageRes, requisitionRes, poRes] = await Promise.all([
    client.query(
      `
        select
          count(*)::int as shortage_not_raised_count,
          coalesce(sum(greatest(coalesce(jsa.shortage_qty, 0), 0)), 0) as shortage_not_raised_qty
        from job_card_line_shortage_actions jsa
        join job_cards jc on jc.id = jsa.job_card_id
        left join purchase_requisition_lines prl on prl.source_shortage_action_id = jsa.id
        where ${shortageWhere.join(" and ")}
      `,
      shortageParams
    ),
    client.query(
      `
        with ordered_qty as (
          select
            pol.purchase_requisition_line_id,
            sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
          from purchase_order_lines pol
          join purchase_orders po on po.id = pol.purchase_order_id
          where pol.purchase_requisition_line_id is not null
          group by pol.purchase_requisition_line_id
        ),
        req_totals as (
          select
            pr.id,
            pr.requisition_status,
            greatest((current_date - pr.requisition_date::date), 0)::int as ageing_days,
            count(*) filter (where greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0) > 0.0001)::int as pending_lines,
            coalesce(sum(greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0)), 0) as pending_qty
          from purchase_requisitions pr
          join purchase_requisition_lines prl on prl.purchase_requisition_id = pr.id
          left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
          where ${requisitionWhere.join(" and ")}
          group by pr.id
        )
        select
          count(*) filter (where requisition_status = 'submitted')::int as pr_submitted_count,
          count(*) filter (where requisition_status = 'submitted' and ageing_days > 2)::int as pr_approval_aged_count,
          count(*) filter (where requisition_status in ('approved', 'closed') and pending_qty > 0.0001)::int as pr_not_ordered_count,
          coalesce(sum(case when requisition_status in ('approved', 'closed') and pending_qty > 0.0001 then pending_qty else 0 end), 0) as pr_not_ordered_qty
        from req_totals
      `,
      requisitionParams
    ),
    client.query(
      `
        with received_qty as (
          select
            grl.purchase_order_line_id,
            coalesce(sum(case when gr.receipt_status <> 'cancelled' then grl.qty_received else 0 end), 0) as qty_received
          from goods_receipt_lines grl
          join goods_receipts gr on gr.id = grl.goods_receipt_id
          where grl.purchase_order_line_id is not null
          group by grl.purchase_order_line_id
        ),
        po_totals as (
          select
            po.id,
            po.po_status,
            greatest((current_date - po.po_date::date), 0)::int as ageing_days,
            coalesce(sum(pol.qty), 0) as ordered_qty,
            coalesce(sum(coalesce(rq.qty_received, 0)), 0) as received_qty,
            coalesce(sum(greatest(pol.qty - coalesce(rq.qty_received, 0), 0)), 0) as pending_qty,
            coalesce(sum(
              case
                when pol.promised_date is not null
                  and pol.promised_date < current_date
                  and greatest(pol.qty - coalesce(rq.qty_received, 0), 0) > 0.0001
                then greatest(pol.qty - coalesce(rq.qty_received, 0), 0)
                else 0
              end
            ), 0) as promise_overdue_qty,
            bool_or(
              pol.promised_date is not null
              and pol.promised_date < current_date
              and greatest(pol.qty - coalesce(rq.qty_received, 0), 0) > 0.0001
            ) as has_promise_overdue
          from purchase_orders po
          join purchase_order_lines pol on pol.purchase_order_id = po.id
          left join received_qty rq on rq.purchase_order_line_id = pol.id
          where ${poWhere.join(" and ")}
          group by po.id
        )
        select
          count(*) filter (where po_status = 'submitted')::int as po_submitted_count,
          count(*) filter (where po_status = 'submitted' and ageing_days > 2)::int as po_approval_aged_count,
          count(*) filter (where po_status in ('approved', 'closed') and pending_qty > 0.0001)::int as po_pending_receipt_count,
          coalesce(sum(case when po_status in ('approved', 'closed') and pending_qty > 0.0001 then pending_qty else 0 end), 0) as po_pending_receipt_qty,
          count(*) filter (where po_status in ('approved', 'closed') and received_qty > 0.0001 and pending_qty > 0.0001)::int as po_partial_supply_count,
          coalesce(sum(case when po_status in ('approved', 'closed') and received_qty > 0.0001 and pending_qty > 0.0001 then pending_qty else 0 end), 0) as po_partial_supply_qty,
          count(*) filter (where po_status in ('approved', 'closed') and has_promise_overdue)::int as po_promise_overdue_count,
          coalesce(sum(case when po_status in ('approved', 'closed') and has_promise_overdue then promise_overdue_qty else 0 end), 0) as po_promise_overdue_qty
        from po_totals
      `,
      poParams
    ),
  ]);

  const shortage = shortageRes.rows[0] || {};
  const requisition = requisitionRes.rows[0] || {};
  const po = poRes.rows[0] || {};

  return {
    shortage_not_raised_count: Number(shortage.shortage_not_raised_count || 0),
    shortage_not_raised_qty: money(shortage.shortage_not_raised_qty),
    pr_submitted_count: Number(requisition.pr_submitted_count || 0),
    pr_approval_aged_count: Number(requisition.pr_approval_aged_count || 0),
    pr_not_ordered_count: Number(requisition.pr_not_ordered_count || 0),
    pr_not_ordered_qty: money(requisition.pr_not_ordered_qty),
    po_submitted_count: Number(po.po_submitted_count || 0),
    po_approval_aged_count: Number(po.po_approval_aged_count || 0),
    po_pending_receipt_count: Number(po.po_pending_receipt_count || 0),
    po_pending_receipt_qty: money(po.po_pending_receipt_qty),
    po_partial_supply_count: Number(po.po_partial_supply_count || 0),
    po_partial_supply_qty: money(po.po_partial_supply_qty),
    po_promise_overdue_count: Number(po.po_promise_overdue_count || 0),
    po_promise_overdue_qty: money(po.po_promise_overdue_qty),
  };
}

async function getExternalProcessingControlSummary(client, req, companyId) {
  const requisitionParams = [Number(companyId)];
  const requisitionWhere = [`pr.company_id = $1`];
  if (ownRecordsOnly(req, "purchase_requisitions")) {
    requisitionParams.push(Number(req.user.id));
    requisitionWhere.push(`pr.created_by = $${requisitionParams.length}`);
  }

  const poParams = [Number(companyId)];
  const poWhere = [`po.company_id = $1`];
  if (ownRecordsOnly(req, "purchase_orders")) {
    poParams.push(Number(req.user.id));
    poWhere.push(`po.created_by = $${poParams.length}`);
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

  const [reqRes, poRes, qcRes, claimRes] = await Promise.all([
    client.query(
      `
        with ordered_qty as (
          select
            pol.purchase_requisition_line_id,
            sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
          from purchase_order_lines pol
          join purchase_orders po on po.id = pol.purchase_order_id
          where pol.purchase_requisition_line_id is not null
          group by pol.purchase_requisition_line_id
        ),
        req_totals as (
          select
            pr.id,
            count(*) filter (where prl.source_shortage_action_id is not null)::int as shortage_linked_lines,
            coalesce(sum(greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0)), 0) as pending_qty
          from purchase_requisitions pr
          join purchase_requisition_lines prl on prl.purchase_requisition_id = pr.id
          left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
          where ${requisitionWhere.join(" and ")}
            and pr.requisition_status in ('approved', 'closed')
          group by pr.id
        )
        select
          count(*) filter (where shortage_linked_lines > 0 and pending_qty > 0.0001)::int as count,
          coalesce(sum(case when shortage_linked_lines > 0 and pending_qty > 0.0001 then pending_qty else 0 end), 0) as qty
        from req_totals
      `,
      requisitionParams
    ),
    client.query(
      `
        with received_qty as (
          select
            grl.purchase_order_line_id,
            coalesce(sum(case when gr.receipt_status <> 'cancelled' then grl.qty_received else 0 end), 0) as qty_received
          from goods_receipt_lines grl
          join goods_receipts gr on gr.id = grl.goods_receipt_id
          where grl.purchase_order_line_id is not null
          group by grl.purchase_order_line_id
        ),
        po_totals as (
          select
            po.id,
            count(*) filter (where prl.source_shortage_action_id is not null)::int as shortage_linked_lines,
            coalesce(sum(pol.qty), 0) as ordered_qty,
            coalesce(sum(coalesce(rq.qty_received, 0)), 0) as received_qty,
            coalesce(sum(greatest(pol.qty - coalesce(rq.qty_received, 0), 0)), 0) as pending_qty
          from purchase_orders po
          join purchase_order_lines pol on pol.purchase_order_id = po.id
          left join purchase_requisition_lines prl on prl.id = pol.purchase_requisition_line_id
          left join received_qty rq on rq.purchase_order_line_id = pol.id
          where ${poWhere.join(" and ")}
            and po.po_status in ('approved', 'closed')
          group by po.id
        )
        select
          count(*) filter (where shortage_linked_lines > 0 and pending_qty > 0.0001)::int as in_flight_count,
          coalesce(sum(case when shortage_linked_lines > 0 and pending_qty > 0.0001 then pending_qty else 0 end), 0) as in_flight_qty,
          count(*) filter (where shortage_linked_lines > 0 and received_qty > 0.0001 and pending_qty > 0.0001)::int as partial_count,
          coalesce(sum(case when shortage_linked_lines > 0 and received_qty > 0.0001 and pending_qty > 0.0001 then pending_qty else 0 end), 0) as partial_qty
        from po_totals
      `,
      poParams
    ),
    client.query(
      `
        with qc_totals as (
          select
            qc.id,
            coalesce(sum(greatest(qcl.qty_on_hold - qcl.qty_replaced - qcl.qty_reworked - qcl.qty_accepted_after_hold, 0)), 0) as pending_hold_qty
          from quality_controls qc
          join quality_control_lines qcl on qcl.quality_control_id = qc.id
          join goods_receipt_lines grl on grl.id = qcl.goods_receipt_line_id
          join purchase_order_lines pol on pol.id = grl.purchase_order_line_id
          join purchase_requisition_lines prl on prl.id = pol.purchase_requisition_line_id
          where ${qcWhere.join(" and ")}
            and prl.source_shortage_action_id is not null
          group by qc.id
        )
        select
          count(*) filter (where pending_hold_qty > 0.0001)::int as count,
          coalesce(sum(case when pending_hold_qty > 0.0001 then pending_hold_qty else 0 end), 0) as qty
        from qc_totals
      `,
      qcParams
    ),
    client.query(
      `
        with claim_totals as (
          select
            sc.id,
            coalesce(sum(greatest(scl.qty_claimed - scl.qty_received, 0)), 0) as pending_qty
          from supplier_claims sc
          join supplier_claim_lines scl on scl.supplier_claim_id = sc.id
          join quality_hold_actions qha on qha.id = scl.quality_hold_action_id
          join quality_control_lines qcl on qcl.id = qha.quality_control_line_id
          join goods_receipt_lines grl on grl.id = qcl.goods_receipt_line_id
          join purchase_order_lines pol on pol.id = grl.purchase_order_line_id
          join purchase_requisition_lines prl on prl.id = pol.purchase_requisition_line_id
          where ${claimWhere.join(" and ")}
            and prl.source_shortage_action_id is not null
          group by sc.id
        )
        select
          count(*) filter (where pending_qty > 0.0001)::int as count,
          coalesce(sum(case when pending_qty > 0.0001 then pending_qty else 0 end), 0) as qty
        from claim_totals
      `,
      claimParams
    ),
  ]);

  const reqRow = reqRes.rows[0] || {};
  const poRow = poRes.rows[0] || {};
  const qcRow = qcRes.rows[0] || {};
  const claimRow = claimRes.rows[0] || {};
  return {
    requisition_waiting_po_count: Number(reqRow.count || 0),
    requisition_waiting_po_qty: money(reqRow.qty),
    vendor_in_flight_count: Number(poRow.in_flight_count || 0),
    vendor_in_flight_qty: money(poRow.in_flight_qty),
    partial_supply_count: Number(poRow.partial_count || 0),
    partial_supply_qty: money(poRow.partial_qty),
    qc_hold_count: Number(qcRow.count || 0),
    qc_hold_qty: money(qcRow.qty),
    replacement_pending_count: Number(claimRow.count || 0),
    replacement_pending_qty: money(claimRow.qty),
  };
}

async function getExternalProcessingControlQueue(client, req, companyId, { bucket = "vendor_in_flight", q = "", limit = 120 } = {}) {
  const normalizedBucket = normalizeText(bucket).toLowerCase() || "vendor_in_flight";
  const normalizedQuery = normalizeText(q);
  const normalizedLimit = normalizeLimit(limit, 120, 300);

  if (normalizedBucket === "requisition_waiting_po") {
    const params = [Number(companyId)];
    const where = [`pr.company_id = $1`];
    if (ownRecordsOnly(req, "purchase_requisitions")) {
      params.push(Number(req.user.id));
      where.push(`pr.created_by = $${params.length}`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(pr.requisition_number ilike $${params.length} or coalesce(pr.department, '') ilike $${params.length} or coalesce(pr.purpose, '') ilike $${params.length})`);
    }
    const r = await client.query(
      `
        with ordered_qty as (
          select
            pol.purchase_requisition_line_id,
            sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
          from purchase_order_lines pol
          join purchase_orders po on po.id = pol.purchase_order_id
          where pol.purchase_requisition_line_id is not null
          group by pol.purchase_requisition_line_id
        ),
        req_totals as (
          select
            pr.id,
            pr.requisition_number,
            pr.requisition_status,
            pr.requisition_date,
            pr.required_by_date,
            pr.department,
            pr.purpose,
            count(*) filter (where prl.source_shortage_action_id is not null)::int as shortage_linked_lines,
            coalesce(sum(greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0)), 0) as pending_qty
          from purchase_requisitions pr
          join purchase_requisition_lines prl on prl.purchase_requisition_id = pr.id
          left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
          where ${where.join(" and ")}
            and pr.requisition_status in ('approved', 'closed')
          group by pr.id
        )
        select *
        from req_totals
        where shortage_linked_lines > 0
          and pending_qty > 0.0001
        order by required_by_date asc nulls last, requisition_date asc, id desc
        limit ${normalizedLimit}
      `,
      params
    );
    return { queue_type: "purchase_requisitions", rows: r.rows.map((row) => ({ ...row, pending_qty: money(row.pending_qty) })) };
  }

  if (["vendor_in_flight", "partial_supply"].includes(normalizedBucket)) {
    const params = [Number(companyId)];
    const where = [`po.company_id = $1`];
    if (ownRecordsOnly(req, "purchase_orders")) {
      params.push(Number(req.user.id));
      where.push(`po.created_by = $${params.length}`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(po.po_number ilike $${params.length} or v.company_name ilike $${params.length} or coalesce(pr.requisition_number, '') ilike $${params.length})`);
    }
    const extraFilter =
      normalizedBucket === "partial_supply"
        ? `shortage_linked_lines > 0 and received_qty > 0.0001 and pending_qty > 0.0001`
        : `shortage_linked_lines > 0 and pending_qty > 0.0001`;
    const r = await client.query(
      `
        with received_qty as (
          select
            grl.purchase_order_line_id,
            coalesce(sum(case when gr.receipt_status <> 'cancelled' then grl.qty_received else 0 end), 0) as qty_received
          from goods_receipt_lines grl
          join goods_receipts gr on gr.id = grl.goods_receipt_id
          where grl.purchase_order_line_id is not null
          group by grl.purchase_order_line_id
        ),
        po_totals as (
          select
            po.id,
            po.po_number,
            po.po_status,
            po.po_date,
            pr.id as purchase_requisition_id,
            pr.requisition_number,
            v.company_name as vendor_name,
            count(*) filter (where prl.source_shortage_action_id is not null)::int as shortage_linked_lines,
            coalesce(sum(pol.qty), 0) as ordered_qty,
            coalesce(sum(coalesce(rq.qty_received, 0)), 0) as received_qty,
            coalesce(sum(greatest(pol.qty - coalesce(rq.qty_received, 0), 0)), 0) as pending_qty
          from purchase_orders po
          join vendors v on v.id = po.vendor_id
          join purchase_order_lines pol on pol.purchase_order_id = po.id
          left join purchase_requisitions pr on pr.id = po.purchase_requisition_id
          left join purchase_requisition_lines prl on prl.id = pol.purchase_requisition_line_id
          left join received_qty rq on rq.purchase_order_line_id = pol.id
          where ${where.join(" and ")}
            and po.po_status in ('approved', 'closed')
          group by po.id, pr.id, pr.requisition_number, v.company_name
        )
        select *
        from po_totals
        where ${extraFilter}
        order by
          case when received_qty > 0.0001 then 0 else 1 end,
          pending_qty desc,
          po_date asc,
          id desc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      queue_type: "purchase_orders",
      rows: r.rows.map((row) => ({
        ...row,
        ordered_qty: money(row.ordered_qty),
        received_qty: money(row.received_qty),
        pending_qty: money(row.pending_qty),
      })),
    };
  }

  if (normalizedBucket === "qc_hold") {
    const params = [Number(companyId)];
    const where = [`qc.company_id = $1`];
    if (ownRecordsOnly(req, "quality_control")) {
      params.push(Number(req.user.id));
      where.push(`qc.created_by = $${params.length}`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(coalesce(gr.grn_number, '') ilike $${params.length} or coalesce(po.po_number, '') ilike $${params.length} or coalesce(v.company_name, '') ilike $${params.length})`);
    }
    const r = await client.query(
      `
        with qc_totals as (
          select
            qc.id,
            qc.qc_number,
            gr.id as goods_receipt_id,
            gr.grn_number,
            po.id as purchase_order_id,
            po.po_number,
            v.company_name as vendor_name,
            coalesce(sum(greatest(qcl.qty_on_hold - qcl.qty_replaced - qcl.qty_reworked - qcl.qty_accepted_after_hold, 0)), 0) as pending_hold_qty
          from quality_controls qc
          join quality_control_lines qcl on qcl.quality_control_id = qc.id
          join goods_receipt_lines grl on grl.id = qcl.goods_receipt_line_id
          join goods_receipts gr on gr.id = grl.goods_receipt_id
          join purchase_order_lines pol on pol.id = grl.purchase_order_line_id
          join purchase_orders po on po.id = pol.purchase_order_id
          join vendors v on v.id = po.vendor_id
          join purchase_requisition_lines prl on prl.id = pol.purchase_requisition_line_id
          where ${where.join(" and ")}
            and prl.source_shortage_action_id is not null
          group by qc.id, gr.id, gr.grn_number, po.id, po.po_number, v.company_name
        )
        select *
        from qc_totals
        where pending_hold_qty > 0.0001
        order by pending_hold_qty desc, id desc
        limit ${normalizedLimit}
      `,
      params
    );
    return { queue_type: "quality_controls", rows: r.rows.map((row) => ({ ...row, pending_hold_qty: money(row.pending_hold_qty) })) };
  }

  const params = [Number(companyId)];
  const where = [`sc.company_id = $1`];
  if (ownRecordsOnly(req, "supplier_claims")) {
    params.push(Number(req.user.id));
    where.push(`sc.created_by = $${params.length}`);
  }
  if (normalizedQuery) {
    params.push(`%${normalizedQuery}%`);
    where.push(`(coalesce(sc.claim_number, '') ilike $${params.length} or coalesce(po.po_number, '') ilike $${params.length} or coalesce(v.company_name, '') ilike $${params.length})`);
  }
  const r = await client.query(
    `
      select
        sc.id,
        sc.claim_number,
        sc.claim_status,
        sc.claim_date,
        po.id as purchase_order_id,
        po.po_number,
        gr.id as goods_receipt_id,
        gr.grn_number,
        v.company_name as vendor_name,
        coalesce(sum(greatest(scl.qty_claimed - scl.qty_received, 0)), 0) as pending_qty
      from supplier_claims sc
      join supplier_claim_lines scl on scl.supplier_claim_id = sc.id
      join quality_hold_actions qha on qha.id = scl.quality_hold_action_id
      join quality_control_lines qcl on qcl.id = qha.quality_control_line_id
      join goods_receipt_lines grl on grl.id = qcl.goods_receipt_line_id
      join goods_receipts gr on gr.id = grl.goods_receipt_id
      join purchase_order_lines pol on pol.id = grl.purchase_order_line_id
      join purchase_orders po on po.id = pol.purchase_order_id
      join vendors v on v.id = po.vendor_id
      join purchase_requisition_lines prl on prl.id = pol.purchase_requisition_line_id
      where ${where.join(" and ")}
        and prl.source_shortage_action_id is not null
      group by sc.id, po.id, gr.id, v.company_name
      having coalesce(sum(greatest(scl.qty_claimed - scl.qty_received, 0)), 0) > 0.0001
      order by pending_qty desc, sc.id desc
      limit ${normalizedLimit}
    `,
    params
  );
  return { queue_type: "supplier_claims", rows: r.rows.map((row) => ({ ...row, pending_qty: money(row.pending_qty) })) };
}

async function getProcurementExceptionsQueue(client, req, companyId, { bucket = "shortage_not_raised", q = "", limit = 120 } = {}) {
  const normalizedBucket = normalizeText(bucket).toLowerCase() || "shortage_not_raised";
  const normalizedQuery = normalizeText(q);
  const normalizedLimit = normalizeLimit(limit, 120, 300);

  if (normalizedBucket === "shortage_not_raised") {
    const params = [Number(companyId)];
    const where = [`jc.company_id = $1`, `coalesce(jsa.action_type, '') <> 'resolved'`, `prl.id is null`];
    if (ownRecordsOnly(req, "purchase_requisitions")) {
      params.push(Number(req.user.id));
      where.push(`jc.created_by = $${params.length}`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(jc.job_card_number ilike $${params.length} or coalesce(jc.job_id, '') ilike $${params.length} or coalesce(jcl.item_code, '') ilike $${params.length} or coalesce(jcl.item_name, '') ilike $${params.length})`);
    }
    const r = await client.query(
      `
        select
          jsa.id as shortage_action_id,
          jsa.action_type,
          jsa.action_date,
          jsa.shortage_qty,
          jsa.expected_date,
          jc.id as job_card_id,
          jc.job_card_number,
          jc.job_id,
          jc.department,
          jcl.id as job_card_line_id,
          jcl.line_no,
          jcl.item_code,
          jcl.item_name,
          jcl.uom
        from job_card_line_shortage_actions jsa
        join job_cards jc on jc.id = jsa.job_card_id
        join job_card_lines jcl on jcl.id = jsa.job_card_line_id
        left join purchase_requisition_lines prl on prl.source_shortage_action_id = jsa.id
        where ${where.join(" and ")}
        order by jsa.expected_date asc nulls last, jsa.action_date asc, jsa.id desc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      bucket: normalizedBucket,
      queue_type: "shortage_actions",
      rows: r.rows.map((row) => ({
        ...row,
        shortage_qty: money(row.shortage_qty),
      })),
    };
  }

  if (["pr_submitted", "pr_approval_aged", "pr_not_ordered"].includes(normalizedBucket)) {
    const params = [Number(companyId)];
    const where = [`pr.company_id = $1`];
    if (ownRecordsOnly(req, "purchase_requisitions")) {
      params.push(Number(req.user.id));
      where.push(`pr.created_by = $${params.length}`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(pr.requisition_number ilike $${params.length} or coalesce(pr.department, '') ilike $${params.length} or coalesce(pr.purpose, '') ilike $${params.length})`);
    }
    let filter = `pr.requisition_status = 'submitted'`;
    if (normalizedBucket === "pr_approval_aged") {
      filter = `pr.requisition_status = 'submitted' and ageing_days > 2`;
    } else if (normalizedBucket === "pr_not_ordered") {
      filter = `pr.requisition_status in ('approved', 'closed') and pending_qty > 0.0001`;
    }
    const r = await client.query(
      `
        with ordered_qty as (
          select
            pol.purchase_requisition_line_id,
            sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
          from purchase_order_lines pol
          join purchase_orders po on po.id = pol.purchase_order_id
          where pol.purchase_requisition_line_id is not null
          group by pol.purchase_requisition_line_id
        ),
        req_totals as (
          select
            pr.id,
            pr.requisition_number,
            pr.requisition_status,
            pr.requisition_date,
            pr.required_by_date,
            pr.department,
            pr.purpose,
            pr.estimated_total,
            cu.full_name as created_by_name,
            greatest((current_date - pr.requisition_date::date), 0)::int as ageing_days,
            count(*) filter (where greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0) > 0.0001)::int as pending_lines,
            coalesce(sum(greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0)), 0) as pending_qty,
            count(*) filter (where prl.source_shortage_action_id is not null)::int as shortage_linked_lines
          from purchase_requisitions pr
          join purchase_requisition_lines prl on prl.purchase_requisition_id = pr.id
          left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
          left join erp_users cu on cu.id = pr.created_by
          where ${where.join(" and ")}
          group by pr.id, cu.full_name
        )
        select *
        from req_totals
        where ${filter}
        order by
          case when requisition_status = 'submitted' then 0 else 1 end,
          ageing_days desc,
          required_by_date asc nulls last,
          requisition_date asc,
          id desc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      bucket: normalizedBucket,
      queue_type: "purchase_requisitions",
      rows: r.rows.map((row) => ({
        ...row,
        estimated_total: money(row.estimated_total),
        pending_qty: money(row.pending_qty),
      })),
    };
  }

  const params = [Number(companyId)];
  const where = [`po.company_id = $1`];
  if (ownRecordsOnly(req, "purchase_orders")) {
    params.push(Number(req.user.id));
    where.push(`po.created_by = $${params.length}`);
  }
  if (normalizedQuery) {
    params.push(`%${normalizedQuery}%`);
    where.push(`(po.po_number ilike $${params.length} or v.company_name ilike $${params.length} or coalesce(pr.requisition_number, '') ilike $${params.length})`);
  }
  let filter = `po_status = 'submitted'`;
  if (normalizedBucket === "po_approval_aged") {
    filter = `po_status = 'submitted' and ageing_days > 2`;
  } else if (normalizedBucket === "po_pending_receipt") {
    filter = `po_status in ('approved', 'closed') and pending_qty > 0.0001`;
  } else if (normalizedBucket === "po_partial_supply") {
    filter = `po_status in ('approved', 'closed') and received_qty > 0.0001 and pending_qty > 0.0001`;
  } else if (normalizedBucket === "po_promise_overdue") {
    filter = `po_status in ('approved', 'closed') and has_promise_overdue`;
  }
  const r = await client.query(
    `
      with received_qty as (
        select
          grl.purchase_order_line_id,
          coalesce(sum(case when gr.receipt_status <> 'cancelled' then grl.qty_received else 0 end), 0) as qty_received
        from goods_receipt_lines grl
        join goods_receipts gr on gr.id = grl.goods_receipt_id
        where grl.purchase_order_line_id is not null
        group by grl.purchase_order_line_id
      ),
      po_totals as (
        select
          po.id,
          po.po_number,
          po.po_status,
          po.po_date,
          pr.requisition_number,
          v.company_name as vendor_name,
          cu.full_name as created_by_name,
          greatest((current_date - po.po_date::date), 0)::int as ageing_days,
          count(*)::int as line_count,
          coalesce(sum(pol.qty), 0) as ordered_qty,
          coalesce(sum(coalesce(rq.qty_received, 0)), 0) as received_qty,
          coalesce(sum(greatest(pol.qty - coalesce(rq.qty_received, 0), 0)), 0) as pending_qty,
          po.grand_total_order,
          min(pol.promised_date) filter (
            where pol.promised_date is not null
              and pol.promised_date < current_date
              and greatest(pol.qty - coalesce(rq.qty_received, 0), 0) > 0.0001
          ) as earliest_promise_overdue,
          bool_or(
            pol.promised_date is not null
            and pol.promised_date < current_date
            and greatest(pol.qty - coalesce(rq.qty_received, 0), 0) > 0.0001
          ) as has_promise_overdue
        from purchase_orders po
        join vendors v on v.id = po.vendor_id and v.company_id = po.company_id
        left join purchase_requisitions pr on pr.id = po.purchase_requisition_id
        left join erp_users cu on cu.id = po.created_by
        join purchase_order_lines pol on pol.purchase_order_id = po.id
        left join received_qty rq on rq.purchase_order_line_id = pol.id
        where ${where.join(" and ")}
        group by po.id, pr.requisition_number, v.company_name, cu.full_name
      )
      select *
      from po_totals
      where ${filter}
      order by
        earliest_promise_overdue asc nulls last,
        case when po_status = 'submitted' then 0 else 1 end,
        ageing_days desc,
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
      ordered_qty: money(row.ordered_qty),
      received_qty: money(row.received_qty),
      pending_qty: money(row.pending_qty),
      grand_total_order: money(row.grand_total_order),
    })),
  };
}

router.get("/bootstrap", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const [vendorsRes, currenciesRes, requisitionsRes] = await Promise.all([
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
      getApprovedRequisitions(pool, companyId),
    ]);

    return res.json({
      ok: true,
      vendors: vendorsRes.rows,
      currencies: currenciesRes.rows,
      approved_requisitions: requisitionsRes,
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/vendors/quick-create", async (req, res, next) => {
  try {
    const canCreate =
      req.user?.group_name === "SuperAdmin" ||
      hasScreenAction(req, "purchase_orders", "can_create") ||
      hasScreenAction(req, "goods_receipts", "can_create") ||
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

router.get("/vendor-scorecard", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));

    const r = await pool.query(
      `
        with po_lines as (
          select
            po.vendor_id,
            pol.id as purchase_order_line_id,
            pol.qty,
            pol.promised_date,
            coalesce(sum(case when gr.receipt_status <> 'cancelled' then grl.qty_received else 0 end), 0) as qty_received,
            max(gr.receipt_date) as last_receipt_date
          from purchase_orders po
          join purchase_order_lines pol on pol.purchase_order_id = po.id
          left join goods_receipt_lines grl on grl.purchase_order_line_id = pol.id
          left join goods_receipts gr on gr.id = grl.goods_receipt_id
          where po.company_id = $1
            and po.po_status <> 'cancelled'
          group by po.vendor_id, pol.id, pol.qty, pol.promised_date
        ),
        qc_stats as (
          select
            gr.vendor_id,
            coalesce(sum(qcl.qty_rejected), 0) as qty_rejected,
            coalesce(sum(qcl.qty_accepted + qcl.qty_rejected + qcl.qty_on_hold), 0) as qty_inspected
          from quality_control_lines qcl
          join quality_controls qc on qc.id = qcl.quality_control_id
          join goods_receipts gr on gr.id = qc.goods_receipt_id
          where qc.company_id = $1
          group by gr.vendor_id
        ),
        claim_stats as (
          select vendor_id, count(*)::int as claim_count
          from supplier_claims
          where company_id = $1
            and claim_status <> 'cancelled'
          group by vendor_id
        )
        select
          v.id as vendor_id,
          v.company_name as vendor_name,
          count(pl.purchase_order_line_id)::int as line_count,
          count(*) filter (
            where pl.promised_date is not null
              and pl.qty_received >= pl.qty - 0.0001
              and pl.last_receipt_date is not null
              and pl.last_receipt_date <= pl.promised_date
          )::int as on_time_lines,
          count(*) filter (
            where pl.promised_date is not null
              and (
                (pl.qty_received >= pl.qty - 0.0001 and pl.last_receipt_date > pl.promised_date)
                or (pl.qty_received < pl.qty - 0.0001 and pl.promised_date < current_date)
              )
          )::int as late_lines,
          coalesce(qc.qty_rejected, 0) as qty_rejected,
          coalesce(qc.qty_inspected, 0) as qty_inspected,
          coalesce(cs.claim_count, 0)::int as claim_count
        from vendors v
        left join po_lines pl on pl.vendor_id = v.id
        left join qc_stats qc on qc.vendor_id = v.id
        left join claim_stats cs on cs.vendor_id = v.id
        where v.company_id = $1
          and v.is_active = true
        group by v.id, v.company_name, qc.qty_rejected, qc.qty_inspected, cs.claim_count
        having count(pl.purchase_order_line_id) > 0 or coalesce(cs.claim_count, 0) > 0
        order by late_lines desc, claim_count desc, v.company_name asc
        limit $2
      `,
      [companyId, limit]
    );

    const rows = r.rows.map((row) => {
      const onTime = Number(row.on_time_lines || 0);
      const late = Number(row.late_lines || 0);
      const promised = onTime + late;
      const inspected = Number(row.qty_inspected || 0);
      const rejected = Number(row.qty_rejected || 0);
      return {
        ...row,
        on_time_pct: promised > 0 ? Number(((onTime / promised) * 100).toFixed(1)) : null,
        reject_pct: inspected > 0 ? Number(((rejected / inspected) * 100).toFixed(1)) : null,
      };
    });

    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/exceptions-summary", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const summary = await getProcurementExceptionsSummary(pool, req, companyId);
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/exceptions-queue", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const queue = await getProcurementExceptionsQueue(pool, req, companyId, {
      bucket: req.query.bucket,
      q: req.query.q,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...queue });
  } catch (err) {
    return next(err);
  }
});

router.get("/external-processing-summary", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const summary = await getExternalProcessingControlSummary(pool, req, companyId);
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/external-processing-queue", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "vendor_in_flight";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = normalizeLimit(req.query.limit, 120, 300);
    const data = await getExternalProcessingControlQueue(pool, req, companyId, { bucket, q, limit });
    return res.json({ ok: true, ...data });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-lookup", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
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

router.get("/", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const params = [];
    const where = [];

    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    where.push(`po.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "purchase_orders")) {
      params.push(Number(req.user.id));
      where.push(`po.created_by = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`po.po_status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(po.po_number ilike $${params.length} or v.company_name ilike $${params.length})`);
    }

    const r = await pool.query(
      `
        select
          po.id,
          po.po_number,
          po.po_status,
          po.po_date,
          po.grand_total_order,
          po.created_at,
          v.company_name as vendor_name,
          ord.currency_code as order_currency_code
        from purchase_orders po
        join vendors v on v.id = po.vendor_id and v.company_id = po.company_id
        left join currencies ord on ord.id = po.order_currency_id
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by po.created_at desc, po.id desc
      `,
      params
    );

    return res.json({ ok: true, purchase_orders: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("purchase_orders", "can_create"), async (req, res, next) => {
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

    const currencyId = Number.isFinite(Number(body.order_currency_id)) ? Number(body.order_currency_id) : await getDefaultCurrencyId(client);
    if (!Number.isFinite(currencyId) || currencyId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    const numRes = await client.query(`select next_company_document_number($1,'PO') as po_number`, [companyId]);
    const poNumber = numRes.rows[0]?.po_number;

    const insertRes = await client.query(
      `
        insert into purchase_orders (
          company_id,
          po_number,
          vendor_id,
          po_status,
          base_currency_id,
          order_currency_id,
          po_date,
          subtotal_base,
          subtotal_order,
          tax_total_base,
          tax_total_order,
          grand_total_base,
          grand_total_order,
          handling_fee_override_order,
          remarks,
          created_by
        )
        values ($1,$2,$3,'draft',$4,$5,current_date,0,0,0,0,0,0,$6,$7,$8)
        returning id
      `,
      [
        companyId,
        poNumber,
        vendorId,
        currencyId,
        currencyId,
        body.handling_fee_override_order == null || body.handling_fee_override_order === ""
          ? null
          : Math.max(0, num(body.handling_fee_override_order, 0)),
        body.remarks || null,
        req.user.id,
      ]
    );

    await client.query("commit");

    const purchaseOrderId = insertRes.rows[0]?.id;
    const purchaseOrder = await getPurchaseOrderHeaderOrNull(client, purchaseOrderId, companyId);
    const lines = await getPurchaseOrderLines(client, purchaseOrderId);
    return res.status(201).json({ ok: true, purchase_order: purchaseOrder, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/from-requisition/:id", requireScreenAction("purchase_orders", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const requisitionId = Number(req.params.id);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const vendorId = Number(body.vendor_id);
    if (!Number.isFinite(requisitionId) || requisitionId <= 0) return res.status(400).json({ ok: false, error: "INVALID_REQUISITION" });
    if (!Number.isFinite(vendorId) || vendorId <= 0) return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");

    const vendorRes = await client.query(`select id from vendors where id = $1 and company_id = $2 and is_active = true limit 1`, [
      vendorId,
      companyId,
    ]);
    if (!vendorRes.rows[0]?.id) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "VENDOR_NOT_FOUND" });
    }

    const requisitionLock = await client.query(
      `
        select id, requisition_status, company_id
        from purchase_requisitions
        where id = $1
        limit 1
        for update
      `,
      [requisitionId]
    );
    const requisitionLocked = requisitionLock.rows[0] || null;
    if (!requisitionLocked) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "REQUISITION_NOT_FOUND" });
    }
    if (Number(requisitionLocked.company_id) !== Number(companyId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    await client.query(`select id from purchase_requisition_lines where purchase_requisition_id = $1 for update`, [requisitionId]);

    const requisitionRes = await client.query(
      `
        with ordered_qty as (
          select
            pol.purchase_requisition_line_id,
            sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
          from purchase_order_lines pol
          join purchase_orders po on po.id = pol.purchase_order_id
          where pol.purchase_requisition_line_id is not null
          group by pol.purchase_requisition_line_id
        )
        select
          pr.*,
          prl.id as requisition_line_id,
          prl.line_no,
          prl.product_id,
          prl.item_code,
          prl.item_name,
          prl.line_description,
          prl.hsn_no,
          prl.uom,
          prl.qty_requested,
          prl.estimated_unit_price,
          prl.gst_pct,
          greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0) as qty_pending
        from purchase_requisitions pr
        join purchase_requisition_lines prl on prl.purchase_requisition_id = pr.id
        left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
        where pr.id = $1
        order by prl.line_no asc
      `,
      [requisitionId]
    );

    const requisitionHeader = requisitionRes.rows[0] || null;
    if (!requisitionHeader) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "REQUISITION_NOT_FOUND" });
    }
    if (!["approved", "closed"].includes(String(requisitionHeader.requisition_status || "").toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REQUISITION_NEEDS_APPROVAL" });
    }

    const pendingLines = requisitionRes.rows.filter((row) => Number(row.qty_pending || 0) > 0.0001);
    if (!pendingLines.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REQUISITION_FULLY_ORDERED" });
    }

    try {
      await assertVendorApprovedForProducts(client, {
        companyId,
        vendorId,
        productIds: pendingLines.map((line) => line.product_id),
      });
    } catch (avlErr) {
      await client.query("rollback");
      if (avlErr?.code === "UNAPPROVED_VENDOR" || avlErr?.message === "UNAPPROVED_VENDOR") {
        return res.status(400).json({
          ok: false,
          error: "UNAPPROVED_VENDOR",
          detail: avlErr.detail || avlErr.message,
        });
      }
      throw avlErr;
    }
    try {
      await assertVendorCompliance(client, vendorId);
    } catch (complianceErr) {
      await client.query("rollback");
      if (complianceErr?.code === "VENDOR_COMPLIANCE_LOCKED") {
        return res.status(400).json({
          ok: false,
          error: "VENDOR_COMPLIANCE_LOCKED",
          message: complianceErr.message || "Purchase order blocked. Vendor statutory compliance documents are expired or unverified.",
          detail: complianceErr.detail,
          non_compliant_documents: complianceErr.non_compliant_documents || complianceErr.expired_documents || [],
          expired_documents: complianceErr.expired_documents || [],
        });
      }
      throw complianceErr;
    }

    const currencyId = Number.isFinite(Number(body.order_currency_id)) ? Number(body.order_currency_id) : await getDefaultCurrencyId(client);
    if (!Number.isFinite(currencyId) || currencyId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    const numRes = await client.query(`select next_company_document_number($1,'PO') as po_number`, [companyId]);
    const poNumber = numRes.rows[0]?.po_number;
    const insertRes = await client.query(
      `
        insert into purchase_orders (
          company_id,
          po_number,
          purchase_requisition_id,
          vendor_id,
          po_status,
          base_currency_id,
          order_currency_id,
          po_date,
          subtotal_base,
          subtotal_order,
          tax_total_base,
          tax_total_order,
          grand_total_base,
          grand_total_order,
          handling_fee_override_order,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,'draft',$5,$6,current_date,0,0,0,0,0,0,$7,$8,$9)
        returning id
      `,
      [
        companyId,
        poNumber,
        requisitionId,
        vendorId,
        currencyId,
        currencyId,
        body.handling_fee_override_order == null || body.handling_fee_override_order === ""
          ? null
          : Math.max(0, num(body.handling_fee_override_order, 0)),
        body.remarks || requisitionHeader.remarks || null,
        req.user.id,
      ]
    );
    const purchaseOrderId = insertRes.rows[0]?.id;

    let lineNo = 1;
    const totals = { subtotal: 0, taxTotal: 0, grandTotal: 0 };
    for (const line of pendingLines) {
      const qty = money(line.qty_pending);
      const unit = money(line.estimated_unit_price);
      const lineSubtotal = money(qty * unit);
      const lineTax = money(lineSubtotal * (Number(line.gst_pct || 0) / 100));
      const lineTotal = money(lineSubtotal + lineTax);
      totals.subtotal += lineSubtotal;
      totals.taxTotal += lineTax;
      totals.grandTotal += lineTotal;
      await client.query(
        `
          insert into purchase_order_lines (
            purchase_order_id,
            line_no,
            purchase_requisition_line_id,
            product_id,
            item_code,
            item_name,
            line_description,
            hsn_no,
            uom,
            qty,
            unit_price_base,
            unit_price_order,
            gst_pct,
            line_total_base,
            line_total_order,
            promised_date
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `,
        [
          purchaseOrderId,
          lineNo,
          line.requisition_line_id,
          line.product_id,
          line.item_code,
          line.item_name,
          line.line_description,
          line.hsn_no,
          line.uom,
          qty,
          unit,
          unit,
          Number(line.gst_pct || 0),
          lineSubtotal,
          lineTotal,
          typeof line.promised_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(line.promised_date) ? line.promised_date : null,
        ]
      );
      lineNo += 1;
    }

    await client.query(
      `
        update purchase_orders
        set subtotal_base = $2,
            subtotal_order = $2,
            tax_total_base = $3,
            tax_total_order = $3,
            grand_total_base = $4,
            grand_total_order = $4,
            updated_at = now()
        where id = $1 and company_id = $5
      `,
      [purchaseOrderId, money(totals.subtotal), money(totals.taxTotal), money(totals.grandTotal), companyId]
    );

    await snapshotPurchaseOrderLandedCost(client, purchaseOrderId, companyId);

    const pendingCheck = await client.query(
      `
        with ordered_qty as (
          select
            pol.purchase_requisition_line_id,
            sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
          from purchase_order_lines pol
          join purchase_orders po on po.id = pol.purchase_order_id
          where pol.purchase_requisition_line_id is not null
          group by pol.purchase_requisition_line_id
        )
        select count(*)::integer as pending_lines
        from purchase_requisition_lines prl
        left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
        where prl.purchase_requisition_id = $1
          and prl.qty_requested - coalesce(oq.qty_ordered, 0) > 0.0001
      `,
      [requisitionId]
    );
    const pendingLinesRemaining = Number(pendingCheck.rows[0]?.pending_lines || 0);
    if (pendingLinesRemaining <= 0 && String(requisitionHeader.requisition_status || "").toLowerCase() !== "cancelled") {
      await client.query(
        `
          update purchase_requisitions
          set requisition_status = 'closed',
              updated_at = now()
          where id = $1
        `,
        [requisitionId]
      );
      if (String(requisitionHeader.requisition_status || "").toLowerCase() !== "closed") {
        await insertApprovalHistory(client, {
          docType: "purchase_requisition",
          docId: requisitionId,
          action: "posted",
          actionLevel: Math.max(0, Number(requisitionHeader.required_approval_level || requisitionHeader.current_approval_level || 0)),
          remarks: `Fully converted into ${poNumber}.`,
          actedBy: req.user.id,
        });
      }
    }

    await client.query("commit");
    const purchaseOrder = await getPurchaseOrderHeaderOrNull(client, purchaseOrderId, companyId);
    const lines = await getPurchaseOrderLines(client, purchaseOrderId);
    const landedCost = await getPurchaseOrderLandedCostPreview(client, purchaseOrderId, companyId);
    return res.status(201).json({ ok: true, purchase_order: purchaseOrder, lines, landed_cost: landedCost });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id/landed-cost-preview", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const companyId = requireResolvedCompanyId(req);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_PURCHASE_ORDER" });
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const landedCost = await getPurchaseOrderLandedCostPreview(pool, id, companyId);
    if (!landedCost) return res.status(404).json({ ok: false, error: "PURCHASE_ORDER_NOT_FOUND" });
    return res.json({ ok: true, landed_cost: landedCost });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireScreenAction("purchase_orders", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const purchaseOrder = await getPurchaseOrderHeaderOrNull(pool, id, companyId);
    if (!purchaseOrder) return res.status(404).json({ ok: false });
    if (!canAccessCompanyContext(req, purchaseOrder)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessPurchaseOrder(req, purchaseOrder)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const lines = await getPurchaseOrderLines(pool, id);
    const approvalPreview = await getApprovalPreview(pool, req, purchaseOrder, companyId);
    const landedCost = await getPurchaseOrderLandedCostPreview(pool, id, companyId);
    return res.json({ ok: true, purchase_order: purchaseOrder, lines, approval_preview: approvalPreview, landed_cost: landedCost });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("purchase_orders", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const nextStatus = typeof body.po_status === "string" ? body.po_status.trim().toLowerCase() : "";
    if (nextStatus && !["draft", "submitted", "approved", "closed", "cancelled"].includes(nextStatus)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const existing = await getPurchaseOrderHeaderOrNull(client, id, companyId);
    if (!existing) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessCompanyContext(req, existing)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessPurchaseOrder(req, existing)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const editingLines = Array.isArray(body.lines);
    const currentStatus = (existing.po_status || "draft").toLowerCase();
    if (editingLines && currentStatus !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ORDER_NOT_EDITABLE" });
    }

    const vendorId =
      body.vendor_id === undefined || body.vendor_id === null || body.vendor_id === ""
        ? null
        : Number(body.vendor_id);
    if (vendorId !== null && (!Number.isFinite(vendorId) || vendorId <= 0)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });
    }

    const currencyId =
      body.order_currency_id === undefined || body.order_currency_id === null || body.order_currency_id === ""
        ? null
        : Number(body.order_currency_id);
    if (currencyId !== null && (!Number.isFinite(currencyId) || currencyId <= 0)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    const nextVendorId = vendorId === null ? existing.vendor_id : vendorId;
    if (!Number.isFinite(Number(nextVendorId)) || Number(nextVendorId) <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });
    }
    const handlingFeeOverride =
      body.handling_fee_override_order === undefined
        ? existing.handling_fee_override_order
        : body.handling_fee_override_order === null || body.handling_fee_override_order === ""
          ? null
          : Number(body.handling_fee_override_order);
    if (handlingFeeOverride !== null && (!Number.isFinite(handlingFeeOverride) || handlingFeeOverride < 0)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_HANDLING_FEE" });
    }

    const updateStatus = nextStatus ? nextStatus : existing.po_status || "draft";
    let normalizedUpdateStatus = String(updateStatus || "").toLowerCase();
    const isSuper = req.user.group_name === "SuperAdmin";
    const canApprove = isSuper || hasScreenAction(req, "purchase_orders", "can_approve");

    if (normalizedUpdateStatus !== currentStatus) {
      if (normalizedUpdateStatus === "submitted") {
        if (currentStatus !== "draft" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "INVALID_TRANSITION" });
        }
      } else if (normalizedUpdateStatus === "draft") {
        if (currentStatus !== "submitted" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "INVALID_TRANSITION" });
        }
      } else if (normalizedUpdateStatus === "approved") {
        if (!canApprove) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "FORBIDDEN" });
        }
        if (currentStatus !== "submitted" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "NEEDS_SUBMISSION" });
        }
      } else if (normalizedUpdateStatus === "closed") {
        if (!canApprove) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "FORBIDDEN" });
        }
        if (currentStatus !== "approved" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "NEEDS_APPROVAL" });
        }
      } else if (normalizedUpdateStatus === "cancelled") {
        if (!isSuper && currentStatus === "approved" && !canApprove) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "FORBIDDEN" });
        }
      }
    }

    const updateCurrencyId = currencyId === null ? existing.order_currency_id : currencyId;

    const linesPayload = editingLines ? body.lines : null;
    const normalizedLines = [];

    if (editingLines) {
      for (const raw of linesPayload) {
        const productId =
          raw?.product_id === undefined || raw?.product_id === null || raw?.product_id === ""
            ? null
            : Number(raw.product_id);
        if (productId !== null && (!Number.isFinite(productId) || productId <= 0)) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
        }

        const qty = num(raw?.qty, 0);
        if (!Number.isFinite(qty) || qty <= 0) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_QTY" });
        }

        const unit = num(raw?.unit_price_order, 0);
        const gst = num(raw?.gst_pct, 0);
        if (!Number.isFinite(unit) || unit < 0 || !Number.isFinite(gst) || gst < 0 || gst > 100) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_PRICE" });
        }

        normalizedLines.push({
          purchase_requisition_line_id:
            raw?.purchase_requisition_line_id === undefined || raw?.purchase_requisition_line_id === null || raw?.purchase_requisition_line_id === ""
              ? null
              : Number(raw.purchase_requisition_line_id),
          product_id: productId,
          component_specification_id:
            raw?.component_specification_id === undefined || raw?.component_specification_id === null || raw?.component_specification_id === ""
              ? null
              : Number(raw.component_specification_id),
          item_code: typeof raw?.item_code === "string" ? raw.item_code.trim() : raw?.item_code || null,
          item_name: typeof raw?.item_name === "string" ? raw.item_name.trim() : raw?.item_name || null,
          line_description: typeof raw?.line_description === "string" ? raw.line_description.trim() : raw?.line_description || null,
          hsn_no: typeof raw?.hsn_no === "string" ? raw.hsn_no.trim() : raw?.hsn_no || null,
          uom: typeof raw?.uom === "string" ? raw.uom.trim() : raw?.uom || null,
          qty,
          unit_price_order: unit,
          gst_pct: gst,
        });
      }

      try {
        await assertVendorApprovedForProducts(client, {
          companyId,
          vendorId: Number(body.vendor_id || existing.vendor_id),
          productIds: normalizedLines.map((line) => line.product_id),
        });
      } catch (avlErr) {
        await client.query("rollback");
        if (avlErr?.code === "UNAPPROVED_VENDOR" || avlErr?.message === "UNAPPROVED_VENDOR") {
          return res.status(400).json({
            ok: false,
            error: "UNAPPROVED_VENDOR",
            detail: avlErr.detail || avlErr.message,
          });
        }
        throw avlErr;
      }
    }

    const totals = editingLines
      ? calcTotals(normalizedLines)
      : {
          subtotal: money(existing.subtotal_order ?? existing.subtotal_base ?? 0),
          taxTotal: money(existing.tax_total_order ?? existing.tax_total_base ?? 0),
          grandTotal: money(existing.grand_total_order ?? existing.grand_total_base ?? 0),
        };
    let approvalCurrentLevel = Number(existing.current_approval_level || 0);
    let approvalRequiredLevel = Number(existing.required_approval_level || 0);
    let approveBy = normalizedUpdateStatus === "approved" && currentStatus !== "approved" ? req.user.id : null;
    let approvalDecision = null;

    if (normalizedUpdateStatus === "submitted" || normalizedUpdateStatus === "approved") {
      try {
        await assertVendorCompliance(client, nextVendorId);
      } catch (complianceErr) {
        await client.query("rollback");
        if (complianceErr?.code === "VENDOR_COMPLIANCE_LOCKED") {
          return res.status(400).json({
            ok: false,
            error: "VENDOR_COMPLIANCE_LOCKED",
            message: complianceErr.message || "Purchase order blocked. Vendor statutory compliance documents are expired or unverified.",
            detail: complianceErr.detail,
            non_compliant_documents: complianceErr.non_compliant_documents || complianceErr.expired_documents || [],
            expired_documents: complianceErr.expired_documents || [],
          });
        }
        throw complianceErr;
      }
    }

    if (normalizedUpdateStatus === "submitted" && currentStatus !== "submitted") {
      const state = await resolveApprovalState(client, "purchase_order", {
        id,
        vendor_id: nextVendorId,
        total_amount: totals.grandTotal,
        current_approval_level: 0,
      }, companyId);
      approvalCurrentLevel = 0;
      approvalRequiredLevel = state.requiredLevel;
    } else if (normalizedUpdateStatus === "draft") {
      approvalCurrentLevel = 0;
      approvalRequiredLevel = 0;
    } else if (normalizedUpdateStatus === "approved" && currentStatus !== "approved") {
      const state = await resolveApprovalState(client, "purchase_order", {
        id,
        vendor_id: nextVendorId,
        total_amount: totals.grandTotal,
        current_approval_level: existing.current_approval_level,
        required_approval_level: existing.required_approval_level,
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
        normalizedUpdateStatus = "submitted";
        approvalCurrentLevel = approvalDecision.nextLevel;
        approveBy = null;
      } else {
        approvalCurrentLevel = approvalDecision.requiredLevel;
      }
    }

    const submitBy = normalizedUpdateStatus === "submitted" && currentStatus !== "submitted" ? req.user.id : null;
    const clearWorkflow = normalizedUpdateStatus === "draft";

    await client.query(
      `
        update purchase_orders
        set vendor_id = $2,
            po_status = $3,
            po_date = coalesce($4, po_date),
            base_currency_id = $5,
            order_currency_id = $6,
            subtotal_base = $7,
            subtotal_order = $8,
            tax_total_base = $9,
            tax_total_order = $10,
            grand_total_base = $11,
            grand_total_order = $12,
            remarks = $13,
            handling_fee_override_order = $14,
            current_approval_level = $15,
            required_approval_level = $16,
            submitted_by = case when $17::boolean then null when $18::integer is not null then $18 else submitted_by end,
            submitted_at = case when $17::boolean then null when $18::integer is not null then now() else submitted_at end,
            approved_by = case when $17::boolean then null when $19::integer is not null then $19 else approved_by end,
            approved_at = case when $17::boolean then null when $19::integer is not null then now() else approved_at end,
            updated_at = now()
        where id = $1 and company_id = $20
      `,
      [
        id,
        nextVendorId,
        normalizedUpdateStatus,
        body.po_date || null,
        updateCurrencyId,
        updateCurrencyId,
        totals.subtotal,
        totals.subtotal,
        totals.taxTotal,
        totals.taxTotal,
        totals.grandTotal,
        totals.grandTotal,
        body.remarks || null,
        handlingFeeOverride,
        approvalCurrentLevel,
        approvalRequiredLevel,
        clearWorkflow,
        submitBy,
        approveBy,
        companyId,
      ]
    );

    if (editingLines) {
      await client.query(`delete from purchase_order_lines where purchase_order_id = $1`, [id]);
      let lineNo = 1;
      for (const line of normalizedLines) {
        const lineTotal = money(num(line.qty, 0) * num(line.unit_price_order, 0));
        await client.query(
          `
            insert into purchase_order_lines (
              purchase_order_id,
              line_no,
              purchase_requisition_line_id,
              product_id,
              component_specification_id,
              item_code,
              item_name,
              line_description,
              hsn_no,
              uom,
              qty,
              unit_price_base,
              unit_price_order,
              gst_pct,
              line_total_base,
              line_total_order,
              promised_date
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          `,
          [
            id,
            lineNo,
            line.purchase_requisition_line_id,
            line.product_id,
            line.component_specification_id,
            line.item_code,
            line.item_name,
            line.line_description,
            line.hsn_no,
            line.uom,
            line.qty,
            line.unit_price_order,
            line.unit_price_order,
            line.gst_pct,
            lineTotal,
            lineTotal,
            typeof line.promised_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(line.promised_date) ? line.promised_date : null,
          ]
        );
        lineNo += 1;
      }
    }

    if (editingLines || currentStatus === "draft") {
      await snapshotPurchaseOrderLandedCost(client, id, companyId);
    }

    const actionRemarks = typeof body.approval_remarks === "string" ? body.approval_remarks.trim().slice(0, 500) : "";
    const requestedApproval = nextStatus === "approved" && currentStatus !== "approved";
    if (currentStatus !== normalizedUpdateStatus) {
      if (normalizedUpdateStatus === "submitted") {
        await insertApprovalHistory(client, {
          docType: "purchase_order",
          docId: id,
          action: "submitted",
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (normalizedUpdateStatus === "draft") {
        await insertApprovalHistory(client, {
          docType: "purchase_order",
          docId: id,
          action: "sent_back",
          actionLevel: Math.max(0, Number(existing.current_approval_level || 0)),
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      }
    }
    if (requestedApproval) {
      await insertApprovalHistory(client, {
        docType: "purchase_order",
        docId: id,
        action: "approved",
        actionLevel: approvalDecision?.requiresPolicy ? approvalDecision.nextLevel : 0,
        policyId: approvalDecision?.nextPolicy?.id || null,
        remarks: actionRemarks || null,
        actedBy: req.user.id,
      });
    }

    await client.query("commit");

    const purchaseOrder = await getPurchaseOrderHeaderOrNull(client, id, companyId);
    const lines = await getPurchaseOrderLines(client, id);
    const approvalPreview = await getApprovalPreview(client, req, purchaseOrder, companyId);
    const landedCost = await getPurchaseOrderLandedCostPreview(client, id, companyId);
    return res.json({ ok: true, purchase_order: purchaseOrder, lines, approval_preview: approvalPreview, landed_cost: landedCost });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/intercompany/create-sales-order", requireScreenAction("purchase_orders", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const purchaseOrderId = Number(req.params.id);
    if (!Number.isFinite(purchaseOrderId) || purchaseOrderId <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const buyerCompanyId = getActiveCompanyId(req);
    if (!buyerCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");

    const poRes = await client.query(
      `select * from purchase_orders where id = $1 and company_id = $2 limit 1 for update`,
      [purchaseOrderId, buyerCompanyId]
    );
    const po = poRes.rows[0] || null;
    if (!po) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const currentStatus = String(po.po_status || "draft").toLowerCase();
    if (!["approved", "closed"].includes(currentStatus)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "PO_NEEDS_APPROVAL" });
    }
    if (po.intercompany_sales_order_id) {
      const soExistingRes = await client.query(
        `select id, so_number, company_id from sales_orders where id = $1 limit 1`,
        [po.intercompany_sales_order_id]
      );
      const soExisting = soExistingRes.rows[0] || null;
      if (soExisting?.company_id && !userCanAccessCompanyId(req, Number(soExisting.company_id))) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "INTERCOMPANY_ACCESS_DENIED" });
      }

      await client.query("rollback");
      const purchaseOrder = await getPurchaseOrderHeaderOrNull(client, purchaseOrderId, buyerCompanyId);
      return res.json({
        ok: true,
        purchase_order: purchaseOrder,
        intercompany_sales_order: soExisting
          ? { id: soExisting.id, so_number: soExisting.so_number, company_id: soExisting.company_id }
          : { id: po.intercompany_sales_order_id, so_number: null, company_id: null },
      });
    }

    const buyerPartner = await getIntercompanyPartnerByVendor(client, buyerCompanyId, po.vendor_id);
    if (!buyerPartner) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "INTERCOMPANY_VENDOR_MAPPING_MISSING" });
    }

    const sellerCompanyId = Number(buyerPartner.counterparty_company_id);
    if (!Number.isFinite(sellerCompanyId) || sellerCompanyId <= 0) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "INTERCOMPANY_COUNTERPARTY_MISSING" });
    }
    if (!userCanAccessCompanyId(req, sellerCompanyId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "INTERCOMPANY_ACCESS_DENIED" });
    }

    const sellerPartner = await getIntercompanyPartnerByCustomer(client, sellerCompanyId, buyerCompanyId);
    if (!sellerPartner?.customer_id) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "INTERCOMPANY_CUSTOMER_MAPPING_MISSING" });
    }

    const lines = await getPurchaseOrderLines(client, purchaseOrderId);
    if (!lines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_LINES" });
    }

    await syncLegacySoNumberSequence(client, sellerCompanyId);
    const numRes = await client.query(`select next_company_document_number($1, 'SO') as so_number`, [sellerCompanyId]);
    const soNumber = numRes.rows[0]?.so_number;
    if (!soNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "NUMBERING_FAILED" });
    }

    const soRes = await client.query(
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
          terms_snapshot
        )
        values ($1,$2,null,$3,null,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        returning id
      `,
      [
        soNumber,
        sellerCompanyId,
        sellerPartner.customer_id,
        po.base_currency_id,
        po.order_currency_id,
        po.po_date || null,
        po.subtotal_base,
        po.subtotal_order,
        po.tax_total_base,
        po.tax_total_order,
        po.grand_total_base,
        po.grand_total_order,
        req.user.id,
        JSON.stringify([]),
      ]
    );
    const salesOrderId = soRes.rows[0]?.id;
    if (!salesOrderId) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "CREATE_FAILED" });
    }

    for (const line of lines) {
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
            line_total_order
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
          line.unit_price_order,
          line.gst_pct,
          line.line_total_base,
          line.line_total_order,
        ]
      );
    }

    await client.query(
      `
        update purchase_orders
        set intercompany_counterparty_company_id = $1,
            intercompany_sales_order_id = $2,
            updated_at = now()
        where id = $3 and company_id = $4
      `,
      [sellerCompanyId, salesOrderId, purchaseOrderId, buyerCompanyId]
    );

    await client.query(
      `
        update sales_orders
        set intercompany_counterparty_company_id = $1,
            intercompany_purchase_order_id = $2,
            updated_at = now()
        where id = $3 and company_id = $4
      `,
      [buyerCompanyId, purchaseOrderId, salesOrderId, sellerCompanyId]
    );

    await client.query("commit");

    const purchaseOrder = await getPurchaseOrderHeaderOrNull(client, purchaseOrderId, buyerCompanyId);
    return res.status(201).json({
      ok: true,
      purchase_order: purchaseOrder,
      intercompany_sales_order: { id: salesOrderId, so_number: soNumber, company_id: sellerCompanyId },
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
