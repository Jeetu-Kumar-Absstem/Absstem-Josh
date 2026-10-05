import { useEffect, useMemo, useState } from "react";
import SlideOverDrawer from "../components/SlideOverDrawer";
import VendorQuickCreate from "../components/VendorQuickCreate";
import ConfirmDraftCard from "../components/ConfirmDraftCard";
import { buildPoFromPrDraft } from "../shared/aiDrafts";
import ApprovalHistoryDrawer from "../shared/ApprovalHistoryDrawer";
import { DeskCard, DeskChip, MiniMetric, NoticeBanner, PageHero, FieldLabel, getDeskStatusAppearance, EmptyState, toast, useSubmitLock } from "../shared/joshUi";

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

function fmtMoney(value, currencyCode) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${currencyCode ? `${currencyCode} ` : ""}${n.toFixed(2)}`;
}

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
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

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function calcTotals(lines) {
  const subtotal = money(
    lines.reduce((sum, line) => {
      const qty = Number(line.qty || 0);
      const unit = Number(line.unit_price_order || 0);
      if (!Number.isFinite(qty) || !Number.isFinite(unit)) return sum;
      return sum + qty * unit;
    }, 0)
  );
  const taxTotal = money(
    lines.reduce((sum, line) => {
      const qty = Number(line.qty || 0);
      const unit = Number(line.unit_price_order || 0);
      const gst = Number(line.gst_pct || 0);
      if (!Number.isFinite(qty) || !Number.isFinite(unit) || !Number.isFinite(gst)) return sum;
      const base = qty * unit;
      return sum + base * (gst / 100);
    }, 0)
  );
  return {
    subtotal,
    taxTotal,
    grandTotal: money(subtotal + taxTotal),
  };
}

function emptyLine() {
  return {
    product_id: null,
    item_code: "",
    item_name: "",
    line_description: "",
    hsn_no: "",
    uom: "",
    qty: 1,
    unit_price_order: 0,
    gst_pct: 0,
  };
}

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["approved", "closed"],
    info: ["submitted", "open"],
    warning: ["draft"],
    danger: ["cancelled"],
    fallbackTone: "#f6f7fb",
  });
}

function externalProcessingAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "requisition_waiting_po") return { tone: "#eef4ff", color: "#234a8f", label: "Requisition Waiting PO" };
  if (key === "vendor_in_flight") return { tone: "#fff7ea", color: "#8b5a00", label: "Vendor In Flight" };
  if (key === "partial_supply") return { tone: "#eefbf3", color: "#147a3d", label: "Partial Supply" };
  if (key === "qc_hold") return { tone: "#fff2f2", color: "#a52323", label: "QC Hold" };
  if (key === "replacement_pending") return { tone: "#fff7ea", color: "#8b5a00", label: "Replacement Pending" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "Vendor Dependency") };
}

function inputStyle(readOnly = false) {
  return {
    height: 38,
    padding: "0 10px",
    borderRadius: 10,
    border: "1px solid #d8dfeb",
    background: readOnly ? "#f7f9fc" : "#ffffff",
  };
}

function textAreaStyle(readOnly = false) {
  return {
    width: "100%",
    padding: 10,
    borderRadius: 12,
    border: "1px solid #d8dfeb",
    background: readOnly ? "#f7f9fc" : "#ffffff",
    resize: "vertical",
  };
}

function commandButtonStyle(active) {
  return {
    all: "unset",
    cursor: "pointer",
    border: `1px solid ${active ? "#cfe0ff" : "#e6ebf3"}`,
    background: active ? "#eef4ff" : "#ffffff",
    borderRadius: 18,
    padding: 14,
    display: "grid",
    gap: 6,
    boxShadow: active ? "0 10px 24px rgba(35, 74, 143, 0.10)" : "0 6px 18px rgba(26, 35, 53, 0.04)",
  };
}

function workflowButtonStyle(tone, active = true) {
  return {
    borderRadius: 12,
    border: `1px solid ${active ? tone.border : "#d8e0ec"}`,
    background: active ? tone.background : "#f8fafc",
    color: active ? tone.color : "#64748b",
    padding: "10px 12px",
    fontWeight: 700,
    cursor: active ? "pointer" : "not-allowed",
    opacity: active ? 1 : 0.7,
  };
}

function queueCardStyle() {
  return {
    border: "1px solid #e7ebf3",
    borderRadius: 18,
    padding: 14,
    background: "#ffffff",
    boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
    display: "grid",
    gap: 12,
  };
}

function queueHeaderStyle() {
  return {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "flex-start",
  };
}

const EXTERNAL_PROCESSING_BUCKETS = [
  ["requisition_waiting_po", "Req waiting PO"],
  ["vendor_in_flight", "Vendor in flight"],
  ["partial_supply", "Partial supply"],
  ["qc_hold", "QC hold"],
  ["replacement_pending", "Replacement pending"],
];

export default function PurchaseOrders({
  openPurchaseOrderId,
  launch,
  onConsumeLaunch,
  onOpenPurchaseRequisition,
  onOpenApprovalDesk,
  onOpenGoodsReceipts,
}) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [orders, setOrders] = useState([]);
  const [exceptionsSummary, setExceptionsSummary] = useState(null);
  const [exceptionsRows, setExceptionsRows] = useState([]);
  const [exceptionsBucket, setExceptionsBucket] = useState("shortage_not_raised");
  const [exceptionsQuery, setExceptionsQuery] = useState("");
  const [exceptionsLoading, setExceptionsLoading] = useState(false);
  const [exceptionsError, setExceptionsError] = useState("");
  const [externalSummary, setExternalSummary] = useState(null);
  const [externalRows, setExternalRows] = useState([]);
  const [externalBucket, setExternalBucket] = useState("vendor_in_flight");
  const [externalQuery, setExternalQuery] = useState("");
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalError, setExternalError] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], currencies: [], approved_requisitions: [] });
  const [createMode, setCreateMode] = useState("manual");
  const [creatingVendorId, setCreatingVendorId] = useState("");
  const [creatingCurrencyId, setCreatingCurrencyId] = useState("");
  const [creatingRequisitionId, setCreatingRequisitionId] = useState("");
  const [creating, setCreating] = useState(false);
  const [poDraft, setPoDraft] = useState(null);

  const queueStats = useMemo(() => {
    const total = orders.length;
    const draft = orders.filter((row) => String(row.po_status || "").toLowerCase() === "draft").length;
    const submitted = orders.filter((row) => String(row.po_status || "").toLowerCase() === "submitted").length;
    const approved = orders.filter((row) => ["approved", "closed"].includes(String(row.po_status || "").toLowerCase())).length;
    return {
      total,
      draft,
      submitted,
      approved,
    };
  }, [orders]);

  async function loadBootstrap() {
    const data = await apiFetch("/purchase-orders/bootstrap");
    setBootstrap({
      vendors: Array.isArray(data?.vendors) ? data.vendors : [],
      currencies: Array.isArray(data?.currencies) ? data.currencies : [],
      approved_requisitions: Array.isArray(data?.approved_requisitions) ? data.approved_requisitions : [],
    });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/purchase-orders");
      setOrders(Array.isArray(data?.purchase_orders) ? data.purchase_orders : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load purchase orders."));
    } finally {
      setLoading(false);
    }
  }

  async function loadExceptionsSummary() {
    try {
      const data = await apiFetch("/purchase-orders/exceptions-summary");
      setExceptionsSummary(data?.summary || null);
    } catch (e) {
      setExceptionsSummary(null);
      setExceptionsError(getApiErrorMessage(e, "Failed to load procurement exceptions summary."));
    }
  }

  async function loadExceptionsQueue({ bucket = exceptionsBucket, q = exceptionsQuery } = {}) {
    setExceptionsLoading(true);
    setExceptionsError("");
    try {
      const params = new URLSearchParams();
      if (bucket) params.set("bucket", bucket);
      if (q) params.set("q", q);
      const query = params.toString();
      const data = await apiFetch(`/purchase-orders/exceptions-queue${query ? `?${query}` : ""}`);
      setExceptionsRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setExceptionsRows([]);
      setExceptionsError(getApiErrorMessage(e, "Failed to load procurement exceptions queue."));
    } finally {
      setExceptionsLoading(false);
    }
  }

  async function loadExternalSummary() {
    try {
      const data = await apiFetch("/purchase-orders/external-processing-summary");
      setExternalSummary(data?.summary || null);
    } catch (e) {
      setExternalSummary(null);
      setExternalError(getApiErrorMessage(e, "Failed to load external processing summary."));
    }
  }

  async function loadExternalQueue({ bucket = externalBucket, q = externalQuery } = {}) {
    setExternalLoading(true);
    setExternalError("");
    try {
      const params = new URLSearchParams();
      if (bucket) params.set("bucket", bucket);
      if (q) params.set("q", q);
      const query = params.toString();
      const data = await apiFetch(`/purchase-orders/external-processing-queue${query ? `?${query}` : ""}`);
      setExternalRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setExternalRows([]);
      setExternalError(getApiErrorMessage(e, "Failed to load external processing queue."));
    } finally {
      setExternalLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
      loadExceptionsSummary().catch(() => {});
      loadExceptionsQueue().catch(() => {});
      loadExternalSummary().catch(() => {});
      loadExternalQueue().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadExceptionsQueue({ bucket: exceptionsBucket }).catch(() => {});
  }, [exceptionsBucket]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadExternalQueue({ bucket: externalBucket }).catch(() => {});
  }, [externalBucket]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextBucket = typeof launch.procurement_bucket === "string" ? launch.procurement_bucket : exceptionsBucket;
    const nextQuery = typeof launch.procurement_q === "string" ? launch.procurement_q : "";
    const nextExternalBucket = typeof launch.external_bucket === "string" ? launch.external_bucket : externalBucket;
    const nextExternalQuery = typeof launch.external_q === "string" ? launch.external_q : "";
    setExceptionsBucket(nextBucket);
    setExceptionsQuery(nextQuery);
    setExternalBucket(nextExternalBucket);
    setExternalQuery(nextExternalQuery);
    if (typeof launch.create_mode === "string") setCreateMode(launch.create_mode === "from_requisition" ? "from_requisition" : "manual");
    if (launch.requisition_id) setCreatingRequisitionId(String(launch.requisition_id));
    if (view.type !== "list") setView({ type: "list" });
    loadExceptionsSummary().catch(() => {});
    loadExceptionsQueue({ bucket: nextBucket, q: nextQuery }).catch(() => {});
    loadExternalSummary().catch(() => {});
    loadExternalQueue({ bucket: nextExternalBucket, q: nextExternalQuery }).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    const id = Number(openPurchaseOrderId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
  }, [openPurchaseOrderId]);

  useEffect(() => {
    if (!bootstrap.currencies.length) return;
    if (creatingCurrencyId) return;
    const inr = bootstrap.currencies.find((c) => c.currency_code === "INR");
    if (inr?.id) setCreatingCurrencyId(String(inr.id));
  }, [bootstrap.currencies, creatingCurrencyId]);

  async function createPurchaseOrder() {
    const vendorId = Number(creatingVendorId);
    const currencyId = Number(creatingCurrencyId);
    if (!Number.isFinite(vendorId) || vendorId <= 0) {
      setError("Select a vendor first.");
      return;
    }
    const requisitionId = Number(creatingRequisitionId);
    if (createMode === "from_requisition" && (!Number.isFinite(requisitionId) || requisitionId <= 0)) {
      setError("Select an approved requisition first.");
      return;
    }

    if (createMode === "from_requisition") {
      const requisition = bootstrap.approved_requisitions.find((r) => Number(r.id) === requisitionId) || null;
      const vendor = bootstrap.vendors.find((v) => Number(v.id) === vendorId) || { id: vendorId };
      const currency = bootstrap.currencies.find((c) => Number(c.id) === currencyId) || null;
      const draft = buildPoFromPrDraft({ requisition, vendor, currency });
      if (!draft) {
        setError("Could not build PO draft from this requisition.");
        return;
      }
      setError("");
      setNotice("");
      setPoDraft(draft);
      return;
    }

    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/purchase-orders", {
        method: "POST",
        body: JSON.stringify({
          vendor_id: vendorId,
          order_currency_id: Number.isFinite(currencyId) && currencyId > 0 ? currencyId : undefined,
        }),
      });
      const id = data?.purchase_order?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Purchase order created.");
      loadExceptionsSummary().catch(() => {});
      loadExceptionsQueue().catch(() => {});
    } catch (e) {
      if (e?.data?.error === "INVALID_VENDOR" || e?.data?.error === "VENDOR_NOT_FOUND") {
        setError("Select a valid vendor.");
      } else {
        setError("Failed to create purchase order.");
      }
    } finally {
      setCreating(false);
    }
  }

  async function confirmPoDraft(data) {
    setCreating(true);
    setPoDraft(null);
    setError("");
    try {
      const id = data?.purchase_order?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Purchase order created from requisition.");
      loadExceptionsSummary().catch(() => {});
      loadExceptionsQueue().catch(() => {});
      loadBootstrap().catch(() => {});
    } finally {
      setCreating(false);
    }
  }

  async function raisePurchaseRequisitionFromShortage(shortageActionId) {
    const id = Number(shortageActionId);
    if (!Number.isFinite(id) || id <= 0) return;
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/purchase-requisitions/from-shortage-action", {
        method: "POST",
        body: JSON.stringify({ shortage_action_id: id }),
      });
      const requisitionId = data?.purchase_requisition?.id;
      if (requisitionId && typeof onOpenPurchaseRequisition === "function") {
        onOpenPurchaseRequisition(Number(requisitionId));
      }
      setNotice("Purchase requisition raised from shortage.");
      loadExceptionsSummary().catch(() => {});
      loadExceptionsQueue().catch(() => {});
    } catch (e) {
      if (e?.data?.error === "SHORTAGE_REQUISITION_ALREADY_RAISED") {
        const requisitionId = Number(e?.data?.purchase_requisition_id);
        if (Number.isFinite(requisitionId) && requisitionId > 0 && typeof onOpenPurchaseRequisition === "function") {
          onOpenPurchaseRequisition(requisitionId);
        }
        setNotice(`Requisition ${e?.data?.requisition_number || ""} already exists for this shortage.`);
      } else {
        setError(getApiErrorMessage(e, "Failed to raise purchase requisition from shortage."));
      }
    }
  }

  if (view.type === "detail") {
    // Keep exception queues mounted under the drawer.
  }

  const closeDetail = () => {
    setView({ type: "list" });
    loadList();
    loadExceptionsSummary().catch(() => {});
    loadExceptionsQueue().catch(() => {});
  };

  const heroStats = [
    { label: "Demand Not Raised", value: exceptionsSummary?.shortage_not_raised_count ?? queueStats.total, tone: "#9f2042" },
    { label: "PR Not Ordered", value: exceptionsSummary?.pr_not_ordered_count ?? queueStats.draft, tone: "#143d7a" },
    { label: "PO Pending Receipt", value: exceptionsSummary?.po_pending_receipt_count ?? queueStats.approved, tone: "#0a7a35" },
    { label: "Approval Pressure", value: (Number(exceptionsSummary?.pr_approval_aged_count || 0) + Number(exceptionsSummary?.po_approval_aged_count || 0)) || queueStats.submitted, tone: "#8b5a00" },
  ];

  const exceptionCards = [
    { key: "shortage_not_raised", label: "Demand not raised", count: Number(exceptionsSummary?.shortage_not_raised_count || 0), qty: Number(exceptionsSummary?.shortage_not_raised_qty || 0), tone: "#9f2042" },
    { key: "pr_submitted", label: "PR awaiting approval", count: Number(exceptionsSummary?.pr_submitted_count || 0), qty: 0, tone: "#234a8f" },
    { key: "pr_approval_aged", label: "PR approval-aged", count: Number(exceptionsSummary?.pr_approval_aged_count || 0), qty: 0, tone: "#8b5a00" },
    { key: "pr_not_ordered", label: "Approved PR not ordered", count: Number(exceptionsSummary?.pr_not_ordered_count || 0), qty: Number(exceptionsSummary?.pr_not_ordered_qty || 0), tone: "#143d7a" },
    { key: "po_submitted", label: "PO awaiting approval", count: Number(exceptionsSummary?.po_submitted_count || 0), qty: 0, tone: "#234a8f" },
    { key: "po_approval_aged", label: "PO approval-aged", count: Number(exceptionsSummary?.po_approval_aged_count || 0), qty: 0, tone: "#8b5a00" },
    { key: "po_pending_receipt", label: "PO pending receipt", count: Number(exceptionsSummary?.po_pending_receipt_count || 0), qty: Number(exceptionsSummary?.po_pending_receipt_qty || 0), tone: "#0a7a35" },
    { key: "po_partial_supply", label: "PO partial supply", count: Number(exceptionsSummary?.po_partial_supply_count || 0), qty: Number(exceptionsSummary?.po_partial_supply_qty || 0), tone: "#7b4ad8" },
  ];

  const procurementFocusActions = [
    {
      label: "Raise missing demand",
      note: `${Number(exceptionsSummary?.shortage_not_raised_count || 0)} shortage rows still have no PR raised.`,
      onClick: () => setExceptionsBucket("shortage_not_raised"),
      tone: "#9f2042",
    },
    {
      label: "Convert approved PRs",
      note: `${Number(exceptionsSummary?.pr_not_ordered_count || 0)} approved requisitions are still waiting for PO action.`,
      onClick: () => {
        setExceptionsBucket("pr_not_ordered");
        setCreateMode("from_requisition");
      },
      tone: "#143d7a",
    },
    {
      label: "Chase vendor supply",
      note: `${Number(exceptionsSummary?.po_pending_receipt_count || 0)} purchase orders still need receiving progress.`,
      onClick: () => setExceptionsBucket("po_pending_receipt"),
      tone: "#0a7a35",
    },
  ];

  const externalFocusActions = [
    {
      label: "Req waiting PO",
      note: `${Number(externalSummary?.requisition_waiting_po_count || 0)} outside-processing requisitions are still not converted.`,
      onClick: () => setExternalBucket("requisition_waiting_po"),
      tone: "#234a8f",
    },
    {
      label: "QC hold",
      note: `${Number(externalSummary?.qc_hold_count || 0)} cases need receiving and quality follow-through.`,
      onClick: () => setExternalBucket("qc_hold"),
      tone: "#a52323",
    },
    {
      label: "Replacement pending",
      note: `${Number(externalSummary?.replacement_pending_count || 0)} claims are still waiting for replacement closure.`,
      onClick: () => setExternalBucket("replacement_pending"),
      tone: "#8b5a00",
    },
  ];

  return (
    <>
    <div style={{ maxWidth: 1460 }}>
      <PageHero
        eyebrow="Purchase Command Desk"
        title="Purchase Orders"
        description="Run procurement before inward and AP start hurting: raise missing purchase demand, chase PR and PO approvals, convert approved requisitions, and keep undelivered orders visible until receiving takes over."
        actions={<button onClick={() => {
          loadList();
          loadExceptionsSummary().catch(() => {});
          loadExceptionsQueue().catch(() => {});
          loadExternalSummary().catch(() => {});
          loadExternalQueue().catch(() => {});
        }} disabled={loading || exceptionsLoading}>{loading || exceptionsLoading ? "Refreshing..." : "Refresh Queue"}</button>}
        stats={heroStats}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Procurement Runbook" subtitle="Use the shortest path for the exact blockage type instead of scanning the whole purchase surface every time.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ fontWeight: 800 }}>Core procurement queue</div>
              <div style={{ display: "grid", gap: 10 }}>
                {procurementFocusActions.map((action) => (
                  <button key={action.label} onClick={action.onClick} style={commandButtonStyle(false)}>
                    <div style={{ fontSize: 12, opacity: 0.68 }}>{action.label}</div>
                    <div style={{ fontSize: 12, marginTop: 6, color: action.tone }}>{action.note}</div>
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ fontWeight: 800 }}>Vendor dependency queue</div>
              <div style={{ display: "grid", gap: 10 }}>
                {externalFocusActions.map((action) => (
                  <button key={action.label} onClick={action.onClick} style={commandButtonStyle(false)}>
                    <div style={{ fontSize: 12, opacity: 0.68 }}>{action.label}</div>
                    <div style={{ fontSize: 12, marginTop: 6, color: action.tone }}>{action.note}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Outside Processing / Vendor Dependency Desk" subtitle="Phase-1 external-processing control using manufacturing-linked PR/PO/GRN/QC/claim flow">
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <button onClick={() => setExternalBucket("requisition_waiting_po")} style={commandButtonStyle(externalBucket === "requisition_waiting_po")}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>Req waiting PO</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#234a8f" }}>{Number(externalSummary?.requisition_waiting_po_count || 0)}</div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>{Number(externalSummary?.requisition_waiting_po_qty || 0).toFixed(2)} qty</div>
              </button>
              <button onClick={() => setExternalBucket("vendor_in_flight")} style={commandButtonStyle(externalBucket === "vendor_in_flight")}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>Vendor in flight</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#8b5a00" }}>{Number(externalSummary?.vendor_in_flight_count || 0)}</div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>{Number(externalSummary?.vendor_in_flight_qty || 0).toFixed(2)} qty</div>
              </button>
              <button onClick={() => setExternalBucket("partial_supply")} style={commandButtonStyle(externalBucket === "partial_supply")}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>Partial supply</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#147a3d" }}>{Number(externalSummary?.partial_supply_count || 0)}</div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>{Number(externalSummary?.partial_supply_qty || 0).toFixed(2)} qty</div>
              </button>
              <button onClick={() => setExternalBucket("qc_hold")} style={commandButtonStyle(externalBucket === "qc_hold")}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>QC hold</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#a52323" }}>{Number(externalSummary?.qc_hold_count || 0)}</div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>{Number(externalSummary?.qc_hold_qty || 0).toFixed(2)} qty</div>
              </button>
              <button onClick={() => setExternalBucket("replacement_pending")} style={commandButtonStyle(externalBucket === "replacement_pending")}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>Replacement pending</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#8b5a00" }}>{Number(externalSummary?.replacement_pending_count || 0)}</div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>{Number(externalSummary?.replacement_pending_qty || 0).toFixed(2)} qty</div>
              </button>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={externalQuery}
                onChange={(e) => setExternalQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadExternalQueue({ q: externalQuery }).catch(() => {});
                }}
                placeholder="Search requisition, PO, vendor, GRN, or claim"
                style={{ ...inputStyle(), minWidth: 260, flex: "1 1 260px" }}
              />
              <button onClick={() => loadExternalQueue({ q: externalQuery })} disabled={externalLoading}>
                {externalLoading ? "Refreshing..." : "Refresh External Queue"}
              </button>
            </div>

            <NoticeBanner tone="error" message={externalError} />

            {externalLoading ? (
              <div>Loading outside processing control…</div>
            ) : externalRows.length ? (
              <div style={{ display: "grid", gap: 12 }}>
                {externalRows.map((row) => {
                  const appearance = externalProcessingAppearance(externalBucket);
                  if (externalBucket === "requisition_waiting_po") {
                    return (
                      <div key={row.id} style={queueCardStyle()}>
                        <div style={queueHeaderStyle()}>
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 16 }}>{row.requisition_number}</div>
                            <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                              {row.department || row.purpose || "No department"} • {fmtDate(row.required_by_date)}
                            </div>
                          </div>
                          <DeskChip label={appearance.label} tone={appearance.tone} color={appearance.color} />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                          <MiniMetric label="Pending Qty" value={Number(row.pending_qty || 0).toFixed(2)} />
                          <MiniMetric label="Shortage Links" value={row.shortage_linked_lines || 0} />
                          <MiniMetric label="Status" value={row.requisition_status || "—"} />
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {typeof onOpenPurchaseRequisition === "function" ? <button onClick={() => onOpenPurchaseRequisition(Number(row.id))}>Open Requisition</button> : null}
                          <button onClick={() => {
                            setCreateMode("from_requisition");
                            setCreatingRequisitionId(String(row.id));
                          }}>Start PO From Requisition</button>
                        </div>
                      </div>
                    );
                  }

                  if (["vendor_in_flight", "partial_supply"].includes(externalBucket)) {
                    return (
                      <div key={row.id} style={queueCardStyle()}>
                        <div style={queueHeaderStyle()}>
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 16 }}>{row.po_number}</div>
                            <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                              {row.vendor_name} • {row.requisition_number || "Manual PO"} • {fmtDate(row.po_date)}
                            </div>
                          </div>
                          <DeskChip label={appearance.label} tone={appearance.tone} color={appearance.color} />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                          <MiniMetric label="Shortage Links" value={row.shortage_linked_lines || 0} />
                          <MiniMetric label="Ordered" value={Number(row.ordered_qty || 0).toFixed(2)} />
                          <MiniMetric label="Received" value={Number(row.received_qty || 0).toFixed(2)} />
                          <MiniMetric label="Pending" value={Number(row.pending_qty || 0).toFixed(2)} />
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button onClick={() => setView({ type: "detail", id: row.id })}>Open PO</button>
                          {typeof onOpenGoodsReceipts === "function" ? (
                            <button onClick={() => onOpenGoodsReceipts({ create_from_po_id: row.id, receiving_bucket: "pending_receipt", receiving_q: row.po_number || "" })}>
                              Receive Goods
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  }

                  if (externalBucket === "qc_hold") {
                    return (
                      <div key={row.id} style={queueCardStyle()}>
                        <div style={queueHeaderStyle()}>
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 16 }}>{row.qc_number}</div>
                            <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                              {row.vendor_name} • {row.po_number} • {row.grn_number}
                            </div>
                          </div>
                          <DeskChip label={appearance.label} tone={appearance.tone} color={appearance.color} />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                          <MiniMetric label="Pending Hold Qty" value={Number(row.pending_hold_qty || 0).toFixed(2)} />
                          <MiniMetric label="PO" value={row.po_number || "—"} />
                          <MiniMetric label="GRN" value={row.grn_number || "—"} />
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {typeof onOpenGoodsReceipts === "function" ? <button onClick={() => onOpenGoodsReceipts({ receiving_bucket: "qc_hold", receiving_q: row.grn_number || row.po_number || "" })}>Open Receiving Desk</button> : null}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={row.id} style={queueCardStyle()}>
                      <div style={queueHeaderStyle()}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{row.claim_number}</div>
                          <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                            {row.vendor_name} • {row.po_number} • {row.grn_number}
                          </div>
                        </div>
                        <DeskChip label={appearance.label} tone={appearance.tone} color={appearance.color} />
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                        <MiniMetric label="Pending Qty" value={Number(row.pending_qty || 0).toFixed(2)} />
                        <MiniMetric label="Claim Date" value={fmtDate(row.claim_date)} />
                        <MiniMetric label="Status" value={row.claim_status || "—"} />
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {typeof onOpenGoodsReceipts === "function" ? <button onClick={() => onOpenGoodsReceipts({ receiving_bucket: "replacement_pending", receiving_q: row.claim_number || row.po_number || "" })}>Open Receiving Desk</button> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                No outside-processing dependency rows in this bucket right now.
              </div>
            )}
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Procurement Exceptions Desk" subtitle="Control demand, approval, ordering, and undelivered purchase backlog from one upstream queue">
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              {exceptionCards.map((card) => (
                <button key={card.key} onClick={() => setExceptionsBucket(card.key)} style={commandButtonStyle(exceptionsBucket === card.key)}>
                  <div style={{ fontSize: 12, opacity: 0.68 }}>{card.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: card.tone }}>{card.count}</div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>{card.qty > 0 ? `${card.qty.toFixed(2)} qty` : "Open queue"}</div>
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={exceptionsQuery}
                onChange={(e) => setExceptionsQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadExceptionsQueue({ q: exceptionsQuery }).catch(() => {});
                }}
                placeholder="Search job card, PR, PO, vendor, or department"
                style={{ ...inputStyle(), minWidth: 260, flex: "1 1 260px" }}
              />
              <button onClick={() => loadExceptionsQueue({ q: exceptionsQuery })} disabled={exceptionsLoading}>
                {exceptionsLoading ? "Refreshing..." : "Refresh Procurement Queue"}
              </button>
              <div style={{ fontSize: 12, color: "#58627a" }}>
                Undelivered PO qty: {Number(exceptionsSummary?.po_pending_receipt_qty || 0).toFixed(2)}
              </div>
            </div>

            <NoticeBanner tone="error" message={exceptionsError} />

            {exceptionsLoading ? (
              <div>Loading procurement exceptions…</div>
            ) : exceptionsRows.length ? (
              <div style={{ display: "grid", gap: 12 }}>
                {exceptionsBucket === "shortage_not_raised"
                  ? exceptionsRows.map((row) => (
                      <div key={row.shortage_action_id} style={queueCardStyle()}>
                        <div style={queueHeaderStyle()}>
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 16 }}>{row.job_card_number}</div>
                            <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                              {row.job_id || "No Job ID"} • Line {row.line_no} • {row.item_code || row.item_name || "Item"}
                            </div>
                          </div>
                          <DeskChip label={String(row.action_type || "shortage").toUpperCase()} tone="#fff2f3" color="#9f2042" />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                          <MiniMetric label="Shortage Qty" value={Number(row.shortage_qty || 0).toFixed(2)} />
                          <MiniMetric label="Department" value={row.department || "—"} />
                          <MiniMetric label="Action Date" value={fmtDate(row.action_date)} />
                          <MiniMetric label="Expected" value={fmtDate(row.expected_date)} />
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button onClick={() => raisePurchaseRequisitionFromShortage(row.shortage_action_id)}>Raise Purchase Requisition</button>
                        </div>
                      </div>
                    ))
                  : ["pr_submitted", "pr_approval_aged", "pr_not_ordered"].includes(exceptionsBucket)
                    ? exceptionsRows.map((row) => (
                        <div key={row.id} style={queueCardStyle()}>
                          <div style={queueHeaderStyle()}>
                            <div>
                              <div style={{ fontWeight: 800, fontSize: 16 }}>{row.requisition_number}</div>
                              <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                                {row.department || row.purpose || "No department"} • {fmtDate(row.required_by_date)} • {row.created_by_name || "—"}
                              </div>
                            </div>
                            <DeskChip label={String(row.requisition_status || "draft").toUpperCase()} tone={row.requisition_status === "submitted" ? "#eef4ff" : "#effcf3"} color={row.requisition_status === "submitted" ? "#234a8f" : "#0b7d45"} />
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                            <MiniMetric label="Age" value={`${Number(row.ageing_days || 0)}d`} />
                            <MiniMetric label="Pending Lines" value={row.pending_lines || 0} />
                            <MiniMetric label="Pending Qty" value={Number(row.pending_qty || 0).toFixed(2)} />
                            <MiniMetric label="Estimate" value={fmtMoney(row.estimated_total)} />
                            <MiniMetric label="Shortage Links" value={row.shortage_linked_lines || 0} />
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {typeof onOpenPurchaseRequisition === "function" ? <button onClick={() => onOpenPurchaseRequisition(Number(row.id))}>Open Requisition</button> : null}
                            {typeof onOpenApprovalDesk === "function" && row.requisition_status === "submitted" ? (
                              <button onClick={() => onOpenApprovalDesk({ doc_type: "purchase_requisition" })}>Open Approval Desk</button>
                            ) : null}
                            {row.requisition_status !== "submitted" ? (
                              <button
                                onClick={() => {
                                  setCreateMode("from_requisition");
                                  setCreatingRequisitionId(String(row.id));
                                }}
                              >
                                Start PO From Requisition
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))
                    : exceptionsRows.map((row) => {
                        const appearance = statusAppearance(row.po_status);
                        return (
                          <div key={row.id} style={queueCardStyle()}>
                            <div style={queueHeaderStyle()}>
                              <div>
                                <div style={{ fontWeight: 800, fontSize: 16 }}>{row.po_number}</div>
                                <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                                  {row.vendor_name} • {row.requisition_number || "Manual PO"} • {fmtDate(row.po_date)}
                                </div>
                              </div>
                              <DeskChip label={String(row.po_status || "draft").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Age" value={`${Number(row.ageing_days || 0)}d`} />
                              <MiniMetric label="Lines" value={row.line_count || 0} />
                              <MiniMetric label="Ordered Qty" value={Number(row.ordered_qty || 0).toFixed(2)} />
                              <MiniMetric label="Received Qty" value={Number(row.received_qty || 0).toFixed(2)} />
                              <MiniMetric label="Pending Qty" value={Number(row.pending_qty || 0).toFixed(2)} />
                              <MiniMetric label="Total" value={fmtMoney(row.grand_total_order, "")} />
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => setView({ type: "detail", id: row.id })}>Open PO</button>
                              {typeof onOpenApprovalDesk === "function" && row.po_status === "submitted" ? (
                                <button onClick={() => onOpenApprovalDesk({ doc_type: "purchase_order" })}>Open Approval Desk</button>
                              ) : null}
                              {typeof onOpenGoodsReceipts === "function" && Number(row.pending_qty || 0) > 0 ? (
                                <button
                                  onClick={() =>
                                    onOpenGoodsReceipts({
                                      create_from_po_id: row.id,
                                      receiving_bucket: "pending_receipt",
                                      receiving_q: row.po_number || "",
                                    })
                                  }
                                >
                                  Receive Goods
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
              </div>
            ) : (
              <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                No procurement rows in this exception bucket right now.
              </div>
            )}
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(320px, 430px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard
          title="Launch Purchase Order"
          subtitle="Treat approved requisitions as the default source of PO creation, and use manual mode only when there is no governed upstream demand."
          actions={<DeskChip label={createMode === "from_requisition" ? "REQUISITION-FIRST" : "MANUAL FALLBACK"} tone="#eef4ff" color="#234a8f" />}
        >
          <div style={{ display: "grid", gap: 12 }}>
            <FieldLabel label="Creation Mode">
              <select value={createMode} onChange={(e) => setCreateMode(e.target.value)} style={inputStyle()}>
                <option value="from_requisition">From Requisition</option>
                <option value="manual">Manual PO</option>
              </select>
            </FieldLabel>

            {createMode === "from_requisition" ? (
              <>
                <FieldLabel label="Approved Requisition">
                  <select value={creatingRequisitionId} onChange={(e) => setCreatingRequisitionId(e.target.value)} style={inputStyle()}>
                    <option value="">Select requisition</option>
                    {bootstrap.approved_requisitions.map((reqRow) => (
                      <option key={reqRow.id} value={String(reqRow.id)}>
                        {reqRow.requisition_number} - {reqRow.department || "Indent"} - pending {Number(reqRow.pending_qty || 0).toFixed(2)}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                <div style={{ display: "grid", gap: 8, maxHeight: 220, overflowY: "auto", paddingRight: 4 }}>
                  {bootstrap.approved_requisitions.slice(0, 6).map((reqRow) => (
                    <button
                      key={reqRow.id}
                      type="button"
                      onClick={() => {
                        setCreatingRequisitionId(String(reqRow.id));
                        if (!creatingVendorId && reqRow.suggested_vendor_id) setCreatingVendorId(String(reqRow.suggested_vendor_id));
                      }}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        border: creatingRequisitionId === String(reqRow.id) ? "1px solid #cfe0ff" : "1px solid #e6ebf3",
                        background: creatingRequisitionId === String(reqRow.id) ? "#eef4ff" : "#ffffff",
                        borderRadius: 16,
                        padding: 12,
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <strong>{reqRow.requisition_number}</strong>
                        <DeskChip label={`Pending ${Number(reqRow.pending_qty || 0).toFixed(2)}`} tone="#effcf3" color="#0b7d45" />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.74 }}>
                        {reqRow.department || "Indent"} • {reqRow.purpose || "No purpose captured"} • {fmtDate(reqRow.required_by_date)}
                      </div>
                    </button>
                  ))}
                  {!bootstrap.approved_requisitions.length ? (
                    <div style={{ padding: 12, borderRadius: 14, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                      No approved requisitions are waiting for PO conversion right now.
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            <FieldLabel label="Vendor">
              <select value={creatingVendorId} onChange={(e) => setCreatingVendorId(e.target.value)} style={inputStyle()}>
                <option value="">Select vendor</option>
                {bootstrap.vendors.map((v) => (
                  <option key={v.id} value={String(v.id)}>
                    {v.company_name}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <VendorQuickCreate
              onCreated={(vendor) => {
                setBootstrap((prev) => ({
                  ...prev,
                  vendors: [{ id: vendor.id, vendor_code: vendor.vendor_code, company_name: vendor.company_name, gstin: vendor.gstin, is_active: true }, ...(prev.vendors || []).filter((v) => Number(v.id) !== Number(vendor.id))],
                }));
                setCreatingVendorId(String(vendor.id));
                setNotice(`Vendor “${vendor.company_name}” created and selected.`);
              }}
            />

            <FieldLabel label="Currency">
              <select value={creatingCurrencyId} onChange={(e) => setCreatingCurrencyId(e.target.value)} style={inputStyle()}>
                <option value="">Select currency</option>
                {bootstrap.currencies.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.currency_code}
                  </option>
                ))}
              </select>
            </FieldLabel>

            <button onClick={createPurchaseOrder} disabled={creating || Boolean(poDraft)}>
              {creating
                ? "Creating..."
                : createMode === "from_requisition"
                  ? "Review PO draft"
                  : "Create Purchase Order"}
            </button>

            {poDraft ? (
              <ConfirmDraftCard
                draft={poDraft}
                onCancel={() => setPoDraft(null)}
                onConfirmed={(data) => confirmPoDraft(data)}
                onError={(e) => {
                  if (e?.data?.error === "INVALID_VENDOR" || e?.data?.error === "VENDOR_NOT_FOUND") {
                    setError("Select a valid vendor.");
                  } else if (e?.data?.error === "REQUISITION_NEEDS_APPROVAL") {
                    setError("Only approved requisitions can be converted to PO.");
                  } else if (e?.data?.error === "REQUISITION_FULLY_ORDERED") {
                    setError("The selected requisition has no pending quantity left for ordering.");
                  } else if (e?.data?.error === "UNAPPROVED_VENDOR") {
                    setError(e?.data?.detail || "The selected vendor is not approved for one or more component specifications.");
                  } else {
                    setError(e?.data?.error || "Failed to create purchase order.");
                  }
                  setPoDraft(null);
                }}
              />
            ) : null}

            <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, lineHeight: 1.7, color: "#58627a" }}>
              {createMode === "from_requisition"
                ? "Requisition mode drafts the PO for confirmation first — nothing is saved until you confirm the draft card."
                : "Manual mode stays available as a fallback, but it should be used only when there is no approved requisition driving the buy."}
            </div>
          </div>
        </DeskCard>

        <DeskCard title="Order Queue" subtitle="Card-based queue to avoid wide-table scanning and keep purchase work focused">
          <div style={{ display: "grid", gap: 12, maxHeight: 1040, overflowY: "auto", paddingRight: 4 }}>
            {loading ? (
              <div>Loading purchase orders…</div>
            ) : orders.length ? (
              orders.map((order) => {
                const appearance = statusAppearance(order.po_status);
                return (
                  <button
                    key={order.id}
                    onClick={() => setView({ type: "detail", id: order.id })}
                    style={{
                      all: "unset",
                      cursor: "pointer",
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
                        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>
                          {fmtDate(order.po_date)}
                        </div>
                        <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                          {order.po_number}
                        </div>
                      </div>
                      <DeskChip label={String(order.po_status || "draft").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                    </div>

                    <div style={{ fontSize: 14, fontWeight: 700 }}>{order.vendor_name || "No vendor"}</div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Total" value={fmtMoney(order.grand_total_order, order.order_currency_code)} />
                      <MiniMetric label="Currency" value={order.order_currency_code || "—"} />
                      <MiniMetric label="Intercompany" value={order.intercompany_sales_order_number || "Not linked"} />
                    </div>
                  </button>
                );
              })
            ) : (
              <EmptyState
                title="No purchase orders yet"
                body="Start with a manual PO or convert an approved requisition. Approval-aged buckets stay visible above."
              />
            )}
          </div>
        </DeskCard>
      </div>
    </div>
    <SlideOverDrawer
      open={view.type === "detail"}
      onClose={closeDetail}
      eyebrow="Purchase Order"
      title={view.type === "detail" ? `PO #${view.id}` : "Purchase Order"}
      subtitle="Exception queues stay open behind this drawer — close when the approval step is done."
      width={820}
    >
      {view.type === "detail" ? (
        <PurchaseOrderDetail
          id={view.id}
          embedded
          onBack={closeDetail}
          onOpenPurchaseRequisition={onOpenPurchaseRequisition}
          onOpenApprovalDesk={onOpenApprovalDesk}
          onOpenGoodsReceipts={onOpenGoodsReceipts}
        />
      ) : null}
    </SlideOverDrawer>
    </>
  );
}

function PurchaseOrderDetail({ id, onBack, onOpenPurchaseRequisition, onOpenApprovalDesk, onOpenGoodsReceipts, embedded = false }) {
  const { busy, isBusy, runLocked } = useSubmitLock();
  const [loading, setLoading] = useState(true);
  const saving = isBusy("save");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [approvalRemarks, setApprovalRemarks] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], currencies: [] });
  const [order, setOrder] = useState(null);
  const [approvalPreview, setApprovalPreview] = useState(null);
  const [landedCost, setLandedCost] = useState(null);
  const [vendorId, setVendorId] = useState("");
  const [currencyId, setCurrencyId] = useState("");
  const [poDate, setPoDate] = useState("");
  const [handlingFeeOverride, setHandlingFeeOverride] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [creatingIntercompany, setCreatingIntercompany] = useState(false);

  const totals = useMemo(() => calcTotals(lines), [lines]);
  const currentStatus = String(order?.po_status || "draft").toLowerCase();
  const canEditLines = currentStatus === "draft";

  function applyDetail(detail, boot = null) {
    if (boot) {
      setBootstrap({
        vendors: Array.isArray(boot?.vendors) ? boot.vendors : [],
        currencies: Array.isArray(boot?.currencies) ? boot.currencies : [],
      });
    }
    const header = detail?.purchase_order || null;
    setOrder(header);
    setApprovalPreview(detail?.approval_preview || null);
    setLandedCost(detail?.landed_cost || null);
    setLines(Array.isArray(detail?.lines) ? detail.lines.map((l) => ({ ...l })) : []);
    setVendorId(header?.vendor_id ? String(header.vendor_id) : "");
    setCurrencyId(header?.order_currency_id ? String(header.order_currency_id) : "");
    setPoDate(toIsoDate(header?.po_date));
    setHandlingFeeOverride(header?.handling_fee_override_order ?? "");
    setRemarks(header?.remarks || "");
  }

  useEffect(() => {
    setLoading(true);
    setError("");
    setNotice("");
    Promise.all([apiFetch("/purchase-orders/bootstrap"), apiFetch(`/purchase-orders/${id}`)])
      .then(([boot, detail]) => {
        applyDetail(detail, boot);
      })
      .catch((e) => setError(e?.data?.error || "Failed to load purchase order."))
      .finally(() => setLoading(false));
  }, [id]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const detail = await apiFetch(`/purchase-orders/${id}`);
      applyDetail(detail);
    } catch (e) {
      setError("Failed to refresh purchase order.");
    } finally {
      setLoading(false);
    }
  }

  async function save(targetStatus = null) {
    const nextStatus = String(targetStatus || currentStatus || "draft").toLowerCase();
    if (targetStatus === "draft" && currentStatus === "submitted" && !String(approvalRemarks || "").trim()) {
      setError("Remarks are required when sending a submitted PO back to draft.");
      toast("Remarks are required when sending a submitted PO back to draft.", "error");
      return;
    }
    await runLocked("save", async () => {
      setError("");
      setNotice("");
      try {
        const payload = {
          vendor_id: vendorId ? Number(vendorId) : undefined,
          order_currency_id: currencyId ? Number(currencyId) : undefined,
          po_status: nextStatus,
          po_date: poDate || undefined,
          remarks: remarks || null,
          handling_fee_override_order: handlingFeeOverride === "" ? null : Number(handlingFeeOverride),
          approval_remarks: approvalRemarks || null,
        };

        if (canEditLines) {
          payload.lines = lines.map((line) => ({
            purchase_requisition_line_id: line.purchase_requisition_line_id || null,
            product_id: line.product_id || null,
            component_specification_id: line.component_specification_id || null,
            item_code: line.item_code || null,
            item_name: line.item_name || null,
            line_description: line.line_description || null,
            hsn_no: line.hsn_no || null,
            uom: line.uom || null,
            qty: Number(line.qty || 0),
            unit_price_order: Number(line.unit_price_order || 0),
            gst_pct: Number(line.gst_pct || 0),
          }));
        }

        const data = await apiFetch(`/purchase-orders/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        applyDetail(data);
        const msg =
          nextStatus === currentStatus
            ? "Purchase order saved."
            : nextStatus === "submitted"
              ? "Purchase order submitted for approval."
              : nextStatus === "draft"
                ? "Purchase order sent back to draft."
                : nextStatus === "approved"
                  ? "Purchase order approved."
                  : nextStatus === "closed"
                    ? "Purchase order closed."
                    : nextStatus === "cancelled"
                      ? "Purchase order cancelled."
                      : "Purchase order updated.";
        setNotice(msg);
        toast(msg, "success");
        setApprovalRemarks("");
      } catch (e) {
        let message = "Failed to save purchase order.";
        if (e?.data?.error === "ORDER_NOT_EDITABLE") message = "Only draft purchase orders can be edited.";
        else if (e?.data?.error === "INVALID_VENDOR" || e?.data?.error === "VENDOR_NOT_FOUND") message = "Select a valid vendor.";
        else if (e?.data?.error === "UNAPPROVED_VENDOR") {
          message = e?.data?.detail || "The selected vendor is not approved for one or more component specifications.";
        }
        else if (e?.data?.error === "INVALID_QTY") message = "Qty must be greater than 0.";
        else if (e?.data?.error === "INVALID_PRICE") message = "Check unit price and GST %.";
        else if (e?.data?.error === "NEEDS_SUBMISSION") message = "Submit this purchase order before trying to approve it.";
        else if (e?.data?.error === "NEEDS_APPROVAL") message = "Approve this purchase order before trying to close it.";
        else if (e?.data?.error === "INVALID_TRANSITION") message = "That workflow transition is not allowed from the current PO state.";
        setError(message);
        toast(message, "error");
      }
    });
  }

  async function createIntercompanySalesOrder() {
    setCreatingIntercompany(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/purchase-orders/${id}/intercompany/create-sales-order`, { method: "POST" });
      const header = data?.purchase_order || order;
      setOrder(header);
      setNotice("Intercompany sales order created.");
    } catch (e) {
      const code = e?.data?.error;
      if (code === "PO_NEEDS_APPROVAL") setError("Approve the purchase order first before creating intercompany sales order.");
      else if (code === "INTERCOMPANY_VENDOR_MAPPING_MISSING") setError("Intercompany mapping missing for this vendor.");
      else if (code === "INTERCOMPANY_CUSTOMER_MAPPING_MISSING") setError("Intercompany mapping missing for the counterparty customer.");
      else if (code === "INTERCOMPANY_ACCESS_DENIED") setError("Your user is not linked to the counterparty company.");
      else if (code === "INTERCOMPANY_SO_ALREADY_LINKED") setError("This PO is already linked to a sales order.");
      else setError("Failed to create intercompany sales order.");
    } finally {
      setCreatingIntercompany(false);
    }
  }

  function updateLine(index, patch) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function searchProducts() {
    const q = searchTerm.trim();
    if (!q) return;
    setSearching(true);
    setError("");
    try {
      const data = await apiFetch(`/purchase-orders/product-lookup?q=${encodeURIComponent(q)}`);
      setSearchResults(Array.isArray(data?.products) ? data.products : []);
    } catch (e) {
      setError("Product lookup failed.");
    } finally {
      setSearching(false);
    }
  }

  function addProduct(product) {
    const unit = Number(product?.last_purchase_price ?? product?.list_price ?? 0);
    setLines((prev) => {
      const existingIndex = prev.findIndex((line) => Number(line.product_id || 0) === Number(product.id || 0));
      if (existingIndex >= 0) {
        return prev.map((line, index) =>
          index === existingIndex
            ? {
                ...line,
                qty: money(Number(line.qty || 0) + 1),
              }
            : line
        );
      }
      return [
        ...prev,
        {
          ...emptyLine(),
          product_id: product.id,
          item_code: product.item_code || "",
          item_name: product.item_name || "",
          line_description: product.item_name || "",
          uom: product.uom || "",
          hsn_no: product.hsn_no || "",
          gst_pct: Number(product.gst_pct || 0),
          unit_price_order: Number.isFinite(unit) ? unit : 0,
        },
      ];
    });
    setNotice(`${product.item_name || product.item_code || "Item"} added to the PO.`);
  }

  if (loading) return <div>Loading purchase order…</div>;

  if (!order) {
    return (
      <div>
        {!embedded ? <button onClick={onBack}>Back</button> : null}
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Purchase order not found."}</div>
      </div>
    );
  }

  const currencyCode =
    bootstrap.currencies.find((c) => String(c.id) === String(order.order_currency_id))?.currency_code ||
    order.order_currency_code ||
    "";

  const statusMeta = statusAppearance(currentStatus);
  const intercompanyReady = Boolean(order?.intercompany_sales_order_id);
  const hasSourceRequisition = Boolean(order?.purchase_requisition_id || order?.requisition_number);
  const canSubmit = currentStatus === "draft";
  const canApprove = currentStatus === "submitted" && Boolean(approvalPreview?.can_current_user_approve);
  const canSendBack = currentStatus === "submitted" && Boolean(approvalPreview?.can_manage_post_approval || approvalPreview?.can_current_user_approve);
  const canClose = currentStatus === "approved" && Boolean(approvalPreview?.can_manage_post_approval);
  const canCancel = !["closed", "cancelled"].includes(currentStatus) && (currentStatus !== "approved" || Boolean(approvalPreview?.can_manage_post_approval));
  const approvalLevelLabel = approvalPreview?.required_level
    ? `${Number(approvalPreview.current_level || 0)}/${Number(approvalPreview.required_level || 0)}`
    : "No policy";
  const nextApproverLabel =
    approvalPreview?.next_approver || (currentStatus === "submitted" ? "Approval routing pending" : "Submit first");

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Active Purchase Desk"
        title={order.po_number}
        description={`${order.vendor_name || "Vendor pending"} • ${order.requisition_number ? `From ${order.requisition_number} • ` : ""}${canEditLines ? "Draft desk is editable." : "Header remains visible while the line desk is read-only."}`}
        actions={
          <>
            {!embedded ? <button onClick={onBack}>Back</button> : null}
            <button onClick={() => setHistoryOpen(true)}>History / Remarks</button>
            <button onClick={refresh} disabled={loading || busy}>Refresh</button>
          </>
        }
        stats={[
          { label: "Status", value: String(currentStatus || "draft").toUpperCase(), tone: statusMeta.color },
          { label: "Approval", value: approvalLevelLabel, tone: "#8b5a00" },
          { label: "Line Count", value: lines.length, tone: "#143d7a" },
          { label: "Grand Total", value: fmtMoney(totals.grandTotal, currencyCode), tone: "#0a7a35" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(320px, 0.8fr)", gap: 16, alignItems: "start" }}>
        <DeskCard
          title="PO Snapshot"
          subtitle="Keep the commercial header compact while the draft lane stays editable and the source document remains visible."
          actions={<DeskChip label={String(currentStatus || "draft").toUpperCase()} tone={statusMeta.tone} color={statusMeta.color} />}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <FieldLabel label="Vendor">
              <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} disabled={!canEditLines} style={inputStyle(!canEditLines)}>
                <option value="">Select vendor</option>
                {bootstrap.vendors.map((v) => (
                  <option key={v.id} value={String(v.id)}>
                    {v.company_name}
                  </option>
                ))}
              </select>
              {canEditLines ? (
                <div style={{ marginTop: 8 }}>
                  <VendorQuickCreate
                    disabled={!canEditLines}
                    onCreated={(vendor) => {
                      setBootstrap((prev) => ({
                        ...prev,
                        vendors: [
                          { id: vendor.id, vendor_code: vendor.vendor_code, company_name: vendor.company_name, gstin: vendor.gstin, is_active: true },
                          ...(prev.vendors || []).filter((v) => Number(v.id) !== Number(vendor.id)),
                        ],
                      }));
                      setVendorId(String(vendor.id));
                    }}
                  />
                </div>
              ) : null}
            </FieldLabel>

            <FieldLabel label="Source Requisition">
              <input
                value={order.requisition_number || "Manual PO"}
                readOnly
                style={inputStyle(true)}
              />
            </FieldLabel>

            <FieldLabel label="PO Date">
              <input type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} disabled={!canEditLines} style={inputStyle(!canEditLines)} />
            </FieldLabel>

            <FieldLabel label="Currency">
              <select value={currencyId} onChange={(e) => setCurrencyId(e.target.value)} disabled={!canEditLines} style={inputStyle(!canEditLines)}>
                <option value="">Select currency</option>
                {bootstrap.currencies.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.currency_code}
                  </option>
                ))}
              </select>
            </FieldLabel>

            <FieldLabel label="Handling Fee Override (order currency)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={handlingFeeOverride}
                onChange={(e) => setHandlingFeeOverride(e.target.value)}
                disabled={!canEditLines}
                placeholder="AVL defaults when blank"
                style={inputStyle(!canEditLines)}
              />
            </FieldLabel>
          </div>

          <FieldLabel label="Remarks" style={{ marginTop: 12 }}>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={!canEditLines} rows={4} style={textAreaStyle(!canEditLines)} />
          </FieldLabel>
        </DeskCard>

        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard
            title="Workflow Actions"
            subtitle="Use explicit purchase actions instead of editing status directly, so approval and receiving follow-through stay visible."
            actions={<DeskChip label={canEditLines ? "DRAFT OPEN" : "CONTROLLED"} tone={canEditLines ? "#eef4ff" : "#f6f7fb"} color={canEditLines ? "#234a8f" : "#58627a"} />}
          >
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={() => save()} disabled={!canEditLines || saving} style={workflowButtonStyle({ border: "#cfe0ff", background: "#eef4ff", color: "#234a8f" }, canEditLines && !saving)}>
                  {saving && canEditLines ? "Saving..." : "Save Draft"}
                </button>
                <button type="button" onClick={() => save("submitted")} disabled={!canSubmit || saving || !lines.length} style={workflowButtonStyle({ border: "#cfe0ff", background: "#eef4ff", color: "#234a8f" }, canSubmit && !saving && lines.length > 0)}>
                  Submit For Approval
                </button>
                <button type="button" onClick={() => save("approved")} disabled={!canApprove || saving} style={workflowButtonStyle({ border: "#cbead6", background: "#effcf3", color: "#0b7d45" }, canApprove && !saving)}>
                  Approve
                </button>
                <button type="button" onClick={() => save("draft")} disabled={!canSendBack || saving} style={workflowButtonStyle({ border: "#f4d7a5", background: "#fff7ea", color: "#8b5a00" }, canSendBack && !saving)}>
                  Send Back To Draft
                </button>
                <button type="button" onClick={() => save("closed")} disabled={!canClose || saving} style={workflowButtonStyle({ border: "#cbead6", background: "#effcf3", color: "#0b7d45" }, canClose && !saving)}>
                  Mark Closed
                </button>
                <button type="button" onClick={() => save("cancelled")} disabled={!canCancel || saving} style={workflowButtonStyle({ border: "#f3d2d5", background: "#fff2f2", color: "#a52323" }, canCancel && !saving)}>
                  Cancel PO
                </button>
              </div>
              <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, lineHeight: 1.7, color: "#58627a" }}>
                {currentStatus === "draft"
                  ? "Draft stays editable. Save commercial changes before submitting so the approval amount and the downstream receiving desk reflect the latest PO."
                  : currentStatus === "submitted"
                    ? "Approval remarks are captured in history. Use them when approving or sending the PO back so the requester and approver lanes stay readable."
                    : currentStatus === "approved"
                      ? "Approved PO becomes the source for receiving. Close it only after procurement follow-through is complete."
                      : "This PO is now a downstream reference record."}
              </div>
              {currentStatus === "submitted" ? (
                <FieldLabel label="Approval Remarks">
                  <textarea
                    value={approvalRemarks}
                    onChange={(e) => setApprovalRemarks(e.target.value)}
                    rows={3}
                    style={textAreaStyle(false)}
                    placeholder="Capture approval note or send-back reason"
                  />
                </FieldLabel>
              ) : null}
            </div>
          </DeskCard>

          <DeskCard
            title="Approval State"
            subtitle="Requester-side visibility for the live PO approval lane."
            actions={<DeskChip label={approvalPreview?.requires_policy ? "POLICY DRIVEN" : "SCREEN CONTROL"} tone="#fff7ea" color="#8b5a00" />}
          >
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                <MiniMetric label="Current Level" value={approvalPreview?.current_level ?? 0} />
                <MiniMetric label="Required Level" value={approvalPreview?.required_level ?? 0} />
                <MiniMetric label="Next Level" value={approvalPreview?.next_level ?? 0} />
              </div>
              <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>Next approver</div>
                <div style={{ fontWeight: 700 }}>{nextApproverLabel}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {typeof onOpenApprovalDesk === "function" ? (
                  <button type="button" onClick={() => onOpenApprovalDesk({ doc_type: "purchase_order", q: order.po_number || "" })}>
                    Open Approval Desk
                  </button>
                ) : null}
                <button type="button" onClick={() => setHistoryOpen(true)}>
                  Review History
                </button>
              </div>
            </div>
          </DeskCard>

          <DeskCard title="Totals" subtitle="Preview only. Server values remain authoritative after save.">
            <div style={{ display: "grid", gap: 10 }}>
              <MiniMetric label="Subtotal" value={fmtMoney(totals.subtotal, currencyCode)} />
              <MiniMetric label="GST" value={fmtMoney(totals.taxTotal, currencyCode)} />
              <MiniMetric label="Grand Total" value={fmtMoney(totals.grandTotal, currencyCode)} />
            </div>
          </DeskCard>

          <DeskCard
            title="Landed Cost Preview"
            subtitle="Raw price plus AVL freight, import duty, and handling. Saved snapshots drive receipt valuation."
            actions={<DeskChip label={landedCost?.variance_threshold_pct != null ? `ALERT > ${landedCost.variance_threshold_pct}%` : "AVL AWARE"} tone="#effcf3" color="#0b7d45" />}
          >
            {landedCost ? (
              <div style={{ display: "grid", gap: 10 }}>
                <MiniMetric label="Raw unit price" value={fmtMoney(landedCost.totals?.raw_base, "BASE")} />
                <MiniMetric label="Freight add-on" value={fmtMoney(landedCost.totals?.freight_base, "BASE")} />
                <MiniMetric label="Import duty add-on" value={fmtMoney(landedCost.totals?.import_duty_base, "BASE")} />
                <MiniMetric label="Handling fees" value={fmtMoney(landedCost.totals?.handling_base, "BASE")} />
                <MiniMetric label="Final landed total" value={fmtMoney(landedCost.totals?.landed_base, "BASE")} />
                {landedCost.alternatives?.filter((item) => item.exceeds_threshold).slice(0, 3).map((item) => (
                  <div key={item.key} style={{ padding: 10, borderRadius: 12, background: "#fff7ea", color: "#8b5a00", fontSize: 12 }}>
                    {item.vendor_name}: {item.variance_pct > 0 ? "+" : ""}{Number(item.variance_pct || 0).toFixed(2)}% vs current vendor
                  </div>
                ))}
                {landedCost.lines?.some((line) => line.avl_status === "missing") ? (
                  <div style={{ padding: 10, borderRadius: 12, background: "#fff2f2", color: "#a52323", fontSize: 12 }}>
                    One or more governed lines do not have an active AVL profile for this vendor.
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="muted">Landed cost preview will appear after the PO has been saved.</div>
            )}
          </DeskCard>

          <DeskCard
            title="Follow-Through"
            subtitle="Keep the PO connected to its source requisition, approval lane, and receiving desk."
            actions={<DeskChip label={hasSourceRequisition ? "REQUISITION-LINKED" : "MANUAL FLOW"} tone={hasSourceRequisition ? "#eef4ff" : "#f6f7fb"} color={hasSourceRequisition ? "#234a8f" : "#58627a"} />}
          >
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, lineHeight: 1.7, color: "#58627a" }}>
                {hasSourceRequisition
                  ? `This PO continues the demand raised in ${order.requisition_number}. Keep source visibility intact so requisition-to-PO closure does not require desk hopping.`
                  : "This PO was raised manually. Use the approval and receiving desks to keep downstream work discoverable."}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {typeof onOpenPurchaseRequisition === "function" && order.purchase_requisition_id ? (
                  <button type="button" onClick={() => onOpenPurchaseRequisition(Number(order.purchase_requisition_id))}>
                    Open Source Requisition
                  </button>
                ) : null}
                {typeof onOpenGoodsReceipts === "function" ? (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenGoodsReceipts({
                        create_from_po_id: order.id,
                        receiving_bucket: "pending_receipt",
                        receiving_q: order.po_number || "",
                      })
                    }
                    disabled={!["approved", "closed"].includes(currentStatus)}
                  >
                    Receive Goods
                  </button>
                ) : null}
              </div>
            </div>
          </DeskCard>

          <DeskCard
            title="Intercompany"
            subtitle={intercompanyReady ? "Counterparty document already linked." : "Create the seller-side Sales Order after approval."}
            actions={
              intercompanyReady ? <DeskChip label="LINKED" tone="#effcf3" color="#0b7d45" /> : <DeskChip label="PENDING" tone="#fff6e8" color="#8b5a00" />
            }
          >
            {intercompanyReady ? (
              <div style={{ display: "grid", gap: 10 }}>
                <MiniMetric
                  label="Linked Sales Order"
                  value={order.intercompany_sales_order_number || `#${order.intercompany_sales_order_id}`}
                />
                <MiniMetric
                  label="Counterparty"
                  value={`${order.intercompany_company_code ? `${order.intercompany_company_code} - ` : ""}${order.intercompany_company_name || "—"}`}
                />
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, lineHeight: 1.7, color: "#58627a" }}>
                  Counterparty SO creation stays idempotent. If this PO is already linked, the existing SO is returned instead of creating duplicates.
                </div>
                <button
                  onClick={createIntercompanySalesOrder}
                  disabled={creatingIntercompany || String(order.po_status || "").toLowerCase() === "draft" || String(order.po_status || "").toLowerCase() === "submitted"}
                >
                  {creatingIntercompany ? "Creating..." : "Create Counterparty Sales Order"}
                </button>
              </div>
            )}
          </DeskCard>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Add Items" subtitle="Search products or append manual rows without leaving the desk. Duplicate product adds merge into the existing draft line.">
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search item code or name"
                style={{ ...inputStyle(!canEditLines), flex: 1, minWidth: 240 }}
                disabled={!canEditLines}
                onKeyDown={(e) => {
                  if (e.key === "Enter") searchProducts();
                }}
              />
              <button onClick={searchProducts} disabled={searching || !canEditLines}>
                {searching ? "Searching..." : "Search"}
              </button>
              <button onClick={() => setLines((prev) => [...prev, emptyLine()])} disabled={!canEditLines}>
                Add Manual Line
              </button>
            </div>

            {searchResults.length ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                {searchResults.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => addProduct(p)}
                    disabled={!canEditLines}
                    style={{
                      all: "unset",
                      cursor: canEditLines ? "pointer" : "default",
                      border: "1px solid #e7ebf3",
                      borderRadius: 16,
                      padding: 12,
                      background: "#ffffff",
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{p.item_code}</div>
                    <div style={{ fontSize: 13 }}>{p.item_name}</div>
                    <div style={{ fontSize: 12, opacity: 0.72 }}>UOM {p.uom || "—"} • GST {Number(p.gst_pct || 0)}%</div>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard
          title="PO Lines"
          subtitle={canEditLines ? "Draft line editor keeps manual-entry fields fully editable without forcing a wide table." : "Read-only view after the document leaves draft."}
          actions={<DeskChip label={canEditLines ? "EDITABLE" : "READ ONLY"} tone={canEditLines ? "#eef4ff" : "#f5f6fa"} color={canEditLines ? "#234a8f" : "#5d6782"} />}
        >
          {lines.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {lines.map((line, index) => {
                const qty = Number(line.qty || 0);
                const unit = Number(line.unit_price_order || 0);
                const amount = money((Number.isFinite(qty) ? qty : 0) * (Number.isFinite(unit) ? unit : 0));
                const label = line.item_code || line.item_name || "—";
                const desc = line.product_group_name || line.item_name || line.line_description || "—";
                const landedLine = landedCost?.lines?.find((candidate) => Number(candidate.id) === Number(line.id));
                return (
                  <div key={`${line.id || "new"}-${index}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#fcfdff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Line {index + 1}</div>
                        <div style={{ fontWeight: 800, marginTop: 4 }}>{label}</div>
                        <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4 }}>{desc}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        {line.purchase_requisition_line_id ? <DeskChip label="REQ-SOURCED" tone="#eef4ff" color="#234a8f" /> : <DeskChip label="MANUAL / CATALOG" tone="#f6f7fb" color="#58627a" />}
                        <DeskChip label={`GST ${Number(line.gst_pct || 0)}%`} tone="#fff6e8" color="#8b5a00" />
                        <DeskChip label={fmtMoney(amount, currencyCode)} tone="#eef4ff" color="#234a8f" />
                        {canEditLines ? <button onClick={() => removeLine(index)}>Remove</button> : null}
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12 }}>
                      <FieldLabel label="Item Code">
                        <input
                          value={line.item_code ?? ""}
                          disabled={!canEditLines}
                          onChange={(e) => updateLine(index, { item_code: e.target.value })}
                          style={inputStyle(!canEditLines)}
                        />
                      </FieldLabel>
                      <FieldLabel label="Item Name">
                        <input
                          value={line.item_name ?? ""}
                          disabled={!canEditLines}
                          onChange={(e) => updateLine(index, { item_name: e.target.value })}
                          style={inputStyle(!canEditLines)}
                        />
                      </FieldLabel>
                      <FieldLabel label="Description">
                        <input
                          value={line.line_description ?? ""}
                          disabled={!canEditLines}
                          onChange={(e) => updateLine(index, { line_description: e.target.value })}
                          style={inputStyle(!canEditLines)}
                        />
                      </FieldLabel>
                      <FieldLabel label="UOM">
                        <input
                          value={line.uom ?? ""}
                          disabled={!canEditLines}
                          onChange={(e) => updateLine(index, { uom: e.target.value })}
                          style={inputStyle(!canEditLines)}
                        />
                      </FieldLabel>
                      <FieldLabel label="HSN">
                        <input
                          value={line.hsn_no ?? ""}
                          disabled={!canEditLines}
                          onChange={(e) => updateLine(index, { hsn_no: e.target.value })}
                          style={inputStyle(!canEditLines)}
                        />
                      </FieldLabel>
                      <FieldLabel label="Qty">
                        <input
                          type="number"
                          value={line.qty ?? ""}
                          disabled={!canEditLines}
                          min="0"
                          step="0.01"
                          onChange={(e) => updateLine(index, { qty: e.target.value })}
                          style={inputStyle(!canEditLines)}
                        />
                      </FieldLabel>
                      <FieldLabel label="Unit Price">
                        <input
                          type="number"
                          value={line.unit_price_order ?? ""}
                          disabled={!canEditLines}
                          min="0"
                          step="0.01"
                          onChange={(e) => updateLine(index, { unit_price_order: e.target.value })}
                          style={inputStyle(!canEditLines)}
                        />
                      </FieldLabel>
                      <FieldLabel label="GST %">
                        <input
                          type="number"
                          value={line.gst_pct ?? ""}
                          disabled={!canEditLines}
                          min="0"
                          max="100"
                          step="0.01"
                          onChange={(e) => updateLine(index, { gst_pct: e.target.value })}
                          style={inputStyle(!canEditLines)}
                        />
                      </FieldLabel>
                    </div>
                    <div style={{ marginTop: 12, padding: 12, borderRadius: 14, background: landedLine?.avl_status === "missing" ? "#fff7ea" : "#f5fbf7", border: `1px solid ${landedLine?.avl_status === "missing" ? "#f2dfb0" : "#d3efdc"}` }}>
                      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#58627a", marginBottom: 8 }}>Landed cost breakdown</div>
                      {landedLine ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, fontSize: 12 }}>
                          <div><div className="muted">Raw unit</div><strong>{fmtMoney(landedLine.raw_unit_base, "BASE")}</strong></div>
                          <div><div className="muted">Freight + duty</div><strong>{fmtMoney(Number(landedLine.freight_unit_base || 0) + Number(landedLine.import_duty_unit_base || 0), "BASE")}</strong></div>
                          <div><div className="muted">Landed unit</div><strong>{fmtMoney(landedLine.landed_unit_base, "BASE")}</strong></div>
                          <div><div className="muted">Line total</div><strong>{fmtMoney(landedLine.landed_total_base, "BASE")}</strong></div>
                        </div>
                      ) : <div className="muted">Save this draft to calculate AVL add-ons.</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No lines yet. Search a product or add a manual row to begin the order.
            </div>
          )}
        </DeskCard>
      </div>
      <ApprovalHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docType="purchase_order"
        docId={id}
        remarks={approvalRemarks}
        onRemarksChange={setApprovalRemarks}
      />
    </div>
  );
}
