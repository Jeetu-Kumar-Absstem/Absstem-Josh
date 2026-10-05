import { useEffect, useMemo, useState } from "react";
import ConfirmDraftCard from "../components/ConfirmDraftCard";
import { buildAftermarketTriageDraft } from "../shared/aiDrafts";
import { DeskCard, DeskChip, DeskStat, DeskTopStrip, MiniMetric, NoticeBanner, getDeskStatusAppearance } from "../shared/joshUi";

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

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stageAppearance(stage) {
  const s = String(stage || "").toLowerCase();
  if (s === "service_case") return { tone: "#eef4ff", color: "#234a8f" };
  if (s === "amc_visit") return { tone: "#eefbf3", color: "#147a3d" };
  if (s === "amc_contract") return { tone: "#fff7ea", color: "#8b5a00" };
  return { tone: "#f6f7fb", color: "#58627a" };
}

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["closed", "completed", "delivered"],
    info: ["open", "scheduled"],
    warning: ["draft"],
    danger: ["cancelled"],
    fallbackTone: "#f6f7fb",
  });
}

const BUCKETS = [
  ["service_pending_field_return", "Service: pending field return"],
  ["service_pending_replacement", "Service: pending replacement"],
  ["service_open_stale_7d", "Service: stale 7d+"],
  ["amc_overdue_visits", "AMC: overdue visits"],
  ["amc_due_today", "AMC: due today"],
  ["amc_due_next_7d", "AMC: due next 7d"],
  ["amc_expiring_7d", "AMC: contracts expiring 7d"],
  ["amc_expiring_30d", "AMC: contracts expiring 30d"],
];

const BUCKET_ALIASES = {
  amc_expiring: "amc_expiring_7d",
  amc_renewals: "amc_expiring_7d",
};

function normalizeLaunch(value) {
  if (!value || typeof value !== "object") return null;
  const rawBucket = typeof value.bucket === "string" ? value.bucket.trim() : "";
  const bucket = BUCKET_ALIASES[rawBucket] || rawBucket;
  const q = typeof value.q === "string" ? value.q : "";
  return { bucket, q };
}

function defaultTriageForRow(row, bucket) {
  const stage = String(row?.stage || "");
  const bucketKey = String(bucket || "");
  if (bucketKey.startsWith("amc_expiring") || stage === "amc_contract") return "amc_renewal_quote";
  if (stage === "amc_visit") return "engineer_dispatch";
  if (stage === "service_case") {
    if (Number(row?.qty_pending_replacement || 0) > 0) return "service_quote";
    return "service_follow_up";
  }
  return null;
}

function triageButtonLabel(triage) {
  if (triage === "amc_renewal_quote") return "Draft renewal quote";
  if (triage === "engineer_dispatch") return "Draft engineer dispatch";
  if (triage === "service_quote") return "Draft service quote";
  return "Draft follow-up";
}

export default function AftermarketDesk({
  launch = null,
  onConsumeLaunch = null,
  onOpenServiceCase = null,
  onOpenAmcContract = null,
  onOpenServiceTickets = null,
  onOpenReverseLogistics = null,
  onOpenReturnRework = null,
  onCreateAftermarketQuote = null,
  canCreateAftermarketQuote = false,
} = {}) {
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [summary, setSummary] = useState(null);
  const [bucket, setBucket] = useState("service_pending_field_return");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [triageDraft, setTriageDraft] = useState(null);

  const topMetrics = useMemo(() => {
    const s = summary && typeof summary === "object" ? summary : {};
    return [
      {
        label: "Svc field return",
        value: String(s?.service?.pending_field_return?.case_count ?? 0),
        tone: "#234a8f",
        note: "Open service returns",
        onClick: () => {
          setBucket("service_pending_field_return");
          loadQueue(query, "service_pending_field_return").catch(() => {});
        },
      },
      {
        label: "Svc replacement",
        value: String(s?.service?.pending_replacement?.case_count ?? 0),
        tone: "#8b5a00",
        note: "Open replacement queue",
        onClick: () => {
          setBucket("service_pending_replacement");
          loadQueue(query, "service_pending_replacement").catch(() => {});
        },
      },
      {
        label: "Svc stale 7d+",
        value: String(s?.service?.open_stale_7d?.case_count ?? 0),
        tone: "#9f2042",
        note: "Open stale service cases",
        onClick: () => {
          setBucket("service_open_stale_7d");
          loadQueue(query, "service_open_stale_7d").catch(() => {});
        },
      },
      {
        label: "AMC overdue",
        value: String(s?.amc?.overdue_visits ?? 0),
        tone: "#147a3d",
        note: "Open overdue AMC visits",
        onClick: () => {
          setBucket("amc_overdue_visits");
          loadQueue(query, "amc_overdue_visits").catch(() => {});
        },
      },
    ];
  }, [summary, query]);

  async function loadSummary() {
    setSummaryLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/aftermarket-desk/summary${query ? `?q=${encodeURIComponent(query)}` : ""}`);
      if (data?.ok) setSummary(data.summary || null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load Aftermarket Desk summary."));
    } finally {
      setSummaryLoading(false);
    }
  }

  async function loadQueue(nextQuery = query, nextBucket = bucket) {
    setQueueLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("bucket", nextBucket);
      params.set("limit", "120");
      if (nextQuery) params.set("q", nextQuery);
      const data = await apiFetch(`/aftermarket-desk/queue?${params.toString()}`);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load Aftermarket Desk queue."));
      setRows([]);
    } finally {
      setQueueLoading(false);
    }
  }

  useEffect(() => {
    loadSummary().catch(() => {});
    loadQueue().catch(() => {});
  }, []);

  useEffect(() => {
    if (!launch) return;
    const normalized = normalizeLaunch(launch);
    if (!normalized) return;
    const nextBucket = BUCKETS.some(([key]) => key === normalized.bucket) ? normalized.bucket : "";
    if (nextBucket) setBucket(nextBucket);
    if (typeof normalized.q === "string") setQuery(normalized.q);
    loadQueue(normalized.q, nextBucket || bucket).catch(() => {});
    loadSummary().catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  const summaryStats = useMemo(() => {
    const s = summary && typeof summary === "object" ? summary : {};
    return {
      service_field_return_qty: num(s?.service?.pending_field_return?.pending_qty),
      service_replacement_qty: num(s?.service?.pending_replacement?.pending_qty),
      amc_overdue: num(s?.amc?.overdue_visits),
      amc_today: num(s?.amc?.due_today),
      amc_next: num(s?.amc?.due_next_7d),
      amc_expiring_7d: num(s?.amc?.expiring_7d),
    };
  }, [summary]);

  function openDocument(row) {
    const stage = String(row?.stage || "");
    if (stage === "service_case") onOpenServiceCase?.(row.record_id);
    if (stage === "amc_visit" || stage === "amc_contract") {
      onOpenAmcContract?.(row.amc_contract_id || row.record_id);
    }
  }

  function openTriageDraft(row, triageOverride = null) {
    const triage = triageOverride || defaultTriageForRow(row, bucket);
    if (triage === "amc_renewal_quote" || triage === "service_quote") {
      if (!canCreateAftermarketQuote || typeof onCreateAftermarketQuote !== "function") {
        setError("Quote create rights are required for this aftermarket draft.");
        return;
      }
    }
    const draft = buildAftermarketTriageDraft({ row, bucket, triage });
    if (!draft) {
      setError("Could not draft a triage action for this row.");
      return;
    }
    setError("");
    setNotice("");
    setTriageDraft(draft);
  }

  function confirmTriageDraft(_data, working) {
    const nav = working?.payload?.navigate;
    setTriageDraft(null);
    if (!nav || typeof nav !== "object") return;

    if (nav.kind === "aftermarket_quote" && typeof onCreateAftermarketQuote === "function") {
      onCreateAftermarketQuote(nav.launch || {});
      setNotice("Opened aftermarket quote draft — save in Quotes when ready.");
      return;
    }
    if (nav.kind === "amc_contract" && typeof onOpenAmcContract === "function") {
      onOpenAmcContract(nav.amc_contract_id);
      setNotice("Opened AMC contract for engineer dispatch.");
      return;
    }
    if (nav.kind === "service_case" && typeof onOpenServiceCase === "function") {
      onOpenServiceCase(nav.service_case_id);
      setNotice("Opened service case for follow-up.");
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <DeskTopStrip
        title="Aftermarket Desk"
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={() => loadSummary().catch(() => {})} disabled={summaryLoading}>
              {summaryLoading ? "Loading..." : "Refresh Summary"}
            </button>
            <button type="button" onClick={() => loadQueue().catch(() => {})} disabled={queueLoading}>
              {queueLoading ? "Loading..." : "Refresh Queue"}
            </button>
            <button
              type="button"
              onClick={() => {
                setBucket("service_open_stale_7d");
                loadQueue(query, "service_open_stale_7d").catch(() => {});
              }}
            >
              Stale service
            </button>
            <button
              type="button"
              onClick={() => {
                setBucket("amc_overdue_visits");
                loadQueue(query, "amc_overdue_visits").catch(() => {});
              }}
            >
              AMC overdue
            </button>
            <button
              type="button"
              onClick={() => {
                setBucket("amc_expiring_7d");
                loadQueue(query, "amc_expiring_7d").catch(() => {});
              }}
            >
              AMC expiring 7d
            </button>
            <button type="button" onClick={() => onOpenServiceTickets?.()}>
              Service Tickets
            </button>
            <button type="button" onClick={() => onOpenReverseLogistics?.()}>
              Reverse Logistics
            </button>
            <button type="button" onClick={() => onOpenReturnRework?.()}>
              Return Rework
            </button>
          </div>
        }
        metrics={topMetrics}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      {triageDraft ? (
        <div style={{ marginTop: 12 }}>
          <ConfirmDraftCard
            draft={triageDraft}
            editableRemarks
            onCancel={() => setTriageDraft(null)}
            onConfirmed={confirmTriageDraft}
          />
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, marginTop: 16 }}>
        <DeskStat label="Field return qty" value={summaryStats.service_field_return_qty.toFixed(4)} tone="#234a8f" />
        <DeskStat label="Replacement qty" value={summaryStats.service_replacement_qty.toFixed(4)} tone="#8b5a00" />
        <DeskStat label="AMC overdue" value={summaryStats.amc_overdue} tone="#9f2042" />
        <DeskStat label="AMC today" value={summaryStats.amc_today} tone="#147a3d" />
        <DeskStat label="AMC next 7d" value={summaryStats.amc_next} tone="#58627a" />
        <DeskStat label="AMC expiring 7d" value={summaryStats.amc_expiring_7d} tone="#8b5a00" />
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 0.38fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Queue" subtitle="Draft a triage action, then confirm — nothing auto-writes">
          {queueLoading ? (
            <div>Loading queue…</div>
          ) : rows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {rows.map((row) => {
                const stage = String(row.stage || "");
                const stageChip = stageAppearance(stage);
                const statusChip = statusAppearance(row.record_status);
                const triage = defaultTriageForRow(row, bucket);
                const quoteTriage = triage === "amc_renewal_quote" || triage === "service_quote";
                const triageDisabled =
                  Boolean(triageDraft) || (quoteTriage && (!canCreateAftermarketQuote || typeof onCreateAftermarketQuote !== "function"));

                return (
                  <div
                    key={`${stage}-${row.record_id}`}
                    style={{
                      border: "1px solid #e7ebf3",
                      borderRadius: 18,
                      padding: 14,
                      background: "#ffffff",
                      boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                      display: "grid",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 16 }}>{row.record_number || `#${row.record_id}`}</div>
                        <div style={{ marginTop: 6, fontSize: 13, opacity: 0.76 }}>{row.customer_name || "—"}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <DeskChip label={stage === "service_case" ? "Service" : "AMC"} tone={stageChip.tone} color={stageChip.color} />
                        <DeskChip label={String(row.record_status || "").toUpperCase()} tone={statusChip.tone} color={statusChip.color} />
                        {Number(row.ageing_days || 0) > 0 ? <DeskChip label={`${row.ageing_days}d`} tone="#fff7ea" color="#8b5a00" /> : null}
                      </div>
                    </div>

                    {stage === "service_case" ? (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                        <MiniMetric label="Pending field return" value={Number(row.qty_pending_field_return || 0).toFixed(4)} />
                        <MiniMetric label="Pending replacement" value={Number(row.qty_pending_replacement || 0).toFixed(4)} />
                        <MiniMetric label="Dispatch" value={row.dispatch_number || "—"} />
                        <MiniMetric label="SO" value={row.so_number || "—"} />
                      </div>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                        <MiniMetric label="Visit no" value={row.visit_no || "—"} />
                        <MiniMetric label="Due date" value={row.due_date ? String(row.due_date).slice(0, 10) : "—"} />
                        <MiniMetric label="Linked service case" value={row.service_case_id || row.service_warranty_case_id ? `#${row.service_case_id || row.service_warranty_case_id}` : "—"} />
                        <MiniMetric label="Contract id" value={row.amc_contract_id ? `#${row.amc_contract_id}` : "—"} />
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {triage ? (
                        <button type="button" onClick={() => openTriageDraft(row, triage)} disabled={triageDisabled}>
                          {triageButtonLabel(triage)}
                        </button>
                      ) : null}
                      {stage === "service_case" && Number(row.qty_pending_replacement || 0) > 0 && triage !== "service_quote" ? (
                        <button
                          type="button"
                          onClick={() => openTriageDraft(row, "service_quote")}
                          disabled={Boolean(triageDraft) || !canCreateAftermarketQuote || typeof onCreateAftermarketQuote !== "function"}
                        >
                          Draft service quote
                        </button>
                      ) : null}
                      <button type="button" className="button-ghost" onClick={() => openDocument(row)}>
                        Open document
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No rows in this bucket.
            </div>
          )}
        </DeskCard>

        <DeskCard title="Buckets" subtitle="Work queues">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer / document no" />
            <button type="button" onClick={() => loadQueue().catch(() => {})} disabled={queueLoading}>
              Apply Search
            </button>
            <div style={{ display: "grid", gap: 8 }}>
              {BUCKETS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setBucket(key);
                    loadQueue(query, key).catch(() => {});
                  }}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid #e7ebf3",
                    background: key === bucket ? "#eef4ff" : "#ffffff",
                    cursor: "pointer",
                    fontWeight: key === bucket ? 800 : 600,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
