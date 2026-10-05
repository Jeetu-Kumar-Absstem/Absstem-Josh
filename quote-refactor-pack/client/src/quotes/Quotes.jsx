import { useEffect, useMemo, useState } from "react";
import SmartQuoteBuilder from "./SmartQuoteBuilder";
import { DeskCard, DeskChip, DeskStat, EmptyState, toast } from "../shared/joshUi";
import QuoteReport from "./QuoteReport";
import QuoteWorkspace from "./QuoteWorkspace";
import QuoteDetail from "./QuoteDetailPanel";
import {
  apiFetch,
  formatAmount,
  formatDayAge,
  getApiErrorMessage,
  statusColor,
  statusTone,
} from "./quoteShared";
import { useGlobalTimeline } from "../timeline/GlobalTimelineContext";
import { appendTimelineParams } from "../timeline/globalTimeline";

function actionButtonStyle({ primary = false, disabled = false } = {}) {
  return {
    borderRadius: 999,
    border: `1px solid ${primary ? "#2354d5" : "#d8e0ef"}`,
    background: disabled ? "#eef2f8" : primary ? "#2354d5" : "#ffffff",
    color: disabled ? "#8a96ab" : primary ? "#ffffff" : "#1f3556",
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

export default function Quotes({ openQuoteId, launch, onConsumeLaunch, me, mailConnectStatus, mailConnectReason, onOpenSalesOrder, onOpenLead, onOpenProforma }) {
  const timeline = useGlobalTimeline();
  const [view, setView] = useState({ type: "list" });
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [quotes, setQuotes] = useState([]);
  const [listQuery, setListQuery] = useState("");
  const [listStatus, setListStatus] = useState("");
  const [listBucket, setListBucket] = useState("");
  const [rowActionBusy, setRowActionBusy] = useState({});
  const [actionNotice, setActionNotice] = useState(null);
  const [lastActionQuoteId, setLastActionQuoteId] = useState(null);
  const [closeTarget, setCloseTarget] = useState(null);
  const [closeReasonId, setCloseReasonId] = useState("");
  const [closeRemarks, setCloseRemarks] = useState("");
  const [closeCustomerPo, setCloseCustomerPo] = useState("");
  const [closeBusy, setCloseBusy] = useState(false);
  const [closureReasons, setClosureReasons] = useState([]);

  useEffect(() => {
    apiFetch("/quotes/bootstrap")
      .then((data) => setClosureReasons(Array.isArray(data?.quote_closure_reasons) ? data.quote_closure_reasons : []))
      .catch(() => setClosureReasons([]));
  }, []);

  const quoteStats = useMemo(() => {
    const total = quotes.length;
    const draft = quotes.filter((q) => String(q.quote_status || "").toLowerCase().includes("draft")).length;
    const issued = quotes.filter((q) => {
      const s = String(q.quote_status || "").toLowerCase();
      return s.includes("issued") || s.includes("sent");
    }).length;
    const approved = quotes.filter((q) => String(q.quote_status || "").toLowerCase().includes("approved")).length;
    return { total, draft, issued, approved };
  }, [quotes]);

  function openGuidedQuote(quoteRoute = "industrial", launchSeed = null) {
    setView({
      type: "new",
      launchSeed: {
        ...(launchSeed && typeof launchSeed === "object" ? launchSeed : {}),
        quote_route: quoteRoute,
      },
    });
  }

  async function loadList(overrides = {}) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : listQuery;
      const status = overrides.status !== undefined ? overrides.status : listStatus;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : listBucket;
      if (qText) params.set("q", qText);
      if (status) params.set("status", status);
      if (bucket) params.set("bucket", bucket);
      appendTimelineParams(params, timeline);
      const data = await apiFetch(`/quotes${params.toString() ? `?${params.toString()}` : ""}`);
      const nextQuotes = Array.isArray(data?.quotes) ? data.quotes : [];
      setQuotes(nextQuotes);
      return nextQuotes;
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to load quotes.");
      return [];
    } finally {
      setLoading(false);
    }
  }

  function openQuoteWorkspace(quote, stageOverride = "") {
    if (!quote?.id) return;
    const status = String(quote.quote_status || quote.revision_status || "").toLowerCase();
    const stage = stageOverride || (status === "draft" || status.includes("draft") ? "build" : "govern");
    setView({ type: "workspace", id: quote.id, stage });
  }

  async function runRowAction(quote, action) {
    if (!quote?.id) return;
    if (action === "open" || action === "complete_quote" || action === "follow_up_customer") {
      openQuoteWorkspace(quote);
      return;
    }
    if (action === "review_approval") {
      openQuoteWorkspace(quote, "govern");
      return;
    }
    if (action === "close_quote") {
      setCloseTarget(quote);
      setCloseReasonId(closureReasons[0]?.id ? String(closureReasons[0].id) : "");
      setCloseRemarks("");
      setCloseCustomerPo("");
      return;
    }

    const busyKey = `${quote.id}:${action}`;
    setRowActionBusy((prev) => ({ ...prev, [busyKey]: true }));
    setError("");
    setActionNotice(null);
    try {
      if (action === "request_approval") {
        await apiFetch(`/quotes/${quote.id}/submit-approval`, { method: "POST" });
        const refreshedQuotes = await loadList();
        const stillVisible = refreshedQuotes.some((item) => Number(item.id) === Number(quote.id));
        setLastActionQuoteId(stillVisible ? Number(quote.id) : null);
        const noticeText = stillVisible
          ? `${quote.quote_number} was sent for approval and the queue is refreshed.`
          : `${quote.quote_number} was sent for approval and moved out of the current queue.`;
        setActionNotice({ tone: "success", text: noticeText });
        toast(noticeText, "success");
      } else if (action === "issue_quote") {
        await apiFetch(`/quotes/${quote.id}/issue`, { method: "POST" });
        const refreshedQuotes = await loadList();
        const nextVersion = refreshedQuotes.find((item) => Number(item.id) === Number(quote.id));
        const stillVisible = Boolean(nextVersion);
        setLastActionQuoteId(stillVisible ? Number(quote.id) : null);
        setActionNotice({
          tone: "success",
          text: stillVisible
            ? `${quote.quote_number} was issued and the queue is showing the updated next step.`
            : `${quote.quote_number} was issued and moved out of the current queue.`,
        });
      } else if (action === "convert_to_so") {
        const data = await apiFetch(`/sales-orders/from-quote/${quote.id}`, { method: "POST" });
        const salesOrderId = Number(data?.sales_order?.id || 0);
        const salesOrderNumber = String(data?.sales_order?.so_number || "").trim();
        await loadList();
        setLastActionQuoteId(null);
        setActionNotice({
          tone: "success",
          text: `${quote.quote_number} was converted${salesOrderNumber ? ` to ${salesOrderNumber}` : " to a sales order"}. Opening the next desk.`,
        });
        if (salesOrderId > 0 && typeof onOpenSalesOrder === "function") {
          onOpenSalesOrder(salesOrderId);
        }
        return;
      }
    } catch (e) {
      setLastActionQuoteId(null);
      setError(getApiErrorMessage(e, "Could not complete the selected quote action."));
    } finally {
      setRowActionBusy((prev) => {
        const next = { ...prev };
        delete next[busyKey];
        return next;
      });
    }
  }

  async function submitCloseQuote() {
    if (!closeTarget?.id || !closeReasonId) return;
    setCloseBusy(true);
    setError("");
    try {
      await apiFetch(`/quotes/${closeTarget.id}/close`, {
        method: "POST",
        body: JSON.stringify({
          closure_reason_id: Number(closeReasonId),
          closure_remarks: closeRemarks,
          customer_po_ref: closeCustomerPo,
        }),
      });
      setCloseTarget(null);
      setCloseRemarks("");
      setCloseCustomerPo("");
      await loadList();
      setActionNotice({ tone: "success", text: `${closeTarget.quote_number} was closed.` });
      toast(`${closeTarget.quote_number} closed`, "success");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to close quote."));
    } finally {
      setCloseBusy(false);
    }
  }

  function getQuoteRowActions(quote) {
    const actions = [{ key: "open", label: "Open", primary: false }];
    if (quote?.can_request_approval) actions.push({ key: "request_approval", label: "Send for approval", primary: true });
    if (quote?.recommended_action === "issue_quote") actions.push({ key: "issue_quote", label: "Issue PDF", primary: true });
    if (quote?.is_convertible) actions.push({ key: "convert_to_so", label: "Convert to SO", primary: true });
    if (quote?.can_close) actions.push({ key: "close_quote", label: "Close", primary: false });
    if (quote?.recommended_action === "follow_up_customer" || Number(quote?.customer_overdue_amount || 0) > 0) {
      actions.push({ key: "follow_up_customer", label: "Follow up", primary: false });
    }
    if (quote?.recommended_action === "review_approval") {
      actions.push({ key: "review_approval", label: "Review approval", primary: true });
    }
    return actions.filter((action, index, arr) => arr.findIndex((item) => item.key === action.key) === index);
  }

  useEffect(() => {
    if (view.type === "list") loadList();
  }, [view.type, timeline.revision, timeline.date_from, timeline.date_to, timeline.preset]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const builderQuoteId = Number(launch.builder_quote_id);
    if (Number.isFinite(builderQuoteId) && builderQuoteId > 0) {
      setView({ type: "workspace", id: builderQuoteId, stage: "build" });
      if (typeof onConsumeLaunch === "function") onConsumeLaunch();
      return;
    }
    if (String(launch.mode || "").trim().toLowerCase() === "aftermarket_service") {
      openGuidedQuote(String(launch.quote_route || "").trim().toLowerCase() === "healthcare" ? "healthcare" : "industrial", launch);
      if (typeof onConsumeLaunch === "function") onConsumeLaunch();
      return;
    }
    const nextQuery = typeof launch.q === "string" ? launch.q : "";
    const nextStatus = typeof launch.status === "string" ? launch.status : "";
    const nextBucket = typeof launch.bucket === "string" ? launch.bucket : "";
    setListQuery(nextQuery);
    setListStatus(nextStatus);
    setListBucket(nextBucket);
    if (view.type !== "list") setView({ type: "list" });
    loadList({ q: nextQuery, status: nextStatus, bucket: nextBucket }).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    const id = Number(openQuoteId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "workspace", id, stage: "govern" });
  }, [openQuoteId]);

  const returnToQueue = () => {
    setView({ type: "list" });
    loadList().catch(() => {});
  };

  if (view.type === "new") {
    return (
      <SmartQuoteBuilder
        onCancel={() => setView({ type: "list" })}
        onOpenDetail={(id) => setView({ type: "workspace", id, stage: "govern" })}
        onOpenSalesOrder={onOpenSalesOrder}
        me={me}
        initialLaunch={view.launchSeed || null}
      />
    );
  }

  if (view.type === "workspace") {
    const stage = view.stage === "govern" ? "govern" : "build";
    return (
      <QuoteWorkspace
        quoteId={view.id}
        stage={stage}
        refreshKey={workspaceRefreshKey}
        onStageChange={(nextStage) => setView({ type: "workspace", id: view.id, stage: nextStage })}
        onBackToList={returnToQueue}
      >
        {stage === "build" ? (
          <SmartQuoteBuilder
            key={`quote-builder-${view.id}`}
            onCancel={returnToQueue}
            onOpenDetail={() => setView({ type: "workspace", id: view.id, stage: "govern" })}
            onOpenSalesOrder={onOpenSalesOrder}
            onOpenLead={onOpenLead}
            onQuoteChanged={() => setWorkspaceRefreshKey((prev) => prev + 1)}
            me={me}
            initialQuoteId={view.id}
          />
        ) : (
          <QuoteDetail
            key={`quote-detail-${view.id}`}
            id={view.id}
            embedded
            onBack={returnToQueue}
            onOpenBuilder={() => setView({ type: "workspace", id: view.id, stage: "build" })}
            onOpenSalesOrder={onOpenSalesOrder}
            onOpenLead={onOpenLead}
            onOpenProforma={onOpenProforma}
            onQuoteChanged={() => setWorkspaceRefreshKey((prev) => prev + 1)}
            me={me}
            mailConnectStatus={mailConnectStatus}
            mailConnectReason={mailConnectReason}
          />
        )}
      </QuoteWorkspace>
    );
  }

  if (view.type === "report") {
    return <QuoteReport onBack={() => setView({ type: "list" })} />;
  }

  return (
    <div style={{ maxWidth: 1460 }}>
      <div
        style={{
          border: "1px solid #dde5f1",
          borderRadius: 24,
          padding: 20,
          background: "linear-gradient(135deg, #f7fafc 0%, #ffffff 42%, #eef4ff 100%)",
          boxShadow: "0 20px 45px rgba(28, 45, 74, 0.08)",
        }}
      >
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.56, marginBottom: 8 }}>
              Quote Queue Desk
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>Quotes</h2>
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth: 760, lineHeight: 1.7 }}>
              Run quotes from one queue-first desk: launch the right Autopilot route, resume live drafts, and move into detailed commercial control only when needed.
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder="Search quote / customer"
              style={{ minWidth: 220 }}
            />
            <select value={listStatus} onChange={(e) => setListStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="approved">Approved</option>
              <option value="issued">Issued</option>
              <option value="sent">Sent</option>
              <option value="lapsed">Lapsed</option>
              <option value="converted">Converted</option>
              <option value="closed">Closed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select value={listBucket} onChange={(e) => setListBucket(e.target.value)}>
              <option value="">All buckets</option>
              <option value="unconverted">Approved not converted</option>
            </select>
            <button onClick={loadList} disabled={loading}>{loading ? "Refreshing..." : "Refresh Queue"}</button>
            <button className="button-primary" onClick={() => openGuidedQuote("industrial")}>New quote</button>
            <button onClick={() => setView({ type: "report" })}>Open Quote Report</button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 12, marginTop: 18 }}>
          <DeskStat label="Quotes In View" value={quoteStats.total} tone="#143d7a" />
          <DeskStat label="Draft / Working" value={quoteStats.draft} tone="#8b5a00" />
          <DeskStat label="Approved" value={quoteStats.approved} tone="#0a7a35" />
          <DeskStat label="Issued / Sent" value={quoteStats.issued} tone="#7a1637" />
        </div>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>{error}</div> : null}
      {actionNotice ? (
        <div
          style={{
            color: actionNotice.tone === "success" ? "#0b6b38" : "#1f3556",
            marginTop: 12,
            padding: "12px 14px",
            borderRadius: 14,
            background: actionNotice.tone === "success" ? "#f2fbf5" : "#eef4ff",
            border: `1px solid ${actionNotice.tone === "success" ? "#cfe7d6" : "#cfdcf7"}`,
          }}
        >
          {actionNotice.text}
        </div>
      ) : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 0.92fr) minmax(360px, 0.72fr)", gap: 18, alignItems: "start" }}>
        <DeskCard title="Quote Queue" subtitle="Resume drafts in the builder; open detail for issue, mail, and conversion">
          <div style={{ display: "grid", gap: 8, maxHeight: 980, overflowY: "auto", paddingRight: 4 }}>
            {loading ? (
              <div>Loading quotes…</div>
            ) : quotes.length ? (
              quotes.map((q) => (
                <button
                  key={q.id}
                  onClick={() => openQuoteWorkspace(q)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: Number(lastActionQuoteId) === Number(q.id) ? "1px solid #9bb7f5" : "1px solid #e7ebf3",
                    borderRadius: 14,
                    padding: "10px 12px",
                    background: Number(lastActionQuoteId) === Number(q.id) ? "#f7faff" : "#ffffff",
                    boxShadow:
                      Number(lastActionQuoteId) === Number(q.id)
                        ? "0 10px 24px rgba(35, 84, 213, 0.12)"
                        : "0 6px 18px rgba(26, 35, 53, 0.04)",
                    display: "grid",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>
                        {q.distributor_name || "Direct / Internal"}
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{q.quote_number}</div>
                    </div>
                    <DeskChip label={String(q.quote_status || "draft").replaceAll("_", " ").toUpperCase()} tone={statusTone(q.quote_status)} color={statusColor(q.quote_status)} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{q.customer_name}</div>
                    <div style={{ fontSize: 12, color: "#4b5c7a", marginTop: 6, lineHeight: 1.5 }}>
                      {q.pending_reason || "Review the quote and move it to the next sales step."}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <DeskChip label={q.distributor_name || "No distributor"} tone="#f6f7fb" color="#58627a" />
                    <DeskChip label={String(q.quote_status || "").toLowerCase().includes("draft") ? "Resume draft" : "Open control"} tone="#eef4ff" color="#2354d5" />
                    {Number(q.stale_days) >= 3 ? <DeskChip label={`Stale ${Number(q.stale_days)}d`} tone="#fff4e4" color="#9a5f00" /> : null}
                    {Number(q.customer_overdue_amount || 0) > 0 ? (
                      <DeskChip label={`Overdue ${formatAmount(q.customer_overdue_amount)}`} tone="#fff2f2" color="#b22727" />
                    ) : null}
                    {q.recommended_action_label ? (
                      <DeskChip
                        label={q.recommended_action_label}
                        tone={q.attention_level === "high" ? "#eef4ff" : q.attention_level === "medium" ? "#fff7e8" : "#f3f8f3"}
                        color={q.attention_level === "high" ? "#1f4bb7" : q.attention_level === "medium" ? "#9a5f00" : "#1a6b37"}
                      />
                    ) : null}
                    {(Array.isArray(q.triggering_lines) ? q.triggering_lines : []).slice(0, 3).map((line) => (
                      <DeskChip
                        key={line.line_id || `${line.line_no}-${line.item_name}`}
                        label={`#${line.line_no} ${line.item_name} · ${Number(line.discount_pct || 0).toFixed(1)}%`}
                        tone="#fff7e8"
                        color="#9a5a00"
                      />
                    ))}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                      gap: 8,
                      padding: 10,
                      borderRadius: 14,
                      background: "#f8fbff",
                      border: "1px solid #e6eef8",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.56 }}>Quote value</div>
                      <div style={{ marginTop: 4, fontWeight: 700 }}>{formatAmount(q.grand_total_quote)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.56 }}>Queue age</div>
                      <div style={{ marginTop: 4, fontWeight: 700 }}>{formatDayAge(q.stale_days)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.56 }}>Next step</div>
                      <div style={{ marginTop: 4, fontWeight: 700 }}>{q.recommended_action_label || "Resume flow"}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {getQuoteRowActions(q).map((action) => {
                      const busyKey = `${q.id}:${action.key}`;
                      const busy = Boolean(rowActionBusy[busyKey]);
                      return (
                        <button
                          key={action.key}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            runRowAction(q, action.key);
                          }}
                          disabled={busy}
                          style={actionButtonStyle({ primary: action.primary, disabled: busy })}
                        >
                          {busy ? "Working..." : action.label}
                        </button>
                      );
                    })}
                  </div>
                </button>
              ))
            ) : (
              <EmptyState
                title="No quotes in this queue"
                body="Start with New quote above, or use the launch rail for industrial / healthcare Autopilot."
                action={
                  <button type="button" className="button-primary" onClick={() => openGuidedQuote("industrial")}>
                    New industrial quote
                  </button>
                }
              />
            )}
          </div>
        </DeskCard>

        <div style={{ position: "sticky", top: 12 }}>
          <DeskCard title="Launch Rail" subtitle="Use one guided sales flow for customer, package, commercial setup, and send">
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ padding: 14, borderRadius: 16, border: "1px solid #e7ebf3", background: "#fcfdff" }}>
                <div style={{ fontWeight: 800 }}>Autopilot Standard</div>
                <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6, marginTop: 8 }}>
                  This desk launches the same guided builder in two clear routes: industrial by default, healthcare only when framing and letterhead must switch.
                </div>
              </div>
              <div style={{ padding: 14, borderRadius: 16, border: "1px solid #edf1f6", background: "#ffffff" }}>
                <div style={{ fontWeight: 800 }}>Industrial Autopilot</div>
                <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6, marginTop: 8 }}>
                  Default sales route for `nGEN`, `nGENX`, `IDOS`, and `IDOS C`. Keeps the builder focused on industrial PSA recommendations and domestic defaults.
                </div>
                <button style={{ marginTop: 12, width: "100%" }} onClick={() => openGuidedQuote("industrial")}>
                  New Industrial Quote
                </button>
              </div>
              <div style={{ padding: 14, borderRadius: 16, border: "1px solid #edf1f6", background: "#ffffff" }}>
                <div style={{ fontWeight: 800 }}>Healthcare Route</div>
                <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6, marginTop: 8 }}>
                  Use only when the quote must follow healthcare framing and healthcare letterhead. Keeps medical presentation separate from the industrial default path.
                </div>
                <button style={{ marginTop: 12, width: "100%" }} onClick={() => openGuidedQuote("healthcare")}>
                  New Healthcare Quote
                </button>
              </div>
              <div style={{ padding: 14, borderRadius: 16, border: "1px solid #edf1f6", background: "#ffffff" }}>
                <div style={{ fontWeight: 800 }}>Desk Role</div>
                <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6, marginTop: 8 }}>
                  This desk now owns queue, launch, resume, and report access. The guided builder handles actual quote creation, while detail stays for deep control and audit follow-through.
                </div>
              </div>
            </div>
          </DeskCard>
        </div>
      </div>
      {closeTarget ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(17, 28, 49, 0.42)",
            display: "grid",
            placeItems: "center",
            zIndex: 40,
            padding: 16,
          }}
        >
          <div style={{ width: "min(440px, 100%)", background: "#fff", borderRadius: 16, padding: 18, boxShadow: "0 24px 48px rgba(17,28,49,0.22)" }}>
            <div style={{ fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.55 }}>Close Quote</div>
            <h3 style={{ margin: "6px 0 12px" }}>{closeTarget.quote_number}</h3>
            <label style={{ display: "grid", gap: 6, fontSize: 13, marginBottom: 12 }}>
              Closure reason
              <select value={closeReasonId} onChange={(e) => setCloseReasonId(e.target.value)} style={{ minHeight: 38 }}>
                <option value="">Select reason</option>
                {closureReasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.outcome_kind === "won" ? "Won · " : ""}
                    {reason.reason_name}
                  </option>
                ))}
              </select>
            </label>
            {closureReasons.find((reason) => String(reason.id) === String(closeReasonId))?.outcome_kind === "won" ? (
              <label style={{ display: "grid", gap: 6, fontSize: 13, marginBottom: 12 }}>
                Customer PO
                <input value={closeCustomerPo} onChange={(e) => setCloseCustomerPo(e.target.value)} placeholder="Customer PO number" />
              </label>
            ) : null}
            <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
              Remarks (optional)
              <textarea value={closeRemarks} onChange={(e) => setCloseRemarks(e.target.value)} rows={4} style={{ width: "100%", resize: "vertical" }} />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <button type="button" onClick={() => setCloseTarget(null)} disabled={closeBusy}>
                Cancel
              </button>
              <button type="button" className="button-primary" onClick={submitCloseQuote} disabled={closeBusy || !closeReasonId}>
                {closeBusy ? "Closing…" : "Close Quote"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
