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

function emptyForm() {
  return {
    company_id: "",
    counterparty_company_id: "",
    vendor_id: "",
    customer_id: "",
    is_active: true,
  };
}

function SurfaceCard({ title, subtitle, actions, children }) {
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
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 13, opacity: 0.74, lineHeight: 1.6, marginTop: 6 }}>{subtitle}</div> : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, note, accent }) {
  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 18,
        padding: 14,
        background: "#fff",
        boxShadow: "0 12px 28px rgba(15, 23, 42, 0.06)",
        borderTop: `4px solid ${accent}`,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>{note}</div>
    </div>
  );
}

export default function IntercompanyPartners() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [bootstrap, setBootstrap] = useState({ companies: [], vendors: [], customers: [] });
  const [partners, setPartners] = useState([]);
  const [form, setForm] = useState(emptyForm());
  const [editDrafts, setEditDrafts] = useState({});

  async function loadAll() {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const [boot, list] = await Promise.all([apiFetch("/intercompany-partners/bootstrap"), apiFetch("/intercompany-partners")]);
      setBootstrap({
        companies: Array.isArray(boot?.companies) ? boot.companies : [],
        vendors: Array.isArray(boot?.vendors) ? boot.vendors : [],
        customers: Array.isArray(boot?.customers) ? boot.customers : [],
      });
      setPartners(Array.isArray(list?.partners) ? list.partners : []);
      setEditDrafts({});
    } catch (e) {
      setError(e?.data?.error || "Failed to load intercompany partners.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll().catch(() => {});
  }, []);

  const companyOptions = useMemo(() => bootstrap.companies.map((c) => ({ ...c })), [bootstrap.companies]);
  const vendorOptions = useMemo(() => bootstrap.vendors.map((v) => ({ ...v })), [bootstrap.vendors]);
  const customerOptions = useMemo(() => bootstrap.customers.map((c) => ({ ...c })), [bootstrap.customers]);
  const filteredPartners = useMemo(() => {
    const q = query.trim().toLowerCase();
    return partners.filter((row) => {
      if (statusFilter === "active" && !row.is_active) return false;
      if (statusFilter === "inactive" && row.is_active) return false;
      if (!q) return true;
      return [
        row.company_code,
        row.counterparty_company_code,
        row.company_name,
        row.counterparty_company_name,
        row.vendor_name,
        row.customer_name,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [partners, query, statusFilter]);

  const stats = useMemo(() => {
    const activeCount = partners.filter((row) => row.is_active).length;
    const vendorLinked = partners.filter((row) => row.vendor_id).length;
    const customerLinked = partners.filter((row) => row.customer_id).length;
    return [
      { label: "Mappings", value: partners.length, note: "total company links", accent: "#1f5eff" },
      { label: "Active", value: activeCount, note: "live intercompany routes", accent: "#14804a" },
      { label: "Buying vendor", value: vendorLinked, note: "vendor-side links configured", accent: "#d97706" },
      { label: "Selling customer", value: customerLinked, note: "customer-side links configured", accent: "#8b5cf6" },
    ];
  }, [partners]);

  function setDraft(id, patch) {
    setEditDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }

  function getRowDraft(row) {
    return {
      vendor_id: editDrafts[row.id]?.vendor_id ?? (row.vendor_id ? String(row.vendor_id) : ""),
      customer_id: editDrafts[row.id]?.customer_id ?? (row.customer_id ? String(row.customer_id) : ""),
      is_active: editDrafts[row.id]?.is_active ?? Boolean(row.is_active),
    };
  }

  async function createMapping() {
    const companyId = Number(form.company_id);
    const counterpartyId = Number(form.counterparty_company_id);
    if (!Number.isFinite(companyId) || companyId <= 0) {
      setError("Select company.");
      return;
    }
    if (!Number.isFinite(counterpartyId) || counterpartyId <= 0) {
      setError("Select counterparty company.");
      return;
    }
    if (companyId === counterpartyId) {
      setError("Company and counterparty cannot be same.");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch("/intercompany-partners", {
        method: "POST",
        body: JSON.stringify({
          company_id: companyId,
          counterparty_company_id: counterpartyId,
          vendor_id: form.vendor_id ? Number(form.vendor_id) : null,
          customer_id: form.customer_id ? Number(form.customer_id) : null,
          is_active: form.is_active !== false,
        }),
      });
      setNotice("Mapping created.");
      setForm(emptyForm());
      await loadAll();
    } catch (e) {
      if (e?.data?.error === "DUPLICATE_MAPPING") setError("Mapping already exists for this company and counterparty.");
      else setError(e?.data?.error || "Failed to create mapping.");
    } finally {
      setSaving(false);
    }
  }

  async function saveRow(row) {
    const draft = getRowDraft(row);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/intercompany-partners/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({
          vendor_id: draft.vendor_id ? Number(draft.vendor_id) : null,
          customer_id: draft.customer_id ? Number(draft.customer_id) : null,
          is_active: draft.is_active !== false,
        }),
      });
      setNotice("Mapping updated.");
      await loadAll();
    } catch (e) {
      setError(e?.data?.error || "Failed to update mapping.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 1320, width: "100%", display: "grid", gap: 16 }}>
      <section
        style={{
          border: "1px solid #dfe5ef",
          borderRadius: 24,
          padding: 22,
          background: "linear-gradient(135deg, #f7fbff 0%, #ffffff 58%, #f9fbff 100%)",
          boxShadow: "0 18px 42px rgba(25, 37, 61, 0.08)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Company network desk</div>
            <h2 style={{ margin: "8px 0 0", fontSize: 32, lineHeight: 1.15 }}>Intercompany Partners, organized into create and mapping lanes.</h2>
            <p style={{ margin: "12px 0 0", fontSize: 14, opacity: 0.76, maxWidth: 760, lineHeight: 1.7 }}>
              Company-to-company mappings now live in a cleaner workspace so buying vendor links and selling customer links are easier to review.
            </p>
          </div>
          <button type="button" onClick={loadAll} disabled={loading || saving}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
        {stats.map((item) => (
          <StatCard key={item.label} {...item} />
        ))}
      </section>

      {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35" }}>{notice}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 16, alignItems: "start" }}>
        <SurfaceCard title="Create mapping" subtitle="Link one company to another and define the vendor/customer references for the intercompany route.">
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Company
              <select value={form.company_id} onChange={(e) => setForm((p) => ({ ...p, company_id: e.target.value }))} style={{ height: 36 }}>
                <option value="">Select</option>
                {companyOptions.map((c) => (
                  <option key={c.id} value={String(c.id)}>{c.company_code} - {c.display_name}</option>
                ))}
              </select>
            </label>

            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Counterparty
              <select
                value={form.counterparty_company_id}
                onChange={(e) => setForm((p) => ({ ...p, counterparty_company_id: e.target.value }))}
                style={{ height: 36 }}
              >
                <option value="">Select</option>
                {companyOptions.map((c) => (
                  <option key={c.id} value={String(c.id)}>{c.company_code} - {c.display_name}</option>
                ))}
              </select>
            </label>

            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Vendor (when buying)
              <select value={form.vendor_id} onChange={(e) => setForm((p) => ({ ...p, vendor_id: e.target.value }))} style={{ height: 36 }}>
                <option value="">—</option>
                {vendorOptions.map((v) => (
                  <option key={v.id} value={String(v.id)}>{v.company_name}</option>
                ))}
              </select>
            </label>

            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Customer (when selling)
              <select value={form.customer_id} onChange={(e) => setForm((p) => ({ ...p, customer_id: e.target.value }))} style={{ height: 36 }}>
                <option value="">—</option>
                {customerOptions.map((c) => (
                  <option key={c.id} value={String(c.id)}>{c.customer_name}</option>
                ))}
              </select>
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={createMapping} disabled={saving}>
                {saving ? "Saving..." : "Create"}
              </button>
            </div>
          </div>
        </SurfaceCard>

        <SurfaceCard
          title="Mapping directory"
          subtitle="Search by company, counterparty, vendor, or customer and update each route in a focused card."
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search mappings" style={{ minWidth: 220 }} />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="active">Active only</option>
                <option value="inactive">Inactive only</option>
              </select>
            </div>
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
        {filteredPartners.map((row) => {
          const draft = getRowDraft(row);
          return (
            <div key={row.id} style={{ border: "1px solid #e3e8f2", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ flex: 1, fontWeight: 700 }}>
                  {row.company_code} → {row.counterparty_company_code}
                </div>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                  Active
                  <input
                    type="checkbox"
                    checked={draft.is_active}
                    onChange={(e) => setDraft(row.id, { is_active: e.target.checked })}
                  />
                </label>
                <button onClick={() => saveRow(row)} disabled={saving}>Save</button>
              </div>

              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Vendor (when buying)
                  <select value={draft.vendor_id} onChange={(e) => setDraft(row.id, { vendor_id: e.target.value })} style={{ height: 36 }}>
                    <option value="">—</option>
                    {vendorOptions.map((v) => (
                      <option key={v.id} value={String(v.id)}>{v.company_name}</option>
                    ))}
                  </select>
                </label>

                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Customer (when selling)
                  <select value={draft.customer_id} onChange={(e) => setDraft(row.id, { customer_id: e.target.value })} style={{ height: 36 }}>
                    <option value="">—</option>
                    {customerOptions.map((c) => (
                      <option key={c.id} value={String(c.id)}>{c.customer_name}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
                <div>Company: {row.company_name || "—"}</div>
                <div>Counterparty: {row.counterparty_company_name || "—"}</div>
                <div>Vendor: {row.vendor_name || "—"} • Customer: {row.customer_name || "—"}</div>
              </div>
            </div>
          );
        })}

        {!filteredPartners.length && !loading ? <div style={{ padding: 12, opacity: 0.72 }}>No mappings yet.</div> : null}
          </div>
        </SurfaceCard>
      </div>
    </div>
  );
}
