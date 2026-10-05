const fs = require("fs");
const readline = require("readline");

const path = "Transactions (1).xml";
const fd = fs.openSync(path, "r");
const bom = Buffer.alloc(4);
fs.readSync(fd, bom, 0, 4, 0);
fs.closeSync(fd);
const isUtf16le = bom[0] === 0xff && bom[1] === 0xfe;
const encoding = isUtf16le ? "utf16le" : "utf8";

const vchTypes = Object.create(null);
const voucherTypenames = Object.create(null);
const numberPrefixes = Object.create(null);
const partyFreq = Object.create(null);
const inventoryItemFreq = Object.create(null);

let vouchers = 0;
let minDate = null;
let maxDate = null;
let salesInvoiceish = 0;
let receipts = 0;
let payments = 0;
let journals = 0;
let creditNotes = 0;
let purchase = 0;
let withStock = 0;
let tiLike = 0;
let aiLike = 0;
let soLike = 0;
let qLike = 0;
let company = "";
let reportName = "";
let sampleSales = [];
let sampleReceipts = [];

let inVoucher = false;
let cur = {};
let bufLines = 0;

function flush() {
  if (!cur.vchtype && !cur.vouchertypename) return;
  vouchers += 1;
  const t = String(cur.vchtype || cur.vouchertypename || "UNKNOWN");
  vchTypes[t] = (vchTypes[t] || 0) + 1;
  const tn = String(cur.vouchertypename || "");
  if (tn) voucherTypenames[tn] = (voucherTypenames[tn] || 0) + 1;
  const d = cur.date;
  if (d && /^\d{8}$/.test(d)) {
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  }
  const num = String(cur.vouchernumber || "");
  let pref = "(blank)";
  if (num) {
    const m = num.match(/^([A-Za-z]+)/);
    pref = m ? m[1] : num.slice(0, 6);
  }
  numberPrefixes[pref] = (numberPrefixes[pref] || 0) + 1;
  if (/^TI/i.test(num)) tiLike += 1;
  if (/^AI[\/\-]/i.test(num)) aiLike += 1;
  if (/^S\d/i.test(num) || /^SO/i.test(num)) soLike += 1;
  if (/^Q\d/i.test(num)) qLike += 1;
  const tl = t.toLowerCase();
  if (/sales|invoice|tax invoice|debit note/.test(tl)) salesInvoiceish += 1;
  if (/receipt/.test(tl)) receipts += 1;
  if (/payment/.test(tl)) payments += 1;
  if (/journal/.test(tl)) journals += 1;
  if (/credit/.test(tl)) creditNotes += 1;
  if (/purchase/.test(tl)) purchase += 1;
  if (cur.hasStock) withStock += 1;
  if (cur.party) partyFreq[cur.party] = (partyFreq[cur.party] || 0) + 1;
  if (cur.stockItems) {
    for (const item of cur.stockItems) {
      inventoryItemFreq[item] = (inventoryItemFreq[item] || 0) + 1;
    }
  }
  if (
    sampleSales.length < 10 &&
    (/sales|invoice|tax/i.test(t) || /^TI|^AI[\/\-]/i.test(num))
  ) {
    sampleSales.push({
      type: t,
      num,
      date: d,
      party: cur.party || null,
      amount: cur.amount || null,
      items: (cur.stockItems || []).slice(0, 3),
    });
  }
  if (sampleReceipts.length < 6 && /receipt/i.test(t)) {
    sampleReceipts.push({ type: t, num, date: d, party: cur.party || null, amount: cur.amount || null });
  }
  cur = {};
}

function top(obj, n = 20) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

const rl = readline.createInterface({
  input: fs.createReadStream(path, { encoding }),
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  bufLines += 1;
  if (!company) {
    const m = line.match(/<SVCURRENTCOMPANY>([^<]+)<\/SVCURRENTCOMPANY>/);
    if (m) company = m[1];
  }
  if (!reportName) {
    const m = line.match(/<REPORTNAME>([^<]+)<\/REPORTNAME>/);
    if (m) reportName = m[1];
  }
  if (/<VOUCHER[\s>]/.test(line)) {
    inVoucher = true;
    const m = line.match(/VCHTYPE="([^"]+)"/);
    if (m) cur.vchtype = m[1];
  }
  if (!inVoucher) return;
  let m;
  if ((m = line.match(/<VOUCHERTYPENAME>([^<]*)<\/VOUCHERTYPENAME>/))) cur.vouchertypename = m[1];
  if ((m = line.match(/<DATE>(\d{8})<\/DATE>/))) cur.date = m[1];
  if ((m = line.match(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/))) cur.vouchernumber = m[1];
  if ((m = line.match(/<PARTYLEDGERNAME>([^<]*)<\/PARTYLEDGERNAME>/))) cur.party = m[1];
  if ((m = line.match(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/))) {
    if (cur.amount == null) cur.amount = m[1];
  }
  if ((m = line.match(/<STOCKITEMNAME>([^<]*)<\/STOCKITEMNAME>/))) {
    if (!cur.stockItems) cur.stockItems = [];
    cur.stockItems.push(m[1]);
    cur.hasStock = true;
  }
  if (/ALLINVENTORYENTRIES\.LIST|INVENTORYENTRIES\.LIST/.test(line)) cur.hasStock = true;
  if (/<\/VOUCHER>/.test(line)) {
    inVoucher = false;
    flush();
  }
});

rl.on("close", () => {
  flush();
  const out = {
    encoding,
    company,
    reportName,
    lines: bufLines,
    vouchers,
    minDate,
    maxDate,
    salesInvoiceish,
    receipts,
    payments,
    journals,
    creditNotes,
    purchase,
    withStock,
    tiLike,
    aiLike,
    soLike,
    qLike,
    topVchTypes: top(vchTypes, 30),
    topTypenames: top(voucherTypenames, 30),
    topNumberPrefixes: top(numberPrefixes, 30),
    topParties: top(partyFreq, 15),
    topStockItems: top(inventoryItemFreq, 20),
    sampleSales,
    sampleReceipts,
  };
  fs.writeFileSync("_tmp_tally_tx_summary.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
