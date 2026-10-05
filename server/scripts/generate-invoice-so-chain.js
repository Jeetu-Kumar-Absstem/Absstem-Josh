const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const { parseTallyData } = require("../src/services/tallyEngine");
const { normalizeJobNo } = require("../src/services/tallyInvoiceEnrichment");

const ROOT = path.resolve(__dirname, "../..");
const SO_FILE = path.join(ROOT, "SalesOrderReport_02-Sep-2026.xlsx");
const TX_FILE = path.join(ROOT, "Transactions (1).xml");
const OUT_FILE = path.join(ROOT, "tally-invoice-so-chain-link.csv");
const OUT_REVIEW = path.join(ROOT, "tally-invoice-so-chain-link-review.csv");

function normCust(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .split(":")[0]
    .replace(/\b(PVT|LTD|LIMITED|PRIVATE|CO|COMPANY|INDUSTRIES|INDUSTRIAL)\b/gi, "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
}

function custKeysMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length, 10);
  if (min >= 6 && a.slice(0, min) === b.slice(0, min)) return true;
  return a.includes(b) || b.includes(a);
}

function findCustomerSos(partyName) {
  const key = normCust(partyName);
  const matches = [];
  for (const [custKey, rows] of soByCustomer.entries()) {
    if (custKeysMatch(key, custKey)) matches.push(...rows);
  }
  return matches;
}

function isTallyNaPo(po) {
  if (!po) return true;
  const t = String(po)
    .replace(/\u0004/g, "")
    .replace(/&#4;/gi, "")
    .trim();
  return !t || /not applicable/i.test(t) || /^n\/a$/i.test(t);
}

function parseSoDate(s) {
  const m = String(s || "").match(/^(\d{2})-(\w{3})-(\d{4})$/);
  if (!m) return null;
  const months = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  };
  const mon = months[m[2]];
  if (mon === undefined) return null;
  return new Date(Date.UTC(+m[3], mon, +m[1]));
}

function csvCell(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const soRows = XLSX.utils.sheet_to_json(XLSX.readFile(SO_FILE).Sheets.Sheet1, { defval: "" });
const soByNumber = new Map();
const soByCustomer = new Map();

for (const r of soRows) {
  const so = String(r["SO No"] || "").trim();
  if (!so) continue;
  const entry = {
    so,
    date: parseSoDate(r["SO Date"]),
    dateStr: r["SO Date"],
    customer: String(r.Customer || "").split(":")[0].trim(),
    customerKey: normCust(r.Customer),
    status: r.Status,
    jobNo: normalizeJobNo(r.JobNo),
  };
  soByNumber.set(so.toUpperCase(), entry);
  if (!soByCustomer.has(entry.customerKey)) soByCustomer.set(entry.customerKey, []);
  soByCustomer.get(entry.customerKey).push(entry);
}

const { vouchers } = parseTallyData(fs.readFileSync(TX_FILE), "Transactions (1).xml");
const sales = vouchers.filter((v) => String(v.voucher_type).toLowerCase() === "sales");

const links = [];
const seen = new Set();

function addLink(inv, soEntry, method) {
  const key = `${inv.voucher_number}|${soEntry.so}`;
  if (seen.has(key)) return;
  seen.add(key);
  const po = isTallyNaPo(inv.customer_po_number) ? "" : String(inv.customer_po_number || "").trim();
  links.push({
    invoice_number: inv.voucher_number,
    so_number: soEntry.so,
    customer_po_number: po,
    customer_po_date: inv.customer_po_date || "",
    job_no: soEntry.jobNo || "",
    method,
    customer: soEntry.customer,
    invoice_date: inv.date || "",
    so_date: soEntry.dateStr || "",
  });
}

const MANUAL_OVERRIDES = {
  "INV-AI/26-27/053": "S26000073",
  "INV-AI/26-27/050": "S26000070",
  "INV-AI/26-27/047": "S26000074",
  "INV-AI/26-27/048": "S26000064",
  "INV-AI/26-27/051": "S26000064",
  "INV-AI/26-27/052": "S26000064",
  "INV-AI/26-27/045": "S26000063",
};

for (const inv of sales) {
  const overrideSo = MANUAL_OVERRIDES[inv.voucher_number];
  if (overrideSo && soByNumber.has(overrideSo.toUpperCase())) {
    addLink(inv, soByNumber.get(overrideSo.toUpperCase()), "manual_override");
    continue;
  }

  const po = String(inv.customer_po_number || "").trim();
  const poUpper = po.toUpperCase();

  if (!isTallyNaPo(po) && soByNumber.has(poUpper)) {
    addLink(inv, soByNumber.get(poUpper), "direct_po_is_so");
    continue;
  }

  const invDate = inv.date ? new Date(`${inv.date}T00:00:00Z`) : null;
  const candidates = findCustomerSos(inv.party_name).filter((s) => s.status === "Approved");
  if (!candidates.length) continue;

  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (!c.date || !invDate) continue;
    const diffDays = (invDate.getTime() - c.date.getTime()) / 86400000;
    if (diffDays < -7 || diffDays > 120) continue;
    const score = Math.abs(diffDays) + (c.so.startsWith("S26") ? 0 : 5);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best && bestScore < 90) {
    addLink(inv, best, "customer_date_match");
  }
}

links.sort((a, b) => a.invoice_number.localeCompare(b.invoice_number));

const uploadHeader = "invoice_number,so_number,customer_po_number,customer_po_date,job_no";
const uploadLines = [uploadHeader];
for (const l of links) {
  uploadLines.push(
    [l.invoice_number, l.so_number, l.customer_po_number, l.customer_po_date, l.job_no].map(csvCell).join(",")
  );
}
fs.writeFileSync(OUT_FILE, `${uploadLines.join("\n")}\n`, "utf8");

const reviewHeader =
  "invoice_number,so_number,customer_po_number,customer_po_date,job_no,match_method,invoice_date,so_date,customer";
const reviewLines = [reviewHeader];
for (const l of links) {
  reviewLines.push(
    [
      l.invoice_number,
      l.so_number,
      l.customer_po_number,
      l.customer_po_date,
      l.job_no,
      l.method,
      l.invoice_date,
      l.so_date,
      l.customer,
    ]
      .map(csvCell)
      .join(",")
  );
}
fs.writeFileSync(OUT_REVIEW, `${reviewLines.join("\n")}\n`, "utf8");

const OUT_HIGH = path.join(ROOT, "tally-invoice-so-chain-link-high-confidence.csv");
const highLines = [uploadHeader];
for (const l of links) {
  if (l.method === "direct_po_is_so" || l.method === "manual_override") {
    highLines.push(
      [l.invoice_number, l.so_number, l.customer_po_number, l.customer_po_date, l.job_no].map(csvCell).join(",")
    );
  }
}
fs.writeFileSync(OUT_HIGH, `${highLines.join("\n")}\n`, "utf8");

const byMethod = {};
for (const l of links) byMethod[l.method] = (byMethod[l.method] || 0) + 1;

console.log(JSON.stringify({
  total_sales_vouchers: sales.length,
  total_links: links.length,
  unlinked: sales.length - new Set(links.map((l) => l.invoice_number)).size,
  by_method: byMethod,
  upload_file: OUT_FILE,
  review_file: OUT_REVIEW,
  high_confidence_file: OUT_HIGH,
  sample_26_27: links.filter((l) => l.invoice_number.includes("26-27")).slice(-12),
}, null, 2));
