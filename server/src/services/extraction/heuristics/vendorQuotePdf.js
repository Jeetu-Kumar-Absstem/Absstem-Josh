function text(value, fallback = "") {
  const s = typeof value === "string" ? value.trim() : "";
  return s || fallback;
}

function num(value) {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Heuristic vendor quote PDF / text → commercial fields + unit prices.
 * @param {{ text: string, prLines?: Array<{id:number,qty?:number,item_name?:string,item_code?:string}> }} args
 */
function extractVendorQuoteHeuristic({ text: rawText = "", prLines = [] } = {}) {
  const blob = String(rawText || "");
  const missing = [];

  const paymentTerms =
    (blob.match(/(?:payment|credit)\s*(?:terms)?\s*[:\-]\s*([^\n]{3,80})/i)?.[1] || "").trim() || null;
  const creditDays =
    num(blob.match(/(?:credit|payment)[^\n]{0,40}?(\d{1,3})\s*days?/i)?.[1]) ??
    num(blob.match(/(\d{1,3})\s*days?\s*(?:credit|net)/i)?.[1]);
  const deliveryDays =
    num(blob.match(/(?:delivery|lead\s*time|lt)\s*[:\-]?\s*(\d{1,3})\s*days?/i)?.[1]) ??
    num(blob.match(/deliver(?:y|ed)?\s+in\s+(\d{1,3})\s*days?/i)?.[1]);
  const quoteRef =
    (blob.match(/(?:quote|quotation)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i)?.[1] || "").trim() ||
    null;
  const gstPct = num(blob.match(/GST\s*[@:]?\s*(\d+(?:\.\d+)?)\s*%/i)?.[1]) ?? 18;

  const unitPrices = [...blob.matchAll(/(?:₹|INR|Rs\.?)\s*([\d,]+\.?\d*)/gi)]
    .map((m) => num(m[1]))
    .filter((n) => n != null && n > 0)
    .slice(0, 40);

  const lines = [];
  const pending = Array.isArray(prLines) ? prLines : [];
  if (pending.length && unitPrices.length) {
    for (let i = 0; i < pending.length; i += 1) {
      const pr = pending[i];
      const price = unitPrices[i] != null ? unitPrices[i] : unitPrices[unitPrices.length - 1];
      lines.push({
        purchase_requisition_line_id: Number(pr.id),
        item_code: pr.item_code || null,
        item_name: pr.item_name || null,
        qty: num(pr.qty_pending ?? pr.qty) ?? 0,
        unit_price: price,
        freight_per_unit: 0,
        gst_pct: gstPct,
      });
    }
  }

  let score = 0.25;
  if (paymentTerms) score += 0.15;
  else missing.push("payment_terms");
  if (creditDays != null) score += 0.1;
  else missing.push("credit_days");
  if (deliveryDays != null) score += 0.1;
  else missing.push("delivery_days");
  if (unitPrices.length) score += 0.25;
  else missing.push("unit_prices");
  if (lines.length) score += 0.15;
  else missing.push("lines");
  if (quoteRef) score += 0.05;

  return {
    source: "heuristic",
    confidence: Math.min(score, 0.99),
    fields: {
      payment_terms: paymentTerms,
      credit_days: creditDays,
      delivery_days: deliveryDays,
      quote_ref: quoteRef,
      gst_pct: gstPct,
      unit_prices: unitPrices,
      lines,
      compliance_ok: true,
      compliance_notes: quoteRef ? `Parsed quote ref ${quoteRef}` : null,
      remarks: "Extracted from vendor quote PDF (heuristic).",
    },
    missing_required: missing.filter((k) => ["unit_prices", "lines"].includes(k)),
  };
}

module.exports = {
  extractVendorQuoteHeuristic,
  text,
};
