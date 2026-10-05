/**
 * Modular SLM extraction interface.
 * Currently returns structured mock fills — no paid / external LLM APIs.
 * Swap the body later for a local Phi-3 (or similar) JSON extract call.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstEmail(raw) {
  const m = String(raw || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : "";
}

function firstPhone(raw) {
  const matches = String(raw || "").match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  for (const rawPhone of matches) {
    const digits = rawPhone.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) return digits.slice(-10);
  }
  return "";
}

function mockInboundEmail(textBlob, heuristicFields = {}) {
  const blob = String(textBlob || "");
  const company =
    text(heuristicFields.company_name) ||
    (blob.match(/(?:company|organisation|organization|firm)\s*[:\-]\s*(.+)$/im)?.[1] || "").trim() ||
    "Prospect (SLM mock)";
  const contact =
    text(heuristicFields.contact_name) ||
    (blob.match(/(?:name|contact person|contact)\s*[:\-]\s*(.+)$/im)?.[1] || "").trim() ||
    "Inbound contact";
  const email = text(heuristicFields.email) || firstEmail(blob);
  const phone = text(heuristicFields.phone) || firstPhone(blob);
  const need =
    text(heuristicFields.need_summary) ||
    (blob.match(/(?:looking for|need|requirement|enquiry|inquiry)\s*[:\-]?\s*(.+)$/im)?.[1] || "").trim().slice(0, 240) ||
    "General product enquiry (mock SLM)";

  return {
    company_name: company.slice(0, 200),
    contact_name: contact.slice(0, 160),
    email: email || null,
    phone: phone || null,
    need_summary: need,
  };
}

function mockVendorQuote(textBlob, heuristicFields = {}) {
  const blob = String(textBlob || "");
  const payment =
    text(heuristicFields.payment_terms) ||
    (blob.match(/(?:payment|credit)\s*(?:terms)?\s*[:\-]\s*([^\n]+)/i)?.[1] || "").trim() ||
    "Net 30 (SLM mock)";
  const creditMatch = blob.match(/(\d{1,3})\s*(?:days?|dys)\b/i);
  const deliveryMatch = blob.match(/(?:delivery|lead\s*time|lt)\s*[:\-]?\s*(\d{1,3})\s*days?/i);
  const prices = [...blob.matchAll(/(?:₹|INR|Rs\.?)\s*([\d,]+\.?\d*)/gi)].map((m) =>
    Number(String(m[1]).replace(/,/g, ""))
  ).filter((n) => Number.isFinite(n) && n > 0);

  return {
    payment_terms: payment.slice(0, 120),
    credit_days:
      heuristicFields.credit_days != null && heuristicFields.credit_days !== ""
        ? Number(heuristicFields.credit_days)
        : creditMatch
          ? Number(creditMatch[1])
          : 30,
    delivery_days:
      heuristicFields.delivery_days != null && heuristicFields.delivery_days !== ""
        ? Number(heuristicFields.delivery_days)
        : deliveryMatch
          ? Number(deliveryMatch[1])
          : 14,
    quote_ref:
      text(heuristicFields.quote_ref) ||
      (blob.match(/(?:quote|quotation)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9\-\/]+)/i)?.[1] || "VQ-MOCK"),
    unit_prices: Array.isArray(heuristicFields.unit_prices) && heuristicFields.unit_prices.length
      ? heuristicFields.unit_prices
      : prices.slice(0, 20),
    gst_pct:
      heuristicFields.gst_pct != null
        ? Number(heuristicFields.gst_pct)
        : Number((blob.match(/GST\s*[@:]?\s*(\d+(?:\.\d+)?)\s*%/i)?.[1] || 18)),
    compliance_notes: text(heuristicFields.compliance_notes) || "Commercials filled by mock SLM — review before save.",
  };
}

/**
 * @param {{ docType: string, text?: string, heuristicResult?: object, schema?: object }} args
 * @returns {Promise<{ source: string, model: string, latency_ms: number, fields: object, confidence: number, note: string }>}
 */
async function extractViaSLM({ docType, text: rawText = "", heuristicResult = null } = {}) {
  const started = Date.now();
  // Simulate async local-model latency without blocking forever.
  await sleep(60 + Math.floor(Math.random() * 40));

  const heuristicFields = heuristicResult?.fields && typeof heuristicResult.fields === "object" ? heuristicResult.fields : {};
  let fields = {};
  if (docType === "inbound_email") {
    fields = mockInboundEmail(rawText, heuristicFields);
  } else if (docType === "vendor_quote_pdf") {
    fields = mockVendorQuote(rawText, heuristicFields);
  } else {
    fields = { ...heuristicFields, note: "Unsupported docType for mock SLM" };
  }

  return {
    source: "slm_mock",
    model: "mock-phi3-extract-v0",
    latency_ms: Date.now() - started,
    fields,
    confidence: 0.58,
    note: "Mock SLM only — no external/paid API. Plug a local Phi-3 extract here later.",
  };
}

module.exports = {
  extractViaSLM,
};
