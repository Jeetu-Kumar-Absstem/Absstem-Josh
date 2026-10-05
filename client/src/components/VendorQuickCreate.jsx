import { useState } from "react";

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

/**
 * Inline vendor quick-create for PO / GRN desks.
 * @param {{ endpoint?: string, onCreated: (vendor: object) => void, disabled?: boolean }} props
 */
export default function VendorQuickCreate({
  endpoint = "/purchase-orders/vendors/quick-create",
  onCreated,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    company_name: "",
    contact_name: "",
    contact_phone: "",
    gstin: "",
    city: "",
  });

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    if (!String(form.company_name || "").trim()) {
      setError("Vendor name is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({
          company_name: String(form.company_name || "").trim(),
          contact_name: String(form.contact_name || "").trim() || null,
          contact_phone: String(form.contact_phone || "").trim() || null,
          gstin: String(form.gstin || "").trim() || null,
          city: String(form.city || "").trim() || null,
        }),
      });
      const vendor = data?.vendor || null;
      if (!vendor?.id) throw new Error("create failed");
      onCreated?.(vendor);
      setForm({ company_name: "", contact_name: "", contact_phone: "", gstin: "", city: "" });
      setOpen(false);
    } catch (e) {
      const code = e?.data?.error;
      if (code === "COMPANY_NAME_REQUIRED") setError("Vendor name is required.");
      else if (code === "DUPLICATE_VENDOR") setError("A vendor with this code already exists.");
      else if (code === "FORBIDDEN") setError("You do not have rights to create vendors.");
      else if (code === "COMPANY_NOT_SELECTED") setError("Select an active company first.");
      else setError(code || "Failed to create vendor.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        style={{
          border: "1px dashed #c5d3ea",
          background: "#f7faff",
          borderRadius: 10,
          padding: "8px 10px",
          fontSize: 12,
          fontWeight: 700,
          color: "#1f4b99",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        + New vendor
      </button>
    );
  }

  return (
    <div
      style={{
        border: "1px solid #d7e3f7",
        borderRadius: 12,
        padding: 12,
        background: "#f8fbff",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", color: "#64748b" }}>
        Quick-create vendor
      </div>
      <input
        value={form.company_name}
        onChange={(e) => setField("company_name", e.target.value)}
        placeholder="Vendor name *"
        disabled={saving || disabled}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input
          value={form.contact_name}
          onChange={(e) => setField("contact_name", e.target.value)}
          placeholder="Contact name"
          disabled={saving || disabled}
        />
        <input
          value={form.contact_phone}
          onChange={(e) => setField("contact_phone", e.target.value)}
          placeholder="Phone"
          disabled={saving || disabled}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input
          value={form.gstin}
          onChange={(e) => setField("gstin", e.target.value)}
          placeholder="GSTIN"
          disabled={saving || disabled}
        />
        <input
          value={form.city}
          onChange={(e) => setField("city", e.target.value)}
          placeholder="City"
          disabled={saving || disabled}
        />
      </div>
      {error ? <div style={{ fontSize: 12, color: "#b42318" }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={save} disabled={saving || disabled}>
          {saving ? "Creating…" : "Create & select"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError("");
          }}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
