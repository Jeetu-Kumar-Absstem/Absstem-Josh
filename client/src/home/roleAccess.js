/** Department-first Home access helpers. Shared with App shell for nav gating. */

import { COMPOSITE_DESK_PAGES, evaluateDeskVisibility } from "./deskVisibility";

export const SUPERADMIN_PAGES = new Set([
  "superadmin_home",
  "admin_masters",
  "job_asset_admin",
  "product_master",
  "data_ops",
  "onboarding",
  "users",
  "approval_policy_matrix",
  "intercompany_partners",
  "rights",
  "user_access_preview",
  "pilot_feedback",
  "chat_readiness",
  "access_profiles",
  "templates",
]);

/** Non–SuperAdmin users may open these if Rights Matrix grants screen view. Org & access stays SuperAdmin-only. */
export const BUSINESS_ADMIN_PAGES = new Set(["admin_masters", "templates", "product_master"]);

export function canAccessPage(me, page) {
  if (!me) return false;
  if (page === "home") return true;
  if (page === "access_profiles" && (!me.access_model || me.access_model === "off")) return false;
  // After cutover the Rights Matrix is retired; Access Profiles replace it.
  if (page === "rights" && me.access_model === "on") return false;
  if (me.group_name === "SuperAdmin") return true;
  if (SUPERADMIN_PAGES.has(page)) {
    if (BUSINESS_ADMIN_PAGES.has(page)) {
      const canView = me.permissions?.screens?.[page]?.can_view;
      if (typeof canView === "boolean") return canView;
    }
    return false;
  }
  if (COMPOSITE_DESK_PAGES.has(page)) {
    return evaluateDeskVisibility(page, me.permissions?.screens || {});
  }
  const permissionKey = page === "vendor_payments" ? "vendor_payments" : page;
  const canView = me.permissions?.screens?.[permissionKey]?.can_view;
  if (typeof canView === "boolean") return canView;
  return false;
}

/** Fine-grained screen action check (create / edit / approve). SuperAdmin always true. */
export function canScreenAction(me, page, action = "can_view") {
  if (!me) return false;
  if (me.group_name === "SuperAdmin") return true;
  if (!canAccessPage(me, page)) return false;
  const flag = String(action || "can_view");
  if (flag === "can_view") return true;
  const permissionKey = page === "vendor_payments" ? "vendor_payments" : page;
  const value = me.permissions?.screens?.[permissionKey]?.[flag];
  if (typeof value === "boolean") return value;
  return false;
}

const SALES_ENTRY_PAGES = ["sales_desk", "leads", "quotes", "sales_orders", "customers", "commercial_desk"];

export function resolveHomeRoleFamily(me) {
  const allowedFamilies = new Set([
    "sales",
    "finance",
    "operations",
    "dispatch",
    "stores",
    "aftermarket",
    "procurement",
    "marketing",
    "hr",
    "executive",
    "office",
    "employee",
    "distributor",
    "superadmin",
  ]);
  const explicitRoleFamily = String(me?.role_workspace_family || "")
    .trim()
    .toLowerCase();
  const explicitDepartmentFamily = String(me?.department_workspace_family || "")
    .trim()
    .toLowerCase();
  const group = String(me?.group_name || "").trim().toLowerCase();
  const role = String(me?.role_name || "").trim().toLowerCase();
  const roleKey = String(me?.role_key || "").trim().toLowerCase();
  const department = String(me?.department_key || "").trim().toLowerCase();
  const roleSignals = `${group} ${role} ${roleKey} ${department}`;
  const screens = me?.permissions?.screens || {};

  if (group === "superadmin") return "superadmin";
  if (group === "distributor" || roleKey === "distributor" || role.includes("distributor")) return "distributor";
  if (allowedFamilies.has(explicitRoleFamily)) return explicitRoleFamily;
  if (allowedFamilies.has(explicitDepartmentFamily)) return explicitDepartmentFamily;

  if (/(account|finance|financial|accounting|\bcfo\b|\bgl\b|receiv|reconcil)/.test(roleSignals)) return "finance";
  if (/(\bceo\b|chief executive|managing director|\bmd\b|chairman|chairperson|president|founder|executive director|whole[- ]time director|\bmanagement\b)/.test(roleSignals)) {
    return "executive";
  }
  if (
    /(post sales|service|aftermarket|warranty|\bamc\b|field return|reverse logistics|rework|field engineer|commission|installation|site engineer|\brma\b|returns)/.test(
      roleSignals
    )
  ) {
    return "aftermarket";
  }
  if (/(office admin|office_admin|front office|front desk|reception|facilit|housekeeping)/.test(roleSignals)) return "office";
  if (/(human resource|hr manager|hr executive|payroll|attendance|leave)/.test(roleSignals)) return "hr";
  if (/(store|stores|warehouse|godown|inventory keeper|stock keeper)/.test(roleSignals)) return "stores";
  if (/(purchase|procurement|buyer|vendor|subcontract|grn|goods receipt|tds)/.test(roleSignals)) return "procurement";
  if (/(marketing|campaign|exhibition|brand|digital marketing|demand gen)/.test(roleSignals)) return "marketing";
  if (/(dispatch|despatch|shipping|logistics|transport)/.test(roleSignals)) return "dispatch";
  if (/(plant|works manager|factory|manufacturing|production|planner|operations|\bcoo\b|chief operating|\bqa\b|quality|packing)/.test(roleSignals)) {
    return "operations";
  }

  if (screens.receipts?.can_view || screens.invoices?.can_view || screens.proforma_invoices?.can_view || screens.ar_desk?.can_view || screens.gl_desk?.can_view || screens.landed_cost?.can_view || screens.tally_export?.can_view) return "finance";
  if (
    screens.aftermarket_desk?.can_view ||
    screens.service_warranty?.can_view ||
    screens.service_tickets?.can_view ||
    screens.amc_contracts?.can_view ||
    screens.reverse_logistics?.can_view ||
    screens.return_rework?.can_view
  ) {
    return "aftermarket";
  }
  if (
    screens.hr_desk?.can_view ||
    screens.expenses?.can_view ||
    screens.leave?.can_view ||
    screens.attendance?.can_view ||
    screens.salary_slips?.can_view
  ) {
    return "hr";
  }
  if (
    screens.marketing_desk?.can_view ||
    screens.campaigns?.can_view ||
    screens.exhibitions?.can_view ||
    screens.source_performance?.can_view ||
    screens.marketing_mailers?.can_view
  ) {
    return "marketing";
  }
  if (
    (screens.stock_ledger?.can_view || screens.stock_adjustments?.can_view || screens.stock_transfers?.can_view) &&
    (screens.goods_receipts?.can_view || screens.quality_control?.can_view) &&
    !screens.purchase_orders?.can_view
  ) {
    return "stores";
  }
  if (
    screens.purchase_orders?.can_view ||
    screens.purchase_requisitions?.can_view ||
    screens.vendor_quotes?.can_view ||
    screens.purchase_invoices?.can_view ||
    screens.goods_receipts?.can_view ||
    screens.subcontracting?.can_view ||
    screens.vendor_payments?.can_view ||
    screens.vendor_statement?.can_view ||
    screens.tds?.can_view
  ) {
    return "procurement";
  }
  if (screens.manufacturing_boms?.can_view || screens.job_cards?.can_view || screens.quality_control?.can_view) {
    return "operations";
  }
  if (screens.dispatches?.can_view) return "dispatch";
  if (screens.executive_command?.can_view || screens.management?.can_view) return "executive";
  if (screens.office_admin?.can_view) return "office";

  if (SALES_ENTRY_PAGES.some((page) => canAccessPage(me, page))) return "sales";
  return "employee";
}

export function defaultLaneForFamily(family) {
  if (family === "finance") return "accounts";
  if (family === "operations") return "manufacturing";
  if (family === "dispatch") return "sales";
  if (family === "stores") return "manufacturing";
  if (family === "aftermarket") return "aftermarket";
  if (family === "procurement" || family === "superadmin") return "procurement";
  if (family === "executive") return "executive_lane";
  if (family === "marketing") return "sales";
  if (family === "hr" || family === "office" || family === "employee") return "accounts";
  if (family === "distributor") return "sales";
  return "sales";
}

export function getHomeRoleConfig(me) {
  const family = resolveHomeRoleFamily(me);

  if (family === "superadmin") {
    return {
      key: "superadmin",
      label: "SuperAdmin",
      tone: "#7c3aed",
      tint: "#f5efff",
      title: "Admin My Day",
      description: "Review setup, asset governance, templates, products, and access controls from one admin home.",
    pins: [
      { label: "Executive BI", caption: "Command", page: "executive_command" },
      { label: "Admin & Security", caption: "Audit & Backups", page: "admin_desk" },
      { label: "SuperAdmin Home", caption: "Control desk", page: "superadmin_home" },
      { label: "Org & access", caption: "People governance", page: "users" },
      { label: "Rights Matrix", caption: "Role templates", page: "rights" },
      { label: "Access Preview", caption: "Diagnose visibility", page: "user_access_preview" },
      { label: "Onboarding", caption: "New users", page: "onboarding" },
      { label: "Admin Masters", caption: "Business controls", page: "admin_masters" },
      { label: "Job Asset Admin", caption: "Deployed assets", page: "job_asset_admin" },
      { label: "Product Master Admin", caption: "SKU import control", page: "product_master" },
      { label: "Intercompany Partners", caption: "AI ↔ AT links", page: "intercompany_partners" },
      { label: "Product Catalog", caption: "SKU desk", page: "product_master_desk" },
      { label: "Pilot Feedback", caption: "Triage notes", page: "pilot_feedback" },
    ],
    };
  }

  if (family === "finance") {
    return {
      key: "finance",
      label: "Finance",
      tone: "#14804a",
      tint: "#ecfbf2",
      title: "Finance My Day",
      description: "Clear overdue follow-ups, broken promises, and close blockers before opening detailed desks.",
      pins: [
        { label: "Finance & Accounts", caption: "Command", page: "finance_desk" },
        { label: "AR Desk", caption: "Collections", page: "ar_desk" },
        { label: "Receipts", caption: "Cash in", page: "receipts" },
        { label: "Executive Board", caption: "Packs", page: "management" },
        { label: "Proforma", caption: "Advance PI", page: "proforma_invoices" },
        { label: "Invoices", caption: "Billing", page: "invoices" },
        { label: "GL Desk", caption: "Close", page: "gl_desk" },
        { label: "Tally", caption: "Export", page: "tally_export" },
      ],
    };
  }

  if (family === "distributor") {
    return {
      key: "distributor",
      label: "Distributor",
      tone: "#0f766e",
      tint: "#ecfdf5",
      title: "Distributor My Day",
      description: "Clear lead follow-ups and quotes first. Request missing Product Master SKUs when catalog blocks a quote.",
      pins: [
        { label: "Sales Desk", caption: "Command", page: "sales_desk" },
        { label: "Leads", caption: "Pipeline", page: "leads" },
        { label: "Quotes", caption: "Commercial", page: "quotes" },
        { label: "Customers", caption: "Accounts", page: "customers" },
        { label: "Request SKU", caption: "Missing item", action: "request_sku" },
      ],
    };
  }

  if (family === "procurement") {
    return {
      key: "procurement",
      label: "Procurement",
      tone: "#7c5a18",
      tint: "#fff6e7",
      title: "Procurement My Day",
      description: "Clear vendor delays, pending receipts, and payables pressure first.",
      pins: [
        { label: "MRP II Planning", caption: "Demand Engine", page: "mrp_planning_desk" },
        { label: "Purchase Requisitions", caption: "Demand", page: "purchase_requisitions" },
        { label: "Approval Desk", caption: "Stamps", page: "approval_desk" },
        { label: "Purchase Orders", caption: "Buy", page: "purchase_orders" },
        { label: "Goods Receipts (GRN)", caption: "GRN desk", page: "goods_receipts" },
        { label: "Vendor Payments", caption: "AP", page: "vendor_payments" },
      ],
    };
  }

  if (family === "stores") {
    return {
      key: "stores",
      label: "Stores",
      tone: "#0f766e",
      tint: "#ecfdf5",
      title: "Stores My Day",
      description: "Clear pending inward, QC holds, and pick lists before the floor waits.",
      pins: [
        { label: "Goods Receipts (GRN)", caption: "GRN desk", page: "goods_receipts" },
        { label: "Quality Control", caption: "Inspect", page: "quality_control" },
        { label: "Stock Ledger", caption: "Balances", page: "stock_ledger" },
        { label: "Stock Adjustments", caption: "Count", page: "stock_adjustments" },
        { label: "Job Cards", caption: "Issue", page: "job_cards" },
      ],
    };
  }

  if (family === "hr") {
    return {
      key: "hr",
      label: "HR",
      tone: "#be185d",
      tint: "#fdf2f8",
      title: "HR My Day",
      description: "Clear expense and leave approvals, attendance exceptions, and unpaid slips first.",
      pins: [
        { label: "HR Desk", caption: "Control", page: "hr_desk" },
        { label: "HR Admin", caption: "Skills", page: "hr_admin" },
        { label: "Expenses", caption: "Claims", page: "expenses" },
        { label: "Leave", caption: "Time off", page: "leave" },
        { label: "Attendance", caption: "Punches", page: "attendance" },
        { label: "Salary Slips", caption: "Payroll", page: "salary_slips" },
      ],
    };
  }

  if (family === "aftermarket") {
    return {
      key: "aftermarket",
      label: "Aftermarket",
      tone: "#0f766e",
      tint: "#ebfffb",
      title: "Aftermarket My Day",
      description: "Clear overdue service actions, field returns, and reverse-flow stalls first.",
      pins: [
        { label: "Service & Maintenance", caption: "Command", page: "service_desk" },
        { label: "My Duty & Expenses", caption: "Field day", page: "my_duty_expenses" },
        { label: "Commissioning Desk", caption: "Sign-off", page: "commissioning_desk" },
        { label: "Service Tickets", caption: "Visits", page: "service_tickets" },
        { label: "Aftermarket Desk", caption: "Recovery", page: "aftermarket_desk" },
        { label: "Service Warranty", caption: "Cases", page: "service_warranty" },
        { label: "Return Rework", caption: "Refurb", page: "return_rework" },
      ],
    };
  }

  if (family === "marketing") {
    return {
      key: "marketing",
      label: "Marketing",
      tone: "#7c3aed",
      tint: "#f5efff",
      title: "Marketing My Day",
      description: "Clear fair intake gaps, weak spend, and unassigned attributed leads before the next outreach.",
      pins: [
        { label: "Marketing Desk", caption: "Demand", page: "marketing_desk" },
        { label: "Market Intelligence", caption: "ROI", page: "marketing" },
        { label: "Exhibitions", caption: "Fairs", page: "exhibitions" },
        { label: "Campaigns", caption: "Spend", page: "campaigns" },
        { label: "Leads", caption: "Intake", page: "leads" },
      ],
    };
  }

  if (family === "operations") {
    return {
      key: "operations",
      label: "Operations",
      tone: "#b45309",
      tint: "#fff7eb",
      title: "Operations My Day",
      description: "Clear dispatch blockers, material gaps, and billing lag before the day gets noisy.",
      pins: [
        { label: "Shop Floor", caption: "Kitting & assembly", page: "shop_floor" },
        { label: "Job Cards", caption: "Factory", page: "job_cards" },
        { label: "Dispatches", caption: "Ship", page: "dispatches" },
        { label: "Sales Desk", caption: "Handoff", page: "sales_desk" },
        { label: "Engineering Desk", caption: "Datasheets", page: "engineering_desk" },
      ],
    };
  }

  if (family === "executive") {
    return {
      key: "executive",
      label: "Executive",
      tone: "#1e293b",
      tint: "#f1f5f9",
      title: "Leadership My Day",
      description: "Cash, collections, billing lag, stalled production, and open service calls across the business.",
      pins: [
        { label: "Executive Command", caption: "BI & cash", page: "executive_command" },
        { label: "Executive Board", caption: "Packs", page: "management" },
        { label: "Sales Desk", caption: "Pipeline", page: "sales_desk" },
        { label: "AR Desk", caption: "Collections", page: "ar_desk" },
        { label: "Job Cards", caption: "Factory", page: "job_cards" },
        { label: "Aftermarket Desk", caption: "Service", page: "aftermarket_desk" },
        { label: "Approval Desk", caption: "Stamps", page: "approval_desk" },
        { label: "Intercompany", caption: "AI ↔ AT", page: "intercompany_dashboard" },
      ],
    };
  }

  if (family === "dispatch") {
    return {
      key: "dispatch",
      label: "Dispatch",
      tone: "#b45309",
      tint: "#fff7eb",
      title: "Dispatch My Day",
      description: "Clear ready-to-ship orders, missing documents, and e-way bill expiries before trucks leave.",
      pins: [
        { label: "Dispatches", caption: "Ship", page: "dispatches" },
        { label: "Sales Orders", caption: "Ready", page: "sales_orders" },
        { label: "Tax Invoices", caption: "Billing", page: "invoices" },
        { label: "Stock Ledger", caption: "Balances", page: "stock_ledger" },
        { label: "Sales Desk", caption: "Handoff", page: "sales_desk" },
      ],
    };
  }

  if (family === "office") {
    return {
      key: "office",
      label: "Office Admin",
      tone: "#475569",
      tint: "#f8fafc",
      title: "Office My Day",
      description: "Visitors, IT assets, and your own duty, leave, and claims.",
      pins: [
        { label: "Office Admin", caption: "Assets & visitors", page: "office_admin" },
        { label: "My Duty & Expenses", caption: "Self", page: "my_duty_expenses" },
        { label: "Leave", caption: "Time off", page: "leave" },
        { label: "Expenses", caption: "Claims", page: "expenses" },
      ],
    };
  }

  if (family === "employee") {
    return {
      key: "employee",
      label: "Self-service",
      tone: "#475569",
      tint: "#f8fafc",
      title: "My Day",
      description: "Mark duty, file claims, and request leave. Ask an admin if you need a department desk.",
      pins: [
        { label: "My Duty & Expenses", caption: "Self", page: "my_duty_expenses" },
        { label: "Leave", caption: "Time off", page: "leave" },
        { label: "Expenses", caption: "Claims", page: "expenses" },
      ],
    };
  }

  return {
    key: "sales",
    label: "Sales",
    tone: "#2354d5",
    tint: "#eef4ff",
    title: "Sales My Day",
    description: "Clear approvals, stale leads, and order handoffs before opening the full desk set.",
    pins: [
      { label: "Sales Desk", caption: "Command", page: "sales_desk" },
      { label: "Leads", caption: "Pipeline", page: "leads" },
      { label: "Customers", caption: "Accounts", page: "customers" },
      { label: "Quotes", caption: "Builder", page: "quotes" },
      { label: "Sales Orders", caption: "Orders", page: "sales_orders" },
      { label: "Commercial Desk", caption: "CRM deals", page: "commercial_desk" },
    ],
  };
}

const HOME_LANES = [
  {
    key: "executive_lane",
    label: "Executive Command",
    detail: "Real-time BI, Working Capital & Operational Pulse",
    targets: ["executive_command", "management", "superadmin_home"],
  },
  {
    key: "finance_lane",
    label: "Finance & Accounts",
    detail: "Double-entry GL, 3-way match, GST reconciliation, Invoicing & AR",
    targets: ["finance_desk", "ar_desk", "invoices", "gl_desk"],
  },
  {
    key: "commercial",
    label: "Commercial & Sales",
    detail: "CRM pipeline, deal conversion, sales orders, dispatch",
    targets: ["commercial_desk", "quotes", "sales_orders", "dispatches"],
  },
  {
    key: "sales",
    label: "Sales",
    detail: "Quotes, orders, dispatch, billing",
    targets: ["sales_desk", "quotes", "sales_orders", "dispatches", "invoices"],
  },
  {
    key: "accounts",
    label: "Accounts",
    detail: "Collections, AR, GL, reconciliation",
    targets: ["ar_desk", "receipts", "gl_desk", "invoices", "proforma_invoices", "tally_export"],
  },
  {
    key: "manufacturing",
    label: "Manufacturing",
    detail: "Planning, stores, production, quality, kitting",
    targets: ["job_cards", "shop_floor", "manufacturing_boms", "quality_control"],
  },
  {
    key: "service_lane",
    label: "Service & Maintenance",
    detail: "Serialized assets, AMCs, breakdown calls & spare parts",
    targets: ["service_desk", "service_tickets", "amc_contracts", "service_warranty"],
  },
  {
    key: "aftermarket",
    label: "Aftermarket",
    detail: "Service, reverse logistics, rework",
    targets: ["aftermarket_desk", "service_tickets", "service_warranty", "commissioning_desk", "reverse_logistics", "return_rework"],
  },
  {
    key: "admin_lane",
    label: "System Administration",
    detail: "Audit logs, RBAC matrix & database backups",
    targets: ["admin_desk", "superadmin_home", "users"],
  },
  {
    key: "procurement",
    label: "Procurement & Planning",
    detail: "MRP II, Purchase, payables, receiving",
    targets: [
      "purchase_orders",
      "goods_receipts",
      "mrp_planning_desk",
      "subcontracting",
      "vendor_payments",
      "vendor_statement",
      "bank_book",
      "tds",
      "purchase_invoices",
      "vendor_quotes",
    ],
  },
];

export function listAccessibleLanes(me) {
  return HOME_LANES.map((lane) => ({
    ...lane,
    page: lane.targets.find((page) => canAccessPage(me, page)) || "",
  })).filter((lane) => lane.page);
}
