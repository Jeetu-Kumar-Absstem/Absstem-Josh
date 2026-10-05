import { useEffect, useMemo, useState } from "react";
import ConfirmDraftCard from "../components/ConfirmDraftCard";
import SlideOverDrawer from "../components/SlideOverDrawer";
import { buildApprovalActionDraft } from "../shared/aiDrafts";
import { useDeskHotkeys } from "../shared/listScale";
import ApprovalHistoryDrawer from "../shared/ApprovalHistoryDrawer";
import { DeskCard, DeskChip, DeskTopStrip, MiniMetric, NoticeBanner, FieldLabel, getDeskStatusAppearance, EmptyState, toast, useSubmitLock } from "../shared/joshUi";

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
  return d.toLocaleString();
}

function fmtMoney(value, currencyCode) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${currencyCode ? `${currencyCode} ` : ""}${n.toFixed(2)}`;
}

function emptyFilters() {
  return {
    doc_type: "",
    vendor_id: "",
    created_by: "",
    date_from: "",
    date_to: "",
  };
}

function buildQuery(filters) {
  const params = new URLSearchParams();
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim()) {
      params.set(key, String(value).trim());
    }
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function docTypeLabel(docType, docTypes) {
  return docTypes.find((item) => item.key === docType)?.label || docType || "Document";
}

function actionErrorMessage(code) {
  if (code === "FORBIDDEN") return "You do not have approval rights for this document.";
  if (code === "NEEDS_SUBMISSION") return "Only submitted documents can be approved.";
  if (code === "NEEDS_APPROVAL") return "This document must be approved before posting.";
  if (code === "INVALID_TRANSITION") return "This action is not allowed for the current status.";
  if (code === "NOT_FOUND") return "The selected document was not found.";
  return code || "Action failed.";
}

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["approved", "posted", "closed"],
    info: ["submitted", "open"],
    warning: ["draft", "pending"],
    danger: ["cancelled", "sent back", "rejected"],
    fallbackTone: "#f6f7fb",
  });
}

function inputStyle() {
  return {
    height: 38,
    padding: "0 10px",
    borderRadius: 10,
    border: "1px solid #d8dfeb",
    background: "#ffffff",
  };
}

function textAreaStyle() {
  return {
    width: "100%",
    padding: 10,
    borderRadius: 12,
    border: "1px solid #d8dfeb",
    background: "#ffffff",
    resize: "vertical",
  };
}

export default function ApprovalDesk({
  me,
  launch,
  onConsumeLaunch,
  onOpenPurchaseRequisition,
  onOpenPurchaseOrder,
  onOpenGoodsReceipt,
  onOpenPurchaseInvoice,
  onOpenVendorPayment,
}) {
  const [filters, setFilters] = useState(emptyFilters);
  const [bootstrap, setBootstrap] = useState({ vendors: [], users: [], doc_types: [] });
  const [counts, setCounts] = useState({
    total_submitted: 0,
    purchase_requisition: 0,
    purchase_order: 0,
    goods_receipt: 0,
    purchase_invoice: 0,
    vendor_payment: 0,
    overdue: 0,
  });
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionKey, setActionKey] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState(null);
  const [remarksByKey, setRemarksByKey] = useState({});
  const [previewRow, setPreviewRow] = useState(null);
  const [actionDraft, setActionDraft] = useState(null);
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const { busy: actionBusy, runLocked } = useSubmitLock();

  useDeskHotkeys({ enabled: !actionDraft && !previewRow });

  const isSuperAdmin = me?.group_name === "SuperAdmin";
  const activeHistoryKey = historyTarget ? `${historyTarget.doc_type}:${historyTarget.doc_id}` : "";

  async function loadDesk(nextFilters = filters) {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/approval-desk${buildQuery(nextFilters)}`);
      setBootstrap({
        vendors: Array.isArray(data?.vendors) ? data.vendors : [],
        users: Array.isArray(data?.users) ? data.users : [],
        doc_types: Array.isArray(data?.doc_types) ? data.doc_types : [],
      });
      setCounts({
        total_submitted: Number(data?.counts?.total_submitted || 0),
        purchase_requisition: Number(data?.counts?.purchase_requisition || 0),
        purchase_order: Number(data?.counts?.purchase_order || 0),
        goods_receipt: Number(data?.counts?.goods_receipt || 0),
        purchase_invoice: Number(data?.counts?.purchase_invoice || 0),
        vendor_payment: Number(data?.counts?.vendor_payment || 0),
        overdue: Number(data?.counts?.overdue || 0),
      });
      setQueue(Array.isArray(data?.queue) ? data.queue : []);
      setSelectedKeys(new Set());
    } catch (e) {
      setError("Failed to load approval queue.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDesk(emptyFilters());
  }, []);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextFilters = {
      doc_type: typeof launch.doc_type === "string" ? launch.doc_type : "",
      vendor_id: launch.vendor_id ? String(launch.vendor_id) : "",
      created_by: launch.created_by ? String(launch.created_by) : "",
      date_from: typeof launch.date_from === "string" ? launch.date_from : "",
      date_to: typeof launch.date_to === "string" ? launch.date_to : "",
    };
    setFilters(nextFilters);
    loadDesk(nextFilters);
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  const summaryCards = useMemo(
    () => [
      { label: "Submitted", value: counts.total_submitted, note: "documents waiting in the desk" },
      { label: "Overdue", value: counts.overdue, note: "submitted more than 2 days ago" },
      { label: "PRQ", value: counts.purchase_requisition, note: "requisitions awaiting approval" },
      { label: "PO", value: counts.purchase_order, note: "purchase orders awaiting approval" },
      { label: "GRN", value: counts.goods_receipt, note: "goods receipts awaiting approval" },
      { label: "PINV", value: counts.purchase_invoice, note: "purchase invoices awaiting approval" },
      { label: "VP", value: counts.vendor_payment, note: "vendor payments awaiting approval" },
    ],
    [counts]
  );

  const topMetrics = useMemo(
    () => [
      {
        label: "Submitted",
        value: counts.total_submitted,
        tone: "#143d7a",
        note: "Show all documents",
        onClick: () => {
          const next = emptyFilters();
          setFilters(next);
          loadDesk(next);
        },
      },
      { label: "Overdue", value: counts.overdue, tone: "#8b5a00", note: "Oldest submissions in queue" },
      {
        label: "PRQ",
        value: counts.purchase_requisition,
        tone: "#234a8f",
        note: "Filter requisitions",
        onClick: () => {
          const next = { ...filters, doc_type: "purchase_requisition" };
          setFilters(next);
          loadDesk(next);
        },
      },
      {
        label: "PO",
        value: counts.purchase_order,
        tone: "#234a8f",
        note: "Filter purchase orders",
        onClick: () => {
          const next = { ...filters, doc_type: "purchase_order" };
          setFilters(next);
          loadDesk(next);
        },
      },
      {
        label: "PINV",
        value: counts.purchase_invoice,
        tone: "#0a7a35",
        note: "Filter invoices",
        onClick: () => {
          const next = { ...filters, doc_type: "purchase_invoice" };
          setFilters(next);
          loadDesk(next);
        },
      },
      {
        label: "VP",
        value: counts.vendor_payment,
        tone: "#5d4b8a",
        note: "Filter payments",
        onClick: () => {
          const next = { ...filters, doc_type: "vendor_payment" };
          setFilters(next);
          loadDesk(next);
        },
      },
    ],
    [counts, filters]
  );

  function setFilter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function applyFilters() {
    setNotice("");
    loadDesk(filters);
  }

  function resetFilters() {
    const next = emptyFilters();
    setFilters(next);
    setNotice("");
    loadDesk(next);
  }

  function openDocument(row) {
    if (!row) return;
    setPreviewRow(row);
  }

  function openFullDocument(row) {
    if (!row) return;
    const id = Number(row.doc_id);
    if (!Number.isFinite(id) || id <= 0) return;
    if (row.doc_type === "purchase_requisition") onOpenPurchaseRequisition?.(id);
    else if (row.doc_type === "purchase_order") onOpenPurchaseOrder?.(id);
    else if (row.doc_type === "goods_receipt") onOpenGoodsReceipt?.(id);
    else if (row.doc_type === "purchase_invoice") onOpenPurchaseInvoice?.(id);
    else if (row.doc_type === "vendor_payment") onOpenVendorPayment?.(id);
  }

  function openHistory(row) {
    if (!row) return;
    setHistoryTarget({
      doc_type: row.doc_type,
      doc_id: row.doc_id,
      doc_number: row.doc_number,
    });
    setHistoryOpen(true);
  }

  function openActionDraft(row, action) {
    if (!row?.can_approve) return;
    const rowKey = `${row.doc_type}:${row.doc_id}`;
    const draft = buildApprovalActionDraft({
      row,
      action,
      docTypes: bootstrap.doc_types,
      existingRemarks: remarksByKey[rowKey] || "",
    });
    if (!draft) {
      setError("Could not draft this approval action.");
      return;
    }
    setError("");
    setNotice("");
    setActionDraft(draft);
  }

  async function confirmActionDraft(_data, working) {
    const action = working?.payload?.action;
    const docType = working?.payload?.doc_type;
    const docId = working?.payload?.doc_id;
    const docNumber = queue.find((r) => r.doc_type === docType && Number(r.doc_id) === Number(docId))?.doc_number || "";
    setActionDraft(null);
    const actionLabel = action === "send_back" ? "sent back" : action === "post" ? "posted" : "approved";
    const msg = `${docTypeLabel(docType, bootstrap.doc_types)} ${docNumber || `#${docId}`} ${actionLabel}.`;
    setNotice(msg);
    toast(msg, "success");
    setRemarksByKey((prev) => {
      const next = { ...prev };
      delete next[`${docType}:${docId}`];
      return next;
    });
    if (previewRow && previewRow.doc_type === docType && Number(previewRow.doc_id) === Number(docId)) {
      setPreviewRow(null);
    }
    await loadDesk(filters);
  }

  function runAction(row, action) {
    openActionDraft(row, action);
  }

  function toggleRowSelected(rowKey, checked) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(rowKey);
      else next.delete(rowKey);
      return next;
    });
  }

  const selectedApproveCount = useMemo(() => {
    let n = 0;
    for (const row of queue) {
      const key = `${row.doc_type}:${row.doc_id}`;
      if (selectedKeys.has(key) && row.can_approve) n += 1;
    }
    return n;
  }, [queue, selectedKeys]);

  async function approveSelectedRows() {
    const rowsToApprove = queue.filter((row) => {
      const key = `${row.doc_type}:${row.doc_id}`;
      return selectedKeys.has(key) && row.can_approve;
    });
    if (!rowsToApprove.length || bulkBusy) return;
    setBulkBusy(true);
    setError("");
    let ok = 0;
    let fail = 0;
    for (const row of rowsToApprove) {
      const rowKey = `${row.doc_type}:${row.doc_id}`;
      const draft = buildApprovalActionDraft({
        row,
        action: "approve",
        docTypes: bootstrap.doc_types,
        existingRemarks: remarksByKey[rowKey] || "",
      });
      const payload = draft?.payload;
      if (!payload) {
        fail += 1;
        continue;
      }
      try {
        await apiFetch("/approval-desk/action", { method: "POST", body: JSON.stringify(payload) });
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    const summary = `Bulk approve: ${ok} succeeded${fail ? `, ${fail} failed` : ""}.`;
    setNotice(summary);
    toast(summary, fail > 0 ? "error" : "success");
    setSelectedKeys(new Set());
    setBulkBusy(false);
    await loadDesk(filters);
  }

  return (
    <>
    <div style={{ maxWidth: 1480 }}>
      <DeskTopStrip
        title="Approval Desk"
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {selectedApproveCount > 0 ? (
              <button type="button" onClick={() => approveSelectedRows()} disabled={loading || bulkBusy || Boolean(actionDraft)}>
                {bulkBusy ? "Approving…" : `Approve selected (${selectedApproveCount})`}
              </button>
            ) : null}
            <button type="button" onClick={() => loadDesk(filters)} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh Queue"}
            </button>
            <button type="button" onClick={resetFilters} disabled={loading}>
              Reset Filters
            </button>
          </div>
        }
        metrics={topMetrics}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      {actionDraft ? (
        <div style={{ marginTop: 12 }}>
          <ConfirmDraftCard
            draft={actionDraft}
            editableRemarks
            onCancel={() => setActionDraft(null)}
            onConfirmed={confirmActionDraft}
            onError={(e) => {
              const message = actionErrorMessage(e?.data?.error);
              setError(message);
              toast(message, "error");
            }}
          />
        </div>
      ) : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 420px)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Approval Queue" subtitle="Open, comment, approve, send back, or direct-post from the shared queue">
          {loading && !queue.length ? <div>Loading approval queue…</div> : null}

          {!loading && !queue.length ? (
            <EmptyState
              title="Approval queue is clear"
              body="No submitted documents match the current filter. Adjust filters or refresh after new submissions."
            />
          ) : null}

          {queue.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {queue.map((row) => {
                const rowKey = `${row.doc_type}:${row.doc_id}`;
                const isBusy = actionKey.endsWith(rowKey);
                const statusMeta = statusAppearance(row.doc_status);
                return (
                  <article
                    key={rowKey}
                    style={{
                      border: "1px solid #e7ebf3",
                      borderRadius: 18,
                      padding: 14,
                      display: "grid",
                      gap: 12,
                      background: "#ffffff",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        {row.can_approve ? (
                          <input
                            type="checkbox"
                            checked={selectedKeys.has(rowKey)}
                            onChange={(e) => toggleRowSelected(rowKey, e.target.checked)}
                            aria-label={`Select ${row.doc_number} for bulk approve`}
                            style={{ marginTop: 6 }}
                          />
                        ) : null}
                      <div>
                        <div style={{ fontSize: 12, opacity: 0.72 }}>{docTypeLabel(row.doc_type, bootstrap.doc_types)}</div>
                        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{row.doc_number}</div>
                        <div style={{ fontSize: 13, opacity: 0.82, marginTop: 4 }}>{row.vendor_name || "—"}</div>
                      </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <DeskChip label={String(row.doc_status || "submitted").toUpperCase()} tone={statusMeta.tone} color={statusMeta.color} />
                        <DeskChip label={fmtMoney(row.total_amount, row.currency_code)} tone="#f6f7fb" color="#58627a" />
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                      <MiniMetric label="Document Date" value={fmtDate(row.doc_date)} />
                      <MiniMetric label="Created By" value={row.created_by_name || "—"} />
                      <MiniMetric label="Submitted By" value={row.submitted_by_name || "—"} />
                      <MiniMetric label="Submitted At" value={fmtDateTime(row.submitted_at)} />
                      <MiniMetric label="Current Level" value={`${Number(row.current_approval_level || 0)} / ${Number(row.required_approval_level || 0)}`} />
                      <MiniMetric label="Next Level" value={row.next_approval_level ? `L${row.next_approval_level}` : "Final approval"} />
                      <MiniMetric label="Next Approver" value={row.next_approver || "—"} />
                    </div>

                    {(row.line_summary || row.policy_match_reason) ? (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {row.line_summary ? <DeskChip label={row.line_summary} tone="#f6f7fb" color="#58627a" /> : null}
                        {row.policy_match_reason ? <DeskChip label={row.policy_match_reason} tone="#fff7e8" color="#8a6708" /> : null}
                      </div>
                    ) : null}

                    <FieldLabel label="Remarks For Your Next Action">
                      <textarea
                        rows={3}
                        value={remarksByKey[rowKey] || ""}
                        onChange={(e) =>
                          setRemarksByKey((prev) => ({
                            ...prev,
                            [rowKey]: e.target.value,
                          }))
                        }
                        style={textAreaStyle()}
                        placeholder="Optional remarks recorded with approve, send back, or direct post."
                      />
                    </FieldLabel>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button type="button" onClick={() => openDocument(row)}>Open Document</button>
                      <button type="button" onClick={() => openHistory(row)}>History / Remarks</button>
                      <button type="button" onClick={() => runAction(row, "approve")} disabled={!row.can_approve || isBusy || Boolean(actionDraft)}>
                        {isBusy && actionKey.startsWith("approve:") ? "Approving..." : "Approve"}
                      </button>
                      <button type="button" onClick={() => runAction(row, "send_back")} disabled={!row.can_approve || isBusy || Boolean(actionDraft)}>
                        {isBusy && actionKey.startsWith("send_back:") ? "Sending..." : "Send Back"}
                      </button>
                      {isSuperAdmin ? (
                        <button type="button" onClick={() => runAction(row, "post")} disabled={!row.can_approve || isBusy || Boolean(actionDraft)}>
                          {isBusy && actionKey.startsWith("post:") ? "Posting..." : "Post Direct"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </DeskCard>

        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Queue Mix" subtitle="Approval load by document family">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
              {summaryCards.map((card) => (
                <div key={card.label} style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 12, background: "#fcfdff" }}>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>{card.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{card.value}</div>
                  <div style={{ fontSize: 12, opacity: 0.68, marginTop: 8, lineHeight: 1.6 }}>{card.note}</div>
                </div>
              ))}
            </div>
          </DeskCard>

          <DeskCard title="Filter Queue" subtitle="Narrow the desk to the exact approval cohort you want to work">
          <div style={{ display: "grid", gap: 12 }}>
            <FieldLabel label="Document Type">
              <select value={filters.doc_type} onChange={(e) => setFilter("doc_type", e.target.value)} style={inputStyle()}>
                <option value="">All documents</option>
                {bootstrap.doc_types.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </FieldLabel>

            <FieldLabel label="Vendor">
              <select value={filters.vendor_id} onChange={(e) => setFilter("vendor_id", e.target.value)} style={inputStyle()}>
                <option value="">All vendors</option>
                {bootstrap.vendors.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.company_name}
                  </option>
                ))}
              </select>
            </FieldLabel>

            <FieldLabel label="Created By">
              <select value={filters.created_by} onChange={(e) => setFilter("created_by", e.target.value)} style={inputStyle()}>
                <option value="">All users</option>
                {bootstrap.users.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.full_name || item.email}
                  </option>
                ))}
              </select>
            </FieldLabel>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FieldLabel label="Date From">
                <input type="date" value={filters.date_from} onChange={(e) => setFilter("date_from", e.target.value)} style={inputStyle()} />
              </FieldLabel>
              <FieldLabel label="Date To">
                <input type="date" value={filters.date_to} onChange={(e) => setFilter("date_to", e.target.value)} style={inputStyle()} />
              </FieldLabel>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={applyFilters} disabled={loading}>Apply Filters</button>
              <button type="button" onClick={resetFilters} disabled={loading}>Reset</button>
            </div>
          </div>
        </DeskCard>
        </div>
      </div>
      <ApprovalHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docType={historyTarget?.doc_type || ""}
        docId={historyTarget?.doc_id || ""}
        remarks={activeHistoryKey ? remarksByKey[activeHistoryKey] || "" : ""}
        onRemarksChange={(value) =>
          setRemarksByKey((prev) => ({
            ...prev,
            ...(activeHistoryKey ? { [activeHistoryKey]: value } : {}),
          }))
        }
      />
    </div>
    <SlideOverDrawer
      open={Boolean(previewRow)}
      onClose={() => setPreviewRow(null)}
      eyebrow="Approval preview"
      title={previewRow?.doc_number || "Document"}
      subtitle={
        previewRow
          ? `${docTypeLabel(previewRow.doc_type, bootstrap.doc_types)} • ${previewRow.vendor_name || "—"} • Queue stays open`
          : null
      }
      width={520}
      footer={
        previewRow ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="button-primary" onClick={() => openFullDocument(previewRow)}>
              Open full document
            </button>
            <button
              type="button"
              onClick={() => runAction(previewRow, "approve")}
              disabled={!previewRow.can_approve || actionBusy || Boolean(actionDraft)}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => runAction(previewRow, "send_back")}
              disabled={!previewRow.can_approve || actionBusy || Boolean(actionDraft)}
            >
              Send Back
            </button>
            {isSuperAdmin ? (
              <button type="button" onClick={() => runAction(previewRow, "post")} disabled={!previewRow.can_approve || actionBusy || Boolean(actionDraft)}>
                Post Direct
              </button>
            ) : null}
          </div>
        ) : null
      }
    >
      {previewRow ? (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <MiniMetric label="Status" value={String(previewRow.doc_status || "submitted").toUpperCase()} />
            <MiniMetric label="Amount" value={fmtMoney(previewRow.total_amount, previewRow.currency_code)} />
            <MiniMetric label="Document date" value={fmtDate(previewRow.doc_date)} />
            <MiniMetric label="Created by" value={previewRow.created_by_name || "—"} />
            <MiniMetric label="Submitted" value={fmtDateTime(previewRow.submitted_at)} />
            <MiniMetric label="Ageing" value={`${Number(previewRow.ageing_days || 0)}d`} />
          </div>
          <FieldLabel label="Remarks for this action">
            <textarea
              rows={4}
              value={remarksByKey[`${previewRow.doc_type}:${previewRow.doc_id}`] || ""}
              onChange={(e) =>
                setRemarksByKey((prev) => ({
                  ...prev,
                  [`${previewRow.doc_type}:${previewRow.doc_id}`]: e.target.value,
                }))
              }
              style={textAreaStyle()}
              placeholder="Optional remarks recorded with approve, send back, or direct post."
            />
          </FieldLabel>
          <button type="button" onClick={() => openHistory(previewRow)}>
            History / Remarks
          </button>
        </div>
      ) : null}
    </SlideOverDrawer>
    </>
  );
}
