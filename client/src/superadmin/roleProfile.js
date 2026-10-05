/**
 * Role Profile flatten map — UI picks one role; group + department are derived.
 * Privilege bands stay SuperAdmin / Distributor / Staff|Factory (legacy).
 * Keep in sync with server/src/auth/roleProfile.js
 */

const ROLE_KEY_MAP = {
  super_admin: { groupName: "SuperAdmin", departmentKey: "office_admin" },
  // ERP / Business Admin: Staff band only — never inherits SuperAdmin group bypass
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
  stores: { groupName: "Staff", departmentKey: "stores" },
  hr: { groupName: "Staff", departmentKey: "hr" },
};

/** Display labels for privilege bands (raw group_name stays in DB). */
const PRIVILEGE_BAND_LABELS = {
  SuperAdmin: "Platform admin",
  Distributor: "Channel partner",
  Staff: "Internal staff",
  Factory: "Factory / ops",
};

const HOME_FAMILY_LABELS = {
  superadmin: "Platform Home",
  distributor: "Partner Home",
  sales: "Sales Home",
  marketing: "Marketing Home",
  finance: "Finance Home",
  procurement: "Procurement Home",
  aftermarket: "Aftermarket Home",
  operations: "Operations Home",
  stores: "Stores Home",
  hr: "HR Home",
};

const FAMILY_SORT_ORDER = [
  "superadmin",
  "sales",
  "marketing",
  "distributor",
  "finance",
  "procurement",
  "stores",
  "operations",
  "aftermarket",
  "hr",
];

function pickGroup(groups, preferredName) {
  const list = Array.isArray(groups) ? groups : [];
  const byName = (name) =>
    list.find((g) => String(g.group_name || "").trim().toLowerCase() === String(name || "").trim().toLowerCase());
  if (preferredName === "SuperAdmin") return byName("SuperAdmin") || null;
  if (preferredName === "Distributor") return byName("Distributor") || null;
  return (
    byName(preferredName) ||
    byName("Staff") ||
    byName("Factory") ||
    list.find((g) => !["superadmin", "distributor"].includes(String(g.group_name || "").toLowerCase())) ||
    null
  );
}

function departmentExists(departments, key) {
  if (!key) return false;
  return (departments || []).some((d) => String(d.department_key) === String(key));
}

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

/**
 * @param {{ role_key?: string, role_name?: string, default_workspace_family?: string } | null} role
 * @param {Array<{ id: number|string, group_name: string }>} groups
 * @param {Array<{ department_key: string, department_name?: string }>} departments
 */
export function resolveRoleProfile(role, groups = [], departments = []) {
  const roleKey = String(role?.role_key || "").trim().toLowerCase();
  const family = String(role?.default_workspace_family || "").trim().toLowerCase();

  let preferred = ROLE_KEY_MAP[roleKey] || null;
  if (!preferred) preferred = inferFromRoleName(role?.role_name);
  if (!preferred && family) preferred = FAMILY_FALLBACK[family] || null;
  if (!preferred) preferred = { groupName: "Staff", departmentKey: null };

  const group = pickGroup(groups, preferred.groupName);
  let departmentKey = preferred.departmentKey;
  if (departmentKey && !departmentExists(departments, departmentKey)) {
    departmentKey = null;
  }

  const groupName = group?.group_name || preferred.groupName || "";
  return {
    roleKey: roleKey || null,
    groupId: group?.id != null ? String(group.id) : "",
    groupName,
    privilegeBandLabel: PRIVILEGE_BAND_LABELS[groupName] || groupName || "Internal",
    departmentKey: departmentKey || "",
    workspaceFamily: family || null,
    homeFamilyLabel: HOME_FAMILY_LABELS[family] || (family ? `${family} Home` : null),
    roleName: role?.role_name || "",
  };
}

export function applyRoleProfileToForm(prev, role, groups, departments) {
  const mapped = resolveRoleProfile(role, groups, departments);
  return {
    ...prev,
    role_id: role?.id != null ? String(role.id) : "",
    group_id: mapped.groupId,
    department_key: mapped.departmentKey,
  };
}

export function formatHomeFamilyLabel(family) {
  const key = String(family || "").trim().toLowerCase();
  if (!key) return "Not set";
  return HOME_FAMILY_LABELS[key] || `${key} Home`;
}

export function formatPrivilegeBandLabel(groupName) {
  const name = String(groupName || "").trim();
  return PRIVILEGE_BAND_LABELS[name] || name || "Internal";
}

export function formatRoleProfileSummary(mapped, departments = []) {
  const dept = (departments || []).find((d) => String(d.department_key) === String(mapped.departmentKey));
  const parts = [
    mapped.privilegeBandLabel || mapped.groupName ? `Access: ${mapped.privilegeBandLabel || mapped.groupName}` : null,
    dept?.department_name || mapped.departmentKey ? `Dept: ${dept?.department_name || mapped.departmentKey}` : null,
    mapped.homeFamilyLabel || mapped.workspaceFamily
      ? `Home: ${mapped.homeFamilyLabel || formatHomeFamilyLabel(mapped.workspaceFamily)}`
      : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Sort roles into Home-family buckets for the Role Profile select. */
export function groupRolesForSelect(roles = []) {
  const buckets = new Map();
  for (const role of roles || []) {
    const family = String(role?.default_workspace_family || "").trim().toLowerCase() || "other";
    if (!buckets.has(family)) buckets.set(family, []);
    buckets.get(family).push(role);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => String(a.role_name || "").localeCompare(String(b.role_name || "")));
  }
  const ordered = [];
  for (const family of FAMILY_SORT_ORDER) {
    if (buckets.has(family)) {
      ordered.push({ family, label: formatHomeFamilyLabel(family), roles: buckets.get(family) });
      buckets.delete(family);
    }
  }
  for (const [family, list] of Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    ordered.push({
      family,
      label: family === "other" ? "Other profiles" : formatHomeFamilyLabel(family),
      roles: list,
    });
  }
  return ordered;
}
