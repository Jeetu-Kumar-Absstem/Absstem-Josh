const puppeteer = require("puppeteer-core");
const fs = require("fs");
const { PDFDocument } = require("pdf-lib");
const { applyPdfBackground, generateQuotePdfBuffer, mergePdfBuffers } = require("./pdfCore");
const { getProductFamilyRule } = require("../configurator/productFamilyMatrix");

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

function fmtDate(d) {
  try {
    const dt = d ? new Date(d) : new Date();
    return dt.toISOString().slice(0, 10);
  } catch {
    return "";
  }
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
    primaryIdx = included.findIndex((l) => pattern.test(String(l?.item_code || l?.item_name || "")));
  }
  if (primaryIdx < 0) primaryIdx = included.length ? 0 : -1;
  const primary = primaryIdx >= 0 ? included[primaryIdx] : null;
  const components = primary
    ? included.filter((_, idx) => idx !== primaryIdx)
    : included.slice();
  return { primary, components, included };
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
  const primaryModel = String(primaryLine?.item_code || primaryLine?.item_name || "").trim();
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
        @page { size: A4; margin: 14mm; }
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
}) {
  const currencyCode = currencies?.quote_currency_code || "";
  const revNo = revision?.revision_no ?? "—";
  const status = revision?.revision_status || "draft";
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const pdfProfile = buildPdfConfiguratorProfile(cfg);
  const { primary: primaryLine, components: componentLines, included: includedLines } = splitPackageLines(lines, configuratorContext);
  const primaryModelLabel = String(primaryLine?.item_code || primaryLine?.item_name || "").trim();

  const customerAddress = [
    quote?.address_line1,
    quote?.address_line2,
    quote?.address_line3,
    [quote?.city, quote?.state, quote?.pincode].filter(Boolean).join(" "),
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  const templateCoverText = typeof coverLetterText === "string" ? coverLetterText.trim() : "";
  const defaultCoverText = buildCustomerCoverText({ quote, pdfProfile, primaryLine, configuratorContext });
  const coverText = templateCoverText
    ? templateCoverText
    : sanitizeGasWording(defaultCoverText, configuratorContext);

  const coverBlocks = String(coverText || "")
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
      model: String(l?.item_code || l?.product_item_code || l?.item_name || l?.product_item_name || "").trim(),
      description: String(l?.product_group_name || l?.product_description || "").trim(),
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
        model: String(primaryLine?.item_code || primaryLine?.item_name || "").trim(),
        description: String(primaryLine?.product_group_name || primaryLine?.product_description || "").trim(),
        qty: Number(primaryLine?.qty || 0) || 0,
      }
    : null;
  const componentRows = componentLines
    .map((l) => ({
      model: String(l?.item_code || l?.item_name || "").trim(),
      description: String(l?.product_group_name || l?.product_description || "").trim(),
      qty: Number(l?.qty || 0) || 0,
    }))
    .filter((row) => row.model && row.qty > 0);

  const primaryHtml = primaryRow
    ? `
      <div class="card">
        <div class="card-title">Primary Equipment</div>
        <div class="card-sub">${escapeHtml(primaryRow.model)}</div>
        ${primaryRow.description ? `<div class="muted" style="margin-top:6px;">${escapeHtml(primaryRow.description)}</div>` : ""}
        ${Number.isFinite(primaryRow.qty) && primaryRow.qty > 0 ? `<div class="muted" style="margin-top:10px;">Qty: ${escapeHtml(String(primaryRow.qty))}</div>` : ""}
      </div>
    `
    : `<div class="muted">Primary equipment not identified yet.</div>`;

  const componentsHtml = componentRows.length
    ? `
      <table class="simple">
        <thead>
          <tr>
            <th style="width: 7%;">#</th>
            <th style="width: 22%;">Item</th>
            <th>Description</th>
            <th style="width: 10%; text-align:right;">Qty</th>
          </tr>
        </thead>
        <tbody>
          ${componentRows
            .map((row, idx) => {
              return `
                <tr>
                  <td>${idx + 1}</td>
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
      <div class="h1">Offered Package</div>
      <div class="muted">${escapeHtml(pdfProfile.scopeIntro)}</div>
      <div style="height: 10px;"></div>
      ${primaryHtml}
      <div class="h2" style="margin-top:16px;">Included Package Components</div>
      ${componentsHtml}
      ${Array.isArray(scope.exclusions) && scope.exclusions.length ? `<div class="h2">${escapeHtml(pdfProfile.exclusionsLabel)}</div>${listHtml(scope.exclusions)}` : ""}
      ${Array.isArray(scope.assumptions) && scope.assumptions.length ? `<div class="h2">${escapeHtml(pdfProfile.assumptionsLabel)}</div>${listHtml(scope.assumptions)}` : ""}
      ${Array.isArray(scope.acceptance) && scope.acceptance.length ? `<div class="h2">${escapeHtml(pdfProfile.acceptanceLabel)}</div>${listHtml(scope.acceptance)}` : ""}
      ${Array.isArray(scope.responsibilities) && scope.responsibilities.length ? `<div class="h2">${escapeHtml(pdfProfile.responsibilitiesLabel)}</div>${responsibilitiesHtml(scope.responsibilities)}` : ""}
    </div>
  `;

  const technicalBlocks = lines
    .map((l) => {
      const productId = l.product_id ? Number(l.product_id) : null;
      const attrs = productId ? attributesByProductId.get(productId) || [] : [];
      const model = l.item_code || l.item_name || "";
      const group = l.product_group_name || "";
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
        : `<div class="muted">No technical specs found.</div>`;

      return `
        <div class="page">
          ${watermarkHtml(status)}
          <div class="h1">${escapeHtml(pdfProfile.technicalSheetTitle)}</div>
          <div class="muted" style="font-weight:700; color:#111;">${escapeHtml(model)}</div>
          ${group ? `<div class="muted" style="margin-top:4px;">${escapeHtml(group)}</div>` : ""}
          <div style="height: 10px;"></div>
          ${attrsHtml}
        </div>
      `;
    })
    .join("");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(quote?.quote_number || "Quote")}</title>
      <style>
        @page { size: A4; margin: 14mm; }
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
        .attrs th, .attrs td { border: 1px solid #eee; }
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
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        ${
          logoDataUrl
            ? `<div style="margin-bottom:16px;"><img src="${logoDataUrl}" alt="Company Logo" style="max-width:180px; max-height:70px;" /></div>`
            : ""
        }
        <div class="h1">${escapeHtml(pdfProfile.quotationTitle)}</div>
        <div class="row">
          <div class="left">Quotation No : ${escapeHtml(quote?.quote_number || "")}</div>
          <div>Date : ${escapeHtml(fmtDate(revision?.prepared_at))}</div>
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

      ${packageHtml}
      ${technicalBlocks}
    </body>
  </html>`;
}

function renderCommercialHtml({ quote, revision, lines, clubbed, configuratorContext, currencies, commercialTerms, companyProfile }) {
  const status = revision?.revision_status || "draft";
  const cfg = configuratorContext && typeof configuratorContext === "object" ? configuratorContext : {};
  const pdfProfile = buildPdfConfiguratorProfile(cfg);
  const { primary: primaryLine } = splitPackageLines(lines, configuratorContext);
  const primaryModelLabel = String(primaryLine?.item_code || primaryLine?.item_name || "").trim();
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

  const offerRows = scheduleLines
    .map((l) => {
      const itemName = escapeHtml(l.item_code || l.item_name || "");
      const qty = Number(l.qty);
      const meta = parseJsonOrNull(l.line_description);
      const grossUnit = meta && typeof meta.gross_unit_price_quote !== "undefined" ? Number(meta.gross_unit_price_quote) : null;
      const discPct = meta && typeof meta.discount_pct !== "undefined" ? Number(meta.discount_pct) : null;
      const unit = Number(l.unit_price_quote);
      const total = Number(l.line_total_quote);
      const group = String(l.product_group_name || "").trim();
      const desc = escapeHtml(group);
      return `
        <tr>
          <td style="width: 60px;">${escapeHtml(l.line_no)}</td>
          <td>${itemName}</td>
          <td>${desc}</td>
          <td style="width: 100px; text-align: right;">${Number.isFinite(qty) ? qty : ""}</td>
          ${
            clubbed || !hasDiscount
              ? ""
              : `<td style="width: 120px; text-align: right;">${Number.isFinite(grossUnit) ? fmtMoney(grossUnit) : ""}</td>`
          }
          ${
            clubbed || !hasDiscount
              ? ""
              : `<td style="width: 70px; text-align: right;">${Number.isFinite(discPct) ? fmtMoney(discPct) : ""}</td>`
          }
          ${
            showLinePricing
              ? `<td style="width: 120px; text-align: right;">${Number.isFinite(unit) ? fmtMoney(unit) : ""}</td>`
              : ""
          }
          ${showLinePricing ? `<td style="width: 110px; text-align: center;">${escapeHtml(l.hsn_no || "")}</td>` : ""}
          ${showLinePricing ? `<td style="width: 140px; text-align: right;">${Number.isFinite(total) ? fmtMoney(total) : ""}</td>` : ""}
        </tr>
      `;
    })
    .join("");

  const commercialTitle =
    cfg.family_key === "MEDO" || cfg.family_key === "MEDO_C"
      ? "Healthcare Commercial Offer"
      : cfg.family_key === "IDOS" || cfg.family_key === "IDOS_C"
        ? "Industrial Oxygen Commercial Offer"
        : cfg.family_key === "NGEN" || cfg.family_key === "NGENX"
          ? "Nitrogen Commercial Offer"
          : "Commercial Offer";
  const commercialSubtitle = [cfg.family_name, cfg.variant_label].filter(Boolean).join(" • ");
  const subtotal = fmtMoneyWithSymbol(revision?.subtotal_quote, currencySymbol, currencyCode);
  const gst = fmtMoneyWithSymbol(revision?.tax_total_quote, currencySymbol, currencyCode);
  const grand = fmtMoneyWithSymbol(revision?.grand_total_quote, currencySymbol, currencyCode);
  const quoteDate = fmtDate(quote?.updated_at || quote?.created_at || revision?.updated_at || revision?.created_at);
  const revisionLabel = Number.isFinite(Number(revision?.revision_no)) ? `Revision ${Number(revision.revision_no)}` : "";
  const terms = commercialTerms && typeof commercialTerms === "object" ? commercialTerms : {};
  const sellerGstin = String(companyProfile?.gstin || "").trim();
  const buyerGstin = String(quote?.customer_site_tax_gstin || quote?.tax_gstin || "").trim();
  const bankName = String(companyProfile?.bank_name || "").trim();
  const accountNo = String(companyProfile?.account_no || "").trim();
  const ifsc = String(companyProfile?.ifsc || "").trim();
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
    { label: "Seller GSTIN", value: sellerGstin },
    { label: "Buyer GSTIN", value: buyerGstin },
  ].filter((item) => !isPlaceholderValue(item.value));

  const commercialTermItems = [
    { label: "Attention", value: terms.attention_to || quote?.attention_to || "" },
    { label: "Payment", value: terms.payment_term || "" },
    { label: "Freight", value: terms.freight_term || "" },
    { label: "P&F", value: terms.p_and_f_term || "" },
    { label: "Incoterm", value: terms.incoterm || "" },
    { label: "Currency", value: terms.quote_currency || currencyCode || "" },
    { label: "Valid till", value: terms.valid_till ? fmtDate(terms.valid_till) : "" },
    { label: "Tax", value: terms.tax_treatment || "" },
    { label: "Pricing", value: terms.pricing_mode || "" },
  ].filter((item) => !isPlaceholderValue(item.value));

  const bankingItems = [
    { label: "Bank", value: bankName },
    { label: "A/C", value: accountNo },
    { label: "IFSC", value: ifsc },
  ].filter((item) => !isPlaceholderValue(item.value));

  const headerMetaHtml = headerMetaItems
    .map((item) => `<span><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</span>`)
    .join(`<span class="meta-sep">|</span>`);

  const commercialTermsHtml = commercialTermItems.length
    ? `<div class="terms-strip">${commercialTermItems
        .map((item) => `<div class="term-item"><span class="term-label">${escapeHtml(item.label)}</span><span class="term-value">${escapeHtml(item.value)}</span></div>`)
        .join("")}</div>`
    : "";

  const bankingHtml = bankingItems.length
    ? `<div class="banking-strip">${bankingItems
        .map((item) => `<span><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</span>`)
        .join(`<span class="meta-sep">|</span>`)}</div>`
    : "";

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(quote?.quote_number || "Quote")}</title>
      <style>
        @page { size: A4; margin: 12mm; }
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
        .totals-box { margin-top: 8px; margin-left: auto; width: 340px; }
        .totals-table { border-collapse: collapse; }
        .totals-table td { border: none; border-top: 1px solid #e5e7eb; padding: 7px 10px; font-size: 12px; }
        .totals-table tr:first-child td { border-top: 1px solid #d7dde6; }
        .totals-table td.label { color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; width: 55%; background: transparent; padding-left: 0; }
        .totals-table td.amt { text-align: right; font-size: 16px; font-weight: 800; color: #111827; background: transparent; padding-right: 0; }
        .doc-head, .schedule-block, .totals-box, .terms-strip { break-inside: avoid; page-break-inside: avoid; }
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        <div class="doc-head">
          <div class="doc-head-top">
            <div>
              <div class="h1">${escapeHtml(commercialTitle)}</div>
              ${commercialSubtitle ? `<div class="muted" style="margin-top:4px;">${escapeHtml(commercialSubtitle)}</div>` : ""}
              ${headerMetaHtml ? `<div class="doc-meta">${headerMetaHtml}</div>` : ""}
            </div>
          </div>
        </div>
        ${commercialTermsHtml}
        ${bankingHtml}
        <div class="schedule-block">
          <div class="schedule-title">Offer Schedule</div>
          <div class="schedule-table">
            <table>
              <thead>
                <tr>
                  <th style="width: 60px;">#</th>
                  <th style="width: 160px;">Item</th>
                  <th>Description</th>
                  <th style="width: 100px; text-align: right;">Qty</th>
                  ${clubbed || !hasDiscount ? "" : '<th style="width: 120px; text-align: right;">Gross</th>'}
                  ${clubbed || !hasDiscount ? "" : '<th style="width: 70px; text-align: right;">Disc%</th>'}
                  ${showLinePricing ? '<th style="width: 120px; text-align: right;">Unit Rate</th>' : ""}
                  ${showLinePricing ? '<th style="width: 110px; text-align: center;">HSN</th>' : ""}
                  ${showLinePricing ? '<th style="width: 140px; text-align: right;">Amount</th>' : ""}
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
                <tr>
                  <td class="label">GST</td>
                  <td class="amt">${escapeHtml(gst)}</td>
                </tr>
                <tr>
                  <td class="label">Grand Total</td>
                  <td class="amt">${escapeHtml(grand)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </body>
  </html>`;
}

function renderDefaultTermsHtml({ quote, revision }) {
  const status = revision?.revision_status || "draft";
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(quote?.quote_number || "Quote")}</title>
      <style>
        @page { size: A4; margin: 14mm; }
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
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        <div class="h1">General Terms & Conditions</div>
        <ol>
          <li><span class="cap">Validity:</span> 30 days from the date of quotation.</li>
          <li><span class="cap">Delivery:</span> As mutually agreed.</li>
          <li><span class="cap">Payment:</span> As per agreed terms.</li>
          <li><span class="cap">GST:</span> As applicable (export quotes will have zero GST).</li>
        </ol>
      </div>
    </body>
  </html>`;
}

function renderTermsTextHtml({ quote, revision, termsText }) {
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
        @page { size: A4; margin: 14mm; }
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
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        <div class="h1">General Terms & Conditions</div>
        <div class="content">${safe}</div>
      </div>
    </body>
  </html>`;
}

function renderRevisionTermsHtml({ quote, revision, terms }) {
  const status = revision?.revision_status || "draft";
  const rows = Array.isArray(terms) ? terms.filter((t) => t && t.is_selected) : [];

  const body = rows.length
    ? rows
        .map((t) => {
          const caption = escapeHtml(t.caption || "");
          const desc = String(t.description ?? "")
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
        @page { size: A4; margin: 14mm; }
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
      </style>
    </head>
    <body>
      <div class="page">
        ${watermarkHtml(status)}
        <div class="h1">General Terms & Conditions</div>
        ${body ? `<ol>${body}</ol>` : `<div style="opacity:0.7; font-size: 12px;">No terms selected.</div>`}
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
};
