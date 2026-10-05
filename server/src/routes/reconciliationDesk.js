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

function normalizeId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function isArAdjustmentsReady(client = pool) {
  const r = await client.query(`select to_regclass('public.customer_ar_adjustments') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

async function isCollectionsFollowupsReady(client = pool) {
  const r = await client.query(`select to_regclass('public.customer_collection_actions') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

async function isCollectionsDisputesReady(client = pool) {
  const r = await client.query(`select to_regclass('public.customer_collection_disputes') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

function canViewReconciliation(req) {
  return (
    hasScreenAction(req, "receipts", "can_view") ||
    hasScreenAction(req, "invoices", "can_view") ||
    hasScreenAction(req, "customers", "can_view")
  );
}

async function loadContextFilters(req, client = pool) {
  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
  if (isDistributor && !distributorId) return { ok: false, error: "DISTRIBUTOR_NOT_LINKED" };
  const activeCompanyId = isDistributor ? null : getActiveCompanyId(req) || null;
  if (!isDistributor && !activeCompanyId) return { ok: false, error: "COMPANY_NOT_SELECTED" };
  return { ok: true, isDistributor, distributorId, activeCompanyId };
}

function getAdjustmentInvoiceJoin(enabled) {
  if (!enabled) return "";
  return `
        left join (
          select
            customer_invoice_id,
            coalesce(sum(adjustment_amount), 0) as adjustment_amount
          from customer_ar_adjustments
          where adjustment_status = 'posted'
          group by customer_invoice_id
        ) adj on adj.customer_invoice_id = ci.id`;
}

function getAdjustmentRollupCte(enabled) {
  if (!enabled) {
    return `,
      adjustment_rollup as (
        select
          null::integer as customer_id,
          0::numeric as total_adjusted
        where false
      )`;
  }
  return `,
      adjustment_rollup as (
        select
          a.customer_id,
          coalesce(sum(a.adjustment_amount), 0) as total_adjusted
        from customer_ar_adjustments a
        where a.adjustment_status = 'posted'
          and ${"{ADJUST_SCOPE}"}
        group by a.customer_id
      )`;
}

async function getReconciliationCustomers(
  client,
  { companyId = null, distributorId = null, q = "", bucket = "", limit = 200, customerId = null } = {}
) {
  const adjustmentsReady = await isArAdjustmentsReady(client);
  const params = [];
  const invoiceScope = [];
  const receiptScope = [];
  const creditScope = [];
  const adjustScope = [];
  const candidateWhere = [];

  if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
    params.push(Number(distributorId));
    invoiceScope.push(`ci.distributor_id = $${params.length}`);
    receiptScope.push(`cr.distributor_id = $${params.length}`);
    creditScope.push(`sr.distributor_id = $${params.length}`);
    adjustScope.push(`a.distributor_id = $${params.length}`);
  } else if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    invoiceScope.push(`ci.company_id = $${params.length}`);
    receiptScope.push(`cr.company_id = $${params.length}`);
    creditScope.push(`sr.company_id = $${params.length}`);
    adjustScope.push(`a.company_id = $${params.length}`);
  }

  if (customerId) {
    params.push(Number(customerId));
    invoiceScope.push(`ci.customer_id = $${params.length}`);
    receiptScope.push(`cr.customer_id = $${params.length}`);
    creditScope.push(`sr.customer_id = $${params.length}`);
    adjustScope.push(`a.customer_id = $${params.length}`);
    candidateWhere.push(`c.id = $${params.length}`);
  }

  if (q) {
    params.push(`%${q}%`);
    candidateWhere.push(`(c.customer_name ilike $${params.length} or coalesce(c.customer_code, '') ilike $${params.length})`);
  }

  const adjustmentRollupCte = getAdjustmentRollupCte(adjustmentsReady).replace("{ADJUST_SCOPE}", adjustScope.length ? adjustScope.join(" and ") : "false");
  const rowsRes = await client.query(
    `
      with invoice_core as (
        select
          ci.id,
          ci.customer_id,
          ci.invoice_number,
          ci.invoice_date,
          ci.grand_total_invoice,
          coalesce(pr.allocated_invoice, 0) as allocated_invoice,
          coalesce(sr.credit_note_amount, 0) as credit_note_amount,
          ${adjustmentsReady ? `coalesce(adj.adjustment_amount, 0)` : `0::numeric`} as adjustment_amount,
          (
            ci.grand_total_invoice
            - coalesce(pr.allocated_invoice, 0)
            - coalesce(sr.credit_note_amount, 0)
            ${adjustmentsReady ? `- coalesce(adj.adjustment_amount, 0)` : ""}
          ) as outstanding_invoice
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
        ${getAdjustmentInvoiceJoin(adjustmentsReady)}
        where ci.invoice_status <> 'cancelled'
          and ${invoiceScope.length ? invoiceScope.join(" and ") : "false"}
      ),
      invoice_rollup as (
        select
          customer_id,
          count(*) filter (where outstanding_invoice > 0.0001)::int as open_invoice_count,
          coalesce(sum(case when outstanding_invoice > 0.0001 then outstanding_invoice else 0 end), 0) as open_invoice_amount,
          count(*) filter (where allocated_invoice > 0.0001 and outstanding_invoice > 0.0001)::int as partially_allocated_invoice_count,
          coalesce(sum(case when allocated_invoice > 0.0001 and outstanding_invoice > 0.0001 then outstanding_invoice else 0 end), 0) as partial_invoice_amount,
          coalesce(sum(grand_total_invoice), 0) as total_invoiced
        from invoice_core
        group by customer_id
      ),
      receipt_rollup as (
        select
          cr.customer_id,
          count(*) filter (where cr.receipt_status = 'posted')::int as posted_receipt_count,
          count(*) filter (where cr.receipt_status = 'posted' and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001)::int as unapplied_receipt_count,
          coalesce(sum(case when cr.receipt_status = 'posted' then cr.receipt_amount_invoice else 0 end), 0) as total_received,
          coalesce(sum(case when cr.receipt_status = 'posted' and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001 then cr.unallocated_amount_invoice else 0 end), 0) as unapplied_cash_amount,
          coalesce(max(case when cr.receipt_status = 'posted' and coalesce(cr.unallocated_amount_invoice, 0) > 0.0001 then current_date - cr.receipt_date else null end), 0)::int as oldest_unapplied_days
        from customer_receipts cr
        where ${receiptScope.length ? receiptScope.join(" and ") : "false"}
        group by cr.customer_id
      ),
      credit_rollup as (
        select
          sr.customer_id,
          coalesce(sum(sr.credit_note_amount), 0) as total_credited
        from sales_returns sr
        where sr.return_status = 'posted'
          and coalesce(sr.credit_note_amount, 0) > 0.0001
          and ${creditScope.length ? creditScope.join(" and ") : "false"}
        group by sr.customer_id
      )
      ${adjustmentRollupCte},
      candidate_ids as (
        select customer_id from invoice_rollup
        union
        select customer_id from receipt_rollup
        union
        select customer_id from credit_rollup
        union
        select customer_id from adjustment_rollup
      )
      select
        c.id as customer_id,
        c.customer_name,
        c.customer_code,
        coalesce(i.total_invoiced, 0) as total_invoiced,
        coalesce(r.total_received, 0) as total_received,
        coalesce(cr.total_credited, 0) as total_credited,
        coalesce(ar.total_adjusted, 0) as total_adjusted,
        coalesce(i.open_invoice_count, 0) as open_invoice_count,
        coalesce(i.open_invoice_amount, 0) as open_invoice_amount,
        coalesce(i.partially_allocated_invoice_count, 0) as partially_allocated_invoice_count,
        coalesce(i.partial_invoice_amount, 0) as partial_invoice_amount,
        coalesce(r.unapplied_receipt_count, 0) as unapplied_receipt_count,
        coalesce(r.unapplied_cash_amount, 0) as unapplied_cash_amount,
        coalesce(r.oldest_unapplied_days, 0) as oldest_unapplied_days,
        (
          coalesce(i.total_invoiced, 0)
          - coalesce(r.total_received, 0)
          - coalesce(cr.total_credited, 0)
          - coalesce(ar.total_adjusted, 0)
        ) as net_customer_balance
      from candidate_ids x
      join customers c on c.id = x.customer_id
      left join invoice_rollup i on i.customer_id = c.id
      left join receipt_rollup r on r.customer_id = c.id
      left join credit_rollup cr on cr.customer_id = c.id
      left join adjustment_rollup ar on ar.customer_id = c.id
      ${candidateWhere.length ? `where ${candidateWhere.join(" and ")}` : ""}
      order by c.customer_name asc
      limit ${Math.min(Math.max(Number(limit || 200), 1), 1000)}
    `,
    params
  );

  const rows = (rowsRes.rows || []).map((row) => {
    const openInvoiceAmount = money(row.open_invoice_amount);
    const unappliedCashAmount = money(row.unapplied_cash_amount);
    const netCustomerBalance = money(row.net_customer_balance);
    const mismatchAmount = money(Math.abs(openInvoiceAmount - netCustomerBalance));
    const queueBucket =
      unappliedCashAmount > 0.0001 && openInvoiceAmount > 0.0001
        ? "matching_gap"
        : unappliedCashAmount > 0.0001 && Number(row.oldest_unapplied_days || 0) > 7
          ? "old_unapplied"
          : unappliedCashAmount > 0.0001
            ? "unapplied_cash"
            : Number(row.partially_allocated_invoice_count || 0) > 0
              ? "partial_settlement"
              : mismatchAmount > 0.0001
                ? "balance_disagreement"
                : "clear";
    return {
      ...row,
      total_invoiced: money(row.total_invoiced),
      total_received: money(row.total_received),
      total_credited: money(row.total_credited),
      total_adjusted: money(row.total_adjusted),
      open_invoice_amount: openInvoiceAmount,
      partial_invoice_amount: money(row.partial_invoice_amount),
      unapplied_cash_amount: unappliedCashAmount,
      net_customer_balance: netCustomerBalance,
      mismatch_amount: mismatchAmount,
      queue_bucket: queueBucket,
    };
  });

  if (!bucket || bucket === "all") return rows;
  return rows.filter((row) => {
    if (bucket === "unapplied_cash") return Number(row.unapplied_cash_amount || 0) > 0.0001;
    if (bucket === "partial_settlement") return Number(row.partially_allocated_invoice_count || 0) > 0;
    if (bucket === "matching_gap") return Number(row.unapplied_cash_amount || 0) > 0.0001 && Number(row.open_invoice_amount || 0) > 0.0001;
    if (bucket === "old_unapplied") return Number(row.unapplied_cash_amount || 0) > 0.0001 && Number(row.oldest_unapplied_days || 0) > 7;
    if (bucket === "balance_disagreement") return Number(row.mismatch_amount || 0) > 0.0001;
    return true;
  });
}

async function getReconciliationDetail(client, { companyId = null, distributorId = null, customerId }) {
  const adjustmentsReady = await isArAdjustmentsReady(client);
  const followupsReady = await isCollectionsFollowupsReady(client);
  const disputesReady = await isCollectionsDisputesReady(client);
  const baseRows = await getReconciliationCustomers(client, { companyId, distributorId, customerId, limit: 1 });
  const customer = baseRows[0] || null;
  if (!customer) return null;

  const params = [Number(customerId)];
  const invoiceScope = [`ci.customer_id = $1`, `ci.invoice_status <> 'cancelled'`];
  const receiptScope = [`cr.customer_id = $1`];
  const creditScope = [`sr.customer_id = $1`, `sr.return_status = 'posted'`, `coalesce(sr.credit_note_amount, 0) > 0.0001`];
  const adjustScope = [`a.customer_id = $1`];
  const disputeScope = [`d.customer_id = $1`];
  const promiseScope = [`a.customer_id = $1`];

  if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
    params.push(Number(distributorId));
    invoiceScope.push(`ci.distributor_id = $${params.length}`);
    receiptScope.push(`cr.distributor_id = $${params.length}`);
    creditScope.push(`sr.distributor_id = $${params.length}`);
    adjustScope.push(`a.distributor_id = $${params.length}`);
    disputeScope.push(`d.distributor_id = $${params.length}`);
    promiseScope.push(`a.distributor_id = $${params.length}`);
  } else if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    invoiceScope.push(`ci.company_id = $${params.length}`);
    receiptScope.push(`cr.company_id = $${params.length}`);
    creditScope.push(`sr.company_id = $${params.length}`);
    adjustScope.push(`a.company_id = $${params.length}`);
    disputeScope.push(`d.company_id = $${params.length}`);
    promiseScope.push(`a.company_id = $${params.length}`);
  }

  const detailPromises = [
    client.query(
      `
        select
          ci.id,
          ci.invoice_number,
          ci.invoice_date,
          curr.currency_code as invoice_currency_code,
          ci.grand_total_invoice,
          coalesce(pr.allocated_invoice, 0) as allocated_invoice,
          coalesce(sr.credit_note_amount, 0) as credit_note_amount,
          ${adjustmentsReady ? `coalesce(adj.adjustment_amount, 0)` : `0::numeric`} as adjustment_amount,
          (
            ci.grand_total_invoice
            - coalesce(pr.allocated_invoice, 0)
            - coalesce(sr.credit_note_amount, 0)
            ${adjustmentsReady ? `- coalesce(adj.adjustment_amount, 0)` : ""}
          ) as outstanding_invoice
        from customer_invoices ci
        left join currencies curr on curr.id = ci.invoice_currency_id
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
        ${getAdjustmentInvoiceJoin(adjustmentsReady)}
        where ${invoiceScope.join(" and ")}
        order by ci.invoice_date desc, ci.id desc
        limit 50
      `,
      params
    ),
    client.query(
      `
        select
          cr.id,
          cr.receipt_number,
          cr.receipt_status,
          cr.receipt_date,
          cr.payment_mode,
          cr.receipt_amount_invoice,
          cr.allocated_amount_invoice,
          cr.unallocated_amount_invoice,
          curr.currency_code as receipt_currency_code
        from customer_receipts cr
        left join currencies curr on curr.id = cr.receipt_currency_id
        where ${receiptScope.join(" and ")}
        order by cr.receipt_date desc, cr.id desc
        limit 50
      `,
      params
    ),
    client.query(
      `
        select
          sr.id,
          sr.return_number,
          sr.credit_note_number,
          sr.return_date,
          sr.credit_note_amount,
          sr.customer_invoice_id,
          ci.invoice_number
        from sales_returns sr
        left join customer_invoices ci on ci.id = sr.customer_invoice_id
        where ${creditScope.join(" and ")}
        order by sr.return_date desc, sr.id desc
        limit 20
      `,
      params
    ),
    adjustmentsReady
      ? client.query(
          `
            select
              a.id,
              a.adjustment_type,
              a.adjustment_status,
              a.adjustment_amount,
              a.reason,
              a.remarks,
              a.customer_invoice_id,
              a.created_at,
              a.posted_at,
              ci.invoice_number
            from customer_ar_adjustments a
            left join customer_invoices ci on ci.id = a.customer_invoice_id
            where ${adjustScope.join(" and ")}
            order by coalesce(a.posted_at, a.created_at) desc, a.id desc
            limit 20
          `,
          params
        )
      : Promise.resolve({ rows: [] }),
    client.query(
      `
        with ledger_rows as (
          select
            ci.invoice_date as txn_date,
            'Invoice'::text as txn_type,
            ci.invoice_number as reference_no,
            ci.grand_total_invoice as debit,
            0::numeric as credit
          from customer_invoices ci
          where ${invoiceScope.join(" and ")}
          union all
          select
            cr.receipt_date as txn_date,
            'Receipt'::text as txn_type,
            cr.receipt_number as reference_no,
            0::numeric as debit,
            cr.receipt_amount_invoice as credit
          from customer_receipts cr
          where ${receiptScope.join(" and ")}
            and cr.receipt_status = 'posted'
          union all
          select
            sr.return_date as txn_date,
            'Credit Note'::text as txn_type,
            coalesce(sr.credit_note_number, sr.return_number) as reference_no,
            0::numeric as debit,
            sr.credit_note_amount as credit
          from sales_returns sr
          where ${creditScope.join(" and ")}
          ${adjustmentsReady ? `
          union all
          select
            a.posted_at::date as txn_date,
            'AR Adjustment'::text as txn_type,
            ('ARADJ-' || a.id::text) as reference_no,
            0::numeric as debit,
            a.adjustment_amount as credit
          from customer_ar_adjustments a
          where ${adjustScope.join(" and ")}
            and a.adjustment_status = 'posted'
          ` : ""}
        )
        select *
        from ledger_rows
        order by txn_date desc, reference_no desc
        limit 12
      `,
      params
    ),
    disputesReady
      ? client.query(
          `
            select
              d.id,
              d.dispute_status,
              d.dispute_reason,
              d.disputed_amount,
              d.expected_resolution_date,
              d.customer_invoice_id,
              ci.invoice_number
            from customer_collection_disputes d
            left join customer_invoices ci on ci.id = d.customer_invoice_id
            where ${disputeScope.join(" and ")}
              and d.dispute_status <> 'resolved'
            order by d.created_at desc, d.id desc
            limit 10
          `,
          params
        )
      : Promise.resolve({ rows: [] }),
    followupsReady
      ? client.query(
          `
            select
              a.id,
              a.expected_date,
              a.promised_amount,
              a.customer_invoice_id,
              a.remarks,
              ci.invoice_number
            from customer_collection_actions a
            left join customer_invoices ci on ci.id = a.customer_invoice_id
            where ${promiseScope.join(" and ")}
              and a.action_type = 'promise_to_pay'
            order by a.created_at desc, a.id desc
            limit 10
          `,
          params
        )
      : Promise.resolve({ rows: [] }),
  ];

  const [openInvoicesRes, receiptsRes, creditNotesRes, adjustmentsRes, ledgerRes, disputesRes, promisesRes] = await Promise.all(detailPromises);

  return {
    customer,
    open_invoices: (openInvoicesRes.rows || []).map((row) => ({
      ...row,
      allocated_invoice: money(row.allocated_invoice),
      credit_note_amount: money(row.credit_note_amount),
      adjustment_amount: money(row.adjustment_amount),
      outstanding_invoice: money(row.outstanding_invoice),
    })),
    receipts: (receiptsRes.rows || []).map((row) => ({
      ...row,
      receipt_amount_invoice: money(row.receipt_amount_invoice),
      allocated_amount_invoice: money(row.allocated_amount_invoice),
      unallocated_amount_invoice: money(row.unallocated_amount_invoice),
    })),
    credit_notes: (creditNotesRes.rows || []).map((row) => ({
      ...row,
      credit_note_amount: money(row.credit_note_amount),
    })),
    adjustments: (adjustmentsRes.rows || []).map((row) => ({
      ...row,
      adjustment_amount: money(row.adjustment_amount),
    })),
    ledger_preview: (ledgerRes.rows || []).map((row) => ({
      ...row,
      debit: money(row.debit),
      credit: money(row.credit),
    })),
    disputes: (disputesRes.rows || []).map((row) => ({
      ...row,
      disputed_amount: money(row.disputed_amount),
    })),
    promises: (promisesRes.rows || []).map((row) => ({
      ...row,
      promised_amount: money(row.promised_amount),
    })),
    readiness: {
      disputes_ready: disputesReady,
      followups_ready: followupsReady,
      adjustments_ready: adjustmentsReady,
    },
  };
}

router.get("/summary", async (req, res, next) => {
  try {
    if (!canViewReconciliation(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const rows = await getReconciliationCustomers(pool, {
      companyId: ctx.activeCompanyId,
      distributorId: ctx.distributorId,
      bucket: "all",
      limit: 1000,
    });

    const summary = rows.reduce(
      (acc, row) => {
        if (Number(row.unapplied_cash_amount || 0) > 0.0001) {
          acc.unapplied_cash_customers += 1;
          acc.unapplied_cash_amount += Number(row.unapplied_cash_amount || 0);
        }
        if (Number(row.partially_allocated_invoice_count || 0) > 0) {
          acc.partial_settlement_customers += 1;
          acc.partial_settlement_invoices += Number(row.partially_allocated_invoice_count || 0);
        }
        if (Number(row.unapplied_cash_amount || 0) > 0.0001 && Number(row.open_invoice_amount || 0) > 0.0001) {
          acc.matching_gap_customers += 1;
        }
        if (Number(row.unapplied_cash_amount || 0) > 0.0001 && Number(row.oldest_unapplied_days || 0) > 7) {
          acc.old_unapplied_customers += 1;
        }
        return acc;
      },
      {
        ready: true,
        unapplied_cash_customers: 0,
        unapplied_cash_amount: 0,
        partial_settlement_customers: 0,
        partial_settlement_invoices: 0,
        matching_gap_customers: 0,
        old_unapplied_customers: 0,
      }
    );
    summary.unapplied_cash_amount = money(summary.unapplied_cash_amount);
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/customers", async (req, res, next) => {
  try {
    if (!canViewReconciliation(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });

    const q = normalizeText(req.query.q);
    const bucket = normalizeText(req.query.bucket);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
    const rows = await getReconciliationCustomers(pool, {
      companyId: ctx.activeCompanyId,
      distributorId: ctx.distributorId,
      q,
      bucket,
      limit,
    });

    rows.sort((a, b) => {
      const gapDiff = Number(b.unapplied_cash_amount || 0) - Number(a.unapplied_cash_amount || 0);
      if (Math.abs(gapDiff) > 0.0001) return gapDiff;
      const openDiff = Number(b.open_invoice_amount || 0) - Number(a.open_invoice_amount || 0);
      if (Math.abs(openDiff) > 0.0001) return openDiff;
      return String(a.customer_name || "").localeCompare(String(b.customer_name || ""));
    });

    return res.json({ ok: true, customers: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/customers/:customerId/detail", async (req, res, next) => {
  try {
    if (!canViewReconciliation(req)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const ctx = await loadContextFilters(req);
    if (!ctx.ok) return res.status(400).json({ ok: false, error: ctx.error });
    const customerId = normalizeId(req.params.customerId);
    if (!customerId) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });

    const detail = await getReconciliationDetail(pool, {
      companyId: ctx.activeCompanyId,
      distributorId: ctx.distributorId,
      customerId,
    });
    if (!detail) return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });
    return res.json({ ok: true, detail });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
