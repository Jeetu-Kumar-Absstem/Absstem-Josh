/**
 * Taxable Packing & Forwarding and Freight charge lines on customer invoices.
 * These are independent commercial tracks — P&F is packing/forwarding, not freight.
 * GST rule: when Absstem bills either with goods, treat as composite supply —
 * same GST% + goods HSN as the principal goods line(s).
 *
 * Freight commercial modes:
 *   Inclusive            → not billed separately
 *   Buyer Scope          → buyer arranges; not billed by Absstem
 *   Buyer Approved billed / Extra at Actuals → amount entered and billed on invoice
 *
 * P&F commercial modes (separate master):
 *   Extra at Actuals     → billed on invoice
 *   Included in Price    → not billed separately
 *   To Buyer Account     → not billed by Absstem
 */

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeTermKey(termCode, termName) {
  return {
    code: cleanText(termCode).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
    name: cleanText(termName).toLowerCase(),
  };
}

/** Packing & Forwarding only — not freight. */
function isBillablePAndFTerm(termCode, termName) {
  const { code, name } = normalizeTermKey(termCode, termName);
  if (!code && !name) return false;
  if (code === "INCL" || code === "INCLUDED") return false;
  if (code === "BUYER" || code === "BUYER_ACCOUNT" || code === "TO_BUYER") return false;
  if (name.includes("included") || name.includes("buyer account") || name.includes("to buyer")) return false;
  if (code === "EXTRA" || code.startsWith("EXTRA")) return true;
  if (code.includes("%") || name.includes("%")) return true;
  if (name.includes("extra") || name.includes("actual")) return true;
  return false;
}

/** Freight only — independent of P&F. */
function isBillableFreightTerm(termCode, termName) {
  const { code, name } = normalizeTermKey(termCode, termName);
  if (!code && !name) return false;
  // Not billed separately on Absstem invoice
  if (code === "INCL" || code === "INCLUDED" || code === "INCLUSIVE") return false;
  if (name.includes("inclusive") || (name.includes("included") && !name.includes("billed"))) return false;
  if (code === "BUYER_SCOPE" || code === "BUYER" || code === "SCOPE") return false;
  if (name.includes("buyer scope") || (name.includes("scope") && !name.includes("approved"))) return false;
  // Billed on invoice (buyer-approved amount, or extra at actuals)
  if (code === "BUYER_BILLED" || code === "BUYER_APPROVED" || code === "BILLED") return true;
  if (name.includes("buyer approved") || (name.includes("billed") && name.includes("invoice"))) return true;
  if (code === "EXTRA" || code.startsWith("EXTRA")) return true;
  if (name.includes("extra") || name.includes("actual")) return true;
  return false;
}

/** @deprecated use isBillablePAndFTerm / isBillableFreightTerm */
function isBillableCommercialTerm(termCode, termName) {
  return isBillablePAndFTerm(termCode, termName) || isBillableFreightTerm(termCode, termName);
}

const CHARGE_META = Object.freeze({
  packing_forwarding: {
    kind: "packing_forwarding",
    item_code: "P&F",
    item_name: "Packing & Forwarding",
    line_description: "Packing & Forwarding charges",
  },
  freight: {
    kind: "freight",
    item_code: "FREIGHT",
    item_name: "Freight / Transportation",
    line_description: "Freight / transportation charges",
  },
});

function pickGoodsTaxProfile(goodsLines) {
  const lines = Array.isArray(goodsLines) ? goodsLines.filter((line) => !cleanText(line.charge_kind)) : [];
  if (!lines.length) {
    return { hsn_no: null, gst_pct: 18, unit_price_base_ratio: 1 };
  }
  // Dominant taxable line (highest invoice line total), else first.
  let best = lines[0];
  let bestTotal = money(best.line_total_invoice ?? qty(best.qty) * money(best.unit_price_invoice || best.unit_price_order));
  for (const line of lines.slice(1)) {
    const total = money(line.line_total_invoice ?? qty(line.qty) * money(line.unit_price_invoice || line.unit_price_order));
    if (total > bestTotal) {
      best = line;
      bestTotal = total;
    }
  }
  const unitInvoice = money(best.unit_price_invoice || best.unit_price_order);
  const unitBase = money(best.unit_price_base || unitInvoice);
  const ratio = unitInvoice > 0 ? unitBase / unitInvoice : 1;
  return {
    hsn_no: cleanText(best.hsn_no) || null,
    gst_pct: qty(best.gst_pct) || 18,
    unit_price_base_ratio: ratio > 0 ? ratio : 1,
  };
}

function buildChargeLinePayload({ kind, amountInvoice, goodsLines, lineNo }) {
  const meta = CHARGE_META[kind];
  if (!meta) throw new Error(`UNKNOWN_CHARGE_KIND:${kind}`);
  const amount = money(amountInvoice);
  if (amount <= 0) return null;
  const profile = pickGoodsTaxProfile(goodsLines);
  const unitInvoice = amount;
  const unitBase = money(unitInvoice * profile.unit_price_base_ratio);
  return {
    charge_kind: meta.kind,
    sales_order_line_id: null,
    product_id: null,
    line_no: Number(lineNo) || 9000,
    item_code: meta.item_code,
    item_name: meta.item_name,
    line_description: meta.line_description,
    hsn_no: profile.hsn_no,
    qty: 1,
    unit_price_base: unitBase,
    unit_price_invoice: unitInvoice,
    gst_pct: profile.gst_pct,
    customer_item_code: null,
    customer_item_description: null,
  };
}

function summarizeChargesFromLines(lines) {
  const out = {
    packing_forwarding_amount: 0,
    freight_amount: 0,
    packing_forwarding_line_id: null,
    freight_line_id: null,
  };
  for (const line of Array.isArray(lines) ? lines : []) {
    const kind = cleanText(line.charge_kind);
    if (kind === "packing_forwarding") {
      out.packing_forwarding_amount = money(line.line_total_invoice ?? line.unit_price_invoice);
      out.packing_forwarding_line_id = line.id || null;
    }
    if (kind === "freight") {
      out.freight_amount = money(line.line_total_invoice ?? line.unit_price_invoice);
      out.freight_line_id = line.id || null;
    }
  }
  return out;
}

module.exports = {
  CHARGE_META,
  money,
  qty,
  cleanText,
  isBillableCommercialTerm,
  isBillablePAndFTerm,
  isBillableFreightTerm,
  pickGoodsTaxProfile,
  buildChargeLinePayload,
  summarizeChargesFromLines,
};
