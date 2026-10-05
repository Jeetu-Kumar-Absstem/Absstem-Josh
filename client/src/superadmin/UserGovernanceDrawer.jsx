import { useEffect, useMemo, useState } from "react";
import SlideOverDrawer from "../components/SlideOverDrawer";
import { applyRoleProfileToForm, formatRoleProfileSummary, groupRolesForSelect, resolveRoleProfile } from "./roleProfile";
import PersonAccessPanel from "./PersonAccessPanel";

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

const SCREEN_FLAGS = [
  { key: "can_view", label: "View" },
  { key: "can_create", label: "Create" },
  { key: "can_edit", label: "Edit" },
  { key: "can_approve", label: "Approve" },
  { key: "own_records_only", label: "Own only" },
];

const TABS = [
  { key: "identity", label: "Identity" },
  { key: "screens", label: "Screen Access" },
  { key: "authority", label: "Financial Authority" },
];
const ACCESS_V2_TABS = [
  { key: "identity", label: "Identity" },
  { key: "access", label: "Access" },
  { key: "authority", label: "Financial Authority" },
];

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function emptyForm() {
  return {
    id: null,
    user_code: "System Generated",
    full_name: "",
    email: "",
    phone: "",
    designation: "",
    group_id: "",
    role_id: "",
    company_name: "",
    distributor_id: "",
    employee_code: "",
    department_key: "",
    employment_company_id: "",
    company_ids: [],
    primary_company_id: "",
    primary_manager_user_id: "",
    secondary_manager_user_id: "",
    date_of_joining: "",
    local_address: "",
    permanent_address: "",
    discount_threshold_pct: "",
    is_active: true,
    is_approved: true,
    password: "",
  };
}

function normalizeUserToForm(user) {
  return {
    id: user?.id ?? null,
    user_code: user?.user_code || "System Generated",
    full_name: user?.full_name || "",
    email: user?.email || "",
    phone: user?.phone || "",
    designation: user?.designation || "",
    group_id: user?.group_id ? String(user.group_id) : "",
    role_id: user?.role_id ? String(user.role_id) : "",
    company_name: user?.company_name || "",
    distributor_id: user?.distributor_id ? String(user.distributor_id) : "",
    employee_code: user?.employee_code || "",
    department_key: user?.department_key || "",
    employment_company_id: user?.employment_company_id ? String(user.employment_company_id) : "",
    company_ids: [],
    primary_company_id: "",
    primary_manager_user_id: user?.primary_manager_user_id ? String(user.primary_manager_user_id) : "",
    secondary_manager_user_id: user?.secondary_manager_user_id ? String(user.secondary_manager_user_id) : "",
    date_of_joining: user?.date_of_joining ? String(user.date_of_joining).slice(0, 10) : "",
    local_address: user?.local_address || "",
    permanent_address: user?.permanent_address || "",
    discount_threshold_pct:
      user?.discount_threshold_override === null || user?.discount_threshold_override === undefined
        ? ""
        : String(user.discount_threshold_override),
    is_active: user?.is_active !== false,
    is_approved: user?.is_approved !== false,
    password: "",
  };
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

function effectiveFlag(roleRow, overrideRow, flagKey) {
  const override = overrideRow?.[flagKey];
  if (override === null || override === undefined || override === "") {
    return Boolean(roleRow?.[flagKey]);
  }
  return Boolean(override);
}

function rowHasException(overrideRow) {
  return SCREEN_FLAGS.some((flag) => {
    const value = overrideRow?.[flag.key];
    return value !== null && value !== undefined && value !== "";
  });
}

function roleHasAnyAccess(roleRow) {
  return SCREEN_FLAGS.some((flag) => Boolean(roleRow?.[flag.key]));
}

function effectiveAccessSummary(roleRow, overrideRow) {
  return SCREEN_FLAGS.filter((flag) => effectiveFlag(roleRow, overrideRow, flag.key)).map((flag) => flag.label);
}

function clearScreenOverrides(screenKey) {
  return {
    screen_key: screenKey,
    can_view: null,
    can_create: null,
    can_edit: null,
    can_approve: null,
    own_records_only: null,
    financial_masking: null,
  };
}

function blockScreenOverrides(screenKey) {
  return {
    screen_key: screenKey,
    can_view: false,
    can_create: false,
    can_edit: false,
    can_approve: false,
    own_records_only: null,
    financial_masking: null,
  };
}

function formatAmountInput(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function isDistributorPerson(user, group, role = null) {
  const groupName = String(group?.group_name || user?.group_name || "").trim().toLowerCase();
  const roleName = String(role?.role_name || user?.role_name || "").trim().toLowerCase();
  const roleKey = String(role?.role_key || user?.role_key || "").trim().toLowerCase();
  return groupName === "distributor" || roleName === "distributor" || roleKey === "distributor";
}

function resolveAuthorityProfile({ user, form, groups, roles, departments }) {
  const group = groups.find((g) => String(g.id) === String(form.group_id)) || null;
  const role = roles.find((r) => String(r.id) === String(form.role_id)) || null;
  if (isDistributorPerson(user, group, role)) {
    return { kind: "distributor", showProcurement: false, showSalesDiscount: true };
  }

  const department = departments.find((d) => String(d.department_key) === String(form.department_key)) || null;
  const family = String(role?.default_workspace_family || department?.default_workspace_family || "").trim().toLowerCase();
  const hay = [
    role?.role_name,
    form.designation,
    user?.role_name,
    user?.designation,
    department?.department_name,
    form.department_key,
    family,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const isSales =
    family === "sales" ||
    family === "marketing" ||
    /\bsales\b|\bquote\b|channel partner|regional sales|business development/.test(hay);

  if (isSales) return { kind: "sales", showProcurement: true, showSalesDiscount: true };
  return { kind: "operations", showProcurement: true, showSalesDiscount: false };
}

function sourceBadge(source) {
  const tone =
    source === "user"
      ? { bg: "rgba(31, 94, 255, 0.12)", color: "#1f5eff" }
      : source === "role"
        ? { bg: "rgba(20, 128, 74, 0.12)", color: "#14804a" }
        : source === "group"
          ? { bg: "rgba(139, 92, 246, 0.12)", color: "#7c3aed" }
          : { bg: "rgba(100, 116, 139, 0.12)", color: "#64748b" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 22,
        padding: "2px 8px",
        borderRadius: 999,
        background: tone.bg,
        color: tone.color,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
      }}
    >
      {source || "none"}
    </span>
  );
}

/**
 * Unified identity / screen-access / financial-authority drawer for one person.
 */
export default function UserGovernanceDrawer({
  open,
  onClose,
  userId = null,
  bootstrap = {},
  onSaved = null,
  onOpenAccessPreview = null,
  initialTab = "identity",
}) {
  const groups = Array.isArray(bootstrap.groups) ? bootstrap.groups : [];
  const roles = Array.isArray(bootstrap.roles) ? bootstrap.roles : [];
  const distributors = Array.isArray(bootstrap.distributors) ? bootstrap.distributors : [];
  const managers = Array.isArray(bootstrap.managers) ? bootstrap.managers : [];
  const departments = Array.isArray(bootstrap.departments) ? bootstrap.departments : [];
  const companies = Array.isArray(bootstrap.companies) ? bootstrap.companies : [];
  const designations = Array.isArray(bootstrap.designations) ? bootstrap.designations : [];

  const [tab, setTab] = useState("identity");
  const [accessMode, setAccessMode] = useState("off");
  const accessV2 = accessMode !== "off";
  const tabs = accessV2 ? ACCESS_V2_TABS : TABS;
  const [previewVisited, setPreviewVisited] = useState(false);
  const [screensReviewed, setScreensReviewed] = useState(false);
  const [screenListMode, setScreenListMode] = useState("role"); // role | exceptions | all
  const [expandedScreenKey, setExpandedScreenKey] = useState("");
  const [moduleOpenState, setModuleOpenState] = useState({}); // moduleKey -> bool (user override)
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showPostCreateChecklist, setShowPostCreateChecklist] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [userMeta, setUserMeta] = useState(null);
  const [screens, setScreens] = useState([]);
  const [rolePermissions, setRolePermissions] = useState({ screens: {} });
  const [overrideMap, setOverrideMap] = useState({});
  const [screenQuery, setScreenQuery] = useState("");
  const [authorities, setAuthorities] = useState([]);
  const [authorityDraft, setAuthorityDraft] = useState({});

  const selectedGroup = groups.find((g) => String(g.id) === String(form.group_id)) || null;
  const selectedRoleForDist = roles.find((r) => String(r.id) === String(form.role_id)) || null;
  const isDistributorUser = isDistributorPerson(userMeta, selectedGroup, selectedRoleForDist);
  const authorityProfile = useMemo(
    () =>
      resolveAuthorityProfile({
        user: userMeta,
        form,
        groups,
        roles,
        departments,
      }),
    [userMeta, form, groups, roles, departments]
  );
  const managerOptions = useMemo(
    () => managers.filter((m) => !form.id || Number(m.id) !== Number(form.id)),
    [managers, form.id]
  );
  const groupDiscountDefault = selectedGroup?.max_autonomous_discount_pct;

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      setNotice("");
      setPreviewVisited(false);
      setScreensReviewed(false);
      setScreenListMode("role");
      setExpandedScreenKey("");
      setModuleOpenState({});
      const status = await apiFetch("/permissions/access/status").catch(() => null);
      if (cancelled) return;
      const mode = status?.tables_ready && status?.mode && status.mode !== "off" ? status.mode : "off";
      setAccessMode(mode);
      const allowedTabs = new Set(mode !== "off" ? ["identity", "access", "authority"] : ["identity", "screens", "authority"]);
      let wanted = String(initialTab || "");
      if (mode !== "off" && wanted === "screens") wanted = "access";
      if (mode === "off" && wanted === "access") wanted = "screens";
      setTab(allowedTabs.has(wanted) ? wanted : "identity");
      setScreenQuery("");

      if (!userId) {
        setForm(emptyForm());
        setUserMeta(null);
        setScreens([]);
        setRolePermissions({ screens: {} });
        setOverrideMap({});
        setAuthorities([]);
        setAuthorityDraft({});
        setLoading(false);
        return;
      }

      try {
        const [detail, effective, authority] = await Promise.all([
          apiFetch(`/users/detail/${userId}`),
          apiFetch(`/permissions/user/${userId}/effective`),
          apiFetch(`/users/${userId}/approval-authority`).catch((err) => {
            if (err?.data?.error === "COMPANY_NOT_SELECTED") {
              return { ok: false, error: "COMPANY_NOT_SELECTED", authorities: [] };
            }
            throw err;
          }),
        ]);

        if (cancelled) return;

        const saved = detail?.user || null;
        const memberships = Array.isArray(detail?.memberships) ? detail.memberships : [];
        const companyIds = memberships.filter((m) => m.is_active !== false).map((m) => String(m.company_id));
        const primary = memberships.find((m) => m.is_primary) || null;
        const base = normalizeUserToForm(saved);
        setUserMeta(saved);
        setForm({
          ...base,
          company_ids: companyIds,
          primary_company_id: primary?.company_id ? String(primary.company_id) : base.employment_company_id || "",
          employment_company_id: base.employment_company_id || (primary?.company_id ? String(primary.company_id) : ""),
        });

        const screenList = Array.isArray(effective?.screens) ? effective.screens : [];
        setScreens(screenList);
        setRolePermissions(effective?.role_permissions || { screens: {} });
        setOverrideMap(buildOverrideMap(effective?.user_screen_permissions || [], screenList));

        const authRows = Array.isArray(authority?.authorities) ? authority.authorities : [];
        setAuthorities(authRows);
        const draft = {};
        for (const row of authRows) {
          draft[row.doc_type] = {
            max_amount: row.source === "user" ? formatAmountInput(row.max_amount) : "",
            clear: false,
            inheritMode: row.source !== "user",
          };
        }
        setAuthorityDraft(draft);

        if (authority?.error === "COMPANY_NOT_SELECTED") {
          setNotice("Select an active company to edit financial authority ceilings.");
        }
      } catch (e) {
        if (!cancelled) setError(e?.data?.error || "Failed to load user governance.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [open, userId, initialTab]);

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setRoleProfile(roleIdValue) {
    const role = roles.find((r) => String(r.id) === String(roleIdValue)) || null;
    if (!role) {
      setForm((prev) => ({ ...prev, role_id: "", group_id: "", department_key: "" }));
      return;
    }
    setForm((prev) => applyRoleProfileToForm(prev, role, groups, departments));
  }

  const selectedRole = useMemo(
    () => roles.find((r) => String(r.id) === String(form.role_id)) || null,
    [roles, form.role_id]
  );
  const roleProfileMapped = useMemo(
    () => (selectedRole ? resolveRoleProfile(selectedRole, groups, departments) : null),
    [selectedRole, groups, departments]
  );

  function setOverrideFlag(screenKey, flagKey, value) {
    setOverrideMap((prev) => ({
      ...prev,
      [screenKey]: {
        ...(prev[screenKey] || { screen_key: screenKey }),
        screen_key: screenKey,
        [flagKey]: value,
      },
    }));
    setScreensReviewed(false);
  }

  function setOverrideRow(screenKey, row) {
    setOverrideMap((prev) => ({
      ...prev,
      [screenKey]: { ...row, screen_key: screenKey },
    }));
    setScreensReviewed(false);
  }

  function toggleModuleOpen(moduleKey, defaultOpen) {
    setModuleOpenState((prev) => {
      const current = Object.prototype.hasOwnProperty.call(prev, moduleKey) ? prev[moduleKey] : defaultOpen;
      return { ...prev, [moduleKey]: !current };
    });
  }

  async function reloadScreenAccess(targetUserId) {
    const uid = Number(targetUserId || form.id);
    if (!Number.isFinite(uid) || uid <= 0) return null;
    const refreshed = await apiFetch(`/permissions/user/${uid}/effective`);
    const screenList = Array.isArray(refreshed?.screens) ? refreshed.screens : [];
    setScreens(screenList);
    setRolePermissions(refreshed?.role_permissions || { screens: {} });
    setOverrideMap(buildOverrideMap(refreshed?.user_screen_permissions || [], screenList));
    if (refreshed?.user) {
      setUserMeta((prev) => ({ ...(prev || {}), ...refreshed.user }));
    }
    return refreshed;
  }

  const filteredScreens = useMemo(() => {
    const q = screenQuery.trim().toLowerCase();
    return (screens || []).filter((screen) => {
      const override = overrideMap[screen.screen_key] || {};
      const roleRow = rolePermissions?.screens?.[screen.screen_key] || {};
      if (screenListMode === "exceptions" && !rowHasException(override)) return false;
      if (screenListMode === "role" && !roleHasAnyAccess(roleRow) && !rowHasException(override)) return false;
      if (!q) return true;
      return (
        String(screen.screen_name || "").toLowerCase().includes(q) ||
        String(screen.screen_key || "").toLowerCase().includes(q) ||
        String(screen.module_key || "").toLowerCase().includes(q)
      );
    });
  }, [screens, screenQuery, screenListMode, overrideMap, rolePermissions]);

  const screensByModule = useMemo(() => {
    const modules = new Map();
    for (const screen of filteredScreens) {
      const key = String(screen.module_key || "other");
      if (!modules.has(key)) modules.set(key, []);
      modules.get(key).push(screen);
    }
    return Array.from(modules.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredScreens]);

  const exceptionCount = useMemo(
    () => Object.values(overrideMap || {}).filter((row) => rowHasException(row)).length,
    [overrideMap]
  );

  const roleVisibleCount = useMemo(
    () =>
      (screens || []).filter((screen) => {
        const roleRow = rolePermissions?.screens?.[screen.screen_key] || {};
        const override = overrideMap[screen.screen_key] || {};
        return roleHasAnyAccess(roleRow) || rowHasException(override);
      }).length,
    [screens, rolePermissions, overrideMap]
  );

  const roleBaselineStale =
    Boolean(form.id) &&
    String(form.role_id || "") !== String(userMeta?.role_id ?? "");

  async function saveIdentity() {
    const previousRoleId = userMeta?.role_id != null ? String(userMeta.role_id) : String(form.role_id || "");
    const role = roles.find((r) => String(r.id) === String(form.role_id)) || null;
    const aligned = role ? applyRoleProfileToForm(form, role, groups, departments) : form;
    if (role && (aligned.group_id !== form.group_id || aligned.department_key !== form.department_key)) {
      setForm(aligned);
    }
    const payload = {
      full_name: aligned.full_name,
      email: aligned.email,
      phone: aligned.phone,
      designation: aligned.designation,
      group_id: aligned.group_id ? Number(aligned.group_id) : null,
      role_id: aligned.role_id ? Number(aligned.role_id) : null,
      company_name: aligned.company_name,
      distributor_id: isDistributorUser && aligned.distributor_id ? Number(aligned.distributor_id) : null,
      employee_code: aligned.employee_code,
      department_key: aligned.department_key || null,
      employment_company_id: aligned.employment_company_id ? Number(aligned.employment_company_id) : null,
      company_ids: Array.isArray(aligned.company_ids) ? aligned.company_ids.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0) : [],
      primary_company_id: aligned.primary_company_id ? Number(aligned.primary_company_id) : null,
      primary_manager_user_id: aligned.primary_manager_user_id ? Number(aligned.primary_manager_user_id) : null,
      secondary_manager_user_id: aligned.secondary_manager_user_id ? Number(aligned.secondary_manager_user_id) : null,
      date_of_joining: aligned.date_of_joining || null,
      local_address: aligned.local_address,
      permanent_address: aligned.permanent_address,
      discount_threshold_pct: aligned.discount_threshold_pct === "" ? null : Number(aligned.discount_threshold_pct),
      is_active: Boolean(aligned.is_active),
      is_approved: Boolean(aligned.is_approved),
      password: aligned.password,
    };

    const data = form.id
      ? await apiFetch(`/users/${form.id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await apiFetch("/users", { method: "POST", body: JSON.stringify(payload) });

    const saved = data?.user || null;
    const memberships = Array.isArray(data?.memberships) ? data.memberships : [];
    if (saved) {
      const companyIds = memberships.filter((m) => m.is_active !== false).map((m) => String(m.company_id));
      const primary = memberships.find((m) => m.is_primary) || null;
      const base = normalizeUserToForm(saved);
      setUserMeta(saved);
      setForm({
        ...base,
        company_ids: companyIds,
        primary_company_id: primary?.company_id ? String(primary.company_id) : base.employment_company_id || "",
        password: "",
      });

      const nextRoleId = saved.role_id != null ? String(saved.role_id) : "";
      const roleChanged = previousRoleId !== nextRoleId;
      const wasCreate = !form.id;
      if (saved.id && (wasCreate || roleChanged)) {
        await reloadScreenAccess(saved.id);
        if (roleChanged && !wasCreate) setScreensReviewed(false);
      }
      saved.__roleChanged = roleChanged && !wasCreate;
    }
    return saved;
  }

  async function saveScreens() {
    if (!form.id) throw Object.assign(new Error("Save identity first"), { data: { error: "SAVE_IDENTITY_FIRST" } });
    await apiFetch(`/permissions/user/${form.id}/screens`, {
      method: "PUT",
      body: JSON.stringify({ screen_permissions: Object.values(overrideMap) }),
    });
    await reloadScreenAccess(form.id);
    setScreensReviewed(true);
  }

  async function saveAuthority() {
    if (!form.id) throw Object.assign(new Error("Save identity first"), { data: { error: "SAVE_IDENTITY_FIRST" } });

    const profile = resolveAuthorityProfile({
      user: userMeta,
      form,
      groups,
      roles,
      departments,
    });

    // Sales Authority: quote discount ceiling lives on the user profile, not approval_policies.
    if (profile.showSalesDiscount) {
      await saveIdentity();
    }

    // Procurement Authority: PO/GRN/PI/VP ceilings via per-user approval_policies (migration 141).
    if (profile.showProcurement) {
      const payload = [];
      for (const row of authorities) {
        const draft = authorityDraft[row.doc_type] || {};
        if (draft.clear || draft.inheritMode) {
          payload.push({ doc_type: row.doc_type, clear: true });
          continue;
        }
        const raw = String(draft.max_amount ?? "").trim();
        if (!raw || raw.toLowerCase() === "unlimited") {
          payload.push({ doc_type: row.doc_type, max_amount: null });
          continue;
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          throw Object.assign(new Error("Invalid amount"), { data: { error: `Invalid amount for ${row.label || row.doc_type}` } });
        }
        payload.push({ doc_type: row.doc_type, max_amount: n });
      }
      if (payload.length) {
        const refreshed = await apiFetch(`/users/${form.id}/approval-authority`, {
          method: "PUT",
          body: JSON.stringify({ authorities: payload }),
        });
        const authRows = Array.isArray(refreshed?.authorities) ? refreshed.authorities : [];
        setAuthorities(authRows);
        const draft = {};
        for (const row of authRows) {
          draft[row.doc_type] = {
            max_amount: row.source === "user" ? formatAmountInput(row.max_amount) : "",
            clear: false,
            inheritMode: row.source !== "user",
          };
        }
        setAuthorityDraft(draft);
      }
    }
  }

  async function saveActiveTab() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (tab === "identity") {
        const wasCreate = !form.id;
        const saved = await saveIdentity();
        if (wasCreate && saved?.id) setShowPostCreateChecklist(true);
        setNotice(
          saved?.__roleChanged
            ? "Identity saved. Role changed — screen baselines refreshed from the new role."
            : form.id || saved?.id
              ? "Identity saved."
              : "User created."
        );
        onSaved?.(saved);
      } else if (tab === "screens") {
        await saveScreens();
        setNotice("Screen access overrides saved.");
        onSaved?.(userMeta);
      } else {
        await saveAuthority();
        const profile = resolveAuthorityProfile({ user: userMeta, form, groups, roles, departments });
        if (profile.showSalesDiscount && profile.showProcurement) setNotice("Sales and procurement authority saved.");
        else if (profile.showSalesDiscount) setNotice("Sales authority (quote discount) saved.");
        else setNotice("Procurement authority saved.");
        onSaved?.(userMeta);
      }
    } catch (e) {
      const code = e?.data?.error;
      const detail = typeof e?.data?.detail === "string" ? e.data.detail.trim() : "";
      if (code === "DUPLICATE_EMAIL") setError(e?.data?.detail || "This email is already assigned to another user.");
      else if (code === "MISSING_FIELDS") setError("Full Name, Email, and Role Profile are required.");
      else if (code === "INVALID_MANAGER") setError("A user cannot report to themselves.");
      else if (code === "SAVE_IDENTITY_FIRST") setError("Save Identity first to create the user.");
      else if (code === "COMPANY_NOT_SELECTED") setError("Select an active company before editing financial authority.");
      else if (code === "INVALID_DISTRIBUTOR") setError(detail || "Select a valid Channel Partner / distributor on Identity.");
      else if (code === "FOREIGN_KEY_VIOLATION" || code === "23503") {
        setError(detail || "Save failed: a linked record is missing (distributor, company, manager, or role). Check Identity.");
      } else setError(detail || code || "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function saveAll() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const wasCreate = !form.id;
      const saved = await saveIdentity();
      const id = Number(saved?.id || form.id);
      if (!Number.isFinite(id) || id <= 0) {
        setError("Save Identity first to create the user.");
        return;
      }
      if (wasCreate) setShowPostCreateChecklist(true);
      if (!accessV2) await saveScreens();
      await saveAuthority();
      setNotice(
        accessV2
          ? "Identity and authority saved. Access exceptions are saved from the Access tab."
          : wasCreate
            ? "User created and all governance tabs saved."
            : "Identity, screens, and authority saved."
      );
      onSaved?.(saved || userMeta);
    } catch (e) {
      const code = e?.data?.error;
      const detail = typeof e?.data?.detail === "string" ? e.data.detail.trim() : "";
      if (code === "DUPLICATE_EMAIL") setError(e?.data?.detail || "This email is already assigned to another user.");
      else if (code === "MISSING_FIELDS") setError("Full Name, Email, and Role Profile are required.");
      else if (code === "INVALID_MANAGER") setError("A user cannot report to themselves.");
      else if (code === "SAVE_IDENTITY_FIRST") setError("Save Identity first to create the user.");
      else if (code === "COMPANY_NOT_SELECTED") setError("Select an active company before editing financial authority.");
      else if (code === "INVALID_DISTRIBUTOR") setError(detail || "Select a valid Channel Partner / distributor on Identity.");
      else if (code === "FOREIGN_KEY_VIOLATION" || code === "23503") {
        setError(detail || "Save failed: a linked record is missing (distributor, company, manager, or role). Check Identity.");
      } else setError(detail || code || "Failed to save all.");
    } finally {
      setSaving(false);
    }
  }

  const checklistItems = [
    {
      key: "companies",
      label: "Company memberships set",
      done: Array.isArray(form.company_ids) && form.company_ids.length > 0,
      action: () => setTab("identity"),
    },
    {
      key: "approved",
      label: "User approved",
      done: Boolean(form.is_approved),
      action: () => setTab("identity"),
    },
    {
      key: "role",
      label: "Role Profile assigned",
      done: Boolean(form.role_id),
      action: () => setTab("identity"),
    },
    {
      key: "screens",
      label: "Screen access reviewed",
      done: Boolean(screensReviewed) || (accessV2 && tab === "access"),
      action: () => setTab(accessV2 ? "access" : "screens"),
    },
    {
      key: "preview",
      label: "Verify in Access Preview",
      done: previewVisited,
      action: () => {
        if (typeof onOpenAccessPreview === "function" && form.id) {
          setPreviewVisited(true);
          onOpenAccessPreview(form.id);
        } else {
          setNotice("Open Access Preview from SuperAdmin Home to diagnose this user.");
        }
      },
    },
  ];

  function renderIdentity() {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Full Name">
            <input value={form.full_name} onChange={(e) => setField("full_name", e.target.value)} />
          </Field>
          <Field label="Email">
            <input value={form.email} onChange={(e) => setField("email", e.target.value)} />
          </Field>
          <Field label="Phone">
            <input value={form.phone} onChange={(e) => setField("phone", e.target.value)} />
          </Field>
          <Field label="Designation">
            <input list="gov-designation-options" value={form.designation} onChange={(e) => setField("designation", e.target.value)} />
            <datalist id="gov-designation-options">
              {designations
                .map((d) => String(d?.designation_name || "").trim())
                .filter(Boolean)
                .map((name) => (
                  <option key={name} value={name} />
                ))}
            </datalist>
          </Field>
          <Field label="Access profile">
            <select value={form.role_id} onChange={(e) => setRoleProfile(e.target.value)}>
              <option value="">-- Select --</option>
              {groupRolesForSelect(roles).map((bucket) => (
                <optgroup key={bucket.family} label={bucket.label}>
                  {bucket.roles.map((r) => (
                    <option key={r.id} value={String(r.id)}>
                      {r.role_name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Employee Code">
            <input value={form.employee_code} onChange={(e) => setField("employee_code", e.target.value)} />
          </Field>
        </div>

        {roleProfileMapped ? (
          <div
            style={{
              border: "1px solid #dbe4f3",
              borderRadius: 12,
              padding: "10px 12px",
              background: "#f7f9fc",
              fontSize: 13,
              color: "#334155",
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#64748b", marginBottom: 4 }}>
              Auto from Role Profile
            </div>
            <div>{formatRoleProfileSummary(roleProfileMapped, departments) || "Access band and department will be set on save."}</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
              Access band, department, and Home workspace follow this profile. Use Screen Access or Financial Authority only for exceptions.
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>
            Pick a Role Profile (for example Sales Head). User Group and Department are set automatically — no separate picks.
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Primary Manager">
            <select value={form.primary_manager_user_id} onChange={(e) => setField("primary_manager_user_id", e.target.value)}>
              <option value="">-- None --</option>
              {managerOptions.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {(u.full_name || u.email) + (u.user_code ? ` (${u.user_code})` : "")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Secondary Manager">
            <select value={form.secondary_manager_user_id} onChange={(e) => setField("secondary_manager_user_id", e.target.value)}>
              <option value="">-- None --</option>
              {managerOptions.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {(u.full_name || u.email) + (u.user_code ? ` (${u.user_code})` : "")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Employment Company">
            <select value={form.employment_company_id} onChange={(e) => setField("employment_company_id", e.target.value)}>
              <option value="">-- Select --</option>
              {companies.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.company_code} - {c.company_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date of Joining">
            <input type="date" value={form.date_of_joining} onChange={(e) => setField("date_of_joining", e.target.value)} />
          </Field>
        </div>

        <Field label="Works For (Companies)">
          <div style={{ display: "grid", gap: 8 }}>
            {companies.map((c) => {
              const cid = String(c.id);
              const checked = Array.isArray(form.company_ids) && form.company_ids.includes(cid);
              return (
                <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const nextChecked = e.target.checked;
                      setForm((prev) => {
                        const existing = Array.isArray(prev.company_ids) ? prev.company_ids : [];
                        const next = nextChecked ? Array.from(new Set([...existing, cid])) : existing.filter((x) => x !== cid);
                        const primaryOk = prev.primary_company_id && next.includes(String(prev.primary_company_id));
                        return {
                          ...prev,
                          company_ids: next,
                          primary_company_id: primaryOk ? prev.primary_company_id : next[0] || "",
                        };
                      });
                    }}
                  />
                  {c.company_code} - {c.company_name}
                </label>
              );
            })}
          </div>
        </Field>

        {isDistributorUser ? (
          <Field label="Channel Partner">
            <select value={form.distributor_id} onChange={(e) => setField("distributor_id", e.target.value)}>
              <option value="">-- Select --</option>
              {distributors.map((d) => (
                <option key={d.id} value={String(d.id)}>
                  {d.company_name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Password (leave blank to keep)">
            <input type="password" value={form.password} onChange={(e) => setField("password", e.target.value)} autoComplete="new-password" />
          </Field>
          <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5, alignSelf: "end", paddingBottom: 8 }}>
            Quote discount and spend ceilings are managed under Financial Authority.
          </div>
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={Boolean(form.is_active)} onChange={(e) => setField("is_active", e.target.checked)} />
            Active
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={Boolean(form.is_approved)} onChange={(e) => setField("is_approved", e.target.checked)} />
            Approved
          </label>
        </div>
      </div>
    );
  }

  function renderScreens() {
    if (!form.id) {
      return <div style={{ color: "#64748b" }}>Save Identity first, then set screen overrides for this person.</div>;
    }

    const modeChip = (mode, label) => (
      <button
        type="button"
        onClick={() => {
          setScreenListMode(mode);
          setExpandedScreenKey("");
        }}
        style={{
          borderRadius: 999,
          border: screenListMode === mode ? "1px solid #96b5ff" : "1px solid #dfe5ef",
          background: screenListMode === mode ? "#eef4ff" : "#fff",
          fontWeight: 700,
          padding: "6px 12px",
        }}
      >
        {label}
      </button>
    );

    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>
          Most people only need the role baseline. Browse role-visible screens, expand a row to customize, or jump to exceptions.
          Inherit keeps the role; Allow / Block create person-level exceptions.
        </div>

        {roleBaselineStale ? (
          <div
            style={{
              border: "1px solid #f0d9a8",
              borderRadius: 12,
              padding: "10px 12px",
              background: "#fff7ea",
              fontSize: 13,
              color: "#8b5a00",
              lineHeight: 1.5,
            }}
          >
            Role changed on Identity but is not saved yet. Save Identity to refresh screen baselines before editing exceptions.
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {modeChip("role", `Profile-visible (${roleVisibleCount})`)}
          {modeChip("exceptions", `Exceptions only (${exceptionCount})`)}
          {modeChip("all", `All screens (${screens.length})`)}
          <input
            value={screenQuery}
            onChange={(e) => setScreenQuery(e.target.value)}
            placeholder="Search screens or modules"
            style={{ flex: "1 1 220px", minWidth: 180 }}
          />
          <button
            type="button"
            onClick={() => {
              setScreensReviewed(true);
              setNotice(
                exceptionCount
                  ? `Screen access marked reviewed (${exceptionCount} exception${exceptionCount === 1 ? "" : "s"}).`
                  : "Screen access marked reviewed — role baseline only, no exceptions."
              );
            }}
          >
            {screensReviewed ? "Reviewed" : "Mark as reviewed"}
          </button>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {screensByModule.map(([moduleKey, moduleScreens]) => {
            const moduleHasException = moduleScreens.some((screen) =>
              rowHasException(overrideMap[screen.screen_key] || {})
            );
            const defaultOpen = Boolean(screenQuery.trim()) || moduleHasException || screenListMode === "exceptions";
            const isOpen = Object.prototype.hasOwnProperty.call(moduleOpenState, moduleKey)
              ? moduleOpenState[moduleKey]
              : defaultOpen;

            return (
              <div key={moduleKey} style={{ border: "1px solid #e2e8f0", borderRadius: 14, overflow: "hidden" }}>
                <button
                  type="button"
                  onClick={() => toggleModuleOpen(moduleKey, defaultOpen)}
                  style={{
                    width: "100%",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    background: "#f8fafc",
                    border: "none",
                    borderBottom: isOpen ? "1px solid #e2e8f0" : "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      fontWeight: 800,
                      fontSize: 12,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      color: "#475569",
                    }}
                  >
                    {isOpen ? "▾" : "▸"} {moduleKey.replace(/_/g, " ")} · {moduleScreens.length}
                  </span>
                  {moduleHasException ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        minHeight: 22,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: "rgba(217, 119, 6, 0.12)",
                        color: "#b45309",
                        fontSize: 10,
                        fontWeight: 800,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}
                    >
                      Has exceptions
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>Role baseline</span>
                  )}
                </button>

                {isOpen ? (
                  <div style={{ display: "grid", gap: 0 }}>
                    {moduleScreens.map((screen) => {
                      const roleRow = rolePermissions?.screens?.[screen.screen_key] || {};
                      const override = overrideMap[screen.screen_key] || {};
                      const hasException = rowHasException(override);
                      const effectiveLabels = effectiveAccessSummary(roleRow, override);
                      const roleLabels = SCREEN_FLAGS.filter((f) => roleRow[f.key]).map((f) => f.label);
                      const expanded = expandedScreenKey === screen.screen_key;

                      return (
                        <div
                          key={screen.screen_key}
                          style={{
                            borderTop: "1px solid #eef2f7",
                            padding: "10px 12px",
                            background: hasException ? "#fffdf7" : "#fff",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 10,
                              flexWrap: "wrap",
                              alignItems: "flex-start",
                            }}
                          >
                            <div style={{ minWidth: 180, flex: "1 1 200px" }}>
                              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <strong style={{ fontSize: 14 }}>{screen.screen_name || screen.screen_key}</strong>
                                {hasException ? (
                                  <span
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      minHeight: 20,
                                      padding: "1px 7px",
                                      borderRadius: 999,
                                      background: "rgba(217, 119, 6, 0.12)",
                                      color: "#b45309",
                                      fontSize: 10,
                                      fontWeight: 800,
                                      letterSpacing: "0.04em",
                                      textTransform: "uppercase",
                                    }}
                                  >
                                    Exception
                                  </span>
                                ) : null}
                              </div>
                              <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
                                Role: {roleLabels.join(", ") || "none"}
                                {" · "}
                                Effective: {effectiveLabels.length ? effectiveLabels.join(", ") : "none"}
                              </div>
                            </div>

                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                              {!expanded ? (
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                  {SCREEN_FLAGS.map((flag) => {
                                    const on = effectiveFlag(roleRow, override, flag.key);
                                    return (
                                      <span
                                        key={flag.key}
                                        title={`${flag.label}: ${on ? "on" : "off"}`}
                                        style={{
                                          display: "inline-flex",
                                          alignItems: "center",
                                          minHeight: 22,
                                          padding: "2px 7px",
                                          borderRadius: 999,
                                          fontSize: 10,
                                          fontWeight: 700,
                                          background: on ? "rgba(20, 128, 74, 0.12)" : "#f1f5f9",
                                          color: on ? "#14804a" : "#94a3b8",
                                        }}
                                      >
                                        {flag.label}
                                      </span>
                                    );
                                  })}
                                </div>
                              ) : null}
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedScreenKey((prev) => (prev === screen.screen_key ? "" : screen.screen_key))
                                }
                                style={{
                                  borderRadius: 10,
                                  border: "1px solid #cad5e5",
                                  background: expanded ? "#eef4ff" : "#fff",
                                  padding: "6px 10px",
                                  fontSize: 12,
                                  fontWeight: 700,
                                }}
                              >
                                {expanded ? "Done" : "Customize"}
                              </button>
                              {hasException ? (
                                <button
                                  type="button"
                                  onClick={() => setOverrideRow(screen.screen_key, clearScreenOverrides(screen.screen_key))}
                                  style={{
                                    borderRadius: 10,
                                    border: "1px solid #e2e8f0",
                                    background: "#fff",
                                    padding: "6px 10px",
                                    fontSize: 12,
                                  }}
                                >
                                  Reset
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setOverrideRow(screen.screen_key, blockScreenOverrides(screen.screen_key))}
                                  style={{
                                    borderRadius: 10,
                                    border: "1px solid #e2e8f0",
                                    background: "#fff",
                                    padding: "6px 10px",
                                    fontSize: 12,
                                  }}
                                >
                                  Block screen
                                </button>
                              )}
                            </div>
                          </div>

                          {expanded ? (
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                                gap: 8,
                                marginTop: 10,
                                paddingTop: 10,
                                borderTop: "1px dashed #e2e8f0",
                              }}
                            >
                              {SCREEN_FLAGS.map((flag) => {
                                const effective = effectiveFlag(roleRow, override, flag.key);
                                return (
                                  <label key={flag.key} style={{ display: "grid", gap: 4, fontSize: 11, color: "#64748b" }}>
                                    <span>
                                      {flag.label}
                                      <span style={{ opacity: 0.65 }}> · role {roleRow[flag.key] ? "on" : "off"}</span>
                                      <span style={{ color: effective ? "#14804a" : "#94a3b8", fontWeight: 700 }}>
                                        {" "}
                                        · effective {effective ? "on" : "off"}
                                      </span>
                                    </span>
                                    <select
                                      value={triStateToValue(override[flag.key])}
                                      onChange={(e) =>
                                        setOverrideFlag(screen.screen_key, flag.key, valueToTriState(e.target.value))
                                      }
                                      style={{
                                        borderRadius: 10,
                                        border: "1px solid #cad5e5",
                                        padding: "7px 8px",
                                        fontSize: 12,
                                      }}
                                    >
                                      <option value="inherit">Inherit</option>
                                      <option value="allow">Allow</option>
                                      <option value="block">Block</option>
                                    </select>
                                  </label>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
          {!filteredScreens.length ? (
            <div style={{ color: "#64748b" }}>
              {screenListMode === "exceptions"
                ? "No screen exceptions for this user."
                : screenListMode === "role"
                  ? "No role-visible screens for this user. Switch to All screens to grant access."
                  : "No screens match this search."}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function renderAuthority() {
    if (!form.id) {
      return <div style={{ color: "#64748b" }}>Save Identity first, then set this person's authority ceilings.</div>;
    }

    const profile = authorityProfile;
    const profileLabel =
      profile.kind === "distributor" ? "Channel Partner" : profile.kind === "sales" ? "Internal Sales" : "Internal Operations / Procurement";

    return (
      <div style={{ display: "grid", gap: 16 }}>
        <div
          style={{
            borderRadius: 14,
            border: "1px solid #e2e8f0",
            background: "#f8fafc",
            padding: "12px 14px",
            fontSize: 13,
            color: "#475569",
            lineHeight: 1.6,
          }}
        >
          Profile lane: <strong>{profileLabel}</strong>. Sales Authority saves to the user profile as max quote discount %.
          Procurement Authority saves as per-user approval policy ceilings.
        </div>

        {profile.showSalesDiscount ? (
          <div
            style={{
              border: "1px solid #f3d2a0",
              borderRadius: 14,
              padding: 14,
              background: "#fff7ed",
              display: "grid",
              gap: 10,
            }}
          >
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#b45309" }}>
                Sales Authority
              </div>
              <strong style={{ display: "block", marginTop: 4 }}>Maximum Autonomous Quote Discount %</strong>
              <div style={{ marginTop: 4, fontSize: 12, color: "#9a3412", lineHeight: 1.5 }}>
                How far this person can discount a quote before manager approval is required. Blank inherits the group default
                {groupDiscountDefault !== null && groupDiscountDefault !== undefined ? ` (${groupDiscountDefault}%)` : ""}.
              </div>
            </div>
            <Field label="Max quote discount %">
              <input
                inputMode="decimal"
                placeholder={
                  groupDiscountDefault !== null && groupDiscountDefault !== undefined
                    ? `Group default ${groupDiscountDefault}`
                    : "e.g. 5"
                }
                value={form.discount_threshold_pct}
                onChange={(e) => setField("discount_threshold_pct", e.target.value)}
              />
            </Field>
          </div>
        ) : null}

        {profile.showProcurement ? (
          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#1d4ed8" }}>
                Procurement Authority
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>
                Personal spend ceilings for PO, GRN, Purchase Invoice, and Vendor Payment. Inherit clears the user override and
                falls back to role/group policy.
              </div>
            </div>

            {!authorities.length ? (
              <div style={{ color: "#64748b", lineHeight: 1.6 }}>
                No procurement authority rows loaded. Select an active company in the shell, then reopen this person.
              </div>
            ) : (
              authorities.map((row) => {
                const draft = authorityDraft[row.doc_type] || { max_amount: "", inheritMode: true, clear: false };
                return (
                  <div
                    key={row.doc_type}
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: 14,
                      padding: 14,
                      background: "#fff",
                      display: "grid",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <div>
                        <strong>{row.label || row.doc_type}</strong>
                        <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
                          Effective:{" "}
                          {row.max_amount === null || row.max_amount === undefined
                            ? row.source === "none"
                              ? "—"
                              : "Unlimited"
                            : Number(row.max_amount).toLocaleString("en-IN")}
                        </div>
                      </div>
                      {sourceBadge(row.source)}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
                      <Field label="Personal max amount">
                        <input
                          inputMode="decimal"
                          placeholder={row.source === "user" ? "Unlimited if empty with override" : "e.g. 500000"}
                          value={draft.inheritMode ? "" : draft.max_amount}
                          disabled={draft.inheritMode}
                          onChange={(e) =>
                            setAuthorityDraft((prev) => ({
                              ...prev,
                              [row.doc_type]: {
                                ...prev[row.doc_type],
                                max_amount: e.target.value,
                                inheritMode: false,
                                clear: false,
                              },
                            }))
                          }
                        />
                      </Field>
                      <button
                        type="button"
                        onClick={() =>
                          setAuthorityDraft((prev) => ({
                            ...prev,
                            [row.doc_type]: { max_amount: "", inheritMode: true, clear: true },
                          }))
                        }
                      >
                        Inherit
                      </button>
                    </div>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={!draft.inheritMode}
                        onChange={(e) =>
                          setAuthorityDraft((prev) => ({
                            ...prev,
                            [row.doc_type]: {
                              max_amount: e.target.checked
                                ? prev[row.doc_type]?.max_amount || formatAmountInput(row.max_amount) || ""
                                : "",
                              inheritMode: !e.target.checked,
                              clear: !e.target.checked,
                            },
                          }))
                        }
                      />
                      Set personal override
                    </label>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div
            style={{
              borderRadius: 14,
              border: "1px dashed #cbd5e1",
              padding: 14,
              color: "#64748b",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            Procurement spend ceilings are hidden for Channel Partners. Use Sales Authority (quote discount %) only.
          </div>
        )}
      </div>
    );
  }

  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      width={820}
      eyebrow="Identity governance"
      title={userMeta?.full_name || form.full_name || (userId ? "User" : "New user")}
      subtitle={
        userMeta || form.id
          ? `${userMeta?.role_name || selectedRole?.role_name || "No Role Profile"} · ${roleProfileMapped?.privilegeBandLabel || roleProfileMapped?.groupName || selectedGroup?.group_name || "No access band"} · ${userMeta?.email || form.email || ""}`
          : "Pick a Role Profile — access band and department are set automatically."
      }
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            Close
          </button>
          <button type="button" onClick={saveAll} disabled={saving || loading}>
            {saving ? "Saving..." : "Save all"}
          </button>
          {tab !== "access" ? (
            <button type="button" onClick={saveActiveTab} disabled={saving || loading}>
              {saving ? "Saving..." : tab === "identity" ? "Save Identity" : tab === "screens" ? "Save Screen Access" : "Save Authority"}
            </button>
          ) : null}
        </>
      }
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }} className="org-chart-no-print">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            style={{
              borderRadius: 999,
              border: tab === item.key ? "1px solid #96b5ff" : "1px solid #dfe5ef",
              background: tab === item.key ? "#eef4ff" : "#fff",
              fontWeight: 700,
              padding: "8px 14px",
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? <div style={{ color: "#64748b" }}>Loading governance…</div> : null}
      {error ? <div style={{ color: "#b91c1c", fontWeight: 700, marginBottom: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#166534", fontWeight: 700, marginBottom: 12 }}>{notice}</div> : null}

      {showPostCreateChecklist && form.id ? (
        <div
          style={{
            border: "1px solid #c7dbff",
            borderRadius: 14,
            padding: 14,
            background: "#f5f9ff",
            marginBottom: 14,
            display: "grid",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 800 }}>Post-create checklist</div>
              <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>
                Finish company, approval, role, and exceptions here. Use Access Preview only to diagnose.
              </div>
            </div>
            <button type="button" onClick={() => setShowPostCreateChecklist(false)}>
              Dismiss
            </button>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {checklistItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={item.action}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  border: "1px solid #d7e3f7",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: item.done ? "#f0fdf4" : "#fff",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>{item.label}</span>
                <span style={{ fontSize: 12, opacity: 0.72 }}>{item.done ? "Done" : "Open"}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!loading && tab === "identity" ? renderIdentity() : null}
      {!loading && tab === "screens" ? renderScreens() : null}
      {!loading && tab === "access" ? <PersonAccessPanel userId={form.id} onSaved={() => onSaved?.(userMeta)} /> : null}
      {!loading && tab === "authority" ? renderAuthority() : null}
    </SlideOverDrawer>
  );
}
