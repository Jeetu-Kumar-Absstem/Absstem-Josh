#!/usr/bin/env node
/**
 * Offline assertions for Tally sales invoice amount computation (no DB).
 *   node scripts/qa_tally_invoice_amount_math.js
 */
const assert = require("assert");
const {
  buildInvoiceLinesFromTallyVoucher,
  computeTallySalesInvoiceTotals,
} = require("../src/services/tallyEngine");

function check(label, raw, expectedGrand, expectedSubtotal = null) {
  const lines = buildInvoiceLinesFromTallyVoucher(raw);
  const totals = computeTallySalesInvoiceTotals(raw, lines);
  assert.strictEqual(
    totals.grandTotal,
    expectedGrand,
    `${label}: grand ${totals.grandTotal} !== ${expectedGrand}`
  );
  if (expectedSubtotal != null) {
    assert.strictEqual(
      totals.subtotal,
      expectedSubtotal,
      `${label}: subtotal ${totals.subtotal} !== ${expectedSubtotal}`
    );
  }
  console.log(`OK  ${label} → grand=${totals.grandTotal} subtotal=${totals.subtotal} tax=${totals.computedTax}`);
}

// Case A: empty inventory service voucher (Ritika INV-AI/26-27/046 pattern)
check(
  "service voucher no inventory",
  {
    amount: 8850,
    party_name: "KARAM-HANS",
    narration: "Service",
    inventory_entries: [],
    entries: [
      { ledger_name: "KARAM-HANS", amount: 8850 },
      { ledger_name: "Service Charge", amount: 7500 },
      { ledger_name: "Output IGST", amount: 1350 },
    ],
  },
  8850,
  7500
);

// Case B: inventory + freight gap previously understated
check(
  "inventory plus freight",
  {
    amount: 11800,
    party_name: "ACME",
    inventory_entries: [{ stock_item_name: "Widget", qty: "1 Nos", amount: 10000, rate: 10000, gst_pct: 18 }],
    entries: [
      { ledger_name: "ACME", amount: 11800 },
      { ledger_name: "Sales", amount: 10000 },
      { ledger_name: "Freight Charges", amount: 0 }, // named but zero ignored
      { ledger_name: "Output IGST", amount: 1800 },
    ],
  },
  11800,
  10000
);

// Case C: inventory + explicit freight ledger (Tally higher / Josh used to miss freight)
check(
  "inventory with freight ledger",
  {
    amount: 12060,
    party_name: "ACME",
    inventory_entries: [{ stock_item_name: "Widget", qty: "1 Nos", amount: 10000, rate: 10000, gst_pct: 18 }],
    entries: [
      { ledger_name: "ACME", amount: 12060 },
      { ledger_name: "Sales Account", amount: 10000 },
      { ledger_name: "Freight", amount: 1000 },
      { ledger_name: "Output CGST", amount: 530 },
      { ledger_name: "Output SGST", amount: 530 },
    ],
  },
  12060,
  11000
);

// Case D: must not double-count Sales ledger on top of inventory
{
  const raw = {
    amount: 11800,
    party_name: "ACME",
    inventory_entries: [{ stock_item_name: "Widget", qty: "1 Nos", amount: 10000, rate: 10000 }],
    entries: [
      { ledger_name: "ACME", amount: 11800 },
      { ledger_name: "Sales", amount: 10000 },
      { ledger_name: "Output IGST", amount: 1800 },
    ],
  };
  const lines = buildInvoiceLinesFromTallyVoucher(raw);
  assert.ok(
    !lines.some((l) => String(l.item_name || "").toLowerCase() === "sales"),
    "Sales ledger must not become an extra line when inventory exists"
  );
  const totals = computeTallySalesInvoiceTotals(raw, lines);
  assert.strictEqual(totals.grandTotal, 11800);
  console.log("OK  inventory does not add Sales ledger line");
}

console.log("\nAll tally invoice amount math checks passed.");
