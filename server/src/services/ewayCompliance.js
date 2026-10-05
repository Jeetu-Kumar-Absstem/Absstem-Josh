/**
 * Soft e-way bill compliance helpers (Rule 138 threshold advisory).
 * Never hard-blocks dispatch status transitions — callers must keep blocking: false.
 */

const EWAY_THRESHOLD_INR = 50000;

const TRANSPORT_MODES = ["road", "rail", "air", "ship"];

const NIC_TRANS_MODE = {
  road: "1",
  rail: "2",
  air: "3",
  ship: "4",
};

function cleanText(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Math.round(num(value) * 100) / 100;
}

function normalizeTransportMode(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = cleanText(value).toLowerCase();
  if (TRANSPORT_MODES.includes(raw)) return raw;
  if (raw === "1" || Number(value) === 1) return "road";
  if (raw === "2" || Number(value) === 2) return "rail";
  if (raw === "3" || Number(value) === 3) return "air";
  if (raw === "4" || Number(value) === 4) return "ship";
  return null;
}

function toNicTransMode(mode) {
  const normalized = normalizeTransportMode(mode);
  return normalized ? NIC_TRANS_MODE[normalized] : undefined;
}

function deriveStateCodeFromGstin(gstin) {
  const text = cleanText(gstin);
  const match = text.match(/^(\d{2})/);
  return match ? match[1] : "";
}

function normalizeStateName(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z]/g, "");
}

function isInterstate({ sellerStateCode, shipToGstin, buyerGstin, sellerState, buyerState }) {
  const sellerCode = cleanText(sellerStateCode);
  const buyerCode =
    deriveStateCodeFromGstin(shipToGstin) ||
    deriveStateCodeFromGstin(buyerGstin) ||
    "";
  if (sellerCode && buyerCode) return sellerCode !== buyerCode;
  const seller = normalizeStateName(sellerState);
  const buyer = normalizeStateName(buyerState);
  if (seller && buyer) return seller !== buyer;
  return true;
}

/**
 * Prefer invoice INR total (includes billed P&F/freight charge lines).
 * Else prorate SO total by dispatched qty; else full SO total.
 */
function computeConsignmentValue({
  invoiceGrandTotalBase,
  salesOrderGrandTotalBase,
  qtyDispatched,
  qtyOrdered,
}) {
  const invoiceTotal = money(invoiceGrandTotalBase);
  if (invoiceGrandTotalBase !== null && invoiceGrandTotalBase !== undefined && Number.isFinite(Number(invoiceGrandTotalBase))) {
    return { value: invoiceTotal, basis: "invoice" };
  }

  const soTotal = money(salesOrderGrandTotalBase);
  const ordered = num(qtyOrdered);
  const dispatched = num(qtyDispatched);
  if (soTotal > 0 && ordered > 0 && dispatched > 0 && dispatched < ordered) {
    return {
      value: money(soTotal * (dispatched / ordered)),
      basis: "sales_order_prorated",
    };
  }
  return { value: soTotal, basis: "sales_order" };
}

function isValidEwayBillNo(value) {
  return /^[0-9]{12}$/.test(cleanText(value).replace(/\s+/g, ""));
}

function isValidTransporterId(value) {
  const text = cleanText(value).toUpperCase();
  return /^[0-9A-Z]{15}$/.test(text);
}

function pushWarning(warnings, code, message, field) {
  warnings.push({ code, message, field });
}

/**
 * Soft compliance evaluation. Always returns blocking: false.
 */
function evaluateEwayCompliance({
  dispatch,
  consignmentValue,
  consignmentValueBasis,
  isInterstate: interstateFlag,
  now = new Date(),
}) {
  const value = money(consignmentValue);
  const ewayRequired = value >= EWAY_THRESHOLD_INR;
  const status = cleanText(dispatch?.dispatch_status).toLowerCase();
  const mode = normalizeTransportMode(dispatch?.transport_mode);
  const ewayBillNo = cleanText(dispatch?.eway_bill_no).replace(/\s+/g, "");
  const ewayBillDate = dispatch?.eway_bill_date || null;
  const validTill = dispatch?.eway_valid_till ? new Date(dispatch.eway_valid_till) : null;
  const transporterId = cleanText(dispatch?.transporter_id);
  const transporterName = cleanText(dispatch?.transporter_name);
  const vehicleNo = cleanText(dispatch?.vehicle_no);
  const vehicleType = cleanText(dispatch?.vehicle_type).toUpperCase();
  const lrNo = cleanText(dispatch?.lr_no);
  const lrDate = dispatch?.lr_date || null;
  const distance = num(dispatch?.approx_distance_km);
  const shipToGstin = cleanText(dispatch?.ship_to_gstin);
  const fromPin = cleanText(dispatch?.dispatch_from_pincode);
  const warnings = [];

  if (ewayBillNo) {
    if (!isValidEwayBillNo(ewayBillNo)) {
      pushWarning(warnings, "EWAY_BILL_NO_INVALID", "E-way bill number must be 12 digits.", "eway_bill_no");
    }
  } else if (ewayRequired) {
    pushWarning(warnings, "EWAY_BILL_NO_MISSING", "E-way bill number is missing.", "eway_bill_no");
  }

  if (ewayBillNo && !ewayBillDate) {
    pushWarning(warnings, "EWAY_BILL_DATE_MISSING", "E-way bill date is missing.", "eway_bill_date");
  }

  if (validTill && !Number.isNaN(validTill.getTime()) && validTill < now && status !== "delivered") {
    pushWarning(warnings, "EWAY_EXPIRED", "E-way bill validity has expired.", "eway_valid_till");
  }

  if (!transporterId && !transporterName) {
    if (ewayRequired) {
      pushWarning(warnings, "TRANSPORTER_MISSING", "Transporter name or ID is required.", "transporter_id");
    }
  } else if (!transporterId) {
    if (ewayRequired) {
      pushWarning(warnings, "TRANSPORTER_ID_MISSING", "Transporter GSTIN / TRANSIN is missing for NIC TransId.", "transporter_id");
    }
  } else if (!isValidTransporterId(transporterId)) {
    pushWarning(warnings, "TRANSPORTER_ID_INVALID", "Transporter ID must be 15 alphanumeric characters.", "transporter_id");
  }

  if (!mode && ewayRequired) {
    pushWarning(warnings, "TRANSPORT_MODE_MISSING", "Transport mode is missing.", "transport_mode");
  }

  if (mode === "road") {
    if (!vehicleNo && ewayRequired) {
      pushWarning(warnings, "VEHICLE_NO_MISSING", "Vehicle number is required for road transport.", "vehicle_no");
    }
    if (!vehicleType && ewayRequired) {
      pushWarning(warnings, "VEHICLE_TYPE_MISSING", "Vehicle type (Regular / ODC) is missing.", "vehicle_type");
    }
  } else if (mode === "rail" || mode === "air" || mode === "ship") {
    if (!lrNo && ewayRequired) {
      pushWarning(warnings, "LR_NO_MISSING", "Transport document (LR / AWB / BL) is required for this mode.", "lr_no");
    }
    if (!lrDate && ewayRequired) {
      pushWarning(warnings, "LR_DATE_MISSING", "Transport document date is missing.", "lr_date");
    }
  }

  if ((distance <= 0 || dispatch?.approx_distance_km === null || dispatch?.approx_distance_km === undefined || dispatch?.approx_distance_km === "") && ewayRequired) {
    pushWarning(warnings, "DISTANCE_MISSING", "Approximate distance (km) is missing.", "approx_distance_km");
  }

  if (interstateFlag && !shipToGstin && ewayRequired) {
    pushWarning(warnings, "SHIP_TO_GSTIN_MISSING", "Ship-to GSTIN is missing for inter-state movement.", "ship_to_gstin");
  }

  if (!fromPin && ewayRequired) {
    pushWarning(warnings, "DISPATCH_FROM_PIN_MISSING", "Dispatch-from pincode is missing.", "dispatch_from_pincode");
  }

  const partBReady =
    Boolean(mode) &&
    (mode === "road" ? Boolean(vehicleNo) : Boolean(lrNo));

  const partAComplete =
    isValidEwayBillNo(ewayBillNo) &&
    Boolean(ewayBillDate) &&
    distance > 0 &&
    Boolean(transporterId || transporterName);

  const complete = partAComplete && partBReady;

  let severity = "none";
  if (ewayRequired && !complete) {
    severity = status === "draft" || status === "cancelled" ? "info" : "warning";
  } else if (warnings.some((w) => w.code === "EWAY_EXPIRED")) {
    severity = "warning";
  }

  return {
    eway_required: ewayRequired,
    threshold_inr: EWAY_THRESHOLD_INR,
    consignment_value: value,
    consignment_value_basis: consignmentValueBasis || "sales_order",
    is_interstate: Boolean(interstateFlag),
    part_a_complete: partAComplete,
    part_b_ready: partBReady,
    complete,
    severity,
    warnings,
    blocking: false,
  };
}

module.exports = {
  EWAY_THRESHOLD_INR,
  TRANSPORT_MODES,
  normalizeTransportMode,
  toNicTransMode,
  deriveStateCodeFromGstin,
  isInterstate,
  computeConsignmentValue,
  evaluateEwayCompliance,
  isValidEwayBillNo,
};
