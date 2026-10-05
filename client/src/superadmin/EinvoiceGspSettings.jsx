import { useEffect, useState } from "react";

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

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

/**
 * Minimal SuperAdmin editor for MasterGST GSP settings.
 * Secrets are never stored here — only the env var name.
 */
export default function EinvoiceGspSettings({ companyId: initialCompanyId }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [companies, setCompanies] = useState([]);
  const [defaults, setDefaults] = useState({});
  const [form, setForm] = useState({
    company_id: initialCompanyId || "",
    provider: "mastergst",
    environment: "sandbox",
    base_url: "https://apisandbox.mastergst.com",
    seller_gstin: "",
    credential_env_key: "",
    is_enabled: false,
    credential_env_configured: false,
  });

  async function load(companyId) {
    setLoading(true);
    setError("");
    try {
      const q = companyId ? `?company_id=${encodeURIComponent(companyId)}` : "";
      const data = await apiFetch(`/admin-masters/einvoice-settings${q}`);
      setCompanies(Array.isArray(data?.companies) ? data.companies : []);
      setDefaults(data?.defaults || {});
      const s = data?.settings || {};
      setForm({
        company_id: String(s.company_id || companyId || ""),
        provider: s.provider || "mastergst",
        environment: s.environment || "sandbox",
        base_url: s.base_url || data?.defaults?.sandbox_base_url || "https://apisandbox.mastergst.com",
        seller_gstin: s.seller_gstin || "",
        credential_env_key: s.credential_env_key || "",
        is_enabled: Boolean(s.is_enabled),
        credential_env_configured: Boolean(s.credential_env_configured),
      });
    } catch (e) {
      setError(e?.data?.error || "Failed to load GSP settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(initialCompanyId).catch(() => {});
  }, [initialCompanyId]);

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/admin-masters/einvoice-settings", {
        method: "PUT",
        body: JSON.stringify({
          company_id: Number(form.company_id),
          provider: form.provider,
          environment: form.environment,
          base_url: form.base_url,
          seller_gstin: form.seller_gstin,
          credential_env_key: form.credential_env_key,
          is_enabled: form.is_enabled,
        }),
      });
      const s = data?.settings || {};
      setForm((p) => ({
        ...p,
        ...s,
        company_id: String(s.company_id || p.company_id),
        credential_env_configured: Boolean(s.credential_env_configured),
      }));
      setNotice("GSP settings saved. Secrets remain in the named environment variable only.");
    } catch (e) {
      setError(e?.data?.error || "Failed to save GSP settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div>Loading MasterGST settings…</div>;

  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 22,
        padding: 18,
        background: "#fff",
        boxShadow: "0 16px 38px rgba(25, 37, 61, 0.07)",
      }}
    >
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>GSP / E-Way</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>MasterGST settings</div>
        <div style={{ fontSize: 13, opacity: 0.74, lineHeight: 1.6, marginTop: 6, maxWidth: 720 }}>
          Enable sandbox or production MasterGST for e-way generate/cancel. Put credentials JSON in an env var and reference only the variable name here.
        </div>
      </div>

      {error ? <div style={{ color: "#b00020", marginBottom: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginBottom: 12 }}>{notice}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Company">
          <select
            value={form.company_id}
            onChange={(e) => {
              const next = e.target.value;
              setForm((p) => ({ ...p, company_id: next }));
              load(next).catch(() => {});
            }}
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company_code} — {c.company_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Provider">
          <select value={form.provider} onChange={(e) => setForm((p) => ({ ...p, provider: e.target.value }))}>
            <option value="mastergst">MasterGST</option>
            <option value="manual">Manual only</option>
          </select>
        </Field>
        <Field label="Environment">
          <select
            value={form.environment}
            onChange={(e) => {
              const environment = e.target.value;
              setForm((p) => ({
                ...p,
                environment,
                base_url:
                  environment === "production"
                    ? defaults.production_base_url || "https://api.mastergst.com"
                    : defaults.sandbox_base_url || "https://apisandbox.mastergst.com",
              }));
            }}
          >
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>
        </Field>
        <Field label="Base URL">
          <input value={form.base_url} onChange={(e) => setForm((p) => ({ ...p, base_url: e.target.value }))} />
        </Field>
        <Field label="Seller GSTIN">
          <input value={form.seller_gstin} onChange={(e) => setForm((p) => ({ ...p, seller_gstin: e.target.value }))} />
        </Field>
        <Field label="Credential env key">
          <input
            value={form.credential_env_key}
            onChange={(e) => setForm((p) => ({ ...p, credential_env_key: e.target.value }))}
            placeholder="e.g. MASTERGST_AI_CREDENTIALS"
          />
        </Field>
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={form.is_enabled}
          onChange={(e) => setForm((p) => ({ ...p, is_enabled: e.target.checked }))}
        />
        <span>Enable GSP for this company</span>
      </label>

      <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 12, lineHeight: 1.6 }}>
        Env configured: {form.credential_env_configured ? "yes" : "no"} · JSON shape:{" "}
        {`{"email","client_id","client_secret","username","password","ip_address","mock":true}`}
      </div>

      <button type="button" onClick={save} disabled={saving || !form.company_id}>
        {saving ? "Saving…" : "Save GSP settings"}
      </button>
    </div>
  );
}
