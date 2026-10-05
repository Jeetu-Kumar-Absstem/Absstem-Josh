import { useEffect, useMemo, useState } from "react";
import ConfirmDraftCard from "../components/ConfirmDraftCard";
import { canScreenAction } from "../home/roleAccess";
import { buildQuoteApprovalDraft } from "../shared/aiDrafts";
import { DeskCard, DeskChip, DeskStat, DeskTopStrip, MiniMetric, NoticeBanner, FieldLabel, EmptyState, getDeskStatusAppearance } from "../shared/joshUi";
import { ListCapBanner } from "../shared/listScale";

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

function money(value) {
  return num(value).toFixed(2);
}

function stageLabel(value) {
  if (value === "quote") return "Quote";
  if (value === "sales_order") return "Sales Order";
  if (value === "dispatch") return "Dispatch";
  if (value === "invoice") return "Invoice";
  return String(value || "");
}

function stageAppearance(stage) {
  const s = String(stage || "").toLowerCase();
  if (s === "quote") return { tone: "#eef4ff", color: "#234a8f" };
  if (s === "sales_order") return { tone: "#f5f6fa", color: "#3e475a" };
  if (s === "dispatch") return { tone: "#fff6e8", color: "#8b5a00" };
  if (s === "invoice") return { tone: "#effcf3", color: "#0b7d45" };
  return { tone: "#f6f7fb", color: "#58627a" };
}

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["approved", "issued", "sent", "confirmed", "ready", "dispatched", "delivered"],
    info: ["submitted", "pending_approval"],
    warning: ["draft"],
    danger: ["cancelled"],
    fallbackTone: "#f6f7fb",
  });
}

const BUCKETS = [
  ["quotes_draft", "Quotes draft"],
  ["quotes_unconverted", "Quotes unconverted"],
  ["quotes_issued_aging", "Issued aging"],
  ["quotes_expiring", "Expiring 7d"],
  ["quotes_follow_up_due", "Follow-up due"],
  ["quotes_lapsed", "Lapsed quotes"],
  ["quotes_issued_not_sent", "Issued, not sent"],
  ["quotes_submitted", "Quotes pending approval"],
  ["engineering_ready", "Engineering returned"],
  ["engineering_waiting", "Engineering waiting on Sales"],
  ["so_confirmed_no_dispatch", "SO confirmed, no dispatch"],
  ["dispatch_ready", "Dispatch ready"],
  ["dispatch_not_invoiced", "Dispatch not invoiced"],
  ["invoice_draft", "Invoice draft"],
  ["invoice_outstanding", "Invoice outstanding"],
];

function normalizeLaunch(value) {
  if (!value || typeof value !== "object") return null;
  const bucket = typeof value.bucket === "string" ? value.bucket : "";
  const q = typeof value.q === "string" ? value.q : "";
  return { bucket, q };
}

function deskButtonStyle({ tone = "neutral", active = false, disabled = false } = {}) {
  const palette =
    tone === "primary"
      ? {
          background: active ? "#173f8a" : "#234a8f",
          color: "#ffffff",
          border: "rgba(22, 55, 117, 0.28)",
          shadow: "0 14px 28px rgba(35, 74, 143, 0.18)",
        }
      : tone === "accent"
        ? {
            background: active ? "#eef4ff" : "#ffffff",
            color: active ? "#234a8f" : "#2f3b52",
            border: active ? "rgba(35, 74, 143, 0.22)" : "rgba(131, 144, 168, 0.22)",
            shadow: active ? "0 10px 22px rgba(35, 74, 143, 0.12)" : "0 6px 16px rgba(19, 34, 61, 0.06)",
          }
        : {
            background: active ? "#f2f6ff" : "#ffffff",
            color: active ? "#234a8f" : "#40506a",
            border: active ? "rgba(35, 74, 143, 0.2)" : "rgba(149, 160, 183, 0.2)",
            shadow: "0 8px 20px rgba(19, 34, 61, 0.05)",
          };

  return {
    appearance: "none",
    border: `1px solid ${palette.border}`,
    background: palette.background,
    color: palette.color,
    borderRadius: 12,
    minHeight: 38,
    padding: "0 14px",
    fontSize: 13,
    fontWeight: active ? 800 : 700,
    letterSpacing: "0.01em",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.58 : 1,
    boxShadow: disabled ? "none" : palette.shadow,
    transition: "transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease",
  };
}

function deskSearchInputStyle() {
  return {
    height: 38,
    minWidth: 240,
    padding: "0 12px",
    borderRadius: 12,
    border: "1px solid rgba(137, 149, 172, 0.24)",
    background: "#ffffff",
    boxShadow: "inset 0 1px 2px rgba(20, 34, 58, 0.04)",
    fontSize: 14,
    color: "#24324a",
    outline: "none",
  };
}

function queueRowButtonStyle() {
  return {
    all: "unset",
    cursor: "pointer",
    border: "1px solid #e0e6f0",
    borderRadius: 18,
    padding: 12,
    background: "#ffffff",
    boxShadow: "0 10px 26px rgba(17, 32, 56, 0.05)",
    display: "grid",
    gap: 10,
  };
}

export default function SalesDesk({
  launch = null,
  onConsumeLaunch = null,
  onOpenQuote = null,
  onOpenSalesOrder = null,
  onOpenDispatch = null,
  onOpenInvoice = null,
  onCreateInvoiceFromSalesOrder = null,
  onConvertQuoteToSalesOrder = null,
  me = null,
} = {}) {
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [summary, setSummary] = useState(null);
  const [bucket, setBucket] = useState("quotes_submitted");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [listMeta, setListMeta] = useState(null);
  const [coverage, setCoverage] = useState([]);
  const [coverageScope, setCoverageScope] = useState("");
  const [funnel, setFunnel] = useState([]);
  const [approvalBusyId, setApprovalBusyId] = useState(null);
  const [quoteDraft, setQuoteDraft] = useState(null);

  const topMetrics = useMemo(() => {
    const s = summary && typeof summary === "object" ? summary : {};
    return [
      {
        label: "Pending approval",
        value: String(s?.quotes?.submitted ?? 0),
        tone: "#234a8f",
        note: "Quotes waiting for approval",
        onClick: () => {
          setBucket("quotes_submitted");
          loadQueue(query, "quotes_submitted").catch(() => {});
        },
      },
      {
        label: "Ready to convert",
        value: String(s?.quotes?.approved_unconverted ?? 0),
        tone: "#8b5a00",
        note: "Approved quotes without SO",
        onClick: () => {
          setBucket("quotes_unconverted");
          loadQueue(query, "quotes_unconverted").catch(() => {});
        },
      },
      {
        label: "Engineering returned",
        value: String(s?.engineering?.ready_for_sales ?? 0),
        tone: "#14804a",
        note: `Waiting on Sales ${s?.engineering?.waiting_on_sales ?? 0} · with Eng ${s?.engineering?.with_engineering ?? 0}`,
        onClick: () => {
          setBucket("engineering_ready");
          loadQueue(query, "engineering_ready").catch(() => {});
        },
      },
      {
        label: "Eng waiting on Sales",
        value: String(s?.engineering?.waiting_on_sales ?? 0),
        tone: "#9f2042",
        note: "Engineering needs your input",
        onClick: () => {
          setBucket("engineering_waiting");
          loadQueue(query, "engineering_waiting").catch(() => {});
        },
      },
      {
        label: "Expiring 7d",
        value: String(s?.quotes?.expiring_7d ?? 0),
        tone: "#9f2042",
        note: "Validity ends within a week",
        onClick: () => {
          setBucket("quotes_expiring");
          loadQueue(query, "quotes_expiring").catch(() => {});
        },
      },
      {
        label: "Follow-up due",
        value: String(s?.quotes?.follow_up_due ?? 0),
        tone: "#8b5a00",
        note: "Chase date today or earlier",
        onClick: () => {
          setBucket("quotes_follow_up_due");
          loadQueue(query, "quotes_follow_up_due").catch(() => {});
        },
      },
      {
        label: "Issued, not sent",
        value: String(s?.quotes?.issued_not_sent ?? 0),
        tone: "#9f2042",
        note: "Locked quotes still waiting for email",
        onClick: () => {
          setBucket("quotes_issued_not_sent");
          loadQueue(query, "quotes_issued_not_sent").catch(() => {});
        },
      },
      {
        label: "Lapsed",
        value: String(s?.quotes?.lapsed ?? 0),
        tone: "#9f2042",
        note: "Validity expired without an order",
        onClick: () => {
          setBucket("quotes_lapsed");
          loadQueue(query, "quotes_lapsed").catch(() => {});
        },
      },
      {
        label: "Aging 7d+",
        value: String(s?.quotes?.aging_7d ?? 0),
        tone: "#9f2042",
        note: `3d ${s?.quotes?.aging_3d ?? 0} · 14d ${s?.quotes?.aging_14d ?? 0}`,
        onClick: () => {
          setBucket("quotes_issued_aging");
          loadQueue(query, "quotes_issued_aging").catch(() => {});
        },
      },
      {
        label: "Dispatch not invoiced",
        value: String(s?.dispatches?.dispatched_not_invoiced ?? 0),
        tone: "#9f2042",
        note: "Load dispatch gap",
        onClick: () => {
          setBucket("dispatch_not_invoiced");
          loadQueue(query, "dispatch_not_invoiced").catch(() => {});
        },
      },
    ];
  }, [summary, query]);

  async function loadSummary() {
    setSummaryLoading(true);
    setError("");
    try {
      const data = await apiFetch("/sales-desk/summary");
      if (data?.ok) setSummary(data.summary || null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load Sales Desk summary."));
    } finally {
      setSummaryLoading(false);
    }
  }

  async function loadCoverageAndFunnel() {
    try {
      const [coverageData, funnelData] = await Promise.allSettled([
        apiFetch("/sales-desk/coverage"),
        apiFetch("/sales-desk/funnel"),
      ]);
      if (coverageData.status === "fulfilled" && coverageData.value?.ok) {
        setCoverage(Array.isArray(coverageData.value.rows) ? coverageData.value.rows : []);
        setCoverageScope(coverageData.value.scope || "");
      } else {
        setCoverage([]);
        setCoverageScope("");
      }
      if (funnelData.status === "fulfilled" && funnelData.value?.ok) {
        setFunnel(Array.isArray(funnelData.value.companies) ? funnelData.value.companies : []);
      } else {
        setFunnel([]);
      }
    } catch {
      setCoverage([]);
      setFunnel([]);
    }
  }

  async function loadQueue(nextQuery = query, nextBucket = bucket) {
    setQueueLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (nextQuery) params.set("q", nextQuery);
      if (nextBucket) params.set("bucket", nextBucket);
      params.set("limit", "80");
      const data = await apiFetch(`/sales-desk/queue?${params.toString()}`);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setListMeta(data?.list || null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load Sales Desk queue."));
      setRows([]);
      setListMeta(null);
    } finally {
      setQueueLoading(false);
    }
  }

  async function refresh(nextQuery = query, nextBucket = bucket) {
    setNotice("");
    await Promise.all([loadSummary(), loadQueue(nextQuery, nextBucket), loadCoverageAndFunnel()]);
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  useEffect(() => {
    const resolved = normalizeLaunch(launch);
    if (!resolved) return;
    const resolvedBucket = BUCKETS.some(([value]) => value === resolved.bucket) ? resolved.bucket : bucket;
    setBucket(resolvedBucket);
    setQuery(resolved.q);
    refresh(resolved.q, resolvedBucket).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  function openRow(row) {
    const stage = String(row?.stage || "");
    const id = Number(row?.record_id || 0);
    if (!Number.isFinite(id) || id <= 0) return;
    if (String(row?.next_action || "") === "create_invoice") {
      const soId = Number(row?.sales_order_id || 0);
      if (Number.isFinite(soId) && soId > 0 && typeof onCreateInvoiceFromSalesOrder === "function") {
        onCreateInvoiceFromSalesOrder(soId, { dispatch_id: id, dispatch_number: row.record_number });
        return;
      }
    }
    if (stage === "quote" && typeof onOpenQuote === "function") onOpenQuote(id);
    if (stage === "sales_order" && typeof onOpenSalesOrder === "function") onOpenSalesOrder(id);
    if (stage === "dispatch" && typeof onOpenDispatch === "function") onOpenDispatch(id);
    if (stage === "invoice" && typeof onOpenInvoice === "function") onOpenInvoice(id);
  }

  async function convertQuoteFromDesk(quoteId) {
    const id = Number(quoteId);
    if (!Number.isFinite(id) || id <= 0) return;
    if (typeof onConvertQuoteToSalesOrder === "function") {
      await onConvertQuoteToSalesOrder(id);
      return;
    }
    setError("Convert to sales order is not wired in this shell.");
  }

  async function openQuoteApprovalDraft(quoteId, action) {
    const id = Number(quoteId);
    if (!Number.isFinite(id) || id <= 0) return;
    setApprovalBusyId(id);
    setError("");
    setNotice("");
    try {
      const status = await apiFetch(`/quotes/${id}/approval-status`);
      const approval = status?.approval || status;
      if (!approval?.can_actor_approve) {
        setError("You are not the current approver for this quote. Open the quote for details.");
        return;
      }
      const quoteRow = rows.find((r) => Number(r.record_id) === id) || { record_id: id };
      const draft = buildQuoteApprovalDraft({ quoteRow, approval, action });
      if (!draft) {
        setError("Could not draft this quote approval action.");
        return;
      }
      setQuoteDraft(draft);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load quote approval context."));
    } finally {
      setApprovalBusyId(null);
    }
  }

  async function confirmQuoteApprovalDraft(_data, working) {
    const id = Number(working?.payload?.quote_id);
    const action = working?.payload?.action;
    setQuoteDraft(null);
    setNotice(action === "reject" ? `Quote #${id} rejected.` : `Quote #${id} approved.`);
    await refresh(query, "quotes_submitted");
  }

  function approveQuoteFromDesk(quoteId) {
    openQuoteApprovalDraft(quoteId, "approve");
  }

  function rejectQuoteFromDesk(quoteId) {
    openQuoteApprovalDraft(quoteId, "reject");
  }

  return (
    <div style={{ maxWidth: 1320 }}>
      <DeskTopStrip
        title="Sales Desk"
        actions={
          <>
            <button
              type="button"
              style={deskButtonStyle({ tone: "primary", disabled: summaryLoading || queueLoading })}
              onClick={() => refresh().catch(() => {})}
              disabled={summaryLoading || queueLoading}
            >
              {summaryLoading || queueLoading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              type="button"
              style={deskButtonStyle({ tone: "accent", active: bucket === "quotes_unconverted", disabled: queueLoading })}
              onClick={() => {
                setBucket("quotes_unconverted");
                refresh(query, "quotes_unconverted").catch(() => {});
              }}
              disabled={queueLoading}
            >
              Quotes unconverted
            </button>
            <button
              type="button"
              style={deskButtonStyle({ tone: "accent", active: bucket === "quotes_submitted", disabled: queueLoading })}
              onClick={() => {
                setBucket("quotes_submitted");
                refresh(query, "quotes_submitted").catch(() => {});
              }}
              disabled={queueLoading}
            >
              Pending approval
            </button>
          </>
        }
        metrics={topMetrics}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      {quoteDraft ? (
        <div style={{ marginTop: 12, marginBottom: 4 }}>
          <ConfirmDraftCard
            draft={quoteDraft}
            editableRemarks
            onCancel={() => setQuoteDraft(null)}
            onConfirmed={confirmQuoteApprovalDraft}
            onError={(e) => setError(getApiErrorMessage(e, "Failed to confirm quote approval."))}
          />
        </div>
      ) : null}

      {funnel.length ? (
        <div
          style={{
            marginTop: 14,
            border: "1px solid #dfe5ef",
            borderRadius: 16,
            padding: "12px 14px",
            background: "linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%)",
            display: "grid",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.58, fontWeight: 800 }}>Company funnel</div>
          <div style={{ display: "grid", gap: 8 }}>
            {funnel.map((company) => (
              <div key={company.company_id} style={{ display: "grid", gridTemplateColumns: "88px repeat(4, minmax(0, 1fr))", gap: 8, alignItems: "center" }}>
                <strong style={{ fontSize: 13 }}>{company.company_code || company.company_name}</strong>
                {[
                  ["Lead", company.lead],
                  ["Quote", company.quote],
                  ["SO", company.sales_order],
                  ["Invoice", company.invoice],
                ].map(([label, stage]) => (
                  <div key={label} style={{ border: "1px solid #e6ebf3", borderRadius: 10, padding: "8px 10px", background: "#fff" }}>
                    <div style={{ fontSize: 11, opacity: 0.58 }}>{label}</div>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>{stage?.count ?? 0}</div>
                    <div style={{ fontSize: 11, opacity: 0.68 }}>med {stage?.median_age_days == null ? "—" : `${stage.median_age_days}d`}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 0.42fr)", gap: 14, alignItems: "start" }}>
        <DeskCard
          title="Sales Queue"
          subtitle="Start from draft quotes, approvals, and conversions before moving downstream."
          actions={
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadQueue(query, bucket).catch(() => {});
                }}
                placeholder="Search number or customer"
                style={deskSearchInputStyle()}
              />
              <button
                type="button"
                style={deskButtonStyle({ tone: "primary", disabled: queueLoading })}
                onClick={() => loadQueue(query, bucket).catch(() => {})}
                disabled={queueLoading}
              >
                {queueLoading ? "Loading..." : "Load"}
              </button>
            </div>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {BUCKETS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                style={deskButtonStyle({ tone: "accent", active: value === bucket, disabled: queueLoading })}
                onClick={() => {
                  setBucket(value);
                  loadQueue(query, value).catch(() => {});
                }}
                disabled={queueLoading}
              >
                {label}
              </button>
            ))}
          </div>

          {listMeta?.capped ? (
            <ListCapBanner
              shown={rows.length}
              total={listMeta?.total_count ?? null}
              cap={listMeta?.limit || 80}
              entityLabel="queue rows"
            />
          ) : listMeta?.message || listMeta?.honesty ? (
            <NoticeBanner tone="info" message={listMeta.message || listMeta.honesty} />
          ) : null}

          {queueLoading ? (
            <div>Loading queue…</div>
          ) : rows.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map((row) => {
                const stageMeta = stageAppearance(row.stage);
                const statusMeta = statusAppearance(row.record_status);
                const amount = num(row.amount);
                const secondaryAmount = num(row.secondary_amount);
                const showOutstanding = String(bucket) === "invoice_outstanding" && secondaryAmount > 0;
                const isApprovalQueue = String(bucket) === "quotes_submitted" && String(row.stage || "") === "quote";
                const isUnconvertedQueue = String(bucket) === "quotes_unconverted" && String(row.stage || "") === "quote";
                const isBillQueue = String(bucket) === "dispatch_not_invoiced" || String(row?.next_action || "") === "create_invoice";
                const busy = approvalBusyId === Number(row.record_id);
                const canApproveQuote = canScreenAction(me, "quotes", "can_approve");
                const canConvertQuote = canScreenAction(me, "sales_orders", "can_create");
                const canCreateInvoice = canScreenAction(me, "invoices", "can_create");

                if (isApprovalQueue || isUnconvertedQueue || isBillQueue) {
                  return (
                    <div key={`${row.stage}:${row.record_id}`} style={queueRowButtonStyle()}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 900, fontSize: 16 }}>{row.record_number || "—"}</div>
                          <div style={{ fontSize: 12, opacity: 0.74 }}>{row.customer_name || "—"}</div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                          <DeskChip label={stageLabel(row.stage)} tone={stageMeta.tone} color={stageMeta.color} />
                          <DeskChip label={String(row.record_status || "—")} tone={statusMeta.tone} color={statusMeta.color} />
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                        <MiniMetric label="Amount" value={amount > 0 ? money(amount) : "—"} />
                        <MiniMetric
                          label="Updated"
                          value={row.updated_at ? String(row.updated_at).slice(0, 10) : "—"}
                        />
                        <MiniMetric
                          label="Signal"
                          value={
                            isApprovalQueue
                              ? "Pending approval"
                              : isUnconvertedQueue
                                ? "Convert to SO"
                                : "Create invoice"
                          }
                        />
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                        {isApprovalQueue ? (
                          <>
                            <button type="button" disabled={busy || Boolean(quoteDraft) || !canApproveQuote} onClick={() => approveQuoteFromDesk(row.record_id)}>
                              {busy ? "Working…" : canApproveQuote ? "Approve" : "No approve right"}
                            </button>
                            <button type="button" disabled={busy || Boolean(quoteDraft) || !canApproveQuote} onClick={() => rejectQuoteFromDesk(row.record_id)}>
                              Reject
                            </button>
                            <button type="button" className="button-ghost" disabled={busy} onClick={() => openRow(row)}>
                              Open quote
                            </button>
                          </>
                        ) : null}
                        {isUnconvertedQueue ? (
                          <>
                            <button type="button" disabled={busy || !canConvertQuote} onClick={() => convertQuoteFromDesk(row.record_id)}>
                              {canConvertQuote ? "Convert to SO" : "No convert right"}
                            </button>
                            <button type="button" className="button-ghost" disabled={busy} onClick={() => openRow(row)}>
                              Open quote
                            </button>
                          </>
                        ) : null}
                        {isBillQueue ? (
                          <>
                            <button type="button" disabled={busy || !canCreateInvoice} onClick={() => openRow(row)}>
                              {canCreateInvoice ? "Create invoice" : "No invoice right"}
                            </button>
                            <button
                              type="button"
                              className="button-ghost"
                              disabled={busy}
                              onClick={() => typeof onOpenDispatch === "function" && onOpenDispatch(row.record_id)}
                            >
                              Open dispatch
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                }

                return (
                  <button
                    key={`${row.stage}:${row.record_id}`}
                    type="button"
                    onClick={() => openRow(row)}
                    style={queueRowButtonStyle()}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 900, fontSize: 16 }}>{row.record_number || "—"}</div>
                        <div style={{ fontSize: 12, opacity: 0.74 }}>{row.customer_name || "—"}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                        <DeskChip label={stageLabel(row.stage)} tone={stageMeta.tone} color={stageMeta.color} />
                        <DeskChip label={String(row.record_status || "—")} tone={statusMeta.tone} color={statusMeta.color} />
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Amount" value={amount > 0 ? money(amount) : "—"} />
                      <MiniMetric
                        label={bucket === "quotes_issued_aging" ? "Age" : "Updated"}
                        value={
                          bucket === "quotes_issued_aging"
                            ? `${Number(row.age_days || 0)}d`
                            : row.updated_at
                              ? String(row.updated_at).slice(0, 10)
                              : "—"
                        }
                      />
                      <MiniMetric
                        label={showOutstanding ? "Outstanding" : bucket === "quotes_issued_aging" ? "Owner" : "Signal"}
                        value={
                          showOutstanding
                            ? money(secondaryAmount)
                            : bucket === "quotes_issued_aging"
                              ? row.owner_name || "—"
                              : bucket.replaceAll("_", " ")
                        }
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState title="Queue empty" body="No rows in this bucket. Switch buckets or refresh to continue." />
          )}
        </DeskCard>

        <DeskCard title="Sales Priorities" subtitle="Keep the desk focused on quote movement and downstream gaps.">
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              <DeskStat label="Confirmed SO" value={String(summary?.sales_orders?.confirmed ?? 0)} tone="#234a8f" />
              <DeskStat label="Ready dispatch" value={String(summary?.dispatches?.ready ?? 0)} tone="#8b5a00" />
            </div>
            {summary?.leads ? (
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>Lead strip</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                  <DeskStat label="Open leads" value={String(summary.leads.open ?? 0)} tone="#234a8f" />
                  <DeskStat label="Due today" value={String(summary.leads.due_today ?? 0)} tone="#8b5a00" />
                  <DeskStat label="Overdue" value={String(summary.leads.overdue ?? 0)} tone="#9f2042" />
                  <DeskStat label="SLA breached" value={String(summary.leads.sla_breached ?? 0)} tone="#9f2042" />
                </div>
              </div>
            ) : null}
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>
                Manager coverage {coverageScope ? `(${coverageScope})` : ""}
              </div>
              {coverage.length ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {coverage.map((row) => (
                    <div key={row.assignee_user_id} style={{ border: "1px solid #e6ebf3", borderRadius: 12, padding: 10, background: "#fff" }}>
                      <div style={{ fontWeight: 800, fontSize: 13 }}>{row.assignee_name}</div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>
                        Approvals {row.pending_approvals} · Issued open {row.unconverted_issued} · SO no dispatch {row.confirmed_no_dispatch}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, opacity: 0.68 }}>No coverage gaps for the current team scope.</div>
              )}
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              <FieldLabel label="Quote-first actions">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={deskButtonStyle({ tone: "accent", active: bucket === "quotes_draft", disabled: queueLoading })}
                    onClick={() => {
                      setBucket("quotes_draft");
                      loadQueue(query, "quotes_draft").catch(() => {});
                    }}
                    disabled={queueLoading}
                  >
                    Draft quotes
                  </button>
                  <button
                    type="button"
                    style={deskButtonStyle({ tone: "accent", active: bucket === "quotes_submitted", disabled: queueLoading })}
                    onClick={() => {
                      setBucket("quotes_submitted");
                      loadQueue(query, "quotes_submitted").catch(() => {});
                    }}
                    disabled={queueLoading}
                  >
                    Pending approval
                  </button>
                  <button
                    type="button"
                    style={deskButtonStyle({ tone: "accent", active: bucket === "quotes_unconverted", disabled: queueLoading })}
                    onClick={() => {
                      setBucket("quotes_unconverted");
                      loadQueue(query, "quotes_unconverted").catch(() => {});
                    }}
                    disabled={queueLoading}
                  >
                    Unconverted quotes
                  </button>
                </div>
              </FieldLabel>
              <FieldLabel label="Downstream actions">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={deskButtonStyle({ tone: "accent", active: bucket === "dispatch_not_invoiced", disabled: queueLoading })}
                    onClick={() => {
                      setBucket("dispatch_not_invoiced");
                      loadQueue(query, "dispatch_not_invoiced").catch(() => {});
                    }}
                    disabled={queueLoading}
                  >
                    Dispatch not invoiced
                  </button>
                  <button
                    type="button"
                    style={deskButtonStyle({ tone: "accent", active: bucket === "invoice_outstanding", disabled: queueLoading })}
                    onClick={() => {
                      setBucket("invoice_outstanding");
                      loadQueue(query, "invoice_outstanding").catch(() => {});
                    }}
                    disabled={queueLoading}
                  >
                    Outstanding invoices
                  </button>
                </div>
              </FieldLabel>
            </div>
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
