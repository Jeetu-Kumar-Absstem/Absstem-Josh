const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const WORKBOOK_FILE = path.join(ROOT_DIR, "Pilot_User_Onboarding_Google_SSO.xlsx");
const OUTPUT_DIR = path.join(ROOT_DIR, "docs");
const DATE_STAMP = "20260729";
const ACCESS_MATRIX_FILE = path.join(OUTPUT_DIR, `${DATE_STAMP}_pilot_access_matrix.md`);
const MAIL_PACK_FILE = path.join(OUTPUT_DIR, `${DATE_STAMP}_pilot_welcome_mail_pack.md`);
const MAIL_JSON_FILE = path.join(OUTPUT_DIR, `${DATE_STAMP}_pilot_welcome_mail_pack.json`);
const SUBJECT = "Welcome to Josh Pilot - Help Shape the Next Absstem Workflow";
const LOGIN_URL = "https://josh.absstem.com";
const JOSH_TAGLINE = "Josh: One Flow. Every Desk. Better Decisions.";

const SEEDED_ROLE_NAMES = new Set([
  "SuperAdmin",
  "Distributor",
  "Management",
  "Sales Head",
  "Sales Executive",
  "Regional Head",
  "Accounts",
  "Post Sales",
  "Service Engineer",
  "Design Engineer",
  "Purchase",
  "Dispatch",
  "Stores",
  "QA",
  "Production Planner",
]);

const DESK_CONFIG = {
  sales: {
    workspaceFamily: "sales",
    accessPack: "Sales desk pilot pack",
    screens: ["Sales Desk", "Leads", "Customers", "Quotes", "Sales Orders", "Dispatches"],
    roleFocus:
      "Use Josh to track leads, build quotes, convert winning opportunities into sales orders, and validate handoff readiness before dispatch.",
  },
  marketing: {
    workspaceFamily: "marketing",
    accessPack: "Marketing desk pilot pack",
    screens: ["Marketing Desk", "Campaigns", "Exhibitions", "Source Performance", "Marketing Mailers"],
    roleFocus:
      "Use Josh to review marketing execution, source effectiveness, campaign activity, and outbound communication readiness for future lead generation flows.",
  },
  purchase: {
    workspaceFamily: "procurement",
    accessPack: "Procurement pilot pack",
    screens: [
      "Purchase Orders",
      "Purchase Requisitions",
      "Goods Receipts",
      "Purchase Invoices",
      "Approval Desk",
      "Subcontracting",
      "Quality Hold / RTV",
      "Supplier Claims",
      "Purchase Returns",
      "Stock Ledger",
      "Stock Adjustments",
      "Stock Transfers",
      "3-way Match",
      "Vendor Payments",
      "Vendor Statement",
      "TDS",
    ],
    roleFocus:
      "Use Josh to review the full purchase cycle from requisition and ordering through receipt, QC holds, supplier claims, and vendor-side financial closure.",
  },
  manufacturing: {
    workspaceFamily: "operations",
    accessPack: "Manufacturing pilot pack",
    screens: ["Manufacturing BOMs", "Job Cards", "Stock Ledger"],
    roleFocus:
      "Use Josh to validate production planning flow, BOM consumption visibility, and job-card execution support for manufacturing handoff.",
  },
  stores: {
    workspaceFamily: "operations",
    accessPack: "Stores pilot pack",
    screens: ["Goods Receipts", "Stock Ledger", "Stock Adjustments", "Stock Transfers", "Job Cards"],
    roleFocus:
      "Use Josh to verify inward receipt handling, inventory visibility, stock movement, and issue-consumption support from a stores perspective.",
  },
  accounts: {
    workspaceFamily: "finance",
    accessPack: "Finance pilot pack",
    screens: ["Invoices", "Receipts", "AR Desk", "GL Desk", "Bank / Cash Book", "Sales Returns"],
    roleFocus:
      "Use Josh to validate invoicing, receipt tracking, ledger visibility, bank-book monitoring, and downstream accounting controls around customer transactions.",
  },
  dispatch: {
    workspaceFamily: "operations",
    accessPack: "Dispatch pilot pack",
    screens: ["Dispatches", "Sales Orders", "Stock Ledger"],
    roleFocus:
      "Use Josh to review fulfilment readiness, dispatch execution, document completeness, and the operational handoff from order confirmation into shipment.",
  },
  service: {
    workspaceFamily: "aftermarket",
    accessPack: "Aftermarket pilot pack",
    screens: [
      "Aftermarket Desk",
      "Warranty / Service Replacement / Field Return",
      "Customer RMA / Reverse Logistics",
      "Return Rework / Refurb Desk",
      "AMC / Preventive Maintenance",
      "Job Cards",
    ],
    roleFocus:
      "Use Josh to review service, warranty, replacement, AMC, and reverse-logistics workflows from the aftermarket support desk.",
  },
  superadmin: {
    workspaceFamily: "superadmin",
    accessPack: "Full platform admin pack",
    screens: [
      "All operational desks",
      "Admin Masters",
      "Product Master",
      "Onboarding",
      "User Master",
      "Approval Policy Matrix",
      "Rights Matrix",
      "Templates",
      "Intercompany Partners",
    ],
    roleFocus:
      "Use Josh to monitor the entire pilot, validate cross-desk flow, and help tune setup, masters, permissions, and adoption blockers across the platform.",
  },
  engineering: {
    workspaceFamily: "operations",
    accessPack: "Engineering BOM-owner exception pack",
    screens: ["Manufacturing BOMs", "Job Cards", "Stock Ledger", "Product Master"],
    roleFocus:
      "Use Josh to validate BOM ownership under Engineering, confirm structure visibility, and review how product and BOM definition should support downstream manufacturing execution.",
  },
};

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeDesk(value) {
  const desk = normalizeText(value).toLowerCase();
  if (desk === "accounts") return "accounts";
  if (desk === "dispatch") return "dispatch";
  if (desk === "engineering") return "engineering";
  if (desk === "manufacturing") return "manufacturing";
  if (desk === "marketing") return "marketing";
  if (desk === "purchase") return "purchase";
  if (desk === "sales") return "sales";
  if (desk === "service") return "service";
  if (desk === "stores") return "stores";
  if (desk === "superadmin") return "superadmin";
  return desk;
}

function normalizeWorkspace(value, deskKey) {
  const raw = normalizeText(value);
  const lower = raw.toLowerCase();
  if (!lower) return DESK_CONFIG[deskKey]?.workspaceFamily || "";
  if (lower === "engneering" || lower === "engineering") return "operations";
  if (lower === "sales") return "sales";
  if (lower === "marketing") return "marketing";
  if (lower === "procurement") return "procurement";
  if (lower === "operations") return "operations";
  if (lower === "finance") return "finance";
  if (lower === "aftermarket") return "aftermarket";
  if (lower === "superadmin") return "superadmin";
  return lower;
}

function slugify(value) {
  return normalizeText(value)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildSuggestionFileName(row) {
  return `${slugify(row["Desk"])}__${slugify(row["Volunteer Full Name"])}.rtf`;
}

function dedupeEmails(list) {
  const out = [];
  const seen = new Set();
  for (const value of list) {
    const email = normalizeEmail(value);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function roleFocusOverride(row, deskKey) {
  const roleName = normalizeText(row["Suggested Role"]);
  if (deskKey === "sales" && roleName === "Sales Head") {
    return "Use Josh to review sales-pipeline discipline, quote conversion, and order-handoff readiness while also giving pilot feedback on dashboard usefulness for sales leadership.";
  }
  return DESK_CONFIG[deskKey].roleFocus;
}

function buildProvisioningNotes(row, deskKey) {
  const notes = [];
  const officialEmail = normalizeEmail(row["Official Email"]);
  const roleName = normalizeText(row["Suggested Role"]);
  const workspace = normalizeText(row["Suggested Workspace"]);
  const primaryCompany = normalizeText(row["Primary Company"]);

  if (workspace && workspace.toLowerCase() === "engneering") {
    notes.push("Workbook workspace typo `Engneering` normalized to `operations` for provisioning.");
  }
  if (deskKey === "engineering" && normalizeText(row["Suggested Department"]).toLowerCase() !== "engineering") {
    notes.push("Engineering pilot should use department `engineering` instead of `management` if that department is available.");
  }
  if (deskKey === "engineering" && primaryCompany.includes(",")) {
    notes.push("Primary Company should be a single company; keep multi-company access in Works For Companies and choose one primary company.");
  }
  if (roleName && !SEEDED_ROLE_NAMES.has(roleName) && deskKey !== "superadmin") {
    notes.push(`Suggested role \`${roleName}\` is not part of the known seeded role list; verify the role exists or grant direct screen permissions.`);
  }
  if (officialEmail === "info@absstem.com" || officialEmail === "contact@absstem.com") {
    notes.push("Pilot row uses a shared mailbox; confirm the intended Google SSO identity before enabling access.");
  }
  if (deskKey !== "superadmin" && !normalizeEmail(row["Primary Manager Email"])) {
    notes.push("Primary manager email is blank; fill before sending the mail if manager visibility is required.");
  }
  if (deskKey === "engineering") {
    notes.push("Engineering has no dedicated desk yet, so this pilot row needs a BOM-owner exception pack instead of a standard desk role.");
  }
  return notes;
}

function buildProvisioningRecord(row) {
  const deskKey = normalizeDesk(row["Desk"]);
  const config = DESK_CONFIG[deskKey];
  if (!config) throw new Error(`Unsupported desk: ${row["Desk"]}`);

  const to = normalizeEmail(row["Google SSO Email"] || row["Official Email"]);
  const cc = dedupeEmails([row["Primary Manager Email"], row["Secondary Manager Email"]]);
  const normalizedWorkspace = normalizeWorkspace(row["Suggested Workspace"], deskKey);
  const screens = config.screens.slice();
  const notes = buildProvisioningNotes(row, deskKey);

  return {
    deskKey,
    deskLabel: normalizeText(row["Desk"]),
    fullName: normalizeText(row["Volunteer Full Name"]),
    to,
    cc,
    designation: normalizeText(row["Designation"]),
    department: normalizeText(row["Suggested Department"]),
    role: normalizeText(row["Suggested Role"]),
    rawWorkspace: normalizeText(row["Suggested Workspace"]),
    workspaceFamily: normalizedWorkspace,
    company: normalizeText(row["Primary Company"] || row["Employment Company"]),
    screens,
    accessPack: config.accessPack,
    roleFocus: roleFocusOverride(row, deskKey),
    suggestionFile: buildSuggestionFileName(row),
    notes,
  };
}

function renderAccessMatrix(records) {
  const lines = [];
  const allNotes = [];

  lines.push(`# Pilot Access Matrix - ${DATE_STAMP}`);
  lines.push("");
  lines.push(`Generated from \`Pilot_User_Onboarding_Google_SSO.xlsx\`.`);
  lines.push("");
  lines.push("## Provisioning Rules");
  lines.push("");
  lines.push("- Login URL: `https://josh.absstem.com`");
  lines.push("- Authentication: Google SSO only for the pilot users listed below.");
  lines.push("- Approval state: keep each pilot row active and approved before first login.");
  lines.push("- Access policy: grant only the listed desk pack, except the explicit Engineering BOM-owner exception and the SuperAdmin row.");
  lines.push("- Escalation: if a pilot lands in the wrong desk or sees missing screens, ask them to reply-all to their welcome mail so the manager loop remains intact.");
  lines.push("");
  lines.push("## Pilot User Matrix");
  lines.push("");
  lines.push("| Desk | Pilot | To | CC | Suggested Role | Department | Workspace | Access Pack | Day-1 Screens |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const record of records) {
    lines.push(
      `| ${record.deskLabel} | ${record.fullName} | ${record.to} | ${record.cc.join(", ") || "-"} | ${record.role || "-"} | ${record.department || "-"} | ${record.workspaceFamily || "-"} | ${record.accessPack} | ${record.screens.join(", ")} |`
    );
    for (const note of record.notes) {
      allNotes.push(`- ${record.fullName} (${record.deskLabel}): ${note}`);
    }
  }

  lines.push("");
  lines.push("## Desk Packs");
  lines.push("");
  for (const record of records) {
    lines.push(`### ${record.fullName} - ${record.deskLabel}`);
    lines.push("");
    lines.push(`- Role focus: ${record.roleFocus}`);
    lines.push(`- Primary screen set: ${record.screens.join(", ")}`);
    lines.push(`- Feedback file: \`Suggestions/${record.suggestionFile}\``);
    lines.push("");
  }

  lines.push("## Open Checks");
  lines.push("");
  if (!allNotes.length) {
    lines.push("- No workbook anomalies detected.");
  } else {
    lines.push(...allNotes);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderMailBody(record) {
  const lines = [];
  const replyAllLine =
    record.cc.length > 0
      ? "If any expected desk screen is missing after login, please reply-all to this mail so we can correct access quickly."
      : "If any expected desk screen is missing after login, please reply to this mail so we can correct access quickly.";

  lines.push(`Dear ${record.fullName},`);
  lines.push("");
  lines.push("Welcome to Josh.");
  lines.push(`${JOSH_TAGLINE}`);
  lines.push("");
  lines.push(
    "You have been selected as one of the first people to experience and shape our next-generation workflow. Your role in this pilot is critical. You are not just testing a system. You are helping define how Absstem operates going forward."
  );
  lines.push("");
  lines.push(
    "Josh is designed as the operating platform across sales, operations, service, and support desks. This pilot is our proving round where we use real work to refine screens, flow, and handoffs before broader rollout."
  );
  lines.push("");
  lines.push(`You are joining this pilot for the **${record.deskLabel}** desk. ${record.roleFocus}`);
  lines.push("");
  lines.push("Here is how you can make a high impact:");
  lines.push("- Dive in: reach your desk and validate whether the flow feels intuitive");
  lines.push("- Test drive: use the key screens naturally in your day-to-day sequence");
  lines.push("- Be direct: call out what feels faster, clearer, missing, or unnecessary");
  lines.push("- Lead the way: help us sharpen Josh before wider release");
  lines.push("");
  lines.push("Your day-1 launchpad includes:");
  for (const screen of record.screens) {
    lines.push(`- ${screen}`);
  }
  lines.push("");
  lines.push("How to log in:");
  lines.push(`- Open ${LOGIN_URL}`);
  lines.push(`- Click **Sign in with Google**`);
  lines.push(`- Use your approved Google SSO email: ${record.to}`);
  lines.push("- Jump into your assigned desk and start with the screens listed above");
  lines.push("");
  lines.push(
    "If you need a baseline comparison, use Clan as reference. The goal is to see where Josh already improves your day and where we still need to push further."
  );
  lines.push("");
  lines.push("Please send your feedback by replying to this mail. We are looking for:");
  lines.push("- friction points you currently face in Clan");
  lines.push("- breakthroughs in Josh and roadblocks in Josh");
  lines.push("- missing fields, workflow gaps, or desk-specific ideas");
  lines.push("- screens that should be simpler, faster, or more role-focused");
  lines.push("");
  lines.push("Do not hold back. Even short observations are valuable. Sharp practical feedback from real users is what will make this rollout stronger.");
  lines.push("");
  lines.push(replyAllLine);
  lines.push("");
  lines.push("Thank you for helping us build a system the entire team will want to use.");
  lines.push("");
  lines.push("Best regards,");
  lines.push("The Josh Pilot Team");
  return lines.join("\n");
}

function renderMailPack(records) {
  const lines = [];
  lines.push(`# Pilot Welcome Mail Pack - ${DATE_STAMP}`);
  lines.push("");
  lines.push(`Subject for all mails: **${SUBJECT}**`);
  lines.push("");
  lines.push(`Login URL for all pilots: \`${LOGIN_URL}\``);
  lines.push("");
  lines.push("## Send Notes");
  lines.push("");
  lines.push("- Keep the subject line identical for all pilot mails.");
  lines.push("- Use the Google SSO email as the primary recipient.");
  lines.push("- Keep the listed managers on CC where available.");
  lines.push("- Keep the desk-access bullet list intact so each pilot knows what should be visible on first login.");
  lines.push("");

  for (const record of records) {
    lines.push(`## ${record.fullName} - ${record.deskLabel}`);
    lines.push("");
    lines.push(`- To: \`${record.to}\``);
    lines.push(`- CC: ${record.cc.length ? record.cc.map((email) => `\`${email}\``).join(", ") : "-"}`);
    lines.push(`- Subject: ${SUBJECT}`);
    lines.push(`- Access Pack: ${record.accessPack}`);
    lines.push(`- Feedback Mode: Reply to this mail`);
    lines.push("");
    lines.push("```text");
    lines.push(renderMailBody(record));
    lines.push("```");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function renderMailJson(records) {
  return JSON.stringify(
    records.map((record) => ({
      header: `${record.fullName} - ${record.deskLabel}`,
      to: record.to,
      cc: record.cc,
      subject: SUBJECT,
      body: renderMailBody(record),
    })),
    null,
    2
  );
}

async function loadWorkbookRows() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(WORKBOOK_FILE);
  const sheet = workbook.getWorksheet("Pilot Users") || workbook.worksheets[0];
  if (!sheet) throw new Error("Pilot Users sheet not found in workbook.");

  const headers = [];
  sheet.getRow(1).eachCell((cell, index) => {
    headers[index - 1] = normalizeText(cell.value);
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    let hasData = false;
    headers.forEach((header, index) => {
      const value = normalizeText(row.getCell(index + 1).text || row.getCell(index + 1).value);
      obj[header] = value;
      if (value) hasData = true;
    });
    if (hasData) rows.push(obj);
  });
  return rows;
}

async function main() {
  const rows = await loadWorkbookRows();
  const records = rows.map(buildProvisioningRecord);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(ACCESS_MATRIX_FILE, renderAccessMatrix(records), "utf8");
  fs.writeFileSync(MAIL_PACK_FILE, renderMailPack(records), "utf8");
  fs.writeFileSync(MAIL_JSON_FILE, renderMailJson(records), "utf8");
  console.log(`Created ${ACCESS_MATRIX_FILE}`);
  console.log(`Created ${MAIL_PACK_FILE}`);
  console.log(`Created ${MAIL_JSON_FILE}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  SUBJECT,
  buildProvisioningRecord,
  loadWorkbookRows,
  renderMailBody,
};
