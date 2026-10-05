const path = require("path");
const ExcelJS = require("exceljs");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const MAX_ATTRIBUTE_COLUMNS = 20;
const COMPANY_WORKBOOKS = [
  {
    companyCode: "AT",
    sourceFile: path.join(ROOT_DIR, "Item Master AT.xlsx"),
    freshOutputFile: path.join(ROOT_DIR, "AT_ProductMaster_Fresh.xlsx"),
    blankOutputFile: path.join(ROOT_DIR, "AT_ProductMaster_Blank_Guided.xlsx"),
  },
  {
    companyCode: "AI",
    sourceFile: path.join(ROOT_DIR, "Item Master AI.xlsx"),
    freshOutputFile: path.join(ROOT_DIR, "AI_ProductMaster_Fresh.xlsx"),
    blankOutputFile: path.join(ROOT_DIR, "AI_ProductMaster_Blank_Guided.xlsx"),
  },
];

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[%]/g, "pct")
    .replace(/[^a-z0-9]+/g, "");
}

function cleanCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function boolLikeLabel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (["yes", "y", "true", "1"].includes(raw)) return "Yes";
  if (["no", "n", "false", "0"].includes(raw)) return "No";
  return String(value).trim();
}

function styleSheet(worksheet) {
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF234A8F" } };
  worksheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = `A1:${excelColumnName(worksheet.columnCount)}1`;
}

function excelColumnName(index) {
  let n = Number(index) || 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || "A";
}

function buildUnifiedColumns() {
  const columns = [
    { header: "Company", key: "company", width: 22 },
    { header: "Item Code", key: "item_code", width: 18 },
    { header: "Item Name", key: "item_name", width: 30 },
    { header: "Category", key: "category", width: 22 },
    { header: "Group", key: "group", width: 22 },
    { header: "Unit", key: "uom", width: 12 },
    { header: "HSN No", key: "hsn_no", width: 16 },
    { header: "GST %", key: "gst_pct", width: 12 },
    { header: "List Price", key: "list_price", width: 14 },
    { header: "Active", key: "active", width: 12 },
    { header: "Serial No Required", key: "serial_no_required", width: 18 },
    { header: "Auto Generated", key: "auto_generated", width: 16 },
    { header: "Brand", key: "brand", width: 18 },
    { header: "Item Type", key: "item_type", width: 16 },
    { header: "Description", key: "description", width: 38 },
    { header: "Sourcing Mode", key: "sourcing_mode", width: 22 },
    { header: "Manufactured In This Company", key: "is_manufactured", width: 24 },
    { header: "Manufacturing Prefix", key: "mfg_job_prefix", width: 24 },
    { header: "Source Company", key: "intercompany_source_company", width: 28 },
    { header: "Preferred Vendor", key: "preferred_vendor", width: 28 },
    { header: "Saleable", key: "is_saleable", width: 14 },
    { header: "Purchaseable", key: "is_purchaseable", width: 16 },
    { header: "Stocked", key: "is_stocked", width: 14 },
    { header: "Notes", key: "remarks", width: 36 },
  ];
  for (let i = 1; i <= MAX_ATTRIBUTE_COLUMNS; i += 1) {
    columns.push({ header: `Caption ${i}`, key: `caption_${i}`, width: 24 });
    columns.push({ header: `Description ${i}`, key: `description_${i}`, width: 28 });
  }
  return columns;
}

function firstMappedValue(record, keys) {
  for (const key of keys) {
    const normalized = normalizeHeader(key);
    if (record.has(normalized)) {
      const value = record.get(normalized);
      if (cleanCell(value) !== "") return cleanCell(value);
    }
  }
  return "";
}

async function readSourceRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const headerIndex = new Map();
  headerRow.eachCell((cell, colNumber) => {
    headerIndex.set(colNumber, normalizeHeader(cell.value));
  });

  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const record = new Map();
    let hasAny = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headerIndex.get(colNumber);
      if (!header) return;
      const value = cleanCell(cell.value);
      if (value !== "") hasAny = true;
      record.set(header, value);
    });
    if (hasAny) rows.push(record);
  }
  return rows;
}

function mapSourceToProductRows(sourceRows) {
  const productRows = [];
  for (const record of sourceRows) {
    const itemCode = firstMappedValue(record, ["Item Code", "ItemCode", "item_code"]);
    if (!itemCode) continue;
    const row = {
      item_code: itemCode,
      item_name: firstMappedValue(record, ["Item Name", "ItemName"]) || itemCode,
      category: firstMappedValue(record, ["Category"]),
      group: firstMappedValue(record, ["Group"]),
      uom: firstMappedValue(record, ["UOM", "Unit"]),
      hsn_no: firstMappedValue(record, ["HSN NO", "HSN No", "HSNNO"]),
      gst_pct: firstMappedValue(record, ["GSTPer", "GST %", "GSTPct"]),
      list_price: firstMappedValue(record, ["List Price", "ListPrice"]),
      active: boolLikeLabel(firstMappedValue(record, ["Active"])),
      serial_no_required: boolLikeLabel(firstMappedValue(record, ["IsSerialNo", "Serial No Required"])),
      auto_generated: "No",
      brand: firstMappedValue(record, ["Brand"]),
      item_type: "",
      description: firstMappedValue(record, ["ItemDescription", "Description"]),
    };
    for (let i = 1; i <= MAX_ATTRIBUTE_COLUMNS; i += 1) {
      row[`caption_${i}`] = firstMappedValue(record, [`Caption${i}`, `Caption ${i}`]);
      row[`description_${i}`] = firstMappedValue(record, [`Specification${i}`, `Specification ${i}`, `Description${i}`, `Description ${i}`]);
    }
    productRows.push(row);
  }
  return productRows;
}

function buildCompanyPolicyRows(productRows, companyCode) {
  return productRows.map((row) => ({
    company: companyCode,
    item_code: row.item_code,
    sourcing_mode: "",
    is_manufactured: "",
    mfg_job_prefix: "",
    intercompany_source_company: "",
    preferred_vendor: "",
    is_saleable: "Yes",
    is_purchaseable: "Yes",
    is_stocked: "Yes",
    remarks: "",
  }));
}

function buildUnifiedRows(productRows, companyPolicyRows) {
  const policyByCode = new Map(companyPolicyRows.map((row) => [row.item_code, row]));
  return productRows.map((row) => {
    const policy = policyByCode.get(row.item_code) || {};
    return {
      company: policy.company || "",
      item_code: row.item_code,
      item_name: row.item_name,
      category: row.category,
      group: row.group,
      uom: row.uom,
      hsn_no: row.hsn_no,
      gst_pct: row.gst_pct,
      list_price: row.list_price,
      active: row.active,
      serial_no_required: row.serial_no_required,
      auto_generated: row.auto_generated,
      brand: row.brand,
      item_type: row.item_type,
      description: row.description,
      sourcing_mode: policy.sourcing_mode || "",
      is_manufactured: policy.is_manufactured || "",
      mfg_job_prefix: policy.mfg_job_prefix || "",
      intercompany_source_company: policy.intercompany_source_company || "",
      preferred_vendor: policy.preferred_vendor || "",
      is_saleable: policy.is_saleable || "",
      is_purchaseable: policy.is_purchaseable || "",
      is_stocked: policy.is_stocked || "",
      remarks: policy.remarks || "",
      ...Object.fromEntries(
        Array.from({ length: MAX_ATTRIBUTE_COLUMNS }, (_, index) => {
          const i = index + 1;
          return [
            [`caption_${i}`, row[`caption_${i}`] || ""],
            [`description_${i}`, row[`description_${i}`] || ""],
          ];
        }).flat()
      ),
    };
  });
}

async function writeWorkbook({ outputPath, productRows = [], companyPolicyRows = [], includeSample = false, companyCode, sourceFileName }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "JOSH";
  workbook.created = new Date();

  const instructions = workbook.addWorksheet("_Instructions");
  instructions.state = "veryHidden";
  instructions.columns = [
    { header: "Step", key: "step", width: 18 },
    { header: "Guidance", key: "guidance", width: 120 },
  ];
  instructions.addRows([
    { step: "1", guidance: "This workbook uses one visible Product Master sheet. Item Code is the frozen key for shared product definition. Company + Item Code is the frozen key for company policy." },
    { step: "2", guidance: `This offline workbook was generated from \`${sourceFileName}\` using the current Josh import cadence for ${companyCode}.` },
    { step: "3", guidance: "If the same Item Code is repeated across company rows, keep the shared product columns identical." },
    { step: "4", guidance: "Fill missing fields like Item Type and any company-policy sourcing decisions before import." },
    { step: "5", guidance: "Caption and Description columns run from 1 to 20 to match the current Josh workbook standard." },
  ]);
  styleSheet(instructions);

  const master = workbook.addWorksheet("Product Master");
  master.columns = buildUnifiedColumns();
  if (productRows.length) {
    master.addRows(buildUnifiedRows(productRows, companyPolicyRows));
  } else if (includeSample) {
    master.addRow({
      company: companyCode,
      item_code: `${companyCode}_SAMPLE_001`,
      item_name: `${companyCode} sample item`,
      category: "Nitrogen",
      group: "Machines",
      uom: "No",
      hsn_no: "84213990",
      gst_pct: "18",
      list_price: "",
      active: "Yes",
      serial_no_required: "No",
      auto_generated: "No",
      brand: "ABSSTEM",
      item_type: "",
      description: "Fill master data before import.",
      sourcing_mode: "",
      is_manufactured: "",
      mfg_job_prefix: "",
      intercompany_source_company: "",
      preferred_vendor: "",
      is_saleable: "Yes",
      is_purchaseable: "Yes",
      is_stocked: "Yes",
      remarks: "",
    });
  }
  styleSheet(master);

  await workbook.xlsx.writeFile(outputPath);
}

async function main() {
  const requestedCompanies = process.argv
    .slice(2)
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean);
  const selectedConfigs = requestedCompanies.length
    ? COMPANY_WORKBOOKS.filter((config) => requestedCompanies.includes(config.companyCode))
    : COMPANY_WORKBOOKS;

  if (!selectedConfigs.length) {
    throw new Error(`No matching company workbook config found for: ${requestedCompanies.join(", ")}`);
  }

  const results = [];
  for (const config of selectedConfigs) {
    const sourceRows = await readSourceRows(config.sourceFile);
    const productRows = mapSourceToProductRows(sourceRows);
    const companyPolicyRows = buildCompanyPolicyRows(productRows, config.companyCode);

    await writeWorkbook({
      outputPath: config.freshOutputFile,
      productRows,
      companyPolicyRows,
      includeSample: false,
      companyCode: config.companyCode,
      sourceFileName: path.basename(config.sourceFile),
    });

    await writeWorkbook({
      outputPath: config.blankOutputFile,
      productRows: [],
      companyPolicyRows: [],
      includeSample: true,
      companyCode: config.companyCode,
      sourceFileName: path.basename(config.sourceFile),
    });

    results.push(
      `${config.companyCode}: ${productRows.length} Products rows -> ${path.basename(config.freshOutputFile)}, ${path.basename(config.blankOutputFile)}`
    );
  }

  process.stdout.write(`Generated offline company workbooks:\n${results.join("\n")}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
