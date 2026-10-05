const fs = require("fs/promises");
const path = require("path");
const ExcelJS = require("exceljs");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const REPORT_MD = path.join(ROOT_DIR, "ProductMaster_Audit_Report.md");
const REPORT_JSON = path.join(ROOT_DIR, "ProductMaster_Audit_Report.json");

const WORKBOOKS = [
  {
    companyCode: "AI",
    filePath: path.join(ROOT_DIR, "AI_ProductMaster_Fresh.xlsx"),
  },
  {
    companyCode: "AT",
    filePath: path.join(ROOT_DIR, "AT_ProductMaster_Fresh.xlsx"),
  },
];

function clean(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function normalizeHeader(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[%]/g, "pct")
    .replace(/[^a-z0-9]+/g, "");
}

function markdownTable(headers, rows) {
  const safeHeaders = headers.map((h) => String(h));
  const lines = [
    `| ${safeHeaders.join(" | ")} |`,
    `| ${safeHeaders.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row.map((cell) => String(cell ?? "")).join(" | ")} |`);
  }
  return lines.join("\n");
}

async function readWorksheetRows(filePath, sheetName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName} in ${path.basename(filePath)}`);
  }

  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = clean(cell.value);
  });

  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = {};
    let hasAny = false;
    normalizedHeaders.forEach((header, index) => {
      if (!header) return;
      const value = clean(row.getCell(index + 1).value);
      if (value !== "") hasAny = true;
      values[header] = value;
    });
    if (hasAny) rows.push(values);
  }

  return { headers, normalizedHeaders, rows };
}

function summarizeProducts(companyCode, data) {
  const duplicateCounts = new Map();
  for (const row of data.rows) {
    const itemCode = clean(row.itemcode);
    if (!itemCode) continue;
    duplicateCounts.set(itemCode, (duplicateCounts.get(itemCode) || 0) + 1);
  }

  const duplicateCodes = Array.from(duplicateCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([itemCode, count]) => ({ item_code: itemCode, count }))
    .sort((a, b) => a.item_code.localeCompare(b.item_code));

  const metrics = {
    company: companyCode,
    total_rows: data.rows.length,
    missing_item_type: 0,
    missing_hsn_no: 0,
    missing_gst_pct: 0,
    missing_category: 0,
    missing_group: 0,
    missing_uom: 0,
    inactive_rows: 0,
    duplicate_item_codes: duplicateCodes.length,
  };

  const samples = {
    missing_item_type: [],
    missing_hsn_no: [],
    missing_gst_pct: [],
    missing_category: [],
    missing_group: [],
    missing_uom: [],
    duplicate_item_codes: duplicateCodes.slice(0, 20),
  };

  for (const row of data.rows) {
    const itemCode = clean(row.itemcode);
    const itemName = clean(row.itemname);
    const active = clean(row.active).toLowerCase();
    if (!clean(row.itemtype)) {
      metrics.missing_item_type += 1;
      if (samples.missing_item_type.length < 20) samples.missing_item_type.push({ item_code: itemCode, item_name: itemName });
    }
    if (!clean(row.hsnno)) {
      metrics.missing_hsn_no += 1;
      if (samples.missing_hsn_no.length < 20) samples.missing_hsn_no.push({ item_code: itemCode, item_name: itemName });
    }
    if (!clean(row.gstpct)) {
      metrics.missing_gst_pct += 1;
      if (samples.missing_gst_pct.length < 20) samples.missing_gst_pct.push({ item_code: itemCode, item_name: itemName });
    }
    if (!clean(row.category)) {
      metrics.missing_category += 1;
      if (samples.missing_category.length < 20) samples.missing_category.push({ item_code: itemCode, item_name: itemName });
    }
    if (!clean(row.group)) {
      metrics.missing_group += 1;
      if (samples.missing_group.length < 20) samples.missing_group.push({ item_code: itemCode, item_name: itemName });
    }
    if (!clean(row.unit)) {
      metrics.missing_uom += 1;
      if (samples.missing_uom.length < 20) samples.missing_uom.push({ item_code: itemCode, item_name: itemName });
    }
    if (active === "no" || active === "false" || active === "0") {
      metrics.inactive_rows += 1;
    }
  }

  return { metrics, samples, headers: data.headers };
}

function summarizeCompanyPolicies(companyCode, data) {
  const keyCounts = new Map();
  for (const row of data.rows) {
    const key = `${clean(row.company)}::${clean(row.itemcode)}`;
    if (!clean(row.company) || !clean(row.itemcode)) continue;
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }

  const duplicateRows = Array.from(keyCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([compound, count]) => {
      const [company, itemCode] = compound.split("::");
      return { company, item_code: itemCode, count };
    })
    .sort((a, b) => a.item_code.localeCompare(b.item_code));

  const metrics = {
    company: companyCode,
    total_rows: data.rows.length,
    missing_company: 0,
    missing_item_code: 0,
    blank_sourcing_mode: 0,
    blank_manufactured_flag: 0,
    duplicate_company_item_rows: duplicateRows.length,
  };

  const samples = {
    blank_sourcing_mode: [],
    blank_manufactured_flag: [],
    duplicate_company_item_rows: duplicateRows.slice(0, 20),
  };

  for (const row of data.rows) {
    const company = clean(row.company);
    const itemCode = clean(row.itemcode);
    if (!company) metrics.missing_company += 1;
    if (!itemCode) metrics.missing_item_code += 1;
    if (!clean(row.sourcingmode)) {
      metrics.blank_sourcing_mode += 1;
      if (samples.blank_sourcing_mode.length < 20) samples.blank_sourcing_mode.push({ company, item_code: itemCode });
    }
    if (!clean(row.manufacturedinthiscompany)) {
      metrics.blank_manufactured_flag += 1;
      if (samples.blank_manufactured_flag.length < 20) samples.blank_manufactured_flag.push({ company, item_code: itemCode });
    }
  }

  return { metrics, samples, headers: data.headers };
}

function buildMarkdownReport(results) {
  const productHeaderRows = results.map((item) => [item.company, item.products.headers.length, item.products.headers.join(", ")]);
  const policyHeaderRows = results.map((item) => [item.company, item.companyPolicies.headers.length, item.companyPolicies.headers.join(", ")]);
  const productMetricRows = results.map((item) => [
    item.company,
    item.products.metrics.total_rows,
    item.products.metrics.missing_item_type,
    item.products.metrics.missing_hsn_no,
    item.products.metrics.missing_gst_pct,
    item.products.metrics.missing_category,
    item.products.metrics.missing_group,
    item.products.metrics.missing_uom,
    item.products.metrics.duplicate_item_codes,
    item.products.metrics.inactive_rows,
  ]);
  const policyMetricRows = results.map((item) => [
    item.company,
    item.companyPolicies.metrics.total_rows,
    item.companyPolicies.metrics.blank_sourcing_mode,
    item.companyPolicies.metrics.blank_manufactured_flag,
    item.companyPolicies.metrics.duplicate_company_item_rows,
  ]);

  const lines = [];
  lines.push("# Product Master Audit Report");
  lines.push("");
  lines.push("Audit compares the freshly generated Josh-format company workbooks and highlights fill-before-import gaps.");
  lines.push("");
  lines.push("## Header Cadence");
  lines.push("");
  lines.push("### Products");
  lines.push("");
  lines.push(markdownTable(["Company", "Column Count", "Headers"], productHeaderRows));
  lines.push("");
  lines.push("### Company Policies");
  lines.push("");
  lines.push(markdownTable(["Company", "Column Count", "Headers"], policyHeaderRows));
  lines.push("");
  lines.push("## Product Gaps");
  lines.push("");
  lines.push(
    markdownTable(
      ["Company", "Rows", "Missing Item Type", "Missing HSN", "Missing GST", "Missing Category", "Missing Group", "Missing Unit", "Duplicate Item Codes", "Inactive Rows"],
      productMetricRows
    )
  );
  lines.push("");
  lines.push("## Company Policy Gaps");
  lines.push("");
  lines.push(
    markdownTable(
      ["Company", "Rows", "Blank Sourcing Mode", "Blank Manufactured Flag", "Duplicate Company + Item Code"],
      policyMetricRows
    )
  );
  lines.push("");

  for (const item of results) {
    lines.push(`## ${item.company} Samples`);
    lines.push("");
    const productSamples = item.products.samples;
    const policySamples = item.companyPolicies.samples;

    const sampleSections = [
      ["Missing Item Type", productSamples.missing_item_type, ["Item Code", "Item Name"], (row) => [row.item_code, row.item_name]],
      ["Missing HSN", productSamples.missing_hsn_no, ["Item Code", "Item Name"], (row) => [row.item_code, row.item_name]],
      ["Missing GST", productSamples.missing_gst_pct, ["Item Code", "Item Name"], (row) => [row.item_code, row.item_name]],
      ["Missing Category", productSamples.missing_category, ["Item Code", "Item Name"], (row) => [row.item_code, row.item_name]],
      ["Missing Group", productSamples.missing_group, ["Item Code", "Item Name"], (row) => [row.item_code, row.item_name]],
      ["Duplicate Item Codes", productSamples.duplicate_item_codes, ["Item Code", "Count"], (row) => [row.item_code, row.count]],
      ["Blank Sourcing Mode", policySamples.blank_sourcing_mode, ["Company", "Item Code"], (row) => [row.company, row.item_code]],
      ["Blank Manufactured Flag", policySamples.blank_manufactured_flag, ["Company", "Item Code"], (row) => [row.company, row.item_code]],
      ["Duplicate Company + Item Code", policySamples.duplicate_company_item_rows, ["Company", "Item Code", "Count"], (row) => [row.company, row.item_code, row.count]],
    ];

    for (const [title, sampleRows, headers, mapRow] of sampleSections) {
      lines.push(`### ${title}`);
      lines.push("");
      if (!sampleRows.length) {
        lines.push("No rows found.");
      } else {
        lines.push(markdownTable(headers, sampleRows.map(mapRow)));
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function main() {
  const results = [];
  for (const workbook of WORKBOOKS) {
    const products = await readWorksheetRows(workbook.filePath, "Products");
    const companyPolicies = await readWorksheetRows(workbook.filePath, "Company Policies");
    results.push({
      company: workbook.companyCode,
      file: path.basename(workbook.filePath),
      products: summarizeProducts(workbook.companyCode, products),
      companyPolicies: summarizeCompanyPolicies(workbook.companyCode, companyPolicies),
    });
  }

  const markdown = buildMarkdownReport(results);
  await fs.writeFile(REPORT_MD, markdown, "utf8");
  await fs.writeFile(REPORT_JSON, JSON.stringify(results, null, 2), "utf8");
  process.stdout.write(`Audit report written to ${path.basename(REPORT_MD)} and ${path.basename(REPORT_JSON)}.\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
