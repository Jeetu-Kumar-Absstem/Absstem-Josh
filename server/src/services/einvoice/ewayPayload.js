/**
 * Build NIC-style e-way bill request payloads for MasterGST GSP.
 * Prefer IRN-based generate when invoice.irn is present.
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
  const match = text.match(/^(\d{2})/);
  return match ? Number(match[1]) : 0;
}

function fmtNicDate(value) {
  const dt = value ? new Date(value) : new Date();
  if (Number.isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function pincode(value) {
  const digits = cleanText(value).replace(/\D/g, "").slice(0, 6);
  const n = Number(digits);
  return Number.isFinite(n) && digits.length === 6 ? n : 0;
}

function splitAddress(value, maxLen = 100) {
  const text = cleanText(value);
  if (!text) return { addr1: "NA", addr2: "" };
  if (text.length <= maxLen) return { addr1: text, addr2: "" };
  return { addr1: text.slice(0, maxLen), addr2: text.slice(maxLen, maxLen * 2) };
}

function goodsLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter((line) => !cleanText(line?.charge_kind));
}

function buildItemList(lines) {
  return goodsLines(lines).map((line, idx) => {
    const qty = num(line.qty);
    const taxable = round2(line.line_total_invoice ?? qty * num(line.unit_price_invoice));
    const gstPct = num(line.gst_pct);
    return {
      productName: cleanText(line.item_name) || cleanText(line.line_description) || "Item",
      productDesc: cleanText(line.line_description) || cleanText(line.item_name) || "Item",
      hsnCode: cleanText(line.hsn_no) || "00",
      quantity: qty,
      qtyUnit: cleanText(line.uom) || "NOS",
      cgstRate: round2(gstPct / 2),
      sgstRate: round2(gstPct / 2),
      igstRate: 0,
      cessRate: 0,
      taxableAmount: taxable,
    };
  });
}

function buildPartB(dispatch) {
  const mode = normalizeTransportMode(dispatch?.transport_mode) || "road";
  const distance = Math.max(1, Math.round(num(dispatch?.approx_distance_km)));
  return {
    transMode: toNicTransMode(mode) || "1",
    transDistance: String(distance),
    transporterId: cleanText(dispatch?.transporter_id) || undefined,
    transporterName: cleanText(dispatch?.transporter_name) || undefined,
    transDocNo: cleanText(dispatch?.lr_no) || undefined,
    transDocDate: dispatch?.lr_date ? fmtNicDate(dispatch.lr_date) : undefined,
    vehicleNo: cleanText(dispatch?.vehicle_no) || undefined,
    vehicleType: mode === "road" ? cleanText(dispatch?.vehicle_type).toUpperCase() || "R" : undefined,
  };
}

/**
 * IRN-based e-way generate body (preferred when IRN exists).
 */
function buildEwayByIrnPayload({ invoice, dispatch }) {
  const irn = cleanText(invoice?.irn);
  if (!irn) return null;
  const partB = buildPartB(dispatch);
  return {
    Irn: irn,
    Distance: Number(partB.transDistance) || 0,
    TransMode: partB.transMode,
    TransId: partB.transporterId,
    TransName: partB.transporterName,
    TransDocNo: partB.transDocNo,
    TransDocDt: partB.transDocDate,
    VehNo: partB.vehicleNo,
    VehType: partB.vehicleType,
  };
}

/**
 * Full GENEWAYBILL Part A + Part B from invoice + dispatch + seller profile.
 */
function buildEwayGeneratePayload({ invoice, lines, sellerProfile, dispatch, buyer }) {
  const byIrn = buildEwayByIrnPayload({ invoice, dispatch });
  if (byIrn) return { mode: "irn", payload: byIrn };

  const fromAddr = splitAddress(sellerProfile?.address_line1 || sellerProfile?.address || "");
  const toAddrRaw =
    cleanText(dispatch?.ship_to_address) ||
    cleanText(invoice?.bill_to_address) ||
    [invoice?.address_line1, invoice?.address_line2, invoice?.city, invoice?.state, invoice?.pincode]
      .filter(Boolean)
      .join(", ");
  const toAddr = splitAddress(toAddrRaw);
  const fromGstin = cleanText(sellerProfile?.gstin);
  const toGstin =
    cleanText(dispatch?.ship_to_gstin) ||
    cleanText(invoice?.customer_gstin) ||
    cleanText(buyer?.gstin);
  const fromPin = pincode(dispatch?.dispatch_from_pincode) || pincode(sellerProfile?.pincode);
  const toPin = pincode(invoice?.customer_pincode) || pincode(buyer?.pincode) || fromPin;
  const fromState = deriveStateCode(fromGstin) || Number(cleanText(sellerProfile?.state_code)) || 0;
  const toState = deriveStateCode(toGstin) || fromState;
  const partB = buildPartB(dispatch);
  const items = buildItemList(lines);
  const totalValue = round2(items.reduce((sum, item) => sum + num(item.taxableAmount), 0));
  const cgst = round2(items.reduce((sum, item) => sum + (num(item.taxableAmount) * num(item.cgstRate)) / 100, 0));
  const sgst = round2(items.reduce((sum, item) => sum + (num(item.taxableAmount) * num(item.sgstRate)) / 100, 0));

  const payload = {
    supplyType: "O",
    subSupplyType: "1",
    subSupplyDesc: "",
    docType: "INV",
    docNo: cleanText(invoice?.invoice_number),
    docDate: fmtNicDate(invoice?.invoice_date),
    fromGstin: fromGstin,
    fromTrdName: cleanText(sellerProfile?.company_name),
    fromAddr1: fromAddr.addr1,
    fromAddr2: fromAddr.addr2,
    fromPlace: cleanText(sellerProfile?.city) || "NA",
    fromPincode: fromPin,
    actFromStateCode: fromState,
    fromStateCode: fromState,
    toGstin: toGstin || "URP",
    toTrdName: cleanText(invoice?.bill_to_name) || cleanText(invoice?.customer_name) || cleanText(buyer?.customer_name),
    toAddr1: toAddr.addr1,
    toAddr2: toAddr.addr2,
    toPlace: cleanText(invoice?.customer_city) || cleanText(buyer?.city) || "NA",
    toPincode: toPin,
    actToStateCode: toState,
    toStateCode: toState,
    transactionType: 1,
    otherValue: 0,
    totalValue,
    cgstValue: fromState === toState ? cgst : 0,
    sgstValue: fromState === toState ? sgst : 0,
    igstValue: fromState === toState ? 0 : round2(cgst + sgst),
    cessValue: 0,
    totInvValue: round2(num(invoice?.grand_total_invoice) || totalValue + cgst + sgst),
    ...partB,
    itemList: items,
  };

  return { mode: "full", payload };
}

function buildEwayCancelPayload({ ewayBillNo, reasonCode = "2", remark = "Cancelled from Josh ERP" }) {
  return {
    ewbNo: Number(cleanText(ewayBillNo).replace(/\D/g, "")) || cleanText(ewayBillNo),
    cancelRsnCode: String(reasonCode || "2"),
    cancelRmrk: cleanText(remark).slice(0, 100) || "Cancelled",
  };
}

/**
 * Part B vehicle update (VEHEWB) payload after truck change.
 */
function buildEwayVehicleUpdatePayload({ dispatch, reasonCode = "1", remark = "Vehicle changed" } = {}) {
  const ewbNo = Number(cleanText(dispatch?.eway_bill_no).replace(/\D/g, "")) || cleanText(dispatch?.eway_bill_no);
  const partB = buildPartB(dispatch);
  const fromPin = pincode(dispatch?.dispatch_from_pincode);
  const fromState =
    deriveStateCode(dispatch?.ship_to_gstin) ||
    (fromPin ? Number(String(fromPin).slice(0, 2)) : 0) ||
    0;
  return {
    ewbNo,
    vehicleNo: partB.vehicleNo,
    fromPlace: cleanText(dispatch?.dispatch_from_place) || cleanText(dispatch?.from_place) || "NA",
    fromState: fromState || undefined,
    reasonCode: String(reasonCode || "1"),
    reasonRem: cleanText(remark).slice(0, 50) || "Vehicle changed",
    transMode: partB.transMode,
    vehicleType: partB.vehicleType || "R",
    transDocNo: partB.transDocNo,
    transDocDate: partB.transDocDate,
  };
}

module.exports = {
  buildEwayByIrnPayload,
  buildEwayGeneratePayload,
  buildEwayCancelPayload,
  buildEwayVehicleUpdatePayload,
  buildPartB,
  fmtNicDate,
};
