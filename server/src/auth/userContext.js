const { accessModelMode, compileScreens, diffScreens } = require("./accessModel");

const SCREEN_CATALOG = [
  { screen_key: "leads", screen_name: "Leads", module_key: "leads" },
  { screen_key: "inbound_lead_review", screen_name: "Inbound Lead Review (mailbox intake)", module_key: "leads" },
  { screen_key: "customers", screen_name: "Customers", module_key: "masters" },
  { screen_key: "quotes", screen_name: "Quotes", module_key: "quotes" },
  { screen_key: "sales_orders", screen_name: "Sales Orders", module_key: "sales_orders" },
  { screen_key: "dispatches", screen_name: "Dispatches", module_key: "dispatch" },
  { screen_key: "invoices", screen_name: "Invoices", module_key: "accounting" },
  { screen_key: "proforma_invoices", screen_name: "Proforma Invoices", module_key: "accounting" },
  { screen_key: "receipts", screen_name: "Receipts", module_key: "accounting" },
  { screen_key: "ar_desk", screen_name: "AR Desk", module_key: "accounting" },
  { screen_key: "gl_desk", screen_name: "GL Desk", module_key: "accounting" },
  { screen_key: "landed_cost", screen_name: "Landed Cost / Inventory Valuation", module_key: "accounting" },
  { screen_key: "tally_export", screen_name: "Tally Export", module_key: "accounting" },
  { screen_key: "tally_import_desk", screen_name: "Tally ERP Ingestion & Rec Desk", module_key: "accounting" },
  { screen_key: "service_warranty", screen_name: "Warranty / Service Replacement / Field Return", module_key: "service" },
  { screen_key: "service_tickets", screen_name: "Service Tickets / Complaints", module_key: "service" },
  { screen_key: "field_service", screen_name: "Field Service / Commissioning", module_key: "service" },
  { screen_key: "reverse_logistics", screen_name: "Customer RMA / Reverse Logistics", module_key: "service" },
  { screen_key: "return_rework", screen_name: "Return Rework / Refurb Desk", module_key: "service" },
  { screen_key: "job_cards", screen_name: "Material Issue / Consumption / Job Card", module_key: "service" },
  { screen_key: "manufacturing_boms", screen_name: "Manufacturing BOMs", module_key: "manufacturing" },
  { screen_key: "engineering_desk", screen_name: "Engineering Desk", module_key: "manufacturing" },
  { screen_key: "amc_contracts", screen_name: "AMC / Preventive Maintenance", module_key: "service" },
  { screen_key: "aftermarket_desk", screen_name: "Aftermarket Desk", module_key: "service" },
  { screen_key: "commissioning_desk", screen_name: "Commissioning Desk", module_key: "service" },
  { screen_key: "purchase_orders", screen_name: "Purchase Orders", module_key: "purchase" },
  { screen_key: "purchase_requisitions", screen_name: "Purchase Requisitions", module_key: "purchase" },
  { screen_key: "vendor_quotes", screen_name: "Vendor Quotes / RFQ", module_key: "purchase" },
  { screen_key: "purchase_invoices", screen_name: "Purchase Invoices", module_key: "purchase" },
  { screen_key: "goods_receipts", screen_name: "GRN / Inward", module_key: "purchase" },
  { screen_key: "subcontracting", screen_name: "Subcontracting / Outside Processing", module_key: "purchase" },
  { screen_key: "quality_control", screen_name: "Quality Hold / RTV", module_key: "purchase" },
  { screen_key: "supplier_claims", screen_name: "Supplier Claims / Replacement Receipt", module_key: "purchase" },
  { screen_key: "purchase_returns", screen_name: "Purchase Return / Debit Note", module_key: "purchase" },
  { screen_key: "stock_ledger", screen_name: "Stock Ledger", module_key: "manufacturing" },
  { screen_key: "stock_adjustments", screen_name: "Stock Adjustment / Physical Verification", module_key: "manufacturing" },
  { screen_key: "stock_transfers", screen_name: "Warehouse / Location Transfer", module_key: "manufacturing" },
  { screen_key: "sales_returns", screen_name: "Sales Return / Customer Credit Note", module_key: "accounting" },
  { screen_key: "three_way_match", screen_name: "3-way Match", module_key: "purchase" },
  { screen_key: "vendor_payments", screen_name: "Vendor Payments", module_key: "purchase" },
  { screen_key: "vendor_statement", screen_name: "Vendor Statement", module_key: "purchase" },
  { screen_key: "approval_desk", screen_name: "Approval Desk", module_key: "purchase" },
  { screen_key: "approval_policy_matrix", screen_name: "Approval Policy Matrix", module_key: "admin" },
  { screen_key: "bank_book", screen_name: "Bank / Cash Book", module_key: "accounting" },
  { screen_key: "tds", screen_name: "TDS", module_key: "purchase" },
  { screen_key: "hr_desk", screen_name: "HR Desk", module_key: "hr" },
  { screen_key: "hr_admin", screen_name: "HR Admin / Transitions", module_key: "hr" },
  { screen_key: "office_admin", screen_name: "Office Admin", module_key: "hr" },
  { screen_key: "attendance", screen_name: "Attendance", module_key: "hr" },
  { screen_key: "expenses", screen_name: "Expenses", module_key: "hr" },
  { screen_key: "my_duty_expenses", screen_name: "My Duty & Expenses", module_key: "hr" },
  { screen_key: "activity_planner", screen_name: "Activity Planner", module_key: "hr" },
  { screen_key: "events", screen_name: "Events", module_key: "hr" },
  { screen_key: "leave", screen_name: "Leave", module_key: "hr" },
  { screen_key: "holidays", screen_name: "Holidays", module_key: "hr" },
  { screen_key: "salary", screen_name: "Salary", module_key: "hr" },
  { screen_key: "salary_slips", screen_name: "Salary Slips", module_key: "hr" },
  { screen_key: "marketing_desk", screen_name: "Marketing Desk", module_key: "marketing" },
  { screen_key: "marketing", screen_name: "Marketing ROI / Trade Shows", module_key: "marketing" },
  { screen_key: "campaigns", screen_name: "Campaigns", module_key: "marketing" },
  { screen_key: "exhibitions", screen_name: "Exhibitions", module_key: "marketing" },
  { screen_key: "source_performance", screen_name: "Source Performance", module_key: "marketing" },
  { screen_key: "marketing_mailers", screen_name: "Marketing Mailers", module_key: "marketing" },
  { screen_key: "lead_ingestion", screen_name: "Lead Ingestion", module_key: "marketing" },
  { screen_key: "geo_territories", screen_name: "Sales Territories", module_key: "marketing" },
  { screen_key: "lead_scoring", screen_name: "Lead Scoring", module_key: "marketing" },
  { screen_key: "dormancy_segments", screen_name: "Dormancy / Newsletter", module_key: "marketing" },
  { screen_key: "quote_write_ups", screen_name: "Quote Write-ups", module_key: "marketing" },
  { screen_key: "management", screen_name: "Executive Management", module_key: "management" },
  { screen_key: "executive_command", screen_name: "Executive Command", module_key: "management" },
  { screen_key: "admin_desk", screen_name: "Admin & Security Governance", module_key: "admin" },
  { screen_key: "data_ops", screen_name: "Data Ops", module_key: "admin" },
  { screen_key: "finance_desk", screen_name: "Finance & Accounts Desk", module_key: "accounting" },
  { screen_key: "commercial_desk", screen_name: "Commercial Desk", module_key: "quotes" },
  { screen_key: "service_desk", screen_name: "Service & Maintenance Desk", module_key: "service" },
  { screen_key: "shop_floor", screen_name: "Shop Floor & Kitting", module_key: "manufacturing" },
  { screen_key: "mrp_planning_desk", screen_name: "MRP Planning Desk", module_key: "purchase" },
  { screen_key: "product_master_desk", screen_name: "Product Master Desk", module_key: "manufacturing" },
  { screen_key: "sales_desk", screen_name: "Sales Desk", module_key: "quotes" },
  { screen_key: "admin_masters", screen_name: "Admin Masters", module_key: "admin" },
  { screen_key: "job_asset_admin", screen_name: "Job Assets", module_key: "admin" },
  { screen_key: "product_master", screen_name: "Product Master", module_key: "admin" },
  { screen_key: "onboarding", screen_name: "Onboarding", module_key: "admin" },
  { screen_key: "users", screen_name: "User Master", module_key: "admin" },
  { screen_key: "user_access_preview", screen_name: "Access Preview", module_key: "admin" },
  { screen_key: "intercompany_partners", screen_name: "Intercompany Partners", module_key: "admin" },
  { screen_key: "intercompany_dashboard", screen_name: "Intercompany Dashboard", module_key: "purchase" },
  { screen_key: "templates", screen_name: "Templates", module_key: "admin" },
  { screen_key: "rights", screen_name: "Rights Matrix", module_key: "admin" },
  { screen_key: "pilot_feedback", screen_name: "Pilot Notes", module_key: "admin" },
];

function buildLegacyFallback(groupName) {
  const isSuperAdmin = groupName === "SuperAdmin";
  const screens = {};
  const modules = {};

  // Facility / governance screens must never allow-by-default for Staff.
  // Explicit screen_permissions (or SuperAdmin) are required.
  const defaultDenyScreens = new Set([
    "office_admin",
    "hr_admin",
    "management",
    "executive_command",
    "admin_desk",
    "data_ops",
    "marketing",
    "admin_masters",
    "users",
    "rights",
    "user_access_preview",
    "onboarding",
    "product_master",
    "quote_write_ups",
    "job_asset_admin",
    "approval_policy_matrix",
    "intercompany_partners",
    "templates",
    "pilot_feedback",
    "superadmin_home",
  ]);

  for (const screen of SCREEN_CATALOG) {
    const adminScreen = screen.module_key === "admin" || screen.module_key === "management";
    const denyDefault = adminScreen || defaultDenyScreens.has(screen.screen_key);
    screens[screen.screen_key] = {
      can_view: isSuperAdmin ? true : !denyDefault,
      can_create: isSuperAdmin ? true : !denyDefault,
      can_edit: isSuperAdmin ? true : !denyDefault,
      can_approve: isSuperAdmin,
      own_records_only: false,
      financial_masking: false,
    };
  }

  const moduleKeys = ["admin", "masters", "leads", "quotes", "sales_orders", "manufacturing", "purchase", "dispatch", "accounting", "service", "hr", "marketing", "management"];
  for (const moduleKey of moduleKeys) {
    const adminModule = moduleKey === "admin" || moduleKey === "management";
    modules[moduleKey] = {
      can_view: isSuperAdmin ? true : !adminModule,
      can_create: isSuperAdmin ? true : !adminModule,
      can_edit: isSuperAdmin ? true : !adminModule,
      can_approve: isSuperAdmin,
    };
  }

  return { screens, modules };
}

let accessTablesReady = false;
async function hasAccessTables(client) {
  if (accessTablesReady) return true;
  const r = await client.query(
    `select to_regclass('public.access_profile_grants') is not null and to_regclass('public.user_access_overrides') is not null as ready`
  );
  accessTablesReady = Boolean(r.rows[0]?.ready);
  return accessTablesReady;
}

async function loadAccessGrants(client, roleId) {
  if (!Number.isFinite(Number(roleId))) return [];
  const r = await client.query(`select * from access_profile_grants where role_id = $1`, [roleId]);
  return r.rows;
}

async function loadActiveAccessOverrides(client, userId) {
  if (!Number.isFinite(Number(userId))) return [];
  const r = await client.query(
    `
      select *
      from user_access_overrides
      where user_id = $1
        and revoked_at is null
        and (expires_at is null or expires_at > now())
    `,
    [userId]
  );
  return r.rows;
}

async function loadLegacyModules(client, roleId, fallback) {
  const modules = { ...fallback.modules };
  if (!Number.isFinite(Number(roleId))) return modules;
  const r = await client.query(
    `
      select m.module_key, p.can_view, p.can_create, p.can_edit, p.can_approve
      from role_module_permissions p
      join erp_modules m on m.id = p.module_id
      where p.role_id = $1
    `,
    [roleId]
  );
  for (const row of r.rows) {
    modules[row.module_key] = {
      can_view: Boolean(row.can_view),
      can_create: Boolean(row.can_create),
      can_edit: Boolean(row.can_edit),
      can_approve: Boolean(row.can_approve),
    };
  }
  return modules;
}

/**
 * Access Profile model: grants + unexpired user overrides compiled to the same 6 flags.
 * `grants` / `overrides` may be passed in to preview a change before saving it.
 */
async function loadCompiledPermissionMaps(client, roleId, groupName, options = {}) {
  const fallback = buildLegacyFallback(groupName);
  const userId = Number(options.userId);
  const isSuperAdmin = groupName === "SuperAdmin";
  // Deny-by-default (ACCESS_MODEL_V2=on): a screen with no grant is closed instead of falling back to open.
  const denyDefault = options.denyDefault === undefined ? accessModelMode() === "on" : Boolean(options.denyDefault);
  const [grants, overrides, modules] = await Promise.all([
    options.grants || loadAccessGrants(client, roleId),
    options.overrides || (Number.isFinite(userId) ? loadActiveAccessOverrides(client, userId) : []),
    loadLegacyModules(client, roleId, fallback),
  ]);
  const fallbackScreens = denyDefault && !isSuperAdmin ? {} : fallback.screens;
  const screens = compileScreens({ catalog: SCREEN_CATALOG, fallbackScreens, grants, overrides });
  if (isSuperAdmin) {
    // Mirrors hasScreenAction: the SuperAdmin group passes every screen check.
    const full = { can_view: true, can_create: true, can_edit: true, can_approve: true, own_records_only: false, financial_masking: false };
    for (const key of Object.keys(screens)) screens[key] = { ...full };
  }
  return { screens, modules };
}

const shadowMismatchLogged = new Set();
async function loadPermissionMaps(client, roleId, groupName, options = {}) {
  const mode = accessModelMode();
  if (mode === "off" || !(await hasAccessTables(client).catch(() => false))) {
    return loadLegacyPermissionMaps(client, roleId, groupName, options);
  }
  if (mode === "on") return loadCompiledPermissionMaps(client, roleId, groupName, options);

  const legacy = await loadLegacyPermissionMaps(client, roleId, groupName, options);
  if (groupName === "SuperAdmin") return legacy;
  try {
    const compiled = await loadCompiledPermissionMaps(client, roleId, groupName, options);
    const changes = diffScreens(legacy.screens, compiled.screens);
    const key = `${options.userId || "role"}:${roleId}`;
    if (changes.length && !shadowMismatchLogged.has(key)) {
      shadowMismatchLogged.add(key);
      process.stderr.write(
        `[access-v2 shadow] user ${options.userId || "-"} role ${roleId}: ${changes.length} screen(s) differ, e.g. ${JSON.stringify(changes.slice(0, 3))}\n`
      );
    }
  } catch (err) {
    process.stderr.write(`[access-v2 shadow] compile failed: ${err?.message || err}\n`);
  }
  return legacy;
}

async function loadLegacyPermissionMaps(client, roleId, groupName, options = {}) {
  const fallback = buildLegacyFallback(groupName);
  const userId = Number(options.userId);
  if (!Number.isFinite(Number(roleId))) {
    if (!Number.isFinite(userId)) return fallback;
    return applyUserScreenOverrides(client, fallback, userId);
  }

  const [screenRes, moduleRes] = await Promise.all([
    client.query(
      `
        select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
        from screen_permissions
        where role_id = $1
      `,
      [roleId]
    ),
    client.query(
      `
        select m.module_key, p.can_view, p.can_create, p.can_edit, p.can_approve
        from role_module_permissions p
        join erp_modules m on m.id = p.module_id
        where p.role_id = $1
      `,
      [roleId]
    ),
  ]);

  const screens = { ...fallback.screens };
  const modules = { ...fallback.modules };

  for (const row of screenRes.rows) {
    screens[row.screen_key] = {
      can_view: Boolean(row.can_view),
      can_create: Boolean(row.can_create),
      can_edit: Boolean(row.can_edit),
      can_approve: Boolean(row.can_approve),
      own_records_only: Boolean(row.own_records_only),
      financial_masking: Boolean(row.financial_masking),
    };
  }

  for (const row of moduleRes.rows) {
    modules[row.module_key] = {
      can_view: Boolean(row.can_view),
      can_create: Boolean(row.can_create),
      can_edit: Boolean(row.can_edit),
      can_approve: Boolean(row.can_approve),
    };
  }

  const permissions = { screens, modules };
  if (!Number.isFinite(userId)) return permissions;
  return applyUserScreenOverrides(client, permissions, userId);
}

async function applyUserScreenOverrides(client, permissions, userId) {
  const r = await client.query(
    `
      select
        screen_key,
        can_view,
        can_create,
        can_edit,
        can_approve,
        own_records_only,
        financial_masking
      from user_screen_permissions
      where user_id = $1
    `,
    [userId]
  );

  if (!r.rows.length) return permissions;

  const screens = { ...permissions.screens };
  for (const row of r.rows) {
    const current = screens[row.screen_key] || {
      can_view: false,
      can_create: false,
      can_edit: false,
      can_approve: false,
      own_records_only: false,
      financial_masking: false,
    };
    screens[row.screen_key] = {
      can_view: row.can_view === null ? current.can_view : Boolean(row.can_view),
      can_create: row.can_create === null ? current.can_create : Boolean(row.can_create),
      can_edit: row.can_edit === null ? current.can_edit : Boolean(row.can_edit),
      can_approve: row.can_approve === null ? current.can_approve : Boolean(row.can_approve),
      own_records_only: row.own_records_only === null ? current.own_records_only : Boolean(row.own_records_only),
      financial_masking: row.financial_masking === null ? current.financial_masking : Boolean(row.financial_masking),
    };
  }

  return { ...permissions, screens };
}

async function loadCompanyMemberships(client, userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return { companies: [], primaryCompanyId: null };
  const r = await client.query(
    `
      select
        ucm.company_id,
        c.company_code,
        c.display_name,
        c.legal_name,
        ucm.is_primary
      from user_company_memberships ucm
      join companies c on c.id = ucm.company_id and c.is_active = true
      where ucm.user_id = $1 and ucm.is_active = true
      order by ucm.is_primary desc, c.company_code asc, ucm.id asc
    `,
    [id]
  );
  const companies = r.rows.map((row) => ({
    company_id: Number(row.company_id),
    company_code: row.company_code,
    display_name: row.display_name,
    legal_name: row.legal_name,
    is_primary: row.is_primary === true,
  }));
  const primaryCompanyId = companies.find((row) => row.is_primary)?.company_id || companies[0]?.company_id || null;
  return { companies, primaryCompanyId };
}

async function loadUserContextById(client, userId) {
  const { rows } = await client.query(
    `
      select
        u.id,
        u.email,
        u.full_name,
        u.department_key,
        u.group_id,
        u.primary_role_id,
        ug.group_name,
        r.role_name,
        r.role_key,
        r.default_workspace_family as role_workspace_family,
        d.default_workspace_family as department_workspace_family,
        coalesce(u.discount_threshold_pct, ug.max_autonomous_discount_pct) as max_autonomous_discount_pct
      from erp_users u
      join user_groups ug on ug.id = u.group_id
      left join roles r on r.id = u.primary_role_id
      left join departments d on d.department_key = u.department_key
      where u.id = $1 and u.is_active = true and u.is_approved = true and ug.is_active = true
      limit 1
    `,
    [userId]
  );
  const base = rows[0] || null;
  if (!base) return null;
  const permissions = await loadPermissionMaps(client, Number(base.primary_role_id), base.group_name, { userId: base.id });
  const membership = await loadCompanyMemberships(client, base.id);
  return {
    ...base,
    permissions,
    companies: membership.companies,
    primary_company_id: membership.primaryCompanyId,
    access_model: accessModelMode(),
  };
}

async function loadUserContextByEmail(client, email) {
  const { rows } = await client.query(
    `
      select
        u.id,
        u.email,
        u.full_name,
        u.department_key,
        u.group_id,
        u.primary_role_id,
        ug.group_name,
        r.role_name,
        r.role_key,
        r.default_workspace_family as role_workspace_family,
        d.default_workspace_family as department_workspace_family,
        coalesce(u.discount_threshold_pct, ug.max_autonomous_discount_pct) as max_autonomous_discount_pct
      from erp_users u
      join user_groups ug on ug.id = u.group_id
      left join roles r on r.id = u.primary_role_id
      left join departments d on d.department_key = u.department_key
      where u.email = $1 and u.is_active = true and u.is_approved = true and ug.is_active = true
      limit 1
    `,
    [email]
  );
  const base = rows[0] || null;
  if (!base) return null;
  const permissions = await loadPermissionMaps(client, Number(base.primary_role_id), base.group_name, { userId: base.id });
  const membership = await loadCompanyMemberships(client, base.id);
  return {
    ...base,
    permissions,
    companies: membership.companies,
    primary_company_id: membership.primaryCompanyId,
    access_model: accessModelMode(),
  };
}

module.exports = {
  SCREEN_CATALOG,
  buildLegacyFallback,
  loadPermissionMaps,
  loadLegacyPermissionMaps,
  loadCompiledPermissionMaps,
  loadAccessGrants,
  loadActiveAccessOverrides,
  loadUserContextById,
  loadUserContextByEmail,
};
