#!/usr/bin/env node
/**
 * Read the engineering team's filled BOM workbooks back into Josh.
 *
 * Service_Parts becomes product_aftermarket_mappings, which is what makes a machine offer
 * the right spares when service quotes it. Full_BOM becomes manufacturing_boms, which is
 * what production plans and kits from.
 *
 * Non-destructive by design. Lines are inserted or their quantity updated, and anything
 * in Josh that the sheet no longer mentions is reported rather than deleted -- these
 * workbooks are being filled by several people over weeks, and a half-finished sheet must
 * never silently wipe work done elsewhere. Use --prune to remove them deliberately.
 *
 * Both tables demand a real product: manufacturing_bom_lines.component_product_id is NOT
 * NULL, and product_aftermarket_mappings has a trigger requiring both sides to be in the
 * company's scope. So a row whose code does not resolve is reported against its workbook,
 * sheet and row, for the engineer who wrote it to fix.
 *
 * Usage:
 *   node scripts/import-boms-from-workbooks.js [options]
 *
 * Options:
 *   --dir=<folder>   folder holding the BOM_*.xlsx workbooks (default ../BOM)
 *   --company=AI     company to import for
 *   --file=<xlsx>    just one workbook, for checking a single engineer's work
 *   --prune          delete lines and mappings the sheets no longer mention
 *   --apply          commit; omit for a dry run
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config();

const XLSX = require("xlsx");
const { pool } = require("../src/db/pool");

const t = (v) => String(v == null ? "" : v).trim();
const squash = (v) => t(v).toUpperCase().replace(/\s+/g, "");
const isYes = (v) => /^(yes|y|true|1|mandatory)$/i.test(t(v));

const MAPPING_TYPES = new Set(["consumable", "spare", "service_kit", "replacement"]);
const SERVICE_LEAD = ["item_code", "component_name", "mapping_type", "interval_days", "interval_hours", "mandatory", "suggested_from", "notes"];
const FULL_LEAD = ["item_code", "component_name", "suggested_from", "notes"];

function parseArgs(argv) {
  const out = {
    dir: path.resolve(__dirname, "../../BOM"),
    company: "AI",
    file: "",
    prune: false,
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const take = (name) => {
      if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
      if (token === `--${name}` && argv[i + 1]) { i += 1; return argv[i]; }
      return null;
    };
    if (token === "--apply") { out.apply = true; continue; }
    if (token === "--prune") { out.prune = true; continue; }
    let v;
    if ((v = take("dir")) !== null) { out.dir = path.resolve(v); continue; }
    if ((v = take("file")) !== null) { out.file = path.resolve(v); continue; }
    if ((v = take("company")) !== null) { out.company = t(v).toUpperCase(); continue; }
  }
  return out;
}

/** A positive number, or null. Blank means "this model does not use the part". */
function qty(value) {
  const s = t(value);
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function interval(value) {
  const n = Number(t(value));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Read one grid sheet into flat entries.
 *
 * The lead columns describe the component; every column after them is a model, and a
 * quantity in that cell is the statement "this model uses this many".
 */
function readGrid(ws, leadColumns, sheetName) {
  if (!ws) return { entries: [], problems: [] };
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: true });
  const header = (grid[0] || []).map((h) => t(h));
  const entries = [];
  const problems = [];

  // Trust the header rather than a fixed offset: an engineer may have inserted a column.
  const leadCount = header.findIndex((h, i) => i >= leadColumns.length - 1 && !leadColumns.includes(h));
  const firstModelCol = leadCount === -1 ? leadColumns.length : leadCount;
  const models = header.slice(firstModelCol).map((h, i) => ({ code: h, col: firstModelCol + i })).filter((m) => m.code);

  for (let r = 1; r < grid.length; r += 1) {
    const line = grid[r];
    if (!line || line.every((c) => !t(c))) continue;
    const get = (name) => {
      const i = header.indexOf(name);
      return i === -1 ? "" : t(line[i]);
    };

    const code = get("item_code");
    const quantities = models.map((m) => ({ model: m.code, q: qty(line[m.col]) })).filter((x) => x.q !== null);

    if (!code) {
      // A service_log row nobody has coded yet is expected, not an error -- unless they
      // filled quantities against it, which means the work is half done.
      if (quantities.length) {
        problems.push({ sheet: sheetName, row: r + 1, reason: "QUANTITIES_BUT_NO_ITEM_CODE", detail: get("notes").slice(0, 60) });
      }
      continue;
    }
    if (!quantities.length) {
      problems.push({ sheet: sheetName, row: r + 1, reason: "ITEM_CODE_BUT_NO_QUANTITY", detail: code });
      continue;
    }

    const mappingType = t(get("mapping_type")).toLowerCase().replace(/[\s-]+/g, "_");
    if (sheetName === "Service_Parts" && mappingType && !MAPPING_TYPES.has(mappingType)) {
      problems.push({ sheet: sheetName, row: r + 1, reason: "BAD_MAPPING_TYPE", detail: `${code}: ${mappingType}` });
      continue;
    }

    for (const { model, q } of quantities) {
      entries.push({
        sheet: sheetName,
        row: r + 1,
        modelCode: model,
        componentCode: code,
        qty: q,
        mappingType: mappingType || "consumable",
        intervalDays: interval(get("interval_days")),
        intervalHours: interval(get("interval_hours")),
        mandatory: isYes(get("mandatory")),
        notes: get("notes"),
      });
    }
  }
  return { entries, problems };
}

function readWorkbook(file) {
  const wb = XLSX.readFile(file, { raw: false });
  const service = readGrid(wb.Sheets.Service_Parts, SERVICE_LEAD, "Service_Parts");
  const full = readGrid(wb.Sheets.Full_BOM, FULL_LEAD, "Full_BOM");

  const newParts = [];
  if (wb.Sheets.New_Parts_Needed) {
    for (const r of XLSX.utils.sheet_to_json(wb.Sheets.New_Parts_Needed, { defval: "", raw: false })) {
      if (t(r.part_name)) newParts.push({ name: t(r.part_name), models: t(r.used_on_models), spec: t(r.specification) });
    }
  }

  const deviations = [];
  if (wb.Sheets.Deviations) {
    for (const r of XLSX.utils.sheet_to_json(wb.Sheets.Deviations, { defval: "", raw: false })) {
      if (!t(r.serial_number)) continue;
      deviations.push({
        serial: t(r.serial_number),
        changeType: t(r.change_type).toLowerCase(),
        componentCode: t(r.item_code),
        qty: qty(r.qty),
        replaces: t(r.replaces_item_code),
        reason: t(r.reason),
      });
    }
  }

  return { service, full, newParts, deviations };
}

/**
 * One line per (model, component) is all manufacturing_bom_lines allows. When the same
 * part is written on two sheet rows for one model, fold them into a single line whose
 * quantity is the sum — otherwise the unique index aborts the whole transaction.
 */
function foldBomLines(lines) {
  const byModel = new Map();
  for (const line of lines) {
    const modelKey = line.model.item_code;
    if (!byModel.has(modelKey)) byModel.set(modelKey, { model: line.model, lines: new Map() });
    const byComponent = byModel.get(modelKey).lines;
    const existing = byComponent.get(line.component.id);
    if (existing) {
      existing.qty += line.qty;
      existing.foldedRows.push(line.row);
    } else {
      byComponent.set(line.component.id, { ...line, foldedRows: [] });
    }
  }
  return byModel;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = args.file
    ? [args.file]
    : fs.existsSync(args.dir)
      ? fs.readdirSync(args.dir).filter((f) => /^BOM_.*\.xlsx$/i.test(f) && !/^~\$/.test(f)).map((f) => path.join(args.dir, f))
      : [];

  if (!files.length) {
    console.error(`no BOM workbooks found in ${args.dir}`);
    console.error("run scripts/build-bom-entry-workbooks.js first");
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const companyRes = await client.query(
      `select id, company_code from companies where upper(company_code) = $1 limit 1`,
      [args.company]
    );
    const company = companyRes.rows[0];
    if (!company) throw new Error(`COMPANY_NOT_FOUND: ${args.company}`);

    // Both tables require the product to be in this company's scope, so scope is part of
    // the lookup rather than something we discover when the insert fails.
    const productRes = await client.query(
      `select p.id, p.item_code, p.item_name, coalesce(p.uom, 'NOS') as uom,
              (pol.product_id is not null) as in_scope
         from products p
         left join company_product_policies pol
           on pol.product_id = p.id and pol.company_id = $1`,
      [company.id]
    );
    const productByCode = new Map(productRes.rows.map((p) => [squash(p.item_code), p]));

    const equipmentRes = await client.query(
      `select serial_number from installed_equipment where company_id = $1`,
      [company.id]
    );
    const serials = new Set(equipmentRes.rows.map((r) => squash(r.serial_number)));

    const summaries = [];
    const allProblems = [];
    const mappings = [];
    const bomLines = new Map(); // model code -> [{component, qty, notes}]
    const newParts = [];
    const deviations = [];

    for (const file of files) {
      const wb = readWorkbook(file);
      const name = path.basename(file);
      const problems = [...wb.service.problems, ...wb.full.problems].map((p) => ({ ...p, file: name }));

      const resolve = (entry, target) => {
        const model = productByCode.get(squash(entry.modelCode));
        const component = productByCode.get(squash(entry.componentCode));
        const fail = (reason, detail) => problems.push({ file: name, sheet: entry.sheet, row: entry.row, reason, detail });

        if (!model) return fail("MODEL_NOT_IN_JOSH", entry.modelCode);
        if (!component) return fail("COMPONENT_NOT_IN_JOSH", entry.componentCode);
        if (!model.in_scope) return fail("MODEL_NOT_IN_COMPANY_SCOPE", entry.modelCode);
        if (!component.in_scope) return fail("COMPONENT_NOT_IN_COMPANY_SCOPE", entry.componentCode);
        // Both tables forbid this, and it is always a typo rather than an intention.
        if (model.id === component.id) return fail("COMPONENT_SAME_AS_MODEL", entry.modelCode);

        target.push({ ...entry, model, component });
        return null;
      };

      const fileMappings = [];
      for (const entry of wb.service.entries) resolve(entry, fileMappings);
      const fileBomLines = [];
      for (const entry of wb.full.entries) resolve(entry, fileBomLines);

      mappings.push(...fileMappings);
      for (const [modelKey, folded] of foldBomLines(fileBomLines)) {
        if (!bomLines.has(modelKey)) bomLines.set(modelKey, { model: folded.model, lines: new Map() });
        const target = bomLines.get(modelKey).lines;
        for (const [componentId, line] of folded.lines) {
          const existing = target.get(componentId);
          if (existing) {
            existing.qty += line.qty;
            existing.foldedRows.push(...line.foldedRows, line.row);
          } else {
            target.set(componentId, line);
          }
        }
      }
      for (const p of wb.newParts) newParts.push({ ...p, file: name });
      for (const d of wb.deviations) {
        deviations.push({ ...d, file: name, knownSerial: serials.has(squash(d.serial)) });
      }

      allProblems.push(...problems);
      summaries.push({
        file: name,
        models: new Set([...wb.service.entries, ...wb.full.entries].map((e) => e.modelCode)).size,
        service: fileMappings.length,
        bom: fileBomLines.length,
        newParts: wb.newParts.length,
        problems: problems.length,
      });
    }

    // Deduplicate on the key the table actually enforces; the same part can legitimately
    // appear twice in a sheet across rows an engineer added at different times.
    const mappingByKey = new Map();
    let duplicateMappings = 0;
    for (const m of mappings) {
      const key = `${m.model.id}|${m.component.id}|${m.mappingType}`;
      if (mappingByKey.has(key)) { duplicateMappings += 1; continue; }
      mappingByKey.set(key, m);
    }

    const existingMapRes = await client.query(
      `select parent_product_id, replacement_product_id, mapping_type, qty_per_parent
         from product_aftermarket_mappings where company_id = $1`,
      [company.id]
    );
    const existingMappings = new Set(
      existingMapRes.rows.map((r) => `${r.parent_product_id}|${r.replacement_product_id}|${r.mapping_type}`)
    );

    const existingBomRes = await client.query(
      `select b.id as bom_id, fg.item_code as model_code, count(l.id) as line_count
         from manufacturing_boms b
         join products fg on fg.id = b.finished_good_product_id
         left join manufacturing_bom_lines l on l.bom_id = b.id
        where b.company_id = $1 and b.is_active
        group by 1, 2`,
      [company.id]
    );
    const existingBoms = new Map(existingBomRes.rows.map((r) => [squash(r.model_code), r]));

    console.log("");
    console.log(`Mode      : ${args.apply ? "APPLY" : "DRY RUN"}${args.prune ? " (pruning)" : ""}`);
    console.log(`Company   : ${company.company_code} (id ${company.id})`);
    console.log(`Workbooks : ${files.length} in ${args.file ? path.dirname(args.file) : args.dir}`);
    console.log("");
    console.log("Per workbook:");
    for (const s of summaries.sort((a, b) => b.service + b.bom - (a.service + a.bom))) {
      if (!s.service && !s.bom && !s.problems && !s.newParts) continue;
      console.log(
        `  ${s.file.padEnd(50)} ${String(s.service).padStart(4)} spare  ${String(s.bom).padStart(4)} bom  ` +
          `${String(s.newParts).padStart(3)} new  ${s.problems ? `${s.problems} to fix` : "clean"}`
      );
    }
    const untouched = summaries.filter((s) => !s.service && !s.bom && !s.problems && !s.newParts).length;
    if (untouched) console.log(`  (${untouched} workbooks still empty)`);

    const newMappings = [...mappingByKey.values()].filter(
      (m) => !existingMappings.has(`${m.model.id}|${m.component.id}|${m.mappingType}`)
    );
    console.log("");
    console.log(`Spare mappings in the sheets : ${mappingByKey.size}${duplicateMappings ? ` (${duplicateMappings} duplicate rows folded)` : ""}`);
    console.log(`  new                        : ${newMappings.length}`);
    console.log(`  already in Josh            : ${mappingByKey.size - newMappings.length}`);
    console.log(`Models gaining a spares list : ${new Set([...mappingByKey.values()].map((m) => m.model.item_code)).size}`);
    console.log("");
    const foldedBomRows = [...bomLines.values()].reduce(
      (n, b) => n + [...b.lines.values()].reduce((m, l) => m + l.foldedRows.length, 0),
      0
    );
    console.log(`Full BOMs in the sheets      : ${bomLines.size} models, ${[...bomLines.values()].reduce((n, b) => n + b.lines.size, 0)} lines`);
    if (foldedBomRows) console.log(`  repeated parts folded        : ${foldedBomRows} extra rows, quantities added up`);
    console.log(`  models with a BOM already  : ${[...bomLines.keys()].filter((c) => existingBoms.has(squash(c))).length}`);

    if (allProblems.length) {
      const tally = allProblems.reduce((acc, p) => { acc[p.reason] = (acc[p.reason] || 0) + 1; return acc; }, {});
      console.log("");
      console.log("Rows the engineers need to fix:");
      Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`   ${String(n).padStart(4)}  ${k}`));
      console.log("");
      console.log("  first few, with where to find them:");
      for (const p of allProblems.slice(0, 12)) {
        console.log(`   ${p.file} :: ${p.sheet} row ${p.row} — ${p.reason} ${p.detail ? `(${p.detail})` : ""}`);
      }
    }

    if (newParts.length) {
      console.log("");
      console.log(`Parts requested that do not exist yet: ${newParts.length}`);
      newParts.slice(0, 10).forEach((p) => console.log(`   ${p.file}: ${p.name}${p.models ? ` — for ${p.models}` : ""}`));
      console.log("  Create these in the Product Master, then re-run.");
    }

    if (deviations.length) {
      const unknown = deviations.filter((d) => !d.knownSerial);
      console.log("");
      console.log(`Job deviations listed: ${deviations.length}${unknown.length ? `, ${unknown.length} against a serial Josh does not have` : ""}`);
      console.log("  Not imported: per-unit as-built lines need a job_assets row, which these");
      console.log("  historical machines do not have. Validated here so the sheet is not wasted.");
    }

    if (!args.apply) {
      await client.query("rollback");
      console.log("");
      if (newMappings.length) {
        console.log("Sample of spare mappings to write:");
        newMappings.slice(0, 12).forEach((m) =>
          console.log(
            `   ${m.model.item_code.padEnd(14)} <- ${m.component.item_code.padEnd(12)} x${String(m.qty).padEnd(4)} ` +
              `${m.mappingType.padEnd(11)} ${m.intervalDays ? `${m.intervalDays}d` : m.intervalHours ? `${m.intervalHours}h` : ""}`
          )
        );
      }
      console.log("");
      console.log("Dry run only. Re-run with --apply to write.");
      return;
    }

    let mappingsWritten = 0;
    for (const m of mappingByKey.values()) {
      await client.query(
        `insert into product_aftermarket_mappings (
           company_id, parent_product_id, replacement_product_id, mapping_type,
           qty_per_parent, is_recommended, is_mandatory,
           service_interval_days, service_interval_hours, notes
         ) values ($1, $2, $3, $4, $5, true, $6, $7, $8, $9)
         on conflict (company_id, parent_product_id, replacement_product_id, mapping_type) do update set
           qty_per_parent         = excluded.qty_per_parent,
           is_mandatory           = excluded.is_mandatory,
           service_interval_days  = excluded.service_interval_days,
           service_interval_hours = excluded.service_interval_hours,
           notes                  = coalesce(excluded.notes, product_aftermarket_mappings.notes),
           is_active              = true,
           updated_at             = now()`,
        [
          company.id,
          m.model.id,
          m.component.id,
          m.mappingType,
          m.qty,
          m.mandatory,
          m.intervalDays,
          m.intervalHours,
          m.notes || null,
        ]
      );
      mappingsWritten += 1;
    }

    let bomsWritten = 0;
    let linesWritten = 0;
    let linesOrphaned = 0;
    for (const [modelCode, { model, lines: lineMap }] of bomLines) {
      const lines = [...lineMap.values()];
      const bomCode = `BOM-${modelCode}`;
      const bomRes = await client.query(
        `insert into manufacturing_boms (company_id, bom_code, finished_good_product_id, remarks)
         values ($1, $2, $3, $4)
         on conflict (company_id, bom_code) do update set
           is_active  = true,
           updated_at = now()
         returning id`,
        [company.id, bomCode, model.id, "Imported from the engineering BOM workbooks"]
      );
      const bomId = bomRes.rows[0].id;
      bomsWritten += 1;

      const existingLineRes = await client.query(
        `select l.id, l.line_no, l.component_product_id from manufacturing_bom_lines l where l.bom_id = $1`,
        [bomId]
      );
      const byComponent = new Map(existingLineRes.rows.map((r) => [r.component_product_id, r]));
      let nextLineNo = existingLineRes.rows.reduce((max, r) => Math.max(max, r.line_no), 0) + 1;

      const inSheet = new Set(lines.map((l) => l.component.id));
      for (const line of lines) {
        const existing = byComponent.get(line.component.id);
        if (existing) {
          await client.query(
            `update manufacturing_bom_lines
                set qty_per = $2, item_code = $3, item_name = $4, uom = $5, updated_at = now()
              where id = $1`,
            [existing.id, line.qty, line.component.item_code, line.component.item_name, line.component.uom]
          );
        } else {
          await client.query(
            `insert into manufacturing_bom_lines (bom_id, line_no, component_product_id, item_code, item_name, uom, qty_per, remarks)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [bomId, nextLineNo, line.component.id, line.component.item_code, line.component.item_name, line.component.uom, line.qty, line.notes || null]
          );
          nextLineNo += 1;
        }
        linesWritten += 1;
      }

      // A component in Josh but not in the sheet is usually an unfinished sheet, not a
      // deletion, so it is counted and left alone unless pruning was asked for.
      for (const [componentId, row] of byComponent) {
        if (inSheet.has(componentId)) continue;
        linesOrphaned += 1;
        if (args.prune) {
          await client.query(`delete from manufacturing_bom_lines where id = $1`, [row.id]);
        }
      }
    }

    await client.query("commit");
    console.log("");
    console.log(`Applied: ${mappingsWritten} spare mappings, ${bomsWritten} BOMs, ${linesWritten} BOM lines.`);
    if (linesOrphaned) {
      console.log(
        args.prune
          ? `Pruned ${linesOrphaned} BOM lines the sheets no longer mention.`
          : `${linesOrphaned} BOM lines in Josh are not in the sheets. Left alone; use --prune to remove them.`
      );
    }
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { qty, interval, readGrid, readWorkbook, foldBomLines, SERVICE_LEAD, FULL_LEAD };
