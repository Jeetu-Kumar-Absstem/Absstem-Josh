import { useEffect, useMemo, useState } from "react";
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

const FLAG_FIELDS = [
  { key: "can_view", label: "View" },
  { key: "can_create", label: "Create" },
  { key: "can_edit", label: "Edit" },
  { key: "can_approve", label: "Approve" },
  { key: "own_records_only", label: "Own only" },
];

const DESK_PREVIEW = DESK_VISIBILITY;

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
        override.financial_masking === null || override.financial_masking === undefined ? Boolean(row.financial_masking) : Boolean(override.financial_masking),
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

function StatCard({ label, value, note, accent }) {
  return (
    <div
      style={{
        border: "1px solid #d7deec",
        borderRadius: 18,
        padding: 14,
        background: "#fff",
        boxShadow: "0 14px 30px rgba(15, 23, 42, 0.08)",
        borderTop: `4px solid ${accent}`,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>{note}</div>
    </div>
  );
}

function Surface({ title, subtitle, actions, children }) {
  return (
    <section
      style={{
        border: "1px solid #d7deec",
        borderRadius: 24,
        background: "#fff",
        padding: 18,
        boxShadow: "0 18px 38px rgba(15, 23, 42, 0.08)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.74, marginTop: 6 }}>{subtitle}</div> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
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
        border: active ? `1px solid ${tone}` : "1px solid #d7deec",
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

function LaneButton({ active, label, note, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        borderRadius: 18,
        padding: "14px 16px",
        border: active ? "1px solid #93c5fd" : "1px solid #d7deec",
        background: active ? "linear-gradient(180deg, #eff6ff 0%, #f8fbff 100%)" : "#fff",
        boxShadow: active ? "0 12px 28px rgba(29, 78, 216, 0.12)" : "0 10px 22px rgba(15, 23, 42, 0.05)",
        display: "grid",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 14 }}>{label}</strong>
      <span style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.5 }}>{note}</span>
    </button>
  );
}

function StatusPill({ label, tone, background }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        color: tone,
        background,
      }}
    >
      {label}
    </span>
  );
}

export default function UserAccessPreview({ launch, onConsumeLaunch, onNavigate = null }) {
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [screenSearch, setScreenSearch] = useState("");
  const [activeLane, setActiveLane] = useState("all");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState(null);
  const [overrideMap, setOverrideMap] = useState({});

  function openOrgAccessEdit(extraLaunch = {}) {
    if (typeof onNavigate !== "function") {
      setNotice("Open Org & access from SuperAdmin to edit this user.");
      return;
    }
    if (!selectedUserId) {
      setNotice("Select a user first.");
      return;
    }
    onNavigate("users", {
      resetQuote: true,
      adminLaunch: {
        view: "orgchart",
        userId: selectedUserId,
        governanceTab: "screens",
        ...extraLaunch,
      },
    });
  }

  useEffect(() => {
    let active = true;
    setLoadingUsers(true);
    apiFetch("/users")
      .then((data) => {
        if (!active) return;
        const nextUsers = Array.isArray(data?.users) ? data.users : [];
        setUsers(nextUsers);
        setSelectedUserId((current) => current || nextUsers[0]?.id || null);
      })
      .catch((err) => {
        if (!active) return;
        setError(err?.data?.error || "Failed to load users.");
      })
      .finally(() => {
        if (active) setLoadingUsers(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!launch) return;
    if (launch.focusLane) {
      setActiveLane(String(launch.focusLane));
    }
    if (launch.userId) {
      setSelectedUserId(launch.userId);
    }
    onConsumeLaunch?.();
  }, [launch, onConsumeLaunch]);

  useEffect(() => {
    if (!selectedUserId) return;
    let active = true;
    setDetailLoading(true);
    setError("");
    setNotice("");
    apiFetch(`/permissions/user/${selectedUserId}/effective`)
      .then((data) => {
        if (!active) return;
        setDetail(data);
        setOverrideMap(buildOverrideMap(data?.user_screen_permissions, data?.screens));
      })
      .catch((err) => {
        if (!active) return;
        setError(err?.data?.error || "Failed to load access preview.");
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedUserId]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((user) =>
      [user.full_name, user.email, user.role_name, user.group_name, user.department_name || user.department_key]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [users, search]);

  const effectivePermissions = useMemo(
    () => mergePermissions(detail?.role_permissions, overrideMap),
    [detail?.role_permissions, overrideMap]
  );
  const roleScreens = detail?.role_permissions?.screens || {};
  const exceptionRows = useMemo(
    () =>
      (detail?.screens || []).filter((screen) => {
        const row = overrideMap?.[screen.screen_key];
        return FLAG_FIELDS.some((field) => row?.[field.key] !== null && row?.[field.key] !== undefined);
      }),
    [detail?.screens, overrideMap]
  );

  const exceptionScreenKeys = useMemo(() => new Set(exceptionRows.map((row) => row.screen_key)), [exceptionRows]);

  const changedByExceptionRows = useMemo(
    () =>
      (detail?.screens || []).filter((screen) =>
        FLAG_FIELDS.some(
          (field) => Boolean(roleScreens?.[screen.screen_key]?.[field.key]) !== Boolean(effectivePermissions?.screens?.[screen.screen_key]?.[field.key])
        )
      ),
    [detail?.screens, effectivePermissions?.screens, roleScreens]
  );

  const changedByExceptionKeys = useMemo(() => new Set(changedByExceptionRows.map((row) => row.screen_key)), [changedByExceptionRows]);

  const overrideCount = useMemo(
    () =>
      Object.values(overrideMap).reduce(
        (total, row) =>
          total +
          FLAG_FIELDS.reduce((count, field) => count + (row?.[field.key] === null || row?.[field.key] === undefined ? 0 : 1), 0),
        0
      ),
    [overrideMap]
  );

  const visibleScreens = useMemo(
    () =>
      (detail?.screens || []).filter((screen) => {
        const perms = effectivePermissions?.screens?.[screen.screen_key];
        return Boolean(perms?.can_view);
      }),
    [detail?.screens, effectivePermissions]
  );

  const visibleDesks = useMemo(() => {
    const screens = effectivePermissions?.screens || {};
    return DESK_PREVIEW.filter((desk) => desk.evaluate(screens));
  }, [effectivePermissions]);

  const actionChecks = useMemo(() => {
    const screens = effectivePermissions?.screens || {};
    const buildCheck = (label, blockers, hint) => ({
      label,
      blockers,
      allowed: blockers.length === 0,
      reason: blockers.length ? blockers.join(" ") : hint,
    });
    return [
      buildCheck(
        "Create standard quote",
        [
          !screens.quotes?.can_view ? "Quotes is hidden." : null,
          screens.quotes?.can_view && !screens.quotes?.can_create ? "Quotes create is blocked." : null,
        ].filter(Boolean),
        "Quotes view and create are available."
      ),
      buildCheck(
        "Create aftermarket quote from Service",
        [
          !screens.service_warranty?.can_view ? "Service Warranty is hidden." : null,
          !screens.quotes?.can_view ? "Quotes is hidden." : null,
          screens.quotes?.can_view && !screens.quotes?.can_create ? "Quotes create is blocked." : null,
        ].filter(Boolean),
        "Service Warranty and Quotes creation are both available."
      ),
      buildCheck(
        "Dispatch order fulfilment",
        [
          !screens.dispatches?.can_view ? "Dispatches is hidden." : null,
          screens.dispatches?.can_view && !screens.sales_orders?.can_view ? "Sales Orders is hidden, so dispatch flow breaks." : null,
        ].filter(Boolean),
        "Dispatches and Sales Orders are both visible."
      ),
      buildCheck(
        "Review purchase invoice validation",
        [
          !screens.purchase_invoices?.can_view ? "Purchase Invoices is hidden." : null,
          screens.purchase_invoices?.can_view && !screens.three_way_match?.can_view ? "Three Way Match is hidden." : null,
        ].filter(Boolean),
        "Purchase Invoices and Three Way Match are both visible."
      ),
      buildCheck(
        "Approve purchase workflows",
        [
          !screens.approval_desk?.can_view ? "Approval Desk is hidden." : null,
          screens.approval_desk?.can_view && !screens.approval_desk?.can_approve ? "Approval Desk approve is blocked." : null,
        ].filter(Boolean),
        "Approval Desk view and approve are available."
      ),
      buildCheck(
        "Open Org & access",
        [!screens.users?.can_view ? "Org & access is hidden." : null].filter(Boolean),
        "Org & access is visible."
      ),
    ];
  }, [effectivePermissions]);

  const governanceAlerts = useMemo(() => {
    const screens = effectivePermissions?.screens || {};
    const alerts = [];
    if (screens.service_warranty?.can_view && (!screens.quotes?.can_view || !screens.quotes?.can_create)) {
      alerts.push({
        key: "aftermarket-quote-gap",
        tone: "#b00020",
        background: "#fff3f3",
        border: "#ffd8d8",
        title: "Aftermarket quote path is broken",
        detail: "Service Warranty is visible, but Quotes view/create is still missing for this user.",
      });
    }
    if (screens.dispatches?.can_view && !screens.sales_orders?.can_view) {
      alerts.push({
        key: "dispatch-gap",
        tone: "#8b5a00",
        background: "#fff9ec",
        border: "#f2dfb0",
        title: "Dispatch flow is incomplete",
        detail: "Dispatches is visible, but Sales Orders is hidden for the same user.",
      });
    }
    if (screens.approval_desk?.can_view && !screens.approval_desk?.can_approve) {
      alerts.push({
        key: "approval-gap",
        tone: "#234a8f",
        background: "#eef4ff",
        border: "#d9e6ff",
        title: "Approval desk opens without approval power",
        detail: "The user can land in Approval Desk but still cannot approve actions.",
      });
    }
    if (screens.purchase_invoices?.can_view && !screens.three_way_match?.can_view) {
      alerts.push({
        key: "purchase-gap",
        tone: "#7c3aed",
        background: "#f6f2ff",
        border: "#e6ddff",
        title: "Invoice review path is incomplete",
        detail: "Purchase Invoices is visible, but Three Way Match is hidden for the same user.",
      });
    }
    return alerts;
  }, [effectivePermissions]);

  const allowedActionCount = actionChecks.filter((item) => item.allowed).length;
  const blockedActionCount = actionChecks.length - allowedActionCount;
  const nextBlockedAction = actionChecks.find((item) => !item.allowed) || null;

  const groupedRows = useMemo(() => {
    const q = screenSearch.trim().toLowerCase();
    const modules = new Map();
    for (const screen of detail?.screens || []) {
      const hasException = exceptionScreenKeys.has(screen.screen_key);
      const changedByException = changedByExceptionKeys.has(screen.screen_key);
      if (activeLane === "exceptions" && !hasException) continue;
      if (activeLane === "changed" && !changedByException) continue;
      if (activeLane === "blocked" && effectivePermissions?.screens?.[screen.screen_key]?.can_view) continue;
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
      const bucket = modules.get(screen.module_key) || [];
      bucket.push(screen);
      modules.set(screen.module_key, bucket);
    }
    return Array.from(modules.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [activeLane, changedByExceptionKeys, detail?.screens, effectivePermissions?.screens, exceptionScreenKeys, screenSearch]);

  const laneOptions = [
    { key: "all", label: "All screens", note: "See the full effective visibility map." },
    { key: "exceptions", label: "Exceptions", note: exceptionRows.length ? `${exceptionRows.length} screens have user-level overrides.` : "No user-specific exceptions applied." },
    { key: "changed", label: "Changed result", note: changedByExceptionRows.length ? `${changedByExceptionRows.length} screens differ from the base role.` : "Effective access matches the base role." },
    { key: "blocked", label: "Blocked view", note: blockedActionCount ? "Review screens that stay hidden after merges." : "No blocked actions are currently flagged." },
  ];

  const focusActions = [
    {
      key: "edit-org-access",
      title: "Edit in Org & access",
      note: selectedUserId
        ? "Open the governance drawer for this user to fix identity, screen exceptions, or financial authority."
        : "Select a user first, then jump to Org & access to edit.",
      tone: "#14804a",
      active: false,
      onClick: () => openOrgAccessEdit({ governanceTab: nextBlockedAction || exceptionRows.length ? "screens" : "identity" }),
    },
    {
      key: "blocked-actions",
      title: "Resolve blocked actions",
      note: nextBlockedAction ? `${nextBlockedAction.label} is still blocked. ${nextBlockedAction.reason}` : "Core operational checks are currently allowed.",
      tone: nextBlockedAction ? "#b00020" : "#14804a",
      active: activeLane === "blocked",
      onClick: () => {
        if (nextBlockedAction) {
          openOrgAccessEdit({ governanceTab: "screens" });
          return;
        }
        setActiveLane("all");
      },
    },
    {
      key: "review-exceptions",
      title: "Review user exceptions",
      note: exceptionRows.length
        ? `${exceptionRows.length} screens have user-specific overrides. Edit them in Org & access — keep only real exceptions.`
        : "No explicit exceptions are applied for this user right now.",
      tone: exceptionRows.length ? "#d97706" : "#14804a",
      active: activeLane === "exceptions",
      onClick: () => {
        if (exceptionRows.length) {
          openOrgAccessEdit({ governanceTab: "screens" });
          return;
        }
        setActiveLane("exceptions");
      },
    },
    {
      key: "role-vs-effective",
      title: "Check changed outcomes",
      note: changedByExceptionRows.length
        ? `${changedByExceptionRows.length} screens behave differently from the base role after user overrides are merged.`
        : "Effective outcomes currently match the role baseline.",
      tone: changedByExceptionRows.length ? "#234a8f" : "#14804a",
      active: activeLane === "changed",
      onClick: () => setActiveLane("changed"),
    },
  ];

  const listUser = users.find((user) => Number(user.id) === Number(selectedUserId)) || null;
  const selectedUser = detail?.user ? { ...listUser, ...detail.user } : listUser;

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <Surface
        title="Access Preview"
        subtitle="Diagnose what a user can actually see and do. Edit exceptions in Org & access; use Role templates for baseline roles."
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="button-primary"
              onClick={() => openOrgAccessEdit({ governanceTab: "screens" })}
              disabled={!selectedUserId}
            >
              Edit in Org & access
            </button>
            <button
              type="button"
              onClick={() =>
                typeof onNavigate === "function"
                  ? onNavigate("rights", { resetQuote: true })
                  : setNotice("Open Role templates from SuperAdmin when available.")
              }
            >
              Open Role templates
            </button>
          </div>
        }
      >
        {error ? <div style={{ marginBottom: 12, color: "#b91c1c", fontWeight: 700 }}>{error}</div> : null}
        {notice ? <div style={{ marginBottom: 12, color: "#166534", fontWeight: 700 }}>{notice}</div> : null}

        <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", gap: 18 }}>
          <div style={{ display: "grid", gap: 14 }}>
            <div
              style={{
                border: "1px solid #d7deec",
                borderRadius: 20,
                background: "linear-gradient(180deg, #f8fbff 0%, #ffffff 100%)",
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56, marginBottom: 10 }}>User picker</div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search user, email, role, or group"
                style={{
                  width: "100%",
                  borderRadius: 12,
                  border: "1px solid #cdd6e7",
                  padding: "10px 12px",
                  marginBottom: 12,
                  fontSize: 13,
                }}
              />
              <div style={{ display: "grid", gap: 8, maxHeight: 520, overflow: "auto", paddingRight: 4 }}>
                {loadingUsers ? <div style={{ opacity: 0.7 }}>Loading users...</div> : null}
                {!loadingUsers && !filteredUsers.length ? <div style={{ opacity: 0.7 }}>No matching users.</div> : null}
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
                        border: active ? "1px solid #1d4ed8" : "1px solid #d7deec",
                        background: active ? "#eff6ff" : "#fff",
                        padding: 12,
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 800 }}>{user.full_name}</div>
                      <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>{user.email}</div>
                      <div style={{ fontSize: 12, opacity: 0.64, marginTop: 6 }}>
                        {user.role_name || "No role"} | {user.group_name || "No group"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gap: 18 }}>
            <div
              style={{
                border: "1px solid #d7deec",
                borderRadius: 20,
                background: "#fff",
                padding: 16,
                boxShadow: "0 14px 30px rgba(15, 23, 42, 0.05)",
              }}
            >
              {detailLoading ? (
                <div style={{ opacity: 0.7 }}>Loading effective access...</div>
              ) : selectedUser ? (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 12, opacity: 0.56, textTransform: "uppercase", letterSpacing: "0.08em" }}>Selected user</div>
                      <h2 style={{ margin: "8px 0 0", fontSize: 28, lineHeight: 1.1 }}>{selectedUser.full_name}</h2>
                      <div style={{ marginTop: 8, fontSize: 13, opacity: 0.72 }}>
                        {selectedUser.email} | {selectedUser.role_name || "No role"} | {selectedUser.group_name || "No group"}
                      </div>
                    </div>
                    <div style={{ minWidth: 240, display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 13, opacity: 0.78 }}>
                        <strong>Department:</strong> {selectedUser.department_name || selectedUser.department_key || "Not mapped"}
                      </div>
                      <div style={{ fontSize: 13, opacity: 0.78 }}>
                        <strong>Primary manager:</strong> {selectedUser.primary_manager_name || "Not mapped"}
                      </div>
                      <div style={{ fontSize: 13, opacity: 0.78 }}>
                        <strong>Secondary manager:</strong> {selectedUser.secondary_manager_name || "Not mapped"}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ opacity: 0.7 }}>Pick a user to inspect access.</div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
              <StatCard label="Visible screens" value={visibleScreens.length} note="Effective screen visibility after role plus overrides." accent="#2563eb" />
              <StatCard label="Visible desks" value={visibleDesks.length} note="Desk shells the user can reach in the app." accent="#0f766e" />
              <StatCard label="Exception flags" value={overrideCount} note="User-specific override decisions applied on top of role." accent="#d97706" />
              <StatCard
                label="Blocked probes"
                value={blockedActionCount}
                note="Operational checks currently failing in the simulator."
                accent="#7c3aed"
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 18 }}>
              <Surface title="Fix now" subtitle="Diagnose here, then jump to Org & access to edit the selected user.">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                  {focusActions.map((item) => (
                    <FocusActionCard key={item.key} {...item} />
                  ))}
                </div>
              </Surface>

              <Surface title="Review rail" subtitle="A compact governance readout before you edit any exception.">
                <div style={{ display: "grid", gap: 10 }}>
                  {governanceAlerts.map((alert) => (
                    <div key={alert.key} style={{ border: `1px solid ${alert.border}`, background: alert.background, borderRadius: 14, padding: 12 }}>
                      <strong style={{ color: alert.tone, fontSize: 13 }}>{alert.title}</strong>
                      <div style={{ fontSize: 12, opacity: 0.82, marginTop: 4 }}>{alert.detail}</div>
                    </div>
                  ))}
                  {!governanceAlerts.length ? (
                    <div style={{ border: "1px solid #d6f4df", background: "#f2fff6", borderRadius: 14, padding: 12 }}>
                      <strong style={{ color: "#0a7a35", fontSize: 13 }}>Visibility baseline looks coherent</strong>
                      <div style={{ fontSize: 12, opacity: 0.78, marginTop: 4 }}>
                        No major dependency gaps are currently flagged in the effective access set.
                      </div>
                    </div>
                  ) : null}
                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                    Allowed probes: {allowedActionCount} of {actionChecks.length} • Changed by exception: {changedByExceptionRows.length}
                  </div>
                </div>
              </Surface>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 18 }}>
              <Surface title="Effective visibility" subtitle="What the user can actually see right now, including desk shells that combine multiple screens.">
                <div style={{ display: "grid", gap: 14 }}>
                  <div>
                    <div style={{ fontWeight: 800, marginBottom: 8 }}>Visible desks</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {visibleDesks.length ? visibleDesks.map((desk) => (
                        <span key={desk.key} style={{ borderRadius: 999, padding: "8px 10px", background: "#eff6ff", color: "#1d4ed8", fontWeight: 700, fontSize: 12 }}>
                          {desk.label}
                        </span>
                      )) : <span style={{ opacity: 0.68 }}>No desk shells visible.</span>}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontWeight: 800, marginBottom: 8 }}>Visible screens</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {visibleScreens.map((screen) => (
                        <span key={screen.screen_key} style={{ borderRadius: 999, padding: "8px 10px", background: "#f8fafc", border: "1px solid #d7deec", fontSize: 12 }}>
                          {screen.screen_name}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </Surface>

              <Surface title="Action Probe" subtitle="Check whether key business flows are allowed and why.">
                <div style={{ display: "grid", gap: 10 }}>
                  {actionChecks.map((check) => (
                    <div key={check.label} style={{ borderRadius: 16, border: "1px solid #d7deec", padding: 12, background: check.allowed ? "#f0fdf4" : "#fff7ed" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ fontWeight: 800 }}>{check.label}</div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: check.allowed ? "#15803d" : "#b45309" }}>{check.allowed ? "Allowed" : "Blocked"}</div>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>{check.reason}</div>
                    </div>
                  ))}
                </div>
              </Surface>
            </div>

            <Surface
              title="User Exceptions (read-only)"
              subtitle="Diagnose overrides here. Edit them in Org & access so the role stays the base source of truth."
              actions={
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    type="button"
                    className="button-primary compact-button"
                    onClick={() => openOrgAccessEdit({ governanceTab: "screens" })}
                    disabled={!selectedUserId}
                  >
                    Edit exceptions in Org & access
                  </button>
                  <input
                    value={screenSearch}
                    onChange={(event) => setScreenSearch(event.target.value)}
                    placeholder="Filter screens"
                    style={{
                      borderRadius: 12,
                      border: "1px solid #cdd6e7",
                      padding: "10px 12px",
                      minWidth: 220,
                    }}
                  />
                  {activeLane !== "all" ? (
                    <button
                      type="button"
                      onClick={() => setActiveLane("all")}
                      style={{ borderRadius: 10, border: "1px solid #cdd6e7", background: "#fff", padding: "8px 10px", cursor: "pointer" }}
                    >
                      Clear lane
                    </button>
                  ) : null}
                </div>
              }
            >
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 14 }}>
                {laneOptions.map((item) => (
                  <LaneButton key={item.key} active={activeLane === item.key} label={item.label} note={item.note} onClick={() => setActiveLane(item.key)} />
                ))}
              </div>
              <div style={{ display: "grid", gap: 14 }}>
                {groupedRows.map(([moduleKey, rows]) => (
                  <div key={moduleKey} style={{ border: "1px solid #e2e8f0", borderRadius: 18, overflow: "hidden" }}>
                    <div style={{ padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontWeight: 800, textTransform: "capitalize" }}>
                      {moduleKey.replace(/_/g, " ")}
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1020 }}>
                        <thead>
                          <tr style={{ background: "#fff" }}>
                            <th style={{ textAlign: "left", padding: 12, borderBottom: "1px solid #e2e8f0" }}>Screen</th>
                            {FLAG_FIELDS.map((field) => (
                              <th key={field.key} style={{ textAlign: "left", padding: 12, borderBottom: "1px solid #e2e8f0" }}>
                                {field.label}
                              </th>
                            ))}
                            <th style={{ textAlign: "left", padding: 12, borderBottom: "1px solid #e2e8f0" }}>Effective</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((screen) => {
                            const row = overrideMap[screen.screen_key] || {};
                            const effective = effectivePermissions?.screens?.[screen.screen_key] || {};
                            const roleBase = roleScreens?.[screen.screen_key] || {};
                            const hasException = exceptionScreenKeys.has(screen.screen_key);
                            const changedByException = changedByExceptionKeys.has(screen.screen_key);
                            return (
                              <tr key={screen.screen_key}>
                                <td style={{ padding: 12, borderBottom: "1px solid #eef2f7", verticalAlign: "top" }}>
                                  <div style={{ fontWeight: 700 }}>{screen.screen_name}</div>
                                  <div style={{ fontSize: 12, opacity: 0.62, marginTop: 4 }}>{screen.screen_key}</div>
                                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                                    <StatusPill
                                      label={roleBase.can_view ? "Role visible" : "Role hidden"}
                                      tone={roleBase.can_view ? "#234a8f" : "#5b6475"}
                                      background={roleBase.can_view ? "#eef4ff" : "#f4f6f8"}
                                    />
                                    {hasException ? (
                                      <StatusPill
                                        label="User exception"
                                        tone="#b45309"
                                        background="#fff6e8"
                                      />
                                    ) : null}
                                    {changedByException ? (
                                      <StatusPill
                                        label="Outcome changed"
                                        tone="#7c3aed"
                                        background="#f3efff"
                                      />
                                    ) : null}
                                  </div>
                                </td>
                                {FLAG_FIELDS.map((field) => {
                                  const overrideValue = row[field.key];
                                  const label =
                                    overrideValue === true || overrideValue === "true"
                                      ? "Force yes"
                                      : overrideValue === false || overrideValue === "false"
                                        ? "Force no"
                                        : "Inherit";
                                  return (
                                    <td key={field.key} style={{ padding: 12, borderBottom: "1px solid #eef2f7", verticalAlign: "top" }}>
                                      <StatusPill
                                        label={label}
                                        tone={label === "Inherit" ? "#5b6475" : "#92400e"}
                                        background={label === "Inherit" ? "#f4f6f8" : "#fff6e8"}
                                      />
                                    </td>
                                  );
                                })}
                                <td style={{ padding: 12, borderBottom: "1px solid #eef2f7", verticalAlign: "top" }}>
                                  <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
                                    <div>View: {Boolean(roleBase.can_view) ? "Role yes" : "Role no"} | {effective.can_view ? "Effective yes" : "Effective no"}</div>
                                    <div>Create: {Boolean(roleBase.can_create) ? "Role yes" : "Role no"} | {effective.can_create ? "Effective yes" : "Effective no"}</div>
                                    <div>Edit: {Boolean(roleBase.can_edit) ? "Role yes" : "Role no"} | {effective.can_edit ? "Effective yes" : "Effective no"}</div>
                                    <div>Approve: {Boolean(roleBase.can_approve) ? "Role yes" : "Role no"} | {effective.can_approve ? "Effective yes" : "Effective no"}</div>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
                {!groupedRows.length ? <div style={{ opacity: 0.7 }}>No screens match the current lane and filter.</div> : null}
              </div>
            </Surface>
          </div>
        </div>
      </Surface>
    </div>
  );
}
