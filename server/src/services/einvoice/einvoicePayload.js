/**
 * NIC e-invoice (IRP) schema ~1.1 JSON payload builder.
 *
 * Builds the request payload shape used to request an IRN from a GSP/NIC,
 * mapped from Josh's existing invoice/line/seller/buyer fields. Live GSP calls
 * remain stubbed (see gspAdapter.js). EwbDtls is fully populated from structured
 * dispatch e-way fields when present (Part B + transporter/doc details).
 *
 * Only goods lines are included (charge_kind lines like packing/freight are
 * skipped for now — NIC schema supports them as separate item rows but we keep
 * this simple and conservative).
 */

const { normalizeTransportMode, toNicTransMode } = require("../ewayCompliance");

function cleanText(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(num(value) * 100) / 100;
}

function deriveStateCode(value) {
  const text = cleanText(value);
  if (!text) return "";
  const match = text.match(/^(\d{2})/);
  return match ? match[1] : "";
}

function normalizeStateName(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z]/g, "");
}

/** Mirrors invoicePdf.js inferTaxMode: state-code match first, else state-name match, else inter-state. */
function inferTaxMode(sellerProfile, invoice) {
  const sellerStateCode = cleanText(sellerProfile?.state_code);
  const buyerStateCode =
    deriveStateCode(invoice?.customer_gstin) ||
    cleanText(invoice?.customer_state_code) ||
    deriveStateCode(invoice?.customer_state_code);
  if (sellerStateCode && buyerStateCode) {
    return sellerStateCode === buyerStateCode ? "intra" : "inter";
  }
  const sellerState = normalizeStateName(sellerProfile?.state);
  const buyerState = normalizeStateName(invoice?.customer_state);
  if (sellerState && buyerState && sellerState === buyerState) return "intra";
  return "inter";
}

function fmtNicDate(value) {
  const dt = value ? new Date(value) : new Date();
  if (Number.isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function pincodeToNumber(value) {
  const text = cleanText(value).replace(/\D/g, "");
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function splitAddress(value, maxLen = 100) {
  const text = cleanText(value);
  if (!text) return { addr1: "", addr2: "" };
  if (text.length <= maxLen) return { addr1: text, addr2: "" };
  return { addr1: text.slice(0, maxLen), addr2: text.slice(maxLen, maxLen * 2) };
}

function buildTranDtls() {
  return {
    TaxSch: "GST",
    SupTyp: "B2B",
    RegRev: "N",
    IgstOnIntra: "N",
  };
}

function buildDocDtls(invoice) {
  return {
    Typ: "INV",
    No: cleanText(invoice?.invoice_number),
    Dt: fmtNicDate(invoice?.invoice_date),
  };
}

function buildSellerDtls(sellerProfile) {
  const { addr1, addr2 } = splitAddress(sellerProfile?.address_line1 || "");
  return {
    Gstin: cleanText(sellerProfile?.gstin),
    LglNm: cleanText(sellerProfile?.company_name),
    TrdNm: cleanText(sellerProfile?.company_name),
    Addr1: addr1 || cleanText(sellerProfile?.address_line1),
    Addr2: addr2 || cleanText(sellerProfile?.address_line2),
    Loc: cleanText(sellerProfile?.city),
    Pin: pincodeToNumber(sellerProfile?.pincode),
    Stcd: cleanText(sellerProfile?.state_code) || deriveStateCode(sellerProfile?.gstin),
    Ph: cleanText(sellerProfile?.contact_phone),
    Em: cleanText(sellerProfile?.contact_email),
  };
}

function buildBuyerAddressLines(invoice, buyer) {
  if (cleanText(invoice?.bill_to_address)) {
    const parts = String(invoice.bill_to_address)
      .split(/\r?\n/)
      .map((p) => cleanText(p))
      .filter(Boolean);
    return { addr1: parts[0] || "", addr2: parts.slice(1).join(", ") };
  }
  const line1 = cleanText(invoice?.address_line1) || cleanText(buyer?.address_line1);
  const line2 = [cleanText(invoice?.address_line2) || cleanText(buyer?.address_line2), cleanText(invoice?.address_line3)]
    .filter(Boolean)
    .join(", ");
  return { addr1: line1, addr2: line2 };
}

function buildBuyerDtls(invoice, buyer) {
  const { addr1, addr2 } = buildBuyerAddressLines(invoice, buyer);
  const stateCode = deriveStateCode(invoice?.customer_gstin) || cleanText(invoice?.customer_state_code);
  return {
    Gstin: cleanText(invoice?.customer_gstin) || cleanText(buyer?.gstin),
    LglNm: cleanText(invoice?.bill_to_name) || cleanText(invoice?.customer_name) || cleanText(buyer?.customer_name),
    TrdNm: cleanText(invoice?.customer_name) || cleanText(buyer?.customer_name),
    Pos: stateCode || undefined,
    Addr1: addr1,
    Addr2: addr2,
    Loc: cleanText(invoice?.customer_city) || cleanText(buyer?.city),
    Pin: pincodeToNumber(invoice?.customer_pincode || buyer?.pincode),
    Stcd: stateCode,
    Ph: cleanText(buyer?.contact_phone),
    Em: cleanText(buyer?.contact_email),
  };
}

/** Goods lines only — charge_kind rows (packing/freight) are excluded from P1 e-invoice payload. */
function isGoodsLine(line) {
  return !cleanText(line?.charge_kind);
}

function buildItemList(lines, taxMode) {
  const goodsLines = (Array.isArray(lines) ? lines : []).filter(isGoodsLine);
  return goodsLines.map((line, idx) => {
    const qty = num(line.qty);
    const unitPrice = num(line.unit_price_invoice);
    const taxableValue = round2(line.line_total_invoice ?? qty * unitPrice);
    const gstPct = num(line.gst_pct);
    const gstAmount = round2((taxableValue * gstPct) / 100);
    const cgstRate = taxMode === "intra" ? round2(gstPct / 2) : 0;
    const sgstRate = taxMode === "intra" ? round2(gstPct / 2) : 0;
    const igstRate = taxMode === "inter" ? gstPct : 0;
    const cgstAmt = taxMode === "intra" ? round2(gstAmount / 2) : 0;
    const sgstAmt = taxMode === "intra" ? round2(gstAmount / 2) : 0;
    const igstAmt = taxMode === "inter" ? gstAmount : 0;
    const totItemVal = round2(taxableValue + gstAmount);
    return {
      SlNo: String(line.line_no ?? idx + 1),
      PrdDesc: cleanText(line.product_group_name) || cleanText(line.item_name) || cleanText(line.line_description) || "Item",
      IsServc: "N",
      HsnCd: cleanText(line.hsn_no),
      Qty: qty,
      Unit: cleanText(line.uom) || "NOS",
      UnitPrice: unitPrice,
      TotAmt: round2(qty * unitPrice),
      AssAmt: taxableValue,
      GstRt: gstPct,
      CgstAmt: cgstAmt,
      SgstAmt: sgstAmt,
      IgstAmt: igstAmt,
      CesRt: 0,
      CesAmt: 0,
      TotItemVal: totItemVal,
      ...(cgstRate ? { CgstRt: cgstRate } : {}),
      ...(sgstRate ? { SgstRt: sgstRate } : {}),
      ...(igstRate ? { IgstRt: igstRate } : {}),
    };
  });
}

function buildValDtls(itemList, invoice) {
  const assVal = round2(itemList.reduce((sum, item) => sum + num(item.AssAmt), 0));
  const cgstVal = round2(itemList.reduce((sum, item) => sum + num(item.CgstAmt), 0));
  const sgstVal = round2(itemList.reduce((sum, item) => sum + num(item.SgstAmt), 0));
  const igstVal = round2(itemList.reduce((sum, item) => sum + num(item.IgstAmt), 0));
  const totInvVal = num(invoice?.grand_total_invoice) || round2(assVal + cgstVal + sgstVal + igstVal);
  return {
    AssVal: assVal,
    CgstVal: cgstVal,
    SgstVal: sgstVal,
    IgstVal: igstVal,
    CesVal: 0,
    StCesVal: 0,
    Discount: 0,
    OthChrg: 0,
    RndOffAmt: 0,
    TotInvVal: totInvVal,
  };
}

function buildEwbDtls(dispatch) {
  if (!dispatch) return null;
  const mode = normalizeTransportMode(dispatch.transport_mode);
  const vehNo = cleanText(dispatch.vehicle_no);
  const transDocNo = cleanText(dispatch.lr_no);
  const transId = cleanText(dispatch.transporter_id);
  const transName = cleanText(dispatch.transporter_name);
  if (!transId && !transName && !vehNo && !transDocNo) return null;
  const distance = Math.round(num(dispatch.approx_distance_km));
  const nicMode = toNicTransMode(mode);
  const vehType = cleanText(dispatch.vehicle_type).toUpperCase();
  return {
    ...(transId ? { TransId: transId } : {}),
    ...(transName ? { TransName: transName } : {}),
    ...(nicMode ? { TransMode: nicMode } : {}),
    Distance: distance > 0 ? distance : 0,
    ...(transDocNo ? { TransDocNo: transDocNo } : {}),
    ...(dispatch.lr_date ? { TransDocDt: fmtNicDate(dispatch.lr_date) } : {}),
    ...(vehNo ? { VehNo: vehNo } : {}),
    ...(mode === "road" && (vehType === "R" || vehType === "O") ? { VehType: vehType } : {}),
  };
}

function buildDispDtls(sellerProfile, dispatch) {
  const sellerPin = pincodeToNumber(sellerProfile?.pincode);
  const fromPin = pincodeToNumber(dispatch?.dispatch_from_pincode);
  if (!fromPin || !sellerPin || fromPin === sellerPin) return null;
  const { addr1, addr2 } = splitAddress(sellerProfile?.address_line1 || "");
  return {
    Nm: cleanText(sellerProfile?.company_name),
    Addr1: addr1 || cleanText(sellerProfile?.address_line1),
    Addr2: addr2 || cleanText(sellerProfile?.address_line2),
    Loc: cleanText(sellerProfile?.city),
    Pin: fromPin,
    Stcd: cleanText(sellerProfile?.state_code) || deriveStateCode(sellerProfile?.gstin),
  };
}

function buildShipDtls(dispatch, buyerDtls) {
  const shipGstin = cleanText(dispatch?.ship_to_gstin);
  const buyerGstin = cleanText(buyerDtls?.Gstin);
  if (!shipGstin || !buyerGstin || shipGstin.toUpperCase() === buyerGstin.toUpperCase()) return null;
  const { addr1, addr2 } = splitAddress(dispatch?.ship_to_address || dispatch?.consignee_address || "");
  const pinMatch = cleanText(dispatch?.ship_to_address).match(/\b(\d{6})\b/);
  return {
    Gstin: shipGstin,
    LglNm: cleanText(dispatch?.ship_to_name) || cleanText(dispatch?.consignee_name),
    TrdNm: cleanText(dispatch?.ship_to_name) || cleanText(dispatch?.consignee_name),
    Addr1: addr1,
    Addr2: addr2,
    Loc: "",
    Pin: pinMatch ? Number(pinMatch[1]) : 0,
    Stcd: deriveStateCode(shipGstin),
  };
}

/**
 * Build a NIC-schema-1.1-ish e-invoice request payload from Josh invoice fields.
 * @param {object} params
 * @param {object} params.invoice - customer_invoices row (joined header, e.g. from getInvoiceHeaderOrNull)
 * @param {Array}  params.lines - invoice_lines rows
 * @param {object} params.sellerProfile - seller/company profile (enrichCompanyProfileAssets shape)
 * @param {object} [params.dispatch] - dispatch row (transporter/vehicle info), optional
 * @param {object} [params.buyer] - customers row for extra buyer fields not on invoice header, optional
 */
function buildEinvoicePayload({ invoice, lines, sellerProfile, dispatch, buyer }) {
  if (!invoice) throw new Error("INVOICE_REQUIRED");
  const taxMode = inferTaxMode(sellerProfile, invoice);
  const itemList = buildItemList(lines, taxMode);
  const buyerDtls = buildBuyerDtls(invoice, buyer);
  const payload = {
    Version: "1.1",
    TranDtls: buildTranDtls(),
    DocDtls: buildDocDtls(invoice),
    SellerDtls: buildSellerDtls(sellerProfile),
    BuyerDtls: buyerDtls,
    ItemList: itemList,
    ValDtls: buildValDtls(itemList, invoice),
  };
  const ewb = buildEwbDtls(dispatch);
  if (ewb) payload.EwbDtls = ewb;
  const disp = buildDispDtls(sellerProfile, dispatch);
  if (disp) payload.DispDtls = disp;
  const ship = buildShipDtls(dispatch, buyerDtls);
  if (ship) payload.ShipDtls = ship;
  return payload;
}

module.exports = {
  buildEinvoicePayload,
  inferTaxMode,
  buildEwbDtls,
};
