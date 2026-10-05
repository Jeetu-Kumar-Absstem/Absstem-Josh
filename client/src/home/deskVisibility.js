/**
 * Shared desk-visibility evaluators for runtime nav (roleAccess),
 * Rights Matrix preview, and Access Preview — keep these in sync.
 */

function screenView(screens, key) {
  return Boolean(screens?.[key]?.can_view);
}

function explicitOrAny(screens, explicitKey, fallbackKeys) {
  const explicit = screens?.[explicitKey]?.can_view;
  if (typeof explicit === "boolean") return explicit;
  return fallbackKeys.some((key) => screenView(screens, key));
}

/** Pure screen-map evaluators (no session / SuperAdmin bypass). */
export const DESK_VISIBILITY = [
  {
    key: "sales_desk",
    label: "Sales Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "sales_desk", ["quotes", "sales_orders", "dispatches", "invoices"]),
  },
  {
    key: "aftermarket_desk",
    label: "Aftermarket Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "aftermarket_desk", [
        "service_warranty",
        "service_tickets",
        "amc_contracts",
        "field_service",
      ]),
  },
  {
    key: "commissioning_desk",
    label: "Commissioning Desk",
    evaluate: (screens) => explicitOrAny(screens, "commissioning_desk", ["field_service"]),
  },
  {
    key: "ar_desk",
    label: "AR Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "ar_desk", ["receipts", "invoices", "customers"]),
  },
  {
    key: "hr_desk",
    label: "HR Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "hr_desk", [
        "attendance",
        "expenses",
        "activity_planner",
        "events",
        "leave",
        "holidays",
        "salary",
        "salary_slips",
      ]),
  },
  {
    key: "marketing_desk",
    label: "Marketing Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "marketing_desk", [
        "campaigns",
        "exhibitions",
        "source_performance",
        "marketing_mailers",
        "marketing",
        "leads",
      ]),
  },
  {
    key: "approval_desk",
    label: "Approval Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "approval_desk", ["purchase_orders", "purchase_requisitions"]),
  },
  {
    key: "tally_import_desk",
    label: "Tally Import Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "tally_import_desk", ["tally_export", "gl_desk", "admin_masters"]),
  },
  {
    key: "inbound_lead_review",
    label: "Inbound Lead Review",
    evaluate: (screens) => screenView(screens, "leads") && explicitOrAny(screens, "inbound_lead_review", ["leads"]),
  },
  {
    key: "finance_desk",
    label: "Finance Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "finance_desk", ["invoices", "receipts", "gl_desk", "ar_desk", "three_way_match"]),
  },
  {
    key: "commercial_desk",
    label: "Commercial Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "commercial_desk", ["quotes", "leads", "sales_orders", "customers"]),
  },
  {
    key: "service_desk",
    label: "Service Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "service_desk", [
        "service_tickets",
        "amc_contracts",
        "service_warranty",
        "field_service",
      ]),
  },
  {
    key: "shop_floor",
    label: "Shop Floor",
    evaluate: (screens) =>
      explicitOrAny(screens, "shop_floor", ["job_cards", "manufacturing_boms", "stock_ledger"]),
  },
  {
    key: "mrp_planning_desk",
    label: "MRP Planning Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "mrp_planning_desk", ["purchase_requisitions", "purchase_orders", "stock_ledger"]),
  },
  {
    key: "product_master_desk",
    label: "Product Master Desk",
    evaluate: (screens) =>
      explicitOrAny(screens, "product_master_desk", ["manufacturing_boms", "product_master"]),
  },
  {
    key: "executive_command",
    label: "Executive Command",
    evaluate: (screens) =>
      explicitOrAny(screens, "executive_command", ["management", "sales_desk", "finance_desk"]),
  },
  {
    key: "admin_desk",
    label: "Admin Desk",
    evaluate: (screens) => screenView(screens, "admin_desk"),
  },
];

const DESK_BY_KEY = Object.fromEntries(DESK_VISIBILITY.map((d) => [d.key, d]));

export function evaluateDeskVisibility(deskKey, screens) {
  const desk = DESK_BY_KEY[deskKey];
  if (!desk) return false;
  return desk.evaluate(screens || {});
}

/** Composite page keys that use DESK_VISIBILITY instead of a bare screen flag. */
export const COMPOSITE_DESK_PAGES = new Set(DESK_VISIBILITY.map((d) => d.key));
