#!/usr/bin/env node
/**
 * Generate the BOM entry workbooks for the engineering team, one per product group.
 *
 * Each workbook is a grid: components down the rows, models across the columns, a
 * quantity in the cell. Engineering fills it once per model instead of once per job,
 * which is what makes the ask finishable -- the same nGEN007SH element list would
 * otherwise be retyped for every job that ever shipped one.
 *
 * Two grids per workbook:
 *
 * - Service_Parts, for every model in the group. Its columns are shaped to match
 *   product_aftermarket_mappings, so filling it is what makes a machine offer the right
 *   spares when service quotes it.
 * - Full_BOM, only for the current-era generators that production needs to plan and kit
 *   from. Feeds manufacturing_boms.
 *
 * Nothing is asked for as free text. Every component is entered as an item code, with the
 * resolved part name shown beside it by formula, because manufacturing_bom_lines and
 * product_aftermarket_mappings both require a real product and a name we cannot resolve
 * is a line that can never be imported. The service log already cost us 65 free-text
 * spare labels needing hand mapping; at BOM scale that is unrecoverable.
 *
 * Rows are prefilled from what is already known -- existing BOM lines in Josh, plus
 * spares customers of that model have actually bought -- and marked with where each
 * suggestion came from, so engineering is reviewing rather than remembering.
 *
 * Usage:
 *   node scripts/build-bom-entry-workbooks.js [options]
 *
 * Options:
 *   --itemmaster=<xlsx>  Clan item master (default ItemMaster_AI_10-Sep-2026.xlsx)
 *   --invoices=<xlsx>    invoice itemwise export (sold machines + spare suggestions)
 *   --review=<xlsx>      service master review workbook, for the installed base
 *   --out=<dir>          output folder (default ../BOM)
 *   --company=AI         company whose item master this is
 *   --scope=sold         sold = invoiced ∪ installed only (default). catalog = every
 *                        active machine-group SKU (use later when the factory needs
 *                        Full_BOM for models not yet shipped)
 *   --full-bom-groups=<regex>  groups that also get a Full_BOM grid
 *   --no-db              skip reading existing BOM lines from Josh
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config();

const XLSX = require("xlsx");

const t = (v) => String(v == null ? "" : v).trim();
const squash = (v) => t(v).toUpperCase().replace(/\s+/g, "");
const isYes = (v) => /^(yes|y|true|1)$/i.test(t(v));

const MAPPING_TYPES = ["consumable", "spare", "service_kit", "replacement"];

function parseArgs(argv) {
  const root = path.resolve(__dirname, "../..");
  const out = {
    root,
    itemmaster: "ItemMaster_AI_10-Sep-2026.xlsx",
    invoices: "ERP-invoice-itemwise-report.xlsx",
    review: "Service_Master_Review_AI.xlsx",
    serviceLog: "Service_master_with_Entry_Form.xlsx",
    outDir: path.join(root, "BOM"),
    company: "AI",
    scope: "sold",
    fullBomGroups: "ultra purity|high purity|high flow",
    useDb: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const take = (name) => {
      if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
      if (token === `--${name}` && argv[i + 1]) { i += 1; return argv[i]; }
      return null;
    };
    if (token === "--no-db") { out.useDb = false; continue; }
    let v;
    if ((v = take("itemmaster")) !== null) { out.itemmaster = v; continue; }
    if ((v = take("invoices")) !== null) { out.invoices = v; continue; }
    if ((v = take("review")) !== null) { out.review = v; continue; }
    if ((v = take("log")) !== null) { out.serviceLog = v; continue; }
    if ((v = take("out")) !== null) { out.outDir = path.resolve(v); continue; }
    if ((v = take("company")) !== null) { out.company = t(v).toUpperCase(); continue; }
    if ((v = take("scope")) !== null) { out.scope = t(v).toLowerCase(); continue; }
    if ((v = take("full-bom-groups")) !== null) { out.fullBomGroups = v; continue; }
  }
  if (out.scope !== "sold" && out.scope !== "catalog") {
    throw new Error(`--scope must be sold or catalog, got ${out.scope}`);
  }
  return out;
}

const sheet = (file, name) => {
  const wb = XLSX.readFile(file, { raw: false });
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`sheet "${name}" not found in ${path.basename(file)}`);
  return XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
};

// Groups that hold machines someone could sell, build or service. Anything in "Service"
// is labour, not a thing with a BOM.
const MACHINE_GROUP = /generator|package|psa|air system|gas storage|booster|deoxo|cracker|vessel/i;

// Labour, paperwork and visits get written into the log's spare column alongside real parts.
const NOT_A_PART = /\b(charge|visit|maintenance|service|commissioning|report|labour|labor|freight|transport|installation)\b/i;

// Clan's master carries a few placeholder rows that should not appear in a pick list.
const JUNK_ITEM = /^(test|testing|dummy|sample|xxx|abc)$/i;

/**
 * A model needs a BOM; a component is something that goes into one.
 *
 * scope=sold (default): only machines that are invoiced or already on the installed
 * base become model columns. Never-sold Clan SKUs do not get a workbook.
 * scope=catalog: every active machine-group SKU (for when manufacturing needs Full_BOM
 * for models not yet shipped).
 */
function loadItemMaster(file, { wantedCodes = null, scope = "sold" } = {}) {
  const rows = sheet(file, "Table");
  const models = [];
  const components = [];
  const wanted = wantedCodes
    ? new Set([...wantedCodes].map((c) => squash(c)))
    : null;
  for (const r of rows) {
    const code = t(r["Item Code"]);
    if (!code) continue;
    const item = {
      code,
      name: t(r["Item Name"]) || code,
      group: t(r.Group),
      category: t(r.Category),
      uom: t(r.UOM) || "NOS",
      type: t(r["Item Type"]),
      active: isYes(r.Active),
      wanted: wanted ? wanted.has(squash(code)) : false,
    };
    if (JUNK_ITEM.test(item.name)) continue;
    const isMachine = MACHINE_GROUP.test(item.group);
    if (isMachine) {
      if (scope === "catalog" && item.active) models.push(item);
      else if (scope === "sold" && item.wanted) models.push(item);
      else if (scope === "catalog" && item.wanted && !item.active) models.push(item);
    }
    // Pick list: every active non-labour item, plus any wanted machine so VLOOKUP
    // still resolves retired installed-base SKUs.
    if (item.active && !/^service$/i.test(item.group)) components.push(item);
    else if (item.wanted && isMachine) components.push(item);
  }
  return { models, components };
}

/** Machine item codes that appear as sold lines on the invoice export. */
function loadInvoicedMachineCodes(invoiceFile, itemMasterByCode = null) {
  const codes = new Set();
  if (!fs.existsSync(invoiceFile)) return codes;
  const seen = new Set();
  for (const r of sheet(invoiceFile, "Invoice Items")) {
    const key = `${t(r["Invoice No"])}|${t(r["Line No"])}|${squash(r["Item Code"])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const code = t(r["Item Code"]);
    if (!code) continue;
    const group = t(r.Group) || (itemMasterByCode && itemMasterByCode.get(squash(code))) || "";
    if (!MACHINE_GROUP.test(group)) continue;
    codes.add(code);
  }
  return codes;
}

/** Lightweight code -> Group map from the item master (for older invoice exports). */
function loadItemMasterGroups(file) {
  const map = new Map();
  for (const r of sheet(file, "Table")) {
    const code = t(r["Item Code"]);
    if (code) map.set(squash(code), t(r.Group));
  }
  return map;
}

/**
 * Spares bought by customers who own exactly one model, as suggestions only.
 *
 * This is correlation, not fitment -- a customer with an nGenx 04 also bought a filter
 * for something else entirely -- so every suggested row says where it came from and the
 * instructions tell engineering to delete what does not belong.
 */
function loadSuggestions(invoiceFile, reviewFile, componentByCode) {
  const suggestions = new Map(); // model code -> Map(component code -> customer count)
  if (!fs.existsSync(invoiceFile) || !fs.existsSync(reviewFile)) return suggestions;

  const machinesByCustomer = new Map();
  for (const r of sheet(reviewFile, "Equipment_Import")) {
    const cust = squash(r.customer_code);
    const model = t(r.item_code);
    if (!cust || !model) continue;
    if (!machinesByCustomer.has(cust)) machinesByCustomer.set(cust, new Set());
    machinesByCustomer.get(cust).add(model);
  }
  const soleModel = new Map();
  for (const [cust, models] of machinesByCustomer) {
    if (models.size === 1) soleModel.set(cust, [...models][0]);
  }

  const seen = new Set();
  for (const r of sheet(invoiceFile, "Invoice Items")) {
    // The PDF parser emitted every line three times.
    const key = `${t(r["Invoice No"])}|${t(r["Line No"])}|${squash(r["Item Code"])}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const m = /:\s*(C\d+)\s*$/i.exec(t(r.Customer));
    const cust = m ? squash(m[1]) : "";
    const model = cust ? soleModel.get(cust) : null;
    const code = t(r["Item Code"]);
    if (!model || !code) continue;

    const component = componentByCode.get(squash(code));
    // Only suggest genuine spares. A machine on the same invoice is a second sale, and
    // labour is not a component.
    if (!component || !/spare/i.test(component.group)) continue;

    if (!suggestions.has(model)) suggestions.set(model, new Map());
    const perModel = suggestions.get(model);
    if (!perModel.has(code)) perModel.set(code, new Set());
    perModel.get(code).add(cust);
  }
  return suggestions;
}

/**
 * Parts the service team recorded fitting to machines of each model.
 *
 * This is the strongest evidence available: a part was physically fitted to that machine,
 * not merely bought by someone who owns one. What it cannot give is the item code, since
 * the log is free text -- so these arrive as rows naming the part in words with the code
 * left for engineering to supply, which is the one question only they can answer.
 */
function loadServiceEvidence(logFile, reviewFile) {
  const byModel = new Map(); // model code -> Map(label -> count)
  if (!fs.existsSync(logFile) || !fs.existsSync(reviewFile)) return byModel;

  const { parseJobRef } = require("../src/services/jobNumber");
  const { canonicalSpareLabel } = require("./build-service-master-review-workbook");

  const modelBySerial = new Map();
  for (const r of sheet(reviewFile, "Equipment_Import")) {
    if (t(r.serial_number) && t(r.item_code)) modelBySerial.set(squash(r.serial_number), t(r.item_code));
  }

  for (const r of sheet(logFile, "Service data")) {
    const raw = t(r["Item / Spare"]);
    if (!raw) continue;
    let serial = "";
    try {
      serial = parseJobRef(r["Job No."]).primary || "";
    } catch {
      continue;
    }
    const model = modelBySerial.get(squash(serial));
    if (!model) continue;
    const label = canonicalSpareLabel(raw);
    if (!label) continue;
    // The log records labour and paperwork in the same column as parts. Asking an
    // engineer for the item code of a "commissioning report" wastes their attention.
    if (NOT_A_PART.test(label)) continue;
    if (!byModel.has(model)) byModel.set(model, new Map());
    const perModel = byModel.get(model);
    perModel.set(label, (perModel.get(label) || 0) + 1);
  }
  return byModel;
}

/** BOM lines Josh already holds, so nobody retypes work that is done. */
async function loadExistingBomLines(companyCode) {
  const { pool } = require("../src/db/pool");
  const client = await pool.connect();
  try {
    const res = await client.query(
      `select fg.item_code as model_code,
              c.item_code  as component_code,
              l.qty_per,
              l.remarks
         from manufacturing_boms b
         join companies co on co.id = b.company_id
         join products fg on fg.id = b.finished_good_product_id
         join manufacturing_bom_lines l on l.bom_id = b.id
         join products c on c.id = l.component_product_id
        where upper(co.company_code) = $1 and b.is_active`,
      [companyCode]
    );
    const byModel = new Map();
    for (const r of res.rows) {
      const model = t(r.model_code);
      if (!byModel.has(model)) byModel.set(model, new Map());
      byModel.get(model).set(t(r.component_code), { qty: Number(r.qty_per) || 1, remarks: t(r.remarks) });
    }
    return byModel;
  } finally {
    client.release();
    await pool.end();
  }
}

const slug = (s) => t(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

/**
 * Build one grid sheet: components down, models across.
 *
 * The component name is a formula rather than a copied value so it answers the moment a
 * code is typed, including for rows engineering adds at the bottom.
 */
function gridSheet({ leadColumns, models, rows, nameFormulaCol = "B" }) {
  const header = [...leadColumns, ...models.map((m) => m.code)];
  const aoa = [header];
  for (const row of rows) {
    const lead = leadColumns.map((c) => (row[c] == null ? "" : row[c]));
    aoa.push([...lead, ...models.map((m) => (row.qty && row.qty.has(m.code) ? row.qty.get(m.code) : ""))]);
  }
  // Blank rows so there is somewhere obvious to add components.
  for (let i = 0; i < 40; i += 1) aoa.push(leadColumns.map(() => "").concat(models.map(() => "")));

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const nameIdx = leadColumns.indexOf("component_name");
  if (nameIdx >= 0) {
    for (let r = 1; r < aoa.length; r += 1) {
      const addr = XLSX.utils.encode_cell({ r, c: nameIdx });
      const rowNo = r + 1;
      // The cached value has to be there: xlsx drops a formula cell that has no v.
      ws[addr] = {
        t: "s",
        v: "",
        f: `IFERROR(VLOOKUP($A${rowNo},Components!$A:$B,2,FALSE),IF($A${rowNo}="","","NOT FOUND — check the Components sheet"))`,
      };
    }
  }
  ws["!cols"] = [
    ...leadColumns.map((c) => ({ wch: c === "component_name" ? 42 : c === "notes" || c === "suggested_from" ? 26 : 16 })),
    ...models.map((m) => ({ wch: Math.max(10, m.code.length + 2) })),
  ];
  ws["!freeze"] = { xSplit: String(leadColumns.length), ySplit: "1" };
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }) };
  return { ws, rowCount: aoa.length };
}

function readMeSheet({ groupName, models, hasFullBom, serviceRowCount }) {
  const lines = [
    ["BOM entry — " + groupName],
    [""],
    ["What to do"],
    ["", "1. Service_Parts: for each model column, put the quantity of every part that gets replaced in service."],
    ["", "2. " + (hasFullBom ? "Full_BOM: the complete build list for each model. Production plans and kits from this." : "This group has no Full_BOM sheet; service parts are all that is needed here.")],
    ["", "3. Enter the item code in column A. The part name appears next to it automatically."],
    ["", "4. If the name shows NOT FOUND, the code is wrong. Find the right one on the Components sheet."],
    ["", "5. Part does not exist in the system yet? Put it on New_Parts_Needed. Do not invent a code here."],
    ["", "6. A row that does not belong to any model in this group: delete the whole row."],
    [""],
    ["Why the grid"],
    ["", "Models in this group share most of their parts. Fill the shared rows once and put a"],
    ["", "quantity under each model that uses them. Leave a cell blank if that model does not use the part."],
    [""],
    ["Rows that are already filled in"],
    ["", "suggested_from tells you where a row came from:"],
    ["", "  service_log (nx) — your service team fitted this to a machine of this group n times,"],
    ["", "                     but wrote it in words. Put the item code in column A. These are the"],
    ["", "                     rows that matter most: the part is definitely used, we just lack a code."],
    ["", "  josh_bom         — already recorded in Josh. Correct it if it is wrong."],
    ["", "  invoices (n)     — n customers who own only this model bought this part. A hint, not a fact."],
    ["", "                     Some will be for other equipment on their site. Delete those rows."],
    [""],
    ["Service_Parts columns"],
    ["", "mapping_type     — one of: " + MAPPING_TYPES.join(", ")],
    ["", "interval_days    — replace every N days, if it is time based. Leave blank if not."],
    ["", "interval_hours   — replace every N running hours, if it is usage based. Leave blank if not."],
    ["", "mandatory        — yes if service must always replace it, otherwise leave blank."],
    [""],
    ["Example"],
    ["", "item_code  AONAF012C   name fills in as Filter Element G012 C FT"],
    ["", "mapping_type consumable, interval_days 365, mandatory yes"],
    ["", "then 1 under every model that takes that element, blank under the ones that do not."],
    [""],
    ["Done means"],
    ["", "Every model column in Service_Parts has at least one quantity in it."],
    ["", "No cell in component_name reads NOT FOUND."],
    ["", "Anything you could not resolve is written on New_Parts_Needed instead of left wrong."],
    [""],
    ["This workbook covers " + models.length + " models and starts with " + serviceRowCount + " suggested service rows."],
    ["Models: " + models.map((m) => m.code).join(", ")],
  ];
  const ws = XLSX.utils.aoa_to_sheet(lines);
  ws["!cols"] = [{ wch: 4 }, { wch: 110 }];
  return ws;
}

function componentsSheet(components) {
  const rows = components
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((c) => ({ item_code: c.code, item_name: c.name, uom: c.uom, group: c.group, category: c.category }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [{ wch: 16 }, { wch: 46 }, { wch: 8 }, { wch: 34 }, { wch: 20 }];
  ws["!autofilter"] = { ref: `A1:E${rows.length + 1}` };
  ws["!freeze"] = { ySplit: "1" };
  return ws;
}

function newPartsSheet() {
  const ws = XLSX.utils.aoa_to_sheet([
    ["part_name", "used_on_models", "uom", "make_or_brand", "specification", "approx_cost", "requested_by", "notes"],
    ...Array.from({ length: 60 }, () => ["", "", "", "", "", "", "", ""]),
  ]);
  ws["!cols"] = [{ wch: 40 }, { wch: 26 }, { wch: 8 }, { wch: 18 }, { wch: 40 }, { wch: 12 }, { wch: 18 }, { wch: 30 }];
  return ws;
}

/** A live count of how much of each model's column is filled, so progress is chaseable. */
function progressSheet(models, serviceRows, fullRows, hasFullBom, leadCount) {
  const aoa = [["model", "service_parts_filled", hasFullBom ? "full_bom_filled" : "", "owner", "status", "notes"]];
  for (const m of models) aoa.push([m.code, 0, hasFullBom ? 0 : "", "", "", ""]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  models.forEach((m, i) => {
    const col = XLSX.utils.encode_col(leadCount + i);
    const r = i + 1;
    ws[XLSX.utils.encode_cell({ r, c: 1 })] = { t: "n", v: 0, f: `COUNT(Service_Parts!${col}2:${col}${serviceRows})` };
    if (hasFullBom) {
      ws[XLSX.utils.encode_cell({ r, c: 2 })] = { t: "n", v: 0, f: `COUNT(Full_BOM!${col}2:${col}${fullRows})` };
    }
  });
  ws["!cols"] = [{ wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 34 }];
  return ws;
}

/** One workbook for one product group. */
function buildGroupWorkbook({ groupName, models, components, suggestions, existing, serviceEvidence, hasFullBom, outDir }) {
  // Rows are the union of what Josh holds and what the invoices hint at, so a component
  // shared across the group appears once with a quantity under each model that uses it.
  const rowsByCode = new Map();
  const ensure = (code, from) => {
    if (!rowsByCode.has(code)) {
      rowsByCode.set(code, { item_code: code, component_name: "", mapping_type: "", interval_days: "", interval_hours: "", mandatory: "", suggested_from: from, notes: "", qty: new Map() });
    }
    const row = rowsByCode.get(code);
    if (from === "josh_bom") row.suggested_from = from; // recorded fact outranks a hint
    return row;
  };

  for (const model of models) {
    for (const [code, line] of existing.get(model.code) || []) {
      const row = ensure(code, "josh_bom");
      row.qty.set(model.code, line.qty);
      if (line.remarks && !row.notes) row.notes = line.remarks;
    }
    for (const [code, customers] of suggestions.get(model.code) || []) {
      const row = ensure(code, `invoices (${customers.size})`);
      // Deliberately no quantity: a purchase says nothing about how many the machine takes.
      if (!row.qty.has(model.code)) row.qty.set(model.code, "");
    }
  }

  // Parts the service team fitted, keyed by the words they used. These have no item code
  // yet, so they sit at the top as the rows most worth an engineer's attention.
  const labelRows = new Map();
  for (const model of models) {
    for (const [label, count] of serviceEvidence.get(model.code) || []) {
      if (!labelRows.has(label)) {
        labelRows.set(label, {
          item_code: "",
          component_name: "",
          mapping_type: "",
          interval_days: "",
          interval_hours: "",
          mandatory: "",
          suggested_from: "service_log",
          notes: `Service fitted "${label}" — supply the item code`,
          fitted: 0,
          qty: new Map(),
        });
      }
      const row = labelRows.get(label);
      row.fitted += count;
      row.qty.set(model.code, "");
    }
  }
  for (const row of labelRows.values()) {
    row.suggested_from = `service_log (${row.fitted}x)`;
    delete row.fitted;
  }

  const coded = [...rowsByCode.values()].sort((a, b) => {
    const rank = (r) => (r.suggested_from === "josh_bom" ? 0 : 1);
    return rank(a) - rank(b) || a.item_code.localeCompare(b.item_code);
  });
  const rows = [...labelRows.values(), ...coded];

  const serviceLead = ["item_code", "component_name", "mapping_type", "interval_days", "interval_hours", "mandatory", "suggested_from", "notes"];
  const fullLead = ["item_code", "component_name", "suggested_from", "notes"];

  const service = gridSheet({ leadColumns: serviceLead, models, rows });
  const full = hasFullBom
    ? gridSheet({ leadColumns: fullLead, models: models.filter((m) => m.isCurrentGenerator), rows: rows.map((r) => ({ ...r, qty: new Map() })) })
    : null;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, readMeSheet({ groupName, models, hasFullBom, serviceRowCount: rows.length }), "Read_Me_First");
  XLSX.utils.book_append_sheet(wb, service.ws, "Service_Parts");
  if (full) XLSX.utils.book_append_sheet(wb, full.ws, "Full_BOM");
  XLSX.utils.book_append_sheet(wb, componentsSheet(components), "Components");
  XLSX.utils.book_append_sheet(wb, newPartsSheet(), "New_Parts_Needed");
  XLSX.utils.book_append_sheet(
    wb,
    progressSheet(models, service.rowCount, full ? full.rowCount : 0, hasFullBom, serviceLead.length),
    "Progress"
  );

  const file = path.join(outDir, `BOM_${slug(groupName)}.xlsx`);
  XLSX.writeFile(wb, file);
  return { file, models: models.length, rows: rows.length, fromJosh: rows.filter((r) => r.suggested_from === "josh_bom").length };
}

/**
 * One workbook for units that differ from their model's standard build.
 *
 * This is the part of the per-job idea worth keeping. Josh records an as-built per unit in
 * job_asset_bom_lines, but it links back to the product BOM and flags the difference, so
 * only the deviations need writing down -- not a file per job repeating the standard.
 */
function buildDeviationsWorkbook({ installed, components, outDir }) {
  const wb = XLSX.utils.book_new();

  const readme = XLSX.utils.aoa_to_sheet([
    ["Job deviations — units that were not built to the standard list"],
    [""],
    ["Only list a machine here if what went out differs from its model's standard BOM."],
    ["A machine built to standard needs no row: Josh takes the model's BOM for it."],
    [""],
    ["Examples worth recording"],
    ["", "a different compressor or dryer than the standard build"],
    ["", "extra or larger storage"],
    ["", "a one-off engineered unit such as nGEN002UH M"],
    ["", "a part substituted because the standard one was unavailable"],
    [""],
    ["change_type"],
    ["", "added      — fitted in addition to the standard list"],
    ["", "removed    — standard part not fitted"],
    ["", "substituted— standard part replaced; put the standard code in replaces_item_code"],
    [""],
    ["Serial numbers are as Josh holds them: " + installed.slice(0, 6).map((m) => m.serial).join(", ") + " and so on."],
  ]);
  readme["!cols"] = [{ wch: 4 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, readme, "Read_Me_First");

  const aoa = [["serial_number", "model_item_code", "change_type", "item_code", "component_name", "qty", "replaces_item_code", "reason"]];
  for (let i = 0; i < 200; i += 1) aoa.push(["", "", "", "", "", "", "", ""]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = 1; r < aoa.length; r += 1) {
    ws[XLSX.utils.encode_cell({ r, c: 4 })] = {
      t: "s",
      v: "",
      f: `IFERROR(VLOOKUP($D${r + 1},Components!$A:$B,2,FALSE),IF($D${r + 1}="","","NOT FOUND — check the Components sheet"))`,
    };
  }
  ws["!cols"] = [{ wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 42 }, { wch: 8 }, { wch: 20 }, { wch: 40 }];
  ws["!freeze"] = { ySplit: "1" };
  XLSX.utils.book_append_sheet(wb, ws, "Deviations");

  const known = XLSX.utils.json_to_sheet(
    installed.map((m) => ({ serial_number: m.serial, model_item_code: m.model, customer_code: m.customer, site: m.site }))
  );
  known["!cols"] = [{ wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 40 }];
  known["!autofilter"] = { ref: `A1:D${installed.length + 1}` };
  XLSX.utils.book_append_sheet(wb, known, "Installed_Base");
  XLSX.utils.book_append_sheet(wb, componentsSheet(components), "Components");

  const file = path.join(outDir, "BOM_Job_Deviations.xlsx");
  XLSX.writeFile(wb, file);
  return { file, machines: installed.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolveIn = (f) => (path.isAbsolute(f) ? f : path.resolve(args.root, f));
  const itemmaster = resolveIn(args.itemmaster);
  if (!fs.existsSync(itemmaster)) {
    console.error(`item master not found: ${itemmaster}`);
    process.exitCode = 1;
    return;
  }

  const installed = [];
  const reviewFile = resolveIn(args.review);
  if (fs.existsSync(reviewFile)) {
    for (const r of sheet(reviewFile, "Equipment_Import")) {
      if (!t(r.serial_number) || !t(r.item_code)) continue;
      installed.push({ serial: t(r.serial_number), model: t(r.item_code), customer: t(r.customer_code), site: t(r.site_location) });
    }
  }

  const invoiceFile = resolveIn(args.invoices);
  const itemMasterGroups = loadItemMasterGroups(itemmaster);
  const invoicedCodes = loadInvoicedMachineCodes(invoiceFile, itemMasterGroups);
  const wantedCodes = new Set([
    ...installed.map((m) => m.model),
    ...invoicedCodes,
  ]);

  const { models, components } = loadItemMaster(itemmaster, {
    wantedCodes,
    scope: args.scope,
  });
  const componentByCode = new Map(components.map((c) => [squash(c.code), c]));
  const fullBomRe = new RegExp(args.fullBomGroups, "i");
  for (const m of models) m.isCurrentGenerator = /(HF|SH|UH)$/i.test(squash(m.code));

  const suggestions = loadSuggestions(invoiceFile, reviewFile, componentByCode);
  const serviceEvidence = loadServiceEvidence(resolveIn(args.serviceLog), resolveIn(args.review));

  let existing = new Map();
  if (args.useDb) {
    try {
      existing = await loadExistingBomLines(args.company);
    } catch (err) {
      console.log(`could not read existing BOM lines from Josh (${err.code || err.message}).`);
      console.log("continuing without them -- run this on the server to prefill what is already recorded.\n");
    }
  }

  fs.mkdirSync(args.outDir, { recursive: true });

  // Drop stale group files from a previous wider scope so engineering never opens a
  // never-sold booster workbook by mistake.
  const keep = new Set(["BOM_Job_Deviations.xlsx"]);
  const byGroup = new Map();
  for (const m of models) {
    if (!byGroup.has(m.group)) byGroup.set(m.group, []);
    byGroup.get(m.group).push(m);
  }
  for (const groupName of byGroup.keys()) keep.add(`BOM_${slug(groupName)}.xlsx`);
  for (const name of fs.readdirSync(args.outDir)) {
    if (!/^BOM_.*\.xlsx$/i.test(name) || /^~\$/.test(name)) continue;
    if (keep.has(name)) continue;
    fs.unlinkSync(path.join(args.outDir, name));
    console.log(`removed stale ${name}`);
  }

  const inactiveWanted = models.filter((m) => !m.active).length;
  console.log(`item master : ${itemmaster}`);
  console.log(`scope       : ${args.scope}${args.scope === "sold" ? " (invoiced ∪ installed only)" : " (full active catalog + installed)"}`);
  console.log(`wanted SKUs : ${wantedCodes.size} (${installed.length} installed rows, ${invoicedCodes.size} invoiced machine codes)`);
  console.log(`models      : ${models.length} in ${byGroup.size} groups`);
  if (inactiveWanted) {
    console.log(`              (${inactiveWanted} inactive SKUs kept because they were sold / are still running)`);
  }
  console.log(`components  : ${components.length} available to pick from`);
  console.log(`prefill     : ${existing.size} models with BOM lines in Josh, ${suggestions.size} with invoice hints,`);
  console.log(`              ${serviceEvidence.size} with parts the service team actually fitted`);
  console.log(`output      : ${args.outDir}\n`);

  const built = [];
  for (const [groupName, groupModels] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) {
    // A: Full_BOM only when this group has a current-era generator that was actually sold.
    const hasFullBom = fullBomRe.test(groupName) && groupModels.some((m) => m.isCurrentGenerator);
    built.push({
      group: groupName,
      hasFullBom,
      ...buildGroupWorkbook({
        groupName,
        models: groupModels.slice().sort((a, b) => a.code.localeCompare(b.code)),
        components,
        suggestions,
        existing,
        serviceEvidence,
        hasFullBom,
        outDir: args.outDir,
      }),
    });
  }

  const dev = buildDeviationsWorkbook({ installed, components, outDir: args.outDir });

  for (const b of built) {
    console.log(
      `  ${path.basename(b.file).padEnd(52)} ${String(b.models).padStart(3)} models  ` +
        `${String(b.rows).padStart(3)} rows (${b.fromJosh} from Josh)${b.hasFullBom ? "  + Full_BOM" : ""}`
    );
  }
  console.log(`  ${path.basename(dev.file).padEnd(52)} ${dev.machines} machines listed`);
  console.log(`\n${built.length + 1} workbooks written.`);
  console.log(`Full BOM grids on: ${built.filter((b) => b.hasFullBom).map((b) => b.group).join(", ") || "none"}`);
  if (args.scope === "sold") {
    console.log("When the factory needs BOMs for models not yet shipped, rebuild with --scope=catalog.");
  }
}

if (require.main === module) main();

module.exports = {
  loadItemMaster,
  loadInvoicedMachineCodes,
  loadItemMasterGroups,
  loadSuggestions,
  slug,
  MACHINE_GROUP,
  MAPPING_TYPES,
  NOT_A_PART,
  JUNK_ITEM,
};
