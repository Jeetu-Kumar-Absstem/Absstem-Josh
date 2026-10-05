const ExcelJS = require("exceljs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const SOURCE_FILE = path.join(ROOT_DIR, "Pilot_User_Onboarding.xlsx");
const OUTPUT_FILE = path.join(ROOT_DIR, "Pilot_User_Onboarding_Google_SSO.xlsx");

function styleHeader(row) {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FF1E2A3A" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF4FB" } };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD7E0ED" } },
      left: { style: "thin", color: { argb: "FFD7E0ED" } },
      bottom: { style: "thin", color: { argb: "FFD7E0ED" } },
      right: { style: "thin", color: { argb: "FFD7E0ED" } },
    };
    cell.alignment = { vertical: "middle" };
  });
}

function addListValidation(worksheet, columnLetter, formula, endRow = 100) {
  for (let row = 2; row <= endRow; row += 1) {
    worksheet.getCell(`${columnLetter}${row}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [formula],
      showErrorMessage: true,
      errorTitle: "Select from list",
      error: "Please use the dropdown values.",
    };
  }
}

async function main() {
  const srcWb = new ExcelJS.Workbook();
  await srcWb.xlsx.readFile(SOURCE_FILE);
  const srcSheet = srcWb.getWorksheet("Pilot Users") || srcWb.worksheets[0];
  if (!srcSheet) throw new Error("Pilot Users sheet not found");

  const rows = [];
  srcSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = [];
    for (let i = 1; i <= srcSheet.columnCount; i += 1) {
      values.push(row.getCell(i).value);
    }
    rows.push(values);
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "JOSH";
  wb.created = new Date();

  const ws = wb.addWorksheet("Pilot Users");
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.columns = [
    { header: "Desk", key: "desk", width: 18 },
    { header: "Volunteer Full Name", key: "full_name", width: 28 },
    { header: "Official Email", key: "email", width: 34 },
    { header: "Google SSO Email", key: "google_sso_email", width: 34 },
    { header: "Login Method", key: "login_method", width: 18 },
    { header: "SSO Ready (Yes/No)", key: "sso_ready", width: 18 },
    { header: "Mobile No", key: "phone", width: 18 },
    { header: "Designation", key: "designation", width: 22 },
    { header: "Suggested Department", key: "suggested_department", width: 22 },
    { header: "Suggested Role", key: "suggested_role", width: 22 },
    { header: "Suggested Workspace", key: "suggested_workspace", width: 18 },
    { header: "Employment Company", key: "employment_company", width: 18 },
    { header: "Works For Companies", key: "works_for_companies", width: 20 },
    { header: "Primary Company", key: "primary_company", width: 18 },
    { header: "Primary Manager Email", key: "primary_manager_email", width: 30 },
    { header: "Secondary Manager Email", key: "secondary_manager_email", width: 30 },
    { header: "Backup Password (Optional)", key: "backup_password", width: 24 },
    { header: "Active (Yes/No)", key: "is_active", width: 16 },
    { header: "SuperAdmin Recommended", key: "superadmin_recommended", width: 28 },
    { header: "Notes", key: "notes", width: 36 },
  ];
  styleHeader(ws.getRow(1));
  ws.autoFilter = `A1:${ws.getColumn(ws.columnCount).letter}1`;

  for (const row of rows) {
    const [
      desk,
      full_name,
      email,
      phone,
      designation,
      suggested_department,
      suggested_role,
      suggested_workspace,
      employment_company,
      works_for_companies,
      primary_company,
      primary_manager_email,
      secondary_manager_email,
      temporary_password,
      is_active,
      superadmin_recommended,
      notes,
    ] = row;

    ws.addRow({
      desk: desk || "",
      full_name: full_name || "",
      email: email || "",
      google_sso_email: email || "",
      login_method: "Google SSO",
      sso_ready: "Yes",
      phone: phone || "",
      designation: designation || "",
      suggested_department: suggested_department || "",
      suggested_role: suggested_role || "",
      suggested_workspace: suggested_workspace || "",
      employment_company: employment_company || "",
      works_for_companies: works_for_companies || "",
      primary_company: primary_company || "",
      primary_manager_email: primary_manager_email || "",
      secondary_manager_email: secondary_manager_email || "",
      backup_password: temporary_password || "",
      is_active: is_active || "Yes",
      superadmin_recommended: superadmin_recommended || "",
      notes: notes || "",
    });
  }

  const lists = wb.addWorksheet("_Lists");
  lists.state = "veryHidden";
  lists.getColumn(1).values = ["Yes/No", "Yes", "No"];
  lists.getColumn(2).values = ["Login Method", "Google SSO", "Local Password", "Google SSO + Backup"];

  addListValidation(ws, "E", "'_Lists'!$B$2:$B$4", rows.length + 20);
  addListValidation(ws, "F", "'_Lists'!$A$2:$A$3", rows.length + 20);
  addListValidation(ws, "R", "'_Lists'!$A$2:$A$3", rows.length + 20);

  await wb.xlsx.writeFile(OUTPUT_FILE);
  console.log(`Created ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
