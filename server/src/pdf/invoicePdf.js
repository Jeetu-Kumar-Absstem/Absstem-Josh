/**
 * Locked Tax Invoice PDF layout rules (P0b / GST Rule 46 / Absstem Brand Guidelines):
 *
 * Print set = ONE PDF with THREE pages (Original / Duplicate / Triplicate).
 * Each copy is designed to fit on a SINGLE page (same content, different copy label).
 * Page numbers are stamped only if a copy overflows (then "Page X of Y" within that copy).
 *
 * Letterhead clearance matches quotes:
 *   - CSS `@page { margin: 12mm }` (slightly tighter than quote 14mm so 1 page fits)
 *   - Puppeteer margins from INVOICE_LETTERHEAD_CLEARANCE
 *   - Small `.page` padding-top under the red line
 *   - omitBackground + transparent sheet so letterhead watermark shows through
 *
 * - Do NOT overstamp "REINVENTING PERFORMANCE" or letterhead artwork.
 * - IRN/QR blocks render only when real e-invoice fields are present.
 * - Customer Part / SAP codes render as muted secondary lines under Description only.
 * - Amount label is exactly: "Amount Chargeable (in words)".
 * - Shared brand CSS from pdfStyles.js; number/words helpers from formatters.js.
 */

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
const { money2 } = require("../services/tally/money");

const INVOICE_COPY_LABELS = Object.freeze([
  "Original for Recipient",
  "Duplicate for Transporter",
  "Triplicate for Supplier",
]);

/** Quote-like inset, slightly tighter vertically so one copy fits on one A4 page. */
const INVOICE_LETTERHEAD_CLEARANCE = Object.freeze({
  top: "12mm",
  right: "12mm",
  bottom: "12mm",
  left: "12mm",
});

/** Extra top nudge under letterhead red line. */
const INVOICE_LETTERHEAD_PAGE_TOP_PAD = "10px";

/** @deprecated alias kept for regen/scripts */
const INVOICE_LETTERHEAD_PAGE_PADDING = Object.freeze({
  top: INVOICE_LETTERHEAD_CLEARANCE.top,
  bottom: INVOICE_LETTERHEAD_CLEARANCE.bottom,
});

const INVOICE_PDF_MARGINS_LETTERHEAD = Object.freeze({ ...INVOICE_LETTERHEAD_CLEARANCE });

const INVOICE_PDF_MARGINS_PLAIN = Object.freeze({
  top: "10mm",
  right: "12mm",
  bottom: "10mm",
  left: "12mm",
});

/** Letterhead owns this artwork — never draw/overstamp it from invoice HTML. */
const BRAND_TAGLINE = "REINVENTING PERFORMANCE";

function inferTaxMode(sellerProfile, invoice) {
  const sellerStateCode = cleanText(sellerProfile.state_code);
  const buyerStateCode =
    deriveStateCode(invoice.customer_gstin) || cleanText(invoice.customer_state_code) || deriveStateCode(invoice.customer_state_code);
  if (sellerStateCode && buyerStateCode) {
    return sellerStateCode === buyerStateCode ? "intra" : "inter";
  }
  const sellerState = normalizeStateName(sellerProfile.state);
  const buyerState = normalizeStateName(invoice.customer_state);
  if (sellerState && buyerState && sellerState === buyerState) return "intra";
  return "inter";
}

function statusWatermark(status) {
  const value = cleanText(status).toLowerCase();
  if (!value || value === "issued" || value === "paid") return "";
  if (value === "cancelled") return "CANCELLED";
  return "DRAFT";
}

/** Chromium PDF margins when digital letterhead is applied as full-page background. */
function getInvoicePdfMargins(hasLetterhead = false) {
  return hasLetterhead ? { ...INVOICE_PDF_MARGINS_LETTERHEAD } : { ...INVOICE_PDF_MARGINS_PLAIN };
}

function renderInvoiceHtml({
  invoice,
  lines,
  dispatch,
  sellerProfile,
  hasLetterhead = false,
  copyLabels = null,
  signedQrDataUrl = null,
}) {
  const copies =
    Array.isArray(copyLabels) && copyLabels.length
      ? copyLabels.map((label) => cleanText(label)).filter(Boolean)
      : [...INVOICE_COPY_LABELS];
  const letterheadMode = Boolean(hasLetterhead);
  const currencyCode = cleanText(invoice.invoice_currency_code) || "INR";
  const watermark = statusWatermark(invoice.invoice_status);
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
    cleanText(invoice.bill_to_address)
      ? String(invoice.bill_to_address)
          .split(/\r?\n/)
          .flatMap((part) => String(part).split(/,\s*(?=[A-Za-z0-9])/))
          .map((part) => cleanText(part))
      : [
          invoice.address_line1,
          invoice.address_line2,
          invoice.address_line3,
          [invoice.customer_city, invoice.customer_state, invoice.customer_pincode].filter(Boolean).join(" - "),
        ]
  );
  const consigneeName =
    cleanText(dispatch?.ship_to_name) ||
    cleanText(dispatch?.consignee_name) ||
    cleanText(invoice.ship_to_name) ||
    cleanText(invoice.end_customer_name) ||
    cleanText(invoice.customer_name);
  const consigneeAddressLines = joinAddressLines(
    dispatch?.ship_to_address || dispatch?.consignee_address
      ? String(dispatch?.ship_to_address || dispatch?.consignee_address)
          .split(/\r?\n/)
          .map((part) => cleanText(part))
      : cleanText(invoice.ship_to_address)
        ? String(invoice.ship_to_address)
            .split(/\r?\n/)
            .map((part) => cleanText(part))
        : buyerAddressLines
  );
  const taxMode = inferTaxMode(sellerProfile, invoice);
  const lineItems = Array.isArray(lines) ? lines : [];

  const computedLines = lineItems.map((line) => {
    const taxableValue = num(line.line_total_invoice);
    const gstPct = num(line.gst_pct);
    const gstAmount = money2((taxableValue * gstPct) / 100);
    const cgstPct = taxMode === "intra" ? gstPct / 2 : 0;
    const sgstPct = taxMode === "intra" ? gstPct / 2 : 0;
    const igstPct = taxMode === "inter" ? gstPct : 0;
    const cgstAmount = taxMode === "intra" ? money2(gstAmount / 2) : 0;
    const sgstAmount = taxMode === "intra" ? money2(gstAmount - cgstAmount) : 0;
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
  const grandTotal = num(invoice.grand_total_invoice) || Number((totalTaxable + totalTax).toFixed(2));

  const summaryMap = new Map();
  for (const line of computedLines) {
    const hsn = cleanText(line.hsn_no) || "—";
    // One tax-summary row per unique HSN (+ GST %) so multi-line invoices roll up correctly.
    const key = `${hsn}|${line.gstPct.toFixed(2)}`;
    if (!summaryMap.has(key)) {
      summaryMap.set(key, {
        hsn,
        gstPct: line.gstPct,
        taxableValue: 0,
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 0,
        taxAmount: 0,
      });
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
  const taxAmountInWords = amountToWords(totalTax, currencyCode);
  const placeOfSupplyStateCode = deriveStateCode(invoice.customer_gstin) || cleanText(invoice.customer_state_code);
  const placeOfSupply = [cleanText(invoice.customer_state), placeOfSupplyStateCode ? `State Code ${placeOfSupplyStateCode}` : ""]
    .filter(Boolean)
    .join(" / ");
  const customerPoNumber = cleanText(invoice.customer_po_number) || cleanText(invoice.buyer_po_number);
  const customerPoDate = invoice.customer_po_date || invoice.buyer_po_date || null;
  const irnValue = cleanText(invoice.irn);
  const irnAckNo = cleanText(invoice.irn_ack_no);
  const irnAckDate = invoice.irn_ack_date ? fmtDate(invoice.irn_ack_date) : "";
  const signedQrCode = cleanText(invoice.signed_qr_code);
  const showEInvoiceBlock = Boolean(irnValue || irnAckNo || irnAckDate || signedQrCode);
  const ewayBillNo =
    cleanText(invoice.eway_bill_no) || cleanText(dispatch?.eway_bill_no) || cleanText(dispatch?.eway_ref);
  const modeLabel = cleanText(dispatch?.transport_mode)
    ? String(dispatch.transport_mode).charAt(0).toUpperCase() + String(dispatch.transport_mode).slice(1)
    : "";
  const vehicleTypeLabel =
    cleanText(dispatch?.vehicle_type).toUpperCase() === "O"
      ? "ODC"
      : cleanText(dispatch?.vehicle_type).toUpperCase() === "R"
        ? "Regular"
        : "";
  const dispatchFields = [
    { label: "Dispatch No", value: dispatch?.dispatch_number },
    { label: "Transporter", value: dispatch?.transporter_name },
    { label: "Transporter ID", value: dispatch?.transporter_id },
    { label: "L.R. No", value: dispatch?.lr_no },
    { label: "L.R. Date", value: dispatch?.lr_date ? fmtDate(dispatch.lr_date) : "" },
    { label: "Mode", value: modeLabel },
    { label: "Vehicle No", value: dispatch?.vehicle_no },
    { label: "Vehicle Type", value: vehicleTypeLabel },
    {
      label: "Distance (km)",
      value:
        dispatch?.approx_distance_km !== null && dispatch?.approx_distance_km !== undefined && dispatch?.approx_distance_km !== ""
          ? String(dispatch.approx_distance_km)
          : "",
    },
    { label: "E-Way Bill", value: ewayBillNo },
    {
      label: "E-Way Date",
      value: invoice.eway_bill_date
        ? fmtDate(invoice.eway_bill_date)
        : dispatch?.eway_bill_date
          ? fmtDate(dispatch.eway_bill_date)
          : "",
    },
    {
      label: "Valid Till",
      value: invoice.eway_valid_till
        ? fmtDate(invoice.eway_valid_till)
        : dispatch?.eway_valid_till
          ? fmtDate(dispatch.eway_valid_till)
          : "",
    },
    { label: "Tracking Ref", value: dispatch?.tracking_ref },
  ].filter((item) => cleanText(item.value));

  const bankFields = [
    { label: "Bank", value: sellerProfile.bank_name },
    { label: "Branch", value: sellerProfile.bank_branch },
    { label: "A/c Name", value: sellerProfile.account_name || sellerProfile.company_name },
    { label: "A/c No", value: sellerProfile.account_no },
    { label: "IFSC", value: sellerProfile.ifsc },
  ].filter((item) => cleanText(item.value));

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(invoice.invoice_number || "Invoice")}</title>
      <style>
        ${baseDocumentStyles({
          letterheadMode,
          pageTopPad: INVOICE_LETTERHEAD_PAGE_TOP_PAD,
          pageMargin: letterheadMode ? "12mm" : "0",
          fontSize: "9.5px",
          lineHeight: "1.3",
        })}
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
        table.layout {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }
        table.layout > tr > td,
        table.layout > tbody > tr > td,
        table.layout > thead > tr > th,
        table.layout > tr > th {
          vertical-align: top;
          word-wrap: break-word;
          overflow-wrap: anywhere;
          white-space: normal;
        }
        .title-row > tr > td,
        .title-row > tbody > tr > td {
          border-bottom: 1.5px solid var(--pdf-primary);
          padding: 4px 6px;
        }
        .title-row > tr > td + td,
        .title-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .company-box { width: 52%; }
        .doc-box { width: 48%; }
        .party-row > tr > td,
        .party-row > tbody > tr > td {
          width: 50%;
          border-bottom: 1px solid var(--pdf-border-strong);
          padding: 4px 6px;
          min-height: 0;
          background: var(--pdf-surface);
        }
        .party-row > tr > td + td,
        .party-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .meta-row > tr > td,
        .meta-row > tbody > tr > td {
          width: 50%;
          border-bottom: 1px solid var(--pdf-border-strong);
          padding: 4px 6px;
          background: var(--pdf-surface);
        }
        .meta-row > tr > td + td,
        .meta-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .irn-row > tr > td,
        .irn-row > tbody > tr > td {
          border-bottom: 1px solid var(--pdf-border-strong);
          padding: 7px 10px;
          font-size: 10px;
          background: #fffaf0;
        }
        .irn-row > tr > td + td,
        .irn-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); width: 110px; text-align: center; }
        .qr-box {
          border: 1px dashed var(--pdf-border-strong);
          min-height: 96px;
          text-align: center;
          padding: 8px 4px;
          color: var(--pdf-faint);
          font-size: 9px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #fff;
        }
        .qr-image {
          width: 96px;
          height: 96px;
          display: block;
        }
        .lines-table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }
        .lines-table th,
        .lines-table td {
          border-right: 1px solid var(--pdf-border-strong);
          border-bottom: 1px solid var(--pdf-border-strong);
          padding: 3px 4px;
          vertical-align: top;
          font-size: 9px;
          line-height: 1.25;
        }
        .lines-table th:last-child,
        .lines-table td:last-child { border-right: none; }
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
        .summary-row > tr > td,
        .summary-row > tbody > tr > td {
          border-bottom: 1px solid var(--pdf-border-strong);
          padding: 4px 6px;
          vertical-align: top;
        }
        .summary-row > tr > td + td,
        .summary-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .summary-row,
        .footer-row {
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .summary-words {
          margin-top: 4px;
          font-size: 9px;
          line-height: 1.3;
          background: var(--pdf-surface-alt);
          padding: 4px 6px;
          border: 1px solid var(--pdf-border);
        }
        .summary-words div { margin: 0 0 2px; color: var(--pdf-muted); }
        .tax-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 2px;
        }
        .tax-table th,
        .tax-table td {
          border: 1px solid var(--pdf-border-strong);
          padding: 2px 3px;
          font-size: 9px;
        }
        .tax-table th {
          background: var(--pdf-surface);
          color: var(--pdf-neutral);
          text-align: center;
          font-weight: 700;
        }
        .totals-table {
          width: 100%;
          border-collapse: collapse;
        }
        .totals-table td {
          padding: 1px 0;
          font-size: 9.5px;
          border: none;
          color: var(--pdf-muted);
        }
        .totals-table tr:last-child td {
          color: var(--pdf-primary);
          font-weight: 700;
        }
        .footer-row > tr > td,
        .footer-row > tbody > tr > td {
          padding: 4px 6px;
          vertical-align: top;
        }
        .footer-row > tr > td + td,
        .footer-row > tbody > tr > td + td { border-left: 1px solid var(--pdf-border-strong); }
        .bank-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 4px;
          table-layout: fixed;
        }
        .bank-table td {
          padding: 0;
          font-size: 9px;
          line-height: 1.3;
          vertical-align: top;
          border: none !important;
        }
        .bank-table td.label {
          width: 68px;
          font-weight: 700;
          white-space: nowrap;
          padding-right: 6px;
          color: var(--pdf-muted);
        }
        .bank-table td.value {
          padding-left: 6px;
          word-break: break-word;
          color: var(--pdf-neutral);
        }
        .declaration {
          margin-top: 3px;
          font-size: 8.5px;
          line-height: 1.3;
          clear: both;
          color: var(--pdf-faint);
        }
        .signature-block {
          text-align: right;
          min-height: 48px;
        }
        .signature-block .for-line { font-weight: 700; margin-bottom: 18px; color: var(--pdf-muted); }
        .signature-block .sign-line { font-weight: 700; color: var(--pdf-neutral); }
        .remark-bar {
          border-top: 1px solid var(--pdf-border-strong);
          padding: 2px 6px;
          font-size: 8.5px;
          min-height: 12px;
          color: var(--pdf-muted);
        }
        .sheet > * { position: relative; z-index: 1; }
      </style>
    </head>
    <body>
      ${copies
        .map((copyLabel) => {
          const itemRows = computedLines
            .map((line) => {
              const customerPartCode = cleanText(line.customer_item_code);
              const customerPartDesc = cleanText(line.customer_item_description);
              const itemCode = cleanText(line.item_code);
              const desc = cleanText(line.description) || cleanText(line.item_name) || cleanText(line.line_description);
              return `
                <tr>
                  <td class="align-center">${escapeHtml(line.line_no)}</td>
                  <td>
                    <span class="item-primary">${escapeHtml(itemCode || desc || "—")}</span>
                  </td>
                  <td>
                    <span class="item-primary">${escapeHtml(desc || itemCode || "—")}</span>
                    ${
                      customerPartCode
                        ? `<span class="item-secondary">Customer Part / SAP: ${escapeHtml(customerPartCode)}</span>`
                        : ""
                    }
                    ${
                      customerPartDesc
                        ? `<span class="item-secondary">${escapeHtml(customerPartDesc)}</span>`
                        : ""
                    }
                  </td>
                  <td class="align-center">${escapeHtml(line.hsn_no || "")}</td>
                  <td class="align-right">${fmtQty(line.qty)}</td>
                  <td class="align-right">${fmtMoney(line.unit_price_invoice)}</td>
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
                 ${sellerProfile.website ? `<div class="meta-line">Website: ${escapeHtml(sellerProfile.website)}</div>` : ""}
               </div>`;

          return `
            <div class="page">
              ${watermark ? `<div class="watermark">${escapeHtml(watermark)}</div>` : ""}
              <div class="sheet">
                <div class="copy-band">${escapeHtml(copyLabel)}</div>
                <table class="layout title-row">
                  <tr>
                    <td class="company-box">${companyCell}</td>
                    <td class="doc-box">
                      <div class="doc-title">TAX INVOICE</div>
                      <div class="meta-line"><strong>Invoice No:</strong> ${escapeHtml(invoice.invoice_number || "")}</div>
                      <div class="meta-line"><strong>Invoice Date:</strong> ${escapeHtml(fmtDate(invoice.invoice_date))}</div>
                      <div class="meta-line"><strong>Customer PO No:</strong> ${escapeHtml(customerPoNumber || "—")}</div>
                      <div class="meta-line"><strong>Customer PO Date:</strong> ${escapeHtml(customerPoDate ? fmtDate(customerPoDate) : "—")}</div>
                      <div class="meta-line"><strong>Sales Order:</strong> ${escapeHtml(invoice.so_number || "")}</div>
                      <div class="meta-line"><strong>Currency:</strong> ${escapeHtml(currencyCode)}</div>
                    </td>
                  </tr>
                </table>

                ${
                  showEInvoiceBlock
                    ? `<table class="layout irn-row">
                        <tr>
                          <td>
                            ${irnValue ? `<div class="meta-line"><strong>IRN:</strong> ${escapeHtml(irnValue)}</div>` : ""}
                            ${irnAckNo ? `<div class="meta-line"><strong>Ack No:</strong> ${escapeHtml(irnAckNo)}</div>` : ""}
                            ${irnAckDate ? `<div class="meta-line"><strong>Ack Date:</strong> ${escapeHtml(irnAckDate)}</div>` : ""}
                          </td>
                          <td>
                            ${
                              signedQrCode
                                ? signedQrDataUrl
                                  ? `<div class="qr-box"><img class="qr-image" src="${escapeHtml(signedQrDataUrl)}" style="width:96px;height:96px" /></div>`
                                  : `<div class="qr-box">Signed QR on file</div>`
                                : ""
                            }
                          </td>
                        </tr>
                      </table>`
                    : ""
                }

                <table class="layout party-row">
                  <tr>
                    <td>
                      <div class="section-title">Bill To</div>
                      <div class="meta-line"><strong>${escapeHtml(invoice.bill_to_name || invoice.customer_name || "")}</strong></div>
                      ${buyerAddressLines.map((line) => `<div class="meta-line">${escapeHtml(line)}</div>`).join("") || `<div class="meta-line">—</div>`}
                      ${invoice.customer_gstin ? `<div class="meta-line" style="margin-top:4px;">GSTIN/UIN: ${escapeHtml(invoice.customer_gstin)}</div>` : ""}
                      ${invoice.attention_to ? `<div class="meta-line">Kind Attention: ${escapeHtml(invoice.attention_to)}</div>` : ""}
                    </td>
                    <td>
                      <div class="section-title">Ship To / Consignee</div>
                      <div class="meta-line"><strong>${escapeHtml(consigneeName)}</strong></div>
                      ${consigneeAddressLines.map((line) => `<div class="meta-line">${escapeHtml(line)}</div>`).join("") || `<div class="meta-line">—</div>`}
                    </td>
                  </tr>
                </table>

                <table class="layout meta-row">
                  <tr>
                    <td>
                      <div class="section-title">Tax / Supply Details</div>
                      <div class="meta-line"><strong>Place Of Supply:</strong> ${escapeHtml(placeOfSupply || "—")}</div>
                      <div class="meta-line"><strong>Nature Of Tax:</strong> ${taxMode === "intra" ? "CGST + SGST" : "IGST"}</div>
                      <div class="meta-line"><strong>Tax Payable On Reverse Charge:</strong> No</div>
                      <div class="meta-line"><strong>Customer Code:</strong> ${escapeHtml(invoice.customer_code || "—")}</div>
                      <div class="meta-line"><strong>Customer PO:</strong> ${escapeHtml(customerPoNumber || "—")}${
                        customerPoDate ? ` dated ${escapeHtml(fmtDate(customerPoDate))}` : ""
                      }</div>
                    </td>
                    <td>
                      <div class="section-title">Dispatch Details</div>
                      ${
                        dispatchFields.length
                          ? dispatchFields
                              .map(
                                (item) =>
                                  `<div class="meta-line"><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</div>`
                              )
                              .join("")
                          : `<div class="meta-line">—</div>`
                      }
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
                    ${itemRows || `<tr><td colspan="10" class="align-center">No invoice lines.</td></tr>`}
                  </tbody>
                </table>

                <table class="layout summary-row">
                  <tr>
                    <td style="width:62%;">
                      <div class="section-title">Tax Summary</div>
                      <table class="tax-table">
                        <thead>
                          <tr>
                            <th>HSN/SAC</th>
                            <th>GST %</th>
                            <th>Taxable Value</th>
                            <th>CGST</th>
                            <th>SGST</th>
                            <th>IGST</th>
                            <th>Total Tax</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${taxRows || `<tr><td colspan="7" class="align-center">No tax rows.</td></tr>`}
                        </tbody>
                      </table>
                      <div class="summary-words">
                        <div><strong>Amount Chargeable (in words):</strong> ${escapeHtml(amountInWords)}</div>
                        <div><strong>Tax Amount (in words):</strong> ${escapeHtml(taxAmountInWords)}</div>
                      </div>
                    </td>
                    <td style="width:38%;">
                      <div class="section-title">Invoice Totals</div>
                      <table class="totals-table">
                        <tr>
                          <td>Subtotal</td>
                          <td class="align-right">${fmtMoney(invoice.subtotal_invoice || totalTaxable)}</td>
                        </tr>
                        <tr>
                          <td>GST Total</td>
                          <td class="align-right">${fmtMoney(invoice.tax_total_invoice || totalTax)}</td>
                        </tr>
                        <tr>
                          <td><strong>Grand Total</strong></td>
                          <td class="align-right"><strong>${fmtMoney(grandTotal)}</strong></td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <table class="layout footer-row">
                  <tr>
                    <td style="width:58%;">
                      <div class="section-title">Bank / Declaration</div>
                      ${
                        bankFields.length
                          ? `<table class="bank-table">
                              ${bankFields
                                .map(
                                  (item) => `
                                    <tr>
                                      <td class="label">${escapeHtml(item.label)}</td>
                                      <td class="value">${escapeHtml(item.value)}</td>
                                    </tr>
                                  `
                                )
                                .join("")}
                            </table>`
                          : `<div class="meta-line">Bank details can be configured from Admin Masters.</div>`
                      }
                      <div class="declaration">${escapeHtml(sellerProfile.invoice_declaration || "")}</div>
                    </td>
                    <td style="width:42%;">
                      <div class="signature-block">
                        <div class="for-line">for ${escapeHtml(sellerProfile.company_name)}</div>
                        ${
                          signatureDataUrl
                            ? `<div><img src="${escapeHtml(signatureDataUrl)}" alt="Authorised Signature" style="max-width:160px; max-height:60px;" /></div>`
                            : ""
                        }
                        <div class="sign-line">Authorised Signatory</div>
                      </div>
                    </td>
                  </tr>
                </table>

                <div class="remark-bar">${invoice.remarks ? `Remarks: ${escapeHtml(invoice.remarks)}` : ""}</div>
              </div>
            </div>
          `;
        })
        .join("")}
    </body>
  </html>`;
}

function shortCopyLabel(label) {
  const text = cleanText(label).toLowerCase();
  if (text.includes("original")) return "Original";
  if (text.includes("duplicate")) return "Duplicate";
  if (text.includes("triplicate")) return "Triplicate";
  return cleanText(label).slice(0, 24) || "Copy";
}

/**
 * Build the print-ready tax invoice PDF:
 * - one physical page per copy when layout fits (target: 3 pages total)
 * - each copy rendered separately so page numbers reset per copy if overflow occurs
 */
async function buildTaxInvoicePdfBuffer(
  { invoice, lines, dispatch, sellerProfile, hasLetterhead, letterheadBuffer, signedQrDataUrl = null },
  {
    generateQuotePdfBuffer,
    applyPdfBackground,
    stampPdfPageNumbers,
    mergePdfBuffers,
    countPdfPages,
  }
) {
  const buffers = [];
  const docLabel = cleanText(invoice.invoice_number) || `invoice_${invoice.id}`;
  for (const copyLabel of INVOICE_COPY_LABELS) {
    let pdf = await generateQuotePdfBuffer(
      renderInvoiceHtml({
        invoice,
        lines,
        dispatch,
        sellerProfile,
        hasLetterhead,
        copyLabels: [copyLabel],
        signedQrDataUrl,
      }),
      {
        margin: getInvoicePdfMargins(hasLetterhead),
        omitBackground: hasLetterhead,
      }
    );
    if (letterheadBuffer) {
      pdf = await applyPdfBackground(pdf, letterheadBuffer);
    }
    const pages = await countPdfPages(pdf);
    // Only stamp when a copy spilled; numbering is within that copy (1 of 2), not across the set.
    if (pages > 1) {
      pdf = await stampPdfPageNumbers(pdf, {
        label: `${docLabel} · ${shortCopyLabel(copyLabel)}`,
        skipIfSinglePage: true,
      });
    }
    buffers.push(pdf);
  }
  return mergePdfBuffers(buffers);
}

module.exports = {
  renderInvoiceHtml,
  buildTaxInvoicePdfBuffer,
  getInvoicePdfMargins,
  INVOICE_COPY_LABELS,
  INVOICE_LETTERHEAD_CLEARANCE,
  INVOICE_LETTERHEAD_PAGE_PADDING,
  INVOICE_LETTERHEAD_PAGE_TOP_PAD,
  INVOICE_PDF_MARGINS_LETTERHEAD,
  INVOICE_PDF_MARGINS_PLAIN,
  BRAND_TAGLINE,
};
