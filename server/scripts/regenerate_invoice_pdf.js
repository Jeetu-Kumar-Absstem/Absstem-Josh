/**
 * Regenerate Tax Invoice PDF for an existing invoice id (layout QA).
 *
 *   QA_INVOICE_ID=1 node scripts/regenerate_invoice_pdf.js
 *
 * Writes progress markers under storage/qa-invoice-pdfs/latest/ so a hung Chromium
 * run is visible on the host even when stdout is missed.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const invoiceId = Number(process.env.QA_INVOICE_ID || 1);
const dayStamp = new Date().toISOString().slice(0, 10);
const OUT_DIR =
  process.env.QA_OUT_DIR || path.join(__dirname, "..", "storage", "qa-invoice-pdfs", dayStamp);
const LATEST_DIR = path.join(__dirname, "..", "storage", "qa-invoice-pdfs", "latest");

function safeFileSegment(value) {
  return String(value || "invoice")
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(LATEST_DIR, { recursive: true });
}

function writeMarker(name, payload) {
  ensureDirs();
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  fs.writeFileSync(path.join(LATEST_DIR, name), `${text}\n`);
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

async function main() {
  const startedAt = new Date().toISOString();
  ensureDirs();
  writeMarker("regen-status.txt", {
    status: "started",
    started_at: startedAt,
    invoice_id: invoiceId,
    cwd: process.cwd(),
    out_dir: OUT_DIR,
    latest_dir: LATEST_DIR,
  });
  process.stdout.write(
    `[regen] start ${startedAt} QA_INVOICE_ID=${invoiceId} cwd=${process.cwd()} out=${OUT_DIR}\n`
  );

  if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
    throw new Error("Set QA_INVOICE_ID to a valid invoice id");
  }

  const { pool } = require("../src/db/pool");
  const { applyPdfBackground, generateQuotePdfBuffer, stampPdfPageNumbers, mergePdfBuffers, countPdfPages } = require("../src/pdf/pdfCore");
  const {
    buildTaxInvoicePdfBuffer,
    INVOICE_LETTERHEAD_CLEARANCE,
    INVOICE_LETTERHEAD_PAGE_PADDING,
    INVOICE_PDF_MARGINS_LETTERHEAD,
  } = require("../src/pdf/invoicePdf");
  const { enrichCompanyProfileAssets, getCompanyProfile } = require("../src/services/companyProfile");

  process.stdout.write(
    `[regen] CLEARANCE=${JSON.stringify(INVOICE_LETTERHEAD_CLEARANCE)} puppeteer_margins=${JSON.stringify(INVOICE_PDF_MARGINS_LETTERHEAD)}\n`
  );
  writeMarker("regen-status.txt", {
    status: "loaded_modules",
    started_at: startedAt,
    clearance: INVOICE_LETTERHEAD_CLEARANCE,
    page_padding: INVOICE_LETTERHEAD_PAGE_PADDING,
    margins: INVOICE_PDF_MARGINS_LETTERHEAD,
  });

  const client = await pool.connect();
  try {
    writeMarker("regen-status.txt", { status: "db_connected", started_at: startedAt, invoice_id: invoiceId });
    const invRes = await client.query(
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
    const invoice = invRes.rows[0];
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
    const linesRes = await client.query(
      `select * from invoice_lines where customer_invoice_id = $1 order by line_no`,
      [invoiceId]
    );
    const lines = linesRes.rows;
    const dispatchRes = await client.query(
      `
        select *
        from dispatches
        where sales_order_id = $1
        order by id desc
        limit 1
      `,
      [invoice.sales_order_id]
    );
    const dispatch = dispatchRes.rows[0] || null;
    const sellerProfile = enrichCompanyProfileAssets(await getCompanyProfile(client, invoice.company_id));
    const letterheadPath =
      (await getCompanyTemplateOverridePath(client, invoice.company_id, "QUOTE_LETTERHEAD")) ||
      (await getTemplatePathByKey(client, "QUOTE_LETTERHEAD"));
    const letterheadBuffer = letterheadPath && fs.existsSync(letterheadPath) ? fs.readFileSync(letterheadPath) : null;
    const hasLetterhead = Boolean(letterheadBuffer);
    process.stdout.write(
      `[regen] invoice=${invoice.invoice_number} lines=${lines.length} letterhead=${hasLetterhead} path=${letterheadPath || "none"}\n`
    );
    writeMarker("regen-status.txt", {
      status: "rendering_pdf",
      started_at: startedAt,
      invoice_number: invoice.invoice_number,
      has_letterhead: hasLetterhead,
      page_padding: INVOICE_LETTERHEAD_PAGE_PADDING,
    });

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

    const stamp = startedAt.replaceAll(/[-:TZ.]/g, "").slice(0, 14);
    const baseName = `regen__${safeFileSegment(invoice.invoice_number || invoice.id)}`;
    const fileName = `${baseName}.pdf`;
    const stampedName = `${baseName}__${stamp}.pdf`;
    const filePath = path.join(OUT_DIR, fileName);
    const stampedPath = path.join(OUT_DIR, stampedName);
    const latestPath = path.join(LATEST_DIR, fileName);
    const latestStampedPath = path.join(LATEST_DIR, stampedName);
    fs.writeFileSync(filePath, pdf);
    fs.writeFileSync(stampedPath, pdf);
    fs.writeFileSync(latestPath, pdf);
    fs.writeFileSync(latestStampedPath, pdf);

    const result = {
      ok: true,
      status: "done",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      has_letterhead: hasLetterhead,
      letterhead_path: letterheadPath || null,
      page_padding: INVOICE_LETTERHEAD_PAGE_PADDING,
      margins: INVOICE_PDF_MARGINS_LETTERHEAD,
      bytes: pdf.length,
      file: filePath,
      stamped_file: stampedPath,
      latest_file: latestPath,
      latest_stamped_file: latestStampedPath,
      host_hint: `server/storage/qa-invoice-pdfs/latest/${stampedName}`,
      app_download: `/invoices/${invoice.id}/pdf`,
    };
    writeMarker("regen-status.txt", result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  const message = err?.stack || String(err);
  try {
    writeMarker("regen-error.txt", { status: "error", at: new Date().toISOString(), error: message });
    writeMarker("regen-status.txt", { status: "error", at: new Date().toISOString(), error: message });
  } catch (_) {
    // ignore marker failures
  }
  console.error(message);
  process.exit(1);
});
