const path = require("path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const MAX_NORMALIZED_DOCUMENT_BYTES = 500 * 1024;

function text(value, fallback = "-") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function dateText(value) {
  return value ? String(value).slice(0, 10) : "-";
}

function safeFileStem(value) {
  return text(value, "document").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}

function drawPageHeading(page, fonts, title, subtitle) {
  const { regular, bold } = fonts;
  const { width, height } = page.getSize();
  page.drawText(title, { x: 42, y: height - 52, size: 19, font: bold, color: rgb(0.04, 0.15, 0.24) });
  page.drawText(subtitle, { x: 42, y: height - 72, size: 9, font: regular, color: rgb(0.35, 0.42, 0.47) });
  page.drawLine({ start: { x: 42, y: height - 84 }, end: { x: width - 42, y: height - 84 }, thickness: 1, color: rgb(0.78, 0.82, 0.83) });
}

function drawWrapped(page, value, { x, y, maxWidth, font, size = 9, lineHeight = 13, color = rgb(0.1, 0.15, 0.18) }) {
  const words = text(value).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  lines.forEach((item, index) => page.drawText(item, { x, y: y - index * lineHeight, size, font, color }));
  return y - lines.length * lineHeight;
}

async function enforceSize(bytes, fileName) {
  const buffer = Buffer.from(bytes);
  if (buffer.length > MAX_NORMALIZED_DOCUMENT_BYTES) {
    const error = new Error("NORMALIZED_DOCUMENT_TOO_LARGE");
    error.status = 400;
    error.code = "NORMALIZED_DOCUMENT_TOO_LARGE";
    error.detail = `${fileName || "Document"} could not be normalized below 500 KB. Upload a smaller source file.`;
    throw error;
  }
  return buffer;
}

async function normalizeDocumentToPdf(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
    const error = new Error("FILE_REQUIRED");
    error.status = 400;
    error.code = "FILE_REQUIRED";
    throw error;
  }
  const originalName = String(file.originalname || "vendor-document");
  const extension = path.extname(originalName).toLowerCase();
  const pdf = await PDFDocument.create();
  if (extension === ".pdf" || String(file.mimetype || "").toLowerCase() === "application/pdf") {
    const source = await PDFDocument.load(file.buffer, { ignoreEncryption: false });
    const pages = await pdf.copyPages(source, source.getPageIndices());
    pages.forEach((page) => pdf.addPage(page));
  } else if (extension === ".jpg" || extension === ".jpeg" || String(file.mimetype || "").toLowerCase() === "image/jpeg") {
    const image = await pdf.embedJpg(file.buffer);
    const scale = Math.min(1, 540 / image.width, 760 / image.height);
    const page = pdf.addPage([595, 842]);
    page.drawImage(image, {
      x: (595 - image.width * scale) / 2,
      y: (842 - image.height * scale) / 2,
      width: image.width * scale,
      height: image.height * scale,
    });
  } else if (extension === ".png" || String(file.mimetype || "").toLowerCase() === "image/png") {
    const image = await pdf.embedPng(file.buffer);
    const scale = Math.min(1, 540 / image.width, 760 / image.height);
    const page = pdf.addPage([595, 842]);
    page.drawImage(image, {
      x: (595 - image.width * scale) / 2,
      y: (842 - image.height * scale) / 2,
      width: image.width * scale,
      height: image.height * scale,
    });
  } else {
    const error = new Error("INVALID_FILE_TYPE");
    error.status = 400;
    error.code = "INVALID_FILE_TYPE";
    throw error;
  }
  if (!pdf.getPageCount()) pdf.addPage([595, 842]);
  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
  return {
    buffer: await enforceSize(bytes, originalName),
    originalname: `${safeFileStem(path.basename(originalName, extension))}.pdf`,
    mimetype: "application/pdf",
  };
}

async function generateVendorComplianceReport({ vendor, documents = [], avlApprovals = [] }) {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  let page = pdf.addPage([595, 842]);
  drawPageHeading(page, fonts, "Vendor compliance dossier", `${text(vendor?.company_name)} · generated ${new Date().toISOString().slice(0, 10)}`);
  let y = 720;
  page.drawText("Vendor record", { x: 42, y, size: 11, font: fonts.bold, color: rgb(0.04, 0.15, 0.24) });
  y -= 18;
  for (const line of [
    `Vendor code: ${text(vendor?.vendor_code)}`,
    `Contact: ${text(vendor?.contact_email)}`,
    `GSTIN: ${text(vendor?.gstin)}`,
  ]) {
    page.drawText(line, { x: 42, y, size: 9, font: fonts.regular });
    y -= 14;
  }
  y -= 12;
  page.drawText("Statutory documents", { x: 42, y, size: 11, font: fonts.bold, color: rgb(0.04, 0.15, 0.24) });
  y -= 20;
  if (!documents.length) {
    page.drawText("No statutory documents have been uploaded.", { x: 42, y, size: 9, font: fonts.regular });
    y -= 15;
  }
  for (const document of documents) {
    if (y < 90) {
      page = pdf.addPage([595, 842]);
      drawPageHeading(page, fonts, "Vendor compliance dossier", "Statutory document continuation");
      y = 730;
    }
    const expired = document.expiry_date && new Date(document.expiry_date) < new Date(new Date().toDateString());
    const status = expired ? "EXPIRED" : String(document.verification_status || "PENDING").toUpperCase();
    page.drawText(text(document.document_type), { x: 42, y, size: 9, font: fonts.bold });
    page.drawText(`Expires ${dateText(document.expiry_date)} · ${status}`, { x: 190, y, size: 9, font: fonts.regular, color: expired ? rgb(0.75, 0.05, 0.08) : rgb(0.1, 0.15, 0.18) });
    y -= 14;
    page.drawText(`File: ${text(document.file_name)}`, { x: 58, y, size: 8, font: fonts.regular, color: rgb(0.35, 0.42, 0.47) });
    y -= 18;
  }
  y -= 8;
  page.drawText("Approved vendor list links", { x: 42, y, size: 11, font: fonts.bold, color: rgb(0.04, 0.15, 0.24) });
  y -= 20;
  if (!avlApprovals.length) page.drawText("No active component specification approvals found.", { x: 42, y, size: 9, font: fonts.regular });
  for (const approval of avlApprovals) {
    if (y < 80) {
      page = pdf.addPage([595, 842]);
      drawPageHeading(page, fonts, "Vendor compliance dossier", "AVL continuation");
      y = 730;
    }
    const label = `${text(approval.spec_code)} - ${text(approval.spec_name)}`;
    y = drawWrapped(page, label, { x: 42, y, maxWidth: 270, font: fonts.bold, size: 9 });
    page.drawText(`AVL: ${text(approval.avl_id)} · ${approval.is_preferred ? "Preferred" : "Approved"}`, { x: 330, y: y + 13, size: 8, font: fonts.regular });
    y -= 10;
  }
  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
  return Buffer.from(bytes);
}

async function generateRfqComparisonReport({ rfq, quotes = [] }) {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  let page = pdf.addPage([595, 842]);
  drawPageHeading(page, fonts, "RFQ quote comparison", `${text(rfq?.rfq_number)} · ${text(rfq?.requisition_number)}`);
  let y = 720;
  page.drawText(`RFQ status: ${text(rfq?.rfq_status)} · due ${dateText(rfq?.due_date)}`, { x: 42, y, size: 9, font: fonts.regular });
  y -= 30;
  const sorted = [...quotes].sort((a, b) => Number(a.quote_total || Infinity) - Number(b.quote_total || Infinity));
  for (let index = 0; index < sorted.length; index += 1) {
    const quote = sorted[index];
    if (y < 140) {
      page = pdf.addPage([595, 842]);
      drawPageHeading(page, fonts, "RFQ quote comparison", "Supplier response continuation");
      y = 730;
    }
    page.drawRectangle({ x: 42, y: y - 48, width: 511, height: 60, borderColor: rgb(0.78, 0.82, 0.83), borderWidth: 1, color: index === 0 ? rgb(0.93, 0.97, 0.95) : rgb(1, 1, 1) });
    page.drawText(`${index + 1}. ${text(quote.company_name || quote.vendor_name)}`, { x: 55, y: y - 8, size: 10, font: fonts.bold });
    page.drawText(`Quote ${text(quote.quote_number)} · ${text(quote.verification_status)}`, { x: 55, y: y - 24, size: 8, font: fonts.regular });
    page.drawText(`Total INR ${Number(quote.quote_total || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`, { x: 360, y: y - 12, size: 10, font: fonts.bold, color: rgb(0.04, 0.15, 0.24) });
    page.drawText(`Delivery: ${quote.delivery_days == null ? "-" : `${quote.delivery_days} days`}`, { x: 360, y: y - 28, size: 8, font: fonts.regular });
    y -= 78;
  }
  if (!sorted.length) page.drawText("No supplier quotes are available for this RFQ.", { x: 42, y, size: 9, font: fonts.regular });
  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
  return Buffer.from(bytes);
}

module.exports = {
  MAX_NORMALIZED_DOCUMENT_BYTES,
  normalizeDocumentToPdf,
  generateVendorComplianceReport,
  generateRfqComparisonReport,
};
