/**
 * Summarize Transactions (1).xml against ECC as-of / MTD windows.
 * Usage: node scripts/summarize-tally-transactions-xml.js
 */
const fs = require("fs");
const path = require("path");
const { parseTallyData } = require("../src/services/tallyEngine");

const ROOT = path.resolve(__dirname, "../..");
const FILE = path.join(ROOT, "Transactions (1).xml");
const AS_OF = "2026-09-07";
const MTD_FROM = "2026-09-01";

function money(n) {
  const v = Number(n) || 0;
  return Math.round(v * 100) / 100;
}

function inr(n) {
  return money(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function typeKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isBankCash(name) {
  const n = String(name || "").trim();
  const lower = n.toLowerCase();
  if (!lower) return false;
  if (/loan|interest|charges|insurance|lombard|inelligible|ineligible|accrude|accrued/.test(lower)) return false;
  if (lower === "cash") return true;
  if (/^icici bank\b/.test(lower) && /\d{6,}/.test(lower)) return true;
  if (/^hdfc bank\b/.test(lower) && !/loan/.test(lower)) return true;
  if (/^axis bank\b|^sbi\b|^state bank|^kotak|^yes bank|^idfc/.test(lower)) return true;
  return false;
}

function isGstLedger(name) {
  return /^(output|input)\s+(cgst|sgst|igst)$/i.test(String(name || "").trim()) ||
    /^cash\s*-\s*(cgst|sgst|igst)$/i.test(String(name || "").trim());
}

function isInputGst(name) {
  const lower = String(name || "").toLowerCase();
  return /input/.test(lower) || /\bitc\b/.test(lower);
}

function voucherKind(type) {
  const t = typeKey(type);
  if (t.includes("receipt")) return "receipt";
  if (t.includes("payment")) return "payment";
  if (t.includes("contra")) return "contra";
  if (t.includes("credit note") || t === "c/note") return "credit_note";
  if (t.includes("debit note") || t === "d/note") return "debit_note";
  if (t.includes("purchase")) return "purchase";
  if (t.includes("sale")) return "sales";
  if (t.includes("journal")) return "journal";
  if (t.includes("stock journal")) return "stock_journal";
  return "other";
}

function signedForAsset(entry) {
  const amt = money(entry.amount);
  return entry.is_debit ? amt : -amt;
}

function signedForLiability(entry) {
  const amt = money(entry.amount);
  return entry.is_debit ? -amt : amt;
}

console.error("Reading", FILE);
const buf = fs.readFileSync(FILE);
console.error("bytes", buf.length);
const parsed = parseTallyData(buf, "Transactions (1).xml");
const vouchers = parsed.vouchers || [];
console.error("vouchers", vouchers.length, "ledgers", (parsed.ledgers || []).length, "company", parsed.tallyCompanyName);

const byType = new Map();
let minDate = null;
let maxDate = null;

const asOf = {
  sales: 0,
  salesCount: 0,
  purchases: 0,
  purchaseCount: 0,
  receipts: 0,
  receiptCount: 0,
  payments: 0,
  paymentCount: 0,
  creditNotes: 0,
  debitNotes: 0,
  cash: 0,
  gstLiability: 0,
  gstInput: 0,
  gstOutput: 0,
};

const mtd = {
  sales: 0,
  salesCount: 0,
  purchases: 0,
  purchaseCount: 0,
  receipts: 0,
  receiptCount: 0,
  payments: 0,
  paymentCount: 0,
};

const bankLedgers = new Map();
const gstLedgers = new Map();
const partyDr = new Map();
const partyCr = new Map();
const byYear = new Map();
let receiptsWithAgst = 0;
let receiptsOnAccount = 0;
let receiptAgstAmount = 0;

function bumpMap(map, key, delta) {
  map.set(key, money((map.get(key) || 0) + delta));
}

for (const v of vouchers) {
  const t = v.voucher_type || "Unknown";
  const rec = byType.get(t) || { count: 0, amount: 0 };
  rec.count += 1;
  rec.amount += money(v.amount);
  byType.set(t, rec);
  if (v.date) {
    if (!minDate || v.date < minDate) minDate = v.date;
    if (!maxDate || v.date > maxDate) maxDate = v.date;
  }
  const asOfOk = !v.date || v.date <= AS_OF;
  const mtdOk = v.date && v.date >= MTD_FROM && v.date <= AS_OF;
  const kind = voucherKind(t);

  if (asOfOk) {
    if (kind === "sales") {
      asOf.sales += money(v.amount);
      asOf.salesCount += 1;
    } else if (kind === "purchase") {
      asOf.purchases += money(v.amount);
      asOf.purchaseCount += 1;
    } else if (kind === "receipt") {
      asOf.receipts += money(v.amount);
      asOf.receiptCount += 1;
    } else if (kind === "payment") {
      asOf.payments += money(v.amount);
      asOf.paymentCount += 1;
    } else if (kind === "credit_note") {
      asOf.creditNotes += money(v.amount);
    } else if (kind === "debit_note") {
      asOf.debitNotes += money(v.amount);
    }
  }

  if (mtdOk) {
    if (kind === "sales") {
      mtd.sales += money(v.amount);
      mtd.salesCount += 1;
    } else if (kind === "purchase") {
      mtd.purchases += money(v.amount);
      mtd.purchaseCount += 1;
    } else if (kind === "receipt") {
      mtd.receipts += money(v.amount);
      mtd.receiptCount += 1;
    } else if (kind === "payment") {
      mtd.payments += money(v.amount);
      mtd.paymentCount += 1;
    }
  }

  const year = (v.date || "").slice(0, 4) || "unknown";
  const yrec = byYear.get(year) || { sales: 0, receipts: 0, purchases: 0, payments: 0 };
  if (kind === "sales") yrec.sales += money(v.amount);
  if (kind === "receipt") yrec.receipts += money(v.amount);
  if (kind === "purchase") yrec.purchases += money(v.amount);
  if (kind === "payment") yrec.payments += money(v.amount);
  byYear.set(year, yrec);

  if (kind === "receipt") {
    let agst = 0;
    for (const e of v.entries || []) {
      for (const b of e.bill_allocations || []) {
        const bt = String(b.bill_type || "").toLowerCase();
        if (bt.includes("agst") || bt.includes("against")) {
          agst += money(b.amount);
        }
      }
    }
    if (agst > 0) {
      receiptsWithAgst += 1;
      receiptAgstAmount += agst;
    } else {
      receiptsOnAccount += 1;
    }
  }

  for (const e of v.entries || []) {
    const name = e.ledger_name || "";
    if (isBankCash(name) && asOfOk) {
      const delta = signedForAsset(e);
      asOf.cash += delta;
      bumpMap(bankLedgers, name, delta);
    }
    if (isGstLedger(name) && asOfOk) {
      const delta = signedForLiability(e);
      bumpMap(gstLedgers, name, delta);
      if (isInputGst(name)) asOf.gstInput += signedForAsset(e);
      else asOf.gstOutput += delta;
      asOf.gstLiability += delta;
    }
    if (e.is_party_ledger && asOfOk) {
      const delta = signedForAsset(e);
      if (kind === "sales" || kind === "receipt" || kind === "credit_note" || kind === "debit_note") {
        bumpMap(partyDr, name, delta);
      }
      if (kind === "purchase" || kind === "payment") {
        bumpMap(partyCr, name, -delta);
      }
    }
  }
}

function topMap(map, n = 12) {
  return [...map.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, n)
    .map(([name, amount]) => ({ name, amount: money(amount) }));
}

let arFromParty = 0;
for (const amt of partyDr.values()) if (amt > 0.01) arFromParty += amt;
let apFromParty = 0;
for (const amt of partyCr.values()) if (amt > 0.01) apFromParty += amt;

const out = {
  file: FILE,
  company: parsed.tallyCompanyName,
  gstin: parsed.tallyGstin,
  voucher_count: vouchers.length,
  ledger_master_count: (parsed.ledgers || []).length,
  date_min: minDate,
  date_max: maxDate,
  as_of: AS_OF,
  mtd: `${MTD_FROM} → ${AS_OF}`,
  types: [...byType.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([type, rec]) => ({ type, count: rec.count, amount: money(rec.amount) })),
  as_of_totals: {
    sales: money(asOf.sales),
    sales_count: asOf.salesCount,
    purchases: money(asOf.purchases),
    purchase_count: asOf.purchaseCount,
    receipts: money(asOf.receipts),
    receipt_count: asOf.receiptCount,
    payments: money(asOf.payments),
    payment_count: asOf.paymentCount,
    credit_notes: money(asOf.creditNotes),
    debit_notes: money(asOf.debitNotes),
    implied_ar_sales_minus_receipts: money(asOf.sales - asOf.receipts - asOf.creditNotes + asOf.debitNotes),
    implied_ap_purchases_minus_payments: money(asOf.purchases - asOf.payments),
    cash_bank_from_ledgers: money(asOf.cash),
    gst_liability_from_ledgers: money(asOf.gstLiability),
    gst_output: money(asOf.gstOutput),
    gst_input: money(asOf.gstInput),
    party_ar_open: money(arFromParty),
    party_ap_open: money(apFromParty),
    receipts_with_against_ref: receiptsWithAgst,
    receipts_on_account: receiptsOnAccount,
    receipt_against_ref_amount: money(receiptAgstAmount),
  },
  by_year: [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([year, rec]) => ({
    year,
    sales: money(rec.sales),
    receipts: money(rec.receipts),
    purchases: money(rec.purchases),
    payments: money(rec.payments),
  })),
  mtd_totals: {
    sales: money(mtd.sales),
    sales_count: mtd.salesCount,
    purchases: money(mtd.purchases),
    purchase_count: mtd.purchaseCount,
    receipts: money(mtd.receipts),
    receipt_count: mtd.receiptCount,
    payments: money(mtd.payments),
    payment_count: mtd.paymentCount,
  },
  top_bank_cash: topMap(bankLedgers),
  top_gst: topMap(gstLedgers),
  ecc_screenshot: {
    nwc: 230747557.24,
    cash: 0,
    ar: 271722941.5,
    ap: 0,
    gst: 40975384.26,
  },
};

const OUT_JSON = path.join(ROOT, "server", "storage", "tally-transactions-ecc-check.json");
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
console.error("wrote", OUT_JSON);
console.error("\n--- readable ---");
console.error("Company:", out.company, out.gstin);
console.error("Vouchers:", out.voucher_count, "from", minDate, "to", maxDate);
console.error("AS OF", AS_OF);
console.error("  Sales", inr(asOf.sales), "n=", asOf.salesCount);
console.error("  Receipts", inr(asOf.receipts), "n=", asOf.receiptCount);
console.error("  Purchases", inr(asOf.purchases), "n=", asOf.purchaseCount);
console.error("  Payments", inr(asOf.payments), "n=", asOf.paymentCount);
console.error("  Implied AR (sales-receipts-CN+DN)", inr(out.as_of_totals.implied_ar_sales_minus_receipts));
console.error("  Implied AP (purchases-payments)", inr(out.as_of_totals.implied_ap_purchases_minus_payments));
console.error("  Cash/Bank ledger net", inr(asOf.cash));
console.error("  GST liability ledger net", inr(asOf.gstLiability), "output", inr(asOf.gstOutput), "input", inr(asOf.gstInput));
console.error("  Receipts Against Ref", receiptsWithAgst, inr(receiptAgstAmount), "On Account", receiptsOnAccount);
console.error("By year", JSON.stringify([...byYear.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([y,r])=>({y,s:inr(r.sales),rc:inr(r.receipts),p:inr(r.purchases),py:inr(r.payments)}))));
console.error("MTD", MTD_FROM, AS_OF);
console.error("  Sales", inr(mtd.sales), "n=", mtd.salesCount);
console.error("  Receipts", inr(mtd.receipts));
console.error("  Purchases", inr(mtd.purchases));
console.error("  Payments", inr(mtd.payments));
console.error("ECC AR", inr(out.ecc_screenshot.ar), "GST", inr(out.ecc_screenshot.gst), "Cash", inr(out.ecc_screenshot.cash), "AP", inr(out.ecc_screenshot.ap));
