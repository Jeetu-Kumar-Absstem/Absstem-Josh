/**
 * Assert locked Tax Invoice PDF layout contracts (no DB / Chromium required).
 *   node scripts/verify_invoice_pdf_locks.js
 *
 * Print set = 3 copies; each copy targets a single A4 page.
 * Page numbers only when a copy overflows (per-copy X of Y).
 */
const assert = require("assert");
const {
  getInvoicePdfMargins,
  INVOICE_PDF_MARGINS_LETTERHEAD,
  INVOICE_PDF_MARGINS_PLAIN,
  INVOICE_LETTERHEAD_CLEARANCE,
  INVOICE_LETTERHEAD_PAGE_TOP_PAD,
  INVOICE_COPY_LABELS,
  BRAND_TAGLINE,
  renderInvoiceHtml,
  buildTaxInvoicePdfBuffer,
} = require("../src/pdf/invoicePdf");
const { applyPdfBackground, countPdfPages, stampPdfPageNumbers } = require("../src/pdf/pdfCore");

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    process.stderr.write(`fail - ${name}\n${err?.stack || err}\n`);
    process.exitCode = 1;
  }
}

test("print set is Original / Duplicate / Triplicate", () => {
  assert.deepStrictEqual([...INVOICE_COPY_LABELS], [
    "Original for Recipient",
    "Duplicate for Transporter",
    "Triplicate for Supplier",
  ]);
  assert.strictEqual(typeof buildTaxInvoicePdfBuffer, "function");
});

test("letterhead clearance is compact 12mm (fit one page per copy)", () => {
  assert.deepStrictEqual(INVOICE_LETTERHEAD_CLEARANCE, {
    top: "12mm",
    right: "12mm",
    bottom: "12mm",
    left: "12mm",
  });
  assert.deepStrictEqual(getInvoicePdfMargins(true), INVOICE_LETTERHEAD_CLEARANCE);
  assert.deepStrictEqual(INVOICE_PDF_MARGINS_LETTERHEAD, getInvoicePdfMargins(true));
  assert.strictEqual(INVOICE_LETTERHEAD_PAGE_TOP_PAD, "10px");
});

test("plain margins locked", () => {
  assert.deepStrictEqual(getInvoicePdfMargins(false), INVOICE_PDF_MARGINS_PLAIN);
});

test("brand tagline is never drawn by invoice HTML", () => {
  assert.strictEqual(BRAND_TAGLINE, "REINVENTING PERFORMANCE");
  const html = renderInvoiceHtml({
    invoice: {
      invoice_number: "INV/TEST/1",
      invoice_status: "issued",
      invoice_date: "2026-08-07",
      grand_total_invoice: 118,
      invoice_currency_code: "INR",
    },
    lines: [],
    dispatch: null,
    sellerProfile: { company_name: "Absstem", gstin: "06AAWCA9492P1ZF", state_code: "06" },
    hasLetterhead: true,
    copyLabels: ["Original for Recipient"],
  });
  assert.ok(!html.includes(BRAND_TAGLINE));
  assert.ok(html.includes("Original for Recipient"));
  assert.ok(!html.includes("Duplicate for Transporter"));
});

test("letterhead HTML uses 12mm @page + single-copy render support", () => {
  const html = renderInvoiceHtml({
    invoice: {
      invoice_number: "INV/TEST/1",
      invoice_status: "issued",
      invoice_date: "2026-08-07",
      grand_total_invoice: 118,
      subtotal_invoice: 100,
      tax_total_invoice: 18,
      customer_name: "Test Customer",
      customer_state: "Haryana",
      invoice_currency_code: "INR",
    },
    lines: [
      {
        line_no: 1,
        item_code: "FG-1",
        item_name: "Finished Good",
        hsn_no: "8419",
        qty: 1,
        unit_price_invoice: 100,
        line_total_invoice: 100,
        gst_pct: 18,
        customer_item_code: "SAP-1001",
        customer_item_description: "Customer material",
      },
    ],
    dispatch: null,
    sellerProfile: {
      company_name: "Absstem Industrial Solutions Pvt. Ltd.",
      gstin: "06AAWCA9492P1ZF",
      state: "Haryana",
      state_code: "06",
      bank_name: "ICICI BANK LTD",
      bank_branch: "Kamla Nagar",
      account_name: "Absstem Industrial Solutions Private Limited",
      account_no: "663305601118",
      ifsc: "ICIC0006633",
      invoice_declaration: "We declare that this invoice shows the actual price of the goods described.",
    },
    hasLetterhead: true,
  });

  assert.ok(html.includes("@page { size: A4; margin: 12mm; }"));
  assert.ok(html.includes("padding-top: 10px"));
  assert.ok(html.includes("Original for Recipient"));
  assert.ok(html.includes("Duplicate for Transporter"));
  assert.ok(html.includes("Triplicate for Supplier"));
  assert.ok(html.includes("Amount Chargeable (in words)"));
  assert.ok(html.includes("Customer Part / SAP: SAP-1001"));
  assert.ok(html.includes("<th>HSN/SAC</th>"));
  assert.ok(!html.includes('class="company-name"'));
});

test("stampPdfPageNumbers can skip single-page copies", async () => {
  assert.strictEqual(typeof stampPdfPageNumbers, "function");
  assert.strictEqual(typeof countPdfPages, "function");
  const empty = Buffer.alloc(0);
  assert.strictEqual(await stampPdfPageNumbers(empty, { skipIfSinglePage: true }), empty);
});

test("applyPdfBackground is exported and no-ops on empty buffers", async () => {
  assert.strictEqual(typeof applyPdfBackground, "function");
  const empty = Buffer.alloc(0);
  const out = await applyPdfBackground(empty, Buffer.from("x"));
  assert.strictEqual(out, empty);
});

(async () => {
  try {
    await applyPdfBackground(Buffer.alloc(0), Buffer.from("x"));
    await stampPdfPageNumbers(Buffer.alloc(0), { skipIfSinglePage: true });
  } catch (err) {
    process.stderr.write(`${err?.stack || err}\n`);
    process.exitCode = 1;
  }
  if (!process.exitCode) process.stdout.write("All invoice PDF lock checks passed.\n");
})();
