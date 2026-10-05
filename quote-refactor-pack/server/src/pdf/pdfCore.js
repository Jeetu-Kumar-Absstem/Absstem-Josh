const fs = require("fs");
const puppeteer = require("puppeteer-core");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const PUPPETEER_LAUNCH_ARGS = Object.freeze([
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  // Keep text crisp when content PDF is merged onto vector letterhead backgrounds.
  "--font-render-hinting=none",
]);

function resolveChromiumExecutablePath() {
  const executableCandidates = [
    process.env.CHROMIUM_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ].filter(Boolean);

  const existing = [];
  const missing = [];
  for (const candidate of executableCandidates) {
    if (fs.existsSync(candidate)) existing.push(candidate);
    else missing.push(candidate);
  }

  if (!existing.length) {
    const envHint = [
      `CHROMIUM_PATH=${process.env.CHROMIUM_PATH || "(unset)"}`,
      `PUPPETEER_EXECUTABLE_PATH=${process.env.PUPPETEER_EXECUTABLE_PATH || "(unset)"}`,
      `NODE_ENV=${process.env.NODE_ENV || "(unset)"}`,
    ].join(", ");
    throw new Error(
      `Chromium executable not found for Puppeteer PDF generation. ` +
        `Checked paths: ${executableCandidates.join(" | ") || "(none)"}. ` +
        `Missing: ${missing.join(" | ") || "(none)"}. ` +
        `Env: ${envHint}. ` +
        `In Docker/Alpine, ensure chromium is installed and PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium.`
    );
  }

  return existing[0];
}

async function generatePdfBuffer(html, options = {}) {
  const executablePath = resolveChromiumExecutablePath();

  const browser = await puppeteer.launch({
    executablePath,
    args: [...PUPPETEER_LAUNCH_ARGS],
  });

  try {
    const page = await browser.newPage();
    // Avoid networkidle* — it can hang forever on setContent in Docker/Alpine Chromium.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      // Keep page canvas transparent so letterhead shows through padded/margin regions.
      omitBackground: options.omitBackground === true,
      margin: options.margin || { top: "14mm", right: "14mm", bottom: "14mm", left: "14mm" },
      timeout: 60_000,
    });
    return buffer;
  } finally {
    await browser.close();
  }
}

async function generateQuotePdfBuffer(html, options = {}) {
  return generatePdfBuffer(html, options);
}

async function mergePdfBuffers(buffers) {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    if (!buf || !buf.length) continue;
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  const bytes = await out.save();
  return Buffer.from(bytes);
}

/**
 * Stamp a full-page PDF letterhead underneath each content page.
 * Draw order is locked:
 *   1) letterhead background
 *   2) invoice content (omitBackground + quote-style margins + page top pad)
 * Do not paint opaque white bands over the letterhead footer/header.
 */
async function applyPdfBackground(pdfBuffer, backgroundPdfBuffer) {
  if (!pdfBuffer || !pdfBuffer.length) return pdfBuffer;
  if (!backgroundPdfBuffer || !backgroundPdfBuffer.length) return pdfBuffer;

  const out = await PDFDocument.create();
  const [bgPage] = await out.embedPdf(backgroundPdfBuffer, [0]);
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const srcPages = await out.embedPdf(pdfBuffer, srcDoc.getPageIndices());

  for (const srcPage of srcPages) {
    const page = out.addPage([srcPage.width, srcPage.height]);
    page.drawPage(bgPage, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    page.drawPage(srcPage, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }

  const bytes = await out.save();
  return Buffer.from(bytes);
}

/**
 * Stamp "Page X of Y" (and optional doc label) on every page.
 * Used per invoice copy so numbering resets (Original 1/2, Duplicate 1/2, …).
 * Set skipIfSinglePage to leave clean single-page copies unlabeled.
 */
async function stampPdfPageNumbers(pdfBuffer, options = {}) {
  if (!pdfBuffer || !pdfBuffer.length) return pdfBuffer;
  const doc = await PDFDocument.load(pdfBuffer);
  const pages = doc.getPages();
  const total = pages.length;
  if (total < 1) return pdfBuffer;
  if (options.skipIfSinglePage && total === 1) return pdfBuffer;

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontSize = 8;
  const labelPrefix = String(options.label || "").trim();

  for (let i = 0; i < total; i += 1) {
    const page = pages[i];
    const { width } = page.getSize();
    const text = labelPrefix
      ? `${labelPrefix}  ·  Page ${i + 1} of ${total}`
      : `Page ${i + 1} of ${total}`;
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, {
      x: Math.max(14, (width - textWidth) / 2),
      y: 34,
      size: fontSize,
      font,
      color: rgb(0.25, 0.25, 0.25),
    });
  }

  return Buffer.from(await doc.save());
}

async function countPdfPages(pdfBuffer) {
  if (!pdfBuffer || !pdfBuffer.length) return 0;
  const doc = await PDFDocument.load(pdfBuffer);
  return doc.getPageCount();
}

module.exports = {
  generatePdfBuffer,
  generateQuotePdfBuffer,
  mergePdfBuffers,
  applyPdfBackground,
  stampPdfPageNumbers,
  countPdfPages,
  resolveChromiumExecutablePath,
  PUPPETEER_LAUNCH_ARGS,
};
