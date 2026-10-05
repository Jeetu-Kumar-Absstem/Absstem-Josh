/**
 * Shared Absstem brand CSS for financial PDFs.
 * Primary #00509E · Neutral #2d3748 · Font: Lufga (with system fallbacks).
 */

const PDF_BRAND = Object.freeze({
  primary: "#00509E",
  primarySoft: "#f0f7ff",
  primaryBorder: "#bde0fe",
  neutral: "#2d3748",
  muted: "#4a5568",
  faint: "#718096",
  border: "#e2e8f0",
  borderStrong: "#cbd5e0",
  surface: "#f8fafc",
  surfaceAlt: "#f7fafc",
  white: "#ffffff",
  fontFamily: "'Lufga', 'Helvetica Neue', Helvetica, Arial, sans-serif",
});

/**
 * Base document rules shared by tax invoices, proformas, challans, and receipts.
 * Document-specific layout CSS is appended by each renderer.
 *
 * @param {{ letterheadMode?: boolean, pageTopPad?: string, fontSize?: string, lineHeight?: string }} [options]
 */
function baseDocumentStyles(options = {}) {
  const letterheadMode = Boolean(options.letterheadMode);
  const pageTopPad = options.pageTopPad || "0";
  const fontSize = options.fontSize || "9.5px";
  const lineHeight = options.lineHeight || "1.3";
  const pageMargin = options.pageMargin || (letterheadMode ? "12mm" : "0");

  return `
    :root {
      --pdf-primary: ${PDF_BRAND.primary};
      --pdf-primary-soft: ${PDF_BRAND.primarySoft};
      --pdf-primary-border: ${PDF_BRAND.primaryBorder};
      --pdf-neutral: ${PDF_BRAND.neutral};
      --pdf-muted: ${PDF_BRAND.muted};
      --pdf-faint: ${PDF_BRAND.faint};
      --pdf-border: ${PDF_BRAND.border};
      --pdf-border-strong: ${PDF_BRAND.borderStrong};
      --pdf-surface: ${PDF_BRAND.surface};
      --pdf-surface-alt: ${PDF_BRAND.surfaceAlt};
      --pdf-font: ${PDF_BRAND.fontFamily};
    }
    @page { size: A4; margin: ${pageMargin}; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      font-family: var(--pdf-font);
      color: var(--pdf-neutral);
      font-size: ${fontSize};
      line-height: ${lineHeight};
      background: ${letterheadMode ? "transparent" : PDF_BRAND.white};
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .page {
      break-after: page;
      page-break-after: always;
      position: relative;
      width: 100%;
      background: transparent;
      padding-top: ${letterheadMode ? pageTopPad : "0"};
      box-sizing: border-box;
    }
    .page:last-child {
      break-after: auto;
      page-break-after: auto;
    }
    .section-title {
      font-weight: 700;
      margin: 0 0 5px;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.03em;
      color: var(--pdf-primary);
    }
    .doc-title {
      font-size: 14px;
      font-weight: 700;
      text-align: center;
      margin: 0 0 3px;
      letter-spacing: 0.3px;
      color: var(--pdf-primary);
      text-transform: uppercase;
    }
    .company-name {
      font-size: 15px;
      font-weight: 700;
      margin: 0 0 4px;
      color: var(--pdf-primary);
    }
    .meta-line { margin: 0 0 3px; line-height: 1.4; color: var(--pdf-muted); }
    .meta-line strong { color: var(--pdf-neutral); }
    .small { font-size: 10px; line-height: 1.4; }
    .align-right { text-align: right; }
    .align-center { text-align: center; }
    .item-primary { display: block; font-weight: 600; color: var(--pdf-neutral); }
    .item-secondary {
      display: block;
      margin-top: 2px;
      font-size: 9px;
      font-weight: 400;
      color: var(--pdf-faint);
      line-height: 1.3;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .watermark {
      position: absolute;
      top: 52%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-28deg);
      font-size: 72px;
      font-weight: 800;
      letter-spacing: 3px;
      color: rgba(0, 80, 158, 0.07);
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
      z-index: 0;
    }
  `;
}

/**
 * Compact shell styles for receipt / statement / challan documents
 * that use a bordered sheet layout (not the tax-invoice table chrome).
 */
function shellDocumentStyles(options = {}) {
  const pageMargin = options.pageMargin || "10mm";
  return `
    ${baseDocumentStyles({
      letterheadMode: false,
      pageMargin,
      fontSize: options.fontSize || "12px",
      lineHeight: options.lineHeight || "1.45",
    })}
    body { margin: 0; }
    .sheet {
      border: 1px solid var(--pdf-border-strong);
      min-height: calc(297mm - 20mm);
      position: relative;
      background: ${PDF_BRAND.white};
    }
    .header {
      display: grid;
      grid-template-columns: 1fr 250px;
      border-bottom: 1px solid var(--pdf-border-strong);
    }
    .seller { padding: 12px; }
    .seller h1 {
      margin: 0 0 6px;
      font-size: 20px;
      color: var(--pdf-primary);
      font-family: var(--pdf-font);
    }
    .doc {
      padding: 12px;
      border-left: 1px solid var(--pdf-border-strong);
      font-size: 12px;
      line-height: 1.6;
    }
    .doc h2 {
      margin: 0 0 8px;
      font-size: 22px;
      text-align: center;
      color: var(--pdf-primary);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid var(--pdf-border-strong);
    }
    .cell {
      padding: 12px;
      min-height: 95px;
      font-size: 12px;
      line-height: 1.5;
    }
    .cell + .cell { border-left: 1px solid var(--pdf-border-strong); }
    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid var(--pdf-border-strong);
    }
    .meta-grid > div + div { border-left: 1px solid var(--pdf-border-strong); }
    .meta-cell {
      padding: 12px;
      min-height: 88px;
      font-size: 12px;
      line-height: 1.6;
    }
    .section {
      padding: 12px;
      border-bottom: 1px solid var(--pdf-border-strong);
    }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      border: 1px solid var(--pdf-border-strong);
      padding: 6px;
      font-size: 11px;
      vertical-align: top;
    }
    th {
      background: var(--pdf-primary);
      color: ${PDF_BRAND.white};
      text-align: center;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      font-size: 10px;
    }
    .footer {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
    }
    .footer > div + div { border-left: 1px solid var(--pdf-border-strong); }
    .footer-box {
      padding: 12px;
      min-height: 120px;
      font-size: 12px;
      line-height: 1.5;
    }
    .signature {
      display: flex;
      height: 100%;
      flex-direction: column;
      justify-content: space-between;
    }
    .for-line, .sign-line { text-align: right; font-weight: 700; color: var(--pdf-neutral); }
    .bank-row { display: flex; gap: 8px; margin-bottom: 3px; }
    .bank-row strong { min-width: 90px; color: var(--pdf-muted); }
  `;
}

module.exports = {
  PDF_BRAND,
  baseDocumentStyles,
  shellDocumentStyles,
};
