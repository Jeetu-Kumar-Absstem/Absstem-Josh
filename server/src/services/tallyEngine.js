const { pool } = require("../db/pool");
const { money2, reconVariance, withinReconTolerance } = require("./tally/money");

function cleanString(val) {
  if (val === null || val === undefined) return "";
  return String(val).trim();
}

/** Tally uses control-char placeholders like "&#4; Not Applicable" for empty master fields. */
function isTallySentinelValue(val) {
  const s = cleanString(val)
    .replace(/\u0004/g, "")
    .replace(/&#4;/gi, "")
    .trim();
  if (!s) return true;
  return /^not applicable$/i.test(s) || /^n\/a$/i.test(s) || /^na$/i.test(s) || /^none$/i.test(s);
}

function normalizeTallyTextField(val) {
  const s = cleanString(val);
  if (!s || isTallySentinelValue(s)) return null;
  return s;
}

function normalizeKey(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Standard Levenshtein / Dice Coefficient fuzzy string similarity (0.0 to 1.0)
 */
function calculateSimilarity(str1, str2) {
  const s1 = normalizeKey(str1);
  const s2 = normalizeKey(str2);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) {
    const ratio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
    return Math.max(0.80, ratio);
  }

  // Bigram Dice coefficient
  const getBigrams = (str) => {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.substring(i, i + 2));
    }
    return bigrams;
  };

  const bg1 = getBigrams(s1);
  const bg2 = getBigrams(s2);
  let intersection = 0;
  for (const b of bg1) {
    if (bg2.has(b)) intersection++;
  }

  const total = bg1.size + bg2.size;
  if (total === 0) return 0;
  return (2.0 * intersection) / total;
}

function parseTallyNumber(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  const cleaned = String(val).replace(/,/g, "").trim();
  let sign = 1;
  let text = cleaned;
  if (text.startsWith("(") && text.endsWith(")")) {
    sign = -1;
    text = text.slice(1, -1);
  } else if (text.endsWith("Dr") || text.endsWith("DR") || text.endsWith("dr")) {
    text = text.replace(/dr/i, "").trim();
  } else if (text.endsWith("Cr") || text.endsWith("CR") || text.endsWith("cr")) {
    sign = -1;
    text = text.replace(/cr/i, "").trim();
  }
  const parsed = parseFloat(text);
  if (Number.isNaN(parsed)) return 0;
  return parsed * sign;
}

function parseTallyQty(qtyText) {
  if (!qtyText) return 1;
  const match = String(qtyText).match(/-?[\d,.]+/);
  if (!match) return 1;
  return Math.abs(parseTallyNumber(match[0])) || 1;
}

function parseTallyUom(qtyText) {
  if (!qtyText) return "NOS";
  const parts = String(qtyText).trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : "NOS";
}

function isTallySalesVoucher(voucherType) {
  const vType = String(voucherType || "").toLowerCase();
  return vType.includes("sale") || vType.includes("invoice") || vType.includes("credit note");
}

function isTallyReceiptVoucher(voucherType) {
  const vType = String(voucherType || "").toLowerCase();
  return vType.includes("receipt");
}

function extractPaymentModeFromEntries(entries = [], partyName = "") {
  const partyKey = normalizeKey(partyName);
  for (const entry of entries) {
    const name = String(entry.ledger_name || "");
    const key = normalizeKey(name);
    if (partyKey && key === partyKey) continue;
    const lower = name.toLowerCase();
    if (
      lower.includes("bank") ||
      lower.includes("cash") ||
      lower.includes("neft") ||
      lower.includes("rtgs") ||
      lower.includes("upi") ||
      lower.includes("cheque") ||
      lower.includes("imps")
    ) {
      return name;
    }
  }
  return "Bank Transfer";
}

function isOutputTaxLedgerName(name) {
  const lower = String(name || "").toLowerCase();
  return (
    lower.includes("cgst") ||
    lower.includes("sgst") ||
    lower.includes("igst") ||
    lower.includes("output gst") ||
    lower.includes("gst output")
  );
}

function extractTaxFromLedgerEntries(entries = []) {
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  for (const entry of entries) {
    const name = String(entry.ledger_name || "").toLowerCase();
    const amt = Math.abs(parseTallyNumber(entry.amount || 0));
    if (name.includes("cgst")) cgst += amt;
    else if (name.includes("sgst")) sgst += amt;
    else if (name.includes("igst")) igst += amt;
  }
  return { cgst, sgst, igst, taxTotal: money2(cgst + sgst + igst) };
}

function isAncillaryChargeLedgerName(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower || isOutputTaxLedgerName(lower)) return false;
  // Primary sales ledgers mirror inventory totals — do not add them as extra lines.
  if (
    (lower.includes("sales") || lower.includes("sale of") || lower === "sales accounts") &&
    !lower.includes("service")
  ) {
    return false;
  }
  return (
    lower.includes("freight") ||
    lower.includes("packing") ||
    lower.includes("forward") ||
    lower.includes("transport") ||
    lower.includes("insurance") ||
    lower.includes("service charge") ||
    lower.includes("service charges") ||
    lower.includes("installation") ||
    lower.includes("handling") ||
    lower.includes("loading") ||
    lower.includes("unloading") ||
    lower.includes("courier") ||
    lower.includes("shipping") ||
    lower.includes("misc")
  );
}

/** Non-party, non-tax ledgers that carry taxable/service/freight value on sales vouchers. */
function extractNonTaxChargeEntries(entries = [], { partyName = "", partyAmount = 0, ancillaryOnly = false } = {}) {
  const partyLower = String(partyName || "").toLowerCase().trim();
  const charges = [];
  for (const entry of entries) {
    const name = String(entry.ledger_name || "").trim();
    if (!name || isOutputTaxLedgerName(name)) continue;
    const amt = money2(Math.abs(parseTallyNumber(entry.amount || 0)));
    if (amt <= 0) continue;
    const lower = name.toLowerCase();
    if (partyLower && lower === partyLower) continue;
    if (partyAmount > 0 && Math.abs(amt - partyAmount) < 0.05) continue;
    if (
      lower.includes("sundry debtor") ||
      lower.includes("debtors") ||
      lower.includes("bank") ||
      lower.includes("cash") ||
      lower.includes("round off") ||
      lower.includes("round-off")
    ) {
      continue;
    }
    if (ancillaryOnly && !isAncillaryChargeLedgerName(name)) continue;
    if (!ancillaryOnly) {
      // Empty-inventory path: skip pure sales mirrors; keep service / income / charge ledgers.
      if (
        (lower.includes("sales") || lower.includes("sale of")) &&
        !lower.includes("service") &&
        !isAncillaryChargeLedgerName(name)
      ) {
        continue;
      }
    }
    charges.push({ ledger_name: name, amount: amt });
  }
  return charges;
}

function parseTallyDateIso(dateStr) {
  if (!dateStr) return new Date().toISOString().slice(0, 10);
  const str = String(dateStr).trim();
  const raw = str.replace(/[-/]/g, "");
  if (/^\d{8}$/.test(raw)) {
    const yyyy = raw.slice(0, 4);
    const mm = raw.slice(4, 6);
    const dd = raw.slice(6, 8);
    return `${yyyy}-${mm}-${dd}`;
  }
  // DD-Mon-YYYY or DD-Mon-YY (e.g. 1-Apr-2024, 31-Mar-24)
  const monthNames = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const monMatch = str.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
  if (monMatch) {
    const dd = monMatch[1].padStart(2, "0");
    const mm = monthNames[monMatch[2].toLowerCase()] || "01";
    let yyyy = monMatch[3];
    if (yyyy.length === 2) {
      yyyy = Number(yyyy) >= 70 ? `19${yyyy}` : `20${yyyy}`;
    }
    return `${yyyy}-${mm}-${dd}`;
  }
  // DD/MM/YYYY or DD-MM-YYYY
  const ddmmyyyyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (ddmmyyyyMatch) {
    const dd = ddmmyyyyMatch[1].padStart(2, "0");
    const mm = ddmmyyyyMatch[2].padStart(2, "0");
    const yyyy = ddmmyyyyMatch[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.slice(0, 10);
  }
  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function extractXmlListBlocks(body, listTag) {
  if (!body) return [];
  const escaped = listTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "gi");
  const blocks = [];
  for (const match of body.matchAll(regex)) {
    const inner = String(match[1] || "").trim();
    if (inner) blocks.push(inner);
  }
  return blocks;
}

function parseGstRateFromInventoryXml(inventoryBody) {
  if (!inventoryBody) return 18;
  let igst = 0;
  let cgst = 0;
  let sgst = 0;
  for (const match of inventoryBody.matchAll(/<RATEDETAILS\.LIST[^>]*>([\s\S]*?)<\/RATEDETAILS\.LIST>/gi)) {
    const block = match[1];
    const head = String(extractXmlTagContent(block, "GSTRATEDUTYHEAD") || "").toUpperCase();
    const rate = Math.abs(parseTallyNumber(extractXmlTagContent(block, "GSTRATE") || 0));
    if (head.includes("IGST")) igst = rate;
    else if (head.includes("CGST")) cgst = rate;
    else if (head.includes("SGST")) sgst = rate;
  }
  if (igst > 0) return igst;
  if (cgst > 0 && sgst > 0) return cgst + sgst;
  if (cgst > 0) return cgst * 2;
  return 18;
}

function extractCustomerPartCodeFromInventory(source) {
  if (typeof source === "string") {
    for (const block of extractXmlListBlocks(source, "BASICUSERDESCRIPTION.LIST")) {
      const desc = extractXmlTagContent(block, "BASICUSERDESCRIPTION");
      if (desc && cleanString(desc)) return cleanString(desc);
    }
    const inline = extractXmlTagContent(source, "BASICUSERDESCRIPTION");
    if (inline && cleanString(inline)) return cleanString(inline);
    return null;
  }
  const obj = source && typeof source === "object" ? source : {};
  const fromList = Array.isArray(obj.basic_user_descriptions)
    ? obj.basic_user_descriptions.map((row) => cleanString(row)).find(Boolean)
    : null;
  return fromList || cleanString(obj.customer_item_code) || null;
}

function extractBillAllocationsFromLedgerBlock(ledgerBody) {
  if (!ledgerBody) return [];
  const rows = [];
  for (const block of extractXmlListBlocks(ledgerBody, "BILLALLOCATIONS.LIST")) {
    const invoiceNumber = cleanString(extractXmlTagContent(block, "NAME"));
    const billType = cleanString(extractXmlTagContent(block, "BILLTYPE"));
    const amount = Math.abs(parseTallyNumber(extractXmlTagContent(block, "AMOUNT") || 0));
    if (!invoiceNumber && !amount) continue;
    rows.push({
      invoice_number: invoiceNumber || null,
      bill_type: billType || null,
      amount,
    });
  }
  return rows;
}

function extractBillAllocationsFromVoucherSource(source = {}) {
  if (typeof source === "string") {
    const rows = [];
    const ledgerPatterns = [
      /<(?:ALLLEDGERENTRIES\.LIST|LEDGERENTRIES\.LIST)[^>]*>([\s\S]*?)<\/(?:ALLLEDGERENTRIES\.LIST|LEDGERENTRIES\.LIST)>/gi,
    ];
    for (const pattern of ledgerPatterns) {
      for (const match of source.matchAll(pattern)) {
        rows.push(...extractBillAllocationsFromLedgerBlock(match[1]));
      }
    }
    return rows;
  }
  const obj = source && typeof source === "object" ? source : {};
  if (Array.isArray(obj.bill_allocations)) return obj.bill_allocations;
  const fromEntries = [];
  for (const entry of obj.entries || []) {
    for (const row of entry.bill_allocations || []) fromEntries.push(row);
  }
  return fromEntries;
}

function extractTallyEinvoiceFields(source = {}) {
  const body = typeof source === "string" ? source : "";
  const obj = typeof source === "object" && source ? source : {};
  const pick = (...keys) => {
    for (const key of keys) {
      const xmlVal = body ? extractXmlTagContent(body, key) : null;
      if (xmlVal && cleanString(xmlVal)) return cleanString(xmlVal);
      for (const candidate of [key, key.toLowerCase()]) {
        const jsonVal = obj[candidate];
        if (jsonVal && cleanString(jsonVal)) return cleanString(jsonVal);
      }
    }
    return "";
  };

  const irn = pick("IRN", "irn");
  const irnAckNo = pick("IRNACKNO", "irn_ack_no");
  const irnAckDateRaw = pick("IRNACKDATE", "IRNACKUPDATEDATETIME", "irn_ack_date");
  const signedQr = pick("IRNQRCODE", "signed_qr_code");
  const cancelledRaw = pick("IRNCANCELLED", "irn_cancelled");
  const cancelled = String(cancelledRaw || "").toLowerCase() === "yes";

  let einvoiceStatus = "none";
  if (irn && cancelled) einvoiceStatus = "cancelled";
  else if (irn) einvoiceStatus = "generated";

  return {
    irn: irn || null,
    irn_ack_no: irnAckNo || null,
    irn_ack_date: irnAckDateRaw ? parseTallyDateIso(irnAckDateRaw) : null,
    signed_qr_code: signedQr || null,
    einvoice_status: einvoiceStatus,
    einvoice_mode: irn ? "manual" : null,
    einvoice_provider: irn ? pick("IRNIRPSOURCE", "irn_irp_source") || "NIC" : null,
  };
}

function extractTallyEwayFields(source = {}) {
  const body = typeof source === "string" ? source : "";
  const obj = typeof source === "object" && source ? source : {};
  const blocks =
    typeof body === "string" && body
      ? extractXmlListBlocks(body, "EWAYBILLDETAILS.LIST")
      : Array.isArray(obj.eway_bill_details)
        ? obj.eway_bill_details
        : [];

  for (const block of blocks) {
    const blockText = typeof block === "string" ? block : "";
    const billNumber = cleanString(
      (blockText ? extractXmlTagContent(blockText, "BILLNUMBER") : null) ||
        (blockText ? extractXmlTagContent(blockText, "EWAYBILLNUMBER") : null) ||
        obj.eway_bill_no
    );
    if (!billNumber) continue;
    const billDateRaw =
      (blockText ? extractXmlTagContent(blockText, "BILLDATE") : null) ||
      (blockText ? extractXmlTagContent(blockText, "EWAYBILLDATE") : null) ||
      obj.eway_bill_date;
    const validTillRaw =
      (blockText ? extractXmlTagContent(blockText, "VALIDUPTO") : null) ||
      (blockText ? extractXmlTagContent(blockText, "VALIDTILL") : null) ||
      obj.eway_valid_till;
    return {
      eway_bill_no: billNumber,
      eway_bill_date: billDateRaw ? parseTallyDateIso(billDateRaw) : null,
      eway_valid_till: validTillRaw ? parseTallyDateIso(validTillRaw) : null,
    };
  }

  return {
    eway_bill_no: null,
    eway_bill_date: null,
    eway_valid_till: null,
  };
}

function extractTallyCustomerOrderFields(source = {}) {
  const body = typeof source === "string" ? source : "";
  const obj = typeof source === "object" && source ? source : {};

  if (body) {
    for (const block of extractXmlListBlocks(body, "INVOICEORDERLIST.LIST")) {
      const poNumber = normalizeTallyTextField(extractXmlTagContent(block, "BASICPURCHASEORDERNO"));
      const poDateRaw = extractXmlTagContent(block, "BASICORDERDATE");
      if (poNumber) {
        return {
          customer_po_number: poNumber,
          customer_po_date: poDateRaw ? parseTallyDateIso(poDateRaw) : null,
        };
      }
    }
  }

  if (obj.invoice_order && typeof obj.invoice_order === "object") {
    const poNumber = normalizeTallyTextField(
      obj.invoice_order.customer_po_number || obj.invoice_order.basic_purchase_order_no
    );
    const poDate = obj.invoice_order.customer_po_date || obj.invoice_order.basic_order_date || null;
    if (poNumber) {
      return {
        customer_po_number: poNumber,
        customer_po_date: poDate ? parseTallyDateIso(poDate) : null,
      };
    }
  }

  const pick = (...keys) => {
    for (const key of keys) {
      const xmlVal = body ? extractXmlTagContent(body, key) : null;
      if (xmlVal && cleanString(xmlVal)) return cleanString(xmlVal);
      for (const candidate of [key, key.toLowerCase()]) {
        const jsonVal = obj[candidate];
        if (jsonVal && cleanString(jsonVal)) return cleanString(jsonVal);
      }
    }
    return "";
  };

  const orderNo = normalizeTallyTextField(
    pick(
      "BASICPURCHASEORDERNO",
      "BASICORDERREF",
      "ORDERNO",
      "ORDERNUMBER",
      "PARTYORDERNO",
      "BUYERSORDERNO",
      "BUYERORDERNO",
      "ORDERREFERENCENO",
      "PURCHASEORDERNO",
      "PO_NUMBER",
      "customer_po_number",
      "order_no",
      "po_number"
    )
  );
  const orderDateRaw = pick(
    "BASICORDERDATE",
    "BUYERORDERREFERENCEDATE",
    "ORDERREFERENCEDATE",
    "ORDERDUEDATE",
    "PODATE",
    "customer_po_date",
    "order_date",
    "po_date"
  );
  const orderDate = orderDateRaw ? parseTallyDateIso(orderDateRaw) : null;
  return {
    customer_po_number: orderNo,
    customer_po_date: orderDate,
  };
}

function extractTallyVoucherMeta(source = {}) {
  const body = typeof source === "string" ? source : "";
  const obj = typeof source === "object" && source ? source : {};
  const partyGstin =
    (body ? cleanString(extractXmlTagContent(body, "PARTYGSTIN") || "") : "") ||
    cleanString(obj.party_gstin || obj.PARTYGSTIN || "").toUpperCase();
  return {
    party_gstin: partyGstin || null,
    place_of_supply:
      (body ? cleanString(extractXmlTagContent(body, "PLACEOFSUPPLY") || "") : "") ||
      cleanString(obj.place_of_supply || "") ||
      null,
    tally_guid: (body ? cleanString(extractXmlTagContent(body, "GUID") || "") : "") || cleanString(obj.tally_guid || "") || null,
    bill_allocations: extractBillAllocationsFromVoucherSource(source),
    ...extractTallyEinvoiceFields(source),
    ...extractTallyEwayFields(source),
    ...extractTallyCustomerOrderFields(source),
  };
}

function extractXmlTagContent(xmlChunk, tagName) {
  if (!xmlChunk) return null;
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<(?:${escaped})(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i");
  const match = xmlChunk.match(regex);
  return match ? match[1].trim() : null;
}

function extractXmlAttribute(xmlChunk, attrName) {
  if (!xmlChunk) return null;
  const regex = new RegExp(`${attrName}="([^"]*)"`, "i");
  const match = xmlChunk.match(regex);
  return match ? match[1].trim() : null;
}

function decodeTallyBuffer(rawBufferOrString) {
  if (typeof rawBufferOrString === "string") {
    return rawBufferOrString.charCodeAt(0) === 0xfeff ? rawBufferOrString.slice(1) : rawBufferOrString;
  }
  if (!Buffer.isBuffer(rawBufferOrString)) {
    return String(rawBufferOrString || "");
  }
  const buf = rawBufferOrString;
  // UTF-16 LE BOM (0xFF 0xFE)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").replace(/^\ufeff/, "");
  }
  // UTF-16 BE BOM (0xFE 0xFF)
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.swap16().toString("utf16le").replace(/^\ufeff/, "");
  }
  // UTF-8 BOM (0xEF 0xBB 0xBF)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").replace(/^\ufeff/, "");
  }
  // UTF-16 BE BOM
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.toString("utf16be").replace(/^\ufeff/, "");
  }
  // Heuristic for UTF-16LE without BOM (ASCII characters interleaved with null \0 bytes)
  if (buf.length >= 8 && buf[1] === 0x00 && buf[3] === 0x00 && buf[5] === 0x00) {
    return buf.toString("utf16le").replace(/^\ufeff/, "");
  }
  return buf.toString("utf8").replace(/^\ufeff/, "");
}

/**
 * Universal XML / JSON Tally Parser
 */
function parseTallyData(rawBufferOrString, fileName = "") {
  const text = decodeTallyBuffer(rawBufferOrString);
  const isJson = fileName.endsWith(".json") || text.trim().startsWith("{") || text.trim().startsWith("[");

  if (isJson) {
    try {
      const parsed = JSON.parse(text);
      return normalizeJsonTally(parsed);
    } catch (err) {
      throw new Error(`JSON_PARSE_ERROR: Invalid JSON file format - ${err.message}`);
    }
  }

  return parseXmlTally(text);
}

function normalizeJsonTally(jsonObj) {
  const root = Array.isArray(jsonObj) ? { vouchers: jsonObj } : jsonObj;
  const companyInfo = root.company || root.company_info || root.COMPANY || {};
  const tallyCompanyName = cleanString(companyInfo.name || companyInfo.company_name || root.company_name || "");
  const tallyGstin = cleanString(companyInfo.gstin || companyInfo.GSTIN || root.gstin || "").toUpperCase();

  const masters = root.masters || {};
  const ledgersRaw = masters.ledgers || root.ledgers || [];
  const stockItemsRaw = masters.stock_items || masters.stockItems || root.stock_items || root.stockItems || [];
  const vouchersRaw = root.vouchers || root.transactions || [];

  const ledgers = ledgersRaw.map((l) => ({
    name: cleanString(l.name || l.ledger_name || l.LEDGERNAME),
    parent: cleanString(l.parent || l.parent_group || l.PARENT || "Sundry Debtors"),
    opening_balance: parseTallyNumber(l.opening_balance || l.OPENINGBALANCE || 0),
    balance_type: cleanString(l.balance_type || (parseTallyNumber(l.opening_balance) < 0 ? "Dr" : "Cr")),
    gstin: cleanString(l.gstin || l.GSTIN || l.gst_no || "").toUpperCase(),
    pan: cleanString(l.pan || l.PAN || l.pan_no || "").toUpperCase(),
    address: cleanString(l.address || l.ADDRESS || ""),
    contact_person: cleanString(l.contact_person || l.contact || ""),
    email: cleanString(l.email || l.contact_email || ""),
    phone: cleanString(l.phone || l.mobile || ""),
  })).filter((l) => l.name.length > 0);

  const stock_items = stockItemsRaw.map((s) => ({
    name: cleanString(s.name || s.item_name || s.item_code || s.STOCKITEMNAME),
    item_code: cleanString(s.item_code || s.sku || s.name || s.STOCKITEMNAME),
    parent: cleanString(s.parent || s.category || s.PARENT || "Finished Goods"),
    uom: cleanString(s.uom || s.base_units || s.BASEUNITS || "NOS"),
    hsn_code: cleanString(s.hsn_code || s.hsn_no || s.HSNCODE || ""),
    standard_cost: parseTallyNumber(s.standard_cost || s.cost || 0),
    selling_price: parseTallyNumber(s.selling_price || s.list_price || s.rate || 0),
    opening_qty: parseTallyNumber(s.opening_qty || s.qty || 0),
    opening_value: parseTallyNumber(s.opening_value || s.value || 0),
    gst_pct: parseTallyNumber(s.gst_pct || 18),
  })).filter((s) => s.name.length > 0);

  const vouchers = vouchersRaw.map((v) => ({
    voucher_type: cleanString(v.voucher_type || v.vch_type || v.VCHTYPE || "Sales"),
    voucher_number: cleanString(v.voucher_number || v.vch_number || v.VOUCHERNUMBER || `VCH-${Date.now()}`),
    date: parseTallyDateIso(v.date || v.DATE),
    party_name: cleanString(v.party_name || v.party_ledger_name || v.PARTYLEDGERNAME || ""),
    amount: Math.abs(parseTallyNumber(v.amount || v.total_amount || 0)),
    narration: cleanString(v.narration || v.NARRATION || ""),
    ...extractTallyVoucherMeta(v),
    inventory_entries: Array.isArray(v.inventory_entries)
      ? v.inventory_entries
      : Array.isArray(v.inventory_lines)
        ? v.inventory_lines
        : [],
    entries: Array.isArray(v.entries || v.ledger_entries)
      ? (v.entries || v.ledger_entries).map((e) => ({
          ledger_name: cleanString(e.ledger_name || e.name || e.LEDGERNAME),
          amount: Math.abs(parseTallyNumber(e.amount || e.AMOUNT || 0)),
          is_debit: Boolean(e.is_debit ?? (parseTallyNumber(e.amount) < 0 || String(e.is_deemed_positive).toLowerCase() === "yes")),
        }))
      : [],
  })).filter((v) => v.voucher_number.length > 0);

  return { tallyCompanyName, tallyGstin, ledgers, stock_items, vouchers };
}

function parseXmlTally(xmlText) {
  const ledgers = [];
  const stock_items = [];
  const vouchers = [];

  // Extract Company Name or GSTIN from Header if present
  const companyNameMatch = extractXmlTagContent(xmlText, "SVCURRENTCOMPANY") ||
                           extractXmlTagContent(xmlText, "COMPANY") ||
                           extractXmlTagContent(xmlText, "TALLYCOMPANYNAME") || "";
  const companyGstinMatch = extractXmlTagContent(xmlText, "COMPANYGSTIN") ||
                            extractXmlTagContent(xmlText, "GSTIN") || "";

  const tallyCompanyName = cleanString(companyNameMatch);
  const tallyGstin = cleanString(companyGstinMatch).toUpperCase();

  const ledgerMatches = xmlText.matchAll(/<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER>/gi);
  for (const match of ledgerMatches) {
    const attrChunk = match[1];
    const body = match[2];
    const name = extractXmlTagContent(body, "NAME") || extractXmlAttribute(attrChunk, "NAME");
    if (!name) continue;

    const parent = extractXmlTagContent(body, "PARENT") || "Sundry Debtors";
    const opBal = parseTallyNumber(extractXmlTagContent(body, "OPENINGBALANCE") || 0);
    const gstin = cleanString(extractXmlTagContent(body, "GSTIN") || extractXmlTagContent(body, "PARTYGSTIN") || "").toUpperCase();
    const pan = cleanString(extractXmlTagContent(body, "INCOMETAXNUMBER") || extractXmlTagContent(body, "PAN") || "").toUpperCase();
    const address = extractXmlTagContent(body, "ADDRESS") || "";

    ledgers.push({
      name: cleanString(name),
      parent: cleanString(parent),
      opening_balance: Math.abs(opBal),
      balance_type: opBal < 0 ? "Dr" : "Cr",
      gstin,
      pan,
      address: cleanString(address),
      contact_person: "",
      email: "",
      phone: "",
    });
  }

  const stockMatches = xmlText.matchAll(/<STOCKITEM\b([^>]*)>([\s\S]*?)<\/STOCKITEM>/gi);
  for (const match of stockMatches) {
    const attrChunk = match[1];
    const body = match[2];
    const name = extractXmlTagContent(body, "NAME") || extractXmlAttribute(attrChunk, "NAME");
    if (!name) continue;

    const parent = extractXmlTagContent(body, "PARENT") || "Finished Goods";
    const uom = extractXmlTagContent(body, "BASEUNITS") || "NOS";
    const hsnCode = extractXmlTagContent(body, "HSNCODE") || extractXmlTagContent(body, "HSN") || "";
    const opBalText = extractXmlTagContent(body, "OPENINGBALANCE") || "";
    const opVal = parseTallyNumber(extractXmlTagContent(body, "OPENINGVALUE") || 0);
    const stdCost = parseTallyNumber(extractXmlTagContent(body, "STANDARDCOST") || 0);
    const stdRate = parseTallyNumber(extractXmlTagContent(body, "STANDARDRATE") || 0);

    stock_items.push({
      name: cleanString(name),
      item_code: cleanString(name),
      parent: cleanString(parent),
      uom: cleanString(uom),
      hsn_code: cleanString(hsnCode),
      standard_cost: stdCost || Math.abs(opVal),
      selling_price: stdRate || (stdCost * 1.3),
      opening_qty: parseTallyNumber(opBalText),
      opening_value: Math.abs(opVal),
      gst_pct: 18,
    });
  }

  const voucherMatches = xmlText.matchAll(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi);
  for (const match of voucherMatches) {
    const attrChunk = match[1];
    const body = match[2];
    const vchType =
      extractXmlTagContent(body, "VOUCHERTYPENAME") ||
      extractXmlAttribute(attrChunk, "VCHTYPE") ||
      extractXmlTagContent(body, "VCHTYPE") ||
      extractXmlTagContent(body, "VOUCHERTYPE") ||
      "Sales";
    const vchNumber =
      extractXmlTagContent(body, "VOUCHERNUMBER") ||
      extractXmlTagContent(body, "VCHNUMBER") ||
      extractXmlTagContent(body, "REFERENCE") ||
      extractXmlAttribute(attrChunk, "VOUCHERNUMBER") ||
      extractXmlAttribute(attrChunk, "KEY") ||
      `VCH-${Date.now()}-${vouchers.length + 1}`;
    const date = parseTallyDateIso(
      extractXmlTagContent(body, "DATE") ||
      extractXmlTagContent(body, "EFFECTIVEDATE") ||
      extractXmlTagContent(body, "VOUCHERDATE")
    );
    let partyName =
      extractXmlTagContent(body, "PARTYLEDGERNAME") ||
      extractXmlTagContent(body, "PARTYNAME") ||
      extractXmlTagContent(body, "BASICBUYERNAME") ||
      extractXmlTagContent(body, "PARTY") ||
      "";
    const narration = extractXmlTagContent(body, "NARRATION") || "";

    const inventory_entries = [];
    const inventoryMatches = body.matchAll(
      /<(?:ALLINVENTORYENTRIES\.LIST|INVENTORYENTRIES\.LIST|INVENTORYENTRIESIN\.LIST|INVENTORYENTRIESOUT\.LIST)\b[^>]*>([\s\S]*?)<\/(?:ALLINVENTORYENTRIES\.LIST|INVENTORYENTRIES\.LIST|INVENTORYENTRIESIN\.LIST|INVENTORYENTRIESOUT\.LIST)>/gi
    );
    for (const im of inventoryMatches) {
      const ib = im[1];
      const stockName = extractXmlTagContent(ib, "STOCKITEMNAME");
      if (!stockName) continue;
      const qtyText = extractXmlTagContent(ib, "BILLEDQTY") || extractXmlTagContent(ib, "ACTUALQTY") || "1";
      const rate = parseTallyNumber(extractXmlTagContent(ib, "RATE") || 0);
      const amt = parseTallyNumber(extractXmlTagContent(ib, "AMOUNT") || 0);
      inventory_entries.push({
        stock_item_name: cleanString(stockName),
        qty: parseTallyQty(qtyText),
        uom: parseTallyUom(qtyText),
        rate: Math.abs(rate),
        amount: Math.abs(amt),
        discount: Math.abs(parseTallyNumber(extractXmlTagContent(ib, "DISCOUNT") || 0)),
        hsn_no: cleanString(extractXmlTagContent(ib, "GSTHSNNAME") || extractXmlTagContent(ib, "HSNCODE") || "") || null,
        gst_pct: parseGstRateFromInventoryXml(ib),
        customer_item_code: extractCustomerPartCodeFromInventory(ib),
      });
    }

    const entries = [];
    const entryMatches = body.matchAll(
      /<(?:ALLLEDGERENTRIES\.LIST|LEDGERENTRIES\.LIST|ACCOUNTINGENTRIES\.LIST|PAYMENTENTRIES\.LIST|RECEIPTENTRIES\.LIST|DUTYENTRIES\.LIST|ALLLEDGERENTRIES|LEDGERENTRIES)\b[^>]*>([\s\S]*?)<\/(?:ALLLEDGERENTRIES\.LIST|LEDGERENTRIES\.LIST|ACCOUNTINGENTRIES\.LIST|PAYMENTENTRIES\.LIST|RECEIPTENTRIES\.LIST|DUTYENTRIES\.LIST|ALLLEDGERENTRIES|LEDGERENTRIES)>/gi
    );
    let totalAmt = 0;
    for (const em of entryMatches) {
      const eb = em[1];
      const lName =
        extractXmlTagContent(eb, "LEDGERNAME") ||
        extractXmlTagContent(eb, "NAME") ||
        extractXmlAttribute(em[0], "NAME");
      const amt = parseTallyNumber(extractXmlTagContent(eb, "AMOUNT") || 0);
      const isDeemedPos = (extractXmlTagContent(eb, "ISDEEMEDPOSITIVE") || "").toLowerCase() === "yes";
      if (lName) {
        entries.push({
          ledger_name: cleanString(lName),
          amount: Math.abs(amt),
          is_debit: amt < 0 || isDeemedPos,
          is_party_ledger: (extractXmlTagContent(eb, "ISPARTYLEDGER") || "").toLowerCase() === "yes",
          bill_allocations: extractBillAllocationsFromLedgerBlock(eb),
        });
        totalAmt = Math.max(totalAmt, Math.abs(amt));
      }
    }

    if (!partyName && entries.length > 0) {
      partyName = entries[0].ledger_name;
    }

    const inventoryTotal = inventory_entries.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    if (inventoryTotal > totalAmt) totalAmt = inventoryTotal;

    const orderBlock = extractXmlListBlocks(body, "INVOICEORDERLIST.LIST")[0];
    const invoiceOrder = orderBlock
      ? {
          basic_purchase_order_no: cleanString(extractXmlTagContent(orderBlock, "BASICPURCHASEORDERNO")) || null,
          basic_order_date: extractXmlTagContent(orderBlock, "BASICORDERDATE")
            ? parseTallyDateIso(extractXmlTagContent(orderBlock, "BASICORDERDATE"))
            : null,
        }
      : null;

    vouchers.push({
      voucher_type: cleanString(vchType),
      voucher_number: cleanString(vchNumber),
      date,
      party_name: cleanString(partyName),
      amount: totalAmt,
      narration: cleanString(narration),
      ...extractTallyVoucherMeta(body),
      invoice_order: invoiceOrder,
      entries,
      inventory_entries,
    });
  }

  return { tallyCompanyName, tallyGstin, ledgers, stock_items, vouchers };
}

async function resolveCompany(client, companyIdOrCode) {
  let query = "";
  let params = [];

  if (Number.isFinite(Number(companyIdOrCode)) && Number(companyIdOrCode) > 0) {
    query = `select id, company_code, legal_name, display_name, gstin from companies where id = $1 limit 1`;
    params = [Number(companyIdOrCode)];
  } else {
    const code = String(companyIdOrCode || "").trim().toUpperCase();
    query = `
      select id, company_code, legal_name, display_name, gstin
      from companies
      where upper(company_code) = $1
         or upper(company_code) = replace($1, 'ABSSTEM_', '')
         or lower(company_code) = lower($1)
         or id in (select id from companies where upper(company_code) like $2 limit 1)
      order by id asc
      limit 1
    `;
    params = [code, `%${code}%`];
  }

  const res = await client.query(query, params);
  return res.rows[0] || null;
}

/**
 * Smart Auto-Resolver: Evaluates raw Tally record against live Josh operational data
 */
async function resolveStagingRecord(client, companyId, recordType, payload, liveContext) {
  if (recordType === "ledger") {
    const pGroup = (payload.parent || "").toLowerCase();
    const isDebtor = pGroup.includes("debtor") || pGroup.includes("customer");
    const isCreditor = pGroup.includes("creditor") || pGroup.includes("vendor") || pGroup.includes("supplier");

    if (isDebtor) {
      // 1. Deterministic GSTIN match
      if (payload.gstin && payload.gstin.length >= 10) {
        const match = liveContext.customers.find((c) => c.gstin && c.gstin.toUpperCase() === payload.gstin);
        if (match) {
          return {
            match_strategy: "deterministic_gstin",
            match_confidence_pct: 100.0,
            suggested_target_table: "customers",
            suggested_target_id: match.id,
            suggested_target_display: `${match.customer_name} (GSTIN: ${match.gstin})`,
            resolution_status: "AUTO_MATCHED",
            ai_recommendation: {
              action: "AUTO_LINK",
              reason: `Exact deterministic GSTIN match (${payload.gstin}) found in customer master.`,
              badge: "GSTIN Match 100%",
            },
          };
        }
      }

      // 2. Deterministic PAN match
      if (payload.pan && payload.pan.length >= 8) {
        const match = liveContext.customers.find((c) => c.pan_no && c.pan_no.toUpperCase() === payload.pan);
        if (match) {
          return {
            match_strategy: "deterministic_pan",
            match_confidence_pct: 98.0,
            suggested_target_table: "customers",
            suggested_target_id: match.id,
            suggested_target_display: `${match.customer_name} (PAN: ${match.pan_no})`,
            resolution_status: "AUTO_MATCHED",
            ai_recommendation: {
              action: "AUTO_LINK",
              reason: `Deterministic Income Tax PAN match (${payload.pan}) found in customer master.`,
              badge: "PAN Match 98%",
            },
          };
        }
      }

      // 3. Fuzzy Name match
      let bestScore = 0;
      let bestMatch = null;
      for (const c of liveContext.customers) {
        const sim = calculateSimilarity(payload.name, c.customer_name);
        if (sim > bestScore) {
          bestScore = sim;
          bestMatch = c;
        }
      }

      if (bestScore >= 0.82 && bestMatch) {
        const isHighConf = bestScore >= 0.90;
        return {
          match_strategy: "fuzzy_name",
          match_confidence_pct: (bestScore * 100).toFixed(2),
          suggested_target_table: "customers",
          suggested_target_id: bestMatch.id,
          suggested_target_display: `${bestMatch.customer_name}`,
          resolution_status: isHighConf ? "AUTO_MATCHED" : "NEEDS_REVIEW",
          ai_recommendation: {
            action: isHighConf ? "AUTO_LINK" : "REVIEW_SUGGESTION",
            reason: `Fuzzy name similarity ${Math.round(bestScore * 100)}% to existing customer '${bestMatch.customer_name}'.`,
            badge: `Fuzzy Name ${Math.round(bestScore * 100)}%`,
          },
        };
      }

      // New Customer creation suggestion
      return {
        match_strategy: "new_record",
        match_confidence_pct: 100.0,
        suggested_target_table: "customers",
        suggested_target_id: null,
        suggested_target_display: `Create Customer: ${payload.name}`,
        resolution_status: "AUTO_MATCHED",
        ai_recommendation: {
          action: "CREATE_NEW",
          reason: "New sundry debtor identified. Ready to register into customer master.",
          badge: "New Customer",
        },
      };
    } else if (isCreditor) {
      // Vendor matching
      if (payload.gstin && payload.gstin.length >= 10) {
        const match = liveContext.vendors.find((v) => v.gstin && v.gstin.toUpperCase() === payload.gstin);
        if (match) {
          return {
            match_strategy: "deterministic_gstin",
            match_confidence_pct: 100.0,
            suggested_target_table: "vendors",
            suggested_target_id: match.id,
            suggested_target_display: `${match.company_name} (GSTIN: ${match.gstin})`,
            resolution_status: "AUTO_MATCHED",
            ai_recommendation: {
              action: "AUTO_LINK",
              reason: `Exact deterministic GSTIN match (${payload.gstin}) found in vendor master.`,
              badge: "GSTIN Match 100%",
            },
          };
        }
      }

      // Fuzzy Vendor Name match
      let bestScore = 0;
      let bestMatch = null;
      for (const v of liveContext.vendors) {
        const sim = calculateSimilarity(payload.name, v.company_name);
        if (sim > bestScore) {
          bestScore = sim;
          bestMatch = v;
        }
      }

      if (bestScore >= 0.82 && bestMatch) {
        const isHighConf = bestScore >= 0.90;
        return {
          match_strategy: "fuzzy_name",
          match_confidence_pct: (bestScore * 100).toFixed(2),
          suggested_target_table: "vendors",
          suggested_target_id: bestMatch.id,
          suggested_target_display: `${bestMatch.company_name}`,
          resolution_status: isHighConf ? "AUTO_MATCHED" : "NEEDS_REVIEW",
          ai_recommendation: {
            action: isHighConf ? "AUTO_LINK" : "REVIEW_SUGGESTION",
            reason: `Fuzzy vendor similarity ${Math.round(bestScore * 100)}% to '${bestMatch.company_name}'.`,
            badge: `Fuzzy Name ${Math.round(bestScore * 100)}%`,
          },
        };
      }

      return {
        match_strategy: "new_record",
        match_confidence_pct: 100.0,
        suggested_target_table: "vendors",
        suggested_target_id: null,
        suggested_target_display: `Create Vendor: ${payload.name}`,
        resolution_status: "AUTO_MATCHED",
        ai_recommendation: {
          action: "CREATE_NEW",
          reason: "New vendor ledger identified. Ready to register into vendor master.",
          badge: "New Vendor",
        },
      };
    } else {
      // General Ledger mapping
      const match = liveContext.coa.find((a) => normalizeKey(a.account_name) === normalizeKey(payload.name));
      return {
        match_strategy: match ? "exact_gl_name" : "new_record",
        match_confidence_pct: match ? 100.0 : 95.0,
        suggested_target_table: "chart_of_accounts",
        suggested_target_id: match ? match.id : null,
        suggested_target_display: match ? match.account_name : `Create GL: ${payload.name}`,
        resolution_status: "AUTO_MATCHED",
        ai_recommendation: {
          action: match ? "AUTO_LINK" : "CREATE_NEW",
          reason: match ? "Matched existing COA ledger." : `Register into Chart of Accounts under ${payload.parent}.`,
          badge: match ? "COA Matched" : "New COA Ledger",
        },
      };
    }
  } else if (recordType === "stock_item") {
    // Stock Item Matching
    const exactCodeMatch = liveContext.products.find(
      (p) => normalizeKey(p.sku) === normalizeKey(payload.item_code) || normalizeKey(p.item_code) === normalizeKey(payload.item_code)
    );
    if (exactCodeMatch) {
      return {
        match_strategy: "exact_sku",
        match_confidence_pct: 100.0,
        suggested_target_table: "products",
        suggested_target_id: exactCodeMatch.id,
        suggested_target_display: `${exactCodeMatch.sku || exactCodeMatch.item_code} - ${exactCodeMatch.item_name}`,
        resolution_status: "AUTO_MATCHED",
        ai_recommendation: {
          action: "AUTO_LINK",
          reason: `Exact SKU match '${exactCodeMatch.sku || exactCodeMatch.item_code}' in Josh Product Master.`,
          badge: "Exact SKU 100%",
        },
      };
    }

    // Fuzzy Product Description match
    let bestScore = 0;
    let bestMatch = null;
    for (const p of liveContext.products) {
      const sim = calculateSimilarity(payload.name, p.item_name);
      if (sim > bestScore) {
        bestScore = sim;
        bestMatch = p;
      }
    }

    if (bestScore >= 0.80 && bestMatch) {
      return {
        match_strategy: "fuzzy_name",
        match_confidence_pct: (bestScore * 100).toFixed(2),
        suggested_target_table: "products",
        suggested_target_id: bestMatch.id,
        suggested_target_display: `${bestMatch.sku || bestMatch.item_code} - ${bestMatch.item_name}`,
        resolution_status: bestScore >= 0.90 ? "AUTO_MATCHED" : "NEEDS_REVIEW",
        ai_recommendation: {
          action: bestScore >= 0.90 ? "AUTO_LINK" : "REVIEW_SUGGESTION",
          reason: `Fuzzy description similarity ${Math.round(bestScore * 100)}% to product '${bestMatch.item_name}'.`,
          badge: `Fuzzy ${Math.round(bestScore * 100)}%`,
        },
      };
    }

    return {
      match_strategy: "new_record",
      match_confidence_pct: 100.0,
      suggested_target_table: "products",
      suggested_target_id: null,
      suggested_target_display: `Create SKU: ${payload.item_code}`,
      resolution_status: "AUTO_MATCHED",
      ai_recommendation: {
        action: "CREATE_NEW",
        reason: "New stock item identified. Ready to register into Product Master & SKU Desk.",
        badge: "New SKU",
      },
    };
  } else if (recordType === "voucher") {
    // Voucher matching (Invoices / Receipts / Bills)
    const vType = (payload.voucher_type || "").toLowerCase();
    if (vType.includes("sale") || vType.includes("invoice")) {
      const match = liveContext.invoices.find(
        (inv) => normalizeKey(inv.invoice_number) === normalizeKey(payload.voucher_number) ||
                 inv.invoice_number.includes(payload.voucher_number) ||
                 payload.voucher_number.includes(inv.invoice_number)
      );

      if (match) {
        const invoiceTotal = parseFloat(match.grand_total_invoice || match.grand_total_base || 0);
        const amtDiff = reconVariance(invoiceTotal, payload.amount);
        const isExactAmt = withinReconTolerance(amtDiff);
        return {
          match_strategy: isExactAmt ? "voucher_exact_amount" : "voucher_variance_detected",
          match_confidence_pct: isExactAmt ? 100.0 : 85.0,
          suggested_target_table: "customer_invoices",
          suggested_target_id: match.id,
          suggested_target_display: `Invoice ${match.invoice_number} (₹${invoiceTotal.toFixed(2)})`,
          resolution_status: isExactAmt ? "AUTO_MATCHED" : "NEEDS_REVIEW",
          ai_recommendation: {
            action: isExactAmt ? "RECONCILE_BALANCED" : "FLAG_VARIANCE",
            reason: isExactAmt
              ? "Exact invoice number and total amount match."
              : `Invoice number matches but variance of ₹${amtDiff.toFixed(2)} detected.`,
            badge: isExactAmt ? "Balanced Match" : `Variance ₹${amtDiff.toFixed(2)}`,
          },
        };
      }

      return {
        match_strategy: "unmatched",
        match_confidence_pct: 70.0,
        suggested_target_table: "customer_invoices",
        suggested_target_id: null,
        suggested_target_display: `Tally Vch ${payload.voucher_number}`,
        resolution_status: "AUTO_MATCHED",
        ai_recommendation: {
          action: "CREATE_INVOICE_ON_COMMIT",
          reason: "No matching Josh invoice found. A new AR invoice will be created on commit (parallel operation mode).",
          badge: "Will Create Invoice",
        },
      };
    }

    if (vType.includes("receipt")) {
      const match = (liveContext.receipts || []).find(
        (rcpt) =>
          normalizeKey(rcpt.reference_no || "") === normalizeKey(payload.voucher_number) ||
          normalizeKey(rcpt.receipt_number || "") === normalizeKey(payload.voucher_number) ||
          normalizeKey(rcpt.tally_voucher_number || "") === normalizeKey(payload.voucher_number)
      );

      if (match) {
        const receiptTotal = parseFloat(match.receipt_amount_invoice || 0);
        const amtDiff = reconVariance(receiptTotal, payload.amount);
        const isExactAmt = withinReconTolerance(amtDiff);
        return {
          match_strategy: isExactAmt ? "voucher_exact_amount" : "voucher_variance_detected",
          match_confidence_pct: isExactAmt ? 100.0 : 85.0,
          suggested_target_table: "customer_receipts",
          suggested_target_id: match.id,
          suggested_target_display: `Receipt ${match.receipt_number} (₹${receiptTotal.toFixed(2)})`,
          resolution_status: isExactAmt ? "AUTO_MATCHED" : "NEEDS_REVIEW",
          ai_recommendation: {
            action: isExactAmt ? "RECONCILE_BALANCED" : "FLAG_VARIANCE",
            reason: isExactAmt
              ? "Exact receipt reference and amount match."
              : `Receipt reference matches but variance of ₹${amtDiff.toFixed(2)} detected.`,
            badge: isExactAmt ? "Balanced Match" : `Variance ₹${amtDiff.toFixed(2)}`,
          },
        };
      }

      return {
        match_strategy: "unmatched",
        match_confidence_pct: 70.0,
        suggested_target_table: "customer_receipts",
        suggested_target_id: null,
        suggested_target_display: `Tally Rcpt ${payload.voucher_number}`,
        resolution_status: "AUTO_MATCHED",
        ai_recommendation: {
          action: "CREATE_RECEIPT_ON_COMMIT",
          reason: "No matching Josh receipt found. A new receipt will be created on commit (parallel operation mode).",
          badge: "Will Create Receipt",
        },
      };
    }

    return {
      match_strategy: "unmatched",
      match_confidence_pct: 50.0,
      suggested_target_table: null,
      suggested_target_id: null,
      suggested_target_display: `Tally Vch ${payload.voucher_number}`,
      resolution_status: "AUTO_MATCHED",
      ai_recommendation: {
        action: "RECORD_NEW_VOUCHER",
        reason: "Voucher recorded in reconciliation audit log only.",
        badge: "Reconcile Only",
      },
    };
  }

  return {
    match_strategy: "unmatched",
    match_confidence_pct: 0.0,
    suggested_target_table: null,
    suggested_target_id: null,
    suggested_target_display: "Unresolved",
    resolution_status: "NEEDS_REVIEW",
    ai_recommendation: { action: "MANUAL_INSPECT", reason: "Cannot determine target structure." },
  };
}

/**
 * Load operational live context for fast batch in-memory matching
 */
async function loadLiveCompanyContext(client, companyId) {
  const [custRes, vendRes, prodRes, coaRes, invRes, rcptRes] = await Promise.all([
    client.query(`select id, customer_name, gstin, pan_no from customers where company_id = $1 or company_id is null`, [companyId]),
    client.query(`select id, company_name, vendor_code, gstin, pan_no from vendors`),
    client.query(`select id, item_code, sku, item_name from products`),
    client.query(`select id, account_code, account_name from chart_of_accounts where company_id = $1`, [companyId]),
    client.query(`select id, invoice_number, grand_total_invoice, grand_total_base from customer_invoices where company_id = $1`, [companyId]),
    client.query(
      `select id, receipt_number, receipt_amount_invoice, reference_no, tally_voucher_number from customer_receipts where company_id = $1`,
      [companyId]
    ),
  ]);

  return {
    customers: custRes.rows,
    vendors: vendRes.rows,
    products: prodRes.rows,
    coa: coaRes.rows,
    invoices: invRes.rows,
    receipts: rcptRes.rows,
  };
}

/**
 * Ingest into Staging Area & Execute Smart Auto-Matching Pipeline
 */
async function stageAndAutoMatchTally(client, { companyIdOrCode, fileBuffer, fileName, userId = null }) {
  const company = await resolveCompany(client, companyIdOrCode);
  if (!company) {
    const err = new Error("COMPANY_NOT_FOUND");
    err.status = 404;
    err.message = `Company '${companyIdOrCode}' could not be identified in Josh ERP.`;
    throw err;
  }

  const companyId = company.id;
  const entityCode = company.company_code;
  const fileFormat = fileName.toLowerCase().endsWith(".json") ? "json" : "xml";
  const { tallyCompanyName, tallyGstin, ledgers, stock_items, vouchers } = parseTallyData(fileBuffer, fileName);

  // Validate File vs Target Entity mismatch
  if (tallyCompanyName || tallyGstin) {
    const targetLegalName = (company.legal_name || "").toUpperCase();
    const targetDisplay = (company.display_name || "").toUpperCase();
    const targetGstin = (company.gstin || "").toUpperCase();

    const isGstinMismatch = tallyGstin && targetGstin && tallyGstin !== targetGstin;
    const isNameMismatch = tallyCompanyName && 
      !targetLegalName.includes(tallyCompanyName.toUpperCase()) && 
      !targetDisplay.includes(tallyCompanyName.toUpperCase()) &&
      !tallyCompanyName.toUpperCase().includes(entityCode);

    if (isGstinMismatch) {
      const err = new Error("TALLY_BACKUP_ENTITY_MISMATCH");
      err.status = 422;
      err.message = `Backup Mismatch Warning: Uploaded Tally backup is for GSTIN '${tallyGstin}' (${tallyCompanyName || "Unknown"}), but target entity is '${entityCode}' (GSTIN: ${targetGstin || "N/A"}). Please select the matching company or upload the correct backup.`;
      throw err;
    }
  }

  const importBatchCode = `STG-${entityCode}-${Date.now().toString(36).toUpperCase()}`;

  // 1. Create Import Log in 'staged' status
  const logRes = await client.query(
    `
      insert into tally_import_logs (
        company_id, import_batch_code, entity_code, file_name, file_format,
        file_size_bytes, masters_count, vouchers_count, ledgers_imported,
        stock_items_imported, status, imported_by, created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 'staged', $9, now())
      returning id
    `,
    [
      companyId,
      importBatchCode,
      entityCode,
      fileName,
      fileFormat,
      fileBuffer.length,
      ledgers.length + stock_items.length,
      vouchers.length,
      userId,
    ]
  );
  const batchId = logRes.rows[0].id;

  // 2. Load live context
  const liveContext = await loadLiveCompanyContext(client, companyId);

  let autoMatchedCount = 0;
  let exceptionsCount = 0;
  let gstinMatchedCount = 0;
  let panMatchedCount = 0;
  let fuzzyMatchedCount = 0;

  // 3. Stage Ledgers
  for (const ledger of ledgers) {
    const resolution = await resolveStagingRecord(client, companyId, "ledger", ledger, liveContext);
    if (resolution.resolution_status === "AUTO_MATCHED") autoMatchedCount++;
    else exceptionsCount++;

    if (resolution.match_strategy === "deterministic_gstin") gstinMatchedCount++;
    if (resolution.match_strategy === "deterministic_pan") panMatchedCount++;
    if (resolution.match_strategy === "fuzzy_name") fuzzyMatchedCount++;

    await client.query(
      `
        insert into tally_staging_area (
          company_id, batch_id, record_type, source_identifier, raw_payload,
          match_strategy, match_confidence_pct, suggested_target_table,
          suggested_target_id, suggested_target_display, resolution_status,
          ai_recommendation, created_at
        )
        values ($1, $2, 'ledger', $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
      `,
      [
        companyId,
        batchId,
        ledger.name,
        JSON.stringify(ledger),
        resolution.match_strategy,
        resolution.match_confidence_pct,
        resolution.suggested_target_table,
        resolution.suggested_target_id,
        resolution.suggested_target_display,
        resolution.resolution_status,
        JSON.stringify(resolution.ai_recommendation),
      ]
    );
  }

  // 4. Stage Stock Items
  for (const item of stock_items) {
    const resolution = await resolveStagingRecord(client, companyId, "stock_item", item, liveContext);
    if (resolution.resolution_status === "AUTO_MATCHED") autoMatchedCount++;
    else exceptionsCount++;
    if (resolution.match_strategy === "fuzzy_name") fuzzyMatchedCount++;

    await client.query(
      `
        insert into tally_staging_area (
          company_id, batch_id, record_type, source_identifier, raw_payload,
          match_strategy, match_confidence_pct, suggested_target_table,
          suggested_target_id, suggested_target_display, resolution_status,
          ai_recommendation, created_at
        )
        values ($1, $2, 'stock_item', $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
      `,
      [
        companyId,
        batchId,
        item.name,
        JSON.stringify(item),
        resolution.match_strategy,
        resolution.match_confidence_pct,
        resolution.suggested_target_table,
        resolution.suggested_target_id,
        resolution.suggested_target_display,
        resolution.resolution_status,
        JSON.stringify(resolution.ai_recommendation),
      ]
    );
  }

  // 5. Stage Vouchers
  for (const vch of vouchers) {
    const resolution = await resolveStagingRecord(client, companyId, "voucher", vch, liveContext);
    if (resolution.resolution_status === "AUTO_MATCHED") autoMatchedCount++;
    else exceptionsCount++;

    await client.query(
      `
        insert into tally_staging_area (
          company_id, batch_id, record_type, source_identifier, raw_payload,
          match_strategy, match_confidence_pct, suggested_target_table,
          suggested_target_id, suggested_target_display, resolution_status,
          ai_recommendation, created_at
        )
        values ($1, $2, 'voucher', $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
      `,
      [
        companyId,
        batchId,
        vch.voucher_number,
        JSON.stringify(vch),
        resolution.match_strategy,
        resolution.match_confidence_pct,
        resolution.suggested_target_table,
        resolution.suggested_target_id,
        resolution.suggested_target_display,
        resolution.resolution_status,
        JSON.stringify(resolution.ai_recommendation),
      ]
    );
  }

  const totalRecords = ledgers.length + stock_items.length + vouchers.length;
  const matchRatePct = totalRecords > 0 ? ((autoMatchedCount / totalRecords) * 100).toFixed(1) : 100.0;

  const summary = {
    entity_code: entityCode,
    company_name: company.display_name || company.legal_name,
    total_records: totalRecords,
    auto_matched_count: autoMatchedCount,
    exceptions_count: exceptionsCount,
    match_rate_pct: parseFloat(matchRatePct),
    gstin_matched_count: gstinMatchedCount,
    pan_matched_count: panMatchedCount,
    fuzzy_matched_count: fuzzyMatchedCount,
    ledgers_count: ledgers.length,
    stock_items_count: stock_items.length,
    vouchers_count: vouchers.length,
  };

  await client.query(
    `update tally_import_logs set reconciliation_summary = $2::jsonb where id = $1`,
    [batchId, JSON.stringify(summary)]
  );

  return {
    ok: true,
    batch_id: batchId,
    batch_code: importBatchCode,
    entity_code: entityCode,
    company_name: company.display_name || company.legal_name,
    summary,
  };
}

/**
 * Fetch Staged Records for Review & Exception Resolution
 */
async function getStagedRecords(client, { batchId, resolutionStatus = "", recordType = "", search = "" }) {
  const where = [`s.batch_id = $1`];
  const params = [Number(batchId)];

  if (resolutionStatus) {
    params.push(resolutionStatus);
    where.push(`s.resolution_status = $${params.length}`);
  }
  if (recordType) {
    params.push(recordType);
    where.push(`s.record_type = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const sParam = `$${params.length}`;
    where.push(`(s.source_identifier ilike ${sParam} or s.suggested_target_display ilike ${sParam})`);
  }

  const query = `
    select
      s.*,
      c.company_code,
      coalesce(c.display_name, c.legal_name) as company_name
    from tally_staging_area s
    join companies c on c.id = s.company_id
    where ${where.join(" and ")}
    order by 
      case when s.resolution_status = 'NEEDS_REVIEW' then 1 else 2 end,
      s.match_confidence_pct asc,
      s.id asc
    limit 300
  `;

  const res = await client.query(query, params);
  return res.rows;
}

/**
 * Update Resolution for a Staged Record (Approve Recommendation or Override)
 */
async function updateStagedRecordAction(client, { stagingId, action, targetId = null, notes = "" }) {
  const stgRes = await client.query(`select * from tally_staging_area where id = $1 limit 1`, [stagingId]);
  const record = stgRes.rows[0];
  if (!record) throw new Error("STAGING_RECORD_NOT_FOUND");

  let newStatus = "APPROVED";
  if (action === "OVERRIDE") newStatus = "OVERRIDDEN";
  else if (action === "DISCARD") newStatus = "DISCARDED";
  else if (action === "APPROVE") newStatus = "APPROVED";

  const res = await client.query(
    `
      update tally_staging_area
      set
        resolution_status = $2,
        user_override_target_id = coalesce($3, user_override_target_id),
        review_notes = $4,
        updated_at = now()
      where id = $1
      returning *
    `,
    [stagingId, newStatus, targetId, notes || null]
  );

  return res.rows[0];
}

/**
 * Bulk Approve all Recommended Matches in a Staging Batch
 */
async function bulkApproveStagingBatch(client, batchId, { includeExceptions = false } = {}) {
  const statuses = includeExceptions ? ["AUTO_MATCHED", "NEEDS_REVIEW"] : ["AUTO_MATCHED"];
  const res = await client.query(
    `
      update tally_staging_area
      set
        resolution_status = 'APPROVED',
        updated_at = now()
      where batch_id = $1 and resolution_status = any($2::text[])
      returning id
    `,
    [batchId, statuses]
  );
  return { ok: true, approved_count: res.rowCount, included_exceptions: includeExceptions };
}

async function getDefaultInrCurrencyId(client) {
  const res = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
  return res.rows[0]?.id || 1;
}

async function resolveCustomerIdForTallyParty(client, companyId, partyName) {
  if (!partyName) return null;

  const mapRes = await client.query(
    `
      select target_id
      from tally_master_mappings
      where company_id = $1
        and master_type = 'customer_ledger'
        and lower(trim(tally_name)) = lower(trim($2))
      limit 1
    `,
    [companyId, partyName]
  );
  if (mapRes.rows[0]?.target_id) return mapRes.rows[0].target_id;

  const custRes = await client.query(
    `
      select id
      from customers
      where (company_id = $1 or company_id is null)
        and lower(trim(customer_name)) = lower(trim($2))
      limit 1
    `,
    [companyId, partyName]
  );
  return custRes.rows[0]?.id || null;
}

async function resolveOrCreateCustomerForParty(client, companyId, partyName) {
  const existingId = await resolveCustomerIdForTallyParty(client, companyId, partyName);
  if (existingId) return existingId;
  if (!partyName) return null;

  const cleanPrefix = partyName.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "X") || "CUST";
  const custCode = `CUST-${cleanPrefix}-${Date.now().toString().slice(-4)}${Math.floor(10 + Math.random() * 90)}`;
  const ins = await client.query(
    `
      insert into customers (
        company_id, customer_code, customer_name, credit_limit, is_active, created_at, updated_at
      )
      values ($1, $2, $3, 500000, true, now(), now())
      returning id
    `,
    [companyId, custCode, partyName]
  );
  return ins.rows[0]?.id || null;
}

async function resolveProductIdForTallyStockItem(client, companyId, stockItemName) {
  if (!stockItemName) return null;

  const mapRes = await client.query(
    `
      select target_id
      from tally_master_mappings
      where company_id = $1
        and master_type = 'stock_item'
        and lower(trim(tally_name)) = lower(trim($2))
      limit 1
    `,
    [companyId, stockItemName]
  );
  if (mapRes.rows[0]?.target_id) return mapRes.rows[0].target_id;

  const prodRes = await client.query(
    `
      select id
      from products
      where lower(trim(item_code)) = lower(trim($1))
         or lower(trim(item_name)) = lower(trim($1))
         or lower(trim(sku)) = lower(trim($1))
      limit 1
    `,
    [stockItemName]
  );
  return prodRes.rows[0]?.id || null;
}

async function resolveInvoiceNumberForTally(client, companyId, tallyVoucherNumber) {
  const clean = String(tallyVoucherNumber || "").trim();
  if (!clean) return null;

  const existing = await client.query(
    `select id from customer_invoices where company_id = $1 and invoice_number = $2 limit 1`,
    [companyId, clean]
  );
  if (!existing.rows.length) return clean;

  const alt = `TALLY-${clean}`;
  const existingAlt = await client.query(
    `select id from customer_invoices where company_id = $1 and invoice_number = $2 limit 1`,
    [companyId, alt]
  );
  if (!existingAlt.rows.length) return alt;

  return null;
}

function tallyInventoryLineTaxable(line) {
  const qty = parseTallyQty(line.qty);
  const rate = money2(Math.abs(parseTallyNumber(line.rate || 0)));
  const tallyAmount = money2(Math.abs(parseTallyNumber(line.amount || 0)));
  const gross = qty > 0 && rate > 0 ? money2(rate * qty) : tallyAmount;

  const discountPct = Number(line.discount_pct);
  const discountAmt = money2(Math.abs(parseTallyNumber(line.discount_amt ?? 0)));
  const discountField = Math.abs(parseTallyNumber(line.discount ?? 0));

  // discount applied before tax (Tally inventory discount timing)
  if (Number.isFinite(discountPct) && discountPct > 0 && discountPct < 100) {
    return money2(gross * (1 - discountPct / 100));
  }
  if (discountAmt > 0) {
    return money2(Math.max(0, gross - discountAmt));
  }
  if (discountField > 0 && gross > 0) {
    const asPct =
      discountField <= 100 ? money2(gross * (1 - discountField / 100)) : null;
    const asAmt = money2(Math.max(0, gross - discountField));
    if (asPct != null && tallyAmount > 0 && Math.abs(asPct - tallyAmount) <= 0.05) return asPct;
    if (tallyAmount > 0 && Math.abs(asAmt - tallyAmount) <= 0.05) return asAmt;
    if (asPct != null && (!tallyAmount || Math.abs(gross - tallyAmount) <= 0.05)) return asPct;
    if (!tallyAmount || Math.abs(gross - tallyAmount) <= 0.05) return asAmt;
  }

  return tallyAmount > 0 ? tallyAmount : gross;
}

function buildInvoiceLinesFromTallyVoucher(raw) {
  const partyTotal = money2(Math.abs(parseTallyNumber(raw.amount || 0)));
  const inventoryLines = Array.isArray(raw.inventory_entries) ? raw.inventory_entries : [];
  const taxInfo = extractTaxFromLedgerEntries(raw.entries || []);

  if (inventoryLines.length > 0) {
    const lines = inventoryLines.map((line, idx) => {
      const qty = parseTallyQty(line.qty);
      const amount = tallyInventoryLineTaxable(line);
      const rate = qty > 0 ? money2(amount / qty) : money2(Math.abs(parseTallyNumber(line.rate || 0)));
      const gstPct = Number.isFinite(Number(line.gst_pct)) ? Number(line.gst_pct) : 18;
      return {
        line_no: idx + 1,
        product_id: null,
        item_code: line.stock_item_name,
        item_name: line.stock_item_name,
        line_description: line.stock_item_name,
        hsn_no: line.hsn_no || null,
        customer_item_code: line.customer_item_code || null,
        qty,
        unit_price: rate,
        line_total: amount,
        gst_pct: gstPct,
      };
    });

    const charges = extractNonTaxChargeEntries(raw.entries || [], {
      partyName: raw.party_name,
      partyAmount: partyTotal,
      ancillaryOnly: true,
    });
    let lineNo = lines.length;
    for (const charge of charges) {
      lineNo += 1;
      const lower = String(charge.ledger_name || "").toLowerCase();
      const chargeKind = lower.includes("freight")
        ? "freight"
        : lower.includes("packing") || lower.includes("forward")
          ? "packing_forwarding"
          : null;
      lines.push({
        line_no: lineNo,
        product_id: null,
        item_code: "TALLY-CHARGE",
        item_name: charge.ledger_name,
        line_description: charge.ledger_name,
        hsn_no: null,
        customer_item_code: null,
        qty: 1,
        unit_price: charge.amount,
        line_total: charge.amount,
        gst_pct: 0,
        charge_kind: chargeKind,
      });
    }

    // If stock + ancillary + tax still short of party bill total, add one balancing charge line.
    const linesSubtotal = money2(lines.reduce((sum, line) => sum + Number(line.line_total || 0), 0));
    const tax = taxInfo.taxTotal || 0;
    if (partyTotal > 0) {
      const gap = money2(partyTotal - linesSubtotal - tax);
      if (gap > 0.05) {
        lines.push({
          line_no: lines.length + 1,
          product_id: null,
          item_code: "TALLY-CHARGE",
          item_name: "Tally other charges",
          line_description: "Tally other charges",
          hsn_no: null,
          customer_item_code: null,
          qty: 1,
          unit_price: gap,
          line_total: gap,
          gst_pct: 0,
          charge_kind: null,
        });
      }
    }
    return lines;
  }

  const charges = extractNonTaxChargeEntries(raw.entries || [], {
    partyName: raw.party_name,
    partyAmount: partyTotal,
    ancillaryOnly: false,
  });

  if (charges.length > 0) {
    return charges.map((charge, idx) => ({
      line_no: idx + 1,
      product_id: null,
      item_code: "TALLY-IMPORT",
      item_name: charge.ledger_name,
      line_description: charge.ledger_name,
      hsn_no: null,
      customer_item_code: null,
      qty: 1,
      unit_price: charge.amount,
      line_total: charge.amount,
      gst_pct: 18,
      charge_kind: null,
    }));
  }

  // Empty inventory and no charge ledgers: taxable = party total minus extracted tax
  // (never use tax-inclusive party total as line subtotal — that double-counts GST).
  const taxable = money2(Math.max(0, partyTotal - (taxInfo.taxTotal || 0)));
  const label = raw.narration || raw.party_name || "Tally Sales Voucher";
  return [
    {
      line_no: 1,
      product_id: null,
      item_code: "TALLY-IMPORT",
      item_name: label,
      line_description: label,
      hsn_no: null,
      customer_item_code: null,
      qty: 1,
      unit_price: taxable,
      line_total: taxable,
      gst_pct: 18,
      charge_kind: null,
    },
  ];
}

/**
 * Prefer Tally party/bill total as grand total. Tax from Output GST ledgers.
 * Prevents inclusive-base + tax double-count on accounting-style vouchers.
 */
function computeTallySalesInvoiceTotals(raw, lineDrafts = []) {
  const partyTotal = money2(Math.abs(parseTallyNumber(raw.amount || 0)));
  const { cgst, sgst, igst, taxTotal } = extractTaxFromLedgerEntries(raw.entries || []);
  const linesSubtotal = money2(lineDrafts.reduce((sum, line) => sum + Number(line.line_total || 0), 0));

  let computedTax = taxTotal > 0 ? taxTotal : money2(Math.max(0, partyTotal - linesSubtotal));
  let subtotal = linesSubtotal;
  let grandTotal;

  if (partyTotal > 0) {
    grandTotal = partyTotal;
    if (computedTax > grandTotal) {
      computedTax = money2(Math.max(0, grandTotal - linesSubtotal));
    }
    if (Math.abs(linesSubtotal + computedTax - partyTotal) <= 0.05) {
      subtotal = linesSubtotal;
      grandTotal = money2(linesSubtotal + computedTax);
    } else {
      // Header must match Tally bill total even if line composition is incomplete.
      subtotal = money2(Math.max(0, grandTotal - computedTax));
    }
  } else {
    grandTotal = money2(linesSubtotal + computedTax);
    subtotal = linesSubtotal;
  }

  const isInterstate = igst > 0 && cgst <= 0 && sgst <= 0;
  return {
    subtotal: money2(subtotal),
    computedTax: money2(computedTax),
    grandTotal: money2(grandTotal),
    cgst: money2(cgst),
    sgst: money2(sgst),
    igst: money2(igst),
    isInterstate,
  };
}

function calculateReceiptTotalsForTally(receiptAmount, allocations) {
  const allocatedInvoice = allocations.reduce((sum, row) => sum + Number(row.allocated_invoice || 0), 0);
  const allocatedBase = allocations.reduce((sum, row) => sum + Number(row.allocated_base || row.allocated_invoice || 0), 0);
  return {
    allocated_amount_invoice: Number(allocatedInvoice.toFixed(2)),
    allocated_amount_base: Number(allocatedBase.toFixed(2)),
    unallocated_amount_invoice: Number((receiptAmount - allocatedInvoice).toFixed(2)),
    unallocated_amount_base: Number((receiptAmount - allocatedBase).toFixed(2)),
  };
}

async function resolveInvoiceIdByTallyBillName(client, companyId, billName) {
  const clean = cleanString(billName);
  if (!clean) return null;
  const res = await client.query(
    `
      select id
      from customer_invoices
      where company_id = $1
        and (
          lower(trim(invoice_number)) = lower(trim($2))
          or lower(trim(coalesce(tally_voucher_number, ''))) = lower(trim($2))
        )
      limit 1
    `,
    [companyId, clean]
  );
  return res.rows[0]?.id || null;
}

async function applyTallyReceiptBillAllocations(client, { companyId, receiptId, raw }) {
  const rawBillRows = extractBillAllocationsFromVoucherSource(raw).filter((row) => {
    const billType = String(row.bill_type || "").toLowerCase();
    return row.invoice_number && (billType.includes("agst") || billType.includes("against"));
  });
  // XML parse can surface the same BILLALLOCATIONS via voucher meta + ledger entries.
  const seen = new Set();
  const billRows = [];
  for (const row of rawBillRows) {
    const key = `${String(row.invoice_number).trim().toLowerCase()}|${Number(row.amount || 0).toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    billRows.push(row);
  }
  if (!billRows.length) return { applied: 0, skipped: 0 };

  const receiptRes = await client.query(
    `select id, receipt_amount_invoice, receipt_amount_base from customer_receipts where id = $1 limit 1`,
    [receiptId]
  );
  const receipt = receiptRes.rows[0];
  if (!receipt) return { applied: 0, skipped: billRows.length };

  const existingAlloc = await client.query(
    `select count(*)::int as n from customer_receipt_allocations where customer_receipt_id = $1`,
    [receiptId]
  );
  if ((existingAlloc.rows[0]?.n ?? 0) > 0) return { applied: 0, skipped: billRows.length, reason: "ALLOCATIONS_EXIST" };

  const allocations = [];
  let applied = 0;
  let skipped = 0;
  for (const row of billRows) {
    const invoiceId = await resolveInvoiceIdByTallyBillName(client, companyId, row.invoice_number);
    if (!invoiceId) {
      skipped += 1;
      continue;
    }
    const allocatedInvoice = Math.abs(parseTallyNumber(row.amount || 0));
    if (allocatedInvoice <= 0) {
      skipped += 1;
      continue;
    }
    await client.query(
      `
        insert into customer_receipt_allocations (
          customer_receipt_id, customer_invoice_id, allocated_base, allocated_invoice
        )
        values ($1, $2, $3, $4)
      `,
      [receiptId, invoiceId, allocatedInvoice, allocatedInvoice]
    );
    allocations.push({
      customer_invoice_id: invoiceId,
      allocated_base: allocatedInvoice,
      allocated_invoice: allocatedInvoice,
    });
    applied += 1;
  }

  if (allocations.length) {
    const totals = calculateReceiptTotalsForTally(Number(receipt.receipt_amount_invoice || 0), allocations);
    await client.query(
      `
        update customer_receipts
        set
          allocated_amount_base = $2,
          allocated_amount_invoice = $3,
          unallocated_amount_base = $4,
          unallocated_amount_invoice = $5,
          updated_at = now()
        where id = $1
      `,
      [
        receiptId,
        totals.allocated_amount_base,
        totals.allocated_amount_invoice,
        totals.unallocated_amount_base,
        totals.unallocated_amount_invoice,
      ]
    );
  }

  return {
    applied,
    skipped,
    invoice_ids: allocations
      .map((row) => Number(row.customer_invoice_id))
      .filter((id) => Number.isFinite(id) && id > 0),
  };
}

async function enrichTallyInvoiceFromVoucherRaw(client, companyId, raw) {
  if (!isTallySalesVoucher(raw.voucher_type)) {
    return { ok: false, reason: "NOT_SALES_VOUCHER", voucher_number: raw.voucher_number || null };
  }

  const invRes = await client.query(
    `
      select id, customer_id
      from customer_invoices
      where company_id = $1
        and invoice_source = 'tally_import'
        and (
          tally_voucher_number = $2
          or lower(trim(invoice_number)) = lower(trim($2))
        )
      limit 1
    `,
    [companyId, raw.voucher_number]
  );
  const invoice = invRes.rows[0];
  if (!invoice?.id) {
    return { ok: false, reason: "INVOICE_NOT_FOUND", voucher_number: raw.voucher_number || null };
  }

  const meta = extractTallyVoucherMeta(raw);
  const orderFields = extractTallyCustomerOrderFields(raw);
  const poNumber = normalizeTallyTextField(orderFields.customer_po_number);

  await client.query(
    `
      update customer_invoices
      set
        customer_po_number = coalesce($3, customer_po_number),
        customer_po_date = coalesce($4::date, customer_po_date),
        customer_gstin = coalesce($5, customer_gstin),
        irn = coalesce($6, irn),
        irn_ack_no = coalesce($7, irn_ack_no),
        irn_ack_date = coalesce($8::timestamptz, irn_ack_date),
        signed_qr_code = coalesce($9, signed_qr_code),
        einvoice_status = case
          when coalesce($6, irn) is not null and einvoice_status = 'none' then $10
          else einvoice_status
        end,
        einvoice_mode = coalesce(einvoice_mode, $11),
        einvoice_provider = coalesce(einvoice_provider, $12),
        eway_bill_no = coalesce($13, eway_bill_no),
        eway_bill_date = coalesce($14::date, eway_bill_date),
        eway_valid_till = coalesce($15::timestamptz, eway_valid_till),
        updated_at = now()
      where id = $1 and company_id = $2
    `,
    [
      invoice.id,
      companyId,
      poNumber,
      orderFields.customer_po_date,
      meta.party_gstin,
      meta.irn,
      meta.irn_ack_no,
      meta.irn_ack_date ? `${meta.irn_ack_date}T00:00:00Z` : null,
      meta.signed_qr_code,
      meta.einvoice_status,
      meta.einvoice_mode,
      meta.einvoice_provider,
      meta.eway_bill_no,
      meta.eway_bill_date,
      meta.eway_valid_till ? `${meta.eway_valid_till}T23:59:59Z` : null,
    ]
  );

  if (meta.party_gstin && invoice.customer_id) {
    await client.query(
      `update customers set gstin = coalesce(gstin, $2), updated_at = now() where id = $1`,
      [invoice.customer_id, meta.party_gstin]
    );
  }

  const lineDrafts = buildInvoiceLinesFromTallyVoucher(raw);
  const existingLines = await client.query(
    `select id, line_no from invoice_lines where customer_invoice_id = $1 order by line_no asc, id asc`,
    [invoice.id]
  );
  for (let idx = 0; idx < lineDrafts.length; idx += 1) {
    const draft = lineDrafts[idx];
    const existing = existingLines.rows[idx];
    if (!existing) continue;
    await client.query(
      `
        update invoice_lines
        set
          hsn_no = coalesce($2, hsn_no),
          gst_pct = coalesce($3, gst_pct),
          customer_item_code = coalesce($4, customer_item_code),
          updated_at = now()
        where id = $1
      `,
      [existing.id, draft.hsn_no, draft.gst_pct, draft.customer_item_code]
    );
  }

  return {
    ok: true,
    invoice_id: invoice.id,
    voucher_number: raw.voucher_number,
    customer_po_number: poNumber,
    irn: meta.irn,
    lines_updated: Math.min(lineDrafts.length, existingLines.rows.length),
  };
}

async function enrichTallyInvoicesFromVouchers(client, companyId, vouchers = []) {
  const results = [];
  for (const raw of vouchers || []) {
    if (!isTallySalesVoucher(raw.voucher_type)) continue;
    try {
      results.push(await enrichTallyInvoiceFromVoucherRaw(client, companyId, raw));
    } catch (err) {
      results.push({
        ok: false,
        voucher_number: raw.voucher_number || null,
        error: err?.message || String(err),
      });
    }
  }
  return results;
}

async function enrichTallyReceiptFromVoucherRaw(client, companyId, raw) {
  if (!isTallyReceiptVoucher(raw.voucher_type)) {
    return { ok: false, reason: "NOT_RECEIPT_VOUCHER", voucher_number: raw.voucher_number || null };
  }
  const rcptRes = await client.query(
    `
      select id
      from customer_receipts
      where company_id = $1
        and receipt_source = 'tally_import'
        and (
          tally_voucher_number = $2
          or lower(trim(receipt_number)) = lower(trim($2))
        )
      limit 1
    `,
    [companyId, raw.voucher_number]
  );
  const receiptId = rcptRes.rows[0]?.id;
  if (!receiptId) {
    return { ok: false, reason: "RECEIPT_NOT_FOUND", voucher_number: raw.voucher_number || null };
  }
  const alloc = await applyTallyReceiptBillAllocations(client, { companyId, receiptId, raw });
  return { ok: true, receipt_id: receiptId, voucher_number: raw.voucher_number, ...alloc };
}

/**
 * Create a live Josh AR invoice from a Tally sales voucher (parallel operation mode).
 * Skips if invoice already exists or voucher is not a sales type.
 */
async function createJoshInvoiceFromTallyVoucher(client, { companyId, batchId, raw, userId = null }) {
  if (!isTallySalesVoucher(raw.voucher_type)) {
    return { created: false, skipped: true, reason: "NOT_SALES_VOUCHER" };
  }

  const dupRes = await client.query(
    `
      select id, grand_total_invoice
      from customer_invoices
      where company_id = $1
        and invoice_source = 'tally_import'
        and tally_voucher_number = $2
        and tally_voucher_date = $3::date
      limit 1
    `,
    [companyId, raw.voucher_number, raw.date]
  );
  if (dupRes.rows[0]?.id) {
    return {
      created: false,
      skipped: true,
      invoiceId: dupRes.rows[0].id,
      grandTotal: parseFloat(dupRes.rows[0].grand_total_invoice || 0),
      reason: "ALREADY_IMPORTED",
    };
  }

  const existingByNumber = await client.query(
    `
      select id, grand_total_invoice
      from customer_invoices
      where company_id = $1 and lower(trim(invoice_number)) = lower(trim($2))
      limit 1
    `,
    [companyId, raw.voucher_number]
  );
  if (existingByNumber.rows[0]?.id) {
    return {
      created: false,
      skipped: true,
      invoiceId: existingByNumber.rows[0].id,
      grandTotal: parseFloat(existingByNumber.rows[0].grand_total_invoice || 0),
      reason: "INVOICE_NUMBER_EXISTS",
    };
  }

  const customerId = await resolveOrCreateCustomerForParty(client, companyId, raw.party_name);
  if (!customerId) {
    return { created: false, skipped: true, reason: "CUSTOMER_NOT_RESOLVED" };
  }

  const invoiceNumber = await resolveInvoiceNumberForTally(client, companyId, raw.voucher_number);
  if (!invoiceNumber) {
    return { created: false, skipped: true, reason: "INVOICE_NUMBER_CONFLICT" };
  }

  const currencyId = await getDefaultInrCurrencyId(client);
  const lineDrafts = buildInvoiceLinesFromTallyVoucher(raw);
  for (const line of lineDrafts) {
    line.product_id = await resolveProductIdForTallyStockItem(client, companyId, line.item_name);
  }

  const {
    subtotal,
    computedTax,
    grandTotal,
    cgst,
    sgst,
    igst,
    isInterstate,
  } = computeTallySalesInvoiceTotals(raw, lineDrafts);

  const custGstinRes = await client.query(`select gstin from customers where id = $1 limit 1`, [customerId]);
  const customerGstin = raw.party_gstin || custGstinRes.rows[0]?.gstin || null;
  if (raw.party_gstin) {
    await client.query(`update customers set gstin = coalesce(gstin, $2), updated_at = now() where id = $1`, [
      customerId,
      raw.party_gstin,
    ]);
  }

  const dueDate = new Date(raw.date || new Date());
  dueDate.setDate(dueDate.getDate() + 30);

  const meta = extractTallyVoucherMeta(raw);
  const orderFields = extractTallyCustomerOrderFields(raw);

  const invRes = await client.query(
    `
      insert into customer_invoices (
        invoice_number, company_id, sales_order_id, customer_id, invoice_status, invoice_date, due_date,
        base_currency_id, invoice_currency_id,
        subtotal_base, subtotal_invoice, tax_total_base, tax_total_invoice,
        grand_total_base, grand_total_invoice, balance_due, paid_amount,
        cgst_amount, sgst_amount, igst_amount, is_interstate, customer_gstin,
        invoice_source, tally_voucher_number, tally_voucher_type, tally_voucher_date, tally_import_log_id,
        customer_po_number, customer_po_date,
        irn, irn_ack_no, irn_ack_date, signed_qr_code, einvoice_status, einvoice_mode, einvoice_provider,
        eway_bill_no, eway_bill_date, eway_valid_till,
        remarks, created_by, created_at, updated_at
      )
      values (
        $1, $2, null, $3, 'issued', $4::date, $5::date,
        $6, $6,
        $7, $7, $8, $8,
        $9, $9, $9, 0,
        $10, $11, $12, $13, $14,
        'tally_import', $15, $16, $17::date, $18,
        $19, $20::date,
        $21, $22, $23::timestamptz, $24, $25, $26, $27,
        $28, $29::date, $30::timestamptz,
        $31, $32, now(), now()
      )
      returning id, invoice_number, grand_total_invoice
    `,
    [
      invoiceNumber,
      companyId,
      customerId,
      raw.date,
      dueDate.toISOString().slice(0, 10),
      currencyId,
      subtotal,
      computedTax,
      grandTotal,
      isInterstate ? 0 : money2(cgst > 0 || sgst > 0 ? cgst : computedTax / 2),
      isInterstate ? 0 : money2(sgst > 0 || cgst > 0 ? sgst : computedTax / 2),
      isInterstate ? money2(igst > 0 ? igst : computedTax) : 0,
      isInterstate,
      customerGstin,
      raw.voucher_number,
      raw.voucher_type || "Sales",
      raw.date,
      batchId,
      orderFields.customer_po_number,
      orderFields.customer_po_date,
      meta.irn,
      meta.irn_ack_no,
      meta.irn_ack_date ? `${meta.irn_ack_date}T00:00:00Z` : null,
      meta.signed_qr_code,
      meta.einvoice_status,
      meta.einvoice_mode,
      meta.einvoice_provider,
      meta.eway_bill_no,
      meta.eway_bill_date,
      meta.eway_valid_till ? `${meta.eway_valid_till}T23:59:59Z` : null,
      raw.narration ? `Imported from Tally: ${raw.narration}` : "Imported from Tally ERP (parallel operation)",
      userId,
    ]
  );

  const invoiceId = invRes.rows[0]?.id;
  for (const line of lineDrafts) {
    await client.query(
      `
        insert into invoice_lines (
          customer_invoice_id, sales_order_line_id, line_no, product_id, item_code, item_name, line_description,
          hsn_no, customer_item_code, qty, unit_price_base, unit_price_invoice, gst_pct, line_total_base, line_total_invoice,
          charge_kind, created_at, updated_at
        )
        values ($1, null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $12, $13, now(), now())
      `,
      [
        invoiceId,
        line.line_no,
        line.product_id,
        line.item_code,
        line.item_name,
        line.line_description,
        line.hsn_no,
        line.customer_item_code,
        line.qty,
        line.unit_price,
        line.gst_pct,
        line.line_total,
        line.charge_kind || null,
      ]
    );
  }

  return {
    created: true,
    skipped: false,
    invoiceId,
    invoiceNumber: invRes.rows[0]?.invoice_number,
    grandTotal: parseFloat(invRes.rows[0]?.grand_total_invoice || grandTotal),
  };
}

/**
 * Create a live Josh receipt from a Tally receipt voucher (parallel operation mode).
 */
async function createJoshReceiptFromTallyVoucher(client, { companyId, batchId, raw, userId = null }) {
  if (!isTallyReceiptVoucher(raw.voucher_type)) {
    return { created: false, skipped: true, reason: "NOT_RECEIPT_VOUCHER" };
  }

  const dupRes = await client.query(
    `
      select id, receipt_amount_invoice
      from customer_receipts
      where company_id = $1
        and receipt_source = 'tally_import'
        and tally_voucher_number = $2
        and tally_voucher_date = $3::date
      limit 1
    `,
    [companyId, raw.voucher_number, raw.date]
  );
  if (dupRes.rows[0]?.id) {
    return {
      created: false,
      skipped: true,
      receiptId: dupRes.rows[0].id,
      receiptAmount: parseFloat(dupRes.rows[0].receipt_amount_invoice || 0),
      reason: "ALREADY_IMPORTED",
    };
  }

  const customerId = await resolveOrCreateCustomerForParty(client, companyId, raw.party_name);
  if (!customerId) {
    return { created: false, skipped: true, reason: "CUSTOMER_NOT_RESOLVED" };
  }

  const receiptAmount = Math.abs(parseTallyNumber(raw.amount || 0));
  if (receiptAmount <= 0) {
    return { created: false, skipped: true, reason: "ZERO_AMOUNT" };
  }

  const currencyId = await getDefaultInrCurrencyId(client);
  const paymentMode = extractPaymentModeFromEntries(raw.entries || [], raw.party_name);
  const numRes = await client.query(`select next_company_document_number($1, 'RCPT') as receipt_number`, [companyId]);
  const receiptNumber = numRes.rows[0]?.receipt_number;

  const rcptRes = await client.query(
    `
      insert into customer_receipts (
        receipt_number, company_id, customer_id, receipt_status, receipt_date,
        base_currency_id, receipt_currency_id,
        receipt_amount_base, receipt_amount_invoice,
        allocated_amount_base, allocated_amount_invoice,
        unallocated_amount_base, unallocated_amount_invoice,
        payment_mode, reference_no, remarks,
        receipt_source, tally_voucher_number, tally_voucher_type, tally_voucher_date, tally_import_log_id,
        created_by, created_at, updated_at
      )
      values (
        $1, $2, $3, 'posted', $4::date,
        $5, $5,
        $6, $6,
        0, 0,
        $6, $6,
        $7, $8, $9,
        'tally_import', $10, $11, $12::date, $13,
        $14, now(), now()
      )
      returning id, receipt_number, receipt_amount_invoice
    `,
    [
      receiptNumber,
      companyId,
      customerId,
      raw.date,
      currencyId,
      receiptAmount,
      paymentMode,
      raw.voucher_number,
      raw.narration ? `Imported from Tally: ${raw.narration}` : "Imported from Tally ERP (parallel operation)",
      raw.voucher_number,
      raw.voucher_type || "Receipt",
      raw.date,
      batchId,
      userId,
    ]
  );

  const receiptId = rcptRes.rows[0]?.id;
  await applyTallyReceiptBillAllocations(client, { companyId, receiptId, raw });

  return {
    created: true,
    skipped: false,
    receiptId,
    receiptNumber: rcptRes.rows[0]?.receipt_number,
    receiptAmount: parseFloat(rcptRes.rows[0]?.receipt_amount_invoice || receiptAmount),
  };
}

/**
 * Commit Approved Staging Batch to Live Operational Tables
 */
async function commitStagingBatchToLive(client, batchId, userId = null) {
  const logRes = await client.query(`select * from tally_import_logs where id = $1 limit 1`, [batchId]);
  const log = logRes.rows[0];
  if (!log) throw new Error("IMPORT_BATCH_NOT_FOUND");

  const companyId = log.company_id;
  const records = await client.query(
    `
      select * from tally_staging_area
      where batch_id = $1 and resolution_status in ('AUTO_MATCHED', 'APPROVED', 'OVERRIDDEN')
      order by id asc
    `,
    [batchId]
  );

  let ledgersCommitted = 0;
  let stockItemsCommitted = 0;
  let vouchersCommitted = 0;
  let invoicesCreated = 0;
  let receiptsCreated = 0;

  for (const rec of records.rows) {
    const raw = rec.raw_payload;
    const targetTable = rec.suggested_target_table;
    const targetId = rec.user_override_target_id || rec.suggested_target_id;

    if (rec.record_type === "ledger") {
      const pGroup = (raw.parent || "").toLowerCase();
      const isDebtor = pGroup.includes("debtor") || pGroup.includes("customer");
      const isCreditor = pGroup.includes("creditor") || pGroup.includes("vendor") || pGroup.includes("supplier");

      if (isDebtor) {
        let finalCustId = targetId;
        if (!finalCustId) {
          // Check if customer exists by GSTIN or by Name
          let existingCust = null;
          if (raw.gstin) {
            const byGstin = await client.query(
              `select id from customers where upper(trim(gstin)) = upper(trim($1)) limit 1`,
              [raw.gstin]
            );
            if (byGstin.rows.length) existingCust = byGstin.rows[0];
          }
          if (!existingCust && raw.name) {
            const byName = await client.query(
              `select id from customers where lower(trim(customer_name)) = lower(trim($1)) limit 1`,
              [raw.name]
            );
            if (byName.rows.length) existingCust = byName.rows[0];
          }

          if (existingCust) {
            finalCustId = existingCust.id;
            await client.query(
              `update customers set gstin = coalesce(nullif(trim(gstin), ''), $1), pan = coalesce(nullif(trim(pan), ''), $2), updated_at = now() where id = $3`,
              [raw.gstin || null, raw.pan || null, finalCustId]
            );
          } else {
            const cleanPrefix = raw.name.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "X") || "CUST";
            const custCode = `CUST-${cleanPrefix}-${Date.now().toString().slice(-4)}${Math.floor(10 + Math.random() * 90)}`;
            const custIns = await client.query(
              `
                insert into customers (
                  company_id, customer_code, customer_name, address_line1, gstin, pan,
                  credit_limit, is_active, created_at, updated_at
                )
                values ($1, $2, $3, $4, $5, $6, 500000, true, now(), now())
                returning id
              `,
              [companyId, custCode, raw.name, raw.address || null, raw.gstin || null, raw.pan || null]
            );
            finalCustId = custIns.rows[0]?.id;
          }
        }

        await client.query(
          `
            insert into tally_master_mappings (
              company_id, master_type, tally_name, tally_parent_group,
              target_table, target_id, match_status, opening_balance, opening_balance_type,
              raw_attributes, updated_at
            )
            values ($1, 'customer_ledger', $2, $3, 'customers', $4, 'matched', $5, $6, $7::jsonb, now())
            on conflict (company_id, master_type, tally_name) do update set
              target_id = excluded.target_id,
              opening_balance = excluded.opening_balance,
              raw_attributes = excluded.raw_attributes,
              updated_at = now()
          `,
          [companyId, raw.name, raw.parent, finalCustId, raw.opening_balance || 0, raw.balance_type || "Dr", JSON.stringify(raw)]
        );
        ledgersCommitted++;
      } else if (isCreditor) {
        let finalVendId = targetId;
        if (!finalVendId) {
          let existingVend = null;
          if (raw.gstin) {
            const byGstin = await client.query(
              `select id from vendors where (company_id = $1 or company_id is null) and upper(trim(gstin)) = upper(trim($2)) limit 1`,
              [companyId, raw.gstin]
            );
            if (byGstin.rows.length) existingVend = byGstin.rows[0];
          }
          if (!existingVend && raw.name) {
            const byName = await client.query(
              `select id from vendors where (company_id = $1 or company_id is null) and lower(trim(company_name)) = lower(trim($2)) limit 1`,
              [companyId, raw.name]
            );
            if (byName.rows.length) existingVend = byName.rows[0];
          }

          if (existingVend) {
            finalVendId = existingVend.id;
            await client.query(
              `update vendors set gstin = coalesce(nullif(trim(gstin), ''), $1), updated_at = now() where id = $2`,
              [raw.gstin || null, finalVendId]
            );
          } else {
            const cleanPrefix = raw.name.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "X") || "VEND";
            const vendCode = `V-${cleanPrefix}-${Date.now().toString().slice(-4)}${Math.floor(10 + Math.random() * 90)}`;
            const vendIns = await client.query(
              `
                insert into vendors (
                  company_id, vendor_code, company_name, gstin, address_line1, is_active, created_at, updated_at
                )
                values ($1, $2, $3, $4, $5, true, now(), now())
                returning id
              `,
              [companyId, vendCode, raw.name, raw.gstin || null, raw.address || null]
            );
            finalVendId = vendIns.rows[0]?.id;
          }
        }

        await client.query(
          `
            insert into tally_master_mappings (
              company_id, master_type, tally_name, tally_parent_group,
              target_table, target_id, match_status, opening_balance, opening_balance_type,
              raw_attributes, updated_at
            )
            values ($1, 'vendor_ledger', $2, $3, 'vendors', $4, 'matched', $5, $6, $7::jsonb, now())
            on conflict (company_id, master_type, tally_name) do update set
              target_id = excluded.target_id,
              opening_balance = excluded.opening_balance,
              raw_attributes = excluded.raw_attributes,
              updated_at = now()
          `,
          [companyId, raw.name, raw.parent, finalVendId, raw.opening_balance || 0, raw.balance_type || "Cr", JSON.stringify(raw)]
        );
        ledgersCommitted++;
      }
    } else if (rec.record_type === "stock_item") {
      let finalProdId = targetId;
      if (!finalProdId) {
        let catId = null;
        const catName = raw.parent || "General";
        const catCheck = await client.query(
          `select id from product_categories where lower(trim(category_name)) = lower(trim($1)) limit 1`,
          [catName]
        );
        if (catCheck.rows.length) {
          catId = catCheck.rows[0].id;
        } else {
          const catIns = await client.query(
            `insert into product_categories (category_name, is_active, created_at, updated_at) values ($1, true, now(), now()) returning id`,
            [catName]
          );
          catId = catIns.rows[0].id;
        }

        let grpId = null;
        const grpCheck = await client.query(
          `select id from product_groups where category_id = $1 and lower(trim(group_name)) = 'standard' limit 1`,
          [catId]
        );
        if (grpCheck.rows.length) {
          grpId = grpCheck.rows[0].id;
        } else {
          const grpIns = await client.query(
            `insert into product_groups (category_id, group_name, is_active, created_at, updated_at) values ($1, 'Standard', true, now(), now()) returning id`,
            [catId]
          );
          grpId = grpIns.rows[0].id;
        }

        const itemCode = raw.item_code || raw.name;
        const prodCheck = await client.query(
          `select id from products where lower(trim(item_code)) = lower(trim($1)) or lower(trim(item_name)) = lower(trim($2)) limit 1`,
          [itemCode, raw.name]
        );
        if (prodCheck.rows.length) {
          finalProdId = prodCheck.rows[0].id;
        } else {
          const prodIns = await client.query(
            `
              insert into products (
                category_id, group_id, item_code, item_name, item_type, uom, hsn_no,
                list_price, gst_pct, is_active, created_at, updated_at
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, now(), now())
              returning id
            `,
            [
              catId,
              grpId,
              itemCode,
              raw.name,
              "raw_material",
              raw.uom || "NOS",
              raw.hsn_code || "8405",
              raw.selling_price || 0,
              raw.gst_pct || 18,
            ]
          );
          finalProdId = prodIns.rows[0]?.id;
        }
      }

      await client.query(
        `
          insert into tally_master_mappings (
            company_id, master_type, tally_name, tally_parent_group,
            target_table, target_id, match_status, opening_balance, opening_balance_type,
            raw_attributes, updated_at
          )
          values ($1, 'stock_item', $2, $3, 'products', $4, 'matched', $5, 'debit', $6::jsonb, now())
          on conflict (company_id, master_type, tally_name) do update set
            target_id = excluded.target_id,
            opening_balance = excluded.opening_balance,
            raw_attributes = excluded.raw_attributes,
            updated_at = now()
        `,
        [companyId, raw.name, raw.parent, finalProdId, raw.opening_value || 0, JSON.stringify(raw)]
      );
      stockItemsCommitted++;
    } else if (rec.record_type === "voucher") {
      let matchedEntityType = targetTable;
      let matchedEntityId = targetId;
      let joshAmount = 0;
      let reconStatus = "missing_in_josh";
      let variance = Math.abs(parseTallyNumber(raw.amount || 0));

      if (isTallySalesVoucher(raw.voucher_type)) {
        let joshInvoiceId = targetTable === "customer_invoices" ? targetId : null;
        if (joshInvoiceId) {
          const matchedInv = await client.query(
            `select id, grand_total_invoice from customer_invoices where id = $1 limit 1`,
            [joshInvoiceId]
          );
          joshAmount = parseFloat(matchedInv.rows[0]?.grand_total_invoice || raw.amount || 0);
          variance = reconVariance(parseTallyNumber(raw.amount || 0), joshAmount);
          reconStatus = withinReconTolerance(variance) ? "reconciled" : "variance_detected";
        } else {
          const created = await createJoshInvoiceFromTallyVoucher(client, {
            companyId,
            batchId,
            raw,
            userId,
          });
          if (created.invoiceId) {
            joshInvoiceId = created.invoiceId;
            joshAmount = created.grandTotal || parseTallyNumber(raw.amount || 0);
            variance = reconVariance(parseTallyNumber(raw.amount || 0), joshAmount);
            if (created.created) {
              invoicesCreated += 1;
              reconStatus = withinReconTolerance(variance) ? "created_in_josh" : "variance_detected";
            } else {
              reconStatus = withinReconTolerance(variance) ? "reconciled" : "variance_detected";
            }
          }
        }
        matchedEntityType = joshInvoiceId ? "customer_invoices" : targetTable;
        matchedEntityId = joshInvoiceId || targetId;
      } else if (isTallyReceiptVoucher(raw.voucher_type)) {
        let joshReceiptId = targetTable === "customer_receipts" ? targetId : null;
        if (joshReceiptId) {
          const matchedRcpt = await client.query(
            `select id, receipt_amount_invoice from customer_receipts where id = $1 limit 1`,
            [joshReceiptId]
          );
          joshAmount = parseFloat(matchedRcpt.rows[0]?.receipt_amount_invoice || raw.amount || 0);
          variance = reconVariance(parseTallyNumber(raw.amount || 0), joshAmount);
          reconStatus = withinReconTolerance(variance) ? "reconciled" : "variance_detected";
        } else {
          const created = await createJoshReceiptFromTallyVoucher(client, {
            companyId,
            batchId,
            raw,
            userId,
          });
          if (created.receiptId) {
            joshReceiptId = created.receiptId;
            joshAmount = created.receiptAmount || parseTallyNumber(raw.amount || 0);
            variance = reconVariance(parseTallyNumber(raw.amount || 0), joshAmount);
            if (created.created) {
              receiptsCreated += 1;
              reconStatus = withinReconTolerance(variance) ? "created_in_josh" : "variance_detected";
            } else {
              reconStatus = withinReconTolerance(variance) ? "reconciled" : "variance_detected";
            }
          }
        }
        matchedEntityType = joshReceiptId ? "customer_receipts" : targetTable;
        matchedEntityId = joshReceiptId || targetId;
      } else {
        joshAmount = targetId ? parseTallyNumber(raw.amount || 0) : 0;
        reconStatus = targetId ? "reconciled" : "missing_in_josh";
        variance = 0;
      }

      await client.query(
        `
          insert into tally_voucher_reconciliations (
            company_id, import_log_id, voucher_type, voucher_number, voucher_date,
            party_name, tally_amount, josh_amount, variance, reconciliation_status,
            matched_entity_type, matched_entity_id, voucher_details, created_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, now())
          on conflict (company_id, voucher_type, voucher_number, voucher_date) do update set
            tally_amount = excluded.tally_amount,
            josh_amount = excluded.josh_amount,
            variance = excluded.variance,
            reconciliation_status = excluded.reconciliation_status,
            matched_entity_type = excluded.matched_entity_type,
            matched_entity_id = excluded.matched_entity_id,
            voucher_details = excluded.voucher_details
        `,
        [
          companyId,
          batchId,
          raw.voucher_type || "Sales",
          raw.voucher_number,
          raw.date,
          raw.party_name,
          raw.amount,
          joshAmount,
          variance,
          reconStatus,
          matchedEntityType,
          matchedEntityId,
          JSON.stringify(raw),
        ]
      );
      vouchersCommitted++;
    }

    // Mark staged item committed
    await client.query(`update tally_staging_area set resolution_status = 'COMMITTED' where id = $1`, [rec.id]);
  }

  // Update import log to completed
  await client.query(
    `
      update tally_import_logs
      set
        status = 'completed',
        ledgers_imported = $2,
        stock_items_imported = $3,
        vouchers_reconciled = $4,
        completed_at = now()
      where id = $1
    `,
    [batchId, ledgersCommitted, stockItemsCommitted, vouchersCommitted]
  );

  return {
    ok: true,
    batch_id: batchId,
    status: "completed",
    ledgers_committed: ledgersCommitted,
    stock_items_committed: stockItemsCommitted,
    vouchers_committed: vouchersCommitted,
    invoices_created: invoicesCreated,
    receipts_created: receiptsCreated,
  };
}

/**
 * Fetch past Tally import logs with pagination & filtering
 */
async function getTallyImportLogs(client, companyId = null) {
  let query = `
    select
      l.id,
      l.company_id,
      l.import_batch_code,
      l.entity_code,
      l.file_name,
      l.file_format,
      l.file_size_bytes,
      l.masters_count,
      l.vouchers_count,
      l.ledgers_imported,
      l.stock_items_imported,
      l.vouchers_reconciled,
      l.status,
      l.reconciliation_summary,
      l.error_message,
      l.created_at,
      l.completed_at,
      c.company_code,
      coalesce(c.display_name, c.legal_name) as company_name,
      u.full_name as imported_by_name
    from tally_import_logs l
    join companies c on c.id = l.company_id
    left join erp_users u on u.id = l.imported_by
  `;
  const params = [];
  if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    query += ` where l.company_id = $1`;
  }
  query += ` order by l.created_at desc limit 50`;

  const res = await client.query(query, params);
  return res.rows;
}

/**
 * Fetch Voucher Reconciliations for an entity or batch
 */
async function getTallyReconciliationVouchers(client, { companyId = null, importLogId = null, status = "", search = "" } = {}) {
  const where = [];
  const params = [];

  if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    where.push(`r.company_id = $${params.length}`);
  }
  if (Number.isFinite(Number(importLogId)) && Number(importLogId) > 0) {
    params.push(Number(importLogId));
    where.push(`r.import_log_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`r.reconciliation_status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const sParam = `$${params.length}`;
    where.push(`(r.voucher_number ilike ${sParam} or r.party_name ilike ${sParam})`);
  }

  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const query = `
    select
      r.*,
      c.company_code,
      coalesce(c.display_name, c.legal_name) as company_name
    from tally_voucher_reconciliations r
    join companies c on c.id = r.company_id
    ${whereSql}
    order by r.voucher_date desc, r.id desc
    limit 200
  `;

  const res = await client.query(query, params);
  return res.rows;
}

/**
 * Fetch Master Mappings
 */
async function getTallyMasterMappings(client, { companyId = null, masterType = "", search = "" } = {}) {
  const where = [];
  const params = [];

  if (Number.isFinite(Number(companyId)) && Number(companyId) > 0) {
    params.push(Number(companyId));
    where.push(`m.company_id = $${params.length}`);
  }
  if (masterType) {
    params.push(masterType);
    where.push(`m.master_type = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const sParam = `$${params.length}`;
    where.push(`(m.tally_name ilike ${sParam} or coalesce(m.tally_parent_group, '') ilike ${sParam})`);
  }

  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const query = `
    select
      m.*,
      c.company_code,
      coalesce(c.display_name, c.legal_name) as company_name
    from tally_master_mappings m
    join companies c on c.id = m.company_id
    ${whereSql}
    order by m.tally_name asc
    limit 250
  `;

  const res = await client.query(query, params);
  return res.rows;
}

module.exports = {
  parseTallyData,
  resolveCompany,
  calculateSimilarity,
  extractTallyCustomerOrderFields,
  extractTallyVoucherMeta,
  isTallySalesVoucher,
  isTallyReceiptVoucher,
  buildInvoiceLinesFromTallyVoucher,
  computeTallySalesInvoiceTotals,
  extractTaxFromLedgerEntries,
  applyTallyReceiptBillAllocations,
  enrichTallyInvoiceFromVoucherRaw,
  enrichTallyInvoicesFromVouchers,
  enrichTallyReceiptFromVoucherRaw,
  stageAndAutoMatchTally,
  getStagedRecords,
  updateStagedRecordAction,
  bulkApproveStagingBatch,
  commitStagingBatchToLive,
  getTallyImportLogs,
  getTallyReconciliationVouchers,
  getTallyMasterMappings,
  createJoshReceiptFromTallyVoucher,
  resolveOrCreateCustomerForParty,
  getDefaultInrCurrencyId: getDefaultInrCurrencyId,
};
