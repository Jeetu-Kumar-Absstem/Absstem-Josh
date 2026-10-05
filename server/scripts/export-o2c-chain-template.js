#!/usr/bin/env node
/**
 * Generate Absstem O2C chain fill template (single workbook).
 *
 * One row on Chain = one commercial machine chain:
 *   SO → Dispatch → Tax Invoice + Job/Serial
 *
 *   node scripts/export-o2c-chain-template.js
 *   node scripts/export-o2c-chain-template.js --out=storage/AI-O2C-Chain-TEMPLATE.xlsx
 *
 * Importer for this workbook is NOT wired yet — this ships the fill contract first.
 */
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

function parseArgs(argv) {
  const out = {
    out: path.resolve(
      __dirname,
      "../storage",
      `AI-O2C-Chain-TEMPLATE-${new Date().toISOString().slice(0, 10)}.xlsx`
    ),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--out=")) out.out = path.resolve(token.slice("--out=".length));
    else if (token === "--out" && argv[i + 1]) out.out = path.resolve(argv[++i]);
  }
  return out;
}

function setColWidths(ws, widths) {
  ws["!cols"] = widths.map((wch) => ({ wch }));
}

function main() {
  const args = parseArgs(process.argv);
  const wb = XLSX.utils.book_new();

  const instructions = [
    ["Josh — Absstem O2C Chain Template (fill from scratch)"],
    [""],
    ["Purpose"],
    ["One workbook to seed a complete commercial chain without juggling SalesOrderReport + Tally + job serial sheets."],
    ["Each data row on sheet Chain = one machine / one SO → Dispatch → Tax Invoice."],
    [""],
    ["How to fill"],
    ["1. Leave Instructions alone. Fill sheet Chain only (start under the header row)."],
    ["2. Use one row per machine. Multi-machine SO: either one row with Job_No = N111,N112 or one row per serial with same SO_Number."],
    ["3. Dates as YYYY-MM-DD (or DD-Mon-YYYY like 08-Sep-2026)."],
    ["4. Customer_Code preferred (stable). If blank, Customer_Name is used to match/create."],
    ["5. Item_Code must exist in Josh Product Master for stock/dispatch integrity. Item_Name is the display fallback."],
    ["6. Leave Doc numbers blank only if you want Josh to auto-number — for Absstem legacy, keep SO_Number / Dispatch_Number / Invoice_Number."],
    ["7. Amounts: if Line_Amount blank, importer will use Qty × Unit_Price. GST_Pct default 18."],
    ["8. Do not invent GL / e-Invoice / stock balances here — those stay system-side after import."],
    [""],
    ["What this will create (planned importer)"],
    ["sales_orders (+ job_no) → sales_order_lines → dispatches + dispatch_lines → customer_invoices (+ job_no, sales_order_id, dispatch_id)"],
    ["Optional later: installed_equipment / job_assets from Job_No serials."],
    [""],
    ["What NOT to put here"],
    ["Tally voucher XML, bank receipts, journals, GST challans, BOM/job cards — keep those on their own sync paths."],
    [""],
    ["Status values"],
    ["SO_Status: draft | confirmed | closed | cancelled  (default confirmed)"],
    ["Dispatch_Status: draft | ready | dispatched | delivered | cancelled  (default dispatched)"],
    ["Invoice_Status: draft | issued | cancelled  (default issued)"],
    [""],
    ["Example row is on Chain (row 2). Delete or overwrite before import."],
  ];
  const wsInstr = XLSX.utils.aoa_to_sheet(instructions);
  setColWidths(wsInstr, [110]);
  XLSX.utils.book_append_sheet(wb, wsInstr, "Instructions");

  const headers = [
    // Party / identity
    "Company_Code",
    "Customer_Code",
    "Customer_Name",
    "Customer_GSTIN",
    "Ship_To_Name",
    "Ship_To_Address",
    "Ship_To_City",
    "Ship_To_State",
    "Ship_To_Pincode",
    // Job / serial (Absstem)
    "Job_No",
    // SO
    "SO_Number",
    "SO_Date",
    "SO_Status",
    "Customer_PO_Number",
    "Customer_PO_Date",
    "SO_Remarks",
    // Line (one machine line per row — repeat SO_Number for multi-line)
    "Line_No",
    "Item_Code",
    "Item_Name",
    "HSN",
    "UOM",
    "Qty",
    "Unit_Price",
    "GST_Pct",
    "Line_Amount",
    // Dispatch
    "Dispatch_Number",
    "Dispatch_Date",
    "Dispatch_Status",
    "Transporter_Name",
    "LR_Number",
    "Vehicle_No",
    // Invoice
    "Invoice_Number",
    "Invoice_Date",
    "Invoice_Status",
    "Invoice_Remarks",
    // Flags
    "Create_Installed_Equipment",
    "Notes",
  ];

  const example = {
    Company_Code: "AI",
    Customer_Code: "",
    Customer_Name: "Subros Limited",
    Customer_GSTIN: "",
    Ship_To_Name: "Subros Limited",
    Ship_To_Address: "",
    Ship_To_City: "",
    Ship_To_State: "",
    Ship_To_Pincode: "",
    Job_No: "N075",
    SO_Number: "S26000074",
    SO_Date: "2026-04-15",
    SO_Status: "confirmed",
    Customer_PO_Number: "",
    Customer_PO_Date: "",
    SO_Remarks: "Example — replace with real row",
    Line_No: 1,
    Item_Code: "",
    Item_Name: "Nitrogen Generator",
    HSN: "",
    UOM: "NOS",
    Qty: 1,
    Unit_Price: 0,
    GST_Pct: 18,
    Line_Amount: "",
    Dispatch_Number: "",
    Dispatch_Date: "2026-05-01",
    Dispatch_Status: "dispatched",
    Transporter_Name: "",
    LR_Number: "",
    Vehicle_No: "",
    Invoice_Number: "",
    Invoice_Date: "2026-05-01",
    Invoice_Status: "issued",
    Invoice_Remarks: "",
    Create_Installed_Equipment: "Yes",
    Notes: "Delete this example before import",
  };

  const blank = Object.fromEntries(headers.map((h) => [h, ""]));
  const chainRows = [example, blank, blank, blank, blank];
  const wsChain = XLSX.utils.json_to_sheet(chainRows, { header: headers });
  setColWidths(
    wsChain,
    headers.map((h) => Math.min(22, Math.max(12, h.length + 2)))
  );
  XLSX.utils.book_append_sheet(wb, wsChain, "Chain");

  const fieldGuide = [
    ["Column", "Required?", "Maps to / meaning"],
    ["Company_Code", "Yes", "Josh company code (AI)"],
    ["Customer_Code", "Preferred", "Stable customer match"],
    ["Customer_Name", "If no code", "Fuzzy match / create customer"],
    ["Job_No", "Yes (Absstem)", "Machine serial → sales_orders.job_no + invoice.job_no (comma-separated OK)"],
    ["SO_Number", "Yes*", "Legacy SO id; *or leave blank for Josh auto SO"],
    ["SO_Date", "Yes", "sales_orders.order_date"],
    ["SO_Status", "No", "default confirmed"],
    ["Item_Code / Item_Name", "Yes", "At least one; Item_Code must exist in products for stock"],
    ["Qty / Unit_Price", "Yes", "Builds SO line + invoice amount"],
    ["Dispatch_Number", "No", "Auto if blank"],
    ["Dispatch_Date", "Yes if dispatching", "dispatches.dispatch_date"],
    ["Invoice_Number", "No", "Auto if blank; keep legacy if you have it"],
    ["Invoice_Date", "Yes if invoicing", "customer_invoices.invoice_date"],
    ["Create_Installed_Equipment", "No", "Yes = seed Service desk serial from Job_No"],
    ["", "", ""],
    ["Multi-line SO", "", "Repeat SO_Number on next rows; change Line_No / Item / Qty. Share Job_No only on first row or set on each."],
    ["Skip dispatch", "", "Leave Dispatch_Number + Dispatch_Date blank"],
    ["Skip invoice", "", "Leave Invoice_Number + Invoice_Date blank"],
  ];
  const wsGuide = XLSX.utils.aoa_to_sheet(fieldGuide);
  setColWidths(wsGuide, [28, 14, 90]);
  XLSX.utils.book_append_sheet(wb, wsGuide, "Field_Guide");

  const lists = [
    ["SO_Status", "Dispatch_Status", "Invoice_Status", "Create_Installed_Equipment", "UOM"],
    ["draft", "draft", "draft", "Yes", "NOS"],
    ["confirmed", "ready", "issued", "No", "SET"],
    ["closed", "dispatched", "cancelled", "", "KG"],
    ["cancelled", "delivered", "", "", "MTR"],
    ["", "cancelled", "", "", ""],
  ];
  const wsLists = XLSX.utils.aoa_to_sheet(lists);
  XLSX.utils.book_append_sheet(wb, wsLists, "_Lists");

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  XLSX.writeFile(wb, args.out);
  console.log(JSON.stringify({ ok: true, out: args.out, sheets: ["Instructions", "Chain", "Field_Guide", "_Lists"] }, null, 2));
}

main();
