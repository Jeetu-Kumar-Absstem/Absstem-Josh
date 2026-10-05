/**
 * QA flow: AI quote Q26000037 → SO (50:50 / ADV50) → 2 Proforma Invoices → Tax Invoice → PDF
 *
 * Run inside API container:
 *   node scripts/qa_quote_q26000037_to_invoice.js
 *
 * Optional:
 *   QA_QUOTE_NUMBER=Q26000037
 *   QA_COMPANY_CODE=AI
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db/pool");
const { applyPdfBackground, generateQuotePdfBuffer, stampPdfPageNumbers, mergePdfBuffers, countPdfPages } = require("../src/pdf/pdfCore");
const { buildTaxInvoicePdfBuffer } = require("../src/pdf/invoicePdf");
const { enrichCompanyProfileAssets, getCompanyProfile } = require("../src/services/companyProfile");
const { resolveCustomerItemFields, normalizeCustomerPoFields } = require("../src/services/customerProductMaps");
const { applyBilledPercent, calculateProformaTotals } = require("../src/services/proformaMath");

const QUOTE_NUMBER = String(process.env.QA_QUOTE_NUMBER || "Q26000037").trim();
const COMPANY_CODE = String(process.env.QA_COMPANY_CODE || "AI").trim().toUpperCase();
const OUT_DIR =
  process.env.QA_OUT_DIR ||
  path.join(__dirname, "..", "storage", "qa-invoice-pdfs", new Date().toISOString().slice(0, 10));

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(2));
}

function safeFileSegment(value) {
  return String(value || "invoice")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function calculateInvoiceLineAmounts(lines) {
  return (lines || []).map((line) => {
    const invoiceQty = qty(line.qty);
    const unitPriceBase = money(line.unit_price_base);
    const unitPriceInvoice = money(line.unit_price_invoice);
    const gstPct = qty(line.gst_pct);
    const lineTotalBase = money(invoiceQty * unitPriceBase);
    const lineTotalInvoice = money(invoiceQty * unitPriceInvoice);
    return {
      ...line,
      qty: invoiceQty,
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

function calculateInvoiceTotals(lines) {
  return (lines || []).reduce(
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

async function tableExists(client, tableName) {
  const r = await client.query(`select to_regclass($1) is not null as ok`, [`public.${tableName}`]);
  return Boolean(r.rows[0]?.ok);
}

async function columnExists(client, tableName, columnName) {
  const r = await client.query(
    `
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
        and column_name = $2
      limit 1
    `,
    [tableName, columnName]
  );
  return Boolean(r.rows[0]);
}

async function resolveQaUserId(client) {
  const r = await client.query(
    `
      select u.id
      from erp_users u
      join user_groups g on g.id = u.group_id
      where g.group_name = 'SuperAdmin'
      order by u.id asc
      limit 1
    `
  );
  return r.rows[0]?.id || null;
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

async function resolveInvoiceLetterheadBuffer(client, companyId) {
  const letterheadPath =
    (await getCompanyTemplateOverridePath(client, companyId, "QUOTE_LETTERHEAD")) ||
    (await getTemplatePathByKey(client, "QUOTE_LETTERHEAD"));
  if (!letterheadPath || !fs.existsSync(letterheadPath)) return null;
  return fs.readFileSync(letterheadPath);
}

async function findQuote(client) {
  const r = await client.query(
    `
      select
        qh.*,
        co.company_code,
        c.customer_name,
        c.gstin as customer_gstin,
        c.address_line1,
        c.address_line2,
        c.address_line3,
        c.city,
        c.state,
        c.pincode
      from quote_headers qh
      join companies co on co.id = qh.company_id
      join customers c on c.id = qh.customer_id
      where upper(co.company_code) = $1
        and (
          qh.quote_number = $2
          or qh.quote_number ilike '%' || regexp_replace($2, '[^0-9]', '', 'g') || '%'
        )
      order by
        case when qh.quote_number = $2 then 0 else 1 end,
        qh.id desc
      limit 1
    `,
    [COMPANY_CODE, QUOTE_NUMBER]
  );
  return r.rows[0] || null;
}

async function getLatestIssuedRevision(client, quoteId) {
  const r = await client.query(
    `
      select *
      from quote_revisions
      where quote_id = $1
        and is_latest = true
      order by revision_no desc
      limit 1
    `,
    [quoteId]
  );
  return r.rows[0] || null;
}

async function ensureAdv50Term(client) {
  await client.query(
    `
      insert into payment_terms (term_code, term_name, credit_days, is_active)
      values ('ADV50', '50% Advance, Balance Against PI', null, true)
      on conflict (term_code) do update
        set term_name = excluded.term_name,
            is_active = true
    `
  );
  const r = await client.query(`select id, term_code, term_name from payment_terms where term_code = 'ADV50' limit 1`);
  return r.rows[0] || null;
}

async function createSalesOrderFromQuote(client, quote, revision, lines, userId, paymentTermId) {
  const customerPo = normalizeCustomerPoFields(
    {
      customer_po_number: quote.customer_po_number || quote.buyer_po_number || `QA-PO-${QUOTE_NUMBER}`,
      customer_po_date: quote.customer_po_date || quote.buyer_po_date || new Date().toISOString().slice(0, 10),
    },
    quote
  );

  const billToName = quote.bill_to_name || quote.customer_name;
  const billToAddress =
    quote.bill_to_address ||
    [quote.address_line1, quote.address_line2, quote.address_line3, quote.city, quote.state, quote.pincode]
      .map((v) => String(v || "").trim())
      .filter(Boolean)
      .join(", ");
  const shipToName = quote.ship_to_name || billToName;
  const shipToAddress = quote.ship_to_address || billToAddress;

  const hasCustomerPoCols = await columnExists(client, "sales_orders", "customer_po_number");
  const numRes = await client.query(`select next_company_document_number($1, 'SO') as so_number`, [quote.company_id]);
  const soNumber = numRes.rows[0]?.so_number;

  let orderRes;
  if (hasCustomerPoCols) {
    orderRes = await client.query(
      `
        insert into sales_orders (
          so_number, company_id, quote_revision_id, customer_id, distributor_id, order_status,
          base_currency_id, order_currency_id, order_date,
          subtotal_base, subtotal_order, tax_total_base, tax_total_order, grand_total_base, grand_total_order,
          created_by, attention_to, incoterm_id, payment_term_id, freight_term_id, terms_snapshot,
          order_flow, fulfillment_mode,
          buyer_po_number, buyer_po_date, customer_po_number, customer_po_date,
          bill_to_name, bill_to_address, ship_to_name, ship_to_address
        )
        values (
          $1,$2,$3,$4,$5,'draft',
          $6,$7,current_date,
          $8,$9,$10,$11,$12,$13,
          $14,$15,$16,$17,$18,'[]',
          $19,$20,
          $21,$22,$23,$24,
          $25,$26,$27,$28
        )
        returning id, so_number
      `,
      [
        soNumber,
        quote.company_id,
        revision.id,
        quote.customer_id,
        quote.distributor_id || null,
        revision.base_currency_id,
        revision.quote_currency_id,
        revision.subtotal_base,
        revision.subtotal_quote,
        revision.tax_total_base,
        revision.tax_total_quote,
        revision.grand_total_base,
        revision.grand_total_quote,
        userId,
        quote.attention_to || null,
        revision.incoterm_id || null,
        paymentTermId,
        revision.freight_term_id || null,
        quote.distributor_id ? "distributor" : "direct",
        quote.distributor_id ? "stock_sale" : "direct_customer",
        customerPo.customer_po_number,
        customerPo.customer_po_date,
        customerPo.customer_po_number,
        customerPo.customer_po_date,
        billToName,
        billToAddress,
        shipToName,
        shipToAddress,
      ]
    );
  } else {
    orderRes = await client.query(
      `
        insert into sales_orders (
          so_number, company_id, quote_revision_id, customer_id, distributor_id, order_status,
          base_currency_id, order_currency_id, order_date,
          subtotal_base, subtotal_order, tax_total_base, tax_total_order, grand_total_base, grand_total_order,
          created_by, attention_to, incoterm_id, payment_term_id, freight_term_id, terms_snapshot,
          order_flow, fulfillment_mode,
          buyer_po_number, buyer_po_date,
          bill_to_name, bill_to_address, ship_to_name, ship_to_address
        )
        values (
          $1,$2,$3,$4,$5,'draft',
          $6,$7,current_date,
          $8,$9,$10,$11,$12,$13,
          $14,$15,$16,$17,$18,'[]',
          $19,$20,
          $21,$22,
          $23,$24,$25,$26
        )
        returning id, so_number
      `,
      [
        soNumber,
        quote.company_id,
        revision.id,
        quote.customer_id,
        quote.distributor_id || null,
        revision.base_currency_id,
        revision.quote_currency_id,
        revision.subtotal_base,
        revision.subtotal_quote,
        revision.tax_total_base,
        revision.tax_total_quote,
        revision.grand_total_base,
        revision.grand_total_quote,
        userId,
        quote.attention_to || null,
        revision.incoterm_id || null,
        paymentTermId,
        revision.freight_term_id || null,
        quote.distributor_id ? "distributor" : "direct",
        quote.distributor_id ? "stock_sale" : "direct_customer",
        customerPo.customer_po_number,
        customerPo.customer_po_date,
        billToName,
        billToAddress,
        shipToName,
        shipToAddress,
      ]
    );
  }

  const salesOrderId = orderRes.rows[0].id;
  const hasLineCustomerItem = await columnExists(client, "sales_order_lines", "customer_item_code");

  for (const line of lines) {
    const customerItem = hasLineCustomerItem
      ? await resolveCustomerItemFields(client, {
          companyId: quote.company_id,
          customerId: quote.customer_id,
          productId: line.product_id,
          customerItemCode: line.customer_item_code,
          customerItemDescription: line.customer_item_description,
        })
      : { customer_item_code: null, customer_item_description: null };

    if (hasLineCustomerItem && !customerItem.customer_item_code) {
      customerItem.customer_item_code = `SAP-${String(line.item_code || line.product_id || line.line_no || "ITEM").slice(0, 24)}`;
      customerItem.customer_item_description = `Customer material for ${line.item_name || line.item_code || "line"}`;
    }

    if (hasLineCustomerItem) {
      await client.query(
        `
          insert into sales_order_lines (
            sales_order_id, line_no, product_id, item_code, item_name, line_description, hsn_no,
            qty, unit_price_base, unit_price_order, gst_pct, line_total_base, line_total_order,
            customer_item_code, customer_item_description
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `,
        [
          salesOrderId,
          line.line_no,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.hsn_no || null,
          line.qty,
          line.unit_price_base,
          line.unit_price_quote,
          line.gst_pct,
          line.line_total_base,
          line.line_total_quote,
          customerItem.customer_item_code,
          customerItem.customer_item_description,
        ]
      );
    } else {
      await client.query(
        `
          insert into sales_order_lines (
            sales_order_id, line_no, product_id, item_code, item_name, line_description, hsn_no,
            qty, unit_price_base, unit_price_order, gst_pct, line_total_base, line_total_order
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `,
        [
          salesOrderId,
          line.line_no,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.hsn_no || null,
          line.qty,
          line.unit_price_base,
          line.unit_price_quote,
          line.gst_pct,
          line.line_total_base,
          line.line_total_quote,
        ]
      );
    }
  }

  await client.query(`update quote_headers set quote_status = 'converted', updated_at = now() where id = $1`, [quote.id]);

  if (Number.isFinite(Number(quote.lead_id)) && Number(quote.lead_id) > 0) {
    await client.query(
      `
        update leads
        set status = 'order_won',
            converted_sales_order_id = coalesce(converted_sales_order_id, $2),
            converted_to_order_at = coalesce(converted_to_order_at, now()),
            converted_quote_id = coalesce(converted_quote_id, $3),
            converted_to_quote_at = coalesce(converted_to_quote_at, now()),
            converted_customer_id = coalesce(converted_customer_id, $4),
            updated_at = now()
        where id = $1
      `,
      [quote.lead_id, salesOrderId, quote.id, quote.customer_id || null]
    );
  }

  return orderRes.rows[0];
}

async function confirmSalesOrder(client, salesOrderId, paymentTermId) {
  const hasCustomerPoCols = await columnExists(client, "sales_orders", "customer_po_number");
  if (hasCustomerPoCols) {
    await client.query(
      `
        update sales_orders
        set
          order_status = 'confirmed',
          payment_term_id = coalesce($2, payment_term_id),
          buyer_po_number = coalesce(nullif(trim(buyer_po_number), ''), 'QA-PO-' || so_number),
          buyer_po_date = coalesce(buyer_po_date, current_date),
          customer_po_number = coalesce(nullif(trim(customer_po_number), ''), nullif(trim(buyer_po_number), ''), 'QA-PO-' || so_number),
          customer_po_date = coalesce(customer_po_date, buyer_po_date, current_date),
          bill_to_name = coalesce(nullif(trim(bill_to_name), ''), 'QA Bill To'),
          bill_to_address = coalesce(nullif(trim(bill_to_address), ''), 'QA Bill To Address'),
          ship_to_name = coalesce(nullif(trim(ship_to_name), ''), 'QA Ship To'),
          ship_to_address = coalesce(nullif(trim(ship_to_address), ''), 'QA Ship To Address'),
          updated_at = now()
        where id = $1
      `,
      [salesOrderId, paymentTermId]
    );
  } else {
    await client.query(
      `
        update sales_orders
        set
          order_status = 'confirmed',
          payment_term_id = coalesce($2, payment_term_id),
          buyer_po_number = coalesce(nullif(trim(buyer_po_number), ''), 'QA-PO-' || so_number),
          buyer_po_date = coalesce(buyer_po_date, current_date),
          bill_to_name = coalesce(nullif(trim(bill_to_name), ''), 'QA Bill To'),
          bill_to_address = coalesce(nullif(trim(bill_to_address), ''), 'QA Bill To Address'),
          ship_to_name = coalesce(nullif(trim(ship_to_name), ''), 'QA Ship To'),
          ship_to_address = coalesce(nullif(trim(ship_to_address), ''), 'QA Ship To Address'),
          updated_at = now()
        where id = $1
      `,
      [salesOrderId, paymentTermId]
    );
  }
}

async function ensureMilestones(client, salesOrder) {
  const existing = await client.query(
    `select id, milestone_name, milestone_percent, milestone_amount_order from payment_milestones where sales_order_id = $1 order by id`,
    [salesOrder.id]
  );
  if (existing.rows.length >= 2) return existing.rows;

  await client.query(`delete from payment_milestones where sales_order_id = $1`, [salesOrder.id]);
  const halfBase = money(qty(salesOrder.grand_total_base) / 2);
  const halfOrder = money(qty(salesOrder.grand_total_order) / 2);
  const rows = [];
  for (const item of [
    { name: "50% Advance against Proforma", pct: 50, amountBase: halfBase, amountOrder: halfOrder, dueOffsetDays: 0 },
    {
      name: "50% Balance against Proforma before dispatch",
      pct: 50,
      amountBase: money(qty(salesOrder.grand_total_base) - halfBase),
      amountOrder: money(qty(salesOrder.grand_total_order) - halfOrder),
      dueOffsetDays: 15,
    },
  ]) {
    const r = await client.query(
      `
        insert into payment_milestones (
          sales_order_id, milestone_name, milestone_percent, milestone_amount_base, milestone_amount_order, due_type, due_date, status
        )
        values ($1, $2, $3::numeric, $4::numeric, $5::numeric, 'date', current_date + ($6::int), 'pending')
        returning id, milestone_name, milestone_percent, milestone_amount_order
      `,
      [salesOrder.id, item.name, item.pct, item.amountBase, item.amountOrder, item.dueOffsetDays]
    );
    rows.push(r.rows[0]);
  }
  return rows;
}

async function createProformaForMilestone(client, salesOrder, soLines, milestone, userId) {
  const pct = qty(milestone.milestone_percent) || 50;
  const hasProforma = await tableExists(client, "proforma_invoices");
  if (!hasProforma) {
    return { skipped: true, reason: "proforma_invoices table missing — apply migration 142" };
  }

  const existing = await client.query(
    `select id, proforma_number from proforma_invoices where payment_milestone_id = $1 limit 1`,
    [milestone.id]
  );
  if (existing.rows[0]) return existing.rows[0];

  const numRes = await client.query(`select next_company_document_number($1, 'PI') as proforma_number`, [
    salesOrder.company_id,
  ]);
  const proformaNumber = numRes.rows[0]?.proforma_number;

  const linePayload = applyBilledPercent(soLines, pct);
  const totals = calculateProformaTotals(linePayload);

  const headerRes = await client.query(
    `
      insert into proforma_invoices (
        company_id, proforma_number, sales_order_id, payment_milestone_id, customer_id, distributor_id,
        proforma_status, billing_basis, billed_percent, proforma_date,
        customer_po_number, customer_po_date,
        base_currency_id, proforma_currency_id,
        subtotal_base, subtotal_proforma, tax_total_base, tax_total_proforma,
        grand_total_base, grand_total_proforma,
        attention_to, remarks, created_by
      )
      values (
        $1,$2,$3,$4,$5,$6,
        'issued','milestone',$7,current_date,
        $8,$9,
        $10,$11,
        $12,$13,$14,$15,
        $16,$17,
        $18,$19,$20
      )
      returning id, proforma_number
    `,
    [
      salesOrder.company_id,
      proformaNumber,
      salesOrder.id,
      milestone.id,
      salesOrder.customer_id,
      salesOrder.distributor_id || null,
      pct,
      salesOrder.customer_po_number || salesOrder.buyer_po_number || null,
      salesOrder.customer_po_date || salesOrder.buyer_po_date || null,
      salesOrder.base_currency_id,
      salesOrder.order_currency_id,
      totals.subtotal_base,
      totals.subtotal_proforma,
      totals.tax_total_base,
      totals.tax_total_proforma,
      totals.grand_total_base,
      totals.grand_total_proforma,
      salesOrder.attention_to || null,
      `QA Proforma for milestone: ${milestone.milestone_name}`,
      userId,
    ]
  );

  const proformaId = headerRes.rows[0].id;
  for (const line of linePayload) {
    await client.query(
      `
        insert into proforma_invoice_lines (
          proforma_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
          customer_item_code, customer_item_description, hsn_no, qty,
          unit_price_base, unit_price_proforma, gst_pct, billed_percent,
          line_total_base, line_total_proforma
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      `,
      [
        proformaId,
        line.id,
        line.line_no,
        line.product_id || null,
        line.item_code || null,
        line.item_name || null,
        line.line_description || null,
        line.customer_item_code || null,
        line.customer_item_description || null,
        line.hsn_no || null,
        line.qty,
        line.unit_price_base,
        line.unit_price_proforma,
        line.gst_pct,
        pct,
        line.line_total_base,
        line.line_total_proforma,
      ]
    );
  }

  return headerRes.rows[0];
}

async function createTaxInvoice(client, salesOrder, soLines, userId) {
  const existing = await client.query(
    `
      select id, invoice_number, invoice_status
      from customer_invoices
      where sales_order_id = $1
        and invoice_status <> 'cancelled'
      order by id desc
      limit 1
    `,
    [salesOrder.id]
  );
  if (existing.rows[0]) return { ...existing.rows[0], reused: true };

  const hasCustomerPo = await columnExists(client, "customer_invoices", "customer_po_number");
  const hasLineCustomerItem = await columnExists(client, "invoice_lines", "customer_item_code");

  const invoiceLinesPayload = calculateInvoiceLineAmounts(
    soLines.map((line) => ({
      ...line,
      unit_price_invoice: line.unit_price_order,
    }))
  );
  const totals = calculateInvoiceTotals(invoiceLinesPayload);
  const numRes = await client.query(`select next_company_document_number($1, 'INV') as invoice_number`, [
    salesOrder.company_id,
  ]);
  const invoiceNumber = numRes.rows[0]?.invoice_number;
  const customerPo = normalizeCustomerPoFields({}, salesOrder);

  const headerRes = await client.query(
    `
      insert into customer_invoices (
        invoice_number, company_id, sales_order_id, customer_id, distributor_id, invoice_status, invoice_date,
        base_currency_id, invoice_currency_id,
        subtotal_base, subtotal_invoice, tax_total_base, tax_total_invoice,
        grand_total_base, grand_total_invoice, attention_to, created_by
        ${hasCustomerPo ? ", customer_po_number, customer_po_date" : ""}
      )
      values (
        $1,$2,$3,$4,$5,'issued',current_date,
        $6,$7,
        $8,$9,$10,$11,
        $12,$13,$14,$15
        ${hasCustomerPo ? ",$16,$17" : ""}
      )
      returning id, invoice_number, invoice_status
    `,
    hasCustomerPo
      ? [
          invoiceNumber,
          salesOrder.company_id,
          salesOrder.id,
          salesOrder.customer_id,
          salesOrder.distributor_id || null,
          salesOrder.base_currency_id,
          salesOrder.order_currency_id,
          totals.subtotal_base,
          totals.subtotal_invoice,
          totals.tax_total_base,
          totals.tax_total_invoice,
          totals.grand_total_base,
          totals.grand_total_invoice,
          salesOrder.attention_to || null,
          userId,
          customerPo.customer_po_number || `QA-PO-${salesOrder.so_number}`,
          customerPo.customer_po_date || new Date().toISOString().slice(0, 10),
        ]
      : [
          invoiceNumber,
          salesOrder.company_id,
          salesOrder.id,
          salesOrder.customer_id,
          salesOrder.distributor_id || null,
          salesOrder.base_currency_id,
          salesOrder.order_currency_id,
          totals.subtotal_base,
          totals.subtotal_invoice,
          totals.tax_total_base,
          totals.tax_total_invoice,
          totals.grand_total_base,
          totals.grand_total_invoice,
          salesOrder.attention_to || null,
          userId,
        ]
  );

  const invoiceId = headerRes.rows[0].id;
  for (const line of invoiceLinesPayload) {
    let customerItem = { customer_item_code: line.customer_item_code || null, customer_item_description: line.customer_item_description || null };
    if (hasLineCustomerItem) {
      customerItem = await resolveCustomerItemFields(client, {
        companyId: salesOrder.company_id,
        customerId: salesOrder.customer_id,
        productId: line.product_id,
        customerItemCode: line.customer_item_code,
        customerItemDescription: line.customer_item_description,
      });
      if (!customerItem.customer_item_code) {
        customerItem = {
          customer_item_code: `SAP-${String(line.item_code || line.product_id || line.line_no || "ITEM").slice(0, 24)}`,
          customer_item_description: `Customer material for ${line.item_name || line.item_code || "line"}`,
        };
      }
    }

    if (hasLineCustomerItem) {
      await client.query(
        `
          insert into invoice_lines (
            customer_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
            hsn_no, qty, unit_price_base, unit_price_invoice, gst_pct, line_total_base, line_total_invoice,
            customer_item_code, customer_item_description
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
    } else {
      await client.query(
        `
          insert into invoice_lines (
            customer_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
            hsn_no, qty, unit_price_base, unit_price_invoice, gst_pct, line_total_base, line_total_invoice
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
        ]
      );
    }
  }

  return { ...headerRes.rows[0], reused: false };
}

async function loadInvoiceForPdf(client, invoiceId) {
  const inv = await client.query(
    `
      select
        ci.*,
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
        so.bill_to_name,
        so.bill_to_address,
        so.ship_to_name,
        so.ship_to_address,
        curr.currency_code as invoice_currency_code
      from customer_invoices ci
      join customers c on c.id = ci.customer_id
      join sales_orders so on so.id = ci.sales_order_id
      left join currencies curr on curr.id = ci.invoice_currency_id
      where ci.id = $1
      limit 1
    `,
    [invoiceId]
  );
  const lines = await client.query(
    `select * from invoice_lines where customer_invoice_id = $1 order by line_no`,
    [invoiceId]
  );
  return { invoice: inv.rows[0] || null, lines: lines.rows };
}

async function generatePdf(client, invoice, lines) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(client, invoice.company_id));
  const letterheadBuffer = await resolveInvoiceLetterheadBuffer(client, invoice.company_id);
  const hasLetterhead = Boolean(letterheadBuffer);
  const pdf = await buildTaxInvoicePdfBuffer(
    {
      invoice,
      lines,
      dispatch: null,
      sellerProfile,
      hasLetterhead,
      letterheadBuffer,
    },
    {
      generateQuotePdfBuffer,
      applyPdfBackground,
      stampPdfPageNumbers,
      mergePdfBuffers,
      countPdfPages,
    }
  );
  const fileName = `qa_q26000037__${safeFileSegment(invoice.invoice_number || invoice.id)}.pdf`;
  const filePath = path.join(OUT_DIR, fileName);
  fs.writeFileSync(filePath, pdf);
  return { filePath, hasLetterhead, sellerGstin: sellerProfile.gstin || null, bankName: sellerProfile.bank_name || null };
}

async function main() {
  const client = await pool.connect();
  const summary = { quote_number_requested: QUOTE_NUMBER, company_code: COMPANY_CODE };
  try {
    await client.query("begin");
    const userId = await resolveQaUserId(client);
    const paymentTerm = await ensureAdv50Term(client);
    if (!paymentTerm) throw new Error("Failed to ensure ADV50 payment term");

    const quote = await findQuote(client);
    if (!quote) throw new Error(`Quote not found for ${COMPANY_CODE} / ${QUOTE_NUMBER}`);
    summary.quote = {
      id: quote.id,
      quote_number: quote.quote_number,
      status: quote.quote_status,
      customer_name: quote.customer_name,
      customer_gstin: quote.customer_gstin,
    };

    const revision = await getLatestIssuedRevision(client, quote.id);
    if (!revision) throw new Error("No latest quote revision found");
    if (String(revision.revision_status || "").toLowerCase() !== "issued") {
      throw new Error(`Latest revision is '${revision.revision_status}', expected 'issued'`);
    }
    summary.revision = { id: revision.id, revision_no: revision.revision_no, status: revision.revision_status };

    const linesRes = await client.query(
      `select * from quote_lines where quote_revision_id = $1 order by line_no`,
      [revision.id]
    );
    const quoteLines = linesRes.rows;
    if (!quoteLines.length) throw new Error("Quote has no lines");

    let soRow = (
      await client.query(`select id, so_number from sales_orders where quote_revision_id = $1 limit 1`, [revision.id])
    ).rows[0];

    if (!soRow) {
      soRow = await createSalesOrderFromQuote(client, quote, revision, quoteLines, userId, paymentTerm.id);
      summary.sales_order_created = true;
    } else {
      summary.sales_order_created = false;
      await client.query(`update sales_orders set payment_term_id = $2, updated_at = now() where id = $1`, [
        soRow.id,
        paymentTerm.id,
      ]);
    }

    await confirmSalesOrder(client, soRow.id, paymentTerm.id);
    const soFull = (
      await client.query(
        `
          select so.*, c.customer_name, c.gstin as customer_gstin
          from sales_orders so
          join customers c on c.id = so.customer_id
          where so.id = $1
        `,
        [soRow.id]
      )
    ).rows[0];
    summary.sales_order = {
      id: soFull.id,
      so_number: soFull.so_number,
      status: soFull.order_status,
      payment_term: paymentTerm.term_code,
      grand_total_order: soFull.grand_total_order,
      customer_po_number: soFull.customer_po_number || soFull.buyer_po_number,
    };

    const soLines = (
      await client.query(`select * from sales_order_lines where sales_order_id = $1 order by line_no`, [soFull.id])
    ).rows;

    const milestones = await ensureMilestones(client, soFull);
    summary.milestones = milestones;

    const proformas = [];
    for (const milestone of milestones) {
      const pi = await createProformaForMilestone(client, soFull, soLines, milestone, userId);
      proformas.push({ milestone: milestone.milestone_name, ...pi });
    }
    summary.proformas = proformas;

    const invoice = await createTaxInvoice(client, soFull, soLines, userId);
    summary.tax_invoice = invoice;

    await client.query("commit");

    const pdfData = await loadInvoiceForPdf(client, invoice.id);
    const pdf = await generatePdf(client, pdfData.invoice, pdfData.lines);
    summary.pdf = {
      file: pdf.filePath,
      has_letterhead: pdf.hasLetterhead,
      seller_gstin: pdf.sellerGstin,
      bank_name: pdf.bankName,
      app_download: `/invoices/${invoice.id}/pdf`,
    };

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    console.error(err);
    process.stdout.write(`${JSON.stringify({ ok: false, error: err.message, summary }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
