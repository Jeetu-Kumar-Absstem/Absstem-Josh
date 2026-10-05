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

function getReverseLogisticsBucket(row) {
  const returnedQty = qty4(row?.qty_returned);
  const acceptedQty = qty4(row?.qty_accepted);
  const scrappedQty = qty4(row?.qty_scrapped);
  if (acceptedQty + scrappedQty > returnedQty + 0.0001) return "over_disposed";
  const pending = qty4(Math.max(returnedQty - acceptedQty - scrappedQty, 0));
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
  return "pending_disposition";
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

const BUCKETS = [
  ["all", "All"],
  ["pending_disposition", "Pending disposition"],
  ["stale_7d", "Stale 7d+"],
  ["over_disposed", "Over-disposed"],
  ["closed", "Closed"],
];

function bucketAppearance(bucket) {
  if (bucket === "pending_disposition") {
    return { ...getDeskStatusAppearance("pending", { info: ["pending"], fallbackTone: "#eef4ff", fallbackColor: "#234a8f" }), label: "Pending" };
  }
  if (bucket === "stale_7d") {
    return { ...getDeskStatusAppearance("stale", { warning: ["stale"], fallbackTone: "#fff6e8", fallbackColor: "#8b5a00" }), label: "Stale 7d+" };
  }
  if (bucket === "over_disposed") {
    return { ...getDeskStatusAppearance("over", { danger: ["over"], fallbackTone: "#fff2f3", fallbackColor: "#9f2042" }), label: "Over-disposed" };
  }
  if (bucket === "closed") {
    return { ...getDeskStatusAppearance("closed", { success: ["closed"], fallbackTone: "#effcf3", fallbackColor: "#0b7d45" }), label: "Closed" };
  }
  return { tone: "#f6f7fb", color: "#58627a", label: bucketLabel(bucket) };
}

function normalizeLaunch(value) {
  if (!value || typeof value !== "object") return null;
  const bucket = typeof value.bucket === "string" ? value.bucket : "all";
  const q = typeof value.q === "string" ? value.q : "";
  return { bucket, q };
}

function keyForRow(row) {
  return `${row?.source_type || ""}:${row?.source_id || ""}:${row?.source_line_id || ""}`;
}

export default function ReverseLogistics({
  launch = null,
  onConsumeLaunch = null,
  onOpenSalesReturn = null,
  onOpenServiceCase = null,
} = {}) {
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [bucket, setBucket] = useState("pending_disposition");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [form, setForm] = useState({ accepted: "", scrapped: "", date: "", remarks: "" });

  const selectedRow = useMemo(() => rows.find((row) => keyForRow(row) === selectedKey) || null, [rows, selectedKey]);

  const stats = useMemo(() => {
    return [
      { label: "Pending lines", value: summaryLoading ? "…" : String(summary?.pending_lines ?? 0), tone: "#234a8f" },
      { label: "Stale 7d+", value: summaryLoading ? "…" : String(summary?.stale_7d_lines ?? 0), tone: "#8b5a00" },
      { label: "Pending qty", value: summaryLoading ? "…" : fmtQty(summary?.pending_qty ?? 0), tone: "#234a8f" },
      { label: "Over-disposed", value: summaryLoading ? "…" : String(summary?.over_disposed_lines ?? 0), tone: "#9f2042" },
    ];
  }, [summary, summaryLoading]);

  async function loadSummary(nextQuery = query) {
    setSummaryLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (nextQuery) params.set("q", nextQuery);
      const data = await apiFetch(`/reverse-logistics/summary${params.toString() ? `?${params.toString()}` : ""}`);
      if (data?.ok) setSummary(data.summary || null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load reverse logistics summary."));
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
      const data = await apiFetch(`/reverse-logistics/queue${params.toString() ? `?${params.toString()}` : ""}`);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load reverse logistics queue."));
    } finally {
      setQueueLoading(false);
    }
  }

  async function refresh(nextQuery = query, nextBucket = bucket) {
    setNotice("");
    await Promise.all([loadSummary(nextQuery), loadQueue(nextQuery, nextBucket)]);
  }

  function openEditor(row) {
    const returnedQty = qty4(row?.qty_returned);
    const acceptedQty = qty4(row?.qty_accepted);
    const scrappedQty = qty4(row?.qty_scrapped);
    const pendingQty = qty4(Math.max(returnedQty - acceptedQty - scrappedQty, 0));
    const nextKey = keyForRow(row);
    setSelectedKey(nextKey);
    setForm({
      accepted: acceptedQty ? String(acceptedQty) : "",
      scrapped: scrappedQty ? String(scrappedQty) : "",
      date: toIsoDate(row?.disposition_date || new Date()),
      remarks: row?.disposition_remarks || "",
      pending_qty: pendingQty,
    });
  }

  function normalizeQtyInput(value) {
    if (value === "" || value === null || value === undefined) return "";
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    return String(qty4(n));
  }

  async function saveDisposition() {
    if (!selectedRow) {
      setError("Select a row first.");
      return;
    }
    const returnedQty = qty4(selectedRow.qty_returned);
    const currentScrapped = qty4(selectedRow.qty_scrapped);
    const acceptedQty = qty4(form.accepted);
    const scrappedQty = qty4(form.scrapped);
    if (acceptedQty < 0 || scrappedQty < 0) {
      setError("Quantities cannot be negative.");
      return;
    }
    if (scrappedQty + 0.0001 < currentScrapped) {
      setError("Scrap qty cannot decrease.");
      return;
    }
    if (acceptedQty + scrappedQty > returnedQty + 0.0001) {
      setError("Accepted + scrapped cannot exceed returned qty.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/reverse-logistics/disposition", {
        method: "PUT",
        body: JSON.stringify({
          source_type: selectedRow.source_type,
          source_id: selectedRow.source_id,
          source_line_id: selectedRow.source_line_id,
          qty_accepted: acceptedQty,
          qty_scrapped: scrappedQty,
          disposition_date: form.date || null,
          disposition_remarks: form.remarks || null,
        }),
      });
      if (data?.ok) {
        setSummary(data.summary || null);
        setRows(Array.isArray(data?.rows) ? data.rows : []);
        setNotice("Disposition saved.");
      }
    } catch (e) {
      const code = String(e?.data?.error || "");
      if (code === "DISPOSITION_EXCEEDS_RETURNED") setError("Accepted + scrapped cannot exceed returned qty.");
      else if (code === "SCRAP_CANNOT_DECREASE") setError("Scrap qty cannot decrease once posted.");
      else if (code === "COMPANY_NOT_SELECTED") setError("Select a company before disposing returns.");
      else setError(getApiErrorMessage(e, "Failed to save disposition."));
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

  useEffect(() => {
    if (!selectedRow) return;
    const acceptedQty = qty4(selectedRow.qty_accepted);
    const scrappedQty = qty4(selectedRow.qty_scrapped);
    setForm((prev) => ({
      ...prev,
      accepted: acceptedQty ? String(acceptedQty) : "",
      scrapped: scrappedQty ? String(scrappedQty) : "",
    }));
  }, [selectedKey]);

  return (
    <div style={{ maxWidth: 1220 }}>
      <PageHero
        eyebrow="Customer RMA"
        title="Reverse logistics control desk"
        description="Control physical disposition for customer returns: accept back into stock or scrap with traceable stock movements."
        actions={
          <>
            <button onClick={() => refresh().catch(() => {})} disabled={summaryLoading || queueLoading}>
              {summaryLoading || queueLoading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={() => {
                setBucket("pending_disposition");
                refresh(query, "pending_disposition").catch(() => {});
              }}
              disabled={summaryLoading || queueLoading}
            >
              Pending disposition
            </button>
          </>
        }
        stats={stats}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
        <DeskCard
          title="Disposition queue"
          subtitle="Filter pending/stale/over-disposed lines, search by document/customer/item, and open each source for context."
          actions={
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") refresh(query, bucket).catch(() => {});
                }}
                placeholder="Search document, customer, or item"
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
            <div>Loading reverse logistics queue…</div>
          ) : rows.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map((row) => {
                const bucketKey = getReverseLogisticsBucket(row);
                const appearance = bucketAppearance(bucketKey);
                const returnedQty = qty4(row.qty_returned);
                const acceptedQty = qty4(row.qty_accepted);
                const scrappedQty = qty4(row.qty_scrapped);
                const pendingQty = qty4(Math.max(returnedQty - acceptedQty - scrappedQty, 0));
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
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Returned" value={fmtQty(returnedQty)} />
                      <MiniMetric label="Accepted" value={fmtQty(acceptedQty)} />
                      <MiniMetric label="Scrapped" value={fmtQty(scrappedQty)} />
                      <MiniMetric label="Pending" value={fmtQty(pendingQty)} />
                      <MiniMetric label="Disposition date" value={fmtDate(row.disposition_date)} />
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        {row.disposition_remarks ? `Remarks: ${row.disposition_remarks}` : "Remarks: —"}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {row.source_type === "sales_return" ? (
                          <button
                            onClick={() => {
                              if (typeof onOpenSalesReturn === "function") onOpenSalesReturn(row.source_id);
                            }}
                          >
                            Open Sales Return
                          </button>
                        ) : null}
                        {row.source_type === "service_warranty" ? (
                          <button
                            onClick={() => {
                              if (typeof onOpenServiceCase === "function") onOpenServiceCase(row.source_id);
                            }}
                          >
                            Open Service Case
                          </button>
                        ) : null}
                        <button onClick={() => openEditor(row)}>Dispose</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ opacity: 0.72 }}>No reverse logistics rows in this bucket.</div>
          )}
        </DeskCard>

        <DeskCard
          title="Disposition editor"
          subtitle="Set accepted vs scrapped quantities. Scrapping posts an incremental stock movement with reference to the return line."
          actions={
            selectedRow ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  onClick={() => {
                    if (!selectedRow) return;
                    const returnedQty = qty4(selectedRow.qty_returned);
                    const currentAccepted = qty4(selectedRow.qty_accepted);
                    const currentScrapped = qty4(selectedRow.qty_scrapped);
                    const remaining = qty4(Math.max(returnedQty - currentAccepted - currentScrapped, 0));
                    setForm((prev) => ({ ...prev, accepted: String(qty4(currentAccepted + remaining)) }));
                  }}
                  disabled={saving}
                >
                  Accept all pending
                </button>
                <button
                  onClick={() => {
                    if (!selectedRow) return;
                    const returnedQty = qty4(selectedRow.qty_returned);
                    const currentAccepted = qty4(selectedRow.qty_accepted);
                    const currentScrapped = qty4(selectedRow.qty_scrapped);
                    const remaining = qty4(Math.max(returnedQty - currentAccepted - currentScrapped, 0));
                    setForm((prev) => ({ ...prev, scrapped: String(qty4(currentScrapped + remaining)) }));
                  }}
                  disabled={saving}
                >
                  Scrap all pending
                </button>
              </div>
            ) : null
          }
        >
          {selectedRow ? (
            <>
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  <DeskStat label="Source" value={sourceLabel(selectedRow.source_type)} tone="#234a8f" />
                  <DeskStat label="Doc" value={selectedRow.source_number || "—"} tone="#234a8f" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                  <MiniMetric label="Returned" value={fmtQty(selectedRow.qty_returned)} />
                  <MiniMetric label="Accepted" value={fmtQty(selectedRow.qty_accepted)} />
                  <MiniMetric label="Scrapped" value={fmtQty(selectedRow.qty_scrapped)} />
                  <MiniMetric
                    label="Pending"
                    value={fmtQty(qty4(Math.max(qty4(selectedRow.qty_returned) - qty4(selectedRow.qty_accepted) - qty4(selectedRow.qty_scrapped), 0)))}
                  />
                </div>
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  <FieldLabel label="Qty accepted">
                    <input
                      value={form.accepted}
                      onChange={(e) => setForm((prev) => ({ ...prev, accepted: normalizeQtyInput(e.target.value) }))}
                      placeholder="0"
                      style={{ height: 36 }}
                    />
                  </FieldLabel>
                  <FieldLabel label="Qty scrapped">
                    <input
                      value={form.scrapped}
                      onChange={(e) => setForm((prev) => ({ ...prev, scrapped: normalizeQtyInput(e.target.value) }))}
                      placeholder="0"
                      style={{ height: 36 }}
                    />
                  </FieldLabel>
                </div>
                <FieldLabel label="Disposition date">
                  <input
                    value={form.date}
                    onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value }))}
                    type="date"
                    style={{ height: 36 }}
                  />
                </FieldLabel>
                <FieldLabel label="Remarks">
                  <textarea
                    value={form.remarks}
                    onChange={(e) => setForm((prev) => ({ ...prev, remarks: e.target.value }))}
                    rows={3}
                    style={{ padding: 10, resize: "vertical" }}
                    placeholder="Disposition notes"
                  />
                </FieldLabel>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button onClick={saveDisposition} disabled={saving}>
                    {saving ? "Saving..." : "Save Disposition"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div style={{ opacity: 0.72 }}>
              Select a row from the queue to dispose it.
            </div>
          )}
        </DeskCard>
      </div>
    </div>
  );
}

