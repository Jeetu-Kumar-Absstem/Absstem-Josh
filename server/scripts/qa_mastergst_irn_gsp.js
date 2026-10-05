/**
 * QA for Step 2 MasterGST IRN generate/cancel (mocked).
 * Run: node server/scripts/qa_mastergst_irn_gsp.js
 */

const assert = require("assert");
const path = require("path");

const {
  EinvoiceNotConfiguredError,
  generateIrn,
  cancelIrn,
  parseIrnSuccess,
  DEFAULT_SANDBOX_BASE,
} = require("../src/services/einvoice/gspAdapter");
const { clearIrnMetadata } = require("../src/services/einvoice");

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const mockClient = {
  query: async (sql, params) => {
    const text = String(sql);
    if (text.includes("company_einvoice_settings")) {
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
    if (text.includes("from customer_invoices") && text.includes("einvoice_status")) {
      return {
        rows: [
          {
            id: 42,
            company_id: 1,
            invoice_number: "INV/26-27/000099",
            invoice_status: "issued",
            irn: "a".repeat(64),
            einvoice_status: "generated",
          },
        ],
      };
    }
    if (text.includes("update customer_invoices") && text.includes("einvoice_status = 'cancelled'")) {
      return {
        rows: [
          {
            id: 42,
            company_id: 1,
            irn: null,
            eway_bill_no: "991012345678",
            eway_bill_date: "2026-08-01",
            eway_valid_till: "2026-08-02T12:00:00Z",
            einvoice_status: "cancelled",
          },
        ],
      };
    }
    if (text.includes("insert into einvoice_events")) {
      return { rows: [] };
    }
    return { rows: [] };
  },
};

async function main() {
  process.env.MASTERGST_QA_MOCK = JSON.stringify({ mock: true, email: "qa@absstem.com" });

  section("NOT_CONFIGURED when settings missing");
  let threw = false;
  try {
    await generateIrn(mockClient, { companyId: 99, payload: { Version: "1.1" } });
  } catch (err) {
    threw = true;
    assert.ok(err instanceof EinvoiceNotConfiguredError || err.code === "NOT_CONFIGURED");
    assert.strictEqual(err.status, 501);
  }
  assert.ok(threw, "expected NOT_CONFIGURED");

  section("mock generate IRN shape");
  const gen = await generateIrn(mockClient, {
    companyId: 1,
    payload: {
      Version: "1.1",
      DocDtls: { Typ: "INV", No: "INV/26-27/000099", Dt: "01/08/2026" },
    },
  });
  assert.ok(gen.mocked);
  assert.ok(gen.irn && gen.irn.length === 64);
  assert.ok(gen.ackNo);
  assert.ok(gen.signedQr);
  assert.strictEqual(gen.provider, "mastergst");

  const parsed = parseIrnSuccess(gen.raw);
  assert.strictEqual(parsed.irn, gen.irn);

  section("mock cancel IRN");
  const cancelled = await cancelIrn(mockClient, {
    companyId: 1,
    payload: { Irn: gen.irn, CnlRsn: "1", CnlRem: "QA cancel" },
  });
  assert.ok(cancelled.mocked);
  assert.strictEqual(cancelled.irn, gen.irn);

  section("clearIrnMetadata leaves e-way intact (D2)");
  const cleared = await clearIrnMetadata(mockClient, {
    invoiceId: 42,
    companyId: 1,
    reason: "QA cancel",
    userId: 1,
  });
  assert.strictEqual(cleared.irn, null);
  assert.strictEqual(cleared.eway_bill_no, "991012345678");
  assert.ok(cleared.eway_bill_date);
  assert.ok(cleared.eway_valid_till);

  console.log("OK modules:", path.basename(__filename));
  console.log("\nAll qa_mastergst_irn_gsp assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
