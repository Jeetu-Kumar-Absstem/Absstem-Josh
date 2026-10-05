const express = require("express");
const fs = require("fs");
const multer = require("multer");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction, hasScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, requireResolvedCompanyId } = require("../services/companyContext");
const { getDistributorIdForUser } = require("../services/mailAccounts");
const { applyPdfBackground, generateQuotePdfBuffer, stampPdfPageNumbers, mergePdfBuffers, countPdfPages } = require("../pdf/pdfCore");
const { buildTaxInvoicePdfBuffer } = require("../pdf/invoicePdf");
const { signedQrToDataUrl } = require("../pdf/qrCode");
const { enrichCompanyProfileAssets, getCompanyProfile } = require("../services/companyProfile");
const { normalizeCustomerPoFields, resolveCustomerItemFields } = require("../services/customerProductMaps");
const {
  isBillablePAndFTerm,
  isBillableFreightTerm,
  buildChargeLinePayload,
  summarizeChargesFromLines,
  money: chargeMoney,
} = require("../services/invoiceCharges");
const { buildEinvoicePayload } = require("../services/einvoice/einvoicePayload");
const {
  generateIrn: gspGenerateIrn,
  cancelIrn: gspCancelIrn,
  generateEwayBill: gspGenerateEwayBill,
  cancelEwayBill: gspCancelEwayBill,
  EinvoiceNotConfiguredError,
  GspTransportError,
} = require("../services/einvoice/gspAdapter");
const { buildEwayGeneratePayload, buildEwayCancelPayload } = require("../services/einvoice/ewayPayload");
const {
  attachIrnMetadata,
  clearIrnMetadata,
  logEinvoiceEvent,
  EinvoiceValidationError,
  EinvoiceNotFoundError,
} = require("../services/einvoice");
const { isValidEwayBillNo } = require("../services/ewayCompliance");
const {
  parseInvoiceChainCsv,
  linkInvoicesToSalesOrders,
  enrichTallyInvoicesFromStaging,
  enrichTallyInvoicesFromTallyFile,
} = require("../services/tallyInvoiceEnrichment");

const { money2 } = require("../services/tally/money");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 },
});

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const money = money2;

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

async function isArAdjustmentsReady(client = pool) {
  const r = await client.query(`select to_regclass('public.customer_ar_adjustments') is not null as ready`);
  return Boolean(r.rows[0]?.ready);
}

function getOutstandingInvoiceExpr({ invoiceAlias = "ci", receiptAlias = "pr", returnAlias = "sr", adjustmentAlias = "adj", adjustmentsReady = false } = {}) {
  return `(${invoiceAlias}.grand_total_invoice - coalesce(${receiptAlias}.allocated_invoice, 0) - coalesce(${returnAlias}.credit_note_amount, 0)${
    adjustmentsReady ? ` - coalesce(${adjustmentAlias}.adjustment_amount, 0)` : ""
  })`;
}

/** Outstanding math for invoice list queries that avoid receipt/return/adj JOIN fan-out. */
function getOutstandingInvoiceScalarExpr({ invoiceAlias = "ci", adjustmentsReady = false } = {}) {
  const allocatedSub = `(select coalesce(sum(cra.allocated_invoice), 0)
    from customer_receipt_allocations cra
    join customer_receipts cr on cr.id = cra.customer_receipt_id
    where cra.customer_invoice_id = ${invoiceAlias}.id
      and cr.receipt_status = 'posted')`;
  const returnsSub = `(select coalesce(sum(sr.credit_note_amount), 0)
    from sales_returns sr
    where sr.customer_invoice_id = ${invoiceAlias}.id
      and sr.return_status = 'posted')`;
  const adjustmentsSub = adjustmentsReady
    ? `(select coalesce(sum(cadj.adjustment_amount), 0)
        from customer_ar_adjustments cadj
        where cadj.customer_invoice_id = ${invoiceAlias}.id
          and cadj.adjustment_status = 'posted')`
    : null;
  return `(${invoiceAlias}.grand_total_invoice - ${allocatedSub} - ${returnsSub}${
    adjustmentsSub ? ` - ${adjustmentsSub}` : ""
  })`;
}

function buildInvoiceListFromClause({ needsPaymentTerms = false } = {}) {
  return `
        from customer_invoices ci
        join customers c on c.id = ci.customer_id
        left join sales_orders so on so.id = ci.sales_order_id
        ${needsPaymentTerms ? `left join payment_terms pt on pt.id = so.payment_term_id` : ""}
        left join currencies curr on curr.id = ci.invoice_currency_id`;
}

function buildInvoiceListSelectSql({ adjustmentsReady, needsAgeingCalc, outstandingExpr }) {
  const dueDateExpr = needsAgeingCalc
    ? `(ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date`
    : `ci.invoice_date`;
  const ageingExpr = needsAgeingCalc
    ? `greatest((current_date - (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date), 0)::int`
    : `0::int`;
  return `
        select
          ci.id,
          ci.invoice_number,
          ci.invoice_status,
          ci.invoice_date,
          coalesce(ci.invoice_source, 'erp') as invoice_source,
          ci.tally_voucher_number,
          ci.customer_po_number,
          ci.customer_po_date,
          ci.job_no,
          ${dueDateExpr} as due_date,
          ${ageingExpr} as ageing_days,
          ci.grand_total_invoice,
          (select coalesce(sum(cra.allocated_invoice), 0)
            from customer_receipt_allocations cra
            join customer_receipts cr on cr.id = cra.customer_receipt_id
            where cra.customer_invoice_id = ci.id
              and cr.receipt_status = 'posted') as amount_received_invoice,
          (select coalesce(sum(sr.credit_note_amount), 0)
            from sales_returns sr
            where sr.customer_invoice_id = ci.id
              and sr.return_status = 'posted') as credit_note_amount,
          ${
            adjustmentsReady
              ? `(select coalesce(sum(cadj.adjustment_amount), 0)
                  from customer_ar_adjustments cadj
                  where cadj.customer_invoice_id = ci.id
                    and cadj.adjustment_status = 'posted')`
              : `0::numeric`
          } as adjustment_amount,
          ${outstandingExpr} as outstanding_invoice,
          c.customer_name,
          c.id as customer_id,
          so.so_number,
          ci.sales_order_id,
          curr.currency_code as invoice_currency_code`;
}

async function loadInvoicesForCompanyDesk(client, companyId, { limit = 0, offset = 0, whereExtra = [], paramsExtra = [] } = {}) {
  const params = [Number(companyId), ...paramsExtra];
  const whereParts = [`ci.company_id = $1`, ...whereExtra];
  const limitSql = limit ? `limit ${Number(limit)} offset ${Number(offset) || 0}` : "";
  const r = await client.query(
    `
      select
        ci.id,
        ci.invoice_number,
        ci.invoice_status,
        ci.invoice_date,
        coalesce(ci.invoice_source, 'erp') as invoice_source,
        ci.tally_voucher_number,
        ci.customer_po_number,
        ci.customer_po_date,
        ci.job_no,
        ci.invoice_date as due_date,
        0::int as ageing_days,
        ci.grand_total_invoice,
        0::numeric as amount_received_invoice,
        0::numeric as credit_note_amount,
        0::numeric as adjustment_amount,
        ci.grand_total_invoice as outstanding_invoice,
        c.customer_name,
        c.id as customer_id,
        so.so_number,
        ci.sales_order_id,
        coalesce(curr.currency_code, 'INR') as invoice_currency_code
      from customer_invoices ci
      join customers c on c.id = ci.customer_id
      left join sales_orders so on so.id = ci.sales_order_id
      left join currencies curr on curr.id = ci.invoice_currency_id
      where ${whereParts.join(" and ")}
      order by ci.created_at desc nulls last, ci.id desc
      ${limitSql}
    `,
    params
  );
  return r.rows;
}

async function queryInvoiceListRows(client, { where, params, limit, offset = 0, adjustmentsReady, outstandingExpr, needsPaymentTerms, needsAgeingCalc, companyId, allowCompanyForced = false }) {
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const limitSql = limit ? `limit ${limit} offset ${Number(offset) || 0}` : "";
  const selectSql = buildInvoiceListSelectSql({ adjustmentsReady, needsAgeingCalc, outstandingExpr });
  const fromSql = buildInvoiceListFromClause({ needsPaymentTerms: needsPaymentTerms || needsAgeingCalc });

  const runQuery = async (select, from, orderBy) => {
    const sql = [select, from, whereSql, orderBy, limitSql].filter((part) => String(part || "").trim()).join("\n");
    return client.query(sql, params);
  };

  try {
    const primary = await runQuery(selectSql, fromSql, `order by ci.created_at desc nulls last, ci.id desc`);
    // An empty filtered result is a real answer; the fallbacks below exist for schema drift only.
    if (primary.rows.length || !allowCompanyForced) return { rows: primary.rows, engine: "primary" };
  } catch (err) {
    process.stderr.write(`[invoices-list] primary query failed: ${err?.message || err}\n`);
  }

  const minimalSelect = `
        select
          ci.id,
          ci.invoice_number,
          ci.invoice_status,
          ci.invoice_date,
          coalesce(ci.invoice_source, 'erp') as invoice_source,
          ci.tally_voucher_number,
          null::text as customer_po_number,
          null::date as customer_po_date,
          ci.invoice_date as due_date,
          0::int as ageing_days,
          ci.grand_total_invoice,
          0::numeric as amount_received_invoice,
          0::numeric as credit_note_amount,
          0::numeric as adjustment_amount,
          ci.grand_total_invoice as outstanding_invoice,
          c.customer_name,
          c.id as customer_id,
          so.so_number,
          ci.sales_order_id,
          coalesce(curr.currency_code, 'INR') as invoice_currency_code`;
  const minimalFrom = buildInvoiceListFromClause({ needsPaymentTerms: false });
  try {
    const fallback = await runQuery(minimalSelect, minimalFrom, `order by ci.id desc`);
    if (fallback.rows.length) return { rows: fallback.rows, engine: "minimal_fallback" };
  } catch (err) {
    process.stderr.write(`[invoices-list] minimal fallback failed: ${err?.message || err}\n`);
  }

  const bareSelect = `
        select
          ci.id,
          ci.invoice_number,
          ci.invoice_status,
          ci.invoice_date,
          'erp'::text as invoice_source,
          null::text as tally_voucher_number,
          null::text as customer_po_number,
          null::date as customer_po_date,
          ci.invoice_date as due_date,
          0::int as ageing_days,
          ci.grand_total_invoice,
          0::numeric as amount_received_invoice,
          0::numeric as credit_note_amount,
          0::numeric as adjustment_amount,
          ci.grand_total_invoice as outstanding_invoice,
          c.customer_name,
          c.id as customer_id,
          so.so_number,
          ci.sales_order_id,
          'INR'::text as invoice_currency_code`;
  try {
    const bare = await runQuery(bareSelect, minimalFrom, `order by ci.id desc`);
    if (bare.rows.length) return { rows: bare.rows, engine: "bare_fallback" };
  } catch (err) {
    process.stderr.write(`[invoices-list] bare fallback failed: ${err?.message || err}\n`);
  }

  if (allowCompanyForced && Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    try {
      const forced = await loadInvoicesForCompanyDesk(client, Number(companyId), { limit });
      if (forced.length) return { rows: forced, engine: "company_forced" };
    } catch (err) {
      process.stderr.write(`[invoices-list] company forced load failed: ${err?.message || err}\n`);
    }
  }

  return { rows: [], engine: "failed" };
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

function canAccessInvoice(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "invoices")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

function canAccessSalesOrder(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "sales_orders")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function getSalesOrderHeader(client, salesOrderId, distributorId = null, companyId = null) {
  const params = [Number(salesOrderId)];
  const distributorFilter =
    Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? ` and so.distributor_id = $2` : "";
  if (distributorFilter) params.push(Number(distributorId));
  const companyFilter =
    Number.isFinite(Number(companyId)) && Number(companyId) > 0 ? ` and so.company_id = $${params.length + 1}` : "";
  if (companyFilter) params.push(Number(companyId));
  const r = await client.query(
    `
      select
        so.*,
        co.company_code,
        c.customer_name
      from sales_orders so
      left join companies co on co.id = so.company_id
      join customers c on c.id = so.customer_id
      where so.id = $1
      ${distributorFilter}
      ${companyFilter}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

async function getSalesOrderLines(client, salesOrderId) {
  const r = await client.query(
    `
      select
        sol.*,
        pg.group_name as product_group_name
      from sales_order_lines sol
      left join products p on p.id = sol.product_id
      left join product_groups pg on pg.id = p.group_id
      where sol.sales_order_id = $1
      order by sol.line_no asc
    `,
    [salesOrderId]
  );
  return r.rows;
}

async function getInvoicedQtyMap(client, salesOrderId, { excludeInvoiceId = null } = {}) {
  const params = [Number(salesOrderId)];
  let excludeSql = "";
  if (Number.isFinite(Number(excludeInvoiceId)) && Number(excludeInvoiceId) > 0) {
    params.push(Number(excludeInvoiceId));
    excludeSql = ` and ci.id <> $${params.length}`;
  }
  const r = await client.query(
    `
      select
        il.sales_order_line_id,
        coalesce(sum(il.qty), 0) as qty_invoiced
      from invoice_lines il
      join customer_invoices ci on ci.id = il.customer_invoice_id
      where ci.sales_order_id = $1
        and ci.invoice_status <> 'cancelled'
        and il.sales_order_line_id is not null
        and il.charge_kind is null
        ${excludeSql}
      group by il.sales_order_line_id
    `,
    params
  );
  return new Map(r.rows.map((row) => [Number(row.sales_order_line_id), qty(row.qty_invoiced)]));
}

async function buildInvoiceProgressLines(client, salesOrderId, { excludeInvoiceId = null } = {}) {
  const [lines, invoicedQtyMap] = await Promise.all([
    getSalesOrderLines(client, salesOrderId),
    getInvoicedQtyMap(client, salesOrderId, { excludeInvoiceId }),
  ]);
  return lines.map((line) => {
    const orderedQty = qty(line.qty);
    const invoicedQty = qty(invoicedQtyMap.get(Number(line.id)));
    return {
      ...line,
      qty_ordered: orderedQty,
      qty_previously_invoiced: invoicedQty,
      qty_remaining_invoice: Math.max(orderedQty - invoicedQty, 0),
    };
  });
}

function enrichInvoiceLines(lines, progressLinesBySoLineId) {
  return lines.map((line) => {
    const progress = progressLinesBySoLineId.get(Number(line.sales_order_line_id));
    const orderedQty = qty(progress?.qty_ordered ?? line.qty_ordered);
    const previousQty = qty(progress?.qty_previously_invoiced);
    const currentQty = qty(line.qty);
    return {
      ...line,
      qty_ordered: orderedQty,
      qty_previously_invoiced: previousQty,
      qty_remaining_before_invoice: Math.max(orderedQty - previousQty, 0),
      qty_remaining_after_invoice: Math.max(orderedQty - previousQty - currentQty, 0),
    };
  });
}

function calculateInvoiceLineAmounts(lines) {
  return lines.map((line) => {
    const invoiceQty = qty(line.qty);
    const unitPriceBase = money(line.unit_price_base);
    const unitPriceInvoice = money(line.unit_price_invoice);
    const gstPct = qty(line.gst_pct);
    const lineTotalBase = money(invoiceQty * unitPriceBase);
    const lineTotalInvoice = money(invoiceQty * unitPriceInvoice);
    const taxBase = money((lineTotalBase * gstPct) / 100);
    const taxInvoice = money((lineTotalInvoice * gstPct) / 100);
    return {
      ...line,
      qty: invoiceQty,
      unit_price_base: unitPriceBase,
      unit_price_invoice: unitPriceInvoice,
      gst_pct: gstPct,
      line_total_base: lineTotalBase,
      line_total_invoice: lineTotalInvoice,
      tax_total_base: taxBase,
      tax_total_invoice: taxInvoice,
    };
  });
}

function calculateInvoiceTotals(lines) {
  const normalized = calculateInvoiceLineAmounts(lines);
  return normalized.reduce(
    (acc, line) => {
      acc.subtotal_base = money(acc.subtotal_base + line.line_total_base);
      acc.subtotal_invoice = money(acc.subtotal_invoice + line.line_total_invoice);
      acc.tax_total_base = money(acc.tax_total_base + line.tax_total_base);
      acc.tax_total_invoice = money(acc.tax_total_invoice + line.tax_total_invoice);
      acc.grand_total_base = money(acc.grand_total_base + line.line_total_base + line.tax_total_base);
      acc.grand_total_invoice = money(acc.grand_total_invoice + line.line_total_invoice + line.tax_total_invoice);
      return acc;
    },
    {
      subtotal_base: 0,
      subtotal_invoice: 0,
      tax_total_base: 0,
      tax_total_invoice: 0,
      grand_total_base: 0,
      grand_total_invoice: 0,
    }
  );
}

function buildChargePolicy(invoiceOrOrder, dispatch = null) {
  const pfBillable = isBillablePAndFTerm(invoiceOrOrder?.p_and_f_term_code, invoiceOrOrder?.p_and_f_term_name);
  const freightBillable = isBillableFreightTerm(invoiceOrOrder?.freight_term_code, invoiceOrOrder?.freight_term_name);
  return {
    packing_forwarding: {
      billable: pfBillable,
      term_code: invoiceOrOrder?.p_and_f_term_code || null,
      term_name: invoiceOrOrder?.p_and_f_term_name || null,
    },
    freight: {
      billable: freightBillable,
      term_code: invoiceOrOrder?.freight_term_code || null,
      term_name: invoiceOrOrder?.freight_term_name || null,
      suggested_amount: freightBillable ? chargeMoney(dispatch?.freight_amount) : 0,
    },
  };
}

async function syncInvoiceChargeLines(client, { invoiceId, goodsLines, packingForwardingAmount, freightAmount }) {
  const existing = await client.query(
    `select id, charge_kind, line_no from invoice_lines where customer_invoice_id = $1 and charge_kind is not null`,
    [invoiceId]
  );
  const byKind = new Map(existing.rows.map((row) => [String(row.charge_kind), row]));
  const maxGoodsLineNo = (goodsLines || []).reduce((max, line) => Math.max(max, Number(line.line_no) || 0), 0);
  let nextLineNo = maxGoodsLineNo + 1;

  async function upsertKind(kind, amount) {
    const payload = buildChargeLinePayload({
      kind,
      amountInvoice: amount,
      goodsLines,
      lineNo: byKind.get(kind)?.line_no || nextLineNo,
    });
    const existingRow = byKind.get(kind);
    if (!payload) {
      if (existingRow) {
        await client.query(`delete from invoice_lines where id = $1 and customer_invoice_id = $2`, [
          existingRow.id,
          invoiceId,
        ]);
      }
      return;
    }
    const amounts = calculateInvoiceLineAmounts([payload])[0];
    if (existingRow) {
      await client.query(
        `
          update invoice_lines
          set item_code = $3,
              item_name = $4,
              line_description = $5,
              hsn_no = $6,
              qty = $7,
              unit_price_base = $8,
              unit_price_invoice = $9,
              gst_pct = $10,
              line_total_base = $11,
              line_total_invoice = $12,
              updated_at = now()
          where id = $1 and customer_invoice_id = $2
        `,
        [
          existingRow.id,
          invoiceId,
          amounts.item_code,
          amounts.item_name,
          amounts.line_description,
          amounts.hsn_no,
          amounts.qty,
          amounts.unit_price_base,
          amounts.unit_price_invoice,
          amounts.gst_pct,
          amounts.line_total_base,
          amounts.line_total_invoice,
        ]
      );
    } else {
      await client.query(
        `
          insert into invoice_lines (
            customer_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
            hsn_no, qty, unit_price_base, unit_price_invoice, gst_pct, line_total_base, line_total_invoice,
            customer_item_code, customer_item_description, charge_kind
          )
          values ($1,null,$2,null,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,null,$13)
        `,
        [
          invoiceId,
          amounts.line_no || nextLineNo,
          amounts.item_code,
          amounts.item_name,
          amounts.line_description,
          amounts.hsn_no,
          amounts.qty,
          amounts.unit_price_base,
          amounts.unit_price_invoice,
          amounts.gst_pct,
          amounts.line_total_base,
          amounts.line_total_invoice,
          amounts.charge_kind,
        ]
      );
      nextLineNo += 1;
    }
  }

  if (packingForwardingAmount !== undefined) {
    await upsertKind("packing_forwarding", packingForwardingAmount);
  }
  if (freightAmount !== undefined) {
    await upsertKind("freight", freightAmount);
  }
}

async function getInvoiceHeaderOrNull(client, invoiceId, distributorId = null, companyId = null) {
  const adjustmentsReady = await isArAdjustmentsReady(client);
  const outstandingExpr = getOutstandingInvoiceExpr({ adjustmentsReady });
  const adjustmentsJoin = getArAdjustmentsJoin({ enabled: adjustmentsReady });
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
        co.company_code,
        c.customer_code,
        c.customer_name,
        c.address_line1,
        c.address_line2,
        c.address_line3,
        c.city as customer_city,
        c.state as customer_state,
        c.pincode as customer_pincode,
        c.gstin as customer_gstin,
        so.so_number,
        so.order_status,
        so.bill_to_name,
        so.bill_to_address,
        so.ship_to_name,
        so.ship_to_address,
        so.end_customer_name,
        so.intercompany_counterparty_company_id,
        so.intercompany_purchase_order_id,
        so.freight_term_id,
        so.p_and_f_term_id,
        ft.term_code as freight_term_code,
        ft.term_name as freight_term_name,
        pf.term_code as p_and_f_term_code,
        pf.term_name as p_and_f_term_name,
        icco.company_code as intercompany_company_code,
        icco.display_name as intercompany_company_name,
        icpi.purchase_invoice_number as intercompany_purchase_invoice_number,
        icpi.company_id as intercompany_purchase_invoice_company_id,
        d.company_name as distributor_name,
        curr.currency_code as invoice_currency_code,
        coalesce(pr.allocated_base, 0) as amount_received_base,
        coalesce(pr.allocated_invoice, 0) as amount_received_invoice,
        coalesce(sr.credit_note_amount, 0) as credit_note_amount,
        ${adjustmentsReady ? `coalesce(adj.adjustment_amount, 0)` : `0::numeric`} as adjustment_amount,
        (ci.grand_total_base - coalesce(pr.allocated_base, 0)) as outstanding_base,
        ${outstandingExpr} as outstanding_invoice
      from customer_invoices ci
      left join companies co on co.id = ci.company_id
      join customers c on c.id = ci.customer_id
      left join sales_orders so on so.id = ci.sales_order_id
      left join freight_terms ft on ft.id = so.freight_term_id
      left join p_and_f_terms pf on pf.id = so.p_and_f_term_id
      left join companies icco on icco.id = so.intercompany_counterparty_company_id
      left join purchase_invoices icpi on icpi.id = ci.intercompany_purchase_invoice_id
      left join distributors d on d.id = ci.distributor_id
      left join currencies curr on curr.id = ci.invoice_currency_id
      left join (
        select
          cra.customer_invoice_id,
          coalesce(sum(cra.allocated_base), 0) as allocated_base,
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
      where ci.id = $1
      ${distributorFilter}
      ${companyFilter}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

function userCanAccessCompanyId(req, companyId) {
  if (!companyId) return false;
  if (req.user?.group_name === "SuperAdmin") return true;
  const companies = Array.isArray(req.user?.companies) ? req.user.companies : [];
  return companies.some((c) => Number(c.company_id) === Number(companyId));
}

async function getIntercompanyVendorPartner(client, buyerCompanyId, sellerCompanyId) {
  const r = await client.query(
    `
      select *
      from intercompany_partners
      where company_id = $1
        and counterparty_company_id = $2
        and vendor_id is not null
        and is_active = true
      order by id asc
      limit 1
    `,
    [Number(buyerCompanyId), Number(sellerCompanyId)]
  );
  return r.rows[0] || null;
}

async function getInvoiceLines(client, invoiceId) {
  const r = await client.query(
    `
      select
        il.*,
        sol.qty as qty_ordered,
        pg.group_name as product_group_name
      from invoice_lines il
      left join sales_order_lines sol on sol.id = il.sales_order_line_id
      left join products p on p.id = il.product_id
      left join product_groups pg on pg.id = p.group_id
      where il.customer_invoice_id = $1
      order by il.line_no asc
    `,
    [invoiceId]
  );
  return r.rows;
}

async function getDispatchForSalesOrderOrNull(client, salesOrderId) {
  const r = await client.query(
    `
      select
        d.id,
        d.dispatch_number,
        d.dispatch_status,
        d.dispatch_date,
        d.transporter_name,
        d.transporter_id,
        d.lr_no,
        d.lr_date,
        d.vehicle_no,
        d.vehicle_type,
        d.transport_mode,
        d.approx_distance_km,
        d.eway_ref,
        d.eway_bill_no,
        d.eway_bill_date,
        d.eway_valid_till,
        d.ship_to_gstin,
        d.dispatch_from_pincode,
        d.ship_to_customer_site_id,
        d.tracking_ref,
        d.freight_amount,
        d.freight_paid_by,
        d.bill_to_name,
        d.bill_to_address,
        d.ship_to_name,
        d.ship_to_address,
        d.consignee_name,
        d.consignee_address,
        d.remarks
      from dispatches d
      where d.sales_order_id = $1
      order by d.id desc
      limit 1
    `,
    [salesOrderId]
  );
  return r.rows[0] || null;
}

function buildDispatchEwaySummary(dispatch) {
  if (!dispatch) return null;
  return {
    dispatch_id: dispatch.id,
    dispatch_number: dispatch.dispatch_number,
    eway_bill_no: dispatch.eway_bill_no || null,
    eway_bill_date: dispatch.eway_bill_date || null,
    eway_valid_till: dispatch.eway_valid_till || null,
    transporter_name: dispatch.transporter_name || null,
    transporter_id: dispatch.transporter_id || null,
    transport_mode: dispatch.transport_mode || null,
    vehicle_no: dispatch.vehicle_no || null,
    vehicle_type: dispatch.vehicle_type || null,
    approx_distance_km: dispatch.approx_distance_km ?? null,
    lr_no: dispatch.lr_no || null,
    lr_date: dispatch.lr_date || null,
  };
}

function safeFileSegment(value) {
  return String(value || "invoice")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

async function getCompanyTemplateOverridePath(client, companyId, templateKey) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  const r = await client.query(
    `
      select a.file_path
      from company_template_overrides cto
      join document_templates dt on dt.id = cto.template_id and dt.is_active = true
      join attachments a on a.id = dt.attachment_id
      where cto.company_id = $1 and cto.template_key = $2 and cto.is_active = true
      order by cto.id desc
      limit 1
    `,
    [cid, templateKey]
  );
  return r.rows[0]?.file_path || null;
}

async function getTemplatePathByKey(client, templateKey) {
  const r = await client.query(
    `
      select a.file_path
      from document_templates dt
      join attachments a on a.id = dt.attachment_id
      where dt.template_key = $1 and dt.is_active = true
      order by dt.version_no desc, dt.id desc
      limit 1
    `,
    [templateKey]
  );
  return r.rows[0]?.file_path || null;
}

async function resolveInvoiceLetterheadBuffer(client, companyId) {
  const letterheadPath =
    (await getCompanyTemplateOverridePath(client, companyId, "QUOTE_LETTERHEAD")) ||
    (await getTemplatePathByKey(client, "QUOTE_LETTERHEAD"));
  if (!letterheadPath || !fs.existsSync(letterheadPath)) return null;
  return fs.readFileSync(letterheadPath);
}

function normalizeOptionalDateValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

router.get("/", requireScreenAction("invoices", "can_view"), async (req, res, next) => {
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
    const customerId = Number(req.query.customer_id);
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.max(Math.floor(limitRaw), 1), 500)
        : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const adjustmentsReady = await isArAdjustmentsReady(pool);
    const outstandingExpr = getOutstandingInvoiceScalarExpr({ adjustmentsReady });

    const params = [];
    const where = [];
    if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
      params.push(Number(distributorId));
      where.push(`ci.distributor_id = $${params.length}`);
    } else {
      params.push(activeCompanyId);
      where.push(`ci.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "invoices")) {
      params.push(Number(req.user.id));
      where.push(`ci.created_by = $${params.length}`);
    }

    if (status) {
      params.push(status);
      where.push(`ci.invoice_status = $${params.length}`);
    }
    if (source === "tally_import" || source === "erp") {
      params.push(source);
      where.push(`coalesce(ci.invoice_source, 'erp') = $${params.length}`);
    }
    if (qText) {
      params.push(`%${qText}%`);
      where.push(
        `(ci.invoice_number ilike $${params.length}
          or c.customer_name ilike $${params.length}
          or so.so_number ilike $${params.length}
          or coalesce(ci.customer_po_number, '') ilike $${params.length}
          or coalesce(so.customer_po_number, so.buyer_po_number, '') ilike $${params.length}
          or exists (
            select 1 from invoice_lines ilq
            where ilq.customer_invoice_id = ci.id
              and (
                coalesce(ilq.customer_item_code, '') ilike $${params.length}
                or coalesce(ilq.item_code, '') ilike $${params.length}
              )
          ))`
      );
    }
    if (Number.isFinite(customerId) && customerId > 0) {
      params.push(customerId);
      where.push(`ci.customer_id = $${params.length}`);
    }
    if (bucket === "outstanding") {
      where.push(`${outstandingExpr} > 0`);
    }
    if (bucket === "overdue") {
      where.push(`${outstandingExpr} > 0`);
      where.push(
        `(current_date - (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date) > 0`
      );
    }
    if (bucket === "post_dispatch_outstanding") {
      where.push(`${outstandingExpr} > 0`);
      where.push(
        `exists (
          select 1
          from dispatches d
          where d.sales_order_id = ci.sales_order_id
            and d.dispatch_status = any($${params.length + 1}::text[])
        )`
      );
      params.push(["dispatched", "delivered"]);
    }
    if (bucket === "ageing_0_30") {
      where.push(`${outstandingExpr} > 0`);
      where.push(
        `greatest((current_date - (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date), 0) <= 30`
      );
    }
    if (bucket === "ageing_31_60") {
      where.push(`${outstandingExpr} > 0`);
      where.push(
        `greatest((current_date - (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date), 0) between 31 and 60`
      );
    }
    if (bucket === "ageing_61_90") {
      where.push(`${outstandingExpr} > 0`);
      where.push(
        `greatest((current_date - (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date), 0) between 61 and 90`
      );
    }
    if (bucket === "ageing_90_plus") {
      where.push(`${outstandingExpr} > 0`);
      where.push(
        `greatest((current_date - (ci.invoice_date + make_interval(days => coalesce(pt.credit_days, 0)))::date), 0) > 90`
      );
    }

    const needsAgeingCalc = Boolean(
      bucket && ["overdue", "ageing_0_30", "ageing_31_60", "ageing_61_90", "ageing_90_plus"].includes(bucket)
    );
    const needsPaymentTerms = needsAgeingCalc;
    const hasAdvancedFilters = Boolean(
      status ||
        source ||
        qText ||
        (Number.isFinite(customerId) && customerId > 0) ||
        bucket ||
        ownRecordsOnly(req, "invoices")
    );

    let listResult;
    if (!hasAdvancedFilters && !isDistributor) {
      const rows = await loadInvoicesForCompanyDesk(pool, activeCompanyId, { limit, offset });
      listResult = { rows, engine: "company_desk" };
    } else {
      listResult = await queryInvoiceListRows(pool, {
        where,
        params,
        limit,
        offset,
        adjustmentsReady,
        outstandingExpr,
        needsPaymentTerms,
        needsAgeingCalc,
        companyId: activeCompanyId,
        allowCompanyForced: !hasAdvancedFilters,
      });
    }
    const r = { rows: listResult.rows };

    const filteredCountRes = await pool.query(
      `
        select count(*)::int as n
        from customer_invoices ci
        left join customers c on c.id = ci.customer_id
        left join sales_orders so on so.id = ci.sales_order_id
        left join payment_terms pt on pt.id = so.payment_term_id
        ${where.length ? `where ${where.join(" and ")}` : ""}
      `,
      params
    );
    const filteredTotal = Number(filteredCountRes.rows[0]?.n || r.rows.length);

    let statusCounts = null;
    let sourceCounts = null;
    try {
      const breakdown = await pool.query(
        `
          select
            coalesce(ci.invoice_status, 'unknown') as status,
            coalesce(ci.invoice_source, 'erp') as source,
            count(*)::int as n
          from customer_invoices ci
          left join customers c on c.id = ci.customer_id
          left join sales_orders so on so.id = ci.sales_order_id
          left join payment_terms pt on pt.id = so.payment_term_id
          ${where.length ? `where ${where.join(" and ")}` : ""}
          group by 1, 2
        `,
        params
      );
      statusCounts = {};
      sourceCounts = {};
      for (const row of breakdown.rows) {
        const n = Number(row.n) || 0;
        statusCounts[row.status] = (statusCounts[row.status] || 0) + n;
        sourceCounts[row.source] = (sourceCounts[row.source] || 0) + n;
      }
    } catch (err) {
      process.stderr.write(`[invoices-list] status breakdown unavailable: ${err.message}\n`);
    }

    const scopeCountRes = await pool.query(
      `select count(*)::int as n from customer_invoices where company_id = $1`,
      [activeCompanyId]
    );
    const companyScope = {
      active_company_id: activeCompanyId,
      db_invoice_count: scopeCountRes.rows[0]?.n ?? 0,
    };

    let diag = null;
    if (!r.rows.length && req.user.group_name === "SuperAdmin" && activeCompanyId) {
      const rawCount = await pool.query(
        `select count(*)::int as n from customer_invoices where company_id = $1`,
        [activeCompanyId]
      );
      const innerSoCount = await pool.query(
        `
          select count(*)::int as n
          from customer_invoices ci
          join customers c on c.id = ci.customer_id
          join sales_orders so on so.id = ci.sales_order_id
          where ci.company_id = $1
        `,
        [activeCompanyId]
      );
      const leftSoCount = await pool.query(
        `
          select count(*)::int as n
          from customer_invoices ci
          join customers c on c.id = ci.customer_id
          left join sales_orders so on so.id = ci.sales_order_id
          where ci.company_id = $1
        `,
        [activeCompanyId]
      );
      diag = {
        active_company_id: activeCompanyId,
        db_invoice_count: rawCount.rows[0]?.n ?? 0,
        list_query_count: r.rows.length,
        list_engine: listResult.engine,
        inner_join_sales_order_count: innerSoCount.rows[0]?.n ?? 0,
        left_join_sales_order_count: leftSoCount.rows[0]?.n ?? 0,
        filters: { status, bucket, source, q: qText, customer_id: customerId || null },
      };
      if (diag.db_invoice_count > 0 && diag.list_query_count === 0) {
        process.stderr.write(`[invoices-list] empty list but company ${activeCompanyId} has ${diag.db_invoice_count} invoices\n`);
      }
    }

    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      invoices: r.rows,
      list_engine: listResult.engine,
      list: {
        total_count: filteredTotal,
        limit,
        offset,
        returned: r.rows.length,
        has_more: offset + r.rows.length < filteredTotal,
        showing_from: filteredTotal === 0 || !r.rows.length ? 0 : offset + 1,
        showing_to: filteredTotal === 0 || !r.rows.length ? 0 : offset + r.rows.length,
        page: Math.floor(offset / limit) + 1,
        page_count: Math.max(1, Math.ceil(filteredTotal / limit) || 1),
        ...(statusCounts ? { status_counts: statusCounts, source_counts: sourceCounts } : {}),
      },
      company_scope: companyScope,
      ...(diag ? { diag } : {}),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/tally-chain-link", requireScreenAction("invoices", "can_edit"), async (req, res, next) => {
  try {
    const activeCompanyId = requireResolvedCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const csvText = typeof req.body?.csv === "string" ? req.body.csv : "";
    const inlineRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    let rows = inlineRows;
    if (!rows) {
      if (!csvText.trim()) return res.status(400).json({ ok: false, error: "CSV_REQUIRED" });
      rows = parseInvoiceChainCsv(csvText);
    }
    if (!rows.length) return res.status(400).json({ ok: false, error: "NO_VALID_ROWS" });

    await pool.query("begin");
    const results = await linkInvoicesToSalesOrders(pool, { companyId: activeCompanyId, rows });
    await pool.query("commit");

    const linked = results.filter((row) => row.ok).length;
    return res.json({
      ok: true,
      linked,
      failed: results.length - linked,
      results,
      template_columns: ["invoice_number", "so_number", "customer_po_number", "customer_po_date", "job_no"],
    });
  } catch (err) {
    try {
      await pool.query("rollback");
    } catch (_rollbackErr) {
      /* ignore */
    }
    if (String(err?.message || "").includes("CSV must include")) {
      return res.status(400).json({ ok: false, error: "INVALID_CSV", detail: err.message });
    }
    return next(err);
  }
});

router.post("/tally-backfill-po", requireScreenAction("invoices", "can_edit"), async (req, res, next) => {
  try {
    const activeCompanyId = requireResolvedCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await pool.query("begin");
    const results = await enrichTallyInvoicesFromStaging(pool, activeCompanyId);
    await pool.query("commit");
    const updated = results.filter((row) => row.ok).length;
    return res.json({ ok: true, updated, failed: results.length - updated, results });
  } catch (err) {
    try {
      await pool.query("rollback");
    } catch (_rollbackErr) {
      /* ignore */
    }
    return next(err);
  }
});

router.post("/tally-enrich-from-file", requireScreenAction("invoices", "can_edit"), upload.single("file"), async (req, res, next) => {
  try {
    const activeCompanyId = requireResolvedCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: "NO_FILE_UPLOADED" });

    await pool.query("begin");
    const summary = await enrichTallyInvoicesFromTallyFile(
      pool,
      activeCompanyId,
      req.file.buffer,
      req.file.originalname || "tally_transactions.xml"
    );
    await pool.query("commit");
    return res.json({ ok: true, ...summary });
  } catch (err) {
    try {
      await pool.query("rollback");
    } catch (_rollbackErr) {
      /* ignore */
    }
    return next(err);
  }
});

router.get("/:id", requireScreenAction("invoices", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const invoice = await getInvoiceHeaderOrNull(pool, id, distributorId, activeCompanyId);
    if (!invoice) return res.status(404).json({ ok: false });
    if (!canAccessInvoice(req, invoice)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, invoice)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const progressLines = invoice.sales_order_id
      ? await buildInvoiceProgressLines(pool, invoice.sales_order_id, { excludeInvoiceId: id })
      : [];
    const progressMap = new Map(progressLines.map((line) => [Number(line.id), line]));
    const lines = enrichInvoiceLines(await getInvoiceLines(pool, id), progressMap);
    const dispatch = await getDispatchForSalesOrderOrNull(pool, invoice.sales_order_id);
    const chargePolicy = buildChargePolicy(invoice, dispatch);
    const charges = summarizeChargesFromLines(lines);
    return res.json({
      ok: true,
      invoice: {
        ...invoice,
        ...charges,
        charge_policy: chargePolicy,
      },
      lines,
      charge_policy: chargePolicy,
      charges,
      dispatch_eway: buildDispatchEwaySummary(dispatch),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/pdf", requireScreenAction("invoices", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const invoice = await getInvoiceHeaderOrNull(pool, id, distributorId, activeCompanyId);
    if (!invoice) return res.status(404).json({ ok: false });
    if (!canAccessInvoice(req, invoice)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, invoice)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const lines = await getInvoiceLines(pool, id);
    const dispatch = await getDispatchForSalesOrderOrNull(pool, invoice.sales_order_id);
    const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(pool, invoice.company_id));
    const letterheadBuffer = await resolveInvoiceLetterheadBuffer(pool, invoice.company_id);
    const hasLetterhead = Boolean(letterheadBuffer);
    const signedQrDataUrl = await signedQrToDataUrl(invoice.signed_qr_code);
    // Print set: 3 single-page copies (Original / Duplicate / Triplicate) merged into one PDF.
    let pdf = await buildTaxInvoicePdfBuffer(
      {
        invoice,
        lines,
        dispatch,
        sellerProfile,
        hasLetterhead,
        letterheadBuffer,
        signedQrDataUrl,
      },
      {
        generateQuotePdfBuffer,
        applyPdfBackground,
        stampPdfPageNumbers,
        mergePdfBuffers,
        countPdfPages,
      }
    );
    const fileName = `${safeFileSegment(invoice.invoice_number || `invoice_${invoice.id}`)}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(pdf);
  } catch (err) {
    return next(err);
  }
});

function mapEinvoiceErrorToResponse(res, err) {
  if (err instanceof EinvoiceValidationError) {
    return res.status(err.status || 400).json({ ok: false, error: err.code || "EINVOICE_VALIDATION_ERROR", detail: err.message });
  }
  if (err instanceof EinvoiceNotFoundError) {
    return res.status(err.status || 404).json({ ok: false, error: err.code || "NOT_FOUND" });
  }
  if (err instanceof EinvoiceNotConfiguredError || (err && err.code === "NOT_CONFIGURED")) {
    return res.status(err.status || 501).json({ ok: false, error: "NOT_CONFIGURED", detail: err.message });
  }
  if (err instanceof GspTransportError || (err && err.name === "GspTransportError")) {
    return res.status(err.status || 502).json({
      ok: false,
      error: err.code || "GSP_ERROR",
      detail: err.message,
      details: err.details || null,
    });
  }
  return null;
}

async function writebackInvoiceAndDispatchEway(
  client,
  {
    invoiceId,
    salesOrderId,
    previousDispatchEwayBillNo,
    ewayBillNo,
    ewayBillDate,
    ewayValidTill,
  }
) {
  const nextNo = emptyToNull(ewayBillNo);
  if (!nextNo) return;

  let dateValue = ewayBillDate || null;
  if (dateValue && String(dateValue).includes("/")) {
    // NIC often returns dd/mm/yyyy
    const [dd, mm, yyyy] = String(dateValue).split(/[\/\-]/);
    if (yyyy && mm && dd) dateValue = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }

  await client.query(
    `
      update customer_invoices
      set eway_bill_no = $2,
          eway_bill_date = coalesce($3::date, eway_bill_date, current_date),
          eway_valid_till = coalesce($4::timestamptz, eway_valid_till),
          updated_at = now()
      where id = $1
    `,
    [invoiceId, nextNo, dateValue, ewayValidTill || null]
  );

  // Sync to linked dispatch without overwriting a desk override that differs from previous.
  const prevNo = emptyToNull(previousDispatchEwayBillNo);
  await client.query(
    `
      update dispatches
      set eway_bill_no = $2,
          eway_ref = $2,
          eway_bill_date = coalesce($3::date, eway_bill_date, current_date),
          eway_valid_till = coalesce($4::timestamptz, eway_valid_till),
          updated_at = now()
      where sales_order_id = $1
        and dispatch_status <> 'cancelled'
        and (
          eway_bill_no is null
          or ($5::text is not null and eway_bill_no = $5)
          or eway_bill_no = $2
        )
    `,
    [Number(salesOrderId), nextNo, dateValue, ewayValidTill || null, prevNo]
  );
}

async function loadInvoiceForEinvoiceRoute(req) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { error: { status: 400, body: { ok: false } } };

  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
  if (isDistributor && !distributorId) {
    return { error: { status: 400, body: { ok: false, error: "DISTRIBUTOR_NOT_LINKED" } } };
  }
  const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
  if (!isDistributor && !activeCompanyId) {
    return { error: { status: 400, body: { ok: false, error: "COMPANY_NOT_SELECTED" } } };
  }

  const invoice = await getInvoiceHeaderOrNull(pool, id, distributorId, activeCompanyId);
  if (!invoice) return { error: { status: 404, body: { ok: false } } };
  if (!canAccessInvoice(req, invoice)) return { error: { status: 403, body: { ok: false, error: "FORBIDDEN" } } };
  if (!canAccessCompanyContext(req, invoice)) {
    return { error: { status: 403, body: { ok: false, error: "COMPANY_CONTEXT_MISMATCH" } } };
  }

  return { id, invoice };
}

router.get("/:id/einvoice/payload", requireScreenAction("invoices", "can_view"), async (req, res, next) => {
  try {
    const loaded = await loadInvoiceForEinvoiceRoute(req);
    if (loaded.error) return res.status(loaded.error.status).json(loaded.error.body);
    const { id, invoice } = loaded;

    const lines = await getInvoiceLines(pool, id);
    const dispatch = await getDispatchForSalesOrderOrNull(pool, invoice.sales_order_id);
    const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(pool, invoice.company_id));

    const payload = buildEinvoicePayload({ invoice, lines, sellerProfile, dispatch, buyer: null });

    await logEinvoiceEvent(pool, {
      companyId: invoice.company_id,
      invoiceId: id,
      eventType: "payload_download",
      requestPayload: null,
      responsePayload: { DocDtls: payload.DocDtls },
      status: "success",
      userId: req.user.id,
    });

    return res.json({ ok: true, payload });
  } catch (err) {
    const mapped = mapEinvoiceErrorToResponse(res, err);
    if (mapped) return mapped;
    return next(err);
  }
});

router.post("/:id/einvoice/irn", requireScreenAction("invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const loaded = await loadInvoiceForEinvoiceRoute(req);
    if (loaded.error) {
      client.release();
      return res.status(loaded.error.status).json(loaded.error.body);
    }
    const { id, invoice } = loaded;
    const body = req.body && typeof req.body === "object" ? req.body : {};

    await client.query("begin");
    const updated = await attachIrnMetadata(client, {
      invoiceId: id,
      companyId: invoice.company_id,
      irn: body.irn,
      ackNo: body.irn_ack_no,
      ackDate: body.irn_ack_date,
      signedQr: body.signed_qr_code,
      signedPayload: body.signed_invoice_payload,
      mode: body.einvoice_mode || "manual",
      userId: req.user.id,
      ewayBillNo: body.eway_bill_no,
      ewayBillDate: body.eway_bill_date,
      ewayValidTill: body.eway_valid_till,
    });
    await client.query("commit");

    const nextInvoice = await getInvoiceHeaderOrNull(pool, id, null, invoice.company_id);
    return res.json({ ok: true, invoice: nextInvoice || updated });
  } catch (err) {
    await client.query("rollback");
    const mapped = mapEinvoiceErrorToResponse(res, err);
    if (mapped) return mapped;
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id/eway", requireScreenAction("invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const invoice = await getInvoiceHeaderOrNull(client, id, distributorId, activeCompanyId);
    if (!invoice) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessInvoice(req, invoice)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, invoice)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const status = String(invoice.invoice_status || "").toLowerCase();
    if (!["issued", "paid"].includes(status)) {
      return res.status(409).json({ ok: false, error: "INVOICE_NOT_ELIGIBLE" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const ewayBillNo = emptyToNull(body.eway_bill_no);
    const ewayBillDate = emptyToNull(body.eway_bill_date);
    const ewayValidTill = emptyToNull(body.eway_valid_till);

    if (ewayBillNo && !isValidEwayBillNo(ewayBillNo)) {
      return res.status(400).json({ ok: false, error: "EWAY_BILL_NO_INVALID" });
    }
    if (ewayBillDate && ewayValidTill) {
      const d0 = new Date(ewayBillDate);
      const d1 = new Date(ewayValidTill);
      if (!Number.isNaN(d0.getTime()) && !Number.isNaN(d1.getTime()) && d1 < d0) {
        return res.status(400).json({ ok: false, error: "EWAY_VALIDITY_INVALID" });
      }
    }

    await client.query("begin");
    const updated = await client.query(
      `
        update customer_invoices
        set eway_bill_no = $2,
            eway_bill_date = $3,
            eway_valid_till = $4,
            updated_at = now()
        where id = $1
        returning *
      `,
      [id, ewayBillNo, ewayBillDate, ewayValidTill]
    );

    await logEinvoiceEvent(client, {
      companyId: invoice.company_id,
      invoiceId: id,
      eventType: "manual_capture",
      requestPayload: {
        eway_bill_no: ewayBillNo,
        eway_bill_date: ewayBillDate,
        eway_valid_till: ewayValidTill,
      },
      responsePayload: { eway_bill_no: ewayBillNo },
      status: "success",
      userId: req.user.id,
    });
    await client.query("commit");

    const nextInvoice = await getInvoiceHeaderOrNull(pool, id, distributorId, activeCompanyId);
    const dispatch = await getDispatchForSalesOrderOrNull(pool, invoice.sales_order_id);
    return res.json({
      ok: true,
      invoice: nextInvoice || updated.rows[0],
      dispatch_eway: buildDispatchEwaySummary(dispatch),
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/eway/generate", requireScreenAction("invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const loaded = await loadInvoiceForEinvoiceRoute(req);
    if (loaded.error) {
      client.release();
      return res.status(loaded.error.status).json(loaded.error.body);
    }
    const { id, invoice } = loaded;
    const status = String(invoice.invoice_status || "").toLowerCase();
    if (!["issued", "paid"].includes(status)) {
      client.release();
      return res.status(409).json({ ok: false, error: "INVOICE_NOT_ELIGIBLE" });
    }

    const lines = await getInvoiceLines(pool, id);
    const dispatch = await getDispatchForSalesOrderOrNull(pool, invoice.sales_order_id);
    const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(pool, invoice.company_id));
    const built = buildEwayGeneratePayload({ invoice, lines, sellerProfile, dispatch, buyer: null });
    if (!built?.payload) {
      client.release();
      return res.status(400).json({ ok: false, error: "EWAY_PAYLOAD_INCOMPLETE" });
    }

    await client.query("begin");
    let result;
    try {
      result = await gspGenerateEwayBill(client, {
        companyId: invoice.company_id,
        mode: built.mode,
        payload: built.payload,
      });
    } catch (err) {
      await logEinvoiceEvent(client, {
        companyId: invoice.company_id,
        invoiceId: id,
        eventType: "eway_generate",
        requestPayload: { mode: built.mode, payload: built.payload },
        responsePayload: err.details || null,
        status: "failed",
        error: err.message,
        userId: req.user.id,
      });
      await client.query("commit");
      const mapped = mapEinvoiceErrorToResponse(res, err);
      if (mapped) return mapped;
      throw err;
    }

    await writebackInvoiceAndDispatchEway(client, {
      invoiceId: id,
      salesOrderId: invoice.sales_order_id,
      previousDispatchEwayBillNo: dispatch?.eway_bill_no || null,
      ewayBillNo: result.ewayBillNo,
      ewayBillDate: result.ewayBillDate,
      ewayValidTill: result.validTill,
    });

    await logEinvoiceEvent(client, {
      companyId: invoice.company_id,
      invoiceId: id,
      eventType: "eway_generate",
      requestPayload: { mode: built.mode, payload: built.payload },
      responsePayload: { eway_bill_no: result.ewayBillNo, mocked: Boolean(result.mocked), raw: result.raw },
      status: "success",
      userId: req.user.id,
    });
    await client.query("commit");

    const nextInvoice = await getInvoiceHeaderOrNull(pool, id, null, invoice.company_id);
    const nextDispatch = await getDispatchForSalesOrderOrNull(pool, invoice.sales_order_id);
    return res.json({
      ok: true,
      invoice: nextInvoice,
      dispatch_eway: buildDispatchEwaySummary(nextDispatch),
      gsp: {
        provider: result.provider,
        mode: result.mode,
        mocked: Boolean(result.mocked),
        eway_bill_no: result.ewayBillNo,
      },
    });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    const mapped = mapEinvoiceErrorToResponse(res, err);
    if (mapped) return mapped;
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/eway/cancel", requireScreenAction("invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const loaded = await loadInvoiceForEinvoiceRoute(req);
    if (loaded.error) {
      client.release();
      return res.status(loaded.error.status).json(loaded.error.body);
    }
    const { id, invoice } = loaded;
    const ewayBillNo = emptyToNull(invoice.eway_bill_no);
    if (!ewayBillNo) {
      client.release();
      return res.status(409).json({ ok: false, error: "NO_EWAY_ON_INVOICE" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const payload = buildEwayCancelPayload({
      ewayBillNo,
      reasonCode: body.reason_code || body.cancelRsnCode || "2",
      remark: body.remark || body.cancelRmrk || "Cancelled from Josh ERP",
    });

    await client.query("begin");
    let result;
    try {
      result = await gspCancelEwayBill(client, { companyId: invoice.company_id, payload });
    } catch (err) {
      await logEinvoiceEvent(client, {
        companyId: invoice.company_id,
        invoiceId: id,
        eventType: "eway_cancel",
        requestPayload: payload,
        responsePayload: err.details || null,
        status: "failed",
        error: err.message,
        userId: req.user.id,
      });
      await client.query("commit");
      const mapped = mapEinvoiceErrorToResponse(res, err);
      if (mapped) return mapped;
      throw err;
    }

    // Clear invoice e-way after successful portal cancel. Do not wipe dispatch if it was desk-overridden to another EBN.
    await client.query(
      `
        update customer_invoices
        set eway_bill_no = null,
            eway_bill_date = null,
            eway_valid_till = null,
            updated_at = now()
        where id = $1
      `,
      [id]
    );
    await client.query(
      `
        update dispatches
        set eway_bill_no = null,
            eway_ref = case when eway_ref = $2 then null else eway_ref end,
            eway_bill_date = null,
            eway_valid_till = null,
            updated_at = now()
        where sales_order_id = $1
          and eway_bill_no = $2
      `,
      [Number(invoice.sales_order_id), ewayBillNo]
    );

    await logEinvoiceEvent(client, {
      companyId: invoice.company_id,
      invoiceId: id,
      eventType: "eway_cancel",
      requestPayload: payload,
      responsePayload: { eway_bill_no: ewayBillNo, mocked: Boolean(result.mocked), raw: result.raw },
      status: "success",
      userId: req.user.id,
    });
    await client.query("commit");

    const nextInvoice = await getInvoiceHeaderOrNull(pool, id, null, invoice.company_id);
    const nextDispatch = await getDispatchForSalesOrderOrNull(pool, invoice.sales_order_id);
    return res.json({
      ok: true,
      invoice: nextInvoice,
      dispatch_eway: buildDispatchEwaySummary(nextDispatch),
      gsp: {
        provider: result.provider,
        mocked: Boolean(result.mocked),
        cancelled: true,
        eway_bill_no: ewayBillNo,
      },
    });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    const mapped = mapEinvoiceErrorToResponse(res, err);
    if (mapped) return mapped;
    return next(err);
  } finally {
    client.release();
  }
});

router.delete("/:id/einvoice/irn", requireScreenAction("invoices", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    // Clearing a filed IRN is sensitive — require can_approve where the role model
    // defines it; otherwise fall back to can_edit.
    if (!hasScreenAction(req, "invoices", "can_approve") && !hasScreenAction(req, "invoices", "can_edit")) {
      client.release();
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const loaded = await loadInvoiceForEinvoiceRoute(req);
    if (loaded.error) {
      client.release();
      return res.status(loaded.error.status).json(loaded.error.body);
    }
    const { id, invoice } = loaded;

    const body = req.body && typeof req.body === "object" ? req.body : {};

    await client.query("begin");
    await clearIrnMetadata(client, {
      invoiceId: id,
      companyId: invoice.company_id,
      reason: body.reason,
      userId: req.user.id,
    });
    await client.query("commit");

    const nextInvoice = await getInvoiceHeaderOrNull(pool, id, null, invoice.company_id);
    return res.json({ ok: true, invoice: nextInvoice });
  } catch (err) {
    await client.query("rollback");
    const mapped = mapEinvoiceErrorToResponse(res, err);
    if (mapped) return mapped;
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/einvoice/generate", requireScreenAction("invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const loaded = await loadInvoiceForEinvoiceRoute(req);
    if (loaded.error) {
      client.release();
      return res.status(loaded.error.status).json(loaded.error.body);
    }
    const { id, invoice } = loaded;
    const status = String(invoice.invoice_status || "").toLowerCase();
    if (!["issued", "paid"].includes(status)) {
      client.release();
      return res.status(409).json({ ok: false, error: "INVOICE_NOT_ELIGIBLE" });
    }
    if (invoice.irn) {
      client.release();
      return res.status(409).json({ ok: false, error: "IRN_ALREADY_PRESENT", detail: "Clear or cancel the existing IRN before regenerating." });
    }

    const lines = await getInvoiceLines(pool, id);
    const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(pool, invoice.company_id));
    const dispatch = await getDispatchForSalesOrderOrNull(pool, invoice.sales_order_id);
    const payload = buildEinvoicePayload({ invoice, lines, sellerProfile, dispatch, buyer: null });

    await client.query("begin");
    let result;
    try {
      result = await gspGenerateIrn(client, { companyId: invoice.company_id, payload });
    } catch (err) {
      await logEinvoiceEvent(client, {
        companyId: invoice.company_id,
        invoiceId: id,
        eventType: "generate",
        requestPayload: { DocDtls: payload?.DocDtls || null },
        responsePayload: err.details || null,
        status: "failed",
        error: err.message,
        userId: req.user.id,
      });
      await client.query("commit");
      const mapped = mapEinvoiceErrorToResponse(res, err);
      if (mapped) return mapped;
      throw err;
    }

    const updated = await attachIrnMetadata(client, {
      invoiceId: id,
      companyId: invoice.company_id,
      irn: result.irn,
      ackNo: result.ackNo,
      ackDate: result.ackDate,
      signedQr: result.signedQr,
      signedPayload: result.signedPayload,
      mode: "gsp",
      userId: req.user.id,
      ewayBillNo: result.ewayBillNo,
      ewayBillDate: result.ewayBillDate,
      ewayValidTill: result.ewayValidTill,
    });

    if (result.ewayBillNo) {
      await writebackInvoiceAndDispatchEway(client, {
        invoiceId: id,
        salesOrderId: invoice.sales_order_id,
        previousDispatchEwayBillNo: dispatch?.eway_bill_no || null,
        ewayBillNo: result.ewayBillNo,
        ewayBillDate: result.ewayBillDate,
        ewayValidTill: result.ewayValidTill,
      });
    }

    await client.query("commit");

    const nextInvoice = await getInvoiceHeaderOrNull(pool, id, null, invoice.company_id);
    const nextDispatch = await getDispatchForSalesOrderOrNull(pool, invoice.sales_order_id);
    return res.json({
      ok: true,
      invoice: nextInvoice || updated,
      dispatch_eway: buildDispatchEwaySummary(nextDispatch),
      gsp: {
        provider: result.provider,
        mocked: Boolean(result.mocked),
        irn: result.irn,
        ack_no: result.ackNo,
      },
    });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    const mapped = mapEinvoiceErrorToResponse(res, err);
    if (mapped) return mapped;
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/einvoice/cancel", requireScreenAction("invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const loaded = await loadInvoiceForEinvoiceRoute(req);
    if (loaded.error) {
      client.release();
      return res.status(loaded.error.status).json(loaded.error.body);
    }
    const { id, invoice } = loaded;
    const irn = emptyToNull(invoice.irn);
    if (!irn) {
      client.release();
      return res.status(409).json({ ok: false, error: "NO_IRN_ON_INVOICE" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const preservedEway = {
      eway_bill_no: invoice.eway_bill_no || null,
      eway_bill_date: invoice.eway_bill_date || null,
      eway_valid_till: invoice.eway_valid_till || null,
    };

    await client.query("begin");
    let result;
    try {
      result = await gspCancelIrn(client, {
        companyId: invoice.company_id,
        payload: {
          Irn: irn,
          CnlRsn: body.reason_code || body.CnlRsn || "1",
          CnlRem: body.remark || body.CnlRem || "Cancelled from Josh ERP",
        },
      });
    } catch (err) {
      await logEinvoiceEvent(client, {
        companyId: invoice.company_id,
        invoiceId: id,
        eventType: "cancel",
        requestPayload: { irn },
        responsePayload: err.details || null,
        status: "failed",
        error: err.message,
        userId: req.user.id,
      });
      await client.query("commit");
      const mapped = mapEinvoiceErrorToResponse(res, err);
      if (mapped) return mapped;
      throw err;
    }

    // clearIrnMetadata intentionally does not touch e-way fields (D2).
    await clearIrnMetadata(client, {
      invoiceId: id,
      companyId: invoice.company_id,
      reason: body.remark || "Cancelled via MasterGST GSP",
      userId: req.user.id,
    });
    await client.query("commit");

    const nextInvoice = await getInvoiceHeaderOrNull(pool, id, null, invoice.company_id);
    return res.json({
      ok: true,
      invoice: nextInvoice,
      preserved_eway: preservedEway,
      gsp: {
        provider: result.provider,
        mocked: Boolean(result.mocked),
        irn: result.irn,
      },
    });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    const mapped = mapEinvoiceErrorToResponse(res, err);
    if (mapped) return mapped;
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/intercompany/create-purchase-invoice", requireScreenAction("invoices", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    if (!req.user?.permissions?.screens?.purchase_invoices?.can_create && req.user?.group_name !== "SuperAdmin") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const invoice = await getInvoiceHeaderOrNull(client, id, distributorId, activeCompanyId);
    if (!invoice) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessInvoice(req, invoice)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, invoice)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (invoice.intercompany_purchase_invoice_id) {
      const piRes = await client.query(
        `select id, purchase_invoice_number, company_id from purchase_invoices where id = $1 limit 1`,
        [invoice.intercompany_purchase_invoice_id]
      );
      const pi = piRes.rows[0] || null;
      if (pi?.company_id && !userCanAccessCompanyId(req, Number(pi.company_id))) {
        return res.status(403).json({ ok: false, error: "INTERCOMPANY_ACCESS_DENIED" });
      }
      return res.json({
        ok: true,
        invoice,
        intercompany_purchase_invoice: pi
          ? { id: pi.id, purchase_invoice_number: pi.purchase_invoice_number, company_id: pi.company_id }
          : { id: invoice.intercompany_purchase_invoice_id, purchase_invoice_number: null, company_id: null },
      });
    }

    const sellerCompanyId = Number(invoice.company_id);
    const buyerCompanyId = Number(invoice.intercompany_counterparty_company_id);
    if (!Number.isFinite(buyerCompanyId) || buyerCompanyId <= 0) {
      return res.status(409).json({ ok: false, error: "INTERCOMPANY_NOT_CONFIGURED" });
    }
    if (!userCanAccessCompanyId(req, buyerCompanyId)) {
      return res.status(403).json({ ok: false, error: "INTERCOMPANY_ACCESS_DENIED" });
    }

    const buyerPartner = await getIntercompanyVendorPartner(client, buyerCompanyId, sellerCompanyId);
    if (!buyerPartner?.vendor_id) {
      return res.status(409).json({ ok: false, error: "INTERCOMPANY_VENDOR_MAPPING_MISSING" });
    }

    const lines = await getInvoiceLines(client, id);
    if (!lines.length) return res.status(400).json({ ok: false, error: "NO_LINES" });

    const normalized = calculateInvoiceLineAmounts(
      lines.map((line) => ({
        line_no: line.line_no,
        product_id: line.product_id,
        item_code: line.item_code,
        item_name: line.item_name,
        line_description: line.line_description,
        hsn_no: line.hsn_no,
        qty: line.qty,
        unit_price_base: line.unit_price_base,
        unit_price_invoice: line.unit_price_invoice,
        gst_pct: line.gst_pct,
      }))
    );
    const totals = calculateInvoiceTotals(normalized);

    await client.query("begin");

    const numRes = await client.query(`select next_company_document_number($1,'PINV') as purchase_invoice_number`, [buyerCompanyId]);
    const purchaseInvoiceNumber = numRes.rows[0]?.purchase_invoice_number;
    if (!purchaseInvoiceNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "NUMBERING_FAILED" });
    }

    const headerRes = await client.query(
      `
        insert into purchase_invoices (
          company_id,
          purchase_invoice_number,
          vendor_id,
          purchase_order_id,
          invoice_status,
          invoice_date,
          vendor_invoice_no,
          base_currency_id,
          invoice_currency_id,
          subtotal_base,
          subtotal_invoice,
          tax_total_base,
          tax_total_invoice,
          grand_total_base,
          grand_total_invoice,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        returning id
      `,
      [
        buyerCompanyId,
        purchaseInvoiceNumber,
        buyerPartner.vendor_id,
        invoice.intercompany_purchase_order_id || null,
        invoice.invoice_date || null,
        invoice.invoice_number || null,
        invoice.base_currency_id,
        invoice.invoice_currency_id,
        totals.subtotal_base,
        totals.subtotal_invoice,
        totals.tax_total_base,
        totals.tax_total_invoice,
        totals.grand_total_base,
        totals.grand_total_invoice,
        `Intercompany from ${invoice.invoice_number}`,
        req.user.id,
      ]
    );
    const purchaseInvoiceId = headerRes.rows[0]?.id;
    if (!purchaseInvoiceId) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "CREATE_FAILED" });
    }

    for (const line of normalized) {
      await client.query(
        `
          insert into purchase_invoice_lines (
            purchase_invoice_id,
            purchase_order_line_id,
            line_no,
            product_id,
            item_code,
            item_name,
            line_description,
            hsn_no,
            uom,
            qty,
            unit_price_base,
            unit_price_invoice,
            gst_pct,
            line_total_base,
            line_total_invoice
          )
          values ($1,null,$2,$3,$4,$5,$6,$7,null,$8,$9,$10,$11,$12,$13)
        `,
        [
          purchaseInvoiceId,
          line.line_no,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.hsn_no || null,
          line.qty,
          line.unit_price_base,
          line.unit_price_invoice,
          line.gst_pct,
          line.line_total_base,
          line.line_total_invoice,
        ]
      );
    }

    await client.query(
      `
        update customer_invoices
        set intercompany_purchase_invoice_id = $1,
            updated_at = now()
        where id = $2
      `,
      [purchaseInvoiceId, id]
    );

    await client.query(
      `
        update purchase_invoices
        set intercompany_customer_invoice_id = $1,
            updated_at = now()
        where id = $2 and company_id = $3
      `,
      [id, purchaseInvoiceId, buyerCompanyId]
    );

    await client.query("commit");

    const nextInvoice = await getInvoiceHeaderOrNull(client, id, distributorId, invoice.company_id);
    return res.status(201).json({
      ok: true,
      invoice: nextInvoice,
      intercompany_purchase_invoice: { id: purchaseInvoiceId, purchase_invoice_number: purchaseInvoiceNumber, company_id: buyerCompanyId },
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/from-sales-order/:id", requireScreenAction("invoices", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const salesOrderId = Number(req.params.id);
    if (!Number.isFinite(salesOrderId)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const order = await getSalesOrderHeader(client, salesOrderId, distributorId, activeCompanyId);
    if (!order) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessSalesOrder(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!["confirmed", "closed"].includes(String(order.order_status || "").trim().toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ORDER_NOT_READY_FOR_INVOICE" });
    }

    const lines = await buildInvoiceProgressLines(client, salesOrderId);
    const creatableLines = lines.filter((line) => qty(line.qty_remaining_invoice) > 0);
    if (!lines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_LINES" });
    }
    if (!creatableLines.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "FULLY_INVOICED" });
    }

    const invoiceLinesPayload = calculateInvoiceLineAmounts(
      creatableLines.map((line) => ({
        ...line,
        qty: line.qty_remaining_invoice,
        unit_price_invoice: line.unit_price_order,
      }))
    );
    const totals = calculateInvoiceTotals(invoiceLinesPayload);

    const companyId = requireResolvedCompanyId(req, order.company_id);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    const numRes = await client.query(`select next_company_document_number($1, 'INV') as invoice_number`, [companyId]);
    const invoiceNumber = numRes.rows[0]?.invoice_number;
    const customerPo = normalizeCustomerPoFields(req.body && typeof req.body === "object" ? req.body : {}, order);
    const headerRes = await client.query(
      `
        insert into customer_invoices (
          invoice_number, company_id, sales_order_id, customer_id, distributor_id, invoice_status, invoice_date,
          base_currency_id, invoice_currency_id, subtotal_base, subtotal_invoice, tax_total_base, tax_total_invoice,
          grand_total_base, grand_total_invoice, attention_to, created_by, customer_po_number, customer_po_date
        )
        values ($1,$2,$3,$4,$5,'draft',current_date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        returning id
      `,
      [
        invoiceNumber,
        companyId,
        salesOrderId,
        order.customer_id,
        order.distributor_id || null,
        order.base_currency_id,
        order.order_currency_id,
        totals.subtotal_base,
        totals.subtotal_invoice,
        totals.tax_total_base,
        totals.tax_total_invoice,
        totals.grand_total_base,
        totals.grand_total_invoice,
        order.attention_to || null,
        req.user.id,
        customerPo.customer_po_number,
        customerPo.customer_po_date,
      ]
    );
    const invoiceId = headerRes.rows[0]?.id;

    for (const line of invoiceLinesPayload) {
      const customerItem = await resolveCustomerItemFields(client, {
        companyId,
        customerId: order.customer_id,
        productId: line.product_id,
        customerItemCode: line.customer_item_code,
        customerItemDescription: line.customer_item_description,
      });

      await client.query(
        `
          insert into invoice_lines (
            customer_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
            hsn_no, qty, unit_price_base, unit_price_invoice, gst_pct, line_total_base, line_total_invoice,
            customer_item_code, customer_item_description, charge_kind
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,null)
        `,
        [
          invoiceId,
          line.id,
          line.line_no,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.hsn_no || null,
          line.qty,
          line.unit_price_base,
          line.unit_price_invoice,
          line.gst_pct,
          line.line_total_base,
          line.line_total_invoice,
          customerItem.customer_item_code,
          customerItem.customer_item_description,
        ]
      );
    }

    const orderTerms = await client.query(
      `
        select
          so.freight_term_id,
          so.p_and_f_term_id,
          ft.term_code as freight_term_code,
          ft.term_name as freight_term_name,
          pf.term_code as p_and_f_term_code,
          pf.term_name as p_and_f_term_name
        from sales_orders so
        left join freight_terms ft on ft.id = so.freight_term_id
        left join p_and_f_terms pf on pf.id = so.p_and_f_term_id
        where so.id = $1
        limit 1
      `,
      [salesOrderId]
    );
    const termRow = orderTerms.rows[0] || {};
    const dispatchSeed = await getDispatchForSalesOrderOrNull(client, salesOrderId);
    const policy = buildChargePolicy(termRow, dispatchSeed);
    if (policy.freight.billable && policy.freight.suggested_amount > 0) {
      await syncInvoiceChargeLines(client, {
        invoiceId,
        goodsLines: invoiceLinesPayload,
        freightAmount: policy.freight.suggested_amount,
      });
      const allLines = await getInvoiceLines(client, invoiceId);
      const nextTotals = calculateInvoiceTotals(allLines);
      await client.query(
        `
          update customer_invoices
          set subtotal_base = $2,
              subtotal_invoice = $3,
              tax_total_base = $4,
              tax_total_invoice = $5,
              grand_total_base = $6,
              grand_total_invoice = $7,
              updated_at = now()
          where id = $1
        `,
        [
          invoiceId,
          nextTotals.subtotal_base,
          nextTotals.subtotal_invoice,
          nextTotals.tax_total_base,
          nextTotals.tax_total_invoice,
          nextTotals.grand_total_base,
          nextTotals.grand_total_invoice,
        ]
      );
    }

    if (dispatchSeed?.eway_bill_no) {
      await client.query(
        `
          update customer_invoices
          set eway_bill_no = $2,
              eway_bill_date = $3,
              eway_valid_till = $4,
              updated_at = now()
          where id = $1
            and eway_bill_no is null
        `,
        [
          invoiceId,
          dispatchSeed.eway_bill_no,
          dispatchSeed.eway_bill_date || null,
          dispatchSeed.eway_valid_till || null,
        ]
      );
    }

    await client.query("commit");
    const invoice = await getInvoiceHeaderOrNull(client, invoiceId, isDistributor ? distributorId : null, companyId);
    const progressLines = await buildInvoiceProgressLines(client, salesOrderId, { excludeInvoiceId: invoiceId });
    const progressMap = new Map(progressLines.map((line) => [Number(line.id), line]));
    const invoiceLines = enrichInvoiceLines(await getInvoiceLines(client, invoiceId), progressMap);
    const dispatch = await getDispatchForSalesOrderOrNull(client, salesOrderId);
    const chargePolicy = buildChargePolicy(invoice || termRow, dispatch);
    const charges = summarizeChargesFromLines(invoiceLines);
    return res.status(201).json({
      ok: true,
      invoice: { ...(invoice || {}), ...charges, charge_policy: chargePolicy },
      lines: invoiceLines,
      charge_policy: chargePolicy,
      charges,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id", requireScreenAction("invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isFinite(invoiceId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const status = typeof body.invoice_status === "string" ? body.invoice_status.trim().toLowerCase() : "draft";
    if (!["draft", "issued", "paid", "cancelled"].includes(status)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }

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

    const requestedLines = Array.isArray(body.lines) ? body.lines : [];
    if (requestedLines.length && invoice.invoice_status !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "INVOICE_NOT_EDITABLE" });
    }

    const wantsCustomerPoUpdate =
      Object.prototype.hasOwnProperty.call(body, "customer_po_number") ||
      Object.prototype.hasOwnProperty.call(body, "customer_po_date") ||
      Object.prototype.hasOwnProperty.call(body, "buyer_po_number") ||
      Object.prototype.hasOwnProperty.call(body, "buyer_po_date");
    if (wantsCustomerPoUpdate) {
      const isTallyImport = String(invoice.invoice_source || "").toLowerCase() === "tally_import";
      if (invoice.invoice_status !== "draft" && !isTallyImport) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "INVOICE_NOT_EDITABLE" });
      }
      const customerPo = normalizeCustomerPoFields(body);
      await client.query(
        `update customer_invoices set customer_po_number = $2, customer_po_date = $3, updated_at = now() where id = $1`,
        [invoiceId, customerPo.customer_po_number, customerPo.customer_po_date]
      );
    }

    if (requestedLines.length) {
      const progressLines = await buildInvoiceProgressLines(client, invoice.sales_order_id, { excludeInvoiceId: invoiceId });
      const progressMap = new Map(progressLines.map((line) => [Number(line.id), line]));
      const currentLines = await getInvoiceLines(client, invoiceId);
      const currentLineMap = new Map(currentLines.map((line) => [Number(line.id), line]));
      const updatedLines = [];

      for (const line of requestedLines) {
        const invoiceLineId = Number(line.id);
        const currentLine = currentLineMap.get(invoiceLineId);
        if (!currentLine) continue;
        if (cleanText(currentLine.charge_kind)) continue; // charge lines updated via charges payload
        const progress = progressMap.get(Number(currentLine.sales_order_line_id));
        const requestedQty = qty(line.qty);
        const remainingQty = qty(progress?.qty_remaining_invoice);
        if (requestedQty < 0 || requestedQty > remainingQty) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_INVOICE_QTY" });
        }
        const hasCustomerItemInput =
          Object.prototype.hasOwnProperty.call(line, "customer_item_code") ||
          Object.prototype.hasOwnProperty.call(line, "customer_item_description");
        const customerItem = await resolveCustomerItemFields(client, {
          companyId: invoice.company_id,
          customerId: invoice.customer_id,
          productId: currentLine.product_id,
          customerItemCode: hasCustomerItemInput ? line.customer_item_code : currentLine.customer_item_code,
          customerItemDescription: hasCustomerItemInput
            ? line.customer_item_description
            : currentLine.customer_item_description,
        });

        updatedLines.push({
          ...currentLine,
          qty: requestedQty,
          customer_item_code: customerItem.customer_item_code,
          customer_item_description: customerItem.customer_item_description,
        });
      }

      if (!updatedLines.some((line) => qty(line.qty) > 0)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "NO_INVOICE_QTY" });
      }

      const normalizedLines = calculateInvoiceLineAmounts(updatedLines);
      for (const line of normalizedLines) {
        await client.query(
          `
            update invoice_lines
            set qty = $2,
                line_total_base = $3,
                line_total_invoice = $4,
                customer_item_code = $6,
                customer_item_description = $7,
                updated_at = now()
            where id = $1 and customer_invoice_id = $5
          `,
          [
            line.id,
            line.qty,
            line.line_total_base,
            line.line_total_invoice,
            invoiceId,
            line.customer_item_code ?? null,
            line.customer_item_description ?? null,
          ]
        );
      }

      const priorCharges = summarizeChargesFromLines(currentLines);
      const chargePolicy = buildChargePolicy(invoice);
      const wantsPf =
        Object.prototype.hasOwnProperty.call(body, "packing_forwarding_amount") ||
        Object.prototype.hasOwnProperty.call(body, "p_and_f_amount");
      const wantsFreight = Object.prototype.hasOwnProperty.call(body, "freight_amount");
      await syncInvoiceChargeLines(client, {
        invoiceId,
        goodsLines: normalizedLines,
        packingForwardingAmount: wantsPf
          ? chargePolicy.packing_forwarding.billable
            ? body.packing_forwarding_amount ?? body.p_and_f_amount
            : 0
          : priorCharges.packing_forwarding_line_id
            ? priorCharges.packing_forwarding_amount
            : undefined,
        freightAmount: wantsFreight
          ? chargePolicy.freight.billable
            ? body.freight_amount
            : 0
          : priorCharges.freight_line_id
            ? priorCharges.freight_amount
            : undefined,
      });

      const allLines = await getInvoiceLines(client, invoiceId);
      const totals = calculateInvoiceTotals(allLines);
      await client.query(
        `
          update customer_invoices
          set invoice_status = $2,
              invoice_date = coalesce($3, invoice_date),
              remarks = $4,
              subtotal_base = $5,
              subtotal_invoice = $6,
              tax_total_base = $7,
              tax_total_invoice = $8,
              grand_total_base = $9,
              grand_total_invoice = $10,
              updated_at = now()
          where id = $1
        `,
        [
          invoiceId,
          status,
          body.invoice_date || null,
          body.remarks || null,
          totals.subtotal_base,
          totals.subtotal_invoice,
          totals.tax_total_base,
          totals.tax_total_invoice,
          totals.grand_total_base,
          totals.grand_total_invoice,
        ]
      );
    } else if (
      Object.prototype.hasOwnProperty.call(body, "packing_forwarding_amount") ||
      Object.prototype.hasOwnProperty.call(body, "p_and_f_amount") ||
      Object.prototype.hasOwnProperty.call(body, "freight_amount")
    ) {
      if (invoice.invoice_status !== "draft") {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "INVOICE_NOT_EDITABLE" });
      }
      const goodsLines = (await getInvoiceLines(client, invoiceId)).filter((line) => !cleanText(line.charge_kind));
      const chargePolicy = buildChargePolicy(invoice);
      const wantsPf =
        Object.prototype.hasOwnProperty.call(body, "packing_forwarding_amount") ||
        Object.prototype.hasOwnProperty.call(body, "p_and_f_amount");
      const wantsFreight = Object.prototype.hasOwnProperty.call(body, "freight_amount");
      await syncInvoiceChargeLines(client, {
        invoiceId,
        goodsLines,
        packingForwardingAmount: wantsPf
          ? chargePolicy.packing_forwarding.billable
            ? body.packing_forwarding_amount ?? body.p_and_f_amount
            : 0
          : undefined,
        freightAmount: wantsFreight ? (chargePolicy.freight.billable ? body.freight_amount : 0) : undefined,
      });
      const allLines = await getInvoiceLines(client, invoiceId);
      const totals = calculateInvoiceTotals(allLines);
      await client.query(
        `
          update customer_invoices
          set invoice_status = $2,
              invoice_date = coalesce($3, invoice_date),
              remarks = $4,
              subtotal_base = $5,
              subtotal_invoice = $6,
              tax_total_base = $7,
              tax_total_invoice = $8,
              grand_total_base = $9,
              grand_total_invoice = $10,
              updated_at = now()
          where id = $1
        `,
        [
          invoiceId,
          status,
          body.invoice_date || null,
          body.remarks || null,
          totals.subtotal_base,
          totals.subtotal_invoice,
          totals.tax_total_base,
          totals.tax_total_invoice,
          totals.grand_total_base,
          totals.grand_total_invoice,
        ]
      );
    } else {
      await client.query(
        `update customer_invoices set invoice_status = $2, invoice_date = coalesce($3, invoice_date), remarks = $4, updated_at = now() where id = $1`,
        [invoiceId, status, body.invoice_date || null, body.remarks || null]
      );
    }

    await client.query("commit");
    const nextInvoice = await getInvoiceHeaderOrNull(client, invoiceId, isDistributor ? distributorId : null, invoice.company_id);
    const nextProgressLines = await buildInvoiceProgressLines(client, invoice.sales_order_id, { excludeInvoiceId: invoiceId });
    const nextProgressMap = new Map(nextProgressLines.map((line) => [Number(line.id), line]));
    const lines = enrichInvoiceLines(await getInvoiceLines(client, invoiceId), nextProgressMap);
    const charges = summarizeChargesFromLines(lines);
    const chargePolicy = buildChargePolicy(nextInvoice || invoice);
    return res.json({
      ok: true,
      invoice: { ...(nextInvoice || invoice), ...charges, charge_policy: chargePolicy },
      lines,
      charge_policy: chargePolicy,
      charges,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
