/**
 * Role Profile flatten map — role drives group band + department_key.
 * Keep in sync with client/src/superadmin/roleProfile.js
 */

const ROLE_KEY_MAP = {
  super_admin: { groupName: "SuperAdmin", departmentKey: "office_admin" },
  // ERP / Business Admin: Staff band only — screen grants (admin_masters, templates), never SuperAdmin bypass
  business_admin: { groupName: "Staff", departmentKey: "office_admin" },
  management: { groupName: "Staff", departmentKey: "office_admin" },
  commercial_manager: { groupName: "Staff", departmentKey: "sales" },
  sales_head: { groupName: "Staff", departmentKey: "sales" },
  sales_executive: { groupName: "Staff", departmentKey: "sales" },
  regional_head: { groupName: "Staff", departmentKey: "sales" },
  distributor: { groupName: "Distributor", departmentKey: "sales" },
  marketing: { groupName: "Staff", departmentKey: "marketing" },
  factory: { groupName: "Factory", departmentKey: "production" },
  purchase: { groupName: "Staff", departmentKey: "purchase" },
  stores: { groupName: "Staff", departmentKey: "stores" },
  dispatch: { groupName: "Factory", departmentKey: "dispatch" },
  accounts: { groupName: "Staff", departmentKey: "accounts" },
  qa: { groupName: "Factory", departmentKey: "production" },
  post_sales: { groupName: "Staff", departmentKey: "service" },
  service_engineer: { groupName: "Staff", departmentKey: "service" },
  design_engineer: { groupName: "Staff", departmentKey: "engineering" },
  engineering_approver: { groupName: "Staff", departmentKey: "engineering" },
  production_planner: { groupName: "Factory", departmentKey: "production" },
  hr: { groupName: "Staff", departmentKey: "hr" },
};

const FAMILY_FALLBACK = {
  superadmin: { groupName: "SuperAdmin", departmentKey: "office_admin" },
  distributor: { groupName: "Distributor", departmentKey: "sales" },
  sales: { groupName: "Staff", departmentKey: "sales" },
  marketing: { groupName: "Staff", departmentKey: "marketing" },
  finance: { groupName: "Staff", departmentKey: "accounts" },
  procurement: { groupName: "Staff", departmentKey: "purchase" },
  aftermarket: { groupName: "Staff", departmentKey: "service" },
  operations: { groupName: "Factory", departmentKey: "production" },
  dispatch: { groupName: "Factory", departmentKey: "dispatch" },
  stores: { groupName: "Staff", departmentKey: "stores" },
  hr: { groupName: "Staff", departmentKey: "hr" },
  executive: { groupName: "Staff", departmentKey: "office_admin" },
  office: { groupName: "Staff", departmentKey: "office_admin" },
  employee: { groupName: "Staff", departmentKey: null },
};

function inferFromRoleName(roleName) {
  const hay = String(roleName || "").toLowerCase();
  if (!hay) return null;
  if (/super\s*admin|platform/.test(hay)) return ROLE_KEY_MAP.super_admin;
  if (/distributor|channel\s*partner/.test(hay)) return ROLE_KEY_MAP.distributor;
  if (/business\s*admin/.test(hay)) return ROLE_KEY_MAP.business_admin;
  if (/sales\s*head|head\s*of\s*sales/.test(hay)) return ROLE_KEY_MAP.sales_head;
  if (/sales|commercial|regional/.test(hay)) return ROLE_KEY_MAP.sales_executive;
  if (/market/.test(hay)) return ROLE_KEY_MAP.marketing;
  if (/purchase|procure|buyer/.test(hay)) return ROLE_KEY_MAP.purchase;
  if (/store|warehouse/.test(hay)) return ROLE_KEY_MAP.stores;
  if (/account|finance|cfo|controller/.test(hay)) return ROLE_KEY_MAP.accounts;
  if (/service|after\s*market|amc|post\s*sales/.test(hay)) return ROLE_KEY_MAP.post_sales;
  if (/design|engineer/.test(hay)) return ROLE_KEY_MAP.design_engineer;
  if (/dispatch|logistics/.test(hay)) return ROLE_KEY_MAP.dispatch;
  if (/qa|quality/.test(hay)) return ROLE_KEY_MAP.qa;
  if (/planner|production|factory|plant/.test(hay)) return ROLE_KEY_MAP.factory;
  if (/\bhr\b|human\s*resource/.test(hay)) return ROLE_KEY_MAP.hr;
  if (/manage|director|ceo/.test(hay)) return ROLE_KEY_MAP.management;
  return null;
}

function pickGroupName(preferredName, availableNames) {
  const set = new Set((availableNames || []).map((n) => String(n || "").trim().toLowerCase()));
  const has = (name) => set.has(String(name).toLowerCase());
  if (preferredName === "SuperAdmin") return has("SuperAdmin") ? "SuperAdmin" : null;
  if (preferredName === "Distributor") return has("Distributor") ? "Distributor" : null;
  if (has(preferredName)) return preferredName;
  if (has("Staff")) return "Staff";
  if (has("Factory")) return "Factory";
  return preferredName || "Staff";
}

/**
 * Resolve preferred group_name + department_key for a role row.
 * @param {{ role_key?: string, role_name?: string, default_workspace_family?: string } | null} role
 * @param {{ groupNames?: string[], departmentKeys?: string[] }} catalog
 */
function resolveRoleProfile(role, catalog = {}) {
  const roleKey = String(role?.role_key || "").trim().toLowerCase();
  const family = String(role?.default_workspace_family || "").trim().toLowerCase();

  let preferred = ROLE_KEY_MAP[roleKey] || null;
  if (!preferred) preferred = inferFromRoleName(role?.role_name);
  if (!preferred && family) preferred = FAMILY_FALLBACK[family] || null;
  if (!preferred) preferred = { groupName: "Staff", departmentKey: null };

  const groupName = pickGroupName(preferred.groupName, catalog.groupNames);
  let departmentKey = preferred.departmentKey || null;
  const deptKeys = new Set((catalog.departmentKeys || []).map((k) => String(k)));
  if (departmentKey && deptKeys.size && !deptKeys.has(departmentKey)) {
    departmentKey = null;
  }

  return { groupName, departmentKey, roleKey: roleKey || null, workspaceFamily: family || null };
}

module.exports = {
  ROLE_KEY_MAP,
  resolveRoleProfile,
};
