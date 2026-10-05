#!/usr/bin/env node
/**
 * Checks on the BOM workbook builder and importer: quantity parsing, grid reading,
 * problem detection, duplicate-component folding, and the filters that keep junk
 * and labour out of the pick list.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");

const {
  qty,
  interval,
  readGrid,
  foldBomLines,
  SERVICE_LEAD,
  FULL_LEAD,
} = require("./import-boms-from-workbooks");
const {
  loadItemMaster,
  MACHINE_GROUP,
  NOT_A_PART,
  JUNK_ITEM,
  slug,
} = require("./build-bom-entry-workbooks");

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
};

// ---- qty / interval -------------------------------------------------------
check("qty blank is null", qty(""), null);
check("qty zero is null", qty("0"), null);
check("qty negative is null", qty("-1"), null);
check("qty positive", qty("2"), 2);
check("qty with comma", qty("1,250"), 1250);
check("qty decimal", qty("0.5"), 0.5);
check("qty word is null", qty("two"), null);
check("interval blank", interval(""), null);
check("interval zero", interval("0"), null);
check("interval days", interval("365"), 365);
check("interval rounds", interval("12.7"), 13);

// ---- grid reading ---------------------------------------------------------
function sheetFrom(aoa) {
  return XLSX.utils.aoa_to_sheet(aoa);
}

const serviceGrid = sheetFrom([
  [...SERVICE_LEAD, "nGEN007SH", "nGEN010SH"],
  ["AONAF012C", "", "consumable", "365", "", "yes", "josh_bom", "", "1", "2"],
  ["ASH60", "", "spare", "", "2000", "", "invoices (3)", "hint", "1", ""],
  ["", "", "consumable", "", "", "", "service_log (4)", "filter elements", "1", "1"], // qty but no code
  ["ASH4", "", "widget", "", "", "", "", "", "1", ""], // bad mapping type
  ["ASH20", "", "spare", "", "", "", "", "", "", ""], // code but no qty
  ["", "", "", "", "", "", "", "", "", ""], // blank row, ignored
]);

const service = readGrid(serviceGrid, SERVICE_LEAD, "Service_Parts");
check("service entries", service.entries.length, 3); // AONAF012C x2 models + ASH60 x1
check(
  "service models expand",
  service.entries.filter((e) => e.componentCode === "AONAF012C").map((e) => [e.modelCode, e.qty]),
  [
    ["nGEN007SH", 1],
    ["nGEN010SH", 2],
  ]
);
check("mandatory yes", service.entries[0].mandatory, true);
check("interval_days", service.entries[0].intervalDays, 365);
check("interval_hours", service.entries.find((e) => e.componentCode === "ASH60").intervalHours, 2000);
check("default mapping_type", service.entries.find((e) => e.componentCode === "ASH60").mappingType, "spare");
check(
  "problems found",
  service.problems.map((p) => p.reason).sort(),
  ["BAD_MAPPING_TYPE", "ITEM_CODE_BUT_NO_QUANTITY", "QUANTITIES_BUT_NO_ITEM_CODE"]
);

// An engineer may insert a column; the reader must find the first model by header,
// not by a fixed offset.
const inserted = sheetFrom([
  ["item_code", "component_name", "extra_note", "mapping_type", "interval_days", "interval_hours", "mandatory", "suggested_from", "notes", "nGEN007SH"],
  ["AONAF012C", "", "keep me", "consumable", "", "", "", "", "", "3"],
]);
const insertedRead = readGrid(inserted, SERVICE_LEAD, "Service_Parts");
check("inserted column still finds model", insertedRead.entries.length, 1);
check("inserted column qty", insertedRead.entries[0].qty, 3);
check("inserted column model", insertedRead.entries[0].modelCode, "nGEN007SH");

const fullGrid = sheetFrom([
  [...FULL_LEAD, "nGEN007SH"],
  ["AONAF012C", "", "josh_bom", "", "2"],
  ["AONAF012C", "", "duplicate", "", "1"], // same component twice
  ["ASH60", "", "", "", "1"],
]);
const full = readGrid(fullGrid, FULL_LEAD, "Full_BOM");
check("full bom raw entries", full.entries.length, 3);

// ---- fold: same component on two rows becomes one line with summed qty -----
const model = { id: 10, item_code: "nGEN007SH" };
const filter = { id: 20, item_code: "AONAF012C", item_name: "Filter", uom: "NOS" };
const sov = { id: 21, item_code: "ASH60", item_name: "SOV", uom: "NOS" };
const folded = foldBomLines([
  { model, component: filter, qty: 2, row: 2, notes: "a" },
  { model, component: filter, qty: 1, row: 3, notes: "b" },
  { model, component: sov, qty: 1, row: 4, notes: "" },
]);
check("fold keeps one model", folded.size, 1);
const lines = folded.get("nGEN007SH").lines;
check("fold collapses to two components", lines.size, 2);
check("fold sums quantities", lines.get(20).qty, 3);
check("fold records the extra row", lines.get(20).foldedRows, [3]);
check("fold leaves unique parts alone", lines.get(21).foldedRows, []);

// ---- builder filters ------------------------------------------------------
check("machine group matches generator", MACHINE_GROUP.test("nGen Nitrogen Generator"), true);
check("machine group matches air package", MACHINE_GROUP.test("nGen Air Package"), true);
check("machine group rejects Spares", MACHINE_GROUP.test("Spares"), false);
check("machine group rejects Service", MACHINE_GROUP.test("Service"), false);
check("junk TEST", JUNK_ITEM.test("TEST"), true);
check("junk Dummy", JUNK_ITEM.test("Dummy"), true);
check("junk real name", JUNK_ITEM.test("Filter Element G012"), false);
check("not a part: commissioning report", NOT_A_PART.test("commissioning report"), true);
check("not a part: service visit", NOT_A_PART.test("service visit charge"), true);
check("not a part: real filter", NOT_A_PART.test("filter elements"), false);
check("slug", slug("nGen Nitrogen Generator Ultra Purity"), "nGen_Nitrogen_Generator_Ultra_Purity");

// ---- loadItemMaster against a tiny workbook -------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bom-verify-"));
const imPath = path.join(tmpDir, "ItemMaster.xlsx");
const imWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  imWb,
  XLSX.utils.json_to_sheet([
    { Category: "Nitrogen", Group: "nGen Nitrogen Generator High Purity", "Item Code": "nGEN007SH", "Item Name": "nGEN 007 SH", UOM: "NOS", "Item Type": "FG", Active: "Yes" },
    { Category: "Absstem Shield", Group: "Spares", "Item Code": "AONAF012C", "Item Name": "Filter Element", UOM: "NOS", "Item Type": "RM", Active: "Yes" },
    { Category: "Absstem Shield", Group: "Spares", "Item Code": "TEST", "Item Name": "TEST", UOM: "NOS", "Item Type": "RM", Active: "Yes" },
    { Category: "Labour", Group: "Service", "Item Code": "SVC01", "Item Name": "Commissioning", UOM: "NOS", "Item Type": "Service", Active: "Yes" },
    { Category: "Nitrogen", Group: "nGen Nitrogen Generator", "Item Code": "nGEN 07", "Item Name": "nGEN 07", UOM: "NOS", "Item Type": "FG", Active: "No" },
  ]),
  "Table"
);
XLSX.writeFile(imWb, imPath);

const { models, components } = loadItemMaster(imPath, { scope: "catalog" });
check("catalog models: active generator only", models.map((m) => m.code), ["nGEN007SH"]);
check("components exclude junk", components.some((c) => c.code === "TEST"), false);
check("components exclude Service group", components.some((c) => c.code === "SVC01"), false);
check("components include spare", components.some((c) => c.code === "AONAF012C"), true);
// A machine is also a legitimate component of a package, so active models stay on the
// pick list even though they also appear as models.
check("components include the model itself", components.some((c) => c.code === "nGEN007SH"), true);
check("catalog skips inactive", models.some((m) => m.code === "nGEN 07"), false);

// scope=sold: only invoiced / installed machines become columns, active or not.
const soldEmpty = loadItemMaster(imPath, { scope: "sold", wantedCodes: new Set() });
check("sold with no wanted SKUs is empty", soldEmpty.models.length, 0);
const soldWanted = loadItemMaster(imPath, { scope: "sold", wantedCodes: new Set(["nGEN 07", "nGEN007SH"]) });
check("sold keeps wanted active + inactive", soldWanted.models.map((m) => m.code).sort(), ["nGEN 07", "nGEN007SH"]);
check("sold ignores never-sold active", loadItemMaster(imPath, { scope: "sold", wantedCodes: new Set(["nGEN 07"]) }).models.map((m) => m.code), ["nGEN 07"]);
check("wanted inactive is on Components", soldWanted.components.some((c) => c.code === "nGEN 07"), true);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\npass ${pass}/${pass + fail}`);
if (fail) process.exitCode = 1;
