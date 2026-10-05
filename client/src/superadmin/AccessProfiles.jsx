import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "../shared/joshUi";

const API = "/permissions/access";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.detail || data?.error || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const LEVELS = ["none", "viewer", "contributor", "approver"];
const LEVEL_LABELS = { none: "None", viewer: "Viewer", contributor: "Contributor", approver: "Approver", custom: "Custom" };
const LEVEL_HELP = {
  none: "Can't see it",
  viewer: "Read only",
  contributor: "Create and edit",
  approver: "Create, edit and approve",
};
const FLAG_LABELS = {
  can_view: "view",
  can_create: "create",
  can_edit: "edit",
  can_approve: "approve",
};

function scopeOptions(isQuotes) {
  return isQuotes
    ? [
        ["team", "Own + team"],
        ["all", "All records"],
      ]
    : [
        ["own", "Own records"],
        ["all", "All records"],
      ];
}

function describeFlag(flag, gained) {
  if (flag === "own_records_only") return gained ? "all records (no longer limited to own)" : "limited to own records";
  if (flag === "financial_masking") return gained ? "unmasked" : "masked";
  return FLAG_LABELS[flag] || flag;
}

function customSummary(g) {
  const on = Object.keys(FLAG_LABELS).filter((k) => g?.[k]);
  return `${on.length ? on.map((k) => FLAG_LABELS[k]).join(", ") : "no access"}${g?.own_records_only ? " · own records" : ""}`;
}

function grantLabel(g, isQuotes) {
  if (!g) return "";
  if (g.level === "custom") return `Custom (${customSummary(g)})`;
  if (g.level === "none") return "None";
  const scope = scopeOptions(isQuotes).find(([v]) => v === g.scope)?.[1] || g.scope;
  return `${LEVEL_LABELS[g.level]} · ${scope}`;
}

function draftFromState(state) {
  const modules = {};
  const screens = {};
  for (const m of state?.modules || []) {
    modules[m.module_key] = m.grant ? { ...m.grant } : null;
    for (const s of m.screens) screens[s.screen_key] = s.grant ? { ...s.grant } : null;
  }
  for (const s of state?.other || []) if (!s.read_only) screens[s.screen_key] = s.grant ? { ...s.grant } : null;
  return { modules, screens };
}

function payloadFromDraft(draft) {
  const grants = [];
  for (const [moduleKey, g] of Object.entries(draft.modules)) {
    if (g) grants.push({ module_key: moduleKey, level: g.level, scope: g.scope });
  }
  for (const [screenKey, g] of Object.entries(draft.screens)) {
    if (!g) continue;
    if (g.level === "custom") grants.push({ screen_key: screenKey, ...g });
    else grants.push({ screen_key: screenKey, level: g.level, scope: g.scope });
  }
  return grants.sort((a, b) => `${a.module_key || ""}${a.screen_key || ""}`.localeCompare(`${b.module_key || ""}${b.screen_key || ""}`));
}

function defaultScope(isQuotes) {
  return isQuotes ? "team" : "all";
}

function Tabs({ tab, setTab }) {
  const items = [
    ["profiles", "Profiles"],
    ["rules", "Baseline rules"],
    ["verify", "Verification"],
  ];
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {items.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => setTab(key)}
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            border: "1px solid #cbd5e1",
            background: tab === key ? "#1e293b" : "#fff",
            color: tab === key ? "#fff" : "#1e293b",
            fontWeight: 700,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ImpactPanel({ impact }) {
  if (!impact) return null;
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 14, padding: 12, background: impact.affected_users ? "#fffaf0" : "#f6fef9" }}>
      <div style={{ fontWeight: 800 }}>
        {impact.affected_users
          ? `This change affects ${impact.affected_users} of ${impact.total_users} active ${impact.total_users === 1 ? "person" : "people"} on this profile.`
          : `No one's access changes (${impact.total_users} active ${impact.total_users === 1 ? "person" : "people"} on this profile).`}
      </div>
      {impact.users?.map((u) => (
        <div key={u.user_id} style={{ marginTop: 10, fontSize: 12 }}>
          <div style={{ fontWeight: 700 }}>
            {u.full_name} <span style={{ color: "#64748b", fontWeight: 400 }}>{u.email}</span>
            {u.superadmin_bypass ? <span style={{ color: "#64748b" }}> · SuperAdmin (bypasses checks, no practical effect)</span> : null}
          </div>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
            {u.changes.map((c) => (
              <li key={c.screen_key}>
                {c.screen_name}:{" "}
                {c.gained.length ? <span style={{ color: "#14804a" }}>gains {c.gained.map((f) => describeFlag(f, true)).join(", ")}</span> : null}
                {c.gained.length && c.lost.length ? "; " : ""}
                {c.lost.length ? <span style={{ color: "#b00020" }}>loses {c.lost.map((f) => describeFlag(f, false)).join(", ")}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ProfilesTab() {
  const [profiles, setProfiles] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [impact, setImpact] = useState(null);
  const [impactKey, setImpactKey] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function loadProfiles() {
    const data = await apiFetch(`${API}/profiles`);
    setProfiles(data.profiles || []);
    if (!selectedId && data.profiles?.length) setSelectedId(data.profiles.find((p) => p.is_active)?.id || data.profiles[0].id);
  }

  async function loadProfile(id) {
    setError("");
    setImpact(null);
    setImpactKey("");
    setReason("");
    try {
      const data = await apiFetch(`${API}/profiles/${id}`);
      setState(data);
      setDraft(draftFromState(data));
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    loadProfiles().catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId) loadProfile(selectedId);
  }, [selectedId]);

  const baselinePayload = useMemo(() => (state ? JSON.stringify(payloadFromDraft(draftFromState(state))) : ""), [state]);
  const payload = useMemo(() => (draft ? payloadFromDraft(draft) : []), [draft]);
  const payloadKey = JSON.stringify(payload);
  const dirty = Boolean(state) && payloadKey !== baselinePayload;
  const previewCurrent = impact && impactKey === payloadKey;

  function setModule(moduleKey, grant) {
    setDraft((d) => ({ ...d, modules: { ...d.modules, [moduleKey]: grant } }));
  }
  function setScreen(screenKey, grant) {
    setDraft((d) => ({ ...d, screens: { ...d.screens, [screenKey]: grant } }));
  }

  function selectProfile(id) {
    if (dirty && !window.confirm("Discard unsaved changes to this profile?")) return;
    setSelectedId(id);
  }

  async function preview() {
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(`${API}/profiles/${selectedId}/preview`, { method: "POST", body: JSON.stringify({ grants: payload }) });
      setImpact(data.impact);
      setImpactKey(payloadKey);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!previewCurrent) return;
    if (impact.affected_users && !window.confirm(`Save and change access for ${impact.affected_users} ${impact.affected_users === 1 ? "person" : "people"}?`)) return;
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(`${API}/profiles/${selectedId}`, { method: "PUT", body: JSON.stringify({ grants: payload, reason }) });
      setState(data);
      setDraft(draftFromState(data));
      setImpact(null);
      setImpactKey("");
      setReason("");
      toast(`Saved ${data.role?.role_name}. ${data.impact?.affected_users || 0} ${data.impact?.affected_users === 1 ? "person" : "people"} affected.`, "success");
      loadProfiles().catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function renderScreenRow(screen, { moduleGrant, isQuotes, inheritsModule }) {
    const g = draft.screens[screen.screen_key];
    const inherited = inheritsModule && moduleGrant ? grantLabel(moduleGrant, isQuotes) : `Default (${LEVEL_LABELS[screen.default_level] || screen.default_level})`;
    const selectValue = g ? g.level : "inherit";
    return (
      <tr key={screen.screen_key} style={{ background: "#fafbfd", fontSize: 12 }}>
        <td style={{ padding: "6px 8px 6px 28px" }}>
          {screen.screen_name}
          {g ? <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 999, background: "#eef2ff", color: "#3730a3", fontSize: 11 }}>exception</span> : null}
        </td>
        <td colSpan={4} style={{ padding: 6 }}>
          <select
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "inherit") setScreen(screen.screen_key, null);
              else if (v !== "custom") setScreen(screen.screen_key, { level: v, scope: v === "none" ? "all" : g?.scope && g.level !== "custom" ? g.scope : defaultScope(screen.screen_key === "quotes") });
            }}
            style={{ height: 28 }}
          >
            <option value="inherit">Inherit: {inherited}</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABELS[l]}
              </option>
            ))}
            {g?.level === "custom" ? <option value="custom">Custom ({customSummary(g)})</option> : null}
          </select>
        </td>
        <td style={{ padding: 6 }}>
          {g && g.level !== "none" && g.level !== "custom" ? (
            <select value={g.scope} onChange={(e) => setScreen(screen.screen_key, { ...g, scope: e.target.value })} style={{ height: 28 }}>
              {scopeOptions(screen.screen_key === "quotes").map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          ) : null}
        </td>
      </tr>
    );
  }

  const exceptionCount = (screens) => screens.filter((s) => draft?.screens[s.screen_key]).length;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16, alignItems: "start" }}>
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 8, background: "#fff" }}>
        {profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => selectProfile(p.id)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 10px",
              borderRadius: 10,
              border: "none",
              background: Number(selectedId) === Number(p.id) ? "#eef4ff" : "transparent",
              opacity: p.is_active ? 1 : 0.55,
            }}
          >
            <div style={{ fontWeight: 700 }}>{p.role_name}</div>
            <div style={{ fontSize: 11, color: "#64748b" }}>
              {p.active_users} {p.active_users === 1 ? "person" : "people"}
              {p.screen_grants ? ` · ${p.screen_grants} exceptions` : ""}
              {p.custom_grants ? ` · ${p.custom_grants} custom` : ""}
              {!p.is_active ? " · inactive" : ""}
            </div>
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
        {state && draft ? (
          <>
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14, background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>{state.role.role_name}</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    {state.role.active_users} active {state.role.active_users === 1 ? "person" : "people"} · Group: {state.role.maps_to_group || "Staff"}
                    {state.role.maps_to_group === "SuperAdmin" ? " (bypasses all checks)" : ""}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#475569", maxWidth: 420 }}>
                  Pick a level per module. Expand a module to give one screen a different level. "Default" means the profile has no setting and the
                  system default applies.
                </div>
              </div>

              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: "left", fontSize: 12, color: "#64748b" }}>
                      <th style={{ padding: 8 }}>Module</th>
                      {LEVELS.map((l) => (
                        <th key={l} style={{ padding: 8, textAlign: "center" }} title={LEVEL_HELP[l]}>
                          {LEVEL_LABELS[l]}
                          <div style={{ fontWeight: 400, fontSize: 11 }}>{LEVEL_HELP[l]}</div>
                        </th>
                      ))}
                      <th style={{ padding: 8 }}>Records</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.modules.map((m) => {
                      const g = draft.modules[m.module_key];
                      const isQuotes = m.module_key === "quotes";
                      const exceptions = exceptionCount(m.screens);
                      return (
                        <Fragment key={m.module_key}>
                          <tr style={{ borderTop: "1px solid #eef2f7" }}>
                            <td style={{ padding: 8 }}>
                              <button
                                type="button"
                                onClick={() => setExpanded((e) => ({ ...e, [m.module_key]: !e[m.module_key] }))}
                                style={{ border: "none", background: "none", padding: 0, fontWeight: 700, cursor: "pointer" }}
                              >
                                {expanded[m.module_key] ? "▾" : "▸"} {m.label}
                              </button>
                              <div style={{ fontSize: 11, color: "#64748b" }}>
                                {m.screens.length} screens
                                {exceptions ? ` · ${exceptions} exception${exceptions === 1 ? "" : "s"}` : ""}
                                {!g ? " · Default" : ""}
                                {g ? (
                                  <button type="button" onClick={() => setModule(m.module_key, null)} style={{ marginLeft: 6, border: "none", background: "none", color: "#2354d5", fontSize: 11, padding: 0, cursor: "pointer" }}>
                                    reset to default
                                  </button>
                                ) : null}
                              </div>
                            </td>
                            {LEVELS.map((l) => (
                              <td key={l} style={{ padding: 8, textAlign: "center" }}>
                                <input
                                  type="radio"
                                  name={`lvl-${m.module_key}`}
                                  checked={g?.level === l}
                                  onChange={() => setModule(m.module_key, { level: l, scope: l === "none" ? "all" : g?.scope && g.level !== "none" ? g.scope : defaultScope(isQuotes) })}
                                />
                              </td>
                            ))}
                            <td style={{ padding: 8 }}>
                              {g && g.level !== "none" ? (
                                <select value={g.scope} onChange={(e) => setModule(m.module_key, { ...g, scope: e.target.value })} style={{ height: 30 }}>
                                  {scopeOptions(isQuotes).map(([v, label]) => (
                                    <option key={v} value={v}>
                                      {label}
                                    </option>
                                  ))}
                                </select>
                              ) : null}
                            </td>
                          </tr>
                          {expanded[m.module_key] ? m.screens.map((s) => renderScreenRow(s, { moduleGrant: g, isQuotes, inheritsModule: true })) : null}
                        </Fragment>
                      );
                    })}
                    <tr style={{ borderTop: "2px solid #e2e8f0" }}>
                      <td colSpan={6} style={{ padding: 8 }}>
                        <button
                          type="button"
                          onClick={() => setExpanded((e) => ({ ...e, __other: !e.__other }))}
                          style={{ border: "none", background: "none", padding: 0, fontWeight: 700, cursor: "pointer" }}
                        >
                          {expanded.__other ? "▾" : "▸"} Admin & other screens
                        </button>
                        <span style={{ fontSize: 11, color: "#64748b", marginLeft: 8 }}>Set per screen; normally only SuperAdmin uses these.</span>
                      </td>
                    </tr>
                    {expanded.__other
                      ? state.other.map((s) =>
                          s.read_only ? (
                            <tr key={s.screen_key} style={{ background: "#fafbfd", fontSize: 12 }}>
                              <td style={{ padding: "6px 8px 6px 28px" }}>{s.screen_key}</td>
                              <td colSpan={5} style={{ padding: 6, color: "#64748b" }}>
                                {grantLabel(s.grant, false)} (kept as is; not part of the screen catalog)
                              </td>
                            </tr>
                          ) : (
                            renderScreenRow(s, { moduleGrant: null, isQuotes: false, inheritsModule: false })
                          )
                        )
                      : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14, background: "#fff", display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" onClick={preview} disabled={busy || !dirty}>
                  {busy && !previewCurrent ? "Checking…" : "Preview who is affected"}
                </button>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for the change (optional, kept in the audit log)" style={{ flex: 1, minWidth: 260, height: 32, padding: "0 10px" }} />
                <button type="button" className="button-primary" onClick={save} disabled={busy || !dirty || !previewCurrent}>
                  Save profile
                </button>
                <button type="button" onClick={() => loadProfile(selectedId)} disabled={busy || !dirty}>
                  Discard changes
                </button>
              </div>
              {!dirty ? <div style={{ fontSize: 12, color: "#64748b" }}>No unsaved changes.</div> : null}
              {dirty && !previewCurrent ? <div style={{ fontSize: 12, color: "#8b5a00" }}>Preview the impact before saving.</div> : null}
              {previewCurrent ? <ImpactPanel impact={impact} /> : null}
            </div>
          </>
        ) : (
          <div style={{ color: "#64748b" }}>Loading…</div>
        )}
      </div>
    </div>
  );
}

const EMPTY_RULE = { id: null, company_id: "", department_key: "", designation_name: "", suggested_role_id: "", priority: 100, note: "", is_active: true };

function RulesTab() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(EMPTY_RULE);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState({ company_id: "", department_key: "", designation: "" });
  const [testResult, setTestResult] = useState(undefined);

  async function load() {
    setData(await apiFetch(`${API}/baseline-rules`));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const body = JSON.stringify({ ...form, company_id: form.company_id || null, suggested_role_id: Number(form.suggested_role_id) || null });
      if (form.id) await apiFetch(`${API}/baseline-rules/${form.id}`, { method: "PUT", body });
      else await apiFetch(`${API}/baseline-rules`, { method: "POST", body });
      toast(form.id ? "Rule updated." : "Rule added.", "success");
      setForm(EMPTY_RULE);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule) {
    if (!window.confirm("Delete this rule?")) return;
    try {
      await apiFetch(`${API}/baseline-rules/${rule.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function runTest() {
    const params = new URLSearchParams();
    if (test.company_id) params.set("company_id", test.company_id);
    if (test.department_key) params.set("department_key", test.department_key);
    if (test.designation) params.set("designation", test.designation);
    try {
      const r = await apiFetch(`${API}/baseline-rules/suggest?${params}`);
      setTestResult(r.suggestion || null);
    } catch (e) {
      setError(e.message);
    }
  }

  if (!data) return <div style={{ color: "#64748b" }}>{error || "Loading…"}</div>;
  const field = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ fontSize: 13, color: "#475569" }}>
        Rules suggest an access profile from a person's department and designation (optionally per company). The most specific active rule wins: company,
        then designation, then department; lower priority numbers win ties.
      </div>
      {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14, background: "#fff", display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 800 }}>{form.id ? "Edit rule" : "Add rule"}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Company
            <select value={form.company_id || ""} onChange={(e) => field("company_id", e.target.value)} style={{ height: 32 }}>
              <option value="">Any company</option>
              {data.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company_name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Department
            <select value={form.department_key || ""} onChange={(e) => field("department_key", e.target.value)} style={{ height: 32 }}>
              <option value="">Any department</option>
              {data.departments.map((d) => (
                <option key={d.department_key} value={d.department_key}>
                  {d.department_name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Designation
            <input list="access-designations" value={form.designation_name || ""} onChange={(e) => field("designation_name", e.target.value)} placeholder="Any designation" style={{ height: 32, padding: "0 8px" }} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Suggested access profile
            <select value={form.suggested_role_id || ""} onChange={(e) => field("suggested_role_id", e.target.value)} style={{ height: 32 }}>
              <option value="">Pick a profile</option>
              {data.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.role_name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Priority
            <input type="number" value={form.priority} onChange={(e) => field("priority", e.target.value)} style={{ height: 32, padding: "0 8px" }} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            Note
            <input value={form.note || ""} onChange={(e) => field("note", e.target.value)} style={{ height: 32, padding: "0 8px" }} />
          </label>
        </div>
        <datalist id="access-designations">
          {data.designations.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={form.is_active} onChange={(e) => field("is_active", e.target.checked)} /> Active
          </label>
          <button type="button" className="button-primary" onClick={save} disabled={busy}>
            {form.id ? "Save rule" : "Add rule"}
          </button>
          {form.id ? (
            <button type="button" onClick={() => setForm(EMPTY_RULE)}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14, background: "#fff" }}>
        {data.rules.length ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: 12, color: "#64748b" }}>
                <th style={{ padding: 6 }}>Company</th>
                <th style={{ padding: 6 }}>Department</th>
                <th style={{ padding: 6 }}>Designation</th>
                <th style={{ padding: 6 }}>Suggests</th>
                <th style={{ padding: 6 }}>Priority</th>
                <th style={{ padding: 6 }} />
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #eef2f7", opacity: r.is_active ? 1 : 0.5 }}>
                  <td style={{ padding: 6 }}>{r.company_name || "Any"}</td>
                  <td style={{ padding: 6 }}>{r.department_name || "Any"}</td>
                  <td style={{ padding: 6 }}>{r.designation_name || "Any"}</td>
                  <td style={{ padding: 6, fontWeight: 700 }}>{r.suggested_role_name}</td>
                  <td style={{ padding: 6 }}>{r.priority}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>
                    <button type="button" onClick={() => setForm({ ...EMPTY_RULE, ...r, company_id: r.company_id || "", department_key: r.department_key || "", designation_name: r.designation_name || "" })}>
                      Edit
                    </button>{" "}
                    <button type="button" onClick={() => remove(r)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 13, color: "#64748b" }}>No rules yet.</div>
        )}
      </div>

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14, background: "#fff", display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 800 }}>Test a match</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={test.company_id} onChange={(e) => setTest((t) => ({ ...t, company_id: e.target.value }))} style={{ height: 32 }}>
            <option value="">Any company</option>
            {data.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company_name}
              </option>
            ))}
          </select>
          <select value={test.department_key} onChange={(e) => setTest((t) => ({ ...t, department_key: e.target.value }))} style={{ height: 32 }}>
            <option value="">No department</option>
            {data.departments.map((d) => (
              <option key={d.department_key} value={d.department_key}>
                {d.department_name}
              </option>
            ))}
          </select>
          <input list="access-designations" value={test.designation} onChange={(e) => setTest((t) => ({ ...t, designation: e.target.value }))} placeholder="Designation" style={{ height: 32, padding: "0 8px" }} />
          <button type="button" onClick={runTest}>
            Find suggested profile
          </button>
        </div>
        {testResult === undefined ? null : testResult ? (
          <div style={{ fontSize: 13 }}>
            Suggests <strong>{testResult.role_name}</strong> (rule #{testResult.rule_id}).
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#8b5a00" }}>No rule matches; the profile has to be picked by hand.</div>
        )}
      </div>
    </div>
  );
}

function VerifyTab() {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const [s, r] = await Promise.all([apiFetch(`${API}/status`), apiFetch(`${API}/verification-runs`)]);
    setStatus(s);
    setRuns(r.runs || []);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function run(kind) {
    if (kind === "backfill" && !window.confirm("Rebuild every profile's grants from the current Rights Matrix? Edits made only in Access Profiles are kept in the Rights Matrix too, so nothing is lost.")) return;
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch(`${API}/${kind}`, { method: "POST", body: "{}" });
      const rep = r.report;
      if (kind === "cutover-check") {
        toast(
          rep.cutover_ready
            ? `Ready: with deny-by-default nobody loses access (${rep.users_checked - rep.bypass_users} people checked).`
            : `Not ready: ${rep.mismatch_users} people would lose access, ${rep.blockers.length} blockers.`,
          rep.cutover_ready ? "success" : "error"
        );
      } else {
        toast(rep.zero_difference ? `Zero difference across ${rep.users_checked} people.` : `${rep.mismatch_users} people differ. See details.`, rep.zero_difference ? "success" : "error");
      }
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14, background: "#fff", fontSize: 13 }}>
        <div>
          Mode: <strong>{status?.mode || "…"}</strong>
          {status?.mode === "shadow" ? " (the Rights Matrix still enforces access; Access Profiles are compared in the background)" : ""}
          {status?.mode === "on" ? " (Access Profiles enforce access)" : ""}
        </div>
        {status?.counts ? (
          <div style={{ color: "#64748b", marginTop: 4 }}>
            {status.counts.grants} profile grants · {status.counts.overrides} user overrides · {status.counts.baseline_rules} baseline rules
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button type="button" className="button-primary" onClick={() => run("verify")} disabled={busy}>
            {busy ? "Running…" : "Run zero-difference check"}
          </button>
          {status?.mode !== "on" ? (
            <button type="button" onClick={() => run("backfill")} disabled={busy}>
              Rebuild from Rights Matrix
            </button>
          ) : null}
        </div>
      </div>
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14, background: "#fff", fontSize: 13, display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 800 }}>Cutover (Phase 4)</div>
        <div style={{ color: "#475569" }}>
          Switching ACCESS_MODEL_V2 to <strong>on</strong> makes Access Profiles enforce access with <strong>deny by default</strong>: a screen with no grant is
          closed, so new screens start closed. The Rights Matrix and per-user Screen Access become read-only. Run the readiness check first; it must show
          zero people losing access and no blockers.
        </div>
        {status?.last_cutover_check ? (
          <div style={{ fontWeight: 700, color: status.cutover_ready ? "#14804a" : "#b00020" }}>
            Last check #{status.last_cutover_check.id} ({new Date(status.last_cutover_check.created_at).toLocaleString()}):{" "}
            {status.cutover_ready
              ? "ready — nobody loses access"
              : `${status.last_cutover_check.mismatch_users} people would lose access · ${(status.last_cutover_check.blockers || []).length} blockers`}
          </div>
        ) : (
          <div style={{ color: "#8b5a00" }}>No readiness check run yet.</div>
        )}
        {(status?.last_cutover_check?.blockers || []).map((b) => (
          <div key={b.user_id} style={{ fontSize: 12, color: "#b00020" }}>
            {b.full_name} ({b.email}): {b.problem === "NO_ACCESS_PROFILE" ? "has no access profile — assign one" : b.problem}
          </div>
        ))}
        <div>
          <button type="button" className="button-primary" onClick={() => run("cutover-check")} disabled={busy}>
            {busy ? "Running…" : "Run cutover readiness check"}
          </button>
        </div>
      </div>
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 14, background: "#fff" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: 12, color: "#64748b" }}>
              <th style={{ padding: 6 }}>Run</th>
              <th style={{ padding: 6 }}>When</th>
              <th style={{ padding: 6 }}>People</th>
              <th style={{ padding: 6 }}>Screen checks</th>
              <th style={{ padding: 6 }}>Result</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <Fragment key={r.id}>
                <tr style={{ borderTop: "1px solid #eef2f7" }}>
                  <td style={{ padding: 6 }}>
                    #{r.id} {r.run_kind === "cutover_check" ? "cutover check (deny by default)" : r.run_kind}
                  </td>
                  <td style={{ padding: 6 }}>
                    {new Date(r.created_at).toLocaleString()}
                    {r.ran_by_name ? ` · ${r.ran_by_name}` : ""}
                  </td>
                  <td style={{ padding: 6 }}>{r.users_checked}</td>
                  <td style={{ padding: 6 }}>{r.screens_checked}</td>
                  <td style={{ padding: 6, fontWeight: 700, color: r.mismatch_users ? "#b00020" : "#14804a" }}>
                    {r.mismatch_users ? `${r.mismatch_users} people, ${r.mismatch_count} differences` : "Zero difference"}
                  </td>
                </tr>
                {Array.isArray(r.details) && r.details.length ? (
                  <tr>
                    <td colSpan={5} style={{ padding: "0 6px 8px 24px", fontSize: 12 }}>
                      {r.details.slice(0, 20).map((d) => (
                        <div key={d.user_id}>
                          {d.full_name}: {d.changes.map((c) => `${c.screen_key} (${[...c.gained.map((f) => `+${f}`), ...c.lost.map((f) => `-${f}`)].join(" ")})`).join(", ")}
                        </div>
                      ))}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AccessProfiles() {
  const [tab, setTab] = useState("profiles");
  return (
    <div style={{ maxWidth: 1360, width: "100%", display: "grid", gap: 16 }}>
      <section style={{ border: "1px solid #dfe5ef", borderRadius: 24, padding: 20, background: "#fff", display: "grid", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.6 }}>Access redesign</div>
          <h2 style={{ margin: "4px 0 4px" }}>Access Profiles</h2>
          <div style={{ fontSize: 13, color: "#475569" }}>
            An Access Profile is what used to be called a role. Saving here also updates the Rights Matrix, so both always agree.
          </div>
        </div>
        <Tabs tab={tab} setTab={setTab} />
      </section>
      {tab === "profiles" ? <ProfilesTab /> : null}
      {tab === "rules" ? <RulesTab /> : null}
      {tab === "verify" ? <VerifyTab /> : null}
    </div>
  );
}
