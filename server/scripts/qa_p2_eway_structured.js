/**
 * Local QA assertions for P2 e-way structured capture.
 * Run: node server/scripts/qa_p2_eway_structured.js
 */

const assert = require("assert");
const path = require("path");

const eway = require("../src/services/ewayCompliance");
const { buildEinvoicePayload, buildEwbDtls } = require("../src/services/einvoice/einvoicePayload");

function section(title) {
  console.log(`\n=== ${title} ===`);
}

section("normalizeTransportMode");
assert.strictEqual(eway.normalizeTransportMode("road"), "road");
assert.strictEqual(eway.normalizeTransportMode("Road"), "road");
assert.strictEqual(eway.normalizeTransportMode(1), "road");
assert.strictEqual(eway.normalizeTransportMode("1"), "road");
assert.strictEqual(eway.normalizeTransportMode("truck"), null);
assert.strictEqual(eway.toNicTransMode("ship"), "4");

section("computeConsignmentValue");
assert.deepStrictEqual(
  eway.computeConsignmentValue({
    invoiceGrandTotalBase: 184500,
    salesOrderGrandTotalBase: 200000,
    qtyDispatched: 1,
    qtyOrdered: 2,
  }),
  { value: 184500, basis: "invoice" }
);
assert.deepStrictEqual(
  eway.computeConsignmentValue({
    invoiceGrandTotalBase: undefined,
    salesOrderGrandTotalBase: 200000,
    qtyDispatched: 1,
    qtyOrdered: 2,
  }),
  { value: 100000, basis: "sales_order_prorated" }
);

section("evaluateEwayCompliance soft blocking");
const below = eway.evaluateEwayCompliance({
  dispatch: { dispatch_status: "ready" },
  consignmentValue: 49999,
  consignmentValueBasis: "sales_order",
  isInterstate: true,
});
assert.strictEqual(below.eway_required, false);
assert.strictEqual(below.severity, "none");
assert.strictEqual(below.blocking, false);

const atThreshold = eway.evaluateEwayCompliance({
  dispatch: { dispatch_status: "ready", transport_mode: "road", vehicle_no: "DL01AB1234" },
  consignmentValue: 50000,
  consignmentValueBasis: "sales_order",
  isInterstate: true,
});
assert.strictEqual(atThreshold.eway_required, true);
assert.strictEqual(atThreshold.blocking, false);
assert.ok(atThreshold.warnings.some((w) => w.code === "EWAY_BILL_NO_MISSING"));

const roadPartial = eway.evaluateEwayCompliance({
  dispatch: {
    dispatch_status: "dispatched",
    eway_bill_no: "123456789012",
    eway_bill_date: "2026-08-01",
    transporter_name: "ABC Logistics",
    transporter_id: "07AAAAA0000A1Z5",
    transport_mode: "road",
    vehicle_no: "DL01AB1234",
    approx_distance_km: 212,
    ship_to_gstin: "29AAAAA0000A1Z5",
    dispatch_from_pincode: "110001",
  },
  consignmentValue: 200000,
  consignmentValueBasis: "invoice",
  isInterstate: true,
});
assert.strictEqual(roadPartial.part_b_ready, true);
assert.ok(roadPartial.warnings.some((w) => w.code === "VEHICLE_TYPE_MISSING"));
assert.strictEqual(roadPartial.blocking, false);

const railOk = eway.evaluateEwayCompliance({
  dispatch: {
    dispatch_status: "dispatched",
    eway_bill_no: "123456789012",
    eway_bill_date: "2026-08-01",
    transporter_name: "Rail Cargo",
    transporter_id: "07AAAAA0000A1Z5",
    transport_mode: "rail",
    lr_no: "RR123",
    lr_date: "2026-08-01",
    approx_distance_km: 400,
    ship_to_gstin: "29AAAAA0000A1Z5",
    dispatch_from_pincode: "110001",
  },
  consignmentValue: 200000,
  consignmentValueBasis: "invoice",
  isInterstate: true,
});
assert.strictEqual(railOk.part_b_ready, true);
assert.ok(!railOk.warnings.some((w) => w.code === "VEHICLE_NO_MISSING"));

section("buildEinvoicePayload EwbDtls / ShipDtls");
const fullDispatch = {
  transporter_name: "ABC Logistics",
  transporter_id: "07AAAAA0000A1Z5",
  transport_mode: "road",
  vehicle_no: "DL01AB1234",
  vehicle_type: "R",
  approx_distance_km: 212,
  lr_no: "LR9",
  lr_date: "2026-08-01",
  ship_to_gstin: "29BBBBB0000B1Z5",
  ship_to_name: "Plant Site",
  ship_to_address: "Plot 1, Pune 411001",
  dispatch_from_pincode: "122001",
};
const ewb = buildEwbDtls(fullDispatch);
assert.strictEqual(ewb.TransMode, "1");
assert.strictEqual(ewb.VehType, "R");
assert.strictEqual(ewb.Distance, 212);

const payload = buildEinvoicePayload({
  invoice: {
    invoice_number: "INV/26-27/000001",
    invoice_date: "2026-08-01",
    customer_gstin: "07AAAAA0000A1Z5",
    customer_name: "Buyer Co",
    bill_to_name: "Buyer Co",
    grand_total_invoice: 118000,
  },
  lines: [
    {
      line_no: 1,
      item_name: "PSA Plant",
      hsn_no: "84196000",
      qty: 1,
      unit_price_invoice: 100000,
      line_total_invoice: 100000,
      gst_pct: 18,
    },
  ],
  sellerProfile: {
    gstin: "07AAAAA0000A1Z5",
    company_name: "Absstem",
    address_line1: "Delhi",
    city: "New Delhi",
    pincode: "110001",
    state_code: "07",
    state: "Delhi",
  },
  dispatch: fullDispatch,
  buyer: null,
});
assert.ok(payload.EwbDtls);
assert.strictEqual(payload.EwbDtls.TransMode, "1");
assert.ok(payload.ShipDtls);
assert.strictEqual(payload.ShipDtls.Gstin, "29BBBBB0000B1Z5");

const emptyPayload = buildEinvoicePayload({
  invoice: {
    invoice_number: "INV/26-27/000002",
    invoice_date: "2026-08-01",
    customer_gstin: "07AAAAA0000A1Z5",
    customer_name: "Buyer Co",
    grand_total_invoice: 1000,
  },
  lines: [],
  sellerProfile: { gstin: "07AAAAA0000A1Z5", company_name: "Absstem", state_code: "07", pincode: "110001" },
  dispatch: {},
  buyer: null,
});
assert.strictEqual(emptyPayload.EwbDtls, undefined);

section("module loads");
require("../src/routes/dispatches");
require("../src/routes/invoices");
require("../src/pdf/dispatchPdf");
require("../src/pdf/invoicePdf");
console.log("OK modules:", path.basename(__filename));

console.log(`
Host checklist after migrate 148 + redeploy:
1) Mark a ₹2L+ dispatch Ready with incomplete e-way → HTTP 200 + eway.severity=warning
2) Fill Part A/B → warning clears; eway_ref mirrors eway_bill_no
3) Confirm linked invoice trio synced (unless desk-overridden)
4) Save then clear IRN → e-way trio survives
5) Download NIC JSON → EwbDtls populated; regenerate invoice + challan PDFs
`);

console.log("\nAll qa_p2_eway_structured assertions passed.");
