const {
  escapeHtml,
  cleanText,
  fmtMoney,
  fmtDate,
  joinAddressLines,
  amountToWords,
} = require("./formatters");
const { shellDocumentStyles } = require("./pdfStyles");

function renderShell({ title, body, sellerProfile }) {
  const logoDataUrl = cleanText(sellerProfile.logo_data_url);
  const signatureDataUrl = cleanText(sellerProfile.signature_data_url);
  const sellerAddressLines = joinAddressLines([
    sellerProfile.address_line1,
    sellerProfile.address_line2,
    sellerProfile.address_line3,
    [sellerProfile.city, sellerProfile.state, sellerProfile.pincode].filter(Boolean).join(" - "),
    sellerProfile.country,
  ]);

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(title)}</title>
      <style>
        ${shellDocumentStyles({ pageMargin: "10mm" })}
        .header { grid-template-columns: 1fr 240px; }
      </style>
    </head>
    <body>
      <div class="sheet">
        <div class="header">
          <div class="seller">
            ${logoDataUrl ? `<div style="margin-bottom:8px;"><img src="${escapeHtml(logoDataUrl)}" alt="Company Logo" style="max-width:160px; max-height:60px;" /></div>` : ""}
            <h1>${escapeHtml(sellerProfile.company_name)}</h1>
            <div class="small">${sellerAddressLines.map((line) => escapeHtml(line)).join("<br />")}</div>
            <div class="small" style="margin-top:6px;">
              ${sellerProfile.gstin ? `GSTIN/UIN: ${escapeHtml(sellerProfile.gstin)}<br />` : ""}
              ${sellerProfile.pan ? `PAN: ${escapeHtml(sellerProfile.pan)}<br />` : ""}
              ${sellerProfile.contact_name ? `Contact: ${escapeHtml(sellerProfile.contact_name)}<br />` : ""}
              ${sellerProfile.contact_email ? `Email: ${escapeHtml(sellerProfile.contact_email)}<br />` : ""}
              ${sellerProfile.website ? `Website: ${escapeHtml(sellerProfile.website)}` : ""}
            </div>
          </div>
          <div class="doc">${body.headerHtml}</div>
        </div>
        ${body.contentHtml}
        <div class="footer">
          <div class="footer-box">
            <div class="section-title">Bank Details</div>
            ${[
              ["Bank", sellerProfile.bank_name],
              ["Branch", sellerProfile.bank_branch],
              ["A/c Name", sellerProfile.account_name || sellerProfile.company_name],
              ["A/c No", sellerProfile.account_no],
              ["IFSC", sellerProfile.ifsc],
            ]
              .filter((item) => cleanText(item[1]))
              .map(([label, value]) => `<div class="bank-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`)
              .join("") || `<div>Bank details can be configured from Admin Masters.</div>`}
          </div>
          <div class="footer-box">
            <div class="signature">
              <div class="for-line">for ${escapeHtml(sellerProfile.company_name)}</div>
              ${signatureDataUrl ? `<div style="text-align:right;"><img src="${escapeHtml(signatureDataUrl)}" alt="Authorised Signature" style="max-width:180px; max-height:70px;" /></div>` : ""}
              <div class="sign-line">Authorised Signatory</div>
            </div>
          </div>
        </div>
      </div>
    </body>
  </html>`;
}

function renderReceiptHtml({ receipt, allocations, sellerProfile }) {
  const currencyCode = cleanText(receipt.receipt_currency_code) || "INR";
  const body = {
    headerHtml: `
      <h2>RECEIPT VOUCHER</h2>
      <div><strong>Receipt No:</strong> ${escapeHtml(receipt.receipt_number || "")}</div>
      <div><strong>Date:</strong> ${escapeHtml(fmtDate(receipt.receipt_date))}</div>
      <div><strong>Status:</strong> ${escapeHtml(cleanText(receipt.receipt_status))}</div>
      <div><strong>Currency:</strong> ${escapeHtml(currencyCode)}</div>
    `,
    contentHtml: `
      <div class="grid-2">
        <div class="cell">
          <div class="section-title">Received From</div>
          <div><strong>${escapeHtml(receipt.customer_name || "")}</strong></div>
          <div>Customer Code: ${escapeHtml(receipt.customer_code || "—")}</div>
        </div>
        <div class="cell">
          <div class="section-title">Payment Reference</div>
          <div><strong>Mode:</strong> ${escapeHtml(receipt.payment_mode || "—")}</div>
          <div><strong>Reference No:</strong> ${escapeHtml(receipt.reference_no || "—")}</div>
          <div><strong>Bank:</strong> ${escapeHtml(receipt.bank_name || "—")}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Receipt Summary</div>
        <table>
          <tbody>
            <tr><td>Receipt Amount</td><td class="align-right">${fmtMoney(receipt.receipt_amount_invoice)}</td></tr>
            <tr><td>Allocated Amount</td><td class="align-right">${fmtMoney(receipt.allocated_amount_invoice)}</td></tr>
            <tr><td>Unallocated Amount</td><td class="align-right">${fmtMoney(receipt.unallocated_amount_invoice)}</td></tr>
            <tr><td><strong>Amount In Words</strong></td><td>${escapeHtml(amountToWords(receipt.receipt_amount_invoice, currencyCode))}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="section">
        <div class="section-title">Invoice Allocations</div>
        <table>
          <thead>
            <tr>
              <th style="width:140px;">Invoice No</th>
              <th style="width:100px;">Inv Date</th>
              <th style="width:100px;">Due Date</th>
              <th style="width:120px;">Invoice Total</th>
              <th style="width:120px;">Allocated</th>
              <th>Balance After</th>
            </tr>
          </thead>
          <tbody>
            ${
              allocations.length
                ? allocations
                    .map(
                      (row) => `
                        <tr>
                          <td>${escapeHtml(row.invoice_number || "")}</td>
                          <td class="align-center">${escapeHtml(fmtDate(row.invoice_date))}</td>
                          <td class="align-center">${escapeHtml(fmtDate(row.due_date))}</td>
                          <td class="align-right">${fmtMoney(row.invoice_total_invoice)}</td>
                          <td class="align-right">${fmtMoney(row.allocated_invoice)}</td>
                          <td class="align-right">${fmtMoney(row.invoice_outstanding_after_current)}</td>
                        </tr>
                      `
                    )
                    .join("")
                : `<tr><td colspan="6" class="align-center">No allocations.</td></tr>`
            }
          </tbody>
        </table>
      </div>

      <div class="section">
        <div><strong>Remarks:</strong> ${escapeHtml(receipt.remarks || "—")}</div>
      </div>
    `,
  };
  return renderShell({ title: receipt.receipt_number || "Receipt", body, sellerProfile });
}

function renderCustomerStatementHtml({ customer, statementRows, summary, sellerProfile, asOfDate }) {
  const body = {
    headerHtml: `
      <h2>CUSTOMER STATEMENT</h2>
      <div><strong>Customer:</strong> ${escapeHtml(customer.customer_name || "")}</div>
      <div><strong>As On:</strong> ${escapeHtml(fmtDate(asOfDate))}</div>
      <div><strong>Currency:</strong> ${escapeHtml(customer.currency_code || "INR")}</div>
    `,
    contentHtml: `
      <div class="grid-2">
        <div class="cell">
          <div class="section-title">Customer</div>
          <div><strong>${escapeHtml(customer.customer_name || "")}</strong></div>
          <div>Customer Code: ${escapeHtml(customer.customer_code || "—")}</div>
        </div>
        <div class="cell">
          <div class="section-title">Statement Summary</div>
          <div><strong>Total Invoiced:</strong> ${fmtMoney(summary.total_invoiced)}</div>
          <div><strong>Total Received:</strong> ${fmtMoney(summary.total_received)}</div>
          <div><strong>Total Credited:</strong> ${fmtMoney(summary.total_credited || 0)}</div>
          <div><strong>Total Adjusted:</strong> ${fmtMoney(summary.total_adjusted || 0)}</div>
          <div><strong>Outstanding:</strong> ${fmtMoney(summary.outstanding)}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Ledger</div>
        <table>
          <thead>
            <tr>
              <th style="width:100px;">Date</th>
              <th style="width:110px;">Type</th>
              <th style="width:140px;">Reference</th>
              <th>Description</th>
              <th style="width:110px;">Debit</th>
              <th style="width:110px;">Credit</th>
              <th style="width:120px;">Balance</th>
            </tr>
          </thead>
          <tbody>
            ${
              statementRows.length
                ? statementRows
                    .map(
                      (row) => `
                        <tr>
                          <td class="align-center">${escapeHtml(fmtDate(row.txn_date))}</td>
                          <td class="align-center">${escapeHtml(row.txn_type)}</td>
                          <td>${escapeHtml(row.reference_no || "")}</td>
                          <td>${escapeHtml(row.description || "")}</td>
                          <td class="align-right">${row.debit ? fmtMoney(row.debit) : ""}</td>
                          <td class="align-right">${row.credit ? fmtMoney(row.credit) : ""}</td>
                          <td class="align-right">${fmtMoney(row.running_balance)}</td>
                        </tr>
                      `
                    )
                    .join("")
                : `<tr><td colspan="7" class="align-center">No statement rows.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    `,
  };
  return renderShell({ title: `${customer.customer_name || "Customer"} Statement`, body, sellerProfile });
}

function renderVendorStatementHtml({ vendor, statementRows, summary, sellerProfile, asOfDate, currencyLabel }) {
  const body = {
    headerHtml: `
      <h2>VENDOR STATEMENT</h2>
      <div><strong>Vendor:</strong> ${escapeHtml(vendor.company_name || "")}</div>
      <div><strong>As On:</strong> ${escapeHtml(fmtDate(asOfDate))}</div>
      <div><strong>Currency:</strong> ${escapeHtml(currencyLabel || "INR")}</div>
    `,
    contentHtml: `
      <div class="grid-2">
        <div class="cell">
          <div class="section-title">Vendor</div>
          <div><strong>${escapeHtml(vendor.company_name || "")}</strong></div>
          <div>Vendor Code: ${escapeHtml(vendor.vendor_code || "—")}</div>
          <div>GSTIN: ${escapeHtml(vendor.gstin || "—")}</div>
        </div>
        <div class="cell">
          <div class="section-title">Statement Summary</div>
          <div><strong>Total Invoiced:</strong> ${fmtMoney(summary.total_invoiced)}</div>
          <div><strong>Total Paid:</strong> ${fmtMoney(summary.total_paid)}</div>
          <div><strong>Outstanding:</strong> ${fmtMoney(summary.outstanding)}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Ledger</div>
        <table>
          <thead>
            <tr>
              <th style="width:100px;">Date</th>
              <th style="width:110px;">Type</th>
              <th style="width:140px;">Reference</th>
              <th>Description</th>
              <th style="width:110px;">Debit</th>
              <th style="width:110px;">Credit</th>
              <th style="width:120px;">Balance</th>
            </tr>
          </thead>
          <tbody>
            ${
              statementRows.length
                ? statementRows
                    .map(
                      (row) => `
                        <tr>
                          <td class="align-center">${escapeHtml(fmtDate(row.txn_date))}</td>
                          <td class="align-center">${escapeHtml(row.txn_type)}</td>
                          <td>${escapeHtml(row.reference_no || "")}</td>
                          <td>${escapeHtml(row.description || "")}</td>
                          <td class="align-right">${row.debit ? fmtMoney(row.debit) : ""}</td>
                          <td class="align-right">${row.credit ? fmtMoney(row.credit) : ""}</td>
                          <td class="align-right">${fmtMoney(row.running_balance)}</td>
                        </tr>
                      `
                    )
                    .join("")
                : `<tr><td colspan="7" class="align-center">No statement rows.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    `,
  };
  return renderShell({ title: `${vendor.company_name || "Vendor"} Statement`, body, sellerProfile });
}

module.exports = {
  renderCustomerStatementHtml,
  renderVendorStatementHtml,
  renderReceiptHtml,
};
