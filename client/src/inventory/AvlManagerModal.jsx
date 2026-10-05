import { useEffect, useMemo, useState } from "react";
import { toast } from "../shared/joshUi";

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

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

const EMPTY_AVL_FORM = {
  vendor_id: "",
  brand_name: "",
  vendor_name: "",
  is_preferred: false,
  freight_percentage: "0",
  import_duty_percentage: "0",
  lead_time_days: "0",
  unit_price_hint: "",
};

/**
 * AVL management modal for a component specification.
 */
export default function AvlManagerModal({ specificationId = null, onClose, onChanged = null }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [spec, setSpec] = useState(null);
  const [avl, setAvl] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState(EMPTY_AVL_FORM);

  const sorted = useMemo(
    () =>
      [...avl].sort((a, b) => {
        if (Boolean(b.is_preferred) !== Boolean(a.is_preferred)) return b.is_preferred ? 1 : -1;
        return Number(a.landed_cost_hint || 1e12) - Number(b.landed_cost_hint || 1e12);
      }),
    [avl]
  );

  async function refresh() {
    if (!specificationId) return;
    setLoading(true);
    setError("");
    setForm(EMPTY_AVL_FORM);
    try {
      const [detail, vendorBootstrap] = await Promise.all([
        apiFetch(`/inventory/specs/${specificationId}`),
        apiFetch("/purchase-orders/bootstrap").catch(() => null),
      ]);
      setSpec(detail?.specification || null);
      setAvl(Array.isArray(detail?.avl) ? detail.avl : []);
      setVendors(Array.isArray(vendorBootstrap?.vendors) ? vendorBootstrap.vendors : []);
    } catch (err) {
      setError(err?.data?.detail || err?.data?.error || "Failed to load AVL.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, [specificationId]);

  async function addEntry() {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(`/inventory/specs/${specificationId}/avl`, {
        method: "POST",
        body: JSON.stringify({
          vendor_id: form.vendor_id ? Number(form.vendor_id) : null,
          brand_name: form.brand_name || null,
          vendor_name: form.vendor_name || null,
          is_preferred: Boolean(form.is_preferred),
          freight_percentage: Number(form.freight_percentage) || 0,
          import_duty_percentage: Number(form.import_duty_percentage) || 0,
          lead_time_days: Number(form.lead_time_days) || 0,
          unit_price_hint: form.unit_price_hint === "" ? null : Number(form.unit_price_hint),
        }),
      });
      setAvl(Array.isArray(data?.avl) ? data.avl : []);
      setForm(EMPTY_AVL_FORM);
      toast("AVL entry added", "success");
      if (typeof onChanged === "function") onChanged();
    } catch (err) {
      const msg = err?.data?.detail || err?.data?.error || "Could not add AVL entry.";
      setError(msg);
      toast(msg, "error");
    } finally {
      setSaving(false);
    }
  }

  async function patchEntry(avlId, patch) {
    setError("");
    try {
      const data = await apiFetch(`/inventory/specs/${specificationId}/avl/${avlId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setAvl(Array.isArray(data?.avl) ? data.avl : []);
      if (typeof onChanged === "function") onChanged();
    } catch (err) {
      toast(err?.data?.detail || err?.data?.error || "Update failed", "error");
    }
  }

  if (!specificationId) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        zIndex: 90,
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(920px, 100%)",
          maxHeight: "min(92vh, 900px)",
          overflow: "auto",
          borderRadius: 18,
          background: "#fff",
          border: "1px solid #dde5f1",
          padding: 20,
          display: "grid",
          gap: 14,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.55 }}>
              Approved Vendor List
            </div>
            <div style={{ fontWeight: 900, fontSize: 20, marginTop: 4 }}>
              {spec ? `${spec.spec_code} · ${spec.spec_name}` : `Spec #${specificationId}`}
            </div>
            {spec ? (
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                {[spec.geometry, spec.material, spec.pressure_rating].filter(Boolean).join(" · ") || "Generic technical specification"}
              </div>
            ) : null}
          </div>
          <button type="button" className="button-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? (
          <div style={{ color: "#9f2042", background: "#fff2f3", border: "1px solid #ffd0d6", borderRadius: 12, padding: "10px 12px" }}>
            {error}
          </div>
        ) : null}

        <div style={{ border: "1px solid #e8eef6", borderRadius: 14, padding: 14, background: "#f8fafc", display: "grid", gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 13 }}>Add approved alternate</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              Vendor
              <select value={form.vendor_id} onChange={(e) => setForm((f) => ({ ...f, vendor_id: e.target.value }))}>
                <option value="">Select vendor…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={String(v.id)}>
                    {v.vendor_code ? `${v.vendor_code} · ` : ""}
                    {v.company_name || `Vendor #${v.id}`}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              Vendor name fallback
              <input
                value={form.vendor_name}
                onChange={(e) => setForm((f) => ({ ...f, vendor_name: e.target.value }))}
                placeholder="Use when vendor master is unavailable"
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              Brand
              <input value={form.brand_name} onChange={(e) => setForm((f) => ({ ...f, brand_name: e.target.value }))} placeholder="e.g. Racmet" />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              Unit price hint
              <input type="number" min="0" step="0.01" value={form.unit_price_hint} onChange={(e) => setForm((f) => ({ ...f, unit_price_hint: e.target.value }))} />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              Freight %
              <input type="number" min="0" step="0.01" value={form.freight_percentage} onChange={(e) => setForm((f) => ({ ...f, freight_percentage: e.target.value }))} />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              Import duty %
              <input type="number" min="0" step="0.01" value={form.import_duty_percentage} onChange={(e) => setForm((f) => ({ ...f, import_duty_percentage: e.target.value }))} />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              Lead time (days)
              <input type="number" min="0" step="1" value={form.lead_time_days} onChange={(e) => setForm((f) => ({ ...f, lead_time_days: e.target.value }))} />
            </label>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={form.is_preferred} onChange={(e) => setForm((f) => ({ ...f, is_preferred: e.target.checked }))} />
            Mark preferred brand
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={addEntry} disabled={saving}>
              {saving ? "Saving…" : "Add to AVL"}
            </button>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          {loading ? (
            <div style={{ padding: 12, opacity: 0.65 }}>Loading AVL…</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e6ebf2" }}>
                  <th style={{ padding: "8px 6px", textAlign: "left" }}>Brand / Vendor</th>
                  <th style={{ padding: "8px 6px", textAlign: "right" }}>Freight %</th>
                  <th style={{ padding: "8px 6px", textAlign: "right" }}>Duty %</th>
                  <th style={{ padding: "8px 6px", textAlign: "right" }}>Lead days</th>
                  <th style={{ padding: "8px 6px", textAlign: "right" }}>Landed hint</th>
                  <th style={{ padding: "8px 6px", textAlign: "center" }}>Flags / Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr key={row.id} style={{ borderBottom: "1px solid #f0f3f8", opacity: row.is_active ? 1 : 0.5 }}>
                    <td style={{ padding: "8px 6px" }}>
                      <div style={{ fontWeight: 700 }}>{row.brand_name || row.product_brand || "—"}</div>
                      <div style={{ fontSize: 12, opacity: 0.65 }}>
                        {row.vendor_company_name || row.vendor_name || row.vendor_code || "—"}
                      </div>
                    </td>
                    <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "monospace" }}>{money(row.freight_percentage)}</td>
                    <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "monospace" }}>{money(row.import_duty_percentage)}</td>
                    <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "monospace" }}>{row.lead_time_days ?? "—"}</td>
                    <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "monospace", fontWeight: 700 }}>
                      {row.landed_cost_hint != null ? money(row.landed_cost_hint) : "—"}
                    </td>
                    <td style={{ padding: "8px 6px", textAlign: "center" }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                        <button type="button" className="button-ghost" onClick={() => patchEntry(row.id, { is_preferred: true })}>
                          {row.is_preferred ? "Preferred" : "Set preferred"}
                        </button>
                        <button
                          type="button"
                          className="button-ghost"
                          onClick={() => patchEntry(row.id, { is_active: !row.is_active })}
                        >
                          {row.is_active ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!sorted.length ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 14, opacity: 0.6 }}>
                      No approved vendors yet. Add at least one brand before purchasing against this spec.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
