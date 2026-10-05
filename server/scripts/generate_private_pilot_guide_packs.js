const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const WORKBOOK_FILE = path.join(ROOT_DIR, "Pilot_User_Onboarding_Google_SSO.xlsx");
const SOURCE_DIR = path.join(ROOT_DIR, "Suggestions", "Process_Guides");
const OUTPUT_ROOT = path.join(ROOT_DIR, "Suggestions", "Pilot_User_Private_Guide_Packs");
const MANIFEST_FILE = path.join(OUTPUT_ROOT, "_share_manifest.json");
const INDEX_FILE = path.join(OUTPUT_ROOT, "_share_manifest.csv");

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function slugify(value) {
  return normalizeText(value)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readWorkbookRows(worksheet) {
  const rows = [];
  const headerRow = worksheet.getRow(1);
  const headers = [];
  headerRow.eachCell((cell, colNumber) => {
    headers[colNumber] = normalizeText(cell.value);
  });
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const record = {};
    let hasValue = false;
    for (let colNumber = 1; colNumber <= headerRow.cellCount; colNumber += 1) {
      const header = headers[colNumber];
      if (!header) continue;
      const value = row.getCell(colNumber).text || row.getCell(colNumber).value || "";
      record[header] = normalizeText(value);
      if (record[header]) hasValue = true;
    }
    if (hasValue) rows.push(record);
  }
  return rows;
}

function buildPilotRecords(rows) {
  return rows
    .filter((row) => normalizeText(row["Volunteer Full Name"]) && normalizeText(row["Desk"]))
    .map((row) => {
      const fullName = normalizeText(row["Volunteer Full Name"]);
      const deskLabel = normalizeText(row["Desk"]);
      const folderName = `${slugify(deskLabel)}__${slugify(fullName)}__Private_Guide_Pack`;
      const mdFile = `${slugify(deskLabel)}__${slugify(fullName)}__Josh_Process_Guide.md`;
      const rtfFile = `${slugify(deskLabel)}__${slugify(fullName)}__Josh_Process_Guide.rtf`;
      const recipients = [
        normalizeEmail(row["Google SSO Email"] || row["Official Email"]),
        normalizeEmail(row["Primary Manager Email"]),
        normalizeEmail(row["Secondary Manager Email"]),
      ].filter(Boolean);
      return {
        fullName,
        deskLabel,
        folderName,
        mdFile,
        rtfFile,
        loginEmail: normalizeEmail(row["Google SSO Email"] || row["Official Email"]),
        officialEmail: normalizeEmail(row["Official Email"]),
        primaryManagerEmail: normalizeEmail(row["Primary Manager Email"]),
        secondaryManagerEmail: normalizeEmail(row["Secondary Manager Email"]),
        recipients: Array.from(new Set(recipients)),
      };
    });
}

function ensureCleanDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeCsv(records) {
  const lines = [
    "full_name,desk,folder_name,login_email,primary_manager_email,secondary_manager_email,recipient_count",
  ];
  records.forEach((record) => {
    lines.push(
      [
        record.fullName,
        record.deskLabel,
        record.folderName,
        record.loginEmail,
        record.primaryManagerEmail,
        record.secondaryManagerEmail,
        String(record.recipients.length),
      ]
        .map((value) => `"${String(value || "").replace(/"/g, '""')}"`)
        .join(",")
    );
  });
  fs.writeFileSync(INDEX_FILE, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(WORKBOOK_FILE);
  const worksheet = workbook.worksheets[0];
  const rows = readWorkbookRows(worksheet);
  const records = buildPilotRecords(rows);

  ensureCleanDirectory(OUTPUT_ROOT);

  records.forEach((record) => {
    const packDir = path.join(OUTPUT_ROOT, record.folderName);
    ensureCleanDirectory(packDir);

    const sourceMd = path.join(SOURCE_DIR, record.mdFile);
    const sourceRtf = path.join(SOURCE_DIR, record.rtfFile);
    const targetMd = path.join(packDir, record.mdFile);
    const targetRtf = path.join(packDir, record.rtfFile);

    if (!fs.existsSync(sourceMd)) {
      throw new Error(`Missing Markdown guide: ${sourceMd}`);
    }
    if (!fs.existsSync(sourceRtf)) {
      throw new Error(`Missing RTF guide: ${sourceRtf}`);
    }

    fs.copyFileSync(sourceMd, targetMd);
    fs.copyFileSync(sourceRtf, targetRtf);
  });

  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  writeCsv(records);

  console.log(`Private pilot guide packs written to ${OUTPUT_ROOT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
