const X = require("xlsx");
const path = require("path");
const t = (v) => String(v == null ? "" : v).trim();

const dir = path.resolve(__dirname, "../../BOM");
for (const f of ["BOM_nGen_Nitrogen_Generator_Ultra_Purity.xlsx", "BOM_IDOS_Oxygen_Generator.xlsx", "BOM_Job_Deviations.xlsx"]) {
  const wb = X.readFile(path.join(dir, f), { raw: false, cellFormula: true });
  console.log(`\n=== ${f} ===`);
  console.log("sheets:", wb.SheetNames.join(", "));

  const sp = wb.Sheets.Service_Parts || wb.Sheets.Deviations;
  const ref = X.utils.decode_range(sp["!ref"]);
  console.log(`grid: ${ref.e.r + 1} rows x ${ref.e.c + 1} cols`);

  const header = [];
  for (let c = 0; c <= ref.e.c; c += 1) {
    const cell = sp[X.utils.encode_cell({ r: 0, c })];
    header.push(cell ? t(cell.v) : "");
  }
  console.log("lead cols:", header.slice(0, 8).join(" | "));
  console.log("model cols:", header.slice(8, 14).join(" | "), header.length > 14 ? `... (${header.length - 8} models)` : "");

  // the name formula must be present on both prefilled and blank rows
  const b2 = sp[X.utils.encode_cell({ r: 1, c: wb.Sheets.Deviations ? 4 : 1 })];
  const bLast = sp[X.utils.encode_cell({ r: ref.e.r, c: wb.Sheets.Deviations ? 4 : 1 })];
  console.log("name formula, first row:", b2 && b2.f ? b2.f.slice(0, 70) : "MISSING");
  console.log("name formula, last row :", bLast && bLast.f ? bLast.f.slice(0, 70) : "MISSING");

  if (wb.Sheets.Service_Parts) {
    const rows = X.utils.sheet_to_json(wb.Sheets.Service_Parts, { defval: "", raw: false }).filter((r) => t(r.item_code) || t(r.suggested_from));
    console.log(`prefilled rows: ${rows.length}`);
    for (const r of rows.slice(0, 6)) {
      console.log(`   ${(t(r.item_code) || "(no code)").padEnd(12)} ${t(r.suggested_from).padEnd(18)} ${t(r.notes).slice(0, 52)}`);
    }
    const comps = X.utils.sheet_to_json(wb.Sheets.Components, { defval: "", raw: false });
    console.log(`components lookup: ${comps.length} rows, first ${t(comps[0].item_code)} = ${t(comps[0].item_name)}`);
    const prog = X.utils.sheet_to_json(wb.Sheets.Progress, { defval: "", raw: false });
    console.log(`progress sheet: ${prog.length} models tracked`);
    const pcell = wb.Sheets.Progress[X.utils.encode_cell({ r: 1, c: 1 })];
    console.log(`  count formula: ${pcell && pcell.f ? pcell.f : "MISSING"}`);
  }
}
