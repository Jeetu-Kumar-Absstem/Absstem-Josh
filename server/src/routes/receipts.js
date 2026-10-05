const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, requireResolvedCompanyId } = require("../services/companyContext");
const { ensureCustomerCompanyAccess } = require("../services/customerCompanyAccess");
const { getDistributorIdForUser } = require("../services/mailAccounts");
const { generateQuotePdfBuffer } = require("../pdf/quotePdf");
const { renderCustomerStatementHtml, renderReceiptHtml } = require("../pdf/receiptPdf");
const { enrichCompanyProfileAssets, getCompanyProfile } = require("../services/companyProfile");
const { money2 } = require("../services/tally/money");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const money = money2;

function safeFileSegment(value) {
  return String(value || "document")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function canAccessReceipt(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "receipts")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

function canAccessInvoice(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "invoices")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function isArAdjustmentsReady(client = pool) {
  const r = await client.query(`select to_regclass('public.customer_ar_adjustments') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

async function getInvoiceHeaderOrNull(client, invoiceId, distributorId = null, companyId = null) {
  const params = [Number(invoiceId)];
  const distributorFilter =
    Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? ` and ci.distributor_id = $2` : "";
  if (distributorFilter) params.push(Number(distributorId));
  const companyFilter =
    Number.isFinite(Number(companyId)) && Number(companyId) > 0 ? ` and ci.company_id = $${params.length + 1}` : "";
  if (companyFilter) params.push(Number(companyId));
  const r = await client.query(
    `
      select
        ci.*,
        c.customer_name,
        c.customer_code,
        c.gstin as customer_gstin,
        so.so_number,
        pt.credit_days,
        curr.currency_code as invoice_currency_code
      from customer_invoices ci
      join customers c on c.id = ci.customer_id
      left join sales_orders so on so.id = ci.sales_order_id
      left join payment_terms pt on pt.id = so.payment_term_id
      left join currencies curr on curr.id = ci.invoice_currency_id
      where ci.id = $1
      ${distributorFilter}
      ${companyFilter}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

async function getInvoiceOutstandingMap(client, { customerId = null, distributorId = null, currencyId = null, companyId = null, excludeReceiptId = null } = {}) {
  const adjustmentsReady = await isArAdjustmentsReady(client);
  const params = [];
  const where = [];
  if (Number.isFinite(Number(customerId)) && Number(customerId) > 0) {
    params.push(Number(customerId));
    where.push(`ci.customer_id = $${params.length}`);
  }
  if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
    params.push(Number(distributorId));
    where.push(`ci.distributor_id = $${params.length}`);
  }
  if (Number.isFinite(Number(currencyId)) && Number(currencyId) > 0) {
    params.push(Number(currencyId));
    where.push(`ci.invoice_currency_id = $${params.length}`);
  }
  if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    where.push(`ci.company_id = $${params.length}`);
  }
  params.push(Number(excludeReceiptId || 0));
  const r = await client.query(
    `
      select
        ci.id as customer_invoice_id,
        ci.customer_id,
        ci.invoice_number,
        ci.invoice_date,
        ci.invoice_status,
        ci.invoice_currency_id,
        ci.grand_total_base,
        ci.grand_total_invoice,
        coalesce(sum(case when cr.receipt_status = 'posted' and cr.id <> $${params.length} then cra.allocated_base else 0 end), 0) as allocated_base,
        coalesce(sum(case when cr.receipt_status = 'posted' and cr.id <> $${params.length} then cra.allocated_invoice else 0 end), 0) as allocated_invoice,
        coalesce((
          select sum(sr.credit_note_amount)
          from sales_returns sr
          where sr.customer_invoice_id = ci.id
            and sr.return_status = 'posted'
        ), 0) as credit_note_amount
        ${
          adjustmentsReady
            ? `,
        coalesce((
          select sum(adj.adjustment_amount)
          from customer_ar_adjustments adj
          where adj.customer_invoice_id = ci.id
            and adj.adjustment_status = 'posted'
        ), 0) as adjustment_amount`
            : `,
        0::numeric as adjustment_amount`
        }
      from customer_invoices ci
      left join customer_receipt_allocations cra on cra.customer_invoice_id = ci.id
      left join customer_receipts cr on cr.id = cra.customer_receipt_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      group by ci.id
    `,
    params
  );
  return new Map(
    r.rows.map((row) => [
      Number(row.customer_invoice_id),
      (() => {
        const ratio = qty(row.grand_total_invoice) > 0 ? qty(row.grand_total_base) / qty(row.grand_total_invoice) : 1;
        const creditAndAdjustments = qty(row.credit_note_amount) + qty(row.adjustment_amount);
        return {
          allocated_base: money(row.allocated_base),
          allocated_invoice: money(row.allocated_invoice),
          outstanding_base: money(qty(row.grand_total_base) - qty(row.allocated_base) - creditAndAdjustments * ratio),
          credit_note_amount: money(row.credit_note_amount),
          adjustment_amount: money(row.adjustment_amount),
          outstanding_invoice: money(qty(row.grand_total_invoice) - qty(row.allocated_invoice) - creditAndAdjustments),
        };
      })(),
    ])
  );
}

async function getReceiptHeaderOrNull(client, receiptId, distributorId = null, companyId = null) {
  const params = [Number(receiptId)];
  const distributorFilter =
    Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? ` and cr.distributor_id = $2` : "";
  if (distributorFilter) params.push(Number(distributorId));
  const companyFilter =
    Number.isFinite(Number(companyId)) && Number(companyId) > 0 ? ` and cr.company_id = $${params.length + 1}` : "";
  if (companyFilter) params.push(Number(companyId));
  const r = await client.query(
    `
      select
        cr.*,
        c.customer_name,
        c.customer_code,
        curr.currency_code as receipt_currency_code,
        fb.book_name as finance_book_name
      from customer_receipts cr
      join customers c on c.id = cr.customer_id
      left join currencies curr on curr.id = cr.receipt_currency_id
      left join finance_books fb on fb.id = cr.finance_book_id and fb.company_id = cr.company_id
      where cr.id = $1
      ${distributorFilter}
      ${companyFilter}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

async function getCustomerHeaderOrNull(client, customerId, distributorId = null) {
  const params = [Number(customerId)];
  const distributorFilter =
    Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? ` and c.distributor_id = $2` : "";
  if (distributorFilter) params.push(Number(distributorId));
  const r = await client.query(
    `
      select
        c.id,
        c.customer_name,
        c.customer_code,
        curr.currency_code
      from customers c
      left join currencies curr on curr.id = c.order_currency_id
      where c.id = $1
      ${distributorFilter}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

async function getReceiptAllocations(client, receiptId, excludeReceiptId = null) {
  const [allocRes, outstandingMap] = await Promise.all([
    client.query(
      `
        select
          cra.*,
          ci.invoice_number,
          ci.invoice_date,
          ci.grand_total_invoice,
          ci.invoice_status,
          curr.currency_code as invoice_currency_code,
          (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date as due_date
        from customer_receipt_allocations cra
        join customer_invoices ci on ci.id = cra.customer_invoice_id
        left join sales_orders so on so.id = ci.sales_order_id
        left join payment_terms pt on pt.id = so.payment_term_id
        left join currencies curr on curr.id = ci.invoice_currency_id
        where cra.customer_receipt_id = $1
        order by ci.invoice_date asc, ci.id asc
      `,
      [receiptId]
    ),
    getInvoiceOutstandingMap(client, { excludeReceiptId })
  ]);

  return allocRes.rows.map((row) => {
    const outstanding = outstandingMap.get(Number(row.customer_invoice_id)) || {
      allocated_invoice: 0,
      outstanding_invoice: qty(row.grand_total_invoice),
    };
    return {
      ...row,
      invoice_total_invoice: qty(row.grand_total_invoice),
      invoice_allocated_before_current: money(outstanding.allocated_invoice),
      invoice_outstanding_before_current: money(outstanding.outstanding_invoice),
      invoice_outstanding_after_current: money(outstanding.outstanding_invoice - qty(row.allocated_invoice)),
    };
  });
}

async function getOpenInvoicesForCustomer(client, { customerId, distributorId = null, currencyId = null, companyId = null, excludeReceiptId = null }) {
  const outstandingMap = await getInvoiceOutstandingMap(client, {
    customerId,
    distributorId,
    currencyId,
    companyId,
    excludeReceiptId,
  });
  const params = [Number(customerId)];
  let distributorFilter = "";
  let currencyFilter = "";
  if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
    params.push(Number(distributorId));
    distributorFilter = ` and ci.distributor_id = $${params.length}`;
  }
  if (Number.isFinite(Number(currencyId)) && Number(currencyId) > 0) {
    params.push(Number(currencyId));
    currencyFilter = ` and ci.invoice_currency_id = $${params.length}`;
  }
  let companyFilter = "";
  if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    companyFilter = ` and ci.company_id = $${params.length}`;
  }
  const r = await client.query(
    `
      select
        ci.id,
        ci.invoice_number,
        ci.invoice_date,
        ci.invoice_status,
        ci.grand_total_invoice,
        curr.currency_code as invoice_currency_code,
        pt.credit_days,
        (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date as due_date
      from customer_invoices ci
      left join sales_orders so on so.id = ci.sales_order_id
      left join payment_terms pt on pt.id = so.payment_term_id
      left join currencies curr on curr.id = ci.invoice_currency_id
      where ci.customer_id = $1
        and ci.invoice_status <> 'cancelled'
        ${distributorFilter}
        ${currencyFilter}
        ${companyFilter}
      order by ci.invoice_date asc, ci.id asc
    `,
    params
  );
  return r.rows
    .map((row) => {
      const outstanding = outstandingMap.get(Number(row.id)) || {
        allocated_invoice: 0,
        outstanding_invoice: qty(row.grand_total_invoice),
      };
      return {
        ...row,
        amount_received_invoice: money(outstanding.allocated_invoice),
        outstanding_invoice: money(outstanding.outstanding_invoice),
      };
    })
    .filter((row) => qty(row.outstanding_invoice) > 0.0001);
}

function calculateReceiptTotals(receiptAmountBase, receiptAmountInvoice, allocations) {
  const allocatedBase = money(allocations.reduce((sum, row) => sum + qty(row.allocated_base), 0));
  const allocatedInvoice = money(allocations.reduce((sum, row) => sum + qty(row.allocated_invoice), 0));
  return {
    allocated_amount_base: allocatedBase,
    allocated_amount_invoice: allocatedInvoice,
    unallocated_amount_base: money(qty(receiptAmountBase) - allocatedBase),
    unallocated_amount_invoice: money(qty(receiptAmountInvoice) - allocatedInvoice),
  };
}

/**
 * Keep customer_invoices.invoice_status aligned with computed outstanding after receipt post/cancel.
 * draft/cancelled invoices are left untouched.
 */
async function syncCustomerInvoicePaidStatus(client, invoiceIds, { companyId = null, excludeReceiptId = null } = {}) {
  const ids = [...new Set((invoiceIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return;

  const headerRes = await client.query(
    `
      select id, invoice_status, company_id
      from customer_invoices
      where id = any($1::int[])
    `,
    [ids]
  );
  const headers = headerRes.rows.filter((row) => {
    if (Number.isFinite(Number(companyId)) && Number(companyId) > 0 && Number(row.company_id) !== Number(companyId)) {
      return false;
    }
    const status = String(row.invoice_status || "").toLowerCase();
    return status !== "draft" && status !== "cancelled";
  });
  if (!headers.length) return;

  const scopedCompanyId = Number.isFinite(Number(companyId)) && Number(companyId) > 0 ? Number(companyId) : Number(headers[0].company_id);
  const outstandingMap = await getInvoiceOutstandingMap(client, {
    companyId: scopedCompanyId,
    excludeReceiptId,
  });

  for (const header of headers) {
    const invoiceId = Number(header.id);
    const row = outstandingMap.get(invoiceId);
    if (!row) continue;
    const currentStatus = String(header.invoice_status || "").toLowerCase();
    const outstanding = qty(row.outstanding_invoice);
    const nextStatus = outstanding <= 0.0001 ? "paid" : currentStatus === "paid" ? "issued" : currentStatus;
    if (nextStatus === currentStatus) continue;

    await client.query(
      `
        update customer_invoices
        set invoice_status = $2,
            updated_at = now()
        where id = $1
          and invoice_status not in ('draft', 'cancelled')
      `,
      [invoiceId, nextStatus]
    );
  }
}

async function getAgeingSummary(client, distributorId = null, companyId = null) {
  const adjustmentsReady = await isArAdjustmentsReady(client);
  const params = [];
  const where = [`ci.invoice_status <> 'cancelled'`];
  if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
    params.push(Number(distributorId));
    where.push(`ci.distributor_id = $${params.length}`);
  }
  if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    where.push(`ci.company_id = $${params.length}`);
  }
  const r = await client.query(
    `
      with posted_receipts as (
        select
          cra.customer_invoice_id,
          coalesce(sum(cra.allocated_invoice), 0) as allocated_invoice
        from customer_receipt_allocations cra
        join customer_receipts cr on cr.id = cra.customer_receipt_id
        where cr.receipt_status = 'posted'
        group by cra.customer_invoice_id
      ),
      invoice_ageing as (
        select
          ci.id,
          ci.customer_id,
          c.customer_name,
          ci.invoice_number,
          ci.customer_po_number,
          ci.customer_po_date,
          ci.invoice_date,
          curr.currency_code as invoice_currency_code,
          ci.grand_total_invoice,
          coalesce(pr.allocated_invoice, 0) as allocated_invoice,
          coalesce((
            select sum(sr.credit_note_amount)
            from sales_returns sr
            where sr.customer_invoice_id = ci.id
              and sr.return_status = 'posted'
          ), 0) as credit_note_amount,
          ${
            adjustmentsReady
              ? `coalesce((
            select sum(adj.adjustment_amount)
            from customer_ar_adjustments adj
            where adj.customer_invoice_id = ci.id
              and adj.adjustment_status = 'posted'
          ), 0) as adjustment_amount,`
              : `0::numeric as adjustment_amount,`
          }
          (
            ci.grand_total_invoice
            - coalesce(pr.allocated_invoice, 0)
            - coalesce((
              select sum(sr.credit_note_amount)
              from sales_returns sr
              where sr.customer_invoice_id = ci.id
                and sr.return_status = 'posted'
            ), 0)
            ${
              adjustmentsReady
                ? `- coalesce((
              select sum(adj.adjustment_amount)
              from customer_ar_adjustments adj
              where adj.customer_invoice_id = ci.id
                and adj.adjustment_status = 'posted'
            ), 0)`
                : ""
            }
          ) as outstanding_invoice,
          greatest((current_date - (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date), 0) as ageing_days
        from customer_invoices ci
        join customers c on c.id = ci.customer_id
        left join sales_orders so on so.id = ci.sales_order_id
        left join payment_terms pt on pt.id = so.payment_term_id
        left join posted_receipts pr on pr.customer_invoice_id = ci.id
        left join currencies curr on curr.id = ci.invoice_currency_id
        where ${where.join(" and ")}
      )
      select *
      from invoice_ageing
      where outstanding_invoice > 0.0001
      order by ageing_days desc, invoice_date asc, id asc
    `,
    params
  );
  const invoiceRows = r.rows.map((row) => ({
    ...row,
    outstanding_invoice: money(row.outstanding_invoice),
    allocated_invoice: money(row.allocated_invoice),
  }));

  const customerMap = new Map();
  for (const row of invoiceRows) {
    const key = Number(row.customer_id);
    if (!customerMap.has(key)) {
      customerMap.set(key, {
        customer_id: key,
        customer_name: row.customer_name,
        current_bucket: 0,
        bucket_31_60: 0,
        bucket_61_90: 0,
        bucket_90_plus: 0,
        total_outstanding: 0,
      });
    }
    const item = customerMap.get(key);
    const amount = qty(row.outstanding_invoice);
    item.total_outstanding = money(item.total_outstanding + amount);
    if (qty(row.ageing_days) <= 30) item.current_bucket = money(item.current_bucket + amount);
    else if (qty(row.ageing_days) <= 60) item.bucket_31_60 = money(item.bucket_31_60 + amount);
    else if (qty(row.ageing_days) <= 90) item.bucket_61_90 = money(item.bucket_61_90 + amount);
    else item.bucket_90_plus = money(item.bucket_90_plus + amount);
  }

  return {
    ageing_customers: Array.from(customerMap.values()).sort((a, b) => qty(b.total_outstanding) - qty(a.total_outstanding)),
    ageing_invoices: invoiceRows,
  };
}

async function getCustomerStatementData(client, customerId, { distributorId = null, companyId = null } = {}) {
  const customer = await getCustomerHeaderOrNull(client, customerId, distributorId);
  if (!customer) return null;
  const adjustmentsReady = await isArAdjustmentsReady(client);

  const params = [Number(customerId)];
  let distributorFilter = "";
  if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
    params.push(Number(distributorId));
    distributorFilter = ` and ci.distributor_id = $${params.length}`;
  }
  let companyFilter = "";
  if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    companyFilter = ` and ci.company_id = $${params.length}`;
  }

  const statementPromises = [
    client.query(
      `
        select
          ci.invoice_date as txn_date,
          'Invoice'::text as txn_type,
          ci.invoice_number as reference_no,
          ('Sales Order ' || coalesce(so.so_number, '—')) as description,
          ci.grand_total_invoice as debit,
          0::numeric as credit
        from customer_invoices ci
        left join sales_orders so on so.id = ci.sales_order_id
        where ci.customer_id = $1
          and ci.invoice_status <> 'cancelled'
          ${distributorFilter}
          ${companyFilter}
      `,
      params
    ),
    client.query(
      `
        select
          cr.receipt_date as txn_date,
          'Receipt'::text as txn_type,
          cr.receipt_number as reference_no,
          coalesce(cr.payment_mode, 'Customer Receipt') as description,
          0::numeric as debit,
          cr.receipt_amount_invoice as credit
        from customer_receipts cr
        where cr.customer_id = $1
          and cr.receipt_status = 'posted'
          ${distributorFilter.replaceAll("ci.", "cr.")}
          ${companyFilter.replaceAll("ci.", "cr.")}
      `,
      params
    ),
    client.query(
      `
        select
          sr.return_date as txn_date,
          'Credit Note'::text as txn_type,
          coalesce(sr.credit_note_number, sr.return_number) as reference_no,
          ('Against Invoice ' || coalesce(ci.invoice_number, '—')) as description,
          0::numeric as debit,
          sr.credit_note_amount as credit
        from sales_returns sr
        left join customer_invoices ci on ci.id = sr.customer_invoice_id
        where sr.customer_id = $1
          and sr.return_status = 'posted'
          and coalesce(sr.credit_note_amount, 0) > 0.0001
          ${distributorFilter.replaceAll("ci.", "sr.")}
          ${companyFilter.replaceAll("ci.", "sr.")}
      `,
      params
    ),
  ];
  if (adjustmentsReady) {
    statementPromises.push(
      client.query(
        `
          select
            a.posted_at::date as txn_date,
            'AR Adjustment'::text as txn_type,
            ('ARADJ-' || a.id::text) as reference_no,
            (
              initcap(replace(a.adjustment_type, '_', ' '))
              || ' against '
              || coalesce(ci.invoice_number, '—')
              || case when coalesce(a.reason, '') <> '' then ' - ' || a.reason else '' end
            ) as description,
            0::numeric as debit,
            a.adjustment_amount as credit
          from customer_ar_adjustments a
          left join customer_invoices ci on ci.id = a.customer_invoice_id
          where a.customer_id = $1
            and a.adjustment_status = 'posted'
            and coalesce(a.adjustment_amount, 0) > 0.0001
            ${distributorFilter.replaceAll("ci.", "a.")}
            ${companyFilter.replaceAll("ci.", "a.")}
        `,
        params
      )
    );
  }
  const [invoiceRowsRes, receiptRowsRes, creditNoteRowsRes, adjustmentRowsRes] = await Promise.all(statementPromises);

  const rows = [...invoiceRowsRes.rows, ...receiptRowsRes.rows, ...creditNoteRowsRes.rows, ...(adjustmentRowsRes?.rows || [])]
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

  let runningBalance = 0;
  const statementRows = rows.map((row) => {
    runningBalance = money(runningBalance + qty(row.debit) - qty(row.credit));
    return {
      ...row,
      running_balance: runningBalance,
    };
  });

  return {
    customer,
    statementRows,
    summary: {
      total_invoiced: money(statementRows.reduce((sum, row) => sum + qty(row.debit), 0)),
      total_received: money(statementRows.reduce((sum, row) => sum + (row.txn_type === "Receipt" ? qty(row.credit) : 0), 0)),
      total_credited: money(statementRows.reduce((sum, row) => sum + (row.txn_type === "Credit Note" ? qty(row.credit) : 0), 0)),
      total_adjusted: money(statementRows.reduce((sum, row) => sum + (row.txn_type === "AR Adjustment" ? qty(row.credit) : 0), 0)),
      outstanding: money(statementRows.length ? statementRows[statementRows.length - 1].running_balance : 0),
    },
    asOfDate: new Date(),
  };
}

router.get("/", requireScreenAction("receipts", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const qText = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim() : "";
    const source = typeof req.query.source === "string" ? req.query.source.trim() : "";

    const params = [];
    const where = [];
    if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
      params.push(Number(distributorId));
      where.push(`cr.distributor_id = $${params.length}`);
    } else {
      params.push(activeCompanyId);
      where.push(`cr.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "receipts")) {
      params.push(Number(req.user.id));
      where.push(`cr.created_by = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`cr.receipt_status = $${params.length}`);
    }
    if (source === "tally_import" || source === "erp") {
      params.push(source);
      where.push(`coalesce(cr.receipt_source, 'erp') = $${params.length}`);
    }
    if (qText) {
      params.push(`%${qText}%`);
      where.push(`(cr.receipt_number ilike $${params.length} or c.customer_name ilike $${params.length})`);
    }
    if (bucket === "pending_allocation") {
      where.push(`cr.receipt_status = 'posted'`);
      where.push(`coalesce(cr.unallocated_amount_invoice, 0) > 0.0001`);
    }
    if (bucket === "unapplied_cash") {
      where.push(`cr.receipt_status = 'posted'`);
      where.push(`coalesce(cr.unallocated_amount_invoice, 0) > 0.0001`);
      where.push(`coalesce(cr.allocated_amount_invoice, 0) <= 0.0001`);
    }

    const [receiptsRes, ageing] = await Promise.all([
      pool.query(
        `
          select
            cr.id,
            cr.receipt_number,
            cr.receipt_status,
            cr.receipt_date,
            coalesce(cr.receipt_source, 'erp') as receipt_source,
            cr.tally_voucher_number,
            cr.receipt_amount_invoice,
            cr.allocated_amount_invoice,
            cr.unallocated_amount_invoice,
            c.customer_name,
            curr.currency_code as receipt_currency_code
          from customer_receipts cr
          join customers c on c.id = cr.customer_id
          left join currencies curr on curr.id = cr.receipt_currency_id
          ${where.length ? `where ${where.join(" and ")}` : ""}
          order by cr.created_at desc, cr.id desc
        `,
        params
      ),
      getAgeingSummary(pool, distributorId, activeCompanyId),
    ]);

    return res.json({ ok: true, receipts: receiptsRes.rows, ...ageing });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("receipts", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const customerId = Number(body.customer_id);
    if (!Number.isFinite(customerId) || customerId <= 0) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });

    const companyId = requireResolvedCompanyId(req, body.company_id ? Number(body.company_id) : null);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const receiptDate = body.receipt_date ? String(body.receipt_date).slice(0, 10) : null;
    const receiptAmountInvoice = money(body.receipt_amount_invoice);
    if (receiptAmountInvoice <= 0.0001) return res.status(400).json({ ok: false, error: "INVALID_RECEIPT_AMOUNT" });

    const financeBookId =
      body.finance_book_id === undefined || body.finance_book_id === null || body.finance_book_id === ""
        ? null
        : Number(body.finance_book_id);
    if (financeBookId !== null && (!Number.isFinite(financeBookId) || financeBookId <= 0)) {
      return res.status(400).json({ ok: false, error: "INVALID_BOOK" });
    }

    await client.query("begin");

    await ensureCustomerCompanyAccess(client, req, customerId);

    if (isDistributor) {
      const allowedRes = await client.query(
        `
          select 1
          from customer_distributor_links cdl
          where cdl.customer_id = $1
            and cdl.distributor_id = $2
          limit 1
        `,
        [customerId, Number(distributorId)]
      );
      if (!allowedRes.rows[0]) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "CUSTOMER_NOT_ALLOWED" });
      }
    }

    if (financeBookId !== null) {
      const bookRes = await client.query(
        `select id from finance_books where id = $1 and company_id = $2 and is_active = true limit 1`,
        [financeBookId, companyId]
      );
      if (!bookRes.rows[0]?.id) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "BOOK_NOT_FOUND" });
      }
    }

    const invoiceParams = [customerId, companyId];
    const invoiceWhere = [`ci.customer_id = $1`, `ci.company_id = $2`, `ci.invoice_status <> 'cancelled'`];
    if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
      invoiceParams.push(Number(distributorId));
      invoiceWhere.push(`ci.distributor_id = $3`);
    }

    const currencyHintRes = await client.query(
      `
        select
          ci.base_currency_id,
          ci.invoice_currency_id,
          ci.grand_total_base,
          ci.grand_total_invoice
        from customer_invoices ci
        where ${invoiceWhere.join(" and ")}
        order by ci.invoice_date desc, ci.id desc
        limit 1
      `,
      invoiceParams
    );

    let baseCurrencyId = Number(currencyHintRes.rows[0]?.base_currency_id || 0);
    let receiptCurrencyId = Number(currencyHintRes.rows[0]?.invoice_currency_id || 0);
    let ratio =
      qty(currencyHintRes.rows[0]?.grand_total_invoice) > 0
        ? qty(currencyHintRes.rows[0]?.grand_total_base) / qty(currencyHintRes.rows[0]?.grand_total_invoice)
        : 1;

    if (!Number.isFinite(baseCurrencyId) || baseCurrencyId <= 0 || !Number.isFinite(receiptCurrencyId) || receiptCurrencyId <= 0) {
      const inrRes = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
      const inrId = Number(inrRes.rows[0]?.id || 0);
      if (!Number.isFinite(inrId) || inrId <= 0) throw new Error("INR currency not seeded");
      baseCurrencyId = inrId;
      receiptCurrencyId = inrId;
      ratio = 1;
    }

    const receiptAmountBase = money(receiptAmountInvoice * ratio);

    const numRes = await client.query(`select next_company_document_number($1, 'RCPT') as receipt_number`, [companyId]);
    const receiptNumber = numRes.rows[0]?.receipt_number;

    const receiptRes = await client.query(
      `
        insert into customer_receipts (
          receipt_number,
          company_id,
          customer_id,
          distributor_id,
          receipt_status,
          receipt_date,
          base_currency_id,
          receipt_currency_id,
          finance_book_id,
          receipt_amount_base,
          receipt_amount_invoice,
          allocated_amount_base,
          allocated_amount_invoice,
          unallocated_amount_base,
          unallocated_amount_invoice,
          payment_mode,
          reference_no,
          bank_name,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,'draft',coalesce($5, current_date),$6,$7,$8,$9,$10,0,0,$11,$12,$13,$14,$15,$16,$17)
        returning id
      `,
      [
        receiptNumber,
        companyId,
        customerId,
        isDistributor ? Number(distributorId) : null,
        receiptDate,
        baseCurrencyId,
        receiptCurrencyId,
        financeBookId,
        receiptAmountBase,
        receiptAmountInvoice,
        receiptAmountBase,
        receiptAmountInvoice,
        body.payment_mode || null,
        body.reference_no || null,
        body.bank_name || null,
        body.remarks || null,
        req.user.id,
      ]
    );
    const receiptId = Number(receiptRes.rows[0]?.id || 0);

    await client.query("commit");

    const receipt = await getReceiptHeaderOrNull(client, receiptId, isDistributor ? distributorId : null, companyId);
    const openInvoices = await getOpenInvoicesForCustomer(client, {
      customerId: receipt.customer_id,
      distributorId: receipt.distributor_id,
      currencyId: receipt.receipt_currency_id,
      companyId: receipt.company_id,
      excludeReceiptId: receiptId,
    });
    return res.status(201).json({ ok: true, receipt, allocations: [], open_invoices: openInvoices });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/customer/:customerId/statement/pdf", requireScreenAction("receipts", "can_view"), async (req, res, next) => {
  try {
    const customerId = Number(req.params.customerId);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const statement = await getCustomerStatementData(pool, customerId, { distributorId, companyId: activeCompanyId });
    if (!statement) return res.status(404).json({ ok: false });

    const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(pool, activeCompanyId));
    const pdf = await generateQuotePdfBuffer(
      renderCustomerStatementHtml({
        customer: statement.customer,
        statementRows: statement.statementRows,
        summary: statement.summary,
        sellerProfile,
        asOfDate: statement.asOfDate,
      })
    );
    const fileName = `${safeFileSegment(statement.customer.customer_name || `customer_${customerId}`)}_statement.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(pdf);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireScreenAction("receipts", "can_view"), async (req, res, next) => {
  try {
    const receiptId = Number(req.params.id);
    if (!Number.isFinite(receiptId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const receipt = await getReceiptHeaderOrNull(pool, receiptId, distributorId, activeCompanyId);
    if (!receipt) return res.status(404).json({ ok: false });
    if (!canAccessReceipt(req, receipt)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, receipt)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const [allocations, openInvoices] = await Promise.all([
      getReceiptAllocations(pool, receiptId, receiptId),
      getOpenInvoicesForCustomer(pool, {
        customerId: receipt.customer_id,
        distributorId: receipt.distributor_id,
        currencyId: receipt.receipt_currency_id,
        companyId: receipt.company_id,
        excludeReceiptId: receiptId,
      }),
    ]);
    return res.json({ ok: true, receipt, allocations, open_invoices: openInvoices });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/pdf", requireScreenAction("receipts", "can_view"), async (req, res, next) => {
  try {
    const receiptId = Number(req.params.id);
    if (!Number.isFinite(receiptId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const receipt = await getReceiptHeaderOrNull(pool, receiptId, distributorId, activeCompanyId);
    if (!receipt) return res.status(404).json({ ok: false });
    if (!canAccessReceipt(req, receipt)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, receipt)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const [allocations, sellerProfile] = await Promise.all([
      getReceiptAllocations(pool, receiptId, receiptId),
      getCompanyProfile(pool, receipt.company_id),
    ]);
    const pdf = await generateQuotePdfBuffer(
      renderReceiptHtml({
        receipt,
        allocations,
        sellerProfile: enrichCompanyProfileAssets(sellerProfile),
      })
    );
    const fileName = `${safeFileSegment(receipt.receipt_number || `receipt_${receiptId}`)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(pdf);
  } catch (err) {
    return next(err);
  }
});

router.post("/from-invoice/:id", requireScreenAction("receipts", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isFinite(invoiceId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const invoice = await getInvoiceHeaderOrNull(client, invoiceId, distributorId, activeCompanyId);
    if (!invoice) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessInvoice(req, invoice)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, invoice)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (String(invoice.invoice_status || "").toLowerCase() === "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "INVOICE_CANCELLED" });
    }

    const outstandingMap = await getInvoiceOutstandingMap(client, {
      customerId: invoice.customer_id,
      distributorId: invoice.distributor_id,
      currencyId: invoice.invoice_currency_id,
      companyId: invoice.company_id,
    });
    const invoiceOutstanding = outstandingMap.get(invoiceId) || {
      outstanding_base: qty(invoice.grand_total_base),
      outstanding_invoice: qty(invoice.grand_total_invoice),
    };
    if (qty(invoiceOutstanding.outstanding_invoice) <= 0.0001) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "INVOICE_ALREADY_SETTLED" });
    }

    const companyId = requireResolvedCompanyId(req, invoice.company_id);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    const numRes = await client.query(`select next_company_document_number($1, 'RCPT') as receipt_number`, [companyId]);
    const receiptNumber = numRes.rows[0]?.receipt_number;
    const receiptRes = await client.query(
      `
        insert into customer_receipts (
          receipt_number, company_id, customer_id, distributor_id, receipt_status, receipt_date,
          base_currency_id, receipt_currency_id,
          finance_book_id,
          receipt_amount_base, receipt_amount_invoice,
          allocated_amount_base, allocated_amount_invoice,
          unallocated_amount_base, unallocated_amount_invoice,
          created_by
        )
        values ($1,$2,$3,$4,'draft',current_date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        returning id
      `,
      [
        receiptNumber,
        companyId,
        invoice.customer_id,
        invoice.distributor_id || null,
        invoice.base_currency_id,
        invoice.invoice_currency_id,
        null,
        invoiceOutstanding.outstanding_base,
        invoiceOutstanding.outstanding_invoice,
        invoiceOutstanding.outstanding_base,
        invoiceOutstanding.outstanding_invoice,
        0,
        0,
        req.user.id,
      ]
    );
    const receiptId = Number(receiptRes.rows[0]?.id || 0);

    await client.query(
      `
        insert into customer_receipt_allocations (
          customer_receipt_id, customer_invoice_id, allocated_base, allocated_invoice
        )
        values ($1,$2,$3,$4)
      `,
      [receiptId, invoiceId, invoiceOutstanding.outstanding_base, invoiceOutstanding.outstanding_invoice]
    );

    const totals = calculateReceiptTotals(invoiceOutstanding.outstanding_base, invoiceOutstanding.outstanding_invoice, [
      {
        allocated_base: invoiceOutstanding.outstanding_base,
        allocated_invoice: invoiceOutstanding.outstanding_invoice,
      },
    ]);
    await client.query(
      `
        update customer_receipts
        set allocated_amount_base = $2,
            allocated_amount_invoice = $3,
            unallocated_amount_base = $4,
            unallocated_amount_invoice = $5,
            updated_at = now()
        where id = $1
      `,
      [
        receiptId,
        totals.allocated_amount_base,
        totals.allocated_amount_invoice,
        totals.unallocated_amount_base,
        totals.unallocated_amount_invoice,
      ]
    );

    await client.query("commit");
    const receipt = await getReceiptHeaderOrNull(client, receiptId, isDistributor ? distributorId : null, companyId);
    const allocations = await getReceiptAllocations(client, receiptId, receiptId);
    const openInvoices = await getOpenInvoicesForCustomer(client, {
      customerId: receipt.customer_id,
      distributorId: receipt.distributor_id,
      currencyId: receipt.receipt_currency_id,
        companyId: receipt.company_id,
      excludeReceiptId: receiptId,
    });
    return res.status(201).json({ ok: true, receipt, allocations, open_invoices: openInvoices });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id", requireScreenAction("receipts", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const receiptId = Number(req.params.id);
    if (!Number.isFinite(receiptId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const status = typeof body.receipt_status === "string" ? body.receipt_status.trim().toLowerCase() : "draft";
    if (!["draft", "posted", "cancelled"].includes(status)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const receipt = await getReceiptHeaderOrNull(client, receiptId, distributorId, activeCompanyId);
    if (!receipt) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessReceipt(req, receipt)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, receipt)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (receipt.receipt_status !== "draft" && status !== "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "RECEIPT_NOT_EDITABLE" });
    }

    const receiptAmountInvoice = money(body.receipt_amount_invoice ?? receipt.receipt_amount_invoice);
    const receiptAmountBase = qty(receipt.receipt_amount_invoice) > 0
      ? money((receiptAmountInvoice / qty(receipt.receipt_amount_invoice)) * qty(receipt.receipt_amount_base))
      : money(body.receipt_amount_base ?? receipt.receipt_amount_base ?? receiptAmountInvoice);
    const financeBookId =
      body.finance_book_id === undefined || body.finance_book_id === null || body.finance_book_id === ""
        ? null
        : Number(body.finance_book_id);
    if (financeBookId !== null && (!Number.isFinite(financeBookId) || financeBookId <= 0)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_BOOK" });
    }
    if (financeBookId !== null) {
      const bookRes = await client.query(`select id from finance_books where id = $1 and company_id = $2 and is_active = true limit 1`, [
        financeBookId,
        receipt.company_id,
      ]);
      if (!bookRes.rows[0]?.id) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "BOOK_NOT_FOUND" });
      }
    }

    const openInvoices = await getOpenInvoicesForCustomer(client, {
      customerId: receipt.customer_id,
      distributorId: receipt.distributor_id,
      currencyId: receipt.receipt_currency_id,
      companyId: receipt.company_id,
      excludeReceiptId: receiptId,
    });
    const invoiceMap = new Map(openInvoices.map((row) => [Number(row.id), row]));
    const requestedAllocations = Array.isArray(body.allocations) ? body.allocations : [];
    const normalizedAllocations = [];

    for (const row of requestedAllocations) {
      const invoiceId = Number(row.customer_invoice_id);
      const targetInvoice = invoiceMap.get(invoiceId);
      if (!targetInvoice) continue;
      const allocatedInvoice = money(row.allocated_invoice);
      if (allocatedInvoice < 0 || allocatedInvoice > qty(targetInvoice.outstanding_invoice)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_ALLOCATION" });
      }
      if (allocatedInvoice <= 0.0001) continue;
      const ratio = qty(targetInvoice.grand_total_invoice) > 0 ? qty(targetInvoice.grand_total_base) / qty(targetInvoice.grand_total_invoice) : 1;
      normalizedAllocations.push({
        customer_invoice_id: invoiceId,
        allocated_invoice: allocatedInvoice,
        allocated_base: money(allocatedInvoice * ratio),
      });
    }

    const totals = calculateReceiptTotals(receiptAmountBase, receiptAmountInvoice, normalizedAllocations);
    if (totals.unallocated_amount_invoice < -0.0001) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "RECEIPT_OVER_ALLOCATED" });
    }
    if (status === "posted" && normalizedAllocations.length === 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_ALLOCATIONS" });
    }

    await client.query(
      `
        update customer_receipts
        set receipt_status = $2,
            receipt_date = coalesce($3, receipt_date),
            receipt_amount_base = $4,
            receipt_amount_invoice = $5,
            allocated_amount_base = $6,
            allocated_amount_invoice = $7,
            unallocated_amount_base = $8,
            unallocated_amount_invoice = $9,
            finance_book_id = $10,
            payment_mode = $11,
            reference_no = $12,
            bank_name = $13,
            remarks = $14,
            updated_at = now()
        where id = $1 and company_id = $15
      `,
      [
        receiptId,
        status,
        body.receipt_date || null,
        receiptAmountBase,
        receiptAmountInvoice,
        totals.allocated_amount_base,
        totals.allocated_amount_invoice,
        totals.unallocated_amount_base,
        totals.unallocated_amount_invoice,
        financeBookId,
        body.payment_mode || null,
        body.reference_no || null,
        body.bank_name || null,
        body.remarks || null,
        receipt.company_id,
      ]
    );

    const previousAllocRes = await client.query(
      `select customer_invoice_id from customer_receipt_allocations where customer_receipt_id = $1`,
      [receiptId]
    );

    await client.query(`delete from customer_receipt_allocations where customer_receipt_id = $1`, [receiptId]);
    for (const row of normalizedAllocations) {
      await client.query(
        `
          insert into customer_receipt_allocations (
            customer_receipt_id, customer_invoice_id, allocated_base, allocated_invoice
          )
          values ($1,$2,$3,$4)
        `,
        [receiptId, row.customer_invoice_id, row.allocated_base, row.allocated_invoice]
      );
    }

    if (status === "posted" || status === "cancelled" || String(receipt.receipt_status || "").toLowerCase() === "posted") {
      const touchedInvoiceIds = [
        ...new Set([
          ...previousAllocRes.rows.map((row) => Number(row.customer_invoice_id)),
          ...normalizedAllocations.map((row) => Number(row.customer_invoice_id)),
        ]),
      ].filter((id) => Number.isFinite(id) && id > 0);
      await syncCustomerInvoicePaidStatus(client, touchedInvoiceIds, {
        companyId: receipt.company_id,
        excludeReceiptId: null,
      });
    }

    await client.query("commit");
    const nextReceipt = await getReceiptHeaderOrNull(client, receiptId, isDistributor ? distributorId : null, receipt.company_id);
    const allocations = await getReceiptAllocations(client, receiptId, receiptId);
    const nextOpenInvoices = await getOpenInvoicesForCustomer(client, {
      customerId: nextReceipt.customer_id,
      distributorId: nextReceipt.distributor_id,
      currencyId: nextReceipt.receipt_currency_id,
      companyId: nextReceipt.company_id,
      excludeReceiptId: receiptId,
    });
    return res.json({ ok: true, receipt: nextReceipt, allocations, open_invoices: nextOpenInvoices });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id/allocations", requireScreenAction("receipts", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const receiptId = Number(req.params.id);
    if (!Number.isFinite(receiptId)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const receipt = await getReceiptHeaderOrNull(client, receiptId, distributorId, activeCompanyId);
    if (!receipt) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessReceipt(req, receipt)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, receipt)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (String(receipt.receipt_status || "").toLowerCase() === "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "RECEIPT_CANCELLED" });
    }

    const receiptAmountBase = money(receipt.receipt_amount_base);
    const receiptAmountInvoice = money(receipt.receipt_amount_invoice);

    const openInvoices = await getOpenInvoicesForCustomer(client, {
      customerId: receipt.customer_id,
      distributorId: receipt.distributor_id,
      currencyId: receipt.receipt_currency_id,
      companyId: receipt.company_id,
      excludeReceiptId: receiptId,
    });
    const invoiceMap = new Map(openInvoices.map((row) => [Number(row.id), row]));

    const requestedAllocations = Array.isArray(body.allocations) ? body.allocations : [];
    const normalizedAllocations = [];

    for (const row of requestedAllocations) {
      const invoiceId = Number(row.customer_invoice_id);
      const targetInvoice = invoiceMap.get(invoiceId);
      if (!targetInvoice) continue;
      const allocatedInvoice = money(row.allocated_invoice);
      if (allocatedInvoice < 0 || allocatedInvoice > qty(targetInvoice.outstanding_invoice)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_ALLOCATION" });
      }
      if (allocatedInvoice <= 0.0001) continue;
      const ratio = qty(targetInvoice.grand_total_invoice) > 0 ? qty(targetInvoice.grand_total_base) / qty(targetInvoice.grand_total_invoice) : 1;
      normalizedAllocations.push({
        customer_invoice_id: invoiceId,
        allocated_invoice: allocatedInvoice,
        allocated_base: money(allocatedInvoice * ratio),
      });
    }

    if (normalizedAllocations.length === 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_ALLOCATIONS" });
    }

    const totals = calculateReceiptTotals(receiptAmountBase, receiptAmountInvoice, normalizedAllocations);
    if (totals.unallocated_amount_invoice < -0.0001) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "RECEIPT_OVER_ALLOCATED" });
    }

    await client.query(
      `
        update customer_receipts
        set allocated_amount_base = $2,
            allocated_amount_invoice = $3,
            unallocated_amount_base = $4,
            unallocated_amount_invoice = $5,
            updated_at = now()
        where id = $1 and company_id = $6
      `,
      [
        receiptId,
        totals.allocated_amount_base,
        totals.allocated_amount_invoice,
        totals.unallocated_amount_base,
        totals.unallocated_amount_invoice,
        receipt.company_id,
      ]
    );

    await client.query(`delete from customer_receipt_allocations where customer_receipt_id = $1`, [receiptId]);
    for (const row of normalizedAllocations) {
      await client.query(
        `
          insert into customer_receipt_allocations (
            customer_receipt_id, customer_invoice_id, allocated_base, allocated_invoice
          )
          values ($1,$2,$3,$4)
        `,
        [receiptId, row.customer_invoice_id, row.allocated_base, row.allocated_invoice]
      );
    }

    if (String(receipt.receipt_status || "").toLowerCase() === "posted") {
      const touchedInvoiceIds = normalizedAllocations
        .map((row) => Number(row.customer_invoice_id))
        .filter((id) => Number.isFinite(id) && id > 0);
      await syncCustomerInvoicePaidStatus(client, touchedInvoiceIds, {
        companyId: receipt.company_id,
        excludeReceiptId: null,
      });
    }

    await client.query("commit");
    const nextReceipt = await getReceiptHeaderOrNull(client, receiptId, isDistributor ? distributorId : null, receipt.company_id);
    const allocations = await getReceiptAllocations(client, receiptId, receiptId);
    const nextOpenInvoices = await getOpenInvoicesForCustomer(client, {
      customerId: nextReceipt.customer_id,
      distributorId: nextReceipt.distributor_id,
      currencyId: nextReceipt.receipt_currency_id,
      companyId: nextReceipt.company_id,
      excludeReceiptId: receiptId,
    });
    return res.json({ ok: true, receipt: nextReceipt, allocations, open_invoices: nextOpenInvoices });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
