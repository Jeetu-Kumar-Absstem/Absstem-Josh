const fs = require("fs");
const path = require("path");

require("dotenv").config();

const { pool } = require("../src/db/pool");

function parseArgs(argv) {
  const out = {
    folder: path.resolve(process.cwd()),
    companyCode: "AT",
    apply: false,
    pattern: "^N\\d+\\.csv$",
    fgMap: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      out.apply = true;
      continue;
    }
    if (token.startsWith("--folder=")) {
      out.folder = path.resolve(token.slice("--folder=".length));
      continue;
    }
    if (token === "--folder" && argv[i + 1]) {
      out.folder = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith("--company=")) {
      out.companyCode = token.slice("--company=".length).trim() || out.companyCode;
      continue;
    }
    if (token === "--company" && argv[i + 1]) {
      out.companyCode = argv[i + 1].trim() || out.companyCode;
      i += 1;
      continue;
    }
    if (token.startsWith("--pattern=")) {
      out.pattern = token.slice("--pattern=".length).trim() || out.pattern;
      continue;
    }
    if (token.startsWith("--map=")) {
      const raw = token.slice("--map=".length).trim();
      const parts = raw.split("=");
      const left = normalizeItemCode(parts[0] || "");
      const right = normalizeItemCode(parts.slice(1).join("=") || "");
      if (left && right) out.fgMap[left] = right;
      continue;
    }
    if (token === "--map" && argv[i + 1]) {
      const raw = String(argv[i + 1] || "").trim();
      const parts = raw.split("=");
      const left = normalizeItemCode(parts[0] || "");
      const right = normalizeItemCode(parts.slice(1).join("=") || "");
      if (left && right) out.fgMap[left] = right;
      i += 1;
      continue;
    }
  }

  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || (row.length === 1 && row[0].trim().length)) rows.push(row);
      row = [];
      continue;
    }

    if (ch === "\r") continue;
    field += ch;
  }

  row.push(field);
  if (row.length > 1 || (row.length === 1 && row[0].trim().length)) rows.push(row);
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h || "").replace(/^\uFEFF/, "").trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = String(r[i] || "").trim();
    return obj;
  });
}

function normalizeItemCode(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function normalizeUom(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.toUpperCase();
}

function parseQty(value) {
  const raw = String(value || "").replace(/,/g, "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function guessJobNo(rows, fileBase) {
  for (const row of rows) {
    const job = String(row.JobNo || "").trim();
    if (job) return job;
  }
  return fileBase;
}

function normalizeDispatch(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  return ["yes", "y", "true", "1"].includes(raw);
}

async function resolveCompanyId(client, companyCode) {
  const res = await client.query(`select id, company_code from companies where company_code = $1 limit 1`, [companyCode]);
  return res.rows[0] || null;
}

async function getProductMapByItemCodes(client, itemCodes) {
  if (!itemCodes.length) return new Map();
  const res = await client.query(
    `
      select id, item_code, item_name, uom, is_manufactured, mfg_job_prefix
      from products
      where trim(item_code) = any($1::text[])
    `,
    [itemCodes]
  );
  const map = new Map();
  for (const row of res.rows) map.set(normalizeItemCode(row.item_code), row);
  return map;
}

async function upsertBom(client, companyId, bomCode, finishedGoodProductId, remarks) {
  const existing = await client.query(
    `select id from manufacturing_boms where company_id = $1 and bom_code = $2 limit 1`,
    [companyId, bomCode]
  );
  if (existing.rows.length) {
    const id = existing.rows[0].id;
    await client.query(
      `
        update manufacturing_boms
        set finished_good_product_id = $2,
            is_active = true,
            remarks = $3,
            updated_at = now()
        where id = $1
      `,
      [id, finishedGoodProductId, remarks || null]
    );
    return { id, created: false };
  }

  const insertRes = await client.query(
    `
      insert into manufacturing_boms (
        company_id,
        bom_code,
        finished_good_product_id,
        revision_no,
        is_active,
        remarks,
        created_by
      )
      values ($1,$2,$3,1,true,$4,null)
      returning id
    `,
    [companyId, bomCode, finishedGoodProductId, remarks || null]
  );
  return { id: insertRes.rows[0].id, created: true };
}

async function replaceBomLines(client, bomId, componentLines) {
  await client.query(`delete from manufacturing_bom_lines where bom_id = $1`, [bomId]);
  let lineNo = 1;
  for (const line of componentLines) {
    await client.query(
      `
        insert into manufacturing_bom_lines (
          bom_id,
          line_no,
          component_product_id,
          item_code,
          item_name,
          uom,
          qty_per,
          remarks
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [bomId, lineNo, line.component_product_id, line.item_code, line.item_name, line.uom, line.qty_per, line.remarks || null]
    );
    lineNo += 1;
  }
}

function foldComponentLines(rawLines, productByCode) {
  const folded = new Map();

  for (const line of rawLines) {
    const code = normalizeItemCode(line.ItemCode);
    if (!code) continue;
    const qty = parseQty(line.Quantity);
    if (qty === null || qty <= 0) continue;
    const product = productByCode.get(code);
    if (!product) continue;

    const existing = folded.get(product.id) || {
      component_product_id: product.id,
      item_code: product.item_code,
      item_name: product.item_name,
      uom: product.uom,
      qty_per: 0,
      remarks: "",
    };

    existing.qty_per = Math.round((existing.qty_per + qty) * 10000) / 10000;
    const nextRemark = String(line.Remarks || "").trim();
    const dispatch = normalizeDispatch(line.Dispatch);
    const uom = normalizeUom(line.UOM);
    const extras = [
      uom ? `UOM:${uom}` : null,
      dispatch ? "DISPATCH:YES" : null,
      nextRemark ? `NOTE:${nextRemark}` : null,
    ].filter(Boolean);
    const extraText = extras.join(" | ");
    if (extraText) {
      const merged = existing.remarks ? `${existing.remarks}\n${extraText}` : extraText;
      existing.remarks = merged.length > 2000 ? merged.slice(0, 2000) : merged;
    }

    folded.set(product.id, existing);
  }

  return Array.from(folded.values()).sort((a, b) => String(a.item_code || "").localeCompare(String(b.item_code || "")));
}

async function processBomFile(client, { companyId, filePath, apply, fgMap }) {
  const text = fs.readFileSync(filePath, "utf8");
  const rows = rowsToObjects(parseCsv(text));
  const base = path.basename(filePath, path.extname(filePath)).trim();
  const jobNo = normalizeItemCode(guessJobNo(rows, base));
  const fgItemCode = normalizeItemCode(fgMap?.[jobNo] || fgMap?.[normalizeItemCode(base)] || "");
  if (!fgItemCode) {
    return { file: path.basename(filePath), jobNo, ok: false, error: `FG_MAPPING_REQUIRED:${jobNo}` };
  }

  const componentCodes = Array.from(
    new Set(
      rows
        .map((r) => normalizeItemCode(r.ItemCode))
        .filter((code) => code.length)
    )
  );

  const fgLookup = await getProductMapByItemCodes(client, [fgItemCode]);
  const fg = fgLookup.get(fgItemCode) || null;

  if (!fg) {
    return { file: path.basename(filePath), jobNo, ok: false, error: `FG_NOT_FOUND:${fgItemCode}` };
  }
  if (!fg.is_manufactured) {
    return { file: path.basename(filePath), jobNo, ok: false, error: `FG_NOT_MANUFACTURED:${fgItemCode}` };
  }
  if (!fg.mfg_job_prefix) {
    return { file: path.basename(filePath), jobNo, ok: false, error: `FG_PREFIX_MISSING:${fgItemCode}` };
  }

  const componentMap = await getProductMapByItemCodes(client, componentCodes);
  const missingComponents = componentCodes.filter((code) => !componentMap.has(code));
  if (missingComponents.length) {
    return {
      file: path.basename(filePath),
      jobNo,
      ok: false,
      error: `MISSING_COMPONENTS:${missingComponents.slice(0, 30).join(",")}${missingComponents.length > 30 ? "..." : ""}`,
      missingCount: missingComponents.length,
    };
  }

  const foldedLines = foldComponentLines(rows, componentMap);
  if (!foldedLines.length) {
    return { file: path.basename(filePath), jobNo, ok: false, error: "NO_VALID_LINES" };
  }

  const dates = rows.map((r) => String(r.Date || "").trim()).filter(Boolean);
  const sampleDate = dates.length ? dates[0] : "";
  const project = rows.map((r) => String(r.Project || "").trim()).find((v) => v.length) || "";
  const remarksParts = [
    `Imported from ${path.basename(filePath)}`,
    sampleDate ? `Date ${sampleDate}` : null,
    jobNo ? `Job ${jobNo}` : null,
    project ? `Project ${project}` : null,
  ].filter(Boolean);
  const remarks = remarksParts.join(" | ");

  if (!apply) {
    return {
      file: path.basename(filePath),
      jobNo,
      fgItemCode,
      ok: true,
      dryRun: true,
      fg: { item_code: fg.item_code, item_name: fg.item_name },
      lineCount: foldedLines.length,
    };
  }

  const bomCode = fgItemCode;
  const upsert = await upsertBom(client, companyId, bomCode, fg.id, remarks);
  await replaceBomLines(client, upsert.id, foldedLines);

  return {
    file: path.basename(filePath),
    jobNo,
    fgItemCode,
    ok: true,
    dryRun: false,
    created: upsert.created,
    bomId: upsert.id,
    bomCode,
    fg: { item_code: fg.item_code, item_name: fg.item_name },
    lineCount: foldedLines.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const regex = new RegExp(args.pattern, "i");

  const files = fs
    .readdirSync(args.folder)
    .filter((name) => regex.test(name))
    .map((name) => path.join(args.folder, name))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    console.error(`No BOM CSVs matched in ${args.folder} using pattern ${args.pattern}`);
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const company = await resolveCompanyId(client, args.companyCode);
    if (!company) {
      await client.query("rollback");
      console.error(`Company not found: ${args.companyCode}`);
      process.exitCode = 1;
      return;
    }

    const results = [];
    for (const filePath of files) {
      const result = await processBomFile(client, { companyId: company.id, filePath, apply: args.apply, fgMap: args.fgMap });
      results.push(result);
      if (!result.ok) {
        await client.query("rollback");
        console.error(`Failed on ${result.file}: ${result.error}`);
        process.exitCode = 1;
        return;
      }
    }

    if (args.apply) await client.query("commit");
    else await client.query("rollback");

    console.log("");
    console.log(`Mode: ${args.apply ? "APPLY" : "DRY RUN"}`);
    console.log(`Company: ${args.companyCode}`);
    console.log(`Folder: ${args.folder}`);
    console.log("");
    for (const row of results) {
      console.log(`${row.file} -> Job ${row.jobNo} -> FG ${row.fg?.item_code || row.fgItemCode || "?"} | lines ${row.lineCount}`);
    }
    console.log("");
    if (!args.apply) {
      console.log("Dry run only. Re-run with --apply to create/update BOM masters.");
    }
  } catch (err) {
    await client.query("rollback");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
