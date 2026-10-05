/**
 * QA for Step 3 MasterGST Part B vehicle update + Home cue field presence.
 * Run: node server/scripts/qa_mastergst_partb_vehicle.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const {
  EinvoiceNotConfiguredError,
  updateEwayVehicle,
  DEFAULT_SANDBOX_BASE,
} = require("../src/services/einvoice/gspAdapter");
const { buildEwayVehicleUpdatePayload } = require("../src/services/einvoice/ewayPayload");

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
  process.env.MASTERGST_QA_MOCK = JSON.stringify({ mock: true, email: "qa@absstem.com" });

  section("vehicle payload from dispatch");
  const payload = buildEwayVehicleUpdatePayload({
    dispatch: {
      eway_bill_no: "991012345678",
      vehicle_no: "DL01AB9999",
      transport_mode: "road",
      vehicle_type: "R",
      approx_distance_km: 150,
      transporter_id: "07AAAAA0000A1Z5",
      lr_no: "LR-1",
      lr_date: "2026-08-01",
      dispatch_from_pincode: "110001",
    },
    reasonCode: "1",
    remark: "Truck changed",
  });
  assert.strictEqual(String(payload.ewbNo), "991012345678");
  assert.strictEqual(payload.vehicleNo, "DL01AB9999");
  assert.strictEqual(payload.transMode, "1");

  section("NOT_CONFIGURED when disabled");
  let threw = false;
  try {
    await updateEwayVehicle(mockClient, { companyId: 99, payload });
  } catch (err) {
    threw = true;
    assert.ok(err instanceof EinvoiceNotConfiguredError || err.code === "NOT_CONFIGURED");
  }
  assert.ok(threw);

  section("mock VEHEWB write-back");
  const updated = await updateEwayVehicle(mockClient, { companyId: 1, payload });
  assert.ok(updated.mocked);
  assert.strictEqual(String(updated.ewayBillNo), "991012345678");
  assert.ok(updated.validTill);

  section("Home My Day surfaces eway_warning / eway_expired");
  const homeSrc = fs.readFileSync(
    path.join(__dirname, "../../client/src/home/buildMyDayItems.js"),
    "utf8"
  );
  assert.ok(homeSrc.includes("eway_warning"));
  assert.ok(homeSrc.includes("eway_expired"));

  console.log("OK modules:", path.basename(__filename));
  console.log("\nAll qa_mastergst_partb_vehicle assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
