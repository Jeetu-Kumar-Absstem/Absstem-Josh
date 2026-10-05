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

function toIsoDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysIso(base, days) {
  const date = new Date(base);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + Number(days || 0));
  return toIsoDate(date);
}

function todayIsoDate() {
  return toIsoDate(new Date());
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export default function AmcContracts({ onOpenServiceWarranty, launch = null, onConsumeLaunch = null } = {}) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [bootstrap, setBootstrap] = useState({ dispatches: [] });
  const [dispatchId, setDispatchId] = useState("");
  const [startDate, setStartDate] = useState(todayIsoDate());
  const [endDate, setEndDate] = useState(addDaysIso(todayIsoDate(), 365));
  const [visitFrequencyDays, setVisitFrequencyDays] = useState("90");
  const [plannedVisits, setPlannedVisits] = useState("4");
  const [remarks, setRemarks] = useState("");

  async function loadBootstrap() {
    const data = await apiFetch("/amc-contracts/bootstrap");
    setBootstrap({ dispatches: Array.isArray(data?.dispatches) ? data.dispatches : [] });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/amc-contracts");
      setItems(Array.isArray(data?.amc_contracts) ? data.amc_contracts : []);
    } catch (_e) {
      setError("Failed to load AMC contracts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
    }
  }, [view.type]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextContractId =
      typeof launch.amc_contract_id === "number" || typeof launch.amc_contract_id === "string"
        ? Number(launch.amc_contract_id)
        : typeof launch.contract_id === "number" || typeof launch.contract_id === "string"
          ? Number(launch.contract_id)
          : 0;
    if (Number.isFinite(nextContractId) && nextContractId > 0) {
      setView({ type: "detail", id: nextContractId });
      if (typeof onConsumeLaunch === "function") onConsumeLaunch();
    }
  }, [launch]);

  async function createFromDispatch() {
    if (!dispatchId) {
      setError("Select a dispatch first.");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/amc-contracts/from-dispatch/${dispatchId}`, {
        method: "POST",
        body: JSON.stringify({
          start_date: startDate || null,
          end_date: endDate || null,
          visit_frequency_days: num(visitFrequencyDays),
          planned_visits: num(plannedVisits),
          remarks: remarks || null,
        }),
      });
      const id = data?.amc_contract?.id;
      if (id) setView({ type: "detail", id });
      setNotice("AMC contract created.");
    } catch (e) {
      if (e?.data?.error === "NO_ELIGIBLE_LINES") setError("Selected dispatch has no eligible lines for AMC coverage.");
      else setError("Failed to create AMC contract.");
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return <AmcContractDetail id={view.id} onBack={() => setView({ type: "list" })} onOpenServiceWarranty={onOpenServiceWarranty} />;
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>AMC / Preventive Maintenance</h2>
        <button onClick={loadList} disabled={loading}>Refresh</button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Create AMC Contract From Dispatch</div>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr repeat(4, minmax(140px, 1fr))", gap: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Dispatch
            <select value={dispatchId} onChange={(e) => setDispatchId(e.target.value)} style={{ height: 36 }}>
              <option value="">Select dispatched material</option>
              {bootstrap.dispatches.map((row) => (
                <option key={row.id} value={String(row.id)}>
                  {row.dispatch_number} • {row.customer_name} • {row.so_number}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Start Date
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ height: 34 }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            End Date
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ height: 34 }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Frequency (Days)
            <input type="number" min="1" value={visitFrequencyDays} onChange={(e) => setVisitFrequencyDays(e.target.value)} style={{ height: 34, padding: "0 8px" }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Planned Visits
            <input type="number" min="1" value={plannedVisits} onChange={(e) => setPlannedVisits(e.target.value)} style={{ height: 34, padding: "0 8px" }} />
          </label>
        </div>
        <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
          Remarks
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} style={{ padding: 10 }} />
        </label>
        <button onClick={createFromDispatch} disabled={creating} style={{ marginTop: 12 }}>
          {creating ? "Creating..." : "Create AMC Contract"}
        </button>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {loading ? <div>Loading AMC contracts…</div> : items.length ? items.map((row) => (
          <button
            key={row.id}
            onClick={() => setView({ type: "detail", id: row.id })}
            style={{ all: "unset", cursor: "pointer", border: "1px solid #e5e5e5", borderRadius: 10, padding: 14, display: "grid", gap: 8 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700 }}>{row.contract_number}</div>
              <div style={{ textTransform: "capitalize" }}>{row.contract_status}</div>
            </div>
            <div style={{ fontSize: 13, opacity: 0.78 }}>
              {row.customer_name} • {row.dispatch_number} • Next due {fmtDate(row.next_due_date)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 10 }}>
              <Metric label="Visits Done" value={`${num(row.visits_completed)}`} />
              <Metric label="Visits Planned" value={`${num(row.visits_total)}`} />
              <Metric label="Contract Ends" value={fmtDate(row.end_date)} />
            </div>
          </button>
        )) : <div style={{ opacity: 0.72 }}>No AMC contracts yet.</div>}
      </div>
    </div>
  );
}

function AmcContractDetail({ id, onBack, onOpenServiceWarranty }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [serviceCaseLoadingId, setServiceCaseLoadingId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [header, setHeader] = useState(null);
  const [lines, setLines] = useState([]);
  const [visits, setVisits] = useState([]);
  const [contractStatus, setContractStatus] = useState("active");
  const [nextDueDate, setNextDueDate] = useState("");
  const [remarks, setRemarks] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/amc-contracts/${id}`);
      const contract = data?.amc_contract || null;
      setHeader(contract);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setVisits(
        Array.isArray(data?.visits)
          ? data.visits.map((visit) => ({
              ...visit,
              due_date: toIsoDate(visit.due_date),
              completed_at: toIsoDate(visit.completed_at),
              technician_name: visit.technician_name || "",
              remarks: visit.remarks || "",
            }))
          : []
      );
      setContractStatus(contract?.contract_status || "active");
      setNextDueDate(toIsoDate(contract?.next_due_date));
      setRemarks(contract?.remarks || "");
    } catch (_e) {
      setError("Failed to load AMC contract.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  const totals = useMemo(() => ({
    covered: lines.reduce((sum, line) => sum + num(line.qty_covered), 0),
    completed: visits.filter((visit) => String(visit.visit_status || "").toLowerCase() === "completed").length,
    pending: visits.filter((visit) => String(visit.visit_status || "").toLowerCase() === "scheduled").length,
  }), [lines, visits]);

  function updateVisit(index, patch) {
    setVisits((prev) => prev.map((visit, i) => (i === index ? { ...visit, ...patch } : visit)));
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/amc-contracts/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          contract_status: contractStatus,
          next_due_date: nextDueDate || null,
          remarks: remarks || null,
          visits: visits.map((visit) => ({
            id: visit.id,
            due_date: visit.due_date || null,
            visit_status: visit.visit_status,
            technician_name: visit.technician_name || null,
            completed_at: visit.completed_at || null,
            remarks: visit.remarks || null,
          })),
        }),
      });
      const contract = data?.amc_contract || header;
      setHeader(contract);
      setLines(Array.isArray(data?.lines) ? data.lines : lines);
      setVisits(
        Array.isArray(data?.visits)
          ? data.visits.map((visit) => ({
              ...visit,
              due_date: toIsoDate(visit.due_date),
              completed_at: toIsoDate(visit.completed_at),
              technician_name: visit.technician_name || "",
              remarks: visit.remarks || "",
            }))
          : visits
      );
      setContractStatus(contract?.contract_status || contractStatus);
      setNextDueDate(toIsoDate(contract?.next_due_date));
      setNotice("AMC contract saved.");
    } catch (_e) {
      setError("Failed to save AMC contract.");
    } finally {
      setSaving(false);
    }
  }

  async function createServiceCase(visitId) {
    setServiceCaseLoadingId(visitId);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/amc-contracts/${id}/visits/${visitId}/create-service-case`, {
        method: "POST",
      });
      const nextVisits = Array.isArray(data?.visits)
        ? data.visits.map((visit) => ({
            ...visit,
            due_date: toIsoDate(visit.due_date),
            completed_at: toIsoDate(visit.completed_at),
            technician_name: visit.technician_name || "",
            remarks: visit.remarks || "",
          }))
        : visits;
      setHeader(data?.amc_contract || header);
      setLines(Array.isArray(data?.lines) ? data.lines : lines);
      setVisits(nextVisits);
      setNotice(
        data?.service_case_id
          ? `Service case ${data.service_case_id} created from AMC visit.`
          : "Service case created from AMC visit."
      );
      if (typeof onOpenServiceWarranty === "function") {
        onOpenServiceWarranty();
      }
    } catch (e) {
      if (e?.data?.error === "SERVICE_CASE_ALREADY_CREATED") setError("A service case is already linked to this visit.");
      else setError("Failed to create service case from AMC visit.");
    } finally {
      setServiceCaseLoadingId(null);
    }
  }

  if (loading) return <div>Loading AMC contract…</div>;
  if (!header) return <div>AMC contract not found.</div>;

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{header.contract_number}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {header.customer_name} • {header.dispatch_number} • {contractStatus}
          </div>
        </div>
        <button onClick={refresh}>Refresh</button>
        <button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Contract Snapshot</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 12 }}>
            <Metric label="Customer" value={header.customer_name || "—"} />
            <Metric label="Sales Order" value={header.so_number || "—"} />
            <Metric label="Invoice" value={header.invoice_number || "—"} />
            <Metric label="Start" value={fmtDate(header.start_date)} />
            <Metric label="End" value={fmtDate(header.end_date)} />
            <Metric label="Frequency" value={`${num(header.visit_frequency_days)} days`} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Status
              <select value={contractStatus} onChange={(e) => setContractStatus(e.target.value)} style={{ height: 36 }}>
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
                <option value="closed">Closed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Next Due Date
              <input type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} style={{ height: 34 }} />
            </label>
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} style={{ padding: 10 }} />
          </label>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Maintenance Metrics</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
            <Metric label="Covered Qty" value={totals.covered.toFixed(4)} />
            <Metric label="Completed Visits" value={`${totals.completed}`} />
            <Metric label="Scheduled Visits" value={`${totals.pending}`} />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Covered Material</div>
        {lines.length ? (
          <div style={{ display: "grid", gap: 10 }}>
            {lines.map((line) => (
              <div key={line.id} style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <strong>{line.item_code || line.item_name || "Item"}</strong>
                    <div style={{ fontSize: 12, opacity: 0.72 }}>{line.item_name || "—"}</div>
                  </div>
                  <div style={{ fontSize: 13 }}>Qty {num(line.qty_covered).toFixed(4)} {line.uom || ""}</div>
                </div>
              </div>
            ))}
          </div>
        ) : <div style={{ opacity: 0.72 }}>No covered lines found.</div>}
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Visit Schedule</div>
        {visits.length ? (
          <div style={{ display: "grid", gap: 12 }}>
            {visits.map((visit, index) => (
              <div key={visit.id} style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700 }}>Visit {visit.visit_no || index + 1}</div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                    {visit.service_case_number ? `Service Case ${visit.service_case_number}` : "No service case yet"}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 12, marginTop: 12 }}>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Due Date
                    <input type="date" value={visit.due_date || ""} onChange={(e) => updateVisit(index, { due_date: e.target.value })} style={{ height: 34 }} />
                  </label>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Status
                    <select value={visit.visit_status || "scheduled"} onChange={(e) => updateVisit(index, { visit_status: e.target.value })} style={{ height: 36 }}>
                      <option value="scheduled">Scheduled</option>
                      <option value="completed">Completed</option>
                      <option value="missed">Missed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Technician
                    <input value={visit.technician_name || ""} onChange={(e) => updateVisit(index, { technician_name: e.target.value })} style={{ height: 34, padding: "0 8px" }} />
                  </label>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Completed On
                    <input type="date" value={visit.completed_at || ""} onChange={(e) => updateVisit(index, { completed_at: e.target.value })} style={{ height: 34 }} />
                  </label>
                </div>
                <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                  Visit Remarks
                  <textarea value={visit.remarks || ""} onChange={(e) => updateVisit(index, { remarks: e.target.value })} rows={2} style={{ padding: 10 }} />
                </label>
                {!visit.service_warranty_case_id ? (
                  <button
                    onClick={() => createServiceCase(visit.id)}
                    disabled={serviceCaseLoadingId === visit.id}
                    style={{ marginTop: 12 }}
                  >
                    {serviceCaseLoadingId === visit.id ? "Creating..." : "Create Service Case"}
                  </button>
                ) : (
                  <div style={{ marginTop: 12, fontSize: 12, opacity: 0.72 }}>
                    Linked service case: {visit.service_case_number || visit.service_warranty_case_id}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : <div style={{ opacity: 0.72 }}>No preventive visits scheduled.</div>}
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
