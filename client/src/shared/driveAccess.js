/**
 * Drive category RBAC — upload vs view.
 * Keep in sync with server/src/auth/driveAccess.js
 */

export const DRIVE_CATEGORIES = Object.freeze([
  "statutory",
  "model_asset",
  "marketing_collateral",
  "service_amc",
]);

const UPLOAD_BY_LANE = Object.freeze({
  finance: ["statutory"],
  management: ["statutory"],
  engineering: ["model_asset"],
  marketing: ["marketing_collateral"],
  service: ["service_amc"],
  sales: [],
  superadmin: [...DRIVE_CATEGORIES],
});

const VIEW_BY_LANE = Object.freeze({
  finance: ["statutory"],
  management: ["statutory"],
  engineering: ["model_asset"],
  marketing: ["marketing_collateral"],
  service: ["service_amc", "model_asset"],
  sales: ["marketing_collateral", "model_asset"],
  superadmin: [...DRIVE_CATEGORIES],
});

export function normalizeCategory(category) {
  const value = String(category || "")
    .trim()
    .toLowerCase();
  return DRIVE_CATEGORIES.includes(value) ? value : null;
}

function signalBlob(user) {
  return [
    user?.group_name,
    user?.role_key,
    user?.role_name,
    user?.department_key,
    user?.role_workspace_family,
    user?.department_workspace_family,
  ]
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

export function resolveDriveLane(user) {
  if (!user) return null;
  const group = String(user.group_name || "")
    .trim()
    .toLowerCase();
  if (group === "superadmin") return "superadmin";

  const roleKey = String(user.role_key || "")
    .trim()
    .toLowerCase();
  const department = String(user.department_key || "")
    .trim()
    .toLowerCase();
  const family = String(user.role_workspace_family || user.department_workspace_family || "")
    .trim()
    .toLowerCase();
  const hay = signalBlob(user);

  if (roleKey === "management" || /\bmanagement\b/.test(hay)) return "management";
  if (department === "accounts" || family === "finance" || roleKey === "accounts" || /(account|finance|cfo|controller)/.test(hay)) {
    return "finance";
  }
  if (department === "engineering" || roleKey === "design_engineer" || /(design.?engineer|engineering)/.test(hay)) {
    return "engineering";
  }
  if (department === "marketing" || family === "marketing" || roleKey === "marketing" || /market/.test(hay)) {
    return "marketing";
  }
  if (
    department === "service" ||
    family === "aftermarket" ||
    roleKey === "post_sales" ||
    roleKey === "service_engineer" ||
    /(after\s*market|post\s*sales|service)/.test(hay)
  ) {
    return "service";
  }
  if (
    department === "sales" ||
    family === "sales" ||
    family === "distributor" ||
    group === "distributor" ||
    /sales|commercial|regional|distributor/.test(hay)
  ) {
    return "sales";
  }
  return null;
}

function listForLane(map, lane) {
  if (!lane) return [];
  return [...(map[lane] || [])];
}

export function canUploadDrive(user, category) {
  const cat = normalizeCategory(category);
  if (!cat || !user) return false;
  if (String(user.group_name || "") === "SuperAdmin") return true;
  const lane = resolveDriveLane(user);
  return listForLane(UPLOAD_BY_LANE, lane).includes(cat);
}

export function canViewDrive(user, category) {
  const cat = normalizeCategory(category);
  if (!cat || !user) return false;
  if (String(user.group_name || "") === "SuperAdmin") return true;
  const lane = resolveDriveLane(user);
  return listForLane(VIEW_BY_LANE, lane).includes(cat);
}

export function driveCapabilities(user) {
  const lane = resolveDriveLane(user);
  const upload = [];
  const view = [];
  for (const category of DRIVE_CATEGORIES) {
    if (canUploadDrive(user, category)) upload.push(category);
    if (canViewDrive(user, category)) view.push(category);
  }
  return {
    lane,
    categories: [...DRIVE_CATEGORIES],
    can_upload: upload,
    can_view: view,
  };
}

export function driveViewUrl(driveFileId, { download = false } = {}) {
  const id = encodeURIComponent(String(driveFileId || "").trim());
  if (!id) return null;
  return download ? `/drive/view/${id}?download=1` : `/drive/view/${id}`;
}

export const DRIVE_CATEGORY_LABELS = Object.freeze({
  statutory: "Statutory documents",
  model_asset: "Machine & model assets",
  marketing_collateral: "Marketing collateral",
  service_amc: "Service & AMC files",
});
