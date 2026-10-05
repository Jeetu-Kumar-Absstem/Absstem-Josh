const { escapeHtml, cleanText, fmtQty, fmtDate, joinAddressLines } = require("./formatters");
const { shellDocumentStyles } = require("./pdfStyles");

function statusWatermark(status) {
  const value = cleanText(status).toLowerCase();
  if (!value || value === "dispatched" || value === "delivered") return "";
  if (value === "cancelled") return "CANCELLED";
  return "DRAFT";
}

function renderDispatchHtml({ dispatch, lines, sellerProfile }) {
  const logoDataUrl = cleanText(sellerProfile.logo_data_url);
  const signatureDataUrl = cleanText(sellerProfile.signature_data_url);
  const watermark = statusWatermark(dispatch.dispatch_status);
  const sellerAddressLines = joinAddressLines([
    sellerProfile.address_line1,
    sellerProfile.address_line2,
    sellerProfile.address_line3,
    [sellerProfile.city, sellerProfile.state, sellerProfile.pincode].filter(Boolean).join(" - "),
    sellerProfile.country,
  ]);
  const consigneeAddressLines = joinAddressLines(
    cleanText(dispatch.consignee_address)
      ? String(dispatch.consignee_address).split(/\r?\n|,\s*/)
      : [dispatch.address_line1, dispatch.address_line2, dispatch.address_line3, dispatch.city, dispatch.state, dispatch.pincode]
  );
  const computedLines = Array.isArray(lines) ? lines : [];

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(dispatch.dispatch_number || "Delivery Challan")}</title>
      <style>
        ${shellDocumentStyles({ pageMargin: "10mm" })}
      </style>
    </head>
    <body>
      <div class="sheet">
        ${watermark ? `<div class="watermark">${escapeHtml(watermark)}</div>` : ""}
        <div class="header">
          <div class="seller">
            ${logoDataUrl ? `<div style="margin-bottom:8px;"><img src="${escapeHtml(logoDataUrl)}" alt="Company Logo" style="max-width:160px; max-height:60px;" /></div>` : ""}
            <h1>${escapeHtml(sellerProfile.company_name)}</h1>
            <div class="small">${sellerAddressLines.map((line) => escapeHtml(line)).join("<br />")}</div>
            <div class="small" style="margin-top:6px;">
              ${sellerProfile.gstin ? `GSTIN/UIN: ${escapeHtml(sellerProfile.gstin)}<br />` : ""}
              ${sellerProfile.contact_name ? `Contact: ${escapeHtml(sellerProfile.contact_name)}<br />` : ""}
              ${sellerProfile.contact_email ? `Email: ${escapeHtml(sellerProfile.contact_email)}<br />` : ""}
              ${sellerProfile.website ? `Website: ${escapeHtml(sellerProfile.website)}` : ""}
            </div>
          </div>
          <div class="doc">
            <h2>DELIVERY CHALLAN</h2>
            <div><strong>Challan No:</strong> ${escapeHtml(dispatch.dispatch_number || "")}</div>
            <div><strong>Date:</strong> ${escapeHtml(fmtDate(dispatch.dispatch_date))}</div>
            <div><strong>Status:</strong> ${escapeHtml(cleanText(dispatch.dispatch_status || "draft"))}</div>
            <div><strong>Sales Order:</strong> ${escapeHtml(dispatch.so_number || "")}</div>
          </div>
        </div>

        <div class="grid-2">
          <div class="cell">
            <div class="section-title">Dispatch To / Consignee</div>
            <div><strong>${escapeHtml(dispatch.consignee_name || dispatch.customer_name || "")}</strong></div>
            <div>${consigneeAddressLines.map((line) => escapeHtml(line)).join("<br />") || "—"}</div>
          </div>
          <div class="cell">
            <div class="section-title">Customer</div>
            <div><strong>${escapeHtml(dispatch.customer_name || "")}</strong></div>
            <div>Sales Order: ${escapeHtml(dispatch.so_number || "—")}</div>
            <div>Order Status: ${escapeHtml(dispatch.order_status || "—")}</div>
          </div>
        </div>

        <div class="meta-grid">
          <div class="meta-cell">
            <div class="section-title">Transport Details</div>
            <div><strong>Transporter:</strong> ${escapeHtml(dispatch.transporter_name || "—")}</div>
            <div><strong>Transporter ID:</strong> ${escapeHtml(dispatch.transporter_id || "—")}</div>
            <div><strong>Mode:</strong> ${escapeHtml(dispatch.transport_mode || "—")}</div>
            <div><strong>LR / AWB:</strong> ${escapeHtml(dispatch.lr_no || "—")}</div>
            <div><strong>LR Date:</strong> ${escapeHtml(dispatch.lr_date ? fmtDate(dispatch.lr_date) : "—")}</div>
            <div><strong>Vehicle No:</strong> ${escapeHtml(dispatch.vehicle_no || "—")}</div>
            <div><strong>Vehicle Type:</strong> ${escapeHtml(dispatch.vehicle_type || "—")}</div>
            <div><strong>Distance (km):</strong> ${escapeHtml(dispatch.approx_distance_km ?? "—")}</div>
          </div>
          <div class="meta-cell">
            <div class="section-title">Tracking Details</div>
            <div><strong>E-Way Bill:</strong> ${escapeHtml(dispatch.eway_bill_no || dispatch.eway_ref || "—")}</div>
            <div><strong>E-Way Date:</strong> ${escapeHtml(dispatch.eway_bill_date ? fmtDate(dispatch.eway_bill_date) : "—")}</div>
            <div><strong>Valid Till:</strong> ${escapeHtml(dispatch.eway_valid_till ? fmtDate(dispatch.eway_valid_till) : "—")}</div>
            <div><strong>Tracking Ref:</strong> ${escapeHtml(dispatch.tracking_ref || "—")}</div>
            <div><strong>Dispatch Date:</strong> ${escapeHtml(fmtDate(dispatch.dispatch_date))}</div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Dispatched Items</div>
          <table>
            <thead>
              <tr>
                <th style="width:36px;">#</th>
                <th style="width:130px;">Item</th>
                <th>Description</th>
                <th style="width:80px;">Ordered Qty</th>
                <th style="width:90px;">Dispatch Qty</th>
              </tr>
            </thead>
            <tbody>
              ${
                computedLines.length
                  ? computedLines
                      .map(
                        (line) => `
                          <tr>
                            <td class="align-center">${escapeHtml(line.line_no)}</td>
                            <td>${escapeHtml(line.item_code || line.item_name || "")}</td>
                            <td>${escapeHtml(line.product_group_name || line.line_description || "")}</td>
                            <td class="align-right">${fmtQty(line.qty_ordered)}</td>
                            <td class="align-right">${fmtQty(line.qty_dispatch)}</td>
                          </tr>
                        `
                      )
                      .join("")
                  : `<tr><td colspan="5" class="align-center">No dispatch lines.</td></tr>`
              }
            </tbody>
          </table>
        </div>

        <div class="section">
          <div><strong>Remarks:</strong> ${escapeHtml(dispatch.remarks || "—")}</div>
        </div>

        <div class="footer">
          <div class="footer-box">
            <div class="section-title">Declaration</div>
            <div>This challan accompanies the dispatched material listed above and is generated from the corresponding sales order in JOSH.</div>
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

function renderPackingListHtml({ dispatch, lines, sellerProfile }) {
  const logoDataUrl = cleanText(sellerProfile.logo_data_url);
  const signatureDataUrl = cleanText(sellerProfile.signature_data_url);
  const watermark = statusWatermark(dispatch.dispatch_status);
  const sellerAddressLines = joinAddressLines([
    sellerProfile.address_line1,
    sellerProfile.address_line2,
    sellerProfile.address_line3,
    [sellerProfile.city, sellerProfile.state, sellerProfile.pincode].filter(Boolean).join(" - "),
    sellerProfile.country,
  ]);
  const consigneeAddressLines = joinAddressLines(
    cleanText(dispatch.consignee_address)
      ? String(dispatch.consignee_address).split(/\r?\n|,\s*/)
      : [dispatch.address_line1, dispatch.address_line2, dispatch.address_line3, dispatch.city, dispatch.state, dispatch.pincode]
  );
  const computedLines = Array.isArray(lines) ? lines : [];

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(dispatch.packing_list_no || dispatch.dispatch_number || "Packing List")}</title>
      <style>
        ${shellDocumentStyles({ pageMargin: "10mm" })}
      </style>
    </head>
    <body>
      <div class="sheet">
        ${watermark ? `<div class="watermark">${escapeHtml(watermark)}</div>` : ""}
        <div class="header">
          <div class="seller">
            ${logoDataUrl ? `<div style="margin-bottom:8px;"><img src="${escapeHtml(logoDataUrl)}" alt="Company Logo" style="max-width:160px; max-height:60px;" /></div>` : ""}
            <h1>${escapeHtml(sellerProfile.company_name)}</h1>
            <div class="small">${sellerAddressLines.map((line) => escapeHtml(line)).join("<br />")}</div>
            <div class="small" style="margin-top:6px;">
              ${sellerProfile.gstin ? `GSTIN/UIN: ${escapeHtml(sellerProfile.gstin)}<br />` : ""}
              ${sellerProfile.contact_name ? `Contact: ${escapeHtml(sellerProfile.contact_name)}<br />` : ""}
              ${sellerProfile.contact_email ? `Email: ${escapeHtml(sellerProfile.contact_email)}<br />` : ""}
              ${sellerProfile.website ? `Website: ${escapeHtml(sellerProfile.website)}` : ""}
            </div>
          </div>
          <div class="doc">
            <h2>PACKING LIST</h2>
            <div><strong>Packing List No:</strong> ${escapeHtml(dispatch.packing_list_no || "—")}</div>
            <div><strong>Packing Date:</strong> ${escapeHtml(fmtDate(dispatch.packing_list_date))}</div>
            <div><strong>Dispatch No:</strong> ${escapeHtml(dispatch.dispatch_number || "")}</div>
            <div><strong>Dispatch Date:</strong> ${escapeHtml(fmtDate(dispatch.dispatch_date))}</div>
            <div><strong>Sales Order:</strong> ${escapeHtml(dispatch.so_number || "")}</div>
          </div>
        </div>

        <div class="grid-2">
          <div class="cell">
            <div class="section-title">Dispatch To / Consignee</div>
            <div><strong>${escapeHtml(dispatch.consignee_name || dispatch.customer_name || "")}</strong></div>
            <div>${consigneeAddressLines.map((line) => escapeHtml(line)).join("<br />") || "—"}</div>
          </div>
          <div class="cell">
            <div class="section-title">Packing Summary</div>
            <div><strong>No. of packages:</strong> ${escapeHtml(dispatch.no_of_packages ?? "—")}</div>
            <div><strong>Gross weight:</strong> ${escapeHtml(dispatch.gross_weight ?? "—")}</div>
            <div><strong>Net weight:</strong> ${escapeHtml(dispatch.net_weight ?? "—")}</div>
          </div>
        </div>

        <div class="meta-grid">
          <div class="meta-cell">
            <div class="section-title">Transport Details</div>
            <div><strong>Transporter:</strong> ${escapeHtml(dispatch.transporter_name || "—")}</div>
            <div><strong>LR / AWB:</strong> ${escapeHtml(dispatch.lr_no || "—")}</div>
            <div><strong>Vehicle No:</strong> ${escapeHtml(dispatch.vehicle_no || "—")}</div>
          </div>
          <div class="meta-cell">
            <div class="section-title">Freight & Tracking</div>
            <div><strong>E-Way Ref:</strong> ${escapeHtml(dispatch.eway_ref || "—")}</div>
            <div><strong>Tracking Ref:</strong> ${escapeHtml(dispatch.tracking_ref || "—")}</div>
            <div><strong>Freight paid by:</strong> ${escapeHtml(dispatch.freight_paid_by || "—")}</div>
            <div><strong>Freight amount:</strong> ${escapeHtml(dispatch.freight_amount ?? "—")}</div>
            <div><strong>Freight bill:</strong> ${escapeHtml(dispatch.freight_bill_no || "—")}${dispatch.freight_bill_date ? ` (${escapeHtml(fmtDate(dispatch.freight_bill_date))})` : ""}</div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Packed Items</div>
          <table>
            <thead>
              <tr>
                <th style="width:36px;">#</th>
                <th style="width:130px;">Item</th>
                <th>Description</th>
                <th style="width:90px;">Dispatch Qty</th>
              </tr>
            </thead>
            <tbody>
              ${
                computedLines.length
                  ? computedLines
                      .map(
                        (line) => `
                          <tr>
                            <td class="align-center">${escapeHtml(line.line_no)}</td>
                            <td>${escapeHtml(line.item_code || line.item_name || "")}</td>
                            <td>${escapeHtml(line.product_group_name || line.line_description || "")}</td>
                            <td class="align-right">${fmtQty(line.qty_dispatch)}</td>
                          </tr>
                        `
                      )
                      .join("")
                  : `<tr><td colspan="4" class="align-center">No dispatch lines.</td></tr>`
              }
            </tbody>
          </table>
        </div>

        <div class="section">
          <div><strong>Packing remarks:</strong> ${escapeHtml(dispatch.packing_remarks || dispatch.remarks || "—")}</div>
        </div>

        <div class="footer">
          <div class="footer-box">
            <div class="section-title">Declaration</div>
            <div>This packing list accompanies the dispatched material listed above and is generated from the corresponding dispatch in JOSH.</div>
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

module.exports = {
  renderDispatchHtml,
  renderPackingListHtml,
};
