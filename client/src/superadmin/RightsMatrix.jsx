import { useEffect, useMemo, useRef, useState } from "react";
import { DESK_VISIBILITY } from "../home/deskVisibility";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const MODULE_FLAGS = [
  { key: "can_view", label: "View", accent: "#1d4ed8" },
  { key: "can_create", label: "Create", accent: "#0f766e" },
  { key: "can_edit", label: "Edit", accent: "#7c3aed" },
  { key: "can_approve", label: "Approve", accent: "#b45309" },
];

const SCREEN_FLAGS = [
  { key: "can_view", label: "View", accent: "#1d4ed8" },
  { key: "can_create", label: "Create", accent: "#0f766e" },
  { key: "can_edit", label: "Edit", accent: "#7c3aed" },
  { key: "can_approve", label: "Approve", accent: "#b45309" },
  { key: "own_records_only", label: "Own only", accent: "#0f766e" },
];

const DESK_PREVIEW = DESK_VISIBILITY;

// Mirrors buildLegacyFallback in server/src/auth/userContext.js; keep the two in sync.
const DEFAULT_DENY_SCREENS = new Set([
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

function screenFallback(isSuper, screen) {
  const moduleKey = screen?.module_key;
  const deny = moduleKey === "admin" || moduleKey === "management" || DEFAULT_DENY_SCREENS.has(screen?.screen_key);
  return {
    can_view: isSuper || !deny,
    can_create: isSuper || !deny,
    can_edit: isSuper || !deny,
    can_approve: isSuper,
    own_records_only: false,
    financial_masking: false,
  };
}

function moduleFallback(isSuper, moduleKey) {
  const adminModule = moduleKey === "admin" || moduleKey === "management";
  return {
    can_view: isSuper || !adminModule,
    can_create: isSuper || !adminModule,
    can_edit: isSuper || !adminModule,
    can_approve: isSuper,
  };
}

function buildRoleRows(roleId, rolesList, modulesList, screensList, data) {
  const role = rolesList.find((r) => String(r.id) === String(roleId));
  const isSuper = role?.role_key === "super_admin";
  const modulePerms = Array.isArray(data?.role_module_permissions) ? data.role_module_permissions : [];
  const screenPerms = Array.isArray(data?.screen_permissions) ? data.screen_permissions : [];

  const moduleRows = modulesList.map((m) => {
    const existing = modulePerms.find((p) => String(p.role_id) === String(roleId) && p.module_key === m.module_key);
    const base = moduleFallback(isSuper, m.module_key);
    return {
      module_key: m.module_key,
      module_name: m.module_name,
      can_view: existing ? Boolean(existing.can_view) : base.can_view,
      can_create: existing ? Boolean(existing.can_create) : base.can_create,
      can_edit: existing ? Boolean(existing.can_edit) : base.can_edit,
      can_approve: existing ? Boolean(existing.can_approve) : base.can_approve,
    };
  });

  const screenRows = screensList.map((s) => {
    const existing = screenPerms.find((p) => String(p.role_id) === String(roleId) && p.screen_key === s.screen_key);
    const base = screenFallback(isSuper, s);
    return {
      screen_key: s.screen_key,
      screen_name: s.screen_name,
      module_key: s.module_key,
      can_view: existing ? Boolean(existing.can_view) : base.can_view,
      can_create: existing ? Boolean(existing.can_create) : base.can_create,
      can_edit: existing ? Boolean(existing.can_edit) : base.can_edit,
      can_approve: existing ? Boolean(existing.can_approve) : base.can_approve,
      own_records_only: existing ? Boolean(existing.own_records_only) : base.own_records_only,
      financial_masking: existing ? Boolean(existing.financial_masking) : base.financial_masking,
    };
  });

  return { moduleRows, screenRows };
}

function summarizeDiff(currentRows, initialRows, keyField, flagFields) {
  const baseMap = new Map((initialRows || []).map((row) => [row[keyField], row]));
  let changedFlags = 0;
  let changedRows = 0;
  let newlyVisible = 0;

  for (const row of currentRows || []) {
    const base = baseMap.get(row[keyField]);
    let rowChanged = false;
    for (const field of flagFields) {
      if (Boolean(row[field]) !== Boolean(base?.[field])) {
        changedFlags += 1;
        rowChanged = true;
      }
    }
    if (rowChanged) changedRows += 1;
    if (row.can_view && !base?.can_view) newlyVisible += 1;
  }

  return { changedFlags, changedRows, newlyVisible };
}

const SCREEN_FLAG_FIELDS = ["can_view", "can_create", "can_edit", "can_approve", "own_records_only", "financial_masking"];

function changedScreenRows(currentRows, initialRows) {
  const baseMap = new Map((initialRows || []).map((row) => [row.screen_key, row]));
  return (currentRows || [])
    .filter((row) => {
      const base = baseMap.get(row.screen_key);
      return !base || SCREEN_FLAG_FIELDS.some((field) => Boolean(row[field]) !== Boolean(base[field]));
    })
    .map((row) => {
      const payload = { screen_key: row.screen_key };
      for (const field of SCREEN_FLAG_FIELDS) payload[field] = Boolean(row[field]);
      return payload;
    });
}

function triStateToValue(value) {
  if (value === true) return "allow";
  if (value === false) return "block";
  return "inherit";
}

function valueToTriState(value) {
  if (value === "allow") return true;
  if (value === "block") return false;
  return null;
}

function mergePermissions(rolePermissions, overrides) {
  const next = {
    modules: { ...(rolePermissions?.modules || {}) },
    screens: {},
  };
  const baseScreens = rolePermissions?.screens || {};
  for (const [screenKey, row] of Object.entries(baseScreens)) {
    const override = overrides?.[screenKey] || {};
    next.screens[screenKey] = {
      can_view: override.can_view === null || override.can_view === undefined ? Boolean(row.can_view) : Boolean(override.can_view),
      can_create: override.can_create === null || override.can_create === undefined ? Boolean(row.can_create) : Boolean(override.can_create),
      can_edit: override.can_edit === null || override.can_edit === undefined ? Boolean(row.can_edit) : Boolean(override.can_edit),
      can_approve: override.can_approve === null || override.can_approve === undefined ? Boolean(row.can_approve) : Boolean(override.can_approve),
      own_records_only:
        override.own_records_only === null || override.own_records_only === undefined ? Boolean(row.own_records_only) : Boolean(override.own_records_only),
      financial_masking:
        override.financial_masking === null || override.financial_masking === undefined
          ? Boolean(row.financial_masking)
          : Boolean(override.financial_masking),
    };
  }
  return next;
}

function buildOverrideMap(rows, screens) {
  const byKey = new Map((rows || []).map((row) => [row.screen_key, row]));
  const next = {};
  for (const screen of screens || []) {
    const row = byKey.get(screen.screen_key);
    next[screen.screen_key] = {
      screen_key: screen.screen_key,
      can_view: row?.can_view ?? null,
      can_create: row?.can_create ?? null,
      can_edit: row?.can_edit ?? null,
      can_approve: row?.can_approve ?? null,
      own_records_only: row?.own_records_only ?? null,
      financial_masking: row?.financial_masking ?? null,
    };
  }
  return next;
}

function countOverrideFlags(overrideMap) {
  return Object.values(overrideMap || {}).reduce(
    (total, row) =>
      total +
      SCREEN_FLAGS.reduce((count, field) => count + (row?.[field.key] === null || row?.[field.key] === undefined ? 0 : 1), 0),
    0
  );
}

function SurfaceCard({ title, subtitle, actions, children }) {
  return (
    <section
      style={{
        border: "1px solid #d7dfed",
        borderRadius: 24,
        background: "#fff",
        padding: 18,
        boxShadow: "0 18px 40px rgba(15, 23, 42, 0.07)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.58 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.74, marginTop: 6 }}>{subtitle}</div> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function StatCard({ label, value, note, accent }) {
  return (
    <div
      style={{
        border: "1px solid #d7dfed",
        borderRadius: 18,
        background: "#fff",
        padding: 14,
        boxShadow: "0 14px 28px rgba(15, 23, 42, 0.06)",
        borderTop: `4px solid ${accent}`,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>{note}</div>
    </div>
  );
}

function SectionPill({ children, tone = "#eef4ff", color = "#1d4ed8" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        padding: "7px 10px",
        background: tone,
        color,
        fontWeight: 700,
        fontSize: 12,
      }}
    >
      {children}
    </span>
  );
}

function FocusActionCard({ title, note, tone, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        borderRadius: 18,
        padding: 14,
        border: active ? `1px solid ${tone}` : "1px solid #d7dfed",
        background: active ? "rgba(29, 78, 216, 0.06)" : "#fff",
        boxShadow: active ? "0 12px 28px rgba(29, 78, 216, 0.12)" : "0 10px 22px rgba(15, 23, 42, 0.05)",
        display: "grid",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 14, color: tone }}>{title}</strong>
      <span style={{ fontSize: 12, opacity: 0.74, lineHeight: 1.5 }}>{note}</span>
    </button>
  );
}

function ToggleChip({ active, label, accent, onToggle }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!active)}
      style={{
        minWidth: 76,
        borderRadius: 999,
        border: `1px solid ${active ? accent : "#d5ddeb"}`,
        background: active ? accent : "#fff",
        color: active ? "#fff" : "#334155",
        fontWeight: 700,
        fontSize: 12,
        padding: "7px 10px",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function FlagSelect({ value, onChange }) {
  return (
    <select
      value={triStateToValue(value)}
      onChange={(event) => onChange(valueToTriState(event.target.value))}
      style={{
        width: "100%",
        borderRadius: 10,
        border: "1px solid #cad5e5",
        background: "#fff",
        padding: "8px 10px",
        fontSize: 12,
      }}
    >
      <option value="inherit">Inherit</option>
      <option value="allow">Allow</option>
      <option value="block">Block</option>
    </select>
  );
}

function tableCellStyle(sticky = false, stickyLeft = false) {
  return {
    padding: 12,
    borderBottom: "1px solid #e9eef6",
    verticalAlign: "top",
    background: sticky ? "#f8fbff" : "#fff",
    position: sticky || stickyLeft ? "sticky" : "static",
    top: sticky ? 0 : "auto",
    left: stickyLeft ? 0 : "auto",
    zIndex: sticky && stickyLeft ? 3 : sticky || stickyLeft ? 2 : "auto",
  };
}

export default function RightsMatrix({ onNavigate }) {
  const roleSelectRef = useRef(null);
  const moduleSearchRef = useRef(null);
  const screenSearchRef = useRef(null);
  const drawerButtonRef = useRef(null);
  const saveButtonRef = useRef(null);
  const moduleGridRef = useRef(null);
  const screenGridRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [moduleQuery, setModuleQuery] = useState("");
  const [screenQuery, setScreenQuery] = useState("");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [roles, setRoles] = useState([]);
  const [modules, setModules] = useState([]);
  const [screens, setScreens] = useState([]);
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [copyRoleId, setCopyRoleId] = useState("");
  const [moduleRows, setModuleRows] = useState([]);
  const [screenRows, setScreenRows] = useState([]);
  const [bootstrapData, setBootstrapData] = useState(null);
  const [initialState, setInitialState] = useState({ moduleRows: [], screenRows: [] });

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [userSearch, setUserSearch] = useState("");
  const [drawerScreenSearch, setDrawerScreenSearch] = useState("");
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerSaving, setDrawerSaving] = useState(false);
  const [drawerError, setDrawerError] = useState("");
  const [drawerNotice, setDrawerNotice] = useState("");
  const [drawerDetail, setDrawerDetail] = useState(null);
  const [overrideMap, setOverrideMap] = useState({});
  const [initialOverrideMap, setInitialOverrideMap] = useState({});

  async function loadData(forcedRoleId, { preserveNotice = false } = {}) {
    setLoading(true);
    setError("");
    if (!preserveNotice) setNotice("");
    try {
      const data = await apiFetch("/permissions/bootstrap");
      const rolesList = Array.isArray(data?.roles) ? data.roles : [];
      const modulesList = Array.isArray(data?.modules) ? data.modules : [];
      const screensList = Array.isArray(data?.screens) ? data.screens : [];
      setBootstrapData(data);
      setRoles(rolesList);
      setModules(modulesList);
      setScreens(screensList);

      const firstRoleId = forcedRoleId || selectedRoleId || (rolesList[0] ? String(rolesList[0].id) : "");
      setSelectedRoleId(firstRoleId);
      const nextRows = buildRoleRows(firstRoleId, rolesList, modulesList, screensList, data);
      setModuleRows(nextRows.moduleRows);
      setScreenRows(nextRows.screenRows);
      setInitialState(nextRows);
      setCopyRoleId((current) => (current && current !== firstRoleId ? current : ""));
    } catch (e) {
      setError(e?.data?.error || "Failed to load Rights Matrix.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData().catch(() => {});
  }, []);

  useEffect(() => {
    if (users.length || loadingUsers) return;
    let active = true;
    setLoadingUsers(true);
    apiFetch("/users")
      .then((data) => {
        if (!active) return;
        const nextUsers = Array.isArray(data?.users) ? data.users : [];
        setUsers(nextUsers);
        setSelectedUserId((current) => current || nextUsers[0]?.id || null);
      })
      .catch((e) => {
        if (!active) return;
        setDrawerError(e?.data?.error || "Failed to load users.");
      })
      .finally(() => {
        if (active) setLoadingUsers(false);
      });
    return () => {
      active = false;
    };
  }, [users.length, loadingUsers]);

  useEffect(() => {
    if (!drawerOpen || !selectedUserId) return;
    let active = true;
    setDrawerLoading(true);
    setDrawerError("");
    setDrawerNotice("");
    apiFetch(`/permissions/user/${selectedUserId}/effective`)
      .then((data) => {
        if (!active) return;
        const nextOverrides = buildOverrideMap(data?.user_screen_permissions, data?.screens);
        setDrawerDetail(data);
        setOverrideMap(nextOverrides);
        setInitialOverrideMap(nextOverrides);
      })
      .catch((e) => {
        if (!active) return;
        setDrawerError(e?.data?.error || "Failed to load user access preview.");
      })
      .finally(() => {
        if (active) setDrawerLoading(false);
      });
    return () => {
      active = false;
    };
  }, [drawerOpen, selectedUserId]);

  const selectedRole = useMemo(() => roles.find((r) => String(r.id) === String(selectedRoleId)) || null, [roles, selectedRoleId]);

  const moduleDiff = useMemo(
    () => summarizeDiff(moduleRows, initialState.moduleRows, "module_key", MODULE_FLAGS.map((field) => field.key)),
    [moduleRows, initialState.moduleRows]
  );
  const screenDiff = useMemo(
    () => summarizeDiff(screenRows, initialState.screenRows, "screen_key", SCREEN_FLAGS.map((field) => field.key)),
    [screenRows, initialState.screenRows]
  );
  const isDirty = moduleDiff.changedFlags > 0 || screenDiff.changedFlags > 0;

  const filteredModuleRows = useMemo(() => {
    const q = moduleQuery.trim().toLowerCase();
    if (!q) return moduleRows;
    return moduleRows.filter((row) => [row.module_name, row.module_key].some((value) => String(value || "").toLowerCase().includes(q)));
  }, [moduleRows, moduleQuery]);

  const groupedScreenRows = useMemo(() => {
    const q = screenQuery.trim().toLowerCase();
    const filtered = screenRows.filter((row) => {
      if (moduleFilter !== "all" && row.module_key !== moduleFilter) return false;
      if (!q) return true;
      return [row.screen_name, row.screen_key, row.module_key].some((value) => String(value || "").toLowerCase().includes(q));
    });
    return modules
      .map((module) => ({
        ...module,
        items: filtered.filter((row) => row.module_key === module.module_key),
      }))
      .filter((group) => group.items.length || moduleFilter === "all" || group.module_key === moduleFilter);
  }, [screenRows, modules, screenQuery, moduleFilter]);

  const stats = useMemo(() => {
    const moduleViewCount = moduleRows.filter((row) => row.can_view).length;
    const moduleApproveCount = moduleRows.filter((row) => row.can_approve).length;
    const screenViewCount = screenRows.filter((row) => row.can_view).length;
    return [
      { label: "Visible modules", value: moduleViewCount, note: "broad shells active for this role", accent: "#2563eb" },
      { label: "Approver modules", value: moduleApproveCount, note: "module-level approvals enabled", accent: "#0f766e" },
      { label: "Visible screens", value: screenViewCount, note: "granular screen coverage", accent: "#d97706" },
      { label: "Changed flags", value: moduleDiff.changedFlags + screenDiff.changedFlags, note: "pending edits in this pass", accent: "#7c3aed" },
      { label: "Newly visible", value: moduleDiff.newlyVisible + screenDiff.newlyVisible, note: "items exposed versus saved role", accent: "#0f766e" },
    ];
  }, [moduleRows, screenRows, moduleDiff, screenDiff]);

  const changedModuleRows = useMemo(() => {
    const baseline = new Map((initialState.moduleRows || []).map((row) => [row.module_key, row]));
    return moduleRows
      .filter((row) => MODULE_FLAGS.some((field) => Boolean(row[field.key]) !== Boolean(baseline.get(row.module_key)?.[field.key])))
      .map((row) => {
        const base = baseline.get(row.module_key) || {};
        const changedFlags = MODULE_FLAGS.filter((field) => Boolean(row[field.key]) !== Boolean(base[field.key])).map((field) => field.label);
        return { key: row.module_key, label: row.module_name, changedFlags };
      });
  }, [moduleRows, initialState.moduleRows]);

  const changedScreenRows = useMemo(() => {
    const baseline = new Map((initialState.screenRows || []).map((row) => [row.screen_key, row]));
    return screenRows
      .filter((row) => SCREEN_FLAGS.some((field) => Boolean(row[field.key]) !== Boolean(baseline.get(row.screen_key)?.[field.key])))
      .map((row) => {
        const base = baseline.get(row.screen_key) || {};
        const changedFlags = SCREEN_FLAGS.filter((field) => Boolean(row[field.key]) !== Boolean(base[field.key])).map((field) => field.label);
        return { key: row.screen_key, label: row.screen_name, moduleKey: row.module_key, changedFlags };
      });
  }, [screenRows, initialState.screenRows]);

  const dependencyWarnings = useMemo(() => {
    const screensMap = Object.fromEntries(screenRows.map((row) => [row.screen_key, row]));
    const warnings = [];

    if (screensMap.service_warranty?.can_view && (!screensMap.quotes?.can_view || !screensMap.quotes?.can_create)) {
      warnings.push({
        key: "service_quotes_dependency",
        severity: "high",
        title: "Service quote blocker",
        detail: "Aftermarket quote creation from Service still depends on Quotes view and create rights.",
        fix: "Grant Quotes view/create or use a user exception for targeted Service users.",
      });
    }

    if (screensMap.dispatches?.can_view && !screensMap.sales_orders?.can_view) {
      warnings.push({
        key: "dispatch_sales_order_dependency",
        severity: "medium",
        title: "Dispatch depends on Sales Orders",
        detail: "Dispatch visibility without Sales Orders creates a broken operational sequence for most users.",
        fix: "Pair Dispatches with Sales Orders visibility for execution roles.",
      });
    }

    if (screensMap.approval_desk?.can_view && !screensMap.approval_desk?.can_approve) {
      warnings.push({
        key: "approval_probe_gap",
        severity: "medium",
        title: "Approval desk opens but cannot approve",
        detail: "Users can land in Approval Desk but may still be blocked from actual approval actions.",
        fix: "Add approve where needed or hide the desk for pure viewers.",
      });
    }

    if (screensMap.purchase_invoices?.can_view && !screensMap.three_way_match?.can_view) {
      warnings.push({
        key: "purchase_dependency",
        severity: "medium",
        title: "Purchase review gap",
        detail: "Purchase Invoices without Three Way Match weakens invoice validation and approval review flow.",
        fix: "Pair Purchase Invoices with Three Way Match for review-heavy purchase roles.",
      });
    }

    return warnings;
  }, [screenRows]);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((user) =>
      [user.full_name, user.email, user.role_name, user.group_name, user.department_name || user.department_key]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [users, userSearch]);

  const roleUsers = useMemo(() => {
    if (!selectedRoleId) return [];
    return users.filter((user) => String(user.role_id || "") === String(selectedRoleId) || String(user.role_name || "") === String(selectedRole?.role_name || ""));
  }, [users, selectedRole, selectedRoleId]);

  const firstRoleUser = roleUsers[0] || null;
  const roleImpactNeedsSimulator = isDirty || dependencyWarnings.length > 0;
  const roleImpactSummary = useMemo(
    () => ({
      totalUsers: roleUsers.length,
      sampleUsers: roleUsers.slice(0, 3),
    }),
    [roleUsers]
  );

  const effectivePermissions = useMemo(
    () => mergePermissions(drawerDetail?.role_permissions, overrideMap),
    [drawerDetail?.role_permissions, overrideMap]
  );

  const visibleScreens = useMemo(
    () =>
      (drawerDetail?.screens || []).filter((screen) => {
        const perms = effectivePermissions?.screens?.[screen.screen_key];
        return Boolean(perms?.can_view);
      }),
    [drawerDetail?.screens, effectivePermissions]
  );

  const visibleDesks = useMemo(() => {
    const screensMap = effectivePermissions?.screens || {};
    return DESK_PREVIEW.filter((desk) => desk.evaluate(screensMap));
  }, [effectivePermissions]);

  const actionChecks = useMemo(() => {
    const screensMap = effectivePermissions?.screens || {};
    return [
      {
        label: "Create standard quote",
        allowed: Boolean(screensMap.quotes?.can_view && screensMap.quotes?.can_create),
        reason: screensMap.quotes?.can_view ? "Quotes is visible; create right decides the action." : "Blocked because Quotes is hidden.",
      },
      {
        label: "Create aftermarket quote from Service",
        allowed: Boolean(screensMap.service_warranty?.can_view && screensMap.quotes?.can_view && screensMap.quotes?.can_create),
        reason: "Requires Service Warranty view plus Quotes view/create.",
      },
      {
        label: "Open User Master",
        allowed: Boolean(screensMap.users?.can_view),
        reason: "Requires the User Master screen.",
      },
      {
        label: "Approve purchase workflow",
        allowed: Boolean(screensMap.approval_desk?.can_view && screensMap.approval_desk?.can_approve),
        reason: "Requires Approval Desk view plus approve.",
      },
    ];
  }, [effectivePermissions]);

  const groupedDrawerRows = useMemo(() => {
    const q = drawerScreenSearch.trim().toLowerCase();
    const buckets = new Map();
    for (const screen of drawerDetail?.screens || []) {
      if (
        q &&
        ![screen.screen_name, screen.screen_key, screen.module_key]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      ) {
        continue;
      }
      const group = buckets.get(screen.module_key) || [];
      group.push(screen);
      buckets.set(screen.module_key, group);
    }
    return Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [drawerDetail?.screens, drawerScreenSearch]);

  const drawerDirty = useMemo(() => JSON.stringify(overrideMap) !== JSON.stringify(initialOverrideMap), [overrideMap, initialOverrideMap]);
  const overrideCount = useMemo(() => countOverrideFlags(overrideMap), [overrideMap]);

  useEffect(() => {
    if (!isDirty || typeof window === "undefined") return undefined;
    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handler = (event) => {
      if (!event.altKey) return;
      const key = String(event.key || "").toLowerCase();
      if (event.shiftKey && key === "1") {
        event.preventDefault();
        moduleGridRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      if (event.shiftKey && key === "2") {
        event.preventDefault();
        screenGridRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      if (key === "1") {
        event.preventDefault();
        roleSelectRef.current?.focus();
        return;
      }
      if (key === "2") {
        event.preventDefault();
        moduleSearchRef.current?.focus();
        return;
      }
      if (key === "3") {
        event.preventDefault();
        screenSearchRef.current?.focus();
        return;
      }
      if (key === "4") {
        event.preventDefault();
        drawerButtonRef.current?.click();
        return;
      }
      if (key === "s") {
        event.preventDefault();
        saveButtonRef.current?.click();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function confirmIfDirty(nextAction) {
    if (!isDirty || typeof window === "undefined") return true;
    return window.confirm(`You have unsaved rights changes. Continue with ${nextAction} and discard them?`);
  }

  function onRoleChange(nextRoleId) {
    if (!confirmIfDirty("role switch")) return;
    setSelectedRoleId(nextRoleId);
    loadData(nextRoleId).catch(() => {});
  }

  function setModuleFlag(moduleKey, field, value) {
    setModuleRows((prev) => prev.map((row) => (row.module_key === moduleKey ? { ...row, [field]: value } : row)));
  }

  function setScreenFlag(screenKey, field, value) {
    setScreenRows((prev) => prev.map((row) => (row.screen_key === screenKey ? { ...row, [field]: value } : row)));
  }

  function applyModuleBulk(field, value) {
    const allowedKeys = new Set(filteredModuleRows.map((row) => row.module_key));
    setModuleRows((prev) => prev.map((row) => (allowedKeys.has(row.module_key) ? { ...row, [field]: value } : row)));
  }

  function applyScreenBulk(field, value, moduleKey = null) {
    const allowedKeys = new Set(
      groupedScreenRows.flatMap((group) => (moduleKey && group.module_key !== moduleKey ? [] : group.items.map((row) => row.screen_key)))
    );
    setScreenRows((prev) => prev.map((row) => (allowedKeys.has(row.screen_key) ? { ...row, [field]: value } : row)));
  }

  function resetRoleToSavedState() {
    if (!confirmIfDirty("reset")) return;
    setModuleRows(initialState.moduleRows);
    setScreenRows(initialState.screenRows);
    setNotice(`Unsaved changes cleared for ${selectedRole?.role_name || "selected role"}.`);
  }

  function copyFromRole() {
    if (!copyRoleId || !bootstrapData) return;
    const sourceRole = roles.find((role) => String(role.id) === String(copyRoleId));
    if (!sourceRole) return;
    const nextRows = buildRoleRows(copyRoleId, roles, modules, screens, bootstrapData);
    setModuleRows(nextRows.moduleRows);
    setScreenRows(nextRows.screenRows);
    setNotice(`Loaded rights from ${sourceRole.role_name}. Review and save to apply them to ${selectedRole?.role_name || "this role"}.`);
  }

  function openDrawer() {
    setDrawerOpen(true);
    setDrawerError("");
    setDrawerNotice("");
  }

  function openPreviewDesk({ focusLane = "all", userId = null } = {}) {
    if (typeof onNavigate !== "function") return;
    onNavigate("user_access_preview", {
      resetQuote: true,
      adminLaunch: {
        focusLane,
        userId: userId || undefined,
      },
    });
  }

  function closeDrawer() {
    if (drawerDirty && typeof window !== "undefined") {
      const proceed = window.confirm("You have unsaved user exception edits. Close the drawer and discard them?");
      if (!proceed) return;
    }
    setDrawerOpen(false);
  }

  function updateOverride(screenKey, field, value) {
    setOverrideMap((current) => ({
      ...current,
      [screenKey]: {
        ...(current[screenKey] || { screen_key: screenKey }),
        [field]: value,
      },
    }));
  }

  function resetScreen(screenKey) {
    setOverrideMap((current) => ({
      ...current,
      [screenKey]: {
        screen_key: screenKey,
        can_view: null,
        can_create: null,
        can_edit: null,
        can_approve: null,
        own_records_only: null,
        financial_masking: null,
      },
    }));
  }

  function clearAllOverrides() {
    if (!drawerDetail?.screens) return;
    setOverrideMap(buildOverrideMap([], drawerDetail.screens));
  }

  async function save() {
    if (!selectedRoleId) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/permissions/role/${selectedRoleId}`, {
        method: "PUT",
        body: JSON.stringify({
          module_permissions: moduleRows,
          screen_permissions: changedScreenRows(screenRows, initialState?.screenRows),
        }),
      });
      setInitialState({ moduleRows, screenRows });
      setNotice(`Rights saved for ${selectedRole?.role_name || "selected role"}.`);
    } catch (e) {
      setError(e?.data?.error || "Failed to save rights.");
    } finally {
      setSaving(false);
    }
  }

  async function saveOverrides() {
    if (!selectedUserId) return;
    setDrawerSaving(true);
    setDrawerError("");
    setDrawerNotice("");
    try {
      await apiFetch(`/permissions/user/${selectedUserId}/screens`, {
        method: "PUT",
        body: JSON.stringify({
          screen_permissions: Object.values(overrideMap),
        }),
      });
      const refreshed = await apiFetch(`/permissions/user/${selectedUserId}/effective`);
      const nextOverrides = buildOverrideMap(refreshed?.user_screen_permissions, refreshed?.screens);
      setDrawerDetail(refreshed);
      setOverrideMap(nextOverrides);
      setInitialOverrideMap(nextOverrides);
      setDrawerNotice("User exceptions saved.");
    } catch (e) {
      setDrawerError(e?.data?.error || "Failed to save user exceptions.");
    } finally {
      setDrawerSaving(false);
    }
  }

  const drawerSelectedUser = drawerDetail?.user
    ? { ...(users.find((user) => Number(user.id) === Number(selectedUserId)) || {}), ...drawerDetail.user }
    : users.find((user) => Number(user.id) === Number(selectedUserId)) || null;

  return (
    <>
      <div style={{ maxWidth: 1420, width: "100%", display: "grid", gap: 16 }}>
        <section
          style={{
            border: "1px solid #d7dfed",
            borderRadius: 26,
            padding: 22,
            background: "linear-gradient(135deg, #f5f9ff 0%, #ffffff 56%, #f6fbff 100%)",
            boxShadow: "0 20px 48px rgba(15, 23, 42, 0.08)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ maxWidth: 860 }}>
              <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Governance Desk</div>
              <h2 style={{ margin: "8px 0 0", fontSize: 32, lineHeight: 1.12 }}>Rights Matrix rebuilt for dense admin review.</h2>
              <p style={{ margin: "12px 0 0", fontSize: 14, opacity: 0.78, lineHeight: 1.7 }}>
                This pass uses a compact grid instead of stacked cards, keeps bulk role editing fast, and opens user-specific exceptions in an inline drawer
                so the admin never loses context.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  if (!confirmIfDirty("refresh")) return;
                  loadData(selectedRoleId).catch(() => {});
                }}
              >
                Refresh
              </button>
              <button type="button" onClick={resetRoleToSavedState} disabled={!isDirty || loading || saving}>
                Reset Unsaved
              </button>
              <button ref={drawerButtonRef} type="button" onClick={openDrawer} disabled={loading || saving}>
                User Exceptions
              </button>
              <button ref={saveButtonRef} type="button" onClick={save} disabled={saving || loading || !selectedRoleId}>
                {saving ? "Saving..." : "Save Rights"}
              </button>
            </div>
          </div>
        </section>

        <section className="rights-matrix-stats" style={{ display: "grid", gap: 14 }}>
          {stats.map((item) => (
            <StatCard key={item.label} {...item} />
          ))}
        </section>

        {error ? <div style={{ color: "#b91c1c", fontWeight: 700 }}>{error}</div> : null}
        {notice ? <div style={{ color: "#166534", fontWeight: 700 }}>{notice}</div> : null}

        <div className="rights-matrix-layout" style={{ display: "grid", gap: 16, alignItems: "start" }}>
          <SurfaceCard title="Role Desk" subtitle="Choose the role, copy from a cleaner baseline, and keep all broad review actions in one compact strip.">
            <div style={{ display: "grid", gap: 14 }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Access profile</div>
                <select ref={roleSelectRef} value={selectedRoleId} onChange={(e) => onRoleChange(e.target.value)} style={{ width: "100%" }}>
                  {roles.map((role) => (
                    <option key={role.id} value={String(role.id)}>
                      {role.role_name}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ border: "1px solid #e5ebf5", borderRadius: 16, background: "#fbfdff", padding: 14, display: "grid", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{selectedRole?.role_name || "No role selected"}</strong>
                  <SectionPill tone={isDirty ? "#fff7ed" : "#eff6ff"} color={isDirty ? "#b45309" : "#1d4ed8"}>
                    {isDirty ? "Unsaved changes" : "Aligned to saved role"}
                  </SectionPill>
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>Role key: {selectedRole?.role_key || "—"}</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>
                  Module rows handle shell-level access. Screen rows handle the final reality users will feel inside the app.
                </div>
              </div>

              <div style={{ border: "1px solid #e5ebf5", borderRadius: 16, background: "#fff", padding: 14, display: "grid", gap: 10 }}>
                <div style={{ fontWeight: 800 }}>Copy from role</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>Use a neighboring role as a clean base, then change only the deltas you actually need.</div>
                <select value={copyRoleId} onChange={(e) => setCopyRoleId(e.target.value)} style={{ width: "100%" }}>
                  <option value="">Select source role</option>
                  {roles
                    .filter((role) => String(role.id) !== String(selectedRoleId))
                    .map((role) => (
                      <option key={role.id} value={String(role.id)}>
                        {role.role_name}
                      </option>
                    ))}
                </select>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={copyFromRole} disabled={!copyRoleId || loading || saving}>
                    Copy From Role
                  </button>
                  {typeof onNavigate === "function" ? (
                    <button type="button" onClick={() => openPreviewDesk({ focusLane: "all", userId: firstRoleUser?.id })} disabled={loading || saving}>
                      Full Preview Desk
                    </button>
                  ) : null}
                </div>
              </div>

              <div style={{ border: "1px solid #e5ebf5", borderRadius: 16, background: "#f8fbff", padding: 14, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 800 }}>Current delta</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>Changed rows: {moduleDiff.changedRows + screenDiff.changedRows}</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>Changed flags: {moduleDiff.changedFlags + screenDiff.changedFlags}</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>Newly visible: {moduleDiff.newlyVisible + screenDiff.newlyVisible}</div>
              </div>

              <div style={{ border: "1px solid #e5ebf5", borderRadius: 16, background: "#fff", padding: 14, display: "grid", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ fontWeight: 800 }}>Role impact</div>
                  <SectionPill tone={roleImpactNeedsSimulator ? "#fff7ed" : "#effcf3"} color={roleImpactNeedsSimulator ? "#b45309" : "#15803d"}>
                    {roleImpactNeedsSimulator ? "Simulator check recommended" : "Ready for simulator"}
                  </SectionPill>
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>
                  {roleImpactSummary.totalUsers
                    ? `${roleImpactSummary.totalUsers} users currently carry this role. Use the simulator after role edits to confirm effective outcome.`
                    : "No live users are currently mapped to this role, so validate the role structure before assigning it wider."}
                </div>
                {roleImpactSummary.sampleUsers.length ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {roleImpactSummary.sampleUsers.map((user) => (
                      <button
                        key={user.id}
                        type="button"
                        onClick={() => openPreviewDesk({ focusLane: "changed", userId: user.id })}
                        style={{ borderRadius: 999, border: "1px solid #d7dfed", background: "#fff", padding: "8px 10px", fontSize: 12, cursor: "pointer" }}
                      >
                        {user.full_name || user.email}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {typeof onNavigate === "function" ? (
                    <button type="button" onClick={() => openPreviewDesk({ focusLane: "changed", userId: firstRoleUser?.id })}>
                      Open Simulator
                    </button>
                  ) : null}
                  {typeof onNavigate === "function" ? (
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate("users", {
                          resetQuote: true,
                          adminLaunch: { view: "directory" },
                        })
                      }
                    >
                      Open User Directory
                    </button>
                  ) : null}
                </div>
              </div>

              <div style={{ border: "1px solid #e5ebf5", borderRadius: 16, background: "#fff", padding: 14, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 800 }}>Keyboard flow</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>`Alt+1` role</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>`Alt+2` module search</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>`Alt+3` screen search</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>`Alt+4` user exceptions</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>`Alt+S` save</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>`Alt+Shift+1/2` jump between module and screen grids</div>
              </div>
            </div>
          </SurfaceCard>

          <div className="rights-matrix-main-stack" style={{ display: "grid", gap: 16 }}>
            <SurfaceCard
              title="Control Strip"
              subtitle="Jump directly to the working zone you need and keep the next blockers visible while editing."
              actions={
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => moduleGridRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>
                    Jump to Modules
                  </button>
                  <button type="button" onClick={() => screenGridRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>
                    Jump to Screens
                  </button>
                  <button type="button" onClick={openDrawer}>
                    Probe a User
                  </button>
                  {typeof onNavigate === "function" ? (
                    <button type="button" onClick={() => openPreviewDesk({ focusLane: "changed", userId: firstRoleUser?.id })}>
                      Send to Simulator
                    </button>
                  ) : null}
                </div>
              }
            >
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {roleImpactSummary.totalUsers ? (
                  <SectionPill tone="#eefcf6" color="#15803d">
                    {roleImpactSummary.totalUsers} affected users
                  </SectionPill>
                ) : (
                  <SectionPill tone="#f8fafc" color="#475569">No mapped users yet</SectionPill>
                )}
                {dependencyWarnings.length ? (
                  dependencyWarnings.map((warning) => (
                    <SectionPill key={warning.key} tone={warning.severity === "high" ? "#fef2f2" : "#fff7ed"} color={warning.severity === "high" ? "#b91c1c" : "#b45309"}>
                      {warning.title}
                    </SectionPill>
                  ))
                ) : (
                  <SectionPill tone="#f0fdf4" color="#15803d">No active dependency blockers in this role snapshot</SectionPill>
                )}
              </div>
            </SurfaceCard>

            <SurfaceCard title="Review Rail" subtitle="Use this rail as the final admin confidence check before save.">
              <div className="rights-matrix-review-body" style={{ display: "grid", gap: 12 }}>
                <div style={{ borderRadius: 16, padding: 12, background: isDirty ? "#fff7ed" : "#f0fdf4", border: `1px solid ${isDirty ? "#fed7aa" : "#bbf7d0"}` }}>
                  <div style={{ fontWeight: 800, color: isDirty ? "#b45309" : "#15803d" }}>{isDirty ? "Pending changes to review" : "No unsaved changes"}</div>
                  <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>
                    {isDirty
                      ? `${changedModuleRows.length} module rows and ${changedScreenRows.length} screen rows differ from the saved role.`
                      : "The role matches the last saved permission set."}
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 800, marginBottom: 8 }}>Simulator follow-through</div>
                  <div className="rights-matrix-review-list" style={{ display: "grid", gap: 8 }}>
                    <div style={{ borderRadius: 16, border: "1px solid #e5ebf5", padding: 12, background: roleImpactNeedsSimulator ? "#fff7ed" : "#f0fdf4" }}>
                      <div style={{ fontWeight: 800, color: roleImpactNeedsSimulator ? "#b45309" : "#15803d" }}>
                        {roleImpactNeedsSimulator ? "Needs effective-user verification" : "Ready to verify on a user"}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>
                        {roleImpactNeedsSimulator
                          ? "This role has unsaved changes or dependency warnings, so confirm the final user outcome in the simulator before you treat the role design as complete."
                          : "The role is structurally stable. Use the simulator to confirm the final user outcome and keep exceptions minimal."}
                      </div>
                    </div>
                    {roleImpactSummary.sampleUsers.length ? (
                      roleImpactSummary.sampleUsers.map((user) => (
                        <div key={user.id} style={{ borderRadius: 14, border: "1px solid #e5ebf5", padding: 10, background: "#fff" }}>
                          <div style={{ fontWeight: 700 }}>{user.full_name || user.email}</div>
                          <div style={{ fontSize: 12, opacity: 0.68, marginTop: 4 }}>
                            {user.email} | {user.group_name || "No group"}
                          </div>
                          {typeof onNavigate === "function" ? (
                            <button
                              type="button"
                              onClick={() => openPreviewDesk({ focusLane: "changed", userId: user.id })}
                              style={{ marginTop: 8 }}
                            >
                              Simulate user
                            </button>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Assign the role to a user, then verify the real outcome in the simulator.</div>
                    )}
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 800, marginBottom: 8 }}>Dependency watch</div>
                  <div className="rights-matrix-review-list" style={{ display: "grid", gap: 8 }}>
                    {dependencyWarnings.length ? (
                      dependencyWarnings.map((warning) => (
                        <div key={warning.key} style={{ borderRadius: 16, border: "1px solid #e5ebf5", padding: 12, background: warning.severity === "high" ? "#fef2f2" : "#fffaf0" }}>
                          <div style={{ fontWeight: 800, color: warning.severity === "high" ? "#b91c1c" : "#b45309" }}>{warning.title}</div>
                          <div style={{ fontSize: 12, opacity: 0.76, marginTop: 6 }}>{warning.detail}</div>
                          <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>
                            <strong>Fix:</strong> {warning.fix}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.72 }}>No common blocker patterns detected in this role snapshot.</div>
                    )}
                  </div>
                </div>

                <div className="rights-matrix-review-grid" style={{ display: "grid", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800, marginBottom: 8 }}>Changed modules</div>
                    <div className="rights-matrix-review-list" style={{ display: "grid", gap: 8 }}>
                      {changedModuleRows.length ? (
                        changedModuleRows.slice(0, 6).map((row) => (
                          <div key={row.key} style={{ borderRadius: 14, border: "1px solid #e5ebf5", padding: 10, background: "#fff" }}>
                            <div style={{ fontWeight: 700 }}>{row.label}</div>
                            <div style={{ fontSize: 12, opacity: 0.68, marginTop: 4 }}>{row.changedFlags.join(", ")}</div>
                          </div>
                        ))
                      ) : (
                        <div style={{ fontSize: 12, opacity: 0.72 }}>No module-level edits.</div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontWeight: 800, marginBottom: 8 }}>Changed screens</div>
                    <div className="rights-matrix-review-list" style={{ display: "grid", gap: 8 }}>
                      {changedScreenRows.length ? (
                        changedScreenRows.slice(0, 8).map((row) => (
                          <div key={row.key} style={{ borderRadius: 14, border: "1px solid #e5ebf5", padding: 10, background: "#fff" }}>
                            <div style={{ fontWeight: 700 }}>{row.label}</div>
                            <div style={{ fontSize: 12, opacity: 0.68, marginTop: 4 }}>{row.moduleKey} | {row.changedFlags.join(", ")}</div>
                          </div>
                        ))
                      ) : (
                        <div style={{ fontSize: 12, opacity: 0.72 }}>No screen-level edits.</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </SurfaceCard>

            <SurfaceCard
              title="Module Grid"
              subtitle="Start with broad shells. The denser table makes it easy to spot role drift and set a whole review slice quickly."
              actions={
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input ref={moduleSearchRef} value={moduleQuery} onChange={(e) => setModuleQuery(e.target.value)} placeholder="Search modules" style={{ minWidth: 220 }} />
                  <button type="button" onClick={() => applyModuleBulk("can_view", true)} disabled={!filteredModuleRows.length}>
                    View all shown
                  </button>
                  <button type="button" onClick={() => applyModuleBulk("can_view", false)} disabled={!filteredModuleRows.length}>
                    Hide all shown
                  </button>
                  <button type="button" onClick={() => applyModuleBulk("can_approve", true)} disabled={!filteredModuleRows.length}>
                    Approve all shown
                  </button>
                </div>
              }
            >
              <div ref={moduleGridRef} style={{ overflowX: "auto", border: "1px solid #e5ebf5", borderRadius: 18 }}>
                <table style={{ width: "100%", minWidth: 860, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#f8fbff" }}>
                      <th style={tableCellStyle(true, true)}>Module</th>
                      {MODULE_FLAGS.map((field) => (
                        <th key={field.key} style={tableCellStyle(true)}>
                          {field.label}
                        </th>
                      ))}
                      <th style={tableCellStyle(true)}>Quick actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredModuleRows.map((row) => (
                      <tr key={row.module_key}>
                        <td style={tableCellStyle(false, true)}>
                          <div style={{ fontWeight: 800 }}>{row.module_name}</div>
                          <div style={{ fontSize: 12, opacity: 0.64, marginTop: 4 }}>{row.module_key}</div>
                        </td>
                        {MODULE_FLAGS.map((field) => (
                          <td key={field.key} style={tableCellStyle()}>
                            <ToggleChip active={row[field.key]} label={field.label} accent={field.accent} onToggle={(value) => setModuleFlag(row.module_key, field.key, value)} />
                          </td>
                        ))}
                        <td style={tableCellStyle()}>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button type="button" onClick={() => MODULE_FLAGS.forEach((field) => setModuleFlag(row.module_key, field.key, true))}>
                              Full
                            </button>
                            <button type="button" onClick={() => MODULE_FLAGS.forEach((field) => setModuleFlag(row.module_key, field.key, false))}>
                              None
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SurfaceCard>

            <SurfaceCard
              title="Screen Grid"
              subtitle="Tighten the actual runtime experience by module. Bulk actions work per filtered slice or per module block."
              actions={
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input ref={screenSearchRef} value={screenQuery} onChange={(e) => setScreenQuery(e.target.value)} placeholder="Search screens" style={{ minWidth: 220 }} />
                  <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)}>
                    <option value="all">All modules</option>
                    {modules.map((module) => (
                      <option key={module.module_key} value={module.module_key}>
                        {module.module_name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => applyScreenBulk("can_view", true)} disabled={!groupedScreenRows.some((group) => group.items.length)}>
                    Show filtered
                  </button>
                  <button type="button" onClick={() => applyScreenBulk("can_view", false)} disabled={!groupedScreenRows.some((group) => group.items.length)}>
                    Hide filtered
                  </button>
                </div>
              }
            >
              <div ref={screenGridRef} style={{ display: "grid", gap: 16 }}>
                {groupedScreenRows.map((group) => (
                  <section key={group.module_key} style={{ border: "1px solid #e5ebf5", borderRadius: 18, overflow: "hidden" }}>
                    <div
                      style={{
                        background: "#f8fbff",
                        padding: 14,
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 800 }}>{group.module_name}</div>
                        <div style={{ fontSize: 12, opacity: 0.68, marginTop: 4 }}>
                          {group.items.length} screens | {group.module_key}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => applyScreenBulk("can_view", true, group.module_key)} disabled={!group.items.length}>
                          View all
                        </button>
                        <button type="button" onClick={() => applyScreenBulk("can_create", true, group.module_key)} disabled={!group.items.length}>
                          Create all
                        </button>
                      </div>
                    </div>

                    {group.items.length ? (
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", minWidth: 1200, borderCollapse: "collapse" }}>
                          <thead>
                            <tr style={{ background: "#fcfdff" }}>
                              <th style={tableCellStyle(true, true)}>Screen</th>
                              {SCREEN_FLAGS.map((field) => (
                                <th key={field.key} style={tableCellStyle(true)}>
                                  {field.label}
                                </th>
                              ))}
                              <th style={tableCellStyle(true)}>Quick actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.items.map((row) => (
                              <tr key={row.screen_key}>
                                <td style={tableCellStyle(false, true)}>
                                  <div style={{ fontWeight: 800 }}>{row.screen_name}</div>
                                  <div style={{ fontSize: 12, opacity: 0.64, marginTop: 4 }}>{row.screen_key}</div>
                                </td>
                                {SCREEN_FLAGS.map((field) => (
                                  <td key={field.key} style={tableCellStyle()}>
                                    <ToggleChip
                                      active={row[field.key]}
                                      label={field.label}
                                      accent={field.accent}
                                      onToggle={(value) => setScreenFlag(row.screen_key, field.key, value)}
                                    />
                                  </td>
                                ))}
                                <td style={tableCellStyle()}>
                                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    <button type="button" onClick={() => setScreenFlag(row.screen_key, "can_view", true)}>
                                      Show
                                    </button>
                                    <button type="button" onClick={() => setScreenFlag(row.screen_key, "can_view", false)}>
                                      Hide
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        ["can_create", "can_edit", "can_approve", "own_records_only", "financial_masking"].forEach((field) =>
                                          setScreenFlag(row.screen_key, field, false)
                                        )
                                      }
                                    >
                                      Clear extras
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div style={{ padding: 14, fontSize: 12, opacity: 0.72 }}>No matching screens in this module.</div>
                    )}
                  </section>
                ))}
              </div>
            </SurfaceCard>
          </div>
        </div>
      </div>

      {drawerOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.32)",
            zIndex: 50,
            display: "flex",
            justifyContent: "flex-end",
            padding: 20,
          }}
        >
          <div
            style={{
              width: "min(1200px, calc(100vw - 40px))",
              height: "calc(100vh - 40px)",
              background: "#f8fbff",
              borderRadius: 28,
              border: "1px solid #cfdae9",
              boxShadow: "0 28px 80px rgba(15, 23, 42, 0.28)",
              display: "grid",
              gridTemplateRows: "auto 1fr",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: 20, borderBottom: "1px solid #d9e3f0", background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ maxWidth: 720 }}>
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Inline Exception Drawer</div>
                  <h3 style={{ margin: "8px 0 0", fontSize: 28, lineHeight: 1.1 }}>Diagnose user exceptions without leaving Rights Matrix.</h3>
                  <div style={{ marginTop: 10, fontSize: 13, opacity: 0.76, lineHeight: 1.6 }}>
                    Inspect effective visibility here. Edit exceptions in Org &amp; access; keep this matrix for role templates.
                  </div>
                </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {typeof onNavigate === "function" ? (
                    <button type="button" onClick={() => openPreviewDesk({ focusLane: "exceptions", userId: selectedUserId })} disabled={drawerSaving}>
                      Full Preview Desk
                    </button>
                  ) : null}
                  {typeof onNavigate === "function" ? (
                    <button
                      type="button"
                      onClick={() => onNavigate("users", { resetQuote: true, adminLaunch: { view: "orgchart", userId: selectedUserId } })}
                      disabled={drawerSaving}
                    >
                      Edit in Org &amp; access
                    </button>
                  ) : null}
                  <button type="button" onClick={closeDrawer}>
                    Close
                  </button>
                </div>
              </div>
              {drawerError ? <div style={{ color: "#b91c1c", fontWeight: 700, marginTop: 12 }}>{drawerError}</div> : null}
              {drawerNotice ? <div style={{ color: "#166534", fontWeight: 700, marginTop: 12 }}>{drawerNotice}</div> : null}
            </div>

            <div style={{ overflow: "auto", padding: 20 }}>
              <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", gap: 18, alignItems: "start" }}>
                <div style={{ display: "grid", gap: 14 }}>
                  <SurfaceCard title="User picker" subtitle="Search by name, email, role, or group and switch targets without leaving the drawer.">
                    <input
                      value={userSearch}
                      onChange={(event) => setUserSearch(event.target.value)}
                      placeholder="Search user, role, email, group"
                      style={{
                        width: "100%",
                        borderRadius: 12,
                        border: "1px solid #cad5e5",
                        padding: "10px 12px",
                        marginBottom: 12,
                      }}
                    />
                    <div style={{ display: "grid", gap: 8, maxHeight: 520, overflow: "auto", paddingRight: 4 }}>
                      {loadingUsers ? <div style={{ opacity: 0.72 }}>Loading users...</div> : null}
                      {!loadingUsers && !filteredUsers.length ? <div style={{ opacity: 0.72 }}>No matching users.</div> : null}
                      {filteredUsers.map((user) => {
                        const active = Number(user.id) === Number(selectedUserId);
                        return (
                          <button
                            key={user.id}
                            type="button"
                            onClick={() => setSelectedUserId(user.id)}
                            style={{
                              textAlign: "left",
                              borderRadius: 16,
                              border: active ? "1px solid #1d4ed8" : "1px solid #d9e3f0",
                              background: active ? "#eff6ff" : "#fff",
                              padding: 12,
                              cursor: "pointer",
                            }}
                          >
                            <div style={{ fontWeight: 800 }}>{user.full_name}</div>
                            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>{user.email}</div>
                            <div style={{ fontSize: 12, opacity: 0.66, marginTop: 6 }}>
                              {user.role_name || "No role"} | {user.group_name || "No group"}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </SurfaceCard>
                </div>

                <div style={{ display: "grid", gap: 16 }}>
                  <div
                    style={{
                      border: "1px solid #d9e3f0",
                      borderRadius: 22,
                      background: "#fff",
                      padding: 16,
                      boxShadow: "0 16px 34px rgba(15, 23, 42, 0.06)",
                    }}
                  >
                    {drawerLoading ? (
                      <div style={{ opacity: 0.72 }}>Loading effective access...</div>
                    ) : drawerSelectedUser ? (
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontSize: 12, opacity: 0.56, letterSpacing: "0.08em", textTransform: "uppercase" }}>Selected user</div>
                          <h3 style={{ margin: "8px 0 0", fontSize: 28, lineHeight: 1.1 }}>{drawerSelectedUser.full_name}</h3>
                          <div style={{ marginTop: 8, fontSize: 13, opacity: 0.74 }}>
                            {drawerSelectedUser.email} | {drawerSelectedUser.role_name || "No role"} | {drawerSelectedUser.group_name || "No group"}
                          </div>
                        </div>
                        <div style={{ minWidth: 280, display: "grid", gap: 8 }}>
                          <div style={{ fontSize: 13, opacity: 0.78 }}>
                            <strong>Department:</strong> {drawerSelectedUser.department_name || drawerSelectedUser.department_key || "Not mapped"}
                          </div>
                          <div style={{ fontSize: 13, opacity: 0.78 }}>
                            <strong>Primary manager:</strong> {drawerSelectedUser.primary_manager_name || "Not mapped"}
                          </div>
                          <div style={{ fontSize: 13, opacity: 0.78 }}>
                            <strong>Secondary manager:</strong> {drawerSelectedUser.secondary_manager_name || "Not mapped"}
                          </div>
                          <div style={{ fontSize: 13, opacity: 0.78 }}>
                            <strong>Exception state:</strong> {drawerDirty ? "Unsaved edits pending" : "Aligned to saved exceptions"}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ opacity: 0.72 }}>Pick a user to inspect access.</div>
                    )}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
                    <StatCard label="Visible screens" value={visibleScreens.length} note="effective visibility after role plus overrides" accent="#2563eb" />
                    <StatCard label="Visible desks" value={visibleDesks.length} note="desk shells the user can actually reach" accent="#0f766e" />
                    <StatCard label="Exception flags" value={overrideCount} note="screen-level override decisions" accent="#d97706" />
                    <StatCard
                      label="Create-enabled"
                      value={Object.values(effectivePermissions?.screens || {}).filter((row) => row.can_view && row.can_create).length}
                      note="useful quick signal for daily coverage"
                      accent="#7c3aed"
                    />
                  </div>

                  <SurfaceCard
                    title="Cross-desk handoff"
                    subtitle="Finish exception editing here, then confirm the full effective-user outcome in the dedicated simulator."
                    actions={
                      typeof onNavigate === "function" ? (
                        <button type="button" onClick={() => openPreviewDesk({ focusLane: "changed", userId: selectedUserId })} disabled={!selectedUserId}>
                          Open Simulator
                        </button>
                      ) : null
                    }
                  >
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
                      <FocusActionCard
                        title="Check changed result"
                        note="See only the screens where user exceptions alter the base role outcome."
                        tone="#1d4ed8"
                        active={false}
                        onClick={() => openPreviewDesk({ focusLane: "changed", userId: selectedUserId })}
                      />
                      <FocusActionCard
                        title="Review exceptions"
                        note="Audit every explicit allow or block on top of the selected role."
                        tone="#d97706"
                        active={false}
                        onClick={() => openPreviewDesk({ focusLane: "exceptions", userId: selectedUserId })}
                      />
                      <FocusActionCard
                        title="Inspect blocked view"
                        note="Confirm which screens and actions still stay hidden for the selected user."
                        tone="#7c3aed"
                        active={false}
                        onClick={() => openPreviewDesk({ focusLane: "blocked", userId: selectedUserId })}
                      />
                    </div>
                  </SurfaceCard>

                  <div style={{ display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 16 }}>
                    <SurfaceCard title="Preview" subtitle="See what the user can reach after role plus overrides.">
                      <div style={{ display: "grid", gap: 14 }}>
                        <div>
                          <div style={{ fontWeight: 800, marginBottom: 8 }}>Visible desks</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {visibleDesks.length ? (
                              visibleDesks.map((desk) => (
                                <SectionPill key={desk.key}>{desk.label}</SectionPill>
                              ))
                            ) : (
                              <span style={{ opacity: 0.68 }}>No desk shells visible.</span>
                            )}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontWeight: 800, marginBottom: 8 }}>Visible screens</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {visibleScreens.map((screen) => (
                              <span key={screen.screen_key} style={{ borderRadius: 999, padding: "8px 10px", border: "1px solid #d9e3f0", background: "#fff", fontSize: 12 }}>
                                {screen.screen_name}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </SurfaceCard>

                    <SurfaceCard title="Action Probe" subtitle="Probe the exact business actions that usually create pilot blockers.">
                      <div style={{ display: "grid", gap: 10 }}>
                        {actionChecks.map((check) => (
                          <div key={check.label} style={{ borderRadius: 16, border: "1px solid #d9e3f0", padding: 12, background: check.allowed ? "#f0fdf4" : "#fff7ed" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                              <div style={{ fontWeight: 800 }}>{check.label}</div>
                              <div style={{ fontSize: 12, fontWeight: 800, color: check.allowed ? "#15803d" : "#b45309" }}>{check.allowed ? "Allowed" : "Blocked"}</div>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>{check.reason}</div>
                          </div>
                        ))}
                      </div>
                    </SurfaceCard>
                  </div>

                  <SurfaceCard
                    title="Exception Grid"
                    subtitle="Leave most values on inherit. Use allow or block only where the user truly needs an exception."
                    actions={
                      <input
                        value={drawerScreenSearch}
                        onChange={(event) => setDrawerScreenSearch(event.target.value)}
                        placeholder="Filter screens"
                        style={{ borderRadius: 12, border: "1px solid #cad5e5", padding: "10px 12px", minWidth: 220 }}
                      />
                    }
                  >
                    <div style={{ display: "grid", gap: 16 }}>
                      {groupedDrawerRows.map(([moduleKey, rows]) => (
                        <section key={moduleKey} style={{ border: "1px solid #dfe7f2", borderRadius: 18, overflow: "hidden" }}>
                          <div style={{ padding: "12px 14px", background: "#f8fbff", borderBottom: "1px solid #dfe7f2", fontWeight: 800, textTransform: "capitalize" }}>
                            {moduleKey.replace(/_/g, " ")}
                          </div>
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1120 }}>
                              <thead>
                                <tr style={{ background: "#fff" }}>
                                  <th style={tableCellStyle(true, true)}>Screen</th>
                                  {SCREEN_FLAGS.map((field) => (
                                    <th key={field.key} style={tableCellStyle(true)}>
                                      {field.label}
                                    </th>
                                  ))}
                                  <th style={tableCellStyle(true)}>Effective</th>
                                </tr>
                              </thead>
                              <tbody>
                                {rows.map((screen) => {
                                  const row = overrideMap[screen.screen_key] || {};
                                  const effective = effectivePermissions?.screens?.[screen.screen_key] || {};
                                  return (
                                    <tr key={screen.screen_key}>
                                      <td style={tableCellStyle(false, true)}>
                                        <div style={{ fontWeight: 700 }}>{screen.screen_name}</div>
                                        <div style={{ fontSize: 12, opacity: 0.62, marginTop: 4 }}>{screen.screen_key}</div>
                                      </td>
                                      {SCREEN_FLAGS.map((field) => {
                                        const overrideValue = row[field.key];
                                        const label =
                                          overrideValue === true || overrideValue === "true"
                                            ? "Force yes"
                                            : overrideValue === false || overrideValue === "false"
                                              ? "Force no"
                                              : "Inherit";
                                        return (
                                          <td key={field.key} style={tableCellStyle()}>
                                            <span style={{ fontSize: 12, opacity: 0.82 }}>{label}</span>
                                          </td>
                                        );
                                      })}
                                      <td style={tableCellStyle()}>
                                        <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
                                          <div>View: {effective.can_view ? "Yes" : "No"}</div>
                                          <div>Create: {effective.can_create ? "Yes" : "No"}</div>
                                          <div>Edit: {effective.can_edit ? "Yes" : "No"}</div>
                                          <div>Approve: {effective.can_approve ? "Yes" : "No"}</div>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      ))}
                    </div>
                  </SurfaceCard>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
