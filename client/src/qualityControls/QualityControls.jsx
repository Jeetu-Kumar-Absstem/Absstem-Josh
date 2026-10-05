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

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function toIsoDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function todayIsoDate() {
  return toIsoDate(new Date());
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function actionTypeLabel(value) {
  if (value === "supplier_replacement") return "Supplier Replacement";
  if (value === "rework") return "Rework";
  if (value === "final_acceptance") return "Final Acceptance";
  return "—";
}

function qualityRiskAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "replacement_pending") return { bg: "#fff2f2", color: "#a52323", label: "Replacement Pending" };
  if (key === "rtv_pending") return { bg: "#fff7ea", color: "#8b5a00", label: "RTV Pending" };
  if (key === "rework_pending") return { bg: "#eef4ff", color: "#234a8f", label: "Rework Pending" };
  if (key === "final_acceptance_pending") return { bg: "#eefbf3", color: "#147a3d", label: "Final Acceptance Pending" };
  if (key === "awaiting_disposition") return { bg: "#f6f7fb", color: "#58627a", label: "Awaiting Disposition" };
  return { bg: "#f6f7fb", color: "#58627a", label: String(bucket || "Quality Risk") };
}

const QUALITY_RISK_BUCKETS = [
  ["all", "All signals"],
  ["replacement_pending", "Replacement pending"],
  ["rtv_pending", "RTV pending"],
  ["rework_pending", "Rework pending"],
  ["final_acceptance_pending", "Final acceptance"],
  ["awaiting_disposition", "Awaiting disposition"],
];

const QUALITY_CAPA_BUCKETS = [
  ["all", "All NCRs"],
  ["new_ncr", "New NCR"],
  ["containment_due", "Containment due"],
  ["root_cause_due", "Root cause due"],
  ["action_overdue", "Action overdue"],
  ["verification_due", "Verification due"],
];

function qualityCapaAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "containment_due") return { bg: "#fff2f2", color: "#a52323", label: "Containment Due" };
  if (key === "action_overdue") return { bg: "#fff7ea", color: "#8b5a00", label: "Action Overdue" };
  if (key === "verification_due") return { bg: "#eefbf3", color: "#147a3d", label: "Verification Due" };
  if (key === "root_cause_due") return { bg: "#eef4ff", color: "#234a8f", label: "Root Cause Due" };
  if (key === "new_ncr") return { bg: "#f6f7fb", color: "#58627a", label: "New NCR" };
  return { bg: "#f6f7fb", color: "#58627a", label: String(bucket || "NCR / CAPA") };
}

function ncrStatusLabel(value) {
  const text = String(value || "").replaceAll("_", " ").trim();
  return text ? text.replace(/\b\w/g, (m) => m.toUpperCase()) : "Open";
}

function ncrStatusTone(value) {
  const key = String(value || "").toLowerCase();
  if (key === "closed") return { bg: "#eefbf3", color: "#147a3d" };
  if (key === "cancelled") return { bg: "#fff2f2", color: "#a52323" };
  if (["verification_pending", "contained"].includes(key)) return { bg: "#eef4ff", color: "#234a8f" };
  if (["action_in_progress", "root_cause_pending"].includes(key)) return { bg: "#fff7ea", color: "#8b5a00" };
  return { bg: "#f6f7fb", color: "#58627a" };
}

function buildNcrForm(lines, current = {}) {
  const candidateLines = Array.isArray(lines) ? lines : [];
  const preferred = candidateLines.find((line) => num(line.qty_on_hold) > 0 || num(line.qty_rejected) > 0) || candidateLines[0];
  const selectedExists = candidateLines.some((line) => String(line.id) === String(current.line_id || current.quality_control_line_id || ""));
  const targetLine = selectedExists ? candidateLines.find((line) => String(line.id) === String(current.line_id || current.quality_control_line_id || "")) : preferred;
  return {
    line_id: targetLine?.id ? String(targetLine.id) : "",
    severity: current.severity || "medium",
    category: current.category || "incoming_defect",
    qty_affected:
      current.qty_affected !== undefined && current.qty_affected !== null && current.qty_affected !== ""
        ? String(current.qty_affected)
        : targetLine
          ? String(Math.max(num(targetLine.qty_on_hold), num(targetLine.qty_rejected), 0))
          : "",
    defect_summary: current.defect_summary || "",
    containment_action: current.containment_action || "",
    containment_due_date: current.containment_due_date || "",
    remarks: current.remarks || "",
  };
}

function buildCapaActionDraft(current = {}) {
  return {
    id: current.id || null,
    action_type: current.action_type || "corrective",
    action_title: current.action_title || "",
    due_date: current.due_date || "",
    completed_date: current.completed_date || "",
    action_status: current.action_status || "open",
    completion_note: current.completion_note || "",
  };
}

function buildActionForm(lines, current = {}) {
  const pendingLines = Array.isArray(lines) ? lines.filter((line) => num(line.qty_pending_hold_resolution) > 0) : [];
  const selectedExists = pendingLines.some((line) => String(line.id) === String(current.line_id || ""));
  return {
    line_id: selectedExists ? String(current.line_id || "") : pendingLines[0] ? String(pendingLines[0].id) : "",
    action_type: current.action_type || "supplier_replacement",
    qty: current.qty || "",
    action_date: current.action_date || todayIsoDate(),
    reference_no: current.reference_no || "",
    expected_date: current.expected_date || "",
    remarks: current.remarks || "",
  };
}

export default function QualityControls({ openQualityControlId = null, onConsumeOpenQualityControl = null, launch = null, onConsumeLaunch = null } = {}) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [riskSummary, setRiskSummary] = useState(null);
  const [riskRows, setRiskRows] = useState([]);
  const [riskBucket, setRiskBucket] = useState("all");
  const [riskQuery, setRiskQuery] = useState("");
  const [riskLoading, setRiskLoading] = useState(false);
  const [capaSummary, setCapaSummary] = useState(null);
  const [capaRows, setCapaRows] = useState([]);
  const [capaBucket, setCapaBucket] = useState("all");
  const [capaQuery, setCapaQuery] = useState("");
  const [capaLoading, setCapaLoading] = useState(false);
  const [bootstrap, setBootstrap] = useState({ posted_grns: [] });
  const [createGrnId, setCreateGrnId] = useState("");
  const [creating, setCreating] = useState(false);

  async function loadBootstrap() {
    const data = await apiFetch("/quality-controls/bootstrap");
    setBootstrap({
      posted_grns: Array.isArray(data?.posted_grns) ? data.posted_grns : [],
    });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/quality-controls");
      setItems(Array.isArray(data?.quality_controls) ? data.quality_controls : []);
    } catch (_e) {
      setError("Failed to load quality controls.");
    } finally {
      setLoading(false);
    }
  }

  async function loadRiskDesk(nextQuery = riskQuery, bucket = riskBucket) {
    setRiskLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery) summaryParams.set("q", nextQuery);
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/quality-controls/rework-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/quality-controls/rework-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setRiskSummary(summaryData?.summary || null);
      setRiskRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load quality hold / rework desk.");
    } finally {
      setRiskLoading(false);
    }
  }

  async function loadCapaDesk(nextQuery = capaQuery, bucket = capaBucket) {
    setCapaLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery) summaryParams.set("q", nextQuery);
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/quality-controls/capa-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/quality-controls/capa-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setCapaSummary(summaryData?.summary || null);
      setCapaRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load NCR / CAPA desk.");
    } finally {
      setCapaLoading(false);
    }
  }

  useEffect(() => {
    if (openQualityControlId) {
      setView({ type: "detail", id: openQualityControlId });
      onConsumeOpenQualityControl?.();
      return;
    }
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
      loadRiskDesk().catch(() => {});
      loadCapaDesk().catch(() => {});
    }
  }, [view.type, openQualityControlId, onConsumeOpenQualityControl]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextRiskBucket = typeof launch.risk_bucket === "string" ? launch.risk_bucket : "all";
    const nextCapaBucket = typeof launch.capa_bucket === "string" ? launch.capa_bucket : "all";
    const nextQuery = typeof launch.q === "string" ? launch.q : "";
    const resolvedRiskBucket = QUALITY_RISK_BUCKETS.some(([value]) => value === nextRiskBucket) ? nextRiskBucket : "all";
    const resolvedCapaBucket = QUALITY_CAPA_BUCKETS.some(([value]) => value === nextCapaBucket) ? nextCapaBucket : "all";
    setRiskBucket(resolvedRiskBucket);
    setRiskQuery(nextQuery);
    setCapaBucket(resolvedCapaBucket);
    setCapaQuery(nextQuery);
    if (view.type !== "list") setView({ type: "list" });
    loadRiskDesk(nextQuery, resolvedRiskBucket).catch(() => {});
    loadCapaDesk(nextQuery, resolvedCapaBucket).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  async function createFromGrn() {
    const grnId = Number(createGrnId);
    if (!Number.isFinite(grnId) || grnId <= 0) {
      setError("Select a posted GRN first.");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/quality-controls/from-grn/${grnId}`, { method: "POST" });
      const id = data?.quality_control?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Quality control created from GRN.");
    } catch (e) {
      if (e?.data?.error === "QC_ALREADY_EXISTS") setError("A quality control record already exists for this GRN.");
      else if (e?.data?.error === "GRN_NOT_POSTED") setError("Only posted GRNs can enter quality control.");
      else setError("Failed to create quality control.");
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return <QualityControlDetail id={view.id} onBack={() => setView({ type: "list" })} />;
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Quality Hold / Replacement / Rework / RTV</h2>
        <button onClick={loadList} disabled={loading}>
          Refresh
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700 }}>Quality Hold / Rework Control Desk</div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>Prioritize pending disposition, rework, supplier replacement, final acceptance, and RTV exposure from one queue.</div>
          </div>
          <button onClick={() => loadRiskDesk(riskQuery, riskBucket)} disabled={riskLoading}>
            {riskLoading ? "Refreshing..." : "Refresh Risk Desk"}
          </button>
        </div>
        {riskSummary ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(120px, 1fr))", gap: 10 }}>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Awaiting</div><div style={{ fontWeight: 800 }}>{riskSummary.awaitingDisposition || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Rework</div><div style={{ fontWeight: 800 }}>{riskSummary.reworkPending || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Replacement</div><div style={{ fontWeight: 800 }}>{riskSummary.replacementPending || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Final Accept</div><div style={{ fontWeight: 800 }}>{riskSummary.finalAcceptancePending || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>RTV Pending</div><div style={{ fontWeight: 800 }}>{riskSummary.rtvPending || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Hold Qty</div><div style={{ fontWeight: 800 }}>{num(riskSummary.pendingHoldQty).toFixed(4)}</div></div>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {QUALITY_RISK_BUCKETS.map(([value, label]) => (
            <button key={value} onClick={() => {
              setRiskBucket(value);
              loadRiskDesk(riskQuery, value).catch(() => {});
            }}>
              {label}
            </button>
          ))}
          <input
            value={riskQuery}
            onChange={(e) => setRiskQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") loadRiskDesk(riskQuery, riskBucket).catch(() => {});
            }}
            placeholder="Search QC, GRN, or vendor"
            style={{ minWidth: 240, height: 36 }}
          />
        </div>
        {riskLoading ? (
          <div>Loading quality risk queue…</div>
        ) : riskRows.length ? (
          <div style={{ display: "grid", gap: 10 }}>
            {riskRows.map((row) => {
              const appearance = qualityRiskAppearance(getQualityBucket(row));
              return (
                <button
                  key={`qc-risk-${row.id}`}
                  onClick={() => setView({ type: "detail", id: row.id })}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e7ebf3",
                    borderRadius: 16,
                    padding: 12,
                    background: "#fff",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{row.qc_number}</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>{row.vendor_name} • {row.grn_number} • {fmtDate(row.inspection_date)}</div>
                    </div>
                    <div style={{ padding: "4px 10px", borderRadius: 999, background: appearance.bg, color: appearance.color, fontSize: 12, fontWeight: 700 }}>
                      {appearance.label}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>Pending Hold</div><div style={{ fontWeight: 700 }}>{num(row.qty_pending_hold_resolution).toFixed(4)}</div></div>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>Repl Pending</div><div style={{ fontWeight: 700 }}>{num(row.replacement_pending_qty).toFixed(4)}</div></div>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>RTV Pending</div><div style={{ fontWeight: 700 }}>{num(row.qty_rejected_pending_rtv).toFixed(4)}</div></div>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>Rework Qty</div><div style={{ fontWeight: 700 }}>{num(row.rework_action_qty).toFixed(4)}</div></div>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>Hold Actions</div><div style={{ fontWeight: 700 }}>{row.hold_action_count || 0}</div></div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ opacity: 0.72 }}>No quality risk rows in this bucket.</div>
        )}
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700 }}>NCR / CAPA Control Desk</div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>Track containment, root cause, overdue corrective actions, and verification closure from the linked nonconformance queue.</div>
          </div>
          <button onClick={() => loadCapaDesk(capaQuery, capaBucket)} disabled={capaLoading}>
            {capaLoading ? "Refreshing..." : "Refresh CAPA Desk"}
          </button>
        </div>
        {capaSummary ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 10 }}>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>New NCR</div><div style={{ fontWeight: 800 }}>{capaSummary.newNcr || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Containment Due</div><div style={{ fontWeight: 800 }}>{capaSummary.containmentDue || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Root Cause Due</div><div style={{ fontWeight: 800 }}>{capaSummary.rootCauseDue || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Action Overdue</div><div style={{ fontWeight: 800 }}>{capaSummary.actionOverdue || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Verification Due</div><div style={{ fontWeight: 800 }}>{capaSummary.verificationDue || 0}</div></div>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {QUALITY_CAPA_BUCKETS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => {
                setCapaBucket(value);
                loadCapaDesk(capaQuery, value).catch(() => {});
              }}
            >
              {label}
            </button>
          ))}
          <input
            value={capaQuery}
            onChange={(e) => setCapaQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") loadCapaDesk(capaQuery, capaBucket).catch(() => {});
            }}
            placeholder="Search NCR, QC, GRN, vendor, or item"
            style={{ minWidth: 260, height: 36 }}
          />
        </div>
        {capaLoading ? (
          <div>Loading NCR / CAPA queue…</div>
        ) : capaRows.length ? (
          <div style={{ display: "grid", gap: 10 }}>
            {capaRows.map((row) => {
              const appearance = qualityCapaAppearance(getQualityCapaBucket(row));
              return (
                <button
                  key={`qc-capa-${row.id}`}
                  onClick={() => setView({ type: "detail", id: row.quality_control_id })}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e7ebf3",
                    borderRadius: 16,
                    padding: 12,
                    background: "#fff",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{row.ncr_number}</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>{row.vendor_name} • {row.qc_number} • {row.grn_number}</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ padding: "4px 10px", borderRadius: 999, background: appearance.bg, color: appearance.color, fontSize: 12, fontWeight: 700 }}>
                        {appearance.label}
                      </div>
                      <div style={{ padding: "4px 10px", borderRadius: 999, background: ncrStatusTone(row.status).bg, color: ncrStatusTone(row.status).color, fontSize: 12, fontWeight: 700 }}>
                        {ncrStatusLabel(row.status)}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.82 }}>{row.defect_summary}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>Severity</div><div style={{ fontWeight: 700 }}>{ncrStatusLabel(row.severity)}</div></div>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>Qty Affected</div><div style={{ fontWeight: 700 }}>{num(row.qty_affected).toFixed(4)}</div></div>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>Overdue Actions</div><div style={{ fontWeight: 700 }}>{row.overdue_action_count || 0}</div></div>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>Open Actions</div><div style={{ fontWeight: 700 }}>{row.open_action_count || 0}</div></div>
                    <div><div style={{ fontSize: 12, opacity: 0.68 }}>Line</div><div style={{ fontWeight: 700 }}>{row.line_no ? `L${row.line_no}` : "Header"}</div></div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ opacity: 0.72 }}>No NCR / CAPA rows in this bucket.</div>
        )}
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Create From Posted GRN</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            GRN
            <select value={createGrnId} onChange={(e) => setCreateGrnId(e.target.value)} style={{ height: 36 }}>
              <option value="">Select posted GRN</option>
              {bootstrap.posted_grns.map((row) => (
                <option key={row.id} value={String(row.id)}>
                  {row.grn_number} • {row.vendor_name} • {fmtDate(row.receipt_date)}
                </option>
              ))}
            </select>
          </label>
          <button onClick={createFromGrn} disabled={creating}>
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 8 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "150px 140px 1fr 120px 150px 170px",
            gap: 8,
            padding: 12,
            fontSize: 12,
            opacity: 0.8,
            borderBottom: "1px solid #e5e5e5",
          }}
        >
          <div>QC No</div>
          <div>GRN</div>
          <div>Vendor</div>
          <div>Status</div>
          <div>Pending Hold</div>
          <div>RTV</div>
        </div>

        {loading ? (
          <div style={{ padding: 12 }}>Loading…</div>
        ) : items.length ? (
          items.map((row) => (
            <button
              key={row.id}
              onClick={() => setView({ type: "detail", id: row.id })}
              style={{
                all: "unset",
                cursor: "pointer",
                display: "grid",
                gridTemplateColumns: "150px 140px 1fr 120px 150px 170px",
                gap: 8,
                padding: 12,
                borderBottom: "1px solid #f2f2f2",
              }}
            >
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{row.qc_number}</div>
              <div>{row.grn_number}</div>
              <div>{row.vendor_name}</div>
              <div style={{ textTransform: "capitalize" }}>{row.qc_status}</div>
              <div>{num(row.qty_pending_hold_resolution).toFixed(4)}</div>
              <div>{row.rtv_purchase_return_id ? `Created #${row.rtv_purchase_return_id}` : "Pending"}</div>
            </button>
          ))
        ) : (
          <div style={{ padding: 12, opacity: 0.72 }}>No quality controls yet.</div>
        )}
      </div>
    </div>
  );
}

function getQualityBucket(row) {
  if (num(row.replacement_pending_qty) > 0) return "replacement_pending";
  if (num(row.qty_rejected_pending_rtv) > 0) return "rtv_pending";
  if (num(row.rework_action_qty) > 0 && num(row.qty_pending_hold_resolution) > 0) return "rework_pending";
  if (num(row.final_acceptance_action_qty) > 0 && num(row.qty_pending_hold_resolution) > 0) return "final_acceptance_pending";
  if (num(row.qty_pending_hold_resolution) > 0 && Number(row.hold_action_count || 0) <= 0) return "awaiting_disposition";
  return "all";
}

function getQualityCapaBucket(row) {
  if (!row) return "all";
  if (!row.containment_completed_date && row.containment_due_date) {
    const due = new Date(row.containment_due_date);
    const today = new Date();
    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    if (!Number.isNaN(due.getTime()) && due < today) return "containment_due";
  }
  if (row.containment_completed_date && !String(row.root_cause || "").trim()) return "root_cause_due";
  if (Number(row.overdue_action_count || 0) > 0) return "action_overdue";
  if (!row.verification_date && Number(row.open_action_count || 0) <= 0 && Number(row.total_action_count || 0) > 0) return "verification_due";
  if (!row.containment_completed_date) return "new_ncr";
  return "all";
}

function QualityControlDetail({ id, onBack }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creatingRtv, setCreatingRtv] = useState(false);
  const [creatingHoldAction, setCreatingHoldAction] = useState(false);
  const [creatingNcr, setCreatingNcr] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [header, setHeader] = useState(null);
  const [lines, setLines] = useState([]);
  const [holdActions, setHoldActions] = useState([]);
  const [ncrCases, setNcrCases] = useState([]);
  const [capaActions, setCapaActions] = useState([]);
  const [status, setStatus] = useState("draft");
  const [inspectionDate, setInspectionDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [actionForm, setActionForm] = useState(() => buildActionForm([]));
  const [ncrForm, setNcrForm] = useState(() => buildNcrForm([]));

  function applyQualityResponse(data) {
    const qc = data?.quality_control || null;
    const nextLines = Array.isArray(data?.lines) ? data.lines.map((line) => ({ ...line })) : [];
    setHeader(qc);
    setLines(nextLines);
    setHoldActions(Array.isArray(data?.hold_actions) ? data.hold_actions : []);
    setNcrCases(Array.isArray(data?.ncr_cases) ? data.ncr_cases : []);
    setCapaActions(Array.isArray(data?.capa_actions) ? data.capa_actions : []);
    setStatus(qc?.qc_status || "draft");
    setInspectionDate(toIsoDate(qc?.inspection_date));
    setRemarks(qc?.remarks || "");
    setActionForm((prev) => buildActionForm(nextLines, prev));
    setNcrForm((prev) => buildNcrForm(nextLines, prev));
  }

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/quality-controls/${id}`);
      applyQualityResponse(data);
    } catch (_e) {
      setError("Failed to load quality control.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  const totals = useMemo(
    () => ({
      received: lines.reduce((sum, line) => sum + num(line.qty_received), 0),
      accepted: lines.reduce((sum, line) => sum + num(line.qty_accepted), 0),
      onHold: lines.reduce((sum, line) => sum + num(line.qty_on_hold), 0),
      rejected: lines.reduce((sum, line) => sum + num(line.qty_rejected), 0),
      pendingRtv: lines.reduce((sum, line) => sum + num(line.qty_pending_rtv), 0),
      replaced: lines.reduce((sum, line) => sum + num(line.qty_replaced), 0),
      reworked: lines.reduce((sum, line) => sum + num(line.qty_reworked), 0),
      acceptedAfterHold: lines.reduce((sum, line) => sum + num(line.qty_accepted_after_hold), 0),
      pendingHoldResolution: lines.reduce((sum, line) => sum + num(line.qty_pending_hold_resolution), 0),
      effectiveAccepted: lines.reduce((sum, line) => sum + num(line.qty_effective_accepted), 0),
    }),
    [lines]
  );

  const pendingHoldLines = useMemo(
    () => lines.filter((line) => num(line.qty_pending_hold_resolution) > 0),
    [lines]
  );

  const capaActionsByCaseId = useMemo(() => {
    const map = new Map();
    capaActions.forEach((row) => {
      const key = Number(row.ncr_case_id || 0);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        ...row,
        due_date: toIsoDate(row.due_date),
        completed_date: toIsoDate(row.completed_date),
      });
    });
    return map;
  }, [capaActions]);

  function updateLine(index, patch) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function setActionField(field, value) {
    setActionForm((prev) => ({ ...prev, [field]: value }));
  }

  function setNcrField(field, value) {
    setNcrForm((prev) => ({ ...prev, [field]: value }));
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        qc_status: status,
        inspection_date: inspectionDate || undefined,
        remarks: remarks || null,
        lines: lines.map((line) => ({
          id: line.id,
          qty_received: num(line.qty_received),
          qty_accepted: num(line.qty_accepted),
          qty_on_hold: num(line.qty_on_hold),
          qty_rejected: num(line.qty_rejected),
          hold_reason: line.hold_reason || null,
          rejection_reason: line.rejection_reason || null,
        })),
      };
      const data = await apiFetch(`/quality-controls/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      applyQualityResponse(data);
      setNotice("Quality control saved.");
    } catch (e) {
      if (e?.data?.error === "QTY_SPLIT_MISMATCH") setError("For each line, accepted + on hold + rejected must equal received qty.");
      else if (e?.data?.error === "QC_NOT_EDITABLE") setError("Only draft quality controls can be edited.");
      else setError("Failed to save quality control.");
    } finally {
      setSaving(false);
    }
  }

  async function createHoldAction() {
    if (!actionForm.line_id) {
      setError("Select a held line first.");
      return;
    }
    if (num(actionForm.qty) <= 0) {
      setError("Enter a valid hold resolution quantity.");
      return;
    }

    setCreatingHoldAction(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/quality-controls/${id}/hold-actions`, {
        method: "POST",
        body: JSON.stringify({
          line_id: Number(actionForm.line_id),
          action_type: actionForm.action_type,
          qty: num(actionForm.qty),
          action_date: actionForm.action_date || null,
          reference_no: actionForm.reference_no || null,
          expected_date: actionForm.expected_date || null,
          remarks: actionForm.remarks || null,
        }),
      });
      const nextLines = Array.isArray(data?.lines) ? data.lines.map((line) => ({ ...line })) : lines;
      applyQualityResponse(data);
      setActionForm((prev) =>
        buildActionForm(nextLines, {
          action_type: prev.action_type,
          action_date: todayIsoDate(),
        })
      );
      setNotice(`${actionTypeLabel(actionForm.action_type)} recorded.`);
    } catch (e) {
      if (e?.data?.error === "QC_NOT_CLOSED") setError("Close the quality control before resolving held quantity.");
      else if (e?.data?.error === "NO_PENDING_HOLD_QTY") setError("This line has no held quantity pending resolution.");
      else if (e?.data?.error === "HOLD_QTY_EXCEEDED") setError("Resolution quantity cannot exceed pending held quantity.");
      else if (e?.data?.error === "LINE_NOT_FOUND") setError("Selected held line was not found.");
      else if (e?.data?.error === "INVALID_ACTION_TYPE") setError("Select a valid hold resolution type.");
      else setError("Failed to save hold resolution.");
    } finally {
      setCreatingHoldAction(false);
    }
  }

  async function createRtv() {
    setCreatingRtv(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/quality-controls/${id}/create-rtv`, { method: "POST" });
      applyQualityResponse(data);
      const pr = data?.purchase_return;
      setNotice(pr?.return_number ? `RTV draft created as ${pr.return_number}.` : "RTV draft created.");
    } catch (e) {
      if (e?.data?.error === "QC_NOT_CLOSED") setError("Close the quality inspection before creating RTV.");
      else if (e?.data?.error === "NO_PENDING_RTV") setError("No rejected quantity is pending RTV.");
      else if (e?.data?.error === "RTV_ALREADY_CREATED") setError("RTV is already created for this quality control.");
      else setError("Failed to create RTV.");
    } finally {
      setCreatingRtv(false);
    }
  }

  async function createNcrCase() {
    if (!ncrForm.line_id) {
      setError("Select a QC line first.");
      return;
    }
    if (!String(ncrForm.defect_summary || "").trim()) {
      setError("Enter a defect summary before raising NCR.");
      return;
    }
    setCreatingNcr(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/quality-controls/${id}/ncr-cases`, {
        method: "POST",
        body: JSON.stringify({
          line_id: Number(ncrForm.line_id),
          severity: ncrForm.severity,
          category: ncrForm.category,
          qty_affected: num(ncrForm.qty_affected),
          defect_summary: ncrForm.defect_summary,
          containment_action: ncrForm.containment_action || null,
          containment_due_date: ncrForm.containment_due_date || null,
          remarks: ncrForm.remarks || null,
        }),
      });
      const nextLines = Array.isArray(data?.lines) ? data.lines.map((line) => ({ ...line })) : lines;
      applyQualityResponse(data);
      setNcrForm(buildNcrForm(nextLines));
      setNotice("NCR raised.");
    } catch (e) {
      if (e?.data?.error === "DEFECT_SUMMARY_REQUIRED") setError("Defect summary is required to raise NCR.");
      else if (e?.data?.error === "LINE_NOT_FOUND") setError("Selected QC line was not found.");
      else setError("Failed to raise NCR.");
    } finally {
      setCreatingNcr(false);
    }
  }

  async function saveNcrCase(ncrId, payload) {
    const data = await apiFetch(`/quality-controls/ncr-cases/${ncrId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    applyQualityResponse(data);
    setNotice("NCR / CAPA updated.");
  }

  if (loading) return <div>Loading quality control…</div>;
  if (!header) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Quality control not found."}</div>
      </div>
    );
  }

  const qcIsDraft = String(header.qc_status || "").toLowerCase() === "draft";
  const qcIsClosed = String(header.qc_status || "").toLowerCase() === "closed";

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{header.qc_number}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {header.grn_number} • {header.vendor_name} • {header.qc_status}
          </div>
        </div>
        <button onClick={refresh} disabled={loading}>
          Refresh
        </button>
        <button onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Inspection Snapshot</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Inspection Date
              <input type="date" value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} style={{ height: 34 }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ height: 36 }}>
                <option value="draft">Draft</option>
                <option value="closed">Closed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.8 }}>
            <div>GRN Date: {fmtDate(header.receipt_date)}</div>
            <div>Vendor: {header.vendor_name}</div>
            <div>Created By: {header.created_by_name || "—"}</div>
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} style={{ padding: 10 }} />
          </label>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Disposition Totals</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
            <div>Received: {totals.received.toFixed(4)}</div>
            <div>Initial Accepted: {totals.accepted.toFixed(4)}</div>
            <div>On Hold: {totals.onHold.toFixed(4)}</div>
            <div>Rejected: {totals.rejected.toFixed(4)}</div>
            <div>Replaced: {totals.replaced.toFixed(4)}</div>
            <div>Reworked: {totals.reworked.toFixed(4)}</div>
            <div>Accepted After Hold: {totals.acceptedAfterHold.toFixed(4)}</div>
            <div>Effective Accepted: {totals.effectiveAccepted.toFixed(4)}</div>
            <div style={{ fontWeight: 700 }}>Pending RTV: {totals.pendingRtv.toFixed(4)}</div>
            <div style={{ fontWeight: 700 }}>Pending Hold Resolution: {totals.pendingHoldResolution.toFixed(4)}</div>
          </div>
          <div style={{ marginTop: 10, fontSize: 13 }}>RTV Draft: {header.rtv_return_number || "Not created"}</div>
          <button onClick={createRtv} disabled={creatingRtv || !!header.rtv_purchase_return_id} style={{ marginTop: 12 }}>
            {creatingRtv ? "Creating RTV..." : "Create RTV Draft"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "0.95fr 1.05fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Hold Resolution Actions</div>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 12 }}>
            Close the QC first, then resolve held quantity through supplier replacement, rework, or final acceptance.
          </div>
          {!qcIsClosed ? (
            <div style={{ fontSize: 13, color: "#7a4d00", background: "#fff7e0", padding: 10, borderRadius: 8 }}>
              QC is currently `{header.qc_status}`. Save it as `closed` before recording hold-resolution actions.
            </div>
          ) : pendingHoldLines.length ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Held Line
                  <select value={actionForm.line_id} onChange={(e) => setActionField("line_id", e.target.value)} style={{ height: 36 }}>
                    {pendingHoldLines.map((line) => (
                      <option key={line.id} value={String(line.id)}>
                        L{line.line_no} • {line.item_code || line.item_name || "Item"} • Pending {num(line.qty_pending_hold_resolution).toFixed(4)}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Action
                  <select value={actionForm.action_type} onChange={(e) => setActionField("action_type", e.target.value)} style={{ height: 36 }}>
                    <option value="supplier_replacement">Supplier Replacement</option>
                    <option value="rework">Rework</option>
                    <option value="final_acceptance">Final Acceptance</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Qty
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={actionForm.qty}
                    onChange={(e) => setActionField("qty", e.target.value)}
                    style={{ height: 34, padding: "0 8px" }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Action Date
                  <input type="date" value={actionForm.action_date} onChange={(e) => setActionField("action_date", e.target.value)} style={{ height: 34 }} />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Reference No
                  <input value={actionForm.reference_no} onChange={(e) => setActionField("reference_no", e.target.value)} style={{ height: 34, padding: "0 8px" }} />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Expected Date
                  <input type="date" value={actionForm.expected_date} onChange={(e) => setActionField("expected_date", e.target.value)} style={{ height: 34 }} />
                </label>
              </div>
              <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                Remarks
                <textarea value={actionForm.remarks} onChange={(e) => setActionField("remarks", e.target.value)} rows={3} style={{ padding: 10 }} />
              </label>
              <button onClick={createHoldAction} disabled={creatingHoldAction} style={{ marginTop: 12 }}>
                {creatingHoldAction ? "Saving..." : "Record Hold Resolution"}
              </button>
            </>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.72 }}>All held quantity is already resolved for this QC.</div>
          )}
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Resolution History</div>
          {holdActions.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {holdActions.map((action) => (
                <div key={action.id} style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                    <strong>{actionTypeLabel(action.action_type)}</strong>
                    <span>Line {action.line_no}</span>
                    <span>Qty {num(action.qty).toFixed(4)}</span>
                    <span>{fmtDate(action.action_date)}</span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82 }}>
                    {(action.item_code || action.item_name || "Item")}{action.reference_no ? ` • Ref ${action.reference_no}` : ""}
                    {action.expected_date ? ` • Expected ${fmtDate(action.expected_date)}` : ""}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
                    By {action.created_by_name || "Unknown"} • Logged {fmtDateTime(action.created_at)}
                  </div>
                  {action.supplier_claim_number ? (
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.82 }}>
                      Supplier Claim {action.supplier_claim_number} • {String(action.supplier_claim_status || "open").replaceAll("_", " ")}
                    </div>
                  ) : null}
                  {action.remarks ? <div style={{ marginTop: 6, fontSize: 13 }}>{action.remarks}</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.72 }}>No hold-resolution actions recorded yet.</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "0.95fr 1.05fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Raise NCR</div>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 12 }}>
            Create a linked nonconformance case from a rejected or held QC line, then push containment, root cause, and action ownership through CAPA.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              QC Line
              <select value={ncrForm.line_id} onChange={(e) => setNcrField("line_id", e.target.value)} style={{ height: 36 }}>
                <option value="">Select line</option>
                {lines.map((line) => (
                  <option key={line.id} value={String(line.id)}>
                    L{line.line_no || "—"} • {line.item_code || line.item_name || "Item"} • Hold {num(line.qty_on_hold).toFixed(4)} • Reject {num(line.qty_rejected).toFixed(4)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Severity
              <select value={ncrForm.severity} onChange={(e) => setNcrField("severity", e.target.value)} style={{ height: 36 }}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Category
              <select value={ncrForm.category} onChange={(e) => setNcrField("category", e.target.value)} style={{ height: 36 }}>
                <option value="incoming_defect">Incoming defect</option>
                <option value="process_deviation">Process deviation</option>
                <option value="vendor_quality">Vendor quality</option>
                <option value="documentation">Documentation</option>
                <option value="packaging">Packaging</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Qty Affected
              <input type="number" min="0" step="0.0001" value={ncrForm.qty_affected} onChange={(e) => setNcrField("qty_affected", e.target.value)} style={{ height: 34, padding: "0 8px" }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Containment Due
              <input type="date" value={ncrForm.containment_due_date} onChange={(e) => setNcrField("containment_due_date", e.target.value)} style={{ height: 34 }} />
            </label>
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Defect Summary
            <textarea value={ncrForm.defect_summary} onChange={(e) => setNcrField("defect_summary", e.target.value)} rows={3} style={{ padding: 10 }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Immediate Containment
            <textarea value={ncrForm.containment_action} onChange={(e) => setNcrField("containment_action", e.target.value)} rows={3} style={{ padding: 10 }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={ncrForm.remarks} onChange={(e) => setNcrField("remarks", e.target.value)} rows={2} style={{ padding: 10 }} />
          </label>
          <button onClick={createNcrCase} disabled={creatingNcr} style={{ marginTop: 12 }}>
            {creatingNcr ? "Raising..." : "Raise NCR"}
          </button>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>NCR / CAPA Cases</div>
          {ncrCases.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {ncrCases.map((ncr) => (
                <NcrCaseCard
                  key={ncr.id}
                  ncr={ncr}
                  actions={capaActionsByCaseId.get(Number(ncr.id)) || []}
                  onSave={saveNcrCase}
                />
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.72 }}>No NCR cases linked to this QC yet.</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>Quality Disposition Lines</div>
        {lines.length ? (
          lines.map((line, index) => (
            <div key={line.id || index} style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
                <div style={{ fontWeight: 700 }}>
                  L{index + 1} • {line.item_code || line.item_name || "Item"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>{line.item_name || line.line_description || "—"}</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 10, marginTop: 12 }}>
                <Metric label="Received" value={num(line.qty_received).toFixed(4)} />
                <Metric label="Pending RTV" value={num(line.qty_pending_rtv).toFixed(4)} />
                <Metric label="Pending Hold Resolution" value={num(line.qty_pending_hold_resolution).toFixed(4)} />
                <Metric label="Replaced" value={num(line.qty_replaced).toFixed(4)} />
                <Metric label="Reworked" value={num(line.qty_reworked).toFixed(4)} />
                <Metric label="Accepted After Hold" value={num(line.qty_accepted_after_hold).toFixed(4)} />
                <Metric label="Effective Accepted" value={num(line.qty_effective_accepted).toFixed(4)} />
                <Metric label="Initial Hold" value={num(line.qty_on_hold).toFixed(4)} />
                <Metric label="Rejected" value={num(line.qty_rejected).toFixed(4)} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(120px, 1fr))", gap: 12, marginTop: 14 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Accepted
                  <input
                    type="number"
                    value={line.qty_accepted}
                    min="0"
                    step="0.0001"
                    disabled={!qcIsDraft}
                    onChange={(e) => updateLine(index, { qty_accepted: e.target.value })}
                    style={{ height: 32, padding: "0 8px" }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Hold
                  <input
                    type="number"
                    value={line.qty_on_hold}
                    min="0"
                    step="0.0001"
                    disabled={!qcIsDraft}
                    onChange={(e) => updateLine(index, { qty_on_hold: e.target.value })}
                    style={{ height: 32, padding: "0 8px" }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Rejected
                  <input
                    type="number"
                    value={line.qty_rejected}
                    min="0"
                    step="0.0001"
                    disabled={!qcIsDraft}
                    onChange={(e) => updateLine(index, { qty_rejected: e.target.value })}
                    style={{ height: 32, padding: "0 8px" }}
                  />
                </label>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Hold Reason
                  <input
                    value={line.hold_reason || ""}
                    disabled={!qcIsDraft}
                    onChange={(e) => updateLine(index, { hold_reason: e.target.value })}
                    style={{ height: 32, padding: "0 8px" }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Reject Reason
                  <input
                    value={line.rejection_reason || ""}
                    disabled={!qcIsDraft}
                    onChange={(e) => updateLine(index, { rejection_reason: e.target.value })}
                    style={{ height: 32, padding: "0 8px" }}
                  />
                </label>
              </div>
            </div>
          ))
        ) : (
          <div style={{ padding: 12, opacity: 0.72 }}>No lines found.</div>
        )}
      </div>
    </div>
  );
}

function NcrCaseCard({ ncr, actions, onSave }) {
  const [draft, setDraft] = useState(() => ({
    severity: ncr.severity || "medium",
    category: ncr.category || "other",
    qty_affected: String(ncr.qty_affected ?? ""),
    defect_summary: ncr.defect_summary || "",
    containment_action: ncr.containment_action || "",
    containment_due_date: toIsoDate(ncr.containment_due_date),
    containment_completed_date: toIsoDate(ncr.containment_completed_date),
    root_cause: ncr.root_cause || "",
    corrective_plan: ncr.corrective_plan || "",
    preventive_plan: ncr.preventive_plan || "",
    verification_method: ncr.verification_method || "",
    verification_date: toIsoDate(ncr.verification_date),
    remarks: ncr.remarks || "",
  }));
  const [actionDrafts, setActionDrafts] = useState(() => actions.map((row) => buildCapaActionDraft(row)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setDraft({
      severity: ncr.severity || "medium",
      category: ncr.category || "other",
      qty_affected: String(ncr.qty_affected ?? ""),
      defect_summary: ncr.defect_summary || "",
      containment_action: ncr.containment_action || "",
      containment_due_date: toIsoDate(ncr.containment_due_date),
      containment_completed_date: toIsoDate(ncr.containment_completed_date),
      root_cause: ncr.root_cause || "",
      corrective_plan: ncr.corrective_plan || "",
      preventive_plan: ncr.preventive_plan || "",
      verification_method: ncr.verification_method || "",
      verification_date: toIsoDate(ncr.verification_date),
      remarks: ncr.remarks || "",
    });
    setActionDrafts(actions.map((row) => buildCapaActionDraft(row)));
  }, [ncr, actions]);

  function setDraftField(field, value) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  function updateAction(index, patch) {
    setActionDrafts((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addAction() {
    setActionDrafts((prev) => [...prev, buildCapaActionDraft()]);
  }

  function removeAction(index) {
    setActionDrafts((prev) => prev.filter((_, i) => i !== index));
  }

  async function saveCase() {
    if (!String(draft.defect_summary || "").trim()) {
      setError("Defect summary is required.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await onSave(ncr.id, {
        severity: draft.severity,
        category: draft.category,
        qty_affected: num(draft.qty_affected),
        defect_summary: draft.defect_summary,
        containment_action: draft.containment_action || null,
        containment_due_date: draft.containment_due_date || null,
        containment_completed_date: draft.containment_completed_date || null,
        root_cause: draft.root_cause || null,
        corrective_plan: draft.corrective_plan || null,
        preventive_plan: draft.preventive_plan || null,
        verification_method: draft.verification_method || null,
        verification_date: draft.verification_date || null,
        remarks: draft.remarks || null,
        actions: actionDrafts.map((row) => ({
          id: row.id || undefined,
          action_type: row.action_type,
          action_title: row.action_title,
          due_date: row.due_date || null,
          completed_date: row.completed_date || null,
          action_status: row.action_status,
          completion_note: row.completion_note || null,
        })),
      });
      setNotice("Saved.");
    } catch (_e) {
      setError("Failed to update NCR / CAPA.");
    } finally {
      setSaving(false);
    }
  }

  const tone = ncrStatusTone(ncr.status);

  return (
    <div style={{ border: "1px solid #f0f0f0", borderRadius: 10, padding: 12, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 800 }}>{ncr.ncr_number}</div>
          <div style={{ fontSize: 12, opacity: 0.72 }}>
            {ncr.line_no ? `Line ${ncr.line_no}` : "Header"} • {ncr.item_code || ncr.item_name || "QC-level case"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ padding: "4px 10px", borderRadius: 999, background: tone.bg, color: tone.color, fontSize: 12, fontWeight: 700 }}>
            {ncrStatusLabel(ncr.status)}
          </div>
          <button onClick={saveCase} disabled={saving}>{saving ? "Saving..." : "Save NCR / CAPA"}</button>
        </div>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 10, fontSize: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 10, fontSize: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          Severity
          <select value={draft.severity} onChange={(e) => setDraftField("severity", e.target.value)} style={{ height: 34 }}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          Category
          <select value={draft.category} onChange={(e) => setDraftField("category", e.target.value)} style={{ height: 34 }}>
            <option value="incoming_defect">Incoming defect</option>
            <option value="process_deviation">Process deviation</option>
            <option value="vendor_quality">Vendor quality</option>
            <option value="documentation">Documentation</option>
            <option value="packaging">Packaging</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          Qty Affected
          <input type="number" min="0" step="0.0001" value={draft.qty_affected} onChange={(e) => setDraftField("qty_affected", e.target.value)} style={{ height: 34, padding: "0 8px" }} />
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          Verification Date
          <input type="date" value={draft.verification_date} onChange={(e) => setDraftField("verification_date", e.target.value)} style={{ height: 34 }} />
        </label>
      </div>

      <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
        Defect Summary
        <textarea value={draft.defect_summary} onChange={(e) => setDraftField("defect_summary", e.target.value)} rows={2} style={{ padding: 10 }} />
      </label>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          Containment Action
          <textarea value={draft.containment_action} onChange={(e) => setDraftField("containment_action", e.target.value)} rows={3} style={{ padding: 10 }} />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Containment Due
            <input type="date" value={draft.containment_due_date} onChange={(e) => setDraftField("containment_due_date", e.target.value)} style={{ height: 34 }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Containment Done
            <input type="date" value={draft.containment_completed_date} onChange={(e) => setDraftField("containment_completed_date", e.target.value)} style={{ height: 34 }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12, gridColumn: "1 / -1" }}>
            Verification Method
            <input value={draft.verification_method} onChange={(e) => setDraftField("verification_method", e.target.value)} style={{ height: 34, padding: "0 8px" }} />
          </label>
        </div>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          Root Cause
          <textarea value={draft.root_cause} onChange={(e) => setDraftField("root_cause", e.target.value)} rows={3} style={{ padding: 10 }} />
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          Corrective Plan
          <textarea value={draft.corrective_plan} onChange={(e) => setDraftField("corrective_plan", e.target.value)} rows={3} style={{ padding: 10 }} />
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          Preventive Plan
          <textarea value={draft.preventive_plan} onChange={(e) => setDraftField("preventive_plan", e.target.value)} rows={3} style={{ padding: 10 }} />
        </label>
      </div>

      <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
        Remarks
        <textarea value={draft.remarks} onChange={(e) => setDraftField("remarks", e.target.value)} rows={2} style={{ padding: 10 }} />
      </label>

      <div style={{ marginTop: 14, borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>CAPA Actions</div>
          <button onClick={addAction}>Add Action</button>
        </div>
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          {actionDrafts.map((row, index) => (
            <div key={row.id || `draft-${index}`} style={{ border: "1px solid #f3f3f3", borderRadius: 8, padding: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Type
                  <select value={row.action_type} onChange={(e) => updateAction(index, { action_type: e.target.value })} style={{ height: 34 }}>
                    <option value="correction">Correction</option>
                    <option value="corrective">Corrective</option>
                    <option value="preventive">Preventive</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Due Date
                  <input type="date" value={row.due_date} onChange={(e) => updateAction(index, { due_date: e.target.value })} style={{ height: 34 }} />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Status
                  <select value={row.action_status} onChange={(e) => updateAction(index, { action_status: e.target.value })} style={{ height: 34 }}>
                    <option value="open">Open</option>
                    <option value="in_progress">In Progress</option>
                    <option value="done">Done</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
                <button onClick={() => removeAction(index)} style={{ alignSelf: "end" }}>Remove</button>
              </div>
              <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 10 }}>
                Action Title
                <input value={row.action_title} onChange={(e) => updateAction(index, { action_title: e.target.value })} style={{ height: 34, padding: "0 8px" }} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 10, marginTop: 10 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Completed Date
                  <input type="date" value={row.completed_date} onChange={(e) => updateAction(index, { completed_date: e.target.value })} style={{ height: 34 }} />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Completion Note
                  <input value={row.completion_note} onChange={(e) => updateAction(index, { completion_note: e.target.value })} style={{ height: 34, padding: "0 8px" }} />
                </label>
              </div>
            </div>
          ))}
          {!actionDrafts.length ? <div style={{ fontSize: 12, opacity: 0.72 }}>No CAPA actions added yet.</div> : null}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={{ border: "1px solid #f1f1f1", borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.72 }}>{label}</div>
      <div style={{ fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}
