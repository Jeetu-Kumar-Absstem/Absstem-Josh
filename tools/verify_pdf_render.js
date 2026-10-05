const { renderCoverAndTechnicalHtml, renderCommercialHtml, renderRevisionTermsHtml } = require("../server/src/pdf/quotePdf");

function must(cond, msg) {
  if (!cond) {
    process.stderr.write(`FAIL: ${msg}\n`);
    process.exit(1);
  }
}

const html = renderCoverAndTechnicalHtml({
  quote: {
    quote_number: "Q26000012",
    customer_name: "Standard Radiators Pvt. Ltd.",
    attention_to: "Sir",
    address_line1: "Addr1",
    city: "City",
  },
  revision: {
    revision_no: 1,
    revision_status: "draft",
    prepared_at: new Date().toISOString(),
    subtotal_quote: 10612000,
    tax_total_quote: 1910160,
    grand_total_quote: 12522160,
  },
  currencies: { quote_currency_code: "INR" },
  lines: [
    { scope_type: "included", item_code: "nGEN100UH", qty: 1, product_group_name: "Nitrogen Generator", product_description: "desc1" },
    { scope_type: "included", item_code: "AI-4000L", qty: 1, product_group_name: "Vessel", product_description: "desc2" },
    { scope_type: "included", item_code: "CO75F0520", qty: 1, product_group_name: "Compressor", product_description: "desc3" },
  ],
  salesUser: { full_name: "Amit", designation: "CEO", email: "a@b.com" },
  companyProfile: { company_name: "Absstem Industrial", website: "https://absstem.com" },
  executiveSummary: { highlights: ["Total: 999", "Deliverables: 2", "Custom bullet"] },
  scopeSummary: { exclusions: ["X"], assumptions: ["Y"], acceptance: ["Z"], responsibilities: ["Client: Provide power"] },
  configuratorContext: { family_key: "NGEN", family_name: "nGEN", variant_key: "UH", variant_label: "UH", presentation_company_code: "AI" },
});

const commercial = renderCommercialHtml({
  quote: { quote_number: "Q26000012", customer_name: "Standard Radiators Pvt. Ltd." },
  revision: { revision_status: "draft", subtotal_quote: 10612000, tax_total_quote: 1910160, grand_total_quote: 12522160 },
  lines: [
    { line_no: 1, item_code: "nGEN100UH", qty: 1, unit_price_quote: 7407000, line_total_quote: 7407000, gst_pct: 18, product_group_name: "Nitrogen Generator", line_description: "" },
  ],
  clubbed: false,
  configuratorContext: { family_key: "NGEN", family_name: "nGEN", variant_label: "UH" },
});

const terms = renderRevisionTermsHtml({
  quote: { quote_number: "Q26000012" },
  revision: { revision_status: "draft" },
  terms: [
    { is_selected: true, caption: "Payment Terms", description: "50% advance." },
    { is_selected: true, caption: "Delivery", description: "6-8 weeks." },
  ],
});

must(!html.includes("Configurator Context"), "No Configurator Context in customer PDF");
must(!html.includes("Proposal Family"), "No Proposal Family block on customer pages");
must(html.includes("Offered Package"), "Has Offered Package page");
must(html.includes("Primary Equipment"), "Has Primary Equipment section");
must(html.includes("Included Package Components"), "Has components section");
must(html.includes("Proposal Snapshot"), "Has executive snapshot");
must(html.includes("Custom bullet"), "Keeps custom user bullet");
must(!html.includes("Total: 999"), "Filters Total: from saved highlights");
must(!/oxygen\\s+and\\s+nitrogen/i.test(html), "No oxygen-and-nitrogen phrase for NGEN");
must(!commercial.includes("Commercial Context"), "No Commercial Context");
must(commercial.includes("Subtotal (excl. GST)"), "Commercial shows subtotal label");
must(terms.includes("<ol>") && terms.includes("Payment Terms"), "Terms uses ordered list");

process.stdout.write("OK\n");
