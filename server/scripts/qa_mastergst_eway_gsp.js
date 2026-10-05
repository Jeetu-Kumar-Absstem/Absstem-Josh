/**
 * QA for Step 1 MasterGST e-way GSP adapter (mocked).
 * Run: node server/scripts/qa_mastergst_eway_gsp.js
 */

const assert = require("assert");
const path = require("path");

const {
  EinvoiceNotConfiguredError,
  generateEwayBill,
  cancelEwayBill,
  parseEwaySuccess,
  resolveBaseUrl,
  DEFAULT_SANDBOX_BASE,
} = require("../src/services/einvoice/gspAdapter");
const { buildEwayGeneratePayload, buildEwayCancelPayload } = require("../src/services/einvoice/ewayPayload");

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const mockClient = {
  query: async (sql, params) => {
    if (String(sql).includes("company_einvoice_settings")) {
      const companyId = Number(params?.[0]);
      if (companyId !== 1) return { rows: [] };
      return {
        rows: [
          {
            company_id: 1,
            provider: "mastergst",
            seller_gstin: "07AAAAA0000A1Z5",
            base_url: DEFAULT_SANDBOX_BASE,
            environment: "sandbox",
            is_enabled: true,
            credential_env_key: "MASTERGST_QA_MOCK",
          },
        ],
      };
    }
    return { rows: [] };
  },
};

async function main() {
  section("resolveBaseUrl defaults to sandbox");
  assert.strictEqual(
    resolveBaseUrl({ environment: "sandbox", base_url: null }),
    DEFAULT_SANDBOX_BASE
  );

  section("NOT_CONFIGURED when company settings missing");
  process.env.MASTERGST_QA_MOCK = JSON.stringify({ mock: true, email: "qa@absstem.com" });
  let threw = false;
  try {
    await generateEwayBill(mockClient, { companyId: 99, mode: "full", payload: { docNo: "X" } });
  } catch (err) {
    threw = true;
    assert.ok(err instanceof EinvoiceNotConfiguredError || err.code === "NOT_CONFIGURED");
    assert.strictEqual(err.status, 501);
  }
  assert.ok(threw, "expected NOT_CONFIGURED");

  section("buildEwayGeneratePayload prefers IRN");
  const irnBuilt = buildEwayGeneratePayload({
    invoice: { irn: "a".repeat(64), invoice_number: "INV1", invoice_date: "2026-08-01" },
    lines: [],
    sellerProfile: { gstin: "07AAAAA0000A1Z5", company_name: "Absstem", pincode: "110001", state_code: "07" },
    dispatch: { transport_mode: "road", vehicle_no: "DL01AB1234", approx_distance_km: 120, vehicle_type: "R" },
  });
  assert.strictEqual(irnBuilt.mode, "irn");
  assert.strictEqual(irnBuilt.payload.Irn.length, 64);

  section("buildEwayGeneratePayload full Part A/B");
  const fullBuilt = buildEwayGeneratePayload({
    invoice: {
      invoice_number: "INV/26-27/000001",
      invoice_date: "2026-08-01",
      customer_gstin: "29BBBBB0000B1Z5",
      customer_name: "Buyer",
      bill_to_name: "Buyer",
      grand_total_invoice: 118000,
    },
    lines: [
      {
        item_name: "PSA",
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
    },
    dispatch: {
      transport_mode: "road",
      vehicle_no: "DL01AB1234",
      vehicle_type: "R",
      approx_distance_km: 212,
      transporter_id: "07AAAAA0000A1Z5",
      transporter_name: "ABC",
      ship_to_gstin: "29BBBBB0000B1Z5",
      dispatch_from_pincode: "110001",
    },
  });
  assert.strictEqual(fullBuilt.mode, "full");
  assert.strictEqual(fullBuilt.payload.docNo, "INV/26-27/000001");
  assert.strictEqual(fullBuilt.payload.transMode, "1");
  assert.strictEqual(fullBuilt.payload.vehicleNo, "DL01AB1234");

  section("mock generate + cancel write-back shape");
  const gen = await generateEwayBill(mockClient, {
    companyId: 1,
    mode: fullBuilt.mode,
    payload: fullBuilt.payload,
  });
  assert.ok(gen.mocked);
  assert.ok(/^[0-9]{12}$/.test(String(gen.ewayBillNo)));
  assert.ok(gen.ewayBillDate);
  assert.ok(gen.validTill);
  assert.strictEqual(gen.provider, "mastergst");

  const parsed = parseEwaySuccess(gen.raw);
  assert.strictEqual(String(parsed.ewayBillNo), String(gen.ewayBillNo));

  const cancelPayload = buildEwayCancelPayload({ ewayBillNo: gen.ewayBillNo });
  const cancelled = await cancelEwayBill(mockClient, { companyId: 1, payload: cancelPayload });
  assert.ok(cancelled.mocked);
  assert.strictEqual(String(cancelled.ewayBillNo), String(gen.ewayBillNo));

  console.log("OK modules:", path.basename(__filename));
  console.log(`
Host checklist after migrate 149 + redeploy:
1) Admin Masters → GSP / E-Way: set provider=mastergst, sandbox URL, seller GSTIN, credential_env_key
2) Set env JSON with mock:true for QA, or real MasterGST sandbox credentials
3) Issued invoice → Generate via GSP → EBN write-back on invoice + dispatch
4) Cancel via GSP → trio cleared
5) Disable is_enabled → 501 NOT_CONFIGURED
`);
  console.log("\nAll qa_mastergst_eway_gsp assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
