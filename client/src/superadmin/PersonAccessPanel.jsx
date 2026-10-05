import { useEffect, useMemo, useState } from "react";

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

const API = "/permissions/access";
const LEVELS = ["none", "viewer", "contributor", "approver"];
const LEVEL_LABEL = { none: "None", viewer: "Viewer", contributor: "Contributor", approver: "Approver", custom: "Custom", mixed: "Mixed" };
const LEVEL_TONE = {
  none: { bg: "#f1f5f9", fg: "#475569" },
  viewer: { bg: "#e0f2fe", fg: "#075985" },
  contributor: { bg: "#dcfce7", fg: "#166534" },
  approver: { bg: "#ede9fe", fg: "#5b21b6" },
  custom: { bg: "#fef3c7", fg: "#92400e" },
  mixed: { bg: "#fff7ed", fg: "#9a3412" },
};
const FLAG_LABEL = { can_view: "view", can_create: "create", can_edit: "edit", can_approve: "approve", own_records_only: "own-only", financial_masking: "masking" };

const isTeamTarget = (moduleKey, screenKey) => moduleKey === "quotes" || screenKey === "quotes";
const scopeOptions = (moduleKey, screenKey) =>
  isTeamTarget(moduleKey, screenKey)
    ? [
        { value: "team", label: "Own + team" },
        { value: "all", label: "All records" },
      ]
    : [
        { value: "own", label: "Own records" },
        { value: "all", label: "All records" },
      ];

function levelText(item) {
  if (!item) return "—";
  const base = LEVEL_LABEL[item.level] || item.level;
  if (item.level === "none" || item.level === "mixed" || !item.scope || item.scope === "all") return base;
  return `${base} (${item.scope === "team" ? "team" : "own"})`;
}

function Chip({ item, muted = false, title }) {
  const tone = LEVEL_TONE[item?.level] || LEVEL_TONE.none;
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        background: muted ? "#f8fafc" : tone.bg,
        color: muted ? "#64748b" : tone.fg,
        border: muted ? "1px dashed #cbd5e1" : "1px solid transparent",
        whiteSpace: "nowrap",
      }}
    >
      {levelText(item)}
    </span>
  );
}

function errorText(e, fallback) {
  const code = e?.data?.error;
  const detail = typeof e?.data?.detail === "string" ? e.data.detail : "";
  if (code === "ACCESS_V2_OFF") return "Access Profiles are switched off (ACCESS_MODEL_V2=off).";
  if (code === "REASON_REQUIRED") return "Give a reason for the exception.";
  if (code === "PROFILE_GROUP_CHANGE" || code === "PROFILE_PRIVILEGED") return detail || "Change this profile from the Identity tab.";
  return detail || code || fallback;
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Person Command Center access tab: inherited (profile) vs exceptions (overrides) per module and screen.
 * Only the screens touched are sent; every save is previewed first.
 */
export default function PersonAccessPanel({ userId, onSaved = null }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState({}); // screen_key -> { level, scope } | { clear: true }
  const [pendingRole, setPendingRole] = useState("");
  const [moduleScope, setModuleScope] = useState({});
  const [expanded, setExpanded] = useState({});
  const [reason, setReason] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewKey, setPreviewKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState([]);
  const [copyFrom, setCopyFrom] = useState("");
  const [compareWith, setCompareWith] = useState("");
  const [comparison, setComparison] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  async function load() {
    if (!userId) return;
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`${API}/users/${userId}/access`);
      setState(data);
    } catch (e) {
      setError(errorText(e, "Failed to load access."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setPending({});
    setPendingRole("");
    setPreview(null);
    setComparison(null);
    setReason("");
    setExpiresOn("");
    setNotice("");
    load();
    apiFetch("/users")
      .then((d) => setPeople((Array.isArray(d?.users) ? d.users : []).filter((u) => u.is_active !== false && Number(u.id) !== Number(userId))))
      .catch(() => setPeople([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const screensByKey = useMemo(() => {
    const map = new Map();
    for (const m of state?.modules || []) for (const s of m.screens) map.set(s.screen_key, s);
    for (const s of state?.other || []) map.set(s.screen_key, s);
    return map;
  }, [state]);

  const changes = useMemo(() => {
    const expires = expiresOn ? new Date(`${expiresOn}T23:59:59`).toISOString() : null;
    return Object.entries(pending).map(([screen_key, c]) => (c.clear ? { screen_key, clear: true } : { screen_key, ...c, expires_at: expires }));
  }, [pending, expiresOn]);
  const roleId = pendingRole && Number(pendingRole) !== Number(state?.person?.role_id) ? Number(pendingRole) : null;
  const payload = useMemo(() => ({ role_id: roleId, changes }), [roleId, changes]);
  const payloadKey = JSON.stringify(payload);
  const dirty = changes.length > 0 || Boolean(roleId);
  const needsReason = changes.some((c) => !c.clear);

  function shownOverride(screen) {
    const p = pending[screen.screen_key];
    if (p) return p.clear ? null : { ...p, pending: true };
    return screen.override;
  }

  function setScreenLevel(screen, value, scope) {
    setPending((prev) => {
      const next = { ...prev };
      if (value === "inherit") {
        if (screen.override) next[screen.screen_key] = { clear: true };
        else delete next[screen.screen_key];
      } else {
        const s = value === "none" ? "all" : scope || (isTeamTarget(screen.module_key, screen.screen_key) ? "team" : "all");
        next[screen.screen_key] = { level: value, scope: s };
      }
      return next;
    });
  }

  function setModuleLevel(mod, value) {
    const scope = moduleScope[mod.module_key] || "all";
    for (const s of mod.screens) setScreenLevel(s, value, value === "none" ? "all" : scope);
  }

  async function runPreview() {
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(`${API}/users/${userId}/access/preview`, { method: "POST", body: payloadKey });
      setPreview(data.preview);
      setPreviewKey(payloadKey);
    } catch (e) {
      setError(errorText(e, "Preview failed."));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (needsReason && !reason.trim()) {
      setError("Give a reason for the exception.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(`${API}/users/${userId}/access`, { method: "PUT", body: JSON.stringify({ ...payload, reason }) });
      setState(data);
      setPending({});
      setPendingRole("");
      setPreview(null);
      setReason("");
      setExpiresOn("");
      setNotice(`Saved. ${data.preview?.changes?.length || 0} screen(s) changed.`);
      onSaved?.();
    } catch (e) {
      setError(errorText(e, "Save failed."));
    } finally {
      setBusy(false);
    }
  }

  async function loadCopyPlan() {
    if (!copyFrom) return;
    setBusy(true);
    setError("");
    try {
      const { plan } = await apiFetch(`${API}/users/${userId}/access/copy-plan?from=${copyFrom}`);
      const next = {};
      for (const c of plan.changes) next[c.screen_key] = c.clear ? { clear: true } : { level: c.level, scope: c.scope, ...(c.level === "custom" ? pickCustom(c) : {}) };
      setPending(next);
      setPendingRole(plan.role_id ? String(plan.role_id) : "");
      if (!reason) setReason(plan.suggested_reason);
      setNotice(`Loaded ${plan.from.full_name}'s access${plan.role_name ? ` (profile ${plan.role_name})` : ""}. Preview, then save.`);
    } catch (e) {
      setError(errorText(e, "Could not copy access."));
    } finally {
      setBusy(false);
    }
  }

  async function runCompare() {
    if (!compareWith) return;
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(`${API}/users/${userId}/access/compare?with=${compareWith}`);
      setComparison(data);
    } catch (e) {
      setError(errorText(e, "Compare failed."));
    } finally {
      setBusy(false);
    }
  }

  if (!userId) return <div style={{ color: "#64748b" }}>Save the person first, then set their access here.</div>;
  if (loading && !state) return <div style={{ color: "#64748b" }}>Loading access…</div>;
  if (!state) return error ? <div style={{ color: "#b91c1c", fontWeight: 700 }}>{error}</div> : null;

  const person = state.person;
  const profileName = person.role_name || "no profile";

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ border: "1px solid #dfe5ef", borderRadius: 12, padding: 12, display: "grid", gap: 10, background: "#fbfcfe" }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "#475569", display: "flex", gap: 6, alignItems: "center" }}>
            Access profile
            <select value={pendingRole || String(person.role_id || "")} onChange={(e) => setPendingRole(e.target.value)} disabled={state.superadmin_bypass}>
              {!person.role_id ? <option value="">— none —</option> : null}
              {(state.profiles || []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.role_name}
                </option>
              ))}
            </select>
          </label>
          {roleId ? <span style={{ fontSize: 12, color: "#92400e", fontWeight: 700 }}>Profile change pending</span> : null}
          <span style={{ fontSize: 12, color: "#64748b" }}>
            {person.group_name}
            {person.department_name ? ` · ${person.department_name}` : ""}
            {person.designation ? ` · ${person.designation}` : ""}
          </span>
        </div>
        {state.superadmin_bypass ? (
          <div style={{ fontSize: 12, color: "#5b21b6", fontWeight: 700 }}>SuperAdmin: passes every screen check. Exceptions have no effect.</div>
        ) : null}
        <div style={{ fontSize: 12, color: "#64748b" }}>
          {state.mode === "on"
            ? "Access Profiles enforce access. Screens with no grant are closed (deny by default)."
            : "Shadow mode: the Rights Matrix still enforces; everything saved here is mirrored to it."}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">Copy access from…</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} {u.role_name ? `· ${u.role_name}` : ""}
              </option>
            ))}
          </select>
          <button type="button" onClick={loadCopyPlan} disabled={!copyFrom || busy}>
            Load
          </button>
          <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">Compare with…</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} {u.role_name ? `· ${u.role_name}` : ""}
              </option>
            ))}
          </select>
          <button type="button" onClick={runCompare} disabled={!compareWith || busy}>
            Compare
          </button>
        </div>
      </div>

      {error ? <div style={{ color: "#b91c1c", fontWeight: 700 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#166534", fontWeight: 700 }}>{notice}</div> : null}

      {comparison ? (
        <div style={{ border: "1px solid #dfe5ef", borderRadius: 12, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>
              {comparison.a.full_name} vs {comparison.b.full_name}: {comparison.differences.length} different, {comparison.same_count} same
            </strong>
            <button type="button" onClick={() => setComparison(null)}>
              Close
            </button>
          </div>
          {comparison.differences.length ? (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: 4 }}>Screen</th>
                  <th style={{ padding: 4 }}>{comparison.a.full_name}</th>
                  <th style={{ padding: 4 }}>{comparison.b.full_name}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.differences.map((d) => (
                  <tr key={d.screen_key} style={{ borderTop: "1px solid #eef2f7" }}>
                    <td style={{ padding: 4 }}>{d.screen_name}</td>
                    <td style={{ padding: 4 }}>
                      <Chip item={d.a} />
                    </td>
                    <td style={{ padding: 4 }}>
                      <Chip item={d.b} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: 12, color: "#166534" }}>Identical access.</div>
          )}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 8 }}>
        {state.modules.map((mod) => {
          const open = Boolean(expanded[mod.module_key]);
          const pendingCount = mod.screens.filter((s) => pending[s.screen_key]).length;
          const overrideCount = mod.screens.filter((s) => shownOverride(s)).length;
          return (
            <div key={mod.module_key} style={{ border: "1px solid #dfe5ef", borderRadius: 12, padding: 10, background: pendingCount ? "#fffbeb" : "#fff" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => setExpanded((p) => ({ ...p, [mod.module_key]: !open }))}
                  style={{ all: "unset", cursor: "pointer", fontWeight: 800, fontSize: 13, minWidth: 170 }}
                >
                  {open ? "▾" : "▸"} {mod.label}
                </button>
                <Chip item={mod.inherited_level} muted title={`Inherited from ${profileName}`} />
                <span style={{ fontSize: 11, color: "#94a3b8" }}>from {profileName}</span>
                {overrideCount ? (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#92400e" }}>
                    {overrideCount} exception{overrideCount === 1 ? "" : "s"}
                  </span>
                ) : null}
                <div style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                  <button type="button" onClick={() => setModuleLevel(mod, "inherit")} disabled={!overrideCount && !pendingCount} title="Remove this module's exceptions">
                    Inherit
                  </button>
                  {LEVELS.map((lvl) => (
                    <button key={lvl} type="button" onClick={() => setModuleLevel(mod, lvl)} title={`Set every ${mod.label} screen to ${LEVEL_LABEL[lvl]}`}>
                      {LEVEL_LABEL[lvl]}
                    </button>
                  ))}
                  <select
                    value={moduleScope[mod.module_key] || "all"}
                    onChange={(e) => setModuleScope((p) => ({ ...p, [mod.module_key]: e.target.value }))}
                    style={{ fontSize: 12 }}
                  >
                    {scopeOptions(mod.module_key).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {open ? <ScreenRows screens={mod.screens} shownOverride={shownOverride} setScreenLevel={setScreenLevel} profileName={profileName} /> : null}
            </div>
          );
        })}
        <div style={{ border: "1px solid #dfe5ef", borderRadius: 12, padding: 10 }}>
          <button
            type="button"
            onClick={() => setExpanded((p) => ({ ...p, __other: !p.__other }))}
            style={{ all: "unset", cursor: "pointer", fontWeight: 800, fontSize: 13 }}
          >
            {expanded.__other ? "▾" : "▸"} Admin &amp; other screens
          </button>
          {expanded.__other ? <ScreenRows screens={state.other} shownOverride={shownOverride} setScreenLevel={setScreenLevel} profileName={profileName} /> : null}
        </div>
      </div>

      {dirty ? (
        <div style={{ border: "1px solid #fcd34d", borderRadius: 12, padding: 12, background: "#fffbeb", display: "grid", gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 13 }}>
            {changes.length} screen change{changes.length === 1 ? "" : "s"}
            {roleId ? " + profile change" : ""} pending
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, display: "grid", gap: 4, flex: "1 1 260px" }}>
              Reason {needsReason ? "(required)" : ""}
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Covering dispatch while Ravi is on leave" />
            </label>
            <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
              Exceptions expire on (optional)
              <input type="date" value={expiresOn} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpiresOn(e.target.value)} />
            </label>
          </div>
          {preview && previewKey === payloadKey ? (
            <div style={{ fontSize: 12, display: "grid", gap: 4 }}>
              {preview.profile_change ? (
                <div>
                  Profile: <strong>{preview.profile_change.from || "none"}</strong> → <strong>{preview.profile_change.to}</strong>
                </div>
              ) : null}
              {preview.changes.length ? (
                preview.changes.map((c) => (
                  <div key={c.screen_key}>
                    <strong>{c.screen_name}</strong>: <Chip item={c.before} /> → <Chip item={c.after} />
                    {c.gained.length ? <span style={{ color: "#166534" }}> +{c.gained.map((f) => FLAG_LABEL[f] || f).join(", ")}</span> : null}
                    {c.lost.length ? <span style={{ color: "#b91c1c" }}> −{c.lost.map((f) => FLAG_LABEL[f] || f).join(", ")}</span> : null}
                  </div>
                ))
              ) : (
                <div style={{ color: "#64748b" }}>No effective change (the exceptions match what the profile already gives).</div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#92400e" }}>Preview the before/after before saving.</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setPending({});
                setPendingRole("");
                setPreview(null);
              }}
              disabled={busy}
            >
              Discard
            </button>
            <button type="button" onClick={runPreview} disabled={busy}>
              Preview changes
            </button>
            <button type="button" onClick={save} disabled={busy || !preview || previewKey !== payloadKey || (needsReason && !reason.trim())}>
              {busy ? "Saving…" : "Save access"}
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ border: "1px solid #dfe5ef", borderRadius: 12, padding: 12, display: "grid", gap: 6 }}>
        <strong style={{ fontSize: 13 }}>Financial authority</strong>
        <div style={{ fontSize: 12, color: "#475569" }}>
          Quote discount without approval:{" "}
          {state.authority.discount_threshold_pct !== null
            ? `${state.authority.discount_threshold_pct}% (personal)`
            : state.authority.group_discount_pct !== null
              ? `${state.authority.group_discount_pct}% (group default)`
              : "not set"}
        </div>
        {state.authority.approval_policies.length ? (
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <tbody>
              {state.authority.approval_policies.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid #eef2f7" }}>
                  <td style={{ padding: 4 }}>{p.doc_type.replace(/_/g, " ")}</td>
                  <td style={{ padding: 4 }}>{p.company_code || ""}</td>
                  <td style={{ padding: 4 }}>Level {p.level_no}</td>
                  <td style={{ padding: 4 }}>
                    {p.min_amount ?? 0} – {p.max_amount ?? "no limit"}
                  </td>
                  <td style={{ padding: 4, color: "#64748b" }}>via {p.applies_via}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 12, color: "#64748b" }}>No approval bands. Edit them in the Financial Authority tab or the Approval Policy Matrix.</div>
        )}
      </div>

      <div>
        <button type="button" onClick={() => setShowHistory((v) => !v)} style={{ fontSize: 12 }}>
          {showHistory ? "Hide" : "Show"} exception history ({state.history.length})
        </button>
        {showHistory ? (
          <div style={{ display: "grid", gap: 4, marginTop: 8, fontSize: 12 }}>
            {state.history.map((h, i) => (
              <div key={i} style={{ color: "#475569" }}>
                {screensByKey.get(h.screen_key)?.screen_name || h.screen_key}: {levelText(h)} · “{h.reason}” · by {h.granted_by_name || "system"} ·{" "}
                {h.revoked_at ? `ended ${formatDate(h.revoked_at)}${h.revoked_by_name ? ` by ${h.revoked_by_name}` : ""}` : `expired ${formatDate(h.expires_at)}`}
              </div>
            ))}
            {!state.history.length ? <div style={{ color: "#94a3b8" }}>No past exceptions.</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function pickCustom(c) {
  const out = {};
  for (const k of Object.keys(FLAG_LABEL)) out[k] = c[k] ?? null;
  return out;
}

function ScreenRows({ screens, shownOverride, setScreenLevel, profileName }) {
  return (
    <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
      {screens.map((s) => {
        const o = shownOverride(s);
        const value = o ? (o.level === "custom" ? "custom" : o.level) : "inherit";
        return (
          <div
            key={s.screen_key}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(160px, 1.4fr) auto minmax(120px, 1fr) auto",
              gap: 8,
              alignItems: "center",
              fontSize: 12,
              padding: "4px 6px",
              borderRadius: 8,
              background: o?.pending ? "#fef3c7" : o ? "#fffbeb" : "transparent",
            }}
          >
            <span>{s.screen_name}</span>
            <Chip item={s.inherited} muted title={`From ${profileName} (${s.inherited.source.replace("_", " ")})`} />
            <span style={{ color: "#92400e" }}>
              {o ? (
                <>
                  <strong>{o.pending ? "Pending" : "Exception"}</strong>
                  {!o.pending && o.reason ? ` · ${o.reason}` : ""}
                  {!o.pending && o.expires_at ? ` · until ${formatDate(o.expires_at)}` : ""}
                  {!o.pending && o.granted_by_name ? ` · ${o.granted_by_name}` : ""}
                </>
              ) : null}
            </span>
            <span style={{ display: "flex", gap: 4 }}>
              <select value={value} onChange={(e) => setScreenLevel(s, e.target.value, o?.scope)} style={{ fontSize: 12 }}>
                <option value="inherit">Inherit</option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {LEVEL_LABEL[l]}
                  </option>
                ))}
                {value === "custom" ? <option value="custom">Custom (migrated)</option> : null}
              </select>
              {o && o.level !== "none" && o.level !== "custom" ? (
                <select value={o.scope || "all"} onChange={(e) => setScreenLevel(s, o.level, e.target.value)} style={{ fontSize: 12 }}>
                  {scopeOptions(s.module_key, s.screen_key).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
