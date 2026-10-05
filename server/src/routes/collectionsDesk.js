const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly } = require("../auth/authorization");
const { getActiveCompanyId } = require("../services/companyContext");
const { getDistributorIdForUser } = require("../services/mailAccounts");
const { getSingleActiveCustomerCompanyId } = require("../services/customerCompanyAccess");

const router = express.Router();

const collectionActionTypes = [
  "follow_up",
  "promise_to_pay",
  "reminder_sent",
  "dispute",
  "escalated",
  "resolved",
  "dunning",
];

const DUNNING_STAGE_DAYS = [0, 3, 7, 14, 21];

function nextDunningStage(current) {
  const stage = Number(current || 0);
  if (!Number.isFinite(stage) || stage < 0) return 1;
  return Math.min(5, stage + 1);
}

function nextDunningDateFromStage(stage) {
  const idx = Math.min(DUNNING_STAGE_DAYS.length - 1, Math.max(0, Number(stage) || 1));
  const days = DUNNING_STAGE_DAYS[idx] || 7;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const arAdjustmentTypes = ["commercial_credit_note", "short_payment_adjustment", "write_off"];

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function normalizeId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(2));
}

function normalizeQty4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function buildFollowupQueueMetadata(row) {
  const nextDate = normalizeDate(row?.next_followup_date);
  const outstandingAmount = normalizeAmount(row?.outstanding_amount) || 0;
  const maxAgeingDays = Number(row?.max_ageing_days || 0);
  const lastActionType = String(row?.last_action_type || "").toLowerCase();
  const today = new Date().toISOString().slice(0, 10);

  if (!nextDate) {
    return {
      queue_reason: "No next follow-up date is set for this customer.",
      recommended_action: "set_next_followup",
      recommended_action_label: "Set next follow-up",
      attention_level: "high",
    };
  }

  if (nextDate < today) {
    return {
      queue_reason: `Follow-up is overdue while ${Number(row?.open_invoices || 0)} invoice(s) worth ${outstandingAmount.toFixed(2)} remain open.`,
      recommended_action: "call_customer",
      recommended_action_label: "Call customer now",
      attention_level: "high",
    };
  }

  if (nextDate === today) {
    return {
      queue_reason: `Follow-up is due today for outstanding invoices aged up to ${maxAgeingDays} day(s).`,
      recommended_action: "complete_followup",
      recommended_action_label: "Complete follow-up",
      attention_level: "medium",
    };
  }

  if (lastActionType === "promise_to_pay") {
    return {
      queue_reason: "Customer already gave a payment promise. Track the commitment before the next escalation.",
      recommended_action: "review_promise",
      recommended_action_label: "Review promise",
      attention_level: "medium",
    };
  }

  return {
    queue_reason: `Next follow-up is scheduled while ${Number(row?.open_invoices || 0)} invoice(s) remain open.`,
    recommended_action: "review_customer",
    recommended_action_label: "Review customer",
    attention_level: "low",
  };
}

function buildPromiseQueueMetadata(row) {
  const dueDate = normalizeDate(row?.expected_date);
  const outstandingAmount = normalizeAmount(row?.outstanding_amount) || 0;
  const promisedAmount = normalizeAmount(row?.promised_amount);
  const overdueDays = Number(row?.overdue_days || 0);
  const openInvoices = Number(row?.open_invoices || 0);
  const today = new Date().toISOString().slice(0, 10);
  const effectivePromiseAmount = promisedAmount !== null && promisedAmount > 0 ? promisedAmount : outstandingAmount;

  if (!dueDate) {
    return {
      queue_reason: "Payment promise is logged without a due date.",
      recommended_action: "set_promise_date",
      recommended_action_label: "Set promise date",
      attention_level: "high",
      promise_gap_amount: Math.max(outstandingAmount - effectivePromiseAmount, 0),
    };
  }

  if (overdueDays > 0 || dueDate < today) {
    return {
      queue_reason: `Payment promise is overdue by ${overdueDays} day(s) while ${outstandingAmount.toFixed(2)} remains open.`,
      recommended_action: "follow_up_promise",
      recommended_action_label: "Follow up now",
      attention_level: "high",
      promise_gap_amount: Math.max(outstandingAmount - effectivePromiseAmount, 0),
    };
  }

  if (dueDate === today) {
    return {
      queue_reason: `Payment promise is due today against ${outstandingAmount.toFixed(2)} of open exposure.`,
      recommended_action: "confirm_receipt",
      recommended_action_label: "Confirm receipt",
      attention_level: "medium",
      promise_gap_amount: Math.max(outstandingAmount - effectivePromiseAmount, 0),
    };
  }

  if (effectivePromiseAmount + 0.009 < outstandingAmount) {
    return {
      queue_reason: `Promise amount covers only part of the open balance, leaving ${(outstandingAmount - effectivePromiseAmount).toFixed(2)} still uncovered.`,
      recommended_action: "review_balance",
      recommended_action_label: "Review balance",
      attention_level: "medium",
      promise_gap_amount: Math.max(outstandingAmount - effectivePromiseAmount, 0),
    };
  }

  return {
    queue_reason: `Payment promise is scheduled while ${openInvoices} invoice(s) remain open.`,
    recommended_action: "monitor_promise",
    recommended_action_label: "Monitor promise",
    attention_level: "low",
    promise_gap_amount: Math.max(outstandingAmount - effectivePromiseAmount, 0),
  };
}

function normalizeNcrStatus(value) {
  const text = normalizeText(value).toLowerCase();
  if (["open", "contained", "root_cause_pending", "action_in_progress", "verification_pending", "closed", "cancelled"].includes(text)) {
    return text;
  }
  return null;
}

function normalizeActionStatus(value) {
  const text = normalizeText(value).toLowerCase();
  if (["open", "in_progress", "done", "cancelled"].includes(text)) return text;
  return null;
}

function normalizeSeverity(value) {
  const text = normalizeText(value).toLowerCase();
  if (["low", "medium", "high", "critical"].includes(text)) return text;
  return "medium";
}

function normalizeNcrCategory(value) {
  const text = normalizeText(value).toLowerCase();
  if (["incoming_defect", "process_deviation", "vendor_quality", "documentation", "packaging", "other"].includes(text)) return text;
  return "other";
}

function deriveNcrStatus(caseInput = {}, actions = []) {
  const explicitStatus = normalizeNcrStatus(caseInput.status);
  if (explicitStatus === "cancelled") return "cancelled";
  if (explicitStatus === "closed") return "closed";
  if (normalizeDate(caseInput.verification_date)) return "closed";
  const activeActions = Array.isArray(actions)
    ? actions.filter((row) => normalizeActionStatus(row.action_status || row.status) !== "cancelled")
    : [];
  const hasOpenActions = activeActions.some((row) => {
    const status = normalizeActionStatus(row.action_status || row.status);
    return status !== "done";
  });
  if (!normalizeDate(caseInput.containment_completed_date)) return "open";
  if (!normalizeText(caseInput.root_cause)) return "root_cause_pending";
  if (hasOpenActions) return "action_in_progress";
  if (activeActions.length > 0) return "verification_pending";
  return "contained";
}

function getOutstandingInvoiceExpr({ invoiceAlias = "ci", receiptAlias = "pr", returnAlias = "sr", adjustmentAlias = "adj", adjustmentsReady = false } = {}) {
  return `(${invoiceAlias}.grand_total_invoice - coalesce(${receiptAlias}.allocated_invoice, 0) - coalesce(${returnAlias}.credit_note_amount, 0)${
    adjustmentsReady ? ` - coalesce(${adjustmentAlias}.adjustment_amount, 0)` : ""
  })`;
}

function getArAdjustmentsJoin({ enabled, invoiceAlias = "ci", adjustmentAlias = "adj" } = {}) {
  if (!enabled) return "";
  return `
          left join (
            select
              customer_invoice_id,
              coalesce(sum(adjustment_amount), 0) as adjustment_amount
            from customer_ar_adjustments
            where adjustment_status = 'posted'
            group by customer_invoice_id
          ) ${adjustmentAlias} on ${adjustmentAlias}.customer_invoice_id = ${invoiceAlias}.id`;
}

function canViewAnyCollectionsDesk(req) {
  return hasScreenAction(req, "invoices", "can_view") || hasScreenAction(req, "receipts", "can_view");
}

async function loadContextFilters(req) {
  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
  if (isDistributor && !distributorId) return { ok: false, error: "DISTRIBUTOR_NOT_LINKED" };
  const activeCompanyId = getActiveCompanyId(req) || null;
  if (!isDistributor && !activeCompanyId) return { ok: false, error: "COMPANY_NOT_SELECTED" };
  return { ok: true, isDistributor, distributorId, activeCompanyId };
}

async function resolveOwnedCompanyId(client, { customerId, customerInvoiceId = null, requestedCompanyId = null } = {}) {
  if (Number.isFinite(Number(requestedCompanyId)) && Number(requestedCompanyId) > 0) {
    return Number(requestedCompanyId);
  }
  if (Number.isFinite(Number(customerInvoiceId)) && Number(customerInvoiceId) > 0) {
    const invoiceRes = await client.query(
      `
        select company_id
        from customer_invoices
        where id = $1
          and customer_id = $2
        limit 1
      `,
      [Number(customerInvoiceId), Number(customerId)]
    );
    const companyId = Number(invoiceRes.rows[0]?.company_id || 0);
    if (companyId > 0) return companyId;
  }
  return getSingleActiveCustomerCompanyId(client, customerId);
}

function buildScopedWhere({ alias, req, isDistributor, distributorId, activeCompanyId, screenKey }) {
  const params = [];
  const where = [];
  if (isDistributor) {
    params.push(Number(distributorId));
    where.push(`${alias}.distributor_id = $${params.length}`);
  } else if (activeCompanyId) {
    params.push(Number(activeCompanyId));
    where.push(`${alias}.company_id = $${params.length}`);
    if (ownRecordsOnly(req, screenKey)) {
      params.push(Number(req.user.id));
      where.push(`${alias}.created_by = $${params.length}`);
    }
  } else {
    where.push("false");
  }
  return { params, whereSql: where.length ? `where ${where.join(" and ")}` : "" };
}

async function getCollectionDisputeOrNull(client, disputeId, ctx, req) {
  const params = [Number(disputeId)];
  const where = [`d.id = $1`];
  if (ctx.isDistributor) {
    params.push(Number(ctx.distributorId));
    where.push(`d.distributor_id = $${params.length}`);
  } else if (ctx.activeCompanyId) {
    params.push(Number(ctx.activeCompanyId));
    where.push(`d.company_id = $${params.length}`);
  }
  if (ownRecordsOnly(req, "receipts")) {
    params.push(Number(req.user.id));
    where.push(`d.created_by = $${params.length}`);
  }
  const r = await client.query(
    `
      select
        d.*,
        c.customer_name,
        ci.invoice_number,
        ci.customer_po_number,
        ci.customer_po_date,
        ci.company_id as invoice_company_id,
        sr.return_number,
        sr.credit_note_number,
        sr.return_status as linked_return_status,
        sr.credit_note_amount as credited_amount
      from customer_collection_disputes d
      join customers c on c.id = d.customer_id
      left join customer_invoices ci on ci.id = d.customer_invoice_id
      left join sales_returns sr on sr.id = d.sales_return_id
      where ${where.join(" and ")}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

async function getDisputeNcrCases(client, disputeId) {
  const r = await client.query(
    `
      with action_stats as (
        select
          a.ncr_case_id,
          count(*)::int as total_action_count,
          count(*) filter (where a.action_status in ('open', 'in_progress'))::int as open_action_count,
          count(*) filter (
            where a.action_status in ('open', 'in_progress')
              and a.due_date is not null
              and a.due_date < current_date
          )::int as overdue_action_count
        from quality_capa_actions a
        group by a.ncr_case_id
      )
      select
        n.*,
        owner_user.full_name as containment_owner_name,
        created_user.full_name as created_by_name,
        verified_user.full_name as verified_by_name,
        sr.return_number,
        sr.credit_note_number,
        sr.return_status as linked_return_status,
        coalesce(ast.total_action_count, 0) as total_action_count,
        coalesce(ast.open_action_count, 0) as open_action_count,
        coalesce(ast.overdue_action_count, 0) as overdue_action_count
      from quality_ncr_cases n
      left join erp_users owner_user on owner_user.id = n.containment_owner_id
      left join erp_users created_user on created_user.id = n.created_by
      left join erp_users verified_user on verified_user.id = n.verified_by
      left join sales_returns sr on sr.id = n.sales_return_id
      left join action_stats ast on ast.ncr_case_id = n.id
      where n.customer_collection_dispute_id = $1
      order by n.created_at desc, n.id desc
    `,
    [Number(disputeId)]
  );
  return r.rows;
}

async function getDisputeCapaActions(client, disputeId) {
  const r = await client.query(
    `
      select
        a.*,
        n.ncr_number,
        owner_user.full_name as owner_name,
        created_user.full_name as created_by_name
      from quality_capa_actions a
      join quality_ncr_cases n on n.id = a.ncr_case_id
      left join erp_users owner_user on owner_user.id = a.owner_user_id
      left join erp_users created_user on created_user.id = a.created_by
      where n.customer_collection_dispute_id = $1
      order by coalesce(a.due_date, current_date) asc, a.id asc
    `,
    [Number(disputeId)]
  );
  return r.rows;
}

function getDisputeFailureBucket(row) {
  const status = String(row.status || "").toLowerCase();
  if (["closed", "cancelled"].includes(status)) return "other";
  const today = new Date().toISOString().slice(0, 10);
  if (!normalizeDate(row.containment_completed_date) && normalizeDate(row.containment_due_date) && row.containment_due_date < today) {
    return "containment_due";
  }
  if (normalizeDate(row.containment_completed_date) && !normalizeText(row.root_cause)) return "root_cause_due";
  if (Number(row.overdue_action_count || 0) > 0) return "action_overdue";
  if (Number(row.open_action_count || 0) <= 0 && Number(row.total_action_count || 0) > 0 && !normalizeDate(row.verification_date)) {
    return "verification_due";
  }
  if (!normalizeDate(row.containment_completed_date)) return "new_ncr";
  return "all";
}

function matchesDisputeFailureBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getDisputeFailureBucket(row) !== "other";
  return getDisputeFailureBucket(row) === key;
}

function getDisputeFailureRank(row) {
  const bucket = getDisputeFailureBucket(row);
  if (bucket === "containment_due") return 0;
  if (bucket === "action_overdue") return 1;
  if (bucket === "verification_due") return 2;
  if (bucket === "root_cause_due") return 3;
  if (bucket === "new_ncr") return 4;
  return 5;
}

async function queryDisputeFailureRows(client, req, ctx, { q = "", limit = 600 } = {}) {
  const params = [];
  const where = [`n.source_type = 'collection_dispute'`];
  if (ctx.isDistributor) {
    params.push(Number(ctx.distributorId));
    where.push(`d.distributor_id = $${params.length}`);
  } else if (ctx.activeCompanyId) {
    params.push(Number(ctx.activeCompanyId));
    where.push(`d.company_id = $${params.length}`);
  }
  if (ownRecordsOnly(req, "receipts")) {
    params.push(Number(req.user.id));
    where.push(`d.created_by = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(
      c.customer_name ilike $${params.length}
      or coalesce(ci.invoice_number, '') ilike $${params.length}
      or coalesce(ci.customer_po_number, '') ilike $${params.length}
      or coalesce(sr.return_number, '') ilike $${params.length}
      or coalesce(n.ncr_number, '') ilike $${params.length}
      or coalesce(d.dispute_reason, '') ilike $${params.length}
      or coalesce(n.defect_summary, '') ilike $${params.length}
    )`);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);
  const r = await client.query(
    `
      with action_stats as (
        select
          a.ncr_case_id,
          count(*)::int as total_action_count,
          count(*) filter (where a.action_status in ('open', 'in_progress'))::int as open_action_count,
          count(*) filter (
            where a.action_status in ('open', 'in_progress')
              and a.due_date is not null
              and a.due_date < current_date
          )::int as overdue_action_count
        from quality_capa_actions a
        group by a.ncr_case_id
      )
      select
        n.id,
        n.ncr_number,
        n.status,
        n.severity,
        n.category,
        n.qty_affected,
        n.defect_summary,
        n.containment_due_date,
        n.containment_completed_date,
        n.root_cause,
        n.verification_date,
        n.customer_collection_dispute_id,
        n.sales_return_id,
        d.customer_id,
        d.customer_invoice_id,
        d.dispute_reason,
        d.dispute_status,
        d.disputed_amount,
        d.expected_resolution_date,
        c.customer_name,
        ci.invoice_number,
        ci.customer_po_number,
        ci.customer_po_date,
        sr.return_number,
        sr.credit_note_number,
        sr.return_status as linked_return_status,
        coalesce(ast.total_action_count, 0) as total_action_count,
        coalesce(ast.open_action_count, 0) as open_action_count,
        coalesce(ast.overdue_action_count, 0) as overdue_action_count
      from quality_ncr_cases n
      join customer_collection_disputes d on d.id = n.customer_collection_dispute_id
      join customers c on c.id = d.customer_id
      left join customer_invoices ci on ci.id = d.customer_invoice_id
      left join sales_returns sr on sr.id = coalesce(n.sales_return_id, d.sales_return_id)
      left join action_stats ast on ast.ncr_case_id = n.id
      where ${where.join(" and ")}
      order by n.created_at desc, n.id desc
      limit ${safeLimit}
    `,
    params
  );
  return r.rows;
}

async function getDisputeFailureSummary(client, req, ctx, { q = "" } = {}) {
  const rows = await queryDisputeFailureRows(client, req, ctx, { q, limit: 800 });
  return {
    ncr_count: rows.length,
    new_ncr: rows.filter((row) => getDisputeFailureBucket(row) === "new_ncr").length,
    containment_due: rows.filter((row) => getDisputeFailureBucket(row) === "containment_due").length,
    root_cause_due: rows.filter((row) => getDisputeFailureBucket(row) === "root_cause_due").length,
    action_overdue: rows.filter((row) => getDisputeFailureBucket(row) === "action_overdue").length,
    verification_due: rows.filter((row) => getDisputeFailureBucket(row) === "verification_due").length,
  };
}

async function getDisputeFailureQueue(client, req, ctx, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryDisputeFailureRows(client, req, ctx, { q, limit: 800 });
  return rows
    .filter((row) => matchesDisputeFailureBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getDisputeFailureRank(a) - getDisputeFailureRank(b);
      if (rankDiff !== 0) return rankDiff;
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const sevDiff = (sevOrder[String(a.severity || "medium").toLowerCase()] ?? 9) - (sevOrder[String(b.severity || "medium").toLowerCase()] ?? 9);
      if (sevDiff !== 0) return sevDiff;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, Math.min(Math.max(Number(limit) || 80, 1), 200));
}

async function isCollectionsFollowupsReady() {
  const r = await pool.query(`select to_regclass('public.customer_collection_actions') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

async function isCollectionsDisputesReady() {
  const r = await pool.query(`select to_regclass('public.customer_collection_disputes') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

async function isArAdjustmentsReady() {
  const r = await pool.query(`select to_regclass('public.customer_ar_adjustments') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

router.use(requireAuth);

router.get("/summary", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const summary = {};
    const [followupsReady, disputesReady, adjustmentsReady] = await Promise.all([
      isCollectionsFollowupsReady(),
      isCollectionsDisputesReady(),
      isArAdjustmentsReady(),
    ]);

    if (hasScreenAction(req, "invoices", "can_view")) {
      const base = buildScopedWhere({ alias: "ci", req, ...ctx, screenKey: "invoices" });
      const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady });
      const adjustmentsJoin = getArAdjustmentsJoin({ enabled: adjustmentsReady });
      const outstandingRes = await pool.query(
        `
          select
            count(*)::int as count,
            coalesce(sum(${outstandingExpr}), 0) as amount
          from customer_invoices ci
          left join sales_orders so on so.id = ci.sales_order_id
          left join payment_terms pt on pt.id = so.payment_term_id
          left join (
            select
              cra.customer_invoice_id,
              coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cr.receipt_status = 'posted'
            group by cra.customer_invoice_id
          ) pr on pr.customer_invoice_id = ci.id
          left join (
            select
              customer_invoice_id,
              coalesce(sum(credit_note_amount), 0) as credit_note_amount
            from sales_returns
            where return_status = 'posted'
              and customer_invoice_id is not null
            group by customer_invoice_id
          ) sr on sr.customer_invoice_id = ci.id
          ${adjustmentsJoin}
          ${base.whereSql}${base.whereSql ? " and" : "where"} ci.invoice_status <> 'cancelled'
            and ${outstandingExpr} > 0.0001
        `,
        base.params
      );
      const overdueRes = await pool.query(
        `
          select count(*)::int as count
          from customer_invoices ci
          left join sales_orders so on so.id = ci.sales_order_id
          left join payment_terms pt on pt.id = so.payment_term_id
          left join (
            select
              cra.customer_invoice_id,
              coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cr.receipt_status = 'posted'
            group by cra.customer_invoice_id
          ) pr on pr.customer_invoice_id = ci.id
          left join (
            select
              customer_invoice_id,
              coalesce(sum(credit_note_amount), 0) as credit_note_amount
            from sales_returns
            where return_status = 'posted'
              and customer_invoice_id is not null
            group by customer_invoice_id
          ) sr on sr.customer_invoice_id = ci.id
          ${adjustmentsJoin}
          ${base.whereSql}${base.whereSql ? " and" : "where"} ci.invoice_status <> 'cancelled'
            and ${outstandingExpr} > 0.0001
            and (current_date - (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date) > 0
        `,
        base.params
      );
      const dispatchCashGapRes = await pool.query(
        `
          select count(distinct ci.id)::int as count
          from customer_invoices ci
          left join (
            select
              cra.customer_invoice_id,
              coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cr.receipt_status = 'posted'
            group by cra.customer_invoice_id
          ) pr on pr.customer_invoice_id = ci.id
          left join (
            select
              customer_invoice_id,
              coalesce(sum(credit_note_amount), 0) as credit_note_amount
            from sales_returns
            where return_status = 'posted'
              and customer_invoice_id is not null
            group by customer_invoice_id
          ) sr on sr.customer_invoice_id = ci.id
          ${adjustmentsJoin}
          ${base.whereSql}${base.whereSql ? " and" : "where"} ci.invoice_status <> 'cancelled'
            and ${outstandingExpr} > 0.0001
            and exists (
              select 1
              from dispatches d
              where d.sales_order_id = ci.sales_order_id
                and d.dispatch_status = any($${base.params.length + 1}::text[])
            )
        `,
        [...base.params, ["dispatched", "delivered"]]
      );
      summary.invoices = {
        outstanding_count: Number(outstandingRes.rows[0]?.count || 0),
        outstanding_amount: Number(outstandingRes.rows[0]?.amount || 0),
        overdue_count: Number(overdueRes.rows[0]?.count || 0),
        dispatch_cash_gap_count: Number(dispatchCashGapRes.rows[0]?.count || 0),
      };
    }

    if (hasScreenAction(req, "receipts", "can_view")) {
      const base = buildScopedWhere({ alias: "cr", req, ...ctx, screenKey: "receipts" });
      const receiptRes = await pool.query(
        `
          select
            count(*) filter (
              where cr.receipt_status = 'posted'
                and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001
            )::int as pending_allocation_count,
            coalesce(sum(case
              when cr.receipt_status = 'posted'
                and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001
              then cr.unallocated_amount_invoice
              else 0
            end), 0) as pending_allocation_amount,
            count(*) filter (
              where cr.receipt_status = 'posted'
                and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001
                and coalesce(cr.allocated_amount_invoice, 0) <= 0.0001
            )::int as unapplied_cash_count,
            coalesce(sum(case
              when cr.receipt_status = 'posted'
                and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001
                and coalesce(cr.allocated_amount_invoice, 0) <= 0.0001
              then cr.unallocated_amount_invoice
              else 0
            end), 0) as unapplied_cash_amount,
            count(*) filter (where cr.receipt_status = 'draft')::int as draft_count
          from customer_receipts cr
          ${base.whereSql}
        `,
        base.params
      );
      const receiptSummary = receiptRes.rows[0] || {};
      summary.receipts = {
        pending_allocation_count: Number(receiptSummary.pending_allocation_count || 0),
        pending_allocation_amount: Number(receiptSummary.pending_allocation_amount || 0),
        unapplied_cash_count: Number(receiptSummary.unapplied_cash_count || 0),
        unapplied_cash_amount: Number(receiptSummary.unapplied_cash_amount || 0),
        draft_count: Number(receiptSummary.draft_count || 0),
      };
    }

    if (hasScreenAction(req, "receipts", "can_view") || hasScreenAction(req, "invoices", "can_view")) {
      if (!adjustmentsReady) {
        summary.adjustments = { ready: false, draft_count: 0, posted_count: 0, posted_amount: 0 };
      } else {
        const params = [];
        const where = [];
        if (ctx.isDistributor) {
          params.push(Number(ctx.distributorId));
          where.push(`a.distributor_id = $${params.length}`);
        } else if (ctx.activeCompanyId) {
          params.push(Number(ctx.activeCompanyId));
          where.push(`a.company_id = $${params.length}`);
        }
        if (ownRecordsOnly(req, "receipts")) {
          params.push(Number(req.user.id));
          where.push(`a.created_by = $${params.length}`);
        }
        const adjustmentsRes = await pool.query(
          `
            select
              count(*) filter (where a.adjustment_status = 'draft')::int as draft_count,
              count(*) filter (where a.adjustment_status = 'posted')::int as posted_count,
              coalesce(sum(case when a.adjustment_status = 'posted' then a.adjustment_amount else 0 end), 0) as posted_amount
            from customer_ar_adjustments a
            ${where.length ? `where ${where.join(" and ")}` : ""}
          `,
          params
        );
        summary.adjustments = {
          ready: true,
          draft_count: Number(adjustmentsRes.rows[0]?.draft_count || 0),
          posted_count: Number(adjustmentsRes.rows[0]?.posted_count || 0),
          posted_amount: Number(adjustmentsRes.rows[0]?.posted_amount || 0),
        };
      }
    }

    if (hasScreenAction(req, "receipts", "can_view") || hasScreenAction(req, "invoices", "can_view")) {
      if (!disputesReady) {
        summary.disputes = { ready: false, open_count: 0, escalated_count: 0, open_amount: 0 };
      } else {
        const params = [];
        const where = [];
        if (ctx.isDistributor) {
          params.push(Number(ctx.distributorId));
          where.push(`d.distributor_id = $${params.length}`);
        } else if (ctx.activeCompanyId) {
          params.push(Number(ctx.activeCompanyId));
          where.push(`d.company_id = $${params.length}`);
        }
        if (ownRecordsOnly(req, "receipts")) {
          params.push(Number(req.user.id));
          where.push(`d.created_by = $${params.length}`);
        }
        const disputesRes = await pool.query(
          `
            select
              count(*) filter (where d.dispute_status = 'open')::int as open_count,
              count(*) filter (where d.dispute_status = 'escalated')::int as escalated_count,
              coalesce(sum(case when d.dispute_status in ('open', 'escalated') then d.disputed_amount else 0 end), 0) as open_amount
            from customer_collection_disputes d
            ${where.length ? `where ${where.join(" and ")}` : ""}
          `,
          params
        );
        summary.disputes = {
          ready: true,
          open_count: Number(disputesRes.rows[0]?.open_count || 0),
          escalated_count: Number(disputesRes.rows[0]?.escalated_count || 0),
          open_amount: Number(disputesRes.rows[0]?.open_amount || 0),
        };
        const failureSummary = await getDisputeFailureSummary(pool, req, ctx);
        summary.disputes.failure = failureSummary;
      }
    }

    if (hasScreenAction(req, "receipts", "can_view") || hasScreenAction(req, "invoices", "can_view")) {
      if (!followupsReady) {
        summary.followups = { ready: false, overdue_count: 0, due_today_count: 0, no_date_count: 0, total_customers: 0 };
        summary.promises = { ready: false, overdue_count: 0, due_today_count: 0, total_count: 0 };
      } else {
        const invoiceBase = buildScopedWhere({ alias: "ci", req, ...ctx, screenKey: "invoices" });
        const params = [...invoiceBase.params];
        const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady });
        const adjustmentsJoin = getArAdjustmentsJoin({ enabled: adjustmentsReady });
        const actionWhere = [];
        if (ctx.isDistributor) {
          params.push(Number(ctx.distributorId));
          actionWhere.push(`a.distributor_id = $${params.length}`);
        } else if (ctx.activeCompanyId) {
          params.push(Number(ctx.activeCompanyId));
          actionWhere.push(`a.company_id = $${params.length}`);
        }
        if (ownRecordsOnly(req, "receipts")) {
          params.push(Number(req.user.id));
          actionWhere.push(`a.created_by = $${params.length}`);
        }

        const followupCountsRes = await pool.query(
          `
            with invoice_balances as (
              select
                ci.customer_id,
                ${outstandingExpr} as outstanding_invoice
              from customer_invoices ci
              left join (
                select
                  cra.customer_invoice_id,
                  coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
                from customer_receipt_allocations cra
                join customer_receipts cr on cr.id = cra.customer_receipt_id
                where cr.receipt_status = 'posted'
                group by cra.customer_invoice_id
              ) pr on pr.customer_invoice_id = ci.id
              left join (
                select
                  customer_invoice_id,
                  coalesce(sum(credit_note_amount), 0) as credit_note_amount
                from sales_returns
                where return_status = 'posted'
                  and customer_invoice_id is not null
                group by customer_invoice_id
              ) sr on sr.customer_invoice_id = ci.id
              ${adjustmentsJoin}
              ${invoiceBase.whereSql}${invoiceBase.whereSql ? " and" : "where"} ci.invoice_status <> 'cancelled'
                and ${outstandingExpr} > 0.0001
            ),
            customer_outstanding as (
              select
                customer_id
              from invoice_balances
              group by customer_id
            ),
            latest_action as (
              select *
              from (
                select
                  a.customer_id,
                  a.expected_date,
                  row_number() over (partition by a.customer_id order by a.action_date desc, a.id desc) as rn
                from customer_collection_actions a
                ${actionWhere.length ? `where ${actionWhere.join(" and ")}` : ""}
              ) x
              where rn = 1
            )
            select
              count(*)::int as total_customers,
              count(*) filter (where la.expected_date is not null and la.expected_date < current_date)::int as overdue_count,
              count(*) filter (where la.expected_date = current_date)::int as due_today_count,
              count(*) filter (where la.expected_date is null)::int as no_date_count
            from customer_outstanding co
            left join latest_action la on la.customer_id = co.customer_id
          `,
          params
        );
        summary.followups = {
          ready: true,
          overdue_count: Number(followupCountsRes.rows[0]?.overdue_count || 0),
          due_today_count: Number(followupCountsRes.rows[0]?.due_today_count || 0),
          no_date_count: Number(followupCountsRes.rows[0]?.no_date_count || 0),
          total_customers: Number(followupCountsRes.rows[0]?.total_customers || 0),
        };

        try {
          const dunningRes = await pool.query(
            `
              with invoice_balances as (
                select
                  ci.id,
                  ci.next_dunning_at,
                  ci.dunning_stage,
                  ${outstandingExpr} as outstanding_invoice
                from customer_invoices ci
                left join (
                  select
                    cra.customer_invoice_id,
                    coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
                  from customer_receipt_allocations cra
                  join customer_receipts cr on cr.id = cra.customer_receipt_id
                  where cr.receipt_status = 'posted'
                  group by cra.customer_invoice_id
                ) pr on pr.customer_invoice_id = ci.id
                left join (
                  select
                    customer_invoice_id,
                    coalesce(sum(credit_note_amount), 0) as credit_note_amount
                  from sales_returns
                  where return_status = 'posted'
                    and customer_invoice_id is not null
                  group by customer_invoice_id
                ) sr on sr.customer_invoice_id = ci.id
                ${adjustmentsJoin}
                ${invoiceBase.whereSql}${invoiceBase.whereSql ? " and" : "where"} ci.invoice_status <> 'cancelled'
                  and ${outstandingExpr} > 0.0001
              )
              select
                count(*) filter (where next_dunning_at is not null and next_dunning_at < current_date)::int as dunning_overdue_count,
                count(*) filter (where next_dunning_at = current_date)::int as dunning_due_today_count,
                count(*) filter (where next_dunning_at is null)::int as dunning_unset_count,
                count(*) filter (where coalesce(dunning_stage, 0) >= 3)::int as dunning_escalated_count
              from invoice_balances
            `,
            invoiceBase.params
          );
          summary.followups.dunning_overdue_count = Number(dunningRes.rows[0]?.dunning_overdue_count || 0);
          summary.followups.dunning_due_today_count = Number(dunningRes.rows[0]?.dunning_due_today_count || 0);
          summary.followups.dunning_unset_count = Number(dunningRes.rows[0]?.dunning_unset_count || 0);
          summary.followups.dunning_escalated_count = Number(dunningRes.rows[0]?.dunning_escalated_count || 0);
        } catch {
          summary.followups.dunning_overdue_count = 0;
          summary.followups.dunning_due_today_count = 0;
          summary.followups.dunning_unset_count = 0;
          summary.followups.dunning_escalated_count = 0;
        }

        const promiseCountsRes = await pool.query(
          `
            with invoice_balances as (
              select
                ci.id,
                ci.customer_id,
                ${outstandingExpr} as outstanding_invoice
              from customer_invoices ci
              left join (
                select
                  cra.customer_invoice_id,
                  coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
                from customer_receipt_allocations cra
                join customer_receipts cr on cr.id = cra.customer_receipt_id
                where cr.receipt_status = 'posted'
                group by cra.customer_invoice_id
              ) pr on pr.customer_invoice_id = ci.id
              left join (
                select
                  customer_invoice_id,
                  coalesce(sum(credit_note_amount), 0) as credit_note_amount
                from sales_returns
                where return_status = 'posted'
                  and customer_invoice_id is not null
                group by customer_invoice_id
              ) sr on sr.customer_invoice_id = ci.id
              ${adjustmentsJoin}
              ${invoiceBase.whereSql}${invoiceBase.whereSql ? " and" : "where"} ci.invoice_status <> 'cancelled'
                and ${outstandingExpr} > 0.0001
            ),
            customer_outstanding as (
              select
                customer_id,
                coalesce(sum(outstanding_invoice), 0) as outstanding_amount
              from invoice_balances
              group by customer_id
            ),
            latest_action as (
              select *
              from (
                select
                  a.*,
                  row_number() over (
                    partition by a.customer_id, coalesce(a.customer_invoice_id, 0)
                    order by a.action_date desc, a.id desc
                  ) as rn
                from customer_collection_actions a
                ${actionWhere.length ? `where ${actionWhere.join(" and ")}` : ""}
              ) x
              where rn = 1
                and action_type = 'promise_to_pay'
            )
            select
              count(*)::int as total_count,
              count(*) filter (where la.expected_date is not null and la.expected_date < current_date)::int as overdue_count,
              count(*) filter (where la.expected_date = current_date)::int as due_today_count,
              coalesce(sum(coalesce(la.promised_amount, case
                when la.customer_invoice_id is not null then ib.outstanding_invoice
                else co.outstanding_amount
              end)), 0) as promised_amount_total
            from latest_action la
            left join invoice_balances ib on ib.id = la.customer_invoice_id
            left join customer_outstanding co on co.customer_id = la.customer_id
            where coalesce(case
              when la.customer_invoice_id is not null then ib.outstanding_invoice
              else co.outstanding_amount
            end, 0) > 0.0001
          `,
          params
        );
        summary.promises = {
          ready: true,
          overdue_count: Number(promiseCountsRes.rows[0]?.overdue_count || 0),
          due_today_count: Number(promiseCountsRes.rows[0]?.due_today_count || 0),
          total_count: Number(promiseCountsRes.rows[0]?.total_count || 0),
          promised_amount_total: Number(promiseCountsRes.rows[0]?.promised_amount_total || 0),
        };
      }
    }

    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/followups", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCollectionsFollowupsReady();
    if (!ready) return res.json({ ok: true, followups_ready: false, followups: [] });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const bucket = normalizeText(req.query.bucket);
    const q = normalizeText(req.query.q);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);

    const base = buildScopedWhere({ alias: "ci", req, ...ctx, screenKey: "invoices" });
    const params = [...base.params];
    const adjustmentsReady = await isArAdjustmentsReady();
    const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady });
    const adjustmentsJoin = getArAdjustmentsJoin({ enabled: adjustmentsReady });
    const customerFilters = [];
    if (q) {
      params.push(`%${q}%`);
      customerFilters.push(`c.customer_name ilike $${params.length}`);
    }

    const actionWhere = [];
    if (ctx.isDistributor) {
      params.push(Number(ctx.distributorId));
      actionWhere.push(`a.distributor_id = $${params.length}`);
    } else if (ctx.activeCompanyId) {
      params.push(Number(ctx.activeCompanyId));
      actionWhere.push(`a.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "receipts")) {
      params.push(Number(req.user.id));
      actionWhere.push(`a.created_by = $${params.length}`);
    }

    const followupFilters = [];
    if (bucket === "due_today") followupFilters.push(`la.expected_date = current_date`);
    if (bucket === "overdue") followupFilters.push(`la.expected_date is not null and la.expected_date < current_date`);
    if (bucket === "no_date") followupFilters.push(`la.expected_date is null`);
    if (bucket === "dunning_overdue") followupFilters.push(`exists (
      select 1 from customer_invoices di
      where di.customer_id = co.customer_id
        and di.invoice_status <> 'cancelled'
        and di.next_dunning_at is not null
        and di.next_dunning_at < current_date
    )`);
    if (bucket === "dunning_due_today") followupFilters.push(`exists (
      select 1 from customer_invoices di
      where di.customer_id = co.customer_id
        and di.invoice_status <> 'cancelled'
        and di.next_dunning_at = current_date
    )`);
    if (bucket === "dunning_unset") followupFilters.push(`exists (
      select 1 from customer_invoices di
      where di.customer_id = co.customer_id
        and di.invoice_status <> 'cancelled'
        and di.next_dunning_at is null
    )`);

    const whereSql = [
      ...customerFilters,
      ...followupFilters,
    ].length
      ? `where ${[...customerFilters, ...followupFilters].join(" and ")}`
      : "";

    const r = await pool.query(
      `
        with invoice_balances as (
          select
            ci.id,
            ci.customer_id,
            ${outstandingExpr} as outstanding_invoice,
            greatest((current_date - (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date), 0)::int as ageing_days
          from customer_invoices ci
          left join sales_orders so on so.id = ci.sales_order_id
          left join payment_terms pt on pt.id = so.payment_term_id
          left join (
            select
              cra.customer_invoice_id,
              coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cr.receipt_status = 'posted'
            group by cra.customer_invoice_id
          ) pr on pr.customer_invoice_id = ci.id
          left join (
            select
              customer_invoice_id,
              coalesce(sum(credit_note_amount), 0) as credit_note_amount
            from sales_returns
            where return_status = 'posted'
              and customer_invoice_id is not null
            group by customer_invoice_id
          ) sr on sr.customer_invoice_id = ci.id
          ${adjustmentsJoin}
          ${base.whereSql}${base.whereSql ? " and" : "where"} ci.invoice_status <> 'cancelled'
            and ${outstandingExpr} > 0.0001
        ),
        customer_outstanding as (
          select
            customer_id,
            count(*)::int as open_invoices,
            coalesce(sum(outstanding_invoice), 0) as outstanding_amount,
            coalesce(max(ageing_days), 0)::int as max_ageing_days
          from invoice_balances
          group by customer_id
        ),
        latest_action as (
          select *
          from (
            select
              a.*,
              row_number() over (partition by a.customer_id order by a.action_date desc, a.id desc) as rn
            from customer_collection_actions a
            ${actionWhere.length ? `where ${actionWhere.join(" and ")}` : ""}
          ) x
          where rn = 1
        )
        select
          c.id as customer_id,
          c.customer_name,
          co.open_invoices,
          co.outstanding_amount,
          co.max_ageing_days,
          la.id as last_action_id,
          la.customer_invoice_id as last_action_invoice_id,
          lci.invoice_number as last_action_invoice_number,
          la.action_type as last_action_type,
          la.action_date as last_action_date,
          la.expected_date as next_followup_date,
          la.promised_amount as last_action_promised_amount,
          la.remarks as last_action_remarks,
          la.created_by as last_action_by,
          u.full_name as last_action_by_name
        from customer_outstanding co
        join customers c on c.id = co.customer_id
        left join latest_action la on la.customer_id = co.customer_id
        left join customer_invoices lci on lci.id = la.customer_invoice_id
        left join erp_users u on u.id = la.created_by
        ${whereSql}
        order by
          case
            when la.expected_date is null then 2
            when la.expected_date < current_date then 0
            when la.expected_date = current_date then 1
            else 3
          end,
          la.expected_date asc nulls last,
          co.max_ageing_days desc,
          co.outstanding_amount desc
        limit ${limit}
      `,
      params
    );

    return res.json({
      ok: true,
      followups_ready: true,
      followups: r.rows.map((row) => ({
        ...row,
        ...buildFollowupQueueMetadata(row),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/promises", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCollectionsFollowupsReady();
    if (!ready) return res.json({ ok: true, followups_ready: false, promises: [] });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const bucket = normalizeText(req.query.bucket);
    const q = normalizeText(req.query.q);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);

    const base = buildScopedWhere({ alias: "ci", req, ...ctx, screenKey: "invoices" });
    const params = [...base.params];
    const adjustmentsReady = await isArAdjustmentsReady();
    const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady });
    const adjustmentsJoin = getArAdjustmentsJoin({ enabled: adjustmentsReady });
    const actionWhere = [];
    if (ctx.isDistributor) {
      params.push(Number(ctx.distributorId));
      actionWhere.push(`a.distributor_id = $${params.length}`);
    } else if (ctx.activeCompanyId) {
      params.push(Number(ctx.activeCompanyId));
      actionWhere.push(`a.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "receipts")) {
      params.push(Number(req.user.id));
      actionWhere.push(`a.created_by = $${params.length}`);
    }

    const filters = [];
    if (q) {
      params.push(`%${q}%`);
      filters.push(`(c.customer_name ilike $${params.length} or coalesce(ci.invoice_number, '') ilike $${params.length} or coalesce(ci.customer_po_number, '') ilike $${params.length} or coalesce(la.remarks, '') ilike $${params.length})`);
    }
    if (bucket === "overdue") filters.push(`la.expected_date is not null and la.expected_date < current_date`);
    if (bucket === "due_today") filters.push(`la.expected_date = current_date`);
    if (bucket === "future") filters.push(`la.expected_date is not null and la.expected_date > current_date`);
    const whereSql = filters.length ? `and ${filters.join(" and ")}` : "";

    const r = await pool.query(
      `
        with invoice_balances as (
          select
            ci.id,
            ci.customer_id,
            ${outstandingExpr} as outstanding_invoice
          from customer_invoices ci
          left join (
            select
              cra.customer_invoice_id,
              coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cr.receipt_status = 'posted'
            group by cra.customer_invoice_id
          ) pr on pr.customer_invoice_id = ci.id
          left join (
            select
              customer_invoice_id,
              coalesce(sum(credit_note_amount), 0) as credit_note_amount
            from sales_returns
            where return_status = 'posted'
              and customer_invoice_id is not null
            group by customer_invoice_id
          ) sr on sr.customer_invoice_id = ci.id
          ${adjustmentsJoin}
          ${base.whereSql}${base.whereSql ? " and" : "where"} ci.invoice_status <> 'cancelled'
            and ${outstandingExpr} > 0.0001
        ),
        customer_outstanding as (
          select
            customer_id,
            count(*)::int as open_invoices,
            coalesce(sum(outstanding_invoice), 0) as outstanding_amount
          from invoice_balances
          group by customer_id
        ),
        latest_action as (
          select *
          from (
            select
              a.*,
              row_number() over (
                partition by a.customer_id, coalesce(a.customer_invoice_id, 0)
                order by a.action_date desc, a.id desc
              ) as rn
            from customer_collection_actions a
            ${actionWhere.length ? `where ${actionWhere.join(" and ")}` : ""}
          ) x
          where rn = 1
            and action_type = 'promise_to_pay'
        )
        select
          la.id,
          la.customer_id,
          c.customer_name,
          la.customer_invoice_id,
          ci.invoice_number,
        ci.customer_po_number,
        ci.customer_po_date,
          la.action_date,
          la.expected_date,
          la.promised_amount,
          la.remarks,
          la.created_by,
          u.full_name as created_by_name,
          coalesce(case
            when la.customer_invoice_id is not null then ib.outstanding_invoice
            else co.outstanding_amount
          end, 0) as outstanding_amount,
          coalesce(co.open_invoices, 0)::int as open_invoices,
          greatest((current_date - la.expected_date), 0)::int as overdue_days
        from latest_action la
        join customers c on c.id = la.customer_id
        left join customer_invoices ci on ci.id = la.customer_invoice_id
        left join invoice_balances ib on ib.id = la.customer_invoice_id
        left join customer_outstanding co on co.customer_id = la.customer_id
        left join erp_users u on u.id = la.created_by
        where coalesce(case
          when la.customer_invoice_id is not null then ib.outstanding_invoice
          else co.outstanding_amount
        end, 0) > 0.0001
        ${whereSql}
        order by
          case
            when la.expected_date is null then 2
            when la.expected_date < current_date then 0
            when la.expected_date = current_date then 1
            else 3
          end,
          la.expected_date asc nulls last,
          outstanding_amount desc,
          la.id desc
        limit ${limit}
      `,
      params
    );

    return res.json({
      ok: true,
      followups_ready: true,
      promises: r.rows.map((row) => ({
        ...row,
        ...buildPromiseQueueMetadata(row),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/customers/:customerId/actions", async (req, res, next) => {
  try {
    if (
      !hasScreenAction(req, "receipts", "can_edit") &&
      !hasScreenAction(req, "invoices", "can_edit") &&
      !hasScreenAction(req, "ar_desk", "can_edit")
    ) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const ready = await isCollectionsFollowupsReady();
    if (!ready) return res.status(400).json({ ok: false, error: "COLLECTION_ACTIONS_NOT_READY" });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const customerId = normalizeId(req.params.customerId);
    if (!customerId) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const actionType = normalizeText(body.action_type);
    const expectedDate = normalizeDate(body.expected_date);
    const remarks = normalizeText(body.remarks);
    const invoiceId = body.customer_invoice_id ? normalizeId(body.customer_invoice_id) : null;
    const promisedAmountRaw = body.promised_amount;
    const promisedAmount = promisedAmountRaw === undefined || promisedAmountRaw === null || promisedAmountRaw === "" ? null : normalizeAmount(promisedAmountRaw);

    if (!collectionActionTypes.includes(actionType)) {
      return res.status(400).json({ ok: false, error: "INVALID_ACTION_TYPE" });
    }
    if (actionType === "promise_to_pay" && (promisedAmount === null || promisedAmount <= 0)) {
      return res.status(400).json({ ok: false, error: "INVALID_PROMISED_AMOUNT" });
    }
    if (actionType !== "promise_to_pay" && promisedAmount !== null && promisedAmount < 0) {
      return res.status(400).json({ ok: false, error: "INVALID_PROMISED_AMOUNT" });
    }

    const companyId = await resolveOwnedCompanyId(pool, {
      customerId,
      customerInvoiceId: invoiceId,
      requestedCompanyId: ctx.activeCompanyId,
    });
    const distributorId = ctx.isDistributor ? Number(ctx.distributorId) : null;
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const customerRes = await pool.query(`select id from customers where id = $1 limit 1`, [Number(customerId)]);
    if (!customerRes.rows?.[0]) return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });

    if (distributorId) {
      const allowedRes = await pool.query(
        `
          select 1
          from customer_distributor_links cdl
          where cdl.customer_id = $1
            and cdl.distributor_id = $2
          limit 1
        `,
        [Number(customerId), Number(distributorId)]
      );
      if (!allowedRes.rows?.[0]) return res.status(400).json({ ok: false, error: "CUSTOMER_NOT_ALLOWED" });
    }

    if (invoiceId) {
      const params = [Number(invoiceId), Number(customerId)];
      const where = [`ci.id = $1`, `ci.customer_id = $2`, `ci.invoice_status <> 'cancelled'`];
      if (distributorId) {
        params.push(Number(distributorId));
        where.push(`ci.distributor_id = $3`);
      } else if (companyId) {
        params.push(Number(companyId));
        where.push(`ci.company_id = $3`);
      }
      const iv = await pool.query(`select ci.id from customer_invoices ci where ${where.join(" and ")} limit 1`, params);
      if (!iv.rows?.[0]) return res.status(400).json({ ok: false, error: "INVALID_INVOICE" });
    }

    const r = await pool.query(
      `
        insert into customer_collection_actions (
          company_id,
          distributor_id,
          customer_id,
          customer_invoice_id,
          action_type,
          expected_date,
          promised_amount,
          remarks,
          created_by
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning id, customer_id, customer_invoice_id, action_type, action_date, expected_date, promised_amount, remarks, created_by, created_at
      `,
      [companyId, distributorId, customerId, invoiceId, actionType, expectedDate, actionType === "promise_to_pay" ? promisedAmount : null, remarks || null, Number(req.user.id)]
    );

    if (actionType === "dunning" || actionType === "reminder_sent" || actionType === "follow_up") {
      try {
        const targetInvoiceId = invoiceId;
        if (targetInvoiceId) {
          const cur = await pool.query(
            `select id, dunning_stage, next_dunning_at from customer_invoices where id = $1 and customer_id = $2 limit 1`,
            [targetInvoiceId, customerId]
          );
          const stage = nextDunningStage(cur.rows[0]?.dunning_stage);
          const nextAt = expectedDate || nextDunningDateFromStage(stage);
          await pool.query(
            `
              update customer_invoices
              set dunning_stage = $2,
                  last_dunning_at = current_date,
                  next_dunning_at = $3::date
              where id = $1
            `,
            [targetInvoiceId, stage, nextAt]
          );
        } else {
          await pool.query(
            `
              update customer_invoices ci
              set dunning_stage = least(coalesce(ci.dunning_stage, 0) + 1, 5),
                  last_dunning_at = current_date,
                  next_dunning_at = coalesce($3::date, current_date + interval '7 days')
              where ci.customer_id = $1
                and ci.company_id = $2
                and ci.invoice_status = 'issued'
                and exists (
                  select 1
                  from customer_invoices x
                  where x.id = ci.id
                )
            `,
            [customerId, companyId, expectedDate]
          );
        }
      } catch {
        // Dunning columns may be absent until migration 151 is applied.
      }
    }

    return res.json({ ok: true, action: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.get("/disputes", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCollectionsDisputesReady();
    if (!ready) return res.json({ ok: true, disputes_ready: false, disputes: [] });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const q = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
    const adjustmentsReady = await isArAdjustmentsReady();
    const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady });
    const adjustmentsJoin = getArAdjustmentsJoin({ enabled: adjustmentsReady });

    const params = [];
    const where = [];
    if (ctx.isDistributor) {
      params.push(Number(ctx.distributorId));
      where.push(`d.distributor_id = $${params.length}`);
    } else if (ctx.activeCompanyId) {
      params.push(Number(ctx.activeCompanyId));
      where.push(`d.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "receipts")) {
      params.push(Number(req.user.id));
      where.push(`d.created_by = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(c.customer_name ilike $${params.length} or coalesce(ci.invoice_number, '') ilike $${params.length} or coalesce(ci.customer_po_number, '') ilike $${params.length} or d.dispute_reason ilike $${params.length})`);
    }
    if (status && ["open", "escalated", "resolved"].includes(status)) {
      params.push(status);
      where.push(`d.dispute_status = $${params.length}`);
    }

    const r = await pool.query(
      `
        with invoice_balances as (
          select
            ci.id,
            ${outstandingExpr} as outstanding_invoice
          from customer_invoices ci
          left join (
            select
              cra.customer_invoice_id,
              coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cr.receipt_status = 'posted'
            group by cra.customer_invoice_id
          ) pr on pr.customer_invoice_id = ci.id
          left join (
            select
              customer_invoice_id,
              coalesce(sum(credit_note_amount), 0) as credit_note_amount
            from sales_returns
            where return_status = 'posted'
              and customer_invoice_id is not null
            group by customer_invoice_id
          ) sr on sr.customer_invoice_id = ci.id
          ${adjustmentsJoin}
        )
        select
          d.id,
          d.customer_id,
          c.customer_name,
          d.customer_invoice_id,
          ci.invoice_number,
        ci.customer_po_number,
        ci.customer_po_date,
          d.sales_return_id,
          sr.return_number,
          sr.credit_note_number,
          sr.return_status as linked_return_status,
          sr.credit_note_amount as credited_amount,
          d.dispute_status,
          d.dispute_reason,
          d.disputed_amount,
          d.opened_on,
          d.expected_resolution_date,
          d.remarks,
          d.resolution_notes,
          d.created_by,
          cu.full_name as created_by_name,
          d.resolved_by,
          ru.full_name as resolved_by_name,
          d.resolved_at,
          coalesce(ib.outstanding_invoice, 0) as invoice_outstanding,
          greatest((current_date - d.opened_on), 0)::int as ageing_days
        from customer_collection_disputes d
        join customers c on c.id = d.customer_id
        left join customer_invoices ci on ci.id = d.customer_invoice_id
        left join sales_returns sr on sr.id = d.sales_return_id
        left join invoice_balances ib on ib.id = d.customer_invoice_id
        left join erp_users cu on cu.id = d.created_by
        left join erp_users ru on ru.id = d.resolved_by
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by
          case d.dispute_status
            when 'escalated' then 0
            when 'open' then 1
            else 2
          end,
          d.expected_resolution_date asc nulls last,
          d.opened_on asc,
          d.id desc
        limit ${limit}
      `,
      params
    );

    return res.json({ ok: true, disputes_ready: true, disputes: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/disputes-failure-summary", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCollectionsDisputesReady();
    if (!ready) return res.json({ ok: true, disputes_ready: false, summary: null });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });
    const q = normalizeText(req.query.q);
    const summary = await getDisputeFailureSummary(pool, req, ctx, { q });
    return res.json({ ok: true, disputes_ready: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/disputes-failure-queue", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCollectionsDisputesReady();
    if (!ready) return res.json({ ok: true, disputes_ready: false, rows: [] });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });
    const q = normalizeText(req.query.q);
    const bucket = normalizeText(req.query.bucket).toLowerCase() || "all";
    const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 200);
    const rows = await getDisputeFailureQueue(pool, req, ctx, { q, bucket, limit });
    return res.json({ ok: true, disputes_ready: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/disputes/:id/ncr-detail", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCollectionsDisputesReady();
    if (!ready) return res.status(400).json({ ok: false, error: "COLLECTION_DISPUTES_NOT_READY" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });
    const disputeId = normalizeId(req.params.id);
    if (!disputeId) return res.status(400).json({ ok: false, error: "INVALID_DISPUTE" });
    const dispute = await getCollectionDisputeOrNull(pool, disputeId, ctx, req);
    if (!dispute) return res.status(404).json({ ok: false, error: "DISPUTE_NOT_FOUND" });
    const ncrCases = await getDisputeNcrCases(pool, disputeId);
    const capaActions = await getDisputeCapaActions(pool, disputeId);
    return res.json({ ok: true, dispute, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    return next(err);
  }
});

router.post("/disputes", async (req, res, next) => {
  try {
    if (!hasScreenAction(req, "receipts", "can_edit") && !hasScreenAction(req, "invoices", "can_edit")) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const ready = await isCollectionsDisputesReady();
    if (!ready) return res.status(400).json({ ok: false, error: "COLLECTION_DISPUTES_NOT_READY" });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const customerId = normalizeId(body.customer_id);
    const invoiceId = body.customer_invoice_id ? normalizeId(body.customer_invoice_id) : null;
    const disputeReason = normalizeText(body.dispute_reason);
    const expectedResolutionDate = normalizeDate(body.expected_resolution_date);
    const disputedAmount = Number(body.disputed_amount);
    const remarks = normalizeText(body.remarks);

    if (!customerId) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    if (!disputeReason) return res.status(400).json({ ok: false, error: "INVALID_DISPUTE_REASON" });
    if (!Number.isFinite(disputedAmount) || disputedAmount <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_DISPUTED_AMOUNT" });
    }

    const companyId = await resolveOwnedCompanyId(pool, {
      customerId,
      customerInvoiceId: invoiceId,
      requestedCompanyId: ctx.activeCompanyId,
    });
    const distributorId = ctx.isDistributor ? Number(ctx.distributorId) : null;
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    if (invoiceId) {
      const params = [Number(invoiceId), Number(customerId)];
      const where = [`ci.id = $1`, `ci.customer_id = $2`, `ci.invoice_status <> 'cancelled'`];
      if (distributorId) {
        params.push(Number(distributorId));
        where.push(`ci.distributor_id = $3`);
      } else if (companyId) {
        params.push(Number(companyId));
        where.push(`ci.company_id = $3`);
      }
      const iv = await pool.query(`select ci.id from customer_invoices ci where ${where.join(" and ")} limit 1`, params);
      if (!iv.rows?.[0]) return res.status(400).json({ ok: false, error: "INVALID_INVOICE" });
    }

    const r = await pool.query(
      `
        insert into customer_collection_disputes (
          company_id,
          distributor_id,
          customer_id,
          customer_invoice_id,
          dispute_status,
          dispute_reason,
          disputed_amount,
          expected_resolution_date,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9)
        returning *
      `,
      [companyId, distributorId, customerId, invoiceId, disputeReason, disputedAmount, expectedResolutionDate, remarks || null, Number(req.user.id)]
    );

    return res.status(201).json({ ok: true, dispute: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/disputes/:id/status", async (req, res, next) => {
  try {
    if (!hasScreenAction(req, "receipts", "can_edit") && !hasScreenAction(req, "invoices", "can_edit")) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const ready = await isCollectionsDisputesReady();
    if (!ready) return res.status(400).json({ ok: false, error: "COLLECTION_DISPUTES_NOT_READY" });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const disputeId = normalizeId(req.params.id);
    if (!disputeId) return res.status(400).json({ ok: false, error: "INVALID_DISPUTE" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const nextStatus = normalizeText(body.dispute_status);
    const resolutionNotes = normalizeText(body.resolution_notes);
    const expectedResolutionDate = normalizeDate(body.expected_resolution_date);
    if (!["open", "escalated", "resolved"].includes(nextStatus)) {
      return res.status(400).json({ ok: false, error: "INVALID_DISPUTE_STATUS" });
    }

    const params = [Number(disputeId)];
    const where = [`id = $1`];
    if (ctx.isDistributor) {
      params.push(Number(ctx.distributorId));
      where.push(`distributor_id = $${params.length}`);
    } else if (ctx.activeCompanyId) {
      params.push(Number(ctx.activeCompanyId));
      where.push(`company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "receipts")) {
      params.push(Number(req.user.id));
      where.push(`created_by = $${params.length}`);
    }

    params.push(nextStatus);
    params.push(expectedResolutionDate);
    params.push(resolutionNotes || null);
    params.push(nextStatus === "resolved" ? Number(req.user.id) : null);

    const r = await pool.query(
      `
        update customer_collection_disputes
        set dispute_status = $${params.length - 3},
            expected_resolution_date = coalesce($${params.length - 2}, expected_resolution_date),
            resolution_notes = case
              when $${params.length - 1} is not null and $${params.length - 1} <> '' then $${params.length - 1}
              else resolution_notes
            end,
            resolved_by = case when $${params.length - 3} = 'resolved' then $${params.length} else null end,
            resolved_at = case when $${params.length - 3} = 'resolved' then now() else null end,
            updated_at = now()
        where ${where.join(" and ")}
        returning *
      `,
      params
    );
    if (!r.rows?.[0]) return res.status(404).json({ ok: false, error: "DISPUTE_NOT_FOUND" });

    return res.json({ ok: true, dispute: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/disputes/:id/ncr-cases", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!hasScreenAction(req, "receipts", "can_edit") && !hasScreenAction(req, "invoices", "can_edit")) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const ready = await isCollectionsDisputesReady();
    if (!ready) return res.status(400).json({ ok: false, error: "COLLECTION_DISPUTES_NOT_READY" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });
    const disputeId = normalizeId(req.params.id);
    if (!disputeId) return res.status(400).json({ ok: false, error: "INVALID_DISPUTE" });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    await client.query("begin");
    const dispute = await getCollectionDisputeOrNull(client, disputeId, ctx, req);
    if (!dispute) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "DISPUTE_NOT_FOUND" });
    }
    const defectSummary = normalizeText(body.defect_summary);
    if (!defectSummary) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DEFECT_SUMMARY_REQUIRED" });
    }
    const resolvedCompanyId = normalizeId(dispute.company_id) || normalizeId(dispute.invoice_company_id);
    if (!resolvedCompanyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_CONTEXT_MISSING" });
    }
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const status = deriveNcrStatus(body, actions);
    const numRes = await client.query(`select next_company_document_number($1,'NCR') as ncr_number`, [resolvedCompanyId]);
    const ncrNumber = numRes.rows[0]?.ncr_number;
    const insertRes = await client.query(
      `
        insert into quality_ncr_cases (
          company_id,
          ncr_number,
          quality_control_id,
          quality_control_line_id,
          service_warranty_case_id,
          service_warranty_case_line_id,
          service_warranty_movement_id,
          customer_collection_dispute_id,
          sales_return_id,
          source_type,
          severity,
          category,
          qty_affected,
          defect_summary,
          containment_action,
          containment_due_date,
          containment_completed_date,
          root_cause,
          corrective_plan,
          preventive_plan,
          verification_method,
          verification_date,
          status,
          remarks,
          created_by
        )
        values ($1,$2,null,null,null,null,null,$3,$4,'collection_dispute',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        returning id
      `,
      [
        resolvedCompanyId,
        ncrNumber,
        disputeId,
        normalizeId(body.sales_return_id || dispute.sales_return_id),
        normalizeSeverity(body.severity),
        normalizeNcrCategory(body.category),
        normalizeQty4(body.qty_affected),
        defectSummary,
        normalizeText(body.containment_action) || null,
        normalizeDate(body.containment_due_date),
        normalizeDate(body.containment_completed_date),
        normalizeText(body.root_cause) || null,
        normalizeText(body.corrective_plan) || null,
        normalizeText(body.preventive_plan) || null,
        normalizeText(body.verification_method) || null,
        normalizeDate(body.verification_date),
        status,
        normalizeText(body.remarks) || null,
        Number(req.user.id),
      ]
    );
    const ncrCaseId = Number(insertRes.rows[0]?.id);
    for (const raw of actions) {
      const title = normalizeText(raw.action_title);
      const actionType = normalizeText(raw.action_type).toLowerCase();
      const actionStatus = normalizeActionStatus(raw.action_status) || "open";
      if (!title || !["correction", "corrective", "preventive"].includes(actionType)) continue;
      await client.query(
        `
          insert into quality_capa_actions (
            ncr_case_id,
            action_type,
            action_title,
            owner_user_id,
            due_date,
            completed_date,
            action_status,
            completion_note,
            created_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          ncrCaseId,
          actionType,
          title,
          normalizeId(raw.owner_user_id),
          normalizeDate(raw.due_date),
          normalizeDate(raw.completed_date),
          actionStatus,
          normalizeText(raw.completion_note) || null,
          Number(req.user.id),
        ]
      );
    }
    await client.query(`update customer_collection_disputes set updated_at = now() where id = $1`, [disputeId]);
    await client.query("commit");
    const nextDispute = await getCollectionDisputeOrNull(client, disputeId, ctx, req);
    const ncrCases = await getDisputeNcrCases(client, disputeId);
    const capaActions = await getDisputeCapaActions(client, disputeId);
    return res.status(201).json({ ok: true, dispute: nextDispute, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/ncr-cases/:ncrId", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!hasScreenAction(req, "receipts", "can_edit") && !hasScreenAction(req, "invoices", "can_edit")) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const ready = await isCollectionsDisputesReady();
    if (!ready) return res.status(400).json({ ok: false, error: "COLLECTION_DISPUTES_NOT_READY" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });
    const ncrId = normalizeId(req.params.ncrId);
    if (!ncrId) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    await client.query("begin");
    const ncrRes = await client.query(
      `select * from quality_ncr_cases where id = $1 and source_type = 'collection_dispute' limit 1`,
      [ncrId]
    );
    const ncr = ncrRes.rows[0] || null;
    if (!ncr) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    const dispute = await getCollectionDisputeOrNull(client, ncr.customer_collection_dispute_id, ctx, req);
    if (!dispute) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "DISPUTE_NOT_FOUND" });
    }
    const defectSummary = normalizeText(body.defect_summary) || ncr.defect_summary;
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const derivedStatus = deriveNcrStatus({ ...ncr, ...body, defect_summary: defectSummary }, actions.length ? actions : [{ action_status: "done" }]);
    await client.query(
      `
        update quality_ncr_cases
        set sales_return_id = $2,
            severity = $3,
            category = $4,
            qty_affected = $5,
            defect_summary = $6,
            containment_action = $7,
            containment_due_date = $8,
            containment_completed_date = $9,
            root_cause = $10,
            corrective_plan = $11,
            preventive_plan = $12,
            verification_method = $13,
            verification_date = $14,
            status = $15,
            remarks = $16,
            updated_at = now()
        where id = $1
      `,
      [
        ncrId,
        normalizeId(body.sales_return_id ?? ncr.sales_return_id),
        normalizeSeverity(body.severity || ncr.severity),
        normalizeNcrCategory(body.category || ncr.category),
        normalizeQty4(body.qty_affected ?? ncr.qty_affected),
        defectSummary,
        normalizeText(body.containment_action) || ncr.containment_action,
        normalizeDate(body.containment_due_date) || ncr.containment_due_date,
        normalizeDate(body.containment_completed_date) || ncr.containment_completed_date,
        normalizeText(body.root_cause) || ncr.root_cause,
        normalizeText(body.corrective_plan) || ncr.corrective_plan,
        normalizeText(body.preventive_plan) || ncr.preventive_plan,
        normalizeText(body.verification_method) || ncr.verification_method,
        normalizeDate(body.verification_date) || ncr.verification_date,
        derivedStatus,
        normalizeText(body.remarks) || ncr.remarks,
      ]
    );

    const existingActionsRes = await client.query(`select id from quality_capa_actions where ncr_case_id = $1`, [ncrId]);
    const existingActionIds = new Set(existingActionsRes.rows.map((row) => Number(row.id)));
    const seenIds = new Set();
    for (const raw of actions) {
      const actionId = normalizeId(raw.id);
      const title = normalizeText(raw.action_title);
      const actionType = normalizeText(raw.action_type).toLowerCase();
      const actionStatus = normalizeActionStatus(raw.action_status) || "open";
      if (!title || !["correction", "corrective", "preventive"].includes(actionType)) continue;
      if (actionId && existingActionIds.has(actionId)) {
        seenIds.add(actionId);
        await client.query(
          `
            update quality_capa_actions
            set action_type = $2,
                action_title = $3,
                owner_user_id = $4,
                due_date = $5,
                completed_date = $6,
                action_status = $7,
                completion_note = $8,
                updated_at = now()
            where id = $1 and ncr_case_id = $9
          `,
          [
            actionId,
            actionType,
            title,
            normalizeId(raw.owner_user_id),
            normalizeDate(raw.due_date),
            normalizeDate(raw.completed_date),
            actionStatus,
            normalizeText(raw.completion_note) || null,
            ncrId,
          ]
        );
      } else {
        await client.query(
          `
            insert into quality_capa_actions (
              ncr_case_id,
              action_type,
              action_title,
              owner_user_id,
              due_date,
              completed_date,
              action_status,
              completion_note,
              created_by
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `,
          [
            ncrId,
            actionType,
            title,
            normalizeId(raw.owner_user_id),
            normalizeDate(raw.due_date),
            normalizeDate(raw.completed_date),
            actionStatus,
            normalizeText(raw.completion_note) || null,
            Number(req.user.id),
          ]
        );
      }
    }
    for (const row of existingActionsRes.rows) {
      const actionId = Number(row.id);
      if (seenIds.has(actionId)) continue;
      const retained = actions.some((raw) => normalizeId(raw.id) === actionId);
      if (!retained) {
        await client.query(`delete from quality_capa_actions where id = $1 and ncr_case_id = $2`, [actionId, ncrId]);
      }
    }
    await client.query(`update customer_collection_disputes set updated_at = now() where id = $1`, [ncr.customer_collection_dispute_id]);
    await client.query("commit");
    const nextDispute = await getCollectionDisputeOrNull(client, ncr.customer_collection_dispute_id, ctx, req);
    const ncrCases = await getDisputeNcrCases(client, ncr.customer_collection_dispute_id);
    const capaActions = await getDisputeCapaActions(client, ncr.customer_collection_dispute_id);
    return res.json({ ok: true, dispute: nextDispute, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/adjustments", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isArAdjustmentsReady();
    if (!ready) return res.json({ ok: true, adjustments_ready: false, adjustments: [] });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const q = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    const type = normalizeText(req.query.type);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
    const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady: true, adjustmentAlias: "adj_total" });
    const adjustmentsJoin = getArAdjustmentsJoin({ enabled: true, invoiceAlias: "ci", adjustmentAlias: "adj_total" });

    const params = [];
    const where = [];
    if (ctx.isDistributor) {
      params.push(Number(ctx.distributorId));
      where.push(`a.distributor_id = $${params.length}`);
    } else if (ctx.activeCompanyId) {
      params.push(Number(ctx.activeCompanyId));
      where.push(`a.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "receipts")) {
      params.push(Number(req.user.id));
      where.push(`a.created_by = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(c.customer_name ilike $${params.length} or coalesce(ci.invoice_number, '') ilike $${params.length} or coalesce(ci.customer_po_number, '') ilike $${params.length} or a.reason ilike $${params.length} or coalesce(a.remarks, '') ilike $${params.length})`
      );
    }
    if (status && ["draft", "posted", "cancelled"].includes(status)) {
      params.push(status);
      where.push(`a.adjustment_status = $${params.length}`);
    }
    if (type && arAdjustmentTypes.includes(type)) {
      params.push(type);
      where.push(`a.adjustment_type = $${params.length}`);
    }

    const r = await pool.query(
      `
        with invoice_balances as (
          select
            ci.id,
            ${outstandingExpr} as outstanding_invoice
          from customer_invoices ci
          left join (
            select
              cra.customer_invoice_id,
              coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cr.receipt_status = 'posted'
            group by cra.customer_invoice_id
          ) pr on pr.customer_invoice_id = ci.id
          left join (
            select
              customer_invoice_id,
              coalesce(sum(credit_note_amount), 0) as credit_note_amount
            from sales_returns
            where return_status = 'posted'
              and customer_invoice_id is not null
            group by customer_invoice_id
          ) sr on sr.customer_invoice_id = ci.id
          ${adjustmentsJoin}
        )
        select
          a.id,
          a.customer_id,
          c.customer_name,
          a.customer_invoice_id,
          ci.invoice_number,
        ci.customer_po_number,
        ci.customer_po_date,
          a.adjustment_type,
          a.adjustment_status,
          a.adjustment_amount,
          a.reason,
          a.remarks,
          a.created_by,
          cu.full_name as created_by_name,
          a.created_at,
          a.posted_by,
          pu.full_name as posted_by_name,
          a.posted_at,
          a.cancelled_by,
          xu.full_name as cancelled_by_name,
          a.cancelled_at,
          coalesce(ib.outstanding_invoice, 0) as invoice_outstanding
        from customer_ar_adjustments a
        join customers c on c.id = a.customer_id
        join customer_invoices ci on ci.id = a.customer_invoice_id
        left join invoice_balances ib on ib.id = a.customer_invoice_id
        left join erp_users cu on cu.id = a.created_by
        left join erp_users pu on pu.id = a.posted_by
        left join erp_users xu on xu.id = a.cancelled_by
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by
          case a.adjustment_status
            when 'draft' then 0
            when 'posted' then 1
            else 2
          end,
          coalesce(a.posted_at, a.cancelled_at, a.created_at) desc,
          a.id desc
        limit ${limit}
      `,
      params
    );

    return res.json({ ok: true, adjustments_ready: true, adjustments: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/adjustments", async (req, res, next) => {
  try {
    if (!hasScreenAction(req, "receipts", "can_edit") && !hasScreenAction(req, "invoices", "can_edit")) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const ready = await isArAdjustmentsReady();
    if (!ready) return res.status(400).json({ ok: false, error: "AR_ADJUSTMENTS_NOT_READY" });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const customerId = normalizeId(body.customer_id);
    const invoiceId = normalizeId(body.customer_invoice_id);
    const adjustmentType = normalizeText(body.adjustment_type);
    const adjustmentAmount = normalizeAmount(body.adjustment_amount);
    const reason = normalizeText(body.reason);
    const remarks = normalizeText(body.remarks);

    if (!customerId) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    if (!invoiceId) return res.status(400).json({ ok: false, error: "INVALID_INVOICE" });
    if (!arAdjustmentTypes.includes(adjustmentType)) {
      return res.status(400).json({ ok: false, error: "INVALID_ADJUSTMENT_TYPE" });
    }
    if (adjustmentAmount === null || adjustmentAmount <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_ADJUSTMENT_AMOUNT" });
    }
    if (!reason) return res.status(400).json({ ok: false, error: "INVALID_ADJUSTMENT_REASON" });

    const companyId = await resolveOwnedCompanyId(pool, {
      customerId,
      customerInvoiceId: invoiceId,
      requestedCompanyId: ctx.activeCompanyId,
    });
    const distributorId = ctx.isDistributor ? Number(ctx.distributorId) : null;
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady: true, adjustmentAlias: "adj_total" });
    const adjustmentsJoin = getArAdjustmentsJoin({ enabled: true, invoiceAlias: "ci", adjustmentAlias: "adj_total" });

    const params = [Number(invoiceId), Number(customerId)];
    const where = [`ci.id = $1`, `ci.customer_id = $2`, `ci.invoice_status <> 'cancelled'`];
    if (distributorId) {
      params.push(Number(distributorId));
      where.push(`ci.distributor_id = $${params.length}`);
    } else if (companyId) {
      params.push(Number(companyId));
      where.push(`ci.company_id = $${params.length}`);
    }

    const invoiceRes = await pool.query(
      `
        select
          ci.id,
          ci.customer_id,
          ${outstandingExpr} as outstanding_invoice
        from customer_invoices ci
        left join (
          select
            cra.customer_invoice_id,
            coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
          from customer_receipt_allocations cra
          join customer_receipts cr on cr.id = cra.customer_receipt_id
          where cr.receipt_status = 'posted'
          group by cra.customer_invoice_id
        ) pr on pr.customer_invoice_id = ci.id
        left join (
          select
            customer_invoice_id,
            coalesce(sum(credit_note_amount), 0) as credit_note_amount
          from sales_returns
          where return_status = 'posted'
            and customer_invoice_id is not null
          group by customer_invoice_id
        ) sr on sr.customer_invoice_id = ci.id
        ${adjustmentsJoin}
        where ${where.join(" and ")}
        limit 1
      `,
      params
    );
    const invoiceRow = invoiceRes.rows[0];
    if (!invoiceRow) return res.status(400).json({ ok: false, error: "INVALID_INVOICE" });
    if (Number(invoiceRow.outstanding_invoice || 0) <= 0.0001) {
      return res.status(409).json({ ok: false, error: "INVOICE_ALREADY_SETTLED" });
    }
    if (adjustmentAmount - Number(invoiceRow.outstanding_invoice || 0) > 0.0001) {
      return res.status(400).json({ ok: false, error: "ADJUSTMENT_EXCEEDS_OUTSTANDING" });
    }

    const r = await pool.query(
      `
        insert into customer_ar_adjustments (
          company_id,
          distributor_id,
          customer_id,
          customer_invoice_id,
          adjustment_type,
          adjustment_status,
          adjustment_amount,
          reason,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9)
        returning *
      `,
      [companyId, distributorId, customerId, invoiceId, adjustmentType, adjustmentAmount, reason, remarks || null, Number(req.user.id)]
    );

    return res.status(201).json({ ok: true, adjustment: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/adjustments/:id/status", async (req, res, next) => {
  try {
    if (!hasScreenAction(req, "receipts", "can_edit") && !hasScreenAction(req, "invoices", "can_edit")) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const ready = await isArAdjustmentsReady();
    if (!ready) return res.status(400).json({ ok: false, error: "AR_ADJUSTMENTS_NOT_READY" });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const adjustmentId = normalizeId(req.params.id);
    if (!adjustmentId) return res.status(400).json({ ok: false, error: "INVALID_ADJUSTMENT" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const nextStatus = normalizeText(body.adjustment_status);
    if (!["posted", "cancelled"].includes(nextStatus)) {
      return res.status(400).json({ ok: false, error: "INVALID_ADJUSTMENT_STATUS" });
    }

    const params = [Number(adjustmentId)];
    const where = [`id = $1`];
    if (ctx.isDistributor) {
      params.push(Number(ctx.distributorId));
      where.push(`distributor_id = $${params.length}`);
    } else if (ctx.activeCompanyId) {
      params.push(Number(ctx.activeCompanyId));
      where.push(`company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "receipts")) {
      params.push(Number(req.user.id));
      where.push(`created_by = $${params.length}`);
    }

    const currentRes = await pool.query(
      `select * from customer_ar_adjustments where ${where.join(" and ")} limit 1`,
      params
    );
    const current = currentRes.rows[0];
    if (!current) return res.status(404).json({ ok: false, error: "ADJUSTMENT_NOT_FOUND" });
    if (String(current.adjustment_status || "").toLowerCase() !== "draft") {
      return res.status(409).json({ ok: false, error: "ADJUSTMENT_NOT_EDITABLE" });
    }

    if (nextStatus === "posted") {
      const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady: true, adjustmentAlias: "adj_total" });
      const adjustmentsJoin = getArAdjustmentsJoin({ enabled: true, invoiceAlias: "ci", adjustmentAlias: "adj_total" });
      const invoiceParams = [Number(current.customer_invoice_id), Number(current.customer_id)];
      const invoiceWhere = [`ci.id = $1`, `ci.customer_id = $2`, `ci.invoice_status <> 'cancelled'`];
      if (ctx.isDistributor) {
        invoiceParams.push(Number(ctx.distributorId));
        invoiceWhere.push(`ci.distributor_id = $${invoiceParams.length}`);
      } else if (ctx.activeCompanyId) {
        invoiceParams.push(Number(ctx.activeCompanyId));
        invoiceWhere.push(`ci.company_id = $${invoiceParams.length}`);
      }
      const invoiceRes = await pool.query(
        `
          select
            ci.id,
            ${outstandingExpr} as outstanding_invoice
          from customer_invoices ci
          left join (
            select
              cra.customer_invoice_id,
              coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cr.receipt_status = 'posted'
            group by cra.customer_invoice_id
          ) pr on pr.customer_invoice_id = ci.id
          left join (
            select
              customer_invoice_id,
              coalesce(sum(credit_note_amount), 0) as credit_note_amount
            from sales_returns
            where return_status = 'posted'
              and customer_invoice_id is not null
            group by customer_invoice_id
          ) sr on sr.customer_invoice_id = ci.id
          ${adjustmentsJoin}
          where ${invoiceWhere.join(" and ")}
          limit 1
        `,
        invoiceParams
      );
      const invoiceRow = invoiceRes.rows[0];
      if (!invoiceRow) return res.status(400).json({ ok: false, error: "INVALID_INVOICE" });
      if (Number(current.adjustment_amount || 0) - Number(invoiceRow.outstanding_invoice || 0) > 0.0001) {
        return res.status(400).json({ ok: false, error: "ADJUSTMENT_EXCEEDS_OUTSTANDING" });
      }
    }

    const updateParams = [
      Number(adjustmentId),
      nextStatus,
      nextStatus === "posted" ? Number(req.user.id) : null,
      nextStatus === "cancelled" ? Number(req.user.id) : null,
    ];
    const scopedWhere = [`id = $1`];
    if (ctx.isDistributor) {
      updateParams.push(Number(ctx.distributorId));
      scopedWhere.push(`distributor_id = $${updateParams.length}`);
    } else if (ctx.activeCompanyId) {
      updateParams.push(Number(ctx.activeCompanyId));
      scopedWhere.push(`company_id = $${updateParams.length}`);
    }
    if (ownRecordsOnly(req, "receipts")) {
      updateParams.push(Number(req.user.id));
      scopedWhere.push(`created_by = $${updateParams.length}`);
    }

    const r = await pool.query(
      `
        update customer_ar_adjustments
        set adjustment_status = $2,
            posted_by = case when $2 = 'posted' then $3 else posted_by end,
            posted_at = case when $2 = 'posted' then now() else posted_at end,
            cancelled_by = case when $2 = 'cancelled' then $4 else cancelled_by end,
            cancelled_at = case when $2 = 'cancelled' then now() else cancelled_at end,
            updated_at = now()
        where ${scopedWhere.join(" and ")}
        returning *
      `,
      updateParams
    );
    if (!r.rows?.[0]) return res.status(404).json({ ok: false, error: "ADJUSTMENT_NOT_FOUND" });

    return res.json({ ok: true, adjustment: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.get("/customers/:customerId/actions", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ready = await isCollectionsFollowupsReady();
    if (!ready) return res.json({ ok: true, followups_ready: false, actions: [] });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const customerId = normalizeId(req.params.customerId);
    if (!customerId) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });

    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);

    const params = [customerId];
    const where = [`a.customer_id = $${params.length}`];
    if (ctx.isDistributor) {
      params.push(Number(ctx.distributorId));
      where.push(`a.distributor_id = $${params.length}`);
    } else if (ctx.activeCompanyId) {
      params.push(Number(ctx.activeCompanyId));
      where.push(`a.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "receipts")) {
      params.push(Number(req.user.id));
      where.push(`a.created_by = $${params.length}`);
    }

    const r = await pool.query(
      `
        select
          a.id,
          a.customer_id,
          a.customer_invoice_id,
          inv.invoice_number,
          a.action_type,
          a.action_date,
          a.expected_date,
          a.promised_amount,
          a.remarks,
          a.created_by,
          u.full_name as created_by_name,
          a.created_at
        from customer_collection_actions a
        left join customer_invoices inv on inv.id = a.customer_invoice_id
        left join erp_users u on u.id = a.created_by
        where ${where.join(" and ")}
        order by a.action_date desc, a.id desc
        limit ${limit}
      `,
      params
    );

    return res.json({ ok: true, followups_ready: true, actions: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/credit-notes", async (req, res, next) => {
  try {
    if (!canViewAnyCollectionsDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
    const q = normalizeText(req.query.q);
    const rows = [];

    const srParams = [];
    const srWhere = [`sr.return_status = 'posted'`, `coalesce(sr.credit_note_amount, 0) > 0.0001`];
    if (ctx.isDistributor) {
      srParams.push(Number(ctx.distributorId));
      srWhere.push(`sr.distributor_id = $${srParams.length}`);
    } else if (ctx.activeCompanyId) {
      srParams.push(Number(ctx.activeCompanyId));
      srWhere.push(`sr.company_id = $${srParams.length}`);
    }
    if (q) {
      srParams.push(`%${q}%`);
      srWhere.push(`(c.customer_name ilike $${srParams.length} or coalesce(sr.return_number, '') ilike $${srParams.length} or coalesce(sr.credit_note_number, '') ilike $${srParams.length})`);
    }
    const sr = await pool.query(
      `
        select
          'sales_return'::text as source,
          sr.id as source_id,
          coalesce(nullif(sr.credit_note_number, ''), sr.return_number) as credit_note_number,
          sr.return_date as credit_note_date,
          sr.credit_note_amount as amount,
          sr.customer_id,
          c.customer_name,
          sr.customer_invoice_id,
          ci.invoice_number,
          sr.return_status as status
        from sales_returns sr
        join customers c on c.id = sr.customer_id
        left join customer_invoices ci on ci.id = sr.customer_invoice_id
        where ${srWhere.join(" and ")}
        order by sr.return_date desc, sr.id desc
        limit ${limit}
      `,
      srParams
    );
    rows.push(...sr.rows);

    const adjustmentsReady = await isArAdjustmentsReady();
    if (adjustmentsReady) {
      const adjParams = [];
      const adjWhere = [`a.adjustment_status = 'posted'`, `a.adjustment_type = 'commercial_credit_note'`];
      if (ctx.isDistributor) {
        adjParams.push(Number(ctx.distributorId));
        adjWhere.push(`a.distributor_id = $${adjParams.length}`);
      } else if (ctx.activeCompanyId) {
        adjParams.push(Number(ctx.activeCompanyId));
        adjWhere.push(`a.company_id = $${adjParams.length}`);
      }
      if (q) {
        adjParams.push(`%${q}%`);
        adjWhere.push(`(c.customer_name ilike $${adjParams.length} or coalesce(a.adjustment_number, '') ilike $${adjParams.length})`);
      }
      const adj = await pool.query(
        `
          select
            'ar_adjustment'::text as source,
            a.id as source_id,
            a.adjustment_number as credit_note_number,
            a.adjustment_date as credit_note_date,
            a.adjustment_amount as amount,
            a.customer_id,
            c.customer_name,
            a.customer_invoice_id,
            ci.invoice_number,
            a.adjustment_status as status
          from customer_ar_adjustments a
          join customers c on c.id = a.customer_id
          left join customer_invoices ci on ci.id = a.customer_invoice_id
          where ${adjWhere.join(" and ")}
          order by a.adjustment_date desc, a.id desc
          limit ${limit}
        `,
        adjParams
      );
      rows.push(...adj.rows);
    }

    rows.sort((a, b) => String(b.credit_note_date || "").localeCompare(String(a.credit_note_date || "")));
    return res.json({ ok: true, credit_notes: rows.slice(0, limit) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
