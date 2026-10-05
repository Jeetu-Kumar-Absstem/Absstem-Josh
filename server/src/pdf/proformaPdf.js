/**
 * Proforma Invoice PDF (P1a) — adapted from invoicePdf.js's Tax Invoice layout, but:
 *   - Single page / single copy (no Original/Duplicate/Triplicate set)
 *   - Title "PROFORMA INVOICE"
 *   - No IRN/QR e-invoice block (proforma is never e-invoiced)
 *   - Shows Valid Till, Billing Basis, Billed % and milestone name (when applicable)
 *   - Footer carries a mandatory GST-exclusion disclaimer
 *   - Watermarks DRAFT / CANCELLED for those statuses only
 *
 * Letterhead clearance is reused as-is from invoicePdf.js (12mm) so proforma and tax
 * invoice PDFs sit identically inside the same digital letterhead.
 * Shared brand CSS from pdfStyles.js; number/words helpers from formatters.js.
 */

const { INVOICE_LETTERHEAD_CLEARANCE, INVOICE_PDF_MARGINS_PLAIN } = require("./invoicePdf");
const {
  escapeHtml,
  num,
  cleanText,
  fmtMoney,
  fmtQty,
  fmtDate,
  deriveStateCode,
  normalizeStateName,
  joinAddressLines,
  amountToWords,
} = require("./formatters");
const { baseDocumentStyles } = require("./pdfStyles");

const PROFORMA_LETTERHEAD_PAGE_TOP_PAD = "10px";

const PROFORMA_FOOTER_DISCLAIMER =
  "This is a Proforma Invoice for advance payment purposes only. It is not a Tax Invoice and does not constitute a supply under GST.";

function inferTaxMode(sellerProfile, proforma) {
  const sellerStateCode = cleanText(sellerProfile.state_code);
  const buyerStateCode =
    deriveStateCode(proforma.customer_gstin) || cleanText(proforma.customer_state_code) || deriveStateCode(proforma.customer_state_code);
  if (sellerStateCode && buyerStateCode) {
    return sellerStateCode === buyerStateCode ? "intra" : "inter";
  }
  const sellerState = normalizeStateName(sellerProfile.state);
  const buyerState = normalizeStateName(proforma.customer_state);
  if (sellerState && buyerState && sellerState === buyerState) return "intra";
  return "inter";
}

function billingBasisLabel(basis) {
  const key = cleanText(basis).toLowerCase();
  if (key === "milestone") return "Milestone";
  if (key === "qty") return "Quantity";
  if (key === "adhoc") return "Ad-hoc";
  return key ? key : "—";
}

function statusWatermark(status) {
  const value = cleanText(status).toLowerCase();
  if (value === "draft") return "DRAFT";
  if (value === "cancelled") return "CANCELLED";
  return "";
}

function getProformaPdfMargins(hasLetterhead = false) {
  return hasLetterhead ? { ...INVOICE_LETTERHEAD_CLEARANCE } : { ...INVOICE_PDF_MARGINS_PLAIN };
}

function renderProformaHtml({ proforma, lines, sellerProfile, hasLetterhead = false }) {
  const letterheadMode = Boolean(hasLetterhead);
  const currencyCode = cleanText(proforma.proforma_currency_code) || "INR";
  const watermark = statusWatermark(proforma.proforma_status);
  const logoDataUrl = cleanText(sellerProfile.logo_data_url);
  const signatureDataUrl = cleanText(sellerProfile.signature_data_url);
  const sellerAddressLines = joinAddressLines([
    sellerProfile.address_line1,
    sellerProfile.address_line2,
    sellerProfile.address_line3,
    [sellerProfile.city, sellerProfile.state, sellerProfile.pincode].filter(Boolean).join(" - "),
    sellerProfile.country,
  ]);
  const buyerAddressLines = joinAddressLines(
    cleanText(proforma.bill_to_address)
      ? String(proforma.bill_to_address)
          .split(/\r?\n/)
          .flatMap((part) => String(part).split(/,\s*(?=[A-Za-z0-9])/))
          .map((part) => cleanText(part))
      : [
          proforma.address_line1,
          proforma.address_line2,
          proforma.address_line3,
          [proforma.customer_city, proforma.customer_state, proforma.customer_pincode].filter(Boolean).join(" - "),
        ]
  );
  const taxMode = inferTaxMode(sellerProfile, proforma);
  const lineItems = Array.isArray(lines) ? lines : [];

  const computedLines = lineItems
    .filter((line) => !cleanText(line.charge_kind))
    .map((line) => {
      const taxableValue = num(line.line_total_proforma);
      const gstPct = num(line.gst_pct);
      const gstAmount = Number(((taxableValue * gstPct) / 100).toFixed(2));
      const cgstPct = taxMode === "intra" ? gstPct / 2 : 0;
      const sgstPct = taxMode === "intra" ? gstPct / 2 : 0;
      const igstPct = taxMode === "inter" ? gstPct : 0;
      const cgstAmount = taxMode === "intra" ? Number((gstAmount / 2).toFixed(2)) : 0;
      const sgstAmount = taxMode === "intra" ? Number((gstAmount / 2).toFixed(2)) : 0;
      const igstAmount = taxMode === "inter" ? gstAmount : 0;
      return {
        ...line,
        description: cleanText(line.product_group_name) || cleanText(line.item_name) || cleanText(line.line_description),
        taxableValue,
        gstPct,
        gstAmount,
        cgstPct,
        sgstPct,
        igstPct,
        cgstAmount,
        sgstAmount,
        igstAmount,
        grossLineTotal: Number((taxableValue + gstAmount).toFixed(2)),
      };
    });

  const totalTaxable = computedLines.reduce((sum, line) => sum + line.taxableValue, 0);
  const totalTax = computedLines.reduce((sum, line) => sum + line.gstAmount, 0);
  const grandTotal = num(proforma.grand_total_proforma) || Number((totalTaxable + totalTax).toFixed(2));

  const summaryMap = new Map();
  for (const line of computedLines) {
    const hsn = cleanText(line.hsn_no) || "—";
    const key = `${hsn}|${line.gstPct.toFixed(2)}`;
    if (!summaryMap.has(key)) {
      summaryMap.set(key, { hsn, gstPct: line.gstPct, taxableValue: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, taxAmount: 0 });
    }
    const row = summaryMap.get(key);
    row.taxableValue += line.taxableValue;
    row.cgstAmount += line.cgstAmount;
    row.sgstAmount += line.sgstAmount;
    row.igstAmount += line.igstAmount;
    row.taxAmount += line.gstAmount;
  }
  const summaryRows = Array.from(summaryMap.values()).sort((a, b) => {
    const hsnCmp = String(a.hsn).localeCompare(String(b.hsn), undefined, { numeric: true, sensitivity: "base" });
    if (hsnCmp !== 0) return hsnCmp;
    return a.gstPct - b.gstPct;
  });

  const amountInWords = amountToWords(grandTotal, currencyCode);
  const customerPoNumber = cleanText(proforma.customer_po_number);
  const customerPoDate = proforma.customer_po_date || null;
  const milestoneName = cleanText(proforma.milestone_name);
  const billedPercent = proforma.billed_percent !== null && proforma.billed_percent !== undefined ? num(proforma.billed_percent) : null;

  const bankFields = [
    { label: "Bank", value: sellerProfile.bank_name },
    { label: "Branch", value: sellerProfile.bank_branch },
    { label: "A/c Name", value: sellerProfile.account_name || sellerProfile.company_name },
    { label: "A/c No", value: sellerProfile.account_no },
    { label: "IFSC", value: sellerProfile.ifsc },
  ].filter((item) => cleanText(item.value));

  const companyCell = letterheadMode
    ? `<div class="small">
         ${sellerProfile.gstin ? `<div class="meta-line"><strong>GSTIN/UIN:</strong> ${escapeHtml(sellerProfile.gstin)}</div>` : ""}
         ${sellerProfile.pan ? `<div class="meta-line"><strong>PAN:</strong> ${escapeHtml(sellerProfile.pan)}</div>` : ""}
       </div>`
    : `${logoDataUrl ? `<div style="margin-bottom:6px;"><img src="${escapeHtml(logoDataUrl)}" alt="Company Logo" style="max-width:150px; max-height:52px;" /></div>` : ""}
       <div class="company-name">${escapeHtml(sellerProfile.company_name)}</div>
       <div class="small">${sellerAddressLines.map((line) => `<div class="meta-line">${escapeHtml(line)}</div>`).join("")}</div>
       <div class="small" style="margin-top:4px;">
         ${sellerProfile.gstin ? `<div class="meta-line">GSTIN/UIN: ${escapeHtml(sellerProfile.gstin)}</div>` : ""}
         ${sellerProfile.pan ? `<div class="meta-line">PAN: ${escapeHtml(sellerProfile.pan)}</div>` : ""}
         ${sellerProfile.contact_name ? `<div class="meta-line">Contact: ${escapeHtml(sellerProfile.contact_name)}</div>` : ""}
         ${sellerProfile.contact_email ? `<div class="meta-line">Email: ${escapeHtml(sellerProfile.contact_email)}</div>` : ""}
       </div>`;

  const itemRows = computedLines
    .map((line) => {
      const customerPartCode = cleanText(line.customer_item_code);
      const customerPartDesc = cleanText(line.customer_item_description);
      const itemCode = cleanText(line.item_code);
      const desc = cleanText(line.description) || cleanText(line.item_name) || cleanText(line.line_description);
      return `
        <tr>
          <td class="align-center">${escapeHtml(line.line_no)}</td>
          <td><span class="item-primary">${escapeHtml(itemCode || desc || "—")}</span></td>
          <td>
            <span class="item-primary">${escapeHtml(desc || itemCode || "—")}</span>
            ${customerPartCode ? `<span class="item-secondary">Customer Part / SAP: ${escapeHtml(customerPartCode)}</span>` : ""}
            ${customerPartDesc ? `<span class="item-secondary">${escapeHtml(customerPartDesc)}</span>` : ""}
          </td>
          <td class="align-center">${escapeHtml(line.hsn_no || "")}</td>
          <td class="align-right">${fmtQty(line.qty)}</td>
          <td class="align-right">${fmtMoney(line.unit_price_proforma)}</td>
          <td class="align-right">${fmtMoney(line.taxableValue)}</td>
          <td class="align-right">${fmtMoney(line.gstPct)}</td>
          <td class="align-right">${fmtMoney(line.gstAmount)}</td>
          <td class="align-right">${fmtMoney(line.grossLineTotal)}</td>
        </tr>
      `;
    })
    .join("");

  const taxRows = summaryRows
    .map(
      (row) => `
        <tr>
          <td class="align-center">${escapeHtml(row.hsn)}</td>
          <td class="align-center">${fmtMoney(row.gstPct)}</td>
          <td class="align-right">${fmtMoney(row.taxableValue)}</td>
          <td class="align-right">${fmtMoney(row.cgstAmount)}</td>
          <td class="align-right">${fmtMoney(row.sgstAmount)}</td>
          <td class="align-right">${fmtMoney(row.igstAmount)}</td>
          <td class="align-right">${fmtMoney(row.taxAmount)}</td>
        </tr>
      `
    )
    .join("");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(proforma.proforma_number || "Proforma Invoice")}</title>
      <style>
        ${baseDocumentStyles({
          letterheadMode,
          pageTopPad: PROFORMA_LETTERHEAD_PAGE_TOP_PAD,
          pageMargin: letterheadMode ? "12mm" : "0",
          fontSize: "9.5px",
          lineHeight: "1.3",
        })}
        .page {
          break-after: auto;
          page-break-after: auto;
        }
        .sheet {
          border: 1px solid var(--pdf-border-strong);
          overflow: hidden;
          background: ${letterheadMode ? "transparent" : "#fff"};
        }
        .copy-band {
          border-bottom: 1px solid var(--pdf-primary);
          text-align: center;
          font-size: 9px;
          font-weight: 700;
          padding: 2px 6px;
          letter-spacing: 0.4px;
          color: var(--pdf-primary);
          text-transform: uppercase;
        }
        table.layout { width: 100%; border-collapse: collapse; table-layout: fixed; }
        table.layout > tr > td, table.layout > tbody > tr > td,
        table.layout > thead > tr > th, table.layout > tr > th {
          vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere; white-space: normal;
        }
        .title-row > tr > td, .title-row > tbody > tr > td {
          border-bottom: 1.5px solid var(--pdf-primary);
          padding: 4px 6px;
        }
        .title-row > tr > td + td, .title-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .company-box { width: 52%; }
        .doc-box { width: 48%; }
        .party-row > tr > td, .party-row > tbody > tr > td {
          width: 50%;
          border-bottom: 1px solid var(--pdf-border-strong);
          padding: 4px 6px;
          background: var(--pdf-surface);
        }
        .party-row > tr > td + td, .party-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .meta-row > tr > td, .meta-row > tbody > tr > td {
          width: 50%;
          border-bottom: 1px solid var(--pdf-border-strong);
          padding: 4px 6px;
          background: var(--pdf-surface);
        }
        .meta-row > tr > td + td, .meta-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .lines-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .lines-table th, .lines-table td {
          border-right: 1px solid var(--pdf-border-strong);
          border-bottom: 1px solid var(--pdf-border-strong);
          padding: 3px 4px;
          vertical-align: top;
          font-size: 9px;
          line-height: 1.25;
        }
        .lines-table th:last-child, .lines-table td:last-child { border-right: none; }
        .lines-table thead th {
          text-align: center;
          font-weight: 700;
          background: var(--pdf-primary);
          color: #fff;
          border-color: var(--pdf-primary);
          text-transform: uppercase;
          letter-spacing: 0.3px;
          font-size: 8.5px;
        }
        .lines-table tbody tr:nth-child(even) { background-color: var(--pdf-surface-alt); }
        .summary-row > tr > td, .summary-row > tbody > tr > td {
          border-bottom: 1px solid var(--pdf-border-strong);
          padding: 4px 6px;
          vertical-align: top;
        }
        .summary-row > tr > td + td, .summary-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .summary-words {
          margin-top: 4px;
          font-size: 9px;
          line-height: 1.3;
          background: var(--pdf-surface-alt);
          padding: 4px 6px;
          border: 1px solid var(--pdf-border);
        }
        .summary-words div { margin: 0 0 2px; color: var(--pdf-muted); }
        .tax-table { width: 100%; border-collapse: collapse; margin-top: 2px; }
        .tax-table th, .tax-table td { border: 1px solid var(--pdf-border-strong); padding: 2px 3px; font-size: 9px; }
        .tax-table th { background: var(--pdf-surface); color: var(--pdf-neutral); text-align: center; font-weight: 700; }
        .totals-table { width: 100%; border-collapse: collapse; }
        .totals-table td { padding: 1px 0; font-size: 9.5px; border: none; color: var(--pdf-muted); }
        .totals-table tr:last-child td { color: var(--pdf-primary); font-weight: 700; }
        .footer-row > tr > td, .footer-row > tbody > tr > td { padding: 4px 6px; vertical-align: top; }
        .footer-row > tr > td + td, .footer-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .bank-table { width: 100%; border-collapse: collapse; margin-bottom: 4px; table-layout: fixed; }
        .bank-table td { padding: 0; font-size: 9px; line-height: 1.3; vertical-align: top; border: none !important; }
        .bank-table td.label { width: 68px; font-weight: 700; white-space: nowrap; padding-right: 6px; color: var(--pdf-muted); }
        .bank-table td.value { padding-left: 6px; word-break: break-word; color: var(--pdf-neutral); }
        .declaration { margin-top: 3px; font-size: 8.5px; line-height: 1.35; clear: both; font-weight: 700; color: var(--pdf-neutral); }
        .signature-block { text-align: right; min-height: 48px; }
        .signature-block .for-line { font-weight: 700; margin-bottom: 18px; color: var(--pdf-muted); }
        .signature-block .sign-line { font-weight: 700; color: var(--pdf-neutral); }
        .remark-bar { border-top: 1px solid var(--pdf-border-strong); padding: 2px 6px; font-size: 8.5px; min-height: 12px; color: var(--pdf-muted); }
        .sheet > * { position: relative; z-index: 1; }
      </style>
    </head>
    <body>
      <div class="page">
        ${watermark ? `<div class="watermark">${escapeHtml(watermark)}</div>` : ""}
        <div class="sheet">
          <div class="copy-band">PROFORMA — NOT A TAX INVOICE</div>
          <table class="layout title-row">
            <tr>
              <td class="company-box">${companyCell}</td>
              <td class="doc-box">
                <div class="doc-title">PROFORMA INVOICE</div>
                <div class="meta-line"><strong>Proforma No:</strong> ${escapeHtml(proforma.proforma_number || "")}</div>
                <div class="meta-line"><strong>Proforma Date:</strong> ${escapeHtml(fmtDate(proforma.proforma_date))}</div>
                <div class="meta-line"><strong>Valid Till:</strong> ${escapeHtml(proforma.valid_till ? fmtDate(proforma.valid_till) : "—")}</div>
                <div class="meta-line"><strong>Billing Basis:</strong> ${escapeHtml(billingBasisLabel(proforma.billing_basis))}${
                  billedPercent !== null ? ` (${fmtMoney(billedPercent)}%)` : ""
                }</div>
                ${milestoneName ? `<div class="meta-line"><strong>Milestone:</strong> ${escapeHtml(milestoneName)}</div>` : ""}
                <div class="meta-line"><strong>Sales Order:</strong> ${escapeHtml(proforma.so_number || "")}</div>
                <div class="meta-line"><strong>Currency:</strong> ${escapeHtml(currencyCode)}</div>
              </td>
            </tr>
          </table>

          <table class="layout party-row">
            <tr>
              <td>
                <div class="section-title">Bill To</div>
                <div class="meta-line"><strong>${escapeHtml(proforma.bill_to_name || proforma.customer_name || "")}</strong></div>
                ${buyerAddressLines.map((line) => `<div class="meta-line">${escapeHtml(line)}</div>`).join("") || `<div class="meta-line">—</div>`}
                ${proforma.customer_gstin ? `<div class="meta-line" style="margin-top:4px;">GSTIN/UIN: ${escapeHtml(proforma.customer_gstin)}</div>` : ""}
                ${proforma.attention_to ? `<div class="meta-line">Kind Attention: ${escapeHtml(proforma.attention_to)}</div>` : ""}
              </td>
              <td>
                <div class="section-title">Customer PO</div>
                <div class="meta-line"><strong>PO No:</strong> ${escapeHtml(customerPoNumber || "—")}</div>
                <div class="meta-line"><strong>PO Date:</strong> ${escapeHtml(customerPoDate ? fmtDate(customerPoDate) : "—")}</div>
                <div class="meta-line"><strong>Customer Code:</strong> ${escapeHtml(proforma.customer_code || "—")}</div>
              </td>
            </tr>
          </table>

          <table class="lines-table">
            <thead>
              <tr>
                <th style="width:28px;">#</th>
                <th style="width:90px;">Item</th>
                <th>Description</th>
                <th style="width:64px;">HSN/SAC</th>
                <th style="width:48px;">Qty</th>
                <th style="width:70px;">Rate</th>
                <th style="width:78px;">Taxable</th>
                <th style="width:48px;">GST%</th>
                <th style="width:70px;">GST Amt</th>
                <th style="width:78px;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${itemRows || `<tr><td colspan="10" class="align-center">No proforma lines.</td></tr>`}
            </tbody>
          </table>

          <table class="layout summary-row">
            <tr>
              <td style="width:62%;">
                <div class="section-title">Tax Summary</div>
                <table class="tax-table">
                  <thead>
                    <tr><th>HSN/SAC</th><th>GST %</th><th>Taxable Value</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Total Tax</th></tr>
                  </thead>
                  <tbody>${taxRows || `<tr><td colspan="7" class="align-center">No tax rows.</td></tr>`}</tbody>
                </table>
                <div class="summary-words">
                  <div><strong>Amount Chargeable (in words):</strong> ${escapeHtml(amountInWords)}</div>
                </div>
              </td>
              <td style="width:38%;">
                <div class="section-title">Proforma Totals</div>
                <table class="totals-table">
                  <tr><td>Subtotal</td><td class="align-right">${fmtMoney(proforma.subtotal_proforma || totalTaxable)}</td></tr>
                  <tr><td>GST Total</td><td class="align-right">${fmtMoney(proforma.tax_total_proforma || totalTax)}</td></tr>
                  <tr><td><strong>Grand Total</strong></td><td class="align-right"><strong>${fmtMoney(grandTotal)}</strong></td></tr>
                </table>
              </td>
            </tr>
          </table>

          <table class="layout footer-row">
            <tr>
              <td style="width:58%;">
                <div class="section-title">Bank Details (For Advance Payment)</div>
                ${
                  bankFields.length
                    ? `<table class="bank-table">
                        ${bankFields
                          .map(
                            (item) => `
                              <tr><td class="label">${escapeHtml(item.label)}</td><td class="value">${escapeHtml(item.value)}</td></tr>
                            `
                          )
                          .join("")}
                      </table>`
                    : `<div class="meta-line">Bank details can be configured from Admin Masters.</div>`
                }
                <div class="declaration">${escapeHtml(PROFORMA_FOOTER_DISCLAIMER)}</div>
              </td>
              <td style="width:42%;">
                <div class="signature-block">
                  <div class="for-line">for ${escapeHtml(sellerProfile.company_name)}</div>
                  ${signatureDataUrl ? `<div><img src="${escapeHtml(signatureDataUrl)}" alt="Authorised Signature" style="max-width:160px; max-height:60px;" /></div>` : ""}
                  <div class="sign-line">Authorised Signatory</div>
                </div>
              </td>
            </tr>
          </table>

          <div class="remark-bar">${proforma.remarks ? `Remarks: ${escapeHtml(proforma.remarks)}` : ""}</div>
        </div>
      </div>
    </body>
  </html>`;
}

/** Build the single-page proforma invoice PDF. */
async function buildProformaPdfBuffer(
  { proforma, lines, sellerProfile, hasLetterhead, letterheadBuffer },
  { generateQuotePdfBuffer, applyPdfBackground, stampPdfPageNumbers, countPdfPages }
) {
  const docLabel = cleanText(proforma.proforma_number) || `proforma_${proforma.id}`;
  let pdf = await generateQuotePdfBuffer(renderProformaHtml({ proforma, lines, sellerProfile, hasLetterhead }), {
    margin: getProformaPdfMargins(hasLetterhead),
    omitBackground: hasLetterhead,
  });
  if (letterheadBuffer) {
    pdf = await applyPdfBackground(pdf, letterheadBuffer);
  }
  const pages = await countPdfPages(pdf);
  if (pages > 1) {
    pdf = await stampPdfPageNumbers(pdf, { label: docLabel, skipIfSinglePage: true });
  }
  return pdf;
}

module.exports = {
  renderProformaHtml,
  buildProformaPdfBuffer,
  getProformaPdfMargins,
  PROFORMA_FOOTER_DISCLAIMER,
};
