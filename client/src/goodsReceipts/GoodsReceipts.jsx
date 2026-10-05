import { useEffect, useMemo, useState } from "react";
import ApprovalHistoryDrawer from "../shared/ApprovalHistoryDrawer";
import SlideOverDrawer from "../components/SlideOverDrawer";
import VendorQuickCreate from "../components/VendorQuickCreate";
import { DeskCard, DeskChip, EmptyState, MiniMetric, NoticeBanner, PageHero, FieldLabel, getDeskStatusAppearance, toast, useSubmitLock } from "../shared/joshUi";

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

function emptyLine() {
  return {
    product_id: null,
    item_code: "",
    item_name: "",
    line_description: "",
    hsn_no: "",
    uom: "",
    qty_received: 0,
    gst_pct: 0,
    serial_no_required: false,
    serials: [],
    location_id: null,
    line_remarks: "",
  };
}

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["approved", "posted"],
    info: ["submitted"],
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

export default function GoodsReceipts({
  openGoodsReceiptId,
  launch,
  onConsumeLaunch,
  onOpenPurchaseOrder,
  onOpenQualityControl,
  onOpenQualityControlsDesk,
  onOpenSupplierClaim,
  onOpenSupplierClaimsDesk,
  onOpenPurchaseReturns,
  onOpenThreeWayMatch,
}) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [exceptionsSummary, setExceptionsSummary] = useState(null);
  const [exceptionsRows, setExceptionsRows] = useState([]);
  const [exceptionsBucket, setExceptionsBucket] = useState("pending_receipt");
  const [exceptionsQuery, setExceptionsQuery] = useState("");
  const [exceptionsLoading, setExceptionsLoading] = useState(false);
  const [exceptionsError, setExceptionsError] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], purchase_orders: [], locations: [] });
  const [createMode, setCreateMode] = useState("from_po");
  const [createPoId, setCreatePoId] = useState("");
  const [createVendorId, setCreateVendorId] = useState("");
  const [creating, setCreating] = useState(false);
  const [receivingPoId, setReceivingPoId] = useState(null);

  const receiptStats = useMemo(() => {
    const total = items.length;
    const draft = items.filter((row) => String(row.receipt_status || "").toLowerCase() === "draft").length;
    const submitted = items.filter((row) => String(row.receipt_status || "").toLowerCase() === "submitted").length;
    const posted = items.filter((row) => ["approved", "posted"].includes(String(row.receipt_status || "").toLowerCase())).length;
    return { total, draft, submitted, posted };
  }, [items]);

  async function loadBootstrap() {
    const data = await apiFetch("/goods-receipts/bootstrap");
    setBootstrap({
      vendors: Array.isArray(data?.vendors) ? data.vendors : [],
      purchase_orders: Array.isArray(data?.purchase_orders) ? data.purchase_orders : [],
      locations: Array.isArray(data?.locations) ? data.locations : [],
    });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/goods-receipts");
      setItems(Array.isArray(data?.goods_receipts) ? data.goods_receipts : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load goods receipts."));
    } finally {
      setLoading(false);
    }
  }

  async function loadExceptionsSummary() {
    try {
      const data = await apiFetch("/goods-receipts/exceptions-summary");
      setExceptionsSummary(data?.summary || null);
    } catch (e) {
      setExceptionsSummary(null);
      setExceptionsError(getApiErrorMessage(e, "Failed to load receiving exceptions summary."));
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
      const data = await apiFetch(`/goods-receipts/exceptions-queue${query ? `?${query}` : ""}`);
      setExceptionsRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setExceptionsRows([]);
      setExceptionsError(getApiErrorMessage(e, "Failed to load receiving exceptions queue."));
    } finally {
      setExceptionsLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
      loadExceptionsSummary().catch(() => {});
      loadExceptionsQueue().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadExceptionsQueue({ bucket: exceptionsBucket }).catch(() => {});
  }, [exceptionsBucket]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextBucket = typeof launch.receiving_bucket === "string" ? launch.receiving_bucket : exceptionsBucket;
    const nextQuery = typeof launch.receiving_q === "string" ? launch.receiving_q : "";
    setExceptionsBucket(nextBucket);
    setExceptionsQuery(nextQuery);
    if (view.type !== "list") setView({ type: "list" });
    loadExceptionsSummary().catch(() => {});
    loadExceptionsQueue({ bucket: nextBucket, q: nextQuery }).catch(() => {});

    const createFromPoId = Number(launch.create_from_po_id);
    if (Number.isFinite(createFromPoId) && createFromPoId > 0) {
      setCreateMode("from_po");
      setCreatePoId(String(createFromPoId));
      (async () => {
        setCreating(true);
        setError("");
        setNotice("");
        try {
          const data = await apiFetch(`/goods-receipts/from-po/${createFromPoId}`, { method: "POST" });
          const id = data?.goods_receipt?.id;
          if (id) setView({ type: "detail", id });
          setNotice("GRN created from PO.");
          loadExceptionsSummary().catch(() => {});
          loadExceptionsQueue().catch(() => {});
        } catch (e) {
          if (e?.data?.error === "FULLY_RECEIVED") setError("This PO is already fully received.");
          else if (e?.data?.error === "RECEIPT_SHORT_CLOSED") setError("This PO receipt was short-closed.");
          else if (e?.data?.error === "PO_NOT_RECEIVABLE") setError("Only approved/closed POs can be received.");
          else setError(getApiErrorMessage(e, "Failed to create GRN from PO."));
        } finally {
          setCreating(false);
        }
      })();
    }

    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    const id = Number(openGoodsReceiptId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
  }, [openGoodsReceiptId]);

  async function receiveFromPo(poId) {
    const id = Number(poId);
    if (!Number.isFinite(id) || id <= 0) return;
    setReceivingPoId(id);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/goods-receipts/from-po/${id}`, { method: "POST" });
      const grnId = data?.goods_receipt?.id;
      if (grnId) setView({ type: "detail", id: grnId });
      setNotice("GRN created from PO.");
      loadExceptionsSummary().catch(() => {});
      loadExceptionsQueue().catch(() => {});
    } catch (e) {
      if (e?.data?.error === "FULLY_RECEIVED") setError("This PO is already fully received.");
      else if (e?.data?.error === "RECEIPT_SHORT_CLOSED") setError("This PO receipt was short-closed.");
      else if (e?.data?.error === "PO_NOT_RECEIVABLE") setError("Only approved/closed POs can be received.");
      else setError(getApiErrorMessage(e, "Failed to create GRN from PO."));
    } finally {
      setReceivingPoId(null);
    }
  }

  async function createReceipt() {
    setCreating(true);
    setError("");
    setNotice("");
    try {
      if (createMode === "from_po") {
        const poId = Number(createPoId);
        if (!Number.isFinite(poId) || poId <= 0) {
          setError("Select a purchase order first.");
          return;
        }
        const data = await apiFetch(`/goods-receipts/from-po/${poId}`, { method: "POST" });
        const id = data?.goods_receipt?.id;
        if (id) setView({ type: "detail", id });
        setNotice("GRN created from PO.");
        loadExceptionsSummary().catch(() => {});
        loadExceptionsQueue().catch(() => {});
        return;
      }

      const vendorId = Number(createVendorId);
      if (!Number.isFinite(vendorId) || vendorId <= 0) {
        setError("Select a vendor first.");
        return;
      }
      const data = await apiFetch("/goods-receipts", {
        method: "POST",
        body: JSON.stringify({ vendor_id: vendorId }),
      });
      const id = data?.goods_receipt?.id;
      if (id) setView({ type: "detail", id });
      setNotice("GRN created.");
      loadExceptionsSummary().catch(() => {});
      loadExceptionsQueue().catch(() => {});
    } catch (e) {
      if (e?.data?.error === "FULLY_RECEIVED") setError("This PO is already fully received.");
      else if (e?.data?.error === "RECEIPT_SHORT_CLOSED") setError("This PO receipt was short-closed.");
      else if (e?.data?.error === "PO_NOT_RECEIVABLE") setError("Only approved/closed POs can be received.");
      else setError(getApiErrorMessage(e, "Failed to create GRN."));
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    // Keep queue mounted under the drawer so filters/buckets stay intact.
  }

  const closeDetail = () => {
    setView({ type: "list" });
    loadList();
    loadExceptionsSummary().catch(() => {});
    loadExceptionsQueue().catch(() => {});
  };

  const heroStats = [
    { label: "Pending Receipt", value: exceptionsSummary?.pending_receipt_count ?? receiptStats.total, tone: "#143d7a" },
    { label: "GRN In Progress", value: exceptionsSummary?.grn_in_progress_count ?? receiptStats.draft, tone: "#8b5a00" },
    { label: "Awaiting QC", value: exceptionsSummary?.awaiting_qc_count ?? receiptStats.submitted, tone: "#234a8f" },
    { label: "QC / Claim Exceptions", value: (Number(exceptionsSummary?.qc_hold_count || 0) + Number(exceptionsSummary?.replacement_pending_count || 0)) || receiptStats.posted, tone: "#9f2042" },
  ];

  const exceptionCards = [
    { key: "pending_receipt", label: "PO pending receipt", count: Number(exceptionsSummary?.pending_receipt_count || 0), qty: Number(exceptionsSummary?.pending_receipt_qty || 0), tone: "#143d7a" },
    { key: "grn_in_progress", label: "GRN in progress", count: Number(exceptionsSummary?.grn_in_progress_count || 0), qty: Number(exceptionsSummary?.grn_in_progress_qty || 0), tone: "#8b5a00" },
    { key: "awaiting_qc", label: "Posted GRN awaiting QC", count: Number(exceptionsSummary?.awaiting_qc_count || 0), qty: Number(exceptionsSummary?.awaiting_qc_qty || 0), tone: "#234a8f" },
    { key: "qc_hold", label: "QC hold unresolved", count: Number(exceptionsSummary?.qc_hold_count || 0), qty: Number(exceptionsSummary?.qc_hold_qty || 0), tone: "#9f2042" },
    { key: "rtv_pending", label: "RTV pending", count: Number(exceptionsSummary?.rtv_pending_count || 0), qty: Number(exceptionsSummary?.rtv_pending_qty || 0), tone: "#7b4ad8" },
    { key: "claim_ready", label: "Supplier claim ready", count: Number(exceptionsSummary?.claim_ready_count || 0), qty: Number(exceptionsSummary?.claim_ready_qty || 0), tone: "#5d6782" },
    { key: "replacement_pending", label: "Replacement pending receipt", count: Number(exceptionsSummary?.replacement_pending_count || 0), qty: Number(exceptionsSummary?.replacement_pending_qty || 0), tone: "#0a7a35" },
    { key: "mismatch_risk", label: "PO / GRN mismatch risk", count: Number(exceptionsSummary?.mismatch_risk_count || 0), qty: Number(exceptionsSummary?.mismatch_risk_qty || 0), tone: "#9f2042" },
  ];

  return (
    <>
    <div style={{ maxWidth: 1460 }}>
      <PageHero
        eyebrow="Goods Receipts (GRN)"
        title="GRN desk"
        description="Control receiving before AP issues begin: keep live PO receipt backlog visible, isolate GRNs stuck before posting, push posted GRNs into QC, and follow hold, RTV, and supplier replacement exceptions from one desk."
        actions={<button onClick={() => {
          loadList();
          loadExceptionsSummary().catch(() => {});
          loadExceptionsQueue().catch(() => {});
        }} disabled={loading || exceptionsLoading}>{loading || exceptionsLoading ? "Refreshing..." : "Refresh Queue"}</button>}
        stats={heroStats}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Receiving Exceptions Desk" subtitle="Work receiving control upstream of QC, claims, returns, and AP invoice pressure">
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              {exceptionCards.map((card) => (
                <button key={card.key} onClick={() => setExceptionsBucket(card.key)} style={commandButtonStyle(exceptionsBucket === card.key)}>
                  <div style={{ fontSize: 12, opacity: 0.68 }}>{card.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: card.tone }}>{card.count}</div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>{card.qty > 0 ? `${card.qty.toFixed(4)} qty` : "Open queue"}</div>
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
                placeholder="Search PO, GRN, QC, claim, or vendor"
                style={{ ...inputStyle(), minWidth: 260, flex: "1 1 260px" }}
              />
              <button onClick={() => loadExceptionsQueue({ q: exceptionsQuery })} disabled={exceptionsLoading}>
                {exceptionsLoading ? "Refreshing..." : "Refresh Exception Queue"}
              </button>
              <div style={{ fontSize: 12, color: "#58627a" }}>
                Claim-ready qty: {Number(exceptionsSummary?.claim_ready_qty || 0).toFixed(4)}
              </div>
            </div>

            <NoticeBanner tone="error" message={exceptionsError} />

            {exceptionsLoading ? (
              <div>Loading receiving exceptions…</div>
            ) : exceptionsRows.length ? (
              <div style={{ display: "grid", gap: 12 }}>
                {["pending_receipt", "mismatch_risk"].includes(exceptionsBucket)
                  ? exceptionsRows.map((row) => (
                      <div key={row.id} style={queueCardStyle()}>
                        <div style={queueHeaderStyle()}>
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 16 }}>{row.po_number}</div>
                            <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>{row.vendor_name} • {fmtDate(row.po_date)}</div>
                          </div>
                          <DeskChip label={String(row.po_status || "approved").toUpperCase()} tone="#eef4ff" color="#234a8f" />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                          <MiniMetric label="Pending Lines" value={row.pending_lines || 0} />
                          <MiniMetric label="Pending Qty" value={Number(row.pending_qty || 0).toFixed(4)} />
                          <MiniMetric label="Ordered Qty" value={Number(row.ordered_qty || 0).toFixed(4)} />
                          <MiniMetric label="Received Qty" value={Number(row.received_qty || 0).toFixed(4)} />
                          <MiniMetric label="Mismatch Lines" value={row.mismatch_lines || 0} />
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {exceptionsBucket === "pending_receipt" ? (
                            <button onClick={() => receiveFromPo(row.id)} disabled={Number(receivingPoId) === Number(row.id) || creating}>
                              {Number(receivingPoId) === Number(row.id) ? "Creating GRN..." : "Receive Goods"}
                            </button>
                          ) : null}
                          {typeof onOpenPurchaseOrder === "function" ? <button onClick={() => onOpenPurchaseOrder(Number(row.id))}>Open PO</button> : null}
                          {typeof onOpenThreeWayMatch === "function" ? <button onClick={() => onOpenThreeWayMatch({ po_id: row.id })}>Open 3-way Match</button> : null}
                        </div>
                      </div>
                    ))
                  : ["grn_in_progress", "awaiting_qc"].includes(exceptionsBucket)
                    ? exceptionsRows.map((row) => {
                        const appearance = statusAppearance(row.receipt_status);
                        return (
                          <div key={row.id} style={queueCardStyle()}>
                            <div style={queueHeaderStyle()}>
                              <div>
                                <div style={{ fontWeight: 800, fontSize: 16 }}>{row.grn_number}</div>
                                <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>{row.vendor_name} • {row.po_number || "Standalone inward"} • {fmtDate(row.receipt_date)}</div>
                              </div>
                              <DeskChip label={String(row.receipt_status || "draft").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Lines" value={row.line_count || 0} />
                              <MiniMetric label="Qty Received" value={Number(row.qty_received || 0).toFixed(4)} />
                              <MiniMetric label="Source" value={row.po_number || "Manual"} />
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => setView({ type: "detail", id: row.id })}>Open GRN</button>
                              {typeof onOpenQualityControlsDesk === "function" && exceptionsBucket === "awaiting_qc" ? (
                                <button onClick={() => onOpenQualityControlsDesk()}>Open QC Desk</button>
                              ) : null}
                              {typeof onOpenThreeWayMatch === "function" && Number.isFinite(Number(row.purchase_order_id)) && Number(row.purchase_order_id) > 0 ? (
                                <button onClick={() => onOpenThreeWayMatch({ po_id: row.purchase_order_id })}>Open 3-way Match</button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    : exceptionsBucket === "replacement_pending"
                      ? exceptionsRows.map((row) => (
                          <div key={row.id} style={queueCardStyle()}>
                            <div style={queueHeaderStyle()}>
                              <div>
                                <div style={{ fontWeight: 800, fontSize: 16 }}>{row.claim_number}</div>
                                <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>{row.vendor_name} • QC {row.qc_number} • GRN {row.grn_number}</div>
                              </div>
                              <DeskChip label={String(row.claim_status || "open").toUpperCase()} tone="#f2fbf6" color="#24593b" />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Claimed" value={Number(row.total_claimed_qty || 0).toFixed(4)} />
                              <MiniMetric label="Received" value={Number(row.total_received_qty || 0).toFixed(4)} />
                              <MiniMetric label="Pending" value={Number(row.total_pending_qty || 0).toFixed(4)} />
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {typeof onOpenSupplierClaim === "function" ? <button onClick={() => onOpenSupplierClaim(Number(row.id))}>Open Claim</button> : null}
                              {typeof onOpenQualityControl === "function" ? <button onClick={() => onOpenQualityControl(Number(row.quality_control_id))}>Open QC</button> : null}
                              {typeof onOpenThreeWayMatch === "function" && Number.isFinite(Number(row.purchase_order_id)) && Number(row.purchase_order_id) > 0 ? (
                                <button onClick={() => onOpenThreeWayMatch({ po_id: row.purchase_order_id })}>Open 3-way Match</button>
                              ) : null}
                            </div>
                          </div>
                        ))
                      : exceptionsRows.map((row) => (
                          <div key={row.id} style={queueCardStyle()}>
                            <div style={queueHeaderStyle()}>
                              <div>
                                <div style={{ fontWeight: 800, fontSize: 16 }}>{row.qc_number}</div>
                                <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>{row.vendor_name} • GRN {row.grn_number}</div>
                              </div>
                              <DeskChip label={String(row.qc_status || "draft").toUpperCase()} tone="#eef4ff" color="#234a8f" />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Pending Hold" value={Number(row.pending_hold_qty || 0).toFixed(4)} />
                              <MiniMetric label="Pending RTV" value={Number(row.pending_rtv_qty || 0).toFixed(4)} />
                              <MiniMetric label="Claim Actions" value={row.claim_ready_actions || 0} />
                              <MiniMetric label="Claim Qty" value={Number(row.claim_ready_qty || 0).toFixed(4)} />
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {typeof onOpenQualityControl === "function" ? <button onClick={() => onOpenQualityControl(Number(row.id))}>Open QC</button> : null}
                              {typeof onOpenPurchaseReturns === "function" && exceptionsBucket === "rtv_pending" ? (
                                <button onClick={() => onOpenPurchaseReturns()}>Open Purchase Returns</button>
                              ) : null}
                              {typeof onOpenSupplierClaimsDesk === "function" && exceptionsBucket === "claim_ready" ? (
                                <button onClick={() => onOpenSupplierClaimsDesk()}>Open Supplier Claims</button>
                              ) : null}
                              {typeof onOpenThreeWayMatch === "function" && Number.isFinite(Number(row.purchase_order_id)) && Number(row.purchase_order_id) > 0 ? (
                                <button onClick={() => onOpenThreeWayMatch({ po_id: row.purchase_order_id })}>Open 3-way Match</button>
                              ) : null}
                            </div>
                          </div>
                        ))}
              </div>
            ) : (
              <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                No receiving rows in this exception bucket right now.
              </div>
            )}
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(320px, 430px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard
          title="Launch GRN"
          subtitle="Start from a PO to preserve pending controls or open a standalone inward desk for unlinked receipts."
          actions={<DeskChip label={createMode === "from_po" ? "FROM PO" : "STANDALONE"} tone="#eef4ff" color="#234a8f" />}
        >
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setCreateMode("from_po")} style={{ opacity: createMode === "from_po" ? 1 : 0.72 }}>
                From PO
              </button>
              <button type="button" onClick={() => setCreateMode("manual")} style={{ opacity: createMode === "manual" ? 1 : 0.72 }}>
                Standalone
              </button>
            </div>

            {createMode === "from_po" ? (
              <>
                <FieldLabel label="Purchase Order">
                  <select value={createPoId} onChange={(e) => setCreatePoId(e.target.value)} style={inputStyle()}>
                    <option value="">Select PO</option>
                    {bootstrap.purchase_orders.map((po) => (
                      <option key={po.id} value={String(po.id)}>
                        {po.po_number} • {po.vendor_name}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                <button onClick={createReceipt} disabled={creating}>{creating ? "Creating..." : "Create From PO"}</button>
              </>
            ) : (
              <>
                <FieldLabel label="Vendor">
                  <select value={createVendorId} onChange={(e) => setCreateVendorId(e.target.value)} style={inputStyle()}>
                    <option value="">Select vendor</option>
                    {bootstrap.vendors.map((v) => (
                      <option key={v.id} value={String(v.id)}>
                        {v.company_name}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                <VendorQuickCreate
                  endpoint="/goods-receipts/vendors/quick-create"
                  onCreated={(vendor) => {
                    setBootstrap((prev) => ({
                      ...prev,
                      vendors: [
                        { id: vendor.id, vendor_code: vendor.vendor_code, company_name: vendor.company_name, gstin: vendor.gstin, is_active: true },
                        ...(prev.vendors || []).filter((v) => Number(v.id) !== Number(vendor.id)),
                      ],
                    }));
                    setCreateVendorId(String(vendor.id));
                    setNotice(`Vendor “${vendor.company_name}” created and selected.`);
                  }}
                />
                <button onClick={createReceipt} disabled={creating}>{creating ? "Creating..." : "Create Standalone GRN"}</button>
              </>
            )}

            <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, lineHeight: 1.7, color: "#58627a" }}>
              {createMode === "from_po"
                ? "PO-linked GRN respects pending quantities and remains aligned with approval, stock, and intercompany follow-up."
                : "Standalone GRN keeps manual inward possible without changing existing serial validation rules."}
            </div>
          </div>
        </DeskCard>

        <DeskCard title="GRN Queue" subtitle="Readable receiving queue with document context, source, and status at a glance">
          <div style={{ display: "grid", gap: 12, maxHeight: 1040, overflowY: "auto", paddingRight: 4 }}>
            {loading ? (
              <div>Loading goods receipts…</div>
            ) : items.length ? (
              items.map((item) => {
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
                        <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                          {item.grn_number}
                        </div>
                      </div>
                      <DeskChip label={String(item.receipt_status || "draft").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                    </div>

                    <div style={{ fontSize: 14, fontWeight: 700 }}>{item.vendor_name || "No vendor"}</div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Source" value={item.po_number || "Standalone"} />
                      <MiniMetric label="Receipt Date" value={fmtDate(item.receipt_date)} />
                      <MiniMetric label="Mode" value={item.po_number ? "PO-linked" : "Manual inward"} />
                    </div>
                  </button>
                );
              })
            ) : (
              <EmptyState
                title="No goods receipts yet"
                body="Start a PO-linked GRN from Pending Receipt, or open a standalone inward receipt."
              />
            )}
          </div>
        </DeskCard>
      </div>
    </div>
    <SlideOverDrawer
      open={view.type === "detail"}
      onClose={closeDetail}
      eyebrow="Goods Receipts (GRN)"
      title={view.type === "detail" ? `GRN #${view.id}` : "GRN"}
      subtitle="Queue stays open behind this drawer — close when you are done."
      width={780}
    >
      {view.type === "detail" ? (
        <GoodsReceiptDetail
          id={view.id}
          locations={bootstrap.locations}
          embedded
          onBack={closeDetail}
          onOpenPurchaseOrder={onOpenPurchaseOrder}
          onOpenQualityControl={onOpenQualityControl}
          onOpenPurchaseReturns={onOpenPurchaseReturns}
          onOpenThreeWayMatch={onOpenThreeWayMatch}
        />
      ) : null}
    </SlideOverDrawer>
    </>
  );
}

function GoodsReceiptDetail({
  id,
  locations: locationsProp = [],
  onBack,
  embedded = false,
  onOpenPurchaseOrder = null,
  onOpenQualityControl = null,
  onOpenPurchaseReturns = null,
  onOpenThreeWayMatch = null,
}) {
  const { busy, isBusy, runLocked } = useSubmitLock();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [approvalRemarks, setApprovalRemarks] = useState("");
  const [shortCloseRemarks, setShortCloseRemarks] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], locations: [] });
  const [header, setHeader] = useState(null);
  const [vendorId, setVendorId] = useState("");
  const [status, setStatus] = useState("draft");
  const [receiptDate, setReceiptDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);

  const canEditLines = (header?.receipt_status || "draft") === "draft";
  const isStandalone = !header?.purchase_order_id;
  const locations = Array.isArray(locationsProp) && locationsProp.length ? locationsProp : bootstrap.locations || [];
  const saving = isBusy("save");
  const shortClosing = isBusy("short-close");
  const isShortClosed = Boolean(header?.receipt_short_closed_at);
  const canShortClose =
    !isStandalone &&
    !isShortClosed &&
    ["approved", "closed"].includes(String(header?.po_status || "").toLowerCase()) &&
    lines.some((line) => Number(line.qty_remaining_receive || 0) > 0.0001);

  useEffect(() => {
    setLoading(true);
    setError("");
    setNotice("");
    Promise.all([apiFetch("/goods-receipts/bootstrap"), apiFetch(`/goods-receipts/${id}`)])
      .then(([boot, detail]) => {
        setBootstrap({
          vendors: Array.isArray(boot?.vendors) ? boot.vendors : [],
          locations: Array.isArray(boot?.locations) ? boot.locations : [],
        });
        const h = detail?.goods_receipt || null;
        setHeader(h);
        setVendorId(h?.vendor_id ? String(h.vendor_id) : "");
        setStatus(h?.receipt_status || "draft");
        setReceiptDate(toIsoDate(h?.receipt_date));
        setRemarks(h?.remarks || "");
        setLines(Array.isArray(detail?.lines) ? detail.lines.map((l) => ({ ...l })) : []);
      })
      .catch((e) => setError(e?.data?.error || "Failed to load GRN."))
      .finally(() => setLoading(false));
  }, [id]);

  function updateLine(index, patch) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function updateSerials(index, nextValue) {
    const raw = String(nextValue || "");
    const serials = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length);
    updateLine(index, { serials });
  }

  async function searchProducts() {
    const q = searchTerm.trim();
    if (!q) return;
    setSearching(true);
    setError("");
    try {
      const data = await apiFetch(`/goods-receipts/product-lookup?q=${encodeURIComponent(q)}`);
      setSearchResults(Array.isArray(data?.products) ? data.products : []);
    } catch (e) {
      setError("Product lookup failed.");
    } finally {
      setSearching(false);
    }
  }

  function addProduct(product) {
    setLines((prev) => [
      ...prev,
      {
        ...emptyLine(),
        product_id: product.id,
        item_code: product.item_code || "",
        item_name: product.item_name || "",
        uom: product.uom || "",
        hsn_no: product.hsn_no || "",
        gst_pct: Number(product.gst_pct || 0),
        qty_received: 0,
        serial_no_required: product.serial_no_required === true,
        location_id: null,
        line_remarks: "",
      },
    ]);
  }

  async function save() {
    await runLocked("save", async () => {
      setError("");
      setNotice("");
      try {
        const payload = {
          vendor_id: vendorId ? Number(vendorId) : undefined,
          receipt_status: status,
          receipt_date: receiptDate || undefined,
          remarks: remarks || null,
          approval_remarks: approvalRemarks || null,
        };

        if (canEditLines) {
          payload.lines = lines.map((line) => ({
            id: line.id,
            purchase_order_line_id: line.purchase_order_line_id ?? null,
            qty_received: Number(line.qty_received || 0),
            location_id: line.location_id ? Number(line.location_id) : null,
            line_remarks: line.line_remarks || null,
            serials: Array.isArray(line.serials) ? line.serials : [],
          }));
        }

        const data = await apiFetch(`/goods-receipts/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        const h = data?.goods_receipt || header;
        setHeader(h);
        setVendorId(h?.vendor_id ? String(h.vendor_id) : vendorId);
        setStatus(h?.receipt_status || status);
        setReceiptDate(toIsoDate(h?.receipt_date));
        setRemarks(h?.remarks || "");
        setLines(Array.isArray(data?.lines) ? data.lines.map((l) => ({ ...l })) : lines);
        const msg = status === "posted" ? "GRN saved and stock posted." : "GRN saved.";
        setNotice(msg);
        toast(msg, "success");
        setApprovalRemarks("");
      } catch (e) {
        const code = e?.data?.error;
        let message = code || "Failed to save GRN.";
        if (code === "RECEIPT_NOT_EDITABLE") message = "Only draft GRNs can be edited.";
        else if (code === "INVALID_RECEIVE_QTY") message = "Received qty must be within pending quantity (for PO GRN).";
        else if (code === "SERIAL_QTY_NOT_INTEGER") message = "Serial-tracked items must have integer qty.";
        else if (code === "SERIAL_COUNT_MISMATCH") message = "Serial count must match received qty.";
        else if (code === "DUPLICATE_SERIALS") message = "Duplicate serial numbers found.";
        else if (code === "INVALID_LOCATION") message = "Select a valid stock location.";
        setError(message);
        toast(message, "error");
      }
    });
  }

  async function shortCloseRemaining() {
    const poId = Number(header?.purchase_order_id);
    if (!Number.isFinite(poId) || poId <= 0) return;
    await runLocked("short-close", async () => {
      setError("");
      setNotice("");
      try {
        await apiFetch(`/goods-receipts/short-close-po/${poId}`, {
          method: "POST",
          body: JSON.stringify({ remarks: shortCloseRemarks || null }),
        });
        setHeader((prev) =>
          prev
            ? {
                ...prev,
                receipt_short_closed_at: new Date().toISOString(),
                receipt_short_close_remarks: shortCloseRemarks || null,
                po_status: prev.po_status === "approved" ? "closed" : prev.po_status,
              }
            : prev
        );
        setNotice("Remaining PO quantity short-closed.");
        toast("Remaining PO quantity short-closed.", "success");
        setShortCloseRemarks("");
      } catch (e) {
        const code = e?.data?.error;
        let message = getApiErrorMessage(e, "Failed to short-close remaining quantity.");
        if (code === "ALREADY_SHORT_CLOSED") message = "PO receipt is already short-closed.";
        else if (code === "NOTHING_TO_SHORT_CLOSE") message = "No remaining quantity to short-close.";
        setError(message);
        toast(message, "error");
      }
    });
  }

  if (loading) return <div>Loading GRN…</div>;

  if (!header) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "GRN not found."}</div>
      </div>
    );
  }

  const statusMeta = statusAppearance(status);

  return (
    <>
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow={embedded ? "Drawer detail" : "Goods Receipts (GRN)"}
        title={header.grn_number}
        description={`${header.vendor_name || "Vendor pending"}${header.po_number ? ` • ${header.po_number}` : " • Standalone inward"} • ${isStandalone ? "Manual item addition available." : "PO quantities remain bounded by pending receipt."}`}
        actions={
          <>
            {!embedded ? <button onClick={onBack}>Back</button> : null}
            {header.purchase_order_id && typeof onOpenPurchaseOrder === "function" ? (
              <button type="button" onClick={() => onOpenPurchaseOrder(Number(header.purchase_order_id))}>Open PO</button>
            ) : null}
            {header.purchase_order_id && typeof onOpenThreeWayMatch === "function" ? (
              <button type="button" onClick={() => onOpenThreeWayMatch({ po_id: Number(header.purchase_order_id) })}>Open 3-way</button>
            ) : null}
            {typeof onOpenPurchaseReturns === "function" ? (
              <button type="button" onClick={() => onOpenPurchaseReturns({ q: header.grn_number || "", from_grn_id: header.id })}>Open Returns</button>
            ) : null}
            <button onClick={() => setHistoryOpen(true)}>History / Remarks</button>
            <button onClick={save} disabled={busy}>{saving ? "Saving..." : "Save"}</button>
          </>
        }
        stats={[
          { label: "Status", value: String(status || "draft").toUpperCase(), tone: statusMeta.color },
          { label: "Lines", value: lines.length, tone: "#143d7a" },
          { label: "Receipt Date", value: receiptDate || "—", tone: "#234a8f" },
          { label: "Mode", value: isStandalone ? "Standalone" : "PO-linked", tone: "#0a7a35" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(320px, 0.8fr)", gap: 16, alignItems: "start" }}>
        <DeskCard
          title="GRN Snapshot"
          subtitle="Header controls stay concise while the receiving desk remains easy to work inside"
          actions={<DeskChip label={String(status || "draft").toUpperCase()} tone={statusMeta.tone} color={statusMeta.color} />}
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
            </FieldLabel>

            <FieldLabel label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle()}>
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
                <option value="approved">Approved</option>
                <option value="posted">Posted</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </FieldLabel>

            <FieldLabel label="Receipt Date">
              <input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} style={inputStyle()} />
            </FieldLabel>
          </div>

          <FieldLabel label="Remarks" style={{ marginTop: 12 }}>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={4} style={textAreaStyle()} />
          </FieldLabel>
        </DeskCard>

        <DeskCard title="Receipt Control" subtitle="Track cumulative receipt and close remaining when supply is complete enough">
          <div style={{ display: "grid", gap: 10 }}>
            <MiniMetric label="Receipt Mode" value={header.purchase_order_id ? "PO-linked" : "Standalone"} />
            <MiniMetric label="Source Document" value={header.po_number || "No purchase order"} />
            <MiniMetric label="PO Status" value={String(header.po_status || "—").toUpperCase()} />
            <MiniMetric label="Short-close" value={isShortClosed ? "Closed remaining" : "Open"} />
            <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, lineHeight: 1.7, color: "#58627a" }}>
              {header.purchase_order_id
                ? isShortClosed
                  ? `Remaining quantity was short-closed${header.receipt_short_close_remarks ? `: ${header.receipt_short_close_remarks}` : "."}`
                  : "Edit this-time qty, optional location/remarks, then move draft → submitted → approved → posted to land stock."
                : "Standalone GRN allows manual line addition and still enforces serial validation when required."}
            </div>
            {canShortClose ? (
              <div style={{ display: "grid", gap: 8 }}>
                <FieldLabel label="Short-close remarks">
                  <input
                    value={shortCloseRemarks}
                    onChange={(e) => setShortCloseRemarks(e.target.value)}
                    placeholder="Optional reason for cancelling remaining"
                    style={inputStyle()}
                  />
                </FieldLabel>
                <button onClick={shortCloseRemaining} disabled={shortClosing}>
                  {shortClosing ? "Short-closing..." : "Short-close remaining qty"}
                </button>
              </div>
            ) : null}
          </div>
        </DeskCard>
      </div>

      {isStandalone ? (
        <div style={{ marginTop: 16 }}>
          <DeskCard title="Add Items" subtitle="Search and add inward items only when this GRN is standalone">
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
                      <div style={{ fontSize: 12, opacity: 0.72 }}>
                        Serial: {p.serial_no_required ? "Yes" : "No"} • UOM {p.uom || "—"} • GST {Number(p.gst_pct || 0)}%
                      </div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </DeskCard>
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <DeskCard
          title="GRN Lines"
          subtitle={canEditLines ? "Receiving cards keep quantities and serial capture readable." : "Read-only card view after the document leaves draft."}
          actions={<DeskChip label={canEditLines ? "EDITABLE" : "READ ONLY"} tone={canEditLines ? "#eef4ff" : "#f5f6fa"} color={canEditLines ? "#234a8f" : "#5d6782"} />}
        >
          {lines.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {lines.map((line, index) => {
                const label = line.item_code || line.item_name || "—";
                const desc = line.product_group_name || line.item_name || line.line_description || "—";
                const needsSerials = line.serial_no_required === true;
                const serialText = Array.isArray(line.serials) ? line.serials.join("\n") : "";
                return (
                  <div key={`${line.id || "new"}-${index}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#fcfdff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Line {index + 1}</div>
                        <div style={{ fontWeight: 800, marginTop: 4 }}>{label}</div>
                        <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4 }}>{desc}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <DeskChip label={needsSerials ? "SERIAL TRACKED" : "NON SERIAL"} tone={needsSerials ? "#fff6e8" : "#f5f6fa"} color={needsSerials ? "#8b5a00" : "#5d6782"} />
                        {canEditLines && isStandalone ? <button onClick={() => removeLine(index)}>Remove</button> : null}
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginTop: 12 }}>
                      {!isStandalone ? (
                        <>
                          <MiniMetric label="Ordered" value={Number(line.qty_ordered || 0).toFixed(4)} />
                          <MiniMetric label="Previously received" value={Number(line.qty_previously_received || 0).toFixed(4)} />
                          <MiniMetric label="Remaining (excl. this)" value={Number(line.qty_remaining_receive || 0).toFixed(4)} />
                        </>
                      ) : null}
                      <FieldLabel label="Qty Received (this GRN)">
                        <input
                          type="number"
                          value={line.qty_received ?? ""}
                          disabled={!canEditLines}
                          min="0"
                          step="0.01"
                          onChange={(e) => updateLine(index, { qty_received: e.target.value })}
                          style={inputStyle(!canEditLines)}
                        />
                      </FieldLabel>
                      <FieldLabel label="Location (optional)">
                        <select
                          value={line.location_id ? String(line.location_id) : ""}
                          disabled={!canEditLines}
                          onChange={(e) => updateLine(index, { location_id: e.target.value ? Number(e.target.value) : null })}
                          style={inputStyle(!canEditLines)}
                        >
                          <option value="">No location</option>
                          {locations.map((loc) => (
                            <option key={loc.id} value={String(loc.id)}>
                              {loc.location_code} • {loc.location_name}
                            </option>
                          ))}
                        </select>
                      </FieldLabel>
                    </div>

                    <FieldLabel label="Line remarks (optional)" style={{ marginTop: 12 }}>
                      <input
                        value={line.line_remarks || ""}
                        disabled={!canEditLines}
                        onChange={(e) => updateLine(index, { line_remarks: e.target.value })}
                        placeholder="Challan / packing / notes"
                        style={inputStyle(!canEditLines)}
                      />
                    </FieldLabel>

                    {needsSerials ? (
                      <FieldLabel label="Serial Numbers (one per line)" style={{ marginTop: 12 }}>
                        <textarea
                          value={serialText}
                          disabled={!canEditLines}
                          onChange={(e) => updateSerials(index, e.target.value)}
                          rows={5}
                          style={{ ...textAreaStyle(!canEditLines), fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
                        />
                      </FieldLabel>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No lines yet. Add inward items to start quantity and serial capture.
            </div>
          )}
        </DeskCard>
      </div>
      <ApprovalHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docType="goods_receipt"
        docId={id}
        remarks={approvalRemarks}
        onRemarksChange={setApprovalRemarks}
      />
    </div>
    </>
  );
}
