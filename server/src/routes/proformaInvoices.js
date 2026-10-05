const express = require("express");
const fs = require("fs");

const { pool } = require("../db/pool");
const { ownRecordsOnly, hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, requireResolvedCompanyId } = require("../services/companyContext");
const { getDistributorIdForUser } = require("../services/mailAccounts");
const { applyPdfBackground, generateQuotePdfBuffer, stampPdfPageNumbers, mergePdfBuffers, countPdfPages } = require("../pdf/pdfCore");
const { buildProformaPdfBuffer } = require("../pdf/proformaPdf");
const { enrichCompanyProfileAssets, getCompanyProfile } = require("../services/companyProfile");
const { normalizeCustomerPoFields, resolveCustomerItemFields } = require("../services/customerProductMaps");
const {
  money,
  qty,
  cleanText,
  calculateProformaLineAmounts,
  calculateProformaTotals,
  applyBilledPercent,
  assertMilestoneCoverage,
} = require("../services/proformaMath");

const router = express.Router();

function normalizeOptionalDateValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeFileSegment(value) {
  return String(value || "proforma")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

/**
 * Invoice-side (customer_invoices / invoice_lines) amount helpers, kept local
 * because proformaMath's calculateProformaLineAmounts targets *_proforma columns,
 * not *_invoice — the two schemas diverge on purpose (P0b lock on invoices).
 */
function buildInvoiceLineAmounts(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => {
    const lineQty = qty(line.qty);
    const unitPriceBase = money(line.unit_price_base);
    const unitPriceInvoice = money(line.unit_price_invoice);
    const gstPct = qty(line.gst_pct);
    const lineTotalBase = money(lineQty * unitPriceBase);
    const lineTotalInvoice = money(lineQty * unitPriceInvoice);
    return {
      ...line,
      qty: lineQty,
      unit_price_base: unitPriceBase,
      unit_price_invoice: unitPriceInvoice,
      gst_pct: gstPct,
      line_total_base: lineTotalBase,
      line_total_invoice: lineTotalInvoice,
      tax_total_base: money((lineTotalBase * gstPct) / 100),
      tax_total_invoice: money((lineTotalInvoice * gstPct) / 100),
    };
  });
}

function buildInvoiceTotals(lines) {
  return (Array.isArray(lines) ? lines : []).reduce(
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

function canAccessProforma(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "proforma_invoices")) return true;
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

/** Minimal duplicate of invoices.js's getInvoicedQtyMap — SO qty already tax-invoiced (non-cancelled, goods lines only). */
async function getInvoicedQtyMapForSalesOrder(client, salesOrderId) {
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
      group by il.sales_order_line_id
    `,
    [salesOrderId]
  );
  return new Map(r.rows.map((row) => [Number(row.sales_order_line_id), qty(row.qty_invoiced)]));
}

async function getProformaHeaderOrNull(client, proformaId, distributorId = null, companyId = null) {
  const params = [Number(proformaId)];
  const distributorFilter =
    Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? ` and pi.distributor_id = $2` : "";
  if (distributorFilter) params.push(Number(distributorId));
  const companyFilter =
    Number.isFinite(Number(companyId)) && Number(companyId) > 0 ? ` and pi.company_id = $${params.length + 1}` : "";
  if (companyFilter) params.push(Number(companyId));
  const r = await client.query(
    `
      select
        pi.*,
        co.company_code,
        c.customer_code,
        c.customer_name,
        c.gstin as customer_gstin,
        c.address_line1,
        c.address_line2,
        c.address_line3,
        c.city as customer_city,
        c.state as customer_state,
        c.pincode as customer_pincode,
        so.so_number,
        so.order_status,
        so.bill_to_name,
        so.bill_to_address,
        so.ship_to_name,
        so.ship_to_address,
        so.end_customer_name,
        pm.milestone_name,
        pm.milestone_percent as milestone_percent_master,
        pm.due_date as milestone_due_date,
        pm.status as milestone_status,
        d.company_name as distributor_name,
        curr.currency_code as proforma_currency_code,
        ci.invoice_number as converted_invoice_number,
        ci.invoice_status as converted_invoice_status
      from proforma_invoices pi
      left join companies co on co.id = pi.company_id
      join customers c on c.id = pi.customer_id
      join sales_orders so on so.id = pi.sales_order_id
      left join payment_milestones pm on pm.id = pi.payment_milestone_id
      left join distributors d on d.id = pi.distributor_id
      left join currencies curr on curr.id = pi.proforma_currency_id
      left join customer_invoices ci on ci.id = pi.converted_invoice_id
      where pi.id = $1
      ${distributorFilter}
      ${companyFilter}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

async function getProformaLines(client, proformaId) {
  const r = await client.query(
    `
      select
        pl.*,
        pg.group_name as product_group_name
      from proforma_invoice_lines pl
      left join products p on p.id = pl.product_id
      left join product_groups pg on pg.id = p.group_id
      where pl.proforma_invoice_id = $1
      order by pl.line_no asc
    `,
    [proformaId]
  );
  return r.rows;
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

async function resolveProformaLetterheadBuffer(client, companyId) {
  const letterheadPath =
    (await getCompanyTemplateOverridePath(client, companyId, "QUOTE_LETTERHEAD")) ||
    (await getTemplatePathByKey(client, "QUOTE_LETTERHEAD"));
  if (!letterheadPath || !fs.existsSync(letterheadPath)) return null;
  return fs.readFileSync(letterheadPath);
}

router.get("/", requireScreenAction("proforma_invoices", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const qText = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const customerId = Number(req.query.customer_id);
    const salesOrderId = Number(req.query.sales_order_id);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 0;

    const params = [];
    const where = [];
    if (Number.isFinite(Number(distributorId)) && Number(distributorId) > 0) {
      params.push(Number(distributorId));
      where.push(`pi.distributor_id = $${params.length}`);
    } else {
      params.push(activeCompanyId);
      where.push(`pi.company_id = $${params.length}`);
    }
    if (ownRecordsOnly(req, "proforma_invoices")) {
      params.push(Number(req.user.id));
      where.push(`pi.created_by = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`pi.proforma_status = $${params.length}`);
    }
    if (Number.isFinite(customerId) && customerId > 0) {
      params.push(customerId);
      where.push(`pi.customer_id = $${params.length}`);
    }
    if (Number.isFinite(salesOrderId) && salesOrderId > 0) {
      params.push(salesOrderId);
      where.push(`pi.sales_order_id = $${params.length}`);
    }
    if (qText) {
      params.push(`%${qText}%`);
      where.push(
        `(pi.proforma_number ilike $${params.length}
          or c.customer_name ilike $${params.length}
          or so.so_number ilike $${params.length}
          or coalesce(pi.customer_po_number, '') ilike $${params.length})`
      );
    }

    const r = await pool.query(
      `
        select
          pi.id,
          pi.proforma_number,
          pi.proforma_status,
          pi.proforma_date,
          pi.valid_till,
          pi.billing_basis,
          pi.billed_percent,
          pi.grand_total_proforma,
          pi.converted_invoice_id,
          pi.sales_order_id,
          pi.payment_milestone_id,
          pi.customer_po_number,
          pi.customer_po_date,
          c.customer_name,
          c.id as customer_id,
          so.so_number,
          pm.milestone_name,
          curr.currency_code as proforma_currency_code
        from proforma_invoices pi
        join customers c on c.id = pi.customer_id
        join sales_orders so on so.id = pi.sales_order_id
        left join payment_milestones pm on pm.id = pi.payment_milestone_id
        left join currencies curr on curr.id = pi.proforma_currency_id
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by pi.created_at desc, pi.id desc
        ${limit ? `limit ${limit}` : ""}
      `,
      params
    );

    return res.json({ ok: true, proforma_invoices: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireScreenAction("proforma_invoices", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const proforma = await getProformaHeaderOrNull(pool, id, distributorId, activeCompanyId);
    if (!proforma) return res.status(404).json({ ok: false });
    if (!canAccessProforma(req, proforma)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, proforma)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const lines = await getProformaLines(pool, id);
    const salesOrder = await getSalesOrderHeader(pool, proforma.sales_order_id, distributorId, activeCompanyId);
    const milestone = Number.isFinite(Number(proforma.payment_milestone_id))
      ? (await pool.query(`select * from payment_milestones where id = $1 limit 1`, [proforma.payment_milestone_id])).rows[0] || null
      : null;

    return res.json({ ok: true, proforma_invoice: proforma, lines, sales_order: salesOrder, milestone });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/pdf", requireScreenAction("proforma_invoices", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(pool, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const proforma = await getProformaHeaderOrNull(pool, id, distributorId, activeCompanyId);
    if (!proforma) return res.status(404).json({ ok: false });
    if (!canAccessProforma(req, proforma)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, proforma)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const lines = await getProformaLines(pool, id);
    const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(pool, proforma.company_id));
    const letterheadBuffer = await resolveProformaLetterheadBuffer(pool, proforma.company_id);
    const hasLetterhead = Boolean(letterheadBuffer);

    const pdf = await buildProformaPdfBuffer(
      { proforma, lines, sellerProfile, hasLetterhead, letterheadBuffer },
      { generateQuotePdfBuffer, applyPdfBackground, stampPdfPageNumbers, mergePdfBuffers, countPdfPages }
    );
    const fileName = `${safeFileSegment(proforma.proforma_number || `proforma_${proforma.id}`)}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(pdf);
  } catch (err) {
    return next(err);
  }
});

router.post("/from-quote/:quoteId", requireScreenAction("proforma_invoices", "can_create"), async (req, res, next) => {
  let client = await pool.connect();
  let released = false;
  const releaseClient = () => {
    if (!released) {
      released = true;
      client.release();
    }
  };
  try {
    const quoteId = Number(req.params.quoteId);
    if (!Number.isFinite(quoteId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const billedPercent = qty(body.billed_percent != null ? body.billed_percent : 30);
    if (!(billedPercent > 0)) {
      return res.status(400).json({ ok: false, error: "BILLED_PERCENT_REQUIRED" });
    }

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const quoteRes = await client.query(
      `
        select q.*
        from quote_headers q
        where q.id = $1
          ${Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? "and q.distributor_id = $2" : ""}
        limit 1
      `,
      Number.isFinite(Number(distributorId)) && Number(distributorId) > 0 ? [quoteId, distributorId] : [quoteId]
    );
    const quote = quoteRes.rows[0] || null;
    if (!quote) return res.status(404).json({ ok: false, error: "QUOTE_NOT_FOUND" });
    if (!canAccessCompanyContext(req, quote)) {
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const revisionRes = await client.query(
      `
        select id
        from quote_revisions
        where quote_id = $1 and is_latest = true
        order by revision_no desc
        limit 1
      `,
      [quoteId]
    );
    const revisionId = revisionRes.rows[0]?.id;
    if (!revisionId) return res.status(400).json({ ok: false, error: "NO_REVISION" });

    let salesOrderId = null;
    const existingSo = await client.query(
      `
        select id
        from sales_orders
        where quote_revision_id = $1 and order_status <> 'cancelled'
        order by id desc
        limit 1
      `,
      [revisionId]
    );
    salesOrderId = existingSo.rows[0]?.id ? Number(existingSo.rows[0].id) : null;
    releaseClient();

    if (!salesOrderId) {
      if (!hasScreenAction(req, "sales_orders", "can_create")) {
        return res.status(409).json({ ok: false, error: "SALES_ORDER_REQUIRED" });
      }
      const host = req.get("host");
      if (!host) return res.status(500).json({ ok: false, error: "HOST_REQUIRED" });
      const proto = req.protocol || "http";
      const soRes = await fetch(`${proto}://${host}/sales-orders/from-quote/${quoteId}`, {
        method: "POST",
        headers: {
          cookie: req.headers.cookie || "",
          "content-type": "application/json",
          accept: "application/json",
        },
        body: "{}",
      });
      const soData = await soRes.json().catch(() => null);
      if (!soRes.ok) {
        if (soData?.error === "SALES_ORDER_ALREADY_EXISTS" && soData?.sales_order_id) {
          salesOrderId = Number(soData.sales_order_id);
        } else {
          return res.status(soRes.status || 409).json(soData || { ok: false, error: "SO_CREATE_FAILED" });
        }
      } else {
        salesOrderId = Number(soData?.sales_order?.id || soData?.sales_order_id || soData?.id);
      }
      if (!Number.isFinite(salesOrderId)) {
        return res.status(409).json({ ok: false, error: "SO_CREATE_FAILED" });
      }
    }

    client = await pool.connect();
    released = false;
    await client.query("begin");

    const order = await getSalesOrderHeader(client, salesOrderId, distributorId, activeCompanyId);
    if (!order) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "SALES_ORDER_NOT_FOUND" });
    }
    if (!canAccessSalesOrder(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, order)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!["draft", "confirmed", "closed"].includes(cleanText(order.order_status).toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ORDER_NOT_READY_FOR_PROFORMA" });
    }

    const companyId = requireResolvedCompanyId(req, order.company_id);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const soLines = await getSalesOrderLines(client, salesOrderId);
    if (!soLines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_LINES" });
    }

    const existingForCoverage = await client.query(
      `select billed_percent, proforma_status from proforma_invoices where sales_order_id = $1 and billing_basis in ('milestone','adhoc')`,
      [salesOrderId]
    );
    assertMilestoneCoverage(existingForCoverage.rows, billedPercent);
    const normalizedLines = applyBilledPercent(soLines, billedPercent);
    const totals = calculateProformaTotals(normalizedLines);
    const numRes = await client.query(`select next_company_document_number($1, 'PI') as proforma_number`, [companyId]);
    const proformaNumber = numRes.rows[0]?.proforma_number;
    if (!proformaNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "NUMBERING_FAILED" });
    }

    const customerPo = normalizeCustomerPoFields(body, order);
    const validTill = normalizeOptionalDateValue(body.valid_till);
    const headerRes = await client.query(
      `
        insert into proforma_invoices (
          company_id, proforma_number, sales_order_id, payment_milestone_id, customer_id, distributor_id,
          proforma_status, billing_basis, billed_percent, proforma_date, valid_till,
          customer_po_number, customer_po_date,
          base_currency_id, proforma_currency_id,
          subtotal_base, subtotal_proforma, tax_total_base, tax_total_proforma,
          grand_total_base, grand_total_proforma,
          attention_to, remarks, created_by
        )
        values (
          $1,$2,$3,null,$4,$5,
          'draft','adhoc',$6,current_date,$7,
          $8,$9,
          $10,$11,
          $12,$13,$14,$15,
          $16,$17,
          $18,$19,$20
        )
        returning id
      `,
      [
        companyId,
        proformaNumber,
        salesOrderId,
        order.customer_id,
        order.distributor_id || null,
        billedPercent,
        validTill,
        customerPo.customer_po_number,
        customerPo.customer_po_date,
        order.base_currency_id,
        order.order_currency_id,
        totals.subtotal_base,
        totals.subtotal_proforma,
        totals.tax_total_base,
        totals.tax_total_proforma,
        totals.grand_total_base,
        totals.grand_total_proforma,
        order.attention_to || null,
        cleanText(body.remarks) || null,
        req.user.id,
      ]
    );
    const proformaId = headerRes.rows[0]?.id;
    let lineNo = 1;
    for (const line of normalizedLines) {
      const customerItem = await resolveCustomerItemFields(client, {
        companyId,
        customerId: order.customer_id,
        productId: line.product_id,
        customerItemCode: line.customer_item_code,
        customerItemDescription: line.customer_item_description,
      });
      await client.query(
        `
          insert into proforma_invoice_lines (
            proforma_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
            customer_item_code, customer_item_description, hsn_no, qty,
            unit_price_base, unit_price_proforma, gst_pct, billed_percent,
            line_total_base, line_total_proforma, charge_kind
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,null)
        `,
        [
          proformaId,
          line.id,
          lineNo++,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          customerItem.customer_item_code,
          customerItem.customer_item_description,
          line.hsn_no || null,
          line.qty,
          line.unit_price_base,
          line.unit_price_proforma,
          line.gst_pct,
          line.billed_percent ?? billedPercent,
          line.line_total_base,
          line.line_total_proforma,
        ]
      );
    }

    await client.query("commit");
    const created = await getProformaHeaderOrNull(client, proformaId, distributorId, companyId);
    return res.status(201).json({
      ok: true,
      proforma: created,
      sales_order_id: salesOrderId,
      created_from_quote: true,
    });
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    return next(err);
  } finally {
    releaseClient();
  }
});

router.post("/from-sales-order/:salesOrderId", requireScreenAction("proforma_invoices", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const salesOrderId = Number(req.params.salesOrderId);
    if (!Number.isFinite(salesOrderId)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const billingBasis = cleanText(body.billing_basis).toLowerCase();
    if (!["milestone", "qty", "adhoc"].includes(billingBasis)) {
      return res.status(400).json({ ok: false, error: "INVALID_BILLING_BASIS" });
    }

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
    if (!["confirmed", "closed"].includes(cleanText(order.order_status).toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ORDER_NOT_READY_FOR_PROFORMA" });
    }

    const companyId = requireResolvedCompanyId(req, order.company_id);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const soLines = await getSalesOrderLines(client, salesOrderId);
    if (!soLines.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_LINES" });
    }

    let normalizedLines = [];
    let headerPercent = null;
    let milestoneId = null;

    if (billingBasis === "milestone") {
      milestoneId = Number(body.payment_milestone_id);
      if (!Number.isFinite(milestoneId) || milestoneId <= 0) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "MILESTONE_REQUIRED" });
      }
      const milestoneRes = await client.query(
        `select * from payment_milestones where id = $1 and sales_order_id = $2 limit 1 for update`,
        [milestoneId, salesOrderId]
      );
      const milestone = milestoneRes.rows[0];
      if (!milestone) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "MILESTONE_NOT_FOUND" });
      }
      if (String(milestone.status || "").toLowerCase() === "locked") {
        await client.query("rollback");
        return res.status(409).json({
          ok: false,
          error: "MILESTONE_LOCKED",
          detail: "Commissioning milestone is locked until commissioning ticket is completed with client sign-off.",
        });
      }
      const pct = qty(milestone.milestone_percent);
      if (!(pct > 0)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "MILESTONE_PERCENT_MISSING" });
      }
      const liveExisting = await client.query(
        `select id from proforma_invoices where payment_milestone_id = $1 and proforma_status not in ('cancelled','expired') limit 1`,
        [milestoneId]
      );
      if (liveExisting.rows[0]) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "MILESTONE_ALREADY_HAS_LIVE_PROFORMA" });
      }
      const existingForCoverage = await client.query(
        `select billed_percent, proforma_status from proforma_invoices where sales_order_id = $1 and billing_basis in ('milestone','adhoc')`,
        [salesOrderId]
      );
      assertMilestoneCoverage(existingForCoverage.rows, pct);
      headerPercent = pct;
      normalizedLines = applyBilledPercent(soLines, pct);
    } else if (billingBasis === "adhoc") {
      const pct = qty(body.billed_percent);
      if (!(pct > 0)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "BILLED_PERCENT_REQUIRED" });
      }
      const existingForCoverage = await client.query(
        `select billed_percent, proforma_status from proforma_invoices where sales_order_id = $1 and billing_basis in ('milestone','adhoc')`,
        [salesOrderId]
      );
      assertMilestoneCoverage(existingForCoverage.rows, pct);
      headerPercent = pct;
      normalizedLines = applyBilledPercent(soLines, pct);
    } else {
      const requestedLines = Array.isArray(body.lines) ? body.lines : [];
      if (!requestedLines.length) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "LINES_REQUIRED" });
      }
      const invoicedQtyMap = await getInvoicedQtyMapForSalesOrder(client, salesOrderId);
      const soLineMap = new Map(soLines.map((l) => [Number(l.id), l]));
      const built = [];
      for (const reqLine of requestedLines) {
        const soLineId = Number(reqLine.sales_order_line_id ?? reqLine.id);
        const soLine = soLineMap.get(soLineId);
        if (!soLine) continue;
        const requestedQty = qty(reqLine.qty);
        if (!(requestedQty > 0)) continue;
        const orderedQty = qty(soLine.qty);
        const invoicedQty = qty(invoicedQtyMap.get(soLineId));
        const remainingQty = Math.max(orderedQty - invoicedQty, 0);
        if (requestedQty > remainingQty + 0.0001) {
          await client.query("rollback");
          return res.status(400).json({
            ok: false,
            error: "QTY_EXCEEDS_REMAINING",
            detail: `Line ${soLine.line_no}: requested ${requestedQty} exceeds remaining ${remainingQty}`,
          });
        }
        built.push({
          ...soLine,
          qty: requestedQty,
          unit_price_proforma: soLine.unit_price_order,
          billed_percent: null,
          charge_kind: null,
        });
      }
      if (!built.length) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "NO_VALID_LINES" });
      }
      normalizedLines = calculateProformaLineAmounts(built);
    }

    const totals = calculateProformaTotals(normalizedLines);
    const numRes = await client.query(`select next_company_document_number($1, 'PI') as proforma_number`, [companyId]);
    const proformaNumber = numRes.rows[0]?.proforma_number;
    if (!proformaNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "NUMBERING_FAILED" });
    }

    const customerPo = normalizeCustomerPoFields(body, order);
    const validTill = normalizeOptionalDateValue(body.valid_till);

    const headerRes = await client.query(
      `
        insert into proforma_invoices (
          company_id, proforma_number, sales_order_id, payment_milestone_id, customer_id, distributor_id,
          proforma_status, billing_basis, billed_percent, proforma_date, valid_till,
          customer_po_number, customer_po_date,
          base_currency_id, proforma_currency_id,
          subtotal_base, subtotal_proforma, tax_total_base, tax_total_proforma,
          grand_total_base, grand_total_proforma,
          attention_to, remarks, created_by
        )
        values (
          $1,$2,$3,$4,$5,$6,
          'draft',$7,$8,current_date,$9,
          $10,$11,
          $12,$13,
          $14,$15,$16,$17,
          $18,$19,
          $20,$21,$22
        )
        returning id
      `,
      [
        companyId,
        proformaNumber,
        salesOrderId,
        milestoneId,
        order.customer_id,
        order.distributor_id || null,
        billingBasis,
        headerPercent,
        validTill,
        customerPo.customer_po_number,
        customerPo.customer_po_date,
        order.base_currency_id,
        order.order_currency_id,
        totals.subtotal_base,
        totals.subtotal_proforma,
        totals.tax_total_base,
        totals.tax_total_proforma,
        totals.grand_total_base,
        totals.grand_total_proforma,
        order.attention_to || null,
        cleanText(body.remarks) || null,
        req.user.id,
      ]
    );
    const proformaId = headerRes.rows[0]?.id;

    let lineNo = 1;
    for (const line of normalizedLines) {
      const customerItem = await resolveCustomerItemFields(client, {
        companyId,
        customerId: order.customer_id,
        productId: line.product_id,
        customerItemCode: line.customer_item_code,
        customerItemDescription: line.customer_item_description,
      });
      await client.query(
        `
          insert into proforma_invoice_lines (
            proforma_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
            customer_item_code, customer_item_description, hsn_no, qty,
            unit_price_base, unit_price_proforma, gst_pct, billed_percent,
            line_total_base, line_total_proforma, charge_kind
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,null)
        `,
        [
          proformaId,
          line.id,
          line.line_no || lineNo,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          customerItem.customer_item_code,
          customerItem.customer_item_description,
          line.hsn_no || null,
          line.qty,
          line.unit_price_base,
          line.unit_price_proforma,
          line.gst_pct,
          line.billed_percent ?? null,
          line.line_total_base,
          line.line_total_proforma,
        ]
      );
      lineNo += 1;
    }

    await client.query("commit");

    const proforma = await getProformaHeaderOrNull(client, proformaId, isDistributor ? distributorId : null, companyId);
    const lines = await getProformaLines(client, proformaId);
    return res.status(201).json({ ok: true, proforma_invoice: proforma, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id", requireScreenAction("proforma_invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const proformaRes = await client.query(`select * from proforma_invoices where id = $1 limit 1 for update`, [id]);
    const proforma = proformaRes.rows[0];
    if (!proforma) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessProforma(req, proforma)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, proforma)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (isDistributor && Number(proforma.distributor_id) !== Number(distributorId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const currentStatus = cleanText(proforma.proforma_status).toLowerCase();
    const requestedLines = Array.isArray(body.lines) ? body.lines : [];
    const wantsPercentUpdate =
      Object.prototype.hasOwnProperty.call(body, "billed_percent") && ["milestone", "adhoc"].includes(proforma.billing_basis);

    if ((requestedLines.length || wantsPercentUpdate) && currentStatus !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "PROFORMA_NOT_EDITABLE" });
    }

    if (requestedLines.length && proforma.billing_basis === "qty") {
      const soLines = await getSalesOrderLines(client, proforma.sales_order_id);
      const soLineMap = new Map(soLines.map((l) => [Number(l.id), l]));
      const invoicedQtyMap = await getInvoicedQtyMapForSalesOrder(client, proforma.sales_order_id);
      const currentLines = await getProformaLines(client, id);
      const currentLineMap = new Map(currentLines.map((l) => [Number(l.id), l]));
      const built = [];
      for (const reqLine of requestedLines) {
        const plId = Number(reqLine.id);
        const currentLine = currentLineMap.get(plId);
        if (!currentLine) continue;
        const soLine = soLineMap.get(Number(currentLine.sales_order_line_id));
        if (!soLine) continue;
        const requestedQty = qty(reqLine.qty);
        if (!(requestedQty > 0)) continue;
        const orderedQty = qty(soLine.qty);
        const invoicedQty = qty(invoicedQtyMap.get(Number(soLine.id)));
        const remainingQty = Math.max(orderedQty - invoicedQty, 0);
        if (requestedQty > remainingQty + 0.0001) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "QTY_EXCEEDS_REMAINING" });
        }
        built.push({
          ...currentLine,
          qty: requestedQty,
          unit_price_base: soLine.unit_price_base,
          unit_price_proforma: soLine.unit_price_order,
        });
      }
      if (!built.length) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "NO_VALID_LINES" });
      }
      const normalized = calculateProformaLineAmounts(built);
      for (const line of normalized) {
        await client.query(
          `
            update proforma_invoice_lines
            set qty = $2, unit_price_base = $3, unit_price_proforma = $4,
                line_total_base = $5, line_total_proforma = $6, updated_at = now()
            where id = $1 and proforma_invoice_id = $7
          `,
          [line.id, line.qty, line.unit_price_base, line.unit_price_proforma, line.line_total_base, line.line_total_proforma, id]
        );
      }
    } else if (wantsPercentUpdate) {
      const pct = qty(body.billed_percent);
      if (!(pct > 0)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "BILLED_PERCENT_REQUIRED" });
      }
      const soLines = await getSalesOrderLines(client, proforma.sales_order_id);
      const existingForCoverage = await client.query(
        `select billed_percent, proforma_status from proforma_invoices where sales_order_id = $1 and billing_basis in ('milestone','adhoc') and id <> $2`,
        [proforma.sales_order_id, id]
      );
      assertMilestoneCoverage(existingForCoverage.rows, pct);
      const normalized = applyBilledPercent(soLines, pct);
      await client.query(`delete from proforma_invoice_lines where proforma_invoice_id = $1`, [id]);
      let lineNo = 1;
      for (const line of normalized) {
        const customerItem = await resolveCustomerItemFields(client, {
          companyId: proforma.company_id,
          customerId: proforma.customer_id,
          productId: line.product_id,
          customerItemCode: line.customer_item_code,
          customerItemDescription: line.customer_item_description,
        });
        await client.query(
          `
            insert into proforma_invoice_lines (
              proforma_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
              customer_item_code, customer_item_description, hsn_no, qty,
              unit_price_base, unit_price_proforma, gst_pct, billed_percent,
              line_total_base, line_total_proforma, charge_kind
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,null)
          `,
          [
            id,
            line.id,
            line.line_no || lineNo,
            line.product_id || null,
            line.item_code || null,
            line.item_name || null,
            line.line_description || null,
            customerItem.customer_item_code,
            customerItem.customer_item_description,
            line.hsn_no || null,
            line.qty,
            line.unit_price_base,
            line.unit_price_proforma,
            line.gst_pct,
            line.billed_percent ?? null,
            line.line_total_base,
            line.line_total_proforma,
          ]
        );
        lineNo += 1;
      }
      await client.query(`update proforma_invoices set billed_percent = $2 where id = $1`, [id, pct]);
    }

    if (requestedLines.length || wantsPercentUpdate) {
      const allLines = await getProformaLines(client, id);
      const totals = calculateProformaTotals(allLines);
      await client.query(
        `
          update proforma_invoices
          set subtotal_base = $2, subtotal_proforma = $3, tax_total_base = $4, tax_total_proforma = $5,
              grand_total_base = $6, grand_total_proforma = $7, updated_at = now()
          where id = $1
        `,
        [id, totals.subtotal_base, totals.subtotal_proforma, totals.tax_total_base, totals.tax_total_proforma, totals.grand_total_base, totals.grand_total_proforma]
      );
    }

    const wantsMetaUpdate =
      Object.prototype.hasOwnProperty.call(body, "valid_till") ||
      Object.prototype.hasOwnProperty.call(body, "remarks") ||
      Object.prototype.hasOwnProperty.call(body, "customer_po_number") ||
      Object.prototype.hasOwnProperty.call(body, "customer_po_date") ||
      Object.prototype.hasOwnProperty.call(body, "buyer_po_number") ||
      Object.prototype.hasOwnProperty.call(body, "buyer_po_date");
    if (wantsMetaUpdate) {
      if (currentStatus !== "draft") {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "PROFORMA_NOT_EDITABLE" });
      }
      const customerPo = normalizeCustomerPoFields(body, proforma);
      await client.query(
        `
          update proforma_invoices
          set customer_po_number = $2, customer_po_date = $3, valid_till = $4, remarks = $5, updated_at = now()
          where id = $1
        `,
        [
          id,
          customerPo.customer_po_number,
          customerPo.customer_po_date,
          Object.prototype.hasOwnProperty.call(body, "valid_till") ? normalizeOptionalDateValue(body.valid_till) : proforma.valid_till,
          Object.prototype.hasOwnProperty.call(body, "remarks") ? cleanText(body.remarks) || null : proforma.remarks,
        ]
      );
    }

    const wantsStatus = Object.prototype.hasOwnProperty.call(body, "proforma_status");
    if (wantsStatus) {
      const nextStatus = cleanText(body.proforma_status).toLowerCase();
      if (!["draft", "issued", "cancelled"].includes(nextStatus)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
      }
      if (nextStatus !== currentStatus) {
        if (["converted", "adjusted", "expired"].includes(currentStatus)) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "PROFORMA_LOCKED" });
        }
        if (nextStatus === "issued") {
          if (currentStatus !== "draft") {
            await client.query("rollback");
            return res.status(409).json({ ok: false, error: "INVALID_TRANSITION" });
          }
          await client.query(
            `update proforma_invoices set proforma_status = 'issued', issued_at = now(), issued_by = $2, updated_at = now() where id = $1`,
            [id, req.user.id]
          );
        } else if (nextStatus === "cancelled") {
          if (!["draft", "issued"].includes(currentStatus)) {
            await client.query("rollback");
            return res.status(409).json({ ok: false, error: "INVALID_TRANSITION" });
          }
          await client.query(
            `
              update proforma_invoices
              set proforma_status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now()
              where id = $1
            `,
            [id, req.user.id, cleanText(body.cancel_reason) || null]
          );
        }
      }
    }

    await client.query("commit");

    const updated = await getProformaHeaderOrNull(client, id, isDistributor ? distributorId : null, proforma.company_id);
    const lines = await getProformaLines(client, id);
    return res.json({ ok: true, proforma_invoice: updated, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/convert-to-invoice", requireScreenAction("proforma_invoices", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(client, req.user.id) : null;
    if (isDistributor && !distributorId) return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    const activeCompanyId = isDistributor ? null : requireResolvedCompanyId(req);
    if (!isDistributor && !activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    if (!req.user?.permissions?.screens?.invoices?.can_create && req.user?.group_name !== "SuperAdmin") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    await client.query("begin");

    const proformaRes = await client.query(`select * from proforma_invoices where id = $1 limit 1 for update`, [id]);
    const proforma = proformaRes.rows[0];
    if (!proforma) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessProforma(req, proforma)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, proforma)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (isDistributor && Number(proforma.distributor_id) !== Number(distributorId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const status = cleanText(proforma.proforma_status).toLowerCase();
    if (!["issued", "adjusted", "converted"].includes(status)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "PROFORMA_NOT_CONVERTIBLE" });
    }
    if (proforma.converted_invoice_id) {
      // Already converted directly, or superseded ("adjusted") by a sibling conversion — idempotent 200.
      const existingInvoiceRes = await client.query(
        `select id, invoice_number, invoice_status from customer_invoices where id = $1 limit 1`,
        [proforma.converted_invoice_id]
      );
      await client.query("commit");
      return res.status(200).json({
        ok: true,
        already_converted: true,
        invoice: existingInvoiceRes.rows[0] || null,
        proforma_invoice: proforma,
      });
    }

    const order = await getSalesOrderHeader(client, proforma.sales_order_id, distributorId, activeCompanyId);
    if (!order) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "SALES_ORDER_NOT_FOUND" });
    }

    const soLines = await getSalesOrderLines(client, proforma.sales_order_id);
    const soLineMap = new Map(soLines.map((l) => [Number(l.id), l]));
    const invoicedQtyMap = await getInvoicedQtyMapForSalesOrder(client, proforma.sales_order_id);

    const invoiceLinesInput = [];
    if (proforma.billing_basis === "milestone" || proforma.billing_basis === "adhoc") {
      // Product rule: milestone/adhoc PI converts to a tax invoice for FULL remaining SO qty at FULL SO prices.
      for (const soLine of soLines) {
        const orderedQty = qty(soLine.qty);
        const invoicedQty = qty(invoicedQtyMap.get(Number(soLine.id)));
        const remainingQty = Math.max(orderedQty - invoicedQty, 0);
        if (remainingQty <= 0) continue;
        invoiceLinesInput.push({
          ...soLine,
          qty: remainingQty,
          unit_price_invoice: soLine.unit_price_order,
        });
      }
    } else {
      // Product rule: qty-basis converts 1:1 for those qtys (prices from SO).
      const piLines = await getProformaLines(client, id);
      for (const piLine of piLines) {
        if (cleanText(piLine.charge_kind)) continue;
        const soLine = soLineMap.get(Number(piLine.sales_order_line_id));
        if (!soLine) continue;
        const orderedQty = qty(soLine.qty);
        const invoicedQty = qty(invoicedQtyMap.get(Number(soLine.id)));
        const remainingQty = Math.max(orderedQty - invoicedQty, 0);
        const lineQty = Math.min(qty(piLine.qty), remainingQty);
        if (lineQty <= 0) continue;
        invoiceLinesInput.push({
          ...soLine,
          qty: lineQty,
          unit_price_invoice: soLine.unit_price_order,
        });
      }
    }

    if (!invoiceLinesInput.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NOTHING_TO_INVOICE" });
    }

    const normalizedInvoiceLines = buildInvoiceLineAmounts(invoiceLinesInput);
    const totals = buildInvoiceTotals(normalizedInvoiceLines);

    const companyId = requireResolvedCompanyId(req, order.company_id) || proforma.company_id;
    const numRes = await client.query(`select next_company_document_number($1, 'INV') as invoice_number`, [companyId]);
    const invoiceNumber = numRes.rows[0]?.invoice_number;
    if (!invoiceNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "NUMBERING_FAILED" });
    }

    const customerPo = normalizeCustomerPoFields({}, order);
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
        proforma.sales_order_id,
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
    if (!invoiceId) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "CREATE_FAILED" });
    }

    for (const line of normalizedInvoiceLines) {
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

    // NOTE: Packing & Forwarding / Freight charge lines are intentionally NOT synced here.
    // syncInvoiceChargeLines() lives in invoices.js and is not exported; duplicating its
    // upsert-by-kind logic here would risk drifting out of sync with the source of truth.
    // Charges can be added afterwards via PUT /invoices/:id on the resulting draft invoice.

    await client.query(
      `update proforma_invoices set proforma_status = 'converted', converted_invoice_id = $2, converted_at = now(), converted_by = $3, updated_at = now() where id = $1`,
      [id, invoiceId, req.user.id]
    );

    let adjustedSiblingIds = [];
    let affectedMilestoneIds = [];
    if (proforma.billing_basis === "milestone" || proforma.billing_basis === "adhoc") {
      // Full remaining SO qty is now invoiced — any other still-issued PI on this SO is superseded.
      const siblingsRes = await client.query(
        `
          select id, payment_milestone_id
          from proforma_invoices
          where sales_order_id = $1
            and id <> $2
            and proforma_status = 'issued'
          for update
        `,
        [proforma.sales_order_id, id]
      );
      adjustedSiblingIds = siblingsRes.rows.map((r) => Number(r.id));
      if (adjustedSiblingIds.length) {
        await client.query(
          `update proforma_invoices set proforma_status = 'adjusted', converted_invoice_id = $2, converted_at = now(), converted_by = $3, updated_at = now() where id = any($1::int[])`,
          [adjustedSiblingIds, invoiceId, req.user.id]
        );
      }
      affectedMilestoneIds = siblingsRes.rows
        .map((r) => r.payment_milestone_id)
        .filter((v) => Number.isFinite(Number(v)) && Number(v) > 0);
    }
    if (Number.isFinite(Number(proforma.payment_milestone_id)) && Number(proforma.payment_milestone_id) > 0) {
      affectedMilestoneIds.push(Number(proforma.payment_milestone_id));
    }
    affectedMilestoneIds = Array.from(new Set(affectedMilestoneIds.map(Number)));
    if (affectedMilestoneIds.length) {
      await client.query(`update payment_milestones set status = 'billed', updated_at = now() where id = any($1::int[])`, [
        affectedMilestoneIds,
      ]);
    }

    await client.query("commit");

    const updatedProforma = await getProformaHeaderOrNull(client, id, isDistributor ? distributorId : null, companyId);
    const invoiceRes = await client.query(`select id, invoice_number, invoice_status from customer_invoices where id = $1`, [invoiceId]);
    return res.status(201).json({
      ok: true,
      proforma_invoice: updatedProforma,
      invoice: invoiceRes.rows[0] || null,
      adjusted_sibling_ids: adjustedSiblingIds,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
