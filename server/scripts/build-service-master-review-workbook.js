#!/usr/bin/env node
/**
 * Build the Service Master onboarding review workbook.
 *
 * The service team's spreadsheet is the only record of our installed base, but it
 * cannot be imported as-is: installed_equipment.customer_id and
 * service_ticket_parts.product_id are both NOT NULL, so every machine needs a
 * resolved customer and every consumed spare needs an item_code. This script does
 * the resolution it can do mechanically and hands the rest to a human as a
 * tick-the-box workbook.
 *
 * Writes one workbook per company so the two onboarding efforts can run
 * independently — AI is the priority ahead of manufacturing starting.
 *
 *   node scripts/build-service-master-review-workbook.js
 *   node scripts/build-service-master-review-workbook.js --company=AI
 *
 * Reads only; no database connection required.
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const { parseJobRef, ISSUE } = require("../src/services/jobNumber");
const { logDate, swappedDate, isAmbiguousDate } = require("./lib/service-log-dates");

const DEFAULTS = Object.freeze({
  serviceMaster: "Service_master_with_Entry_Form.xlsx",
  customerAI: "CustomerMaster_16-Sep-2026-AI.xlsx",
  customerAT: "CustomerMaster_16-Sep-2026-AT.xlsx",
  invoiceBible: "AI-Invoice-Bible-O2C-2026-09-08.xlsx",
  productMaster: "ProductMaster_Current_AI-AT_20260831_060644.xlsx",
  // Clan sales orders carry the customer code inline and a job number, which is the only
  // deterministic bridge from a service-master serial to a customer.
  salesOrders: "SalesOrderReport_02-Sep-2026.xlsx",
  // Extracted from Clan invoice PDFs: the only source stating the exact SKU sold, including
  // whether a machine is a legacy build or a current SH/UH/HF one.
  invoiceItems: "ERP-invoice-itemwise-report.xlsx",
  // Carries each SKU's flow-versus-purity curve, used to size a machine from the duty the
  // service sheet recorded when nothing states the SKU outright.
  itemMaster: "ItemMaster_AI_10-Sep-2026.xlsx",
  // Sales orders broken out to item level. Uniquely among our sources this names a model
  // *and* a job number on the same order, which is a direct statement of what a given
  // serial is, rather than something inferred.
  soItems: "ERP-sales-order-itemwise-report-fixed.xlsx",
  company: "both",
  outPrefix: "Service_Master_Review",
});

function parseArgs(argv) {
  const out = { root: path.resolve(__dirname, "../../"), ...DEFAULTS };
  for (let i = 2; i < argv.length; i += 1) {
    const [rawKey, rawVal] = argv[i].includes("=") ? argv[i].split(/=(.*)/s) : [argv[i], argv[i + 1]];
    const key = rawKey.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!argv[i].includes("=")) i += 1;
    if (key in out || key === "root") out[key] = rawVal;
  }
  return out;
}

const t = (v) => String(v == null ? "" : v).trim();

// ---------------------------------------------------------------- text helpers

const CORPORATE_NOISE = /\b(PVT|PRIVATE|LTD|LIMITED|LLP|INDIA|CO|COMPANY|THE|AND|INC|PRI|HOLDINGS|ENTERPRISES|CORPORATION|CORP|GROUP|INDUSTRIES|INDUSTRY)\b/g;

function cleanName(s) {
  return t(s).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(CORPORATE_NOISE, " ").replace(/\s+/g, " ").trim();
}

function nameTokens(s) {
  return new Set(cleanName(s).split(" ").filter((w) => w.length > 2));
}

/**
 * Token overlap, 0..1. Deliberately paired with a geography check by callers:
 * on its own it scores "Shree Vardhman Engineering" against "Shree Hospital" at
 * 1.00 because the corporate noise strip leaves a single shared word.
 */
function nameScore(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

const phoneKey = (s) => t(s).replace(/\D/g, "").slice(-10);
const emailKey = (s) => t(s).toLowerCase().replace(/\s+/g, "");

/** Excel serial-date corruption: a bare 2 or 4 in a date column reads as Jul 1905. */
function parseLooseDate(raw) {
  const s = t(raw);
  if (!s) return { iso: null, issue: null };
  if (/^\d{1,3}$/.test(s)) return { iso: null, issue: "DATE_IS_BARE_NUMBER" };
  const m = s.match(/^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})$/);
  if (!m) return { iso: null, issue: "DATE_UNPARSEABLE" };
  let [, a, b, c] = m;
  let year, month, day;
  if (a.length === 4) {
    year = Number(a); month = Number(b); day = Number(c);
  } else {
    day = Number(a); month = Number(b); year = Number(c);
  }
  if (year < 100) year += year < 50 ? 2000 : 1900;
  if (year < 1990) return { iso: null, issue: "DATE_IMPLAUSIBLE_YEAR" };
  if (month < 1 || month > 12 || day < 1 || day > 31) return { iso: null, issue: "DATE_OUT_OF_RANGE" };
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { iso, issue: /\//.test(s) ? "DATE_FORMAT_SLASH" : null };
}

/** Client-name cells that are placeholders, addresses or junk rather than a customer. */
function looksLikeJunkName(s) {
  const v = t(s);
  if (!v) return "CLIENT_NAME_BLANK";
  if (/^\d/.test(v)) return "CLIENT_NAME_IS_ADDRESS";
  if (v.length <= 3) return "CLIENT_NAME_TOO_SHORT";
  if (/^(test|xyz|abcd|abc|na|n\/a|dummy)$/i.test(v)) return "CLIENT_NAME_PLACEHOLDER";
  if (/\//.test(v) && v.split("/").length > 1 && v.length < 40) return "CLIENT_NAME_TWO_NAMES";
  return null;
}

// ---------------------------------------------------------------- loaders

function sheetRows(file, sheetName) {
  const wb = XLSX.readFile(file, { raw: false });
  const name = sheetName || wb.SheetNames[0];
  if (!wb.Sheets[name]) throw new Error(`sheet "${name}" not found in ${path.basename(file)}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "", raw: false });
}

/**
 * The service log, each row carrying the spreadsheet row it came from.
 *
 * sheet_to_json drops blank rows, which would shift every row number after the first gap.
 * A correction sheet is useless if it points at the wrong line, so the grid is walked
 * directly instead.
 */
function loadServiceLogRows(file, sheetName = "Service data") {
  const wb = XLSX.readFile(file, { raw: false });
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`sheet "${sheetName}" not found in ${path.basename(file)}`);
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: true });
  const headers = (grid[0] || []).map((h) => t(h));
  const rows = [];
  for (let i = 1; i < grid.length; i += 1) {
    const line = grid[i];
    if (!line || line.every((c) => !t(c))) continue;
    const row = { __row: i + 1 }; // 1-based, and row 1 is the header
    headers.forEach((h, c) => {
      if (h) row[h] = line[c] == null ? "" : line[c];
    });
    rows.push(row);
  }
  return rows;
}

/** Service Master has a section-label row above the real header row. */
function loadServiceMaster(file) {
  const wb = XLSX.readFile(file, { raw: false });
  const grid = XLSX.utils.sheet_to_json(wb.Sheets["Service Master"], {
    header: 1, defval: "", raw: false, blankrows: false,
  });
  const header = grid[1] || [];
  const col = (re) => header.findIndex((h) => re.test(t(h)));
  const idx = {
    job: col(/^Job No/i),
    segment: col(/CMSS/i),
    capacity: col(/^Capacity/i),
    location: col(/^Location/i),
    client: col(/^Client Name/i),
    address: col(/^Address/i),
    contact: col(/Contact person/i),
    phone: col(/Contact Number/i),
    email: col(/Email/i),
    model: col(/^Model$/i),
    commissioning: col(/Commissioning Date/i),
    warrantyEnd: col(/Warranty over/i),
    accountHolder: col(/Account holder/i),
  };
  const rows = grid.slice(2).filter((r) => (r || []).some((c) => t(c) !== ""));
  return rows.map((r, i) => ({
    rowNo: i + 3,
    job: t(r[idx.job]),
    segment: t(r[idx.segment]),
    capacity: t(r[idx.capacity]),
    location: t(r[idx.location]),
    client: t(r[idx.client]),
    address: t(r[idx.address]),
    contact: t(r[idx.contact]),
    phone: t(r[idx.phone]),
    email: t(r[idx.email]),
    model: t(r[idx.model]),
    commissioning: t(r[idx.commissioning]),
    warrantyEnd: t(r[idx.warrantyEnd]),
    accountHolder: t(r[idx.accountHolder]),
  }));
}

function loadCustomerMaster(file) {
  return sheetRows(file, "Table")
    .filter((r) => t(r.CustomerCode))
    .map((r) => ({
      code: t(r.CustomerCode),
      name: t(r.CustomerName),
      city: t(r.CityName),
      state: t(r.StateName).split(":")[0].trim(),
      pin: t(r.PinCode),
      phone: t(r.PhoneNo),
      email: t(r["Email ID"]),
      active: /^y/i.test(t(r.Active)),
      type: t(r["Customer Type"]),
    }));
}

// ---------------------------------------------------------------- Clan sales orders

/** Clan flattens an order's lines into a single comma-joined cell per column. */
const splitList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

/** "Standard Radiators Pvt. Ltd. : C12759" -> "C12759" */
function inlineCustomerCode(raw) {
  const m = t(raw).match(/:\s*(C\d+)\s*$/i);
  return m ? m[1].toUpperCase() : "";
}

/**
 * Clan's product groups, as they appear on a sales order line. Only the generator groups
 * identify a machine; boosters, dryers, storage vessels and air packages are the
 * surrounding plant, and Spares/Service lines are aftermarket.
 *
 * The purity words are the point of this table: they are the one place, outside an
 * invoice, that says whether a serial is an Ultra/High purity build or a plain legacy
 * one, which the service sheet never records.
 */
const SO_MACHINE_GROUPS = new Map([
  ["nGen Nitrogen Generator Ultra Purity", { family: "NGEN", variant: "UH", era: "current" }],
  ["nGen Nitrogen Generator High Purity", { family: "NGEN", variant: "SH", era: "current" }],
  ["nGen Nitrogen Generator High Flow", { family: "NGEN", variant: "HF", era: "current" }],
  // No purity word: the naming predates the 12-Mar-2025 split, so this is a legacy build.
  ["nGen Nitrogen Generator", { family: "NGEN", variant: null, era: "legacy" }],
  ["nGenx Nitrogen Generator", { family: "NGENX", variant: null, era: null }],
  ["IDOS Oxygen Generator", { family: "IDOS", variant: null, era: null }],
  ["IDOS C", { family: "IDOS_C", variant: null, era: null }],
  // "nGen Nitrogen Generator Package" and "IDOS Oxygen Generator Package" are deliberately
  // absent: Clan files the legacy nGEN*P purity models under the IDOS package group, so a
  // package group states nothing reliable about the family.
]);

function loadSalesOrders(file) {
  return sheetRows(file, "Sheet1")
    .filter((r) => t(r["SO No"]))
    .map((r) => ({
      soNo: t(r["SO No"]),
      soDate: t(r["SO Date"]),
      customerCode: inlineCustomerCode(r.Customer),
      customerName: t(r.Customer).replace(/:\s*C\d+\s*$/i, "").trim(),
      rawJob: t(r.JobNo),
      group: t(r.Group),
      consigneeName: t(r.ConsigneeName),
      consigneeAddress: [t(r.ConsigneeAddressLine1), t(r.ConsigneeAddressLine2)].filter(Boolean).join(", "),
      consigneeCity: t(r.ConsigneeCity),
      consigneePin: t(r.ConsigneePincode),
      consigneePhone: t(r.ConsigneePhoneNo),
      consigneeEmail: t(r.ConsigneeEmailID),
    }));
}

/**
 * job key -> sales order, preferring an order that actually sold a machine.
 *
 * A serial appears on every order ever raised against it, most of which are spares and
 * service. Those are fine for identifying the customer but say nothing about the machine,
 * so a machine-bearing order wins when one exists.
 */
function buildSalesOrderIndex(rows) {
  const byJobKey = new Map();
  for (const so of rows) {
    if (!so.customerCode) continue;
    const sellsMachine = splitList(so.group).some((g) => SO_MACHINE_GROUPS.has(g));
    for (const ref of parseJobRef(so.rawJob).refs) {
      const held = byJobKey.get(ref.key);
      if (!held || (sellsMachine && !held.sellsMachine)) {
        byJobKey.set(ref.key, { ...so, sellsMachine });
      }
    }
  }
  return byJobKey;
}

/**
 * job key -> the machine group sold against it, where the order says so unambiguously.
 *
 * Clan flattens each order's lines into parallel comma lists. When the two lists are the
 * same length they line up positionally; when they are not, an order that mentions exactly
 * one machine group still pins every serial on it to that group. Anything less certain --
 * an order carrying both an nGEN and an IDOS, say -- yields no hint rather than a guess.
 */
function buildJobGroupIndex(rows) {
  const perJob = new Map();
  const note = (jobToken, group) => {
    const spec = SO_MACHINE_GROUPS.get(group);
    if (!spec) return;
    for (const ref of parseJobRef(jobToken).refs) {
      if (!perJob.has(ref.key)) perJob.set(ref.key, new Map());
      perJob.get(ref.key).set(group, spec);
    }
  };

  for (const so of rows) {
    const jobs = splitList(so.rawJob);
    const groups = splitList(so.group);
    if (!jobs.length || !groups.length) continue;

    if (jobs.length === groups.length) {
      jobs.forEach((j, i) => note(j, groups[i]));
      continue;
    }
    const machineGroups = [...new Set(groups.filter((g) => SO_MACHINE_GROUPS.has(g)))];
    if (machineGroups.length === 1) for (const j of jobs) note(j, machineGroups[0]);
  }

  const out = new Map();
  for (const [key, groups] of perJob) {
    if (groups.size !== 1) continue; // two different machines on one serial: not decidable
    const [[group, spec]] = [...groups];
    out.set(key, { group, ...spec });
  }
  return out;
}

// ---------------------------------------------------------------- Clan invoice line items

/**
 * Accessories that share a machine's stem but are not the machine: CP is the
 * compressed-air package, ST the storage vessel. Including them would let a storage
 * vessel masquerade as the generator.
 */
const NON_MACHINE_SUFFIX = /\b(CP|ST)\b/i;

const MACHINE_CODE = /^(NGEN|NGENX|IDOS|MEDO)/;

function looksLikeMachineCode(code) {
  const c = t(code).toUpperCase().replace(/\s+/g, "");
  if (!MACHINE_CODE.test(c)) return false;
  if (NON_MACHINE_SUFFIX.test(t(code))) return false;
  // Filters, sensors and elements are spares even when the name mentions a machine.
  return !/FILTER|ELEMENT|SENSOR|VALVE|KIT|KVA/i.test(t(code));
}

/**
 * Load invoice lines, collapsing the extractor's exact triplication (each row is emitted
 * three times, so 1314 rows carry 438 distinct lines).
 */
function loadInvoiceItems(file) {
  const seen = new Set();
  const out = [];
  for (const r of sheetRows(file, "Invoice Items")) {
    const itemCode = t(r["Item Code"]);
    if (!itemCode) continue;
    const key = [t(r["Invoice No"]), t(r["Line No"]), itemCode.toUpperCase(), t(r.Qty), t(r["Unit Price"])].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      invoiceNo: t(r["Invoice No"]),
      invoiceDate: t(r["Invoice Date"]),
      customerCode: inlineCustomerCode(r.Customer),
      itemCode,
      itemName: t(r["Item Name"]) || itemCode,
      qty: t(r.Qty),
    });
  }
  return out;
}

/** customer code -> distinct machine SKUs that customer was invoiced. */
function buildInvoicedMachineIndex(lines) {
  const byCustomer = new Map();
  for (const l of lines) {
    if (!l.customerCode || !looksLikeMachineCode(l.itemCode)) continue;
    if (!byCustomer.has(l.customerCode)) byCustomer.set(l.customerCode, new Map());
    const m = byCustomer.get(l.customerCode);
    if (!m.has(l.itemCode)) m.set(l.itemCode, { itemCode: l.itemCode, itemName: l.itemName, invoices: [] });
    m.get(l.itemCode).invoices.push(`${l.invoiceNo} ${l.invoiceDate}`);
  }
  return byCustomer;
}

// ---------------------------------------------------------------- SO item lines

const squash = (v) => t(v).toUpperCase().replace(/\s+/g, "");

/**
 * Pull the bare model out of an order line's description.
 *
 *   "nGEN 09 Nitrogen"                                   -> ["nGEN 09"]
 *   "Absstem Shield Premium-nGEN 70 UH B Absstem Shield" -> ["nGEN 70 UH B"]
 *   "nGEN 05 CP / nGenx 04 CP Nitrogen"                  -> ["nGEN 05 CP", "nGenx 04 CP"]
 */
function modelsFromSoDescription(desc) {
  return t(desc)
    .replace(/Absstem\s+Shield\s+\w*-?/gi, " ")
    .replace(/\b(Absstem|Shield|Nitrogen|Oxygen|Storage\s+Vessel)\b/gi, " ")
    .split("/")
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => /^(nGEN|nGenx|IDOS|MedO)/i.test(x));
}

/**
 * Match a model as written on an order against the real Clan code.
 *
 * Current-era codes zero-pad the size ("nGEN001UH") while orders often print it spaced
 * and unpadded ("nGEN 01 UH"), so both spellings are tried. Whitespace is ignored when
 * comparing but never when choosing: "nGenx 04" and "nGenx004" are different machines
 * from different eras, and collapsing them would undo the era separation.
 */
function resolveSoModel(model, clanCodes) {
  const direct = clanCodes.get(squash(model));
  if (direct) return direct;

  const padded = t(model).match(/^(nGENX?|IDOS|MEDO)\s*0*(\d+)\s*(UH|SH|HF)(\s*B)?$/i);
  if (padded) {
    const key = `${padded[1]}${String(padded[2]).padStart(3, "0")}${padded[3]}${padded[4] ? "B" : ""}`;
    return clanCodes.get(squash(key)) || null;
  }
  return null;
}

/**
 * job key -> the machine models ordered against it.
 *
 * Only approved orders count: cancelled ones never shipped and pending ones have not
 * shipped yet, so neither describes an installed machine. Air packages and storage
 * vessels are dropped as well -- they ride on the same order but are not the generator.
 */
function buildSoItemIndex(file, clanCodes) {
  const wb = XLSX.readFile(file, { raw: false });
  const report = XLSX.utils.sheet_to_json(wb.Sheets["Sales Order Report"], { defval: "", raw: false });
  const items = XLSX.utils.sheet_to_json(wb.Sheets["SO Items"], { defval: "", raw: false });

  const jobBySo = new Map();
  for (const r of report) {
    if (!/^Approved$/i.test(t(r.Status)) || !t(r.JobNo)) continue;
    jobBySo.set(t(r["SO No"]), { job: t(r.JobNo), soNo: t(r["SO No"]), soDate: t(r["SO Date"]) });
  }

  const byJobKey = new Map();
  const unmatchedModels = new Map();
  for (const it of items) {
    const so = jobBySo.get(t(it["SO No"]));
    if (!so) continue;
    for (const model of modelsFromSoDescription(it.Description)) {
      const resolved = resolveSoModel(model, clanCodes);
      if (!resolved) {
        unmatchedModels.set(model, (unmatchedModels.get(model) || 0) + 1);
        continue;
      }
      if (!looksLikeMachineCode(resolved.code)) continue;
      for (const ref of parseJobRef(so.job).refs) {
        if (!byJobKey.has(ref.key)) byJobKey.set(ref.key, new Map());
        byJobKey.get(ref.key).set(resolved.code, { ...resolved, soNo: so.soNo, soDate: so.soDate });
      }
    }
  }
  return { byJobKey, unmatchedModels };
}

/** Read the SKU straight off the order line, when the order names exactly one machine. */
function resolveProductFromSoItem(jobKey, soItemIndex, productByCode) {
  const models = soItemIndex.byJobKey.get(jobKey);
  if (!models || !models.size) return null;

  const list = [...models.values()].map((m) => ({
    itemCode: m.code,
    itemName: m.name || m.code,
    inJosh: productByCode.has(squash(m.code)),
    source: `${m.soNo} ${m.soDate}`,
  }));

  if (list.length !== 1) {
    return { product: null, basis: "SO_ITEM_AMBIGUOUS", candidates: list, inJosh: false };
  }
  const only = list[0];
  return {
    product: { itemCode: only.itemCode, itemName: only.itemName },
    basis: only.inJosh ? "SO_ITEM_LINE" : "SO_ITEM_LINE_PRODUCT_MISSING",
    candidates: list,
    inJosh: only.inJosh,
  };
}

// ---------------------------------------------------------------- flow / purity sizing

/**
 * The model number is a frame size, not a flow: nGEN007UH makes 14 Nm3/hr while
 * nGEN007SH makes 35. Each SKU's captions instead publish a flow-versus-purity curve
 *
 *   FLOW AT 99.9% PURITY -> "21 Nm3/Hr DRY AIR REQUIRED 40 CFM"
 *
 * which is the only way to work back from what the service sheet does record -- a
 * committed flow and purity -- towards a model.
 */
/**
 * Every Clan AI code, for resolving a model as printed on an order to the real SKU.
 * Of two codes differing only in whitespace, the one whose group matches its own family
 * is kept: Clan files 14 nGEN duplicates under an IDOS group, and those are the stale twins.
 */
function loadClanCodes(file) {
  const byKey = new Map();
  for (const r of sheetRows(file)) {
    const code = t(r["Item Code"]);
    if (!code) continue;
    const entry = { code, name: t(r["Item Name"]) || code, group: t(r.Group), active: /^(YES|Y|TRUE|1)$/i.test(t(r.Active)) };
    const key = squash(code);
    const held = byKey.get(key);
    if (!held) { byKey.set(key, entry); continue; }
    const agrees = (e) => (/^NGEN/i.test(squash(e.code)) ? /NGEN/i.test(e.group) : true);
    if (!agrees(held) && agrees(entry)) byKey.set(key, entry);
  }
  return byKey;
}

function loadFlowTable(file) {
  const out = [];
  for (const r of sheetRows(file)) {
    const code = t(r["Item Code"]);
    if (!code) continue;
    const parts = machineCodeParts(code);
    if (!parts) continue;

    const curve = [];
    for (let i = 1; i <= 18; i += 1) {
      const cap = t(r[`Caption${i}`]);
      const purity = cap.match(/FLOW\s+AT\s+([\d.]+)\s*%\s*PURITY/i);
      if (!purity) continue;
      const flow = t(r[`Specification${i}`]).match(/([\d.]+)\s*Nm3/i);
      if (!flow) continue;
      curve.push({ purity: Number(purity[1]), flow: Number(flow[1]) });
    }
    if (curve.length) out.push({ code, ...parts, group: t(r.Group), curve });
  }
  return out;
}

/**
 * A "P" immediately after the size ("nGEN 7P", "ngen05p") is the pre-2025 purity marker,
 * so the machine is a legacy build even when the sales order does not say so.
 */
function eraFromText(text) {
  return /n\s*gen\s*x?\s*0*\d+(?:\.\d+)?\s*P\b/i.test(t(text)) ? "legacy" : null;
}

/** "400 Nm3/hr@99.6%", "25 LPM", "14nm3/hr @99.999" -> { flow (Nm3/hr), purity } */
function parseCommittedSpec(text) {
  const s = t(text).replace(/\s+/g, " ");
  if (!s) return null;

  const flowMatch = s.match(/([\d.]+)\s*(nm\s*3|nm\u00b3|lpm|l\/min|cfm)?\s*(?:\/|\s*per\s*)?\s*(hr|h|hour|min)?/i);
  // A purity is any 9x.x figure; it is never the flow, so read it first and exclude it.
  const purityMatch = s.match(/(9\d(?:\.\d+)?)\s*%/) || s.match(/@\s*(9\d(?:\.\d+)?)/);
  const purity = purityMatch ? Number(purityMatch[1]) : null;

  let flow = null;
  const unitRe = /([\d.]+)\s*(nm\s*3\s*\/?\s*(?:hr|h|hour)?|nm\u00b3|lpm|l\s*\/\s*min)/i;
  const um = s.match(unitRe);
  if (um) {
    const value = Number(um[1]);
    const unit = um[2].toLowerCase().replace(/\s+/g, "");
    // 1 Nm3/hr = 1000 litres per hour, so litres-per-minute scales by 60/1000.
    flow = /lpm|l\/min/.test(unit) ? value * 0.06 : value;
  } else if (flowMatch && purity !== Number(flowMatch[1])) {
    flow = null; // a bare number with no unit is not a flow we can trust
  }
  if (flow == null && purity == null) return null;
  return { flow, purity, raw: s };
}

/**
 * Suggest the SKUs that could deliver a committed duty.
 *
 * Deliberately a suggestion and not an assignment: the sheet records what was promised
 * to the customer, and a machine is picked to meet or beat that, so several models can
 * satisfy one figure. Ranked by how little headroom each leaves, which is how the SKU
 * would have been chosen in the first place.
 */
const CURRENT_VARIANTS = new Set(["UH", "SH", "HF"]);
const LEGACY_VARIANTS = new Set(["STD", "P"]);

function suggestByFlow(spec, flowTable, { family = null, variant = null, era = null } = {}, limit = 3) {
  if (!spec || spec.flow == null) return [];

  const scored = [];
  for (const sku of flowTable) {
    if (family && sku.family !== family) continue;
    if (variant && sku.variant !== variant) continue;
    // Never offer a current model for a legacy machine or the reverse. The two ranges
    // share size numbers but not flows, so a cross-era suggestion is always wrong.
    if (era === "current" && !CURRENT_VARIANTS.has(sku.variant)) continue;
    if (era === "legacy" && !LEGACY_VARIANTS.has(sku.variant)) continue;

    let point = null;
    if (spec.purity != null) {
      // Nearest published purity, but only if it is genuinely close: 99.6 may be read
      // against a 99.5 curve, never against a 95 one.
      for (const p of sku.curve) {
        const gap = Math.abs(p.purity - spec.purity);
        if (gap <= 0.45 && (!point || gap < Math.abs(point.purity - spec.purity))) point = p;
      }
    } else {
      point = sku.curve.reduce((a, b) => (a && a.flow >= b.flow ? a : b), null);
    }
    if (!point || point.flow < spec.flow * 0.98) continue; // cannot meet the duty

    scored.push({
      itemCode: sku.code,
      itemName: `${sku.code} (${point.flow} Nm3/hr @ ${point.purity}%)`,
      headroom: point.flow / spec.flow,
      atPurity: point.purity,
      atFlow: point.flow,
    });
  }
  return scored.sort((a, b) => a.headroom - b.headroom).slice(0, limit);
}

// ---------------------------------------------------------------- customer resolution

function buildCustomerIndex(rows) {
  const byPhone = new Map();
  const byEmail = new Map();
  const byCode = new Map();
  for (const c of rows) {
    const p = phoneKey(c.phone);
    if (p.length === 10 && !byPhone.has(p)) byPhone.set(p, c);
    const e = emailKey(c.email);
    if (e && !byEmail.has(e)) byEmail.set(e, c);
    if (c.code) byCode.set(c.code.toUpperCase(), c);
  }
  return { rows, byPhone, byEmail, byCode };
}

/**
 * Resolve a Service Master row to a customer, strongest signal first.
 *
 * A sales order matched on job number is authoritative: Clan states the customer code
 * against the same serial the service team recorded, so it beats every heuristic below
 * and is the only signal that needs no human confirmation. Name similarity alone is
 * never accepted without a geography corroboration.
 */
function resolveCustomer(machine, index, salesOrder = null) {
  if (!index) return { method: "NO_COMPANY", customer: null, score: 0, candidates: [] };

  if (salesOrder && salesOrder.customerCode) {
    const byCode = index.byCode.get(salesOrder.customerCode);
    if (byCode) {
      return { method: "SALES_ORDER", customer: byCode, score: 1, candidates: [byCode], salesOrder };
    }
    // Clan named a customer the company's own master does not contain -- worth surfacing
    // rather than silently falling through to a weaker guess.
    return {
      method: "SALES_ORDER_CODE_NOT_IN_MASTER",
      customer: null,
      score: 0,
      candidates: [],
      salesOrder,
      orphanCode: salesOrder.customerCode,
    };
  }

  const byPhone = index.byPhone.get(phoneKey(machine.phone));
  if (byPhone) return { method: "PHONE", customer: byPhone, score: 1, candidates: [byPhone] };

  const byEmail = index.byEmail.get(emailKey(machine.email));
  if (byEmail) return { method: "EMAIL", customer: byEmail, score: 1, candidates: [byEmail] };

  const geoHaystack = `${machine.location} ${machine.address}`.toUpperCase();
  const scored = [];
  for (const c of index.rows) {
    const score = nameScore(machine.client, c.name);
    if (score < 0.6) continue;
    const geoHit = Boolean(
      (c.city && geoHaystack.includes(c.city.toUpperCase())) ||
      (c.state && geoHaystack.includes(c.state.toUpperCase()))
    );
    scored.push({ customer: c, score, geoHit });
  }
  scored.sort((a, b) => (b.geoHit === a.geoHit ? b.score - a.score : b.geoHit ? 1 : -1));

  const withGeo = scored.filter((s) => s.geoHit);
  if (withGeo.length === 1) {
    return { method: "NAME_AND_GEO", customer: withGeo[0].customer, score: withGeo[0].score, candidates: scored.slice(0, 5) };
  }
  if (scored.length) {
    // name-only, or several geographic ties — needs a human
    return { method: "NAME_AMBIGUOUS", customer: null, score: scored[0].score, candidates: scored.slice(0, 5) };
  }
  return { method: "NONE", customer: null, score: 0, candidates: [] };
}

// ---------------------------------------------------------------- spares normalization

// Per-word spelling repairs. The service log is typed free-hand on site, so the
// same part appears as "oil saprator", "oil saperatort", "oil sapretaor".
const WORD_FIXES = [
  [/^s[ae]p[ae]?r?[ae]?t[ao].*$/, "separator"],
  [/^sep[ae]?r[ae]?to.*$/, "separator"],
  [/^aperator$/, "separator"],
  [/^(filteer|filterr|fliter|filtr|filer|fillter)$/, "filter"],
  [/^(elemnt|elemet|elemen|elemant|elimentt?)s?$/, "element"],
  [/^(maiontenance|maintainance|maintenence|maintainence)$/, "maintenance"],
  [/^prev.?n.?t?i?e?[vt]e?$/, "preventive"],
  [/^(cou?st|cust|coust|courest)[eouia]*r?[yie]?(sy)?$/, "courtesy"],
  [/^(brea?k?l?downn?|brteakdown)$/, "breakdown"],
  [/^(sliencer|silncer|silencor)$/, "silencer"],
  [/^(teminal|termnal|terminl)$/, "terminal"],
  [/^(sevo|servoo|serv)$/, "servo"],
  [/^(coolent|coolan|colant|coolnt)$/, "coolant"],
  [/^(mitter|miter|metter)$/, "meter"],
  [/^(oit|o\/t)$/, "ot"],
  [/^(analyser|analizer|analyzer)$/, "analyzer"],
  [/^(saftey|safty)$/, "safety"],
  [/^(valu|valve?s|value)$/, "valve"],
  [/^(compresser|compresor|comperssor|compressore)$/, "compressor"],
  [/^comp$/, "compressor"],
  [/^(oring|orring)$/, "o ring"],
];

// Words that describe the visit rather than the part. Dropping them merges
// "both oil filter", "oil filter changed" and "oil filter at site".
const MODIFIER_WORDS = new Set([
  "both", "new", "one", "old", "complete", "completed", "change", "changed", "changing",
  "replace", "replaced", "replacement", "fill", "filled", "fitted", "fitting", "done",
  "at", "on", "in", "site", "sites", "kept", "hand", "over", "handover", "handed",
  "given", "provided", "supply", "supplied", "carry", "carried", "with", "and", "the",
  "for", "of", "no", "nos", "pcs", "pc", "qty", "each", "per", "set", "sets", "unit",
]);

function canonicalSpareLabel(raw) {
  let s = t(raw).toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  // quantities: "2 ltr", "7 5 ltr", "3 litre"
  s = s.replace(/\b\d+(\s+\d+)?\s*(ltr|ltrs|liter|liters|litre|litres|kg|kgs|ml|mtr|meter|metre)\b/g, " ");
  s = s.replace(/\b\d+\b/g, " ");

  const words = [];
  for (const rawWord of s.split(/\s+/)) {
    if (!rawWord) continue;
    let word = rawWord;
    for (const [re, to] of WORD_FIXES) {
      if (re.test(word)) {
        word = to;
        break;
      }
    }
    for (const part of word.split(" ")) {
      if (part && !MODIFIER_WORDS.has(part)) words.push(part);
    }
  }
  // de-duplicate repeated words ("oil top up oil") and sort-stabilise word order
  // only for the trailing duplicates, keeping the first occurrence order.
  const seen = new Set();
  const kept = words.filter((w) => (seen.has(w) ? false : seen.add(w)));
  return kept.join(" ").trim();
}

// ---------------------------------------------------------------- machine model -> product

/**
 * Pull a family + size + variant out of a model or capacity string.
 * The service team writes "Medo 6", "Medo 12.5", "nGENx10", "ngen05 SH 13nm3/hr",
 * "IDOS 01 B"; the Product Master writes "MedO 06", "nGEN 10 P", "IDOS 01 B".
 */
function parseMachineModel(text, defaultFamily = null) {
  const s = t(text).toUpperCase().replace(/\s+/g, " ");
  if (!s) return null;

  // Match on a space-stripped copy so "n GEN 05" and "nGEN05" behave the same,
  // then read the size from the text following the family token.
  const compact = s.replace(/[\s-]/g, "");
  const families = [
    ["NGENX", /NGENX/],
    ["IDOSC", /IDOSC/],
    ["NGEN", /NGEN/],
    ["IDOS", /IDOS/],
    ["MEDO", /MEDO/],
  ];
  let family = null;
  let tokenEnd = 0;
  for (const [name, re] of families) {
    const m = compact.match(re);
    if (m) {
      family = name;
      tokenEnd = m.index + m[0].length;
      break;
    }
  }
  // The service team often records only a size ("12.5", "9"); the machine's own
  // job prefix tells us the family in that case.
  const familyFromText = Boolean(family);
  if (!family) {
    if (!defaultFamily) return null;
    family = defaultFamily;
    tokenEnd = 0;
  }

  const rest = compact.slice(tokenEnd);
  const num = rest.match(/(\d+(?:\.\d+)?)/);
  if (!num) return null;
  const size = num[1];

  // A number followed by a flow unit is a capacity, not a model number.
  // "25 LPM" is about 1.5 Nm3/hr and has nothing to do with nGEN 025.
  const flowUnit = /\d\s*(LPM|NM3|M3|CFM|LTR|L\/MIN|LITRE)/.test(s);

  // Variant marker sits immediately after the size, with or without a separator:
  // "nGEN001HF", "IDOS 01 B", "nGen 30 P", "nGenx80 UH", "MedO 12.5C".
  const afterSize = rest.slice(num.index + num[0].length);
  const variantMatch = afterSize.match(/^(SH|HF|UH|[BCDEP])(?![A-Z0-9])/);
  return {
    family,
    size,
    variant: variantMatch ? variantMatch[1] : null,
    familyFromText,
    flowUnit,
  };
}

function normalizeProductModelKey(itemName) {
  const parsed = parseMachineModel(itemName);
  if (!parsed) return null;
  return `${parsed.family}|${Number(parsed.size)}|${parsed.variant || ""}`;
}

// The Product Master is inconsistent here: AT rows say "finished_good" while AI
// rows say "FG" for the same thing.
function isFinishedGood(itemType) {
  const v = t(itemType).toLowerCase().replace(/[\s-]+/g, "_");
  return v === "fg" || v === "finished_good";
}

function buildMachineProductIndex(products) {
  const byVariant = new Map(); // company|family|size|variant -> products
  const bySize = new Map(); // company|family|size -> products across all variants
  for (const p of products) {
    if (!isFinishedGood(p.itemType)) continue;
    if (!/generator|psa|oxygen|nitrogen/i.test(`${p.group} ${p.itemName}`)) continue;
    const parsed = parseMachineModel(p.itemName);
    if (!parsed) continue;
    const sizeKey = `${p.company}|${parsed.family}|${Number(parsed.size)}`;
    const variantKey = `${sizeKey}|${parsed.variant || ""}`;
    if (!byVariant.has(variantKey)) byVariant.set(variantKey, []);
    byVariant.get(variantKey).push(p);
    if (!bySize.has(sizeKey)) bySize.set(sizeKey, []);
    bySize.get(sizeKey).push(p);
  }
  return { byVariant, bySize };
}

/**
 * Resolve a Service Master machine to a product. Tries the model column first,
 * then the capacity column, which is often where the model actually got typed.
 *
 * Never guesses across sizes: the service team records "Medo 12" where the
 * catalogue only has "MedO 12.5", and silently rounding that would put the wrong
 * machine on a customer's installed base.
 */
function resolveMachineProduct(company, modelText, capacityText, index, defaultFamily, variantHint = null) {
  // Kept even when no catalogue product matches: legacy models are absent from Josh, but
  // the parse is still what narrows an ambiguous invoice down to one machine.
  let lastParsed = null;
  for (const source of [modelText, capacityText]) {
    const parsed = parseMachineModel(source, defaultFamily);
    if (!parsed) continue;
    // Only trust a bare number as a model size when no flow unit is attached.
    // Otherwise "500 LPM" would masquerade as model 500.
    if (parsed.flowUnit && !parsed.familyFromText) continue;
    lastParsed = parsed;
    const sizeKey = `${company}|${parsed.family}|${Number(parsed.size)}`;

    if (parsed.variant) {
      const exact = index.byVariant.get(`${sizeKey}|${parsed.variant}`);
      if (exact && exact.length) return { product: exact[0], basis: "MODEL_WITH_VARIANT", parsed, candidates: exact };
    }

    // The service sheet records size but never purity. Where the sales order named a
    // purity for this exact serial, it settles which of the same-size models this is.
    if (!parsed.variant && variantHint) {
      const hinted = index.byVariant.get(`${sizeKey}|${variantHint}`);
      if (hinted && hinted.length === 1) {
        return { product: hinted[0], basis: "MODEL_AND_SO_PURITY", parsed, candidates: hinted };
      }
    }

    const sameSize = index.bySize.get(sizeKey) || [];
    if (sameSize.length === 1) {
      // only one product at this size, whatever its variant letter
      return { product: sameSize[0], basis: "MODEL_SIZE_UNIQUE", parsed, candidates: sameSize };
    }
    if (sameSize.length > 1) {
      const plain = index.byVariant.get(`${sizeKey}|`);
      if (plain && plain.length === 1) {
        return { product: plain[0], basis: "MODEL_BASE", parsed, candidates: sameSize };
      }
      return { product: null, basis: "VARIANT_AMBIGUOUS", parsed, candidates: sameSize };
    }
  }
  return { product: null, basis: "UNRESOLVED", parsed: lastParsed, candidates: [] };
}

/**
 * Resolve a machine's SKU from what its owner was actually invoiced.
 *
 * This outranks model-text inference because it is a record of the sale rather than a
 * reading of a free-text field, and it is the only way to tell a legacy build from a
 * current one: the service sheet says "Ngen 10" either way, while the invoice says
 * "nGEN 10 P" or "nGEN010UH".
 *
 * The caveat is that an invoice names a customer, not a serial. When a customer bought
 * several different machines we cannot say which is which, so those become candidates for
 * a human rather than an assignment.
 */
/**
 * Decompose a catalogue SKU into family, size and variant so an invoiced code can be
 * compared against the size read off the service sheet's model column. Handles both
 * eras: "nGEN 10 P" / "nGEN 09" (legacy, spaced) and "nGEN010UH" (current, padded).
 */
function machineCodeParts(code) {
  const c = t(code).toUpperCase().replace(/\s+/g, " ").trim();
  const m = c.match(/^(NGENX|NGEN|IDOSC|IDOS|MEDO)\s*0*(\d+(?:\.\d+)?)\s*(P|UH|SH|HF)?\b/);
  if (!m) return null;
  return { family: m[1], size: Number(m[2]), variant: m[3] || "STD" };
}

function resolveProductFromInvoice(customerCode, invoicedMachineIndex, productByCode) {
  if (!customerCode) return null;
  const skus = invoicedMachineIndex.get(customerCode.toUpperCase());
  if (!skus || !skus.size) return null;

  const list = [...skus.values()];
  const decorate = (sku) => {
    const known = productByCode.get(sku.itemCode.toUpperCase().replace(/\s+/g, ""));
    return {
      itemCode: sku.itemCode,
      itemName: known ? known.itemName : sku.itemName,
      inJosh: Boolean(known),
      invoices: sku.invoices,
    };
  };

  if (list.length === 1) {
    const only = decorate(list[0]);
    return {
      product: { itemCode: only.itemCode, itemName: only.itemName },
      basis: only.inJosh ? "INVOICE_UNIQUE" : "INVOICE_UNIQUE_PRODUCT_MISSING",
      candidates: [only],
      inJosh: only.inJosh,
    };
  }
  return {
    product: null,
    basis: "INVOICE_AMBIGUOUS",
    candidates: list.map(decorate),
    inJosh: false,
  };
}

/**
 * When a customer bought several machines, the model column can still say which of them
 * this serial is. Matching on size alone is enough to separate an nGEN 10 from an
 * nGEN 40; it deliberately does not try to pick between purity variants of one size,
 * since the service sheet does not record purity.
 */
function narrowInvoiceByModel(fromInvoice, modelParsed, soHint) {
  if (!fromInvoice || fromInvoice.basis !== "INVOICE_AMBIGUOUS") return fromInvoice;

  const tries = [];
  if (modelParsed) {
    tries.push([
      "MODEL",
      (parts) => parts.family === modelParsed.family && parts.size === Number(modelParsed.size),
    ]);
  }
  if (soHint && (soHint.family || soHint.variant)) {
    tries.push([
      "SO_GROUP",
      (parts) =>
        (!soHint.family || parts.family === soHint.family) &&
        (!soHint.variant || parts.variant === soHint.variant),
    ]);
  }
  // Both signals together, for the case where neither alone is decisive.
  if (tries.length === 2) {
    tries.push(["MODEL_AND_SO_GROUP", (parts) => tries[0][1](parts) && tries[1][1](parts)]);
  }

  for (const [label, test] of tries) {
    const hits = fromInvoice.candidates.filter((c) => {
      const parts = machineCodeParts(c.itemCode);
      return parts && test(parts);
    });
    if (hits.length !== 1) continue;
    const only = hits[0];
    return {
      product: { itemCode: only.itemCode, itemName: only.itemName },
      basis: only.inJosh ? `INVOICE_NARROWED_BY_${label}` : `INVOICE_NARROWED_PRODUCT_MISSING`,
      candidates: fromInvoice.candidates,
      inJosh: only.inJosh,
    };
  }
  return fromInvoice;
}

function suggestItemCodes(label, products, limit = 3, company = null) {
  const target = nameTokens(label);
  if (!target.size) return [];
  const scored = [];
  for (const p of products) {
    // A spare label can never be a machine. Without this, "medo filter elements"
    // scores a perfect match against the machine "MedO 01" on the word "medo".
    if (isFinishedGood(p.itemType)) continue;
    const score = nameScore(label, p.itemName);
    if (score >= 0.5) scored.push({ ...p, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.company === company ? -1 : 0) - (b.company === company ? -1 : 0));
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv);
  const resolveIn = (f) => (path.isAbsolute(f) ? f : path.resolve(args.root, f));

  const files = {
    serviceMaster: resolveIn(args.serviceMaster),
    customerAI: resolveIn(args.customerAI),
    customerAT: resolveIn(args.customerAT),
    invoiceBible: resolveIn(args.invoiceBible),
    productMaster: resolveIn(args.productMaster),
    salesOrders: resolveIn(args.salesOrders),
    invoiceItems: resolveIn(args.invoiceItems),
    itemMaster: resolveIn(args.itemMaster),
    soItems: resolveIn(args.soItems),
  };
  for (const [key, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) {
      console.error(`missing ${key}: ${file}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log("reading sources...");
  const serviceMaster = loadServiceMaster(files.serviceMaster);
  const customersAI = loadCustomerMaster(files.customerAI);
  const customersAT = loadCustomerMaster(files.customerAT);
  const indexes = { AI: buildCustomerIndex(customersAI), AT: buildCustomerIndex(customersAT) };

  const products = sheetRows(files.productMaster, "Product Master")
    .filter((r) => t(r["Item Code"]))
    .map((r) => ({
      company: t(r.Company).split("•")[0].trim(),
      itemCode: t(r["Item Code"]),
      itemName: t(r["Item Name"]),
      group: t(r.Group),
      itemType: t(r["Item Type"]),
    }));

  const machineProductIndex = buildMachineProductIndex(products);
  const productByCode = new Map(products.map((p) => [p.itemCode.toUpperCase().replace(/\s+/g, ""), p]));

  const bibleRows = sheetRows(files.invoiceBible, "Invoice_Lines_Bible").filter((r) => t(r.invoice_number));
  const fillRows = sheetRows(files.invoiceBible, "Invoice_Lines_Fill").filter((r) => t(r.invoice_number));

  const salesOrders = loadSalesOrders(files.salesOrders);
  const soByJobKey = buildSalesOrderIndex(salesOrders);
  const jobGroupIndex = buildJobGroupIndex(salesOrders);
  const invoiceItems = loadInvoiceItems(files.invoiceItems);
  const invoicedMachineIndex = buildInvoicedMachineIndex(invoiceItems);
  const flowTable = loadFlowTable(files.itemMaster);
  const clanCodes = loadClanCodes(files.itemMaster);
  const soItemIndex = buildSoItemIndex(files.soItems, clanCodes);

  console.log(
    `  service master ${serviceMaster.length} rows | customers AI ${customersAI.length} / AT ${customersAT.length} | products ${products.length} | invoice lines ${bibleRows.length}`
  );
  console.log(
    `  sales orders ${salesOrders.length} (${soByJobKey.size} job keys, ${jobGroupIndex.size} with a decided machine group) | invoice items ${invoiceItems.length} deduped (${invoicedMachineIndex.size} customers with a machine)`
  );
  console.log(`  flow curves ${flowTable.length} SKUs | Clan codes ${clanCodes.size}`);
  console.log(
    `  SO item lines: ${soItemIndex.byJobKey.size} job keys name a machine` +
      (soItemIndex.unmatchedModels.size
        ? ` | ${soItemIndex.unmatchedModels.size} model spellings matched no Clan code: ${[...soItemIndex.unmatchedModels.keys()].slice(0, 6).join(", ")}`
        : "")
  );

  // ---- equipment rows, one per machine reference -------------------------
  const equipment = [];
  const exceptions = [];
  const seenSerial = new Map();

  for (const m of serviceMaster) {
    const parsed = parseJobRef(m.job);
    const nameIssue = looksLikeJunkName(m.client);
    const comm = parseLooseDate(m.commissioning);
    const warranty = parseLooseDate(m.warrantyEnd);

    const rowIssues = [...parsed.issues];
    if (nameIssue) rowIssues.push(nameIssue);
    if (comm.issue) rowIssues.push(comm.issue);
    if (warranty.issue) rowIssues.push(`WARRANTY_${warranty.issue}`);

    if (!parsed.refs.length) {
      exceptions.push({
        // No parseable serial means no prefix, so no company: this row goes to
        // both teams rather than silently to neither.
        company_code: "",
        source: "Service Master",
        row: m.rowNo,
        raw_job_no: m.job,
        client: m.client,
        issues: rowIssues.join(","),
        action: parsed.issues.includes(ISSUE.SLIP_WITHOUT_MACHINE)
          ? "Install slip has no machine serial — supply the N/M/ID serial"
          : "Job number unreadable — supply a valid serial",
      });
      continue;
    }

    for (const ref of parsed.refs) {
      const serial = ref.key + (ref.suffix || "");
      const index = indexes[ref.company] || null;
      const salesOrder = soByJobKey.get(ref.key) || null;
      const resolved = resolveCustomer(m, index, salesOrder);

      // Prefer the invoiced SKU over anything inferred from the model text: it records
      // what was sold, and it is the only thing that distinguishes a legacy build from a
      // current one. Fall back to model inference when the invoice cannot decide.
      const customerCode = resolved.customer ? resolved.customer.code : salesOrder?.customerCode || "";
      const soHint = jobGroupIndex.get(ref.key) || null;
      const fromModel = ref.company
        ? resolveMachineProduct(ref.company, m.model, m.capacity, machineProductIndex, ref.familyGroup, soHint?.variant)
        : { product: null, basis: "UNRESOLVED", parsed: null, candidates: [] };
      const fromInvoice = narrowInvoiceByModel(
        resolveProductFromInvoice(customerCode, invoicedMachineIndex, productByCode),
        fromModel.parsed,
        soHint
      );
      // An order line names the model against this very serial, so it outranks the invoice
      // (which only names a customer) and anything read out of the model column.
      const fromSoItem = resolveProductFromSoItem(ref.key, soItemIndex, productByCode);
      const machineProduct =
        [fromSoItem, fromInvoice, fromModel].find((r) => r && r.product) ||
        fromSoItem ||
        fromInvoice ||
        fromModel;

      // Where both sources speak and name different SKUs, say so. Usually the invoice is
      // the looser one -- it is keyed to a customer, so it cannot distinguish two machines
      // at one site -- but a conflict can equally mean the order was revised after sale.
      const soCodes = (fromSoItem?.candidates || []).map((c) => squash(c.itemCode));
      const invCodes = (fromInvoice?.candidates || []).map((c) => squash(c.itemCode));
      const evidenceConflict =
        soCodes.length && invCodes.length && !soCodes.some((c) => invCodes.includes(c))
          ? `SO says ${fromSoItem.candidates.map((c) => c.itemCode).join("/")}; invoice says ${fromInvoice.candidates.map((c) => c.itemCode).join("/")}`
          : "";

      // Last resort when nothing records the SKU: size it from the duty the service sheet
      // captured. Offered as ranked candidates only -- see suggestByFlow.
      const committed = machineProduct.product ? null : parseCommittedSpec(`${m.capacity} ${m.model}`);
      const era = soHint?.era || eraFromText(`${m.capacity} ${m.model}`);
      const flowSuggestions = committed
        ? suggestByFlow(committed, flowTable, {
            family: soHint?.family || fromModel.parsed?.family || null,
            variant: soHint?.variant || null,
            era,
          })
        : [];

      // A suggestion the model text independently names is no longer really a guess: the
      // duty and the typed model agree on the same SKU.
      const corroborated = fromModel.parsed
        ? flowSuggestions.filter((s) => {
            const parts = machineCodeParts(s.itemCode);
            return parts && parts.family === fromModel.parsed.family && parts.size === Number(fromModel.parsed.size);
          })
        : [];
      const suggestionConfidence = !flowSuggestions.length
        ? ""
        : corroborated.length === 1
          ? "MODEL_TEXT_AGREES"
          : flowSuggestions[0].headroom <= 1.02
            ? "EXACT_DUTY"
            : flowSuggestions[0].headroom <= 1.2
              ? "CLOSE_DUTY"
              : "WIDE";

      const dupKey = `${ref.company}|${serial}`;
      const blockers = [];
      if (seenSerial.has(dupKey)) blockers.push(`DUPLICATE_SERIAL(row ${seenSerial.get(dupKey)})`);
      else seenSerial.set(dupKey, m.rowNo);
      if (!ref.company) blockers.push("COMPANY_UNKNOWN");
      if (!resolved.customer) blockers.push("CUSTOMER_UNRESOLVED");
      if (!machineProduct.product) blockers.push("ITEM_CODE_UNRESOLVED");
      // product_id is nullable, but a code with no product row cannot inherit spares or a
      // BOM, so it is worth importing the SKU first.
      else if (machineProduct.inJosh === false) blockers.push("PRODUCT_NOT_IN_JOSH");
      if (nameIssue) blockers.push(nameIssue);

      equipment.push({
        status: blockers.length ? "BLOCKED" : "READY",
        block_reason: blockers.join(","),
        company_code: ref.company || "",
        serial_number: serial,
        job_key: ref.key,
        variant_suffix: ref.suffix || "",
        install_slip: parsed.installSlip || "",
        raw_job_no: m.job,
        source_row: m.rowNo,
        segment: m.segment,
        service_client_name: m.client,
        customer_code: resolved.customer ? resolved.customer.code : "",
        customer_name: resolved.customer ? resolved.customer.name : "",
        match_method: resolved.method,
        match_score: resolved.score ? resolved.score.toFixed(2) : "",
        // Clan's own linkage, shown so a reviewer can audit the customer match.
        so_number: salesOrder ? salesOrder.soNo : "",
        so_date: salesOrder ? salesOrder.soDate : "",
        so_customer_code: salesOrder ? salesOrder.customerCode : "",
        so_group: salesOrder ? salesOrder.group : "",
        so_machine_group: soHint ? soHint.group : "",
        so_purity: soHint?.variant || "",
        so_era: era || "",
        item_code: machineProduct.product ? machineProduct.product.itemCode : "",
        item_name: machineProduct.product ? machineProduct.product.itemName : "",
        item_code_basis: machineProduct.basis,
        item_code_candidates:
          (machineProduct.candidates || []).map((c) => c.itemCode).join(", ") ||
          flowSuggestions.map((s) => s.itemCode).join(", "),
        // Shown with the duty each model meets so a reviewer can judge the fit rather
        // than trust a ranking.
        flow_committed: committed?.flow != null ? `${Number(committed.flow.toFixed(2))} Nm3/hr` : "",
        purity_committed: committed?.purity != null ? `${committed.purity}%` : "",
        flow_suggestions: (corroborated.length === 1 ? corroborated : flowSuggestions).map((s) => s.itemName).join(" | "),
        suggestion_confidence: suggestionConfidence,
        evidence_conflict: evidenceConflict,
        item_code_evidence: [
          ...(fromSoItem?.candidates || []).map((c) => `${c.itemCode} <- SO ${c.source}`),
          ...(fromInvoice?.candidates || []).flatMap((c) => c.invoices.map((inv) => `${c.itemCode} <- inv ${inv}`)),
        ].join(" | "),
        model: m.model,
        capacity: m.capacity,
        // The service sheet is often blank here; the sales order's consignee is the
        // delivery address, which is the installed site.
        site_location: m.location || salesOrder?.consigneeCity || "",
        site_address: m.address || (salesOrder ? [salesOrder.consigneeName, salesOrder.consigneeAddress, salesOrder.consigneePin].filter(Boolean).join(", ") : ""),
        contact_person: m.contact,
        contact_phone: m.phone || salesOrder?.consigneePhone || "",
        contact_email: m.email || salesOrder?.consigneeEmail || "",
        commissioning_date: comm.iso || "",
        warranty_end_date: warranty.iso || "",
        account_holder: m.accountHolder,
        data_issues: rowIssues.join(","),
        CONFIRM_customer_code: "",
        CONFIRM_item_code: "",
        CONFIRM_serial_number: "",
        notes: "",
      });

      if (rowIssues.length) {
        exceptions.push({
          company_code: ref.company || "",
          source: "Service Master",
          row: m.rowNo,
          serial_number: serial,
          raw_job_no: m.job,
          client: m.client,
          issues: rowIssues.join(","),
          action: describeAction(rowIssues),
        });
      }
    }
  }

  // ---- customer link review: only the rows a human must decide ----------
  const linkReview = [];
  for (const e of equipment) {
    if (e.customer_code && e.match_method !== "NAME_AMBIGUOUS") continue;
    const m = serviceMaster.find((s) => s.rowNo === e.source_row);
    const index = indexes[e.company_code] || null;
    const resolved = index ? resolveCustomer(m, index) : { candidates: [] };
    const row = {
      company_code: e.company_code,
      serial_number: e.serial_number,
      service_client_name: e.service_client_name,
      site_location: e.site_location,
      contact_phone: e.contact_phone,
      contact_email: e.contact_email,
      match_method: e.match_method,
    };
    resolved.candidates.slice(0, 3).forEach((c, i) => {
      row[`candidate_${i + 1}_code`] = c.customer.code;
      row[`candidate_${i + 1}_name`] = c.customer.name;
      row[`candidate_${i + 1}_city`] = c.customer.city;
      row[`candidate_${i + 1}_score`] = c.score.toFixed(2);
      row[`candidate_${i + 1}_geo_match`] = c.geoHit ? "yes" : "no";
    });
    row.CONFIRM_customer_code = "";
    linkReview.push(row);
  }

  // ---- job_no recovery for invoices with no machine link ----------------
  const invoiceIndex = new Map();
  for (const r of bibleRows) {
    const num = t(r.invoice_number);
    if (!invoiceIndex.has(num)) {
      invoiceIndex.set(num, {
        invoice_number: num,
        invoice_date: t(r.invoice_date),
        customer_code: t(r.customer_code),
        customer_name: t(r.customer_name),
        grand_total: t(r.invoice_grand_total),
        linked_so: t(r.linked_so_number),
      });
    }
  }
  const linkedByInvoice = new Map();
  for (const r of fillRows) {
    const num = t(r.invoice_number);
    if (!linkedByInvoice.has(num)) linkedByInvoice.set(num, { job: false, so: false });
    if (t(r.job_no)) linkedByInvoice.get(num).job = true;
    if (t(r.so_number)) linkedByInvoice.get(num).so = true;
  }

  // machines grouped by the customer we resolved them to
  const machinesByCustomer = new Map();
  for (const e of equipment) {
    if (!e.customer_code) continue;
    if (!machinesByCustomer.has(e.customer_code)) machinesByCustomer.set(e.customer_code, []);
    machinesByCustomer.get(e.customer_code).push(e);
  }

  const recovery = [];
  for (const [num, inv] of invoiceIndex) {
    const links = linkedByInvoice.get(num) || { job: false, so: false };
    if (links.job) continue;

    const byCode = machinesByCustomer.get(inv.customer_code) || [];
    let candidates = byCode;
    let basis = byCode.length ? "CUSTOMER_CODE" : "";

    if (!candidates.length) {
      const scored = equipment
        .filter((e) => e.service_client_name && nameScore(inv.customer_name, e.service_client_name) >= 0.6)
        .slice(0, 5);
      if (scored.length) {
        candidates = scored;
        basis = "NAME_ONLY_NEEDS_CHECK";
      }
    }

    recovery.push({
      invoice_number: num,
      invoice_date: inv.invoice_date,
      customer_code: inv.customer_code,
      customer_name: inv.customer_name,
      grand_total: inv.grand_total,
      linked_so_number: inv.linked_so,
      missing_so_too: links.so ? "no" : "yes",
      match_basis: basis || "NO_CANDIDATE",
      candidate_count: candidates.length,
      candidate_serials: candidates.map((c) => c.serial_number).join(", "),
      candidate_clients: [...new Set(candidates.map((c) => c.service_client_name))].join(" | "),
      confidence: basis === "CUSTOMER_CODE" && candidates.length === 1 ? "HIGH" : candidates.length ? "REVIEW" : "NONE",
      CONFIRM_job_no: "",
      notes: "",
    });
  }
  recovery.sort((a, b) => {
    const rank = { HIGH: 0, REVIEW: 1, NONE: 2 };
    return rank[a.confidence] - rank[b.confidence] || a.invoice_number.localeCompare(b.invoice_number);
  });

  // ---- spares mapping, split by the owning company of each machine ------
  const serviceLog = loadServiceLogRows(files.serviceMaster)
    .filter((r) => t(r["Job No."]))
    .map((r) => ({ ...r, __company: parseJobRef(r["Job No."]).company }));
  const today = new Date().toISOString().slice(0, 10);

  const sparesByCompany = { AI: buildSpares(serviceLog, "AI", products), AT: buildSpares(serviceLog, "AT", products) };

  // ---- write one workbook per company -----------------------------------
  const wanted = args.company.toLowerCase() === "both" ? ["AI", "AT"] : [args.company.toUpperCase()];
  for (const companyCode of wanted) {
    writeCompanyWorkbook({
      companyCode,
      outPath: path.resolve(args.root, `${args.outPrefix}_${companyCode}.xlsx`),
      serviceMasterRowCount: serviceMaster.length,
      equipment: equipment.filter((e) => e.company_code === companyCode),
      linkReview: linkReview.filter((r) => r.company_code === companyCode),
      // The invoice bible we have is AI-only; AT has no equivalent export yet.
      recovery: companyCode === "AI" ? recovery : [],
      spares: sparesByCompany[companyCode] || [],
      dateCorrections: buildDateCorrections(serviceLog, companyCode, today),
      serviceLogCount: serviceLog.filter((r) => r.__company === companyCode).length,
      // Rows we could not attribute to a company travel with both files so
      // neither team assumes someone else is handling them.
      exceptions: exceptions.filter((x) => !x.company_code || x.company_code === companyCode),
    });
  }
}

function writeCompanyWorkbook(ctx) {
  const { companyCode, outPath, equipment, linkReview, recovery, spares, exceptions, dateCorrections } = ctx;
  const label = companyCode === "AI" ? "AI — nGEN / nGENX / Idos" : "AT — MedO";

  const tally = (rows, key) =>
    Object.entries(rows.reduce((acc, r) => { acc[r[key]] = (acc[r[key]] || 0) + 1; return acc; }, {}))
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [`  ${k}`, v]);

  const coverageAt = (pct) => {
    const i = spares.findIndex((s) => Number(s.cumulative_pct_of_log) >= pct);
    return i === -1 ? spares.length : i + 1;
  };

  const summary = [
    [`Service Master Onboarding Review — ${label}`, ""],
    ["Generated", new Date().toISOString().slice(0, 19).replace("T", " ")],
    ["", ""],
    ["Machine references for this company", equipment.length],
    ["  READY to import", equipment.filter((e) => e.status === "READY").length],
    ["  BLOCKED", equipment.filter((e) => e.status === "BLOCKED").length],
    ["", ""],
    ["Blocked on customer", equipment.filter((e) => /CUSTOMER_UNRESOLVED/.test(e.block_reason)).length],
    ["Blocked on item_code", equipment.filter((e) => /ITEM_CODE_UNRESOLVED/.test(e.block_reason)).length],
    ["Blocked only on a missing product row", equipment.filter((e) => e.block_reason === "PRODUCT_NOT_IN_JOSH").length],
    ["  distinct SKUs to import first", buildProductsToImport(equipment).length],
    ["", ""],
    ["Customer match method", ""],
    ...tally(equipment, "match_method"),
    ["", ""],
    ["Machine item_code resolution", ""],
    ...tally(equipment, "item_code_basis"),
    ["", ""],
    ["SO and invoice name different SKUs (review)", equipment.filter((e) => e.evidence_conflict).length],
    ["Flow-sized suggestions for unresolved machines", equipment.filter((e) => e.flow_suggestions).length],
    ...tally(equipment.filter((e) => e.suggestion_confidence), "suggestion_confidence"),
    ["", ""],
    ["Invoices needing a job_no", recovery.length],
    ...(recovery.length
      ? [
          ["  HIGH confidence", recovery.filter((r) => r.confidence === "HIGH").length],
          ["  REVIEW", recovery.filter((r) => r.confidence === "REVIEW").length],
          ["  no candidate", recovery.filter((r) => r.confidence === "NONE").length],
        ]
      : [["  (no invoice bible exported for this company yet)", ""]]),
    ["", ""],
    ["Service log rows for this company", ctx.serviceLogCount],
    ["Distinct spare labels", spares.length],
    ["  labels covering 80% of the log", coverageAt(80)],
    ["  labels covering 95% of the log", coverageAt(95)],
    ["", ""],
    ["Service log dates to correct", dateCorrections.length],
    ["  day and month swapped on entry", dateCorrections.filter((d) => d.issue === "TRANSPOSED").length],
    ["  not a readable date", dateCorrections.filter((d) => d.issue === "UNREADABLE").length],
    ["  in the future and not recoverable", dateCorrections.filter((d) => d.issue === "IMPOSSIBLE").length],
    ["  2026 rows a swap would have hidden", dateCorrections.filter((d) => d.issue === "CHECK_2026").length],
    ["", ""],
    ["Exception rows", exceptions.length],
  ];

  const wb = XLSX.utils.book_new();
  const add = (name, rows, aoa = false) => {
    const ws = aoa ? XLSX.utils.aoa_to_sheet(rows) : XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: "none" }]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add("Summary", summary, true);
  add("Equipment_Import", equipment);
  add("Customer_Link_Review", linkReview);
  add("Products_To_Import", buildProductsToImport(equipment));
  add("Job_Recovery", recovery);
  add("Spares_Mapping", spares);
  add("Date_Corrections", dateCorrections);
  add("Exceptions", exceptions);
  XLSX.writeFile(wb, outPath);

  console.log(`\nwrote ${outPath}`);
  for (const [key, value] of summary) {
    if (key && value !== "") console.log(`  ${key}: ${value}`);
  }
}

/**
 * The exact SKUs the installed base needs but Josh does not carry, which is the input
 * list for import-legacy-ai-generator-products.js. Cross-checking this against that
 * script's plan is what confirms the two agree on scope.
 */
function buildProductsToImport(equipment) {
  const byCode = new Map();
  for (const e of equipment) {
    if (!/PRODUCT_NOT_IN_JOSH/.test(e.block_reason) || !e.item_code) continue;
    if (!byCode.has(e.item_code)) {
      byCode.set(e.item_code, { item_code: e.item_code, item_name: e.item_name, machines: [], customers: new Set() });
    }
    const g = byCode.get(e.item_code);
    g.machines.push(e.serial_number);
    if (e.customer_name) g.customers.add(e.customer_name);
  }
  return [...byCode.values()]
    .sort((a, b) => b.machines.length - a.machines.length || a.item_code.localeCompare(b.item_code))
    .map((g) => ({
      item_code: g.item_code,
      item_name: g.item_name,
      machine_count: g.machines.length,
      serials: g.machines.join(", "),
      customers: [...g.customers].join(" | "),
      action: "Import as inactive/service_only via import-legacy-ai-generator-products.js",
    }));
}

/**
 * The service log's date problems, as a worksheet the service team can correct in place.
 *
 * Three kinds, most actionable first. TRANSPOSED rows are provably wrong and the intended
 * date is recoverable. UNREADABLE rows are plain typos. CHECK_2026 rows are the ones that
 * matter most and can least be proved: the same day/month transposition, on a row where
 * both readings are real dates, so nothing in the file distinguishes them. They are listed
 * with both readings so an engineer can say which visit actually happened.
 */
function buildDateCorrections(serviceLog, companyCode, today) {
  const out = [];
  for (const r of serviceLog) {
    if (r.__company !== companyCode) continue;
    for (const [column, shown] of [
      ["Engineer Visit Date", t(r["Engineer Visit Date"])],
      ["Visit / item Date", t(r["Visit / item Date"])],
    ]) {
      if (!shown) continue;
      const iso = logDate(shown);
      const base = {
        source_row: r.__row,
        job_no: t(r["Job No."]),
        column,
        value_in_sheet: shown,
      };

      if (!iso) {
        out.push({
          ...base,
          issue: "UNREADABLE",
          reads_as: "",
          other_reading: "",
          why: "Not a date. Expected DD-MM-YYYY.",
          CONFIRM_correct_date: "",
        });
        continue;
      }

      const swap = swappedDate(iso);
      if (iso > today) {
        out.push({
          ...base,
          issue: swap && swap <= today ? "TRANSPOSED" : "IMPOSSIBLE",
          reads_as: iso,
          other_reading: swap || "",
          why:
            swap && swap <= today
              ? "Cannot have happened yet. Day and month were swapped on entry; the other reading is a real past date."
              : "Cannot have happened yet and swapping day and month does not give a real date either.",
          CONFIRM_correct_date: "",
        });
        continue;
      }

      // Only 2026 shows the fault, so older rows are not worth anyone's time.
      if (iso.startsWith("2026") && isAmbiguousDate(iso) && swap && swap !== iso) {
        out.push({
          ...base,
          issue: "CHECK_2026",
          reads_as: iso,
          other_reading: swap,
          why: "Both readings are real dates, so a swap here would be invisible. Confirm which visit happened.",
          CONFIRM_correct_date: "",
        });
      }
    }
  }
  const rank = { TRANSPOSED: 0, IMPOSSIBLE: 1, UNREADABLE: 2, CHECK_2026: 3 };
  return out.sort((a, b) => rank[a.issue] - rank[b.issue] || a.source_row - b.source_row);
}

/** Group a company's service-log rows into canonical spare labels with item_code suggestions. */
function buildSpares(serviceLog, companyCode, products) {
  const groups = new Map();
  for (const r of serviceLog) {
    if (r.__company !== companyCode) continue;
    const raw = t(r["Item / Spare"]);
    if (!raw) continue;
    const label = canonicalSpareLabel(raw);
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, { label, count: 0, variants: new Set() });
    const g = groups.get(label);
    g.count += 1;
    g.variants.add(raw);
  }

  const total = [...groups.values()].reduce((sum, g) => sum + g.count, 0) || 1;
  let running = 0;
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => {
      running += g.count;
      const row = {
        canonical_label: g.label,
        occurrences: g.count,
        // Mapping in occurrence order lets a reviewer stop once coverage is good
        // enough rather than working through the whole tail.
        cumulative_pct_of_log: ((100 * running) / total).toFixed(1),
        raw_variant_count: g.variants.size,
        raw_variants: [...g.variants].slice(0, 6).join(" | "),
      };
      suggestItemCodes(g.label, products, 3, companyCode).forEach((s, i) => {
        row[`suggested_${i + 1}_item_code`] = s.itemCode;
        row[`suggested_${i + 1}_item_name`] = s.itemName;
        row[`suggested_${i + 1}_company`] = s.company;
        row[`suggested_${i + 1}_score`] = s.score.toFixed(2);
      });
      row.CONFIRM_item_code = "";
      row.is_service_charge_not_a_part = /charge|visit|maintenance|service|commissioning|report/i.test(g.label)
        ? "yes"
        : "";
      return row;
    });
}

function describeAction(issues) {
  if (issues.includes(ISSUE.LETTER_SUFFIX)) return "Two machines share one number — assign distinct serials";
  if (issues.includes(ISSUE.MULTI_REF)) return "Cell holds several machines — one machine per row";
  if (issues.includes(ISSUE.SHORT_NUMBER)) return "Serial looks truncated — confirm the full number";
  if (issues.includes(ISSUE.LETTER_O_FOR_ZERO)) return "Letter O typed for zero — correct the serial";
  if (issues.includes(ISSUE.EMBEDDED_SPACE)) return "Remove the space inside the serial";
  if (issues.includes(ISSUE.SLIP_NUMBER_MISSING)) return "Install slip number missing";
  if (issues.some((i) => i.startsWith("CLIENT_NAME"))) return "Client name is not a usable customer — supply the real name";
  if (issues.some((i) => i.startsWith("DATE") || i.startsWith("WARRANTY"))) return "Fix the date (expected DD-MM-YYYY)";
  return "Review";
}

if (require.main === module) main();

// canonicalSpareLabel is the key the Spares_Mapping sheet is written under, so the
// service-history importer has to use this exact function to read a reviewer's
// CONFIRM_item_code back out again.
module.exports = { canonicalSpareLabel, parseMachineModel, isFinishedGood, loadServiceLogRows };
