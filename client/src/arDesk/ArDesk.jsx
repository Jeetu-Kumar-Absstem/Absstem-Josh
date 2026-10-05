import { useEffect, useMemo, useState } from "react";
import ConfirmDraftCard from "../components/ConfirmDraftCard";
import CreditReleasePanel from "../shared/CreditReleasePanel";
import { buildArCollectionDraft } from "../shared/aiDrafts";
import { DeskCard, DeskChip, DeskTopStrip, MiniMetric, NoticeBanner, getDeskStatusAppearance } from "../shared/joshUi";

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

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["posted", "resolved", "approved", "closed"],
    info: ["open", "requested", "scheduled"],
    warning: ["draft", "escalated"],
    danger: ["cancelled", "rejected"],
    fallbackTone: "#f6f7fb",
  });
}

function attentionAppearance(level) {
  if (level === "high") return { tone: "#fff1f1", color: "#a43f3f" };
  if (level === "medium") return { tone: "#fff7ea", color: "#8b5a00" };
  return { tone: "#eef7ef", color: "#1d6b3a" };
}

const PANELS = [
  { key: "credit_control", label: "Credit control" },
  { key: "followups", label: "Follow-ups" },
  { key: "promises", label: "Promises" },
  { key: "disputes", label: "Disputes" },
  { key: "adjustments", label: "Adjustments" },
  { key: "credit_notes", label: "Credit notes" },
  { key: "reconciliation", label: "Reconciliation" },
];

const FOLLOWUP_BUCKETS = [
  ["overdue", "Overdue"],
  ["due_today", "Due today"],
  ["no_date", "Missing date"],
  ["dunning_overdue", "Dunning overdue"],
  ["dunning_due_today", "Dunning due today"],
  ["dunning_unset", "Dunning unset"],
  ["all", "All"],
];

const PROMISE_BUCKETS = [
  ["overdue", "Broken / overdue"],
  ["due_today", "Due today"],
  ["future", "Future"],
  ["all", "All"],
];

const DISPUTE_STATUS = [
  ["open", "Open"],
  ["escalated", "Escalated"],
  ["resolved", "Resolved"],
  ["all", "All"],
];

const ADJUSTMENT_STATUS = [
  ["draft", "Draft"],
  ["posted", "Posted"],
  ["cancelled", "Cancelled"],
  ["all", "All"],
];

const ADJUSTMENT_TYPES = [
  ["all", "All types"],
  ["commercial_credit_note", "Commercial credit note"],
  ["short_payment_adjustment", "Short-pay adjustment"],
  ["write_off", "Write-off"],
];

const CREDIT_BUCKETS = [
  ["over_limit", "Over limit"],
  ["overdue", "Overdue"],
  ["hold", "Manual hold"],
  ["release_requested", "Release requested"],
  ["dispatch_blocked", "Dispatch blocked"],
  ["active_release", "Active releases"],
  ["all", "All"],
];

const RECON_BUCKETS = [
  ["matching_gap", "Matching gap"],
  ["unapplied_cash", "Unapplied cash"],
  ["partial_settlement", "Partial settlement"],
  ["old_unapplied", "Old unapplied cash"],
  ["balance_disagreement", "Balance disagreement"],
  ["all", "All"],
];

function normalizeLaunch(value) {
  if (!value || typeof value !== "object") return null;
  const panel = typeof value.panel === "string" ? value.panel : "";
  const bucket = typeof value.bucket === "string" ? value.bucket : "";
  const q = typeof value.q === "string" ? value.q : "";
  return { panel, bucket, q };
}

export default function ArDesk({
  launch = null,
  onConsumeLaunch = null,
  onOpenInvoice = null,
  onOpenSalesReturn = null,
  onOpenReceipts = null,
  onOpenCreditRelease = null,
  onOpenCustomerInvoices = null,
} = {}) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [actionSavingCustomerId, setActionSavingCustomerId] = useState(null);
  const [actionDrafts, setActionDrafts] = useState({});
  const [collectionDraft, setCollectionDraft] = useState(null);

  const [collectionsSummary, setCollectionsSummary] = useState(null);
  const [creditSummary, setCreditSummary] = useState(null);
  const [reconSummary, setReconSummary] = useState(null);

  const [panel, setPanel] = useState("credit_control");
  const [query, setQuery] = useState("");

  const [followupBucket, setFollowupBucket] = useState("overdue");
  const [promiseBucket, setPromiseBucket] = useState("overdue");
  const [disputeStatus, setDisputeStatus] = useState("open");
  const [adjustmentStatus, setAdjustmentStatus] = useState("draft");
  const [adjustmentType, setAdjustmentType] = useState("all");
  const [creditBucket, setCreditBucket] = useState("over_limit");
  const [openCreditCustomerId, setOpenCreditCustomerId] = useState(null);
  const [reconBucket, setReconBucket] = useState("matching_gap");

  const [rows, setRows] = useState([]);

  const topMetrics = useMemo(() => {
    return [
      {
        label: "Outstanding invoices",
        value: String(collectionsSummary?.invoices?.outstanding_count ?? 0),
        tone: "#234a8f",
        note: "Open follow-ups",
        onClick: () => {
          setPanel("followups");
          setFollowupBucket("all");
        },
      },
      {
        label: "Overdue invoices",
        value: String(collectionsSummary?.invoices?.overdue_count ?? 0),
        tone: "#8b5a00",
        note: "Open overdue queue",
        onClick: () => {
          setPanel("followups");
          setFollowupBucket("overdue");
        },
      },
      {
        label: "Follow-ups overdue",
        value: String(collectionsSummary?.followups?.overdue_count ?? 0),
        tone: "#9f2042",
        note: "Review collections",
        onClick: () => {
          setPanel("followups");
          setFollowupBucket("overdue");
        },
      },
      {
        label: "Credit holds",
        value: String(creditSummary?.credit_hold_count ?? 0),
        tone: "#5d4b8a",
        note: "Review credit control",
        onClick: () => {
          setPanel("credit_control");
          setCreditBucket("hold");
        },
      },
    ];
  }, [collectionsSummary, creditSummary]);

  async function loadSummary(nextQuery = query) {
    setSummaryLoading(true);
    setError("");
    try {
      const qp = nextQuery ? `?q=${encodeURIComponent(nextQuery)}` : "";
      const [collections, credit, recon] = await Promise.all([
        apiFetch(`/collections-desk/summary${qp}`),
        apiFetch(`/credit-control/summary${qp}`),
        apiFetch(`/reconciliation-desk/summary${qp}`),
      ]);
      if (collections?.ok) setCollectionsSummary(collections.summary || null);
      if (credit?.ok) setCreditSummary(credit.summary || null);
      if (recon?.ok) setReconSummary(recon.summary || null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load AR Desk summary."));
    } finally {
      setSummaryLoading(false);
    }
  }

  async function loadQueue(nextPanel = panel, nextQuery = query) {
    setQueueLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (nextQuery) params.set("q", nextQuery);
      params.set("limit", "200");

      let path = "";
      if (nextPanel === "followups") {
        path = "/collections-desk/followups";
        params.set("bucket", followupBucket);
      } else if (nextPanel === "promises") {
        path = "/collections-desk/promises";
        params.set("bucket", promiseBucket);
      } else if (nextPanel === "disputes") {
        path = "/collections-desk/disputes";
        params.set("status", disputeStatus);
      } else if (nextPanel === "adjustments") {
        path = "/collections-desk/adjustments";
        params.set("status", adjustmentStatus);
        params.set("type", adjustmentType);
      } else if (nextPanel === "credit_notes") {
        path = "/collections-desk/credit-notes";
      } else if (nextPanel === "credit_control") {
        path = "/credit-control/customers";
        params.set("bucket", creditBucket);
      } else if (nextPanel === "reconciliation") {
        path = "/reconciliation-desk/customers";
        params.set("bucket", reconBucket);
      } else {
        path = "/collections-desk/followups";
        params.set("bucket", followupBucket);
      }

      const data = await apiFetch(`${path}?${params.toString()}`);
      if (nextPanel === "followups") {
        if (data?.followups_ready === false) {
          setRows([]);
        } else {
          setRows(Array.isArray(data?.followups) ? data.followups : []);
        }
        return;
      }
      if (nextPanel === "promises") {
        if (data?.followups_ready === false) {
          setRows([]);
        } else {
          setRows(Array.isArray(data?.promises) ? data.promises : []);
        }
        return;
      }
      if (nextPanel === "disputes") {
        if (data?.disputes_ready === false) {
          setRows([]);
        } else {
          setRows(Array.isArray(data?.disputes) ? data.disputes : []);
        }
        return;
      }
      if (nextPanel === "adjustments") {
        if (data?.adjustments_ready === false) {
          setRows([]);
        } else {
          setRows(Array.isArray(data?.adjustments) ? data.adjustments : []);
        }
        return;
      }
      if (nextPanel === "credit_notes") {
        setRows(Array.isArray(data?.credit_notes) ? data.credit_notes : []);
        return;
      }
      if (nextPanel === "credit_control") {
        if (data?.ready === false) {
          setRows([]);
        } else {
          setRows(Array.isArray(data?.customers) ? data.customers : []);
        }
        return;
      }
      if (nextPanel === "reconciliation") {
        setRows(Array.isArray(data?.customers) ? data.customers : []);
        return;
      }
      setRows([]);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load AR Desk queue."));
      setRows([]);
    } finally {
      setQueueLoading(false);
    }
  }

  useEffect(() => {
    loadSummary().catch(() => {});
    loadQueue().catch(() => {});
  }, []);

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function getActionDraft(customerId, seed = {}) {
    const key = String(customerId);
    const existing = actionDrafts[key];
    if (existing) return existing;
    return {
      action_type: seed.action_type || "follow_up",
      expected_date: seed.expected_date || todayIso(),
      promised_amount: seed.promised_amount || "",
      remarks: seed.remarks || "",
      customer_invoice_id: seed.customer_invoice_id || "",
    };
  }

  function setActionDraft(customerId, patch) {
    const key = String(customerId);
    setActionDrafts((prev) => {
      const existing = prev[key] || {
        action_type: "follow_up",
        expected_date: todayIso(),
        promised_amount: "",
        remarks: "",
        customer_invoice_id: "",
      };
      return {
        ...prev,
        [key]: { ...existing, ...(patch && typeof patch === "object" ? patch : {}) },
      };
    });
  }

  function openCollectionDraft(row, mode = "follow_up", remarksOverride = null) {
    const draft = buildArCollectionDraft({ customer: row, mode, remarksOverride });
    if (!draft) {
      setError("Could not draft a collection action for this customer.");
      return;
    }
    setError("");
    setNotice("");
    setCollectionDraft(draft);
  }

  async function confirmCollectionDraft(data, workingDraft) {
    setCollectionDraft(null);
    const kind = workingDraft?.payload?.action_type;
    setNotice(kind === "promise_to_pay" ? "Promise logged." : "Follow-up logged.");
    await Promise.all([loadSummary(), loadQueue()]);
  }

  async function saveCollectionAction(customerId, override = null) {
    const draft = override || getActionDraft(customerId);
    if (!customerId) return;
    setActionSavingCustomerId(Number(customerId));
    setError("");
    setNotice("");
    try {
      await apiFetch(`/collections-desk/customers/${customerId}/actions`, {
        method: "POST",
        body: JSON.stringify({
          action_type: draft.action_type,
          expected_date: draft.expected_date || null,
          promised_amount: draft.action_type === "promise_to_pay" ? Number(draft.promised_amount || 0) : null,
          customer_invoice_id: draft.customer_invoice_id || null,
          remarks: draft.remarks || "",
        }),
      });
      setNotice(draft.action_type === "promise_to_pay" ? "Promise logged." : "Follow-up logged.");
      setActionDrafts((prev) => {
        const next = { ...(prev && typeof prev === "object" ? prev : {}) };
        delete next[String(customerId)];
        return next;
      });
      await Promise.all([loadSummary(), loadQueue()]);
    } catch (e) {
      if (e?.data?.error === "COLLECTION_ACTIONS_NOT_READY") setError("Collection actions are not ready on this database yet.");
      else if (e?.data?.error === "INVALID_PROMISED_AMOUNT") setError("Promised amount must be greater than 0.");
      else setError(getApiErrorMessage(e, "Failed to save collection action."));
    } finally {
      setActionSavingCustomerId(null);
    }
  }

  function renderInlineActionForm(customerId, seed = {}) {
    const draft = getActionDraft(customerId, seed);
    const saving = actionSavingCustomerId === Number(customerId);
    return (
      <div
        style={{
          marginTop: 12,
          padding: 12,
          borderRadius: 14,
          background: "#f7fafc",
          border: "1px solid #e3ebf5",
          display: "grid",
          gap: 10,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Log action here</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
          <select value={draft.action_type} onChange={(e) => setActionDraft(customerId, { action_type: e.target.value })}>
            <option value="follow_up">Follow-up / call</option>
            <option value="promise_to_pay">Promise to pay</option>
            <option value="reminder_sent">Reminder sent</option>
            <option value="escalated">Escalate</option>
          </select>
          <input
            type="date"
            value={draft.expected_date || ""}
            onChange={(e) => setActionDraft(customerId, { expected_date: e.target.value })}
          />
          {draft.action_type === "promise_to_pay" ? (
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Promised amount"
              value={draft.promised_amount || ""}
              onChange={(e) => setActionDraft(customerId, { promised_amount: e.target.value })}
            />
          ) : null}
          <input
            placeholder="Remarks"
            value={draft.remarks || ""}
            onChange={(e) => setActionDraft(customerId, { remarks: e.target.value })}
          />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => saveCollectionAction(customerId)} disabled={saving}>
            {saving ? "Saving…" : "Save action"}
          </button>
          <button
            type="button"
            onClick={() =>
              openCollectionDraft(
                {
                  customer_id: customerId,
                  customer_name: seed.customer_name,
                  outstanding_amount: seed.outstanding_amount,
                  max_ageing_days: seed.max_ageing_days,
                  last_action_invoice_id: seed.customer_invoice_id,
                  next_followup_date: seed.next_followup_date,
                },
                "follow_up",
                draft.remarks || null
              )
            }
            disabled={saving || Boolean(collectionDraft)}
          >
            Draft call
          </button>
          <button
            type="button"
            onClick={() =>
              openCollectionDraft(
                {
                  customer_id: customerId,
                  customer_name: seed.customer_name,
                  outstanding_amount: seed.outstanding_amount,
                  promised_amount: seed.promised_amount || seed.outstanding_amount,
                  max_ageing_days: seed.max_ageing_days,
                  last_action_invoice_id: seed.customer_invoice_id,
                  next_followup_date: draft.expected_date || seed.next_followup_date,
                },
                "promise_to_pay"
              )
            }
            disabled={saving || Boolean(collectionDraft)}
          >
            Draft promise
          </button>
        </div>
      </div>
    );
  }

  useEffect(() => {
    if (!launch) return;
    const normalized = normalizeLaunch(launch);
    if (!normalized) return;
    const nextPanel = PANELS.some((p) => p.key === normalized.panel) ? normalized.panel : panel;
    if (typeof normalized.q === "string") setQuery(normalized.q);
    if (normalized.bucket) {
      if (nextPanel === "followups" && FOLLOWUP_BUCKETS.some(([key]) => key === normalized.bucket)) {
        setFollowupBucket(normalized.bucket);
      } else if (nextPanel === "promises" && PROMISE_BUCKETS.some(([key]) => key === normalized.bucket)) {
        setPromiseBucket(normalized.bucket);
      } else if (nextPanel === "disputes" && DISPUTE_STATUS.some(([key]) => key === normalized.bucket)) {
        setDisputeStatus(normalized.bucket);
      } else if (nextPanel === "adjustments" && ADJUSTMENT_STATUS.some(([key]) => key === normalized.bucket)) {
        setAdjustmentStatus(normalized.bucket);
      } else if (nextPanel === "credit_control" && CREDIT_BUCKETS.some(([key]) => key === normalized.bucket)) {
        setCreditBucket(normalized.bucket);
      } else if (nextPanel === "reconciliation" && RECON_BUCKETS.some(([key]) => key === normalized.bucket)) {
        setReconBucket(normalized.bucket);
      }
    }
    setPanel(nextPanel);
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
    loadSummary(normalized.q || query).catch(() => {});
  }, [launch]);

  useEffect(() => {
    loadQueue(panel, query).catch(() => {});
  }, [panel, followupBucket, promiseBucket, disputeStatus, adjustmentStatus, adjustmentType, creditBucket, reconBucket]);

  const deskStats = useMemo(() => {
    return [
      {
        label: "Outstanding amt",
        value: money(collectionsSummary?.invoices?.outstanding_amount),
        tone: "#234a8f",
        onClick: () => {
          setPanel("followups");
          setFollowupBucket("all");
        },
      },
      {
        label: "Unapplied cash",
        value: money(collectionsSummary?.receipts?.unapplied_cash_amount),
        tone: "#8b5a00",
        onClick: () => {
          setPanel("reconciliation");
          setReconBucket("unapplied_cash");
        },
      },
      {
        label: "Matching gaps",
        value: String(reconSummary?.matching_gap_customers ?? 0),
        tone: "#5d4b8a",
        onClick: () => {
          setPanel("reconciliation");
          setReconBucket("matching_gap");
        },
      },
      {
        label: "Credit over-limit",
        value: money(creditSummary?.over_limit_amount),
        tone: "#9f2042",
        onClick: () => {
          setPanel("credit_control");
          setCreditBucket("over_limit");
        },
      },
    ];
  }, [collectionsSummary, reconSummary, creditSummary]);

  const activeBucketLabel = useMemo(() => {
    if (panel === "followups") return FOLLOWUP_BUCKETS.find(([value]) => value === followupBucket)?.[1] || "Follow-ups";
    if (panel === "promises") return PROMISE_BUCKETS.find(([value]) => value === promiseBucket)?.[1] || "Promises";
    if (panel === "disputes") return DISPUTE_STATUS.find(([value]) => value === disputeStatus)?.[1] || "Disputes";
    if (panel === "adjustments") return ADJUSTMENT_STATUS.find(([value]) => value === adjustmentStatus)?.[1] || "Adjustments";
    if (panel === "credit_control") return CREDIT_BUCKETS.find(([value]) => value === creditBucket)?.[1] || "Credit control";
    if (panel === "reconciliation") return RECON_BUCKETS.find(([value]) => value === reconBucket)?.[1] || "Reconciliation";
    return "Queue";
  }, [panel, followupBucket, promiseBucket, disputeStatus, adjustmentStatus, creditBucket, reconBucket]);

  return (
    <div style={{ maxWidth: 1480 }}>
      <DeskTopStrip
        title="AR Desk"
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {typeof onOpenReceipts === "function" ? (
              <button type="button" onClick={() => onOpenReceipts({})}>
                Open Receipts
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                loadSummary(query).catch(() => {});
                loadQueue(panel, query).catch(() => {});
              }}
              disabled={summaryLoading || queueLoading}
            >
              {summaryLoading || queueLoading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPanel("followups");
                setFollowupBucket("overdue");
              }}
            >
              Overdue follow-ups
            </button>
            <button
              type="button"
              onClick={() => {
                setPanel("reconciliation");
                setReconBucket("matching_gap");
              }}
            >
              Matching gaps
            </button>
          </div>
        }
        metrics={topMetrics}
      />
      <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.6, color: "#4a5872", maxWidth: 920 }}>
        Collections and credit home — follow-ups, promises, disputes, reconciliation, and <strong>credit release</strong> lanes. Post receipts and allocate cash from Receipts when payment lands.
      </p>

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      {collectionDraft ? (
        <div style={{ marginTop: 12, marginBottom: 4 }}>
          <ConfirmDraftCard
            draft={collectionDraft}
            editableRemarks
            editablePromisedAmount={collectionDraft.payload?.action_type === "promise_to_pay"}
            onCancel={() => setCollectionDraft(null)}
            onConfirmed={confirmCollectionDraft}
            onError={(e) => {
              if (e?.data?.error === "COLLECTION_ACTIONS_NOT_READY") {
                setError("Collection actions are not ready on this database yet.");
              } else if (e?.data?.error === "INVALID_PROMISED_AMOUNT") {
                setError("Promised amount must be greater than 0.");
              } else {
                setError(getApiErrorMessage(e, "Failed to confirm collection draft."));
              }
            }}
          />
        </div>
      ) : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 0.35fr)", gap: 16, alignItems: "start" }}>
        <DeskCard
          title="Queue"
          subtitle={`Active lane: ${PANELS.find((item) => item.key === panel)?.label || "Queue"} / ${activeBucketLabel}`}
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <DeskChip label={`${rows.length} row(s)`} tone="#f6f7fb" color="#58627a" />
              {query ? <DeskChip label={`Search: ${query}`} tone="#eef4ff" color="#234a8f" /> : null}
            </div>
          }
        >
          {queueLoading ? (
            <div>Loading queue…</div>
          ) : rows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {rows.map((row) => {
                if (panel === "followups") {
                  const attention = attentionAppearance(row.attention_level);
                  const openFollowupTarget = () => {
                    if (row.last_action_invoice_id && typeof onOpenInvoice === "function") {
                      onOpenInvoice(row.last_action_invoice_id);
                      return;
                    }
                    if (typeof onOpenCustomerInvoices === "function") {
                      onOpenCustomerInvoices(row.customer_id, row.customer_name);
                    }
                  };
                  return (
                    <div key={`followup-${row.customer_id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.customer_name}</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                            <DeskChip label={`Outstanding ${money(row.outstanding_amount)}`} tone="#eef4ff" color="#234a8f" />
                            <DeskChip label={`Open invoices ${row.open_invoices || 0}`} tone="#f6f7fb" color="#58627a" />
                            <DeskChip label={row.next_followup_date ? `Next ${fmtDate(row.next_followup_date)}` : "Next —"} tone="#fff7ea" color="#8b5a00" />
                            {row.recommended_action_label ? (
                              <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                            ) : null}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            onClick={() => openCollectionDraft(row, "follow_up")}
                            disabled={Boolean(collectionDraft)}
                          >
                            Draft call
                          </button>
                          <button
                            type="button"
                            onClick={() => openCollectionDraft(row, "promise_to_pay")}
                            disabled={Boolean(collectionDraft)}
                          >
                            Draft promise
                          </button>
                          {(row.last_action_invoice_id || typeof onOpenCustomerInvoices === "function") ? (
                            <button type="button" className="button-ghost" onClick={openFollowupTarget}>
                              {row.last_action_invoice_id ? "Open invoice" : "Open invoices"}
                            </button>
                          ) : null}
                          <a href={`/receipts/customer/${row.customer_id}/statement/pdf`} target="_blank" rel="noreferrer">
                            Statement PDF
                          </a>
                        </div>
                      </div>
                      <div style={{ marginTop: 12, padding: 12, borderRadius: 14, background: "#f8fbff", border: "1px solid #e6eef8" }}>
                        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58, marginBottom: 6 }}>Why this needs attention</div>
                        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                          {row.queue_reason || "Review the customer follow-up plan before the next collection step."}
                        </div>
                      </div>
                      <div
                        style={{
                          marginTop: 10,
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                          gap: 10,
                          padding: 12,
                          borderRadius: 14,
                          background: "#fcfdff",
                          border: "1px solid #edf1f8",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Next action</div>
                          <div style={{ marginTop: 4, fontWeight: 700 }}>{row.recommended_action_label || "Log follow-up here"}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Next follow-up</div>
                          <div style={{ marginTop: 4, fontWeight: 700 }}>{row.next_followup_date ? fmtDate(row.next_followup_date) : "Not set"}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Oldest ageing</div>
                          <div style={{ marginTop: 4, fontWeight: 700 }}>{row.max_ageing_days || 0} day(s)</div>
                        </div>
                      </div>
                      {row.last_action_type ? (
                        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8, lineHeight: 1.6 }}>
                          Last: {String(row.last_action_type).replace(/_/g, " ")} on {fmtDate(row.last_action_date)}
                          {row.last_action_remarks ? ` — ${row.last_action_remarks}` : ""}
                        </div>
                      ) : null}
                      {renderInlineActionForm(row.customer_id, {
                        customer_name: row.customer_name,
                        outstanding_amount: row.outstanding_amount,
                        max_ageing_days: row.max_ageing_days,
                        next_followup_date: row.next_followup_date,
                        customer_invoice_id: row.last_action_invoice_id || "",
                      })}
                    </div>
                  );
                }

                if (panel === "promises") {
                  const chip = statusAppearance(row.overdue_days > 0 ? "escalated" : "open");
                  const attention = attentionAppearance(row.attention_level);
                  const openPromiseTarget = () => {
                    if (row.customer_invoice_id && typeof onOpenInvoice === "function") {
                      onOpenInvoice(row.customer_invoice_id);
                      return;
                    }
                    if (typeof onOpenCustomerInvoices === "function") {
                      onOpenCustomerInvoices(row.customer_id, row.customer_name);
                    }
                  };
                  return (
                    <div key={`promise-${row.id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.customer_name}</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                            <DeskChip label={`Promise ${money(row.promised_amount || row.outstanding_amount)}`} tone="#fff7ea" color="#8b5a00" />
                            <DeskChip label={row.expected_date ? `Due ${fmtDate(row.expected_date)}` : "Due —"} tone={chip.tone} color={chip.color} />
                            {row.invoice_number ? <DeskChip label={row.invoice_number} tone="#eef4ff" color="#234a8f" /> : null}
                            {row.customer_po_number ? <DeskChip label={`Cust PO ${row.customer_po_number}`} tone="#fff7ea" color="#9a5a00" /> : null}
                            {row.recommended_action_label ? (
                              <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                            ) : null}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            onClick={() => openCollectionDraft(row, "chase")}
                            disabled={Boolean(collectionDraft)}
                          >
                            Draft chase
                          </button>
                          <button
                            type="button"
                            onClick={() => openCollectionDraft(row, "promise_to_pay")}
                            disabled={Boolean(collectionDraft)}
                          >
                            Draft re-promise
                          </button>
                          {(row.customer_invoice_id || typeof onOpenCustomerInvoices === "function") ? (
                            <button type="button" className="button-ghost" onClick={openPromiseTarget}>
                              {row.customer_invoice_id ? "Open invoice" : "Open invoices"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div style={{ marginTop: 12, padding: 12, borderRadius: 14, background: "#f8fbff", border: "1px solid #e6eef8" }}>
                        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58, marginBottom: 6 }}>Why this needs attention</div>
                        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                          {row.queue_reason || "Review the payment promise before the next collection step."}
                        </div>
                      </div>
                      <div
                        style={{
                          marginTop: 10,
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                          gap: 10,
                          padding: 12,
                          borderRadius: 14,
                          background: "#fcfdff",
                          border: "1px solid #edf1f8",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Next action</div>
                          <div style={{ marginTop: 4, fontWeight: 700 }}>{row.recommended_action_label || "Review promise"}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Open exposure</div>
                          <div style={{ marginTop: 4, fontWeight: 700 }}>{money(row.outstanding_amount)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Uncovered amount</div>
                          <div style={{ marginTop: 4, fontWeight: 700 }}>{money(row.promise_gap_amount)}</div>
                        </div>
                      </div>
                      {row.remarks ? <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8, lineHeight: 1.6 }}>{row.remarks}</div> : null}
                      {renderInlineActionForm(row.customer_id, {
                        action_type: "promise_to_pay",
                        expected_date: row.expected_date ? String(row.expected_date).slice(0, 10) : todayIso(),
                        promised_amount: row.promised_amount || row.outstanding_amount || "",
                        customer_invoice_id: row.customer_invoice_id || "",
                        outstanding_amount: row.outstanding_amount,
                      })}
                    </div>
                  );
                }

                if (panel === "disputes") {
                  const chip = statusAppearance(row.dispute_status);
                  return (
                    <div key={`dispute-${row.id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.customer_name}</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                            <DeskChip label={String(row.dispute_status || "").toUpperCase()} tone={chip.tone} color={chip.color} />
                            <DeskChip label={`Amount ${money(row.disputed_amount)}`} tone="#f6f7fb" color="#58627a" />
                            <DeskChip label={`Age ${row.ageing_days || 0}d`} tone="#eef4ff" color="#234a8f" />
                            {row.invoice_number ? <DeskChip label={row.invoice_number} tone="#eef4ff" color="#234a8f" /> : null}
                            {row.customer_po_number ? <DeskChip label={`Cust PO ${row.customer_po_number}`} tone="#fff7ea" color="#9a5a00" /> : null}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {row.customer_invoice_id ? (
                            <button type="button" onClick={() => onOpenInvoice?.(row.customer_invoice_id)}>
                              Open invoice
                            </button>
                          ) : null}
                          {row.sales_return_id ? (
                            <button type="button" onClick={() => onOpenSalesReturn?.(row.sales_return_id)}>
                              Open credit note
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6 }}>
                        <strong>{row.dispute_reason}</strong>
                        {row.invoice_outstanding ? ` • invoice outstanding ${money(row.invoice_outstanding)}` : ""}
                      </div>
                      {row.remarks ? <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8, lineHeight: 1.6 }}>{row.remarks}</div> : null}
                    </div>
                  );
                }

                if (panel === "adjustments") {
                  const chip = statusAppearance(row.adjustment_status);
                  return (
                    <div key={`adjustment-${row.id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.customer_name}</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                            <DeskChip label={String(row.adjustment_status || "").toUpperCase()} tone={chip.tone} color={chip.color} />
                            <DeskChip label={String(row.adjustment_type || "").replace(/_/g, " ")} tone="#eef4ff" color="#234a8f" />
                            <DeskChip label={`Amount ${money(row.adjustment_amount)}`} tone="#f6f7fb" color="#58627a" />
                            {row.invoice_number ? <DeskChip label={row.invoice_number} tone="#eef4ff" color="#234a8f" /> : null}
                            {row.customer_po_number ? <DeskChip label={`Cust PO ${row.customer_po_number}`} tone="#fff7ea" color="#9a5a00" /> : null}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {row.customer_invoice_id ? (
                            <button type="button" onClick={() => onOpenInvoice?.(row.customer_invoice_id)}>
                              Open invoice
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {row.reason ? <div style={{ marginTop: 10, fontSize: 13, opacity: 0.82 }}>{row.reason}</div> : null}
                    </div>
                  );
                }

                if (panel === "credit_notes") {
                  const chip = statusAppearance(row.status);
                  return (
                    <div key={`cn-${row.source}-${row.source_id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.customer_name}</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                            <DeskChip label={row.credit_note_number || "CN"} tone="#eef4ff" color="#234a8f" />
                            <DeskChip label={String(row.source || "").replace(/_/g, " ")} tone="#f6f7fb" color="#58627a" />
                            <DeskChip label={money(row.amount)} tone="#ecfbf2" color="#14804a" />
                            <DeskChip label={String(row.status || "").toUpperCase()} tone={chip.tone} color={chip.color} />
                            {row.invoice_number ? <DeskChip label={row.invoice_number} tone="#fff7ea" color="#8b5a00" /> : null}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {row.customer_invoice_id ? (
                            <button type="button" onClick={() => onOpenInvoice?.(row.customer_invoice_id)}>
                              Open invoice
                            </button>
                          ) : null}
                          {row.source === "sales_return" && row.source_id ? (
                            <button type="button" onClick={() => onOpenSalesReturn?.(row.source_id)}>
                              Open sales return
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {row.credit_note_date ? <div style={{ marginTop: 10, fontSize: 13, opacity: 0.75 }}>Date {row.credit_note_date}</div> : null}
                    </div>
                  );
                }

                if (panel === "credit_control") {
                  const latestStatus = String(row.latest_release?.release_status || "").toLowerCase();
                  const chip = statusAppearance(latestStatus || (row.profile?.is_credit_hold ? "hold" : "open"));
                  const attention = attentionAppearance(row.attention_level);
                  return (
                    <div key={`credit-${row.customer_id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.customer_name}</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                            <DeskChip label={`Exposure ${money(row.exposure?.total_exposure)}`} tone="#f6f7fb" color="#58627a" />
                            <DeskChip label={`Over limit ${money(row.exposure?.over_limit_amount)}`} tone="#fff7ea" color="#8b5a00" />
                            <DeskChip label={row.profile?.is_credit_hold ? "Manual hold" : latestStatus ? latestStatus.toUpperCase() : "OK"} tone={chip.tone} color={chip.color} />
                            {row.recommended_action_label ? (
                              <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                            ) : null}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" onClick={() => onOpenCustomerInvoices?.(row.customer_id, row.customer_name)}>
                            Open invoices
                          </button>
                          <button
                            type="button"
                            className={openCreditCustomerId === row.customer_id ? "" : "button-primary"}
                            onClick={() => setOpenCreditCustomerId((current) => (current === row.customer_id ? null : row.customer_id))}
                          >
                            {openCreditCustomerId === row.customer_id
                              ? "Hide release"
                              : latestStatus === "requested"
                                ? "Review release"
                                : "Release credit"}
                          </button>
                          <a href={`/receipts/customer/${row.customer_id}/statement/pdf`} target="_blank" rel="noreferrer">
                            Statement PDF
                          </a>
                        </div>
                      </div>
                      {openCreditCustomerId === row.customer_id ? (
                        <div style={{ marginTop: 12 }}>
                          <CreditReleasePanel
                            customerId={row.customer_id}
                            customerName={row.customer_name || ""}
                            onChanged={() => {
                              loadQueue().catch(() => {});
                              loadSummary().catch(() => {});
                            }}
                            onOpenFullDesk={
                              typeof onOpenCreditRelease === "function"
                                ? () =>
                                    onOpenCreditRelease({
                                      customerId: row.customer_id,
                                      customerName: row.customer_name || "",
                                      bucket: row.profile?.is_credit_hold ? "hold" : "release_requested",
                                    })
                                : null
                            }
                          />
                        </div>
                      ) : null}
                      <div style={{ marginTop: 12, padding: 12, borderRadius: 14, background: "#f8fbff", border: "1px solid #e6eef8" }}>
                        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58, marginBottom: 6 }}>Why this needs attention</div>
                        <div style={{ fontSize: 13, lineHeight: 1.7 }}>{row.queue_reason || "Review the customer credit position before the next sales step."}</div>
                      </div>
                      <div
                        style={{
                          marginTop: 10,
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                          gap: 10,
                          padding: 12,
                          borderRadius: 14,
                          background: "#fcfdff",
                          border: "1px solid #edf1f8",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Next action</div>
                          <div style={{ marginTop: 4, fontWeight: 700 }}>{row.recommended_action_label || "Review customer"}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Overdue</div>
                          <div style={{ marginTop: 4, fontWeight: 700 }}>
                            {row.exposure?.overdue_count || 0} invoice(s) / {money(row.exposure?.overdue_amount)}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Dispatch block</div>
                          <div style={{ marginTop: 4, fontWeight: 700 }}>{row.decisions?.dispatch_release?.block ? "Blocked" : "Clear"}</div>
                        </div>
                      </div>
                    </div>
                  );
                }

                if (panel === "reconciliation") {
                  return (
                    <div key={`recon-${row.customer_id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.customer_name}</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                            <DeskChip label={`Open AR ${money(row.open_invoice_amount)}`} tone="#eef4ff" color="#234a8f" />
                            <DeskChip label={`Unapplied ${money(row.unapplied_cash_amount)}`} tone="#fff7ea" color="#8b5a00" />
                            <DeskChip label={`Net ${money(row.net_customer_balance)}`} tone="#f6f7fb" color="#58627a" />
                            <DeskChip label={String(row.queue_bucket || "clear").replace(/_/g, " ")} tone="#f6f7fb" color="#58627a" />
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" onClick={() => onOpenCustomerInvoices?.(row.customer_id, row.customer_name)}>
                            Open invoices
                          </button>
                          <a href={`/receipts/customer/${row.customer_id}/statement/pdf`} target="_blank" rel="noreferrer">
                            Statement PDF
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                }

                return null;
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No rows in this queue.
            </div>
          )}
        </DeskCard>

        <DeskCard title="Command Rail" subtitle="Switch lanes, review live signals, and tighten the next move.">
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              {deskStats.map((row) => (
                <button
                  key={row.label}
                  type="button"
                  onClick={row.onClick}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    borderRadius: 16,
                    padding: 12,
                    background: "#fcfdff",
                    border: "1px solid #e6ebf2",
                    boxShadow: "0 8px 22px rgba(17, 32, 56, 0.05)",
                  }}
                >
                  <div style={{ fontSize: 11, opacity: 0.66 }}>{row.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 900, marginTop: 6, color: row.tone }}>{row.value}</div>
                </button>
              ))}
            </div>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer / invoice / Cust PO / reason" />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => loadSummary(query).catch(() => {})} disabled={summaryLoading}>
                {summaryLoading ? "Loading..." : "Refresh KPIs"}
              </button>
              <button type="button" onClick={() => loadQueue(panel, query).catch(() => {})} disabled={queueLoading}>
                {queueLoading ? "Loading..." : "Apply Search"}
              </button>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {PANELS.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setPanel(row.key)}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid #e7ebf3",
                    background: row.key === panel ? "#eef4ff" : "#ffffff",
                    cursor: "pointer",
                    fontWeight: row.key === panel ? 800 : 600,
                  }}
                >
                  {row.label}
                </button>
              ))}
            </div>

            {panel === "followups" ? (
              <select value={followupBucket} onChange={(e) => setFollowupBucket(e.target.value)}>
                {FOLLOWUP_BUCKETS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : null}

            {panel === "promises" ? (
              <select value={promiseBucket} onChange={(e) => setPromiseBucket(e.target.value)}>
                {PROMISE_BUCKETS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : null}

            {panel === "disputes" ? (
              <select value={disputeStatus} onChange={(e) => setDisputeStatus(e.target.value)}>
                {DISPUTE_STATUS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : null}

            {panel === "adjustments" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <select value={adjustmentStatus} onChange={(e) => setAdjustmentStatus(e.target.value)}>
                  {ADJUSTMENT_STATUS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <select value={adjustmentType} onChange={(e) => setAdjustmentType(e.target.value)}>
                  {ADJUSTMENT_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {panel === "credit_control" ? (
              <select value={creditBucket} onChange={(e) => setCreditBucket(e.target.value)}>
                {CREDIT_BUCKETS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : null}

            {panel === "reconciliation" ? (
              <select value={reconBucket} onChange={(e) => setReconBucket(e.target.value)}>
                {RECON_BUCKETS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
