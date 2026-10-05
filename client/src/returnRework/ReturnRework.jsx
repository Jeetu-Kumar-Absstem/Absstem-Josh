import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskStat, MiniMetric, NoticeBanner, PageHero, FieldLabel, getDeskStatusAppearance } from "../shared/joshUi";

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

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
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

function qty4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function fmtQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return qty4(n).toFixed(4);
}

function bucketLabel(value) {
  const text = String(value || "").replaceAll("_", " ").trim();
  return text ? text.replace(/\b\w/g, (m) => m.toUpperCase()) : "All";
}

function sourceLabel(value) {
  if (String(value) === "sales_return") return "Sales Return";
  if (String(value) === "service_warranty") return "Service / Warranty";
  return bucketLabel(value);
}

function bucketAppearance(bucket) {
  const key = String(bucket || "");
  if (key === "pending_start") {
    return { ...getDeskStatusAppearance("pending", { info: ["pending"], fallbackTone: "#eef4ff", fallbackColor: "#234a8f" }), label: "Pending start" };
  }
  if (key === "in_progress") {
    return { ...getDeskStatusAppearance("progress", { warning: ["progress"], fallbackTone: "#fff6e8", fallbackColor: "#8b5a00" }), label: "In progress" };
  }
  if (key === "stale_7d") {
    return { ...getDeskStatusAppearance("stale", { danger: ["stale"], fallbackTone: "#fff2f3", fallbackColor: "#9f2042" }), label: "Stale 7d+" };
  }
  if (key === "closed") {
    return { ...getDeskStatusAppearance("closed", { success: ["closed"], fallbackTone: "#effcf3", fallbackColor: "#0b7d45" }), label: "Closed" };
  }
  return { tone: "#f6f7fb", color: "#58627a", label: bucketLabel(bucket) };
}

function deriveBucket(row) {
  const accepted = qty4(row?.qty_accepted);
  const planned = qty4(row?.qty_planned_active);
  const pending = qty4(Math.max(accepted - planned, 0));
  if (pending <= 0.0001) return "closed";
  const dateText = row?.source_date ? String(row.source_date).slice(0, 10) : "";
  if (dateText) {
    const d = new Date(dateText);
    const today = new Date();
    d.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    const ageDays = Math.floor((today.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
    if (Number.isFinite(ageDays) && ageDays >= 7) return "stale_7d";
  }
  const jobs = Number(row?.active_job_count || 0);
  return jobs > 0 ? "in_progress" : "pending_start";
}

const BUCKETS = [
  ["all", "All"],
  ["pending_start", "Pending start"],
  ["in_progress", "In progress"],
  ["stale_7d", "Stale 7d+"],
  ["closed", "Closed"],
];

function normalizeLaunch(value) {
  if (!value || typeof value !== "object") return null;
  const bucket = typeof value.bucket === "string" ? value.bucket : "all";
  const q = typeof value.q === "string" ? value.q : "";
  return { bucket, q };
}

function keyForRow(row) {
  return `${row?.source_type || ""}:${row?.source_id || ""}:${row?.source_line_id || ""}`;
}

export default function ReturnRework({
  launch = null,
  onConsumeLaunch = null,
  onOpenSalesReturn = null,
  onOpenServiceCase = null,
  onOpenJobCard = null,
} = {}) {
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [bucket, setBucket] = useState("pending_start");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [form, setForm] = useState({ qty_planned: "", job_date: toIsoDate(new Date()), technician_name: "", department: "", site_name: "", remarks: "" });

  const selectedRow = useMemo(() => rows.find((row) => keyForRow(row) === selectedKey) || null, [rows, selectedKey]);

  const stats = useMemo(() => {
    return [
      { label: "Pending start", value: summaryLoading ? "…" : String(summary?.pending_start_lines ?? 0), tone: "#234a8f" },
      { label: "In progress", value: summaryLoading ? "…" : String(summary?.in_progress_lines ?? 0), tone: "#8b5a00" },
      { label: "Stale 7d+", value: summaryLoading ? "…" : String(summary?.stale_7d_lines ?? 0), tone: "#9f2042" },
      { label: "Pending qty", value: summaryLoading ? "…" : fmtQty(summary?.pending_qty ?? 0), tone: "#234a8f" },
    ];
  }, [summary, summaryLoading]);

  async function loadSummary(nextQuery = query) {
    setSummaryLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (nextQuery) params.set("q", nextQuery);
      const data = await apiFetch(`/return-rework/summary${params.toString() ? `?${params.toString()}` : ""}`);
      if (data?.ok) setSummary(data.summary || null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load return rework summary."));
    } finally {
      setSummaryLoading(false);
    }
  }

  async function loadQueue(nextQuery = query, nextBucket = bucket) {
    setQueueLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (nextQuery) params.set("q", nextQuery);
      if (nextBucket && nextBucket !== "all") params.set("bucket", nextBucket);
      params.set("limit", "80");
      const data = await apiFetch(`/return-rework/queue?${params.toString()}`);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load return rework queue."));
    } finally {
      setQueueLoading(false);
    }
  }

  async function refresh(nextQuery = query, nextBucket = bucket) {
    setNotice("");
    await Promise.all([loadSummary(nextQuery), loadQueue(nextQuery, nextBucket)]);
  }

  function openEditor(row) {
    const accepted = qty4(row?.qty_accepted);
    const planned = qty4(row?.qty_planned_active);
    const pending = qty4(Math.max(accepted - planned, 0));
    setSelectedKey(keyForRow(row));
    setForm((prev) => ({
      ...prev,
      qty_planned: pending > 0 ? String(pending) : "",
      job_date: prev.job_date || toIsoDate(new Date()),
    }));
  }

  function normalizeQtyInput(value) {
    if (value === "" || value === null || value === undefined) return "";
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    return String(qty4(n));
  }

  async function startRework() {
    if (!selectedRow) {
      setError("Select a row first.");
      return;
    }
    const qtyPlanned = qty4(form.qty_planned);
    const accepted = qty4(selectedRow.qty_accepted);
    const planned = qty4(selectedRow.qty_planned_active);
    const pending = qty4(Math.max(accepted - planned, 0));
    if (qtyPlanned <= 0.0001) {
      setError("Enter planned qty.");
      return;
    }
    if (qtyPlanned > pending + 0.0001) {
      setError("Planned qty cannot exceed pending qty.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/return-rework/start", {
        method: "POST",
        body: JSON.stringify({
          source_type: selectedRow.source_type,
          source_id: selectedRow.source_id,
          source_line_id: selectedRow.source_line_id,
          qty_planned: qtyPlanned,
          job_date: form.job_date || null,
          technician_name: form.technician_name || null,
          department: form.department || null,
          site_name: form.site_name || null,
          remarks: form.remarks || null,
        }),
      });
      if (data?.ok) {
        setSummary(data.summary || null);
        setRows(Array.isArray(data?.rows) ? data.rows : []);
        setNotice("Rework job card created.");
        if (data?.job_card_id && typeof onOpenJobCard === "function") onOpenJobCard(data.job_card_id);
      }
    } catch (e) {
      const code = String(e?.data?.error || "");
      if (code === "NO_ACCEPTED_QTY") setError("This return line has no accepted qty yet.");
      else if (code === "QTY_EXCEEDS_PENDING") setError("Planned qty cannot exceed pending qty.");
      else if (code === "COMPANY_NOT_SELECTED") setError("Select a company before creating rework jobs.");
      else setError(getApiErrorMessage(e, "Failed to create rework job."));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  useEffect(() => {
    const resolved = normalizeLaunch(launch);
    if (!resolved) return;
    const resolvedBucket = BUCKETS.some(([value]) => value === resolved.bucket) ? resolved.bucket : "all";
    setBucket(resolvedBucket);
    setQuery(resolved.q);
    refresh(resolved.q, resolvedBucket).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  return (
    <div style={{ maxWidth: 1220 }}>
      <PageHero
        eyebrow="Post-RMA execution"
        title="Return rework / refurb desk"
        description="Convert accepted returns into controlled rework jobs using Job Cards so follow-up, parts issue, and closure remain visible."
        actions={
          <>
            <button onClick={() => refresh().catch(() => {})} disabled={summaryLoading || queueLoading}>
              {summaryLoading || queueLoading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={() => {
                setBucket("pending_start");
                refresh(query, "pending_start").catch(() => {});
              }}
              disabled={summaryLoading || queueLoading}
            >
              Pending start
            </button>
          </>
        }
        stats={stats}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
        <DeskCard
          title="Accepted return lines"
          subtitle="Each row is an accepted return line. Start a Job Card to track refurbishment effort and closure."
          actions={
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") refresh(query, bucket).catch(() => {});
                }}
                placeholder="Search document, customer, item, job card"
                style={{ height: 36, minWidth: 260 }}
              />
              <button onClick={() => refresh(query, bucket).catch(() => {})} disabled={queueLoading}>
                {queueLoading ? "Loading..." : "Load"}
              </button>
            </div>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {BUCKETS.map(([value, label]) => (
              <button
                key={value}
                onClick={() => {
                  setBucket(value);
                  refresh(query, value).catch(() => {});
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {queueLoading ? (
            <div>Loading return rework queue…</div>
          ) : rows.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map((row) => {
                const accepted = qty4(row.qty_accepted);
                const planned = qty4(row.qty_planned_active);
                const pending = qty4(Math.max(accepted - planned, 0));
                const bucketKey = deriveBucket(row);
                const appearance = bucketAppearance(bucketKey);
                const selected = keyForRow(row) === selectedKey;
                return (
                  <div
                    key={keyForRow(row)}
                    style={{
                      border: selected ? "2px solid #234a8f" : "1px solid #e0e6f0",
                      borderRadius: 18,
                      padding: 12,
                      background: "#ffffff",
                      boxShadow: selected ? "0 16px 35px rgba(35, 74, 143, 0.12)" : "0 10px 26px rgba(17, 32, 56, 0.05)",
                      display: "grid",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 900, fontSize: 16 }}>
                          {row.source_number} • {row.item_code}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.72 }}>
                          {row.customer_name} • {sourceLabel(row.source_type)} • {fmtDate(row.source_date)} • L{row.line_no}
                        </div>
                        <div style={{ fontSize: 13, opacity: 0.82, marginTop: 6 }}>{row.item_name}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                        <DeskChip label={appearance.label} tone={appearance.tone} color={appearance.color} />
                        <DeskChip label={row.uom || "—"} tone="#f6f7fb" color="#58627a" />
                        {row.latest_job_card_number ? <DeskChip label={row.latest_job_card_number} tone="#eef4ff" color="#234a8f" /> : null}
                        {row.latest_job_status ? (
                          <DeskChip label={String(row.latest_job_status)} tone={getDeskStatusAppearance(row.latest_job_status).tone} color={getDeskStatusAppearance(row.latest_job_status).color} />
                        ) : null}
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Accepted" value={fmtQty(accepted)} />
                      <MiniMetric label="Planned" value={fmtQty(planned)} />
                      <MiniMetric label="Pending" value={fmtQty(pending)} />
                      <MiniMetric label="Active jobs" value={String(row.active_job_count || 0)} />
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        {row.latest_job_card_number ? `Latest job: ${row.latest_job_card_number}` : "No job card yet."}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {row.source_type === "sales_return" ? (
                          <button onClick={() => typeof onOpenSalesReturn === "function" && onOpenSalesReturn(row.source_id)}>Open Sales Return</button>
                        ) : null}
                        {row.source_type === "service_warranty" ? (
                          <button onClick={() => typeof onOpenServiceCase === "function" && onOpenServiceCase(row.source_id)}>Open Service Case</button>
                        ) : null}
                        {row.latest_job_card_id ? (
                          <button onClick={() => typeof onOpenJobCard === "function" && onOpenJobCard(row.latest_job_card_id)}>Open Job Card</button>
                        ) : null}
                        <button onClick={() => openEditor(row)} disabled={pending <= 0.0001}>
                          Start rework
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ opacity: 0.72 }}>No accepted return lines in this bucket.</div>
          )}
        </DeskCard>

        <DeskCard title="Start rework job" subtitle="Creates a Job Card (internal issue) and links it to this accepted return line.">
          {selectedRow ? (
            <>
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  <DeskStat label="Source" value={sourceLabel(selectedRow.source_type)} tone="#234a8f" />
                  <DeskStat label="Doc" value={selectedRow.source_number || "—"} tone="#234a8f" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                  <MiniMetric label="Accepted" value={fmtQty(selectedRow.qty_accepted)} />
                  <MiniMetric label="Planned" value={fmtQty(selectedRow.qty_planned_active)} />
                  <MiniMetric
                    label="Pending"
                    value={fmtQty(qty4(Math.max(qty4(selectedRow.qty_accepted) - qty4(selectedRow.qty_planned_active), 0)))}
                  />
                </div>
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                <FieldLabel label="Planned qty">
                  <input
                    value={form.qty_planned}
                    onChange={(e) => setForm((prev) => ({ ...prev, qty_planned: normalizeQtyInput(e.target.value) }))}
                    placeholder="0"
                    style={{ height: 36 }}
                  />
                </FieldLabel>
                <FieldLabel label="Job date">
                  <input value={form.job_date} onChange={(e) => setForm((prev) => ({ ...prev, job_date: e.target.value }))} type="date" style={{ height: 36 }} />
                </FieldLabel>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  <FieldLabel label="Technician">
                    <input value={form.technician_name} onChange={(e) => setForm((prev) => ({ ...prev, technician_name: e.target.value }))} style={{ height: 36 }} />
                  </FieldLabel>
                  <FieldLabel label="Department">
                    <input value={form.department} onChange={(e) => setForm((prev) => ({ ...prev, department: e.target.value }))} style={{ height: 36 }} />
                  </FieldLabel>
                </div>
                <FieldLabel label="Site">
                  <input value={form.site_name} onChange={(e) => setForm((prev) => ({ ...prev, site_name: e.target.value }))} style={{ height: 36 }} />
                </FieldLabel>
                <FieldLabel label="Remarks">
                  <textarea
                    value={form.remarks}
                    onChange={(e) => setForm((prev) => ({ ...prev, remarks: e.target.value }))}
                    rows={3}
                    style={{ padding: 10, resize: "vertical" }}
                    placeholder="Work notes"
                  />
                </FieldLabel>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button onClick={startRework} disabled={saving}>
                    {saving ? "Creating..." : "Create Job Card"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div style={{ opacity: 0.72 }}>Select a row from the queue to create a rework job card.</div>
          )}
        </DeskCard>
      </div>
    </div>
  );
}

