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

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function fmtMoney(value, currencyCode) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${currencyCode ? `${currencyCode} ` : ""}${n.toFixed(2)}`;
}

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function bucketButtonStyle(active) {
  return {
    all: "unset",
    cursor: "pointer",
    border: `1px solid ${active ? "#cfe0ff" : "#e6ebf3"}`,
    background: active ? "#eef4ff" : "#ffffff",
    borderRadius: 18,
    padding: 14,
    display: "grid",
    gap: 6,
    boxShadow: active ? "0 10px 24px rgba(35, 74, 143, 0.10)" : "0 6px 18px rgba(26, 35, 53, 0.04)",
  };
}

function metricCardStyle() {
  return {
    border: "1px solid #e7ebf3",
    borderRadius: 14,
    padding: 12,
    background: "#fafbff",
    display: "grid",
    gap: 4,
  };
}

function queueCardStyle() {
  return {
    border: "1px solid #e7ebf3",
    borderRadius: 18,
    padding: 14,
    background: "#ffffff",
    boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
    display: "grid",
    gap: 12,
  };
}

function queueActionButtonStyle() {
  return {
    border: "1px solid #d4dbeb",
    background: "#ffffff",
    borderRadius: 10,
    padding: "8px 12px",
    cursor: "pointer",
  };
}

function emptySection() {
  return {
    id: null,
    section_code: "",
    section_name: "",
    default_rate: "0",
    threshold_amount: "0",
    is_active: true,
  };
}

export default function Tds({ launch, onConsumeLaunch, onOpenVendorPayment, onOpenVendorPaymentsDesk, onOpenAdminMasters }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sections, setSections] = useState([]);
  const [vendorSummary, setVendorSummary] = useState([]);
  const [payments, setPayments] = useState([]);
  const [sectionForm, setSectionForm] = useState(emptySection());
  const [saving, setSaving] = useState(false);
  const [opsSummary, setOpsSummary] = useState(null);
  const [opsRows, setOpsRows] = useState([]);
  const [opsBucket, setOpsBucket] = useState("profile_gaps");
  const [opsQuery, setOpsQuery] = useState("");
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsError, setOpsError] = useState("");

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/tds");
      setSections(Array.isArray(data?.sections) ? data.sections : []);
      setVendorSummary(Array.isArray(data?.vendor_summary) ? data.vendor_summary : []);
      setPayments(Array.isArray(data?.payments) ? data.payments : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load TDS data."));
    } finally {
      setLoading(false);
    }
  }

  async function loadOpsSummary() {
    try {
      const data = await apiFetch("/tds/operations-summary");
      setOpsSummary(data?.summary || null);
    } catch (e) {
      setOpsSummary(null);
      setOpsError(getApiErrorMessage(e, "Failed to load TDS operations summary."));
    }
  }

  async function loadOpsQueue({ bucket = opsBucket, q = opsQuery } = {}) {
    setOpsLoading(true);
    setOpsError("");
    try {
      const params = new URLSearchParams();
      if (bucket) params.set("bucket", bucket);
      if (q) params.set("q", q);
      const query = params.toString();
      const data = await apiFetch(`/tds/operations-queue${query ? `?${query}` : ""}`);
      setOpsRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setOpsRows([]);
      setOpsError(getApiErrorMessage(e, "Failed to load TDS operations queue."));
    } finally {
      setOpsLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    loadOpsSummary().catch(() => {});
    loadOpsQueue().catch(() => {});
  }, []);

  useEffect(() => {
    loadOpsQueue({ bucket: opsBucket }).catch(() => {});
  }, [opsBucket]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextBucket = typeof launch.ops_bucket === "string" ? launch.ops_bucket : opsBucket;
    const nextQuery = typeof launch.ops_q === "string" ? launch.ops_q : "";
    setOpsBucket(nextBucket);
    setOpsQuery(nextQuery);
    loadOpsSummary().catch(() => {});
    loadOpsQueue({ bucket: nextBucket, q: nextQuery }).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  function openVendorMaster() {
    if (typeof onOpenAdminMasters === "function") onOpenAdminMasters();
  }

  function openPaymentAction(row) {
    if (typeof onOpenVendorPayment === "function" && Number.isFinite(Number(row?.id)) && Number(row.id) > 0) {
      onOpenVendorPayment(Number(row.id));
      return;
    }
    if (typeof onOpenVendorPaymentsDesk === "function") {
      onOpenVendorPaymentsDesk({
        command_bucket: Number(row?.tds_amount || 0) > 0 ? "unallocated" : "submitted",
        command_q: row?.vendor_name || "",
      });
    }
  }

  async function saveSection() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        ...sectionForm,
        default_rate: Number(sectionForm.default_rate || 0),
        threshold_amount: Number(sectionForm.threshold_amount || 0),
      };
      if (sectionForm.id) {
        await apiFetch(`/tds/sections/${sectionForm.id}`, { method: "PUT", body: JSON.stringify(payload) });
        setNotice("TDS section updated.");
      } else {
        await apiFetch("/tds/sections", { method: "POST", body: JSON.stringify(payload) });
        setNotice("TDS section created.");
      }
      setSectionForm(emptySection());
      await loadAll();
      await loadOpsSummary().catch(() => {});
      await loadOpsQueue().catch(() => {});
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save TDS section."));
    } finally {
      setSaving(false);
    }
  }

  const heroMetrics = [
    { label: "Profile gaps", value: opsSummary?.profile_gap_vendors ?? 0, amount: "", tone: "#9f2042" },
    { label: "Zero-deduction exceptions", value: opsSummary?.zero_deduction_payment_count ?? 0, amount: fmtMoney(opsSummary?.zero_deduction_gross_amount || 0), tone: "#8b5a00" },
    { label: "Current-month deductions", value: opsSummary?.current_month_deducted_payment_count ?? 0, amount: fmtMoney(opsSummary?.current_month_tds_amount || 0), tone: "#143d7a" },
    { label: "Lower-rate vendors", value: opsSummary?.lower_rate_vendor_count ?? 0, amount: "", tone: "#7b4ad8" },
  ];

  const bucketCards = [
    { key: "profile_gaps", label: "Vendor profile gaps", count: Number(opsSummary?.profile_gap_vendors || 0), amount: 0, tone: "#9f2042" },
    { key: "inactive_sections", label: "Inactive section assignments", count: Number(opsSummary?.inactive_section_vendors || 0), amount: 0, tone: "#58627a" },
    { key: "zero_deduction", label: "Zero-deduction exceptions", count: Number(opsSummary?.zero_deduction_payment_count || 0), amount: Number(opsSummary?.zero_deduction_gross_amount || 0), tone: "#8b5a00" },
    { key: "deducted_current_month", label: "Current-month deducted payments", count: Number(opsSummary?.current_month_deducted_payment_count || 0), amount: Number(opsSummary?.current_month_tds_amount || 0), tone: "#143d7a" },
    { key: "lower_rate", label: "Lower-rate vendor profiles", count: Number(opsSummary?.lower_rate_vendor_count || 0), amount: 0, tone: "#7b4ad8" },
  ];

  return (
    <div style={{ maxWidth: 1380 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, opacity: 0.72, textTransform: "uppercase", letterSpacing: "0.08em" }}>Statutory Control Desk</div>
          <h2 style={{ margin: "4px 0 0 0", flex: 1 }}>TDS</h2>
        </div>
        <button onClick={() => {
          loadAll();
          loadOpsSummary().catch(() => {});
          loadOpsQueue().catch(() => {});
        }} disabled={loading || opsLoading}>{loading || opsLoading ? "Refreshing..." : "Refresh"}</button>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
        {heroMetrics.map((item) => (
          <div key={item.label} style={{ ...metricCardStyle(), background: "#ffffff" }}>
            <div style={{ fontSize: 12, opacity: 0.68 }}>{item.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: item.tone }}>{item.value}</div>
            <div style={{ fontSize: 12, color: "#58627a" }}>{item.amount || "Operational queue"}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e7ebf3", borderRadius: 18, background: "#ffffff", padding: 16, boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>TDS Operations Desk</div>
            <div style={{ marginTop: 4, fontSize: 13, color: "#58627a", lineHeight: 1.6 }}>
              Separate setup risk from deduction risk: catch vendor profiles that are not TDS-ready, review zero-deduction exceptions, and use the current-month deduction queue as the live deposit and return-prep worklist.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {bucketCards.map((card) => (
              <button key={card.key} onClick={() => setOpsBucket(card.key)} style={bucketButtonStyle(opsBucket === card.key)}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>{card.label}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: card.tone }}>{card.count}</div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>{card.amount > 0 ? fmtMoney(card.amount) : "Open queue"}</div>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={opsQuery}
              onChange={(e) => setOpsQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadOpsQueue({ q: opsQuery }).catch(() => {});
              }}
              placeholder="Search vendor, payment, PAN, or section"
              style={{ height: 38, minWidth: 260, flex: "1 1 260px", borderRadius: 10, border: "1px solid #d4dbeb", padding: "0 12px" }}
            />
            <button onClick={() => loadOpsQueue({ q: opsQuery })} disabled={opsLoading}>
              {opsLoading ? "Refreshing..." : "Refresh Queue"}
            </button>
            <div style={{ fontSize: 12, color: "#58627a" }}>
              Current-month TDS: {fmtMoney(opsSummary?.current_month_tds_amount || 0)}
            </div>
          </div>

          {opsError ? <div style={{ color: "#b00020", fontSize: 13 }}>{opsError}</div> : null}

          {opsLoading ? (
            <div>Loading TDS operations queue…</div>
          ) : opsRows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {["profile_gaps", "inactive_sections", "lower_rate"].includes(opsBucket)
                ? opsRows.map((row) => (
                    <div key={row.id} style={queueCardStyle()}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.company_name}</div>
                          <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                            {row.vendor_code || "—"} • PAN {row.pan_no || "missing"} • Section {row.section_code || "missing"}
                          </div>
                        </div>
                        <div style={{ fontSize: 12, color: "#58627a" }}>
                          {row.tds_exempt ? "Exempt" : `Lower rate ${Number(row.lower_deduction_rate || 0).toFixed(2)}%`}
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                        <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>TDS enabled</div><div style={{ fontWeight: 800 }}>{row.tds_enabled ? "Yes" : "No"}</div></div>
                        <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Section status</div><div style={{ fontWeight: 800 }}>{row.section_is_active === false ? "Inactive" : row.section_code ? "Active" : "Missing"}</div></div>
                        <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Default rate</div><div style={{ fontWeight: 800 }}>{Number(row.default_rate || 0).toFixed(2)}%</div></div>
                        <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Threshold</div><div style={{ fontWeight: 800 }}>{fmtMoney(row.threshold_amount)}</div></div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {typeof onOpenAdminMasters === "function" ? (
                          <button onClick={openVendorMaster} style={queueActionButtonStyle()}>
                            Open Vendor Master
                          </button>
                        ) : null}
                        {typeof onOpenVendorPaymentsDesk === "function" ? (
                          <button onClick={() => onOpenVendorPaymentsDesk({ command_q: row.company_name || "" })} style={queueActionButtonStyle()}>
                            Open Payables Desk
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))
                : opsRows.map((row) => (
                    <div key={row.id} style={queueCardStyle()}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.vendor_name}</div>
                          <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                            {row.payment_number} • {fmtDate(row.payment_date)} • Section {row.section_code || "—"}
                          </div>
                        </div>
                        <div style={{ fontWeight: 800 }}>{fmtMoney(row.tds_amount || row.payment_amount, row.currency_code)}</div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                        <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Gross</div><div style={{ fontWeight: 800 }}>{fmtMoney(row.payment_amount, row.currency_code)}</div></div>
                        <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>TDS base</div><div style={{ fontWeight: 800 }}>{fmtMoney(row.tds_base_amount, row.currency_code)}</div></div>
                        <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Rate</div><div style={{ fontWeight: 800 }}>{Number(row.tds_rate || 0).toFixed(2)}%</div></div>
                        <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>TDS</div><div style={{ fontWeight: 800 }}>{fmtMoney(row.tds_amount, row.currency_code)}</div></div>
                        <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Net paid</div><div style={{ fontWeight: 800 }}>{fmtMoney(row.net_payment_amount, row.currency_code)}</div></div>
                      </div>
                      <div style={{ fontSize: 13, color: "#58627a" }}>
                        PAN {row.pan_no || "missing"} • Lower rate {Number(row.lower_deduction_rate || 0).toFixed(2)}% • Threshold {fmtMoney(row.threshold_amount)}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {typeof onOpenVendorPayment === "function" ? (
                          <button onClick={() => openPaymentAction(row)} style={queueActionButtonStyle()}>
                            Open Payment
                          </button>
                        ) : null}
                        {typeof onOpenVendorPaymentsDesk === "function" ? (
                          <button onClick={() => onOpenVendorPaymentsDesk({ command_q: row.vendor_name || "" })} style={queueActionButtonStyle()}>
                            Open Payables Desk
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No rows in this TDS bucket right now.
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "0.9fr 1.1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>TDS Section Master</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Section Code"><input value={sectionForm.section_code} onChange={(e) => setSectionForm((p) => ({ ...p, section_code: e.target.value }))} /></Field>
            <Field label="Section Name"><input value={sectionForm.section_name} onChange={(e) => setSectionForm((p) => ({ ...p, section_name: e.target.value }))} /></Field>
            <Field label="Default Rate %"><input value={sectionForm.default_rate} onChange={(e) => setSectionForm((p) => ({ ...p, default_rate: e.target.value }))} /></Field>
            <Field label="Threshold Amount"><input value={sectionForm.threshold_amount} onChange={(e) => setSectionForm((p) => ({ ...p, threshold_amount: e.target.value }))} /></Field>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <input type="checkbox" checked={sectionForm.is_active} onChange={(e) => setSectionForm((p) => ({ ...p, is_active: e.target.checked }))} />
            Active
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => setSectionForm(emptySection())}>Reset</button>
            <button onClick={saveSection} disabled={saving}>{saving ? "Saving..." : (sectionForm.id ? "Update Section" : "Create Section")}</button>
          </div>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e5e5", fontWeight: 700 }}>Sections</div>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 120px 120px 100px", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
            <div>Code</div><div>Name</div><div>Rate</div><div>Threshold</div><div>Status</div>
          </div>
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setSectionForm({
                id: section.id,
                section_code: section.section_code || "",
                section_name: section.section_name || "",
                default_rate: String(section.default_rate ?? 0),
                threshold_amount: String(section.threshold_amount ?? 0),
                is_active: section.is_active !== false,
              })}
              style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: "120px 1fr 120px 120px 100px", gap: 8, padding: 12, borderBottom: "1px solid #f2f2f2" }}
            >
              <div>{section.section_code}</div>
              <div>{section.section_name}</div>
              <div>{section.default_rate}</div>
              <div>{section.threshold_amount}</div>
              <div>{section.is_active ? "Active" : "Inactive"}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e5e5", fontWeight: 700 }}>Vendor TDS Summary</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 120px 120px", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
            <div>Vendor</div><div>Gross</div><div>TDS</div><div>Net Paid</div>
          </div>
          {vendorSummary.length ? vendorSummary.map((row) => (
            <div key={row.vendor_id} style={{ display: "grid", gridTemplateColumns: "1fr 120px 120px 120px", gap: 8, padding: 12, borderBottom: "1px solid #f2f2f2" }}>
              <div>{row.vendor_name}</div>
              <div>{fmtMoney(row.gross_settlement)}</div>
              <div>{fmtMoney(row.total_tds)}</div>
              <div>{fmtMoney(row.net_paid)}</div>
            </div>
          )) : <div style={{ padding: 12, opacity: 0.72 }}>No posted TDS deductions yet.</div>}
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e5e5", fontWeight: 700 }}>Deducted Payments</div>
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 100px 80px 100px 100px", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
            <div>Date</div><div>Vendor / Payment</div><div>Section</div><div>Rate</div><div>TDS</div><div>Net Paid</div>
          </div>
          {payments.length ? payments.map((row) => (
            <div key={row.id} style={{ display: "grid", gridTemplateColumns: "110px 1fr 100px 80px 100px 100px", gap: 8, padding: 12, borderBottom: "1px solid #f2f2f2" }}>
              <div>{fmtDate(row.payment_date)}</div>
              <div>{row.vendor_name} • {row.payment_number}</div>
              <div>{row.section_code || "—"}</div>
              <div>{row.tds_rate}</div>
              <div>{fmtMoney(row.tds_amount, row.currency_code)}</div>
              <div>{fmtMoney(row.net_payment_amount, row.currency_code)}</div>
            </div>
          )) : <div style={{ padding: 12, opacity: 0.72 }}>No TDS-deducted payments yet.</div>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
