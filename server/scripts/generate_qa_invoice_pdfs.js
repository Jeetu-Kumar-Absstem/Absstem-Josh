/**
 * Generate 2–3 Tax Invoice PDF samples for P0b QA / GST Rule 46 review.
 *
 * Run inside the API container (Chromium + DB + letterhead storage):
 *   node scripts/generate_qa_invoice_pdfs.js
 *
 * If no invoices exist yet, seed draft invoices from confirmed SOs:
 *   QA_SEED_FROM_SO=1 node scripts/generate_qa_invoice_pdfs.js
 *
 * Optional:
 *   QA_INVOICE_IDS=12,34,56   force specific invoice ids (case1,case2,case3)
 *   QA_LIST_ONLY=1            list candidate invoices and exit
 *   QA_OUT_DIR=/path         override output folder
 *
 * Outputs land under server/storage/qa-invoice-pdfs/ (mounted on host in prod).
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db/pool");
const { applyPdfBackground, generateQuotePdfBuffer, stampPdfPageNumbers, mergePdfBuffers, countPdfPages } = require("../src/pdf/pdfCore");
const { buildTaxInvoicePdfBuffer } = require("../src/pdf/invoicePdf");
const { enrichCompanyProfileAssets, getCompanyProfile } = require("../src/services/companyProfile");
const { resolveCustomerItemFields, normalizeCustomerPoFields } = require("../src/services/customerProductMaps");

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

function calculateInvoiceLineAmounts(lines) {
  return (lines || []).map((line) => {
    const lineQty = qty(line.qty);
    const unitBase = money(line.unit_price_base ?? line.unit_price_order ?? line.unit_price_invoice);
    const unitInv = money(line.unit_price_invoice ?? line.unit_price_order ?? line.unit_price_base);
    const gstPct = qty(line.gst_pct);
    const lineTotalBase = money(lineQty * unitBase);
    const lineTotalInv = money(lineQty * unitInv);
    return {
      ...line,
      qty: lineQty,
      unit_price_base: unitBase,
      unit_price_invoice: unitInv,
      gst_pct: gstPct,
      line_total_base: lineTotalBase,
      line_total_order: lineTotalInv,
      line_total_invoice: lineTotalInv,
    };
  });
}

function calculateInvoiceTotals(lines) {
  let subtotalBase = 0;
  let subtotalInv = 0;
  let taxBase = 0;
  let taxInv = 0;
  for (const line of lines || []) {
    const taxableBase = money(line.line_total_base);
    const taxableInv = money(line.line_total_invoice ?? line.line_total_order);
    const gstPct = qty(line.gst_pct);
    subtotalBase += taxableBase;
    subtotalInv += taxableInv;
    taxBase += money((taxableBase * gstPct) / 100);
    taxInv += money((taxableInv * gstPct) / 100);
  }
  return {
    subtotal_base: money(subtotalBase),
    subtotal_invoice: money(subtotalInv),
    tax_total_base: money(taxBase),
    tax_total_invoice: money(taxInv),
    grand_total_base: money(subtotalBase + taxBase),
    grand_total_invoice: money(subtotalInv + taxInv),
  };
}

function safeFileSegment(value) {
  return String(value || "invoice")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function deriveStateCode(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{2})/);
  return match ? match[1] : "";
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

async function getInvoiceHeader(client, invoiceId) {
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
        so.buyer_po_number,
        so.buyer_po_date,
        d.company_name as distributor_name,
        curr.currency_code as invoice_currency_code,
        cp.gstin as seller_gstin,
        cp.state_code as seller_state_code,
        cp.state as seller_state,
        co.gstin as company_gstin
      from customer_invoices ci
      left join companies co on co.id = ci.company_id
      join customers c on c.id = ci.customer_id
      join sales_orders so on so.id = ci.sales_order_id
      left join distributors d on d.id = ci.distributor_id
      left join currencies curr on curr.id = ci.invoice_currency_id
      left join company_profiles_v2 cp on cp.company_id = ci.company_id
      where ci.id = $1
      limit 1
    `,
    [Number(invoiceId)]
  );
  return r.rows[0] || null;
}

async function getInvoiceLines(client, invoiceId) {
  const r = await client.query(
    `
      select il.*
      from invoice_lines il
      where il.customer_invoice_id = $1
      order by il.line_no asc
    `,
    [Number(invoiceId)]
  );
  return r.rows;
}

async function getDispatch(client, salesOrderId) {
  const r = await client.query(
    `
      select
        d.id,
        d.dispatch_number,
        d.dispatch_status,
        d.dispatch_date,
        d.transporter_name,
        d.lr_no,
        d.vehicle_no,
        d.eway_ref,
        d.tracking_ref,
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
    [Number(salesOrderId)]
  );
  return r.rows[0] || null;
}

function taxModeFor(invoice) {
  const sellerCode =
    String(invoice.seller_state_code || "").trim() ||
    deriveStateCode(invoice.seller_gstin) ||
    deriveStateCode(invoice.company_gstin);
  const buyerCode = deriveStateCode(invoice.customer_gstin);
  if (sellerCode && buyerCode) return sellerCode === buyerCode ? "intra" : "inter";
  return "unknown";
}

async function findCandidates(client) {
  const r = await client.query(
    `
      select
        ci.id,
        ci.invoice_number,
        ci.invoice_status,
        ci.invoice_date,
        ci.customer_po_number,
        ci.customer_po_date,
        ci.grand_total_invoice,
        c.customer_name,
        c.gstin as customer_gstin,
        c.state as customer_state,
        coalesce(cp.gstin, co.gstin) as seller_gstin,
        coalesce(cp.state_code, co.state_code, left(nullif(trim(coalesce(cp.gstin, co.gstin)), ''), 2)) as seller_state_code,
        co.gstin as company_gstin,
        (
          select count(*)::int from invoice_lines il where il.customer_invoice_id = ci.id
        ) as line_count,
        (
          select count(*)::int
          from invoice_lines il
          where il.customer_invoice_id = ci.id
            and coalesce(nullif(trim(il.customer_item_code), ''), '') <> ''
        ) as mapped_line_count,
        (
          select count(distinct coalesce(nullif(trim(il.hsn_no), ''), ''))::int
          from invoice_lines il
          where il.customer_invoice_id = ci.id
        ) as hsn_count
      from customer_invoices ci
      join customers c on c.id = ci.customer_id
      left join companies co on co.id = ci.company_id
      left join company_profiles_v2 cp on cp.company_id = ci.company_id
      where ci.invoice_status in ('issued', 'paid', 'draft')
        and exists (select 1 from invoice_lines il0 where il0.customer_invoice_id = ci.id)
      order by
        case when ci.invoice_status in ('issued', 'paid') then 0 else 1 end,
        ci.invoice_date desc nulls last,
        ci.id desc
      limit 250
    `
  );
  return r.rows.map((row) => ({ ...row, tax_mode: taxModeFor(row) }));
}

function pickScenarios(rows, forcedIds = []) {
  const used = new Set();
  const pick = (predicate, fallbackPredicate) => {
    const hit = rows.find((r) => !used.has(Number(r.id)) && predicate(r));
    if (hit) {
      used.add(Number(hit.id));
      return hit;
    }
    const fallback = rows.find((r) => !used.has(Number(r.id)) && (!fallbackPredicate || fallbackPredicate(r)));
    if (fallback) {
      used.add(Number(fallback.id));
      return fallback;
    }
    return null;
  };

  if (forcedIds.length) {
    // Direct IDs — do not require them to already appear in the candidate shortlist.
    return {
      case1_igst: forcedIds[0] ? { id: Number(forcedIds[0]) } : null,
      case2_cgst_sgst: forcedIds[1] ? { id: Number(forcedIds[1]) } : null,
      case3_customer_po_sap: forcedIds[2]
        ? { id: Number(forcedIds[2]) }
        : forcedIds[0]
          ? { id: Number(forcedIds[0]) }
          : null,
    };
  }

  const case1 = pick(
    (r) => r.tax_mode === "inter" && Number(r.line_count) >= 2,
    (r) => r.tax_mode === "inter" || Number(r.line_count) >= 2
  );
  const case2 = pick(
    (r) => r.tax_mode === "intra" && Number(r.line_count) >= 1,
    (r) => r.tax_mode === "intra" || Number(r.line_count) >= 1
  );
  const case3 = pick(
    (r) =>
      (String(r.customer_po_number || "").trim() || Number(r.mapped_line_count) > 0) &&
      Number(r.line_count) >= 1,
    (r) => Number(r.line_count) >= 1
  );

  return {
    case1_igst: case1,
    case2_cgst_sgst: case2,
    case3_customer_po_sap: case3,
  };
}

function enrichForCustomerPoDemo(invoice, lines) {
  const nextInvoice = { ...invoice };
  const nextLines = lines.map((line) => ({ ...line }));
  let stamped = false;

  if (!String(nextInvoice.customer_po_number || "").trim()) {
    nextInvoice.customer_po_number =
      String(invoice.buyer_po_number || "").trim() || `QA-PO-${invoice.invoice_number || invoice.id}`;
    stamped = true;
  }
  if (!nextInvoice.customer_po_date) {
    nextInvoice.customer_po_date = invoice.buyer_po_date || invoice.invoice_date || new Date().toISOString().slice(0, 10);
    stamped = true;
  }

  for (const line of nextLines) {
    if (!String(line.customer_item_code || "").trim()) {
      line.customer_item_code = `SAP-${String(line.item_code || line.product_id || line.line_no || "ITEM").slice(0, 24)}`;
      stamped = true;
    }
    if (!String(line.customer_item_description || "").trim()) {
      line.customer_item_description = `Customer material for ${line.item_name || line.item_code || "line"}`;
      stamped = true;
    }
  }

  return { invoice: nextInvoice, lines: nextLines, stamped };
}

async function renderPdf(client, invoice, lines) {
  const dispatch = await getDispatch(client, invoice.sales_order_id);
  const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(client, invoice.company_id));
  const letterheadBuffer = await resolveInvoiceLetterheadBuffer(client, invoice.company_id);
  const hasLetterhead = Boolean(letterheadBuffer);
  const pdf = await buildTaxInvoicePdfBuffer(
    {
      invoice,
      lines,
      dispatch,
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
  return {
    pdf,
    hasLetterhead,
    sellerGstin: sellerProfile.gstin || null,
    bankName: sellerProfile.bank_name || null,
  };
}

async function writeCase(client, caseKey, label, candidate, { forcePoStamp = false } = {}) {
  if (!candidate) {
    return {
      case: caseKey,
      label,
      ok: false,
      error: "No matching invoice found in database for this scenario.",
    };
  }

  let invoice = await getInvoiceHeader(client, candidate.id);
  if (!invoice) {
    return { case: caseKey, label, ok: false, error: `Invoice id ${candidate.id} not found.` };
  }
  let lines = await getInvoiceLines(client, candidate.id);
  let stamped = false;
  if (forcePoStamp) {
    const enriched = enrichForCustomerPoDemo(invoice, lines);
    invoice = enriched.invoice;
    lines = enriched.lines;
    stamped = enriched.stamped;
  }

  const rendered = await renderPdf(client, invoice, lines);
  const fileName = `${caseKey}__${safeFileSegment(invoice.invoice_number || invoice.id)}.pdf`;
  const filePath = path.join(OUT_DIR, fileName);
  fs.writeFileSync(filePath, rendered.pdf);

  return {
    case: caseKey,
    label,
    ok: true,
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    invoice_status: invoice.invoice_status,
    customer_name: invoice.customer_name,
    customer_gstin: invoice.customer_gstin,
    seller_gstin: rendered.sellerGstin,
    tax_mode: taxModeFor({ ...invoice, seller_gstin: rendered.sellerGstin, seller_state_code: invoice.seller_state_code }),
    customer_po_number: invoice.customer_po_number || null,
    customer_po_date: invoice.customer_po_date || null,
    line_count: lines.length,
    mapped_line_count: lines.filter((l) => String(l.customer_item_code || "").trim()).length,
    has_letterhead: rendered.hasLetterhead,
    bank_name: rendered.bankName,
    qa_po_sap_stamped_in_memory: stamped,
    file: filePath,
    app_download: `/invoices/${invoice.id}/pdf`,
  };
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

async function findSeedSalesOrders(client) {
  const r = await client.query(
    `
      select
        so.id,
        so.so_number,
        so.company_id,
        so.customer_id,
        so.distributor_id,
        so.base_currency_id,
        so.order_currency_id,
        so.attention_to,
        so.customer_po_number,
        so.customer_po_date,
        so.buyer_po_number,
        so.buyer_po_date,
        c.customer_name,
        c.gstin as customer_gstin,
        coalesce(cp.gstin, co.gstin) as seller_gstin,
        coalesce(cp.state_code, co.state_code, left(nullif(trim(coalesce(cp.gstin, co.gstin)), ''), 2)) as seller_state_code,
        (
          select count(*)::int from sales_order_lines sol where sol.sales_order_id = so.id
        ) as line_count
      from sales_orders so
      join customers c on c.id = so.customer_id
      left join companies co on co.id = so.company_id
      left join company_profiles_v2 cp on cp.company_id = so.company_id
      where lower(coalesce(so.order_status, '')) in ('confirmed', 'closed')
        and exists (select 1 from sales_order_lines sol0 where sol0.sales_order_id = so.id)
      order by so.id desc
      limit 100
    `
  );
  return r.rows.map((row) => ({ ...row, tax_mode: taxModeFor(row) }));
}

async function createDraftInvoiceFromSalesOrder(client, salesOrder, { stampCustomerPo = false } = {}) {
  const soId = Number(salesOrder.id);
  const linesRes = await client.query(
    `
      select
        sol.id,
        sol.line_no,
        sol.product_id,
        sol.item_code,
        sol.item_name,
        sol.line_description,
        sol.hsn_no,
        sol.qty,
        sol.unit_price_base,
        sol.unit_price_order,
        sol.gst_pct,
        sol.customer_item_code,
        sol.customer_item_description
      from sales_order_lines sol
      where sol.sales_order_id = $1
      order by sol.line_no asc
    `,
    [soId]
  );
  const sourceLines = linesRes.rows;
  if (!sourceLines.length) throw new Error(`SO ${soId} has no lines`);

  const invoiceLinesPayload = calculateInvoiceLineAmounts(
    sourceLines.map((line) => ({
      ...line,
      unit_price_invoice: line.unit_price_order,
    }))
  );
  const totals = calculateInvoiceTotals(invoiceLinesPayload);
  const companyId = Number(salesOrder.company_id);
  const numRes = await client.query(`select next_company_document_number($1, 'INV') as invoice_number`, [companyId]);
  const invoiceNumber = numRes.rows[0]?.invoice_number;
  if (!invoiceNumber) throw new Error("Failed to allocate invoice number");

  const poBody = stampCustomerPo
    ? {
        customer_po_number: salesOrder.customer_po_number || salesOrder.buyer_po_number || `QA-PO-${salesOrder.so_number || soId}`,
        customer_po_date: salesOrder.customer_po_date || salesOrder.buyer_po_date || new Date().toISOString().slice(0, 10),
      }
    : {
        customer_po_number: salesOrder.customer_po_number || salesOrder.buyer_po_number || null,
        customer_po_date: salesOrder.customer_po_date || salesOrder.buyer_po_date || null,
      };
  const customerPo = normalizeCustomerPoFields(poBody, salesOrder);
  const createdBy = await resolveQaUserId(client);

  const headerRes = await client.query(
    `
      insert into customer_invoices (
        invoice_number, company_id, sales_order_id, customer_id, distributor_id, invoice_status, invoice_date,
        base_currency_id, invoice_currency_id, subtotal_base, subtotal_invoice, tax_total_base, tax_total_invoice,
        grand_total_base, grand_total_invoice, attention_to, created_by, customer_po_number, customer_po_date
      )
      values ($1,$2,$3,$4,$5,'draft',current_date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      returning id, invoice_number
    `,
    [
      invoiceNumber,
      companyId,
      soId,
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
      createdBy,
      customerPo.customer_po_number,
      customerPo.customer_po_date,
    ]
  );
  const invoiceId = headerRes.rows[0]?.id;

  for (const line of invoiceLinesPayload) {
    let customerItem = await resolveCustomerItemFields(client, {
      companyId,
      customerId: salesOrder.customer_id,
      productId: line.product_id,
      customerItemCode: line.customer_item_code,
      customerItemDescription: line.customer_item_description,
    });
    if (stampCustomerPo && !customerItem.customer_item_code) {
      customerItem = {
        customer_item_code: `SAP-${String(line.item_code || line.product_id || line.line_no || "ITEM").slice(0, 24)}`,
        customer_item_description: `Customer material for ${line.item_name || line.item_code || "line"}`,
      };
    }

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
  }

  return { id: invoiceId, invoice_number: headerRes.rows[0]?.invoice_number, so_id: soId, so_number: salesOrder.so_number };
}

async function seedInvoicesFromSalesOrders(client) {
  const orders = await findSeedSalesOrders(client);
  if (!orders.length) {
    return {
      seeded: [],
      error:
        "No confirmed/closed sales orders with lines found. Create SO (and preferably dispatch) in Josh, or import commercial data before PDF QA.",
    };
  }

  const used = new Set();
  const pick = (predicate) => {
    const hit = orders.find((row) => !used.has(Number(row.id)) && predicate(row));
    if (hit) {
      used.add(Number(hit.id));
      return hit;
    }
    const any = orders.find((row) => !used.has(Number(row.id)));
    if (any) {
      used.add(Number(any.id));
      return any;
    }
    return null;
  };

  const picks = [
    { key: "case1_igst", order: pick((r) => r.tax_mode === "inter" && Number(r.line_count) >= 2), stamp: false },
    { key: "case2_cgst_sgst", order: pick((r) => r.tax_mode === "intra"), stamp: false },
    { key: "case3_customer_po_sap", order: pick(() => true), stamp: true },
  ];

  const seeded = [];
  await client.query("begin");
  try {
    for (const item of picks) {
      if (!item.order) continue;
      const created = await createDraftInvoiceFromSalesOrder(client, item.order, { stampCustomerPo: item.stamp });
      seeded.push({
        case: item.key,
        ...created,
        tax_mode: item.order.tax_mode,
        customer_name: item.order.customer_name,
        customer_gstin: item.order.customer_gstin,
      });
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
  return { seeded, available_sales_orders: orders.length };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const forcedIds = String(process.env.QA_INVOICE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const listOnly = String(process.env.QA_LIST_ONLY || "").trim() === "1";
  const seedFromSo = String(process.env.QA_SEED_FROM_SO || "").trim() === "1";

  const client = await pool.connect();
  try {
    let seedInfo = null;
    if (seedFromSo) {
      seedInfo = await seedInvoicesFromSalesOrders(client);
      if (seedInfo.error && !seedInfo.seeded?.length) {
        process.stdout.write(`${JSON.stringify({ ok: false, ...seedInfo }, null, 2)}\n`);
        process.exitCode = 1;
        return;
      }
    }

    let candidates = await findCandidates(client);
    const preview = candidates.slice(0, 30).map((r) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      status: r.invoice_status,
      tax_mode: r.tax_mode,
      customer_name: r.customer_name,
      customer_gstin: r.customer_gstin,
      seller_gstin: r.seller_gstin,
      lines: r.line_count,
      customer_po_number: r.customer_po_number,
    }));

    if (listOnly) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, count: candidates.length, invoices: preview, seed: seedInfo }, null, 2)}\n`
      );
      return;
    }

    if (!forcedIds.length && !candidates.length) {
      const soProbe = await findSeedSalesOrders(client);
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            error: "No invoices with lines found in Josh DB.",
            sales_orders_ready_to_seed: soProbe.length,
            hint:
              soProbe.length > 0
                ? "Re-run with QA_SEED_FROM_SO=1 to create draft invoices from confirmed/closed SOs, then generate PDFs."
                : "Josh has no confirmed/closed sales orders with lines either. Clan TI-* invoices are not in this database — create Quote→SO→Invoice in Josh first.",
            sample_sales_orders: soProbe.slice(0, 10).map((r) => ({
              id: r.id,
              so_number: r.so_number,
              tax_mode: r.tax_mode,
              customer_name: r.customer_name,
              lines: r.line_count,
            })),
          },
          null,
          2
        )}\n`
      );
      process.exitCode = 1;
      return;
    }

    let picked;
    if (seedInfo?.seeded?.length && !forcedIds.length) {
      const byCase = new Map(seedInfo.seeded.map((row) => [row.case, { id: row.id }]));
      picked = {
        case1_igst: byCase.get("case1_igst") || { id: seedInfo.seeded[0].id },
        case2_cgst_sgst: byCase.get("case2_cgst_sgst") || { id: seedInfo.seeded[Math.min(1, seedInfo.seeded.length - 1)].id },
        case3_customer_po_sap: byCase.get("case3_customer_po_sap") || { id: seedInfo.seeded[seedInfo.seeded.length - 1].id },
      };
    } else {
      picked = pickScenarios(candidates, forcedIds);
    }

    const results = [];
    results.push(await writeCase(client, "case1_igst", "Inter-State IGST supply", picked.case1_igst));
    results.push(await writeCase(client, "case2_cgst_sgst", "Intra-State CGST + SGST supply", picked.case2_cgst_sgst));
    results.push(
      await writeCase(client, "case3_customer_po_sap", "Customer PO + SAP / part codes", picked.case3_customer_po_sap, {
        forcePoStamp: true,
      })
    );

    const manifest = {
      generated_at: new Date().toISOString(),
      out_dir: OUT_DIR,
      forced_ids: forcedIds,
      seed: seedInfo,
      candidate_count: candidates.length,
      candidate_preview: preview,
      checklist: [
        "Letterhead overlay via applyPdfBackground (single print-ready PDF)",
        "Company GSTIN / Customer GSTIN / Place of Supply",
        "HSN + taxable value + IGST or CGST/SGST columns",
        "Amount Chargeable (in words) + Tax Amount (in words)",
        "Customer PO No / PO Date / Customer Item Code on lines",
        "Bank remittance details + Authorised Signatory",
      ],
      results,
      note:
        "Seeded invoices are draft Josh documents created for PDF QA. Clan TI-* numbers are not expected to exist in this DB.",
    };

    const manifestPath = path.join(OUT_DIR, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`\nWrote PDFs + manifest to ${OUT_DIR}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
