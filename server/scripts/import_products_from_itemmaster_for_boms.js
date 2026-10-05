const fs = require("fs");
const path = require("path");

require("dotenv").config();

const { pool } = require("../src/db/pool");
const { saveProduct } = require("../src/services/productMaster");

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function parseArgs(argv) {
  const out = {
    bomFolder: path.resolve(process.cwd()),
    itemMasterFile: "",
    bomPattern: "^N\\d+\\.csv$",
    apply: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      out.apply = true;
      continue;
    }
    if (token.startsWith("--bom-folder=")) {
      out.bomFolder = path.resolve(token.slice("--bom-folder=".length));
      continue;
    }
    if (token === "--bom-folder" && argv[i + 1]) {
      out.bomFolder = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith("--itemmaster=")) {
      out.itemMasterFile = path.resolve(token.slice("--itemmaster=".length));
      continue;
    }
    if (token === "--itemmaster" && argv[i + 1]) {
      out.itemMasterFile = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith("--bom-pattern=")) {
      out.bomPattern = token.slice("--bom-pattern=".length).trim() || out.bomPattern;
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

function readCsvObjects(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return rowsToObjects(parseCsv(text));
}

function collectBomItemCodes(folder, patternText) {
  const regex = new RegExp(patternText, "i");
  const files = fs.readdirSync(folder).filter((name) => regex.test(name));
  const set = new Set();

  for (const name of files) {
    const fullPath = path.join(folder, name);
    const rows = readCsvObjects(fullPath);
    for (const row of rows) {
      const code = normalizeKey(row.ItemCode);
      if (code) set.add(code);
    }
  }

  return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
}

function buildItemMasterMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = normalizeKey(row["Item Code"] || row.ItemCode);
    if (!key) continue;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

async function getExistingProductKeys(client, keys) {
  if (!keys.length) return new Set();
  const res = await client.query(
    `
      select item_code
      from products
      where upper(replace(trim(item_code), ' ', '')) = any($1::text[])
    `,
    [keys]
  );
  return new Set(res.rows.map((r) => normalizeKey(r.item_code)));
}

function asYesNo(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  if (["YES", "Y", "TRUE", "1"].includes(raw)) return true;
  if (["NO", "N", "FALSE", "0"].includes(raw)) return false;
  return null;
}

function buildProductPayload(itemRow) {
  return {
    Category: itemRow.Category,
    Group: itemRow.Group,
    Brand: itemRow.Brand,
    ItemCode: itemRow["Item Code"] || itemRow.ItemCode,
    ItemName: itemRow["Item Name"] || itemRow.ItemName,
    HSNNO: itemRow["HSN NO"],
    UOM: itemRow.UOM,
    ListPrice: itemRow["List Price"],
    GSTPer: itemRow.GSTPer,
    Active: itemRow.Active,
    SerialNoRequired: asYesNo(itemRow.IsSerialNo) ?? false,
    ItemType: itemRow["Item Type"],
    Description: itemRow.ItemDescription,
    LastPurchasePrice: itemRow.LPP,
    VariancePer: itemRow.VariancePer,
    IsManufactured: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.itemMasterFile) {
    console.error("Missing --itemmaster=<path-to-ItemMaster.csv>");
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(args.itemMasterFile)) {
    console.error(`ItemMaster file not found: ${args.itemMasterFile}`);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(args.bomFolder)) {
    console.error(`BOM folder not found: ${args.bomFolder}`);
    process.exitCode = 1;
    return;
  }

  const bomKeys = collectBomItemCodes(args.bomFolder, args.bomPattern);
  const itemRows = readCsvObjects(args.itemMasterFile);
  const itemMap = buildItemMasterMap(itemRows);

  const client = await pool.connect();
  try {
    await client.query("begin");

    const existingKeys = await getExistingProductKeys(client, bomKeys);
    const missingKeys = bomKeys.filter((k) => !existingKeys.has(k));
    const importRows = missingKeys
      .map((k) => ({ key: k, row: itemMap.get(k) || null }))
      .filter((r) => r.row);

    const stillMissing = missingKeys.filter((k) => !itemMap.has(k));

    if (!args.apply) {
      await client.query("rollback");
      console.log("");
      console.log("Mode: DRY RUN");
      console.log(`BOM folder: ${args.bomFolder}`);
      console.log(`ItemMaster: ${args.itemMasterFile}`);
      console.log("");
      console.log(`BOM item codes found: ${bomKeys.length}`);
      console.log(`Already in Josh: ${existingKeys.size}`);
      console.log(`Missing in Josh: ${missingKeys.length}`);
      console.log(`Found in ItemMaster for import: ${importRows.length}`);
      console.log(`Missing in ItemMaster: ${stillMissing.length}`);
      if (stillMissing.length) console.log(`First missing codes: ${stillMissing.slice(0, 40).join(",")}${stillMissing.length > 40 ? "..." : ""}`);
      console.log("");
      console.log("Dry run only. Re-run with --apply to import missing products.");
      return;
    }

    let imported = 0;
    let skipped = 0;
    for (const item of importRows) {
      const payload = buildProductPayload(item.row);
      await saveProduct(client, payload);
      imported += 1;
    }

    skipped = missingKeys.length - importRows.length;
    await client.query("commit");

    console.log("");
    console.log("Mode: APPLY");
    console.log(`Imported products: ${imported}`);
    console.log(`Skipped (not found in ItemMaster): ${skipped}`);
    if (stillMissing.length) console.log(`Still missing codes: ${stillMissing.slice(0, 40).join(",")}${stillMissing.length > 40 ? "..." : ""}`);
    console.log("");
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

