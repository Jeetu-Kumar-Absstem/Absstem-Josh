import { useEffect, useMemo, useRef, useState } from "react";
import SlideOverDrawer from "../components/SlideOverDrawer";
import BlockerRibbon from "../shared/BlockerRibbon";
import CreditReleasePanel from "../shared/CreditReleasePanel";
import { DeskCard, DeskChip, DeskStat, MiniMetric, getDeskStatusAppearance } from "../shared/joshUi";

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

export default function Dispatches({ openDispatchId, launch, onConsumeLaunch, onOpenSalesOrder, onOpenGoodsReceipt, onOpenInvoice, onOpenCreditRelease }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [shipmentSummaryLoading, setShipmentSummaryLoading] = useState(false);
  const [shipmentSummary, setShipmentSummary] = useState(null);
  const [listQuery, setListQuery] = useState("");
  const [listStatus, setListStatus] = useState("");
  const [listBucket, setListBucket] = useState("");
  const [invoicingSalesOrderId, setInvoicingSalesOrderId] = useState(null);

  const dispatchStats = useMemo(() => {
    const total = items.length;
    const ready = items.filter((item) => ["ready"].includes(String(item.dispatch_status || "").toLowerCase())).length;
    const dispatched = items.filter((item) => ["dispatched", "delivered"].includes(String(item.dispatch_status || "").toLowerCase())).length;
    const draft = items.filter((item) => ["draft"].includes(String(item.dispatch_status || "").toLowerCase())).length;
    const needsInvoice = items.filter((item) => item.needs_invoice).length;
    return { total, ready, dispatched, draft, needsInvoice };
  }, [items]);

  async function createInvoiceFromSalesOrder(salesOrderId) {
    const soId = Number(salesOrderId);
    if (!Number.isFinite(soId) || soId <= 0) return;
    setInvoicingSalesOrderId(soId);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/invoices/from-sales-order/${soId}`, { method: "POST" });
      const invoiceId = data?.invoice?.id;
      setNotice("Invoice created from sales order.");
      await loadList();
      await loadShipmentSummary();
      if (invoiceId && typeof onOpenInvoice === "function") onOpenInvoice(invoiceId);
    } catch (e) {
      if (e?.data?.error === "ORDER_NOT_READY_FOR_INVOICE") setError("Confirm the sales order before creating an invoice.");
      else if (e?.data?.error === "FULLY_INVOICED") setError("All sales-order quantities are already invoiced.");
      else setError(e?.data?.error || "Failed to create invoice.");
    } finally {
      setInvoicingSalesOrderId(null);
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
      if (qText) params.set("q", qText);
      if (status) params.set("status", status);
      if (bucket) params.set("bucket", bucket);
      const data = await apiFetch(`/dispatches${params.toString() ? `?${params.toString()}` : ""}`);
      setItems(Array.isArray(data?.dispatches) ? data.dispatches : []);
    } catch (e) {
      setError(e?.data?.error || "Failed to load dispatches.");
    } finally {
      setLoading(false);
    }
  }

  async function loadShipmentSummary() {
    setShipmentSummaryLoading(true);
    setError("");
    try {
      const data = await apiFetch("/dispatches/shipment-control-summary");
      setShipmentSummary(data?.summary || null);
    } catch (e) {
      setShipmentSummary(null);
      setError(e?.data?.error || "Failed to load shipment control summary.");
    } finally {
      setShipmentSummaryLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadList();
      loadShipmentSummary().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
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
    const id = Number(openDispatchId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
  }, [openDispatchId]);

  const closeDetail = () => {
    setView({ type: "list" });
    loadList();
    loadShipmentSummary().catch(() => {});
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
              Dispatch Command Desk
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>Dispatches</h2>
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth: 760, lineHeight: 1.7 }}>
              Track despatch readiness, transporter information, and linked intercompany receipt flow from a queue-first operational surface.
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder="Search dispatch / customer / SO"
              style={{ minWidth: 240 }}
            />
            <select value={listStatus} onChange={(e) => setListStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="dispatched">Dispatched</option>
              <option value="delivered">Delivered</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select value={listBucket} onChange={(e) => setListBucket(e.target.value)}>
              <option value="">All buckets</option>
              <option value="docs_pending">Docs pending</option>
              <option value="ready_missing_transporter">Ready, missing transporter</option>
              <option value="ready_to_dispatch">Ready, transporter assigned</option>
              <option value="packing_list_pending">Packing list pending</option>
              <option value="pod_pending">POD pending</option>
              <option value="freight_pending">Freight pending</option>
              <option value="in_transit">In transit</option>
              <option value="dispatched_missing_docs">Dispatched, missing LR/eWay</option>
              <option value="eway_warning">E-way incomplete ≥ ₹50k</option>
              <option value="eway_expired">E-way expired (in transit)</option>
              <option value="dispatched_not_invoiced">Dispatched, not invoiced</option>
            </select>
            <button
              onClick={() => {
                loadList().catch(() => {});
                loadShipmentSummary().catch(() => {});
              }}
              disabled={loading || shipmentSummaryLoading}
            >
              {loading || shipmentSummaryLoading ? "Refreshing..." : "Refresh Queue"}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(140px, 1fr))", gap: 12, marginTop: 18 }}>
          <DeskStat label="Dispatches In View" value={dispatchStats.total} tone="#143d7a" />
          <DeskStat label="Draft" value={dispatchStats.draft} tone="#8b5a00" />
          <DeskStat label="Ready" value={dispatchStats.ready} tone="#234a8f" />
          <DeskStat label="Dispatched / Delivered" value={dispatchStats.dispatched} tone="#0a7a35" />
          <DeskStat label="Needs Invoice" value={dispatchStats.needsInvoice} tone="#b45309" />
        </div>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#f2fff6", border: "1px solid #d6f4df" }}>{notice}</div> : null}

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Shipment Control" subtitle="Docs completeness, in-transit execution, and billing lag">
          <div style={{ display: "grid", gap: 10 }}>
            {shipmentSummary ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(11, minmax(0, 1fr))", gap: 10 }}>
                <MiniMetric label="Docs pending" value={shipmentSummary.docs_pending || 0} />
                <MiniMetric label="Ready missing transp" value={shipmentSummary.ready_missing_transporter || 0} />
                <MiniMetric label="Ready to dispatch" value={shipmentSummary.ready_to_dispatch || 0} />
                <MiniMetric label="In transit" value={shipmentSummary.in_transit || 0} />
                <MiniMetric label="Missing LR/eWay" value={shipmentSummary.dispatched_missing_docs || 0} />
                <MiniMetric label="E-way warning" value={shipmentSummary.eway_warning || 0} />
                <MiniMetric label="E-way expired" value={shipmentSummary.eway_expired || 0} />
                <MiniMetric label="Not invoiced" value={shipmentSummary.dispatched_not_invoiced || 0} />
                <MiniMetric label="PL pending" value={shipmentSummary.packing_list_pending || 0} />
                <MiniMetric label="POD pending" value={shipmentSummary.pod_pending || 0} />
                <MiniMetric label="Freight pending" value={shipmentSummary.freight_pending || 0} />
              </div>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.72 }}>{shipmentSummaryLoading ? "Loading shipment control…" : "Shipment control summary not available."}</div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => {
                  setListStatus("");
                  setListBucket("docs_pending");
                  loadList({ status: "", bucket: "docs_pending" }).catch(() => {});
                }}
              >
                Docs Pending
              </button>
              <button
                onClick={() => {
                  setListStatus("ready");
                  setListBucket("ready_missing_transporter");
                  loadList({ status: "ready", bucket: "ready_missing_transporter" }).catch(() => {});
                }}
              >
                Ready Missing Transporter
              </button>
              <button
                onClick={() => {
                  setListStatus("ready");
                  setListBucket("ready_to_dispatch");
                  loadList({ status: "ready", bucket: "ready_to_dispatch" }).catch(() => {});
                }}
              >
                Ready To Dispatch
              </button>
              <button
                onClick={() => {
                  setListStatus("");
                  setListBucket("packing_list_pending");
                  loadList({ status: "", bucket: "packing_list_pending" }).catch(() => {});
                }}
              >
                Packing List Pending
              </button>
              <button
                onClick={() => {
                  setListStatus("");
                  setListBucket("pod_pending");
                  loadList({ status: "", bucket: "pod_pending" }).catch(() => {});
                }}
              >
                POD Pending
              </button>
              <button
                onClick={() => {
                  setListStatus("");
                  setListBucket("freight_pending");
                  loadList({ status: "", bucket: "freight_pending" }).catch(() => {});
                }}
              >
                Freight Pending
              </button>
              <button
                onClick={() => {
                  setListStatus("dispatched");
                  setListBucket("in_transit");
                  loadList({ status: "dispatched", bucket: "in_transit" }).catch(() => {});
                }}
              >
                In Transit
              </button>
              <button
                onClick={() => {
                  setListStatus("");
                  setListBucket("eway_warning");
                  loadList({ status: "", bucket: "eway_warning" }).catch(() => {});
                }}
              >
                E-way Incomplete ≥ ₹50k
              </button>
              <button
                onClick={() => {
                  setListStatus("dispatched");
                  setListBucket("eway_expired");
                  loadList({ status: "dispatched", bucket: "eway_expired" }).catch(() => {});
                }}
              >
                E-way Expired
              </button>
              <button
                onClick={() => {
                  setListStatus("");
                  setListBucket("dispatched_not_invoiced");
                  loadList({ status: "", bucket: "dispatched_not_invoiced" }).catch(() => {});
                }}
              >
                Dispatched Not Invoiced
              </button>
            </div>
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Dispatch Queue" subtitle="Open a dispatch desk directly from this queue">
          <div style={{ display: "grid", gap: 10, maxHeight: 980, overflowY: "auto", paddingRight: 4 }}>
            {loading ? (
              <div>Loading dispatches…</div>
            ) : items.length ? (
              items.map((item) => (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setView({ type: "detail", id: item.id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setView({ type: "detail", id: item.id });
                    }
                  }}
                  style={{
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
                        {fmtDate(item.dispatch_date)}
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{item.dispatch_number}</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <DeskChip label={String(item.dispatch_status || "draft").toUpperCase()} tone={statusTone(item.dispatch_status)} color={statusColor(item.dispatch_status)} />
                      {item.needs_invoice ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            createInvoiceFromSalesOrder(item.sales_order_id);
                          }}
                          disabled={invoicingSalesOrderId === Number(item.sales_order_id)}
                        >
                          {invoicingSalesOrderId === Number(item.sales_order_id) ? "Invoicing…" : "Invoice remaining"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{item.customer_name}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <DeskChip label={item.so_number ? `SO ${item.so_number}` : "No sales order"} tone="#eef4ff" color="#234a8f" />
                    <DeskChip label={item.transporter_name || "No transporter"} tone="#f6f7fb" color="#58627a" />
                    {item.needs_invoice ? <DeskChip label="Not invoiced" tone="#fff7ea" color="#8b5a00" /> : null}
                    {["dispatched", "delivered"].includes(String(item.dispatch_status || "").toLowerCase()) ? (
                      <DeskChip
                        label={
                          item.lr_no && item.vehicle_no && (item.eway_bill_no || item.eway_ref)
                            ? "Docs ok"
                            : `Docs missing${!item.lr_no ? " LR" : ""}${!item.vehicle_no ? " Vehicle" : ""}${!(item.eway_bill_no || item.eway_ref) ? " eWay" : ""}`
                        }
                        tone={item.lr_no && item.vehicle_no && (item.eway_bill_no || item.eway_ref) ? "#eefbf3" : "#fff7ea"}
                        color={item.lr_no && item.vehicle_no && (item.eway_bill_no || item.eway_ref) ? "#147a3d" : "#8b5a00"}
                      />
                    ) : null}
                    {item.eway?.severity === "warning" ? (
                      <DeskChip label="E-way incomplete" tone="#fff7ea" color="#8b5a00" />
                    ) : null}
                    {Array.isArray(item.eway?.warnings) && item.eway.warnings.some((w) => w.code === "EWAY_EXPIRED") ? (
                      <DeskChip label="E-way expired" tone="#fff2f2" color="#b42318" />
                    ) : null}
                    {["dispatched", "delivered"].includes(String(item.dispatch_status || "").toLowerCase()) ? (
                      <DeskChip
                        label={item.packing_list_no ? "Packing list ok" : "Packing list missing"}
                        tone={item.packing_list_no ? "#eefbf3" : "#fff7ea"}
                        color={item.packing_list_no ? "#147a3d" : "#8b5a00"}
                      />
                    ) : null}
                    {String(item.dispatch_status || "").toLowerCase() === "delivered" ? (
                      <DeskChip
                        label={item.pod_attachment_id ? "POD ok" : "POD missing"}
                        tone={item.pod_attachment_id ? "#eefbf3" : "#fff2f2"}
                        color={item.pod_attachment_id ? "#147a3d" : "#b42318"}
                      />
                    ) : null}
                    {String(item.dispatch_status || "").toLowerCase() === "delivered" ? (
                      <DeskChip
                        label={item.freight_bill_no && Number(item.freight_amount || 0) > 0 ? "Freight ok" : "Freight pending"}
                        tone={item.freight_bill_no && Number(item.freight_amount || 0) > 0 ? "#eefbf3" : "#fff7ea"}
                        color={item.freight_bill_no && Number(item.freight_amount || 0) > 0 ? "#147a3d" : "#8b5a00"}
                      />
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                No dispatches yet. Create the first one from a confirmed sales order.
              </div>
            )}
          </div>
        </DeskCard>
      </div>
    </div>
    <SlideOverDrawer
      open={view.type === "detail"}
      onClose={closeDetail}
      eyebrow="Dispatch"
      title={view.type === "detail" ? `Dispatch #${view.id}` : "Dispatch"}
      subtitle="Shipment control queue stays open behind this drawer — close when the dispatch step is done."
      width={900}
    >
      {view.type === "detail" ? (
        <DispatchDetail
          id={view.id}
          embedded
          onBack={closeDetail}
          onOpenSalesOrder={onOpenSalesOrder}
          onOpenGoodsReceipt={onOpenGoodsReceipt}
          onOpenInvoice={onOpenInvoice}
          onOpenCreditRelease={onOpenCreditRelease}
          onNotice={(msg) => setNotice(msg)}
        />
      ) : null}
    </SlideOverDrawer>
    </>
  );
}

function DispatchDetail({ id, onBack, onOpenSalesOrder, onOpenGoodsReceipt, onOpenInvoice, onNotice, onOpenCreditRelease, embedded = false }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dispatch, setDispatch] = useState(null);
  const [lines, setLines] = useState([]);
  const [creditControl, setCreditControl] = useState(null);
  const creditPanelRef = useRef(null);
  const podSectionRef = useRef(null);
  const [eway, setEway] = useState(null);
  const [needsInvoice, setNeedsInvoice] = useState(false);
  const [form, setForm] = useState({
    dispatch_status: "draft",
    dispatch_date: "",
    transporter_name: "",
    lr_no: "",
    vehicle_no: "",
    eway_ref: "",
    eway_bill_no: "",
    eway_bill_date: "",
    eway_valid_till: "",
    transporter_id: "",
    transport_mode: "road",
    vehicle_type: "",
    approx_distance_km: "",
    ship_to_gstin: "",
    lr_date: "",
    dispatch_from_pincode: "",
    tracking_ref: "",
    bill_to_name: "",
    bill_to_address: "",
    ship_to_name: "",
    ship_to_address: "",
    consignee_name: "",
    consignee_address: "",
    remarks: "",
    packing_list_no: "",
    packing_list_date: "",
    no_of_packages: "",
    gross_weight: "",
    net_weight: "",
    packing_remarks: "",
    freight_paid_by: "",
    freight_amount: "",
    freight_bill_no: "",
    freight_bill_date: "",
  });

  useEffect(() => {
    setLoading(true);
    apiFetch(`/dispatches/${id}`)
      .then((data) => {
        const header = data?.dispatch || null;
        setDispatch(header);
        setNeedsInvoice(Boolean(data?.needs_invoice));
        setCreditControl(data?.credit_control || null);
        setEway(data?.eway || null);
        const nextLines = Array.isArray(data?.lines) ? data.lines : [];
        setLines(nextLines.map((line) => ({ ...line, qty_dispatch: String(line.qty_dispatch ?? line.qty_ordered ?? 0) })));
        setForm({
          dispatch_status: header?.dispatch_status || "draft",
          dispatch_date: header?.dispatch_date ? String(header.dispatch_date).slice(0, 10) : "",
          transporter_name: header?.transporter_name || "",
          lr_no: header?.lr_no || "",
          vehicle_no: header?.vehicle_no || "",
          eway_ref: header?.eway_ref || "",
          eway_bill_no: header?.eway_bill_no || "",
          eway_bill_date: header?.eway_bill_date ? String(header.eway_bill_date).slice(0, 10) : "",
          eway_valid_till: header?.eway_valid_till ? String(header.eway_valid_till).slice(0, 16) : "",
          transporter_id: header?.transporter_id || "",
          transport_mode: header?.transport_mode || "road",
          vehicle_type: header?.vehicle_type || "",
          approx_distance_km: header?.approx_distance_km ?? "",
          ship_to_gstin: header?.ship_to_gstin || "",
          lr_date: header?.lr_date ? String(header.lr_date).slice(0, 10) : "",
          dispatch_from_pincode: header?.dispatch_from_pincode || "",
          tracking_ref: header?.tracking_ref || "",
          bill_to_name: header?.bill_to_name || "",
          bill_to_address: header?.bill_to_address || "",
          ship_to_name: header?.ship_to_name || header?.consignee_name || "",
          ship_to_address: header?.ship_to_address || header?.consignee_address || "",
          consignee_name: header?.consignee_name || "",
          consignee_address: header?.consignee_address || "",
          remarks: header?.remarks || "",
          packing_list_no: header?.packing_list_no || "",
          packing_list_date: header?.packing_list_date ? String(header.packing_list_date).slice(0, 10) : "",
          no_of_packages: header?.no_of_packages ?? "",
          gross_weight: header?.gross_weight ?? "",
          net_weight: header?.net_weight ?? "",
          packing_remarks: header?.packing_remarks || "",
          freight_paid_by: header?.freight_paid_by || "",
          freight_amount: header?.freight_amount ?? "",
          freight_bill_no: header?.freight_bill_no || "",
          freight_bill_date: header?.freight_bill_date ? String(header.freight_bill_date).slice(0, 10) : "",
        });
      })
      .catch((e) => setError(e?.data?.error || "Failed to load dispatch."))
      .finally(() => setLoading(false));
  }, [id]);

  async function saveDispatch() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/dispatches/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...form,
          consignee_name: form.ship_to_name,
          consignee_address: form.ship_to_address,
          lines: lines.map((line) => ({
            id: line.id,
            sales_order_line_id: Number(line.sales_order_line_id || 0),
            qty_dispatch: Number(line.qty_dispatch || 0),
          })),
        }),
      });
      const header = data?.dispatch || dispatch;
      setDispatch(header);
      setCreditControl(data?.credit_control || null);
      setEway(data?.eway || null);
      const nextLines = Array.isArray(data?.lines) ? data.lines : [];
      setLines(nextLines.map((line) => ({ ...line, qty_dispatch: String(line.qty_dispatch ?? line.qty_ordered ?? 0) })));
      setNotice("Dispatch updated successfully.");
      onNotice?.("Dispatch updated successfully.");
    } catch (e) {
      if (e?.data?.credit_control) setCreditControl(e.data.credit_control);
      setError(
        e?.data?.error === "INVALID_DISPATCH_QTY"
          ? "Dispatch quantity must be between 0 and the remaining dispatch quantity."
          : e?.data?.error === "CUSTOMER_CREDIT_HOLD"
            ? e?.data?.detail || "Customer is on manual credit hold."
            : e?.data?.error === "CUSTOMER_OVER_CREDIT_LIMIT"
              ? e?.data?.detail || "Customer is over the approved credit limit."
              : e?.data?.error === "CUSTOMER_OVERDUE_BLOCK"
                ? e?.data?.detail || "Customer has overdue receivables and is blocked."
                : e?.data?.error || "Failed to save dispatch."
      );
    } finally {
      setSaving(false);
    }
  }

  async function uploadPod(file) {
    if (!file) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/dispatches/${id}/pod`, { method: "POST", credentials: "include", body });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw { data };
      const header = data?.dispatch || null;
      if (header) setDispatch(header);
      setNotice("POD uploaded successfully.");
      onNotice?.("POD uploaded successfully.");
    } catch (e) {
      setError(e?.data?.error || "Failed to upload POD.");
    } finally {
      setSaving(false);
    }
  }

  async function invoiceRemainingQty() {
    if (!dispatch?.sales_order_id) return;
    setCreatingInvoice(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/invoices/from-sales-order/${dispatch.sales_order_id}`, { method: "POST" });
      const invoiceId = data?.invoice?.id;
      setNeedsInvoice(false);
      setNotice("Invoice created from sales order.");
      if (typeof onNotice === "function") onNotice("Invoice created from sales order.");
      if (invoiceId && typeof onOpenInvoice === "function") onOpenInvoice(invoiceId);
    } catch (e) {
      if (e?.data?.error === "ORDER_NOT_READY_FOR_INVOICE") setError("Confirm the sales order before creating an invoice.");
      else if (e?.data?.error === "FULLY_INVOICED") {
        setNeedsInvoice(false);
        setError("All sales-order quantities are already invoiced.");
      } else setError(e?.data?.error || "Failed to create invoice.");
    } finally {
      setCreatingInvoice(false);
    }
  }

  const dispatchBlockers = useMemo(() => {
    const items = [];
    const creditBlock = creditControl?.decisions?.dispatch_release;
    if (creditBlock?.block || creditBlock?.warn) {
      items.push({
        id: "credit-dispatch",
        severity: creditBlock.block ? "high" : "soft",
        reason: creditBlock.message || "Dispatch release is blocked by credit control.",
        explain: creditBlock.explain || null,
        creditMode: creditBlock.mode || creditControl?.profile?.credit_control_mode,
        ownerDesk: "Credit",
        ctaLabel: creditBlock.block ? "Request / approve release" : "View credit position",
        onCta: () => creditPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
      });
    }
    const dispatchStatus = String(dispatch?.dispatch_status || "").toLowerCase();
    if (needsInvoice && dispatch?.sales_order_id && ["dispatched", "delivered"].includes(dispatchStatus)) {
      items.push({
        id: "dispatch-not-invoiced",
        severity: "med",
        reason: "Goods have left but the shipped quantity is not invoiced yet.",
        ownerDesk: "Billing",
        ctaLabel: "Invoice remaining qty",
        onCta: invoiceRemainingQty,
      });
    }
    if (dispatchStatus === "delivered" && !dispatch?.pod_attachment_id) {
      items.push({
        id: "pod-missing",
        severity: "med",
        reason: "Marked delivered without a proof of delivery on file.",
        ownerDesk: "Dispatch",
        ctaLabel: "Upload POD",
        onCta: () => podSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
      });
    }
    return items;
  }, [creditControl, dispatch, needsInvoice]);

  function refreshCreditControl() {
    apiFetch(`/dispatches/${id}`)
      .then((data) => setCreditControl(data?.credit_control || null))
      .catch(() => {});
  }

  const creditCustomerId = creditControl?.profile?.customer_id || dispatch?.customer_id || null;
  const creditCustomerName = creditControl?.profile?.customer_name || dispatch?.customer_name || "";

  if (loading) return <div>Loading dispatch…</div>;
  if (!dispatch) {
    return (
      <div>
        {!embedded ? <button onClick={onBack}>Back</button> : null}
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Dispatch not found."}</div>
      </div>
    );
  }

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
              Active Dispatch Desk
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>{dispatch.dispatch_number}</h2>
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth: 780, lineHeight: 1.7 }}>
              {dispatch.customer_name} • {dispatch.so_number ? `SO ${dispatch.so_number}` : "No source order"} • transporter and delivery control stay visible here.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <DeskChip label={String(dispatch.dispatch_status || "draft").toUpperCase()} tone={statusTone(dispatch.dispatch_status)} color={statusColor(dispatch.dispatch_status)} />
            {!embedded ? <button onClick={onBack}>Back To Queue</button> : null}
            <a
              href={`/dispatches/${id}/pdf`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none", border: "1px solid #d0d0d0", borderRadius: 6, padding: "8px 12px", color: "#111", background: "#fff", fontSize: 13 }}
            >
              Download Challan PDF
            </a>
            <a
              href={`/dispatches/${id}/packing-list/pdf`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none", border: "1px solid #d0d0d0", borderRadius: 6, padding: "8px 12px", color: "#111", background: "#fff", fontSize: 13 }}
            >
              Download Packing List
            </a>
            {dispatch.pod_attachment_id ? (
              <a
                href={`/dispatches/${id}/pod`}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "none", border: "1px solid #d0d0d0", borderRadius: 6, padding: "8px 12px", color: "#111", background: "#fff", fontSize: 13 }}
              >
                Download POD
              </a>
            ) : null}
            {dispatch.sales_order_id && onOpenSalesOrder ? <button onClick={() => onOpenSalesOrder(dispatch.sales_order_id)}>Open Sales Order</button> : null}
            {needsInvoice && dispatch.sales_order_id ? (
              <button
                onClick={invoiceRemainingQty}
                disabled={creatingInvoice}
              >
                {creatingInvoice ? "Creating Invoice…" : "Invoice remaining qty"}
              </button>
            ) : null}
            {dispatch.intercompany_goods_receipt_id && onOpenGoodsReceipt ? <button onClick={() => onOpenGoodsReceipt(dispatch.intercompany_goods_receipt_id)}>Open Linked GRN</button> : null}
          </div>
        </div>

        <BlockerRibbon blockers={dispatchBlockers} />
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#f2fff6", border: "1px solid #d6f4df" }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(280px, 0.72fr) minmax(0, 1.1fr) minmax(300px, 0.7fr)", gap: 18, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Dispatch Header" subtitle="Status, dates, transporter, consignee, and remarks">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Status"><select value={form.dispatch_status} onChange={(e) => setForm((p) => ({ ...p, dispatch_status: e.target.value }))}><option value="draft">Draft</option><option value="ready">Ready</option><option value="dispatched">Dispatched</option><option value="delivered">Delivered</option><option value="cancelled">Cancelled</option></select></Field>
              <Field label="Dispatch Date"><input type="date" value={form.dispatch_date} onChange={(e) => setForm((p) => ({ ...p, dispatch_date: e.target.value }))} /></Field>
              <Field label="Transporter"><input value={form.transporter_name} onChange={(e) => setForm((p) => ({ ...p, transporter_name: e.target.value }))} /></Field>
              <Field label="LR / AWB"><input value={form.lr_no} onChange={(e) => setForm((p) => ({ ...p, lr_no: e.target.value }))} /></Field>
              <Field label="Vehicle No"><input value={form.vehicle_no} onChange={(e) => setForm((p) => ({ ...p, vehicle_no: e.target.value }))} /></Field>
              <Field label="Tracking Ref"><input value={form.tracking_ref} onChange={(e) => setForm((p) => ({ ...p, tracking_ref: e.target.value }))} /></Field>
              <Field label="Bill To"><input value={form.bill_to_name} onChange={(e) => setForm((p) => ({ ...p, bill_to_name: e.target.value }))} /></Field>
              <Field label="Ship To / Consignee"><input value={form.ship_to_name} onChange={(e) => setForm((p) => ({ ...p, ship_to_name: e.target.value }))} /></Field>
            </div>
            <Field label="Bill To Address"><textarea rows={3} style={{ width: "100%" }} value={form.bill_to_address} onChange={(e) => setForm((p) => ({ ...p, bill_to_address: e.target.value }))} /></Field>
            <Field label="Ship To Address"><textarea rows={3} style={{ width: "100%" }} value={form.ship_to_address} onChange={(e) => setForm((p) => ({ ...p, ship_to_address: e.target.value }))} /></Field>
            <Field label="Remarks"><textarea rows={3} style={{ width: "100%" }} value={form.remarks} onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))} /></Field>
            <button onClick={saveDispatch} disabled={saving}>{saving ? "Saving..." : "Save Dispatch"}</button>
          </DeskCard>

          <DeskCard title="E-Way Bill" subtitle="Part A and Part B capture for consignments of ₹50,000 or more">
            {form.eway_bill_no ? (
              <div
                style={{
                  marginBottom: 12,
                  padding: "10px 12px",
                  borderRadius: 12,
                  background: "#eef4ff",
                  border: "1px solid #c7d7ff",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                <strong>Filed EBN (invoice/GSP sync):</strong> {form.eway_bill_no}
                {form.eway_bill_date ? ` · ${form.eway_bill_date}` : ""}
                {form.eway_valid_till ? ` · valid till ${form.eway_valid_till}` : ""}
                <div style={{ opacity: 0.72, fontSize: 12, marginTop: 4 }}>
                  Generate/cancel runs from the Invoice desk. Part B vehicle/transporter fields below remain editable for logistics.
                </div>
              </div>
            ) : null}
            <div
              style={{
                marginBottom: 12,
                padding: "10px 12px",
                borderRadius: 12,
                background: eway?.severity === "warning" ? "#fff7ea" : eway?.complete ? "#eefbf3" : "#f6f7fb",
                border: `1px solid ${eway?.severity === "warning" ? "#f0d9a8" : eway?.complete ? "#c6ebd4" : "#e4e7ef"}`,
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <div>
                Consignment value ₹{Number(eway?.consignment_value || 0).toLocaleString("en-IN")} · basis{" "}
                {eway?.consignment_value_basis || "—"} · {eway?.is_interstate ? "Inter-state" : "Intra-state"} · threshold ₹50,000
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                {eway?.complete ? (
                  <DeskChip label="E-way documents complete" tone="#eefbf3" color="#147a3d" />
                ) : Array.isArray(eway?.warnings) && eway.warnings.length ? (
                  eway.warnings.map((w) => (
                    <DeskChip
                      key={w.code}
                      label={w.message}
                      tone={eway.severity === "warning" ? "#fff7ea" : "#f6f7fb"}
                      color={eway.severity === "warning" ? "#8b5a00" : "#58627a"}
                    />
                  ))
                ) : (
                  <DeskChip label="No e-way gaps flagged" tone="#f6f7fb" color="#58627a" />
                )}
              </div>
              <div style={{ marginTop: 8, opacity: 0.72, fontSize: 12 }}>
                Advisory only — you can still mark this dispatch Ready or Dispatched. Some states set a higher intra-state threshold; ₹50,000 is applied as the default.
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="E-Way Bill No">
                <input value={form.eway_bill_no} onChange={(e) => setForm((p) => ({ ...p, eway_bill_no: e.target.value }))} placeholder="12-digit EBN" />
              </Field>
              <Field label="E-Way Bill Date">
                <input type="date" value={form.eway_bill_date} onChange={(e) => setForm((p) => ({ ...p, eway_bill_date: e.target.value }))} />
              </Field>
              <Field label="Valid Till">
                <input type="datetime-local" value={form.eway_valid_till} onChange={(e) => setForm((p) => ({ ...p, eway_valid_till: e.target.value }))} />
              </Field>
              <Field label="Transporter ID / GSTIN">
                <input value={form.transporter_id} onChange={(e) => setForm((p) => ({ ...p, transporter_id: e.target.value }))} />
              </Field>
              <Field label="Transport Mode">
                <select
                  value={form.transport_mode}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      transport_mode: e.target.value,
                      vehicle_type: e.target.value === "road" ? p.vehicle_type : "",
                    }))
                  }
                >
                  <option value="road">Road</option>
                  <option value="rail">Rail</option>
                  <option value="air">Air</option>
                  <option value="ship">Ship</option>
                </select>
              </Field>
              {form.transport_mode === "road" ? (
                <Field label="Vehicle Type">
                  <select value={form.vehicle_type} onChange={(e) => setForm((p) => ({ ...p, vehicle_type: e.target.value }))}>
                    <option value="">Select</option>
                    <option value="R">Regular</option>
                    <option value="O">ODC</option>
                  </select>
                </Field>
              ) : (
                <Field label="LR Date">
                  <input type="date" value={form.lr_date} onChange={(e) => setForm((p) => ({ ...p, lr_date: e.target.value }))} />
                </Field>
              )}
              <Field label="Approx Distance (km)">
                <input value={form.approx_distance_km} onChange={(e) => setForm((p) => ({ ...p, approx_distance_km: e.target.value }))} />
              </Field>
              {form.transport_mode === "road" ? (
                <Field label="LR Date">
                  <input type="date" value={form.lr_date} onChange={(e) => setForm((p) => ({ ...p, lr_date: e.target.value }))} />
                </Field>
              ) : null}
              <Field label="Ship-To GSTIN">
                <input value={form.ship_to_gstin} onChange={(e) => setForm((p) => ({ ...p, ship_to_gstin: e.target.value }))} />
              </Field>
              <Field label="Dispatch-From PIN">
                <input value={form.dispatch_from_pincode} onChange={(e) => setForm((p) => ({ ...p, dispatch_from_pincode: e.target.value }))} />
              </Field>
            </div>
            <button onClick={saveDispatch} disabled={saving} style={{ marginTop: 12 }}>
              {saving ? "Saving..." : "Save Dispatch"}
            </button>
            {form.eway_bill_no ? (
              <button
                type="button"
                disabled={saving || !form.vehicle_no}
                style={{ marginTop: 12, marginLeft: 8 }}
                title={
                  form.vehicle_no
                    ? "Push Part B vehicle change to MasterGST (VEHEWB)"
                    : "Enter vehicle number first"
                }
                onClick={async () => {
                  if (!window.confirm(`Update vehicle ${form.vehicle_no} on e-way ${form.eway_bill_no} via MasterGST?`)) {
                    return;
                  }
                  setSaving(true);
                  setError("");
                  setNotice("");
                  try {
                    const data = await apiFetch(`/dispatches/${id}/eway/update-vehicle`, {
                      method: "POST",
                      body: JSON.stringify({
                        vehicle_no: form.vehicle_no,
                        transport_mode: form.transport_mode,
                        vehicle_type: form.vehicle_type,
                        approx_distance_km: form.approx_distance_km,
                        transporter_id: form.transporter_id,
                        transporter_name: form.transporter_name,
                        lr_no: form.lr_no,
                        lr_date: form.lr_date,
                        dispatch_from_pincode: form.dispatch_from_pincode,
                        remark: "Vehicle changed from Josh dispatch desk",
                      }),
                    });
                    const header = data?.dispatch || dispatch;
                    setDispatch(header);
                    if (header) {
                      setForm((p) => ({
                        ...p,
                        vehicle_no: header.vehicle_no || p.vehicle_no,
                        transport_mode: header.transport_mode || p.transport_mode,
                        vehicle_type: header.vehicle_type || p.vehicle_type,
                        approx_distance_km: header.approx_distance_km ?? p.approx_distance_km,
                        eway_valid_till: header.eway_valid_till
                          ? String(header.eway_valid_till).slice(0, 16)
                          : p.eway_valid_till,
                      }));
                    }
                    const msg = data?.gsp?.mocked
                      ? `Mock vehicle update saved${data?.gsp?.valid_till ? ` · valid till ${data.gsp.valid_till}` : ""}.`
                      : `Vehicle updated on portal${data?.gsp?.valid_till ? ` · valid till ${data.gsp.valid_till}` : ""}.`;
                    setNotice(msg);
                    onNotice?.(msg);
                  } catch (e) {
                    setError(
                      e?.data?.error === "NOT_CONFIGURED"
                        ? e?.data?.detail || "MasterGST is not configured for this company."
                        : e?.data?.detail || e?.data?.error || "Vehicle update via GSP failed."
                    );
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Update vehicle via GSP
              </button>
            ) : null}
          </DeskCard>

          <DeskCard title="Packing & Freight" subtitle="Packing list details, freight bill capture, and POD upload">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Packing list no"><input value={form.packing_list_no} onChange={(e) => setForm((p) => ({ ...p, packing_list_no: e.target.value }))} /></Field>
              <Field label="Packing list date"><input type="date" value={form.packing_list_date} onChange={(e) => setForm((p) => ({ ...p, packing_list_date: e.target.value }))} /></Field>
              <Field label="No. of packages"><input value={form.no_of_packages} onChange={(e) => setForm((p) => ({ ...p, no_of_packages: e.target.value }))} /></Field>
              <Field label="Gross weight"><input value={form.gross_weight} onChange={(e) => setForm((p) => ({ ...p, gross_weight: e.target.value }))} /></Field>
              <Field label="Net weight"><input value={form.net_weight} onChange={(e) => setForm((p) => ({ ...p, net_weight: e.target.value }))} /></Field>
              <Field label="Freight paid by"><input value={form.freight_paid_by} onChange={(e) => setForm((p) => ({ ...p, freight_paid_by: e.target.value }))} /></Field>
              <Field label="Freight amount"><input value={form.freight_amount} onChange={(e) => setForm((p) => ({ ...p, freight_amount: e.target.value }))} /></Field>
              <Field label="Freight bill no"><input value={form.freight_bill_no} onChange={(e) => setForm((p) => ({ ...p, freight_bill_no: e.target.value }))} /></Field>
              <Field label="Freight bill date"><input type="date" value={form.freight_bill_date} onChange={(e) => setForm((p) => ({ ...p, freight_bill_date: e.target.value }))} /></Field>
            </div>
            <Field label="Packing remarks"><textarea rows={3} style={{ width: "100%" }} value={form.packing_remarks} onChange={(e) => setForm((p) => ({ ...p, packing_remarks: e.target.value }))} /></Field>
            <div ref={podSectionRef} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Upload POD
                <input type="file" accept=".pdf,image/*" disabled={saving} onChange={(e) => uploadPod(e.target.files?.[0])} />
              </label>
              {dispatch.pod_attachment_id ? <DeskChip label="POD attached" tone="#eefbf3" color="#147a3d" /> : <DeskChip label="POD pending" tone="#fff2f2" color="#b42318" />}
              <button onClick={saveDispatch} disabled={saving}>{saving ? "Saving..." : "Save Packing/Freight"}</button>
            </div>
          </DeskCard>

          {creditControl?.ready ? (
            <DeskCard title="Credit Control" subtitle="Release state before marking dispatch ready or dispatched">
              <div style={{ display: "grid", gap: 8, fontSize: 13, lineHeight: 1.8 }}>
                <div>Total exposure: {Number(creditControl.exposure?.total_exposure || 0).toFixed(2)}</div>
                <div>Outstanding: {Number(creditControl.exposure?.outstanding_amount || 0).toFixed(2)}</div>
                <div>Open order exposure: {Number(creditControl.exposure?.open_order_amount || 0).toFixed(2)}</div>
                <div>Overdue invoices: {creditControl.exposure?.overdue_count || 0}</div>
                <div>Mode: {String(creditControl.profile?.credit_control_mode || "warning").replace(/_/g, " ")}</div>
                <div>Credit limit: {Number(creditControl.profile?.credit_limit || 0) > 0 ? Number(creditControl.profile?.credit_limit || 0).toFixed(2) : "Not set"}</div>
                {creditControl.profile?.is_credit_hold ? <div style={{ color: "#b42318" }}>Manual hold: {creditControl.profile?.credit_hold_reason || "Customer blocked."}</div> : null}
                {creditControl.active_release?.id ? <div style={{ color: "#0a7a35" }}>Active release till {fmtDate(creditControl.active_release?.expires_on)}</div> : null}
                <div ref={creditPanelRef} style={{ marginTop: 6 }}>
                  <CreditReleasePanel
                    customerId={creditCustomerId}
                    customerName={creditCustomerName}
                    onChanged={refreshCreditControl}
                    onOpenFullDesk={
                      typeof onOpenCreditRelease === "function"
                        ? () => onOpenCreditRelease({ customerId: creditCustomerId, customerName: creditCustomerName })
                        : null
                    }
                  />
                </div>
              </div>
            </DeskCard>
          ) : null}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Dispatch Lines" subtitle="Enter actual dispatch quantity against remaining quantities">
            <div style={{ display: "grid", gap: 10 }}>
              {lines.map((line) => (
                <div key={line.id} style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 14, background: "#ffffff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>L{line.line_no} • {line.item_code || line.item_name || "—"}</div>
                      <div style={{ fontSize: 12, opacity: 0.68 }}>{line.product_group_name || "—"}</div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr)) 140px", gap: 10, marginTop: 12, alignItems: "end" }}>
                    <MiniMetric label="Ordered Qty" value={Number(line.qty_ordered || 0)} />
                    <MiniMetric label="Prev Disp." value={Number(line.qty_previously_dispatched || 0)} />
                    <MiniMetric label="Avail. Qty" value={Number(line.qty_remaining_before_dispatch || 0)} />
                    <MiniMetric label="Current Status" value={dispatch.dispatch_status || "—"} />
                    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                      Dispatch Qty
                      <input value={line.qty_dispatch} onChange={(e) => setLines((prev) => prev.map((row) => (row.id === line.id ? { ...row, qty_dispatch: e.target.value } : row)))} />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </DeskCard>
        </div>

        <div style={{ display: "grid", gap: 16, position: "sticky", top: 12 }}>
          <DeskCard title="Source Snapshot" subtitle="Commercial and intercompany context">
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <div>Sales Order: {dispatch.so_number || "—"}</div>
              <div>Order Status: {dispatch.order_status || "—"}</div>
              <div>Dispatch Date: {fmtDate(dispatch.dispatch_date)}</div>
              <div>Bill To: {dispatch.bill_to_name || "—"}</div>
              <div>Ship To: {dispatch.ship_to_name || dispatch.consignee_name || "—"}</div>
              <div>End Customer: {dispatch.end_customer_name || "—"}</div>
              {dispatch.intercompany_counterparty_company_id ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>Intercompany</div>
                  <div style={{ opacity: 0.78 }}>
                    Counterparty: {dispatch.intercompany_company_code ? `${dispatch.intercompany_company_code} - ` : ""}{dispatch.intercompany_company_name || "—"}
                  </div>
                  <div style={{ opacity: 0.78 }}>
                    Linked GRN: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{dispatch.intercompany_grn_number || (dispatch.intercompany_goods_receipt_id ? `#${dispatch.intercompany_goods_receipt_id}` : "—")}</span>
                  </div>
                </div>
              ) : null}
            </div>
          </DeskCard>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function statusTone(status) {
  return getDeskStatusAppearance(status, {
    success: ["delivered", "dispatched"],
    info: ["ready"],
    danger: ["cancelled"],
    warning: ["draft"],
    fallbackTone: "#fff6e8",
  }).tone;
}

function statusColor(status) {
  return getDeskStatusAppearance(status, {
    success: ["delivered", "dispatched"],
    info: ["ready"],
    danger: ["cancelled"],
    warning: ["draft"],
    fallbackColor: "#8b5a00",
  }).color;
}
