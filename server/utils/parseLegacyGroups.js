/**
 * Parse legacy QuotationReport `Group` package strings into discrete catalog-aware
 * line-item drafts for quote_lines / analytics / price-reference.
 *
 * Example:
 *   "Compressed Air System,Gas Storage Vessel,nGen Nitrogen Generator High Purity"
 *   → 3 components, mapped to product_groups/products when possible.
 */

"use strict";

const LEGACY_ALIASES = Object.freeze({
  ngenx: "ngen",
  "ngen x": "ngen",
  "n gen": "ngen",
  "compressed air system": "ngen air package",
  "gas storage vessel": "ngen gas storage",
  "idos c": "idos",
  "medo psa only": "medo psa package",
  "industrial oxygen": "idos oxygen generator",
  "nogen nitrogen generator": "ngen nitrogen generator",
});

function normalizeLegacyToken(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyLegacyAlias(normalized) {
  if (!normalized) return normalized;
  if (LEGACY_ALIASES[normalized]) return LEGACY_ALIASES[normalized];
  // Prefix-style aliases (e.g. ngenx nitrogen… → ngen nitrogen…)
  let out = normalized;
  out = out.replace(/\bngenx\b/g, "ngen");
  out = out.replace(/\bn gen\b/g, "ngen");
  return out;
}

/**
 * Split a legacy Group cell into ordered component labels.
 * Handles comma separators and lightly normalizes whitespace / trailing commas.
 */
function splitLegacyGroupString(groupValue) {
  const raw = String(groupValue || "").trim();
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0)
    .filter((part) => !/^(n\/?a|na|-|none|nil)$/i.test(part));
}

function slugLegacyCode(label, maxLen = 40) {
  const slug = normalizeLegacyToken(label).replace(/\s+/g, "_").toUpperCase();
  const trimmed = slug.slice(0, maxLen).replace(/^_+|_+$/g, "");
  return trimmed || "CUSTOM";
}

function indexCatalog(catalog = {}) {
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];

  const byNorm = {
    productName: new Map(),
    productCode: new Map(),
    groupName: new Map(),
    categoryName: new Map(),
  };

  for (const p of products) {
    const nameKey = applyLegacyAlias(normalizeLegacyToken(p.item_name));
    const codeKey = normalizeLegacyToken(p.item_code || p.sku);
    if (nameKey && !byNorm.productName.has(nameKey)) byNorm.productName.set(nameKey, p);
    if (codeKey && !byNorm.productCode.has(codeKey)) byNorm.productCode.set(codeKey, p);
  }
  for (const g of groups) {
    const key = applyLegacyAlias(normalizeLegacyToken(g.group_name));
    if (key && !byNorm.groupName.has(key)) byNorm.groupName.set(key, g);
  }
  for (const c of categories) {
    const key = applyLegacyAlias(normalizeLegacyToken(c.category_name));
    if (key && !byNorm.categoryName.has(key)) byNorm.categoryName.set(key, c);
  }

  return { products, groups, categories, byNorm };
}

function fuzzyFind(normalized, entries, pick) {
  if (!normalized || normalized.length < 3) return null;
  let best = null;
  let bestScore = 0;
  for (const [key, value] of entries) {
    if (!key) continue;
    let score = 0;
    if (key === normalized) score = 100;
    else if (key.length >= 6 && normalized.length >= 6) {
      const shorter = Math.min(key.length, normalized.length);
      const longer = Math.max(key.length, normalized.length);
      const ratio = shorter / longer;
      // Only accept containment/prefix when tokens are close in length (avoid
      // "nGen Nitrogen Generator" → "… High Purity" false positives).
      if (ratio < 0.75) {
        score = 0;
      } else if (key.startsWith(normalized) || normalized.startsWith(key)) {
        score = Math.round(80 * ratio);
      } else if (key.includes(normalized) || normalized.includes(key)) {
        score = Math.round(60 * ratio);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = pick(value, key, score);
    }
  }
  return bestScore >= 70 ? best : null;
}

/**
 * Map one legacy component label to product / group / category.
 * @returns {{
 *   label: string,
 *   normalized: string,
 *   match_type: 'product'|'product_group'|'product_category'|'custom',
 *   product_id: number|null,
 *   product_group_id: number|null,
 *   product_category_id: number|null,
 *   item_code: string,
 *   item_name: string,
 *   hsn_no: string|null,
 *   gst_pct: number|null,
 *   match_score: number
 * }}
 */
function mapLegacyComponent(label, catalogIndex) {
  const original = String(label || "").trim();
  const normalized = applyLegacyAlias(normalizeLegacyToken(original));
  const idx = catalogIndex || indexCatalog();

  const productExact =
    idx.byNorm.productName.get(normalized) || idx.byNorm.productCode.get(normalized) || null;
  if (productExact) {
    return {
      label: original,
      normalized,
      match_type: "product",
      product_id: productExact.id,
      product_group_id: productExact.group_id || null,
      product_category_id: productExact.category_id || null,
      item_code: productExact.item_code || productExact.sku || `LEGACY-${slugLegacyCode(original)}`,
      item_name: productExact.item_name || original,
      hsn_no: productExact.hsn_no || null,
      gst_pct: productExact.gst_pct != null ? Number(productExact.gst_pct) : null,
      match_score: 100,
    };
  }

  const groupExact = idx.byNorm.groupName.get(normalized) || null;
  if (groupExact) {
    // Prefer a representative finished-good product in that group when available
    const representative =
      idx.products.find(
        (p) =>
          Number(p.group_id) === Number(groupExact.id) &&
          String(p.item_type || "").toLowerCase() === "finished_good"
      ) || idx.products.find((p) => Number(p.group_id) === Number(groupExact.id)) || null;

    return {
      label: original,
      normalized,
      match_type: representative ? "product" : "product_group",
      product_id: representative?.id || null,
      product_group_id: groupExact.id,
      product_category_id: groupExact.category_id || representative?.category_id || null,
      item_code: representative?.item_code || `GRP-${slugLegacyCode(groupExact.group_name)}`,
      item_name: representative?.item_name || groupExact.group_name || original,
      hsn_no: representative?.hsn_no || null,
      gst_pct: representative?.gst_pct != null ? Number(representative.gst_pct) : null,
      match_score: representative ? 92 : 85,
    };
  }

  const categoryExact = idx.byNorm.categoryName.get(normalized) || null;
  if (categoryExact) {
    return {
      label: original,
      normalized,
      match_type: "product_category",
      product_id: null,
      product_group_id: null,
      product_category_id: categoryExact.id,
      item_code: `CAT-${slugLegacyCode(categoryExact.category_name)}`,
      item_name: categoryExact.category_name || original,
      hsn_no: null,
      gst_pct: null,
      match_score: 75,
    };
  }

  const fuzzyProduct = fuzzyFind(normalized, idx.byNorm.productName, (p, _k, score) => ({
    ...p,
    _score: score,
  }));
  if (fuzzyProduct) {
    return {
      label: original,
      normalized,
      match_type: "product",
      product_id: fuzzyProduct.id,
      product_group_id: fuzzyProduct.group_id || null,
      product_category_id: fuzzyProduct.category_id || null,
      item_code: fuzzyProduct.item_code || `LEGACY-${slugLegacyCode(original)}`,
      item_name: fuzzyProduct.item_name || original,
      hsn_no: fuzzyProduct.hsn_no || null,
      gst_pct: fuzzyProduct.gst_pct != null ? Number(fuzzyProduct.gst_pct) : null,
      match_score: fuzzyProduct._score,
    };
  }

  const fuzzyGroup = fuzzyFind(normalized, idx.byNorm.groupName, (g, _k, score) => ({
    ...g,
    _score: score,
  }));
  if (fuzzyGroup) {
    return {
      label: original,
      normalized,
      match_type: "product_group",
      product_id: null,
      product_group_id: fuzzyGroup.id,
      product_category_id: fuzzyGroup.category_id || null,
      item_code: `GRP-${slugLegacyCode(fuzzyGroup.group_name)}`,
      item_name: fuzzyGroup.group_name || original,
      hsn_no: null,
      gst_pct: null,
      match_score: fuzzyGroup._score,
    };
  }

  return {
    label: original,
    normalized,
    match_type: "custom",
    product_id: null,
    product_group_id: null,
    product_category_id: null,
    item_code: `LEGACY-${slugLegacyCode(original)}`,
    item_name: original,
    hsn_no: null,
    gst_pct: null,
    match_score: 0,
  };
}

/**
 * Allocate quotation money across mapped components.
 * Prefer SubTotal (pre-GST). Fall back to TotalPrice when SubTotal is missing.
 * Equal split with remainder on the last line so totals reconcile.
 */
function allocateLegacyLineAmounts({
  componentCount,
  subtotal = null,
  totalPrice = null,
  quantity = null,
}) {
  const n = Math.max(1, Number(componentCount) || 1);
  const qtyRaw = Number(quantity);
  const hasQty = Number.isFinite(qtyRaw) && qtyRaw > 0;

  // When report Quantity matches component count (common legacy pattern), treat as 1 each.
  const perLineQty =
    hasQty && Math.abs(qtyRaw - n) < 0.0001 ? 1 : hasQty && n === 1 ? qtyRaw : 1;

  const basis =
    Number.isFinite(Number(subtotal)) && Number(subtotal) > 0
      ? Number(subtotal)
      : Number.isFinite(Number(totalPrice)) && Number(totalPrice) > 0
        ? Number(totalPrice)
        : 0;

  const share = n > 0 ? basis / n : 0;
  const amounts = [];
  let allocated = 0;
  for (let i = 0; i < n; i += 1) {
    const isLast = i === n - 1;
    const lineTotal = isLast ? Number((basis - allocated).toFixed(2)) : Number(share.toFixed(2));
    allocated = Number((allocated + lineTotal).toFixed(2));
    const qty = Number(perLineQty.toFixed(4));
    const unit = qty > 0 ? Number((lineTotal / qty).toFixed(4)) : 0;
    amounts.push({ qty, unit_price: unit, line_total: lineTotal });
  }
  return { basis, amounts };
}

/**
 * Parse a legacy Group string into mapped components (+ optional amount drafts).
 *
 * @param {string} groupValue
 * @param {object} [catalog] products/groups/categories arrays
 * @param {object} [money] { subtotal, totalPrice, gstRate, quantity }
 */
function parseLegacyGroups(groupValue, catalog = null, money = null) {
  const labels = splitLegacyGroupString(groupValue);
  const catalogIndex = indexCatalog(catalog || {});
  const components = labels.map((label) => mapLegacyComponent(label, catalogIndex));

  if (!components.length && String(groupValue || "").trim()) {
    components.push(mapLegacyComponent(String(groupValue).trim(), catalogIndex));
  }

  let lines = components.map((c, i) => ({
    line_no: i + 1,
    ...c,
    qty: 1,
    unit_price: 0,
    line_total: 0,
    gst_pct: c.gst_pct,
    scope_type: "included",
    line_description: `Legacy package component from Group: ${c.label}`,
  }));

  if (money && components.length) {
    const gstFallback =
      money.gstRate != null && Number.isFinite(Number(money.gstRate)) ? Number(money.gstRate) : 18;
    const { amounts } = allocateLegacyLineAmounts({
      componentCount: components.length,
      subtotal: money.subtotal,
      totalPrice: money.totalPrice,
      quantity: money.quantity,
    });
    lines = lines.map((line, i) => {
      const amt = amounts[i] || { qty: 1, unit_price: 0, line_total: 0 };
      return {
        ...line,
        qty: amt.qty,
        unit_price: amt.unit_price,
        line_total: amt.line_total,
        gst_pct: line.gst_pct != null && Number.isFinite(Number(line.gst_pct)) ? Number(line.gst_pct) : gstFallback,
      };
    });
  }

  return {
    raw: String(groupValue || "").trim(),
    component_count: lines.length,
    mapped_count: lines.filter((l) => l.match_type !== "custom").length,
    custom_count: lines.filter((l) => l.match_type === "custom").length,
    components: lines,
  };
}

module.exports = {
  LEGACY_ALIASES,
  normalizeLegacyToken,
  applyLegacyAlias,
  splitLegacyGroupString,
  slugLegacyCode,
  indexCatalog,
  mapLegacyComponent,
  allocateLegacyLineAmounts,
  parseLegacyGroups,
};
