const { pool } = require("../db/pool");
const { getGstReconciliationSummary } = require("./financeAccounting");
const { pushDateRangeFilter } = require("./timelineWindow");

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function companyClause(alias, companyId, params) {
  if (Number.isFinite(companyId) && companyId > 0) {
    params.push(companyId);
    return `(${alias}.company_id = $${params.length} or ${alias}.company_id is null)`;
  }
  return "true";
}

function strictCompanyClause(alias, companyId, params) {
  if (Number.isFinite(companyId) && companyId > 0) {
    params.push(companyId);
    return `${alias}.company_id = $${params.length}`;
  }
  return "true";
}

/** Age in days as of window end (dateTo), not Postgres current_date. */
function agingDaysSql(params, dateTo, dateColumn) {
  if (dateTo) {
    params.push(dateTo);
    return `($${params.length}::date - (${dateColumn})::date)`;
  }
  return `(current_date - (${dateColumn})::date)`;
}

async function safeSection(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[executiveAnalytics] ${label} failed:`, err?.message || err);
    return typeof fallback === "function" ? fallback() : fallback;
  }
}

/**
 * Aggregates Working Capital, Receivables (AR), Payables (AP), and GST position.
 */
async function getWorkingCapitalMetrics(client, companyId, timeline = {}) {
  const { dateFrom = null, dateTo = null } = timeline || {};

  // Outstanding AR / aging are a closing position as of dateTo (not "invoices issued this week").
  const arAsOfParams = [];
  const arAsOfCompany = strictCompanyClause("ci", companyId, arAsOfParams);
  const arAgingDays = agingDaysSql(arAsOfParams, dateTo, "ci.invoice_date");
  let receiptAsOfSql = "";
  if (dateTo) {
    arAsOfParams.push(dateTo);
    receiptAsOfSql = `and cr.receipt_date::date <= $${arAsOfParams.length}::date`;
  }
  const arOutstandingSql = `
    greatest(
      coalesce(nullif(ci.grand_total_invoice, 0), ci.grand_total_base, 0)
      - coalesce((
          select sum(cra.allocated_invoice)
          from customer_receipt_allocations cra
          join customer_receipts cr on cr.id = cra.customer_receipt_id
          where cra.customer_invoice_id = ci.id
            and lower(coalesce(cr.receipt_status, 'posted')) not in ('cancelled', 'draft', 'void')
            ${receiptAsOfSql}
        ), 0),
      0
    )`;
  const arAsOfDate = dateTo ? pushDateRangeFilter(arAsOfParams, "ci.invoice_date", null, dateTo) : null;
  const arRes = await client.query(
    `
      select
        coalesce(sum(${arOutstandingSql}), 0) as total_receivable,
        count(*) filter (
          where lower(coalesce(ci.invoice_status, '')) in ('issued', 'sent', 'posted', 'partially_paid', 'paid')
            and ${arOutstandingSql} > 0.01
        ) as active_invoices_count,
        coalesce(sum(case when ${arAgingDays} <= 30 then ${arOutstandingSql} else 0 end), 0) as aging_0_30,
        coalesce(sum(case when ${arAgingDays} between 31 and 60 then ${arOutstandingSql} else 0 end), 0) as aging_31_60,
        coalesce(sum(case when ${arAgingDays} between 61 and 90 then ${arOutstandingSql} else 0 end), 0) as aging_61_90,
        coalesce(sum(case when ${arAgingDays} > 90 then ${arOutstandingSql} else 0 end), 0) as aging_over_90
      from customer_invoices ci
      where ${arAsOfCompany}
        and lower(coalesce(ci.invoice_status, '')) not in ('cancelled', 'draft', 'void')
        ${arAsOfDate ? `and ${arAsOfDate}` : ""}
    `,
    arAsOfParams
  );
  const ar = arRes.rows[0] || {};

  const arPeriodParams = [];
  const arPeriodCompany = strictCompanyClause("ci", companyId, arPeriodParams);
  const arPeriodDate = pushDateRangeFilter(arPeriodParams, "ci.invoice_date", dateFrom, dateTo);
  const arPeriodRes = await client.query(
    `
      select
        coalesce(sum(coalesce(nullif(ci.grand_total_invoice, 0), ci.grand_total_base, 0)), 0) as total_invoiced
      from customer_invoices ci
      where ${arPeriodCompany}
        and lower(coalesce(ci.invoice_status, '')) not in ('cancelled', 'draft', 'void')
        ${arPeriodDate ? `and ${arPeriodDate}` : ""}
    `,
    arPeriodParams
  );
  const arPeriod = arPeriodRes.rows[0] || {};

  const collectedParams = [];
  const collectedCompany = strictCompanyClause("cr", companyId, collectedParams);
  const collectedDate = pushDateRangeFilter(collectedParams, "cr.receipt_date", dateFrom, dateTo);
  let collectedInWindow = 0;
  try {
    const collectedRes = await client.query(
      `
        select coalesce(sum(cr.receipt_amount_invoice), 0) as total_collected
        from customer_receipts cr
        where ${collectedCompany}
          and lower(coalesce(cr.receipt_status, 'posted')) not in ('cancelled', 'draft', 'void')
          and lower(coalesce(cr.payment_mode, '')) <> 'credit note'
          ${collectedDate ? `and ${collectedDate}` : ""}
      `,
      collectedParams
    );
    collectedInWindow = money(collectedRes.rows[0]?.total_collected);
  } catch (_e) {
    collectedInWindow = 0;
  }

  const apAsOfParams = [];
  const apAsOfCompany = strictCompanyClause("vb", companyId, apAsOfParams);
  const apAgingDays = agingDaysSql(apAsOfParams, dateTo, "vb.bill_date");
  const apAsOfDate = dateTo ? pushDateRangeFilter(apAsOfParams, "vb.bill_date", null, dateTo) : null;
  let ap = {};
  try {
    const apRes = await client.query(
      `
        select
          coalesce(sum(grand_total), 0) as total_billed,
          coalesce(sum(paid_amount), 0) as total_paid,
          coalesce(sum(greatest(grand_total - paid_amount, 0)), 0) as total_payable,
          count(*) filter (where payment_status in ('unpaid', 'partially_paid')) as active_bills_count,
          count(*) filter (where match_status = 'matched_ok') as matched_ok_count,
          count(*) filter (where match_status in ('qty_mismatch', 'price_mismatch', 'locked_unverified')) as mismatch_count,
          coalesce(sum(case when ${apAgingDays} <= 30 then greatest(grand_total - paid_amount, 0) else 0 end), 0) as aging_0_30,
          coalesce(sum(case when ${apAgingDays} between 31 and 60 then greatest(grand_total - paid_amount, 0) else 0 end), 0) as aging_31_60,
          coalesce(sum(case when ${apAgingDays} > 60 then greatest(grand_total - paid_amount, 0) else 0 end), 0) as aging_over_60
        from vendor_bills vb
        where ${apAsOfCompany}
          and payment_status <> 'paid'
          ${apAsOfDate ? `and ${apAsOfDate}` : ""}
      `,
      apAsOfParams
    );
    ap = apRes.rows[0] || {};
  } catch (_e) {
    ap = {};
  }

  try {
    const tallyApParams = [companyId];
    const tallyApDate = dateTo ? `and gle.entry_date::date <= $2::date` : "";
    if (dateTo) tallyApParams.push(dateTo);
    const tallyApRes = await client.query(
      `
        select coalesce(sum(gle.credit - gle.debit), 0) as tally_ap
        from general_ledger_entries gle
        join chart_of_accounts coa on coa.id = gle.account_id
        where gle.company_id = $1
          and gle.source_event = 'TALLY_AP_SYNC'
          and coa.account_code = '2100'
          ${tallyApDate}
      `,
      tallyApParams
    );
    const tallyAp = money(tallyApRes.rows[0]?.tally_ap);
    if (tallyAp > 0.01) {
      ap = {
        ...ap,
        total_payable: tallyAp,
        ap_source: "tally_ledgers",
      };
    }
  } catch (_e) {
    /* keep vendor_bills AP */
  }

  if (!Number(ap.total_payable || 0)) {
    try {
      const piParams = [];
      const piCompany = strictCompanyClause("pi", companyId, piParams);
      const piAsOf = dateTo ? pushDateRangeFilter(piParams, "pi.invoice_date", null, dateTo) : null;
      const piRes = await client.query(
        `
          select
            coalesce(sum(coalesce(nullif(pi.grand_total_invoice, 0), pi.grand_total_base, 0)), 0) as total_payable,
            count(*) as active_bills_count
          from purchase_invoices pi
          where ${piCompany}
            and lower(coalesce(pi.invoice_status, '')) = 'posted'
            ${piAsOf ? `and ${piAsOf}` : ""}
        `,
        piParams
      );
      if (Number(piRes.rows[0]?.total_payable || 0) > 0) {
        ap = {
          ...ap,
          total_payable: piRes.rows[0].total_payable,
          active_bills_count: piRes.rows[0].active_bills_count,
        };
      }
    } catch (_e) {
      /* keep vendor_bills result */
    }
  }

  let gstSummary = null;
  try {
    if (Number.isFinite(companyId) && companyId > 0) {
      gstSummary = await getGstReconciliationSummary(client, companyId, { dateTo });
    }
  } catch (_e) {
    gstSummary = { net_gst_liability: 0, itc_carry_forward: 0 };
  }

  const bankParams = [];
  const bankCompany = strictCompanyClause("gle", companyId, bankParams);
  const bankAsOf = dateTo ? pushDateRangeFilter(bankParams, "gle.entry_date", null, dateTo) : null;
  let liquidCash = 0;
  try {
    const bankRes = await client.query(
      `
        select coalesce(sum(gle.debit - gle.credit), 0) as liquid_cash_balance
        from general_ledger_entries gle
        join chart_of_accounts coa on coa.id = gle.account_id
        where ${bankCompany}
          and coa.account_code <> '1100'
          and (
            coa.account_code in ('1400', '1000', '1010', '1020', 'Bank', 'Cash')
            or lower(coa.account_type) in ('bank', 'cash')
            or (lower(coa.account_type) = 'asset' and lower(coa.account_name) ~ '(bank|cash|petty)')
          )
          ${bankAsOf ? `and ${bankAsOf}` : ""}
      `,
      bankParams
    );
    liquidCash = money(bankRes.rows[0]?.liquid_cash_balance);
  } catch (_e) {
    liquidCash = 0;
  }

  let cashSource = liquidCash !== 0 ? "gl" : "none";

  if (liquidCash === 0) {
    try {
      const bookParams = [companyId];
      if (dateTo) bookParams.push(dateTo);
      const entryDate = dateTo ? "and e.entry_date::date <= $2::date" : "";
      const receiptDate = dateTo ? "and cr.receipt_date::date <= $2::date" : "";
      const paymentDate = dateTo ? "and vp.payment_date::date <= $2::date" : "";
      const bookRes = await client.query(
        `
          with manual_totals as (
            select
              e.finance_book_id,
              coalesce(sum(case when e.entry_status = 'posted' and e.entry_type = 'receipt' then e.amount else 0 end), 0) as manual_receipts,
              coalesce(sum(case when e.entry_status = 'posted' and e.entry_type = 'payment' then e.amount else 0 end), 0) as manual_payments
            from finance_book_entries e
            where e.company_id = $1
              ${entryDate}
            group by e.finance_book_id
          ),
          receipt_totals as (
            select
              cr.finance_book_id,
              coalesce(sum(cr.receipt_amount_invoice), 0) as receipt_total
            from customer_receipts cr
            where cr.company_id = $1
              and cr.receipt_status = 'posted'
              and cr.finance_book_id is not null
              ${receiptDate}
            group by cr.finance_book_id
          ),
          payment_totals as (
            select
              vp.finance_book_id,
              coalesce(sum(coalesce(nullif(vp.net_payment_amount, 0), vp.payment_amount)), 0) as payment_total
            from vendor_payments vp
            where vp.company_id = $1
              and vp.payment_status = 'posted'
              and vp.finance_book_id is not null
              ${paymentDate}
            group by vp.finance_book_id
          )
          select coalesce(sum(
            fb.opening_balance
            + coalesce(mt.manual_receipts, 0)
            + coalesce(rt.receipt_total, 0)
            - coalesce(mt.manual_payments, 0)
            - coalesce(pt.payment_total, 0)
          ), 0) as liquid_cash_balance
          from finance_books fb
          left join manual_totals mt on mt.finance_book_id = fb.id
          left join receipt_totals rt on rt.finance_book_id = fb.id
          left join payment_totals pt on pt.finance_book_id = fb.id
          where fb.company_id = $1
        `,
        bookParams
      );
      liquidCash = money(bookRes.rows[0]?.liquid_cash_balance);
      if (liquidCash !== 0) cashSource = "finance_books";
    } catch (_e) {
      /* keep 0 */
    }
  }

  if (liquidCash === 0) {
    try {
      const receiptParams = [];
      const receiptCompany = strictCompanyClause("cr", companyId, receiptParams);
      const receiptAsOf = dateTo ? pushDateRangeFilter(receiptParams, "cr.receipt_date", null, dateTo) : null;
      const receiptRes = await client.query(
        `
          select coalesce(sum(coalesce(cr.unallocated_amount_base, 0)), 0) as receipt_total
          from customer_receipts cr
          where ${receiptCompany}
            and lower(coalesce(cr.receipt_status, 'posted')) not in ('cancelled', 'draft', 'void')
            ${receiptAsOf ? `and ${receiptAsOf}` : ""}
        `,
        receiptParams
      );
      liquidCash = money(receiptRes.rows[0]?.receipt_total);
      if (liquidCash !== 0) cashSource = "unallocated_receipts";
    } catch (_e2) {
      liquidCash = 0;
    }
  }

  const totalReceivable = money(ar.total_receivable);
  const totalPayable = money(ap.total_payable);
  const netGst = money(gstSummary?.net_gst_liability || 0);
  const netWorkingCapital = money(liquidCash + totalReceivable - totalPayable - netGst);

  const totalInvoiced = money(arPeriod.total_invoiced);
  const collectionVelocityPct =
    totalInvoiced > 0 ? Number(((collectedInWindow / totalInvoiced) * 100).toFixed(1)) : 0;

  return {
    liquid_cash_balance: liquidCash,
    cash_source: cashSource,
    net_working_capital: netWorkingCapital,
    collection_velocity_pct: collectionVelocityPct,
    receivables: {
      total: totalReceivable,
      invoiced: totalInvoiced,
      collected: collectedInWindow,
      active_count: Number(ar.active_invoices_count || 0),
      aging: {
        under_30: money(ar.aging_0_30),
        days_31_60: money(ar.aging_31_60),
        days_61_90: money(ar.aging_61_90),
        over_90: money(ar.aging_over_90),
      },
    },
    payables: {
      total: totalPayable,
      billed: money(ap.total_billed),
      paid: money(ap.total_paid),
      active_count: Number(ap.active_bills_count || 0),
      matched_count: Number(ap.matched_ok_count || 0),
      mismatch_count: Number(ap.mismatch_count || 0),
      aging: {
        under_30: money(ap.aging_0_30),
        days_31_60: money(ap.aging_31_60),
        over_60: money(ap.aging_over_60),
      },
    },
    tax_position: {
      net_gst_payable: netGst,
      itc_carry_forward: money(gstSummary?.itc_carry_forward || 0),
    },
  };
}

/**
 * Aggregates Manufacturing, Shop Floor throughput, and Scrap Variances.
 */
async function getManufacturingMetrics(client, companyId, timeline = {}) {
  const { dateFrom = null, dateTo = null } = timeline || {};
  const woParams = [];
  const woCompany = companyClause("wo", companyId, woParams);
  const woDate = pushDateRangeFilter(woParams, "coalesce(wo.actual_completed_at, wo.scheduled_start_date, wo.created_at)", dateFrom, dateTo);
  let wo = {};
  try {
    const woRes = await client.query(
      `
        select
          count(*) as total_work_orders,
          count(*) filter (where status = 'scheduled') as scheduled_count,
          count(*) filter (where status = 'in_production') as in_production_count,
          count(*) filter (where status = 'completed') as completed_count,
          count(*) filter (where status = 'cancelled') as cancelled_count
        from work_orders wo
        where ${woCompany}
          ${woDate ? `and ${woDate}` : ""}
      `,
      woParams
    );
    wo = woRes.rows[0] || {};
  } catch (_e) {
    wo = {};
  }

  // Also reflect job_cards when dedicated work_orders table is empty
  const totalWO = Number(wo.total_work_orders || 0);
  if (totalWO === 0) {
    try {
      const jcParams = [];
      const jcCompany = companyClause("jc", companyId, jcParams);
      const jcDate = pushDateRangeFilter(jcParams, "coalesce(jc.updated_at, jc.created_at)", dateFrom, dateTo);
      const jcRes = await client.query(
        `
          select
            count(*) as total_work_orders,
            count(*) filter (where lower(coalesce(job_status, '')) in ('draft', 'submitted', 'approved', 'open', 'scheduled')) as scheduled_count,
            count(*) filter (where lower(coalesce(job_status, '')) in ('in_progress', 'in_production', 'kitting', 'production')) as in_production_count,
            count(*) filter (where lower(coalesce(job_status, '')) in ('completed', 'closed', 'posted', 'fg_received')) as completed_count,
            count(*) filter (where lower(coalesce(job_status, '')) = 'cancelled') as cancelled_count
          from job_cards jc
          where ${jcCompany}
            ${jcDate ? `and ${jcDate}` : ""}
        `,
        jcParams
      );
      wo = jcRes.rows[0] || wo;
    } catch (_e) {
      /* keep wo */
    }
  }

  let scrap = {};
  let topReasons = [];
  try {
    const scrapParams = [];
    const scrapCompany = companyClause("s", companyId, scrapParams);
    const scrapRes = await client.query(
      `
        select
          coalesce(sum(qty_scrapped), 0) as total_scrap_qty,
          coalesce(sum(variance_cost), 0) as total_scrap_variance_cost,
          count(*) as scrap_incidents_count
        from shop_floor_scrap s
        where ${scrapCompany}
      `,
      scrapParams
    );
    scrap = scrapRes.rows[0] || {};

    const reasonsParams = [];
    const reasonsCompany = companyClause("s", companyId, reasonsParams);
    const reasonsRes = await client.query(
      `
        select
          reason,
          count(*) as count,
          coalesce(sum(variance_cost), 0) as variance_cost
        from shop_floor_scrap s
        where ${reasonsCompany}
        group by reason
        order by variance_cost desc
        limit 4
      `,
      reasonsParams
    );
    topReasons = reasonsRes.rows;
  } catch (_e) {
    scrap = {};
    topReasons = [];
  }

  // stock_balances uses stock_qty / stock_value_base / average_unit_cost_base (not current_balance)
  let stock = {};
  try {
    const stockParams = [];
    const stockCompany = companyClause("sb", companyId, stockParams);
    const stockRes = await client.query(
      `
        select
          coalesce(sum(coalesce(sb.stock_value_base, coalesce(sb.stock_qty, 0) * coalesce(sb.average_unit_cost_base, 0))), 0) as total_inventory_valuation,
          count(*) filter (where coalesce(sb.stock_qty, 0) > 0) as active_sku_count,
          count(*) filter (where coalesce(sb.stock_qty, 0) <= 0) as out_of_stock_sku_count
        from stock_balances sb
        where ${stockCompany}
      `,
      stockParams
    );
    stock = stockRes.rows[0] || {};
  } catch (_e) {
    stock = {};
  }

  const totalOrders = Number(wo.total_work_orders || 0);
  const completedWO = Number(wo.completed_count || 0);
  const completionEfficiencyPct =
    totalOrders > 0 ? Number(((completedWO / totalOrders) * 100).toFixed(1)) : 0;

  return {
    completion_efficiency_pct: completionEfficiencyPct,
    work_orders: {
      total: totalOrders,
      scheduled: Number(wo.scheduled_count || 0),
      in_production: Number(wo.in_production_count || 0),
      completed: completedWO,
      cancelled: Number(wo.cancelled_count || 0),
    },
    scrap: {
      total_variance_cost: money(scrap.total_scrap_variance_cost),
      total_qty: Number(scrap.total_scrap_qty || 0),
      incidents: Number(scrap.scrap_incidents_count || 0),
      top_reasons: topReasons.map((r) => ({
        reason: r.reason || "Unspecified",
        count: Number(r.count),
        variance_cost: money(r.variance_cost),
      })),
    },
    inventory: {
      total_valuation: money(stock.total_inventory_valuation),
      active_sku_count: Number(stock.active_sku_count || 0),
      out_of_stock_count: Number(stock.out_of_stock_sku_count || 0),
    },
  };
}

/**
 * Build commercial funnel from sales_pipelines when present; otherwise
 * bridge from leads + quote_headers (hygiene-synced historical data).
 */
async function getQuoteLeadPipeline(client, companyId, timeline = {}) {
  const { dateFrom = null, dateTo = null } = timeline || {};
  const params = [];
  const qCompany = companyClause("qh", companyId, params);
  const qDate = pushDateRangeFilter(
    params,
    "coalesce(qr.issued_at, qr.prepared_at, qh.created_at)",
    dateFrom,
    dateTo
  );
  const quoteRes = await client.query(
    `
      select
        count(*) filter (
          where lower(coalesce(qh.quote_status, '')) in ('draft', 'pending_approval', 'approved')
        )::int as inquiry_count,
        coalesce(sum(qr.grand_total_quote) filter (
          where lower(coalesce(qh.quote_status, '')) in ('draft', 'pending_approval', 'approved')
        ), 0) as inquiry_value,
        count(*) filter (
          where lower(coalesce(qh.quote_status, '')) in ('issued', 'sent', 'lapsed')
            and qh.next_follow_up_at is null
        )::int as quoted_count,
        coalesce(sum(qr.grand_total_quote) filter (
          where lower(coalesce(qh.quote_status, '')) in ('issued', 'sent', 'lapsed')
            and qh.next_follow_up_at is null
        ), 0) as quoted_value,
        count(*) filter (
          where lower(coalesce(qh.quote_status, '')) in ('issued', 'sent')
            and qh.next_follow_up_at is not null
        )::int as negotiation_count,
        coalesce(sum(qr.grand_total_quote) filter (
          where lower(coalesce(qh.quote_status, '')) in ('issued', 'sent')
            and qh.next_follow_up_at is not null
        ), 0) as negotiation_value,
        count(*) filter (
          where lower(coalesce(qh.quote_status, '')) = 'converted'
        )::int as won_count,
        coalesce(sum(qr.grand_total_quote) filter (
          where lower(coalesce(qh.quote_status, '')) = 'converted'
        ), 0) as won_value,
        count(*) filter (
          where lower(coalesce(qh.quote_status, '')) = 'closed'
        )::int as lost_count,
        coalesce(sum(qr.grand_total_quote) filter (
          where lower(coalesce(qh.quote_status, '')) = 'closed'
        ), 0) as lost_value
      from quote_headers qh
      left join quote_revisions qr on qr.quote_id = qh.id and qr.is_latest = true
      where ${qCompany}
        and lower(coalesce(qh.quote_status, '')) <> 'cancelled'
        ${qDate ? `and ${qDate}` : ""}
    `,
    params
  );
  const q = quoteRes.rows[0] || {};

  const leadParams = [];
  const leadCompany = companyClause("l", companyId, leadParams);
  const leadDate = pushDateRangeFilter(leadParams, "coalesce(l.legacy_created_at, l.created_at)", dateFrom, dateTo);
  let leadInquiryValue = 0;
  let leadInquiryCount = 0;
  try {
    const leadRes = await client.query(
      `
        select
          count(*)::int as lead_count
        from leads l
        where ${leadCompany}
          and lower(coalesce(l.status, '')) in (
            'new', 'follow_up', 'qualified', 'quoted', 'warm', 'hot', 'to_be_qualified'
          )
          and l.converted_quote_id is null
          ${leadDate ? `and ${leadDate}` : ""}
      `,
      leadParams
    );
    leadInquiryCount = Number(leadRes.rows[0]?.lead_count || 0);
    // Leads without quote value: count only (value stays on quotes)
    leadInquiryValue = 0;
  } catch (_e) {
    leadInquiryCount = 0;
  }

  const inquiryValue = money(q.inquiry_value) + money(leadInquiryValue);
  const quotedValue = money(q.quoted_value);
  const negotiationValue = money(q.negotiation_value);
  const wonValue = money(q.won_value);
  const lostValue = money(q.lost_value);

  const totalDeals =
    Number(q.inquiry_count || 0) +
    leadInquiryCount +
    Number(q.quoted_count || 0) +
    Number(q.negotiation_count || 0) +
    Number(q.won_count || 0) +
    Number(q.lost_count || 0);

  // Active pipeline = inquiry + quoted + negotiation (exclude won/lost from headline)
  const activeValue = money(inquiryValue + quotedValue + negotiationValue);
  const weighted = money(inquiryValue * 0.2 + quotedValue * 0.5 + negotiationValue * 0.7 + wonValue * 1.0);

  return {
    total_deals: totalDeals,
    total_value: activeValue,
    weighted_value: weighted,
    stages: {
      inquiry: inquiryValue,
      quoted: quotedValue,
      negotiation: negotiationValue,
      won: wonValue,
      lost: lostValue,
    },
    source: "quotes_leads",
    counts: {
      inquiry: Number(q.inquiry_count || 0) + leadInquiryCount,
      quoted: Number(q.quoted_count || 0),
      negotiation: Number(q.negotiation_count || 0),
      won: Number(q.won_count || 0),
      lost: Number(q.lost_count || 0),
    },
  };
}

/**
 * Aggregates Commercial Sales Funnel, Dispatches, and Field Service Pulse.
 */
async function getCommercialServiceMetrics(client, companyId, timeline = {}) {
  const { dateFrom = null, dateTo = null } = timeline || {};
  let pipeline = {
    total_deals: 0,
    total_value: 0,
    weighted_value: 0,
    stages: { inquiry: 0, quoted: 0, negotiation: 0, won: 0, lost: 0 },
  };

  try {
    const pipeParams = [];
    const pipeCompany = companyClause("sp", companyId, pipeParams);
    const pipeDate = pushDateRangeFilter(pipeParams, "coalesce(sp.updated_at, sp.created_at)", dateFrom, dateTo);
    const pipeRes = await client.query(
      `
        select
          count(*) as total_deals,
          coalesce(sum(expected_value) filter (where stage in ('inquiry', 'quoted', 'negotiation')), 0) as total_pipeline_value,
          coalesce(sum(expected_value * probability_pct / 100.0) filter (where stage in ('inquiry', 'quoted', 'negotiation')), 0) as weighted_pipeline_value,
          coalesce(sum(expected_value) filter (where stage = 'inquiry'), 0) as inquiry_value,
          coalesce(sum(expected_value) filter (where stage = 'quoted'), 0) as quoted_value,
          coalesce(sum(expected_value) filter (where stage = 'negotiation'), 0) as negotiation_value,
          coalesce(sum(expected_value) filter (where stage = 'won'), 0) as won_value,
          coalesce(sum(expected_value) filter (where stage = 'lost'), 0) as lost_value
        from sales_pipelines sp
        where ${pipeCompany}
          ${pipeDate ? `and ${pipeDate}` : ""}
      `,
      pipeParams
    );
    const pipe = pipeRes.rows[0] || {};
    if (Number(pipe.total_deals || 0) > 0) {
      pipeline = {
        total_deals: Number(pipe.total_deals || 0),
        total_value: money(pipe.total_pipeline_value),
        weighted_value: money(pipe.weighted_pipeline_value),
        stages: {
          inquiry: money(pipe.inquiry_value),
          quoted: money(pipe.quoted_value),
          negotiation: money(pipe.negotiation_value),
          won: money(pipe.won_value),
          lost: money(pipe.lost_value),
        },
        source: "sales_pipelines",
      };
    } else {
      pipeline = await getQuoteLeadPipeline(client, companyId, timeline);
    }
  } catch (_e) {
    pipeline = await getQuoteLeadPipeline(client, companyId, timeline);
  }

  const orderParams = [];
  const orderCompany = companyClause("so", companyId, orderParams);
  const orderDate = pushDateRangeFilter(orderParams, "coalesce(so.order_date, so.created_at)", dateFrom, dateTo);
  const orderRes = await client.query(
    `
      select
        count(*) as total_sales_orders,
        coalesce(sum(
          coalesce(
            nullif(so.grand_total_order, 0),
            nullif(so.grand_total_base, 0),
            (
              select coalesce(sum(coalesce(nullif(sol.line_total_order, 0), sol.line_total_base, 0)), 0)
              from sales_order_lines sol
              where sol.sales_order_id = so.id
            )
          )
        ), 0) as total_booked_value,
        count(*) filter (where lower(coalesce(so.order_status, '')) in ('confirmed', 'open', 'partial', 'in_progress')) as open_orders_count,
        count(*) filter (where lower(coalesce(so.order_status, '')) in ('dispatched', 'closed', 'completed', 'delivered')) as dispatched_orders_count
      from sales_orders so
      where ${orderCompany}
        and lower(coalesce(so.order_status, '')) <> 'cancelled'
        ${orderDate ? `and ${orderDate}` : ""}
    `,
    orderParams
  );
  const orders = orderRes.rows[0] || {};

  const dispParams = [];
  const dispCompany = companyClause("d", companyId, dispParams);
  let dispatches = {};
  try {
    const dispRes = await client.query(
      `
        select
          count(*) as total_dispatches,
          coalesce(sum(gross_weight_kg), 0) as total_weight_kg,
          coalesce(sum(total_packages), 0) as total_packages
        from dispatches d
        where ${dispCompany}
      `,
      dispParams
    );
    dispatches = dispRes.rows[0] || {};
  } catch (_e) {
    dispatches = {};
  }

  let srv = {};
  try {
    const srvParams = [];
    const srvCompany = companyClause("st", companyId, srvParams);
    const srvRes = await client.query(
      `
        select
          count(*) as total_tickets,
          count(*) filter (where ticket_status in ('open', 'assigned', 'in_progress')) as open_tickets,
          count(*) filter (where ticket_status in ('resolved', 'closed')) as resolved_tickets,
          count(*) filter (where ticket_priority = 'critical' and ticket_status in ('open', 'assigned', 'in_progress')) as critical_open,
          coalesce(sum(parts_cost_total), 0) as total_parts_cost
        from service_tickets st
        where ${srvCompany}
      `,
      srvParams
    );
    srv = srvRes.rows[0] || {};
  } catch (_e) {
    srv = {};
  }

  let eq = {};
  try {
    const eqParams = [];
    const eqCompany = companyClause("ie", companyId, eqParams);
    const eqRes = await client.query(
      `
        select
          count(*) as total_equipment,
          count(*) filter (where warranty_end_date >= current_date) as active_warranty_count,
          count(*) filter (where warranty_end_date < current_date) as expired_warranty_count
        from installed_equipment ie
        where ${eqCompany}
      `,
      eqParams
    );
    eq = eqRes.rows[0] || {};
  } catch (_e) {
    // Fall back to job_assets when installed_equipment is empty/unavailable
    try {
      const jaParams = [];
      const jaCompany = companyClause("ja", companyId, jaParams);
      const jaRes = await client.query(
        `
          select
            count(*) as total_equipment,
            count(*) filter (where warranty_end_date >= current_date) as active_warranty_count,
            count(*) filter (where warranty_end_date < current_date) as expired_warranty_count
          from job_assets ja
          where ${jaCompany}
        `,
        jaParams
      );
      eq = jaRes.rows[0] || {};
    } catch (_e2) {
      eq = {};
    }
  }

  let amc = {};
  try {
    const amcParams = [];
    const amcCompany = companyClause("a", companyId, amcParams);
    const amcRes = await client.query(
      `
        select
          count(*) as total_amc_contracts,
          count(*) filter (where contract_status = 'active' and coalesce(end_date, current_date) >= current_date) as active_amc_count,
          coalesce(sum(contract_value) filter (where contract_status = 'active'), 0) as active_amc_value
        from amc_contracts a
        where ${amcCompany}
      `,
      amcParams
    );
    amc = amcRes.rows[0] || {};
  } catch (_e) {
    amc = {};
  }

  return {
    pipeline,
    sales_orders: {
      total_orders: Number(orders.total_sales_orders || 0),
      booked_value: money(orders.total_booked_value),
      open_orders: Number(orders.open_orders_count || 0),
      dispatched_orders: Number(orders.dispatched_orders_count || 0),
    },
    dispatches: {
      total_consignments: Number(dispatches.total_dispatches || 0),
      total_weight_kg: Number(dispatches.total_weight_kg || 0),
      total_packages: Number(dispatches.total_packages || 0),
    },
    service: {
      installed_equipment_count: Number(eq.total_equipment || 0),
      active_warranty_count: Number(eq.active_warranty_count || 0),
      expired_warranty_count: Number(eq.expired_warranty_count || 0),
      active_amc_count: Number(amc.active_amc_count || 0),
      active_amc_value: money(amc.active_amc_value),
      open_tickets: Number(srv.open_tickets || 0),
      resolved_tickets: Number(srv.resolved_tickets || 0),
      critical_open: Number(srv.critical_open || 0),
      parts_consumed_cost: money(srv.total_parts_cost),
    },
  };
}

/**
 * Returns unified real-time executive dashboard payload.
 * Sections are isolated so one failing query cannot zero the whole desk.
 */
async function getUnifiedExecutiveMetrics(client, companyId, timeline = {}) {
  const emptyWc = () => ({
    liquid_cash_balance: 0,
    cash_source: "none",
    net_working_capital: 0,
    collection_velocity_pct: 0,
    receivables: { total: 0, invoiced: 0, collected: 0, active_count: 0, aging: { under_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 } },
    payables: { total: 0, billed: 0, paid: 0, active_count: 0, matched_count: 0, mismatch_count: 0, aging: { under_30: 0, days_31_60: 0, over_60: 0 } },
    tax_position: { net_gst_payable: 0, itc_carry_forward: 0 },
  });
  const emptyMfg = () => ({
    completion_efficiency_pct: 0,
    work_orders: { total: 0, scheduled: 0, in_production: 0, completed: 0, cancelled: 0 },
    scrap: { total_variance_cost: 0, total_qty: 0, incidents: 0, top_reasons: [] },
    inventory: { total_valuation: 0, active_sku_count: 0, out_of_stock_count: 0 },
  });
  const emptyCommercial = () => ({
    pipeline: { total_deals: 0, total_value: 0, weighted_value: 0, stages: { inquiry: 0, quoted: 0, negotiation: 0, won: 0, lost: 0 } },
    sales_orders: { total_orders: 0, booked_value: 0, open_orders: 0, dispatched_orders: 0 },
    dispatches: { total_consignments: 0, total_weight_kg: 0, total_packages: 0 },
    service: {
      installed_equipment_count: 0,
      active_warranty_count: 0,
      expired_warranty_count: 0,
      active_amc_count: 0,
      active_amc_value: 0,
      open_tickets: 0,
      resolved_tickets: 0,
      critical_open: 0,
      parts_consumed_cost: 0,
    },
  });

  const workingCapital = await safeSection("working_capital", () => getWorkingCapitalMetrics(client, companyId, timeline), emptyWc);
  const manufacturing = await safeSection("manufacturing", () => getManufacturingMetrics(client, companyId, timeline), emptyMfg);
  const commercialService = await safeSection("commercial_service", () => getCommercialServiceMetrics(client, companyId, timeline), emptyCommercial);

  const inventoryOnHand = money(manufacturing?.inventory?.total_valuation);
  workingCapital.inventory_on_hand = inventoryOnHand;
  workingCapital.net_working_capital = money(
    Number(workingCapital.liquid_cash_balance || 0) +
      Number(workingCapital.receivables?.total || 0) +
      inventoryOnHand -
      Number(workingCapital.payables?.total || 0) -
      Number(workingCapital.tax_position?.net_gst_payable || 0)
  );

  return {
    timestamp: new Date().toISOString(),
    company_id: companyId,
    timeline: {
      date_from: timeline?.dateFrom || null,
      date_to: timeline?.dateTo || null,
      preset: timeline?.preset || null,
      label: timeline?.label || null,
      range_label: timeline?.rangeLabel || null,
      hint: timeline?.hint || null,
      timezone: timeline?.timezone || "Asia/Kolkata",
    },
    working_capital: workingCapital,
    manufacturing: manufacturing,
    commercial_service: commercialService,
  };
}

module.exports = {
  getWorkingCapitalMetrics,
  getManufacturingMetrics,
  getCommercialServiceMetrics,
  getUnifiedExecutiveMetrics,
};
