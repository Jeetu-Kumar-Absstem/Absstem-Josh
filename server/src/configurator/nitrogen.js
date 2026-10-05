const { pool } = require("../db/pool");

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizePurity(p) {
  const s = String(p ?? "").trim();
  if (!s) return null;
  const n = toNum(s);
  if (n === null) return null;
  return String(n);
}

function normText(value) {
  return String(value ?? "").trim();
}

function normAttrKey(value) {
  return normText(value).replace(/\s+/g, " ").toUpperCase();
}

function parseNumber(text, { unitRegex = null } = {}) {
  const str = normText(text);
  if (!str) return null;
  if (unitRegex) {
    const m = str.match(unitRegex);
    if (m?.[1] !== undefined) return toNum(m[1]);
  }
  const generic = str.match(/-?\d+(?:\.\d+)?/);
  return generic ? toNum(generic[0]) : null;
}

function parsePurityCaption(value) {
  const key = normAttrKey(value);
  const m = key.match(/^FLOW AT ([0-9.]+)\s*% PURITY$/);
  return m?.[1] ? normalizePurity(m[1]) : null;
}

function detectControllerVariant({ model, itemCode = "", groupName = "" }) {
  const modelText = normText(model);
  const itemCodeText = normText(itemCode);
  const groupText = normText(groupName);
  const combined = `${modelText} ${itemCodeText} ${groupText}`.toUpperCase();

  const isNgenx = /NGENX/i.test(combined);
  const isNitrogenDigital = isNgenx || /DIGITAL CONTROLLER/i.test(groupText);
  const isOxygenDigital =
    /\bIDOS\s*\d+(?:\.\d+)?\s*C\b/i.test(modelText) ||
    /\bIDOS\s*\d+(?:\.\d+)?C\b/i.test(modelText) ||
    /\bIDOS C\b/i.test(groupText);

  let baseSeries = "Generic";
  let controllerType = "Standard";
  if (isNgenx) {
    baseSeries = "nGENX";
    controllerType = "Digital Controller";
  } else if (/NGEN/i.test(combined)) {
    baseSeries = "nGEN";
    controllerType = isNitrogenDigital ? "Digital Controller" : "HMI";
  } else if (/IDOS/i.test(combined)) {
    baseSeries = "IDOS";
    controllerType = isOxygenDigital ? "Digital Controller" : "HMI";
  }

  return {
    baseSeries,
    controllerType,
    variantRank: controllerType === "Digital Controller" ? 0 : controllerType === "HMI" ? 1 : 2,
  };
}

function buildAttributeMap(attrs) {
  const map = {};
  for (const attr of attrs || []) {
    const key = normAttrKey(attr?.caption);
    if (!key) continue;
    map[key] = normText(attr?.spec_value);
  }
  return map;
}

function parseAttributeNumber(attrs, captions, options = {}) {
  for (const caption of captions || []) {
    const value = parseNumber(attrs[normAttrKey(caption)], options);
    if (value !== null) return value;
  }
  return null;
}

async function loadProductCatalog(categoryName, { clientOrPool = pool } = {}) {
  try {
    const res = await clientOrPool.query(
      `
        select
          p.id,
          p.item_code,
          p.item_name,
          p.list_price,
          pc.category_name,
          pg.group_name,
          pa.sort_order,
          pa.caption,
          pa.spec_value
        from products p
        join product_categories pc on pc.id = p.category_id
        left join product_groups pg on pg.id = p.group_id
        left join product_attributes pa on pa.product_id = p.id
        where p.is_active = true and lower(coalesce(pc.category_name, '')) = lower($1)
        order by p.id asc, pa.sort_order asc, pa.id asc
      `,
      [categoryName]
    );

    const byId = new Map();
    for (const row of res.rows) {
      if (!byId.has(row.id)) {
        byId.set(row.id, {
          id: row.id,
          item_code: row.item_code,
          item_name: row.item_name,
          list_price: row.list_price,
          category_name: row.category_name,
          group_name: row.group_name,
          attributes: [],
        });
      }
      if (row.caption || row.spec_value) {
        byId.get(row.id).attributes.push({
          sort_order: row.sort_order,
          caption: row.caption,
          spec_value: row.spec_value,
        });
      }
    }
    return Array.from(byId.values());
  } catch (_err) {
    return [];
  }
}

function parseNitrogenProductRows(products) {
  const rows = [];
  for (const product of products) {
    const attrs = buildAttributeMap(product.attributes);
    const storageVolume = parseAttributeNumber(
      attrs,
      ["RECOMMENDED NITROGEN STORAGE", "RECOMMENDED STORAGE", "NITROGEN STORAGE VOLUME", "STORAGE VOLUME", "STORAGEVOLUME"],
      { unitRegex: /([0-9.]+)\s*(?:LITERS?|LITRES?|LTR|L)\b/i }
    );
    const airVesselVolume = parseAttributeNumber(
      attrs,
      ["RECOMMENDED AIR RECEIVER", "AIR RECEIVER VOLUME", "AIR VESSEL", "AIR VESSEL VOLUME", "AIRVESSELVOLUME"],
      { unitRegex: /([0-9.]+)\s*(?:LITRES?|LITERS?|LTR|L)\b/i }
    );

    for (const attr of product.attributes || []) {
      const purity = parsePurityCaption(attr.caption);
      if (!purity) continue;
      rows.push({
        purity,
        flow: parseNumber(attr.spec_value, { unitRegex: /([0-9.]+)\s*NM3/i }),
        airRequirement: parseNumber(attr.spec_value, { unitRegex: /([0-9.]+)\s*CFM/i }),
        storageVolume,
        airVesselVolume,
        product_id: product.id || null,
        item_code: normText(product.item_code),
        model: normText(product.item_name || product.item_code),
        ...detectControllerVariant({
          model: product.item_name || product.item_code,
          itemCode: product.item_code,
          groupName: product.group_name,
        }),
      });
    }
  }
  return rows.filter((row) => row.model && row.flow !== null);
}

function parseOxygenProductRows(products) {
  return products
    .map((product) => {
      const model = normText(product.item_name || product.item_code);
      const attrs = buildAttributeMap(product.attributes);
      const flow = parseNumber(attrs["FLOW"], { unitRegex: /([0-9.]+)\s*NM3/i });
      const airRequirement = parseNumber(attrs["DRY AIR REQUIRED"], { unitRegex: /([0-9.]+)\s*CFM/i });
      const storageVolume = parseAttributeNumber(
        attrs,
        [
          "RECOMMENDED OXYGEN STORAGE",
          "RECOMMENDED STORAGE",
          "OXYGEN STORAGE VOLUME",
          "STORAGE VOLUME",
          "STORAGEVOLUME",
        ],
        { unitRegex: /([0-9.]+)\s*(?:LITERS?|LITRES?|LTR|L)\b/i }
      );
      const airVesselVolume = parseAttributeNumber(
        attrs,
        [
          "RECOMMENDED AIR RECEIVER",
          "AIR RECEIVER VOLUME",
          "AIR VESSEL",
          "AIR VESSEL VOLUME",
          "AIRVESSELVOLUME",
        ],
        { unitRegex: /([0-9.]+)\s*(?:LITERS?|LITRES?|LTR|L)\b/i }
      );

      return {
        purity: normalizePurity(parseNumber(attrs["PURITY"])),
        flow,
        airRequirement,
        storageVolume,
        airVesselVolume,
        product_id: product.id || null,
        item_code: normText(product.item_code),
        model,
        ...detectControllerVariant({
          model,
          itemCode: product.item_code,
          groupName: product.group_name,
        }),
      };
    })
    .filter((row) => row.model && row.flow !== null && row.purity);
}

function parseCompressorProductRows(products) {
  return products
    .map((product) => {
      const attrs = buildAttributeMap(product.attributes);
      return {
        compressorModel: normText(product.item_name || product.item_code),
        kw: normText(attrs["AIR COMPRESSOR KW"]),
        airflow: parseNumber(attrs["DRY AIR GENERATED"], { unitRegex: /([0-9.]+)\s*CFM/i }),
        dryAirStorageVolume: parseAttributeNumber(
          attrs,
          ["DRY AIR STORAGE", "DRY AIR STORAGE VOLUME", "AIR VESSEL VOLUME", "AIRVESSELVOLUME"],
          { unitRegex: /([0-9.]+)\s*(?:LITERS?|LITRES?|LTR|L)\b/i }
        ),
      };
    })
    .filter((row) => row.compressorModel && row.airflow !== null);
}

async function loadSelectorRows(key, { clientOrPool = pool } = {}) {
  if (key === "nitrogen") {
    const products = await loadProductCatalog("Nitrogen", { clientOrPool });
    return parseNitrogenProductRows(products);
  }
  if (key === "oxygen") {
    const products = await loadProductCatalog("Oxygen", { clientOrPool });
    return parseOxygenProductRows(products);
  }
  if (key === "compressor") {
    const products = await loadProductCatalog("Air System", { clientOrPool });
    return parseCompressorProductRows(products);
  }
  return [];
}

async function listPsaPurities(datasetKey, { seriesSuffix = "", controllerType = "", baseSeries = "", clientOrPool = pool } = {}) {
  const rows = await loadSelectorRows(datasetKey, { clientOrPool });
  const purities = Array.from(
    new Set(
      rows
        .filter((r) => !seriesSuffix || normText(r.model).endsWith(seriesSuffix))
        .filter((r) => !controllerType || normText(r.controllerType) === normText(controllerType))
        .filter((r) => !baseSeries || normText(r.baseSeries) === normText(baseSeries))
        .map((r) => normalizePurity(r.purity))
        .filter(Boolean)
    )
  );
  purities.sort((a, b) => Number(a) - Number(b));
  return purities;
}

function buildPsaRows(rows, { purity, seriesSuffix = "", controllerType = "", baseSeries = "" }) {
  return rows
    .filter((r) => normalizePurity(r.purity ?? r.Purity) === purity)
    .filter((r) => !seriesSuffix || normText(r.model || r.Model).endsWith(seriesSuffix))
    .map((r) => ({
      purity: normalizePurity(r.purity ?? r.Purity),
      flow: toNum(r.flow ?? r.Flow),
      airRequirement: toNum(r.airRequirement ?? r.AirRequirement),
      storageVolume: toNum(r.storageVolume ?? r.StorageVolume),
      airVesselVolume: toNum(r.airVesselVolume ?? r.AirVesselVolume),
      product_id: Number(r.product_id || r.productId || 0) || null,
      item_code: normText(r.item_code || r.itemCode || ""),
      model: normText(r.model || r.Model),
      baseSeries: r.baseSeries || detectControllerVariant({ model: r.model || r.Model }).baseSeries,
      controllerType: r.controllerType || detectControllerVariant({ model: r.model || r.Model }).controllerType,
      variantRank: r.variantRank ?? detectControllerVariant({ model: r.model || r.Model }).variantRank,
    }))
    .filter((r) => !controllerType || normText(r.controllerType) === normText(controllerType))
    .filter((r) => !baseSeries || normText(r.baseSeries) === normText(baseSeries))
    .filter((r) => r.flow !== null && r.model);
}

function buildRecommendation(data, flow) {
  data.sort((a, b) => a.flow - b.flow || (a.variantRank ?? 9) - (b.variantRank ?? 9) || a.model.localeCompare(b.model));
  if (!data.length) return { ok: false, error: "NO_DATA" };

  const higher = data.find((x) => x.flow >= flow) || data[data.length - 1];
  const lower = [...data].reverse().find((x) => x.flow <= flow) || data[0];
  const nearest = data.reduce((best, cur) => {
    const bd = Math.abs(best.flow - flow);
    const cd = Math.abs(cur.flow - flow);
    if (cd !== bd) return cd < bd ? cur : best;
    const br = best.variantRank ?? 9;
    const cr = cur.variantRank ?? 9;
    if (cr !== br) return cr < br ? cur : best;
    return cur.model.localeCompare(best.model) < 0 ? cur : best;
  }, data[0]);

  const targetFlows = Array.from(new Set([higher, nearest, lower].filter(Boolean).map((x) => x.flow)));
  const options = data
    .filter((row) => targetFlows.includes(row.flow))
    .sort((a, b) => {
      const ad = Math.abs(a.flow - flow);
      const bd = Math.abs(b.flow - flow);
      if (ad !== bd) return ad - bd;
      if ((a.variantRank ?? 9) !== (b.variantRank ?? 9)) return (a.variantRank ?? 9) - (b.variantRank ?? 9);
      return a.model.localeCompare(b.model);
    });

  const recommended = options.find((row) => row.flow === higher.flow) || higher;

  return { ok: true, recommended, nearest, lower, options };
}

async function recommendPsaModel(
  datasetKey,
  { purity, requiredFlow, seriesSuffix = "", controllerType = "", baseSeries = "", clientOrPool = pool }
) {
  const p = normalizePurity(purity);
  const flow = toNum(requiredFlow);
  if (!p || flow === null || flow <= 0) return { ok: false, error: "INVALID_INPUT" };

  const rows = await loadSelectorRows(datasetKey, { clientOrPool });
  const data = buildPsaRows(rows, { purity: p, seriesSuffix, controllerType, baseSeries });
  const recommendation = buildRecommendation(data, flow);
  if (!recommendation.ok) return recommendation;

  return {
    ok: true,
    purity: p,
    requiredFlow: flow,
    recommended: recommendation.recommended,
    nearest: recommendation.nearest,
    lower: recommendation.lower,
    options: recommendation.options,
  };
}

async function recommendNitrogenModel({
  purity,
  requiredFlow,
  seriesSuffix = "",
  controllerType = "",
  baseSeries = "",
  clientOrPool = pool,
}) {
  const primary = await recommendPsaModel("nitrogen", {
    purity,
    requiredFlow,
    seriesSuffix,
    controllerType,
    baseSeries,
    clientOrPool,
  });
  if (primary.ok) {
    return {
      ...primary,
      catalog_source_key: String(baseSeries || "").trim().toLowerCase() === "ngenx" ? "ngenx" : "nitrogen",
      catalog_source_label: String(baseSeries || "").trim().toLowerCase() === "ngenx" ? "Dedicated nGENX master data" : "Standard nitrogen master data",
      used_family_fallback: false,
    };
  }

  // NGENX should still size from the nitrogen engine even when compact-series
  // products are not tagged distinctly in the product master yet.
  if (String(baseSeries || "").trim().toLowerCase() === "ngenx") {
    const controllerFallback = await recommendPsaModel("nitrogen", {
      purity,
      requiredFlow,
      seriesSuffix,
      controllerType: "Digital Controller",
      baseSeries: "",
      clientOrPool,
    });
    if (controllerFallback.ok) {
      return {
        ...controllerFallback,
        catalog_source_key: "nitrogen_digital_controller",
        catalog_source_label: "Standard nitrogen master data (digital-controller fallback)",
        used_family_fallback: true,
      };
    }

    const genericFallback = await recommendPsaModel("nitrogen", {
      purity,
      requiredFlow,
      seriesSuffix,
      controllerType: "",
      baseSeries: "",
      clientOrPool,
    });
    if (genericFallback.ok) {
      return {
        ...genericFallback,
        catalog_source_key: "nitrogen",
        catalog_source_label: "Standard nitrogen master data",
        used_family_fallback: true,
      };
    }
    return genericFallback;
  }

  return primary;
}

async function recommendOxygenModel({ purity, requiredFlow, seriesSuffix = "", controllerType = "", baseSeries = "", clientOrPool = pool }) {
  return recommendPsaModel("oxygen", { purity, requiredFlow, seriesSuffix, controllerType, baseSeries, clientOrPool });
}

async function recommendCompressor(airRequirementCfm, { clientOrPool = pool } = {}) {
  const req = toNum(airRequirementCfm);
  if (req === null || req <= 0) return null;

  const data = (await loadSelectorRows("compressor", { clientOrPool }))
    .map((r) => ({
      compressorModel: normText(r.compressorModel),
      kw: normText(r.kw),
      airflow: toNum(String(r.airflow ?? "").replace(/[^0-9.]/g, "")),
      dryAirStorageVolume: toNum(r.dryAirStorageVolume),
    }))
    .filter((x) => x.airflow !== null && x.compressorModel);

  data.sort((a, b) => a.airflow - b.airflow);
  if (!data.length) return null;

  return data.find((x) => x.airflow >= req) || data[data.length - 1];
}

module.exports = { listPsaPurities, recommendNitrogenModel, recommendOxygenModel, recommendCompressor };
