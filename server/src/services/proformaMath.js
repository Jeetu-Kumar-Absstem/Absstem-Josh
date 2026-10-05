/**
 * Pure arithmetic for proforma invoices.
 * Milestone/adhoc amounts scale unit prices only — never qty (prevents double-scaling).
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

function calculateProformaLineAmounts(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => {
    const lineQty = qty(line.qty);
    const unitPriceBase = money(line.unit_price_base);
    const unitPriceProforma = money(line.unit_price_proforma ?? line.unit_price_invoice ?? line.unit_price_order);
    const gstPct = qty(line.gst_pct);
    const lineTotalBase = money(lineQty * unitPriceBase);
    const lineTotalProforma = money(lineQty * unitPriceProforma);
    const taxBase = money((lineTotalBase * gstPct) / 100);
    const taxProforma = money((lineTotalProforma * gstPct) / 100);
    return {
      ...line,
      qty: lineQty,
      unit_price_base: unitPriceBase,
      unit_price_proforma: unitPriceProforma,
      gst_pct: gstPct,
      line_total_base: lineTotalBase,
      line_total_proforma: lineTotalProforma,
      tax_total_base: taxBase,
      tax_total_proforma: taxProforma,
    };
  });
}

function calculateProformaTotals(lines) {
  const normalized = calculateProformaLineAmounts(lines);
  return normalized.reduce(
    (acc, line) => {
      acc.subtotal_base = money(acc.subtotal_base + line.line_total_base);
      acc.subtotal_proforma = money(acc.subtotal_proforma + line.line_total_proforma);
      acc.tax_total_base = money(acc.tax_total_base + line.tax_total_base);
      acc.tax_total_proforma = money(acc.tax_total_proforma + line.tax_total_proforma);
      acc.grand_total_base = money(acc.grand_total_base + line.line_total_base + line.tax_total_base);
      acc.grand_total_proforma = money(
        acc.grand_total_proforma + line.line_total_proforma + line.tax_total_proforma
      );
      return acc;
    },
    {
      subtotal_base: 0,
      subtotal_proforma: 0,
      tax_total_base: 0,
      tax_total_proforma: 0,
      grand_total_base: 0,
      grand_total_proforma: 0,
    }
  );
}

/**
 * Scale SO lines by billed percent — keep full qty, scale unit prices only.
 * Puts rounding residual on the last line so Σ ≈ round(SO × pct).
 */
function applyBilledPercent(soLines, percent) {
  const pct = qty(percent);
  const factor = pct / 100;
  if (!(factor > 0)) return [];

  const mapped = (Array.isArray(soLines) ? soLines : []).map((line) => ({
    ...line,
    qty: qty(line.qty),
    unit_price_base: money(qty(line.unit_price_base) * factor),
    unit_price_proforma: money(qty(line.unit_price_order ?? line.unit_price_invoice) * factor),
    gst_pct: qty(line.gst_pct),
    billed_percent: pct,
    charge_kind: null,
  }));

  const normalized = calculateProformaLineAmounts(mapped);
  if (normalized.length < 2) return normalized;

  const targetTaxable = money(
    (Array.isArray(soLines) ? soLines : []).reduce(
      (sum, line) => sum + qty(line.qty) * qty(line.unit_price_order ?? line.unit_price_invoice) * factor,
      0
    )
  );
  const actualTaxable = money(normalized.reduce((sum, line) => sum + line.line_total_proforma, 0));
  const delta = money(targetTaxable - actualTaxable);
  if (Math.abs(delta) >= 0.01) {
    const last = normalized[normalized.length - 1];
    last.line_total_proforma = money(last.line_total_proforma + delta);
    last.unit_price_proforma = last.qty > 0 ? money(last.line_total_proforma / last.qty) : last.unit_price_proforma;
    last.tax_total_proforma = money((last.line_total_proforma * last.gst_pct) / 100);
  }
  return normalized;
}

function assertMilestoneCoverage(existingProformas, newPercent) {
  const existing = (Array.isArray(existingProformas) ? existingProformas : [])
    .filter((row) => !["cancelled", "expired"].includes(cleanText(row.proforma_status).toLowerCase()))
    .reduce((sum, row) => sum + qty(row.billed_percent), 0);
  const next = money(existing + qty(newPercent));
  if (next > 100.0001) {
    const err = new Error("PROFORMA_PERCENT_EXCEEDED");
    err.code = "PROFORMA_PERCENT_EXCEEDED";
    err.status = 409;
    err.detail = `Cumulative billed percent would be ${next}% (max 100%).`;
    throw err;
  }
  return next;
}

module.exports = {
  money,
  qty,
  cleanText,
  calculateProformaLineAmounts,
  calculateProformaTotals,
  applyBilledPercent,
  assertMilestoneCoverage,
};
