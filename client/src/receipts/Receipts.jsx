import { useEffect, useMemo, useState } from "react";
import SlideOverDrawer from "../components/SlideOverDrawer";
import { DeskCard, DeskChip, MiniMetric, NoticeBanner, PageHero, FieldLabel, getDeskStatusAppearance } from "../shared/joshUi";

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

function getErrorMessage(e, fallback) {
  if (e?.data?.detail) return String(e.data.detail);
  if (e?.data?.error) {
    const err = String(e.data.error);
    if (err === "SERVER_ERROR") return fallback || "Internal server error. Please try again or refresh.";
    return err;
  }
  return e?.message || fallback || "An unexpected error occurred.";
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

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function buildAllocationRows(openInvoices, allocations) {
  const map = new Map();
  for (const row of openInvoices || []) {
    map.set(Number(row.id), {
      customer_invoice_id: Number(row.id),
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      due_date: row.due_date,
      invoice_status: row.invoice_status,
      invoice_currency_code: row.invoice_currency_code,
      invoice_total_invoice: row.grand_total_invoice,
      invoice_outstanding_before_current: row.outstanding_invoice,
      allocated_invoice: "0",
    });
  }
  for (const row of allocations || []) {
    map.set(Number(row.customer_invoice_id), {
      customer_invoice_id: Number(row.customer_invoice_id),
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      due_date: row.due_date,
      invoice_status: row.invoice_status,
      invoice_currency_code: row.invoice_currency_code,
      invoice_total_invoice: row.invoice_total_invoice,
      invoice_outstanding_before_current: row.invoice_outstanding_before_current,
      allocated_invoice: String(row.allocated_invoice ?? 0),
    });
  }
  return Array.from(map.values()).sort((a, b) => String(a.invoice_number || "").localeCompare(String(b.invoice_number || "")));
}

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["posted"],
    warning: ["draft"],
    danger: ["cancelled"],
    fallbackTone: "#f6f7fb",
  });
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

const COMMERCIAL_FAILURE_BUCKETS = [
  ["all", "All NCRs"],
  ["new_ncr", "New NCR"],
  ["containment_due", "Containment due"],
  ["root_cause_due", "Root cause due"],
  ["action_overdue", "Action overdue"],
  ["verification_due", "Verification due"],
];

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

function commercialFailureAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "containment_due") return { bg: "#fff2f2", color: "#a52323", label: "Containment Due" };
  if (key === "action_overdue") return { bg: "#fff7ea", color: "#8b5a00", label: "Action Overdue" };
  if (key === "verification_due") return { bg: "#eefbf3", color: "#147a3d", label: "Verification Due" };
  if (key === "root_cause_due") return { bg: "#eef4ff", color: "#234a8f", label: "Root Cause Due" };
  if (key === "new_ncr") return { bg: "#f6f7fb", color: "#58627a", label: "New NCR" };
  return { bg: "#f6f7fb", color: "#58627a", label: "Commercial Failure" };
}

function getDisputeFailureBucket(row) {
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

function buildCommercialNcrForm(detail, current = {}) {
  return {
    sales_return_id:
      current.sales_return_id !== undefined && current.sales_return_id !== null && current.sales_return_id !== ""
        ? String(current.sales_return_id)
        : detail?.dispute?.sales_return_id
          ? String(detail.dispute.sales_return_id)
          : "",
    severity: current.severity || "medium",
    category: current.category || "other",
    qty_affected:
      current.qty_affected !== undefined && current.qty_affected !== null && current.qty_affected !== ""
        ? String(current.qty_affected)
        : detail?.dispute?.disputed_amount
          ? String(detail.dispute.disputed_amount)
          : "",
    defect_summary: current.defect_summary || detail?.dispute?.dispute_reason || "",
    containment_action: current.containment_action || "",
    containment_due_date: current.containment_due_date || detail?.dispute?.expected_resolution_date || "",
    remarks: current.remarks || detail?.dispute?.remarks || "",
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

export default function Receipts({ openReceiptId, launch, onConsumeLaunch, onOpenInvoice, onOpenCustomerInvoices, onCreateCreditNoteFromInvoice, onOpenSalesReturn, onOpenArDesk }) {
  const [view, setView] = useState({ type: "list" });
  const [showCollectionsTools, setShowCollectionsTools] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receipts, setReceipts] = useState([]);
  const [ageingCustomers, setAgeingCustomers] = useState([]);
  const [ageingInvoices, setAgeingInvoices] = useState([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsSummary, setAnalyticsSummary] = useState(null);
  const [analyticsRows, setAnalyticsRows] = useState([]);
  const [analyticsUsers, setAnalyticsUsers] = useState([]);
  const [analyticsQuery, setAnalyticsQuery] = useState("");
  const [analyticsBucket, setAnalyticsBucket] = useState("all");
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [reconciliationRows, setReconciliationRows] = useState([]);
  const [reconciliationQuery, setReconciliationQuery] = useState("");
  const [reconciliationBucket, setReconciliationBucket] = useState("all");
  const [reconciliationOpenCustomerId, setReconciliationOpenCustomerId] = useState(null);
  const [reconciliationDetailLoading, setReconciliationDetailLoading] = useState(false);
  const [reconciliationDetails, setReconciliationDetails] = useState({});
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditReady, setCreditReady] = useState(true);
  const [creditRows, setCreditRows] = useState([]);
  const [creditQuery, setCreditQuery] = useState("");
  const [creditBucket, setCreditBucket] = useState("all");
  const [creditEditorCustomerId, setCreditEditorCustomerId] = useState(null);
  const [creditDrafts, setCreditDrafts] = useState({});
  const [followupsLoading, setFollowupsLoading] = useState(false);
  const [followupsQuery, setFollowupsQuery] = useState("");
  const [followupsBucket, setFollowupsBucket] = useState("all");
  const [followupsReady, setFollowupsReady] = useState(true);
  const [followups, setFollowups] = useState([]);
  const [promisesLoading, setPromisesLoading] = useState(false);
  const [promisesQuery, setPromisesQuery] = useState("");
  const [promisesBucket, setPromisesBucket] = useState("all");
  const [promisesReady, setPromisesReady] = useState(true);
  const [promises, setPromises] = useState([]);
  const [followupEditingCustomerId, setFollowupEditingCustomerId] = useState(null);
  const [followupInvoiceLoadingCustomerId, setFollowupInvoiceLoadingCustomerId] = useState(null);
  const [followupInvoiceOptions, setFollowupInvoiceOptions] = useState({});
  const [followupHistoryCustomerId, setFollowupHistoryCustomerId] = useState(null);
  const [followupHistoryLoading, setFollowupHistoryLoading] = useState(false);
  const [followupHistoryRows, setFollowupHistoryRows] = useState({});
  const [followupDrafts, setFollowupDrafts] = useState({});
  const [disputesLoading, setDisputesLoading] = useState(false);
  const [disputesReady, setDisputesReady] = useState(true);
  const [disputes, setDisputes] = useState([]);
  const [disputesQuery, setDisputesQuery] = useState("");
  const [disputesStatus, setDisputesStatus] = useState("all");
  const [commercialFailureLoading, setCommercialFailureLoading] = useState(false);
  const [commercialFailureReady, setCommercialFailureReady] = useState(true);
  const [commercialFailureSummary, setCommercialFailureSummary] = useState(null);
  const [commercialFailureRows, setCommercialFailureRows] = useState([]);
  const [commercialFailureQuery, setCommercialFailureQuery] = useState("");
  const [commercialFailureBucket, setCommercialFailureBucket] = useState("all");
  const [commercialFailureDetailLoading, setCommercialFailureDetailLoading] = useState(false);
  const [commercialFailureEditorDisputeId, setCommercialFailureEditorDisputeId] = useState(null);
  const [commercialFailureDetails, setCommercialFailureDetails] = useState({});
  const [adjustmentsLoading, setAdjustmentsLoading] = useState(false);
  const [adjustmentsReady, setAdjustmentsReady] = useState(true);
  const [adjustments, setAdjustments] = useState([]);
  const [adjustmentsQuery, setAdjustmentsQuery] = useState("");
  const [adjustmentsStatus, setAdjustmentsStatus] = useState("draft");
  const [adjustmentsType, setAdjustmentsType] = useState("all");
  const [adjustmentFormOpen, setAdjustmentFormOpen] = useState(false);
  const [adjustmentCustomerQuery, setAdjustmentCustomerQuery] = useState("");
  const [adjustmentCustomerResults, setAdjustmentCustomerResults] = useState([]);
  const [adjustmentInvoiceLoading, setAdjustmentInvoiceLoading] = useState(false);
  const [adjustmentInvoiceOptions, setAdjustmentInvoiceOptions] = useState([]);
  const [adjustmentDraft, setAdjustmentDraft] = useState({
    customer_id: "",
    customer_name: "",
    customer_invoice_id: "",
    adjustment_type: "commercial_credit_note",
    adjustment_amount: "",
    reason: "",
    remarks: "",
  });
  const [disputeFormOpen, setDisputeFormOpen] = useState(false);
  const [disputeCustomerQuery, setDisputeCustomerQuery] = useState("");
  const [disputeCustomerResults, setDisputeCustomerResults] = useState([]);
  const [disputeInvoiceLoading, setDisputeInvoiceLoading] = useState(false);
  const [disputeInvoiceOptions, setDisputeInvoiceOptions] = useState([]);
  const [disputeDraft, setDisputeDraft] = useState({
    customer_id: "",
    customer_name: "",
    customer_invoice_id: "",
    dispute_reason: "",
    disputed_amount: "",
    expected_resolution_date: "",
    remarks: "",
  });
  const [listQuery, setListQuery] = useState("");
  const [listStatus, setListStatus] = useState("");
  const [listBucket, setListBucket] = useState("");
  const [listSource, setListSource] = useState("");

  const receiptStats = useMemo(() => {
    const list = Array.isArray(receipts) ? receipts : [];
    const total = list.length;
    const draft = list.filter((row) => String(row?.receipt_status || "").toLowerCase() === "draft").length;
    const posted = list.filter((row) => String(row?.receipt_status || "").toLowerCase() === "posted").length;
    const tallyImport = list.filter((row) => String(row?.receipt_source || "").toLowerCase() === "tally_import").length;
    const unappliedCashCount = list.filter(
      (row) =>
        String(row?.receipt_status || "").toLowerCase() === "posted" &&
        Number(row?.unallocated_amount_invoice || 0) > 0.0001 &&
        Number(row?.allocated_amount_invoice || 0) <= 0.0001
    ).length;
    const unallocatedAmount = list.reduce((sum, row) => sum + Number(row?.unallocated_amount_invoice || 0), 0);
    return { total, draft, posted, tallyImport, unappliedCashCount, unallocatedAmount };
  }, [receipts]);

  function ensureCreditDraft(customerId, row = null) {
    const key = String(customerId);
    const current = creditDrafts && typeof creditDrafts === "object" ? creditDrafts[key] : null;
    if (current) return current;
    const next = {
      reason: row?.latest_release?.reason || "",
      remarks: row?.latest_release?.remarks || "",
      expires_on:
        row?.latest_release?.expires_on ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      approved_upto_amount:
        row?.active_release?.approved_upto_amount ||
        row?.latest_release?.approved_upto_amount ||
        row?.exposure?.total_exposure ||
        "",
    };
    setCreditDrafts((prev) => ({ ...(prev && typeof prev === "object" ? prev : {}), [key]: next }));
    return next;
  }

  async function loadReconciliation(overrides = {}) {
    setReconciliationLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : reconciliationQuery;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : reconciliationBucket;
      if (qText) params.set("q", qText);
      if (bucket && bucket !== "all") params.set("bucket", bucket);
      params.set("limit", "200");
      const data = await apiFetch(`/reconciliation-desk/customers?${params.toString()}`);
      setReconciliationRows(Array.isArray(data?.customers) ? data.customers : []);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load reconciliation queue."));
      setReconciliationRows([]);
    } finally {
      setReconciliationLoading(false);
    }
  }

  async function loadReconciliationDetail(customerId) {
    setReconciliationDetailLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/reconciliation-desk/customers/${customerId}/detail`);
      setReconciliationDetails((prev) => ({ ...(prev && typeof prev === "object" ? prev : {}), [String(customerId)]: data?.detail || null }));
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load reconciliation detail."));
    } finally {
      setReconciliationDetailLoading(false);
    }
  }

  async function loadList(overrides = {}) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : listQuery;
      const status = overrides.status !== undefined ? overrides.status : listStatus;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : listBucket;
      const source = overrides.source !== undefined ? overrides.source : listSource;
      if (qText) params.set("q", qText);
      if (status) params.set("status", status);
      if (bucket) params.set("bucket", bucket);
      if (source) params.set("source", source);
      const data = await apiFetch(`/receipts${params.toString() ? `?${params.toString()}` : ""}`);
      setReceipts(Array.isArray(data?.receipts) ? data.receipts : []);
      setAgeingCustomers(Array.isArray(data?.ageing_customers) ? data.ageing_customers : []);
      setAgeingInvoices(Array.isArray(data?.ageing_invoices) ? data.ageing_invoices : []);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load receipts."));
    } finally {
      setLoading(false);
    }
  }

  async function loadAnalytics(overrides = {}) {
    setAnalyticsLoading(true);
    setError("");
    try {
      const qText = overrides.q !== undefined ? overrides.q : analyticsQuery;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : analyticsBucket;
      const [summaryData, customerData, userData] = await Promise.all([
        apiFetch("/collections-analytics/summary"),
        apiFetch(
          `/collections-analytics/customers?${new URLSearchParams({
            ...(qText ? { q: qText } : {}),
            ...(bucket && bucket !== "all" ? { bucket } : {}),
            limit: "100",
          }).toString()}`
        ),
        apiFetch("/collections-analytics/users?limit=12"),
      ]);
      setAnalyticsSummary(summaryData?.summary || null);
      setAnalyticsRows(Array.isArray(customerData?.customers) ? customerData.customers : []);
      setAnalyticsUsers(Array.isArray(userData?.users) ? userData.users : []);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load collections analytics."));
      setAnalyticsSummary(null);
      setAnalyticsRows([]);
      setAnalyticsUsers([]);
    } finally {
      setAnalyticsLoading(false);
    }
  }

  async function loadFollowups(overrides = {}) {
    setFollowupsLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : followupsQuery;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : followupsBucket;
      if (qText) params.set("q", qText);
      if (bucket && bucket !== "all") params.set("bucket", bucket);
      params.set("limit", "200");
      const data = await apiFetch(`/collections-desk/followups?${params.toString()}`);
      if (data?.followups_ready === false) {
        setFollowupsReady(false);
        setFollowups([]);
        return;
      }
      setFollowupsReady(true);
      setFollowups(Array.isArray(data?.followups) ? data.followups : []);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load follow-up queue."));
      setFollowupsReady(true);
      setFollowups([]);
    } finally {
      setFollowupsLoading(false);
    }
  }

  async function loadCreditControls(overrides = {}) {
    setCreditLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : creditQuery;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : creditBucket;
      if (qText) params.set("q", qText);
      if (bucket && bucket !== "all") params.set("bucket", bucket);
      params.set("limit", "200");
      const data = await apiFetch(`/credit-control/customers?${params.toString()}`);
      if (data?.ready === false) {
        setCreditReady(false);
        setCreditRows([]);
        return;
      }
      setCreditReady(true);
      setCreditRows(Array.isArray(data?.customers) ? data.customers : []);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load credit-control queue."));
      setCreditReady(true);
      setCreditRows([]);
    } finally {
      setCreditLoading(false);
    }
  }

  async function loadPromises(overrides = {}) {
    setPromisesLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : promisesQuery;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : promisesBucket;
      if (qText) params.set("q", qText);
      if (bucket && bucket !== "all") params.set("bucket", bucket);
      params.set("limit", "200");
      const data = await apiFetch(`/collections-desk/promises?${params.toString()}`);
      if (data?.followups_ready === false) {
        setPromisesReady(false);
        setPromises([]);
        return;
      }
      setPromisesReady(true);
      setPromises(Array.isArray(data?.promises) ? data.promises : []);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load promise tracker."));
      setPromisesReady(true);
      setPromises([]);
    } finally {
      setPromisesLoading(false);
    }
  }

  async function loadDisputes(overrides = {}) {
    setDisputesLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : disputesQuery;
      const status = overrides.status !== undefined ? overrides.status : disputesStatus;
      if (qText) params.set("q", qText);
      if (status && status !== "all") params.set("status", status);
      params.set("limit", "200");
      const data = await apiFetch(`/collections-desk/disputes?${params.toString()}`);
      if (data?.disputes_ready === false) {
        setDisputesReady(false);
        setDisputes([]);
        return;
      }
      setDisputesReady(true);
      setDisputes(Array.isArray(data?.disputes) ? data.disputes : []);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load disputes."));
      setDisputesReady(true);
      setDisputes([]);
    } finally {
      setDisputesLoading(false);
    }
  }

  async function loadCommercialFailures(overrides = {}) {
    setCommercialFailureLoading(true);
    setError("");
    try {
      const qText = overrides.q !== undefined ? overrides.q : commercialFailureQuery;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : commercialFailureBucket;
      const summaryParams = new URLSearchParams();
      if (qText) summaryParams.set("q", qText);
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "100");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/collections-desk/disputes-failure-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/collections-desk/disputes-failure-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      if (summaryData?.disputes_ready === false || queueData?.disputes_ready === false) {
        setCommercialFailureReady(false);
        setCommercialFailureSummary(null);
        setCommercialFailureRows([]);
        return;
      }
      setCommercialFailureReady(true);
      setCommercialFailureSummary(summaryData?.summary || null);
      setCommercialFailureRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load commercial failure queue."));
      setCommercialFailureReady(true);
      setCommercialFailureSummary(null);
      setCommercialFailureRows([]);
    } finally {
      setCommercialFailureLoading(false);
    }
  }

  async function loadCommercialFailureDetail(disputeId) {
    setCommercialFailureDetailLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/collections-desk/disputes/${disputeId}/ncr-detail`);
      setCommercialFailureDetails((prev) => ({
        ...(prev && typeof prev === "object" ? prev : {}),
        [String(disputeId)]: {
          dispute: data?.dispute || null,
          ncr_cases: Array.isArray(data?.ncr_cases) ? data.ncr_cases : [],
          capa_actions: Array.isArray(data?.capa_actions) ? data.capa_actions : [],
        },
      }));
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load commercial failure detail."));
    } finally {
      setCommercialFailureDetailLoading(false);
    }
  }

  async function loadAdjustments(overrides = {}) {
    setAdjustmentsLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : adjustmentsQuery;
      const status = overrides.status !== undefined ? overrides.status : adjustmentsStatus;
      const type = overrides.type !== undefined ? overrides.type : adjustmentsType;
      if (qText) params.set("q", qText);
      if (status && status !== "all") params.set("status", status);
      if (type && type !== "all") params.set("type", type);
      params.set("limit", "200");
      const data = await apiFetch(`/collections-desk/adjustments?${params.toString()}`);
      if (data?.adjustments_ready === false) {
        setAdjustmentsReady(false);
        setAdjustments([]);
        return;
      }
      setAdjustmentsReady(true);
      setAdjustments(Array.isArray(data?.adjustments) ? data.adjustments : []);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load AR adjustments."));
      setAdjustmentsReady(true);
      setAdjustments([]);
    } finally {
      setAdjustmentsLoading(false);
    }
  }

  async function searchDisputeCustomers() {
    setError("");
    try {
      const qp = disputeCustomerQuery.trim().length ? `?q=${encodeURIComponent(disputeCustomerQuery.trim())}` : "";
      const data = await apiFetch(`/customers${qp}`);
      setDisputeCustomerResults(Array.isArray(data?.customers) ? data.customers : []);
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to search customers.");
    }
  }

  async function searchAdjustmentCustomers() {
    setError("");
    try {
      const qp = adjustmentCustomerQuery.trim().length ? `?q=${encodeURIComponent(adjustmentCustomerQuery.trim())}` : "";
      const data = await apiFetch(`/customers${qp}`);
      setAdjustmentCustomerResults(Array.isArray(data?.customers) ? data.customers : []);
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to search customers.");
    }
  }

  async function loadDisputeInvoiceOptions(customerId) {
    if (!customerId) {
      setDisputeInvoiceOptions([]);
      return;
    }
    setDisputeInvoiceLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("customer_id", String(customerId));
      params.set("bucket", "outstanding");
      params.set("limit", "50");
      const data = await apiFetch(`/invoices?${params.toString()}`);
      setDisputeInvoiceOptions(Array.isArray(data?.invoices) ? data.invoices : []);
    } catch {
      setDisputeInvoiceOptions([]);
    } finally {
      setDisputeInvoiceLoading(false);
    }
  }

  async function loadAdjustmentInvoiceOptions(customerId) {
    if (!customerId) {
      setAdjustmentInvoiceOptions([]);
      return;
    }
    setAdjustmentInvoiceLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("customer_id", String(customerId));
      params.set("bucket", "outstanding");
      params.set("limit", "50");
      const data = await apiFetch(`/invoices?${params.toString()}`);
      setAdjustmentInvoiceOptions(Array.isArray(data?.invoices) ? data.invoices : []);
    } catch {
      setAdjustmentInvoiceOptions([]);
    } finally {
      setAdjustmentInvoiceLoading(false);
    }
  }

  async function saveDispute() {
    setError("");
    setNotice("");
    try {
      await apiFetch("/collections-desk/disputes", {
        method: "POST",
        body: JSON.stringify({
          customer_id: disputeDraft.customer_id ? Number(disputeDraft.customer_id) : null,
          customer_invoice_id: disputeDraft.customer_invoice_id ? Number(disputeDraft.customer_invoice_id) : null,
          dispute_reason: disputeDraft.dispute_reason || "",
          disputed_amount: Number(disputeDraft.disputed_amount || 0),
          expected_resolution_date: disputeDraft.expected_resolution_date || null,
          remarks: disputeDraft.remarks || "",
        }),
      });
      setNotice("Dispute created.");
      setDisputeFormOpen(false);
      setDisputeCustomerResults([]);
      setDisputeInvoiceOptions([]);
      setDisputeDraft({
        customer_id: "",
        customer_name: "",
        customer_invoice_id: "",
        dispute_reason: "",
        disputed_amount: "",
        expected_resolution_date: "",
        remarks: "",
      });
      await loadDisputes();
    } catch (e) {
      const code = e?.data?.error;
      if (code === "COLLECTION_DISPUTES_NOT_READY") setError("Apply migration 069_customer_collection_disputes_v1.sql to enable dispute tracking.");
      else if (code === "INVALID_CUSTOMER") setError("Select a customer.");
      else if (code === "INVALID_INVOICE") setError("Selected invoice is not valid for this customer.");
      else if (code === "INVALID_DISPUTE_REASON") setError("Enter a dispute reason.");
      else if (code === "INVALID_DISPUTED_AMOUNT") setError("Disputed amount must be greater than 0.");
      else setError(code || "Failed to create dispute.");
    }
  }

  async function updateDisputeStatus(disputeId, disputeStatus) {
    setError("");
    setNotice("");
    try {
      await apiFetch(`/collections-desk/disputes/${disputeId}/status`, {
        method: "POST",
        body: JSON.stringify({ dispute_status: disputeStatus }),
      });
      setNotice(
        disputeStatus === "resolved"
          ? "Dispute resolved."
          : disputeStatus === "escalated"
            ? "Dispute escalated."
            : "Dispute reopened."
      );
      await loadDisputes();
    } catch (e) {
      setError(getErrorMessage(e, "Failed to update dispute."));
    }
  }

  function mergeCommercialFailureDetail(disputeId, data) {
    const key = String(disputeId);
    const current = commercialFailureDetails && typeof commercialFailureDetails === "object" ? commercialFailureDetails[key] : null;
    const nextDetail = {
      dispute: data?.dispute || current?.dispute || null,
      ncr_cases: Array.isArray(data?.ncr_cases) ? data.ncr_cases : current?.ncr_cases || [],
      capa_actions: Array.isArray(data?.capa_actions) ? data.capa_actions : current?.capa_actions || [],
    };
    setCommercialFailureDetails((prev) => ({ ...(prev && typeof prev === "object" ? prev : {}), [key]: nextDetail }));
    return nextDetail;
  }

  async function openCommercialFailureEditor(disputeId) {
    setCommercialFailureEditorDisputeId(disputeId);
    const existing = commercialFailureDetails && typeof commercialFailureDetails === "object" ? commercialFailureDetails[String(disputeId)] : null;
    if (existing) return;
    await loadCommercialFailureDetail(disputeId);
  }

  async function createCommercialNcrCase(disputeId, payload) {
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/collections-desk/disputes/${disputeId}/ncr-cases`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      mergeCommercialFailureDetail(disputeId, data);
      setNotice("Commercial failure NCR raised.");
      await Promise.all([loadDisputes(), loadCommercialFailures()]);
      return data;
    } catch (e) {
      const code = e?.data?.error;
      if (code === "DEFECT_SUMMARY_REQUIRED") setError("Defect summary is required to raise NCR.");
      else setError(code || "Failed to raise commercial failure NCR.");
      throw e;
    }
  }

  async function saveCommercialNcrCase(disputeId, ncrId, payload) {
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/collections-desk/ncr-cases/${ncrId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      mergeCommercialFailureDetail(disputeId, data);
      setNotice("Commercial failure NCR / CAPA updated.");
      await Promise.all([loadDisputes(), loadCommercialFailures()]);
      return data;
    } catch (e) {
      setError(getErrorMessage(e, "Failed to update commercial failure NCR / CAPA."));
      throw e;
    }
  }

  async function saveAdjustment() {
    setError("");
    setNotice("");
    try {
      await apiFetch("/collections-desk/adjustments", {
        method: "POST",
        body: JSON.stringify({
          customer_id: adjustmentDraft.customer_id ? Number(adjustmentDraft.customer_id) : null,
          customer_invoice_id: adjustmentDraft.customer_invoice_id ? Number(adjustmentDraft.customer_invoice_id) : null,
          adjustment_type: adjustmentDraft.adjustment_type || "",
          adjustment_amount: Number(adjustmentDraft.adjustment_amount || 0),
          reason: adjustmentDraft.reason || "",
          remarks: adjustmentDraft.remarks || "",
        }),
      });
      setNotice("AR adjustment draft created.");
      setAdjustmentFormOpen(false);
      setAdjustmentCustomerResults([]);
      setAdjustmentInvoiceOptions([]);
      setAdjustmentDraft({
        customer_id: "",
        customer_name: "",
        customer_invoice_id: "",
        adjustment_type: "commercial_credit_note",
        adjustment_amount: "",
        reason: "",
        remarks: "",
      });
      await loadAdjustments();
    } catch (e) {
      const code = e?.data?.error;
      if (code === "AR_ADJUSTMENTS_NOT_READY") setError("Apply migration 072_customer_ar_adjustments_v1.sql to enable AR adjustments.");
      else if (code === "INVALID_CUSTOMER") setError("Select a customer.");
      else if (code === "INVALID_INVOICE") setError("Select a valid outstanding invoice.");
      else if (code === "INVALID_ADJUSTMENT_TYPE") setError("Select an adjustment type.");
      else if (code === "INVALID_ADJUSTMENT_AMOUNT") setError("Adjustment amount must be greater than 0.");
      else if (code === "INVALID_ADJUSTMENT_REASON") setError("Enter an adjustment reason.");
      else if (code === "INVOICE_ALREADY_SETTLED") setError("This invoice is already fully settled.");
      else if (code === "ADJUSTMENT_EXCEEDS_OUTSTANDING") setError("Adjustment amount cannot exceed invoice outstanding.");
      else setError(code || "Failed to create AR adjustment.");
    }
  }

  async function updateAdjustmentStatus(adjustmentId, adjustmentStatus) {
    setError("");
    setNotice("");
    try {
      await apiFetch(`/collections-desk/adjustments/${adjustmentId}/status`, {
        method: "POST",
        body: JSON.stringify({ adjustment_status: adjustmentStatus }),
      });
      setNotice(adjustmentStatus === "posted" ? "AR adjustment posted." : "AR adjustment cancelled.");
      await Promise.all([loadAdjustments(), loadList(), loadFollowups(), loadPromises(), loadDisputes()]);
    } catch (e) {
      const code = e?.data?.error;
      if (code === "ADJUSTMENT_EXCEEDS_OUTSTANDING") setError("Adjustment amount cannot exceed invoice outstanding.");
      else if (code === "ADJUSTMENT_NOT_EDITABLE") setError("Only draft adjustments can be posted or cancelled.");
      else setError(code || "Failed to update AR adjustment.");
    }
  }

  async function saveCreditReleaseRequest(customerId) {
    const draft = ensureCreditDraft(customerId);
    setError("");
    setNotice("");
    try {
      await apiFetch("/credit-control/releases", {
        method: "POST",
        body: JSON.stringify({
          customer_id: Number(customerId),
          reason: draft.reason || "",
          remarks: draft.remarks || "",
          expires_on: draft.expires_on || "",
        }),
      });
      setNotice("Credit release requested.");
      setCreditEditorCustomerId(null);
      await loadCreditControls();
    } catch (e) {
      const code = e?.data?.error;
      if (code === "CREDIT_CONTROL_NOT_READY") setError("Apply migration 073_customer_credit_control_v1.sql to enable credit control.");
      else if (code === "INVALID_REASON") setError("Enter a release reason.");
      else if (code === "INVALID_EXPIRY") setError("Select a valid release expiry date.");
      else if (code === "RELEASE_ALREADY_REQUESTED") setError("A release is already waiting for approval for this customer.");
      else setError(code || "Failed to request release.");
    }
  }

  async function updateCreditReleaseStatus(releaseId, customerId, nextStatus) {
    const draft = ensureCreditDraft(customerId);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/credit-control/releases/${releaseId}/status`, {
        method: "POST",
        body: JSON.stringify({
          release_status: nextStatus,
          approved_upto_amount: nextStatus === "approved" ? Number(draft.approved_upto_amount || 0) : null,
          expires_on: draft.expires_on || "",
        }),
      });
      setNotice(
        nextStatus === "approved"
          ? "Credit release approved."
          : nextStatus === "rejected"
            ? "Credit release rejected."
            : "Credit release cancelled."
      );
      setCreditEditorCustomerId(null);
      await loadCreditControls();
    } catch (e) {
      const code = e?.data?.error;
      if (code === "INVALID_APPROVED_LIMIT") setError("Enter an approved exposure limit greater than 0.");
      else if (code === "INVALID_EXPIRY") setError("Select a valid expiry date before approval.");
      else if (code === "SELF_APPROVAL_NOT_ALLOWED") setError("You requested this release — another approver must decide it.");
      else if (code === "APPROVER_RIGHTS_REQUIRED") setError("Approving needs Receipts / Invoices approve rights or Customer edit rights.");
      else setError(code || "Failed to update release.");
    }
  }

  function ensureFollowupDraft(customerId) {
    const key = String(customerId);
    const current = followupDrafts && typeof followupDrafts === "object" ? followupDrafts[key] : null;
    if (current) return current;
    const next = { action_type: "follow_up", expected_date: "", promised_amount: "", customer_invoice_id: "", remarks: "" };
    setFollowupDrafts((prev) => ({ ...(prev && typeof prev === "object" ? prev : {}), [key]: next }));
    return next;
  }

  async function loadFollowupInvoiceOptions(customerId) {
    const key = String(customerId);
    const existing = followupInvoiceOptions && typeof followupInvoiceOptions === "object" ? followupInvoiceOptions[key] : null;
    if (Array.isArray(existing)) return;
    setFollowupInvoiceLoadingCustomerId(customerId);
    try {
      const params = new URLSearchParams();
      params.set("customer_id", String(customerId));
      params.set("bucket", "outstanding");
      params.set("limit", "50");
      const data = await apiFetch(`/invoices?${params.toString()}`);
      const rows = Array.isArray(data?.invoices) ? data.invoices : [];
      setFollowupInvoiceOptions((prev) => ({ ...(prev && typeof prev === "object" ? prev : {}), [key]: rows }));
    } catch (e) {
      setFollowupInvoiceOptions((prev) => ({ ...(prev && typeof prev === "object" ? prev : {}), [key]: [] }));
    } finally {
      setFollowupInvoiceLoadingCustomerId(null);
    }
  }

  async function saveFollowupAction(customerId) {
    const key = String(customerId);
    const draft = followupDrafts && typeof followupDrafts === "object" ? followupDrafts[key] : null;
    if (!draft) return;
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
      setNotice(draft.action_type === "promise_to_pay" ? "Promise saved." : "Follow-up action saved.");
      setFollowupEditingCustomerId(null);
      await loadFollowups();
      await loadPromises();
    } catch (e) {
      if (e?.data?.error === "COLLECTION_ACTIONS_NOT_READY") setError("Apply migration 068_customer_collection_actions_v1.sql to enable follow-ups.");
      else if (e?.data?.error === "INVALID_PROMISED_AMOUNT") setError("Promised amount must be greater than 0.");
      else setError(getErrorMessage(e, "Failed to save follow-up action."));
    }
  }

  async function logCollectionAction(customerId, payload, successMessage) {
    setError("");
    setNotice("");
    try {
      await apiFetch(`/collections-desk/customers/${customerId}/actions`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setNotice(successMessage);
      await Promise.all([loadFollowups(), loadPromises()]);
    } catch (e) {
      setError(getErrorMessage(e, "Failed to save action."));
    }
  }

  async function loadFollowupHistory(customerId) {
    setFollowupHistoryLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/collections-desk/customers/${customerId}/actions?limit=50`);
      if (data?.followups_ready === false) {
        setFollowupsReady(false);
        setFollowupHistoryRows((prev) => ({ ...(prev && typeof prev === "object" ? prev : {}), [String(customerId)]: [] }));
        return;
      }
      const rows = Array.isArray(data?.actions) ? data.actions : [];
      setFollowupHistoryRows((prev) => ({ ...(prev && typeof prev === "object" ? prev : {}), [String(customerId)]: rows }));
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load follow-up history."));
    } finally {
      setFollowupHistoryLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") loadList();
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadAnalytics().catch(() => {});
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadReconciliation().catch(() => {});
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadFollowups().catch(() => {});
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadCreditControls().catch(() => {});
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadPromises().catch(() => {});
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadDisputes().catch(() => {});
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadAdjustments().catch(() => {});
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadAnalytics({ bucket: analyticsBucket }).catch(() => {});
  }, [analyticsBucket]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadReconciliation({ bucket: reconciliationBucket }).catch(() => {});
  }, [reconciliationBucket]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadFollowups({ bucket: followupsBucket }).catch(() => {});
  }, [followupsBucket]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadPromises({ bucket: promisesBucket }).catch(() => {});
  }, [promisesBucket]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadDisputes({ status: disputesStatus }).catch(() => {});
  }, [disputesStatus]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadCommercialFailures({ bucket: commercialFailureBucket }).catch(() => {});
  }, [commercialFailureBucket]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadAdjustments({ status: adjustmentsStatus, type: adjustmentsType }).catch(() => {});
  }, [adjustmentsStatus, adjustmentsType]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadCreditControls({ bucket: creditBucket }).catch(() => {});
  }, [creditBucket]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextQuery = typeof launch.q === "string" ? launch.q : "";
    const nextStatus = typeof launch.status === "string" ? launch.status : "";
    const nextBucket = typeof launch.bucket === "string" ? launch.bucket : "";
    const nextFollowupsQuery = typeof launch.followups_q === "string" ? launch.followups_q : "";
    const nextFollowupsBucket = typeof launch.followups_bucket === "string" ? launch.followups_bucket : "";
    const nextPromisesQuery = typeof launch.promises_q === "string" ? launch.promises_q : "";
    const nextPromisesBucket = typeof launch.promises_bucket === "string" ? launch.promises_bucket : "";
    const nextDisputesQuery = typeof launch.disputes_q === "string" ? launch.disputes_q : "";
    const nextDisputesStatus = typeof launch.disputes_status === "string" ? launch.disputes_status : "";
    const nextFailureQuery = typeof launch.failure_q === "string" ? launch.failure_q : "";
    const nextFailureBucket = typeof launch.failure_bucket === "string" ? launch.failure_bucket : "";
    const nextAdjustmentsQuery = typeof launch.adjustments_q === "string" ? launch.adjustments_q : "";
    const nextAdjustmentsStatus = typeof launch.adjustments_status === "string" ? launch.adjustments_status : "";
    const nextAdjustmentsType = typeof launch.adjustments_type === "string" ? launch.adjustments_type : "";
    const nextCreditQuery = typeof launch.credit_q === "string" ? launch.credit_q : "";
    const nextCreditBucket = typeof launch.credit_bucket === "string" ? launch.credit_bucket : "";
    const nextAnalyticsQuery = typeof launch.analytics_q === "string" ? launch.analytics_q : "";
    const nextAnalyticsBucket = typeof launch.analytics_bucket === "string" ? launch.analytics_bucket : "";
    const nextReconciliationQuery = typeof launch.recon_q === "string" ? launch.recon_q : "";
    const nextReconciliationBucket = typeof launch.recon_bucket === "string" ? launch.recon_bucket : "";
    setListQuery(nextQuery);
    setListStatus(nextStatus);
    setListBucket(nextBucket);
    if (nextFollowupsQuery) setFollowupsQuery(nextFollowupsQuery);
    if (nextFollowupsBucket) setFollowupsBucket(nextFollowupsBucket);
    if (nextPromisesQuery) setPromisesQuery(nextPromisesQuery);
    if (nextPromisesBucket) setPromisesBucket(nextPromisesBucket);
    if (nextDisputesQuery) setDisputesQuery(nextDisputesQuery);
    if (nextDisputesStatus) setDisputesStatus(nextDisputesStatus);
    if (nextFailureQuery) setCommercialFailureQuery(nextFailureQuery);
    if (nextFailureBucket) setCommercialFailureBucket(nextFailureBucket);
    if (nextAdjustmentsQuery) setAdjustmentsQuery(nextAdjustmentsQuery);
    if (nextAdjustmentsStatus) setAdjustmentsStatus(nextAdjustmentsStatus);
    if (nextAdjustmentsType) setAdjustmentsType(nextAdjustmentsType);
    if (nextCreditQuery) setCreditQuery(nextCreditQuery);
    if (nextCreditBucket) setCreditBucket(nextCreditBucket);
    if (nextAnalyticsQuery) setAnalyticsQuery(nextAnalyticsQuery);
    if (nextAnalyticsBucket) setAnalyticsBucket(nextAnalyticsBucket);
    if (nextReconciliationQuery) setReconciliationQuery(nextReconciliationQuery);
    if (nextReconciliationBucket) setReconciliationBucket(nextReconciliationBucket);
    if (view.type !== "list") setView({ type: "list" });
    loadList({ q: nextQuery, status: nextStatus, bucket: nextBucket }).catch(() => {});
    if (nextAnalyticsQuery || nextAnalyticsBucket) {
      loadAnalytics({
        q: nextAnalyticsQuery || analyticsQuery,
        bucket: nextAnalyticsBucket || analyticsBucket,
      }).catch(() => {});
    }
    if (nextReconciliationQuery || nextReconciliationBucket) {
      loadReconciliation({
        q: nextReconciliationQuery || reconciliationQuery,
        bucket: nextReconciliationBucket || reconciliationBucket,
      }).catch(() => {});
    }
    if (nextFollowupsQuery || nextFollowupsBucket) {
      loadFollowups({
        q: nextFollowupsQuery || followupsQuery,
        bucket: nextFollowupsBucket || followupsBucket,
      }).catch(() => {});
    }
    if (nextPromisesQuery || nextPromisesBucket) {
      loadPromises({
        q: nextPromisesQuery || promisesQuery,
        bucket: nextPromisesBucket || promisesBucket,
      }).catch(() => {});
    }
    if (nextDisputesQuery || nextDisputesStatus) {
      loadDisputes({
        q: nextDisputesQuery || disputesQuery,
        status: nextDisputesStatus || disputesStatus,
      }).catch(() => {});
    }
    if (nextFailureQuery || nextFailureBucket) {
      loadCommercialFailures({
        q: nextFailureQuery || commercialFailureQuery,
        bucket: nextFailureBucket || commercialFailureBucket,
      }).catch(() => {});
    }
    if (nextAdjustmentsQuery || nextAdjustmentsStatus || nextAdjustmentsType) {
      loadAdjustments({
        q: nextAdjustmentsQuery || adjustmentsQuery,
        status: nextAdjustmentsStatus || adjustmentsStatus,
        type: nextAdjustmentsType || adjustmentsType,
      }).catch(() => {});
    }
    if (nextCreditQuery || nextCreditBucket) {
      loadCreditControls({
        q: nextCreditQuery || creditQuery,
        bucket: nextCreditBucket || creditBucket,
      }).catch(() => {});
    }
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    const id = Number(openReceiptId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
  }, [openReceiptId]);

  const closeDetail = () => {
    setView({ type: "list" });
    loadList().catch(() => {});
  };

  const closeCreate = () => {
    setView({ type: "list" });
  };

  return (
    <>
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Cash & allocation desk"
        title="Receipts"
        description="Post customer receipts, allocate cash to open invoices, and clear unapplied balances. Day-to-day collections, ageing follow-ups, and credit release live on AR Desk."
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={() => setView({ type: "create" })}>
              Create Receipt
            </button>
            <input
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder="Search receipt / customer"
              style={{ minWidth: 220, ...inputStyle() }}
            />
            <select value={listStatus} onChange={(e) => setListStatus(e.target.value)} style={inputStyle()}>
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="posted">Posted</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select value={listBucket} onChange={(e) => setListBucket(e.target.value)} style={inputStyle()}>
              <option value="">All buckets</option>
              <option value="pending_allocation">Pending allocation</option>
              <option value="unapplied_cash">Unapplied cash</option>
            </select>
            <select value={listSource} onChange={(e) => setListSource(e.target.value)} style={inputStyle()}>
              <option value="">All sources</option>
              <option value="erp">Josh ERP</option>
              <option value="tally_import">Tally Import</option>
            </select>
            <button onClick={loadList} disabled={loading}>{loading ? "Refreshing..." : "Refresh Queue"}</button>
          </div>
        }
        stats={[
          { label: "Receipts In View", value: receiptStats.total, tone: "#143d7a" },
          { label: "Draft", value: receiptStats.draft, tone: "#8b5a00" },
          { label: "Posted", value: receiptStats.posted, tone: "#0a7a35" },
          { label: "Tally Import", value: receiptStats.tallyImport, tone: "#0f766e" },
          { label: "Unapplied Cash", value: receiptStats.unappliedCashCount, tone: "#234a8f" },
          { label: "Unallocated Amt", value: fmtMoney(receiptStats.unallocatedAmount), tone: "#5d4b8a" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div
        style={{
          marginTop: 16,
          padding: "12px 14px",
          borderRadius: 14,
          border: "1px solid #dbe7ff",
          background: "#f5f9ff",
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        <span>
          Collections, ageing follow-ups, and credit release are maintained on <strong>AR Desk</strong>.
        </span>
        {typeof onOpenArDesk === "function" ? (
          <button type="button" onClick={() => onOpenArDesk({})}>
            Open AR Desk
          </button>
        ) : null}
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={() => setShowCollectionsTools((prev) => !prev)}>
          {showCollectionsTools ? "Hide legacy collections tools (prefer AR Desk)" : "Show legacy collections tools (prefer AR Desk)"}
        </button>
        {!showCollectionsTools ? (
          <span style={{ fontSize: 13, opacity: 0.72 }}>Legacy ageing and collections panels are collapsed — use AR Desk for daily recovery work.</span>
        ) : null}
      </div>

      {showCollectionsTools ? (
      <>
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16, opacity: 0.92 }}>
        <DeskCard title="Ageing By Customer" subtitle="Quick collection posture with direct statement access">
          {ageingCustomers.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {ageingCustomers.slice(0, 8).map((row) => (
                <div key={row.customer_id} style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 12, background: "#fcfdff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div style={{ fontWeight: 700 }}>{row.customer_name}</div>
                    <a href={`/receipts/customer/${row.customer_id}/statement/pdf`} target="_blank" rel="noreferrer" style={{ color: "#0f4aa1", textDecoration: "none", fontSize: 13 }}>
                      Statement PDF
                    </a>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8, marginTop: 10 }}>
                    <MiniMetric label="0-30" value={fmtMoney(row.current_bucket)} />
                    <MiniMetric label="31-60" value={fmtMoney(row.bucket_31_60)} />
                    <MiniMetric label="61-90" value={fmtMoney(row.bucket_61_90)} />
                    <MiniMetric label="90+" value={fmtMoney(row.bucket_90_plus)} />
                    <MiniMetric label="Total" value={fmtMoney(row.total_outstanding)} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No outstanding ageing right now.
            </div>
          )}
        </DeskCard>

        <DeskCard title="Most Overdue Invoices" subtitle="Open the invoice directly from the collection watchlist">
          {ageingInvoices.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {ageingInvoices.slice(0, 8).map((row) => (
                <button
                  key={row.id}
                  onClick={() => onOpenInvoice?.(row.id)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e7ebf3",
                    borderRadius: 16,
                    padding: 12,
                    background: "#fcfdff",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 700 }}>{row.invoice_number}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {row.customer_po_number ? <DeskChip label={`Cust PO ${row.customer_po_number}`} tone="#fff7ea" color="#9a5a00" /> : null}
                      <DeskChip label={`${row.ageing_days || 0} DAYS`} tone="#fff6e8" color="#8b5a00" />
                    </div>
                  </div>
                  <div style={{ fontSize: 13 }}>{row.customer_name}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                    <MiniMetric label="Outstanding" value={fmtMoney(row.outstanding_invoice, row.invoice_currency_code)} />
                    <MiniMetric label="Currency" value={row.invoice_currency_code || "—"} />
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No overdue invoices.
            </div>
          )}
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Collections Performance" subtitle="Watch broken promises, stale follow-ups, repeat disputes, and adjustment-heavy accounts from one analytics surface">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <input
              value={analyticsQuery}
              onChange={(e) => setAnalyticsQuery(e.target.value)}
              placeholder="Search customer / code"
              style={{ minWidth: 240, ...inputStyle() }}
            />
            <select value={analyticsBucket} onChange={(e) => setAnalyticsBucket(e.target.value)} style={inputStyle()}>
              <option value="all">All accounts</option>
              <option value="broken_promises">Broken promises</option>
              <option value="stale_followups">Stale follow-ups</option>
              <option value="repeat_disputes">Repeat disputes</option>
              <option value="adjustment_heavy">Adjustment heavy</option>
              <option value="matching_gap">Matching gaps</option>
            </select>
            <button type="button" onClick={() => loadAnalytics().catch(() => {})} disabled={analyticsLoading}>
              {analyticsLoading ? "Loading..." : "Refresh Analytics"}
            </button>
          </div>

          {analyticsSummary ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8, marginBottom: 12 }}>
              <MiniMetric label="Outstanding" value={fmtMoney(analyticsSummary.outstanding_amount)} />
              <MiniMetric label="Overdue" value={fmtMoney(analyticsSummary.overdue_amount)} />
              <MiniMetric label="Broken Promises" value={analyticsSummary.broken_promises || 0} />
              <MiniMetric label="Stale Follow-ups" value={analyticsSummary.stale_followups || 0} />
              <MiniMetric label="Repeat Disputes" value={analyticsSummary.repeat_disputes || 0} />
              <MiniMetric label="Matching Gaps" value={analyticsSummary.matching_gap || 0} />
            </div>
          ) : null}

          {analyticsLoading ? (
            <div>Loading analytics…</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
              <div style={{ display: "grid", gap: 12 }}>
                {analyticsRows.length ? (
                  analyticsRows.map((row) => (
                    <div key={row.customer_id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff", boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 15 }}>{row.customer_name}</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                            <DeskChip label={`Outstanding ${fmtMoney(row.outstanding_amount)}`} tone="#eef4ff" color="#234a8f" />
                            <DeskChip label={`Overdue ${fmtMoney(row.overdue_amount)}`} tone={Number(row.overdue_amount || 0) > 0.0001 ? "#fff6e8" : "#eefaf1"} color={Number(row.overdue_amount || 0) > 0.0001 ? "#8b5a00" : "#0a7a35"} />
                            {Number(row.broken_promises || 0) > 0 ? <DeskChip label={`${row.broken_promises} broken promise`} tone="#fff2f2" color="#b42318" /> : null}
                            {row.stale_followup ? <DeskChip label="Stale follow-up" tone="#fff6e8" color="#8b5a00" /> : null}
                            {Number(row.open_disputes || 0) > 0 ? <DeskChip label={`${row.open_disputes} open disputes`} tone="#fff2f2" color="#b42318" /> : null}
                            {Number(row.posted_adjustment_amount || 0) > 0.0001 ? <DeskChip label={`Adjusted ${fmtMoney(row.posted_adjustment_amount)}`} tone="#fff8ea" color="#8b5a00" /> : null}
                            {Number(row.matching_gap_amount || 0) > 0.0001 ? <DeskChip label={`Gap ${fmtMoney(row.matching_gap_amount)}`} tone="#eef4ff" color="#234a8f" /> : null}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" onClick={() => onOpenCustomerInvoices?.(row.customer_id, row.customer_name)}>
                            Open invoices
                          </button>
                          <a
                            href={`/receipts/customer/${row.customer_id}/statement/pdf`}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "8px 12px",
                              borderRadius: 12,
                              border: "1px solid #d8dfeb",
                              background: "#ffffff",
                              color: "#0f4aa1",
                              textDecoration: "none",
                              fontSize: 13,
                              fontWeight: 700,
                            }}
                          >
                            Statement PDF
                          </a>
                        </div>
                      </div>
                      <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, opacity: 0.8 }}>
                        Queue bucket: <strong>{String(row.queue_bucket || "clear").replace(/_/g, " ")}</strong>
                        {row.next_followup_date ? ` • next follow-up ${fmtDate(row.next_followup_date)}` : ""}
                        {row.last_action_date ? ` • last activity ${fmtDate(row.last_action_date)}` : ""}
                        {row.latest_promised_amount ? ` • latest promise ${fmtMoney(row.latest_promised_amount)}` : ""}
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                    No customers in this analytics bucket.
                  </div>
                )}
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62 }}>User activity</div>
                {analyticsUsers.length ? (
                  analyticsUsers.map((row) => (
                    <div key={row.user_id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff", boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
                      <div style={{ fontWeight: 800, fontSize: 15 }}>{row.user_name}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 10 }}>
                        <MiniMetric label="Actions 30d" value={row.action_count || 0} />
                        <MiniMetric label="Follow-ups" value={row.followups_logged || 0} />
                        <MiniMetric label="Promises" value={row.promises_logged || 0} />
                        <MiniMetric label="Broken" value={row.broken_promises || 0} />
                        <MiniMetric label="Disputes closed" value={row.dispute_resolved_count || 0} />
                        <MiniMetric label="Adj posted" value={row.adjustments_posted || 0} />
                      </div>
                      {Number(row.adjustments_posted_amount || 0) > 0.0001 ? (
                        <div style={{ marginTop: 8, fontSize: 13, opacity: 0.78 }}>
                          Posted adjustment amount {fmtMoney(row.adjustments_posted_amount)}
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                    No user activity yet.
                  </div>
                )}
              </div>
            </div>
          )}
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Reconciliation Desk" subtitle="Explain customer balance, isolate matching gaps, and jump directly into invoices, receipts, disputes, and AR adjustments">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <input
              value={reconciliationQuery}
              onChange={(e) => setReconciliationQuery(e.target.value)}
              placeholder="Search customer / code"
              style={{ minWidth: 240, ...inputStyle() }}
            />
            <select value={reconciliationBucket} onChange={(e) => setReconciliationBucket(e.target.value)} style={inputStyle()}>
              <option value="all">All accounts</option>
              <option value="matching_gap">Matching gap</option>
              <option value="unapplied_cash">Unapplied cash</option>
              <option value="partial_settlement">Partially settled invoices</option>
              <option value="old_unapplied">Old unapplied cash (&gt;7d)</option>
              <option value="balance_disagreement">Balance variance</option>
            </select>
            <button type="button" onClick={() => loadReconciliation().catch(() => {})} disabled={reconciliationLoading}>
              {reconciliationLoading ? "Loading..." : "Refresh Reconciliation"}
            </button>
          </div>

          {reconciliationLoading ? (
            <div>Loading reconciliation desk…</div>
          ) : reconciliationRows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {reconciliationRows.map((row) => {
                const isOpen = String(reconciliationOpenCustomerId || "") === String(row.customer_id || "");
                const detail = reconciliationDetails && typeof reconciliationDetails === "object" ? reconciliationDetails[String(row.customer_id)] : null;
                return (
                  <div key={row.customer_id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff", boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 15 }}>{row.customer_name}</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                          <DeskChip label={`Open AR ${fmtMoney(row.open_invoice_amount)}`} tone="#eef4ff" color="#234a8f" />
                          <DeskChip label={`Unapplied ${fmtMoney(row.unapplied_cash_amount)}`} tone={Number(row.unapplied_cash_amount || 0) > 0.0001 ? "#fff8ea" : "#eefaf1"} color={Number(row.unapplied_cash_amount || 0) > 0.0001 ? "#8b5a00" : "#0a7a35"} />
                          <DeskChip label={`Net balance ${fmtMoney(row.net_customer_balance)}`} tone="#f6f7fb" color="#58627a" />
                          <DeskChip label={`${row.partially_allocated_invoice_count || 0} partial invoices`} tone="#fff6e8" color="#8b5a00" />
                          {Number(row.oldest_unapplied_days || 0) > 0 ? <DeskChip label={`Oldest unapplied ${row.oldest_unapplied_days}d`} tone="#fff2f2" color="#b42318" /> : null}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => onOpenCustomerInvoices?.(row.customer_id, row.customer_name)}>
                          Open invoices
                        </button>
                        <a
                          href={`/receipts/customer/${row.customer_id}/statement/pdf`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "8px 12px",
                            borderRadius: 12,
                            border: "1px solid #d8dfeb",
                            background: "#ffffff",
                            color: "#0f4aa1",
                            textDecoration: "none",
                            fontSize: 13,
                            fontWeight: 700,
                          }}
                        >
                          Statement PDF
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            if (isOpen) {
                              setReconciliationOpenCustomerId(null);
                              return;
                            }
                            setReconciliationOpenCustomerId(row.customer_id);
                            loadReconciliationDetail(row.customer_id).catch(() => {});
                          }}
                        >
                          {isOpen ? "Hide Detail" : "Explain Balance"}
                        </button>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, opacity: 0.78, fontSize: 13, lineHeight: 1.6 }}>
                      Queue bucket: <strong>{String(row.queue_bucket || "clear").replace(/_/g, " ")}</strong>
                      {Number(row.unapplied_cash_amount || 0) > 0.0001 && Number(row.open_invoice_amount || 0) > 0.0001
                        ? " — cash is posted but still not fully matched against open invoices."
                        : Number(row.partially_allocated_invoice_count || 0) > 0
                          ? " — one or more invoices are only partly settled."
                          : " — customer is currently balanced across the matching model."}
                    </div>

                    {isOpen ? (
                      <div style={{ marginTop: 12, borderRadius: 16, border: "1px solid #edf1f7", background: "#fbfcff", padding: 12, display: "grid", gap: 12 }}>
                        {reconciliationDetailLoading && !detail ? (
                          <div>Loading reconciliation detail…</div>
                        ) : detail ? (
                          <>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8 }}>
                              <MiniMetric label="Invoiced" value={fmtMoney(detail.customer?.total_invoiced)} />
                              <MiniMetric label="Received" value={fmtMoney(detail.customer?.total_received)} />
                              <MiniMetric label="Credited" value={fmtMoney(detail.customer?.total_credited)} />
                              <MiniMetric label="Adjusted" value={fmtMoney(detail.customer?.total_adjusted)} />
                              <MiniMetric label="Net AR" value={fmtMoney(detail.customer?.net_customer_balance)} />
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 12 }}>
                              <div style={{ display: "grid", gap: 10 }}>
                                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62 }}>Ledger preview</div>
                                {(detail.ledger_preview || []).length ? (
                                  (detail.ledger_preview || []).map((item, idx) => (
                                    <div key={`${item.reference_no}-${idx}`} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                                        <div style={{ fontWeight: 700 }}>{item.reference_no || item.txn_type}</div>
                                        <div style={{ fontSize: 12, opacity: 0.7 }}>{fmtDate(item.txn_date)}</div>
                                      </div>
                                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                                        <DeskChip label={item.txn_type} tone="#eef4ff" color="#234a8f" />
                                        {Number(item.debit || 0) > 0 ? <DeskChip label={`Debit ${fmtMoney(item.debit)}`} tone="#fff8ea" color="#8b5a00" /> : null}
                                        {Number(item.credit || 0) > 0 ? <DeskChip label={`Credit ${fmtMoney(item.credit)}`} tone="#eefaf1" color="#0a7a35" /> : null}
                                      </div>
                                    </div>
                                  ))
                                ) : (
                                  <div style={{ opacity: 0.7 }}>No ledger rows available.</div>
                                )}
                              </div>

                              <div style={{ display: "grid", gap: 10 }}>
                                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62 }}>Open items</div>
                                {(detail.open_invoices || []).slice(0, 8).map((item) => (
                                  <div key={item.id} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                                      <div style={{ fontWeight: 700 }}>{item.invoice_number}</div>
                                      <button type="button" onClick={() => onOpenInvoice?.(item.id)}>
                                        Open
                                      </button>
                                    </div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                                      <DeskChip label={`Outstanding ${fmtMoney(item.outstanding_invoice, item.invoice_currency_code)}`} tone="#eef4ff" color="#234a8f" />
                                      <DeskChip label={`Allocated ${fmtMoney(item.allocated_invoice, item.invoice_currency_code)}`} tone="#f6f7fb" color="#58627a" />
                                      {Number(item.credit_note_amount || 0) > 0 ? <DeskChip label={`Credit ${fmtMoney(item.credit_note_amount, item.invoice_currency_code)}`} tone="#eefaf1" color="#0a7a35" /> : null}
                                      {Number(item.adjustment_amount || 0) > 0 ? <DeskChip label={`Adjust ${fmtMoney(item.adjustment_amount, item.invoice_currency_code)}`} tone="#fff8ea" color="#8b5a00" /> : null}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                              <div style={{ display: "grid", gap: 10 }}>
                                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62 }}>Receipts</div>
                                {(detail.receipts || []).slice(0, 8).map((item) => (
                                  <div key={item.id} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                                      <div style={{ fontWeight: 700 }}>{item.receipt_number}</div>
                                      <button type="button" onClick={() => setView({ type: "detail", id: item.id })}>
                                        Open
                                      </button>
                                    </div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                                      <DeskChip label={`Status ${String(item.receipt_status || "").toUpperCase()}`} tone={item.receipt_status === "posted" ? "#eefaf1" : item.receipt_status === "draft" ? "#fff8ea" : "#fff2f2"} color={item.receipt_status === "posted" ? "#0a7a35" : item.receipt_status === "draft" ? "#8b5a00" : "#b42318"} />
                                      <DeskChip label={`Amount ${fmtMoney(item.receipt_amount_invoice, item.receipt_currency_code)}`} tone="#eef4ff" color="#234a8f" />
                                      <DeskChip label={`Allocated ${fmtMoney(item.allocated_amount_invoice, item.receipt_currency_code)}`} tone="#f6f7fb" color="#58627a" />
                                      <DeskChip label={`Unapplied ${fmtMoney(item.unallocated_amount_invoice, item.receipt_currency_code)}`} tone={Number(item.unallocated_amount_invoice || 0) > 0.0001 ? "#fff6e8" : "#eefaf1"} color={Number(item.unallocated_amount_invoice || 0) > 0.0001 ? "#8b5a00" : "#0a7a35"} />
                                    </div>
                                  </div>
                                ))}
                              </div>

                              <div style={{ display: "grid", gap: 10 }}>
                                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62 }}>Credits, adjustments, and risks</div>
                                {(detail.credit_notes || []).slice(0, 4).map((item) => (
                                  <div key={`cn-${item.id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                                    <div style={{ fontWeight: 700 }}>{item.credit_note_number || item.return_number}</div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                                      <DeskChip label={`Credit ${fmtMoney(item.credit_note_amount)}`} tone="#eefaf1" color="#0a7a35" />
                                      {item.invoice_number ? <DeskChip label={item.invoice_number} tone="#eef4ff" color="#234a8f" /> : null}
                                    </div>
                                  </div>
                                ))}
                                {(detail.adjustments || []).slice(0, 4).map((item) => (
                                  <div key={`adj-${item.id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                                    <div style={{ fontWeight: 700 }}>{String(item.adjustment_type || "").replace(/_/g, " ")}</div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                                      <DeskChip label={`Status ${String(item.adjustment_status || "").toUpperCase()}`} tone={item.adjustment_status === "posted" ? "#eefaf1" : item.adjustment_status === "draft" ? "#fff8ea" : "#fff2f2"} color={item.adjustment_status === "posted" ? "#0a7a35" : item.adjustment_status === "draft" ? "#8b5a00" : "#b42318"} />
                                      <DeskChip label={`Adjust ${fmtMoney(item.adjustment_amount)}`} tone="#fff8ea" color="#8b5a00" />
                                      {item.invoice_number ? <DeskChip label={item.invoice_number} tone="#eef4ff" color="#234a8f" /> : null}
                                    </div>
                                  </div>
                                ))}
                                {(detail.disputes || []).slice(0, 3).map((item) => (
                                  <div key={`disp-${item.id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                                    <div style={{ fontWeight: 700 }}>{item.dispute_reason}</div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                                      <DeskChip label={`Status ${String(item.dispute_status || "").toUpperCase()}`} tone="#fff6e8" color="#8b5a00" />
                                      <DeskChip label={`Amount ${fmtMoney(item.disputed_amount)}`} tone="#fff2f2" color="#b42318" />
                                      {item.invoice_number ? <DeskChip label={item.invoice_number} tone="#eef4ff" color="#234a8f" /> : null}
                                    </div>
                                  </div>
                                ))}
                                {(detail.promises || []).slice(0, 3).map((item) => (
                                  <div key={`promise-${item.id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                                    <div style={{ fontWeight: 700 }}>Promise to pay</div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                                      <DeskChip label={item.expected_date ? `Due ${fmtDate(item.expected_date)}` : "Due —"} tone="#eef4ff" color="#234a8f" />
                                      {Number(item.promised_amount || 0) > 0 ? <DeskChip label={`Promise ${fmtMoney(item.promised_amount)}`} tone="#fff8ea" color="#8b5a00" /> : null}
                                      {item.invoice_number ? <DeskChip label={item.invoice_number} tone="#eef4ff" color="#234a8f" /> : null}
                                    </div>
                                    {item.remarks ? <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>{item.remarks}</div> : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </>
                        ) : (
                          <div style={{ opacity: 0.7 }}>No reconciliation detail available yet.</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No customers in this reconciliation bucket.
            </div>
          )}
        </DeskCard>
      </div>
      </>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Credit Control Desk" subtitle="Watch over-limit customers, overdue blocks, and temporary release approvals before dispatch risk leaks further. Prefer AR Desk → Credit release for daily work.">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <input
              value={creditQuery}
              onChange={(e) => setCreditQuery(e.target.value)}
              placeholder="Search customer / code"
              style={{ minWidth: 240, ...inputStyle() }}
            />
            <select value={creditBucket} onChange={(e) => setCreditBucket(e.target.value)} style={inputStyle()}>
              <option value="all">All credit accounts</option>
              <option value="over_limit">Over limit</option>
              <option value="overdue">Overdue</option>
              <option value="hold">Manual hold</option>
              <option value="release_requested">Release requested</option>
              <option value="dispatch_blocked">Dispatch blocked</option>
              <option value="active_release">Active releases</option>
            </select>
            <button type="button" onClick={() => loadCreditControls().catch(() => {})} disabled={creditLoading}>
              {creditLoading ? "Loading..." : "Refresh Credit Desk"}
            </button>
          </div>

          {!creditReady ? (
            <div style={{ padding: 18, borderRadius: 16, background: "#fff7f7", border: "1px solid #f2caca", color: "#8a1c1c", lineHeight: 1.7 }}>
              Apply migration <strong>073_customer_credit_control_v1.sql</strong> to enable credit control.
            </div>
          ) : creditLoading ? (
            <div>Loading credit control…</div>
          ) : creditRows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {creditRows.map((row) => {
                const isEditing = String(creditEditorCustomerId || "") === String(row.customer_id || "");
                const draft = ensureCreditDraft(row.customer_id, row);
                const latestStatus = String(row.latest_release?.release_status || "").toLowerCase();
                const soDecision = row.decisions?.so_confirmation;
                const dispatchDecision = row.decisions?.dispatch_release;
                return (
                  <div key={row.customer_id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff", boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 15 }}>{row.customer_name}</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                          <DeskChip label={`Exposure ${fmtMoney(row.exposure?.total_exposure)}`} tone="#f6f7fb" color="#58627a" />
                          <DeskChip label={`Outstanding ${fmtMoney(row.exposure?.outstanding_amount)}`} tone="#eef4ff" color="#234a8f" />
                          <DeskChip label={`Open SO ${fmtMoney(row.exposure?.open_order_amount)}`} tone="#eef4ff" color="#234a8f" />
                          <DeskChip label={`Overdue ${row.exposure?.overdue_count || 0}`} tone={Number(row.exposure?.overdue_count || 0) > 0 ? "#fff6e8" : "#eefaf1"} color={Number(row.exposure?.overdue_count || 0) > 0 ? "#8b5a00" : "#0a7a35"} />
                          <DeskChip label={`Mode ${String(row.profile?.credit_control_mode || "warning").replace(/_/g, " ")}`} tone="#f6f7fb" color="#58627a" />
                          {Number(row.profile?.credit_limit || 0) > 0 ? <DeskChip label={`Limit ${fmtMoney(row.profile?.credit_limit)}`} tone="#f6f7fb" color="#58627a" /> : null}
                          {row.profile?.is_credit_hold ? <DeskChip label="Manual hold" tone="#fff2f2" color="#b42318" /> : null}
                          {row.active_release?.id ? <DeskChip label={`Release till ${fmtDate(row.active_release?.expires_on)}`} tone="#eefaf1" color="#0a7a35" /> : null}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => onOpenCustomerInvoices?.(row.customer_id, row.customer_name)}>
                          Open invoices
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            ensureCreditDraft(row.customer_id, row);
                            setCreditEditorCustomerId((prev) => (String(prev || "") === String(row.customer_id || "") ? null : row.customer_id));
                          }}
                        >
                          {isEditing ? "Close" : latestStatus === "requested" ? "Review Release" : "Request Release"}
                        </button>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.7, opacity: 0.82 }}>
                      {row.evaluation?.over_limit ? `Over limit by ${fmtMoney(row.exposure?.over_limit_amount)}.` : "Within limit."}{" "}
                      {dispatchDecision?.block ? `Dispatch blocked: ${dispatchDecision.message}` : soDecision?.block ? `SO blocked: ${soDecision.message}` : "No active release block."}
                      {row.profile?.credit_hold_reason ? ` Hold note: ${row.profile.credit_hold_reason}` : ""}
                    </div>

                    {isEditing ? (
                      <div style={{ marginTop: 14, display: "grid", gap: 12, borderTop: "1px solid #edf1f7", paddingTop: 12 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
                          <FieldLabel label="Reason">
                            <input
                              value={draft.reason || ""}
                              onChange={(e) =>
                                setCreditDrafts((prev) => ({
                                  ...(prev && typeof prev === "object" ? prev : {}),
                                  [String(row.customer_id)]: { ...(draft || {}), reason: e.target.value },
                                }))
                              }
                              style={inputStyle()}
                            />
                          </FieldLabel>
                          <FieldLabel label="Expiry">
                            <input
                              type="date"
                              value={draft.expires_on || ""}
                              onChange={(e) =>
                                setCreditDrafts((prev) => ({
                                  ...(prev && typeof prev === "object" ? prev : {}),
                                  [String(row.customer_id)]: { ...(draft || {}), expires_on: e.target.value },
                                }))
                              }
                              style={inputStyle()}
                            />
                          </FieldLabel>
                          <FieldLabel label="Approved upto amount">
                            <input
                              value={draft.approved_upto_amount || ""}
                              onChange={(e) =>
                                setCreditDrafts((prev) => ({
                                  ...(prev && typeof prev === "object" ? prev : {}),
                                  [String(row.customer_id)]: { ...(draft || {}), approved_upto_amount: e.target.value },
                                }))
                              }
                              style={inputStyle()}
                            />
                          </FieldLabel>
                        </div>
                        <FieldLabel label="Remarks">
                          <textarea
                            rows={3}
                            value={draft.remarks || ""}
                            onChange={(e) =>
                              setCreditDrafts((prev) => ({
                                ...(prev && typeof prev === "object" ? prev : {}),
                                [String(row.customer_id)]: { ...(draft || {}), remarks: e.target.value },
                              }))
                            }
                            style={textAreaStyle()}
                          />
                        </FieldLabel>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          {latestStatus === "requested" && row.latest_release?.id ? (
                            <>
                              <button type="button" onClick={() => updateCreditReleaseStatus(row.latest_release.id, row.customer_id, "approved").catch(() => {})}>
                                Approve Release
                              </button>
                              <button type="button" onClick={() => updateCreditReleaseStatus(row.latest_release.id, row.customer_id, "rejected").catch(() => {})}>
                                Reject
                              </button>
                              <button type="button" onClick={() => updateCreditReleaseStatus(row.latest_release.id, row.customer_id, "cancelled").catch(() => {})}>
                                Cancel Request
                              </button>
                            </>
                          ) : (
                            <button type="button" onClick={() => saveCreditReleaseRequest(row.customer_id).catch(() => {})}>
                              Save Release Request
                            </button>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No customers in this credit bucket.
            </div>
          )}
        </DeskCard>
      </div>

      {showCollectionsTools ? (
      <>
      <div style={{ marginTop: 16 }}>
        <DeskCard title="Collection Follow-ups" subtitle="Capture next follow-up dates and remarks so recovery work is trackable">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <input
              value={followupsQuery}
              onChange={(e) => setFollowupsQuery(e.target.value)}
              placeholder="Search customer"
              style={{ minWidth: 220, ...inputStyle() }}
            />
            <select value={followupsBucket} onChange={(e) => setFollowupsBucket(e.target.value)} style={inputStyle()}>
              <option value="all">All pending follow-ups</option>
              <option value="overdue">Overdue follow-ups</option>
              <option value="due_today">Due today</option>
              <option value="no_date">Missing follow-up date</option>
            </select>
            <button
              type="button"
              onClick={() => loadFollowups().catch(() => {})}
              disabled={followupsLoading}
            >
              {followupsLoading ? "Loading..." : "Refresh Follow-ups"}
            </button>
          </div>

          {!followupsReady ? (
            <div style={{ padding: 18, borderRadius: 16, background: "#fff7f7", border: "1px solid #f2caca", color: "#8a1c1c", lineHeight: 1.7 }}>
              Apply migration <strong>068_customer_collection_actions_v1.sql</strong> to enable follow-up tracking.
            </div>
          ) : followupsLoading ? (
            <div>Loading follow-up queue…</div>
          ) : followups.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {followups.map((row) => {
                const isEditing = String(followupEditingCustomerId || "") === String(row.customer_id || "");
                const isHistoryOpen = String(followupHistoryCustomerId || "") === String(row.customer_id || "");
                const draft = ensureFollowupDraft(row.customer_id);
                const historyRows = followupHistoryRows && typeof followupHistoryRows === "object" ? followupHistoryRows[String(row.customer_id)] : null;
                const invoiceOptions =
                  followupInvoiceOptions && typeof followupInvoiceOptions === "object" ? followupInvoiceOptions[String(row.customer_id)] : null;
                const invoiceLoading = String(followupInvoiceLoadingCustomerId || "") === String(row.customer_id || "");
                return (
                  <div key={row.customer_id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff", boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 15 }}>{row.customer_name}</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                          <DeskChip label={`Outstanding ${fmtMoney(row.outstanding_amount)}`} tone="#f6f7fb" color="#58627a" />
                          <DeskChip label={`${row.open_invoices || 0} open invoices`} tone="#eef4ff" color="#234a8f" />
                          <DeskChip label={`Max ageing ${row.max_ageing_days || 0}d`} tone="#fff6e8" color="#8b5a00" />
                          <DeskChip label={row.next_followup_date ? `Next ${fmtDate(row.next_followup_date)}` : "Next —"} tone="#f6f7fb" color="#58627a" />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          onClick={() => onOpenCustomerInvoices?.(row.customer_id, row.customer_name)}
                        >
                          Open invoices
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (isHistoryOpen) {
                              setFollowupHistoryCustomerId(null);
                              return;
                            }
                            setFollowupHistoryCustomerId(row.customer_id);
                            loadFollowupHistory(row.customer_id).catch(() => {});
                          }}
                        >
                          {isHistoryOpen ? "Hide history" : "History"}
                        </button>
                        <a
                          href={`/receipts/customer/${row.customer_id}/statement/pdf`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "8px 12px",
                            borderRadius: 12,
                            border: "1px solid #d8dfeb",
                            background: "#ffffff",
                            color: "#0f4aa1",
                            textDecoration: "none",
                            fontSize: 13,
                            fontWeight: 700,
                          }}
                        >
                          Statement PDF
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            ensureFollowupDraft(row.customer_id);
                            if (isEditing) {
                              setFollowupEditingCustomerId(null);
                              return;
                            }
                            setFollowupEditingCustomerId(row.customer_id);
                            loadFollowupInvoiceOptions(row.customer_id).catch(() => {});
                          }}
                        >
                          {isEditing ? "Close" : "Log Action"}
                        </button>
                      </div>
                    </div>
                    <div style={{ marginTop: 10, opacity: 0.78, fontSize: 13, lineHeight: 1.6 }}>
                      {row.last_action_type ? (
                        <span>
                          Last: <strong>{String(row.last_action_type).replace(/_/g, " ")}</strong> on {fmtDate(row.last_action_date)}
                          {row.last_action_promised_amount ? ` for ${fmtMoney(row.last_action_promised_amount)}` : ""}
                          {row.last_action_invoice_number ? ` for ${row.last_action_invoice_number}` : ""}
                          {row.last_action_by_name ? ` by ${row.last_action_by_name}` : ""}
                          {row.last_action_remarks ? ` — ${row.last_action_remarks}` : ""}
                        </span>
                      ) : (
                        <span>No follow-up history captured yet.</span>
                      )}
                    </div>

                    {isHistoryOpen ? (
                      <div style={{ marginTop: 12, borderRadius: 14, border: "1px solid #edf1f7", background: "#fbfcff", padding: 12 }}>
                        <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62, marginBottom: 10 }}>
                          Follow-up history
                        </div>
                        {followupHistoryLoading ? (
                          <div>Loading history…</div>
                        ) : historyRows && historyRows.length ? (
                          <div style={{ display: "grid", gap: 10 }}>
                            {historyRows.map((item) => (
                              <div key={item.id} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 10, background: "#ffffff" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                                  <div style={{ fontWeight: 800, fontSize: 13 }}>{String(item.action_type || "").replace(/_/g, " ")}</div>
                                  <div style={{ fontSize: 12, opacity: 0.7 }}>{fmtDate(item.action_date)}</div>
                                </div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                                  <DeskChip label={item.expected_date ? `Next ${fmtDate(item.expected_date)}` : "Next —"} tone="#f6f7fb" color="#58627a" />
                                  {item.promised_amount ? <DeskChip label={`Promise ${fmtMoney(item.promised_amount)}`} tone="#fff8ea" color="#8b5a00" /> : null}
                                  {item.invoice_number ? (
                                    <button
                                      type="button"
                                      onClick={() => onOpenInvoice?.(item.customer_invoice_id)}
                                      style={{ all: "unset", cursor: onOpenInvoice ? "pointer" : "default" }}
                                    >
                                      <DeskChip label={item.invoice_number} tone="#eef4ff" color="#234a8f" />
                                    </button>
                                  ) : null}
                                  {item.created_by_name ? <DeskChip label={item.created_by_name} tone="#eef4ff" color="#234a8f" /> : null}
                                </div>
                                {item.remarks ? <div style={{ marginTop: 8, fontSize: 13, opacity: 0.78, lineHeight: 1.6 }}>{item.remarks}</div> : null}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ opacity: 0.7 }}>No actions logged yet.</div>
                        )}
                      </div>
                    ) : null}

                    {isEditing ? (
                      <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                          <div>
                            <FieldLabel label="Action type" />
                            <select
                              value={draft.action_type}
                              onChange={(e) =>
                                setFollowupDrafts((prev) => ({
                                  ...(prev && typeof prev === "object" ? prev : {}),
                                  [String(row.customer_id)]: { ...(draft || {}), action_type: e.target.value },
                                }))
                              }
                              style={inputStyle()}
                            >
                              <option value="follow_up">Follow up</option>
                              <option value="promise_to_pay">Promise to pay</option>
                              <option value="reminder_sent">Reminder sent</option>
                              <option value="dispute">Dispute</option>
                              <option value="escalated">Escalated</option>
                              <option value="resolved">Resolved</option>
                            </select>
                          </div>
                          <div>
                            <FieldLabel label="Next follow-up date" />
                            <input
                              type="date"
                              value={draft.expected_date || ""}
                              onChange={(e) =>
                                setFollowupDrafts((prev) => ({
                                  ...(prev && typeof prev === "object" ? prev : {}),
                                  [String(row.customer_id)]: { ...(draft || {}), expected_date: e.target.value },
                                }))
                              }
                              style={inputStyle()}
                            />
                          </div>
                          <div>
                            <FieldLabel label="Invoice (optional)">
                              <select
                                value={draft.customer_invoice_id || ""}
                                onChange={(e) =>
                                  setFollowupDrafts((prev) => ({
                                    ...(prev && typeof prev === "object" ? prev : {}),
                                    [String(row.customer_id)]: { ...(draft || {}), customer_invoice_id: e.target.value },
                                  }))
                                }
                                disabled={invoiceLoading}
                                style={inputStyle()}
                              >
                                <option value="">Customer-level follow-up</option>
                                {Array.isArray(invoiceOptions)
                                  ? invoiceOptions.map((inv) => (
                                      <option key={inv.id} value={String(inv.id)}>
                                        {inv.invoice_number}
                                        {inv.outstanding_invoice ? ` — ${fmtMoney(inv.outstanding_invoice, inv.invoice_currency_code)}` : ""}
                                        {inv.due_date ? ` — due ${fmtDate(inv.due_date)}` : ""}
                                      </option>
                                    ))
                                  : null}
                              </select>
                            </FieldLabel>
                          </div>
                          <div>
                            <FieldLabel label="Promised amount">
                              <input
                                value={draft.promised_amount || ""}
                                disabled={draft.action_type !== "promise_to_pay"}
                                onChange={(e) =>
                                  setFollowupDrafts((prev) => ({
                                    ...(prev && typeof prev === "object" ? prev : {}),
                                    [String(row.customer_id)]: { ...(draft || {}), promised_amount: e.target.value },
                                  }))
                                }
                                style={inputStyle(draft.action_type !== "promise_to_pay")}
                              />
                            </FieldLabel>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <button type="button" onClick={() => saveFollowupAction(row.customer_id)} disabled={followupsLoading}>
                            Save Action
                          </button>
                          <button type="button" onClick={() => setFollowupEditingCustomerId(null)} disabled={followupsLoading}>
                            Cancel
                          </button>
                        </div>
                        <div>
                          <FieldLabel label="Remarks" />
                          <textarea
                            value={draft.remarks || ""}
                            onChange={(e) =>
                              setFollowupDrafts((prev) => ({
                                ...(prev && typeof prev === "object" ? prev : {}),
                                [String(row.customer_id)]: { ...(draft || {}), remarks: e.target.value },
                              }))
                            }
                            rows={3}
                            style={textAreaStyle()}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No follow-ups in this bucket.
            </div>
          )}
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Promise Tracker" subtitle="Committed payment dates that need active closure before they slip">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <input
              value={promisesQuery}
              onChange={(e) => setPromisesQuery(e.target.value)}
              placeholder="Search customer / invoice / remarks"
              style={{ minWidth: 260, ...inputStyle() }}
            />
            <select value={promisesBucket} onChange={(e) => setPromisesBucket(e.target.value)} style={inputStyle()}>
              <option value="all">All commitments</option>
              <option value="overdue">Broken promises</option>
              <option value="due_today">Due today</option>
              <option value="future">Future commitments</option>
            </select>
            <button type="button" onClick={() => loadPromises().catch(() => {})} disabled={promisesLoading}>
              {promisesLoading ? "Loading..." : "Refresh Promises"}
            </button>
          </div>

          {!promisesReady ? (
            <div style={{ padding: 18, borderRadius: 16, background: "#fff7f7", border: "1px solid #f2caca", color: "#8a1c1c", lineHeight: 1.7 }}>
              Apply migration <strong>068_customer_collection_actions_v1.sql</strong> to enable promise tracking.
            </div>
          ) : promisesLoading ? (
            <div>Loading promise tracker…</div>
          ) : promises.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {promises.map((row) => (
                <div key={row.id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff", boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 15 }}>{row.customer_name}</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        <DeskChip label={row.expected_date ? `Promised ${fmtDate(row.expected_date)}` : "Promised —"} tone="#eef4ff" color="#234a8f" />
                        <DeskChip label={`Promise ${fmtMoney(row.promised_amount || row.outstanding_amount)}`} tone="#fff8ea" color="#8b5a00" />
                        <DeskChip label={`Outstanding ${fmtMoney(row.outstanding_amount)}`} tone="#f6f7fb" color="#58627a" />
                        {row.expected_date && row.overdue_days > 0 ? (
                          <DeskChip label={`${row.overdue_days}d overdue`} tone="#fff2f2" color="#b42318" />
                        ) : (
                          <DeskChip label={row.open_invoices ? `${row.open_invoices} open invoices` : "Open invoices —"} tone="#fff8ea" color="#8b5a00" />
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {row.customer_invoice_id ? (
                        <button type="button" onClick={() => onOpenInvoice?.(row.customer_invoice_id)}>
                          {row.invoice_number || "Open invoice"}
                        </button>
                      ) : (
                        <button type="button" onClick={() => onOpenCustomerInvoices?.(row.customer_id, row.customer_name)}>
                          Open invoices
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          logCollectionAction(
                            row.customer_id,
                            {
                              action_type: "resolved",
                              customer_invoice_id: row.customer_invoice_id || null,
                              remarks: `Promise met${row.invoice_number ? ` for ${row.invoice_number}` : ""}`,
                            },
                            "Promise closed as resolved."
                          ).catch(() => {})
                        }
                      >
                        Mark Paid
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          logCollectionAction(
                            row.customer_id,
                            {
                              action_type: "follow_up",
                              customer_invoice_id: row.customer_invoice_id || null,
                              expected_date: row.expected_date || null,
                              remarks: `Promise broken${row.invoice_number ? ` for ${row.invoice_number}` : ""}${row.remarks ? ` — ${row.remarks}` : ""}`,
                            },
                            "Promise moved back to follow-up queue."
                          ).catch(() => {})
                        }
                      >
                        Re-Chase
                      </button>
                    </div>
                  </div>
                  <div style={{ marginTop: 10, opacity: 0.78, fontSize: 13, lineHeight: 1.6 }}>
                    Logged on {fmtDate(row.action_date)}
                    {row.created_by_name ? ` by ${row.created_by_name}` : ""}
                    {row.invoice_number ? ` for ${row.invoice_number}` : ""}
                    {row.remarks ? ` — ${row.remarks}` : ""}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No promises in this bucket.
            </div>
          )}
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Collections Disputes" subtitle="Track deductions, short-pays, and commercial holds as a separate recovery queue">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <input
              value={disputesQuery}
              onChange={(e) => setDisputesQuery(e.target.value)}
              placeholder="Search customer / invoice / reason"
              style={{ minWidth: 260, ...inputStyle() }}
            />
            <select value={disputesStatus} onChange={(e) => setDisputesStatus(e.target.value)} style={inputStyle()}>
              <option value="all">All disputes</option>
              <option value="open">Open</option>
              <option value="escalated">Escalated</option>
              <option value="resolved">Resolved</option>
            </select>
            <button type="button" onClick={() => loadDisputes().catch(() => {})} disabled={disputesLoading}>
              {disputesLoading ? "Loading..." : "Refresh Disputes"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDisputeFormOpen((prev) => !prev);
                if (disputeFormOpen) {
                  setDisputeCustomerResults([]);
                  setDisputeInvoiceOptions([]);
                }
              }}
            >
              {disputeFormOpen ? "Close Form" : "Raise Dispute"}
            </button>
          </div>

          {!disputesReady ? (
            <div style={{ padding: 18, borderRadius: 16, background: "#fff7f7", border: "1px solid #f2caca", color: "#8a1c1c", lineHeight: 1.7 }}>
              Apply migration <strong>069_customer_collection_disputes_v1.sql</strong> to enable dispute tracking.
            </div>
          ) : null}

          {disputesReady && disputeFormOpen ? (
            <div style={{ marginBottom: 14, borderRadius: 16, border: "1px solid #e7ebf3", background: "#fbfcff", padding: 14, display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  value={disputeCustomerQuery}
                  onChange={(e) => setDisputeCustomerQuery(e.target.value)}
                  placeholder="Search customer"
                  style={{ minWidth: 220, ...inputStyle() }}
                />
                <button type="button" onClick={() => searchDisputeCustomers().catch(() => {})}>
                  Search
                </button>
                {disputeDraft.customer_name ? <DeskChip label={`Customer ${disputeDraft.customer_name}`} tone="#eef4ff" color="#234a8f" /> : null}
              </div>

              {disputeCustomerResults.length ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {disputeCustomerResults.slice(0, 8).map((row) => (
                    <button
                      type="button"
                      key={row.id}
                      onClick={() => {
                        setDisputeDraft((prev) => ({
                          ...prev,
                          customer_id: String(row.id),
                          customer_name: row.customer_name || "",
                          customer_invoice_id: "",
                        }));
                        loadDisputeInvoiceOptions(row.id).catch(() => {});
                      }}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        border: "1px solid #e7ebf3",
                        borderRadius: 12,
                        padding: 10,
                        background: String(disputeDraft.customer_id || "") === String(row.id) ? "#eef4ff" : "#ffffff",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <span style={{ fontWeight: 700 }}>{row.customer_name}</span>
                      <span style={{ fontSize: 12, opacity: 0.7 }}>{row.customer_code || "—"}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                <FieldLabel label="Invoice (optional)">
                  <select
                    value={disputeDraft.customer_invoice_id}
                    onChange={(e) => setDisputeDraft((prev) => ({ ...prev, customer_invoice_id: e.target.value }))}
                    disabled={disputeInvoiceLoading || !disputeDraft.customer_id}
                    style={inputStyle(disputeInvoiceLoading || !disputeDraft.customer_id)}
                  >
                    <option value="">Customer-level dispute</option>
                    {disputeInvoiceOptions.map((inv) => (
                      <option key={inv.id} value={String(inv.id)}>
                        {inv.invoice_number}
                        {inv.outstanding_invoice ? ` — ${fmtMoney(inv.outstanding_invoice, inv.invoice_currency_code)}` : ""}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                <FieldLabel label="Disputed amount">
                  <input
                    value={disputeDraft.disputed_amount}
                    onChange={(e) => setDisputeDraft((prev) => ({ ...prev, disputed_amount: e.target.value }))}
                    style={inputStyle()}
                  />
                </FieldLabel>
                <FieldLabel label="Reason">
                  <input
                    value={disputeDraft.dispute_reason}
                    onChange={(e) => setDisputeDraft((prev) => ({ ...prev, dispute_reason: e.target.value }))}
                    placeholder="Rate mismatch / shortage / damage / POD hold"
                    style={inputStyle()}
                  />
                </FieldLabel>
                <FieldLabel label="Expected resolution">
                  <input
                    type="date"
                    value={disputeDraft.expected_resolution_date}
                    onChange={(e) => setDisputeDraft((prev) => ({ ...prev, expected_resolution_date: e.target.value }))}
                    style={inputStyle()}
                  />
                </FieldLabel>
              </div>
              <FieldLabel label="Remarks">
                <textarea
                  rows={3}
                  value={disputeDraft.remarks}
                  onChange={(e) => setDisputeDraft((prev) => ({ ...prev, remarks: e.target.value }))}
                  style={textAreaStyle()}
                />
              </FieldLabel>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" onClick={() => saveDispute().catch(() => {})}>
                  Save Dispute
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDisputeFormOpen(false);
                    setDisputeCustomerResults([]);
                    setDisputeInvoiceOptions([]);
                    setDisputeDraft({
                      customer_id: "",
                      customer_name: "",
                      customer_invoice_id: "",
                      dispute_reason: "",
                      disputed_amount: "",
                      expected_resolution_date: "",
                      remarks: "",
                    });
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {!disputesReady ? null : disputesLoading ? (
            <div>Loading disputes…</div>
          ) : disputes.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {disputes.map((row) => (
                <div key={row.id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff", boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 15 }}>{row.customer_name}</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        <DeskChip label={`Status ${String(row.dispute_status || "open").toUpperCase()}`} tone={row.dispute_status === "resolved" ? "#eefaf1" : row.dispute_status === "escalated" ? "#fff2f2" : "#fff8ea"} color={row.dispute_status === "resolved" ? "#0a7a35" : row.dispute_status === "escalated" ? "#b42318" : "#8b5a00"} />
                        <DeskChip label={`Amount ${fmtMoney(row.disputed_amount)}`} tone="#f6f7fb" color="#58627a" />
                        <DeskChip label={`Age ${row.ageing_days || 0}d`} tone="#eef4ff" color="#234a8f" />
                        <DeskChip label={row.expected_resolution_date ? `Target ${fmtDate(row.expected_resolution_date)}` : "Target —"} tone="#f6f7fb" color="#58627a" />
                        {row.linked_return_status ? (
                          <DeskChip
                            label={row.linked_return_status === "posted" ? `Credit ${row.credit_note_number || row.return_number || row.sales_return_id}` : `Draft ${row.return_number || row.sales_return_id}`}
                            tone={row.linked_return_status === "posted" ? "#eefaf1" : "#eef4ff"}
                            color={row.linked_return_status === "posted" ? "#0a7a35" : "#234a8f"}
                          />
                        ) : null}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {row.customer_invoice_id ? (
                        <button type="button" onClick={() => onOpenInvoice?.(row.customer_invoice_id)}>
                          {row.invoice_number || "Open invoice"}
                        </button>
                      ) : null}
                      {row.sales_return_id ? (
                        <button type="button" onClick={() => onOpenSalesReturn?.(row.sales_return_id)}>
                          Open Credit Note
                        </button>
                      ) : row.customer_invoice_id ? (
                        <button type="button" onClick={() => onCreateCreditNoteFromInvoice?.(row.customer_invoice_id, row.id)}>
                          Create Credit Note
                        </button>
                      ) : null}
                      <button type="button" onClick={() => openCommercialFailureEditor(row.id).catch(() => {})}>
                        {commercialFailureEditorDisputeId === row.id ? "Open NCR / CAPA" : "Raise / Open NCR"}
                      </button>
                      {row.dispute_status !== "escalated" ? (
                        <button type="button" onClick={() => updateDisputeStatus(row.id, "escalated").catch(() => {})}>
                          Escalate
                        </button>
                      ) : null}
                      {row.dispute_status !== "resolved" ? (
                        <button type="button" onClick={() => updateDisputeStatus(row.id, "resolved").catch(() => {})}>
                          Resolve
                        </button>
                      ) : (
                        <button type="button" onClick={() => updateDisputeStatus(row.id, "open").catch(() => {})}>
                          Reopen
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6 }}>
                    <strong>{row.dispute_reason}</strong>
                    {row.invoice_outstanding ? ` • invoice outstanding ${fmtMoney(row.invoice_outstanding)}` : ""}
                    {row.credited_amount ? ` • credited ${fmtMoney(row.credited_amount)}` : ""}
                    {row.created_by_name ? ` • raised by ${row.created_by_name}` : ""}
                  </div>
                  {row.remarks ? <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8, lineHeight: 1.6 }}>{row.remarks}</div> : null}
                  {row.dispute_status === "resolved" && row.resolved_by_name ? (
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
                      Resolved by {row.resolved_by_name} {row.resolved_at ? `on ${fmtDate(row.resolved_at)}` : ""}
                    </div>
                  ) : null}
                  {commercialFailureEditorDisputeId === row.id ? (
                    <div style={{ marginTop: 14 }}>
                      <CommercialFailureEditor
                        detail={commercialFailureDetails[String(row.id)] || { dispute: row, ncr_cases: [], capa_actions: [] }}
                        loading={commercialFailureDetailLoading}
                        onCreate={(payload) => createCommercialNcrCase(row.id, payload)}
                        onSave={(ncrId, payload) => saveCommercialNcrCase(row.id, ncrId, payload)}
                        onOpenSalesReturn={onOpenSalesReturn}
                        onCreateCreditNoteFromInvoice={onCreateCreditNoteFromInvoice}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No disputes in this bucket.
            </div>
          )}
        </DeskCard>
      </div>
      </>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Commercial Failure / CAPA Desk" subtitle="Track dispute-linked investigations through containment, root cause, and corrective action while credit-note resolution runs separately">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <input
              value={commercialFailureQuery}
              onChange={(e) => setCommercialFailureQuery(e.target.value)}
              placeholder="Search NCR / customer / invoice / dispute"
              style={{ minWidth: 260, ...inputStyle() }}
            />
            <select value={commercialFailureBucket} onChange={(e) => setCommercialFailureBucket(e.target.value)} style={inputStyle()}>
              {COMMERCIAL_FAILURE_BUCKETS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => loadCommercialFailures().catch(() => {})} disabled={commercialFailureLoading}>
              {commercialFailureLoading ? "Loading..." : "Refresh Failure Desk"}
            </button>
          </div>

          {!commercialFailureReady ? (
            <div style={{ padding: 18, borderRadius: 16, background: "#fff7f7", border: "1px solid #f2caca", color: "#8a1c1c", lineHeight: 1.7 }}>
              Apply migration <strong>069_customer_collection_disputes_v1.sql</strong> to enable dispute-linked failure control.
            </div>
          ) : null}

          {commercialFailureSummary ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 10, marginBottom: 12 }}>
              <MiniMetric label="New NCR" value={commercialFailureSummary.new_ncr || 0} />
              <MiniMetric label="Containment Due" value={commercialFailureSummary.containment_due || 0} />
              <MiniMetric label="Root Cause Due" value={commercialFailureSummary.root_cause_due || 0} />
              <MiniMetric label="Action Overdue" value={commercialFailureSummary.action_overdue || 0} />
              <MiniMetric label="Verification Due" value={commercialFailureSummary.verification_due || 0} />
            </div>
          ) : null}

          {!commercialFailureReady ? null : commercialFailureLoading ? (
            <div>Loading commercial failure queue…</div>
          ) : commercialFailureRows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {commercialFailureRows.map((row) => {
                const appearance = commercialFailureAppearance(getDisputeFailureBucket(row));
                return (
                  <div key={`commercial-failure-${row.id}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff", boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 15 }}>{row.ncr_number}</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                          <DeskChip label={appearance.label} tone={appearance.bg} color={appearance.color} />
                          <DeskChip label={ncrStatusLabel(row.status)} tone={ncrStatusTone(row.status).bg} color={ncrStatusTone(row.status).color} />
                          <DeskChip label={`Customer ${row.customer_name || "—"}`} tone="#eef4ff" color="#234a8f" />
                          {row.invoice_number ? <DeskChip label={`Invoice ${row.invoice_number}`} tone="#f6f7fb" color="#58627a" /> : null}
                          {row.return_number ? <DeskChip label={`Return ${row.return_number}`} tone="#eefaf1" color="#0a7a35" /> : null}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => openCommercialFailureEditor(row.customer_collection_dispute_id).catch(() => {})}>
                          Open Editor
                        </button>
                        {row.sales_return_id ? (
                          <button type="button" onClick={() => onOpenSalesReturn?.(row.sales_return_id)}>
                            Open Credit Note
                          </button>
                        ) : row.customer_invoice_id ? (
                          <button type="button" onClick={() => onCreateCreditNoteFromInvoice?.(row.customer_invoice_id, row.customer_collection_dispute_id)}>
                            Create Credit Note
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6 }}>
                      <strong>{row.defect_summary}</strong>
                      {row.dispute_reason ? ` • dispute ${row.dispute_reason}` : ""}
                    </div>
                    <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: 10 }}>
                      <MiniMetric label="Severity" value={ncrStatusLabel(row.severity)} />
                      <MiniMetric label="Qty / Amount" value={fmtMoney(row.qty_affected)} />
                      <MiniMetric label="Overdue Actions" value={row.overdue_action_count || 0} />
                      <MiniMetric label="Open Actions" value={row.open_action_count || 0} />
                    </div>
                    {commercialFailureEditorDisputeId === row.customer_collection_dispute_id ? (
                      <div style={{ marginTop: 14 }}>
                        <CommercialFailureEditor
                          detail={commercialFailureDetails[String(row.customer_collection_dispute_id)] || { dispute: { id: row.customer_collection_dispute_id, customer_name: row.customer_name, invoice_number: row.invoice_number, sales_return_id: row.sales_return_id, dispute_reason: row.dispute_reason }, ncr_cases: [], capa_actions: [] }}
                          loading={commercialFailureDetailLoading}
                          onCreate={(payload) => createCommercialNcrCase(row.customer_collection_dispute_id, payload)}
                          onSave={(ncrId, payload) => saveCommercialNcrCase(row.customer_collection_dispute_id, ncrId, payload)}
                          onOpenSalesReturn={onOpenSalesReturn}
                          onCreateCreditNoteFromInvoice={onCreateCreditNoteFromInvoice}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No commercial-failure NCRs in this bucket.
            </div>
          )}
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="AR Adjustments Desk" subtitle="Govern commercial credits, short-payment settlements, and write-offs as controlled receivable documents">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <input
              value={adjustmentsQuery}
              onChange={(e) => setAdjustmentsQuery(e.target.value)}
              placeholder="Search customer / invoice / reason"
              style={{ minWidth: 260, ...inputStyle() }}
            />
            <select value={adjustmentsStatus} onChange={(e) => setAdjustmentsStatus(e.target.value)} style={inputStyle()}>
              <option value="draft">Draft</option>
              <option value="posted">Posted</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All</option>
            </select>
            <select value={adjustmentsType} onChange={(e) => setAdjustmentsType(e.target.value)} style={inputStyle()}>
              <option value="all">All types</option>
              <option value="commercial_credit_note">Commercial credit note</option>
              <option value="short_payment_adjustment">Short-payment adjustment</option>
              <option value="write_off">Write-off</option>
            </select>
            <button type="button" onClick={() => loadAdjustments().catch(() => {})} disabled={adjustmentsLoading}>
              {adjustmentsLoading ? "Loading..." : "Refresh Adjustments"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdjustmentFormOpen((prev) => !prev);
                if (adjustmentFormOpen) {
                  setAdjustmentCustomerResults([]);
                  setAdjustmentInvoiceOptions([]);
                }
              }}
            >
              {adjustmentFormOpen ? "Close Form" : "Create Adjustment"}
            </button>
          </div>

          {!adjustmentsReady ? (
            <div style={{ padding: 18, borderRadius: 16, background: "#fff7f7", border: "1px solid #f2caca", color: "#8a1c1c", lineHeight: 1.7 }}>
              Apply migration <strong>072_customer_ar_adjustments_v1.sql</strong> to enable AR adjustments.
            </div>
          ) : null}

          {adjustmentsReady && adjustmentFormOpen ? (
            <div style={{ marginBottom: 14, borderRadius: 16, border: "1px solid #e7ebf3", background: "#fbfcff", padding: 14, display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  value={adjustmentCustomerQuery}
                  onChange={(e) => setAdjustmentCustomerQuery(e.target.value)}
                  placeholder="Search customer"
                  style={{ minWidth: 220, ...inputStyle() }}
                />
                <button type="button" onClick={() => searchAdjustmentCustomers().catch(() => {})}>
                  Search
                </button>
                {adjustmentDraft.customer_name ? <DeskChip label={`Customer ${adjustmentDraft.customer_name}`} tone="#eef4ff" color="#234a8f" /> : null}
              </div>

              {adjustmentCustomerResults.length ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {adjustmentCustomerResults.slice(0, 8).map((row) => (
                    <button
                      type="button"
                      key={row.id}
                      onClick={() => {
                        setAdjustmentDraft((prev) => ({
                          ...prev,
                          customer_id: String(row.id),
                          customer_name: row.customer_name || "",
                          customer_invoice_id: "",
                        }));
                        loadAdjustmentInvoiceOptions(row.id).catch(() => {});
                      }}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        border: "1px solid #e7ebf3",
                        borderRadius: 12,
                        padding: 10,
                        background: String(adjustmentDraft.customer_id || "") === String(row.id) ? "#eef4ff" : "#ffffff",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <span style={{ fontWeight: 700 }}>{row.customer_name}</span>
                      <span style={{ fontSize: 12, opacity: 0.7 }}>{row.customer_code || "—"}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                <FieldLabel label="Invoice">
                  <select
                    value={adjustmentDraft.customer_invoice_id}
                    onChange={(e) => setAdjustmentDraft((prev) => ({ ...prev, customer_invoice_id: e.target.value }))}
                    disabled={adjustmentInvoiceLoading || !adjustmentDraft.customer_id}
                    style={inputStyle(adjustmentInvoiceLoading || !adjustmentDraft.customer_id)}
                  >
                    <option value="">Select outstanding invoice</option>
                    {adjustmentInvoiceOptions.map((inv) => (
                      <option key={inv.id} value={String(inv.id)}>
                        {inv.invoice_number}
                        {inv.outstanding_invoice ? ` — ${fmtMoney(inv.outstanding_invoice, inv.invoice_currency_code)}` : ""}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                <FieldLabel label="Adjustment type">
                  <select
                    value={adjustmentDraft.adjustment_type}
                    onChange={(e) => setAdjustmentDraft((prev) => ({ ...prev, adjustment_type: e.target.value }))}
                    style={inputStyle()}
                  >
                    <option value="commercial_credit_note">Commercial credit note</option>
                    <option value="short_payment_adjustment">Short-payment adjustment</option>
                    <option value="write_off">Write-off</option>
                  </select>
                </FieldLabel>
                <FieldLabel label="Adjustment amount">
                  <input
                    value={adjustmentDraft.adjustment_amount}
                    onChange={(e) => setAdjustmentDraft((prev) => ({ ...prev, adjustment_amount: e.target.value }))}
                    style={inputStyle()}
                  />
                </FieldLabel>
                <FieldLabel label="Reason">
                  <input
                    value={adjustmentDraft.reason}
                    onChange={(e) => setAdjustmentDraft((prev) => ({ ...prev, reason: e.target.value }))}
                    placeholder="Commercial settlement / short-pay accepted / write-off"
                    style={inputStyle()}
                  />
                </FieldLabel>
              </div>
              <FieldLabel label="Remarks">
                <textarea
                  rows={3}
                  value={adjustmentDraft.remarks}
                  onChange={(e) => setAdjustmentDraft((prev) => ({ ...prev, remarks: e.target.value }))}
                  style={textAreaStyle()}
                />
              </FieldLabel>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" onClick={() => saveAdjustment().catch(() => {})}>
                  Save Draft
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdjustmentFormOpen(false);
                    setAdjustmentCustomerResults([]);
                    setAdjustmentInvoiceOptions([]);
                    setAdjustmentDraft({
                      customer_id: "",
                      customer_name: "",
                      customer_invoice_id: "",
                      adjustment_type: "commercial_credit_note",
                      adjustment_amount: "",
                      reason: "",
                      remarks: "",
                    });
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {!adjustmentsReady ? null : adjustmentsLoading ? (
            <div>Loading AR adjustments…</div>
          ) : adjustments.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {adjustments.map((row) => (
                <div key={row.id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff", boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 15 }}>{row.customer_name}</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        <DeskChip label={`Status ${String(row.adjustment_status || "draft").toUpperCase()}`} tone={row.adjustment_status === "posted" ? "#eefaf1" : row.adjustment_status === "cancelled" ? "#fff2f2" : "#fff8ea"} color={row.adjustment_status === "posted" ? "#0a7a35" : row.adjustment_status === "cancelled" ? "#b42318" : "#8b5a00"} />
                        <DeskChip label={String(row.adjustment_type || "").replace(/_/g, " ")} tone="#eef4ff" color="#234a8f" />
                        <DeskChip label={`Amount ${fmtMoney(row.adjustment_amount)}`} tone="#f6f7fb" color="#58627a" />
                        <DeskChip label={`Invoice outstanding ${fmtMoney(row.invoice_outstanding)}`} tone="#f6f7fb" color="#58627a" />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button type="button" onClick={() => onOpenInvoice?.(row.customer_invoice_id)}>
                        {row.invoice_number || "Open invoice"}
                      </button>
                      {row.adjustment_status === "draft" ? (
                        <>
                          <button type="button" onClick={() => updateAdjustmentStatus(row.id, "posted").catch(() => {})}>
                            Post
                          </button>
                          <button type="button" onClick={() => updateAdjustmentStatus(row.id, "cancelled").catch(() => {})}>
                            Cancel
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6 }}>
                    <strong>{row.reason}</strong>
                    {row.created_by_name ? ` • created by ${row.created_by_name}` : ""}
                    {row.posted_by_name ? ` • posted by ${row.posted_by_name}` : ""}
                    {row.cancelled_by_name ? ` • cancelled by ${row.cancelled_by_name}` : ""}
                  </div>
                  {row.remarks ? <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8, lineHeight: 1.6 }}>{row.remarks}</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No AR adjustments in this bucket.
            </div>
          )}
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Receipt Queue" subtitle="Open receipts from cards instead of scanning a wide register">
          {loading ? (
            <div>Loading receipts…</div>
          ) : receipts.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {receipts.map((item) => {
                const appearance = statusAppearance(item.receipt_status);
                return (
                  <button
                    key={item.id}
                    onClick={() => setView({ type: "detail", id: item.id })}
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
                          {fmtDate(item.receipt_date)}
                        </div>
                        <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{item.receipt_number}</div>
                      </div>
                      <DeskChip label={String(item.receipt_status || "draft").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{item.customer_name}</div>
                    {String(item.receipt_source || "").toLowerCase() === "tally_import" ? (
                      <DeskChip label="Tally Import" tone="#ecfdf5" color="#047857" />
                    ) : null}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Allocated" value={fmtMoney(item.allocated_amount_invoice, item.receipt_currency_code)} />
                      <MiniMetric label="Unallocated" value={fmtMoney(item.unallocated_amount_invoice, item.receipt_currency_code)} />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No receipts yet. Create the first receipt from an invoice.
            </div>
          )}
        </DeskCard>
      </div>
    </div>
    <SlideOverDrawer
      open={view.type === "detail"}
      onClose={closeDetail}
      eyebrow="Customer Receipt"
      title={view.type === "detail" ? `Receipt #${view.id}` : "Receipt"}
      subtitle="Collection queues stay open behind this drawer — close when allocation work is done."
      width={900}
    >
      {view.type === "detail" ? (
        <ReceiptDetail
          id={view.id}
          embedded
          onBack={closeDetail}
          onOpenInvoice={onOpenInvoice}
          onNotice={(msg) => setNotice(msg)}
        />
      ) : null}
    </SlideOverDrawer>
    <SlideOverDrawer
      open={view.type === "create"}
      onClose={closeCreate}
      eyebrow="Customer Receipt"
      title="Create Receipt"
      subtitle="Capture payment details, then allocate to open invoices."
      width={900}
    >
      {view.type === "create" ? (
        <ReceiptCreate
          embedded
          onCancel={closeCreate}
          onCreated={(id) => setView({ type: "detail", id })}
        />
      ) : null}
    </SlideOverDrawer>
    </>
  );
}

function ReceiptCreate({ onCancel, onCreated, embedded = false }) {
  const [customerQ, setCustomerQ] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [financeBooks, setFinanceBooks] = useState([]);
  const [form, setForm] = useState({
    receipt_date: new Date().toISOString().slice(0, 10),
    receipt_amount_invoice: "",
    finance_book_id: "",
    payment_mode: "",
    reference_no: "",
    bank_name: "",
    remarks: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedCustomer = useMemo(() => {
    const id = customerId ? Number(customerId) : null;
    if (!id) return null;
    return customerResults.find((c) => c.id === id) || null;
  }, [customerId, customerResults]);

  useEffect(() => {
    apiFetch("/bank-book/bootstrap")
      .then((data) => setFinanceBooks(Array.isArray(data?.books) ? data.books : []))
      .catch(() => setFinanceBooks([]));
  }, []);

  async function searchCustomers() {
    setError("");
    try {
      const qp = customerQ.trim().length ? `?q=${encodeURIComponent(customerQ.trim())}` : "";
      const data = await apiFetch(`/customers${qp}`);
      setCustomerResults(Array.isArray(data?.customers) ? data.customers : []);
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to search customers.");
    }
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/receipts", {
        method: "POST",
        body: JSON.stringify({
          customer_id: Number(customerId),
          receipt_date: form.receipt_date || null,
          receipt_amount_invoice: Number(form.receipt_amount_invoice || 0),
          finance_book_id: form.finance_book_id ? Number(form.finance_book_id) : null,
          payment_mode: form.payment_mode || null,
          reference_no: form.reference_no || null,
          bank_name: form.bank_name || null,
          remarks: form.remarks || null,
        }),
      });
      const id = Number(data?.receipt?.id || 0);
      if (!id) throw new Error("Missing receipt id");
      setNotice("Receipt created.");
      onCreated?.(id);
    } catch (e2) {
      const code = e2?.data?.error;
      if (code === "COMPANY_NOT_SELECTED") setError("Select company context before creating receipts.");
      else if (code === "INVALID_CUSTOMER") setError("Select a customer.");
      else if (code === "INVALID_RECEIPT_AMOUNT") setError("Receipt amount must be greater than 0.");
      else if (code === "CUSTOMER_NOT_ALLOWED") setError("Customer not allowed for this distributor.");
      else if (code === "BOOK_NOT_FOUND") setError("Selected bank/cash book is not available.");
      else setError(code || "Failed to create receipt.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 1200 }}>
      <PageHero
        eyebrow="Collection Desk"
        title="Create Receipt"
        description="Capture cash received first, then allocate it across invoices from the allocation rail."
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {!embedded ? (
              <button type="button" onClick={onCancel}>
                Back
              </button>
            ) : (
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button type="submit" disabled={saving || !customerId}>
              {saving ? "Creating..." : "Create"}
            </button>
          </div>
        }
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(320px, 0.8fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Customer" subtitle="Search and select the customer receiving this payment">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input value={customerQ} onChange={(e) => setCustomerQ(e.target.value)} placeholder="Search customer" style={{ minWidth: 240, ...inputStyle() }} />
            <button type="button" onClick={() => searchCustomers().catch(() => {})}>
              Search
            </button>
          </div>
          {selectedCustomer ? (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <DeskChip label={`Selected: ${selectedCustomer.customer_name}`} tone="#eef4ff" color="#234a8f" />
              <button type="button" onClick={() => setCustomerId("")}>
                Clear
              </button>
            </div>
          ) : null}
          {customerResults.length ? (
            <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
              {customerResults.slice(0, 10).map((row) => (
                <button
                  type="button"
                  key={row.id}
                  onClick={() => setCustomerId(String(row.id))}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e7ebf3",
                    borderRadius: 14,
                    padding: 10,
                    background: customerId && Number(customerId) === Number(row.id) ? "#eef4ff" : "#ffffff",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{row.customer_name}</div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>{row.customer_code || "—"}</div>
                </button>
              ))}
            </div>
          ) : null}
        </DeskCard>

        <DeskCard title="Receipt Header" subtitle="Capture the payment details (allocations happen next)">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <FieldLabel label="Receipt date">
              <input type="date" value={form.receipt_date} onChange={(e) => setForm((p) => ({ ...p, receipt_date: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="Amount received">
              <input value={form.receipt_amount_invoice} onChange={(e) => setForm((p) => ({ ...p, receipt_amount_invoice: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="Payment mode">
              <input value={form.payment_mode} onChange={(e) => setForm((p) => ({ ...p, payment_mode: e.target.value }))} placeholder="NEFT / RTGS / Cheque / Cash" style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="Reference no">
              <input value={form.reference_no} onChange={(e) => setForm((p) => ({ ...p, reference_no: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="Bank name">
              <input value={form.bank_name} onChange={(e) => setForm((p) => ({ ...p, bank_name: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="Bank / Cash book">
              <select value={form.finance_book_id} onChange={(e) => setForm((p) => ({ ...p, finance_book_id: e.target.value }))} style={inputStyle()}>
                <option value="">-- None --</option>
                {financeBooks.map((book) => (
                  <option key={book.id} value={String(book.id)}>
                    {book.book_name}
                  </option>
                ))}
              </select>
            </FieldLabel>
          </div>
          <FieldLabel label="Remarks" style={{ marginTop: 12 }}>
            <textarea rows={4} style={textAreaStyle()} value={form.remarks} onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))} />
          </FieldLabel>
        </DeskCard>
      </div>
    </form>
  );
}

function CommercialFailureEditor({ detail, loading, onCreate, onSave, onOpenSalesReturn, onCreateCreditNoteFromInvoice }) {
  const [ncrForm, setNcrForm] = useState(() => buildCommercialNcrForm(detail));
  const [creating, setCreating] = useState(false);
  const [localError, setLocalError] = useState("");
  const capaActionsByCaseId = useMemo(() => {
    const map = new Map();
    const actions = Array.isArray(detail?.capa_actions) ? detail.capa_actions : [];
    actions.forEach((row) => {
      const key = Number(row.ncr_case_id || 0);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        ...row,
        due_date: row.due_date ? String(row.due_date).slice(0, 10) : "",
        completed_date: row.completed_date ? String(row.completed_date).slice(0, 10) : "",
      });
    });
    return map;
  }, [detail]);

  useEffect(() => {
    setNcrForm(buildCommercialNcrForm(detail));
  }, [detail]);

  async function createCase() {
    if (!String(ncrForm.defect_summary || "").trim()) {
      setLocalError("Defect summary is required.");
      return;
    }
    setCreating(true);
    setLocalError("");
    try {
      await onCreate({
        sales_return_id: ncrForm.sales_return_id ? Number(ncrForm.sales_return_id) : null,
        severity: ncrForm.severity,
        category: ncrForm.category,
        qty_affected: Number(ncrForm.qty_affected || 0),
        defect_summary: ncrForm.defect_summary,
        containment_action: ncrForm.containment_action || null,
        containment_due_date: ncrForm.containment_due_date || null,
        remarks: ncrForm.remarks || null,
      });
    } catch {
      // parent handles user-facing error
    } finally {
      setCreating(false);
    }
  }

  if (loading && !detail?.dispute) return <div>Loading commercial failure detail…</div>;

  const dispute = detail?.dispute || null;
  const ncrCases = Array.isArray(detail?.ncr_cases) ? detail.ncr_cases : [];

  return (
    <div style={{ border: "1px solid #edf1f6", borderRadius: 16, padding: 14, background: "#fbfcff", display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 800 }}>Commercial Failure Editor</div>
          <div style={{ fontSize: 12, opacity: 0.72 }}>
            {dispute?.customer_name || "Customer"}
            {dispute?.invoice_number ? ` • ${dispute.invoice_number}` : ""}
            {dispute?.dispute_reason ? ` • ${dispute.dispute_reason}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {dispute?.sales_return_id ? (
            <button type="button" onClick={() => onOpenSalesReturn?.(dispute.sales_return_id)}>
              Open Credit Note
            </button>
          ) : dispute?.customer_invoice_id ? (
            <button type="button" onClick={() => onCreateCreditNoteFromInvoice?.(dispute.customer_invoice_id, dispute.id)}>
              Create Credit Note
            </button>
          ) : null}
        </div>
      </div>

      {localError ? <div style={{ color: "#b00020", fontSize: 12 }}>{localError}</div> : null}

      {!ncrCases.length ? (
        <div style={{ border: "1px dashed #d5dcec", borderRadius: 14, padding: 12, background: "#ffffff", display: "grid", gap: 12 }}>
          <div style={{ fontWeight: 700 }}>Raise NCR From Dispute</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
            <FieldLabel label="Linked return">
              <input value={ncrForm.sales_return_id} onChange={(e) => setNcrForm((prev) => ({ ...prev, sales_return_id: e.target.value }))} style={inputStyle()} placeholder="Optional sales return id" />
            </FieldLabel>
            <FieldLabel label="Severity">
              <select value={ncrForm.severity} onChange={(e) => setNcrForm((prev) => ({ ...prev, severity: e.target.value }))} style={inputStyle()}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </FieldLabel>
            <FieldLabel label="Category">
              <select value={ncrForm.category} onChange={(e) => setNcrForm((prev) => ({ ...prev, category: e.target.value }))} style={inputStyle()}>
                <option value="other">Other</option>
                <option value="documentation">Documentation</option>
                <option value="packaging">Packaging</option>
                <option value="process_deviation">Process deviation</option>
                <option value="vendor_quality">Vendor quality</option>
                <option value="incoming_defect">Incoming defect</option>
              </select>
            </FieldLabel>
            <FieldLabel label="Qty / Amount affected">
              <input value={ncrForm.qty_affected} onChange={(e) => setNcrForm((prev) => ({ ...prev, qty_affected: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
          </div>
          <FieldLabel label="Defect summary">
            <textarea value={ncrForm.defect_summary} onChange={(e) => setNcrForm((prev) => ({ ...prev, defect_summary: e.target.value }))} rows={3} style={textAreaStyle()} />
          </FieldLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 12 }}>
            <FieldLabel label="Immediate containment">
              <textarea value={ncrForm.containment_action} onChange={(e) => setNcrForm((prev) => ({ ...prev, containment_action: e.target.value }))} rows={3} style={textAreaStyle()} />
            </FieldLabel>
            <FieldLabel label="Containment due">
              <input type="date" value={ncrForm.containment_due_date} onChange={(e) => setNcrForm((prev) => ({ ...prev, containment_due_date: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
          </div>
          <FieldLabel label="Remarks">
            <textarea value={ncrForm.remarks} onChange={(e) => setNcrForm((prev) => ({ ...prev, remarks: e.target.value }))} rows={2} style={textAreaStyle()} />
          </FieldLabel>
          <div>
            <button type="button" onClick={() => createCase().catch(() => {})} disabled={creating}>
              {creating ? "Raising..." : "Raise NCR"}
            </button>
          </div>
        </div>
      ) : null}

      {ncrCases.length ? (
        <div style={{ display: "grid", gap: 12 }}>
          {ncrCases.map((ncr) => (
            <CommercialNcrCaseCard
              key={ncr.id}
              ncr={ncr}
              actions={capaActionsByCaseId.get(Number(ncr.id)) || []}
              onSave={(payload) => onSave(ncr.id, payload)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CommercialNcrCaseCard({ ncr, actions, onSave }) {
  const [draft, setDraft] = useState(() => ({
    sales_return_id: ncr.sales_return_id ? String(ncr.sales_return_id) : "",
    severity: ncr.severity || "medium",
    category: ncr.category || "other",
    qty_affected: String(ncr.qty_affected ?? ""),
    defect_summary: ncr.defect_summary || "",
    containment_action: ncr.containment_action || "",
    containment_due_date: ncr.containment_due_date ? String(ncr.containment_due_date).slice(0, 10) : "",
    containment_completed_date: ncr.containment_completed_date ? String(ncr.containment_completed_date).slice(0, 10) : "",
    root_cause: ncr.root_cause || "",
    corrective_plan: ncr.corrective_plan || "",
    preventive_plan: ncr.preventive_plan || "",
    verification_method: ncr.verification_method || "",
    verification_date: ncr.verification_date ? String(ncr.verification_date).slice(0, 10) : "",
    remarks: ncr.remarks || "",
  }));
  const [actionDrafts, setActionDrafts] = useState(() => actions.map((row) => buildCapaActionDraft(row)));
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    setDraft({
      sales_return_id: ncr.sales_return_id ? String(ncr.sales_return_id) : "",
      severity: ncr.severity || "medium",
      category: ncr.category || "other",
      qty_affected: String(ncr.qty_affected ?? ""),
      defect_summary: ncr.defect_summary || "",
      containment_action: ncr.containment_action || "",
      containment_due_date: ncr.containment_due_date ? String(ncr.containment_due_date).slice(0, 10) : "",
      containment_completed_date: ncr.containment_completed_date ? String(ncr.containment_completed_date).slice(0, 10) : "",
      root_cause: ncr.root_cause || "",
      corrective_plan: ncr.corrective_plan || "",
      preventive_plan: ncr.preventive_plan || "",
      verification_method: ncr.verification_method || "",
      verification_date: ncr.verification_date ? String(ncr.verification_date).slice(0, 10) : "",
      remarks: ncr.remarks || "",
    });
    setActionDrafts(actions.map((row) => buildCapaActionDraft(row)));
  }, [ncr, actions]);

  async function saveCase() {
    if (!String(draft.defect_summary || "").trim()) {
      setLocalError("Defect summary is required.");
      return;
    }
    setSaving(true);
    setLocalError("");
    try {
      await onSave({
        sales_return_id: draft.sales_return_id ? Number(draft.sales_return_id) : null,
        severity: draft.severity,
        category: draft.category,
        qty_affected: Number(draft.qty_affected || 0),
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
    } catch {
      // parent handles user-facing error
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 12, background: "#ffffff", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 800 }}>{ncr.ncr_number}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            <DeskChip label={ncrStatusLabel(ncr.status)} tone={ncrStatusTone(ncr.status).bg} color={ncrStatusTone(ncr.status).color} />
            {ncr.return_number ? <DeskChip label={`Return ${ncr.return_number}`} tone="#eefaf1" color="#0a7a35" /> : null}
          </div>
        </div>
        <button type="button" onClick={() => saveCase().catch(() => {})} disabled={saving}>
          {saving ? "Saving..." : "Save NCR / CAPA"}
        </button>
      </div>
      {localError ? <div style={{ color: "#b00020", fontSize: 12 }}>{localError}</div> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
        <FieldLabel label="Linked return">
          <input value={draft.sales_return_id} onChange={(e) => setDraft((prev) => ({ ...prev, sales_return_id: e.target.value }))} style={inputStyle()} />
        </FieldLabel>
        <FieldLabel label="Severity">
          <select value={draft.severity} onChange={(e) => setDraft((prev) => ({ ...prev, severity: e.target.value }))} style={inputStyle()}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </FieldLabel>
        <FieldLabel label="Category">
          <select value={draft.category} onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))} style={inputStyle()}>
            <option value="other">Other</option>
            <option value="documentation">Documentation</option>
            <option value="packaging">Packaging</option>
            <option value="process_deviation">Process deviation</option>
            <option value="vendor_quality">Vendor quality</option>
            <option value="incoming_defect">Incoming defect</option>
          </select>
        </FieldLabel>
        <FieldLabel label="Qty / Amount affected">
          <input value={draft.qty_affected} onChange={(e) => setDraft((prev) => ({ ...prev, qty_affected: e.target.value }))} style={inputStyle()} />
        </FieldLabel>
      </div>
      <FieldLabel label="Defect summary">
        <textarea value={draft.defect_summary} onChange={(e) => setDraft((prev) => ({ ...prev, defect_summary: e.target.value }))} rows={2} style={textAreaStyle()} />
      </FieldLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 220px 220px", gap: 12 }}>
        <FieldLabel label="Containment action">
          <textarea value={draft.containment_action} onChange={(e) => setDraft((prev) => ({ ...prev, containment_action: e.target.value }))} rows={3} style={textAreaStyle()} />
        </FieldLabel>
        <FieldLabel label="Containment due">
          <input type="date" value={draft.containment_due_date} onChange={(e) => setDraft((prev) => ({ ...prev, containment_due_date: e.target.value }))} style={inputStyle()} />
        </FieldLabel>
        <FieldLabel label="Containment done">
          <input type="date" value={draft.containment_completed_date} onChange={(e) => setDraft((prev) => ({ ...prev, containment_completed_date: e.target.value }))} style={inputStyle()} />
        </FieldLabel>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <FieldLabel label="Root cause">
          <textarea value={draft.root_cause} onChange={(e) => setDraft((prev) => ({ ...prev, root_cause: e.target.value }))} rows={3} style={textAreaStyle()} />
        </FieldLabel>
        <FieldLabel label="Corrective plan">
          <textarea value={draft.corrective_plan} onChange={(e) => setDraft((prev) => ({ ...prev, corrective_plan: e.target.value }))} rows={3} style={textAreaStyle()} />
        </FieldLabel>
        <FieldLabel label="Preventive plan">
          <textarea value={draft.preventive_plan} onChange={(e) => setDraft((prev) => ({ ...prev, preventive_plan: e.target.value }))} rows={3} style={textAreaStyle()} />
        </FieldLabel>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 12 }}>
        <FieldLabel label="Verification method">
          <input value={draft.verification_method} onChange={(e) => setDraft((prev) => ({ ...prev, verification_method: e.target.value }))} style={inputStyle()} />
        </FieldLabel>
        <FieldLabel label="Verification date">
          <input type="date" value={draft.verification_date} onChange={(e) => setDraft((prev) => ({ ...prev, verification_date: e.target.value }))} style={inputStyle()} />
        </FieldLabel>
      </div>
      <FieldLabel label="Remarks">
        <textarea value={draft.remarks} onChange={(e) => setDraft((prev) => ({ ...prev, remarks: e.target.value }))} rows={2} style={textAreaStyle()} />
      </FieldLabel>
      <div style={{ borderTop: "1px solid #edf1f6", paddingTop: 10, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ fontWeight: 700 }}>CAPA Actions</div>
          <button type="button" onClick={() => setActionDrafts((prev) => [...prev, buildCapaActionDraft()])}>Add Action</button>
        </div>
        {actionDrafts.map((row, index) => (
          <div key={row.id || `draft-${index}`} style={{ border: "1px solid #edf1f6", borderRadius: 12, padding: 10, display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 180px 180px auto", gap: 10 }}>
              <FieldLabel label="Type">
                <select value={row.action_type} onChange={(e) => setActionDrafts((prev) => prev.map((item, i) => (i === index ? { ...item, action_type: e.target.value } : item)))} style={inputStyle()}>
                  <option value="correction">Correction</option>
                  <option value="corrective">Corrective</option>
                  <option value="preventive">Preventive</option>
                </select>
              </FieldLabel>
              <FieldLabel label="Due date">
                <input type="date" value={row.due_date} onChange={(e) => setActionDrafts((prev) => prev.map((item, i) => (i === index ? { ...item, due_date: e.target.value } : item)))} style={inputStyle()} />
              </FieldLabel>
              <FieldLabel label="Status">
                <select value={row.action_status} onChange={(e) => setActionDrafts((prev) => prev.map((item, i) => (i === index ? { ...item, action_status: e.target.value } : item)))} style={inputStyle()}>
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="done">Done</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </FieldLabel>
              <button type="button" onClick={() => setActionDrafts((prev) => prev.filter((_, i) => i !== index))} style={{ alignSelf: "end" }}>
                Remove
              </button>
            </div>
            <FieldLabel label="Action title">
              <input value={row.action_title} onChange={(e) => setActionDrafts((prev) => prev.map((item, i) => (i === index ? { ...item, action_title: e.target.value } : item)))} style={inputStyle()} />
            </FieldLabel>
            <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 10 }}>
              <FieldLabel label="Completed date">
                <input type="date" value={row.completed_date} onChange={(e) => setActionDrafts((prev) => prev.map((item, i) => (i === index ? { ...item, completed_date: e.target.value } : item)))} style={inputStyle()} />
              </FieldLabel>
              <FieldLabel label="Completion note">
                <input value={row.completion_note} onChange={(e) => setActionDrafts((prev) => prev.map((item, i) => (i === index ? { ...item, completion_note: e.target.value } : item)))} style={inputStyle()} />
              </FieldLabel>
            </div>
          </div>
        ))}
        {!actionDrafts.length ? <div style={{ fontSize: 12, opacity: 0.72 }}>No CAPA actions added yet.</div> : null}
      </div>
    </div>
  );
}

function ReceiptDetail({ id, onBack, onOpenInvoice, onNotice, embedded = false }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [financeBooks, setFinanceBooks] = useState([]);
  const [receipt, setReceipt] = useState(null);
  const [allocationRows, setAllocationRows] = useState([]);
  const [form, setForm] = useState({
    receipt_status: "draft",
    receipt_date: "",
    receipt_amount_invoice: "",
    finance_book_id: "",
    payment_mode: "",
    reference_no: "",
    bank_name: "",
    remarks: "",
  });

  useEffect(() => {
    setLoading(true);
    Promise.all([apiFetch(`/receipts/${id}`), apiFetch("/bank-book/bootstrap").catch(() => ({ books: [] }))])
      .then(([data, booksData]) => {
        const header = data?.receipt || null;
        const allocations = Array.isArray(data?.allocations) ? data.allocations : [];
        const openInvoices = Array.isArray(data?.open_invoices) ? data.open_invoices : [];
        setFinanceBooks(Array.isArray(booksData?.books) ? booksData.books : []);
        setReceipt(header);
        setAllocationRows(buildAllocationRows(openInvoices, allocations));
        setForm({
          receipt_status: header?.receipt_status || "draft",
          receipt_date: header?.receipt_date ? String(header.receipt_date).slice(0, 10) : "",
          receipt_amount_invoice: String(header?.receipt_amount_invoice ?? 0),
          finance_book_id: header?.finance_book_id ? String(header.finance_book_id) : "",
          payment_mode: header?.payment_mode || "",
          reference_no: header?.reference_no || "",
          bank_name: header?.bank_name || "",
          remarks: header?.remarks || "",
        });
      })
      .catch((e) => setError(getErrorMessage(e, "Failed to load receipt.")))
      .finally(() => setLoading(false));
  }, [id]);

  const allocatedPreview = useMemo(
    () => allocationRows.reduce((sum, row) => sum + Number(row.allocated_invoice || 0), 0),
    [allocationRows]
  );
  const unallocatedPreview = Number(form.receipt_amount_invoice || 0) - allocatedPreview;
  const statusMeta = statusAppearance(form.receipt_status);
  const canEditReceipt = String(receipt?.receipt_status || "").toLowerCase() === "draft";
  const canEditAllocations = ["draft", "posted"].includes(String(receipt?.receipt_status || "").toLowerCase());

  function autoAllocate() {
    const receiptAmount = roundMoney(form.receipt_amount_invoice || 0);
    let remaining = roundMoney(receiptAmount - allocationRows.reduce((sum, row) => sum + roundMoney(row.allocated_invoice || 0), 0));
    if (remaining <= 0.0001) return;

    setAllocationRows((prev) => {
      const ordered = [...prev].sort((a, b) => {
        const aDue = a.due_date ? new Date(a.due_date).getTime() : 0;
        const bDue = b.due_date ? new Date(b.due_date).getTime() : 0;
        if (aDue !== bDue) return aDue - bDue;
        const aInv = a.invoice_date ? new Date(a.invoice_date).getTime() : 0;
        const bInv = b.invoice_date ? new Date(b.invoice_date).getTime() : 0;
        if (aInv !== bInv) return aInv - bInv;
        return String(a.invoice_number || "").localeCompare(String(b.invoice_number || ""));
      });

      const nextMap = new Map();
      for (const row of ordered) {
        const already = roundMoney(row.allocated_invoice || 0);
        const maxAvail = Math.max(roundMoney(row.invoice_outstanding_before_current || 0) - already, 0);
        const add = remaining > 0 ? Math.min(maxAvail, remaining) : 0;
        const updated = roundMoney(already + add);
        remaining = roundMoney(remaining - add);
        nextMap.set(row.customer_invoice_id, { ...row, allocated_invoice: updated ? String(updated) : "0" });
      }
      return prev.map((row) => nextMap.get(row.customer_invoice_id) || row);
    });
  }

  async function saveReceipt() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payloadAllocations = allocationRows.map((row) => ({
        customer_invoice_id: row.customer_invoice_id,
        allocated_invoice: Number(row.allocated_invoice || 0),
      }));

      const data = canEditReceipt
        ? await apiFetch(`/receipts/${id}`, {
            method: "PUT",
            body: JSON.stringify({
              ...form,
              receipt_amount_invoice: Number(form.receipt_amount_invoice || 0),
              finance_book_id: form.finance_book_id ? Number(form.finance_book_id) : null,
              allocations: payloadAllocations,
            }),
          })
        : await apiFetch(`/receipts/${id}/allocations`, {
            method: "PUT",
            body: JSON.stringify({
              allocations: payloadAllocations,
            }),
          });
      const header = data?.receipt || receipt;
      const allocations = Array.isArray(data?.allocations) ? data.allocations : [];
      const openInvoices = Array.isArray(data?.open_invoices) ? data.open_invoices : [];
      setReceipt(header);
      setAllocationRows(buildAllocationRows(openInvoices, allocations));
      if (canEditReceipt) {
        setForm((prev) => ({
          ...prev,
          receipt_status: header?.receipt_status || prev.receipt_status,
          receipt_date: header?.receipt_date ? String(header.receipt_date).slice(0, 10) : prev.receipt_date,
          receipt_amount_invoice: String(header?.receipt_amount_invoice ?? prev.receipt_amount_invoice),
          finance_book_id: header?.finance_book_id ? String(header.finance_book_id) : prev.finance_book_id,
        }));
      } else {
        setForm((prev) => ({
          ...prev,
          receipt_status: header?.receipt_status || prev.receipt_status,
          receipt_amount_invoice: String(header?.receipt_amount_invoice ?? prev.receipt_amount_invoice),
        }));
      }
      setNotice(canEditReceipt ? "Receipt updated successfully." : "Allocations updated successfully.");
      onNotice?.(canEditReceipt ? "Receipt updated successfully." : "Allocations updated successfully.");
    } catch (e) {
      const code = e?.data?.error;
      if (code === "INVALID_ALLOCATION") setError("Allocation must be between 0 and invoice outstanding.");
      else if (code === "RECEIPT_OVER_ALLOCATED") setError("Allocated total cannot exceed receipt amount.");
      else if (code === "NO_ALLOCATIONS") setError("At least one allocation is required.");
      else if (code === "RECEIPT_NOT_EDITABLE") setError("Only draft receipts can be edited. Cancelled receipts are read-only.");
      else if (code === "RECEIPT_CANCELLED") setError("Cancelled receipts are read-only.");
      else setError(code || "Failed to save receipt.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div>Loading receipt…</div>;
  if (!receipt) {
    return (
      <div>
        {!embedded ? <button onClick={onBack}>Back</button> : null}
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Receipt not found."}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Receipt Allocation Desk"
        title={receipt.receipt_number}
        description={`${receipt.customer_name || "Customer pending"} • ${receipt.receipt_status || "draft"} • Work the amount and allocations from the same operator surface.`}
        actions={
          <>
            {!embedded ? <button onClick={onBack}>Back</button> : null}
            <a href={`/receipts/${id}/pdf`} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              <button type="button">Receipt PDF</button>
            </a>
            <a href={`/receipts/customer/${receipt.customer_id}/statement/pdf`} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              <button type="button">Statement PDF</button>
            </a>
            {canEditAllocations ? (
              <>
                <button type="button" onClick={autoAllocate} disabled={saving || unallocatedPreview <= 0.0001}>
                  Auto Allocate
                </button>
                <button onClick={saveReceipt} disabled={saving}>
                  {saving ? "Saving..." : canEditReceipt ? "Save Receipt" : "Save Allocations"}
                </button>
              </>
            ) : null}
          </>
        }
        stats={[
          { label: "Status", value: String(form.receipt_status || "draft").toUpperCase(), tone: statusMeta.color },
          { label: "Receipt Amount", value: fmtMoney(form.receipt_amount_invoice, receipt.receipt_currency_code), tone: "#143d7a" },
          { label: "Allocated", value: fmtMoney(allocatedPreview, receipt.receipt_currency_code), tone: "#234a8f" },
          { label: "Unallocated", value: fmtMoney(unallocatedPreview, receipt.receipt_currency_code), tone: "#0a7a35" },
        ]}
      />
      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(320px, 0.8fr)", gap: 16, alignItems: "start" }}>
        <DeskCard
          title="Receipt Header"
          subtitle="Collection controls and reference details stay close to the allocation rail"
          actions={<DeskChip label={String(form.receipt_status || "draft").toUpperCase()} tone={statusMeta.tone} color={statusMeta.color} />}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <FieldLabel label="Status">
              <select
                value={form.receipt_status}
                disabled={!canEditReceipt}
                onChange={(e) => setForm((p) => ({ ...p, receipt_status: e.target.value }))}
                style={inputStyle(!canEditReceipt)}
              >
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </FieldLabel>
            <FieldLabel label="Receipt Date">
              <input
                type="date"
                value={form.receipt_date}
                disabled={!canEditReceipt}
                onChange={(e) => setForm((p) => ({ ...p, receipt_date: e.target.value }))}
                style={inputStyle(!canEditReceipt)}
              />
            </FieldLabel>
            <FieldLabel label="Receipt Amount">
              <input
                value={form.receipt_amount_invoice}
                disabled={!canEditReceipt}
                onChange={(e) => setForm((p) => ({ ...p, receipt_amount_invoice: e.target.value }))}
                style={inputStyle(!canEditReceipt)}
              />
            </FieldLabel>
            <FieldLabel label="Payment Mode">
              <input
                value={form.payment_mode}
                disabled={!canEditReceipt}
                onChange={(e) => setForm((p) => ({ ...p, payment_mode: e.target.value }))}
                placeholder="NEFT / RTGS / Cheque / Cash"
                style={inputStyle(!canEditReceipt)}
              />
            </FieldLabel>
            <FieldLabel label="Bank / Cash Book">
              <select
                value={form.finance_book_id}
                disabled={!canEditReceipt}
                onChange={(e) => setForm((p) => ({ ...p, finance_book_id: e.target.value }))}
                style={inputStyle(!canEditReceipt)}
              >
                <option value="">-- None --</option>
                {financeBooks.map((book) => (
                  <option key={book.id} value={String(book.id)}>
                    {book.book_name}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel label="Reference No">
              <input
                value={form.reference_no}
                disabled={!canEditReceipt}
                onChange={(e) => setForm((p) => ({ ...p, reference_no: e.target.value }))}
                style={inputStyle(!canEditReceipt)}
              />
            </FieldLabel>
            <FieldLabel label="Bank Name">
              <input
                value={form.bank_name}
                disabled={!canEditReceipt}
                onChange={(e) => setForm((p) => ({ ...p, bank_name: e.target.value }))}
                style={inputStyle(!canEditReceipt)}
              />
            </FieldLabel>
          </div>
          <FieldLabel label="Remarks" style={{ marginTop: 12 }}>
            <textarea
              rows={4}
              disabled={!canEditReceipt}
              style={textAreaStyle(!canEditReceipt)}
              value={form.remarks}
              onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))}
            />
          </FieldLabel>
        </DeskCard>

        <DeskCard title="Receipt Summary" subtitle="Fast preview of the document outcome before posting">
          <div style={{ display: "grid", gap: 10 }}>
            <MiniMetric label="Customer" value={receipt.customer_name || "—"} />
            <MiniMetric label="Currency" value={receipt.receipt_currency_code || "—"} />
            <MiniMetric label="Book" value={receipt.finance_book_name || "—"} />
            <MiniMetric label="Allocated" value={fmtMoney(allocatedPreview, receipt.receipt_currency_code)} />
            <MiniMetric label="Unallocated" value={fmtMoney(unallocatedPreview, receipt.receipt_currency_code)} />
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard
          title="Invoice Allocations"
          subtitle="Allocation cards keep invoice context readable while editing amounts"
          actions={
            <DeskChip
              label={String(receipt.receipt_status || "").toLowerCase() === "draft" ? "DRAFT ALLOCATION" : String(receipt.receipt_status || "").toLowerCase() === "posted" ? "POSTED ALLOCATION" : "LOCKED"}
              tone={canEditAllocations ? "#eef4ff" : "#f5f6fa"}
              color={canEditAllocations ? "#234a8f" : "#5d6782"}
            />
          }
        >
          {allocationRows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {allocationRows.map((row) => (
                <div key={row.customer_invoice_id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#fcfdff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <button onClick={() => onOpenInvoice?.(row.customer_invoice_id)} style={{ all: "unset", cursor: "pointer", color: "#0f4aa1", fontWeight: 700 }}>
                      {row.invoice_number}
                    </button>
                    <DeskChip label={String(row.invoice_status || "open").toUpperCase()} tone="#eef4ff" color="#234a8f" />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
                    <MiniMetric label="Invoice Date" value={fmtDate(row.invoice_date)} />
                    <MiniMetric label="Due Date" value={fmtDate(row.due_date)} />
                    <MiniMetric label="Total" value={fmtMoney(row.invoice_total_invoice, receipt.receipt_currency_code)} />
                    <MiniMetric label="Available" value={fmtMoney(row.invoice_outstanding_before_current, receipt.receipt_currency_code)} />
                  </div>
                  <FieldLabel label="Allocate" style={{ marginTop: 12 }}>
                    <input
                      value={row.allocated_invoice}
                      disabled={!canEditAllocations}
                      onChange={(e) =>
                        setAllocationRows((prev) =>
                          prev.map((item) =>
                            item.customer_invoice_id === row.customer_invoice_id ? { ...item, allocated_invoice: e.target.value } : item
                          )
                        )
                      }
                      style={inputStyle(!canEditAllocations)}
                    />
                  </FieldLabel>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No invoices are available for allocation on this receipt.
            </div>
          )}
        </DeskCard>
      </div>
    </div>
  );
}
