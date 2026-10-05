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
    ...(process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : null,
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : []),
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

const MAX_CONCURRENT_RENDERS = Math.max(1, Number(process.env.PDF_MAX_CONCURRENT_RENDERS) || 2);
const BROWSER_IDLE_CLOSE_MS = 60_000;

let sharedBrowserPromise = null;
let idleCloseTimer = null;
let activeRenders = 0;
const renderQueue = [];

function acquireRenderSlot() {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => renderQueue.push(resolve));
}

function releaseRenderSlot() {
  const next = renderQueue.shift();
  if (next) {
    next();
    return;
  }
  activeRenders = Math.max(0, activeRenders - 1);
  if (activeRenders === 0) scheduleIdleClose();
}

function scheduleIdleClose() {
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(async () => {
    idleCloseTimer = null;
    if (activeRenders > 0 || !sharedBrowserPromise) return;
    const pending = sharedBrowserPromise;
    sharedBrowserPromise = null;
    try {
      const browser = await pending;
      await browser.close();
    } catch {
      // Browser already gone.
    }
  }, BROWSER_IDLE_CLOSE_MS);
  if (typeof idleCloseTimer.unref === "function") idleCloseTimer.unref();
}

async function getSharedBrowser() {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }
  if (sharedBrowserPromise) {
    try {
      const browser = await sharedBrowserPromise;
      if (browser.isConnected()) return browser;
    } catch {
      // Previous launch failed; relaunch below.
    }
    sharedBrowserPromise = null;
  }
  const executablePath = resolveChromiumExecutablePath();
  const launching = puppeteer.launch({ executablePath, args: [...PUPPETEER_LAUNCH_ARGS] });
  sharedBrowserPromise = launching;
  launching
    .then((browser) =>
      browser.on("disconnected", () => {
        if (sharedBrowserPromise === launching) sharedBrowserPromise = null;
      })
    )
    .catch(() => {
      if (sharedBrowserPromise === launching) sharedBrowserPromise = null;
    });
  return launching;
}

async function renderPdfOnPage(browser, html, options) {
  const page = await browser.newPage();
  try {
    // Avoid networkidle* — it can hang forever on setContent in Docker/Alpine Chromium.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      // Keep page canvas transparent so letterhead shows through padded/margin regions.
      omitBackground: options.omitBackground === true,
      margin: options.margin || { top: "14mm", right: "14mm", bottom: "14mm", left: "14mm" },
      timeout: 60_000,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function generatePdfBuffer(html, options = {}) {
  await acquireRenderSlot();
  try {
    const browser = await getSharedBrowser();
    try {
      return await renderPdfOnPage(browser, html, options);
    } catch (err) {
      if (browser.isConnected()) throw err;
      // Browser crashed mid-render: relaunch once and retry.
      return await renderPdfOnPage(await getSharedBrowser(), html, options);
    }
  } finally {
    releaseRenderSlot();
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

async function checkPdfReadable(pdfBuffer) {
  if (!pdfBuffer || !pdfBuffer.length) return { ok: false, reason: "empty" };
  try {
    const doc = await PDFDocument.load(pdfBuffer);
    if (doc.getPageCount() < 1) return { ok: false, reason: "empty" };
    return { ok: true, reason: null };
  } catch (err) {
    const encrypted = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message || ""));
    return { ok: false, reason: encrypted ? "password_protected" : "corrupt" };
  }
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
  checkPdfReadable,
  countPdfPages,
  resolveChromiumExecutablePath,
  PUPPETEER_LAUNCH_ARGS,
};
