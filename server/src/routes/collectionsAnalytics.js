const express = require("express");

const { hasScreenAction } = require("../auth/authorization");
const { pool } = require("../db/pool");
const { getActiveCompanyId } = require("../services/companyContext");
const { getDistributorIdForUser } = require("../services/mailAccounts");

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

async function isCollectionsFollowupsReady(client = pool) {
  const r = await client.query(`select to_regclass('public.customer_collection_actions') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

async function isCollectionsDisputesReady(client = pool) {
  const r = await client.query(`select to_regclass('public.customer_collection_disputes') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

async function isArAdjustmentsReady(client = pool) {
  const r = await client.query(`select to_regclass('public.customer_ar_adjustments') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

function canViewCollectionsAnalytics(req) {
  return hasScreenAction(req, "receipts", "can_view") || hasScreenAction(req, "invoices", "can_view");
}

async function loadContextFilters(req, client = pool) {
  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
  if (isDistributor && !distributorId) return { ok: false, error: "DISTRIBUTOR_NOT_LINKED" };
  const activeCompanyId = isDistributor ? null : getActiveCompanyId(req) || null;
  if (!isDistributor && !activeCompanyId) return { ok: false, error: "COMPANY_NOT_SELECTED" };
  return { ok: true, isDistributor, distributorId, activeCompanyId };
}

function buildScopeCondition(alias, ctx) {
  if (ctx.isDistributor && ctx.distributorId) return `${alias}.distributor_id = ${Number(ctx.distributorId)}`;
  if (ctx.activeCompanyId) return `${alias}.company_id = ${Number(ctx.activeCompanyId)}`;
  return "false";
}

async function getCustomerAnalyticsRows(client, ctx, { q = "", bucket = "", limit = 200 } = {}) {
  const followupsReady = await isCollectionsFollowupsReady(client);
  const disputesReady = await isCollectionsDisputesReady(client);
  const adjustmentsReady = await isArAdjustmentsReady(client);

  const qClause = q ? `and (c.customer_name ilike $1 or coalesce(c.customer_code, '') ilike $1)` : "";
  const params = q ? [`%${q}%`] : [];
  const limitValue = Math.min(Math.max(Number(limit || 200), 1), 1000);

  const invoiceScope = buildScopeCondition("ci", ctx);
  const receiptScope = buildScopeCondition("cr", ctx);
  const disputeScope = buildScopeCondition("d", ctx);
  const adjustScope = buildScopeCondition("a", ctx);

  const rowsRes = await client.query(
    `
      with invoice_core as (
        select
          ci.id,
          ci.customer_id,
          ci.invoice_date,
          (
            ci.grand_total_invoice
            - coalesce(pr.allocated_invoice, 0)
            - coalesce(sr.credit_note_amount, 0)
            ${adjustmentsReady ? `- coalesce(adj.adjustment_amount, 0)` : ""}
          ) as outstanding_invoice,
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
        ${
          adjustmentsReady
            ? `
        left join (
          select
            customer_invoice_id,
            coalesce(sum(adjustment_amount), 0) as adjustment_amount
          from customer_ar_adjustments
          where adjustment_status = 'posted'
          group by customer_invoice_id
        ) adj on adj.customer_invoice_id = ci.id`
            : ""
        }
        where ci.invoice_status <> 'cancelled'
          and ${invoiceScope}
      ),
      invoice_rollup as (
        select
          customer_id,
          count(*) filter (where outstanding_invoice > 0.0001)::int as open_invoices,
          coalesce(sum(case when outstanding_invoice > 0.0001 then outstanding_invoice else 0 end), 0) as outstanding_amount,
          count(*) filter (where outstanding_invoice > 0.0001 and ageing_days > 0)::int as overdue_invoices,
          coalesce(sum(case when outstanding_invoice > 0.0001 and ageing_days > 0 then outstanding_invoice else 0 end), 0) as overdue_amount
        from invoice_core
        group by customer_id
      ),
      receipt_rollup as (
        select
          cr.customer_id,
          count(*) filter (where cr.receipt_status = 'posted' and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001)::int as unapplied_receipts,
          coalesce(sum(case when cr.receipt_status = 'posted' and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001 then cr.unallocated_amount_invoice else 0 end), 0) as unapplied_cash_amount,
          coalesce(max(case when cr.receipt_status = 'posted' and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001 then current_date - cr.receipt_date else null end), 0)::int as oldest_unapplied_days
        from customer_receipts cr
        where ${receiptScope}
        group by cr.customer_id
      )
      ${
        followupsReady
          ? `,
      latest_actions as (
        select distinct on (a.customer_id)
          a.customer_id,
          a.action_type,
          a.expected_date,
          a.created_at::date as action_date,
          a.created_by,
          a.promised_amount
        from customer_collection_actions a
        where ${buildScopeCondition("a", ctx)}
        order by a.customer_id, a.created_at desc, a.id desc
      ),
      followup_rollup as (
        select
          a.customer_id,
          count(*)::int as total_actions,
          count(*) filter (where a.action_type = 'follow_up')::int as followups_logged,
          count(*) filter (where a.action_type = 'promise_to_pay')::int as promises_logged
        from customer_collection_actions a
        where ${buildScopeCondition("a", ctx)}
        group by a.customer_id
      )`
          : `,
      latest_actions as (
        select
          null::integer as customer_id,
          null::text as action_type,
          null::date as expected_date,
          null::date as action_date,
          null::integer as created_by,
          null::numeric as promised_amount
        where false
      ),
      followup_rollup as (
        select
          null::integer as customer_id,
          0::int as total_actions,
          0::int as followups_logged,
          0::int as promises_logged
        where false
      )`
      }
      ${
        disputesReady
          ? `,
      dispute_rollup as (
        select
          d.customer_id,
          count(*) filter (where d.dispute_status <> 'resolved')::int as open_disputes,
          count(*)::int as total_disputes,
          coalesce(sum(case when d.dispute_status <> 'resolved' then d.disputed_amount else 0 end), 0) as disputed_amount
        from customer_collection_disputes d
        where ${disputeScope}
        group by d.customer_id
      )`
          : `,
      dispute_rollup as (
        select
          null::integer as customer_id,
          0::int as open_disputes,
          0::int as total_disputes,
          0::numeric as disputed_amount
        where false
      )`
      }
      ${
        adjustmentsReady
          ? `,
      adjustment_rollup as (
        select
          a.customer_id,
          count(*) filter (where a.adjustment_status = 'posted')::int as posted_adjustments,
          coalesce(sum(case when a.adjustment_status = 'posted' then a.adjustment_amount else 0 end), 0) as posted_adjustment_amount
        from customer_ar_adjustments a
        where ${adjustScope}
        group by a.customer_id
      )`
          : `,
      adjustment_rollup as (
        select
          null::integer as customer_id,
          0::int as posted_adjustments,
          0::numeric as posted_adjustment_amount
        where false
      )`
      },
      candidate_ids as (
        select customer_id from invoice_rollup
        union
        select customer_id from receipt_rollup
        union
        select customer_id from followup_rollup
        union
        select customer_id from dispute_rollup
        union
        select customer_id from adjustment_rollup
      )
      select
        c.id as customer_id,
        c.customer_name,
        c.customer_code,
        coalesce(i.open_invoices, 0) as open_invoices,
        coalesce(i.outstanding_amount, 0) as outstanding_amount,
        coalesce(i.overdue_invoices, 0) as overdue_invoices,
        coalesce(i.overdue_amount, 0) as overdue_amount,
        coalesce(r.unapplied_receipts, 0) as unapplied_receipts,
        coalesce(r.unapplied_cash_amount, 0) as unapplied_cash_amount,
        coalesce(r.oldest_unapplied_days, 0) as oldest_unapplied_days,
        coalesce(f.total_actions, 0) as total_actions,
        coalesce(f.followups_logged, 0) as followups_logged,
        coalesce(f.promises_logged, 0) as promises_logged,
        la.action_type as last_action_type,
        la.expected_date as next_followup_date,
        la.action_date as last_action_date,
        coalesce(la.promised_amount, 0) as latest_promised_amount,
        coalesce(d.open_disputes, 0) as open_disputes,
        coalesce(d.total_disputes, 0) as total_disputes,
        coalesce(d.disputed_amount, 0) as disputed_amount,
        coalesce(a.posted_adjustments, 0) as posted_adjustments,
        coalesce(a.posted_adjustment_amount, 0) as posted_adjustment_amount
      from candidate_ids x
      join customers c on c.id = x.customer_id
      left join invoice_rollup i on i.customer_id = c.id
      left join receipt_rollup r on r.customer_id = c.id
      left join followup_rollup f on f.customer_id = c.id
      left join latest_actions la on la.customer_id = c.id
      left join dispute_rollup d on d.customer_id = c.id
      left join adjustment_rollup a on a.customer_id = c.id
      where true
      ${qClause}
      order by c.customer_name asc
      limit ${limitValue}
    `,
    params
  );

  const rows = (rowsRes.rows || []).map((row) => {
    const outstandingAmount = money(row.outstanding_amount);
    const overdueAmount = money(row.overdue_amount);
    const unappliedCashAmount = money(row.unapplied_cash_amount);
    const postedAdjustmentAmount = money(row.posted_adjustment_amount);
    const disputedAmount = money(row.disputed_amount);
    const brokenPromises = row.last_action_type === "promise_to_pay" && row.next_followup_date && new Date(row.next_followup_date) < new Date()
      ? 1
      : 0;
    const staleFollowup =
      outstandingAmount > 0.0001 &&
      (!row.last_action_date || (new Date().getTime() - new Date(row.last_action_date).getTime()) / (1000 * 60 * 60 * 24) > 7);
    const matchingGapAmount = money(unappliedCashAmount > 0.0001 && outstandingAmount > 0.0001 ? Math.min(unappliedCashAmount, outstandingAmount) : 0);
    let queueBucket = "clear";
    if (brokenPromises > 0) queueBucket = "broken_promises";
    else if (Number(row.open_disputes || 0) > 0 && Number(row.total_disputes || 0) >= 2) queueBucket = "repeat_disputes";
    else if (staleFollowup) queueBucket = "stale_followups";
    else if (postedAdjustmentAmount > 0.0001) queueBucket = "adjustment_heavy";
    else if (matchingGapAmount > 0.0001) queueBucket = "matching_gap";

    return {
      ...row,
      outstanding_amount: outstandingAmount,
      overdue_amount: overdueAmount,
      unapplied_cash_amount: unappliedCashAmount,
      posted_adjustment_amount: postedAdjustmentAmount,
      disputed_amount: disputedAmount,
      latest_promised_amount: money(row.latest_promised_amount),
      broken_promises: brokenPromises,
      stale_followup: staleFollowup,
      matching_gap_amount: matchingGapAmount,
      queue_bucket: queueBucket,
    };
  });

  if (!bucket || bucket === "all") return rows;
  return rows.filter((row) => {
    if (bucket === "broken_promises") return Number(row.broken_promises || 0) > 0;
    if (bucket === "repeat_disputes") return Number(row.open_disputes || 0) > 0 && Number(row.total_disputes || 0) >= 2;
    if (bucket === "stale_followups") return Boolean(row.stale_followup);
    if (bucket === "adjustment_heavy") return Number(row.posted_adjustment_amount || 0) > 0.0001;
    if (bucket === "matching_gap") return Number(row.matching_gap_amount || 0) > 0.0001;
    return true;
  });
}

async function getUserAnalyticsRows(client, ctx, { limit = 50 } = {}) {
  const followupsReady = await isCollectionsFollowupsReady(client);
  const disputesReady = await isCollectionsDisputesReady(client);
  const adjustmentsReady = await isArAdjustmentsReady(client);
  const userMap = new Map();
  const limitValue = Math.min(Math.max(Number(limit || 50), 1), 200);

  if (followupsReady) {
    const actionRes = await client.query(
      `
        select
          u.id as user_id,
          coalesce(u.full_name, u.email) as user_name,
          count(*)::int as action_count,
          count(*) filter (where a.action_type = 'follow_up')::int as followups_logged,
          count(*) filter (where a.action_type = 'promise_to_pay')::int as promises_logged,
          count(*) filter (where a.action_type = 'resolved')::int as resolved_actions
        from customer_collection_actions a
        left join erp_users u on u.id = a.created_by
        where ${buildScopeCondition("a", ctx)}
          and a.created_at >= current_date - interval '30 day'
        group by u.id, u.full_name, u.email
      `
    );
    for (const row of actionRes.rows || []) {
      userMap.set(Number(row.user_id), {
        user_id: Number(row.user_id),
        user_name: row.user_name || "Unknown",
        action_count: Number(row.action_count || 0),
        followups_logged: Number(row.followups_logged || 0),
        promises_logged: Number(row.promises_logged || 0),
        resolved_actions: Number(row.resolved_actions || 0),
        dispute_resolved_count: 0,
        adjustments_posted: 0,
        adjustments_posted_amount: 0,
      });
    }

    const brokenPromiseRes = await client.query(
      `
        with latest_promise as (
          select distinct on (a.customer_id)
            a.customer_id,
            a.created_by,
            a.expected_date
          from customer_collection_actions a
          where a.action_type = 'promise_to_pay'
            and ${buildScopeCondition("a", ctx)}
          order by a.customer_id, a.created_at desc, a.id desc
        )
        select
          u.id as user_id,
          count(*)::int as broken_promises
        from latest_promise p
        left join erp_users u on u.id = p.created_by
        where p.expected_date is not null
          and p.expected_date < current_date
        group by u.id
      `
    );
    for (const row of brokenPromiseRes.rows || []) {
      const key = Number(row.user_id);
      const current = userMap.get(key) || {
        user_id: key,
        user_name: "Unknown",
        action_count: 0,
        followups_logged: 0,
        promises_logged: 0,
        resolved_actions: 0,
        dispute_resolved_count: 0,
        adjustments_posted: 0,
        adjustments_posted_amount: 0,
      };
      current.broken_promises = Number(row.broken_promises || 0);
      userMap.set(key, current);
    }
  }

  if (disputesReady) {
    const disputeRes = await client.query(
      `
        select
          u.id as user_id,
          coalesce(u.full_name, u.email) as user_name,
          count(*) filter (where d.dispute_status = 'resolved')::int as dispute_resolved_count
        from customer_collection_disputes d
        left join erp_users u on u.id = d.resolved_by
        where ${buildScopeCondition("d", ctx)}
        group by u.id, u.full_name, u.email
      `
    );
    for (const row of disputeRes.rows || []) {
      const key = Number(row.user_id);
      const current = userMap.get(key) || {
        user_id: key,
        user_name: row.user_name || "Unknown",
        action_count: 0,
        followups_logged: 0,
        promises_logged: 0,
        resolved_actions: 0,
        dispute_resolved_count: 0,
        adjustments_posted: 0,
        adjustments_posted_amount: 0,
      };
      current.dispute_resolved_count = Number(row.dispute_resolved_count || 0);
      userMap.set(key, current);
    }
  }

  if (adjustmentsReady) {
    const adjRes = await client.query(
      `
        select
          u.id as user_id,
          coalesce(u.full_name, u.email) as user_name,
          count(*) filter (where a.adjustment_status = 'posted')::int as adjustments_posted,
          coalesce(sum(case when a.adjustment_status = 'posted' then a.adjustment_amount else 0 end), 0) as adjustments_posted_amount
        from customer_ar_adjustments a
        left join erp_users u on u.id = a.posted_by
        where ${buildScopeCondition("a", ctx)}
        group by u.id, u.full_name, u.email
      `
    );
    for (const row of adjRes.rows || []) {
      const key = Number(row.user_id);
      const current = userMap.get(key) || {
        user_id: key,
        user_name: row.user_name || "Unknown",
        action_count: 0,
        followups_logged: 0,
        promises_logged: 0,
        resolved_actions: 0,
        dispute_resolved_count: 0,
        adjustments_posted: 0,
        adjustments_posted_amount: 0,
      };
      current.adjustments_posted = Number(row.adjustments_posted || 0);
      current.adjustments_posted_amount = money(row.adjustments_posted_amount);
      userMap.set(key, current);
    }
  }

  return Array.from(userMap.values())
    .filter((row) => Number(row.user_id || 0) > 0)
    .sort((a, b) => {
      const primary = (Number(b.action_count || 0) + Number(b.dispute_resolved_count || 0)) - (Number(a.action_count || 0) + Number(a.dispute_resolved_count || 0));
      if (primary !== 0) return primary;
      return String(a.user_name || "").localeCompare(String(b.user_name || ""));
    })
    .slice(0, limitValue);
}

router.get("/summary", async (req, res, next) => {
  try {
    if (!canViewCollectionsAnalytics(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const rows = await getCustomerAnalyticsRows(pool, ctx, { bucket: "all", limit: 1000 });
    const summary = rows.reduce(
      (acc, row) => {
        acc.outstanding_amount += Number(row.outstanding_amount || 0);
        acc.overdue_amount += Number(row.overdue_amount || 0);
        acc.outstanding_customers += Number(row.outstanding_amount || 0) > 0.0001 ? 1 : 0;
        acc.overdue_customers += Number(row.overdue_amount || 0) > 0.0001 ? 1 : 0;
        acc.broken_promises += Number(row.broken_promises || 0);
        acc.stale_followups += row.stale_followup ? 1 : 0;
        acc.repeat_disputes += Number(row.open_disputes || 0) > 0 && Number(row.total_disputes || 0) >= 2 ? 1 : 0;
        acc.adjustment_heavy += Number(row.posted_adjustment_amount || 0) > 0.0001 ? 1 : 0;
        acc.matching_gap += Number(row.matching_gap_amount || 0) > 0.0001 ? 1 : 0;
        return acc;
      },
      {
        ready: true,
        outstanding_amount: 0,
        overdue_amount: 0,
        outstanding_customers: 0,
        overdue_customers: 0,
        broken_promises: 0,
        stale_followups: 0,
        repeat_disputes: 0,
        adjustment_heavy: 0,
        matching_gap: 0,
      }
    );
    summary.outstanding_amount = money(summary.outstanding_amount);
    summary.overdue_amount = money(summary.overdue_amount);
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/customers", async (req, res, next) => {
  try {
    if (!canViewCollectionsAnalytics(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const q = normalizeText(req.query.q);
    const bucket = normalizeText(req.query.bucket);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
    const rows = await getCustomerAnalyticsRows(pool, ctx, { q, bucket, limit });
    rows.sort((a, b) => {
      const priority = Number(b.overdue_amount || 0) - Number(a.overdue_amount || 0);
      if (Math.abs(priority) > 0.0001) return priority;
      const secondary = Number(b.outstanding_amount || 0) - Number(a.outstanding_amount || 0);
      if (Math.abs(secondary) > 0.0001) return secondary;
      return String(a.customer_name || "").localeCompare(String(b.customer_name || ""));
    });
    return res.json({ ok: true, customers: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/users", async (req, res, next) => {
  try {
    if (!canViewCollectionsAnalytics(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const rows = await getUserAnalyticsRows(pool, ctx, { limit });
    return res.json({ ok: true, users: rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
