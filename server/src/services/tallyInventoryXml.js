const MONTHS = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

function readInventoryXml(filePath) {
  const fs = require("fs");
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function nameKey(value) {
  return decodeXml(value)
    .replace(/[“”"']/g, "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseLeafTags(xml) {
  const tags = [];
  const re = /<([A-Z0-9]+)>([^<]*)<\/\1>/g;
  let match;
  while ((match = re.exec(xml))) {
    tags.push({ name: match[1], value: decodeXml(match[2]) });
  }
  return tags;
}

function parseQty(raw) {
  const s = decodeXml(raw);
  if (!s) return { qty: 0, uom: null };
  const match = s.match(/^(-?\d+(?:,\d{3})*(?:\.\d+)?)\s*(.*)$/);
  if (!match) return { qty: 0, uom: s || null };
  const qty = Number(String(match[1]).replace(/,/g, ""));
  let uom = String(match[2] || "").trim();
  if (/^pcs\.?$/i.test(uom)) uom = "Pcs";
  else if (/^nos\.?$/i.test(uom)) uom = "Nos";
  else if (/^kgs?$/i.test(uom)) uom = "Kgs";
  else if (/^ltr?s?\.?$/i.test(uom)) uom = "Ltr";
  return { qty: Number.isFinite(qty) ? qty : 0, uom: uom || null };
}

function parseDate(raw) {
  const s = decodeXml(raw);
  const match = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (!match) return null;
  const month = MONTHS[match[2]];
  if (!month) return null;
  const year = 2000 + Number(match[3]);
  const day = String(Number(match[1])).padStart(2, "0");
  const mon = String(month).padStart(2, "0");
  return `${year}-${mon}-${day}`;
}

function parseMoney(raw) {
  const s = decodeXml(raw).replace(/,/g, "");
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseVoucherNumber(raw) {
  const s = decodeXml(raw);
  if (!s) return null;
  const match = s.match(/No\.\s*:\s*(.+?)\s*\)?\s*$/i) || s.match(/\((?:No\.\s*:)?\s*(.+?)\)/i);
  const value = (match ? match[1] : s).replace(/[()]/g, "").trim();
  return value || null;
}

function normalizeVoucherType(raw) {
  const s = decodeXml(raw).toLowerCase();
  if (s.startsWith("purc") || s === "purchase") return "Purc";
  if (s.startsWith("sale")) return "Sale";
  if (s.includes("jrnl") || s.includes("journal") || s.includes("stk")) return "Stk Jrnl";
  if (s.startsWith("opn") || s.includes("opening")) return "Opn";
  return decodeXml(raw) || "Other";
}

function movementRefType(voucherType) {
  if (voucherType === "Purc") return "TALLY_PURCHASE";
  if (voucherType === "Sale") return "TALLY_SALE";
  if (voucherType === "Stk Jrnl") return "TALLY_STOCK_JOURNAL";
  if (voucherType === "Opn") return "TALLY_OPENING";
  if (voucherType === "C/Note") return "TALLY_CREDIT_NOTE";
  if (voucherType === "D/Note") return "TALLY_DEBIT_NOTE";
  return "TALLY_STOCK";
}

function inferCatalogGroup(itemName) {
  const s = String(itemName || "").toLowerCase();
  if (/valve|nrv|sov/.test(s)) return "Valves";
  if (/filter/.test(s)) return "Filters";
  if (/sensor|transmitter|probe/.test(s)) return "Sensors";
  if (/tank|vessel/.test(s)) return "Tanks";
  if (/kit/.test(s)) return "Service Kits";
  if (/flange|gasket|fitting/.test(s)) return "Fittings";
  if (/pipe|tubing/.test(s)) return "Piping";
  if (/chiller|compressor|generator|heater|panel|machine/.test(s)) return "Equipment";
  if (/ball|alumina|palladium|chemical|media/.test(s)) return "Consumables";
  return "Components";
}

function fingerprint(row) {
  return [
    nameKey(row.item_title),
    row.voucher_date || "",
    row.voucher_type || "",
    String(row.voucher_number || "").trim().toUpperCase(),
    Number(row.qty_signed || 0).toFixed(4),
    Number(row.unit_cost_base || 0).toFixed(4),
  ].join("|");
}

function flushVoucher(item, voucher, rows) {
  if (!item || !voucher || !voucher.voucher_date || !voucher.voucher_type) return;
  const qtyIn = Number(voucher.qty_in || 0);
  const qtyOut = Number(voucher.qty_out || 0);
  if (Math.abs(qtyIn) < 0.0001 && Math.abs(qtyOut) < 0.0001) return;
  const qtySigned = qtyIn - qtyOut;
  const rate = qtySigned >= 0 ? Number(voucher.in_rate || 0) : Number(voucher.out_rate || 0);
  const amount = qtySigned >= 0 ? Math.abs(Number(voucher.in_amount || 0)) : Math.abs(Number(voucher.out_amount || 0));
  const unitCost = Math.abs(rate) > 0 ? Math.abs(rate) : Math.abs(qtySigned) > 0.0001 ? amount / Math.abs(qtySigned) : 0;
  const closingQty = voucher.closing_qty == null ? null : Number(voucher.closing_qty);
  const closingRate = voucher.closing_rate == null ? null : Math.abs(Number(voucher.closing_rate));
  const closingAmountRaw = voucher.closing_amount == null ? null : Number(voucher.closing_amount);
  const closingAmount =
    closingAmountRaw == null || !Number.isFinite(closingAmountRaw) ? null : Math.abs(closingAmountRaw);
  const row = {
    item_title: item.item_title,
    uom: voucher.uom || item.uom || "Nos",
    voucher_date: voucher.voucher_date,
    voucher_type: voucher.voucher_type,
    voucher_number: voucher.voucher_number || null,
    narration: voucher.narration || null,
    qty_in: qtyIn,
    qty_out: qtyOut,
    qty_signed: qtySigned,
    unit_cost_base: Number(unitCost.toFixed(4)),
    value_signed_base: Number((qtySigned * unitCost).toFixed(2)),
    closing_qty: closingQty,
    closing_rate: closingRate == null || !Number.isFinite(closingRate) ? null : Number(closingRate.toFixed(4)),
    closing_amount: closingAmount == null ? null : Number(closingAmount.toFixed(2)),
  };
  row.source_fingerprint = fingerprint(row);
  rows.push(row);
}

function parseInventoryXml(xmlText) {
  const tags = parseLeafTags(xmlText);
  const items = [];
  const rows = [];
  let currentItem = null;
  let currentVoucher = null;
  const types = new Map();

  function startItem(title) {
    flushVoucher(currentItem, currentVoucher, rows);
    currentVoucher = null;
    currentItem = { item_title: title, uom: null };
    items.push(currentItem);
  }

  function startVoucher(date) {
    flushVoucher(currentItem, currentVoucher, rows);
    currentVoucher = {
      voucher_date: date,
      voucher_type: null,
      voucher_number: null,
      narration: null,
      qty_in: 0,
      qty_out: 0,
      in_rate: 0,
      out_rate: 0,
      in_amount: 0,
      out_amount: 0,
      closing_qty: null,
      closing_rate: null,
      closing_amount: null,
      uom: null,
    };
  }

  for (const tag of tags) {
    if (tag.name === "STKVCHPRNITEMTITLE" && tag.value) {
      startItem(tag.value);
      continue;
    }
    if (!currentItem) continue;

    if (tag.name === "DSPVCHDATE" && tag.value) {
      const date = parseDate(tag.value);
      if (date) startVoucher(date);
      continue;
    }
    if (!currentVoucher) continue;

    if (tag.name === "DSPVCHTYPE" && tag.value) {
      currentVoucher.voucher_type = normalizeVoucherType(tag.value);
      types.set(currentVoucher.voucher_type, (types.get(currentVoucher.voucher_type) || 0) + 1);
      continue;
    }
    if (tag.name === "DSPVCHINQTY" && tag.value) {
      const parsed = parseQty(tag.value);
      currentVoucher.qty_in = parsed.qty;
      currentVoucher.uom = parsed.uom || currentVoucher.uom;
      currentItem.uom = currentItem.uom || parsed.uom;
      continue;
    }
    if (tag.name === "DSPVCHOUTQTY" && tag.value) {
      const parsed = parseQty(tag.value);
      currentVoucher.qty_out = parsed.qty;
      currentVoucher.uom = parsed.uom || currentVoucher.uom;
      currentItem.uom = currentItem.uom || parsed.uom;
      continue;
    }
    if (tag.name === "DSPVCHINRATE" && tag.value) {
      currentVoucher.in_rate = parseMoney(tag.value);
      continue;
    }
    if (tag.name === "DSPVCHOUTRATE" && tag.value) {
      currentVoucher.out_rate = parseMoney(tag.value);
      continue;
    }
    if (tag.name === "DSPVCHINAMT" && tag.value) {
      currentVoucher.in_amount = parseMoney(tag.value);
      continue;
    }
    if (tag.name === "DSPVCHNETTOUTAMT" && tag.value) {
      currentVoucher.out_amount = parseMoney(tag.value);
      continue;
    }
    if (tag.name === "DSPVCHCLQTY" && tag.value) {
      currentVoucher.closing_qty = parseQty(tag.value).qty;
      continue;
    }
    if (tag.name === "DSPVCHCLRATE" && tag.value) {
      currentVoucher.closing_rate = parseMoney(tag.value);
      continue;
    }
    if (tag.name === "DSPVCHCLAMT" && tag.value) {
      currentVoucher.closing_amount = parseMoney(tag.value);
      continue;
    }
    if (tag.name === "DSPVCHNARR" && tag.value) {
      currentVoucher.narration = tag.value;
      continue;
    }
    if (tag.name === "DSPEXPLVCHNUMBER" && tag.value) {
      currentVoucher.voucher_number = parseVoucherNumber(tag.value);
    }
  }

  flushVoucher(currentItem, currentVoucher, rows);

  const uniqueItems = [];
  const seen = new Set();
  for (const item of items) {
    const key = nameKey(item.item_title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(item);
  }

  return {
    items: uniqueItems,
    rows,
    typeCounts: Object.fromEntries(types),
  };
}

/**
 * Last Tally-reported closing per item (from DSPCLBLOCK on voucher lines).
 * Prefers closing_amount/qty when present; falls back to summed qty_signed.
 */
function computeTallyInventoryClosings(parsed) {
  const byItem = new Map();
  for (const row of parsed.rows || []) {
    const key = nameKey(row.item_title);
    if (!key) continue;
    const cur = byItem.get(key) || {
      item_title: row.item_title,
      uom: row.uom || "Nos",
      qty_sum: 0,
      value_sum: 0,
      closing_qty: null,
      closing_rate: null,
      closing_amount: null,
      as_of: null,
    };
    cur.qty_sum = Number((cur.qty_sum + Number(row.qty_signed || 0)).toFixed(4));
    cur.value_sum = Number((cur.value_sum + Number(row.value_signed_base || 0)).toFixed(2));
    if (row.uom) cur.uom = row.uom;
    const hasClose =
      row.closing_qty != null ||
      row.closing_amount != null ||
      (row.closing_rate != null && Number(row.closing_rate) > 0);
    if (hasClose) {
      if (!cur.as_of || String(row.voucher_date || "") >= String(cur.as_of || "")) {
        cur.as_of = row.voucher_date || cur.as_of;
        if (row.closing_qty != null) cur.closing_qty = Number(row.closing_qty);
        if (row.closing_rate != null) cur.closing_rate = Number(row.closing_rate);
        if (row.closing_amount != null) cur.closing_amount = Number(row.closing_amount);
      }
    }
    byItem.set(key, cur);
  }

  const closings = [];
  let openItems = 0;
  let totalQty = 0;
  let totalValue = 0;
  for (const [key, cur] of byItem.entries()) {
    let qty = cur.closing_qty != null ? Number(cur.closing_qty) : Number(cur.qty_sum);
    let value = null;
    if (Math.abs(qty) < 0.0001) {
      qty = 0;
      value = 0;
    } else if (cur.closing_amount != null) {
      value = Number(cur.closing_amount);
    } else if (cur.closing_rate != null) {
      value = Number((qty * Number(cur.closing_rate)).toFixed(2));
    } else {
      value = Math.max(0, Number(cur.value_sum));
    }
    if (value < 0) value = Math.abs(value);
    const rate =
      Math.abs(qty) > 0.0001 ? Number((Number(value || 0) / qty).toFixed(4)) : 0;
    const row = {
      key,
      item_title: cur.item_title,
      uom: cur.uom,
      qty: Number(qty.toFixed(4)),
      value: Number(Number(value || 0).toFixed(2)),
      rate,
      as_of: cur.as_of,
      source: cur.closing_qty != null || cur.closing_amount != null ? "tally_closing" : "movement_sum",
    };
    if (Math.abs(row.qty) > 0.0001 || Math.abs(row.value) > 0.01) openItems += 1;
    totalQty += row.qty;
    totalValue += row.value;
    closings.push(row);
  }
  closings.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return {
    item_count: closings.length,
    open_items: openItems,
    total_qty: Number(totalQty.toFixed(4)),
    total_value: Number(totalValue.toFixed(2)),
    closings,
  };
}

module.exports = {
  computeTallyInventoryClosings,
  decodeXml,
  fingerprint,
  inferCatalogGroup,
  movementRefType,
  nameKey,
  parseDate,
  parseInventoryXml,
  parseQty,
  parseVoucherNumber,
  readInventoryXml,
};
