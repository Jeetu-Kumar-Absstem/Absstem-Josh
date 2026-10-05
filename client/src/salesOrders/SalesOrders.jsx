import { useEffect, useMemo, useRef, useState } from "react";
import SlideOverDrawer from "../components/SlideOverDrawer";
import { DeskCard, DeskChip, DeskStat, MiniMetric, PressFitLinker, getDeskStatusAppearance, toast } from "../shared/joshUi";
import SiteReadinessPanel, { isSiteReadinessApproved } from "../fieldService/SiteReadinessPanel";
import BlockerRibbon from "../shared/BlockerRibbon";
import CreditReleasePanel from "../shared/CreditReleasePanel";
import OrderFlightLog from "../shared/OrderFlightLog";
import { ListPager, useDeskHotkeys } from "../shared/listScale";
import { useGlobalTimeline } from "../timeline/GlobalTimelineContext";
import { appendTimelineParams } from "../timeline/globalTimeline";

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

function fulfillmentRiskAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "production_blocked") return { tone: "#fff2f2", color: "#a52323", label: "Production Blocked" };
  if (key === "confirmed_no_dispatch") return { tone: "#fff7ea", color: "#8b5a00", label: "Confirmed No Dispatch" };
  if (key === "ready_for_dispatch") return { tone: "#eefbf3", color: "#147a3d", label: "Ready for Dispatch" };
  if (key === "dispatched_not_invoiced") return { tone: "#eef4ff", color: "#234a8f", label: "Dispatched Not Invoiced" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "Fulfillment") };
}

function billingControlAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "dispatched_no_invoice") return { tone: "#fff2f2", color: "#a52323", label: "Dispatched No Invoice" };
  if (key === "draft_pending_issue") return { tone: "#fff7ea", color: "#8b5a00", label: "Draft Pending Issue" };
  if (key === "invoice_qty_pending") return { tone: "#eef4ff", color: "#234a8f", label: "Invoice Qty Pending" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "Billing") };
}

const FULFILLMENT_RISK_BUCKETS = [
  ["all", "All signals"],
  ["production_blocked", "Production blocked"],
  ["confirmed_no_dispatch", "Confirmed no dispatch"],
  ["ready_for_dispatch", "Ready for dispatch"],
  ["dispatched_not_invoiced", "Dispatched not invoiced"],
];

const BILLING_CONTROL_BUCKETS = [
  ["all", "All signals"],
  ["dispatched_no_invoice", "Dispatched no invoice"],
  ["draft_pending_issue", "Draft pending issue"],
  ["invoice_qty_pending", "Invoice qty pending"],
];

const CLEARANCE_MODE_OPTIONS = [
  {
    key: "direct_customer",
    orderFlow: "direct",
    fulfillmentMode: "direct_customer",
    label: "Direct Customer Order",
    subtitle: "Customer is the buyer and the receiving party unless you override the ship-to.",
    accent: "#234a8f",
    tone: "#eef4ff",
  },
  {
    key: "stock_sale",
    orderFlow: "distributor",
    fulfillmentMode: "stock_sale",
    label: "Stock Sale To Distributor",
    subtitle: "Distributor is the buyer and the receiving party for stock replenishment or warehouse sale.",
    accent: "#8b5a00",
    tone: "#fff8ea",
  },
  {
    key: "direct_ship_end_customer",
    orderFlow: "distributor",
    fulfillmentMode: "direct_ship_end_customer",
    label: "Bill Distributor, Ship End Customer",
    subtitle: "Distributor places the PO, but the goods ship directly to the final end customer site.",
    accent: "#0a7a35",
    tone: "#effcf3",
  },
];

export default function SalesOrders({
  me,
  openSalesOrderId,
  launch,
  onConsumeLaunch,
  onOpenQuote,
  onOpenDispatch,
  onOpenInvoice,
  onOpenProforma,
  onOpenReceipt,
  onOpenDispatchesDesk,
  onOpenJobCardsDesk,
  onOpenCreditRelease,
} = {}) {
  const timeline = useGlobalTimeline();
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [orders, setOrders] = useState([]);
  const [listQuery, setListQuery] = useState("");
  const [listStatus, setListStatus] = useState("");
  const [listBucket, setListBucket] = useState("");
  const [listPage, setListPage] = useState(1);
  const [listMeta, setListMeta] = useState(null);
  const [selectedListId, setSelectedListId] = useState(null);
  const searchInputRef = useRef(null);
  const PAGE_SIZE = 50;
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskRows, setRiskRows] = useState([]);
  const [riskSummary, setRiskSummary] = useState(null);
  const [riskBucket, setRiskBucket] = useState("all");
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingRows, setBillingRows] = useState([]);
  const [billingSummary, setBillingSummary] = useState(null);
  const [billingBucket, setBillingBucket] = useState("all");
  const [convertQuotes, setConvertQuotes] = useState([]);
  const [convertQuotesLoading, setConvertQuotesLoading] = useState(false);
  const [convertQuoteId, setConvertQuoteId] = useState("");
  const [createdSoLabel, setCreatedSoLabel] = useState("");

  const selectedConvertQuote = useMemo(
    () => convertQuotes.find((q) => String(q.id) === String(convertQuoteId)) || null,
    [convertQuotes, convertQuoteId]
  );

  const orderStats = useMemo(() => {
    const serverCounts = listMeta?.status_counts && typeof listMeta.status_counts === "object" ? listMeta.status_counts : null;
    const countStatus = (status) =>
      serverCounts
        ? Number(serverCounts[status] || 0)
        : orders.filter((order) => String(order.order_status || "").toLowerCase() === status).length;
    return {
      total: orders.length,
      confirmed: countStatus("confirmed"),
      closed: countStatus("closed"),
      draft: countStatus("draft"),
      fromServer: Boolean(serverCounts),
    };
  }, [orders, listMeta]);

  async function loadList(overrides = {}) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : listQuery;
      const status = overrides.status !== undefined ? overrides.status : listStatus;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : listBucket;
      const page = overrides.page !== undefined ? overrides.page : listPage;
      const offset = Math.max(0, (Number(page) || 1) - 1) * PAGE_SIZE;
      if (qText) params.set("q", qText);
      if (status) params.set("status", status);
      if (bucket) params.set("bucket", bucket);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      appendTimelineParams(params, timeline);
      const data = await apiFetch(`/sales-orders${params.toString() ? `?${params.toString()}` : ""}`);
      const rows = Array.isArray(data?.sales_orders) ? data.sales_orders : [];
      setOrders(rows);
      setListMeta(data?.list || null);
      if (overrides.page !== undefined) setListPage(Number(overrides.page) || 1);
      const scopeCount = Number(data?.company_scope?.db_sales_order_count);
      if (!rows.length && Number.isFinite(scopeCount) && scopeCount > 0) {
        const filters = data?.diag?.filters;
        const filterHint = filters
          ? ` (status=${filters.status || "all"}, bucket=${filters.bucket || "all"}, q=${filters.q || ""})`
          : "";
        setError(
          `List returned 0 rows but company ${data.company_scope.active_company_id} has ${scopeCount} sales orders in DB${filterHint}. Redeploy API if this persists.`
        );
      } else if (!rows.length && data?.diag?.global?.so_count > 0) {
        const byCo = Array.isArray(data.diag.by_company)
          ? data.diag.by_company.map((row) => `${row.company_code || row.company_id}:${row.n}`).join(", ")
          : "";
        setError(
          `No sales orders for active company ${data.diag.active_company_id}. DB has ${data.diag.global.so_count} SOs total${byCo ? ` (${byCo})` : ""}. Switch company workspace if needed.`
        );
      }
    } catch (e) {
      setError(
        e?.data?.error === "DISTRIBUTOR_NOT_LINKED"
          ? "Distributor is not linked."
          : e?.data?.error === "COMPANY_NOT_SELECTED"
            ? "Select a company workspace (AI) before loading sales orders."
            : e?.data?.detail || e?.data?.error || "Failed to load sales orders."
      );
      setOrders([]);
      setListMeta(null);
    } finally {
      setLoading(false);
    }
  }

  useDeskHotkeys({
    enabled: view.type === "list",
    searchInputRef,
    onFocusSearch: () => searchInputRef.current?.focus(),
    onNew: typeof onOpenQuote === "function" ? () => loadConvertQuotes() : null,
    onOpenSelected: () => {
      if (selectedListId) setView({ type: "detail", id: selectedListId });
    },
  });

  async function loadFulfillmentRisk(nextQuery = listQuery, bucket = riskBucket) {
    setRiskLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery) summaryParams.set("q", nextQuery);
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/sales-orders/fulfillment-risk-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/sales-orders/fulfillment-risk-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setRiskSummary(summaryData?.summary || null);
      setRiskRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to load fulfillment risk.");
    } finally {
      setRiskLoading(false);
    }
  }

  async function loadConvertQuotes() {
    setConvertQuotesLoading(true);
    try {
      const data = await apiFetch("/quotes?bucket=unconverted");
      const rows = Array.isArray(data?.quotes) ? data.quotes : [];
      setConvertQuotes(
        rows.filter((q) => {
          const rev = String(q.revision_status || q.quote_status || "").toLowerCase();
          return rev.includes("issued") || rev.includes("sent") || rev.includes("approved");
        })
      );
    } catch {
      setConvertQuotes([]);
    } finally {
      setConvertQuotesLoading(false);
    }
  }

  function quoteToSoErrorMessage(err) {
    if (err?.data?.error === "SALES_ORDER_ALREADY_EXISTS") {
      return err?.data?.so_number
        ? `Sales order ${err.data.so_number} already exists for this quote.`
        : "A sales order already exists for this quote.";
    }
    if (err?.data?.error === "QUOTE_NOT_ISSUED") return "Only issued quote revisions can be converted into sales orders.";
    if (typeof err?.data?.detail === "string" && err.data.detail.trim()) return err.data.detail.trim();
    if (typeof err?.data?.error === "string" && err.data.error.trim()) return err.data.error.trim();
    return err?.message || "Could not link quote to sales order.";
  }

  async function pressFitQuoteToSalesOrder() {
    if (!selectedConvertQuote?.id) {
      const err = new Error("Select an issued quote first.");
      throw err;
    }
    try {
      const data = await apiFetch(`/sales-orders/from-quote/${selectedConvertQuote.id}`, { method: "POST" });
      const so = data?.sales_order || null;
      const label = so?.so_number || (so?.id ? `SO #${so.id}` : "Sales order");
      setCreatedSoLabel(label);
      setNotice(`Sales order ${label} press-fit from ${selectedConvertQuote.quote_number || "quote"}.`);
      await loadList();
      await loadConvertQuotes();
      if (so?.id) setView({ type: "detail", id: so.id });
      return data;
    } catch (err) {
      if (err?.data?.error === "SALES_ORDER_ALREADY_EXISTS" && err?.data?.sales_order_id) {
        const existingId = Number(err.data.sales_order_id);
        const label = err.data.so_number || `SO #${existingId}`;
        setCreatedSoLabel(label);
        setNotice(`Sales order ${label} already linked to this quote.`);
        await loadConvertQuotes();
        if (Number.isFinite(existingId) && existingId > 0) setView({ type: "detail", id: existingId });
        return { ok: true, sales_order: { id: existingId, so_number: err.data.so_number } };
      }
      throw err;
    }
  }

  async function loadBillingControl(nextQuery = listQuery, bucket = billingBucket) {
    setBillingLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery) summaryParams.set("q", nextQuery);
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/sales-orders/billing-control-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/sales-orders/billing-control-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setBillingSummary(summaryData?.summary || null);
      setBillingRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to load billing control.");
    } finally {
      setBillingLoading(false);
    }
  }

  async function startInvoiceFromSalesOrderId(salesOrderId) {
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/invoices/from-sales-order/${salesOrderId}`, { method: "POST" });
      const invoiceId = Number(data?.invoice_id);
      if (Number.isFinite(invoiceId) && invoiceId > 0 && onOpenInvoice) {
        onOpenInvoice(invoiceId);
        setNotice("Invoice draft created.");
      } else {
        setNotice("Invoice created.");
      }
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to start invoice draft.");
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadList();
      loadFulfillmentRisk();
      loadBillingControl();
      loadConvertQuotes();
      setConvertQuoteId("");
      setCreatedSoLabel("");
    }
  }, [view.type, timeline.revision, timeline.date_from, timeline.date_to, timeline.preset]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextQuery = typeof launch.q === "string" ? launch.q : "";
    const nextStatus = typeof launch.status === "string" ? launch.status : "";
    const nextBucket = typeof launch.bucket === "string" ? launch.bucket : "";
    const nextRiskBucket = typeof launch.risk_bucket === "string" ? launch.risk_bucket : "all";
    const nextBillingBucket = typeof launch.billing_bucket === "string" ? launch.billing_bucket : "all";
    setListQuery(nextQuery);
    setListStatus(nextStatus);
    setListBucket(nextBucket);
    setListPage(1);
    setRiskBucket(FULFILLMENT_RISK_BUCKETS.some(([value]) => value === nextRiskBucket) ? nextRiskBucket : "all");
    setBillingBucket(BILLING_CONTROL_BUCKETS.some(([value]) => value === nextBillingBucket) ? nextBillingBucket : "all");
    if (view.type !== "list") setView({ type: "list" });
    loadList({ q: nextQuery, status: nextStatus, bucket: nextBucket, page: 1 }).catch(() => {});
    loadFulfillmentRisk(nextQuery, FULFILLMENT_RISK_BUCKETS.some(([value]) => value === nextRiskBucket) ? nextRiskBucket : "all").catch(() => {});
    loadBillingControl(nextQuery, BILLING_CONTROL_BUCKETS.some(([value]) => value === nextBillingBucket) ? nextBillingBucket : "all").catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    const id = Number(openSalesOrderId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
  }, [openSalesOrderId]);

  const closeDetail = () => {
    setView({ type: "list" });
    loadList();
  };

  return (
    <>
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
              Sales Order Command Desk
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>Sales Orders</h2>
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth: 760, lineHeight: 1.7 }}>
              Track commercial handoff after quoting, watch order readiness, and launch dispatch or invoice actions from a cleaner control queue.
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              ref={searchInputRef}
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setListPage(1);
                  loadList({ page: 1 }).catch(() => {});
                }
              }}
              placeholder="Search SO / customer / Cust PO / SAP code  (/ to focus)"
              style={{ minWidth: 240 }}
            />
            <select
              value={listStatus}
              onChange={(e) => {
                setListStatus(e.target.value);
                setListPage(1);
              }}
            >
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="confirmed">Confirmed</option>
              <option value="closed">Closed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select
              value={listBucket}
              onChange={(e) => {
                setListBucket(e.target.value);
                setListPage(1);
              }}
            >
              <option value="">All buckets</option>
              <option value="confirmed_no_dispatch">Confirmed, no dispatch</option>
            </select>
            <button
              type="button"
              onClick={() => {
                setListPage(1);
                loadList({ page: 1 }).catch(() => {});
              }}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh Queue"}
            </button>
          </div>
        </div>

        <div className="desk-metric-grid" style={{ marginTop: 18 }}>
          <DeskStat label="Orders In View" value={listMeta?.total_count ?? orderStats.total} tone="#143d7a" />
          <DeskStat label="Draft" value={orderStats.draft} tone="#8b5a00" />
          <DeskStat label="Confirmed" value={orderStats.confirmed} tone="#234a8f" />
          <DeskStat label="Closed" value={orderStats.closed} tone="#0a7a35" />
        </div>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#f2fff6", border: "1px solid #d6f4df" }}>{notice}</div> : null}

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Order Queue" subtitle="Open order control, dispatch, or invoice from this queue · N new · / search · Enter open">
          <div style={{ display: "grid", gap: 10, maxHeight: 980, overflowY: "auto", paddingRight: 4 }}>
            {loading ? (
              <div>Loading sales orders…</div>
            ) : orders.length ? (
              orders.map((order) => {
                const selected = Number(selectedListId) === Number(order.id);
                return (
                <div
                  key={order.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedListId(order.id)}
                  onDoubleClick={() => setView({ type: "detail", id: order.id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setView({ type: "detail", id: order.id });
                  }}
                  style={{
                    border: selected ? "1px solid #93c5fd" : "1px solid #e7ebf3",
                    borderRadius: 18,
                    padding: 14,
                    background: selected ? "#f0f7ff" : "#ffffff",
                    boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                    display: "grid",
                    gap: 10,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>{fmtDate(order.order_date)}</div>
                      <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{order.so_number}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>{order.customer_name || "—"}</div>
                      {order.job_no ? <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>Job {order.job_no}</div> : null}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <DeskChip label={String(order.order_status || "draft").toUpperCase()} tone={statusTone(order.order_status)} color={statusColor(order.order_status)} />
                      {order.quote_number ? <DeskChip label={order.quote_number} tone="#eef4ff" color="#234a8f" /> : <DeskChip label="Legacy / shell" tone="#f6f7fb" color="#58627a" />}
                    </div>
                  </div>
                  <div className="desk-metric-grid desk-metric-grid-compact">
                    <MiniMetric label="Amount" value={fmtMoney(order.grand_total_order, order.order_currency_code)} />
                    <MiniMetric label="Customer PO" value={order.customer_po_number || order.buyer_po_number || "—"} />
                    <MiniMetric label="Customer code" value={order.customer_code || "—"} />
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setView({ type: "detail", id: order.id });
                      }}
                    >
                      Open SO
                    </button>
                  </div>
                </div>
              );
              })
            ) : (
              <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                No sales orders in this company workspace yet. Legacy imports and quote conversions both appear here.
              </div>
            )}
          </div>
          <ListPager
            meta={listMeta}
            loading={loading}
            label="sales orders"
            onPageChange={(nextPage) => {
              setListPage(nextPage);
              loadList({ page: nextPage }).catch(() => {});
            }}
          />
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Billing Control Desk" subtitle="Dispatch completed, invoice drafts, and issuance backlog">
          <div style={{ display: "grid", gap: 12 }}>
            {billingSummary ? (
              <div className="desk-metric-grid" style={{ marginTop: 0 }}>
                <MiniMetric label="Dispatched scope" value={billingSummary.ordersInScope || 0} />
                <MiniMetric label="No invoice" value={billingSummary.dispatchedNoInvoice || 0} />
                <MiniMetric label="Draft pending" value={billingSummary.draftPendingIssue || 0} />
                <MiniMetric label="Qty pending" value={billingSummary.invoiceQtyPending || 0} />
                <MiniMetric label="Invoice qty" value={Number(billingSummary.invoicingPendingQty || 0).toFixed(4)} />
                <MiniMetric label="Bucket" value={billingBucket} />
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {BILLING_CONTROL_BUCKETS.map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => {
                    setBillingBucket(value);
                    loadBillingControl(listQuery, value).catch(() => {});
                  }}
                  style={billingBucket === value ? { borderColor: "#d8b16a", background: "#fff8ea" } : undefined}
                >
                  {label}
                </button>
              ))}
              <button onClick={() => loadBillingControl(listQuery, billingBucket)} disabled={billingLoading}>
                {billingLoading ? "Refreshing..." : "Refresh Billing Desk"}
              </button>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {billingLoading ? (
                <div>Loading billing control…</div>
              ) : billingRows.length ? (
                billingRows.map((row) => {
                  const appearance = billingControlAppearance(
                    row.billing_flags?.dispatched_no_invoice
                      ? "dispatched_no_invoice"
                      : row.billing_flags?.draft_pending_issue
                        ? "draft_pending_issue"
                        : row.billing_flags?.invoice_qty_pending
                          ? "invoice_qty_pending"
                          : "all"
                  );
                  return (
                    <div
                      key={`billing-control-${row.id}`}
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
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>{fmtDate(row.order_date)}</div>
                          <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{row.so_number}</div>
                          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>{row.customer_name}</div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <DeskChip label={appearance.label} tone={appearance.tone} color={appearance.color} />
                          <DeskChip label={String(row.order_status || "draft").toUpperCase()} tone={statusTone(row.order_status)} color={statusColor(row.order_status)} />
                          {(row.customer_po_number || row.buyer_po_number) ? (
                            <DeskChip label={`Cust PO ${row.customer_po_number || row.buyer_po_number}`} tone="#fff7ea" color="#9a5a00" />
                          ) : null}
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(110px, 1fr))", gap: 10 }}>
                        <MiniMetric label="Dispatched" value={Number(row.qty_dispatched || 0).toFixed(4)} />
                        <MiniMetric label="Invoiced" value={Number(row.qty_invoiced || 0).toFixed(4)} />
                        <MiniMetric label="Inv pending" value={Number(row.qty_invoice_remaining || 0).toFixed(4)} />
                        <MiniMetric label="Inv count" value={row.invoice_status_stats?.invoice_count || 0} />
                        <MiniMetric label="Draft" value={row.invoice_status_stats?.draft_count || 0} />
                        <MiniMetric label="Issued" value={row.invoice_status_stats?.issued_count || 0} />
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button onClick={() => setView({ type: "detail", id: row.id })}>Open SO</button>
                        {typeof onOpenInvoice === "function" ? (
                          <button onClick={() => startInvoiceFromSalesOrderId(row.id).catch(() => {})}>Start Invoice</button>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                  No billing control rows match the current search and bucket.
                </div>
              )}
            </div>
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Fulfillment Risk Desk" subtitle="Bridge order backlog with production blockers, dispatch readiness, and invoicing lag">
          <div style={{ display: "grid", gap: 12 }}>
            {riskSummary ? (
              <div className="desk-metric-grid">
                <MiniMetric label="Prod Blocked" value={riskSummary.productionBlocked || 0} />
                <MiniMetric label="No Dispatch" value={riskSummary.confirmedNoDispatch || 0} />
                <MiniMetric label="Ready Dispatch" value={riskSummary.readyForDispatch || 0} />
                <MiniMetric label="Not Invoiced" value={riskSummary.dispatchedNotInvoiced || 0} />
                <MiniMetric label="Dispatch Qty" value={Number(riskSummary.dispatchRemainingQty || 0).toFixed(4)} />
                <MiniMetric label="Invoice Qty" value={Number(riskSummary.invoicingPendingQty || 0).toFixed(4)} />
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {FULFILLMENT_RISK_BUCKETS.map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => {
                    setRiskBucket(value);
                    loadFulfillmentRisk(listQuery, value).catch(() => {});
                  }}
                  style={riskBucket === value ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                >
                  {label}
                </button>
              ))}
              <button onClick={() => loadFulfillmentRisk(listQuery, riskBucket)} disabled={riskLoading}>
                {riskLoading ? "Refreshing..." : "Refresh Risk Desk"}
              </button>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {riskLoading ? (
                <div>Loading fulfillment risk…</div>
              ) : riskRows.length ? (
                riskRows.map((row) => {
                  const appearance = fulfillmentRiskAppearance(
                    row.fulfillment_flags?.production_blocked
                      ? "production_blocked"
                      : row.fulfillment_flags?.confirmed_no_dispatch
                        ? "confirmed_no_dispatch"
                        : row.fulfillment_flags?.ready_for_dispatch
                          ? "ready_for_dispatch"
                          : row.fulfillment_flags?.dispatched_not_invoiced
                            ? "dispatched_not_invoiced"
                            : "all"
                  );
                  return (
                    <div
                      key={`fulfillment-risk-${row.id}`}
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
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>{fmtDate(row.order_date)}</div>
                          <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{row.so_number}</div>
                          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>{row.customer_name}</div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <DeskChip label={appearance.label} tone={appearance.tone} color={appearance.color} />
                          <DeskChip label={String(row.order_status || "draft").toUpperCase()} tone={statusTone(row.order_status)} color={statusColor(row.order_status)} />
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(110px, 1fr))", gap: 10 }}>
                        <MiniMetric label="Ordered" value={Number(row.qty_ordered || 0).toFixed(4)} />
                        <MiniMetric label="Dispatched" value={Number(row.qty_dispatched || 0).toFixed(4)} />
                        <MiniMetric label="Remaining" value={Number(row.qty_dispatch_remaining || 0).toFixed(4)} />
                        <MiniMetric label="Invoiced" value={Number(row.qty_invoiced || 0).toFixed(4)} />
                        <MiniMetric label="Inv Pending" value={Number(row.qty_invoice_remaining || 0).toFixed(4)} />
                        <MiniMetric label="FG Stock" value={Number(row.fg_stock_qty || 0).toFixed(4)} />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.76 }}>
                        {(row.fulfillment_labels || []).length ? row.fulfillment_labels.join(" • ") : "No fulfillment-risk labels"}
                        {row.finished_good_codes ? ` • FG ${row.finished_good_codes}` : ""}
                        {Number(row.linked_job_count || 0) > 0 ? ` • Jobs ${row.linked_job_count}` : ""}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button onClick={() => setView({ type: "detail", id: row.id })}>Open SO</button>
                        {typeof onOpenDispatchesDesk === "function" ? (
                          <button onClick={() => onOpenDispatchesDesk({ q: row.so_number, status: "ready" })}>Open Dispatch Desk</button>
                        ) : null}
                        {typeof onOpenJobCardsDesk === "function" ? (
                          <button
                            onClick={() =>
                              onOpenJobCardsDesk({
                                panel: "audit",
                                audit_q: row.so_number,
                                dispatch_ready_bucket: row.fulfillment_flags?.production_blocked
                                  ? "awaiting_completion"
                                  : row.fulfillment_flags?.ready_for_dispatch
                                    ? "ready_for_dispatch"
                                    : "all",
                              })
                            }
                          >
                            Open Factory Blockers
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                  No fulfillment risk rows match the current search and bucket.
                </div>
              )}
            </div>
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard
          title="Press-fit quote → sales order"
          subtitle="Issued quotes without an SO — mechanical convert handoff"
          actions={
            <button type="button" onClick={() => loadConvertQuotes()} disabled={convertQuotesLoading}>
              {convertQuotesLoading ? "Loading…" : "Refresh quotes"}
            </button>
          }
        >
          <div
            style={{
              border: "1px solid #e8eef6",
              borderRadius: 16,
              padding: 16,
              background: "#f8fafc",
              display: "grid",
              gap: 12,
            }}
          >
            <label style={{ display: "grid", gap: 6, fontSize: 12, fontWeight: 700, color: "#475569" }}>
              Issued quote
              <select
                value={convertQuoteId}
                onChange={(e) => {
                  setConvertQuoteId(e.target.value);
                  setCreatedSoLabel("");
                }}
                disabled={convertQuotesLoading}
                style={{ fontWeight: 600, color: "#16202b", minHeight: 38 }}
              >
                <option value="">{convertQuotesLoading ? "Loading quotes…" : "Select an issued quote…"}</option>
                {convertQuotes.map((q) => (
                  <option key={q.id} value={String(q.id)}>
                    {q.quote_number || `Quote #${q.id}`}
                    {q.customer_name ? ` · ${q.customer_name}` : ""}
                    {q.revision_status ? ` · ${q.revision_status}` : ""}
                  </option>
                ))}
              </select>
            </label>

            {selectedConvertQuote ? (
              <div style={{ overflowX: "auto", paddingBottom: 4 }}>
                <div style={{ minWidth: 320 }}>
                  <PressFitLinker
                    leftLabel={selectedConvertQuote.quote_number || `Quote #${selectedConvertQuote.id}`}
                    rightLabel={createdSoLabel || "New sales order"}
                    linked={Boolean(createdSoLabel)}
                    linkLabel="Link quote → SO"
                    linkedLabel="Converted · Crimped"
                    onLink={pressFitQuoteToSalesOrder}
                    onError={(err) => toast(quoteToSoErrorMessage(err), "error")}
                    onLinked={() =>
                      toast(
                        createdSoLabel
                          ? `Sales order ${createdSoLabel} linked`
                          : "Sales order created from quote",
                        "success"
                      )
                    }
                  />
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.55 }}>
                Choose an unconverted issued quote to enable the press-fit linker.
              </div>
            )}
          </div>
        </DeskCard>
      </div>
    </div>
    <SlideOverDrawer
      open={view.type === "detail"}
      onClose={closeDetail}
      eyebrow="Sales Order"
      title={view.type === "detail" ? `SO #${view.id}` : "Sales Order"}
      subtitle="Fulfillment and billing queues stay open behind this drawer — close when the order step is done."
      width={920}
    >
      {view.type === "detail" ? (
        <SalesOrderDetail
          me={me}
          id={view.id}
          embedded
          onBack={closeDetail}
          onOpenQuote={onOpenQuote}
          onOpenDispatch={onOpenDispatch}
          onOpenInvoice={onOpenInvoice}
          onOpenProforma={onOpenProforma}
          onOpenReceipt={onOpenReceipt}
          onOpenCreditRelease={onOpenCreditRelease}
          onOpenJobCardsDesk={onOpenJobCardsDesk}
          onNotice={(message) => setNotice(message)}
        />
      ) : null}
    </SlideOverDrawer>
    </>
  );
}

function SalesOrderDetail({
  me,
  id,
  onBack,
  onOpenQuote,
  onOpenDispatch,
  onOpenInvoice,
  onOpenProforma,
  onOpenReceipt,
  onNotice,
  onOpenCreditRelease,
  onOpenJobCardsDesk,
  embedded = false,
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [order, setOrder] = useState(null);
  const [lines, setLines] = useState([]);
  const [terms, setTerms] = useState([]);
  const [dispatches, setDispatches] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [customerSites, setCustomerSites] = useState([]);
  const [creditControl, setCreditControl] = useState(null);
  const [status, setStatus] = useState("draft");
  const [clearance, setClearance] = useState({
    order_flow: "direct",
    fulfillment_mode: "direct_customer",
    buyer_po_number: "",
    buyer_po_date: "",
    customer_po_number: "",
    customer_po_date: "",
    po_exception_reason: "",
    end_customer_name: "",
    end_customer_po_number: "",
    end_customer_po_date: "",
    ship_to_customer_site_id: "",
    bill_to_name: "",
    bill_to_address: "",
    ship_to_name: "",
    ship_to_address: "",
  });
  const [creatingDispatch, setCreatingDispatch] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [showShipSiteCreate, setShowShipSiteCreate] = useState(false);
  const [shipSiteCreating, setShipSiteCreating] = useState(false);
  const [newShipSiteForm, setNewShipSiteForm] = useState({
    site_name: "",
    address_line1: "",
    city: "",
    state: "",
    pincode: "",
  });
  const [forceDispatch, setForceDispatch] = useState(null);
  const [forceReason, setForceReason] = useState("");
  const [siteReadinessStatus, setSiteReadinessStatus] = useState(null);
  const [fulfillmentFlags, setFulfillmentFlags] = useState(null);
  const [flightLogEvents, setFlightLogEvents] = useState([]);
  const [flightLogLoading, setFlightLogLoading] = useState(false);
  const creditPanelRef = useRef(null);
  const siteReadinessRef = useRef(null);

  function refreshCreditControl() {
    apiFetch(`/sales-orders/${id}`)
      .then((data) => setCreditControl(data?.credit_control || null))
      .catch(() => {});
  }

  useEffect(() => {
    setLoading(true);
    setError("");
    setNotice("");
    apiFetch(`/sales-orders/${id}`)
      .then((data) => {
        setOrder(data?.sales_order || null);
        setLines(Array.isArray(data?.lines) ? data.lines : []);
        setTerms(Array.isArray(data?.terms) ? data.terms : []);
        setDispatches(Array.isArray(data?.dispatches) ? data.dispatches : []);
        setInvoices(Array.isArray(data?.invoices) ? data.invoices : []);
        setCustomerSites(Array.isArray(data?.customer_sites) ? data.customer_sites : []);
        setCreditControl(data?.credit_control || null);
        setStatus(data?.sales_order?.order_status || "draft");
        setClearance({
          order_flow: data?.sales_order?.order_flow || (data?.sales_order?.distributor_id ? "distributor" : "direct"),
          fulfillment_mode: data?.sales_order?.fulfillment_mode || (data?.sales_order?.distributor_id ? "stock_sale" : "direct_customer"),
          buyer_po_number: data?.sales_order?.customer_po_number || data?.sales_order?.buyer_po_number || "",
          buyer_po_date: data?.sales_order?.customer_po_date || data?.sales_order?.buyer_po_date || "",
          customer_po_number: data?.sales_order?.customer_po_number || data?.sales_order?.buyer_po_number || "",
          customer_po_date: data?.sales_order?.customer_po_date || data?.sales_order?.buyer_po_date || "",
          po_exception_reason: data?.sales_order?.po_exception_reason || "",
          end_customer_name: data?.sales_order?.end_customer_name || "",
          end_customer_po_number: data?.sales_order?.end_customer_po_number || "",
          end_customer_po_date: data?.sales_order?.end_customer_po_date || "",
          ship_to_customer_site_id: data?.sales_order?.ship_to_customer_site_id ? String(data.sales_order.ship_to_customer_site_id) : "",
          bill_to_name: data?.sales_order?.bill_to_name || "",
          bill_to_address: data?.sales_order?.bill_to_address || "",
          ship_to_name: data?.sales_order?.ship_to_name || "",
          ship_to_address: data?.sales_order?.ship_to_address || "",
        });
      })
      .catch((e) =>
        setError(
          e?.data?.detail ||
            (e?.data?.pg_code ? `${e.data.error || "SERVER_ERROR"} (${e.data.pg_code})` : null) ||
            e?.data?.error ||
            "Failed to load sales order."
        )
      )
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    setFlightLogLoading(true);
    apiFetch(`/sales-orders/${id}/flight-log`)
      .then((data) => setFlightLogEvents(Array.isArray(data?.events) ? data.events : []))
      .catch(() => setFlightLogEvents([]))
      .finally(() => setFlightLogLoading(false));
  }, [id]);

  useEffect(() => {
    apiFetch(`/sales-orders/fulfillment-risk-queue?limit=200`)
      .then((data) => {
        const row = (Array.isArray(data?.rows) ? data.rows : []).find((item) => Number(item.id) === Number(id));
        setFulfillmentFlags(row?.fulfillment_flags || null);
      })
      .catch(() => setFulfillmentFlags(null));
  }, [id]);

  const detailBlockers = useMemo(() => {
    if (!order) return [];
    const items = [];
    const creditBlock = creditControl?.decisions?.so_confirmation;
    if (creditBlock?.block || creditBlock?.warn) {
      items.push({
        id: "credit-so-confirm",
        severity: creditBlock.block ? "high" : "soft",
        reason: creditBlock.message || "Sales order confirmation is blocked by credit control.",
        explain: creditBlock.explain || null,
        creditMode: creditBlock.mode || creditControl?.profile?.credit_control_mode,
        ownerDesk: "Credit",
        ctaLabel: creditBlock.block ? "Request / approve release" : "View credit position",
        onCta: () => creditPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
      });
    }
    const orderLive = ["confirmed", "closed"].includes(String(order.order_status || "").toLowerCase());
    const dispatchPending = lines.some((line) => Number(line.qty_dispatch_remaining || 0) > 0);
    if (orderLive && dispatchPending && !isSiteReadinessApproved(siteReadinessStatus)) {
      items.push({
        id: "site-readiness",
        severity: "med",
        reason: siteReadinessStatus
          ? `Site readiness is ${String(siteReadinessStatus).replace(/_/g, " ")} — dispatch stays gated until approved.`
          : "No site readiness checklist yet — dispatch stays locked until one is approved.",
        ownerDesk: "Field service",
        ctaLabel: siteReadinessStatus ? "Open checklist" : "Start checklist",
        onCta: () => siteReadinessRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
      });
    }
    const uninvoicedDispatched = lines.reduce(
      (sum, line) => sum + Math.max(Number(line.qty_dispatched || 0) - Number(line.qty_invoiced || 0), 0),
      0
    );
    if (orderLive && uninvoicedDispatched > 0) {
      items.push({
        id: "dispatched-not-invoiced",
        severity: "med",
        reason: `${uninvoicedDispatched} dispatched unit${uninvoicedDispatched === 1 ? "" : "s"} not invoiced yet.`,
        ownerDesk: "Billing",
        ctaLabel: "Create invoice",
        onCta: () => createInvoice(),
      });
    }
    if (fulfillmentFlags?.production_blocked) {
      items.push({
        id: "production-blocked",
        severity: "high",
        reason: "Production or finished-goods readiness is blocking fulfillment.",
        ownerDesk: "Manufacturing",
        ctaLabel: typeof onOpenJobCardsDesk === "function" ? "Open job cards" : undefined,
        onCta:
          typeof onOpenJobCardsDesk === "function"
            ? () =>
                onOpenJobCardsDesk({
                  sales_order_id: id,
                  so_number: order.so_number,
                })
            : undefined,
      });
    }
    return items;
  }, [order, lines, creditControl, siteReadinessStatus, fulfillmentFlags, id, onOpenCreditRelease, onOpenJobCardsDesk]);

  async function saveStatus() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/sales-orders/${id}/status`, {
        method: "PUT",
        body: JSON.stringify({ order_status: status }),
      });
      setOrder(data?.sales_order || order);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setTerms(Array.isArray(data?.terms) ? data.terms : []);
      setDispatches(Array.isArray(data?.dispatches) ? data.dispatches : dispatches);
      setInvoices(Array.isArray(data?.invoices) ? data.invoices : invoices);
      setCreditControl(data?.credit_control || null);
      setNotice("Sales order status updated.");
      onNotice?.("Sales order updated successfully.");
    } catch (e) {
      const code = e?.data?.error;
      if (e?.data?.credit_control) setCreditControl(e.data.credit_control);
      if (code === "CUSTOMER_CREDIT_HOLD") setError(e?.data?.detail || "Customer is on manual credit hold.");
      else if (code === "CUSTOMER_OVER_CREDIT_LIMIT") setError(e?.data?.detail || "Customer is over the approved credit limit.");
      else if (code === "CUSTOMER_OVERDUE_BLOCK") setError(e?.data?.detail || "Customer has overdue receivables and is blocked.");
      else if (code === "ORDER_PO_REQUIRED") setError(e?.data?.detail || "Buyer PO or exception reason is required before confirming the sales order.");
      else if (code === "END_CUSTOMER_REQUIRED") setError(e?.data?.detail || "End customer details are required before confirming this distributor direct-ship order.");
      else if (code === "BILL_TO_REQUIRED") setError(e?.data?.detail || "Bill-to details are required before confirming the sales order.");
      else if (code === "SHIP_TO_REQUIRED") setError(e?.data?.detail || "Ship-to details are required before confirming the sales order.");
      else setError(code || "Failed to update sales order status.");
    } finally {
      setSaving(false);
    }
  }

  async function saveClearance() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/sales-orders/${id}/clearance`, {
        method: "PUT",
        body: JSON.stringify({
          order_flow: clearance.order_flow,
          fulfillment_mode: clearance.fulfillment_mode,
          buyer_po_number: clearance.customer_po_number || clearance.buyer_po_number,
          buyer_po_date: clearance.customer_po_date || clearance.buyer_po_date || null,
          customer_po_number: clearance.customer_po_number || clearance.buyer_po_number,
          customer_po_date: clearance.customer_po_date || clearance.buyer_po_date || null,
          po_exception_reason: clearance.po_exception_reason,
          end_customer_name: clearance.end_customer_name,
          end_customer_po_number: clearance.end_customer_po_number,
          end_customer_po_date: clearance.end_customer_po_date || null,
          ship_to_customer_site_id: clearance.ship_to_customer_site_id ? Number(clearance.ship_to_customer_site_id) : null,
          bill_to_name: clearance.bill_to_name,
          bill_to_address: clearance.bill_to_address,
          ship_to_name: clearance.ship_to_name,
          ship_to_address: clearance.ship_to_address,
        }),
      });
      setOrder(data?.sales_order || order);
      setCustomerSites(Array.isArray(data?.customer_sites) ? data.customer_sites : customerSites);
      setClearance((prev) => ({
        ...prev,
        order_flow: data?.sales_order?.order_flow || prev.order_flow,
        fulfillment_mode: data?.sales_order?.fulfillment_mode || prev.fulfillment_mode,
        buyer_po_number: data?.sales_order?.customer_po_number || data?.sales_order?.buyer_po_number || "",
        buyer_po_date: data?.sales_order?.customer_po_date || data?.sales_order?.buyer_po_date || "",
        customer_po_number: data?.sales_order?.customer_po_number || data?.sales_order?.buyer_po_number || "",
        customer_po_date: data?.sales_order?.customer_po_date || data?.sales_order?.buyer_po_date || "",
        po_exception_reason: data?.sales_order?.po_exception_reason || "",
        end_customer_name: data?.sales_order?.end_customer_name || "",
        end_customer_po_number: data?.sales_order?.end_customer_po_number || "",
        end_customer_po_date: data?.sales_order?.end_customer_po_date || "",
        ship_to_customer_site_id: data?.sales_order?.ship_to_customer_site_id ? String(data.sales_order.ship_to_customer_site_id) : "",
        bill_to_name: data?.sales_order?.bill_to_name || "",
        bill_to_address: data?.sales_order?.bill_to_address || "",
        ship_to_name: data?.sales_order?.ship_to_name || "",
        ship_to_address: data?.sales_order?.ship_to_address || "",
      }));
      setNotice("Sales order clearance updated.");
      onNotice?.("Sales order clearance updated.");
    } catch (e) {
      const code = e?.data?.error;
      if (code === "SHIP_TO_SITE_INACTIVE") setError("Selected ship-to site is inactive.");
      else if (code === "SHIP_TO_SITE_CANNOT_DISPATCH") setError("Selected ship-to site is not dispatch-enabled.");
      else if (code === "INVALID_FULFILLMENT_MODE") setError("Choose a valid fulfillment mode for the selected order flow.");
      else if (code === "DISTRIBUTOR_REQUIRED") setError("This sales order does not have a linked distributor, so distributor clearance cannot be used.");
      else setError(code || "Failed to save sales order clearance.");
    } finally {
      setSaving(false);
    }
  }

  async function createShipSiteInline() {
    const customerId = Number(order?.customer_id);
    if (!Number.isFinite(customerId) || customerId <= 0) {
      setError("Sales order has no customer for site create.");
      return;
    }
    if (!String(newShipSiteForm.site_name || "").trim()) {
      setError("Site / plant name is required.");
      return;
    }
    setShipSiteCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/customers/${customerId}/sites`, {
        method: "POST",
        body: JSON.stringify({
          site_name: String(newShipSiteForm.site_name || "").trim(),
          site_type: "plant",
          address_line1: String(newShipSiteForm.address_line1 || "").trim() || null,
          city: String(newShipSiteForm.city || "").trim() || null,
          state: String(newShipSiteForm.state || "").trim() || null,
          pincode: String(newShipSiteForm.pincode || "").trim() || null,
          can_quote: true,
          can_dispatch: true,
          can_bill: true,
          is_default_ship_to: customerSites.filter((site) => site?.is_active !== false && site?.can_dispatch !== false).length === 0,
          is_active: true,
        }),
      });
      const site = data?.site || null;
      const detail = await apiFetch(`/customers/${customerId}`);
      const sites = Array.isArray(detail?.sites) ? detail.sites : [];
      setCustomerSites(sites);
      if (site?.id) {
        setClearance((prev) => ({
          ...prev,
          ship_to_customer_site_id: String(site.id),
          ship_to_name: site.site_name || prev.ship_to_name,
          ship_to_address:
            [site.address_line1, site.city, site.state, site.pincode].filter(Boolean).join(", ") || prev.ship_to_address,
        }));
      }
      setNewShipSiteForm({ site_name: "", address_line1: "", city: "", state: "", pincode: "" });
      setShowShipSiteCreate(false);
      setNotice("Dispatch site added and selected without leaving the order.");
      onNotice?.("Dispatch site added on sales order.");
    } catch (e) {
      setError(e?.data?.error || e?.data?.detail || "Failed to add ship-to site.");
    } finally {
      setShipSiteCreating(false);
    }
  }

  async function createDispatch(options = {}) {
    setCreatingDispatch(true);
    setError("");
    try {
      const payload =
        options.force && options.forceReason
          ? { force: true, force_reason: options.forceReason }
          : {};
      const data = await apiFetch(`/dispatches/from-sales-order/${id}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const dispatchId = data?.dispatch?.id;
      if (dispatchId && onOpenDispatch) onOpenDispatch(dispatchId);
    } catch (e) {
      if (e?.data?.error === "ORDER_NOT_READY") {
        const blockers = Array.isArray(e?.data?.readiness?.blockers) ? e.data.readiness.blockers : [];
        const detail = e?.data?.detail || blockers.join("; ") || "Production or FG readiness is blocking dispatch.";
        if (e?.data?.override_allowed) {
          setForceDispatch({ detail, blockers });
          setForceReason("");
          return;
        }
        setError(`Dispatch blocked: ${detail}`);
      } else if (e?.data?.error === "ORDER_NOT_READY_FOR_DISPATCH") {
        setError("Confirm the sales order first before creating dispatch.");
      } else if (e?.data?.error === "SITE_READINESS_REQUIRED" || e?.data?.error === "SITE_READINESS_NOT_APPROVED") {
        setError(e?.data?.detail || "Approve site readiness before creating dispatch.");
      } else if (e?.data?.error === "FULLY_DISPATCHED") {
        setError("All sales-order quantities are already dispatched.");
      } else {
        setError(e?.data?.detail || e?.data?.error || "Failed to create dispatch.");
      }
    } finally {
      setCreatingDispatch(false);
    }
  }

  async function createInvoice() {
    setCreatingInvoice(true);
    setError("");
    try {
      const data = await apiFetch(`/invoices/from-sales-order/${id}`, { method: "POST" });
      const invoiceId = data?.invoice?.id;
      if (invoiceId && onOpenInvoice) onOpenInvoice(invoiceId);
    } catch (e) {
      if (e?.data?.error === "ORDER_NOT_READY_FOR_INVOICE") {
        setError("Confirm the sales order first before creating invoice.");
      } else if (e?.data?.error === "FULLY_INVOICED") {
        setError("All sales-order quantities are already invoiced.");
      } else {
        setError("Failed to create invoice.");
      }
    } finally {
      setCreatingInvoice(false);
    }
  }

  if (loading) {
    return <div>Loading sales order…</div>;
  }

  if (!order) {
    return (
      <div>
        {!embedded ? <button onClick={onBack}>Back</button> : null}
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Sales order not found."}</div>
      </div>
    );
  }

  const hasDispatchRemaining = lines.some((line) => Number(line.qty_dispatch_remaining || 0) > 0);
  const hasInvoiceRemaining = lines.some((line) => Number(line.qty_invoice_remaining || 0) > 0);
  const hasDistributor = Boolean(order.distributor_id);
  const availableClearanceModes = CLEARANCE_MODE_OPTIONS.filter((option) => option.orderFlow === "direct" || hasDistributor);
  const clearanceModeKey = getClearanceModeKey(clearance);
  const activeClearanceMode = availableClearanceModes.find((option) => option.key === clearanceModeKey) || availableClearanceModes[0];
  const isDistributorFlow = activeClearanceMode?.orderFlow === "distributor";
  const isDirectShip = activeClearanceMode?.fulfillmentMode === "direct_ship_end_customer";
  const linkedShipSites = customerSites.filter((site) => site?.is_active !== false && site?.can_dispatch !== false);
  const canUseLinkedShipSite = activeClearanceMode?.fulfillmentMode !== "stock_sale" && linkedShipSites.length > 0;
  const readinessChecks = [
    {
      key: "po",
      ready: Boolean(String(clearance.customer_po_number || clearance.buyer_po_number || "").trim() || String(clearance.po_exception_reason || "").trim()),
      label: String(clearance.customer_po_number || clearance.buyer_po_number || "").trim() ? "Customer PO captured" : "PO exception captured",
      pending: "Buyer PO or exception needed",
      tone: "#eef4ff",
      color: "#234a8f",
    },
    {
      key: "bill-to",
      ready: Boolean(String(clearance.bill_to_name || "").trim() && String(clearance.bill_to_address || "").trim()),
      label: "Bill-to ready",
      pending: "Bill-to pending",
      tone: "#fff8ea",
      color: "#8b5a00",
    },
    {
      key: "ship-to",
      ready: Boolean(String(clearance.ship_to_name || "").trim() && String(clearance.ship_to_address || "").trim()),
      label: "Ship-to ready",
      pending: "Ship-to pending",
      tone: "#effcf3",
      color: "#0a7a35",
    },
    {
      key: "end-customer",
      ready: !isDirectShip || Boolean(String(clearance.end_customer_name || "").trim()),
      label: "End customer ready",
      pending: "End customer pending",
      tone: "#f4f0ff",
      color: "#6b35b5",
    },
  ];

  function applyClearanceMode(modeKey) {
    const nextMode = availableClearanceModes.find((option) => option.key === modeKey);
    if (!nextMode) return;
    setClearance((prev) => ({
      ...prev,
      order_flow: nextMode.orderFlow,
      fulfillment_mode: nextMode.fulfillmentMode,
      ship_to_customer_site_id: nextMode.fulfillmentMode === "stock_sale" ? "" : prev.ship_to_customer_site_id,
    }));
  }

  const siteReady = isSiteReadinessApproved(siteReadinessStatus);
  const dispatchBlockedBySite = !siteReady;
  const canCreateDispatch =
    ["confirmed", "closed"].includes(order.order_status || "") && hasDispatchRemaining && siteReady;

  return (
    <div style={{ maxWidth: 1480 }}>
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
              Active Sales Order Desk
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>{order.so_number}</h2>
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth: 780, lineHeight: 1.7 }}>
              {order.customer_name} • {order.quote_number ? `Quote ${order.quote_number}` : "No source quote"} • dispatch and invoice actions remain visible from this desk.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <DeskChip label={String(order.order_status || "draft").toUpperCase()} tone={statusTone(order.order_status)} color={statusColor(order.order_status)} />
            {!embedded ? <button onClick={onBack}>Back To Queue</button> : null}
            {order.quote_id && onOpenQuote ? <button onClick={() => onOpenQuote(order.quote_id)}>Open Source Quote</button> : null}
            <span title={dispatchBlockedBySite ? "Approve site readiness before creating dispatch." : undefined}>
              <button
                onClick={createDispatch}
                disabled={creatingDispatch || !canCreateDispatch}
                title={dispatchBlockedBySite ? "Site readiness must be Approved before dispatch." : undefined}
              >
                {creatingDispatch ? "Creating Dispatch..." : "Create Dispatch"}
              </button>
            </span>
            <button onClick={createInvoice} disabled={creatingInvoice || !["confirmed", "closed"].includes(order.order_status || "") || !hasInvoiceRemaining}>
              {creatingInvoice ? "Creating Invoice..." : "Create Invoice"}
            </button>
            {typeof onOpenProforma === "function" ? (
              <button
                type="button"
                disabled={!["confirmed", "closed"].includes(order.order_status || "")}
                onClick={() => onOpenProforma({ sales_order_id: id })}
              >
                Create Proforma
              </button>
            ) : null}
          </div>
        </div>

        <BlockerRibbon blockers={detailBlockers} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 12, marginTop: 18 }}>
          <DeskStat label="Subtotal" value={fmtMoney(order.subtotal_order, order.order_currency_code)} tone="#143d7a" />
          <DeskStat label="GST" value={fmtMoney(order.tax_total_order, order.order_currency_code)} tone="#8b5a00" />
          <DeskStat label="Grand Total" value={fmtMoney(order.grand_total_order, order.order_currency_code)} tone="#0a7a35" />
          <DeskStat label="Dispatch Remaining" value={hasDispatchRemaining ? "Yes" : "No"} tone="#234a8f" />
          <DeskStat label="Invoice Remaining" value={hasInvoiceRemaining ? "Yes" : "No"} tone="#7a1637" />
        </div>

        <div style={{ marginTop: 16 }}>
          <div ref={siteReadinessRef}>
            <SiteReadinessPanel me={me} salesOrderId={id} onStatusChange={setSiteReadinessStatus} />
          </div>
        </div>

        <div
          style={{
            marginTop: 16,
            border: "1px solid #dce6f5",
            borderRadius: 18,
            padding: 14,
            background: "linear-gradient(180deg, #ffffff 0%, #f7faff 100%)",
          }}
        >
          <div style={{ fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.58, marginBottom: 10 }}>
            Confirm → Dispatch → Invoice → Collect
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 10 }}>
            {(() => {
              const orderStatus = String(order.order_status || "").toLowerCase();
              const isDraft = orderStatus === "draft";
              const isConfirmedOrClosed = ["confirmed", "closed"].includes(orderStatus);
              const outstanding = Number(creditControl?.exposure?.outstanding_amount || 0);
              const hasInvoices = invoices.length > 0;
              const collectDone = hasInvoices && outstanding <= 0.0001;
              const collectActive = hasInvoices && outstanding > 0.0001;
              const statusSelectReady = String(status || "").toLowerCase() === "confirmed";

              async function confirmOrder() {
                if (!isDraft) return;
                setStatus("confirmed");
                setSaving(true);
                setError("");
                setNotice("");
                try {
                  const data = await apiFetch(`/sales-orders/${id}/status`, {
                    method: "PUT",
                    body: JSON.stringify({ order_status: "confirmed" }),
                  });
                  setOrder(data?.sales_order || order);
                  setLines(Array.isArray(data?.lines) ? data.lines : lines);
                  setTerms(Array.isArray(data?.terms) ? data.terms : terms);
                  setDispatches(Array.isArray(data?.dispatches) ? data.dispatches : dispatches);
                  setInvoices(Array.isArray(data?.invoices) ? data.invoices : invoices);
                  setCreditControl(data?.credit_control || null);
                  setStatus(data?.sales_order?.order_status || "confirmed");
                  setNotice("Sales order status updated.");
                  onNotice?.("Sales order updated successfully.");
                } catch (e) {
                  const code = e?.data?.error;
                  if (e?.data?.credit_control) setCreditControl(e.data.credit_control);
                  if (code === "CUSTOMER_CREDIT_HOLD") setError(e?.data?.detail || "Customer is on manual credit hold.");
                  else if (code === "CUSTOMER_OVER_CREDIT_LIMIT") setError(e?.data?.detail || "Customer is over the approved credit limit.");
                  else if (code === "CUSTOMER_OVERDUE_BLOCK") setError(e?.data?.detail || "Customer has overdue receivables and is blocked.");
                  else if (code === "ORDER_PO_REQUIRED") setError(e?.data?.detail || "Buyer PO or exception reason is required before confirming the sales order.");
                  else if (code === "END_CUSTOMER_REQUIRED") setError(e?.data?.detail || "End customer details are required before confirming this distributor direct-ship order.");
                  else if (code === "BILL_TO_REQUIRED") setError(e?.data?.detail || "Bill-to details are required before confirming the sales order.");
                  else if (code === "SHIP_TO_REQUIRED") setError(e?.data?.detail || "Ship-to details are required before confirming the sales order.");
                  else setError(code || "Failed to update sales order status.");
                } finally {
                  setSaving(false);
                }
              }

              const steps = [
                {
                  key: "confirm",
                  label: "Confirm",
                  body: isConfirmedOrClosed ? (
                    <DeskChip label="Done" tone="#effcf3" color="#0b7d45" />
                  ) : isDraft ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (statusSelectReady) saveStatus();
                        else confirmOrder();
                      }}
                      disabled={saving}
                    >
                      {saving ? "Saving..." : "Save Status"}
                    </button>
                  ) : (
                    <DeskChip label={String(order.order_status || "—").toUpperCase()} tone="#f6f7fb" color="#58627a" />
                  ),
                  active: isDraft,
                },
                {
                  key: "dispatch",
                  label: "Dispatch",
                  body:
                    hasDispatchRemaining && isConfirmedOrClosed ? (
                      <span title={dispatchBlockedBySite ? "Approve site readiness before creating dispatch." : undefined}>
                        <button type="button" onClick={createDispatch} disabled={creatingDispatch || dispatchBlockedBySite}>
                          {creatingDispatch ? "Creating..." : "Create Dispatch"}
                        </button>
                      </span>
                    ) : (
                      <DeskChip label="Done" tone="#effcf3" color="#0b7d45" />
                    ),
                  active: hasDispatchRemaining && isConfirmedOrClosed && siteReady,
                },
                {
                  key: "invoice",
                  label: "Invoice",
                  body: hasInvoiceRemaining ? (
                    <button type="button" onClick={createInvoice} disabled={creatingInvoice || !isConfirmedOrClosed}>
                      {creatingInvoice ? "Creating..." : "Create Invoice"}
                    </button>
                  ) : (
                    <DeskChip label="Done" tone="#effcf3" color="#0b7d45" />
                  ),
                  active: hasInvoiceRemaining && isConfirmedOrClosed,
                },
                {
                  key: "collect",
                  label: "Collect",
                  body: collectDone ? (
                    <DeskChip label="Done" tone="#effcf3" color="#0b7d45" />
                  ) : collectActive ? (
                    <button
                      type="button"
                      onClick={async () => {
                        const first = invoices.find((item) => Number(item.id) > 0) || null;
                        if (!first?.id) {
                          setNotice("Create an invoice first, then collect.");
                          return;
                        }
                        setError("");
                        try {
                          const data = await apiFetch(`/receipts/from-invoice/${first.id}`, { method: "POST" });
                          const receiptId = Number(data?.receipt?.id);
                          if (Number.isFinite(receiptId) && receiptId > 0 && typeof onOpenReceipt === "function") {
                            onOpenReceipt(receiptId);
                            return;
                          }
                          setNotice(data?.receipt?.receipt_number ? `Receipt ${data.receipt.receipt_number} created.` : "Receipt draft created.");
                        } catch (e) {
                          if (e?.data?.error === "INVOICE_ALREADY_SETTLED") {
                            setError("This invoice is already settled. Open Receipts to review allocations.");
                          } else {
                            setError(e?.data?.error || e?.data?.detail || "Failed to create receipt from invoice.");
                          }
                        }
                      }}
                    >
                      Collect from invoice
                    </button>
                  ) : (
                    <DeskChip label="Pending" tone="#fff8ea" color="#8b5a00" />
                  ),
                  active: collectActive,
                },
              ];

              return steps.map((step) => (
                <div
                  key={step.key}
                  style={{
                    border: step.active ? "1px solid #9bb7f5" : "1px solid #e7ebf3",
                    borderRadius: 14,
                    padding: 12,
                    background: step.active ? "#f7faff" : "#ffffff",
                    display: "grid",
                    gap: 8,
                    alignContent: "start",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 800, color: step.active ? "#1f5eff" : "#17304d" }}>{step.label}</div>
                  {step.body}
                </div>
              ));
            })()}
          </div>
        </div>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#f2fff6", border: "1px solid #d6f4df" }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(280px, 0.72fr) minmax(0, 1.1fr) minmax(300px, 0.7fr)", gap: 18, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Order Snapshot" subtitle="Commercial origin and committed terms">
            <div style={{ display: "grid", gap: 8, fontSize: 13, lineHeight: 1.8 }}>
              <div>
                Source Quote:{" "}
                {order.quote_id && typeof onOpenQuote === "function" ? (
                  <button
                    type="button"
                    onClick={() => onOpenQuote(order.quote_id)}
                    style={{ all: "unset", cursor: "pointer", color: "#0f4aa1", fontWeight: 700 }}
                  >
                    {order.quote_number || `Quote #${order.quote_id}`}
                  </button>
                ) : (
                  order.quote_number || "—"
                )}
              </div>
              <div>Quote Revision: {order.quote_revision_no || "—"}</div>
              <div>Order Flow: {describeOrderFlow(order.order_flow)}</div>
              <div>Fulfillment: {describeFulfillmentMode(order.fulfillment_mode)}</div>
              <div>Distributor: {order.distributor_name || "—"}</div>
              <div>Customer PO: {order.customer_po_number || order.buyer_po_number || "—"}</div>
              <div>Customer PO Date: {fmtDate(order.customer_po_date || order.buyer_po_date)}</div>
              <div>PO Exception: {order.po_exception_reason || "—"}</div>
              <div>End Customer: {order.end_customer_name || "—"}</div>
              <div>End Customer PO: {order.end_customer_po_number || "—"}</div>
              <div>Bill To: {order.bill_to_name || "—"}</div>
              <div>Ship To: {order.ship_to_name || order.ship_to_site_name || "—"}</div>
              <div>Attention To: {order.attention_to || "—"}</div>
              <div>Incoterm: {order.incoterm_code || "—"}</div>
              <div>Payment Term: {order.payment_term_name || order.payment_term_code || "—"}</div>
              <div>Freight Term: {order.freight_term_name || order.freight_term_code || "—"}</div>
              <div>Order Date: {fmtDate(order.order_date)}</div>
            </div>

            {order.quote_id ? (
              <div
                style={{
                  marginTop: 14,
                  border: "1px solid #e8eef6",
                  borderRadius: 14,
                  padding: 14,
                  background: "#f8fafc",
                  overflowX: "auto",
                }}
              >
                <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4 }}>Quote ↔ order joint</div>
                <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 10, lineHeight: 1.45 }}>
                  Source quote is press-fit into this sales order. Conversion happens from the quote desk; this view
                  confirms the locked joint.
                </div>
                <div style={{ minWidth: 300 }}>
                  <PressFitLinker
                    leftLabel={order.quote_number || `Quote #${order.quote_id}`}
                    rightLabel={order.so_number || `SO #${order.id}`}
                    linked
                    linkLabel="Link quote → SO"
                    linkedLabel="Converted · Crimped"
                    onLink={async () => {
                      /* Already joined at convert time via POST /sales-orders/from-quote/:quoteId */
                      toast("This sales order is already press-fit to its source quote.", "info");
                    }}
                    onError={(err) => toast(err?.message || "Link unavailable.", "error")}
                  />
                </div>
              </div>
            ) : null}
          </DeskCard>

          <DeskCard title="Control Rail" subtitle="Status management and action readiness">
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Status</div>
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ minWidth: 220 }}>
              <option value="draft">Draft</option>
              <option value="confirmed">Confirmed</option>
              <option value="closed">Closed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button onClick={saveStatus} disabled={saving} style={{ marginTop: 12 }}>
              {saving ? "Saving..." : "Save Status"}
            </button>
            <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
              <DeskChip label={hasDispatchRemaining ? "Dispatch pending" : "Dispatch complete"} tone={hasDispatchRemaining ? "#eef4ff" : "#effcf3"} color={hasDispatchRemaining ? "#234a8f" : "#0b7d45"} />
              <DeskChip label={hasInvoiceRemaining ? "Invoice pending" : "Invoice complete"} tone={hasInvoiceRemaining ? "#fff6e8" : "#effcf3"} color={hasInvoiceRemaining ? "#8b5a00" : "#0b7d45"} />
            </div>
          </DeskCard>

          <DeskCard title="SO Clearance" subtitle="Finalize PO, order mode, bill-to, and ship-to here before confirmation">
            <div style={{ display: "grid", gap: 14 }}>
              <div
                style={{
                  border: "1px solid #e7ebf3",
                  borderRadius: 16,
                  background: "#fbfcff",
                  padding: 14,
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62 }}>Clearance Mode</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{activeClearanceMode?.label || "Direct Customer Order"}</div>
                <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.78 }}>
                  {activeClearanceMode?.subtitle}
                </div>
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", marginTop: 4 }}>
                  {availableClearanceModes.map((option) => {
                    const selected = option.key === clearanceModeKey;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => applyClearanceMode(option.key)}
                        style={{
                          textAlign: "left",
                          border: `1px solid ${selected ? option.accent : "#d9e1ef"}`,
                          borderRadius: 16,
                          padding: 14,
                          background: selected ? option.tone : "#ffffff",
                          boxShadow: selected ? `0 10px 22px ${option.accent}20` : "0 4px 12px rgba(26, 35, 53, 0.04)",
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        <div style={{ fontWeight: 800, color: option.accent }}>{option.label}</div>
                        <div style={{ fontSize: 12, lineHeight: 1.5, color: "#41506a" }}>{option.subtitle}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {readinessChecks.map((item) => (
                  <DeskChip
                    key={item.key}
                    label={item.ready ? item.label : item.pending}
                    tone={item.ready ? item.tone : "#fff3f3"}
                    color={item.ready ? item.color : "#b42318"}
                  />
                ))}
              </div>

              <div
                style={{
                  border: "1px solid #eceff5",
                  borderRadius: 16,
                  background: "#ffffff",
                  padding: 14,
                  display: "grid",
                  gap: 12,
                }}
              >
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62 }}>Commercial Basis</div>
                <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.78 }}>
                  Draft SO can begin before the PO arrives, but confirmation requires either the buyer PO or an approved exception note.
                </div>
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, opacity: 0.75 }}>{isDistributorFlow ? "Distributor PO Number" : "Customer PO Number"}</span>
                    <input
                      value={clearance.customer_po_number || clearance.buyer_po_number}
                      onChange={(e) =>
                        setClearance((prev) => ({
                          ...prev,
                          customer_po_number: e.target.value,
                          buyer_po_number: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, opacity: 0.75 }}>{isDistributorFlow ? "Distributor PO Date" : "Customer PO Date"}</span>
                    <input
                      type="date"
                      value={clearance.customer_po_date || clearance.buyer_po_date}
                      onChange={(e) =>
                        setClearance((prev) => ({
                          ...prev,
                          customer_po_date: e.target.value,
                          buyer_po_date: e.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontSize: 12, opacity: 0.75 }}>PO Exception Reason</span>
                  <input value={clearance.po_exception_reason} onChange={(e) => setClearance((prev) => ({ ...prev, po_exception_reason: e.target.value }))} placeholder="Use only if SO draft begins before PO arrives" />
                </label>
                {isDirectShip ? (
                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ fontSize: 12, opacity: 0.75 }}>End Customer Name</span>
                      <input value={clearance.end_customer_name} onChange={(e) => setClearance((prev) => ({ ...prev, end_customer_name: e.target.value }))} />
                    </label>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ fontSize: 12, opacity: 0.75 }}>End Customer PO Number</span>
                      <input value={clearance.end_customer_po_number} onChange={(e) => setClearance((prev) => ({ ...prev, end_customer_po_number: e.target.value }))} />
                    </label>
                    <label style={{ display: "grid", gap: 6, gridColumn: "1 / span 2" }}>
                      <span style={{ fontSize: 12, opacity: 0.75 }}>End Customer PO Date</span>
                      <input type="date" value={clearance.end_customer_po_date} onChange={(e) => setClearance((prev) => ({ ...prev, end_customer_po_date: e.target.value }))} />
                    </label>
                  </div>
                ) : null}
              </div>

              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                <div
                  style={{
                    border: "1px solid #eceff5",
                    borderRadius: 16,
                    background: "#ffffff",
                    padding: 14,
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62 }}>Bill To Snapshot</div>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, opacity: 0.75 }}>Bill To Name</span>
                    <input value={clearance.bill_to_name} onChange={(e) => setClearance((prev) => ({ ...prev, bill_to_name: e.target.value }))} />
                  </label>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, opacity: 0.75 }}>Bill To Address</span>
                    <textarea rows={4} style={{ width: "100%" }} value={clearance.bill_to_address} onChange={(e) => setClearance((prev) => ({ ...prev, bill_to_address: e.target.value }))} />
                  </label>
                </div>

                <div
                  style={{
                    border: "1px solid #eceff5",
                    borderRadius: 16,
                    background: "#ffffff",
                    padding: 14,
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.62 }}>Ship To Snapshot</div>
                  {canUseLinkedShipSite ? (
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ fontSize: 12, opacity: 0.75 }}>Linked Ship-To Site</span>
                      <select value={clearance.ship_to_customer_site_id} onChange={(e) => setClearance((prev) => ({ ...prev, ship_to_customer_site_id: e.target.value }))}>
                        <option value="">Manual / no linked site</option>
                        {linkedShipSites.map((site) => (
                          <option key={site.id} value={String(site.id)}>
                            {[site.site_code || null, site.site_name || null, site.site_type || null].filter(Boolean).join(" - ")}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <div style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.72 }}>
                      {activeClearanceMode?.fulfillmentMode === "stock_sale"
                        ? "Distributor stock-sale mode uses a manual ship-to snapshot rather than an end-customer dispatch site."
                        : "No dispatch-enabled customer sites are available. Use the manual ship-to snapshot below, or add a site here."}
                    </div>
                  )}
                  {activeClearanceMode?.fulfillmentMode !== "stock_sale" && Number(order?.customer_id) ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => {
                          setShowShipSiteCreate((prev) => !prev);
                          setNewShipSiteForm({
                            site_name: "",
                            address_line1: clearance.ship_to_address || "",
                            city: "",
                            state: "",
                            pincode: "",
                          });
                        }}
                      >
                        {showShipSiteCreate ? "Hide site form" : "Add ship-to site here"}
                      </button>
                      {showShipSiteCreate ? (
                        <div style={{ border: "1px solid #e7ebf3", borderRadius: 12, padding: 12, background: "#fbfcff", display: "grid", gap: 8 }}>
                          <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                            Create a dispatch-enabled plant without opening Customer Master.
                          </div>
                          <label style={{ display: "grid", gap: 4 }}>
                            <span style={{ fontSize: 12, opacity: 0.75 }}>Site name</span>
                            <input
                              value={newShipSiteForm.site_name}
                              onChange={(e) => setNewShipSiteForm((prev) => ({ ...prev, site_name: e.target.value }))}
                              placeholder="e.g. Pune Plant"
                            />
                          </label>
                          <label style={{ display: "grid", gap: 4 }}>
                            <span style={{ fontSize: 12, opacity: 0.75 }}>Address</span>
                            <input
                              value={newShipSiteForm.address_line1}
                              onChange={(e) => setNewShipSiteForm((prev) => ({ ...prev, address_line1: e.target.value }))}
                              placeholder="Optional"
                            />
                          </label>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                            <input
                              value={newShipSiteForm.city}
                              onChange={(e) => setNewShipSiteForm((prev) => ({ ...prev, city: e.target.value }))}
                              placeholder="City"
                            />
                            <input
                              value={newShipSiteForm.state}
                              onChange={(e) => setNewShipSiteForm((prev) => ({ ...prev, state: e.target.value }))}
                              placeholder="State"
                            />
                            <input
                              value={newShipSiteForm.pincode}
                              onChange={(e) => setNewShipSiteForm((prev) => ({ ...prev, pincode: e.target.value }))}
                              placeholder="Pincode"
                            />
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button type="button" className="button-primary" onClick={createShipSiteInline} disabled={shipSiteCreating}>
                              {shipSiteCreating ? "Saving…" : "Save ship-to site"}
                            </button>
                            <button type="button" onClick={() => setShowShipSiteCreate(false)} disabled={shipSiteCreating}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, opacity: 0.75 }}>Ship To Name</span>
                    <input value={clearance.ship_to_name} onChange={(e) => setClearance((prev) => ({ ...prev, ship_to_name: e.target.value }))} />
                  </label>
                  <label style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, opacity: 0.75 }}>Ship To Address</span>
                    <textarea rows={4} style={{ width: "100%" }} value={clearance.ship_to_address} onChange={(e) => setClearance((prev) => ({ ...prev, ship_to_address: e.target.value }))} />
                  </label>
                </div>
              </div>

              <button onClick={saveClearance} disabled={saving}>
                {saving ? "Saving..." : "Save Clearance"}
              </button>
            </div>
          </DeskCard>

          {creditControl?.ready ? (
            <DeskCard title="Credit Control" subtitle="Customer exposure and release state before confirming or dispatching">
              <div style={{ display: "grid", gap: 8, fontSize: 13, lineHeight: 1.8 }}>
                <div>Total exposure: {fmtMoney(creditControl.exposure?.total_exposure, order.order_currency_code)}</div>
                <div>Outstanding: {fmtMoney(creditControl.exposure?.outstanding_amount, order.order_currency_code)}</div>
                <div>Open order exposure: {fmtMoney(creditControl.exposure?.open_order_amount, order.order_currency_code)}</div>
                <div>Credit limit: {Number(creditControl.profile?.credit_limit || 0) > 0 ? fmtMoney(creditControl.profile?.credit_limit, order.order_currency_code) : "Not set"}</div>
                <div>Mode: {String(creditControl.profile?.credit_control_mode || "warning").replace(/_/g, " ")}</div>
                <div>Overdue invoices: {creditControl.exposure?.overdue_count || 0}</div>
                {creditControl.profile?.is_credit_hold ? <div style={{ color: "#b42318" }}>Manual hold: {creditControl.profile?.credit_hold_reason || "Customer blocked."}</div> : null}
                <div ref={creditPanelRef} style={{ marginTop: 6 }}>
                  <CreditReleasePanel
                    customerId={order.customer_id}
                    customerName={order.customer_name || ""}
                    onChanged={refreshCreditControl}
                    onOpenFullDesk={
                      typeof onOpenCreditRelease === "function"
                        ? () => onOpenCreditRelease({ customerId: order.customer_id, customerName: order.customer_name || "" })
                        : null
                    }
                  />
                </div>
              </div>
            </DeskCard>
          ) : null}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Order Lines" subtitle="Progress against dispatch and invoicing">
            <div style={{ display: "grid", gap: 10 }}>
              {lines.map((line) => (
                <div key={line.id} style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 14, background: "#ffffff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>L{line.line_no} • {line.item_code || line.item_name || "—"}</div>
                      <div style={{ fontSize: 12, opacity: 0.68 }}>{line.product_group_name || "—"}</div>
                      {line.customer_item_code ? (
                        <div style={{ fontSize: 12, marginTop: 4, color: "#9a5a00" }}>
                          Customer Part: {line.customer_item_code}
                          {line.customer_item_description ? ` — ${line.customer_item_description}` : ""}
                        </div>
                      ) : null}
                    </div>
                    <DeskChip label={fmtMoney(line.line_total_order, order.order_currency_code)} tone="#f6f7fb" color="#58627a" />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
                    <MiniMetric label="Qty" value={Number(line.qty || 0)} />
                    <MiniMetric label="Dispatched" value={Number(line.qty_dispatched || 0)} />
                    <MiniMetric label="Dispatch Bal" value={Number(line.qty_dispatch_remaining || 0)} />
                    <MiniMetric label="Invoiced" value={Number(line.qty_invoiced || 0)} />
                    <MiniMetric label="Invoice Bal" value={Number(line.qty_invoice_remaining || 0)} />
                  </div>
                </div>
              ))}
            </div>
          </DeskCard>

          <DeskCard title="Terms Snapshot" subtitle="Commercial terms frozen into the order">
            {terms.length ? (
              <div style={{ display: "grid", gap: 10 }}>
                {terms.map((term, index) => (
                  <div key={`${term.caption}-${index}`} style={{ border: "1px solid #f0f0f0", borderRadius: 12, padding: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{term.caption || `Term ${index + 1}`}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", marginTop: 6 }}>{term.description || "—"}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ opacity: 0.72 }}>No terms snapshot stored.</div>
            )}
          </DeskCard>
        </div>

        <div style={{ display: "grid", gap: 16, position: "sticky", top: 12 }}>
          <DeskCard title="Dispatch Register" subtitle="Open downstream dispatch documents">
            {dispatches.length ? (
              <div style={{ display: "grid", gap: 8 }}>
                {dispatches.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => onOpenDispatch?.(item.id)}
                    style={{ all: "unset", cursor: "pointer", border: "1px solid #f0f0f0", borderRadius: 12, padding: 12 }}
                  >
                    <div style={{ fontWeight: 700 }}>{item.dispatch_number}</div>
                    <div style={{ fontSize: 12, opacity: 0.72 }}>
                      {fmtDate(item.dispatch_date)} • {item.dispatch_status || "—"}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ opacity: 0.72 }}>No dispatches created yet.</div>
            )}
          </DeskCard>

          <DeskCard title="Invoice Register" subtitle="Open downstream invoice documents">
            {invoices.length ? (
              <div style={{ display: "grid", gap: 8 }}>
                {invoices.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => onOpenInvoice?.(item.id)}
                    style={{ all: "unset", cursor: "pointer", border: "1px solid #f0f0f0", borderRadius: 12, padding: 12 }}
                  >
                    <div style={{ fontWeight: 700 }}>{item.invoice_number}</div>
                    <div style={{ fontSize: 12, opacity: 0.72 }}>
                      {fmtDate(item.invoice_date)} • {item.invoice_status || "—"} • {fmtMoney(item.grand_total_invoice, order.order_currency_code)}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ opacity: 0.72 }}>No invoices created yet.</div>
            )}
          </DeskCard>

          <DeskCard title="Order Flight Log" subtitle="Quote-to-cash milestones tied to this sales order">
            <OrderFlightLog events={flightLogEvents} loading={flightLogLoading} />
          </DeskCard>
        </div>
      </div>

      <SlideOverDrawer
        open={Boolean(forceDispatch)}
        onClose={() => {
          if (creatingDispatch) return;
          setForceDispatch(null);
          setForceReason("");
        }}
        width={520}
        eyebrow="Manufacturing override"
        title="Force create dispatch"
        subtitle="Production or FG readiness is blocking this order. Confirm with a reason to override."
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setForceDispatch(null);
                setForceReason("");
              }}
              disabled={creatingDispatch}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button-primary"
              disabled={creatingDispatch || forceReason.trim().length < 3}
              onClick={async () => {
                const reason = forceReason.trim();
                if (reason.length < 3) return;
                setForceDispatch(null);
                await createDispatch({ force: true, forceReason: reason });
                setForceReason("");
              }}
            >
              {creatingDispatch ? "Creating…" : "Force create"}
            </button>
          </>
        }
      >
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.82 }}>{forceDispatch?.detail || "Order is not ready for dispatch."}</div>
          {Array.isArray(forceDispatch?.blockers) && forceDispatch.blockers.length ? (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
              {forceDispatch.blockers.map((item) => (
                <li key={String(item)}>{String(item)}</li>
              ))}
            </ul>
          ) : null}
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Override reason (required)</span>
            <textarea
              rows={4}
              value={forceReason}
              onChange={(e) => setForceReason(e.target.value)}
              placeholder="Explain why dispatch should proceed despite readiness blockers"
            />
          </label>
        </div>
      </SlideOverDrawer>
    </div>
  );
}

function statusTone(status) {
  return getDeskStatusAppearance(status, {
    success: ["confirmed", "closed"],
    danger: ["cancelled"],
    warning: ["draft"],
    info: ["submitted", "pending", "open"],
    fallbackTone: "#eef4ff",
  }).tone;
}

function statusColor(status) {
  return getDeskStatusAppearance(status, {
    success: ["confirmed", "closed"],
    danger: ["cancelled"],
    warning: ["draft"],
    info: ["submitted", "pending", "open"],
    fallbackColor: "#234a8f",
  }).color;
}

function getClearanceModeKey(clearance) {
  const orderFlow = String(clearance?.order_flow || "").toLowerCase();
  const fulfillmentMode = String(clearance?.fulfillment_mode || "").toLowerCase();
  if (orderFlow === "distributor" && fulfillmentMode === "direct_ship_end_customer") return "direct_ship_end_customer";
  if (orderFlow === "distributor") return "stock_sale";
  return "direct_customer";
}

function describeOrderFlow(orderFlow) {
  return String(orderFlow || "").toLowerCase() === "distributor" ? "Distributor" : "Direct Customer";
}

function describeFulfillmentMode(fulfillmentMode) {
  const value = String(fulfillmentMode || "").toLowerCase();
  if (value === "stock_sale") return "Stock Sale To Distributor";
  if (value === "direct_ship_end_customer") return "Bill Distributor, Ship End Customer";
  if (value === "direct_customer") return "Direct Customer Fulfillment";
  return fulfillmentMode || "—";
}
