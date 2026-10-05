const { extractViaSLM } = require("./extractViaSLM");
const { extractTextFromPdfBuffer } = require("./extractTextFromPdf");
const { extractInboundEmailHeuristic } = require("./heuristics/inboundEmail");
const { extractVendorQuoteHeuristic } = require("./heuristics/vendorQuotePdf");

const CONFIDENCE_THRESHOLD = 0.7;

function mergeFields(base = {}, overlay = {}) {
  const out = { ...(base && typeof base === "object" ? base : {}) };
  for (const [key, value] of Object.entries(overlay && typeof overlay === "object" ? overlay : {})) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    out[key] = value;
  }
  return out;
}

function confidenceLabel(score) {
  if (score >= 0.85) return "high";
  if (score >= 0.7) return "medium";
  return "low";
}

/**
 * Heuristics first; escalate to mock SLM when required fields missing or confidence < threshold.
 */
async function runExtractionPipeline({
  docType,
  text = "",
  buffer = null,
  meta = {},
} = {}) {
  let workingText = String(text || "");
  let textMethod = "provided";

  if ((!workingText || workingText.length < 20) && buffer && buffer.length) {
    const scraped = extractTextFromPdfBuffer(buffer);
    workingText = scraped.text || "";
    textMethod = scraped.method;
  }

  let heuristic = null;
  if (docType === "inbound_email") {
    heuristic = extractInboundEmailHeuristic({
      subject: meta.subject,
      fromName: meta.from_name || meta.fromName,
      fromEmail: meta.from_email || meta.fromEmail,
      bodyText: workingText || meta.body_text || meta.bodyText,
      bodyPreview: meta.body_preview || meta.bodyPreview,
    });
  } else if (docType === "vendor_quote_pdf") {
    heuristic = extractVendorQuoteHeuristic({
      text: workingText,
      prLines: Array.isArray(meta.prLines) ? meta.prLines : [],
    });
  } else {
    const err = new Error("UNSUPPORTED_DOC_TYPE");
    err.code = "UNSUPPORTED_DOC_TYPE";
    throw err;
  }

  const needsSlm =
    heuristic.confidence < CONFIDENCE_THRESHOLD ||
    (Array.isArray(heuristic.missing_required) && heuristic.missing_required.length > 0);

  let slm = null;
  let fields = { ...(heuristic.fields || {}) };
  let finalConfidence = heuristic.confidence;
  let source = "heuristic";

  if (needsSlm) {
    slm = await extractViaSLM({
      docType,
      text: workingText,
      heuristicResult: heuristic,
    });
    fields = mergeFields(fields, slm.fields || {});

    // Re-bind vendor quote lines after SLM price fill.
    if (docType === "vendor_quote_pdf" && Array.isArray(meta.prLines) && meta.prLines.length) {
      const prices = Array.isArray(fields.unit_prices) ? fields.unit_prices : [];
      const gstPct = Number(fields.gst_pct);
      fields.lines = meta.prLines.map((pr, i) => ({
        purchase_requisition_line_id: Number(pr.id),
        item_code: pr.item_code || null,
        item_name: pr.item_name || null,
        qty: Number(pr.qty_pending ?? pr.qty ?? 0),
        unit_price: Number(prices[i] != null ? prices[i] : prices[prices.length - 1] || 0),
        freight_per_unit: 0,
        gst_pct: Number.isFinite(gstPct) ? gstPct : 18,
      }));
    }

    finalConfidence = Math.max(heuristic.confidence, Number(slm.confidence || 0));
    source = "heuristic+slm_mock";
  }

  return {
    ok: true,
    doc_type: docType,
    source,
    confidence: finalConfidence,
    confidence_label: confidenceLabel(finalConfidence),
    used_slm: Boolean(slm),
    text_method: textMethod,
    text_preview: workingText.slice(0, 600),
    fields,
    heuristic,
    slm,
    threshold: CONFIDENCE_THRESHOLD,
  };
}

module.exports = {
  runExtractionPipeline,
  CONFIDENCE_THRESHOLD,
};
