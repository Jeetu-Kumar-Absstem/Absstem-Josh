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

function movementTypeLabel(value) {
  if (value === "field_return") return "Field Return";
  if (value === "replacement_issue") return "Replacement Issue";
  return "—";
}

const SERVICE_FAILURE_BUCKETS = [
  ["all", "All NCRs"],
  ["new_ncr", "New NCR"],
  ["containment_due", "Containment due"],
  ["root_cause_due", "Root cause due"],
  ["action_overdue", "Action overdue"],
  ["verification_due", "Verification due"],
];

function failureAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "containment_due") return { bg: "#fff2f2", color: "#a52323", label: "Containment Due" };
  if (key === "action_overdue") return { bg: "#fff7ea", color: "#8b5a00", label: "Action Overdue" };
  if (key === "verification_due") return { bg: "#eefbf3", color: "#147a3d", label: "Verification Due" };
  if (key === "root_cause_due") return { bg: "#eef4ff", color: "#234a8f", label: "Root Cause Due" };
  if (key === "new_ncr") return { bg: "#f6f7fb", color: "#58627a", label: "New NCR" };
  return { bg: "#f6f7fb", color: "#58627a", label: String(bucket || "Customer Failure") };
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
  const preferred = candidateLines.find((line) => num(line.qty_field_returned) > 0 || num(line.qty_eligible) > 0) || candidateLines[0];
  const selectedExists = candidateLines.some((line) => String(line.id) === String(current.line_id || current.service_warranty_case_line_id || ""));
  const targetLine = selectedExists ? candidateLines.find((line) => String(line.id) === String(current.line_id || current.service_warranty_case_line_id || "")) : preferred;
  return {
    line_id: targetLine?.id ? String(targetLine.id) : "",
    severity: current.severity || "medium",
    category: current.category || "incoming_defect",
    qty_affected:
      current.qty_affected !== undefined && current.qty_affected !== null && current.qty_affected !== ""
        ? String(current.qty_affected)
        : targetLine
          ? String(Math.max(num(targetLine.qty_field_returned), 1))
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

function getServiceFailureBucket(row) {
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

function buildMovementForm(lines, current = {}) {
  const movementType = current.movement_type || "field_return";
  const eligibleLines = Array.isArray(lines)
    ? lines.filter((line) =>
        movementType === "field_return" ? num(line.qty_pending_field_return) > 0 : num(line.qty_pending_replacement) > 0
      )
    : [];
  const selectedExists = eligibleLines.some((line) => String(line.id) === String(current.line_id || ""));
  return {
    line_id: selectedExists ? String(current.line_id || "") : eligibleLines[0] ? String(eligibleLines[0].id) : "",
    movement_type: movementType,
    qty: current.qty || "",
    movement_date: current.movement_date || todayIsoDate(),
    reference_no: current.reference_no || "",
    remarks: current.remarks || "",
    serial_text: current.serial_text || "",
  };
}

export default function ServiceWarranty({
  launch = null,
  onConsumeLaunch = null,
  onCreateAftermarketQuote = null,
  canCreateAftermarketQuote = false,
} = {}) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [failureSummary, setFailureSummary] = useState(null);
  const [failureRows, setFailureRows] = useState([]);
  const [failureBucket, setFailureBucket] = useState("all");
  const [failureQuery, setFailureQuery] = useState("");
  const [failureLoading, setFailureLoading] = useState(false);
  const [bootstrap, setBootstrap] = useState({ dispatches: [] });
  const [createDispatchId, setCreateDispatchId] = useState("");
  const [createIssueType, setCreateIssueType] = useState("warranty");
  const [creating, setCreating] = useState(false);

  async function loadBootstrap() {
    const data = await apiFetch("/service-warranty/bootstrap");
    setBootstrap({
      dispatches: Array.isArray(data?.dispatches) ? data.dispatches : [],
    });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/service-warranty");
      setItems(Array.isArray(data?.service_cases) ? data.service_cases : []);
    } catch (_e) {
      setError("Failed to load service / warranty cases.");
    } finally {
      setLoading(false);
    }
  }

  async function loadFailureDesk(nextQuery = failureQuery, bucket = failureBucket) {
    setFailureLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery) summaryParams.set("q", nextQuery);
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/service-warranty/failure-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/service-warranty/failure-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setFailureSummary(summaryData?.summary || null);
      setFailureRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load customer failure desk.");
    } finally {
      setFailureLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
      loadFailureDesk().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextServiceCaseId =
      typeof launch.service_case_id === "number" || typeof launch.service_case_id === "string" ? Number(launch.service_case_id) : 0;
    if (Number.isFinite(nextServiceCaseId) && nextServiceCaseId > 0) {
      setView({ type: "detail", id: nextServiceCaseId });
      if (typeof onConsumeLaunch === "function") onConsumeLaunch();
      return;
    }
    const nextBucket = typeof launch.failure_bucket === "string" ? launch.failure_bucket : "all";
    const nextQuery = typeof launch.q === "string" ? launch.q : "";
    const resolvedBucket = SERVICE_FAILURE_BUCKETS.some(([value]) => value === nextBucket) ? nextBucket : "all";
    setFailureBucket(resolvedBucket);
    setFailureQuery(nextQuery);
    if (view.type !== "list") setView({ type: "list" });
    loadFailureDesk(nextQuery, resolvedBucket).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  async function createFromDispatch() {
    const dispatchId = Number(createDispatchId);
    if (!Number.isFinite(dispatchId) || dispatchId <= 0) {
      setError("Select a dispatch first.");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/service-warranty/from-dispatch/${dispatchId}`, {
        method: "POST",
        body: JSON.stringify({ issue_type: createIssueType }),
      });
      const id = data?.service_case?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Service / warranty case created from dispatch.");
    } catch (e) {
      if (e?.data?.error === "NO_ELIGIBLE_LINES") setError("This dispatch has no product lines eligible for service tracking.");
      else setError("Failed to create service / warranty case.");
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return (
      <ServiceWarrantyDetail
        id={view.id}
        onBack={() => setView({ type: "list" })}
        onCreateAftermarketQuote={onCreateAftermarketQuote}
        canCreateAftermarketQuote={canCreateAftermarketQuote}
      />
    );
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Warranty / Service Replacement / Field Return</h2>
        <button onClick={loadList} disabled={loading}>
          Refresh
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700 }}>Customer Failure / CAPA Desk</div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>Run containment, root-cause, and corrective-action follow-up for customer-side failures from the same NCR engine.</div>
          </div>
          <button onClick={() => loadFailureDesk(failureQuery, failureBucket)} disabled={failureLoading}>
            {failureLoading ? "Refreshing..." : "Refresh Failure Desk"}
          </button>
        </div>
        {failureSummary ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 10 }}>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>New NCR</div><div style={{ fontWeight: 800 }}>{failureSummary.newNcr || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Containment Due</div><div style={{ fontWeight: 800 }}>{failureSummary.containmentDue || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Root Cause Due</div><div style={{ fontWeight: 800 }}>{failureSummary.rootCauseDue || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Action Overdue</div><div style={{ fontWeight: 800 }}>{failureSummary.actionOverdue || 0}</div></div>
            <div><div style={{ fontSize: 12, opacity: 0.68 }}>Verification Due</div><div style={{ fontWeight: 800 }}>{failureSummary.verificationDue || 0}</div></div>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {SERVICE_FAILURE_BUCKETS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => {
                setFailureBucket(value);
                loadFailureDesk(failureQuery, value).catch(() => {});
              }}
            >
              {label}
            </button>
          ))}
          <input
            value={failureQuery}
            onChange={(e) => setFailureQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") loadFailureDesk(failureQuery, failureBucket).catch(() => {});
            }}
            placeholder="Search NCR, case, customer, dispatch, or item"
            style={{ minWidth: 260, height: 36 }}
          />
        </div>
        {failureLoading ? (
          <div>Loading customer failure queue…</div>
        ) : failureRows.length ? (
          <div style={{ display: "grid", gap: 10 }}>
            {failureRows.map((row) => {
              const appearance = failureAppearance(getServiceFailureBucket(row));
              return (
                <button
                  key={`service-failure-${row.id}`}
                  onClick={() => setView({ type: "detail", id: row.service_warranty_case_id })}
                  style={{ all: "unset", cursor: "pointer", border: "1px solid #e7ebf3", borderRadius: 16, padding: 12, background: "#fff", display: "grid", gap: 8 }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{row.ncr_number}</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>{row.customer_name} • {row.case_number} • {row.dispatch_number}</div>
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
          <div style={{ opacity: 0.72 }}>No customer-failure NCR rows in this bucket.</div>
        )}
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Create From Dispatch</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 180px 160px", gap: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Dispatch
            <select value={createDispatchId} onChange={(e) => setCreateDispatchId(e.target.value)} style={{ height: 36 }}>
              <option value="">Select dispatch</option>
              {bootstrap.dispatches.map((row) => (
                <option key={row.id} value={String(row.id)}>
                  {row.dispatch_number} • {row.customer_name} • {row.so_number} • {fmtDate(row.dispatch_date)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Issue Type
            <select value={createIssueType} onChange={(e) => setCreateIssueType(e.target.value)} style={{ height: 36 }}>
              <option value="warranty">Warranty</option>
              <option value="service">Service</option>
              <option value="field_return">Field Return</option>
            </select>
          </label>
          <button onClick={createFromDispatch} disabled={creating}>
            {creating ? "Creating..." : "Create Case"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {loading ? (
          <div>Loading service cases…</div>
        ) : items.length ? (
          items.map((row) => (
            <button
              key={row.id}
              onClick={() => setView({ type: "detail", id: row.id })}
              style={{ all: "unset", cursor: "pointer", border: "1px solid #e5e5e5", borderRadius: 10, padding: 14, display: "grid", gap: 8 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700 }}>{row.case_number}</div>
                <div style={{ textTransform: "capitalize" }}>{row.case_status}</div>
              </div>
              <div style={{ fontSize: 13, opacity: 0.78 }}>
                {row.customer_name} • {row.dispatch_number} • {row.so_number || "No SO"} • {row.issue_type}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(150px, 1fr))", gap: 10 }}>
                <Metric label="Eligible" value={num(row.total_eligible_qty).toFixed(4)} />
                <Metric label="Field Returned" value={num(row.total_field_returned).toFixed(4)} />
                <Metric label="Replaced" value={num(row.total_replaced).toFixed(4)} />
              </div>
            </button>
          ))
        ) : (
          <div style={{ opacity: 0.72 }}>No service / warranty cases yet.</div>
        )}
      </div>
    </div>
  );
}

function ServiceWarrantyDetail({ id, onBack, onCreateAftermarketQuote = null, canCreateAftermarketQuote = false }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [creatingNcr, setCreatingNcr] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [header, setHeader] = useState(null);
  const [lines, setLines] = useState([]);
  const [movements, setMovements] = useState([]);
  const [ncrCases, setNcrCases] = useState([]);
  const [capaActions, setCapaActions] = useState([]);
  const [caseStatus, setCaseStatus] = useState("open");
  const [caseDate, setCaseDate] = useState("");
  const [issueType, setIssueType] = useState("warranty");
  const [reportedBy, setReportedBy] = useState("");
  const [remarks, setRemarks] = useState("");
  const [movementForm, setMovementForm] = useState(() => buildMovementForm([]));
  const [ncrForm, setNcrForm] = useState(() => buildNcrForm([]));

  function applyServiceResponse(data) {
    const nextHeader = data?.service_case || null;
    const nextLines = Array.isArray(data?.lines) ? data.lines : [];
    setHeader(nextHeader);
    setLines(nextLines);
    setMovements(Array.isArray(data?.movements) ? data.movements : []);
    setNcrCases(Array.isArray(data?.ncr_cases) ? data.ncr_cases : []);
    setCapaActions(Array.isArray(data?.capa_actions) ? data.capa_actions : []);
    setCaseStatus(nextHeader?.case_status || "open");
    setCaseDate(toIsoDate(nextHeader?.case_date));
    setIssueType(nextHeader?.issue_type || "warranty");
    setReportedBy(nextHeader?.reported_by || "");
    setRemarks(nextHeader?.remarks || "");
    setMovementForm((prev) => buildMovementForm(nextLines, prev));
    setNcrForm((prev) => buildNcrForm(nextLines, prev));
  }

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/service-warranty/${id}`);
      applyServiceResponse(data);
    } catch (_e) {
      setError("Failed to load service / warranty case.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  const totals = useMemo(
    () => ({
      eligible: lines.reduce((sum, line) => sum + num(line.qty_eligible), 0),
      returned: lines.reduce((sum, line) => sum + num(line.qty_field_returned), 0),
      replaced: lines.reduce((sum, line) => sum + num(line.qty_replaced), 0),
      pendingReturn: lines.reduce((sum, line) => sum + num(line.qty_pending_field_return), 0),
      pendingReplacement: lines.reduce((sum, line) => sum + num(line.qty_pending_replacement), 0),
    }),
    [lines]
  );

  const pendingLines = useMemo(
    () =>
      lines.filter((line) =>
        movementForm.movement_type === "field_return" ? num(line.qty_pending_field_return) > 0 : num(line.qty_pending_replacement) > 0
      ),
    [lines, movementForm.movement_type]
  );
  const selectedLine = useMemo(
    () => pendingLines.find((line) => String(line.id) === String(movementForm.line_id || "")) || null,
    [pendingLines, movementForm.line_id]
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

  function setMovementField(field, value) {
    setMovementForm((prev) => (field === "movement_type" ? buildMovementForm(lines, { ...prev, [field]: value }) : { ...prev, [field]: value }));
  }

  function setNcrField(field, value) {
    setNcrForm((prev) => ({ ...prev, [field]: value }));
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/service-warranty/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          case_status: caseStatus,
          case_date: caseDate || null,
          issue_type: issueType,
          reported_by: reportedBy || null,
          remarks: remarks || null,
        }),
      });
      applyServiceResponse(data);
      setNotice("Service / warranty case saved.");
    } catch (_e) {
      setError("Failed to save service / warranty case.");
    } finally {
      setSaving(false);
    }
  }

  async function recordMovement() {
    if (!movementForm.line_id) {
      setError("Select a case line first.");
      return;
    }
    if (num(movementForm.qty) <= 0) {
      setError("Enter a valid quantity.");
      return;
    }

    const serials = String(movementForm.serial_text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

    setRecording(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/service-warranty/${id}/movements`, {
        method: "POST",
        body: JSON.stringify({
          line_id: Number(movementForm.line_id),
          movement_type: movementForm.movement_type,
          qty: num(movementForm.qty),
          movement_date: movementForm.movement_date || null,
          reference_no: movementForm.reference_no || null,
          remarks: movementForm.remarks || null,
          serials,
        }),
      });
      const nextLines = Array.isArray(data?.lines) ? data.lines : lines;
      applyServiceResponse(data);
      setMovementForm((prev) =>
        buildMovementForm(nextLines, {
          movement_type: prev.movement_type,
          movement_date: todayIsoDate(),
        })
      );
      setNotice(`${movementTypeLabel(movementForm.movement_type)} recorded.`);
    } catch (e) {
      if (e?.data?.error === "CASE_NOT_OPEN") setError("Open the case before recording field return or replacement.");
      else if (e?.data?.error === "QTY_EXCEEDS_ELIGIBLE") setError("Movement qty exceeds the eligible qty for this line.");
      else if (e?.data?.error === "SERIAL_COUNT_MISMATCH") setError("Serial-controlled items require one serial per unit.");
      else if (e?.data?.error === "SERIAL_QTY_NOT_INTEGER") setError("Serial-controlled items require an integer qty.");
      else if (e?.data?.error === "DUPLICATE_SERIALS") setError("Duplicate serial numbers are not allowed.");
      else setError("Failed to record service movement.");
    } finally {
      setRecording(false);
    }
  }

  async function createNcrCase() {
    if (!ncrForm.line_id) {
      setError("Select a case line first.");
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
      const data = await apiFetch(`/service-warranty/${id}/ncr-cases`, {
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
      const nextLines = Array.isArray(data?.lines) ? data.lines : lines;
      applyServiceResponse(data);
      setNcrForm(buildNcrForm(nextLines));
      setNotice("Customer failure NCR raised.");
    } catch (e) {
      if (e?.data?.error === "DEFECT_SUMMARY_REQUIRED") setError("Defect summary is required to raise NCR.");
      else if (e?.data?.error === "LINE_NOT_FOUND") setError("Selected service line was not found.");
      else setError("Failed to raise customer failure NCR.");
    } finally {
      setCreatingNcr(false);
    }
  }

  async function saveNcrCase(ncrId, payload) {
    const data = await apiFetch(`/service-warranty/ncr-cases/${ncrId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    applyServiceResponse(data);
    setNotice("Customer failure NCR / CAPA updated.");
  }

  if (loading) return <div>Loading service case…</div>;
  if (!header) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Service case not found."}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{header.case_number}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {header.customer_name} • {header.dispatch_number} • {header.so_number || "No SO"} • {header.invoice_number || "No Invoice"}
          </div>
        </div>
        <button onClick={refresh} disabled={loading}>
          Refresh
        </button>
        {canCreateAftermarketQuote && typeof onCreateAftermarketQuote === "function" ? (
          <button
            onClick={() =>
              onCreateAftermarketQuote({
                service_warranty_case_id: header.id,
                customer_id: header.customer_id,
                customer_name: header.customer_name || "",
                source_label: "Service Aftermarket Quote",
                source_note: `Create an aftermarket quote for ${header.case_number}${header.dispatch_number ? ` against ${header.dispatch_number}` : ""}.`,
              })
            }
          >
            Create Aftermarket Quote
          </button>
        ) : null}
        <button onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Case Snapshot</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Case Date
              <input type="date" value={caseDate} onChange={(e) => setCaseDate(e.target.value)} style={{ height: 34 }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Status
              <select value={caseStatus} onChange={(e) => setCaseStatus(e.target.value)} style={{ height: 36 }}>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Issue Type
              <select value={issueType} onChange={(e) => setIssueType(e.target.value)} style={{ height: 36 }}>
                <option value="warranty">Warranty</option>
                <option value="service">Service</option>
                <option value="field_return">Field Return</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Reported By
              <input value={reportedBy} onChange={(e) => setReportedBy(e.target.value)} style={{ height: 34, padding: "0 8px" }} />
            </label>
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} style={{ padding: 10 }} />
          </label>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Service Metrics</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(140px, 1fr))", gap: 10 }}>
            <Metric label="Eligible" value={totals.eligible.toFixed(4)} />
            <Metric label="Field Returned" value={totals.returned.toFixed(4)} />
            <Metric label="Replacement Issued" value={totals.replaced.toFixed(4)} />
            <Metric label="Pending Field Return" value={totals.pendingReturn.toFixed(4)} />
            <Metric label="Pending Replacement" value={totals.pendingReplacement.toFixed(4)} />
          </div>
          <div style={{ marginTop: 12, fontSize: 13 }}>Movements logged: {movements.length}</div>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Record Field Return / Replacement</div>
          {caseStatus === "open" && pendingLines.length ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Case Line
                  <select value={movementForm.line_id} onChange={(e) => setMovementField("line_id", e.target.value)} style={{ height: 36 }}>
                    {pendingLines.map((line) => (
                      <option key={line.id} value={String(line.id)}>
                        L{line.line_no} • {line.item_code || line.item_name || "Item"} • Pending{" "}
                        {movementForm.movement_type === "field_return"
                          ? num(line.qty_pending_field_return).toFixed(4)
                          : num(line.qty_pending_replacement).toFixed(4)}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Movement Type
                  <select value={movementForm.movement_type} onChange={(e) => setMovementField("movement_type", e.target.value)} style={{ height: 36 }}>
                    <option value="field_return">Field Return</option>
                    <option value="replacement_issue">Replacement Issue</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Qty
                  <input type="number" min="0" step="0.0001" value={movementForm.qty} onChange={(e) => setMovementField("qty", e.target.value)} style={{ height: 34, padding: "0 8px" }} />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Movement Date
                  <input type="date" value={movementForm.movement_date} onChange={(e) => setMovementField("movement_date", e.target.value)} style={{ height: 34 }} />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Reference No
                  <input value={movementForm.reference_no} onChange={(e) => setMovementField("reference_no", e.target.value)} style={{ height: 34, padding: "0 8px" }} />
                </label>
              </div>
              <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                Remarks
                <textarea value={movementForm.remarks} onChange={(e) => setMovementField("remarks", e.target.value)} rows={3} style={{ padding: 10 }} />
              </label>
              {selectedLine?.serial_no_required ? (
                <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                  Serial Numbers
                  <textarea value={movementForm.serial_text} onChange={(e) => setMovementField("serial_text", e.target.value)} rows={4} placeholder="One serial number per line" style={{ padding: 10 }} />
                </label>
              ) : null}
              <button onClick={recordMovement} disabled={recording} style={{ marginTop: 12 }}>
                {recording ? "Recording..." : "Record Movement"}
              </button>
            </>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.72 }}>
              {caseStatus !== "open" ? "Only open cases can receive field return or replacement entries." : "All eligible qty has already been handled."}
            </div>
          )}
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Movement History</div>
          {movements.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {movements.map((move) => (
                <div key={move.id} style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                    <strong>{movementTypeLabel(move.movement_type)}</strong>
                    <span>Line {move.line_no}</span>
                    <span>Qty {num(move.qty).toFixed(4)}</span>
                    <span>{fmtDate(move.movement_date)}</span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82 }}>
                    {(move.item_code || move.item_name || "Item")}{move.reference_no ? ` • Ref ${move.reference_no}` : ""}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
                    By {move.created_by_name || "Unknown"} • Logged {fmtDateTime(move.created_at)}
                  </div>
                  {move.serials?.length ? <div style={{ marginTop: 4, fontSize: 12, opacity: 0.82 }}>Serials: {move.serials.join(", ")}</div> : null}
                  {move.remarks ? <div style={{ marginTop: 6, fontSize: 13 }}>{move.remarks}</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.72 }}>No movements recorded yet.</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "0.95fr 1.05fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Raise Customer Failure NCR</div>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 12 }}>
            Use the same CAPA engine for customer failures once the field issue is known on a service line.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Case Line
              <select value={ncrForm.line_id} onChange={(e) => setNcrField("line_id", e.target.value)} style={{ height: 36 }}>
                <option value="">Select line</option>
                {lines.map((line) => (
                  <option key={line.id} value={String(line.id)}>
                    L{line.line_no} • {line.item_code || line.item_name || "Item"} • Returned {num(line.qty_field_returned).toFixed(4)}
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
            {creatingNcr ? "Raising..." : "Raise Customer Failure NCR"}
          </button>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Linked Customer Failure NCRs</div>
          {ncrCases.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {ncrCases.map((ncr) => (
                <ServiceNcrCaseCard
                  key={ncr.id}
                  ncr={ncr}
                  actions={capaActionsByCaseId.get(Number(ncr.id)) || []}
                  onSave={saveNcrCase}
                />
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.72 }}>No customer-failure NCRs linked to this case yet.</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>Case Lines</div>
        {lines.length ? (
          lines.map((line) => (
            <div key={line.id} style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700 }}>
                  L{line.line_no} • {line.item_code || line.item_name || "Item"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>{line.serial_no_required ? "Serial controlled" : "Non-serial item"}</div>
              </div>
              <div style={{ fontSize: 13, opacity: 0.78, marginTop: 6 }}>{line.item_name || line.line_description || "—"}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: 10, marginTop: 12 }}>
                <Metric label="Eligible" value={num(line.qty_eligible).toFixed(4)} />
                <Metric label="Field Returned" value={num(line.qty_field_returned).toFixed(4)} />
                <Metric label="Replaced" value={num(line.qty_replaced).toFixed(4)} />
                <Metric label="Pending Return" value={num(line.qty_pending_field_return).toFixed(4)} />
                <Metric label="Pending Replacement" value={num(line.qty_pending_replacement).toFixed(4)} />
              </div>
            </div>
          ))
        ) : (
          <div style={{ opacity: 0.72 }}>No case lines found.</div>
        )}
      </div>
    </div>
  );
}

function ServiceNcrCaseCard({ ncr, actions, onSave }) {
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
      setError("Failed to update customer failure NCR / CAPA.");
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
            {ncr.line_no ? `Line ${ncr.line_no}` : "Header"} • {ncr.item_code || ncr.item_name || "Case-level failure"}
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
