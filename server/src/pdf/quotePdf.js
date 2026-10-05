const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { applyPdfBackground, generateQuotePdfBuffer: generatePdfCoreBuffer, mergePdfBuffers } = require("./pdfCore");

/** Bottom margin clears the letterhead footer (logo, address, CIN) and the page-number line. */
const QUOTE_PAGE_MARGIN = Object.freeze({ top: "14mm", right: "14mm", bottom: "30mm", left: "14mm" });

function generateQuotePdfBuffer(html, options = {}) {
  return generatePdfCoreBuffer(html, { margin: QUOTE_PAGE_MARGIN, ...options });
}
const { getProductFamilyRule } = require("../configurator/productFamilyMatrix");
const { resolveFamilyBrochureProfile, isCoreGeneratorLine, brochureProfileKey } = require("./quoteFamilyBrochureContent");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtMoney(v) {
  const n = Number(v);
  return Number.isFinite(n)
    ? new Intl.NumberFormat("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n)
    : "";
}

function fmtMoneyWithSymbol(v, currencySymbol, currencyCode) {
  const amount = fmtMoney(v);
  if (!amount) return "";
  const symbol = String(currencySymbol || "").trim();
  if (symbol) return `${symbol} ${amount}`;
  const code = String(currencyCode || "").trim();
  return code ? `${code} ${amount}` : amount;
}

// Customer-facing dates are Indian calendar dates; UTC slicing shows the previous day before 05:30 IST.
function fmtDate(d) {
  try {
    const dt = d ? new Date(d) : new Date();
    if (Number.isNaN(dt.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(dt);
  } catch {
    return "";
  }
}

function quoteOfferDate(quote, revision) {
  return revision?.issued_at || revision?.prepared_at || revision?.created_at || quote?.created_at || null;
}

function parseJsonOrNull(v) {
  if (typeof v !== "string" || !v.trim().length) return null;
  try {
    const obj = JSON.parse(v);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function proofPointCopy(pointKey, { familyKey, variantKey } = {}) {
  const family = String(familyKey || "").trim().toUpperCase();
  const variant = String(variantKey || "").trim().toUpperCase();
  if (family === "NGEN") {
    if (pointKey === "purity_stability") return "Purity stability tuned for industrial duty";
    if (pointKey === "automation") return "Automation-ready controls with clean operating visibility";
    if (pointKey === "industrial_reliability") return "Industrial reliability backed by service + spares discipline";
  }
  if (family === "NGENX") {
    if (pointKey === "footprint") return "Compact footprint for faster deployment";
    if (pointKey === "ease_of_use") return "Operator-friendly digital controller for day-to-day use";
    if (pointKey === "value_positioning") return "Value-led package without compromising essentials";
  }
  if (family === "IDOS" || family === "IDOS_C") {
    if (pointKey === "process_continuity") return "Process continuity with dependable oxygen availability";
    if (pointKey === "oxygen_availability") return "Oxygen availability aligned to plant duty cycles";
    if (pointKey === "industrial_safety") return "Industrial safety with monitoring-first controls";
    if (pointKey === "compactness") return "Compact oxygen package for footprint-aware deployment";
    if (pointKey === "faster_installation") return "Faster installation with simplified site interfaces";
    if (pointKey === "value_positioning") return "Value-led delivery without scope drift";
  }
  if (family === "MEDO" || family === "MEDO_C") {
    if (pointKey === "continuity_of_supply") return "Continuity of supply positioned for healthcare uptime";
    if (pointKey === "operator_simplicity") return "Operator simplicity for day-to-day hospital handling";
    if (pointKey === "healthcare_positioning") return "Healthcare-ready documentation and service discipline";
    if (pointKey === "compactness") return "Compact deployment for space-aware hospital layouts";
    if (pointKey === "faster_installation") return "Faster installation with cleaner site readiness";
    if (pointKey === "value_positioning") return "Value-led care continuity with essential compliance";
  }
  if (family === "NGEN" && variant === "UH" && pointKey === "purity_stability") {
    return "Purity stability positioned for ultra-high purity demand";
  }
  if (family === "NGEN" && variant === "HF" && pointKey === "industrial_reliability") {
    return "High-flow duty aligned to industrial reliability expectations";
  }
  return "";
}

function buildProposalDnaHighlights(configuratorContext) {
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const familyKey = String(cfg.family_key || "").trim().toUpperCase();
  const variantKey = String(cfg.variant_key || "").trim().toUpperCase();
  const rule = getProductFamilyRule(familyKey);
  const points = Array.isArray(rule?.proposal_blocks?.proof_points) ? rule.proposal_blocks.proof_points : [];
  return points
    .map((key) => proofPointCopy(key, { familyKey, variantKey }))
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

function statusLabel(status) {
  const s = String(status || "").trim();
  if (!s) return "";
  return s.replaceAll("_", " ");
}

function watermarkText(status) {
  const s = String(status || "").trim();
  if (!s || s === "issued") return "";
  if (s === "pending_approval") return "PENDING APPROVAL";
  if (s === "approved") return "APPROVED";
  if (s === "rejected") return "REJECTED";
  return "DRAFT";
}

function watermarkHtml(status) {
  const text = watermarkText(status);
  if (!text) return "";
  return `<div class="watermark">${escapeHtml(text)}</div>`;
}

function includedQuoteLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter((l) => String(l?.scope_type || "included") === "included");
}

function quoteLinesByScope(lines, scopeType) {
  return (Array.isArray(lines) ? lines : []).filter((l) => String(l?.scope_type || "included") === scopeType);
}

function lineRemarks(line) {
  const meta = parseJsonOrNull(line?.line_description);
  return String(meta?.remarks || "").trim();
}

const NITROGEN_PROCESS_IMAGE = path.join(__dirname, "assets", "nitrogen-psa-process.png");
let nitrogenProcessDataUri;

function nitrogenProcessImageDataUri() {
  if (nitrogenProcessDataUri === undefined) {
    try {
      nitrogenProcessDataUri = `data:image/png;base64,${fs.readFileSync(NITROGEN_PROCESS_IMAGE).toString("base64")}`;
    } catch {
      nitrogenProcessDataUri = null;
    }
  }
  return nitrogenProcessDataUri;
}

const PRODUCT_IMAGE_DIR = path.join(__dirname, "assets", "products");
const productImageCache = new Map();

/** Product photo per family (assets/products/<KEY>.webp); variants such as NGEN_UH fall back to NGEN. */
function productImageDataUri(familyKey) {
  const key = String(familyKey || "").trim().toUpperCase();
  if (!key) return null;
  const candidates = [key, key.split("_")[0]];
  for (const candidate of candidates) {
    if (productImageCache.has(candidate)) {
      const cached = productImageCache.get(candidate);
      if (cached) return cached;
      continue;
    }
    let uri = null;
    try {
      uri = `data:image/webp;base64,${fs.readFileSync(path.join(PRODUCT_IMAGE_DIR, `${candidate}.webp`)).toString("base64")}`;
    } catch {
      uri = null;
    }
    productImageCache.set(candidate, uri);
    if (uri) return uri;
  }
  return null;
}

const BRAND = Object.freeze({
  red: "#ed1f27",
  green: "#009742",
  blue: "#00509e",
  cyan: "#00aeea",
  sky: "#eaf5fd",
  skyBorder: "#cfe6f8",
  ink: "#1f2937",
});

const BRAND_STRIPE_HTML = `<div class="brand-stripe"><span style="background:${BRAND.red}"></span><span style="background:${BRAND.green}"></span><span style="background:${BRAND.blue}"></span></div>`;

/** Appended after each document's own styles so brand colours win. */
const BRAND_CSS = `
  .h1 { color: ${BRAND.blue}; }
  .h1::after { content: ""; display: block; width: 46px; height: 3px; background: ${BRAND.red}; border-radius: 2px; margin-top: 6px; }
  .h2, .schedule-title { color: ${BRAND.blue}; }
  .brand-stripe { display: flex; height: 4px; border-radius: 2px; overflow: hidden; margin: 0 0 12px; }
  .brand-stripe span { flex: 1; }
  table.attrs th, table.simple th, .schedule-table th {
    background: ${BRAND.blue} !important; color: #fff !important; border-color: ${BRAND.blue} !important; font-weight: 700;
  }
  table.attrs tbody tr:nth-child(even) td, table.simple tbody tr:nth-child(even) td, .schedule-table tbody tr:nth-child(even) td { background: ${BRAND.sky}; }
  .brochure { background: ${BRAND.sky}; border: 1px solid ${BRAND.skyBorder}; border-left: 4px solid ${BRAND.cyan}; }
  .brochure-title { color: ${BRAND.blue}; }
  .brochure-features li::marker { color: ${BRAND.green}; }
  .card, .side-card { border-color: ${BRAND.skyBorder}; border-top: 3px solid ${BRAND.cyan}; }
  .card-title, .side-title { color: ${BRAND.blue}; text-transform: uppercase; letter-spacing: 0.04em; }
  .terms-strip { background: ${BRAND.sky} !important; border-color: ${BRAND.skyBorder} !important; border-left: 4px solid ${BRAND.blue} !important; }
  .term-label { color: ${BRAND.blue} !important; }
  .statutory { margin-top: 22px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; break-inside: avoid; page-break-inside: avoid; }
  .statutory-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; background: #fafafa; }
  .statutory-title { font-size: 12px; font-weight: 800; color: #111; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .statutory-row { display: grid; grid-template-columns: 38% 1fr; gap: 6px; font-size: 11.5px; padding: 3px 0; }
  .statutory-row .k { color: #475569; }
  .statutory-row .v { font-weight: 700; color: ${BRAND.ink}; }
`;

const CLIENT_LOGO_DIR = path.join(__dirname, "assets", "clients");
const clientLogoCache = new Map();

function clientLogoDataUris(setName) {
  if (clientLogoCache.has(setName)) return clientLogoCache.get(setName);
  let uris = [];
  try {
    const dir = path.join(CLIENT_LOGO_DIR, setName);
    uris = fs
      .readdirSync(dir)
      .filter((file) => file.toLowerCase().endsWith(".webp"))
      .sort()
      .map((file) => `data:image/webp;base64,${fs.readFileSync(path.join(dir, file)).toString("base64")}`);
  } catch {
    uris = [];
  }
  clientLogoCache.set(setName, uris);
  return uris;
}

const WHY_ABSSTEM_STATS = [
  { value: "300+", label: "Installations across India" },
  { value: "24 States & 6 UTs", label: "Pan-India service network" },
  { value: "ISO 13485:2016", label: "Certified by TÜV Nord" },
  { value: "Aegis Graham Bell", label: "Award for Innovative Medical Equipment" },
  { value: "10-Year*", label: "Molecular sieve performance warranty" },
  { value: "Made in India", label: "Designed and manufactured in-house" },
];

const WHY_ABSSTEM_REASONS = [
  { title: "Complete On-Site PSA Plant", text: "Application study, design, in-house manufacturing, installation, commissioning, operator training and long-term service." },
  { title: "Adsorption & PSA Specialists", text: "Continuously optimised PSA cycles and molecular sieve performance for stable purity and long service life." },
  { title: "Lowest Operating Cost", text: "Proprietary technology achieving the lowest air-to-gas ratio, which keeps energy cost per Nm³ low." },
  { title: "Reliable 24/7 Supply", text: "Gas generated directly from atmospheric air with consistent purity and pressure and zero cylinder dependency." },
  { title: "Certified & Compliant", text: "One of India's only ISO 13485-certified medical oxygen plant manufacturers, meeting Indian and global standards." },
  { title: "R&D-Driven Innovation", text: "Refined operating cycles and next-generation adsorbents for cleaner, more cost-effective gas production." },
];

const SHIELD_POINTS = [
  "AMC and CMC plans for Absstem and other brands",
  "4 preventive maintenance visits per year",
  "Telephonic / remote support within 2–6 hours",
  "On-site response within 48 hrs (CMC) / 72 hrs (AMC)",
  "Genuine spares and service report after every visit",
  "IIoT real-time remote monitoring (add-on)",
];

function whyAbsstemPageHtml({ familyKey, status }) {
  const key = String(familyKey || "").toUpperCase();
  const isHealthcare = key.startsWith("MEDO");
  const logos = clientLogoDataUris(isHealthcare ? "healthcare" : "industrial");
  const gasWord = key.startsWith("NGEN") ? "nitrogen" : key ? "oxygen" : "oxygen / nitrogen";
  return `
    <div class="page why-page">
      ${watermarkHtml(status)}
      ${BRAND_STRIPE_HTML}
      <div class="h1">Why Absstem</div>
      <div class="why-stats">
        ${WHY_ABSSTEM_STATS.map(
          (s) => `<div class="why-stat"><div class="why-stat-value">${escapeHtml(s.value)}</div><div class="why-stat-label">${escapeHtml(s.label)}</div></div>`
        ).join("")}
      </div>
      <div class="why-reasons">
        ${WHY_ABSSTEM_REASONS.map(
          (r) => `<div class="why-reason"><div class="why-reason-title">${escapeHtml(r.title)}</div><div class="why-reason-text">${escapeHtml(r.text)}</div></div>`
        ).join("")}
      </div>
      ${
        logos.length
          ? `<div class="h2">Trusted by Leading ${isHealthcare ? "Hospitals & Medical Institutions" : "Industries"}</div>
             <div class="why-logos">${logos.map((uri) => `<div class="why-logo"><img src="${uri}" alt="" /></div>`).join("")}</div>`
          : ""
      }
      <div class="why-bottom">
        <div class="why-shield">
          <div class="why-box-title">After-Sales Care – Absstem Shield</div>
          <ul>${SHIELD_POINTS.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
        </div>
        <div class="why-savings">
          <div class="why-box-title">Significant Cost Savings</div>
          <div class="why-savings-big">Up to 80%</div>
          <div class="why-savings-text">savings compared to cylinders or liquid ${escapeHtml(gasWord)}</div>
          <div class="why-savings-text">Typical payback within <strong>12–18 months</strong> · Zero transportation and rental charges</div>
          <div class="why-savings-link">Calculate your savings: <strong>absstem.com/calculators</strong></div>
        </div>
      </div>
      <div class="why-note">* The 10-year molecular sieve performance warranty applies to the molecular sieves under Absstem warranty conditions. It is separate from, and does not extend, the equipment warranty stated in the Terms &amp; Conditions of this offer.</div>
    </div>
  `;
}

const WHY_ABSSTEM_CSS = `
  .why-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
  .why-stat { border: 1px solid ${BRAND.skyBorder}; border-top: 3px solid ${BRAND.cyan}; border-radius: 10px; padding: 9px 10px; background: ${BRAND.sky}; }
  .why-stat-value { font-size: 15px; font-weight: 800; color: ${BRAND.blue}; }
  .why-stat-label { font-size: 10.5px; color: #475569; margin-top: 2px; }
  .why-reasons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin-top: 14px; }
  .why-reason { padding-left: 10px; border-left: 3px solid ${BRAND.green}; }
  .why-reason-title { font-size: 12px; font-weight: 800; color: ${BRAND.ink}; }
  .why-reason-text { font-size: 10.5px; color: #475569; line-height: 1.45; margin-top: 2px; }
  .why-logos { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
  .why-logo { border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; height: 44px; display: flex; align-items: center; justify-content: center; padding: 4px; }
  .why-logo img { max-width: 100%; max-height: 36px; object-fit: contain; }
  .why-bottom { display: grid; grid-template-columns: 1.25fr 1fr; gap: 12px; margin-top: 14px; break-inside: avoid; page-break-inside: avoid; }
  .why-shield, .why-savings { border-radius: 10px; padding: 10px 12px; }
  .why-shield { border: 1px solid ${BRAND.skyBorder}; background: ${BRAND.sky}; border-left: 4px solid ${BRAND.blue}; }
  .why-shield ul { margin: 6px 0 0 16px; font-size: 10.5px; line-height: 1.5; }
  .why-shield li { margin: 0 0 2px; }
  .why-shield li::marker { color: ${BRAND.green}; }
  .why-savings { background: linear-gradient(135deg, ${BRAND.blue}, ${BRAND.cyan}); color: #fff; }
  .why-savings .why-box-title { color: #fff; }
  .why-box-title { font-size: 12px; font-weight: 800; color: ${BRAND.blue}; text-transform: uppercase; letter-spacing: 0.04em; }
  .why-savings-big { font-size: 26px; font-weight: 800; margin-top: 4px; }
  .why-savings-text { font-size: 10.5px; line-height: 1.5; margin-top: 2px; }
  .why-savings-link { font-size: 10.5px; margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.35); }
  .why-note { margin-top: 10px; font-size: 9.5px; color: #64748b; line-height: 1.45; }
`;

function statutoryDetailsHtml(companyProfile) {
  const cp = companyProfile && typeof companyProfile === "object" ? companyProfile : {};
  const rows = (items) =>
    items
      .filter(([, value]) => String(value || "").trim())
      .map(([label, value]) => `<div class="statutory-row"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(value)}</div></div>`)
      .join("");
  const bankRows = rows([
    ["Account Name", cp.account_name || cp.company_name],
    ["Bank", cp.bank_name],
    ["Branch", cp.bank_branch],
    ["Account No.", cp.account_no],
    ["IFSC", cp.ifsc],
  ]);
  const taxRows = rows([
    ["Company", cp.company_name],
    ["GSTIN", cp.gstin],
    ["PAN", cp.pan],
    ["State Code", cp.state_code],
  ]);
  const hasBank = Boolean(String(cp.bank_name || cp.account_no || "").trim());
  const hasTax = Boolean(String(cp.gstin || cp.pan || "").trim());
  if (!hasBank && !hasTax) return "";
  return `
    <div class="statutory">
      ${hasBank ? `<div class="statutory-card"><div class="statutory-title">Bank Details</div>${bankRows}</div>` : ""}
      ${hasTax ? `<div class="statutory-card"><div class="statutory-title">Statutory Details</div>${taxRows}</div>` : ""}
    </div>
  `;
}

// Split points are percentages of the 1024px-wide process image.
const SCOPE_DIAGRAM_BLOCKS = [
  { role: "compressor_package", label: "Compressor Package", from: 0, to: 53.5 },
  { role: "psa_generator", label: "PSA Generator", from: 53.5, to: 70.1 },
  { role: "product_storage", label: "Nitrogen Storage Tank", from: 70.1, to: 100 },
];

function scopeDiagramHtml(lines, configuratorContext) {
  const familyKey = String(configuratorContext?.family_key || "").trim().toUpperCase();
  const tagged = (Array.isArray(lines) ? lines : [])
    .map((l) => ({ line: l, meta: parseJsonOrNull(l?.line_description) || {} }))
    .filter(({ meta }) => meta.scope_role);
  if (!tagged.length) return "";
  const generator = tagged.find(({ meta }) => meta.scope_role === "psa_generator");
  const isNitrogen =
    familyKey === "NGEN" ||
    familyKey === "NGENX" ||
    (!familyKey && /^NGEN/i.test(String(generator?.line?.item_code || generator?.line?.item_name || "")));
  if (!isNitrogen) return "";
  const img = nitrogenProcessImageDataUri();
  if (!img) return "";

  const blocks = SCOPE_DIAGRAM_BLOCKS.map((block) => {
    const rows = tagged.filter(({ meta }) => meta.scope_role === block.role);
    const absstem = rows.some(({ line }) => String(line?.scope_type || "included") === "included");
    const requirement = rows.map(({ meta }) => String(meta.scope_requirement || "").trim()).find(Boolean) || "";
    return { ...block, absstem, requirement };
  });

  const overlays = blocks
    .filter((b) => !b.absstem)
    .map(
      (b) =>
        `<div class="scope-dia-shade" style="left:${b.from}%; width:${b.to - b.from}%;"></div>`
    )
    .join("");
  const labels = blocks
    .map((b) => {
      const tone = b.absstem ? "scope-dia-tag scope-dia-tag--ours" : "scope-dia-tag scope-dia-tag--client";
      const status = b.absstem ? "✓ Absstem Supply" : "Client Scope";
      return `
        <div class="scope-dia-cell" style="width:${b.to - b.from}%;">
          <div class="${tone}">
            <div class="scope-dia-name">${escapeHtml(b.label)}</div>
            <div class="scope-dia-status">${escapeHtml(status)}</div>
            ${!b.absstem && b.requirement ? `<div class="scope-dia-req">${escapeHtml(b.requirement)}</div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
  const hasClient = blocks.some((b) => !b.absstem);

  return `
    <style>
      .scope-dia { margin-top: 14px; break-inside: avoid; page-break-inside: avoid; }
      .scope-dia-frame { position: relative; width: 100%; line-height: 0; }
      .scope-dia-frame img { width: 100%; height: auto; display: block; }
      .scope-dia-shade {
        position: absolute; top: 0; bottom: 0;
        background: rgba(248, 250, 252, 0.78);
        border: 2px dashed #d97706; box-sizing: border-box;
      }
      .scope-dia-row { display: flex; margin-top: 6px; }
      .scope-dia-cell { box-sizing: border-box; padding: 0 3px; }
      .scope-dia-tag { border-radius: 6px; padding: 5px 6px; text-align: center; line-height: 1.3; }
      .scope-dia-tag--ours { background: #ecfdf3; border: 1px solid #86d3a5; color: #136b3c; }
      .scope-dia-tag--client { background: #fff7ea; border: 1px dashed #d97706; color: #8b4a00; }
      .scope-dia-name { font-size: 10px; font-weight: 700; color: #1f2937; }
      .scope-dia-status { font-size: 10px; font-weight: 800; margin-top: 2px; }
      .scope-dia-req { font-size: 9.5px; margin-top: 2px; }
    </style>
    <div class="scope-dia">
      <div class="h2" style="margin-top:0;">Scope of Supply at a Glance</div>
      <div class="scope-dia-frame">
        <img src="${img}" alt="Nitrogen PSA system" />
        ${overlays}
      </div>
      <div class="scope-dia-row">${labels}</div>
      ${
        hasClient
          ? `<div class="muted" style="margin-top:6px;">Shaded sections are to be arranged by the client to the minimum requirement stated.</div>`
          : ""
      }
    </div>
  `;
}

function scopeOfSupplyHtml(lines) {
  const clientLines = quoteLinesByScope(lines, "client_scope");
  if (!clientLines.length) return "";
  const rows = [...includedQuoteLines(lines), ...clientLines];
  return `
    <div class="h2" style="margin-top:16px;">Scope of Supply</div>
    <table class="simple">
      <thead>
        <tr>
          <th style="width: 32%;">Component</th>
          <th style="width: 11%; text-align:center;">Absstem</th>
          <th style="width: 11%; text-align:center;">Client</th>
          <th>Requirement / Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((l) => {
            const isClient = String(l?.scope_type || "included") === "client_scope";
            const label = resolveProductMasterLabel(l) || resolveProductMasterCode(l);
            const remarks = isClient ? lineRemarks(l) || "To be supplied by client." : "";
            return `
              <tr>
                <td>${escapeHtml(label)}</td>
                <td style="text-align:center;">${isClient ? "" : "✓"}</td>
                <td style="text-align:center;">${isClient ? "✓" : ""}</td>
                <td>${escapeHtml(remarks)}</td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
    <div class="muted" style="margin-top:6px;">Items marked Client are not included in the offer price.</div>
  `;
}

/** Exact Product Master nomenclature preferred for customer-facing PDF labels. */
function resolveProductMasterLabel(line) {
  return String(
    line?.product_item_name ||
      line?.item_name ||
      line?.product_item_code ||
      line?.item_code ||
      ""
  ).trim();
}

function resolveProductMasterCode(line) {
  return String(line?.product_item_code || line?.item_code || "").trim();
}

function detectPrimaryModelPattern(configuratorContext) {
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const familyKey = String(cfg.family_key || "").trim().toUpperCase();
  if (familyKey === "NGEN" || familyKey === "NGENX") return /ngen/i;
  if (familyKey === "IDOS" || familyKey === "IDOS_C") return /idos/i;
  if (familyKey === "MEDO" || familyKey === "MEDO_C") return /medo/i;
  return null;
}

function splitPackageLines(lines, configuratorContext) {
  const included = includedQuoteLines(lines);
  const pattern = detectPrimaryModelPattern(configuratorContext);
  let primaryIdx = -1;
  if (pattern) {
    primaryIdx = included.findIndex((l) => pattern.test(String(l?.item_code || l?.item_name || l?.product_item_name || "")));
  }
  if (primaryIdx < 0) {
    primaryIdx = included.findIndex((l) => isCoreGeneratorLine(l, configuratorContext));
  }
  if (primaryIdx < 0) primaryIdx = included.length ? 0 : -1;
  const primary = primaryIdx >= 0 ? included[primaryIdx] : null;
  const components = primary
    ? included.filter((_, idx) => idx !== primaryIdx)
    : included.slice();
  return { primary, components, included };
}

function normalizeParamLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const PACKAGE_MODULE_FAMILY_KEYS = new Set(["AIR_SYSTEM", "GAS_STORAGE", "BOOSTER"]);
const FAMILY_RANGE_ROW_PATTERN = /\b(purity|flow range|flow envelope|delivery pressure|warranty)\b/;

function renderFamilyBrochureHtml(profile, { captionLabels = [], compact = false, specsHtml = "" } = {}) {
  if (!profile) return "";
  const features = !compact && Array.isArray(profile.unique_features) ? profile.unique_features.filter(Boolean) : [];
  const productMasterLabels = new Set(captionLabels.map(normalizeParamLabel).filter(Boolean));
  const hasModelSpecs = productMasterLabels.size > 0;
  const ambient =
    !compact && Array.isArray(profile.ambient_design)
      ? profile.ambient_design.filter((row) => {
          if (!row || !row.label || !row.value) return false;
          const label = normalizeParamLabel(row.label);
          if (productMasterLabels.has(label)) return false;
          if (hasModelSpecs && FAMILY_RANGE_ROW_PATTERN.test(label)) return false;
          return true;
        })
      : [];
  const writeUp = String(profile.write_up || "").trim();
  const title = String(profile.title || "").trim();
  const tagline = String(profile.tagline || "").trim();
  const hasStarredText = [writeUp, ...features, ...ambient.map((row) => `${row.label} ${row.value}`)].some((text) =>
    String(text).includes("*")
  );

  return `
    <div class="brochure">
      ${title ? `<div class="brochure-title">${escapeHtml(title)}</div>` : ""}
      ${tagline ? `<div class="brochure-tagline">${escapeHtml(tagline)}</div>` : ""}
      ${writeUp ? `<div class="brochure-writeup">${escapeHtml(writeUp)}</div>` : ""}
    </div>
    ${specsHtml}
    <div class="brochure-details">
      ${
        features.length
          ? `<div class="h2" style="margin-top:12px;">Unique Features</div>
             <ul class="brochure-features">${features.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
          : ""
      }
      ${
        ambient.length
          ? `<div class="keep-together">
             <div class="h2" style="margin-top:12px;">Features</div>
             <table class="attrs brochure-ambient">
               <thead><tr><th style="width:42%;">Item</th><th>Details</th></tr></thead>
               <tbody>
                 ${ambient
                   .map(
                     (row) =>
                       `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.value)}</td></tr>`
                   )
                   .join("")}
               </tbody>
             </table>
             </div>`
          : ""
      }
      ${hasStarredText ? `<div class="brochure-note">* IIoT / remote monitoring features are subject to Absstem terms &amp; conditions where marked.</div>` : ""}
    </div>
  `;
}

function sanitizeCustomerHighlights(highlights) {
  const rows = Array.isArray(highlights) ? highlights : [];
  return rows
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .filter((x) => !/^(quote:|total:|subtotal|deliverables:|included items:|offered model:)/i.test(x));
}

function sanitizeGasWording(text, configuratorContext) {
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const familyKey = String(cfg.family_key || "").trim().toUpperCase();
  const base = String(text || "");
  if (familyKey === "NGEN" || familyKey === "NGENX") {
    return base
      .replace(/oxygen\s+and\s+nitrogen/gi, "nitrogen")
      .replace(/oxygen\s*&\s*nitrogen/gi, "nitrogen")
      .replace(/oxygen\/nitrogen/gi, "nitrogen");
  }
  if (familyKey === "IDOS" || familyKey === "IDOS_C" || familyKey === "MEDO" || familyKey === "MEDO_C") {
    return base
      .replace(/nitrogen\s+and\s+oxygen/gi, "oxygen")
      .replace(/nitrogen\s*&\s*oxygen/gi, "oxygen")
      .replace(/nitrogen\/oxygen/gi, "oxygen");
  }
  return base;
}

function buildCustomerCoverText({ quote, pdfProfile, primaryLine, configuratorContext }) {
  const attentionTo = String(quote?.attention_to || "Sir/Madam").trim() || "Sir/Madam";
  const customer = String(quote?.customer_name || "").trim();
  const primaryModel = resolveProductMasterLabel(primaryLine) || resolveProductMasterCode(primaryLine);
  const intro = buildConfiguratorCoverIntro(configuratorContext);
  const offerLine = primaryModel ? `Offered model: ${primaryModel}.` : "";
  const body = [
    `Dear ${attentionTo},`,
    intro || "Please find attached our quotation for your kind consideration.",
    customer && offerLine ? `For ${customer}, ${offerLine}` : offerLine,
    "Please review the offered package, technical schedule, commercial offer, and terms & conditions enclosed with this quotation.",
    "Regards,",
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .join("\n\n");
  return body;
}

function buildPdfConfiguratorProfile(configuratorContext) {
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const familyKey = String(cfg.family_key || "").trim().toUpperCase();
  const variantKey = String(cfg.variant_key || "").trim().toUpperCase();
  const familyName = String(cfg.family_name || "").trim();
  const proposalTitle = "Absstem's Value Proposition";

  const base = {
    quotationTitle: proposalTitle,
    coverTagline: familyName ? `${familyName} proposal configuration` : "Configured proposal",
    executiveTitle: "Executive Summary",
    scopeTitle: "Scope Summary",
    scopeIntro: "This section provides a concise scope overview. Refer annexures for full technical and compliance details.",
    problemLabel: "Need / Problem",
    solutionLabel: "Proposed Solution",
    highlightsLabel: "Highlights",
    proofLabel: "Proposal DNA",
    noteLabel: "Notes",
    deliverablesLabel: "Deliverables",
    technicalHighlightsLabel: "Technical Highlights",
    exclusionsLabel: "Exclusions",
    assumptionsLabel: "Assumptions",
    acceptanceLabel: "Acceptance / Testing",
    responsibilitiesLabel: "Responsibilities",
    technicalSheetTitle: "Technical Sheet",
  };

  if (familyKey === "MEDO") {
    return {
      ...base,
      coverTagline: "AT healthcare continuity proposal",
      executiveTitle: "Healthcare Continuity Summary",
      scopeTitle: "Healthcare Scope Summary",
      scopeIntro: "This section provides a healthcare-facing scope summary for the proposed oxygen package. Refer annexures for detailed technical and compliance information.",
      problemLabel: "Clinical Need",
      solutionLabel: "Proposed Healthcare Solution",
      highlightsLabel: "Healthcare Highlights",
      proofLabel: "Healthcare Proposal DNA",
      noteLabel: "Healthcare Notes",
      technicalSheetTitle: "Healthcare Technical Schedule",
    };
  }
  if (familyKey === "MEDO_C") {
    return {
      ...base,
      coverTagline: "AT compact healthcare proposal",
      executiveTitle: "Compact Healthcare Summary",
      scopeTitle: "Compact Healthcare Scope Summary",
      scopeIntro: "This section provides a compact healthcare scope overview for the proposed oxygen package. Refer annexures for detailed technical and compliance information.",
      problemLabel: "Clinical Need",
      solutionLabel: "Proposed Compact Healthcare Solution",
      highlightsLabel: "Healthcare Highlights",
      proofLabel: "Compact Healthcare DNA",
      noteLabel: "Healthcare Notes",
      technicalSheetTitle: "Healthcare Technical Schedule",
    };
  }
  if (familyKey === "IDOS") {
    return {
      ...base,
      coverTagline: "Industrial oxygen process proposal",
      executiveTitle: "Industrial Oxygen Solution Summary",
      scopeTitle: "Industrial Oxygen Scope Summary",
      scopeIntro: "This section provides a process-oriented scope summary for the proposed oxygen package. Refer annexures for full technical and compliance details.",
      problemLabel: "Process Need",
      solutionLabel: "Proposed Process Solution",
      highlightsLabel: "Process Highlights",
      proofLabel: "Industrial Proposal DNA",
      technicalSheetTitle: "Industrial Oxygen Technical Schedule",
    };
  }
  if (familyKey === "IDOS_C") {
    return {
      ...base,
      coverTagline: "Compact industrial oxygen proposal",
      executiveTitle: "Compact Industrial Oxygen Summary",
      scopeTitle: "Compact Industrial Oxygen Scope Summary",
      scopeIntro: "This section provides a compact process-oriented scope summary for the proposed oxygen package. Refer annexures for full technical and compliance details.",
      problemLabel: "Process Need",
      solutionLabel: "Proposed Compact Process Solution",
      highlightsLabel: "Process Highlights",
      proofLabel: "Compact Industrial DNA",
      technicalSheetTitle: "Industrial Oxygen Technical Schedule",
    };
  }
  if (familyKey === "NGENX") {
    return {
      ...base,
      coverTagline: "Compact value nitrogen proposal",
      executiveTitle: "Compact Nitrogen Solution Summary",
      scopeTitle: "Compact Nitrogen Scope Summary",
      scopeIntro: "This section provides a compact nitrogen scope overview for the proposed package. Refer annexures for full technical and compliance details.",
      problemLabel: "Application Need",
      solutionLabel: "Proposed Compact Solution",
      highlightsLabel: "Compact Highlights",
      proofLabel: "Compact Proposal DNA",
      technicalSheetTitle: "Nitrogen Technical Schedule",
    };
  }
  if (familyKey === "NGEN") {
    if (variantKey === "UH") {
      return {
        ...base,
        coverTagline: "Ultra-high-purity nitrogen proposal",
        executiveTitle: "Purity-Led Nitrogen Solution Summary",
        scopeTitle: "Purity-Led Nitrogen Scope Summary",
        problemLabel: "Purity Need",
        solutionLabel: "Proposed Purity-Led Solution",
        highlightsLabel: "Purity Highlights",
        proofLabel: "Purity-Led Proposal DNA",
        technicalSheetTitle: "Nitrogen Technical Schedule",
      };
    }
    if (variantKey === "HF") {
      return {
        ...base,
        coverTagline: "High-flow nitrogen proposal",
        executiveTitle: "High-Flow Nitrogen Solution Summary",
        scopeTitle: "High-Flow Nitrogen Scope Summary",
        problemLabel: "Flow Need",
        solutionLabel: "Proposed High-Flow Solution",
        highlightsLabel: "Flow Highlights",
        proofLabel: "High-Flow Proposal DNA",
        technicalSheetTitle: "Nitrogen Technical Schedule",
      };
    }
    return {
      ...base,
      coverTagline: variantKey === "SH" ? "Balanced premium nitrogen proposal" : "Premium nitrogen proposal",
      executiveTitle: "Premium Nitrogen Solution Summary",
      scopeTitle: "Premium Nitrogen Scope Summary",
      problemLabel: "Application Need",
      solutionLabel: "Proposed Premium Solution",
      highlightsLabel: "Performance Highlights",
      proofLabel: "Premium Proposal DNA",
      technicalSheetTitle: "Nitrogen Technical Schedule",
    };
  }

  return base;
}

function renderAnnexureDividerHtml({ quote, revision, configuratorContext, groupName, annexureIndex, annexureCount }) {
  const status = revision?.revision_status || "draft";
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const pdfProfile = buildPdfConfiguratorProfile(cfg);
  const safeGroup = String(groupName || "").trim();
  const annexureTitle =
    cfg.family_key === "MEDO" || cfg.family_key === "MEDO_C"
      ? "Healthcare Annexure"
      : cfg.family_key === "IDOS" || cfg.family_key === "IDOS_C"
        ? "Industrial Oxygen Annexure"
        : cfg.family_key === "NGEN" || cfg.family_key === "NGENX"
          ? "Nitrogen Annexure"
          : "Technical Annexure";
  const annexureSubtitle = safeGroup
    ? `${safeGroup} technical scope reference`
    : `${pdfProfile.quotationTitle} supporting technical reference`;
  const familyLine = [cfg.family_name, cfg.variant_label].filter(Boolean).join(" • ");
  const sequenceLine =
    Number.isFinite(Number(annexureIndex)) && Number.isFinite(Number(annexureCount)) && Number(annexureCount) > 0
      ? `Annexure ${annexureIndex} of ${annexureCount}`
      : "Annexure";

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(quote?.quote_number || "Quote")} Annexure</title>
      <style>
        @page { size: A4; margin: 14mm 14mm 30mm 14mm; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; }
        .page { position: relative; min-height: 100vh; padding-top: 32px; box-sizing: border-box; }
        .watermark {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%) rotate(-24deg);
          font-size: 64px;
          font-weight: 800;
          letter-spacing: 2px;
          color: rgba(0,0,0,0.035);
          z-index: 0;
          user-select: none;
          pointer-events: none;
          white-space: nowrap;
        }
        .content { position: relative; z-index: 1; min-height: 92vh; display: flex; flex-direction: column; justify-content: center; }
        .chip { display: inline-block; padding: 6px 10px; border-radius: 999px; background: #eff6ff; color: #1d4ed8; font-size: 11px; font-weight: 700; letter-spacing: 0.3px; text-transform: uppercase; }
        .h1 { font-size: 28px; font-weight: 800; margin: 16px 0 8px; }
        .h2 { font-size: 16px; font-weight: 700; color: #334155; margin: 0 0 12px; }
        .muted { font-size: 12px; color: #475569; line-height: 1.7; }
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        <div class="content">
          <div class="chip">${escapeHtml(sequenceLine)}</div>
          <div class="h1">${escapeHtml(annexureTitle)}</div>
          <div class="h2">${escapeHtml(annexureSubtitle)}</div>
          <div class="muted">
            This annexure forms part of ${escapeHtml(pdfProfile.quotationTitle)} and provides the supporting technical scope reference for the configured solution.
          </div>
        </div>
      </div>
    </body>
  </html>`;
}

function buildConfiguratorCoverIntro(configuratorContext) {
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const familyKey = String(cfg.family_key || "").trim().toUpperCase();
  const variantKey = String(cfg.variant_key || "").trim().toUpperCase();
  const modelText = String(cfg.selected_model || "").trim();
  const modelSuffix = modelText ? ` based on ${modelText}` : "";

  if (familyKey === "MEDO") {
    return `We are pleased to submit our proposal for a medical oxygen solution${modelSuffix}, designed to support healthcare continuity of supply and dependable day-to-day operation.`;
  }
  if (familyKey === "MEDO_C") {
    return `We are pleased to submit our proposal for a compact medical oxygen solution${modelSuffix}, designed for space-aware healthcare deployment while preserving continuity of supply.`;
  }
  if (familyKey === "IDOS") {
    return `We are pleased to submit our proposal for an industrial oxygen solution${modelSuffix}, designed to support dependable process oxygen availability for plant operations.`;
  }
  if (familyKey === "IDOS_C") {
    return `We are pleased to submit our proposal for a compact industrial oxygen solution${modelSuffix}, designed for footprint-aware deployment and dependable process use.`;
  }
  if (familyKey === "NGENX") {
    return `We are pleased to submit our proposal for a compact nitrogen solution${modelSuffix}, designed for cleaner deployment, practical adoption, and value-focused operation.`;
  }
  if (familyKey === "NGEN" && variantKey === "UH") {
    return `We are pleased to submit our proposal for a purity-led nitrogen solution${modelSuffix}, designed for quality-sensitive applications with stronger performance expectations.`;
  }
  if (familyKey === "NGEN" && variantKey === "HF") {
    return `We are pleased to submit our proposal for a high-flow nitrogen solution${modelSuffix}, designed for stronger throughput requirements and dependable industrial duty.`;
  }
  if (familyKey === "NGEN") {
    return `We are pleased to submit our proposal for a premium nitrogen solution${modelSuffix}, designed for dependable industrial performance, controls, and reliability.`;
  }
  return "";
}

function injectConfiguratorCoverTone(baseText, configuratorContext) {
  const intro = buildConfiguratorCoverIntro(configuratorContext);
  const trimmedBase = String(baseText || "").trim();
  if (!intro) return trimmedBase;
  if (!trimmedBase) return intro;
  const normalizedBase = trimmedBase.toLowerCase();
  if (normalizedBase.includes(intro.toLowerCase())) return trimmedBase;
  const blocks = trimmedBase.split(/\n\s*\n/g).map((block) => block.trim()).filter(Boolean);
  if (!blocks.length) return intro;
  if (/^dear\b/i.test(blocks[0])) {
    return [blocks[0], intro, ...blocks.slice(1)].join("\n\n");
  }
  return [intro, ...blocks].join("\n\n");
}

function normalizeSentenceSpacing(text) {
  return String(text || "")
    .replace(/([A-Za-z]),([A-Za-z])/g, "$1, $2")
    .replace(/([a-z]{2,})\.([A-Z][a-z])/g, "$1. $2");
}

const SHIELD_SPARE_REMARK_PREFIX = /^absstem shield recommended spare/i;

function sparesLineCompatibility(line, sparesContext) {
  const parts = [];
  const mapped = sparesContext?.compatibleByProductId?.[Number(line?.product_id)];
  if (mapped) parts.push(mapped);
  const remarks = lineRemarks(line);
  if (SHIELD_SPARE_REMARK_PREFIX.test(remarks)) {
    for (const segment of remarks.split("•").slice(1)) {
      const text = segment.trim().replace(/^installed item\s*/i, "");
      if (text) parts.push(text);
    }
  } else if (remarks) {
    parts.push(remarks);
  }
  const customerCode = String(line?.customer_item_code || "").trim();
  if (customerCode) parts.push(`Your part no. ${customerCode}`);
  return Array.from(new Set(parts)).join("; ");
}

function buildSparesCoverText({ quote, sparesContext, lineCount }) {
  const attentionTo = String(quote?.attention_to || "Sir/Madam").trim() || "Sir/Madam";
  const equipment = String(sparesContext?.equipment || "").trim();
  return [
    `Dear ${attentionTo},`,
    equipment
      ? `Thank you for your enquiry. Please find below our offer for genuine spares and consumables for your ${equipment}.`
      : "Thank you for your enquiry. Please find below our offer for genuine spares and consumables for your Absstem equipment.",
    lineCount
      ? `The enclosed schedule lists ${lineCount} item${lineCount === 1 ? "" : "s"} with part numbers, quantities and unit rates. Kindly verify the part numbers against your equipment before placing the order.`
      : "",
    "Please review the spares schedule, commercial offer and terms of supply enclosed with this quotation.",
    "Regards,",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderCoverAndTechnicalHtml({
  quote,
  revision,
  lines,
  currencies,
  attributesByProductId,
  coverLetterText,
  salesUser,
  companyProfile,
  executiveSummary,
  scopeSummary,
  configuratorContext,
  familyContent,
  annexuresMerged = false,
  offerType = "completes",
  sparesContext = null,
}) {
  const isSpares = offerType === "spares";
  const currencyCode = currencies?.quote_currency_code || "";
  const revNo = revision?.revision_no ?? "—";
  const status = revision?.revision_status || "draft";
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const pdfProfile = buildPdfConfiguratorProfile(cfg);
  const { primary: primaryLine, components: componentLines, included: includedLines } = splitPackageLines(lines, configuratorContext);
  const primaryModelLabel = resolveProductMasterLabel(primaryLine) || resolveProductMasterCode(primaryLine);
  const primaryBrochure = primaryLine
    ? resolveFamilyBrochureProfile({ configuratorContext, line: primaryLine, content: familyContent })
    : null;

  const customerAddress = [
    quote?.address_line1,
    quote?.address_line2,
    quote?.address_line3,
    [quote?.city, quote?.state, quote?.pincode].filter(Boolean).join(" "),
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  const templateCoverText = typeof coverLetterText === "string" ? coverLetterText.trim() : "";
  const coverText = templateCoverText
    ? templateCoverText
    : isSpares
      ? buildSparesCoverText({ quote, sparesContext, lineCount: includedQuoteLines(lines).length })
      : sanitizeGasWording(buildCustomerCoverText({ quote, pdfProfile, primaryLine, configuratorContext }), configuratorContext);

  const coverBlocks = normalizeSentenceSpacing(coverText)
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const coverHtml = coverBlocks
    .map((block) => `<p>${escapeHtml(block).replaceAll("\n", "<br />")}</p>`)
    .join("");
  const signatureName = escapeHtml(salesUser?.full_name || "");
  const signatureDesignation = escapeHtml(salesUser?.designation || "");
  const signaturePhone = escapeHtml(salesUser?.phone || companyProfile?.contact_phone || "");
  const signatureEmail = escapeHtml(salesUser?.email || companyProfile?.contact_email || "");
  const companyName = escapeHtml(companyProfile?.company_name || "Absstem Industrial Solutions Pvt. Ltd.");
  const companyWebsite = escapeHtml(companyProfile?.website || "");
  const logoDataUrl = escapeHtml(companyProfile?.logo_data_url || "");
  const signatureDataUrl = escapeHtml(companyProfile?.signature_data_url || "");

  const exec = executiveSummary && typeof executiveSummary === "object" ? executiveSummary : {};
  const scope = scopeSummary && typeof scopeSummary === "object" ? scopeSummary : {};
  const deliverables = includedLines
    .map((l) => ({
      model: resolveProductMasterLabel(l) || resolveProductMasterCode(l),
      description: String(l?.product_description || l?.product_group_name || "").trim(),
      qty: Number(l?.qty || 0) || 0,
      remarks: "",
    }))
    .filter((row) => row.model && row.qty > 0);

  function listHtml(items) {
    const list = (Array.isArray(items) ? items : []).map((x) => String(x || "").trim()).filter(Boolean);
    if (!list.length) return "";
    return `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  }

  function responsibilitiesHtml(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object");
    if (!list.length) return "";
    return `
      <table class="simple">
        <thead>
          <tr><th style="width: 30%;">Party</th><th>Responsibility</th></tr>
        </thead>
        <tbody>
          ${list
            .map((row) => {
              const party = String(row.party || "").trim();
              const responsibility = String(row.responsibility || "").trim();
              if (!party && !responsibility) return "";
              return `<tr><td>${escapeHtml(party)}</td><td>${escapeHtml(responsibility)}</td></tr>`;
            })
            .filter(Boolean)
            .join("")}
        </tbody>
      </table>
    `;
  }

  const userHighlights = sanitizeCustomerHighlights(exec.highlights);
  const dnaHighlights = buildProposalDnaHighlights(cfg);
  const computedHighlights = [
    primaryModelLabel ? `Offered model: ${primaryModelLabel}` : "",
    Number.isFinite(Number(revision?.subtotal_quote || 0)) && Number(revision?.subtotal_quote || 0) > 0
      ? `Subtotal (excl. GST): ${Number(revision.subtotal_quote).toFixed(2)}`
      : "",
    deliverables.length ? `Included items: ${deliverables.length}` : "",
  ].filter(Boolean);
  const mergedHighlights = Array.from(new Set([...dnaHighlights, ...computedHighlights, ...userHighlights])).slice(0, 8);
  const execProblem = String(exec.problem || cfg.preview_problem || "").trim();
  const execSolution = String(exec.solution || cfg.preview_solution || "").trim();
  const snapshotRows = [
    quote?.quote_number ? { k: "Quote No", v: quote.quote_number } : null,
    quote?.customer_name ? { k: "Customer", v: quote.customer_name } : null,
    cfg.family_name || cfg.variant_label ? { k: "Product Family", v: [cfg.family_name, cfg.variant_label].filter(Boolean).join(" • ") } : null,
    primaryModelLabel ? { k: "Offered Model", v: primaryModelLabel } : null,
    currencyCode ? { k: "Currency", v: currencyCode } : null,
    Number.isFinite(Number(revision?.subtotal_quote || 0)) && Number(revision?.subtotal_quote || 0) > 0
      ? { k: "Subtotal (excl. GST)", v: fmtMoney(revision.subtotal_quote) }
      : null,
  ].filter(Boolean);
  const snapshotHtml = snapshotRows.length
    ? `
      <div class="side-card">
        <div class="side-title">Proposal Snapshot</div>
        ${snapshotRows
          .map((row) => `<div class="kv"><div class="k">${escapeHtml(row.k)}</div><div class="v">${escapeHtml(row.v)}</div></div>`)
          .join("")}
      </div>
    `
    : "";

  const primaryRow = primaryLine
    ? {
        model: resolveProductMasterLabel(primaryLine) || resolveProductMasterCode(primaryLine),
        code: resolveProductMasterCode(primaryLine),
        description: String(primaryLine?.product_description || primaryLine?.product_group_name || "").trim(),
        qty: Number(primaryLine?.qty || 0) || 0,
      }
    : null;
  const componentRows = componentLines
    .map((l) => ({
      model: resolveProductMasterLabel(l) || resolveProductMasterCode(l),
      code: resolveProductMasterCode(l),
      description: String(l?.product_description || l?.product_group_name || "").trim(),
      qty: Number(l?.qty || 0) || 0,
    }))
    .filter((row) => row.model && row.qty > 0);

  const primaryImage = productImageDataUri(cfg.family_key || primaryBrochure?.family_key);
  const primaryHtml = primaryRow
    ? `
      <div class="card" style="display:flex; gap:14px; align-items:center;">
        ${primaryImage ? `<img src="${primaryImage}" alt="" style="width:92px; height:110px; object-fit:contain; flex:none;" />` : ""}
        <div style="flex:1;">
        <div class="card-title">Primary Equipment</div>
        <div class="card-sub">${escapeHtml(primaryRow.model)}</div>
        ${
          primaryRow.code && primaryRow.code !== primaryRow.model
            ? `<div class="muted" style="margin-top:4px;">Code: ${escapeHtml(primaryRow.code)}</div>`
            : ""
        }
        ${primaryRow.description ? `<div class="muted" style="margin-top:6px;">${escapeHtml(primaryRow.description)}</div>` : ""}
        ${Number.isFinite(primaryRow.qty) && primaryRow.qty > 0 ? `<div class="muted" style="margin-top:10px;">Qty: ${escapeHtml(String(primaryRow.qty))}</div>` : ""}
        </div>
      </div>
    `
    : "";

  const componentsHtml = componentRows.length
    ? `
      <table class="simple">
        <thead>
          <tr>
            <th style="width: 7%;">✓</th>
            <th style="width: 28%;">Item</th>
            <th>Description</th>
            <th style="width: 10%; text-align:right;">Qty</th>
          </tr>
        </thead>
        <tbody>
          ${componentRows
            .map((row, idx) => {
              return `
                <tr>
                  <td>✓</td>
                  <td>${escapeHtml(row.model)}</td>
                  <td>${escapeHtml(row.description)}</td>
                  <td style="text-align:right;">${escapeHtml(String(row.qty))}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `
    : `<div class="muted">No additional included components listed.</div>`;

  const packageHtml = `
    <div class="page">
      ${watermarkHtml(status)}
      ${BRAND_STRIPE_HTML}
      <div class="h1">Offered Package</div>
      <div class="muted">${escapeHtml(
        annexuresMerged
          ? pdfProfile.scopeIntro
          : String(pdfProfile.scopeIntro || "").replace(/Refer annexures[^.]*\./i, "Detailed technical schedules follow.")
      )}</div>
      ${scopeDiagramHtml(lines, configuratorContext)}
      <div style="height: 10px;"></div>
      ${primaryHtml}
      <div class="h2" style="margin-top:16px;">Included Package Components</div>
      ${componentsHtml}
      ${scopeOfSupplyHtml(lines)}
      ${Array.isArray(scope.exclusions) && scope.exclusions.length ? `<div class="h2">${escapeHtml(pdfProfile.exclusionsLabel)}</div>${listHtml(scope.exclusions)}` : ""}
      ${Array.isArray(scope.assumptions) && scope.assumptions.length ? `<div class="h2">${escapeHtml(pdfProfile.assumptionsLabel)}</div>${listHtml(scope.assumptions)}` : ""}
      ${Array.isArray(scope.acceptance) && scope.acceptance.length ? `<div class="h2">${escapeHtml(pdfProfile.acceptanceLabel)}</div>${listHtml(scope.acceptance)}` : ""}
      ${Array.isArray(scope.responsibilities) && scope.responsibilities.length ? `<div class="h2">${escapeHtml(pdfProfile.responsibilitiesLabel)}</div>${responsibilitiesHtml(scope.responsibilities)}` : ""}
    </div>
  `;

  const technicalScheduleLines = includedQuoteLines(lines);
  const renderedBrochureKeys = new Set();
  const technicalBlocks = technicalScheduleLines
    .map((l) => {
      const productId = l.product_id ? Number(l.product_id) : null;
      const attrs = productId ? attributesByProductId.get(productId) || [] : [];
      const model = resolveProductMasterLabel(l) || resolveProductMasterCode(l);
      const code = resolveProductMasterCode(l);
      const group = String(l.product_group_name || l.product_category_name || "").trim();
      const brochureProfile = resolveFamilyBrochureProfile({ configuratorContext, line: l, content: familyContent });
      const profileKey = brochureProfileKey(brochureProfile);
      const showBrochure = Boolean(brochureProfile && profileKey && !renderedBrochureKeys.has(profileKey));
      if (showBrochure) renderedBrochureKeys.add(profileKey);

      const isModule = PACKAGE_MODULE_FAMILY_KEYS.has(String(brochureProfile?.family_key || "").toUpperCase());
      const attrsHtml = attrs.length
        ? `
          <table class="attrs">
            <thead>
              <tr><th style="width: 45%;">Parameter</th><th>Value</th></tr>
            </thead>
            <tbody>
              ${attrs
                .map(
                  (a) => `
                    <tr>
                      <td>${escapeHtml(a.caption || "")}</td>
                      <td>${escapeHtml(a.spec_value || "")}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        `
        : "";
      const specsHtml = attrsHtml
        ? `<div class="keep-together"><div class="h2" style="margin-top:14px;">Technical Specifications</div>${attrsHtml}</div>`
        : "";
      const brochureHtml = showBrochure
        ? renderFamilyBrochureHtml(brochureProfile, { captionLabels: attrs.map((a) => a.caption), compact: isModule, specsHtml })
        : specsHtml;

      const bodyHtml = `
          <div class="tech-model">${escapeHtml(model)}</div>
          ${
            code && code !== model
              ? `<div class="muted" style="margin-top:2px;">Item code: ${escapeHtml(code)}</div>`
              : ""
          }
          ${group ? `<div class="muted" style="margin-top:4px;">${escapeHtml(group)}</div>` : ""}
          ${brochureHtml}
      `;
      return { isModule, bodyHtml };
    });

  const technicalPage = (inner) => `
        <div class="page">
          ${watermarkHtml(status)}
          ${BRAND_STRIPE_HTML}
          <div class="h1">${escapeHtml(pdfProfile.technicalSheetTitle)}</div>
          ${inner}
        </div>
      `;
  const technicalPages = [];
  for (const block of technicalBlocks) {
    if (block.isModule && technicalPages.length) {
      technicalPages[technicalPages.length - 1].push(`<div class="tech-block">${block.bodyHtml}</div>`);
    } else {
      technicalPages.push([block.isModule ? `<div class="tech-block">${block.bodyHtml}</div>` : block.bodyHtml]);
    }
  }
  const technicalHtml = technicalPages.map((blocks) => technicalPage(blocks.join(""))).join("");

  const heroImage = productImageDataUri(cfg.family_key || primaryBrochure?.family_key);
  const titleFamilyKey = String(cfg.family_key || primaryBrochure?.family_key || "").toUpperCase();
  const isGeneratorFamily = /^(NGEN|MEDO|IDOS)/.test(titleFamilyKey);
  const titleText = String(primaryBrochure?.title || pdfProfile.quotationTitle || "Techno-Commercial Proposal").trim();
  const titleTagline = String(primaryBrochure?.tagline || "").trim();
  const customerCityLine = [quote?.city, quote?.state].filter(Boolean).join(", ");
  const titleRows = [
    ["Quotation No", quote?.quote_number],
    ["Date", fmtDate(quoteOfferDate(quote, revision))],
    ["Revision", revNo],
    ["Offered Model", primaryModelLabel],
    ["Valid Till", quote?.quote_valid_till ? fmtDate(quote.quote_valid_till) : ""],
  ].filter(([, value]) => String(value ?? "").trim() && String(value) !== "—");
  const titleBadges = isGeneratorFamily
    ? ["ISO 13485:2016 Certified", "Industry-best Air-to-Gas Ratio", "IIoT Remote Monitoring", "Made in India"]
    : [];
  const titleFooter = [companyName, companyWebsite, signatureEmail, signaturePhone].filter(Boolean);
  const titlePageHtml = `
    <div class="page">
      ${watermarkHtml(status)}
      <div class="tp-band">
        <div class="tp-kicker">Techno-Commercial Proposal</div>
        <div class="tp-title">${escapeHtml(titleText)}</div>
        ${titleTagline ? `<div class="tp-tagline">${escapeHtml(titleTagline)}</div>` : ""}
      </div>
      ${heroImage ? `<div class="tp-hero"><img src="${heroImage}" alt="" /></div>` : `<div style="height:24px;"></div>`}
      ${BRAND_STRIPE_HTML}
      <div class="tp-grid">
        <div class="tp-box accent">
          <div class="tp-label">Prepared for</div>
          <div class="tp-customer">${escapeHtml(quote?.customer_name || "")}</div>
          ${customerCityLine ? `<div class="tp-sub">${escapeHtml(customerCityLine)}</div>` : ""}
          ${quote?.attention_to ? `<div class="tp-sub">Kind Attn: ${escapeHtml(quote.attention_to)}</div>` : ""}
        </div>
        <div class="tp-box accent-green">
          <div class="tp-label">Proposal Details</div>
          <div style="margin-top:6px;">
            ${titleRows.map(([k, v]) => `<div class="tp-kv"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div></div>`).join("")}
          </div>
        </div>
      </div>
      ${titleBadges.length ? `<div class="tp-badges">${titleBadges.map((b) => `<div class="tp-badge">${escapeHtml(b)}</div>`).join("")}</div>` : ""}
      ${titleFooter.length ? `<div class="tp-footer">${titleFooter.map((part, idx) => (idx === 0 ? `<strong>${part}</strong>` : part)).join(" &nbsp;•&nbsp; ")}</div>` : ""}
    </div>
  `;

  const sparesLines = isSpares ? includedQuoteLines(lines) : [];
  const shieldProfile = isSpares
    ? sparesLines
        .map((l) => resolveFamilyBrochureProfile({ configuratorContext, line: l, content: familyContent }))
        .find((p) => String(p?.family_key || "").toUpperCase() === "SHIELD") || null
    : null;
  const sparesEquipment = String(sparesContext?.equipment || "").trim();
  const sparesTitleRows = [
    ["Quotation No", quote?.quote_number],
    ["Date", fmtDate(quoteOfferDate(quote, revision))],
    ["Revision", revNo],
    ["Equipment", sparesEquipment],
    ["Items", sparesLines.length ? String(sparesLines.length) : ""],
    ["Valid Till", quote?.quote_valid_till ? fmtDate(quote.quote_valid_till) : ""],
  ].filter(([, value]) => String(value ?? "").trim() && String(value) !== "—");
  const sparesTitlePageHtml = isSpares
    ? `
    <div class="page">
      ${watermarkHtml(status)}
      <div class="tp-band">
        <div class="tp-kicker">Spares &amp; Service Proposal</div>
        <div class="tp-title">${shieldProfile ? "Absstem Shield &mdash; Spares &amp; Service" : "Spares &amp; Consumables Offer"}</div>
        <div class="tp-tagline">Genuine replacement parts and consumables, matched to your installed equipment.</div>
      </div>
      <div style="height:24px;"></div>
      ${BRAND_STRIPE_HTML}
      <div class="tp-grid">
        <div class="tp-box accent">
          <div class="tp-label">Prepared for</div>
          <div class="tp-customer">${escapeHtml(quote?.customer_name || "")}</div>
          ${customerCityLine ? `<div class="tp-sub">${escapeHtml(customerCityLine)}</div>` : ""}
          ${quote?.attention_to ? `<div class="tp-sub">Kind Attn: ${escapeHtml(quote.attention_to)}</div>` : ""}
        </div>
        <div class="tp-box accent-green">
          <div class="tp-label">Proposal Details</div>
          <div style="margin-top:6px;">
            ${sparesTitleRows.map(([k, v]) => `<div class="tp-kv"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div></div>`).join("")}
          </div>
        </div>
      </div>
      ${titleFooter.length ? `<div class="tp-footer">${titleFooter.map((part, idx) => (idx === 0 ? `<strong>${part}</strong>` : part)).join(" &nbsp;•&nbsp; ")}</div>` : ""}
    </div>
  `
    : "";
  const sparesScheduleHtml = isSpares
    ? `
    <div class="page">
      ${watermarkHtml(status)}
      ${BRAND_STRIPE_HTML}
      <div class="h1">Spares Schedule</div>
      <div class="muted">Parts offered under this quotation. Unit rates and totals follow in the commercial offer.</div>
      ${
        sparesEquipment
          ? `<div class="card" style="margin-top:12px;"><div class="card-title">Equipment</div><div class="card-sub" style="font-size:14px;">${escapeHtml(sparesEquipment)}</div></div>`
          : ""
      }
      <table class="simple spares-table" style="margin-top:14px;">
        <thead>
          <tr>
            <th style="width: 5%;">#</th>
            <th style="width: 17%;">Part No</th>
            <th>Description</th>
            <th style="width: 22%;">Compatible with</th>
            <th style="width: 10%;">HSN</th>
            <th style="width: 7%; text-align:right;">Qty</th>
            <th style="width: 7%;">UoM</th>
          </tr>
        </thead>
        <tbody>
          ${sparesLines
            .map((l, idx) => {
              const code = resolveProductMasterCode(l);
              const name = resolveProductMasterLabel(l) || code;
              const detail = String(l?.product_description || "").trim();
              const qty = Number(l?.qty);
              return `
                <tr>
                  <td>${idx + 1}</td>
                  <td class="part-no">${escapeHtml(code || "—")}</td>
                  <td>${escapeHtml(name)}${detail && detail !== name ? `<div class="muted" style="margin-top:3px;">${escapeHtml(detail)}</div>` : ""}</td>
                  <td>${escapeHtml(sparesLineCompatibility(l, sparesContext))}</td>
                  <td>${escapeHtml(l?.hsn_no || "")}</td>
                  <td style="text-align:right;">${Number.isFinite(qty) ? escapeHtml(String(qty)) : ""}</td>
                  <td>${escapeHtml(l?.product_uom || "Nos")}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
      ${Array.isArray(scope.exclusions) && scope.exclusions.length ? `<div class="h2">Exclusions</div>${listHtml(scope.exclusions)}` : ""}
      ${Array.isArray(scope.assumptions) && scope.assumptions.length ? `<div class="h2">Notes</div>${listHtml(scope.assumptions)}` : ""}
    </div>
  `
    : "";
  const shieldPageHtml = shieldProfile
    ? `
    <div class="page">
      ${watermarkHtml(status)}
      ${BRAND_STRIPE_HTML}
      <div class="h1">Absstem Shield</div>
      ${renderFamilyBrochureHtml(shieldProfile, { compact: true })}
    </div>
  `
    : "";

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(quote?.quote_number || "Quote")}</title>
      <style>
        @page { size: A4; margin: 14mm 14mm 30mm 14mm; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; }
        .page { page-break-after: always; padding-top: 46px; box-sizing: border-box; position: relative; }
        .page:last-child { page-break-after: auto; }
        .h1 { font-size: 20px; font-weight: 700; margin: 0 0 6px; }
        .muted { font-size: 12px; color: #444; }
        .row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
        .row .left { font-weight: 700; }
        .address { font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
        .attn { font-size: 13px; font-weight: 700; margin: 28px 0 22px; }
        .letter { font-size: 12px; line-height: 1.7; }
        .letter p { margin: 0 0 14px; }
        .sig { margin-top: 26px; }
        .sig .company { font-size: 15px; font-weight: 700; margin-bottom: 10px; }
        .sig .name { font-size: 14px; font-weight: 700; margin-bottom: 6px; }
        .sig .meta { font-size: 12px; margin-top: 4px; }
        .watermark {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%) rotate(-24deg);
          font-size: 64px;
          font-weight: 800;
          letter-spacing: 2px;
          color: rgba(0,0,0,0.035);
          z-index: 0;
          user-select: none;
          pointer-events: none;
          white-space: nowrap;
        }
        .page > * { position: relative; z-index: 1; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border-bottom: 1px solid #eee; padding: 8px; vertical-align: top; font-size: 12px; }
        th { text-align: left; background: #fafafa; }
        .attrs th, .attrs td { border: 1px solid #eee; padding: 5px 8px; }
        .attrs th { background: #fafafa; }
        .h2 { font-size: 14px; font-weight: 800; margin: 16px 0 8px; }
        .desc { font-size: 12px; line-height: 1.65; white-space: pre-wrap; color: #111; }
        ul { margin: 8px 0 0 18px; padding: 0; font-size: 12px; line-height: 1.6; }
        li { margin: 0 0 6px; }
        table.simple th, table.simple td { border: 1px solid #eee; }
        table.simple th { background: #fafafa; }
        table.simple tbody tr:nth-child(even) { background: #fbfdff; }
        .two-col { display: grid; grid-template-columns: 1.55fr 1fr; gap: 18px; align-items: start; }
        .side-card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; background: #fff; }
        .side-title { font-size: 12px; font-weight: 800; margin-bottom: 8px; }
        .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
        .kv:last-child { border-bottom: none; }
        .k { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.3px; }
        .v { font-size: 12px; font-weight: 700; color: #111; text-align: right; }
        .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; background: #fff; }
        .card-title { font-size: 12px; font-weight: 800; margin-bottom: 6px; }
        .card-sub { font-size: 16px; font-weight: 800; }
        .brochure {
          margin-top: 12px;
          border: 1px solid #e8edf5;
          border-radius: 10px;
          padding: 12px 14px;
          background: #fbfcfe;
        }
        .brochure-title { font-size: 13px; font-weight: 800; color: #0f172a; margin: 0 0 4px; }
        .brochure-tagline { font-size: 11px; color: #475569; margin: 0 0 8px; line-height: 1.45; }
        .brochure-writeup { font-size: 11.5px; line-height: 1.6; color: #1f2937; }
        .brochure-features { margin: 6px 0 0 16px; padding: 0; font-size: 11.5px; line-height: 1.55; }
        .brochure-features li { margin: 0 0 5px; }
        .brochure-ambient th, .brochure-ambient td { font-size: 11px; }
        .brochure-note { margin-top: 8px; font-size: 10px; color: #64748b; }
        .brochure-details:empty { display: none; }
        .tech-model { font-size: 12px; font-weight: 700; color: #111; }
        .tech-block { break-inside: avoid; page-break-inside: avoid; }
        * + .tech-block { margin-top: 18px; padding-top: 14px; border-top: 1px solid #e5e7eb; }
        .keep-together { break-inside: avoid; page-break-inside: avoid; }
        .attrs tr { break-inside: avoid; page-break-inside: avoid; }
        ${BRAND_CSS}
        ${WHY_ABSSTEM_CSS}
        .tp-band {
          background: linear-gradient(120deg, ${BRAND.blue} 0%, #0070c0 55%, ${BRAND.cyan} 100%);
          color: #fff; border-radius: 14px; padding: 22px 24px 20px; position: relative; overflow: hidden;
        }
        .tp-band::after {
          content: ""; position: absolute; right: -40px; top: -40px; width: 170px; height: 170px;
          border-radius: 50%; background: rgba(255,255,255,0.10);
        }
        .tp-kicker { font-size: 11px; font-weight: 800; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.9; }
        .tp-title { font-size: 26px; font-weight: 800; line-height: 1.2; margin-top: 8px; }
        .tp-tagline { font-size: 13px; line-height: 1.5; margin-top: 8px; opacity: 0.95; max-width: 88%; }
        .tp-hero { text-align: center; margin: 18px 0 10px; }
        .tp-hero img { max-height: 340px; max-width: 70%; object-fit: contain; }
        .tp-grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 14px; margin-top: 8px; }
        .tp-box { border: 1px solid ${BRAND.skyBorder}; border-radius: 12px; padding: 12px 14px; background: ${BRAND.sky}; }
        .tp-box.accent { border-top: 4px solid ${BRAND.red}; }
        .tp-box.accent-green { border-top: 4px solid ${BRAND.green}; }
        .tp-label { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: ${BRAND.blue}; }
        .tp-customer { font-size: 16px; font-weight: 800; color: ${BRAND.ink}; margin-top: 6px; }
        .tp-sub { font-size: 11.5px; color: #475569; margin-top: 4px; line-height: 1.5; }
        .tp-kv { display: grid; grid-template-columns: 42% 1fr; gap: 4px; font-size: 11.5px; padding: 3px 0; }
        .tp-kv .k { color: #475569; }
        .tp-kv .v { font-weight: 700; color: ${BRAND.ink}; }
        .tp-badges { display: flex; gap: 8px; margin-top: 14px; }
        .tp-badge { flex: 1; text-align: center; font-size: 10.5px; font-weight: 700; color: ${BRAND.blue}; border: 1px solid ${BRAND.skyBorder}; border-radius: 20px; padding: 7px 6px; background: #fff; }
        .tp-badge::before { content: "✓ "; color: ${BRAND.green}; font-weight: 800; }
        .tp-footer { margin-top: 14px; text-align: center; font-size: 11px; color: #475569; }
        .tp-footer strong { color: ${BRAND.blue}; }
        .spares-table td.part-no { font-weight: 800; color: ${BRAND.ink}; white-space: nowrap; }
      </style>
    </head>
    <body>
      ${isSpares ? sparesTitlePageHtml : titlePageHtml}
      <div class="page">
        ${watermarkHtml(status)}
        ${
          logoDataUrl
            ? `<div style="margin-bottom:16px;"><img src="${logoDataUrl}" alt="Company Logo" style="max-width:180px; max-height:70px;" /></div>`
            : ""
        }
        <div class="h1">${escapeHtml(isSpares ? "Quotation for Spares & Consumables" : pdfProfile.quotationTitle)}</div>
        <div class="row">
          <div class="left">Quotation No : ${escapeHtml(quote?.quote_number || "")}</div>
          <div>Date : ${escapeHtml(fmtDate(quoteOfferDate(quote, revision)))}</div>
        </div>
        <div style="height: 20px;"></div>
        <div style="display:flex; gap:12px; align-items:flex-start;">
          <div style="flex:1;">
            <div class="address" style="font-weight:700; font-size:14px;">${escapeHtml(quote?.customer_name || "")}</div>
            ${customerAddress.length ? `<div class="address">${customerAddress.map(escapeHtml).join("<br />")}</div>` : ""}
          </div>
          <div style="min-width:120px; text-align:right;">
            <div class="muted" style="font-size:13px; color:#111;">Rev ${escapeHtml(revNo)}</div>
            <div class="muted" style="margin-top:4px;">${currencyCode ? escapeHtml(currencyCode) : ""}</div>
          </div>
        </div>
        <div class="attn">Kind Attention : ${escapeHtml(quote?.attention_to || "Sir/Madam")}</div>
        <div class="letter">
          ${coverHtml}
        </div>
        <div class="sig">
          <div class="company">For ${companyName}</div>
          ${signatureDataUrl ? `<div style="margin:10px 0 8px;"><img src="${signatureDataUrl}" alt="Authorised Signature" style="max-width:180px; max-height:70px;" /></div>` : ""}
          <div class="name">${signatureName || "Sales Team"}</div>
          ${signatureDesignation ? `<div class="meta">${signatureDesignation}</div>` : ""}
          ${signaturePhone ? `<div class="meta">${signaturePhone}</div>` : ""}
          ${signatureEmail ? `<div class="meta">${signatureEmail}</div>` : ""}
          ${companyWebsite ? `<div class="meta">${companyWebsite}</div>` : ""}
        </div>
      </div>

      ${
        isSpares
          ? `${sparesScheduleHtml}${shieldPageHtml}`
          : `${packageHtml}${technicalHtml}${whyAbsstemPageHtml({ familyKey: titleFamilyKey, status })}`
      }
    </body>
  </html>`;
}

function fmtGstRate(rate) {
  return `${Math.round(Number(rate) * 100) / 100}%`;
}

// CGST/SGST vs IGST is settled at invoicing once place of supply is confirmed; the quote shows GST per rate only.
function buildGstTotalsRows({ scheduleLines, taxTotal, isExport, fmt }) {
  if (isExport) return [{ label: "GST (export — not applicable)", amount: fmt(0) }];
  const byRate = new Map();
  for (const l of scheduleLines) {
    const rate = Math.round(Number(l.gst_pct) * 100) / 100;
    const base = Number(l.line_total_quote);
    if (!Number.isFinite(rate) || !Number.isFinite(base)) continue;
    byRate.set(rate, (byRate.get(rate) || 0) + (base * rate) / 100);
  }
  const rates = Array.from(byRate.keys()).filter((r) => r > 0).sort((a, b) => a - b);
  const total = Number(taxTotal);
  if (!rates.length || !Number.isFinite(total)) return [{ label: "GST", amount: fmt(taxTotal) }];
  // Scale per-rate amounts so the split always adds up to the stored tax total.
  const rawSum = rates.reduce((s, r) => s + byRate.get(r), 0);
  const scale = rawSum > 0 ? total / rawSum : 0;
  const rows = [];
  let allocated = 0;
  rates.forEach((rate, idx) => {
    const amount = idx === rates.length - 1 ? total - allocated : Math.round(byRate.get(rate) * scale * 100) / 100;
    allocated += amount;
    rows.push({ label: `GST @ ${fmtGstRate(rate)}`, amount: fmt(amount) });
  });
  return rows;
}

function renderCommercialHtml({
  quote,
  revision,
  lines,
  clubbed,
  configuratorContext,
  currencies,
  commercialTerms,
  companyProfile,
  offerType = "completes",
}) {
  const isSpares = offerType === "spares";
  const status = revision?.revision_status || "draft";
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const pdfProfile = buildPdfConfiguratorProfile(cfg);
  const { primary: primaryLine } = splitPackageLines(lines, configuratorContext);
  const primaryModelLabel = resolveProductMasterLabel(primaryLine) || resolveProductMasterCode(primaryLine);
  const currencyCode = String(currencies?.quote_currency_code || "").trim();
  const currencySymbol = String(currencies?.quote_currency_symbol || "").trim();
  const showLinePricing = !clubbed;
  const scheduleLines = (Array.isArray(lines) ? lines : []).filter(
    (l) => String(l?.scope_type || "included") === "included"
  );
  const hasDiscount =
    !clubbed &&
    scheduleLines.some((l) => {
      const meta = parseJsonOrNull(l.line_description);
      const grossUnit =
        meta && typeof meta.gross_unit_price_quote !== "undefined" ? Number(meta.gross_unit_price_quote) : null;
      const discPct = meta && typeof meta.discount_pct !== "undefined" ? Number(meta.discount_pct) : null;
      const discAmt = meta && typeof meta.discount_amt !== "undefined" ? Number(meta.discount_amt) : null;
      if (Number.isFinite(discPct) && discPct > 0.0001) return true;
      if (Number.isFinite(discAmt) && discAmt > 0.0001) return true;
      const unit = Number(l.unit_price_quote);
      if (Number.isFinite(grossUnit) && grossUnit > 0 && Number.isFinite(unit) && Math.abs(grossUnit - unit) > 0.01) return true;
      return false;
    });

  const showGstColumn = !revision?.is_export;
  const offerRows = scheduleLines
    .map((l) => {
      const masterName = resolveProductMasterLabel(l) || resolveProductMasterCode(l);
      const masterCode = resolveProductMasterCode(l);
      const itemName = isSpares ? `<strong>${escapeHtml(masterCode || masterName)}</strong>` : escapeHtml(masterName);
      const itemCodeNote = "";
      const qty = Number(l.qty);
      const meta = parseJsonOrNull(l.line_description);
      const grossUnit = meta && typeof meta.gross_unit_price_quote !== "undefined" ? Number(meta.gross_unit_price_quote) : null;
      const discPct = meta && typeof meta.discount_pct !== "undefined" ? Number(meta.discount_pct) : null;
      const unit = Number(l.unit_price_quote);
      const total = Number(l.line_total_quote);
      const group = isSpares && masterCode ? masterName : String(l.product_description || l.product_group_name || "").trim();
      const desc = escapeHtml(group);
      return `
        <tr>
          <td>${escapeHtml(l.line_no)}</td>
          <td>${itemName}${itemCodeNote}</td>
          <td>${desc}</td>
          <td style="text-align: right;">${Number.isFinite(qty) ? qty : ""}</td>
          ${
            clubbed || !hasDiscount
              ? ""
              : `<td style="text-align: right; white-space: nowrap;">${Number.isFinite(grossUnit) ? fmtMoney(grossUnit) : ""}</td>`
          }
          ${
            clubbed || !hasDiscount
              ? ""
              : `<td style="text-align: right;">${Number.isFinite(discPct) ? fmtMoney(discPct) : ""}</td>`
          }
          ${
            showLinePricing
              ? `<td style="text-align: right; white-space: nowrap;">${Number.isFinite(unit) ? fmtMoney(unit) : ""}</td>`
              : ""
          }
          ${showLinePricing ? `<td style="text-align: center;">${escapeHtml(l.hsn_no || "")}</td>` : ""}
          ${showLinePricing && showGstColumn ? `<td style="text-align: right;">${Number.isFinite(Number(l.gst_pct)) ? fmtGstRate(l.gst_pct) : ""}</td>` : ""}
          ${showLinePricing ? `<td style="text-align: right; white-space: nowrap;">${Number.isFinite(total) ? fmtMoney(total) : ""}</td>` : ""}
        </tr>
      `;
    })
    .join("");

  const commercialTitle = isSpares
    ? "Spares Commercial Offer"
    : cfg.family_key === "MEDO" || cfg.family_key === "MEDO_C"
      ? "Healthcare Commercial Offer"
      : cfg.family_key === "IDOS" || cfg.family_key === "IDOS_C"
        ? "Industrial Oxygen Commercial Offer"
        : cfg.family_key === "NGEN" || cfg.family_key === "NGENX"
          ? "Nitrogen Commercial Offer"
          : "Commercial Offer";
  const commercialSubtitle = isSpares ? "" : [cfg.family_name, cfg.variant_label].filter(Boolean).join(" • ");
  const subtotal = fmtMoneyWithSymbol(revision?.subtotal_quote, currencySymbol, currencyCode);
  const gstRowsHtml = buildGstTotalsRows({
    scheduleLines,
    taxTotal: revision?.tax_total_quote,
    isExport: Boolean(revision?.is_export),
    fmt: (value) => fmtMoneyWithSymbol(value, currencySymbol, currencyCode),
  })
    .map(
      (row) => `
                <tr>
                  <td class="label">${escapeHtml(row.label)}</td>
                  <td class="amt">${escapeHtml(row.amount)}</td>
                </tr>`
    )
    .join("");
  const grand = fmtMoneyWithSymbol(revision?.grand_total_quote, currencySymbol, currencyCode);
  const quoteDate = fmtDate(quoteOfferDate(quote, revision));
  const revisionLabel = Number.isFinite(Number(revision?.revision_no)) ? `Revision ${Number(revision.revision_no)}` : "";
  const terms = commercialTerms && typeof commercialTerms === "object" ? commercialTerms : {};
  const buyerGstin = String(quote?.customer_site_tax_gstin || quote?.tax_gstin || "").trim();
  function isPlaceholderValue(value) {
    const v = String(value || "").trim().toLowerCase();
    if (!v) return true;
    if (v === "—") return true;
    if (v === "to be confirmed") return true;
    return false;
  }

  const headerMetaItems = [
    { label: "Quote No", value: quote?.quote_number || "" },
    { label: "Date", value: quoteDate || "" },
    { label: "Revision", value: revisionLabel },
    { label: "Valid Till", value: terms.valid_till ? fmtDate(terms.valid_till) : "" },
    { label: "Incoterm", value: terms.incoterm || "" },
    { label: "Buyer GSTIN", value: buyerGstin },
  ].filter((item) => !isPlaceholderValue(item.value));

  const headerMetaHtml = headerMetaItems
    .map((item) => `<span><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</span>`)
    .join(`<span class="meta-sep">|</span>`);

  const clientScopeLines = quoteLinesByScope(lines, "client_scope");
  const clientScopeNoteHtml = clientScopeLines.length
    ? `<div class="schedule-block">
        <div class="schedule-title">Client Scope (not included in price)</div>
        <ul style="margin:8px 0 0 18px; padding:0; font-size:12px; line-height:1.6;">
          ${clientScopeLines
            .map((l) => {
              const label = resolveProductMasterLabel(l) || resolveProductMasterCode(l);
              const remarks = lineRemarks(l);
              return `<li><strong>${escapeHtml(label)}</strong>${remarks ? ` — ${escapeHtml(remarks)}` : ""}</li>`;
            })
            .join("")}
        </ul>
      </div>`
    : "";

  const optionalLines = quoteLinesByScope(lines, "quoted_separately");
  const optionalItemsHtml = optionalLines.length
    ? `<div class="schedule-block">
        <div class="schedule-title">Optional Items (quoted separately, not included in the total)</div>
        <div class="schedule-table">
          <table>
            <thead>
              <tr>
                <th style="width: 120px;">Item</th>
                <th>Description</th>
                <th style="width: 40px; text-align: right;">Qty</th>
                <th style="width: 100px; text-align: right;">Unit Rate</th>
                <th style="width: 110px; text-align: right;">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${optionalLines
                .map((l) => {
                  const label = resolveProductMasterLabel(l) || resolveProductMasterCode(l);
                  const qty = Number(l.qty);
                  const unit = Number(l.unit_price_quote);
                  const total = Number(l.line_total_quote);
                  const desc = lineRemarks(l) || String(l.product_description || l.product_group_name || "").trim();
                  return `
                    <tr>
                      <td>${escapeHtml(label)}</td>
                      <td>${escapeHtml(desc)}</td>
                      <td style="text-align: right;">${Number.isFinite(qty) ? qty : ""}</td>
                      <td style="text-align: right;">${Number.isFinite(unit) ? fmtMoney(unit) : ""}</td>
                      <td style="text-align: right;">${Number.isFinite(total) ? fmtMoney(total) : ""}</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
        <div class="muted" style="margin-top:6px;">Prices exclude GST. Add to the order on request.</div>
      </div>`
    : "";

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(quote?.quote_number || "Quote")}</title>
      <style>
        @page { size: A4; margin: 12mm 12mm 30mm 12mm; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; background: transparent; }
        .page { page-break-after: auto; padding-top: 32px; box-sizing: border-box; position: relative; }
        .h1 { font-size: 22px; font-weight: 800; margin: 0; }
        .muted { font-size: 12px; color: #526074; }
        .watermark {
          position: absolute;
          left: 50%;
          top: 52%;
          transform: translate(-50%, -50%) rotate(-24deg);
          font-size: 64px;
          font-weight: 800;
          letter-spacing: 2px;
          color: rgba(0,0,0,0.035);
          z-index: 0;
          user-select: none;
          pointer-events: none;
          white-space: nowrap;
        }
        .page > * { position: relative; z-index: 1; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #eee; padding: 8px; vertical-align: top; font-size: 12px; }
        th { text-align: left; background: #fafafa; color: #374151; }
        tbody tr:nth-child(even) td { background: transparent; }
        .doc-head { padding-bottom: 0; border-bottom: none; }
        .doc-head-top { display: block; }
        .doc-meta { margin-top: 8px; font-size: 12px; color: #374151; line-height: 1.7; }
        .meta-sep { display: inline-block; margin: 0 8px; color: #c0c7d1; }
        .terms-strip {
          margin-top: 12px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px 14px;
          border: 1px solid #e8edf5;
          border-radius: 8px;
          padding: 10px 12px;
          background: #fbfcfe;
        }
        .term-item { display: grid; gap: 2px; }
        .term-label { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: #6b7280; }
        .term-value { font-size: 12px; color: #111827; font-weight: 600; }
        .banking-strip { margin-top: 10px; font-size: 11px; color: #374151; line-height: 1.7; }
        .schedule-block { margin-top: 14px; }
        .schedule-title { font-size: 15px; font-weight: 800; color: #18212f; }
        .schedule-table { margin-top: 10px; }
        .schedule-table table { table-layout: fixed; }
        .schedule-table th, .schedule-table td { padding: 7px 6px; overflow-wrap: anywhere; }
        .totals-box { margin-top: 8px; margin-left: auto; width: 380px; }
        .totals-table { border-collapse: collapse; }
        .totals-table td { border: none; border-top: 1px solid #e5e7eb; padding: 7px 10px; font-size: 12px; }
        .totals-table tr:first-child td { border-top: 1px solid #d7dde6; }
        .totals-table td.label { color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; width: 55%; background: transparent; padding-left: 0; }
        .totals-table td.amt { text-align: right; font-size: 16px; font-weight: 800; color: #111827; background: transparent; padding-right: 0; white-space: nowrap; }
        .doc-head, .schedule-block, .totals-box, .terms-strip { break-inside: avoid; page-break-inside: avoid; }
        ${BRAND_CSS}
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        ${BRAND_STRIPE_HTML}
        <div class="doc-head">
          <div class="doc-head-top">
            <div>
              <div class="h1">${escapeHtml(commercialTitle)}</div>
              ${commercialSubtitle ? `<div class="muted" style="margin-top:4px;">${escapeHtml(commercialSubtitle)}</div>` : ""}
              ${headerMetaHtml ? `<div class="doc-meta">${headerMetaHtml}</div>` : ""}
            </div>
          </div>
        </div>
        <div class="schedule-block">
          <div class="schedule-title">${isSpares ? "Parts &amp; Pricing" : "Offer Schedule"}</div>
          <div class="schedule-table">
            <table>
              <thead>
                <tr>
                  <th style="width: 18px;">#</th>
                  <th style="width: 88px;">${isSpares ? "Part No" : "Item"}</th>
                  <th>Description</th>
                  <th style="width: 30px; text-align: right;">Qty</th>
                  ${clubbed || !hasDiscount ? "" : '<th style="width: 84px; text-align: right;">Gross</th>'}
                  ${clubbed || !hasDiscount ? "" : '<th style="width: 40px; text-align: right;">Disc%</th>'}
                  ${showLinePricing ? '<th style="width: 84px; text-align: right;">Unit Rate</th>' : ""}
                  ${showLinePricing ? '<th style="width: 58px; text-align: center;">HSN</th>' : ""}
                  ${showLinePricing && showGstColumn ? '<th style="width: 38px; text-align: right;">GST</th>' : ""}
                  ${showLinePricing ? '<th style="width: 96px; text-align: right;">Amount</th>' : ""}
                </tr>
              </thead>
              <tbody>
                ${offerRows}
              </tbody>
            </table>
          </div>
          <div class="totals-box">
            <table class="totals-table">
              <tbody>
                <tr>
                  <td class="label">Subtotal (excl. GST)</td>
                  <td class="amt">${escapeHtml(subtotal)}</td>
                </tr>
                ${gstRowsHtml}
                <tr>
                  <td class="label">Grand Total</td>
                  <td class="amt">${escapeHtml(grand)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        ${clientScopeNoteHtml}
        ${optionalItemsHtml}
      </div>
    </body>
  </html>`;
}

function termsPageTitle(offerType) {
  return offerType === "spares" ? "Terms & Conditions of Supply" : "General Terms & Conditions";
}

function renderDefaultTermsHtml({ quote, revision, companyProfile, offerType = "completes" }) {
  const isSpares = offerType === "spares";
  const status = revision?.revision_status || "draft";
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(quote?.quote_number || "Quote")}</title>
      <style>
        @page { size: A4; margin: 14mm 14mm 30mm 14mm; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; }
        .page { page-break-after: auto; padding-top: 32px; box-sizing: border-box; position: relative; }
        .h1 { font-size: 20px; font-weight: 700; margin: 0 0 6px; }
        ol { margin: 10px 0 0 18px; padding: 0; font-size: 12px; line-height: 1.65; }
        li { margin: 0 0 10px; }
        .cap { font-weight: 800; }
        .watermark {
          position: absolute;
          left: 50%;
          top: 52%;
          transform: translate(-50%, -50%) rotate(-24deg);
          font-size: 64px;
          font-weight: 800;
          letter-spacing: 2px;
          color: rgba(0,0,0,0.035);
          z-index: 0;
          user-select: none;
          pointer-events: none;
          white-space: nowrap;
        }
        .page > * { position: relative; z-index: 1; }
        ${BRAND_CSS}
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        ${BRAND_STRIPE_HTML}
        <div class="h1">${escapeHtml(termsPageTitle(offerType))}</div>
        <ol>
          <li><span class="cap">Validity:</span> ${
            quote?.quote_valid_till
              ? `This offer is valid till ${escapeHtml(fmtDate(quote.quote_valid_till))}.`
              : "30 days from the date of quotation."
          }</li>
          ${
            isSpares
              ? `<li><span class="cap">Price Basis:</span> Ex-works, supply of listed parts only.</li>
          <li><span class="cap">Delivery:</span> Ex-works. Ready-stock items 1-2 weeks from PO and payment; non-stock items as confirmed at order.</li>
          <li><span class="cap">Payment:</span> 100% advance against Proforma Invoice.</li>
          <li><span class="cap">Warranty:</span> Replacement parts against manufacturing defects; consumables and wear parts excluded.</li>`
              : `<li><span class="cap">Delivery:</span> As mutually agreed.</li>
          <li><span class="cap">Payment:</span> As per agreed terms.</li>`
          }
          <li><span class="cap">GST:</span> As applicable (export quotes will have zero GST).</li>
        </ol>
        ${statutoryDetailsHtml(companyProfile)}
      </div>
    </body>
  </html>`;
}

function renderTermsTextHtml({ quote, revision, termsText, companyProfile }) {
  const status = revision?.revision_status || "draft";
  const safe = String(termsText ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(quote?.quote_number || "Quote")}</title>
      <style>
        @page { size: A4; margin: 14mm 14mm 30mm 14mm; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; }
        .page { page-break-after: auto; padding-top: 32px; box-sizing: border-box; position: relative; }
        .h1 { font-size: 20px; font-weight: 700; margin: 0 0 10px; }
        .content { font-size: 12px; line-height: 1.65; white-space: pre-wrap; }
        .watermark {
          position: absolute;
          left: 50%;
          top: 52%;
          transform: translate(-50%, -50%) rotate(-24deg);
          font-size: 64px;
          font-weight: 800;
          letter-spacing: 2px;
          color: rgba(0,0,0,0.035);
          z-index: 0;
          user-select: none;
          pointer-events: none;
          white-space: nowrap;
        }
        .page > * { position: relative; z-index: 1; }
        ${BRAND_CSS}
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        ${BRAND_STRIPE_HTML}
        <div class="h1">General Terms & Conditions</div>
        <div class="content">${safe}</div>
        ${statutoryDetailsHtml(companyProfile)}
      </div>
    </body>
  </html>`;
}

function commercialTermKind(caption) {
  const c = String(caption || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (c === "incoterm" || c === "incoterms") return "incoterm";
  if (c === "payment term" || c === "payment terms" || c === "payment") return "payment_term";
  if (c === "freight term" || c === "freight terms" || c === "freight") return "freight_term";
  if (c === "p f" || c === "p f terms" || c === "packing forwarding" || c === "packing and forwarding") return "p_and_f_term";
  if (c === "delivery" || c === "delivery period" || c === "delivery schedule" || c === "lead time") return "delivery";
  if (c === "warranty" || c === "warranty period") return "warranty";
  return "";
}

/** Terms library text must not contradict the values chosen on the quote itself. */
function reconcileTermDescription(term, commercialTerms, warrantyMonths) {
  const text = String(term?.description ?? "");
  const kind = commercialTermKind(term?.caption);
  const ct = commercialTerms && typeof commercialTerms === "object" ? commercialTerms : {};
  if (!kind) return text;
  if (kind === "delivery") return ct.delivery_lead_time ? `${ct.delivery_lead_time}.` : text;
  if (kind === "warranty") {
    const months = Number(warrantyMonths);
    if (!(months > 0)) return text;
    if (new RegExp(`\\b${months}\\s*months?\\b`, "i").test(text)) return text;
    return `${ct.warranty || `${months} months`}.`;
  }
  const value = String(ct[kind] || "").trim();
  return value ? `${value}.`.replace(/\.\.$/, ".") : text;
}

function renderRevisionTermsHtml({ quote, revision, terms, commercialTerms, companyProfile, offerType = "completes" }) {
  const status = revision?.revision_status || "draft";
  const rows = Array.isArray(terms) ? terms.filter((t) => t && t.is_selected) : [];

  const body = rows.length
    ? rows
        .map((t) => {
          const caption = escapeHtml(t.caption || "");
          const desc = reconcileTermDescription(t, commercialTerms, revision?.warranty_months)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
          return `
            <li>
              <div class="cap">${caption}</div>
              <div class="desc">${desc}</div>
            </li>
          `;
        })
        .join("")
    : "";

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(quote?.quote_number || "Quote")}</title>
      <style>
        @page { size: A4; margin: 14mm 14mm 30mm 14mm; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; }
        .page { page-break-after: auto; padding-top: 32px; box-sizing: border-box; position: relative; }
        .h1 { font-size: 20px; font-weight: 700; margin: 0 0 10px; }
        .watermark {
          position: absolute;
          left: 50%;
          top: 52%;
          transform: translate(-50%, -50%) rotate(-24deg);
          font-size: 64px;
          font-weight: 800;
          letter-spacing: 2px;
          color: rgba(0,0,0,0.035);
          z-index: 0;
          user-select: none;
          pointer-events: none;
          white-space: nowrap;
        }
        .page > * { position: relative; z-index: 1; }
        ol { margin: 10px 0 0 18px; padding: 0; }
        li { margin: 0 0 12px; }
        .cap { font-size: 12px; font-weight: 800; letter-spacing: 0.2px; }
        .desc { font-size: 12px; line-height: 1.65; margin-top: 6px; white-space: pre-wrap; }
        ${BRAND_CSS}
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        ${BRAND_STRIPE_HTML}
        <div class="h1">${escapeHtml(termsPageTitle(offerType))}</div>
        ${body ? `<ol>${body}</ol>` : `<div style="opacity:0.7; font-size: 12px;">No terms selected.</div>`}
        ${statutoryDetailsHtml(companyProfile)}
      </div>
    </body>
  </html>`;
}

module.exports = {
  renderAnnexureDividerHtml,
  renderCoverAndTechnicalHtml,
  renderCommercialHtml,
  renderDefaultTermsHtml,
  renderTermsTextHtml,
  renderRevisionTermsHtml,
  generateQuotePdfBuffer,
  mergePdfBuffers,
  applyPdfBackground,
  resolveProductMasterLabel,
  resolveFamilyBrochureProfile,
};
