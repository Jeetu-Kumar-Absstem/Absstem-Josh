#!/usr/bin/env node
/**
 * P1 smoke checks that can run without a live DB session:
 * - AR isolation
 * - Module load of proforma / einvoice / tally / qrcode
 * - applyBilledPercent does not double-scale
 */
const path = require("path");
const { spawnSync } = require("child_process");

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("OK:", msg);
}

const root = path.resolve(__dirname, "..");

const iso = spawnSync(process.execPath, [path.join(__dirname, "verify_ar_isolation.js")], { encoding: "utf8" });
assert(iso.status === 0, `AR isolation (${iso.stdout.trim() || iso.stderr.trim()})`);

const { applyBilledPercent, calculateProformaTotals } = require("../src/services/proformaMath");
const lines = applyBilledPercent(
  [
    { id: 1, line_no: 1, qty: 2, unit_price_base: 100, unit_price_order: 100, gst_pct: 18 },
    { id: 2, line_no: 2, qty: 1, unit_price_base: 50, unit_price_order: 50, gst_pct: 18 },
  ],
  50
);
assert(lines[0].qty === 2, "milestone keeps full qty");
assert(Math.abs(lines[0].unit_price_proforma - 50) < 0.011, "milestone scales unit price only");
const totals = calculateProformaTotals(lines);
const expectedTaxable = 125; // (2*100 + 1*50) * 0.5
assert(Math.abs(totals.subtotal_proforma - expectedTaxable) < 0.05, `Σ PI taxable ≈ ${expectedTaxable} got ${totals.subtotal_proforma}`);

require("../src/pdf/qrCode");
require("../src/services/einvoice");
require("../src/services/einvoice/einvoicePayload");
require("../src/services/einvoice/gspAdapter");
require("../src/services/tally/tallyXml");
require("../src/services/tally/ledgerMap");
require("../src/services/tally/salesVoucher");
require("../src/services/tally/receiptVoucher");
require("../src/routes/proformaInvoices");
require("../src/routes/tallyExport");
assert(true, "P1 modules load");

console.log("\nqa_p1_proforma_einvoice_tally: local checks passed.");
console.log("On host after migrate/deploy, also exercise:");
console.log("  - POST /proforma-invoices/from-sales-order/:id");
console.log("  - POST /proforma-invoices/:id/convert-to-invoice");
console.log("  - GET/POST/DELETE /invoices/:id/einvoice/*");
console.log("  - GET /tally-export/preview + /xml");
