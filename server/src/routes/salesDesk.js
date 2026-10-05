const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly } = require("../auth/authorization");
const { getActiveCompanyId } = require("../services/companyContext");
const { getDistributorIdForUser } = require("../services/mailAccounts");
const { loadQuoteScope } = require("../services/quoteTeamScope");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function canViewAnySalesDesk(req) {
  return (
    hasScreenAction(req, "quotes", "can_view") ||
    hasScreenAction(req, "sales_orders", "can_view") ||
    hasScreenAction(req, "dispatches", "can_view") ||
    hasScreenAction(req, "invoices", "can_view")
  );
}

async function loadContextFilters(req) {
  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
  if (isDistributor && !distributorId) return { ok: false, error: "DISTRIBUTOR_NOT_LINKED" };
  const activeCompanyId = !isDistributor ? getActiveCompanyId(req) : null;
  if (!isDistributor && !activeCompanyId) return { ok: false, error: "COMPANY_NOT_SELECTED" };
  if (!req.quoteScope && req.user.group_name !== "SuperAdmin" && ownRecordsOnly(req, "quotes")) {
    req.quoteScope = await loadQuoteScope(pool, req.user.id);
  }
  return { ok: true, isDistributor, distributorId, activeCompanyId };
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
      if (screenKey === "quotes" && req.quoteScope?.userIds?.size) {
        params.push([...req.quoteScope.userIds]);
        where.push(`coalesce(${alias}.owner_user_id, ${alias}.created_by) = any($${params.length}::int[])`);
      } else {
        params.push(Number(req.user.id));
        where.push(`${alias}.created_by = $${params.length}`);
      }
    }
  } else {
    where.push("false");
  }
  return { params, whereSql: where.length ? `where ${where.join(" and ")}` : "" };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value, fallback = 80, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function getDaysSince(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - dt.getTime()) / 86400000));
}

function buildQuoteQueueMetadata(row) {
  const status = String(row?.record_status || "").trim().toLowerCase();
  const ageDays = getDaysSince(row?.updated_at);

  if (status === "pending_approval") {
    return {
      age_days: ageDays,
      queue_reason: "Waiting for approval before issue.",
      recommended_action: "review_approval",
      recommended_action_label: "Review approval",
    };
  }

  if (status === "approved") {
    return {
      age_days: ageDays,
      queue_reason: "Approved quote should be issued before order conversion.",
      recommended_action: "issue_quote",
      recommended_action_label: "Issue PDF",
    };
  }

  if (status === "issued" || status === "sent") {
    return {
      age_days: ageDays,
      queue_reason: "Issued quote is waiting for sales order conversion.",
      recommended_action: "convert_to_so",
      recommended_action_label: "Convert to SO",
    };
  }

  return {
    age_days: ageDays,
    queue_reason: "Review the quote and take the next sales step.",
    recommended_action: "open_quote",
    recommended_action_label: "Open quote",
  };
}

async function isArAdjustmentsReady() {
  const r = await pool.query(`select to_regclass('public.customer_ar_adjustments') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
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

router.use(requireAuth);

router.get("/summary", async (req, res, next) => {
  try {
    if (!canViewAnySalesDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const summary = {};

    if (hasScreenAction(req, "quotes", "can_view")) {
      const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
      try {
        await pool.query(
          `
            update quote_headers q
            set
              lapsed_at = coalesce(q.lapsed_at, now()),
              quote_status = 'lapsed',
              updated_at = now()
            ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = any($${base.params.length + 1}::text[])
              and q.quote_valid_till is not null
              and q.quote_valid_till < current_date
              and not exists (
                select 1
                from quote_revisions qr
                join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
                where qr.quote_id = q.id
              )
          `,
          [...base.params, ["issued", "sent", "approved"]]
        );
      } catch (_err) {
        // lapsed_at column may not exist until migration 152
      }
      const draftRes = await pool.query(
        `
          select count(*)::int as count
          from quote_headers q
          ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = 'draft'
        `,
        base.params
      );
      const submittedRes = await pool.query(
        `
          select count(*)::int as count
          from quote_headers q
          ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = 'pending_approval'
        `,
        base.params
      );
      const unconvertedRes = await pool.query(
        `
          select count(*)::int as count
          from quote_headers q
          join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id
          ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = any($${base.params.length + 1}::text[])
            and so.id is null
        `,
        [...base.params, ["approved", "issued", "sent"]]
      );
      const issuedAgingRes = await pool.query(
        `
          select count(*)::int as count
          from quote_headers q
          join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = any($${base.params.length + 1}::text[])
            and so.id is null
        `,
        [...base.params, ["issued", "sent"]]
      );
      const expiringRes = await pool.query(
        `
          select count(*)::int as count
          from quote_headers q
          join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = any($${base.params.length + 1}::text[])
            and so.id is null
            and q.quote_valid_till is not null
            and q.quote_valid_till <= (current_date + interval '7 days')
            and q.quote_valid_till >= current_date
        `,
        [...base.params, ["issued", "sent", "approved"]]
      );
      const followUpDueRes = await pool.query(
        `
          select count(*)::int as count
          from quote_headers q
          join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = any($${base.params.length + 1}::text[])
            and so.id is null
            and q.next_follow_up_at is not null
            and q.next_follow_up_at::date <= current_date
        `,
        [...base.params, ["issued", "sent", "approved"]]
      );
      const aging3Res = await pool.query(
        `
          select count(*)::int as count
          from quote_headers q
          join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = any($${base.params.length + 1}::text[])
            and so.id is null
            and coalesce(qr.issued_at, q.updated_at) <= now() - interval '3 days'
        `,
        [...base.params, ["issued", "sent"]]
      );
      const aging7Res = await pool.query(
        `
          select count(*)::int as count
          from quote_headers q
          join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = any($${base.params.length + 1}::text[])
            and so.id is null
            and coalesce(qr.issued_at, q.updated_at) <= now() - interval '7 days'
        `,
        [...base.params, ["issued", "sent"]]
      );
      const aging14Res = await pool.query(
        `
          select count(*)::int as count
          from quote_headers q
          join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = any($${base.params.length + 1}::text[])
            and so.id is null
            and coalesce(qr.issued_at, q.updated_at) <= now() - interval '14 days'
        `,
        [...base.params, ["issued", "sent"]]
      );
      let lapsedCount = 0;
      let issuedNotSentCount = 0;
      try {
        const lapsedRes = await pool.query(
          `
            select count(*)::int as count
            from quote_headers q
            join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
            left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
            ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = 'lapsed'
              and so.id is null
          `,
          base.params
        );
        lapsedCount = Number(lapsedRes.rows[0]?.count || 0);
        const issuedNotSentRes = await pool.query(
          `
            select count(*)::int as count
            from quote_headers q
            join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
            left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
            ${base.whereSql}${base.whereSql ? " and" : "where"} q.quote_status = 'issued'
              and qr.revision_status = 'issued'
              and q.first_sent_at is null
              and so.id is null
          `,
          base.params
        );
        issuedNotSentCount = Number(issuedNotSentRes.rows[0]?.count || 0);
      } catch (_err) {
        lapsedCount = 0;
        issuedNotSentCount = 0;
      }
      summary.quotes = {
        draft: Number(draftRes.rows[0]?.count || 0),
        submitted: Number(submittedRes.rows[0]?.count || 0),
        approved_unconverted: Number(unconvertedRes.rows[0]?.count || 0),
        issued_aging: Number(issuedAgingRes.rows[0]?.count || 0),
        expiring_7d: Number(expiringRes.rows[0]?.count || 0),
        follow_up_due: Number(followUpDueRes.rows[0]?.count || 0),
        aging_3d: Number(aging3Res.rows[0]?.count || 0),
        aging_7d: Number(aging7Res.rows[0]?.count || 0),
        aging_14d: Number(aging14Res.rows[0]?.count || 0),
        lapsed: lapsedCount,
        issued_not_sent: issuedNotSentCount,
      };

      try {
        const engRes = await pool.query(
          `
            select
              count(*) filter (where er.request_status = 'ready')::int as ready_for_sales,
              count(*) filter (where er.request_status = 'waiting_input')::int as waiting_on_sales,
              count(*) filter (where er.request_status in ('new', 'in_review'))::int as with_engineering
            from engineering_requests er
            join quote_headers q on q.id = er.quote_header_id
            ${base.whereSql}${base.whereSql ? " and" : "where"} er.request_status not in ('closed', 'cancelled')
              and coalesce(q.quote_status, '') not in ('converted', 'closed', 'cancelled')
          `,
          base.params
        );
        summary.engineering = {
          ready_for_sales: Number(engRes.rows[0]?.ready_for_sales || 0),
          waiting_on_sales: Number(engRes.rows[0]?.waiting_on_sales || 0),
          with_engineering: Number(engRes.rows[0]?.with_engineering || 0),
        };
      } catch (_err) {
        summary.engineering = { ready_for_sales: 0, waiting_on_sales: 0, with_engineering: 0 };
      }
    }

    if (hasScreenAction(req, "leads", "can_view")) {
      const leadParams = [];
      const leadWhere = [`coalesce(l.status, '') not in ('order_won', 'lost', 'closed', 'cancelled', 'closed_no_action')`];
      if (Number.isFinite(Number(ctx.activeCompanyId))) {
        leadParams.push(Number(ctx.activeCompanyId));
        leadWhere.push(`l.company_id = $${leadParams.length}`);
      }
      if (ownRecordsOnly(req, "leads")) {
        leadParams.push(req.user.id);
        leadWhere.push(`l.assigned_to = $${leadParams.length}`);
      }
      const leadRes = await pool.query(
        `
          select
            count(*)::int as open_leads,
            count(*) filter (
              where exists (
                select 1 from lead_activities la
                where la.lead_id = l.id
                  and la.due_at is not null
                  and la.due_at::date = current_date
              )
            )::int as due_today,
            count(*) filter (
              where exists (
                select 1 from lead_activities la
                where la.lead_id = l.id
                  and la.due_at is not null
                  and la.due_at::date < current_date
              )
              or (
                l.assigned_at is not null
                and l.first_response_at is null
                and l.assigned_at + make_interval(hours => coalesce(nullif(l.assign_sla_hours, 0), 24)) < now()
              )
            )::int as overdue,
            count(*) filter (
              where l.assigned_at is not null
                and l.first_response_at is null
                and l.assigned_at + make_interval(hours => coalesce(nullif(l.assign_sla_hours, 0), 24)) < now()
            )::int as sla_breached
          from leads l
          where ${leadWhere.join(" and ")}
        `,
        leadParams
      );
      summary.leads = {
        open: Number(leadRes.rows[0]?.open_leads || 0),
        due_today: Number(leadRes.rows[0]?.due_today || 0),
        overdue: Number(leadRes.rows[0]?.overdue || 0),
        sla_breached: Number(leadRes.rows[0]?.sla_breached || 0),
      };
    }

    if (hasScreenAction(req, "sales_orders", "can_view")) {
      const base = buildScopedWhere({ alias: "so", req, ...ctx, screenKey: "sales_orders" });
      const draftRes = await pool.query(
        `
          select count(*)::int as count
          from sales_orders so
          ${base.whereSql}${base.whereSql ? " and" : "where"} so.order_status = 'draft'
        `,
        base.params
      );
      const confirmedRes = await pool.query(
        `
          select count(*)::int as count
          from sales_orders so
          ${base.whereSql}${base.whereSql ? " and" : "where"} so.order_status = 'confirmed'
        `,
        base.params
      );
      const confirmedNoDispatchRes = await pool.query(
        `
          select count(*)::int as count
          from sales_orders so
          ${base.whereSql}${base.whereSql ? " and" : "where"} so.order_status = 'confirmed'
            and not exists (
              select 1
              from dispatches d
              where d.sales_order_id = so.id
                and d.dispatch_status <> 'cancelled'
            )
        `,
        base.params
      );
      summary.sales_orders = {
        draft: Number(draftRes.rows[0]?.count || 0),
        confirmed: Number(confirmedRes.rows[0]?.count || 0),
        confirmed_no_dispatch: Number(confirmedNoDispatchRes.rows[0]?.count || 0),
      };
    }

    if (hasScreenAction(req, "dispatches", "can_view")) {
      const base = buildScopedWhere({ alias: "d", req, ...ctx, screenKey: "dispatches" });
      const readyRes = await pool.query(
        `
          select count(*)::int as count
          from dispatches d
          ${base.whereSql}${base.whereSql ? " and" : "where"} d.dispatch_status = 'ready'
        `,
        base.params
      );
      const dispatchedNotInvoicedRes = await pool.query(
        `
          select count(distinct d.sales_order_id)::int as count
          from dispatches d
          ${base.whereSql}${base.whereSql ? " and" : "where"} d.dispatch_status = any($${base.params.length + 1}::text[])
            and d.dispatch_status <> 'cancelled'
            and not exists (
              select 1
              from customer_invoices ci
              where ci.sales_order_id = d.sales_order_id
                and ci.invoice_status <> 'cancelled'
            )
        `,
        [...base.params, ["dispatched", "delivered"]]
      );
      summary.dispatches = {
        ready: Number(readyRes.rows[0]?.count || 0),
        dispatched_not_invoiced: Number(dispatchedNotInvoicedRes.rows[0]?.count || 0),
      };
    }

    if (hasScreenAction(req, "invoices", "can_view")) {
      const base = buildScopedWhere({ alias: "ci", req, ...ctx, screenKey: "invoices" });
      const adjustmentsReady = await isArAdjustmentsReady();
      const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady });
      const adjustmentsJoin = getArAdjustmentsJoin({ enabled: adjustmentsReady });
      const draftRes = await pool.query(
        `
          select count(*)::int as count
          from customer_invoices ci
          ${base.whereSql}${base.whereSql ? " and" : "where"} ci.invoice_status = 'draft'
        `,
        base.params
      );
      const outstandingRes = await pool.query(
        `
          select count(*)::int as count
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
          ${base.whereSql}${base.whereSql ? " and" : "where"} ci.invoice_status = 'issued'
            and ${outstandingExpr} > 0
        `,
        base.params
      );
      summary.invoices = {
        draft: Number(draftRes.rows[0]?.count || 0),
        outstanding: Number(outstandingRes.rows[0]?.count || 0),
      };
    }

    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/queue", async (req, res, next) => {
  try {
    if (!canViewAnySalesDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const qText = normalizeText(req.query.q);
    const bucket = normalizeText(req.query.bucket).toLowerCase() || "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);

    const rows = [];

    const applySearch = (params, conditions, fields) => {
      if (!qText) return { params, conditions };
      params.push(`%${qText}%`);
      const p = `$${params.length}`;
      conditions.push(`(${fields.map((f) => `coalesce(${f}, '') ilike ${p}`).join(" or ")})`);
      return { params, conditions };
    };

    if (bucket === "quotes_draft" && hasScreenAction(req, "quotes", "can_view")) {
      const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      conditions.push(`q.quote_status = 'draft'`);
      ({ params } = applySearch(params, conditions, ["q.quote_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'quote'::text as stage,
            q.id as record_id,
            q.quote_number as record_number,
            q.quote_status as record_status,
            q.updated_at,
            c.customer_name,
            qr.grand_total_quote as amount,
            null::numeric as secondary_amount
          from quote_headers q
          join customers c on c.id = q.customer_id
          left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          ${whereSql}
          order by q.updated_at desc nulls last, q.id desc
          limit ${limit}
        `,
        params
      );
      rows.push(...r.rows.map((row) => ({ ...row, ...buildQuoteQueueMetadata(row) })));
    } else if ((bucket === "engineering_ready" || bucket === "engineering_waiting") && hasScreenAction(req, "quotes", "can_view")) {
      const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      conditions.push(`er.request_status = '${bucket === "engineering_ready" ? "ready" : "waiting_input"}'`);
      conditions.push(`coalesce(q.quote_status, '') not in ('converted', 'closed', 'cancelled')`);
      ({ params } = applySearch(params, conditions, ["q.quote_number", "c.customer_name", "er.request_title"]));
      const whereSql = `where ${conditions.join(" and ")}`;
      const r = await pool.query(
        `
          select
            'quote'::text as stage,
            q.id as record_id,
            q.quote_number as record_number,
            q.quote_status as record_status,
            er.updated_at,
            c.customer_name,
            qr.grand_total_quote as amount,
            null::numeric as secondary_amount,
            er.id as engineering_request_id,
            er.request_title as engineering_request_title
          from engineering_requests er
          join quote_headers q on q.id = er.quote_header_id
          join customers c on c.id = q.customer_id
          left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          ${whereSql}
          order by er.updated_at asc nulls last, er.id asc
          limit ${limit}
        `,
        params
      );
      const ready = bucket === "engineering_ready";
      rows.push(
        ...r.rows.map((row) => ({
          ...row,
          age_days: getDaysSince(row.updated_at),
          queue_reason: ready
            ? `Engineering returned "${row.engineering_request_title || "datasheet"}" — review it and update the quote.`
            : `Engineering is waiting on Sales input for "${row.engineering_request_title || "this request"}".`,
          recommended_action: "open_quote",
          recommended_action_label: ready ? "Review engineering return" : "Reply to engineering",
        }))
      );
    } else if (bucket === "quotes_submitted" && hasScreenAction(req, "quotes", "can_view")) {
      const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      conditions.push(`q.quote_status = 'pending_approval'`);
      ({ params } = applySearch(params, conditions, ["q.quote_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'quote'::text as stage,
            q.id as record_id,
            q.quote_number as record_number,
            q.quote_status as record_status,
            q.updated_at,
            c.customer_name,
            qr.grand_total_quote as amount,
            null::numeric as secondary_amount
          from quote_headers q
          join customers c on c.id = q.customer_id
          left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          ${whereSql}
          order by q.updated_at desc nulls last, q.id desc
          limit ${limit}
        `,
        params
      );
      rows.push(...r.rows.map((row) => ({ ...row, ...buildQuoteQueueMetadata(row) })));
    } else if (bucket === "quotes_unconverted" && hasScreenAction(req, "quotes", "can_view")) {
      const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      params.push(["approved", "issued", "sent"]);
      const statusParam = `$${params.length}`;
      conditions.push(`q.quote_status = any(${statusParam}::text[])`);
      conditions.push(`so.id is null`);
      ({ params } = applySearch(params, conditions, ["q.quote_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'quote'::text as stage,
            q.id as record_id,
            q.quote_number as record_number,
            q.quote_status as record_status,
            q.updated_at,
            c.customer_name,
            qr.grand_total_quote as amount,
            null::numeric as secondary_amount
          from quote_headers q
          join customers c on c.id = q.customer_id
          left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${whereSql}
          order by q.updated_at desc nulls last, q.id desc
          limit ${limit}
        `,
        params
      );
      rows.push(...r.rows.map((row) => ({ ...row, ...buildQuoteQueueMetadata(row) })));
    } else if (bucket === "quotes_issued_aging" && hasScreenAction(req, "quotes", "can_view")) {
      const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      params.push(["issued", "sent"]);
      const statusParam = `$${params.length}`;
      conditions.push(`q.quote_status = any(${statusParam}::text[])`);
      conditions.push(`so.id is null`);
      ({ params } = applySearch(params, conditions, ["q.quote_number", "c.customer_name", "owner.full_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'quote'::text as stage,
            q.id as record_id,
            q.quote_number as record_number,
            q.quote_status as record_status,
            coalesce(qr.issued_at, q.updated_at) as updated_at,
            c.customer_name,
            qr.grand_total_quote as amount,
            null::numeric as secondary_amount,
            q.created_by as owner_user_id,
            owner.full_name as owner_name
          from quote_headers q
          join customers c on c.id = q.customer_id
          left join erp_users owner on owner.id = q.created_by
          left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${whereSql}
          order by coalesce(qr.issued_at, q.updated_at) asc nulls last, q.id asc
          limit ${limit}
        `,
        params
      );
      rows.push(
        ...r.rows.map((row) => ({
          ...row,
          ...buildQuoteQueueMetadata(row),
          age_days: getDaysSince(row.updated_at),
          queue_reason: "Issued/sent quote aging without sales order.",
          recommended_action: "convert_to_so",
          recommended_action_label: "Convert to SO",
        }))
      );
    } else if (bucket === "quotes_expiring" && hasScreenAction(req, "quotes", "can_view")) {
      const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      params.push(["issued", "sent", "approved"]);
      const statusParam = `$${params.length}`;
      conditions.push(`q.quote_status = any(${statusParam}::text[])`);
      conditions.push(`so.id is null`);
      conditions.push(`q.quote_valid_till is not null`);
      conditions.push(`q.quote_valid_till <= (current_date + interval '7 days')`);
      conditions.push(`q.quote_valid_till >= current_date`);
      ({ params } = applySearch(params, conditions, ["q.quote_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'quote'::text as stage,
            q.id as record_id,
            q.quote_number as record_number,
            q.quote_status as record_status,
            q.quote_valid_till::timestamptz as updated_at,
            c.customer_name,
            qr.grand_total_quote as amount,
            null::numeric as secondary_amount,
            q.quote_valid_till,
            q.next_follow_up_at
          from quote_headers q
          join customers c on c.id = q.customer_id
          left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${whereSql}
          order by q.quote_valid_till asc nulls last, q.id asc
          limit ${limit}
        `,
        params
      );
      rows.push(
        ...r.rows.map((row) => ({
          ...row,
          ...buildQuoteQueueMetadata(row),
          queue_reason: "Quote validity ends within 7 days.",
          recommended_action: "chase_quote",
          recommended_action_label: "Chase quote",
        }))
      );
    } else if (bucket === "quotes_follow_up_due" && hasScreenAction(req, "quotes", "can_view")) {
      const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      params.push(["issued", "sent", "approved"]);
      const statusParam = `$${params.length}`;
      conditions.push(`q.quote_status = any(${statusParam}::text[])`);
      conditions.push(`so.id is null`);
      conditions.push(`q.next_follow_up_at is not null`);
      conditions.push(`q.next_follow_up_at::date <= current_date`);
      ({ params } = applySearch(params, conditions, ["q.quote_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'quote'::text as stage,
            q.id as record_id,
            q.quote_number as record_number,
            q.quote_status as record_status,
            q.next_follow_up_at as updated_at,
            c.customer_name,
            qr.grand_total_quote as amount,
            null::numeric as secondary_amount,
            q.quote_valid_till,
            q.next_follow_up_at
          from quote_headers q
          join customers c on c.id = q.customer_id
          left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          ${whereSql}
          order by q.next_follow_up_at asc nulls last, q.id asc
          limit ${limit}
        `,
        params
      );
      rows.push(
        ...r.rows.map((row) => ({
          ...row,
          ...buildQuoteQueueMetadata(row),
          queue_reason: "Quote follow-up date is due.",
          recommended_action: "follow_up",
          recommended_action_label: "Follow up",
        }))
      );
    } else if (bucket === "quotes_lapsed" && hasScreenAction(req, "quotes", "can_view")) {
      try {
        const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
        const conditions = [];
        let params = [...base.params];
        if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
        conditions.push(`q.quote_status = 'lapsed'`);
        conditions.push(`so.id is null`);
        ({ params } = applySearch(params, conditions, ["q.quote_number", "c.customer_name"]));
        const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
        const r = await pool.query(
          `
            select
              'quote'::text as stage,
              q.id as record_id,
              q.quote_number as record_number,
              q.quote_status as record_status,
              coalesce(q.lapsed_at, q.quote_valid_till::timestamptz, q.updated_at) as updated_at,
              c.customer_name,
              qr.grand_total_quote as amount,
              null::numeric as secondary_amount,
              q.quote_valid_till
            from quote_headers q
            join customers c on c.id = q.customer_id
            left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
            left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
            ${whereSql}
            order by q.quote_valid_till asc nulls last, q.id asc
            limit ${limit}
          `,
          params
        );
        rows.push(
          ...r.rows.map((row) => ({
            ...row,
            ...buildQuoteQueueMetadata(row),
            queue_reason: "Quote validity has lapsed.",
            recommended_action: "close_or_revive",
            recommended_action_label: "Revive or close",
          }))
        );
      } catch (_err) {
        // lapsed_at may not exist until migration 152
      }
    } else if (bucket === "quotes_issued_not_sent" && hasScreenAction(req, "quotes", "can_view")) {
      try {
        const base = buildScopedWhere({ alias: "q", req, ...ctx, screenKey: "quotes" });
        const conditions = [];
        let params = [...base.params];
        if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
        conditions.push(`q.quote_status = 'issued'`);
        conditions.push(`qr.revision_status = 'issued'`);
        conditions.push(`q.first_sent_at is null`);
        conditions.push(`so.id is null`);
        ({ params } = applySearch(params, conditions, ["q.quote_number", "c.customer_name"]));
        const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
        const r = await pool.query(
          `
            select
              'quote'::text as stage,
              q.id as record_id,
              q.quote_number as record_number,
              q.quote_status as record_status,
              coalesce(qr.issued_at, q.updated_at) as updated_at,
              c.customer_name,
              qr.grand_total_quote as amount,
              null::numeric as secondary_amount
            from quote_headers q
            join customers c on c.id = q.customer_id
            left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
            left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
            ${whereSql}
            order by coalesce(qr.issued_at, q.updated_at) asc nulls last, q.id asc
            limit ${limit}
          `,
          params
        );
        rows.push(
          ...r.rows.map((row) => ({
            ...row,
            ...buildQuoteQueueMetadata(row),
            queue_reason: "Issued quote has not been emailed to the customer.",
            recommended_action: "send_quote",
            recommended_action_label: "Send quote",
          }))
        );
      } catch (_err) {
        // first_sent_at may not exist until migration 152
      }
    } else if (bucket === "so_confirmed_no_dispatch" && hasScreenAction(req, "sales_orders", "can_view")) {
      const base = buildScopedWhere({ alias: "so", req, ...ctx, screenKey: "sales_orders" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      conditions.push(`so.order_status = 'confirmed'`);
      conditions.push(
        `not exists (
          select 1
          from dispatches d
          where d.sales_order_id = so.id
            and d.dispatch_status <> 'cancelled'
        )`
      );
      ({ params } = applySearch(params, conditions, ["so.so_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'sales_order'::text as stage,
            so.id as record_id,
            so.so_number as record_number,
            so.order_status as record_status,
            so.updated_at,
            c.customer_name,
            so.grand_total_order as amount,
            null::numeric as secondary_amount
          from sales_orders so
          join customers c on c.id = so.customer_id
          ${whereSql}
          order by so.updated_at desc nulls last, so.id desc
          limit ${limit}
        `,
        params
      );
      rows.push(...r.rows);
    } else if (bucket === "dispatch_ready" && hasScreenAction(req, "dispatches", "can_view")) {
      const base = buildScopedWhere({ alias: "d", req, ...ctx, screenKey: "dispatches" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      conditions.push(`d.dispatch_status = 'ready'`);
      ({ params } = applySearch(params, conditions, ["d.dispatch_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'dispatch'::text as stage,
            d.id as record_id,
            d.dispatch_number as record_number,
            d.dispatch_status as record_status,
            d.updated_at,
            c.customer_name,
            null::numeric as amount,
            null::numeric as secondary_amount
          from dispatches d
          join customers c on c.id = d.customer_id
          ${whereSql}
          order by d.updated_at desc nulls last, d.id desc
          limit ${limit}
        `,
        params
      );
      rows.push(...r.rows);
    } else if (bucket === "dispatch_not_invoiced" && hasScreenAction(req, "dispatches", "can_view")) {
      const base = buildScopedWhere({ alias: "d", req, ...ctx, screenKey: "dispatches" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      params.push(["dispatched", "delivered"]);
      const statusParam = `$${params.length}`;
      conditions.push(`d.dispatch_status = any(${statusParam}::text[])`);
      conditions.push(
        `not exists (
          select 1
          from customer_invoices ci
          where ci.sales_order_id = d.sales_order_id
            and ci.invoice_status <> 'cancelled'
        )`
      );
      ({ params } = applySearch(params, conditions, ["d.dispatch_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'dispatch'::text as stage,
            d.id as record_id,
            d.dispatch_number as record_number,
            d.dispatch_status as record_status,
            d.sales_order_id,
            'create_invoice'::text as next_action,
            d.updated_at,
            c.customer_name,
            null::numeric as amount,
            null::numeric as secondary_amount
          from dispatches d
          join customers c on c.id = d.customer_id
          ${whereSql}
          order by d.updated_at desc nulls last, d.id desc
          limit ${limit}
        `,
        params
      );
      rows.push(...r.rows);
    } else if (bucket === "invoice_draft" && hasScreenAction(req, "invoices", "can_view")) {
      const base = buildScopedWhere({ alias: "ci", req, ...ctx, screenKey: "invoices" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      conditions.push(`ci.invoice_status = 'draft'`);
      ({ params } = applySearch(params, conditions, ["ci.invoice_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'invoice'::text as stage,
            ci.id as record_id,
            ci.invoice_number as record_number,
            ci.invoice_status as record_status,
            ci.updated_at,
            c.customer_name,
            ci.grand_total_invoice as amount,
            null::numeric as secondary_amount
          from customer_invoices ci
          join customers c on c.id = ci.customer_id
          ${whereSql}
          order by ci.updated_at desc nulls last, ci.id desc
          limit ${limit}
        `,
        params
      );
      rows.push(...r.rows);
    } else if (bucket === "invoice_outstanding" && hasScreenAction(req, "invoices", "can_view")) {
      const base = buildScopedWhere({ alias: "ci", req, ...ctx, screenKey: "invoices" });
      const conditions = [];
      let params = [...base.params];
      if (base.whereSql) conditions.push(base.whereSql.replace(/^where\s+/i, ""));
      const adjustmentsReady = await isArAdjustmentsReady();
      const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady });
      const adjustmentsJoin = getArAdjustmentsJoin({ enabled: adjustmentsReady });
      conditions.push(`ci.invoice_status = 'issued'`);
      conditions.push(`${outstandingExpr} > 0`);
      ({ params } = applySearch(params, conditions, ["ci.invoice_number", "c.customer_name"]));
      const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const r = await pool.query(
        `
          select
            'invoice'::text as stage,
            ci.id as record_id,
            ci.invoice_number as record_number,
            ci.invoice_status as record_status,
            ci.updated_at,
            c.customer_name,
            ci.grand_total_invoice as amount,
            ${outstandingExpr} as secondary_amount
          from customer_invoices ci
          join customers c on c.id = ci.customer_id
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
          ${whereSql}
          order by ci.updated_at desc nulls last, ci.id desc
          limit ${limit}
        `,
        params
      );
      rows.push(
        ...r.rows.map((row) => ({
          ...row,
          amount: Number(row.amount || 0),
          secondary_amount: Number(row.secondary_amount || 0),
        }))
      );
    } else {
      return res.json({ ok: true, rows: [], list: { returned: 0, limit: limit, capped: false } });
    }

    return res.json({
      ok: true,
      rows,
      list: {
        returned: rows.length,
        limit,
        capped: rows.length >= limit,
        honesty:
          rows.length >= limit
            ? `Showing first ${limit} queue rows. Refine the bucket or search to see more.`
            : null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

async function loadTeamUserIds(client, managerUserId) {
  const r = await client.query(
    `
      select id
      from erp_users
      where is_active = true
        and (id = $1 or primary_manager_user_id = $1 or secondary_manager_user_id = $1)
    `,
    [Number(managerUserId)]
  );
  return r.rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
}

function canSeeCompanyFunnel(req) {
  if (req.user?.group_name === "SuperAdmin") return true;
  if (ownRecordsOnly(req, "quotes") && ownRecordsOnly(req, "sales_orders") && ownRecordsOnly(req, "leads")) return false;
  return canViewAnySalesDesk(req);
}

router.get("/coverage", async (req, res, next) => {
  try {
    if (!canViewAnySalesDesk(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const isManagerView = !ownRecordsOnly(req, "quotes") || req.user.group_name === "SuperAdmin";
    const teamIds = isManagerView ? await loadTeamUserIds(pool, req.user.id) : [Number(req.user.id)];
    if (!teamIds.length) return res.json({ ok: true, rows: [] });

    const companyFilter = ctx.isDistributor
      ? `and q.distributor_id = $2`
      : `and q.company_id = $2`;
    const companyParam = ctx.isDistributor ? Number(ctx.distributorId) : Number(ctx.activeCompanyId);

    const quoteCoverage = hasScreenAction(req, "quotes", "can_view")
      ? await pool.query(
          `
            select
              coalesce(u.id, 0)::int as assignee_user_id,
              coalesce(u.full_name, 'Unassigned') as assignee_name,
              count(*) filter (where q.quote_status = 'pending_approval')::int as pending_approvals,
              count(*) filter (
                where q.quote_status = any($3::text[])
                  and so.id is null
              )::int as unconverted_issued
            from quote_headers q
            left join erp_users u on u.id = q.created_by
            left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
            left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
            where q.created_by = any($1::int[])
              ${companyFilter}
            group by coalesce(u.id, 0), coalesce(u.full_name, 'Unassigned')
          `,
          [teamIds, companyParam, ["issued", "sent"]]
        )
      : { rows: [] };

    const soCoverage = hasScreenAction(req, "sales_orders", "can_view")
      ? await pool.query(
          `
            select
              coalesce(u.id, 0)::int as assignee_user_id,
              coalesce(u.full_name, 'Unassigned') as assignee_name,
              count(*)::int as confirmed_no_dispatch
            from sales_orders so
            left join erp_users u on u.id = so.created_by
            where so.created_by = any($1::int[])
              and ${ctx.isDistributor ? "so.distributor_id = $2" : "so.company_id = $2"}
              and so.order_status = 'confirmed'
              and not exists (
                select 1 from dispatches d
                where d.sales_order_id = so.id and d.dispatch_status <> 'cancelled'
              )
            group by coalesce(u.id, 0), coalesce(u.full_name, 'Unassigned')
          `,
          [teamIds, companyParam]
        )
      : { rows: [] };

    const byUser = new Map();
    for (const row of quoteCoverage.rows) {
      const key = Number(row.assignee_user_id);
      byUser.set(key, {
        assignee_user_id: key,
        assignee_name: row.assignee_name,
        pending_approvals: Number(row.pending_approvals || 0),
        unconverted_issued: Number(row.unconverted_issued || 0),
        confirmed_no_dispatch: 0,
      });
    }
    for (const row of soCoverage.rows) {
      const key = Number(row.assignee_user_id);
      const existing = byUser.get(key) || {
        assignee_user_id: key,
        assignee_name: row.assignee_name,
        pending_approvals: 0,
        unconverted_issued: 0,
        confirmed_no_dispatch: 0,
      };
      existing.confirmed_no_dispatch = Number(row.confirmed_no_dispatch || 0);
      byUser.set(key, existing);
    }

    const rows = Array.from(byUser.values())
      .filter((row) => row.pending_approvals + row.unconverted_issued + row.confirmed_no_dispatch > 0)
      .sort(
        (a, b) =>
          b.pending_approvals + b.unconverted_issued + b.confirmed_no_dispatch - (a.pending_approvals + a.unconverted_issued + a.confirmed_no_dispatch)
      );

    return res.json({ ok: true, rows, scope: isManagerView ? "team" : "self" });
  } catch (err) {
    return next(err);
  }
});

router.get("/funnel", async (req, res, next) => {
  try {
    if (!canSeeCompanyFunnel(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });
    if (ctx.isDistributor) return res.json({ ok: true, companies: [] });

    const companyId = Number(ctx.activeCompanyId);
    const companyRes = await pool.query(
      `
        select id, company_code, display_name, legal_name
        from companies
        where is_active = true
          and ($1::int is null or id = $1)
        order by company_code asc
      `,
      [companyId]
    );

    const companies = [];
    for (const company of companyRes.rows) {
      const cid = Number(company.id);
      const [leadsRes, quotesRes, soRes, invRes] = await Promise.all([
        pool.query(
          `
            select
              count(*)::int as count,
              percentile_cont(0.5) within group (order by extract(epoch from (now() - l.created_at)) / 86400.0)::numeric as median_age_days
            from leads l
            where l.company_id = $1
              and coalesce(l.status, '') not in ('order_won', 'lost', 'closed', 'cancelled')
          `,
          [cid]
        ),
        pool.query(
          `
            select
              count(*)::int as count,
              percentile_cont(0.5) within group (order by extract(epoch from (now() - coalesce(qr.issued_at, q.created_at))) / 86400.0)::numeric as median_age_days
            from quote_headers q
            left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
            where q.company_id = $1
              and q.quote_status = any($2::text[])
          `,
          [cid, ["draft", "pending_approval", "approved", "issued", "sent"]]
        ),
        pool.query(
          `
            select
              count(*)::int as count,
              percentile_cont(0.5) within group (order by extract(epoch from (now() - so.created_at)) / 86400.0)::numeric as median_age_days
            from sales_orders so
            where so.company_id = $1
              and so.order_status = any($2::text[])
          `,
          [cid, ["draft", "confirmed"]]
        ),
        pool.query(
          `
            select
              count(*)::int as count,
              percentile_cont(0.5) within group (order by extract(epoch from (now() - ci.created_at)) / 86400.0)::numeric as median_age_days
            from customer_invoices ci
            where ci.company_id = $1
              and ci.invoice_status = any($2::text[])
          `,
          [cid, ["draft", "issued"]]
        ),
      ]);

      const stage = (row) => ({
        count: Number(row?.count || 0),
        median_age_days: row?.median_age_days == null ? null : Math.round(Number(row.median_age_days) * 10) / 10,
      });

      companies.push({
        company_id: cid,
        company_code: company.company_code,
        company_name: company.display_name || company.legal_name || company.company_code,
        lead: stage(leadsRes.rows[0]),
        quote: stage(quotesRes.rows[0]),
        sales_order: stage(soRes.rows[0]),
        invoice: stage(invRes.rows[0]),
      });
    }

    return res.json({ ok: true, companies });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
