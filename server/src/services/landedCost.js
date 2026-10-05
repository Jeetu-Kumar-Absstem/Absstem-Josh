function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, scale = 4) {
  const factor = 10 ** scale;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function cleanDate(value) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date().toISOString().slice(0, 10);
}

function vendorMatches(row, vendor) {
  if (!row || !vendor) return false;
  if (row.vendor_id && Number(row.vendor_id) === Number(vendor.id)) return true;
  if (row.vendor_id) return false;
  const avlName = String(row.vendor_name || "").trim().toLowerCase();
  if (!avlName) return false;
  return [vendor.company_name, vendor.vendor_code]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .includes(avlName);
}

async function resolveExchangeRate(client, { fromCurrencyId, toCurrencyId, rateDate } = {}) {
  const from = Number(fromCurrencyId);
  const to = Number(toCurrencyId);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return 1;

  const date = cleanDate(rateDate);
  const direct = await client.query(
    `
      select rate_value
      from exchange_rates
      where from_currency_id = $1
        and to_currency_id = $2
        and rate_date <= $3::date
      order by rate_date desc, id desc
      limit 1
    `,
    [from, to, date]
  );
  const directRate = number(direct.rows[0]?.rate_value);
  if (directRate > 0) return directRate;

  const inverse = await client.query(
    `
      select rate_value
      from exchange_rates
      where from_currency_id = $1
        and to_currency_id = $2
        and rate_date <= $3::date
      order by rate_date desc, id desc
      limit 1
    `,
    [to, from, date]
  );
  const inverseRate = number(inverse.rows[0]?.rate_value);
  if (inverseRate > 0) return round(1 / inverseRate, 8);

  const error = new Error("EXCHANGE_RATE_NOT_FOUND");
  error.status = 400;
  error.code = "EXCHANGE_RATE_NOT_FOUND";
  error.detail = `No active exchange rate exists for currency pair ${from} → ${to}.`;
  throw error;
}

function calculateLineLandedCost({
  rawUnitOrder,
  quantity,
  fxRate = 1,
  freightPercentage = 0,
  importDutyPercentage = 0,
  handlingUnitBase = 0,
} = {}) {
  const rawOrder = Math.max(0, number(rawUnitOrder));
  const qty = Math.max(0, number(quantity));
  const fx = number(fxRate, 1) > 0 ? number(fxRate, 1) : 1;
  const rawUnitBase = round(rawOrder * fx);
  const freightUnitBase = round(rawUnitBase * number(freightPercentage) / 100);
  const importDutyUnitBase = round(rawUnitBase * number(importDutyPercentage) / 100);
  const handlingUnit = round(Math.max(0, number(handlingUnitBase)));
  const landedUnitBase = round(rawUnitBase + freightUnitBase + importDutyUnitBase + handlingUnit);
  return {
    quantity: qty,
    raw_unit_order: round(rawOrder),
    raw_unit_base: rawUnitBase,
    freight_percentage: round(freightPercentage),
    freight_unit_base: freightUnitBase,
    import_duty_percentage: round(importDutyPercentage),
    import_duty_unit_base: importDutyUnitBase,
    handling_unit_base: handlingUnit,
    landed_unit_base: landedUnitBase,
    landed_total_base: round(landedUnitBase * qty, 2),
    landed_unit_order: round(landedUnitBase / fx),
    landed_total_order: round((landedUnitBase * qty) / fx, 2),
    fx_rate: fx,
  };
}

async function loadPurchaseOrderCostContext(client, purchaseOrderId, companyId) {
  const headerRes = await client.query(
    `
      select
        po.id,
        po.company_id,
        po.vendor_id,
        po.po_date,
        po.order_currency_id,
        po.base_currency_id,
        po.handling_fee_override_order,
        v.company_name as vendor_name,
        v.vendor_code
      from purchase_orders po
      left join vendors v on v.id = po.vendor_id and v.company_id = po.company_id
      where po.id = $1 and po.company_id = $2
      limit 1
    `,
    [Number(purchaseOrderId), Number(companyId)]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return null;

  const linesRes = await client.query(
    `
      select
        pol.*,
        p.item_code as product_item_code,
        p.item_name as product_item_name,
        coalesce(pol.component_specification_id, bom_spec.spec_id) as resolved_specification_id,
        cs.spec_code,
        cs.spec_name,
        cs.geometry,
        cs.material,
        cs.pressure_rating
      from purchase_order_lines pol
      left join products p on p.id = pol.product_id
      left join lateral (
        select bl.component_specification_id as spec_id
        from manufacturing_bom_lines bl
        join manufacturing_boms mb on mb.id = bl.bom_id
        where bl.component_product_id = pol.product_id
          and bl.component_specification_id is not null
          and mb.company_id = $2
          and mb.is_active = true
        order by mb.revision_no desc, mb.updated_at desc, mb.id desc, bl.line_no asc
        limit 1
      ) bom_spec on true
      left join component_specifications cs
        on cs.id = coalesce(pol.component_specification_id, bom_spec.spec_id)
      where pol.purchase_order_id = $1
      order by pol.line_no asc
    `,
    [Number(purchaseOrderId), Number(companyId)]
  );

  const fxRate = await resolveExchangeRate(client, {
    fromCurrencyId: header.order_currency_id,
    toCurrencyId: header.base_currency_id,
    rateDate: header.po_date,
  });

  const lines = linesRes.rows.map((line) => ({
    ...line,
    resolved_specification_id: line.resolved_specification_id ? Number(line.resolved_specification_id) : null,
    quantity: number(line.qty),
  }));

  const specIds = [...new Set(lines.map((line) => line.resolved_specification_id).filter(Boolean))];
  const avlRes = specIds.length
    ? await client.query(
        `
          select
            a.*,
            v.company_name as vendor_company_name,
            v.vendor_code
          from component_specification_avl a
          left join vendors v on v.id = a.vendor_id
          where a.component_specification_id = any($1::bigint[])
            and a.is_active = true
          order by a.component_specification_id, a.is_preferred desc, a.id asc
        `,
        [specIds]
      )
    : { rows: [] };

  return {
    header: {
      ...header,
      vendor: {
        id: Number(header.vendor_id),
        company_name: header.vendor_name,
        vendor_code: header.vendor_code,
      },
    },
    lines,
    avlRows: avlRes.rows,
    fxRate,
  };
}

function findVendorAvl(avlRows, line, vendor) {
  const candidates = avlRows.filter(
    (row) => Number(row.component_specification_id) === Number(line.resolved_specification_id)
  );
  return (
    candidates.find((row) => row.product_id && Number(row.product_id) === Number(line.product_id) && vendorMatches(row, vendor)) ||
    candidates.find((row) => vendorMatches(row, vendor)) ||
    null
  );
}

function buildLineCost(line, avl, fxRate, handlingAllocationBase = null) {
  const handlingDefault = avl ? number(avl.handling_fee_per_unit) * number(line.quantity) : 0;
  const handlingTotal = handlingAllocationBase !== null ? handlingAllocationBase : handlingDefault;
  const handlingUnit = line.quantity > 0 ? handlingTotal / line.quantity : 0;
  return {
    ...calculateLineLandedCost({
      rawUnitOrder: line.unit_price_order,
      quantity: line.quantity,
      fxRate,
      freightPercentage: avl?.freight_percentage || 0,
      importDutyPercentage: avl?.import_duty_percentage || 0,
      handlingUnitBase: handlingUnit,
    }),
    id: Number(line.id),
    line_no: Number(line.line_no),
    product_id: line.product_id ? Number(line.product_id) : null,
    item_code: line.item_code || line.product_item_code || null,
    item_name: line.item_name || line.product_item_name || null,
    component_specification_id: line.resolved_specification_id,
    spec_code: line.spec_code || null,
    spec_name: line.spec_name || null,
    avl_id: avl ? Number(avl.id) : null,
    vendor_name: avl?.vendor_company_name || avl?.vendor_name || null,
    brand_name: avl?.brand_name || avl?.product_brand || null,
    avl_status: line.resolved_specification_id ? (avl ? "approved" : "missing") : "not_governed",
  };
}

function buildAlternativeScenarios(context, currentLines) {
  const candidates = new Map();
  for (const row of context.avlRows) {
    const key = row.vendor_id
      ? `vendor:${row.vendor_id}`
      : `name:${String(row.vendor_name || "").trim().toLowerCase()}`;
    if (!key || key === "name:") continue;
    if (!candidates.has(key)) {
      candidates.set(key, {
        key,
        vendor_id: row.vendor_id ? Number(row.vendor_id) : null,
        vendor_name: row.vendor_company_name || row.vendor_name || "Unassigned vendor",
        total_base: 0,
        missing_lines: 0,
      });
    }
  }

  return [...candidates.values()]
    .map((scenario) => {
      let total = 0;
      let missing = 0;
      for (const line of context.lines) {
        if (!line.resolved_specification_id) {
          total += number(line.qty) * number(line.unit_price_order) * context.fxRate;
          continue;
        }
        const avl = context.avlRows.find(
          (row) =>
            Number(row.component_specification_id) === Number(line.resolved_specification_id) &&
            (scenario.vendor_id
              ? Number(row.vendor_id) === Number(scenario.vendor_id)
              : String(row.vendor_name || "").trim().toLowerCase() === String(scenario.vendor_name || "").trim().toLowerCase())
        );
        if (!avl) {
          missing += 1;
          continue;
        }
        const cost = buildLineCost(line, avl, context.fxRate);
        total += cost.landed_total_base;
      }
      const currentTotal = currentLines.reduce((sum, line) => sum + number(line.landed_total_base), 0);
      return {
        ...scenario,
        total_base: round(total, 2),
        variance_base: round(total - currentTotal, 2),
        variance_pct: currentTotal > 0 ? round(((total - currentTotal) / currentTotal) * 100, 4) : 0,
        missing_lines: missing,
      };
    })
    .sort((a, b) => a.total_base - b.total_base);
}

async function getPurchaseOrderLandedCostPreview(client, purchaseOrderId, companyId, { strict = false } = {}) {
  const context = await loadPurchaseOrderCostContext(client, purchaseOrderId, companyId);
  if (!context) return null;

  const rawTotals = context.lines.reduce(
    (sum, line) => sum + number(line.qty) * number(line.unit_price_order) * context.fxRate,
    0
  );
  const override = context.header.handling_fee_override_order == null
    ? null
    : number(context.header.handling_fee_override_order) * context.fxRate;
  const currentLines = [];
  let allocatedOverride = 0;

  for (const line of context.lines) {
    const lineRawBase = number(line.qty) * number(line.unit_price_order) * context.fxRate;
    const lineAllocation = override !== null && rawTotals > 0 ? (override * lineRawBase) / rawTotals : 0;
    allocatedOverride += lineAllocation;
    const avl = findVendorAvl(context.avlRows, line, context.header.vendor);
    currentLines.push(buildLineCost(line, avl, context.fxRate, override !== null ? lineAllocation : null));
  }

  const currentTotal = currentLines.reduce((sum, line) => sum + number(line.landed_total_base), 0);
  const missingAvl = currentLines.filter((line) => line.avl_status === "missing");
  if (strict && missingAvl.length) {
    const error = new Error("UNAPPROVED_VENDOR");
    error.status = 400;
    error.code = "UNAPPROVED_VENDOR";
    error.detail = `No active AVL profile is available for the selected vendor on: ${missingAvl
      .map((line) => line.spec_code || line.item_code || `line ${line.line_no}`)
      .join(", ")}.`;
    throw error;
  }

  const thresholdRes = await client.query(
    `
      select landed_cost_variance_threshold_pct
      from company_finance_settings
      where company_id = $1
      limit 1
    `,
    [Number(companyId)]
  );
  const threshold = number(thresholdRes.rows[0]?.landed_cost_variance_threshold_pct, 5);
  const alternatives = buildAlternativeScenarios(
    context,
    currentLines
  ).map((row) => ({
    ...row,
    exceeds_threshold: Math.abs(number(row.variance_pct)) > threshold,
  }));

  return {
    purchase_order_id: Number(purchaseOrderId),
    vendor_id: Number(context.header.vendor_id),
    vendor_name: context.header.vendor_name,
    order_currency_id: Number(context.header.order_currency_id),
    base_currency_id: Number(context.header.base_currency_id),
    fx_rate: context.fxRate,
    handling_fee_override_order: context.header.handling_fee_override_order,
    handling_fee_override_base: override,
    handling_fee_allocated_base: round(allocatedOverride, 2),
    variance_threshold_pct: threshold,
    lines: currentLines,
    totals: {
      raw_base: round(currentLines.reduce((sum, line) => sum + line.raw_unit_base * line.quantity, 0), 2),
      freight_base: round(currentLines.reduce((sum, line) => sum + line.freight_unit_base * line.quantity, 0), 2),
      import_duty_base: round(currentLines.reduce((sum, line) => sum + line.import_duty_unit_base * line.quantity, 0), 2),
      handling_base: round(currentLines.reduce((sum, line) => sum + line.handling_unit_base * line.quantity, 0), 2),
      landed_base: round(currentTotal, 2),
      landed_order: round(currentTotal / context.fxRate, 2),
    },
    alternatives,
  };
}

async function snapshotPurchaseOrderLandedCost(client, purchaseOrderId, companyId) {
  const preview = await getPurchaseOrderLandedCostPreview(client, purchaseOrderId, companyId, { strict: true });
  if (!preview) return null;

  for (const line of preview.lines) {
    await client.query(
      `
        update purchase_order_lines
        set component_specification_id = $2,
            component_specification_avl_id = $3,
            landed_cost_fx_rate = $4,
            landed_cost_raw_unit_base = $5,
            landed_cost_freight_unit_base = $6,
            landed_cost_import_duty_unit_base = $7,
            landed_cost_handling_unit_base = $8,
            landed_cost_unit_base = $9,
            landed_cost_total_base = $10,
            landed_cost_raw_unit_order = $11,
            landed_cost_total_order = $12,
            landed_cost_calculated_at = now()
        where id = $1
      `,
      [
        line.id,
        line.component_specification_id,
        line.avl_id,
        line.fx_rate,
        line.raw_unit_base,
        line.freight_unit_base,
        line.import_duty_unit_base,
        line.handling_unit_base,
        line.landed_unit_base,
        line.landed_total_base,
        line.raw_unit_order,
        line.landed_total_order,
      ]
    );
  }
  await client.query(
    `update purchase_orders set landed_cost_calculated_at = now(), updated_at = now() where id = $1 and company_id = $2`,
    [Number(purchaseOrderId), Number(companyId)]
  );
  return preview;
}

async function getCompanyLandedCostSettings(client, companyId) {
  await client.query(
    `
      insert into company_finance_settings (company_id)
      values ($1)
      on conflict (company_id) do nothing
    `,
    [Number(companyId)]
  );
  const result = await client.query(
    `select * from company_finance_settings where company_id = $1 limit 1`,
    [Number(companyId)]
  );
  return result.rows[0] || null;
}

module.exports = {
  round,
  resolveExchangeRate,
  calculateLineLandedCost,
  getPurchaseOrderLandedCostPreview,
  snapshotPurchaseOrderLandedCost,
  getCompanyLandedCostSettings,
};
