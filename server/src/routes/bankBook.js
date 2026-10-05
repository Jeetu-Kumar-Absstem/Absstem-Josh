const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");

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

function normalizeLimit(value, fallback = 100, max = 300) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

async function getFinanceBookOrNull(client, companyId, bookId) {
  const r = await client.query(
    `
      select *
      from finance_books
      where id = $1 and company_id = $2
      limit 1
    `,
    [bookId, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getFinanceBookStatementData(client, companyId, bookId) {
  const book = await getFinanceBookOrNull(client, companyId, bookId);
  if (!book) return null;

  const [manualRes, receiptRes, paymentRes, manualEntriesRes] = await Promise.all([
    client.query(
      `
        select
          entry_date as txn_date,
          initcap(entry_type) as txn_type,
          entry_number as reference_no,
          coalesce(counterparty_name, 'Manual Entry') as description,
          case when entry_status = 'posted' and entry_type = 'receipt' then amount else 0 end as debit,
          case when entry_status = 'posted' and entry_type = 'payment' then amount else 0 end as credit
        from finance_book_entries
        where finance_book_id = $1 and company_id = $2
      `,
      [bookId, Number(companyId)]
    ),
    client.query(
      `
        select
          receipt_date as txn_date,
          'Customer Receipt'::text as txn_type,
          receipt_number as reference_no,
          coalesce(payment_mode, 'Customer Receipt') as description,
          receipt_amount_invoice as debit,
          0::numeric as credit
        from customer_receipts
        where finance_book_id = $1 and company_id = $2
          and receipt_status = 'posted'
      `,
      [bookId, Number(companyId)]
    ),
    client.query(
      `
        select
          payment_date as txn_date,
          'Vendor Payment'::text as txn_type,
          payment_number as reference_no,
          coalesce(payment_mode, 'Vendor Payment') as description,
          0::numeric as debit,
          coalesce(nullif(net_payment_amount, 0), payment_amount) as credit
        from vendor_payments
        where finance_book_id = $1 and company_id = $2
          and payment_status = 'posted'
      `,
      [bookId, Number(companyId)]
    ),
    client.query(
      `
        select *
        from finance_book_entries
        where finance_book_id = $1 and company_id = $2
        order by entry_date desc, id desc
      `,
      [bookId, Number(companyId)]
    ),
  ]);

  const rows = [...manualRes.rows, ...receiptRes.rows, ...paymentRes.rows]
    .map((row) => ({
      ...row,
      debit: money(row.debit),
      credit: money(row.credit),
    }))
    .sort((a, b) => {
      const aDate = new Date(a.txn_date || 0).getTime();
      const bDate = new Date(b.txn_date || 0).getTime();
      if (aDate !== bDate) return aDate - bDate;
      return String(a.reference_no || "").localeCompare(String(b.reference_no || ""));
    });

  let runningBalance = money(book.opening_balance);
  const statementRows = rows.map((row) => {
    runningBalance = money(runningBalance + qty(row.debit) - qty(row.credit));
    return {
      ...row,
      running_balance: runningBalance,
    };
  });

  return {
    book,
    statementRows,
    manual_entries: manualEntriesRes.rows,
    summary: {
      opening_balance: money(book.opening_balance),
      total_receipts: money(statementRows.reduce((sum, row) => sum + qty(row.debit), 0)),
      total_payments: money(statementRows.reduce((sum, row) => sum + qty(row.credit), 0)),
      closing_balance: money(statementRows.length ? statementRows[statementRows.length - 1].running_balance : book.opening_balance),
    },
  };
}

async function getBankReconciliationSummary(client, companyId) {
  const company = Number(companyId);

  const [unbookedReceiptsRes, unbookedPaymentsRes, draftEntriesRes, staleManualRes, negativeBooksRes, recentMovementsRes] = await Promise.all([
    client.query(
      `
        select
          count(*)::int as item_count,
          coalesce(sum(cr.receipt_amount_invoice), 0) as amount
        from customer_receipts cr
        where cr.company_id = $1
          and cr.receipt_status = 'posted'
          and cr.finance_book_id is null
      `,
      [company]
    ),
    client.query(
      `
        select
          count(*)::int as item_count,
          coalesce(sum(coalesce(nullif(vp.net_payment_amount, 0), vp.payment_amount)), 0) as amount
        from vendor_payments vp
        where vp.company_id = $1
          and vp.payment_status = 'posted'
          and vp.finance_book_id is null
      `,
      [company]
    ),
    client.query(
      `
        select
          count(*)::int as item_count,
          coalesce(sum(amount), 0) as amount
        from finance_book_entries
        where company_id = $1
          and entry_status = 'draft'
      `,
      [company]
    ),
    client.query(
      `
        select
          count(*)::int as item_count,
          coalesce(sum(amount), 0) as amount
        from finance_book_entries
        where company_id = $1
          and entry_status = 'posted'
          and entry_date <= current_date - interval '7 days'
      `,
      [company]
    ),
    client.query(
      `
        with manual_totals as (
          select
            finance_book_id,
            coalesce(sum(case when entry_status = 'posted' and entry_type = 'receipt' then amount else 0 end), 0) as manual_receipts,
            coalesce(sum(case when entry_status = 'posted' and entry_type = 'payment' then amount else 0 end), 0) as manual_payments
          from finance_book_entries
          where company_id = $1
          group by finance_book_id
        ),
        receipt_totals as (
          select
            finance_book_id,
            coalesce(sum(receipt_amount_invoice), 0) as receipt_total
          from customer_receipts
          where receipt_status = 'posted'
            and finance_book_id is not null
            and company_id = $1
          group by finance_book_id
        ),
        payment_totals as (
          select
            finance_book_id,
            coalesce(sum(coalesce(nullif(net_payment_amount, 0), payment_amount)), 0) as payment_total
          from vendor_payments
          where payment_status = 'posted'
            and finance_book_id is not null
            and company_id = $1
          group by finance_book_id
        ),
        closing_rows as (
          select
            fb.id,
            (fb.opening_balance + coalesce(mt.manual_receipts, 0) + coalesce(rt.receipt_total, 0) - coalesce(mt.manual_payments, 0) - coalesce(pt.payment_total, 0)) as closing_balance
          from finance_books fb
          left join manual_totals mt on mt.finance_book_id = fb.id
          left join receipt_totals rt on rt.finance_book_id = fb.id
          left join payment_totals pt on pt.finance_book_id = fb.id
          where fb.company_id = $1
        )
        select
          count(*) filter (where closing_balance < 0)::int as item_count,
          coalesce(sum(case when closing_balance < 0 then abs(closing_balance) else 0 end), 0) as amount
        from closing_rows
      `,
      [company]
    ),
    client.query(
      `
        with recent_txns as (
          select
            cr.finance_book_id,
            cr.receipt_date as txn_date,
            cr.receipt_amount_invoice as amount
          from customer_receipts cr
          where cr.company_id = $1
            and cr.receipt_status = 'posted'
            and cr.finance_book_id is not null
            and cr.receipt_date >= current_date - interval '5 days'

          union all

          select
            vp.finance_book_id,
            vp.payment_date as txn_date,
            coalesce(nullif(vp.net_payment_amount, 0), vp.payment_amount) as amount
          from vendor_payments vp
          where vp.company_id = $1
            and vp.payment_status = 'posted'
            and vp.finance_book_id is not null
            and vp.payment_date >= current_date - interval '5 days'

          union all

          select
            fbe.finance_book_id,
            fbe.entry_date as txn_date,
            fbe.amount
          from finance_book_entries fbe
          where fbe.company_id = $1
            and fbe.entry_status = 'posted'
            and fbe.entry_date >= current_date - interval '5 days'
        )
        select
          count(distinct finance_book_id)::int as book_count,
          count(*)::int as item_count,
          coalesce(sum(amount), 0) as amount
        from recent_txns
      `,
      [company]
    ),
  ]);

  const unbookedReceipts = unbookedReceiptsRes.rows[0] || {};
  const unbookedPayments = unbookedPaymentsRes.rows[0] || {};
  const draftEntries = draftEntriesRes.rows[0] || {};
  const staleManual = staleManualRes.rows[0] || {};
  const negativeBooks = negativeBooksRes.rows[0] || {};
  const recentMovements = recentMovementsRes.rows[0] || {};

  return {
    unbooked_receipts_count: Number(unbookedReceipts.item_count || 0),
    unbooked_receipts_amount: money(unbookedReceipts.amount),
    unbooked_payments_count: Number(unbookedPayments.item_count || 0),
    unbooked_payments_amount: money(unbookedPayments.amount),
    draft_entry_count: Number(draftEntries.item_count || 0),
    draft_entry_amount: money(draftEntries.amount),
    stale_manual_count: Number(staleManual.item_count || 0),
    stale_manual_amount: money(staleManual.amount),
    negative_book_count: Number(negativeBooks.item_count || 0),
    negative_book_amount: money(negativeBooks.amount),
    recent_movement_book_count: Number(recentMovements.book_count || 0),
    recent_movement_count: Number(recentMovements.item_count || 0),
    recent_movement_amount: money(recentMovements.amount),
  };
}

async function getBankReconciliationQueue(client, companyId, { bucket = "unbooked_receipts", q = "", limit = 120 } = {}) {
  const company = Number(companyId);
  const normalizedBucket = normalizeText(bucket).toLowerCase() || "unbooked_receipts";
  const normalizedQuery = normalizeText(q);
  const normalizedLimit = normalizeLimit(limit, 120, 300);

  if (normalizedBucket === "unbooked_receipts") {
    const params = [company];
    const where = [`cr.company_id = $1`, `cr.receipt_status = 'posted'`, `cr.finance_book_id is null`];
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(cr.receipt_number ilike $${params.length} or c.customer_name ilike $${params.length} or coalesce(cr.payment_mode, '') ilike $${params.length})`);
    }
    const r = await client.query(
      `
        select
          cr.id,
          cr.receipt_number,
          cr.receipt_date,
          cr.payment_mode,
          cr.receipt_amount_invoice,
          cr.unallocated_amount_invoice,
          c.customer_name,
          curr.currency_code as receipt_currency_code
        from customer_receipts cr
        join customers c on c.id = cr.customer_id
        left join currencies curr on curr.id = cr.receipt_currency_id
        where ${where.join(" and ")}
        order by cr.receipt_date asc, cr.id asc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      bucket: normalizedBucket,
      queue_type: "receipts",
      rows: r.rows.map((row) => ({
        ...row,
        receipt_amount_invoice: money(row.receipt_amount_invoice),
        unallocated_amount_invoice: money(row.unallocated_amount_invoice),
      })),
    };
  }

  if (normalizedBucket === "unbooked_payments") {
    const params = [company];
    const where = [`vp.company_id = $1`, `vp.payment_status = 'posted'`, `vp.finance_book_id is null`];
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(vp.payment_number ilike $${params.length} or v.company_name ilike $${params.length} or coalesce(vp.payment_mode, '') ilike $${params.length})`);
    }
    const r = await client.query(
      `
        select
          vp.id,
          vp.payment_number,
          vp.payment_date,
          vp.payment_mode,
          vp.payment_amount,
          vp.net_payment_amount,
          vp.tds_amount,
          v.company_name as vendor_name,
          curr.currency_code as payment_currency_code
        from vendor_payments vp
        join vendors v on v.id = vp.vendor_id
        left join currencies curr on curr.id = vp.payment_currency_id
        where ${where.join(" and ")}
        order by vp.payment_date asc, vp.id asc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      bucket: normalizedBucket,
      queue_type: "payments",
      rows: r.rows.map((row) => ({
        ...row,
        payment_amount: money(row.payment_amount),
        net_payment_amount: money(row.net_payment_amount),
        tds_amount: money(row.tds_amount),
      })),
    };
  }

  if (normalizedBucket === "draft_entries" || normalizedBucket === "stale_manual") {
    const params = [company];
    const where = [`fbe.company_id = $1`];
    if (normalizedBucket === "draft_entries") {
      where.push(`fbe.entry_status = 'draft'`);
    } else {
      where.push(`fbe.entry_status = 'posted'`);
      where.push(`fbe.entry_date <= current_date - interval '7 days'`);
    }
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      where.push(`(fbe.entry_number ilike $${params.length} or fb.book_name ilike $${params.length} or coalesce(fbe.counterparty_name, '') ilike $${params.length} or coalesce(fbe.reference_no, '') ilike $${params.length})`);
    }
    const r = await client.query(
      `
        select
          fbe.id,
          fbe.finance_book_id,
          fbe.entry_number,
          fbe.entry_status,
          fbe.entry_date,
          fbe.entry_type,
          fbe.amount,
          fbe.counterparty_name,
          fbe.reference_no,
          fbe.remarks,
          fb.book_name,
          fb.book_type
        from finance_book_entries fbe
        join finance_books fb on fb.id = fbe.finance_book_id
        where ${where.join(" and ")}
        order by fbe.entry_date asc, fbe.id asc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      bucket: normalizedBucket,
      queue_type: "entries",
      rows: r.rows.map((row) => ({
        ...row,
        amount: money(row.amount),
      })),
    };
  }

  if (normalizedBucket === "negative_books") {
    const params = [company];
    let filter = `closing_balance < 0`;
    if (normalizedQuery) {
      params.push(`%${normalizedQuery}%`);
      filter += ` and (book_name ilike $${params.length} or coalesce(book_code, '') ilike $${params.length} or coalesce(bank_name, '') ilike $${params.length})`;
    }
    const r = await client.query(
      `
        with manual_totals as (
          select
            finance_book_id,
            coalesce(sum(case when entry_status = 'posted' and entry_type = 'receipt' then amount else 0 end), 0) as manual_receipts,
            coalesce(sum(case when entry_status = 'posted' and entry_type = 'payment' then amount else 0 end), 0) as manual_payments
          from finance_book_entries
          where company_id = $1
          group by finance_book_id
        ),
        receipt_totals as (
          select
            finance_book_id,
            coalesce(sum(receipt_amount_invoice), 0) as receipt_total,
            max(receipt_date) as last_receipt_date
          from customer_receipts
          where receipt_status = 'posted'
            and finance_book_id is not null
            and company_id = $1
          group by finance_book_id
        ),
        payment_totals as (
          select
            finance_book_id,
            coalesce(sum(coalesce(nullif(net_payment_amount, 0), payment_amount)), 0) as payment_total,
            max(payment_date) as last_payment_date
          from vendor_payments
          where payment_status = 'posted'
            and finance_book_id is not null
            and company_id = $1
          group by finance_book_id
        ),
        manual_dates as (
          select
            finance_book_id,
            max(entry_date) as last_manual_date
          from finance_book_entries
          where company_id = $1
            and entry_status = 'posted'
          group by finance_book_id
        ),
        closing_rows as (
          select
            fb.id as book_id,
            fb.book_code,
            fb.book_name,
            fb.book_type,
            fb.bank_name,
            fb.opening_balance,
            coalesce(mt.manual_receipts, 0) + coalesce(rt.receipt_total, 0) as total_receipts,
            coalesce(mt.manual_payments, 0) + coalesce(pt.payment_total, 0) as total_payments,
            (fb.opening_balance + coalesce(mt.manual_receipts, 0) + coalesce(rt.receipt_total, 0) - coalesce(mt.manual_payments, 0) - coalesce(pt.payment_total, 0)) as closing_balance,
            greatest(coalesce(rt.last_receipt_date, date '1900-01-01'), coalesce(pt.last_payment_date, date '1900-01-01'), coalesce(md.last_manual_date, date '1900-01-01')) as last_txn_date
          from finance_books fb
          left join manual_totals mt on mt.finance_book_id = fb.id
          left join receipt_totals rt on rt.finance_book_id = fb.id
          left join payment_totals pt on pt.finance_book_id = fb.id
          left join manual_dates md on md.finance_book_id = fb.id
          where fb.company_id = $1
        )
        select *
        from closing_rows
        where ${filter}
        order by closing_balance asc, book_name asc
        limit ${normalizedLimit}
      `,
      params
    );
    return {
      bucket: normalizedBucket,
      queue_type: "books",
      rows: r.rows.map((row) => ({
        ...row,
        opening_balance: money(row.opening_balance),
        total_receipts: money(row.total_receipts),
        total_payments: money(row.total_payments),
        closing_balance: money(row.closing_balance),
      })),
    };
  }

  const params = [company];
  let searchWhere = "";
  if (normalizedQuery) {
    params.push(`%${normalizedQuery}%`);
    searchWhere = `where fb.book_name ilike $${params.length} or coalesce(fb.book_code, '') ilike $${params.length} or coalesce(fb.bank_name, '') ilike $${params.length}`;
  }
  const r = await client.query(
    `
      with recent_txns as (
        select
          cr.finance_book_id,
          cr.receipt_date as txn_date,
          'Customer Receipt'::text as source_type,
          cr.receipt_amount_invoice as amount
        from customer_receipts cr
        where cr.company_id = $1
          and cr.receipt_status = 'posted'
          and cr.finance_book_id is not null
          and cr.receipt_date >= current_date - interval '5 days'

        union all

        select
          vp.finance_book_id,
          vp.payment_date as txn_date,
          'Vendor Payment'::text as source_type,
          coalesce(nullif(vp.net_payment_amount, 0), vp.payment_amount) as amount
        from vendor_payments vp
        where vp.company_id = $1
          and vp.payment_status = 'posted'
          and vp.finance_book_id is not null
          and vp.payment_date >= current_date - interval '5 days'

        union all

        select
          fbe.finance_book_id,
          fbe.entry_date as txn_date,
          'Manual Entry'::text as source_type,
          fbe.amount
        from finance_book_entries fbe
        where fbe.company_id = $1
          and fbe.entry_status = 'posted'
          and fbe.entry_date >= current_date - interval '5 days'
      ),
      manual_totals as (
        select
          finance_book_id,
          coalesce(sum(case when entry_status = 'posted' and entry_type = 'receipt' then amount else 0 end), 0) as manual_receipts,
          coalesce(sum(case when entry_status = 'posted' and entry_type = 'payment' then amount else 0 end), 0) as manual_payments
        from finance_book_entries
        where company_id = $1
        group by finance_book_id
      ),
      receipt_totals as (
        select
          finance_book_id,
          coalesce(sum(receipt_amount_invoice), 0) as receipt_total
        from customer_receipts
        where receipt_status = 'posted'
          and finance_book_id is not null
          and company_id = $1
        group by finance_book_id
      ),
      payment_totals as (
        select
          finance_book_id,
          coalesce(sum(coalesce(nullif(net_payment_amount, 0), payment_amount)), 0) as payment_total
        from vendor_payments
        where payment_status = 'posted'
          and finance_book_id is not null
          and company_id = $1
        group by finance_book_id
      )
      select
        fb.id as book_id,
        fb.book_code,
        fb.book_name,
        fb.book_type,
        fb.bank_name,
        count(rt.*)::int as recent_txn_count,
        coalesce(sum(case when rt.source_type = 'Customer Receipt' then rt.amount else 0 end), 0) as recent_receipts_amount,
        coalesce(sum(case when rt.source_type = 'Vendor Payment' then rt.amount else 0 end), 0) as recent_payments_amount,
        count(*) filter (where rt.source_type = 'Manual Entry')::int as recent_manual_count,
        max(rt.txn_date) as last_txn_date,
        (fb.opening_balance + coalesce(mt.manual_receipts, 0) + coalesce(rc.receipt_total, 0) - coalesce(mt.manual_payments, 0) - coalesce(pt.payment_total, 0)) as closing_balance
      from finance_books fb
      join recent_txns rt on rt.finance_book_id = fb.id
      left join manual_totals mt on mt.finance_book_id = fb.id
      left join receipt_totals rc on rc.finance_book_id = fb.id
      left join payment_totals pt on pt.finance_book_id = fb.id
      ${searchWhere}
      group by fb.id, mt.manual_receipts, mt.manual_payments, rc.receipt_total, pt.payment_total
      order by max(rt.txn_date) desc, fb.book_name asc
      limit ${normalizedLimit}
    `,
    params
  );
  return {
    bucket: normalizedBucket,
    queue_type: "books",
    rows: r.rows.map((row) => ({
      ...row,
      recent_receipts_amount: money(row.recent_receipts_amount),
      recent_payments_amount: money(row.recent_payments_amount),
      closing_balance: money(row.closing_balance),
    })),
  };
}

router.get("/bootstrap", requireScreenAction("bank_book", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const r = await pool.query(
      `
        select *
        from finance_books
        where company_id = $1
        order by book_type asc, book_name asc, id asc
      `,
      [companyId]
    );
    return res.json({ ok: true, books: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/reconciliation-summary", requireScreenAction("bank_book", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const summary = await getBankReconciliationSummary(pool, companyId);
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/reconciliation-queue", requireScreenAction("bank_book", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const queue = await getBankReconciliationQueue(pool, companyId, {
      bucket: req.query.bucket,
      q: req.query.q,
      limit: req.query.limit,
    });
    return res.json({ ok: true, ...queue });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("bank_book", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const r = await pool.query(
      `
        with manual_totals as (
          select
            finance_book_id,
            coalesce(sum(case when entry_status = 'posted' and entry_type = 'receipt' then amount else 0 end), 0) as manual_receipts,
            coalesce(sum(case when entry_status = 'posted' and entry_type = 'payment' then amount else 0 end), 0) as manual_payments
          from finance_book_entries
          where company_id = $1
          group by finance_book_id
        ),
        receipt_totals as (
          select
            finance_book_id,
            coalesce(sum(receipt_amount_invoice), 0) as receipt_total
          from customer_receipts
          where receipt_status = 'posted'
            and finance_book_id is not null
            and company_id = $1
          group by finance_book_id
        ),
        payment_totals as (
          select
            finance_book_id,
            coalesce(sum(coalesce(nullif(net_payment_amount, 0), payment_amount)), 0) as payment_total
          from vendor_payments
          where payment_status = 'posted'
            and finance_book_id is not null
            and company_id = $1
          group by finance_book_id
        )
        select
          fb.*,
          coalesce(mt.manual_receipts, 0) + coalesce(rt.receipt_total, 0) as total_receipts,
          coalesce(mt.manual_payments, 0) + coalesce(pt.payment_total, 0) as total_payments,
          (fb.opening_balance + coalesce(mt.manual_receipts, 0) + coalesce(rt.receipt_total, 0) - coalesce(mt.manual_payments, 0) - coalesce(pt.payment_total, 0)) as closing_balance
        from finance_books fb
        left join manual_totals mt on mt.finance_book_id = fb.id
        left join receipt_totals rt on rt.finance_book_id = fb.id
        left join payment_totals pt on pt.finance_book_id = fb.id
        where fb.company_id = $1
        order by fb.book_type asc, fb.book_name asc, fb.id asc
      `,
      [companyId]
    );
    return res.json({ ok: true, books: r.rows.map((row) => ({ ...row, closing_balance: money(row.closing_balance) })) });
  } catch (err) {
    return next(err);
  }
});

router.post("/books", requireScreenAction("bank_book", "can_create"), async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const bookName = String(body.book_name || "").trim();
    const bookType = String(body.book_type || "bank").trim().toLowerCase();
    if (!bookName) return res.status(400).json({ ok: false, error: "BOOK_NAME_REQUIRED" });
    if (!["bank", "cash"].includes(bookType)) return res.status(400).json({ ok: false, error: "INVALID_BOOK_TYPE" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const r = await pool.query(
      `
        insert into finance_books (
          company_id,
          book_code,
          book_name,
          book_type,
          opening_balance,
          account_name,
          account_no,
          ifsc,
          bank_name,
          branch_name,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
        returning *
      `,
      [
        companyId,
        body.book_code || null,
        bookName,
        bookType,
        money(body.opening_balance),
        body.account_name || null,
        body.account_no || null,
        body.ifsc || null,
        body.bank_name || null,
        body.branch_name || null,
        body.is_active !== false,
      ]
    );
    return res.status(201).json({ ok: true, book: r.rows[0] });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_BOOK" });
    return next(err);
  }
});

router.put("/books/:id", requireScreenAction("bank_book", "can_edit"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const bookName = String(body.book_name || "").trim();
    const bookType = String(body.book_type || "bank").trim().toLowerCase();
    if (!bookName) return res.status(400).json({ ok: false, error: "BOOK_NAME_REQUIRED" });
    if (!["bank", "cash"].includes(bookType)) return res.status(400).json({ ok: false, error: "INVALID_BOOK_TYPE" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const r = await pool.query(
      `
        update finance_books
        set book_code = $1,
            book_name = $2,
            book_type = $3,
            opening_balance = $4,
            account_name = $5,
            account_no = $6,
            ifsc = $7,
            bank_name = $8,
            branch_name = $9,
            is_active = $10,
            updated_at = now()
        where id = $11 and company_id = $12
        returning *
      `,
      [
        body.book_code || null,
        bookName,
        bookType,
        money(body.opening_balance),
        body.account_name || null,
        body.account_no || null,
        body.ifsc || null,
        body.bank_name || null,
        body.branch_name || null,
        body.is_active !== false,
        id,
        companyId,
      ]
    );
    const book = r.rows[0] || null;
    if (!book) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, book });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_BOOK" });
    return next(err);
  }
});

router.get("/book/:id", requireScreenAction("bank_book", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const data = await getFinanceBookStatementData(pool, companyId, id);
    if (!data) return res.status(404).json({ ok: false });
    return res.json({ ok: true, ...data });
  } catch (err) {
    return next(err);
  }
});

router.post("/entries", requireScreenAction("bank_book", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const financeBookId = Number(body.finance_book_id);
    if (!Number.isFinite(financeBookId) || financeBookId <= 0) return res.status(400).json({ ok: false, error: "INVALID_BOOK" });
    const amount = money(body.amount);
    const entryType = String(body.entry_type || "receipt").trim().toLowerCase();
    if (!["receipt", "payment"].includes(entryType)) return res.status(400).json({ ok: false, error: "INVALID_ENTRY_TYPE" });
    if (amount < 0) return res.status(400).json({ ok: false, error: "INVALID_AMOUNT" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const book = await getFinanceBookOrNull(client, companyId, financeBookId);
    if (!book) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "BOOK_NOT_FOUND" });
    }
    const numRes = await client.query(`select next_company_document_number($1,'BKV') as entry_number`, [companyId]);
    const r = await client.query(
      `
        insert into finance_book_entries (
          company_id,
          finance_book_id,
          entry_number,
          entry_status,
          entry_date,
          entry_type,
          amount,
          counterparty_name,
          reference_no,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,coalesce($5,current_date),$6,$7,$8,$9,$10,$11)
        returning *
      `,
      [
        companyId,
        financeBookId,
        numRes.rows[0]?.entry_number,
        String(body.entry_status || "draft").trim().toLowerCase(),
        body.entry_date || null,
        entryType,
        amount,
        body.counterparty_name || null,
        body.reference_no || null,
        body.remarks || null,
        req.user.id,
      ]
    );
    await client.query("commit");
    return res.status(201).json({ ok: true, entry: r.rows[0] });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/entries/:id", requireScreenAction("bank_book", "can_edit"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const amount = money(body.amount);
    const entryType = String(body.entry_type || "receipt").trim().toLowerCase();
    const entryStatus = String(body.entry_status || "draft").trim().toLowerCase();
    if (!["receipt", "payment"].includes(entryType)) return res.status(400).json({ ok: false, error: "INVALID_ENTRY_TYPE" });
    if (!["draft", "posted", "cancelled"].includes(entryStatus)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    if (amount < 0) return res.status(400).json({ ok: false, error: "INVALID_AMOUNT" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const r = await pool.query(
      `
        update finance_book_entries
        set entry_status = $1,
            entry_date = coalesce($2, entry_date),
            entry_type = $3,
            amount = $4,
            counterparty_name = $5,
            reference_no = $6,
            remarks = $7,
            updated_at = now()
        where id = $8 and company_id = $9
        returning *
      `,
      [entryStatus, body.entry_date || null, entryType, amount, body.counterparty_name || null, body.reference_no || null, body.remarks || null, id, companyId]
    );
    const entry = r.rows[0] || null;
    if (!entry) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, entry });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
