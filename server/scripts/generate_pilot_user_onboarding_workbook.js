const path = require("path");
const ExcelJS = require("exceljs");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const OUTPUT_FILE = path.join(ROOT_DIR, "Pilot_User_Onboarding.xlsx");

const DESK_ROWS = [
  { desk: "Sales", suggested_department: "sales", suggested_role: "Sales Executive", suggested_workspace: "sales", superadmin_recommended: "No" },
  { desk: "Marketing", suggested_department: "marketing", suggested_role: "Marketing", suggested_workspace: "marketing", superadmin_recommended: "No" },
  { desk: "Purchase", suggested_department: "purchase", suggested_role: "Purchase", suggested_workspace: "procurement", superadmin_recommended: "No" },
  { desk: "Manufacturing", suggested_department: "manufacturing", suggested_role: "Production Planner", suggested_workspace: "operations", superadmin_recommended: "No" },
  { desk: "Stores", suggested_department: "stores", suggested_role: "Stores", suggested_workspace: "operations", superadmin_recommended: "No" },
  { desk: "Accounts", suggested_department: "accounts", suggested_role: "Accounts", suggested_workspace: "finance", superadmin_recommended: "No" },
  { desk: "Dispatch", suggested_department: "dispatch", suggested_role: "Dispatch", suggested_workspace: "operations", superadmin_recommended: "No" },
  { desk: "Service", suggested_department: "service", suggested_role: "Service Engineer", suggested_workspace: "aftermarket", superadmin_recommended: "No" },
  { desk: "SuperAdmin", suggested_department: "management", suggested_role: "SuperAdmin", suggested_workspace: "superadmin", superadmin_recommended: "Yes - ideally project owner only" },
];

const YES_NO = ["Yes", "No"];
const ROLE_OPTIONS = [
  "SuperAdmin",
  "Sales Executive",
  "Sales Head",
  "Marketing",
  "Purchase",
  "Production Planner",
  "Factory",
  "Stores",
  "Dispatch",
  "Accounts",
  "Post Sales",
  "Service Engineer",
];
const DEPARTMENT_OPTIONS = ["sales", "marketing", "purchase", "manufacturing", "stores", "accounts", "dispatch", "service", "management"];
const COMPANY_OPTIONS = ["AT", "AI", "AT,AI"];

function styleSheet(worksheet) {
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  const header = worksheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
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
  worksheet.autoFilter = `A1:${worksheet.getColumn(worksheet.columnCount).letter}1`;
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
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "JOSH";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Pilot Users");
  sheet.columns = [
    { header: "Desk", key: "desk", width: 18 },
    { header: "Volunteer Full Name", key: "full_name", width: 28 },
    { header: "Official Email", key: "email", width: 34 },
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
    { header: "Temporary Password", key: "temporary_password", width: 22 },
    { header: "Active (Yes/No)", key: "is_active", width: 16 },
    { header: "SuperAdmin Recommended", key: "superadmin_recommended", width: 28 },
    { header: "Notes", key: "notes", width: 36 },
  ];

  sheet.addRows(
    DESK_ROWS.map((row, index) => ({
      ...row,
      full_name: "",
      email: "",
      phone: "",
      designation: index === 8 ? "Implementation owner" : "",
      employment_company: "",
      works_for_companies: "",
      primary_company: "",
      primary_manager_email: "",
      secondary_manager_email: "",
      temporary_password: "",
      is_active: "Yes",
      notes:
        row.desk === "SuperAdmin"
          ? "Prefer this row for the project owner, not a volunteer tester."
          : "Fill only if this volunteer is confirmed for pilot access.",
    }))
  );
  styleSheet(sheet);

  const lists = workbook.addWorksheet("_Lists");
  lists.state = "veryHidden";
  lists.getColumn(1).values = ["Yes/No", ...YES_NO];
  lists.getColumn(2).values = ["Roles", ...ROLE_OPTIONS];
  lists.getColumn(3).values = ["Departments", ...DEPARTMENT_OPTIONS];
  lists.getColumn(4).values = ["Companies", ...COMPANY_OPTIONS];

  addListValidation(sheet, "F", `'_Lists'!$C$2:$C$${DEPARTMENT_OPTIONS.length + 1}`, DESK_ROWS.length + 10);
  addListValidation(sheet, "G", `'_Lists'!$B$2:$B$${ROLE_OPTIONS.length + 1}`, DESK_ROWS.length + 10);
  addListValidation(sheet, "I", `'_Lists'!$D$2:$D$${COMPANY_OPTIONS.length + 1}`, DESK_ROWS.length + 10);
  addListValidation(sheet, "J", `'_Lists'!$D$2:$D$${COMPANY_OPTIONS.length + 1}`, DESK_ROWS.length + 10);
  addListValidation(sheet, "K", `'_Lists'!$D$2:$D$${COMPANY_OPTIONS.length + 1}`, DESK_ROWS.length + 10);
  addListValidation(sheet, "O", `'_Lists'!$A$2:$A$${YES_NO.length + 1}`, DESK_ROWS.length + 10);

  await workbook.xlsx.writeFile(OUTPUT_FILE);
  console.log(`Pilot onboarding workbook written to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
