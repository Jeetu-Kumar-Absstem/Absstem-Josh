const { pool } = require("../db/pool");
const { buildCustomerCompanyScopeSql } = require("./customerCompanyAccess");

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(2));
}

// Exposure at or above this share of the effective limit is flagged before it becomes an over-limit block.
const NEAR_LIMIT_PCT = 80;

const ENFORCEMENT_STAGE_BY_MODE = {
  warning: "observe",
  soft_block: "gate_dispatch",
  hard_block: "block",
};

async function isCreditControlReady(client = pool) {
  const r = await client.query(`select to_regclass('public.customer_credit_releases') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

async function getCustomerCreditSnapshot(
  client,
  {
    customerId,
    companyId = null,
    distributorId = null,
    pendingSalesOrderAmount = 0,
    excludeSalesOrderId = null,
  } = {}
) {
  const customerKey = Number(customerId);
  if (!Number.isFinite(customerKey) || customerKey <= 0) return null;
  const scopedDistributorId = Number(distributorId);
  const scopedCompanyId = Number(companyId);
  const hasDistributorScope = Number.isFinite(scopedDistributorId) && scopedDistributorId > 0;
  const hasCompanyScope = Number.isFinite(scopedCompanyId) && scopedCompanyId > 0;
  if (!hasDistributorScope && !hasCompanyScope) {
    const err = new Error("COMPANY_NOT_SELECTED");
    err.status = 400;
    throw err;
  }
  const ready = await isCreditControlReady(client);
  if (!ready) return { ready: false, customer_id: customerKey };

  const scopeWhere = [];
  const customerParams = [customerKey];
  if (hasDistributorScope) {
    customerParams.push(scopedDistributorId);
    scopeWhere.push(`exists (
      select 1
      from customer_distributor_links cdl
      where cdl.customer_id = c.id
        and cdl.distributor_id = $${customerParams.length}
    )`);
  } else if (hasCompanyScope) {
    customerParams.push(scopedCompanyId);
    scopeWhere.push(buildCustomerCompanyScopeSql("c.id", `$${customerParams.length}`));
  }

  const customerRes = await client.query(
    `
      select
        c.id,
        c.customer_code,
        c.customer_name,
        c.credit_limit,
        c.credit_control_mode,
        c.is_credit_hold,
        c.credit_hold_reason
      from customers c
      where c.id = $1
      ${scopeWhere.length ? `and ${scopeWhere.join(" and ")}` : ""}
      limit 1
    `,
    customerParams
  );
  const customer = customerRes.rows[0];
  if (!customer) return null;

  const invoiceParams = [customerKey];
  const invoiceWhere = [`ci.customer_id = $1`, `ci.invoice_status <> 'cancelled'`];
  if (hasDistributorScope) {
    invoiceParams.push(scopedDistributorId);
    invoiceWhere.push(`ci.distributor_id = $${invoiceParams.length}`);
  } else if (hasCompanyScope) {
    invoiceParams.push(scopedCompanyId);
    invoiceWhere.push(`ci.company_id = $${invoiceParams.length}`);
  }
  const invoiceRes = await client.query(
    `
      with invoice_balances as (
        select
          ci.id,
          (
            ci.grand_total_invoice
            - coalesce(pr.allocated_invoice, 0)
            - coalesce(sr.credit_note_amount, 0)
            - coalesce(adj.adjustment_amount, 0)
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
        left join (
          select
            customer_invoice_id,
            coalesce(sum(adjustment_amount), 0) as adjustment_amount
          from customer_ar_adjustments
          where adjustment_status = 'posted'
          group by customer_invoice_id
        ) adj on adj.customer_invoice_id = ci.id
        where ${invoiceWhere.join(" and ")}
      )
      select
        count(*) filter (where outstanding_invoice > 0.0001)::int as outstanding_count,
        coalesce(sum(case when outstanding_invoice > 0.0001 then outstanding_invoice else 0 end), 0) as outstanding_amount,
        count(*) filter (where outstanding_invoice > 0.0001 and ageing_days > 0)::int as overdue_count,
        coalesce(sum(case when outstanding_invoice > 0.0001 and ageing_days > 0 then outstanding_invoice else 0 end), 0) as overdue_amount,
        coalesce(max(ageing_days), 0)::int as max_ageing_days
      from invoice_balances
    `,
    invoiceParams
  );

  const orderParams = [customerKey];
  const orderWhere = [
    `so.customer_id = $1`,
    `so.order_status in ('confirmed', 'closed')`,
  ];
  if (hasDistributorScope) {
    orderParams.push(scopedDistributorId);
    orderWhere.push(`so.distributor_id = $${orderParams.length}`);
  } else if (hasCompanyScope) {
    orderParams.push(scopedCompanyId);
    orderWhere.push(`so.company_id = $${orderParams.length}`);
  }
  if (Number.isFinite(Number(excludeSalesOrderId)) && Number(excludeSalesOrderId) > 0) {
    orderParams.push(Number(excludeSalesOrderId));
    orderWhere.push(`so.id <> $${orderParams.length}`);
  }
  const orderRes = await client.query(
    `
      with order_balances as (
        select
          so.id,
          greatest(so.grand_total_order - coalesce(inv.invoiced_amount, 0), 0) as uninvoiced_amount
        from sales_orders so
        left join (
          select
            sales_order_id,
            coalesce(sum(grand_total_invoice), 0) as invoiced_amount
          from customer_invoices
          where invoice_status <> 'cancelled'
          group by sales_order_id
        ) inv on inv.sales_order_id = so.id
        where ${orderWhere.join(" and ")}
      )
      select
        count(*) filter (where uninvoiced_amount > 0.0001)::int as open_order_count,
        coalesce(sum(case when uninvoiced_amount > 0.0001 then uninvoiced_amount else 0 end), 0) as open_order_amount
      from order_balances
    `,
    orderParams
  );

  const dispatchParams = [customerKey];
  const dispatchWhere = [`d.customer_id = $1`, `d.dispatch_status in ('ready', 'dispatched', 'delivered')`];
  if (hasDistributorScope) {
    dispatchParams.push(scopedDistributorId);
    dispatchWhere.push(`d.distributor_id = $${dispatchParams.length}`);
  } else if (hasCompanyScope) {
    dispatchParams.push(scopedCompanyId);
    dispatchWhere.push(`d.company_id = $${dispatchParams.length}`);
  }
  const dispatchRes = await client.query(
    `
      select
        count(*)::int as dispatch_gap_count
      from dispatches d
      where ${dispatchWhere.join(" and ")}
        and not exists (
          select 1
          from customer_invoices ci
          where ci.sales_order_id = d.sales_order_id
            and ci.invoice_status <> 'cancelled'
        )
    `,
    dispatchParams
  );

  const releaseParams = [customerKey];
  const releaseWhere = [`r.customer_id = $1`];
  if (hasDistributorScope) {
    releaseParams.push(scopedDistributorId);
    releaseWhere.push(`r.distributor_id = $${releaseParams.length}`);
  } else if (hasCompanyScope) {
    releaseParams.push(scopedCompanyId);
    releaseWhere.push(`r.company_id = $${releaseParams.length}`);
  }
  const [activeReleaseRes, latestReleaseRes] = await Promise.all([
    client.query(
      `
        select
          r.id,
          r.release_status,
          r.requested_exposure,
          r.approved_upto_amount,
          r.expires_on,
          r.reason,
          r.remarks,
          r.created_at,
          r.approved_at,
          coalesce(u.full_name, u.email) as requested_by_name,
          coalesce(au.full_name, au.email) as approved_by_name
        from customer_credit_releases r
        left join erp_users u on u.id = r.requested_by
        left join erp_users au on au.id = r.approved_by
        where ${releaseWhere.join(" and ")}
          and r.release_status = 'approved'
          and r.expires_on >= current_date
        order by r.expires_on desc, r.id desc
        limit 1
      `,
      releaseParams
    ),
    client.query(
      `
        select
          r.id,
          case
            when r.release_status = 'approved' and r.expires_on < current_date then 'expired'
            else r.release_status
          end as release_status,
          r.requested_exposure,
          r.approved_upto_amount,
          r.expires_on,
          r.reason,
          r.remarks,
          r.created_at,
          r.approved_at,
          r.requested_by,
          coalesce(u.full_name, u.email) as requested_by_name
        from customer_credit_releases r
        left join erp_users u on u.id = r.requested_by
        where ${releaseWhere.join(" and ")}
        order by r.created_at desc, r.id desc
        limit 1
      `,
      releaseParams
    ),
  ]);

  const invoiceRow = invoiceRes.rows[0] || {};
  const orderRow = orderRes.rows[0] || {};
  const dispatchRow = dispatchRes.rows[0] || {};
  const activeRelease = activeReleaseRes.rows[0] || null;
  const latestRelease = latestReleaseRes.rows[0] || null;

  const configuredLimit = qty(customer.credit_limit);
  const releaseLimit = qty(activeRelease?.approved_upto_amount);
  const effectiveLimit = releaseLimit > 0 ? Math.max(configuredLimit, releaseLimit) : configuredLimit;
  const outstandingAmount = qty(invoiceRow.outstanding_amount);
  const openOrderAmount = qty(orderRow.open_order_amount);
  const pendingAmount = qty(pendingSalesOrderAmount);
  const totalExposure = outstandingAmount + openOrderAmount + pendingAmount;
  const overLimitAmount = effectiveLimit > 0 ? Math.max(totalExposure - effectiveLimit, 0) : 0;
  const overdueCount = Number(invoiceRow.overdue_count || 0);
  const hasReleaseCover = Boolean(activeRelease?.id);
  const mode = String(customer.credit_control_mode || "warning").toLowerCase();
  const onHold = Boolean(customer.is_credit_hold);
  const overLimit = overLimitAmount > 0.0001;
  const overdueBlocked = overdueCount > 0 && !hasReleaseCover;
  const limitBlocked = overLimit && !hasReleaseCover;
  const hasRisk = onHold || overdueBlocked || limitBlocked;
  const utilizationPct = effectiveLimit > 0 ? (totalExposure / effectiveLimit) * 100 : null;
  const approachingLimit = !overLimit && utilizationPct !== null && utilizationPct >= NEAR_LIMIT_PCT;

  return {
    ready: true,
    customer_id: customerKey,
    customer_name: customer.customer_name,
    customer_code: customer.customer_code,
    profile: {
      credit_limit: money(customer.credit_limit),
      credit_control_mode: mode || "warning",
      is_credit_hold: onHold,
      credit_hold_reason: customer.credit_hold_reason || null,
    },
    exposure: {
      outstanding_count: Number(invoiceRow.outstanding_count || 0),
      outstanding_amount: money(outstandingAmount),
      overdue_count: overdueCount,
      overdue_amount: money(invoiceRow.overdue_amount),
      max_ageing_days: Number(invoiceRow.max_ageing_days || 0),
      open_order_count: Number(orderRow.open_order_count || 0),
      open_order_amount: money(openOrderAmount),
      pending_order_amount: money(pendingAmount),
      total_exposure: money(totalExposure),
      dispatch_gap_count: Number(dispatchRow.dispatch_gap_count || 0),
      over_limit_amount: money(overLimitAmount),
    },
    active_release: activeRelease
      ? {
          ...activeRelease,
          requested_exposure: money(activeRelease.requested_exposure),
          approved_upto_amount: money(activeRelease.approved_upto_amount),
        }
      : null,
    latest_release: latestRelease
      ? {
          ...latestRelease,
          requested_exposure: money(latestRelease.requested_exposure),
          approved_upto_amount: money(latestRelease.approved_upto_amount),
        }
      : null,
    evaluation: {
      effective_limit: money(effectiveLimit),
      has_release_cover: hasReleaseCover,
      over_limit: overLimit,
      overdue_blocked: overdueBlocked,
      limit_blocked: limitBlocked,
      has_risk: hasRisk,
      utilization_pct: utilizationPct === null ? null : Number(utilizationPct.toFixed(1)),
      approaching_limit: approachingLimit,
      near_limit_pct: NEAR_LIMIT_PCT,
      enforcement_stage: ENFORCEMENT_STAGE_BY_MODE[mode] || "observe",
      queue_bucket: onHold
        ? "hold"
        : latestRelease?.release_status === "requested"
          ? "release_requested"
          : limitBlocked
            ? "over_limit"
            : overdueBlocked
              ? "overdue"
              : hasReleaseCover
                ? "active_release"
                : "clear",
    },
  };
}

function getCreditControlDecision(snapshot, stage = "so_confirmation") {
  if (!snapshot?.ready) return { ready: false, block: false };
  const mode = String(snapshot.profile?.credit_control_mode || "warning").toLowerCase();
  const onHold = Boolean(snapshot.profile?.is_credit_hold);
  const limitBlocked = Boolean(snapshot.evaluation?.limit_blocked);
  const overdueBlocked = Boolean(snapshot.evaluation?.overdue_blocked);

  if (onHold) {
    return {
      ready: true,
      block: true,
      code: "CUSTOMER_CREDIT_HOLD",
      message: snapshot.profile?.credit_hold_reason || "Customer is on credit hold.",
      mode,
      severity: "hard",
      explain: "Manual credit hold — all confirm/dispatch paths stay blocked until released.",
    };
  }

  if (stage === "dispatch_release") {
    if ((mode === "soft_block" || mode === "hard_block") && (limitBlocked || overdueBlocked)) {
      return {
        ready: true,
        block: true,
        code: limitBlocked ? "CUSTOMER_OVER_CREDIT_LIMIT" : "CUSTOMER_OVERDUE_BLOCK",
        message: limitBlocked
          ? "Dispatch is blocked because the customer is over the approved credit limit."
          : "Dispatch is blocked because the customer has overdue receivables.",
        mode,
        severity: mode === "hard_block" ? "hard" : "soft",
        explain:
          mode === "hard_block"
            ? "Hard block: dispatch cannot proceed until credit is cleared."
            : "Soft block: dispatch is gated here; SO confirmation may still warn-only depending on stage.",
      };
    }
  } else if (stage === "so_confirmation") {
    if (mode === "hard_block" && (limitBlocked || overdueBlocked)) {
      return {
        ready: true,
        block: true,
        code: limitBlocked ? "CUSTOMER_OVER_CREDIT_LIMIT" : "CUSTOMER_OVERDUE_BLOCK",
        message: limitBlocked
          ? "Sales-order confirmation is blocked because the customer is over the approved credit limit."
          : "Sales-order confirmation is blocked because the customer has overdue receivables.",
        mode,
        severity: "hard",
        explain: "Hard block: confirmation cannot proceed until credit/overdue is cleared.",
      };
    }
    if (mode === "soft_block" && (limitBlocked || overdueBlocked)) {
      return {
        ready: true,
        block: false,
        warn: true,
        code: limitBlocked ? "CUSTOMER_OVER_CREDIT_LIMIT_WARN" : "CUSTOMER_OVERDUE_WARN",
        message: limitBlocked
          ? "Soft block warning: customer is over the approved credit limit (confirmation still allowed)."
          : "Soft block warning: customer has overdue receivables (confirmation still allowed).",
        mode,
        severity: "soft",
        explain: "Soft block: SO confirmation is allowed with a warning; dispatch will be blocked.",
      };
    }
  }

  const stageLabel = stage === "dispatch_release" ? "Dispatch" : "Sales-order confirmation";
  if (limitBlocked || overdueBlocked) {
    const nextStep =
      mode === "warning"
        ? "Warning mode: nothing is blocked yet. Credit control can move this customer to soft block (gates dispatch) or hard block."
        : "Allowed at this stage; the next gate may block.";
    return {
      ready: true,
      block: false,
      warn: true,
      code: limitBlocked ? "CUSTOMER_OVER_CREDIT_LIMIT_WARN" : "CUSTOMER_OVERDUE_WARN",
      message: limitBlocked
        ? `${stageLabel} allowed, but the customer is over the credit limit by ₹${money(snapshot.exposure?.over_limit_amount).toLocaleString("en-IN")}.`
        : `${stageLabel} allowed, but the customer has ${snapshot.exposure?.overdue_count || 0} overdue invoice(s).`,
      mode,
      severity: "soft",
      explain: nextStep,
    };
  }
  if (snapshot.evaluation?.approaching_limit) {
    return {
      ready: true,
      block: false,
      warn: true,
      code: "CUSTOMER_CREDIT_NEAR_LIMIT",
      message: `Customer is at ${snapshot.evaluation.utilization_pct}% of the credit limit.`,
      mode,
      severity: "info",
      explain: `Heads-up only — flagged from ${snapshot.evaluation.near_limit_pct}% utilisation so collections can act before any block applies.`,
    };
  }

  return { ready: true, block: false, mode, severity: mode === "warning" ? "warn" : null };
}

module.exports = {
  isCreditControlReady,
  getCustomerCreditSnapshot,
  getCreditControlDecision,
};
