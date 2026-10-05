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

function emptyPerson() {
  return {
    full_name: "",
    email: "",
    phone: "",
    department_key: "",
    designation: "",
    company_ids: [],
    primary_company_id: "",
    primary_manager_user_id: "",
    secondary_manager_user_id: "",
    date_of_joining: "",
    role_id: "",
  };
}

function Field({ label, children, help }) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#475569" }}>
      {label}
      {children}
      {help ? <span style={{ fontSize: 11, color: "#64748b" }}>{help}</span> : null}
    </label>
  );
}

function levelText(m) {
  const base = LEVEL_LABEL[m.level] || m.level;
  if (!m.scope || m.scope === "all" || m.level === "none" || m.level === "mixed") return base;
  return `${base} (${m.scope === "team" ? "team" : "own"})`;
}

function errorText(e) {
  const code = e?.data?.error;
  const detail = typeof e?.data?.detail === "string" ? e.data.detail : "";
  if (code === "DUPLICATE_EMAIL") return detail || "This email is already used by another person.";
  if (code === "MISSING_FIELDS") return "Name, email and access profile are required.";
  if (code === "MANAGER_CYCLE" || code === "INVALID_MANAGER") return detail || "That manager choice would create a reporting loop.";
  if (code === "REASON_REQUIRED") return "Give a reason for the access exceptions.";
  if (code === "INVALID_CHANGES") return `Invalid exceptions: ${detail}`;
  return detail || code || "Could not create the person.";
}

/**
 * Add person: who they are, where they sit, what they get — one page and one atomic save
 * (identity, companies, profile and exceptions commit together or not at all).
 */
export default function AddPerson({ bootstrap = {}, onCreated, onCancel }) {
  const roles = (bootstrap.roles || []).filter((r) => !["SuperAdmin", "Distributor"].includes(r.role_name));
  const departments = bootstrap.departments || [];
  const companies = bootstrap.companies || [];
  const designations = bootstrap.designations || [];
  const managers = bootstrap.managers || [];

  const [form, setForm] = useState(() => {
    const p = emptyPerson();
    const def = companies.find((c) => String(c.company_code || "").toUpperCase() === "AT") || companies[0];
    if (def) {
      p.company_ids = [String(def.id)];
      p.primary_company_id = String(def.id);
    }
    return p;
  });
  const [roleTouched, setRoleTouched] = useState(false);
  const [exceptions, setExceptions] = useState([]); // { screen_key, level, scope }
  const [reason, setReason] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [preview, setPreview] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const changes = useMemo(() => {
    const expires = expiresOn ? new Date(`${expiresOn}T23:59:59`).toISOString() : null;
    return exceptions.filter((e) => e.screen_key && e.level).map((e) => ({ screen_key: e.screen_key, level: e.level, scope: e.scope, expires_at: expires }));
  }, [exceptions, expiresOn]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch(`${API}/provision/preview`, {
        method: "POST",
        body: JSON.stringify({
          role_id: form.role_id || null,
          department_key: form.department_key || null,
          designation: form.designation || null,
          company_id: form.primary_company_id || null,
          changes,
        }),
      })
        .then((data) => {
          if (cancelled) return;
          setPreview(data.preview);
          const s = data.suggestion && roles.some((r) => String(r.id) === String(data.suggestion.role_id)) ? data.suggestion : null;
          setSuggestion(s);
          if (s && !roleTouched) setForm((prev) => (String(prev.role_id) === String(s.role_id) ? prev : { ...prev, role_id: String(s.role_id) }));
        })
        .catch(() => !cancelled && setPreview(null));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.role_id, form.department_key, form.designation, form.primary_company_id, JSON.stringify(changes), roleTouched]);

  const allScreens = useMemo(() => (preview?.modules || []).flatMap((m) => m.screens.map((s) => ({ ...s, module_label: m.label, module_key: m.module_key }))), [preview]);

  function toggleCompany(id) {
    setForm((prev) => {
      const has = prev.company_ids.includes(id);
      const company_ids = has ? prev.company_ids.filter((x) => x !== id) : [...prev.company_ids, id];
      const primary_company_id = company_ids.includes(prev.primary_company_id) ? prev.primary_company_id : company_ids[0] || "";
      return { ...prev, company_ids, primary_company_id };
    });
  }

  async function save() {
    setError("");
    if (!form.full_name.trim() || !form.email.trim() || !form.role_id) {
      setError("Name, email and access profile are required.");
      return;
    }
    if (changes.length && !reason.trim()) {
      setError("Give a reason for the access exceptions.");
      return;
    }
    setSaving(true);
    try {
      const data = await apiFetch(`${API}/users/provision`, {
        method: "POST",
        body: JSON.stringify({
          ...form,
          role_id: Number(form.role_id),
          employment_company_id: form.primary_company_id || null,
          primary_manager_user_id: form.primary_manager_user_id || null,
          secondary_manager_user_id: form.secondary_manager_user_id || null,
          date_of_joining: form.date_of_joining || null,
          is_active: true,
          is_approved: true,
          access_overrides: changes,
          access_reason: reason,
        }),
      });
      onCreated?.(data.user);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const card = { border: "1px solid #dfe5ef", borderRadius: 14, padding: 14, background: "#fff", display: "grid", gap: 12 };
  const grid2 = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(320px, 0.8fr)", gap: 16, alignItems: "start" }}>
      <div style={{ display: "grid", gap: 14 }}>
        <div style={card}>
          <strong>Who</strong>
          <div style={grid2}>
            <Field label="Full name *">
              <input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} />
            </Field>
            <Field label="Work email *">
              <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field label="Phone">
              <input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field label="Date of joining">
              <input type="date" value={form.date_of_joining} onChange={(e) => set("date_of_joining", e.target.value)} />
            </Field>
          </div>
        </div>

        <div style={card}>
          <strong>Where they sit</strong>
          <div style={grid2}>
            <Field label="Department">
              <select value={form.department_key} onChange={(e) => set("department_key", e.target.value)}>
                <option value="">— select —</option>
                {departments.map((d) => (
                  <option key={d.department_key} value={d.department_key}>
                    {d.department_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Designation">
              <input list="add-person-designations" value={form.designation} onChange={(e) => set("designation", e.target.value)} />
              <datalist id="add-person-designations">
                {designations.map((d) => (
                  <option key={d.id || d.designation_name} value={d.designation_name} />
                ))}
              </datalist>
            </Field>
            <Field label="Reports to">
              <select value={form.primary_manager_user_id} onChange={(e) => set("primary_manager_user_id", e.target.value)}>
                <option value="">— none —</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name || m.email}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Also reports to (dotted line)">
              <select value={form.secondary_manager_user_id} onChange={(e) => set("secondary_manager_user_id", e.target.value)}>
                <option value="">— none —</option>
                {managers
                  .filter((m) => String(m.id) !== String(form.primary_manager_user_id))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name || m.email}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, color: "#475569" }}>Companies (★ = primary)</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {companies.map((c) => {
                const id = String(c.id);
                const on = form.company_ids.includes(id);
                return (
                  <span key={id} style={{ display: "inline-flex", gap: 4, alignItems: "center", border: "1px solid #dfe5ef", borderRadius: 999, padding: "4px 10px", fontSize: 12, background: on ? "#eef4ff" : "#fff" }}>
                    <input type="checkbox" checked={on} onChange={() => toggleCompany(id)} />
                    {c.company_code || c.company_name}
                    {on ? (
                      <button type="button" onClick={() => set("primary_company_id", id)} style={{ all: "unset", cursor: "pointer", color: form.primary_company_id === id ? "#b45309" : "#cbd5e1" }} title="Make primary">
                        ★
                      </button>
                    ) : null}
                  </span>
                );
              })}
            </div>
          </div>
        </div>

        <div style={card}>
          <strong>What they get</strong>
          <Field
            label="Access profile *"
            help={
              suggestion
                ? String(form.role_id) === String(suggestion.role_id)
                  ? "Suggested by org rules for this department and designation."
                  : `Org rules suggest ${suggestion.role_name}.`
                : "Add baseline rules in Access Profiles to suggest this automatically."
            }
          >
            <select
              value={form.role_id}
              onChange={(e) => {
                setRoleTouched(true);
                set("role_id", e.target.value);
              }}
            >
              <option value="">— select access profile —</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.role_name}
                </option>
              ))}
            </select>
          </Field>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, color: "#475569" }}>Exceptions (optional) — only where this person should differ from the profile</div>
            {exceptions.map((ex, i) => {
              const screen = allScreens.find((s) => s.screen_key === ex.screen_key);
              const teamTarget = ex.screen_key === "quotes";
              return (
                <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <select
                    value={ex.screen_key}
                    onChange={(e) => setExceptions((prev) => prev.map((x, j) => (j === i ? { ...x, screen_key: e.target.value, scope: e.target.value === "quotes" ? "team" : "all" } : x)))}
                    style={{ minWidth: 220 }}
                  >
                    <option value="">— screen —</option>
                    {(preview?.modules || []).map((m) => (
                      <optgroup key={m.module_key} label={m.label}>
                        {m.screens.map((s) => (
                          <option key={s.screen_key} value={s.screen_key}>
                            {s.screen_name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <select value={ex.level} onChange={(e) => setExceptions((prev) => prev.map((x, j) => (j === i ? { ...x, level: e.target.value } : x)))}>
                    {LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_LABEL[l]}
                      </option>
                    ))}
                  </select>
                  {ex.level !== "none" ? (
                    <select value={ex.scope} onChange={(e) => setExceptions((prev) => prev.map((x, j) => (j === i ? { ...x, scope: e.target.value } : x)))}>
                      {teamTarget ? <option value="team">Own + team</option> : <option value="own">Own records</option>}
                      <option value="all">All records</option>
                    </select>
                  ) : null}
                  {screen ? <span style={{ fontSize: 11, color: "#94a3b8" }}>profile gives {levelText(screen)}</span> : null}
                  <button type="button" onClick={() => setExceptions((prev) => prev.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              );
            })}
            <div>
              <button type="button" onClick={() => setExceptions((prev) => [...prev, { screen_key: "", level: "viewer", scope: "all" }])} disabled={!preview?.role}>
                + Add exception
              </button>
            </div>
            {exceptions.length ? (
              <div style={grid2}>
                <Field label="Reason (required for exceptions)">
                  <input value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <Field label="Exceptions expire on (optional)">
                  <input type="date" value={expiresOn} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpiresOn(e.target.value)} />
                </Field>
              </div>
            ) : null}
          </div>
        </div>

        {error ? <div style={{ color: "#b91c1c", fontWeight: 700 }}>{error}</div> : null}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}>
            {saving ? "Creating…" : "Create person"}
          </button>
        </div>
      </div>

      <div style={{ ...card, position: "sticky", top: 12 }}>
        <strong>Will get</strong>
        {!preview?.role ? (
          <div style={{ fontSize: 12, color: "#64748b" }}>Pick an access profile to see what this person will be able to do.</div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "#475569" }}>
              {preview.role.role_name} · {preview.role.group_name}
              {preview.superadmin_bypass ? " · SuperAdmin (everything)" : ""}
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {preview.modules.map((m) => {
                const tone = LEVEL_TONE[m.level] || LEVEL_TONE.none;
                return (
                  <div key={m.module_key} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                    <span>{m.label}</span>
                    <span style={{ padding: "2px 8px", borderRadius: 999, fontWeight: 700, background: tone.bg, color: tone.fg }}>
                      {levelText(m)}
                      {m.level === "mixed" ? ` · ${m.screens_open}/${m.screens_total} open` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
            {preview.admin_screens?.length ? (
              <div style={{ fontSize: 12, color: "#475569" }}>Admin screens: {preview.admin_screens.join(", ")}</div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
