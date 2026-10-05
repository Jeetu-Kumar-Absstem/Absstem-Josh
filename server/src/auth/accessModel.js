const FLAG_KEYS = ["can_view", "can_create", "can_edit", "can_approve", "own_records_only", "financial_masking"];

// The 12 business modules edited on the Access Profile grid. "admin" screens stay screen-level only.
const ACCESS_MODULES = [
  { module_key: "leads", label: "Leads" },
  { module_key: "masters", label: "Customers & Masters" },
  { module_key: "quotes", label: "Quotes & Sales Desk" },
  { module_key: "sales_orders", label: "Sales Orders" },
  { module_key: "dispatch", label: "Dispatch" },
  { module_key: "accounting", label: "Accounts & Finance" },
  { module_key: "service", label: "Service" },
  { module_key: "manufacturing", label: "Manufacturing & Stores" },
  { module_key: "purchase", label: "Purchase" },
  { module_key: "hr", label: "HR & Office" },
  { module_key: "marketing", label: "Marketing" },
  { module_key: "management", label: "Management" },
];
const ACCESS_MODULE_KEYS = new Set(ACCESS_MODULES.map((m) => m.module_key));

const LEVELS = ["none", "viewer", "contributor", "approver"];
const LEVEL_FLAGS = {
  none: { can_view: false, can_create: false, can_edit: false, can_approve: false },
  viewer: { can_view: true, can_create: false, can_edit: false, can_approve: false },
  contributor: { can_view: true, can_create: true, can_edit: true, can_approve: false },
  approver: { can_view: true, can_create: true, can_edit: true, can_approve: true },
};

// Quotes already widen "own records only" to the reporting tree (quoteTeamScope), so Team is quotes-only.
function isTeamScopeTarget({ module_key: moduleKey, screen_key: screenKey }) {
  return moduleKey === "quotes" || screenKey === "quotes";
}

function accessModelMode() {
  const raw = String(process.env.ACCESS_MODEL_V2 || "off").trim().toLowerCase();
  return raw === "on" || raw === "shadow" ? raw : "off";
}

function emptyFlags() {
  return { can_view: false, can_create: false, can_edit: false, can_approve: false, own_records_only: false, financial_masking: false };
}

function levelToFlags(level, scope) {
  const base = LEVEL_FLAGS[level];
  if (!base) return null;
  return {
    ...base,
    own_records_only: level !== "none" && (scope === "own" || scope === "team"),
    financial_masking: false,
  };
}

function grantToFlags(grant) {
  if (!grant) return null;
  if (grant.level === "custom") {
    const out = {};
    for (const k of FLAG_KEYS) out[k] = Boolean(grant[k]);
    return out;
  }
  return levelToFlags(grant.level, grant.scope);
}

/** Exact inverse of levelToFlags; null when the combination needs a Custom grant. */
function flagsToLevel(flags, target = {}) {
  if (!flags || flags.financial_masking) return null;
  for (const level of LEVELS) {
    const lf = LEVEL_FLAGS[level];
    if (!["can_view", "can_create", "can_edit", "can_approve"].every((k) => Boolean(flags[k]) === lf[k])) continue;
    if (level === "none") return flags.own_records_only ? null : { level, scope: "all" };
    const scope = flags.own_records_only ? (isTeamScopeTarget(target) ? "team" : "own") : "all";
    return { level, scope };
  }
  return null;
}

function normalizeScope(scope, target) {
  const s = String(scope || "all");
  if (s === "team") return isTeamScopeTarget(target) ? "team" : null;
  if (s === "own") return isTeamScopeTarget(target) ? "team" : "own";
  return s === "all" ? "all" : null;
}

/**
 * Validates one proposed grant; returns { grant } or { error }.
 * Custom grants may only be kept as they are (they come from migrated legacy rows).
 */
function normalizeGrant(input, { screenKeys }) {
  const moduleKey = input?.module_key ? String(input.module_key).trim() : null;
  const screenKey = input?.screen_key ? String(input.screen_key).trim() : null;
  if (Boolean(moduleKey) === Boolean(screenKey)) return { error: "GRANT_TARGET_REQUIRED" };
  if (moduleKey && !ACCESS_MODULE_KEYS.has(moduleKey)) return { error: `UNKNOWN_MODULE:${moduleKey}` };
  if (screenKey && !screenKeys.has(screenKey)) return { error: `UNKNOWN_SCREEN:${screenKey}` };
  const target = { module_key: moduleKey, screen_key: screenKey };
  const level = String(input.level || "");
  if (level === "custom") {
    const flags = {};
    for (const k of FLAG_KEYS) flags[k] = Boolean(input[k]);
    return { grant: { ...target, level, scope: flags.own_records_only ? "own" : "all", ...flags } };
  }
  if (!LEVELS.includes(level)) return { error: `INVALID_LEVEL:${level}` };
  const scope = level === "none" ? "all" : normalizeScope(input.scope, target);
  if (!scope) return { error: `INVALID_SCOPE:${input.scope}` };
  return { grant: { ...target, level, scope } };
}

/**
 * Compile Access Profile grants + user overrides into the legacy screens map.
 * Precedence per screen: user override > screen grant > module grant > default (legacy group fallback).
 */
function compileScreens({ catalog, fallbackScreens, grants = [], overrides = [] }) {
  const moduleGrants = new Map();
  const screenGrants = new Map();
  for (const g of grants) {
    if (g.module_key) moduleGrants.set(g.module_key, g);
    else if (g.screen_key) screenGrants.set(g.screen_key, g);
  }

  const screens = {};
  for (const [key, flags] of Object.entries(fallbackScreens || {})) screens[key] = { ...flags };
  for (const screen of catalog) {
    const g = screenGrants.get(screen.screen_key) || moduleGrants.get(screen.module_key);
    if (g) screens[screen.screen_key] = grantToFlags(g);
  }
  for (const [key, g] of screenGrants) {
    if (!screens[key] || !catalog.some((s) => s.screen_key === key)) screens[key] = grantToFlags(g);
  }

  for (const o of overrides) {
    const current = screens[o.screen_key] || emptyFlags();
    if (o.level === "custom") {
      const next = { ...current };
      for (const k of FLAG_KEYS) if (o[k] !== null && o[k] !== undefined) next[k] = Boolean(o[k]);
      screens[o.screen_key] = next;
    } else {
      screens[o.screen_key] = levelToFlags(o.level, o.scope) || current;
    }
  }
  return screens;
}

/** Where each screen's permission came from, for explain mode and the editor. */
function explainScreens({ catalog, grants = [], overrides = [] }) {
  const moduleGrants = new Map();
  const screenGrants = new Map();
  for (const g of grants) {
    if (g.module_key) moduleGrants.set(g.module_key, g);
    else if (g.screen_key) screenGrants.set(g.screen_key, g);
  }
  const overrideMap = new Map(overrides.map((o) => [o.screen_key, o]));
  const out = {};
  const keys = new Set([...catalog.map((s) => s.screen_key), ...screenGrants.keys(), ...overrideMap.keys()]);
  for (const key of keys) {
    const screen = catalog.find((s) => s.screen_key === key);
    const o = overrideMap.get(key);
    const sg = screenGrants.get(key);
    const mg = screen ? moduleGrants.get(screen.module_key) : null;
    if (o) out[key] = { source: "user_override", level: o.level, scope: o.scope, reason: o.reason, expires_at: o.expires_at || null };
    else if (sg) out[key] = { source: "screen_grant", level: sg.level, scope: sg.scope };
    else if (mg) out[key] = { source: "module_grant", level: mg.level, scope: mg.scope, module_key: mg.module_key };
    else out[key] = { source: "default" };
  }
  return out;
}

function diffScreens(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    const a = before?.[key] || emptyFlags();
    const b = after?.[key] || emptyFlags();
    const gained = [];
    const lost = [];
    for (const k of FLAG_KEYS) {
      if (Boolean(a[k]) === Boolean(b[k])) continue;
      // own_records_only / financial_masking narrow access, so turning them on is a loss.
      const narrowing = k === "own_records_only" || k === "financial_masking";
      if (Boolean(b[k]) !== narrowing) gained.push(k);
      else lost.push(k);
    }
    if (gained.length || lost.length) changes.push({ screen_key: key, gained, lost });
  }
  return changes.sort((x, y) => x.screen_key.localeCompare(y.screen_key));
}

module.exports = {
  FLAG_KEYS,
  ACCESS_MODULES,
  ACCESS_MODULE_KEYS,
  LEVELS,
  accessModelMode,
  levelToFlags,
  grantToFlags,
  flagsToLevel,
  normalizeGrant,
  isTeamScopeTarget,
  compileScreens,
  explainScreens,
  diffScreens,
};
