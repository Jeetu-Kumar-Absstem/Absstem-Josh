const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const WORKBOOK_FILE = path.join(ROOT_DIR, "Pilot_User_Onboarding_Google_SSO.xlsx");
const OUTPUT_DIR = path.join(ROOT_DIR, "Suggestions", "Process_Guides");
const INDEX_FILE = path.join(OUTPUT_DIR, "00_Pilot_User_Process_Guides_Index.rtf");

const DESK_CONFIG = {
  sales: {
    workspaceFamily: "sales",
    title: "Sales Operating Guide",
    purpose:
      "Use Josh to manage customer-facing commercial flow from enquiry visibility through quote creation, order confirmation, and dispatch handoff readiness.",
    primaryScreens: ["Sales Desk", "Leads", "Customers", "Quotes", "Sales Orders", "Dispatches"],
    flow: [
      "Lead or customer requirement is captured and tracked.",
      "Commercial discussion is converted into a quote.",
      "Approved or won quote is converted into a sales order.",
      "Sales order is checked for fulfilment readiness before dispatch.",
      "Dispatch execution completes the commercial handoff.",
    ],
    dailyRhythm: [
      "Review open leads and active customer opportunities.",
      "Prepare and refine quotes.",
      "Track quotes awaiting approval or conversion.",
      "Monitor sales orders ready for dispatch handoff.",
      "Check delivery status and cross-desk blockers.",
    ],
  },
  marketing: {
    workspaceFamily: "marketing",
    title: "Marketing Operating Guide",
    purpose:
      "Use Josh to monitor marketing execution, outbound communication readiness, exhibition activity, and source performance for pipeline support.",
    primaryScreens: ["Marketing Desk", "Campaigns", "Exhibitions", "Source Performance", "Marketing Mailers"],
    flow: [
      "Campaign or exhibition activity is planned.",
      "Source and outreach execution is tracked.",
      "Performance and source quality are reviewed.",
      "Learnings are used to refine future lead-generation actions.",
    ],
    dailyRhythm: [
      "Review active campaigns and event plans.",
      "Track mailers and marketing execution status.",
      "Check source performance and response quality.",
      "Flag insights that should improve future sales pipeline inputs.",
    ],
  },
  purchase: {
    workspaceFamily: "procurement",
    title: "Purchase Operating Guide",
    purpose:
      "Use Josh to control the procure-to-pay cycle from requirement and ordering through receipt, quality resolution, invoice validation, and vendor payment readiness.",
    primaryScreens: [
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
    flow: [
      "Requirement becomes Purchase Requisition.",
      "Approved demand becomes Purchase Order.",
      "Supplier delivery becomes Goods Receipt.",
      "Quality exception becomes claim or purchase return if required.",
      "Supplier bill becomes Purchase Invoice.",
      "Three-way match validates PO vs GRN vs Invoice.",
      "Vendor payment is released after commercial and control checks.",
    ],
    dailyRhythm: [
      "Review new and submitted requisitions.",
      "Convert approved demand into POs.",
      "Monitor undelivered or ageing POs.",
      "Post inward receipts and review QC exceptions.",
      "Validate purchase invoices and match exceptions.",
      "Track payment-ready vendors and statement closure.",
    ],
  },
  manufacturing: {
    workspaceFamily: "operations",
    title: "Manufacturing Operating Guide",
    purpose:
      "Use Josh to review BOM structure, job-card execution, and inventory-backed production support from planning through material consumption visibility.",
    primaryScreens: ["Manufacturing BOMs", "Job Cards", "Stock Ledger"],
    flow: [
      "Finished-good BOM is defined and maintained.",
      "Job cards are raised for execution.",
      "Material issue and consumption are tracked against jobs.",
      "Production support gaps are surfaced for cross-desk action.",
    ],
    dailyRhythm: [
      "Review BOM readiness for active items.",
      "Track open job cards and release blockers.",
      "Check issue, return, and consumption visibility.",
      "Flag shortage or setup gaps to upstream teams.",
    ],
  },
  stores: {
    workspaceFamily: "operations",
    title: "Stores Operating Guide",
    purpose:
      "Use Josh to manage inward handling, stock visibility, stock movement control, and support material issue / return flow for operations.",
    primaryScreens: ["Goods Receipts", "Stock Ledger", "Stock Adjustments", "Stock Transfers", "Job Cards"],
    flow: [
      "Incoming material is received and recorded.",
      "Inventory becomes visible in Stock Ledger.",
      "Transfers and adjustments are documented.",
      "Material is issued and returned against operational jobs.",
    ],
    dailyRhythm: [
      "Review inward pending posting.",
      "Monitor stock movement and balance visibility.",
      "Track adjustments and transfers needing action.",
      "Support job-card issue and return flow accurately.",
    ],
  },
  accounts: {
    workspaceFamily: "finance",
    title: "Accounts Operating Guide",
    purpose:
      "Use Josh to validate financial document flow around invoicing, receipts, receivable visibility, banking, and transaction closure.",
    primaryScreens: ["Invoices", "Receipts", "AR Desk", "GL Desk", "Bank / Cash Book", "Sales Returns"],
    flow: [
      "Commercial billing is raised through invoices.",
      "Customer receipt is captured and allocated.",
      "Receivable visibility is reviewed in AR control.",
      "Ledger and bank-book positions are monitored for closure.",
      "Sales return impact is recorded where applicable.",
    ],
    dailyRhythm: [
      "Review invoices and receipt capture.",
      "Check open receivables and allocation gaps.",
      "Monitor bank / cash entries and ledger impact.",
      "Resolve accounting exceptions affecting customer closure.",
    ],
  },
  dispatch: {
    workspaceFamily: "operations",
    title: "Dispatch Operating Guide",
    purpose:
      "Use Josh to control fulfilment readiness, shipment execution, and dispatch-side operational completion after order confirmation.",
    primaryScreens: ["Dispatches", "Sales Orders", "Stock Ledger"],
    flow: [
      "Confirmed sales order enters fulfilment stage.",
      "Dispatch readiness is reviewed against stock and document state.",
      "Shipment is executed and recorded.",
      "Operational handoff from order to shipment is completed.",
    ],
    dailyRhythm: [
      "Review dispatch-ready orders.",
      "Track stock and shipment readiness.",
      "Complete dispatch documentation and execution.",
      "Flag missing material or commercial blockers before shipment.",
    ],
  },
  service: {
    workspaceFamily: "aftermarket",
    title: "Service Operating Guide",
    purpose:
      "Use Josh to manage aftermarket operations covering service cases, warranty / replacement flow, AMC activity, reverse logistics, and job-card support.",
    primaryScreens: [
      "Aftermarket Desk",
      "Warranty / Service Replacement / Field Return",
      "Customer RMA / Reverse Logistics",
      "Return Rework / Refurb Desk",
      "AMC / Preventive Maintenance",
      "Job Cards",
    ],
    flow: [
      "Customer issue or service need enters aftermarket workflow.",
      "Service / warranty case is tracked and processed.",
      "RMA, return, or reverse logistics is managed where needed.",
      "Refurb or rework is coordinated for returned material.",
      "AMC and field service obligations are tracked.",
      "Job cards support execution activity.",
    ],
    dailyRhythm: [
      "Review Aftermarket Desk queues.",
      "Track active warranty / service cases.",
      "Monitor reverse logistics and rework progress.",
      "Review AMC and field-service commitments.",
      "Coordinate parts, execution, and closure actions.",
    ],
  },
  superadmin: {
    workspaceFamily: "superadmin",
    title: "SuperAdmin Operating Guide",
    purpose:
      "Use Josh to monitor the full pilot, validate cross-desk flow, maintain system masters, and resolve setup or permissions blockers across the platform.",
    primaryScreens: [
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
    flow: [
      "Users, masters, and permissions are prepared.",
      "Cross-desk workflows are monitored during pilot use.",
      "Configuration gaps and adoption blockers are identified.",
      "Platform behavior is tuned based on live feedback.",
    ],
    dailyRhythm: [
      "Monitor pilot access and user setup.",
      "Review cross-desk blockers and escalation points.",
      "Maintain masters, templates, and rights.",
      "Guide process correction and platform tuning.",
    ],
  },
  engineering: {
    workspaceFamily: "operations",
    title: "Engineering Operating Guide",
    purpose:
      "Use Josh to validate engineering-side product and BOM definition, manufacturing support readiness, and technical ownership for downstream execution.",
    primaryScreens: ["Manufacturing BOMs", "Job Cards", "Stock Ledger", "Product Master"],
    flow: [
      "Product definition and engineering structure are reviewed.",
      "BOM ownership and release readiness are validated.",
      "Manufacturing handoff support is checked through job-card context.",
      "Technical data and structure visibility support operations.",
    ],
    dailyRhythm: [
      "Review Product Master and BOM definition quality.",
      "Check engineering release readiness for production support.",
      "Monitor technical gaps affecting manufacturing execution.",
      "Coordinate structure and definition changes where required.",
    ],
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

function loadPilotRows(rows) {
  return rows
    .filter((row) => normalizeText(row["Volunteer Full Name"]) && normalizeText(row["Desk"]))
    .map((row) => {
      const deskKey = normalizeDesk(row["Desk"]);
      const config = DESK_CONFIG[deskKey];
      if (!config) return null;
      return {
        fullName: normalizeText(row["Volunteer Full Name"]),
        deskLabel: normalizeText(row["Desk"]),
        deskKey,
        officialEmail: normalizeEmail(row["Official Email"]),
        loginEmail: normalizeEmail(row["Google SSO Email"] || row["Official Email"]),
        designation: normalizeText(row["Designation"]),
        role: normalizeText(row["Suggested Role"]),
        department: normalizeText(row["Suggested Department"]),
        workspace: config.workspaceFamily,
        primaryCompany: normalizeText(row["Primary Company"]),
        config,
      };
    })
    .filter(Boolean);
}

function buildOperateInJosh(record) {
  const { deskKey, role, designation } = record;
  const roleText = `${String(role || "")} ${String(designation || "")}`.toLowerCase();

  if (deskKey === "sales") {
    if (roleText.includes("head") || roleText.includes("manager")) {
      return [
        "Start in Sales Desk and review the full pipeline, pending quotes, and orders waiting for commercial follow-up.",
        "Open Leads and Customers to confirm that the account, enquiry, and decision-maker details are complete before pushing the case ahead.",
        "Use Quotes to refine pricing, commercial terms, and approval readiness so the team works from one current quote record only.",
        "Move winning business into Sales Orders and track dispatch readiness from Josh instead of asking for separate status updates offline.",
        "Use Josh as the control view for coaching, escalation, and closure so open deals, pending approvals, and handoff gaps stay visible.",
      ];
    }
    return [
      "Start in Sales Desk and pick the lead, quote, or customer follow-up that needs action first.",
      "Open the exact customer or lead record in Josh and confirm contact details, enquiry scope, and the current commercial stage.",
      "Prepare or revise the quote inside Quotes so pricing, terms, and revision history stay connected to the same customer trail.",
      "Once the customer confirms, move the case into Sales Orders and keep dispatch handoff visibility inside Josh.",
      "If pricing approval, stock, or dispatch readiness is blocked, keep that blocker recorded in Josh instead of tracking it separately.",
    ];
  }

  if (deskKey === "marketing") {
    return [
      "Start in Marketing Desk and review live campaigns, mailers, exhibitions, and any source-performance signals needing action.",
      "Use Campaigns and Exhibitions to keep planning, execution status, and follow-up ownership in one place.",
      "Review Source Performance before repeating an activity so Josh becomes the reference point for what is actually producing better leads.",
      "Use Marketing Mailers from Josh-linked context so outreach, activity status, and future learning stay connected.",
      "Capture weak channels, campaign blockers, and quality-of-lead observations in Josh so future sales handoffs improve.",
    ];
  }

  if (deskKey === "purchase") {
    if (roleText.includes("manager")) {
      return [
        "Start by reviewing submitted requisitions, ageing purchase orders, inward gaps, and invoice exceptions that need management attention.",
        "Use Purchase Requisitions and Purchase Orders to confirm priority, supplier commitment, and approval readiness before releasing work.",
        "Check Goods Receipts, quality holds, and supplier claims in Josh before approving the next commercial or financial step.",
        "Use 3-way Match, Vendor Statement, and Vendor Payments to resolve control gaps from one connected record trail.",
        "Keep escalations, follow-up priorities, and closure status inside Josh so supplier issues do not split across calls, chats, and spreadsheets.",
      ];
    }
    return [
      "Start with new requisitions and convert approved demand into Purchase Orders inside Josh.",
      "Use Purchase Orders to track supplier commitment dates, pending deliveries, and commercial follow-up against the same record.",
      "When material arrives, verify the receipt in Goods Receipts and watch for quality hold, claim, or return conditions before moving ahead.",
      "Use Purchase Invoices and 3-way Match to spot PO, GRN, and bill differences before passing the case onward.",
      "Record supplier delays, shortages, and pending clarifications in Josh so the next user sees the same status without a separate tracker.",
    ];
  }

  if (deskKey === "manufacturing") {
    return [
      "Start with Manufacturing BOMs and open job-related production work that is waiting for release, structure check, or material visibility.",
      "Use Job Cards to track execution status, issue readiness, and shop-floor support requirements against the active production record.",
      "Review Stock Ledger when material availability or consumption must be confirmed before execution continues.",
      "Keep BOM gaps, release blockers, and consumption concerns linked to Josh records so production support stays traceable.",
      "Use Josh as the live execution board instead of relying on verbal follow-up for job progress and shortages.",
    ];
  }

  if (deskKey === "stores") {
    return [
      "Start with inward receipts, stock movement tasks, and material issue or return activity pending in Josh.",
      "Use Goods Receipts to record incoming material correctly so stock becomes visible to the rest of the flow immediately.",
      "Check Stock Ledger before issuing, transferring, or adjusting material so the transaction is based on current system stock.",
      "Support Job Cards from the same Josh flow when material must be issued or returned for production work.",
      "Keep adjustments, shortages, and stock movement exceptions in Josh so downstream desks work from one inventory truth.",
    ];
  }

  if (deskKey === "accounts") {
    return [
      "Start by reviewing invoices, receipts, receivable gaps, and bank or ledger items that need financial closure.",
      "Use Invoices and Receipts to keep billing and collection entries tied to the correct customer and document trail.",
      "Review AR Desk before chasing customers so overdue items, unallocated receipts, and exceptions are visible in one place.",
      "Use GL Desk and Bank / Cash Book to validate accounting impact before marking a case as financially complete.",
      "Keep unresolved accounting blockers inside Josh so commercial and finance teams see the same status.",
    ];
  }

  if (deskKey === "dispatch") {
    return [
      "Start with dispatch-ready orders and shipments that are pending document, stock, or execution clearance.",
      "Use Sales Orders to confirm that the order is commercially ready before shipment movement begins.",
      "Check Dispatches and Stock Ledger together when availability, picking, or shipment completion needs confirmation.",
      "Update shipment status in Josh as execution happens so the order-to-dispatch trail remains complete.",
      "If stock, documents, or upstream approval is missing, keep the blocker visible in Josh before dispatching.",
    ];
  }

  if (deskKey === "service") {
    return [
      "Start in Aftermarket Desk and review warranty, replacement, AMC, and reverse-logistics cases that need action now.",
      "Open the exact service or warranty record before acting so customer issue details, part history, and previous updates are visible.",
      "Use the linked service screens for RMA, reverse logistics, refurb, and AMC activity so the case stays connected end to end.",
      "When field execution or repair support is needed, use Job Cards from the same case context instead of creating a side trail.",
      "Keep pending parts, customer approvals, and closure blockers updated in Josh so service status remains visible to all desks.",
    ];
  }

  if (deskKey === "superadmin") {
    return [
      "Start by reviewing cross-desk adoption, user access issues, master-data gaps, and workflow blockers across the pilot.",
      "Use Admin Masters, User Master, Rights Matrix, and Onboarding as the control points for setup correction and access readiness.",
      "Open the affected operational desk directly in Josh when a user reports a broken handoff, missing visibility, or process confusion.",
      "Use Product Master, templates, and policy screens to correct root-cause setup instead of applying temporary offline workarounds.",
      "Keep Josh as the single operating control layer for pilot monitoring, escalation, and tuning decisions.",
    ];
  }

  if (deskKey === "engineering") {
    return [
      "Start by reviewing Product Master, Manufacturing BOMs, and open technical gaps affecting release or downstream execution.",
      "Use Product Master to confirm item definition, specs, and structure before supporting manufacturing or commercial follow-up.",
      "Use Manufacturing BOMs to validate release readiness, component structure, and engineering ownership against the exact product record.",
      "Review Job Cards and Stock Ledger when production support issues point to definition, release, or structure problems.",
      "Keep technical blockers, missing data, and release notes inside Josh so manufacturing and service teams see the same engineering position.",
    ];
  }

  return [
    "Start in your main Josh screen and review the live queue or pending work that needs action now.",
    "Open the exact record first, confirm the current data and previous-stage details, and only then continue the transaction.",
    "Move the work through the next step inside Josh itself instead of keeping a separate offline tracker or personal follow-up list.",
    "Use the linked screens for the next stage so the same record stays connected from one step to the next.",
    "If another desk must act before you can continue, leave the record in the correct pending stage and note the blocker clearly inside the system.",
  ];
}

function buildWatchCarefully(record) {
  const { deskKey, role, designation } = record;
  const roleText = `${String(role || "")} ${String(designation || "")}`.toLowerCase();

  if (deskKey === "sales") {
    if (roleText.includes("head") || roleText.includes("manager")) {
      return [
        "Watch quotes that are commercially active but not moving toward order conversion.",
        "Check that approvals, pricing exceptions, and dispatch handoff gaps are visible in Josh before the team escalates offline.",
        "Watch for poor pipeline hygiene such as stale leads, incomplete customer context, or duplicate commercial follow-up.",
        "Capture pilot feedback around visibility, team control, and conversion discipline in the same guide set.",
      ];
    }
    return [
      "Watch for incomplete customer details, weak enquiry notes, or missing commercial context before you issue a quote.",
      "Check whether pricing approval, stock commitment, or dispatch readiness is blocking the next step.",
      "Avoid running a personal follow-up tracker that drifts away from the live Josh record.",
      "Capture repeated customer or quote-stage pain points as pilot feedback after real usage.",
    ];
  }

  if (deskKey === "marketing") {
    return [
      "Watch for campaign activity that is running without clear ownership, status, or result visibility in Josh.",
      "Check weak source performance before repeating spend or outreach effort.",
      "Keep campaign observations and lead-quality concerns tied to Josh records instead of separate notes.",
      "Capture improvement ideas around campaign visibility and sales handoff quality during live use.",
    ];
  }

  if (deskKey === "purchase") {
    if (roleText.includes("manager")) {
      return [
        "Watch for ageing requisitions, purchase orders, and invoice exceptions that indicate control drift.",
        "Check that inward, claims, and payment readiness are being resolved from connected Josh records rather than informal follow-up.",
        "Watch supplier escalations that keep bouncing between teams without a clear next owner in the system.",
        "Capture pilot feedback on approval flow, visibility, and control quality after real transactions move through Josh.",
      ];
    }
    return [
      "Watch for pending supplier confirmation, overdue delivery, or receipt mismatch against the same PO.",
      "Check quality hold, claim, and return conditions before letting a case move forward.",
      "Avoid splitting supplier status across calls, chats, and offline sheets when the PO is already live in Josh.",
      "Capture repeated vendor-side or inward-side issues as pilot improvement feedback.",
    ];
  }

  if (deskKey === "manufacturing") {
    return [
      "Watch for BOM gaps, unreleased structures, or production blockers that should be visible before execution starts.",
      "Check whether job progress and material concerns are being recorded in Josh instead of passed verbally.",
      "Watch for repeated shortages or unclear issue status that will slow production flow.",
      "Capture pilot feedback on execution visibility, release readiness, and shop-floor support clarity.",
    ];
  }

  if (deskKey === "stores") {
    return [
      "Watch for receipt delays, unposted stock movement, or issue-return gaps that weaken inventory accuracy.",
      "Check stock before every issue, adjustment, or transfer so the transaction reflects the current system balance.",
      "Avoid maintaining a side record of stock movement when the same trace should sit inside Josh.",
      "Capture repeated inventory-visibility or movement-control gaps as pilot feedback.",
    ];
  }

  if (deskKey === "accounts") {
    return [
      "Watch for invoices, receipts, or customer allocations that remain open without a clear next finance action.",
      "Check AR exceptions and banking impact before treating a case as financially closed.",
      "Avoid working from disconnected statements or private notes when the receivable trail is already in Josh.",
      "Capture recurring finance-control or reconciliation friction as pilot feedback.",
    ];
  }

  if (deskKey === "dispatch") {
    return [
      "Watch for orders marked ready to ship while stock, documents, or commercial clearance are still incomplete.",
      "Check shipment execution status in Josh instead of relying on verbal confirmation alone.",
      "Avoid dispatching from an offline list that is not aligned with the live sales-order status.",
      "Capture repeated fulfilment or shipment-visibility issues as pilot feedback.",
    ];
  }

  if (deskKey === "service") {
    return [
      "Watch for open service cases with missing part status, pending customer response, or unclear closure ownership.",
      "Check that RMA, refurb, AMC, and job-card activity remains tied to the same case context inside Josh.",
      "Avoid separate service follow-up lists that disconnect from the actual aftermarket record.",
      "Capture recurring service, replacement, or closure bottlenecks as pilot feedback.",
    ];
  }

  if (deskKey === "superadmin") {
    return [
      "Watch for repeated access issues, master gaps, and cross-desk blockers that point to setup or policy problems.",
      "Check whether users are solving workflow gaps inside Josh or falling back to temporary offline practices.",
      "Watch for weak ownership in rights, templates, and policy settings that affects pilot adoption.",
      "Capture system-wide improvements that will make the pilot easier to scale after stabilization.",
    ];
  }

  if (deskKey === "engineering") {
    return [
      "Watch for incomplete product definition, weak BOM structure, or release gaps before production depends on the record.",
      "Check whether manufacturing support requests are tied back to the correct product and structure context in Josh.",
      "Avoid technical clarifications living only in calls or chat when downstream desks need the same reference trail.",
      "Capture repeated definition, release, or technical-visibility issues as pilot feedback.",
    ];
  }

  return [
    "Use linked flow inside Josh rather than parallel offline tracking wherever possible.",
    "Watch for missing handoff data from upstream desks before processing the next stage.",
    "Note blockers, confusion points, or repeated manual work during pilot usage.",
    "Capture improvement suggestions in your dedicated pilot feedback file after live use.",
  ];
}

function buildSimpleSummary(record) {
  const { deskKey, deskLabel, role, designation } = record;
  const roleText = `${String(role || "")} ${String(designation || "")}`.toLowerCase();

  if (deskKey === "sales" && (roleText.includes("head") || roleText.includes("manager"))) {
    return "Josh gives Sales leadership one connected view of pipeline control, quote movement, and order handoff readiness.";
  }
  if (deskKey === "sales") {
    return "Josh helps Sales move enquiries into quotes and confirmed orders without losing follow-up visibility.";
  }
  if (deskKey === "marketing") {
    return "Josh helps Marketing track campaign execution, source quality, and handoff learning in one visible flow.";
  }
  if (deskKey === "purchase" && roleText.includes("manager")) {
    return "Josh helps Purchase management control demand, supplier follow-up, inward visibility, and payment readiness from one system trail.";
  }
  if (deskKey === "purchase") {
    return "Josh helps Purchase run requisition, ordering, inward, and invoice control in one connected process.";
  }
  if (deskKey === "manufacturing") {
    return "Josh helps Manufacturing track BOM readiness, job execution, and production support visibility in one flow.";
  }
  if (deskKey === "stores") {
    return "Josh helps Stores keep inward, stock movement, and issue-return control aligned to one inventory record.";
  }
  if (deskKey === "accounts") {
    return "Josh helps Accounts manage invoice, receipt, receivable, and closure visibility from one financial trail.";
  }
  if (deskKey === "dispatch") {
    return "Josh helps Dispatch control shipment readiness and execution from confirmed order through final movement.";
  }
  if (deskKey === "service") {
    return "Josh helps Service run warranty, AMC, reverse logistics, and repair-support cases from one aftermarket flow.";
  }
  if (deskKey === "superadmin") {
    return "Josh helps SuperAdmin control pilot readiness, setup quality, rights, and cross-desk execution from one command layer.";
  }
  if (deskKey === "engineering") {
    return "Josh helps Engineering hold product definition, BOM readiness, and technical support visibility in one connected system.";
  }
  return `Josh helps ${deskLabel} users run their work in one connected flow instead of isolated screens and manual follow-up.`;
}

function rtfEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

function paragraph(text = "", opts = {}) {
  const { bold = false } = opts;
  const prefix = bold ? "\\b " : "";
  const suffix = bold ? "\\b0 " : "";
  return `${prefix}${rtfEscape(text)}${suffix}\\par\n`;
}

function blankLine() {
  return "\\par\n";
}

function bullet(text = "") {
  return `${rtfEscape("- " + text)}\\par\n`;
}

function numbered(index, text = "") {
  return `${rtfEscape(`${index}. ${text}`)}\\par\n`;
}

function buildGuide(record) {
  const { fullName, deskLabel, loginEmail, designation, role, department, workspace, primaryCompany, config } = record;
  const operateInJosh = buildOperateInJosh(record);
  const watchCarefully = buildWatchCarefully(record);
  const simpleSummary = buildSimpleSummary(record);
  const lines = [];
  lines.push("{\\rtf1\\ansi\\deff0");
  lines.push(paragraph(`Josh Process Guide - ${fullName}`, { bold: true }));
  lines.push(blankLine());
  lines.push(paragraph("Profile", { bold: true }));
  lines.push(bullet(`Desk: ${deskLabel}`));
  lines.push(bullet(`Guide Type: ${config.title}`));
  lines.push(bullet(`Login Email: ${loginEmail || "-"}`));
  lines.push(bullet(`Designation: ${designation || "-"}`));
  lines.push(bullet(`Suggested Role: ${role || "-"}`));
  lines.push(bullet(`Department: ${department || "-"}`));
  lines.push(bullet(`Workspace: ${workspace || "-"}`));
  lines.push(bullet(`Primary Company: ${primaryCompany || "-"}`));
  lines.push(blankLine());
  lines.push(paragraph("What Josh Does For Your Desk", { bold: true }));
  lines.push(paragraph(config.purpose));
  lines.push(blankLine());
  lines.push(paragraph("Primary Screens", { bold: true }));
  config.primaryScreens.forEach((screen) => lines.push(bullet(screen)));
  lines.push(blankLine());
  lines.push(paragraph("Process Flow", { bold: true }));
  config.flow.forEach((step, index) => lines.push(numbered(index + 1, step)));
  lines.push(blankLine());
  lines.push(paragraph("How To Operate In Josh", { bold: true }));
  operateInJosh.forEach((step, index) => lines.push(numbered(index + 1, step)));
  lines.push(blankLine());
  lines.push(paragraph("How You Should Operate Daily", { bold: true }));
  config.dailyRhythm.forEach((step, index) => lines.push(numbered(index + 1, step)));
  lines.push(blankLine());
  lines.push(paragraph("What To Watch Carefully", { bold: true }));
  watchCarefully.forEach((step) => lines.push(bullet(step)));
  lines.push(blankLine());
  lines.push(paragraph("Simple One-Line Summary", { bold: true }));
  lines.push(paragraph(simpleSummary));
  lines.push("}");
  return lines.join("");
}

function buildIndex(records) {
  const lines = [];
  lines.push("{\\rtf1\\ansi\\deff0");
  lines.push(paragraph("Pilot User Process Guides Index", { bold: true }));
  lines.push(paragraph("Use this folder to share one dedicated Josh process guide with each pilot user."));
  lines.push(blankLine());
  lines.push(paragraph("Pilot List", { bold: true }));
  records.forEach((record) => {
    const fileName = `${slugify(record.deskLabel)}__${slugify(record.fullName)}__Josh_Process_Guide.rtf`;
    lines.push(bullet(`${record.fullName} | ${record.deskLabel} | ${fileName}`));
  });
  lines.push("}");
  return lines.join("");
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(WORKBOOK_FILE);
  const worksheet = workbook.worksheets[0];
  const rows = readWorkbookRows(worksheet);
  const records = loadPilotRows(rows);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, buildIndex(records), "utf8");

  records.forEach((record) => {
    const fileName = `${slugify(record.deskLabel)}__${slugify(record.fullName)}__Josh_Process_Guide.rtf`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(filePath, buildGuide(record), "utf8");
  });

  console.log(`Pilot user process guide RTF files written to ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
