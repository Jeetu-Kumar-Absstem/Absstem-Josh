import { useEffect, useMemo, useState } from "react";
import ApprovalHistoryDrawer from "../shared/ApprovalHistoryDrawer";
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
      const unit = Number(line.unit_price_invoice || 0);
      if (!Number.isFinite(qty) || !Number.isFinite(unit)) return sum;
      return sum + qty * unit;
    }, 0)
  );
  const taxTotal = money(
    lines.reduce((sum, line) => {
      const qty = Number(line.qty || 0);
      const unit = Number(line.unit_price_invoice || 0);
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
    unit_price_invoice: 0,
    gst_pct: 0,
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

export default function PurchaseInvoices({ openPurchaseInvoiceId, launch, onConsumeLaunch, onOpenApprovalDesk, onOpenThreeWayMatch, onOpenVendorPayments }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [controlSummary, setControlSummary] = useState(null);
  const [controlRows, setControlRows] = useState([]);
  const [controlBucket, setControlBucket] = useState("draft");
  const [controlQuery, setControlQuery] = useState("");
  const [controlLoading, setControlLoading] = useState(false);
  const [controlError, setControlError] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], currencies: [], purchase_orders: [] });
  const [createMode, setCreateMode] = useState("from_po");
  const [createPoId, setCreatePoId] = useState("");
  const [createVendorId, setCreateVendorId] = useState("");
  const [createCurrencyId, setCreateCurrencyId] = useState("");
  const [creating, setCreating] = useState(false);

  const invoiceStats = useMemo(() => {
    const total = items.length;
    const draft = items.filter((row) => String(row.invoice_status || "").toLowerCase() === "draft").length;
    const submitted = items.filter((row) => String(row.invoice_status || "").toLowerCase() === "submitted").length;
    const posted = items.filter((row) => ["approved", "posted"].includes(String(row.invoice_status || "").toLowerCase())).length;
    return { total, draft, submitted, posted };
  }, [items]);

  async function loadBootstrap() {
    const data = await apiFetch("/purchase-invoices/bootstrap");
    setBootstrap({
      vendors: Array.isArray(data?.vendors) ? data.vendors : [],
      currencies: Array.isArray(data?.currencies) ? data.currencies : [],
      purchase_orders: Array.isArray(data?.purchase_orders) ? data.purchase_orders : [],
    });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/purchase-invoices");
      setItems(Array.isArray(data?.purchase_invoices) ? data.purchase_invoices : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load purchase invoices."));
    } finally {
      setLoading(false);
    }
  }

  async function loadControlSummary() {
    try {
      const data = await apiFetch("/purchase-invoices/control-summary");
      setControlSummary(data?.summary || null);
    } catch (e) {
      setControlSummary(null);
      setControlError(getApiErrorMessage(e, "Failed to load AP invoice control summary."));
    }
  }

  async function loadControlQueue({ bucket = controlBucket, q = controlQuery } = {}) {
    setControlLoading(true);
    setControlError("");
    try {
      const params = new URLSearchParams();
      if (bucket) params.set("bucket", bucket);
      if (q) params.set("q", q);
      const query = params.toString();
      const data = await apiFetch(`/purchase-invoices/control-queue${query ? `?${query}` : ""}`);
      setControlRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setControlRows([]);
      setControlError(getApiErrorMessage(e, "Failed to load AP invoice control queue."));
    } finally {
      setControlLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
      loadControlSummary().catch(() => {});
      loadControlQueue().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadControlQueue({ bucket: controlBucket }).catch(() => {});
  }, [controlBucket]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextBucket = typeof launch.control_bucket === "string" ? launch.control_bucket : controlBucket;
    const nextQuery = typeof launch.control_q === "string" ? launch.control_q : "";
    setControlBucket(nextBucket);
    setControlQuery(nextQuery);
    if (view.type !== "list") setView({ type: "list" });
    loadControlSummary().catch(() => {});
    loadControlQueue({ bucket: nextBucket, q: nextQuery }).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    const id = Number(openPurchaseInvoiceId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
  }, [openPurchaseInvoiceId]);

  useEffect(() => {
    if (!bootstrap.currencies.length) return;
    if (createCurrencyId) return;
    const inr = bootstrap.currencies.find((c) => c.currency_code === "INR");
    if (inr?.id) setCreateCurrencyId(String(inr.id));
  }, [bootstrap.currencies, createCurrencyId]);

  async function createInvoice() {
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
        const data = await apiFetch(`/purchase-invoices/from-po/${poId}`, { method: "POST" });
        const id = data?.purchase_invoice?.id;
        if (id) setView({ type: "detail", id });
        setNotice("Purchase invoice created from PO.");
        loadControlSummary().catch(() => {});
        loadControlQueue().catch(() => {});
        return;
      }

      const vendorId = Number(createVendorId);
      const currencyId = Number(createCurrencyId);
      if (!Number.isFinite(vendorId) || vendorId <= 0) {
        setError("Select a vendor first.");
        return;
      }

      const data = await apiFetch("/purchase-invoices", {
        method: "POST",
        body: JSON.stringify({
          vendor_id: vendorId,
          invoice_currency_id: Number.isFinite(currencyId) && currencyId > 0 ? currencyId : undefined,
        }),
      });
      const id = data?.purchase_invoice?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Purchase invoice created.");
      loadControlSummary().catch(() => {});
      loadControlQueue().catch(() => {});
    } catch (e) {
      if (e?.data?.error === "NO_LINES") setError("This PO has no lines.");
      else if (e?.data?.error === "INVALID_VENDOR" || e?.data?.error === "VENDOR_NOT_FOUND") setError("Select a valid vendor.");
      else setError("Failed to create purchase invoice.");
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return <PurchaseInvoiceDetail id={view.id} onBack={() => setView({ type: "list" })} />;
  }

  const heroStats = [
    { label: "Draft", value: controlSummary?.draft_count ?? invoiceStats.draft, tone: "#8b5a00" },
    { label: "Submitted", value: controlSummary?.submitted_count ?? invoiceStats.submitted, tone: "#234a8f" },
    { label: "Match Blocked", value: controlSummary?.match_blocked_count ?? 0, tone: "#9f2042" },
    { label: "Payment Ready", value: controlSummary?.payment_ready_count ?? invoiceStats.posted, tone: "#0a7a35" },
  ];

  const controlCards = [
    { key: "draft", label: "Draft invoices", count: Number(controlSummary?.draft_count || 0), amount: 0, tone: "#8b5a00" },
    { key: "submitted", label: "Submitted for approval", count: Number(controlSummary?.submitted_count || 0), amount: 0, tone: "#234a8f" },
    { key: "approval_aged", label: "Approval-aged submissions", count: Number(controlSummary?.approval_aged_count || 0), amount: 0, tone: "#58627a" },
    { key: "manual", label: "Manual / no PO invoices", count: Number(controlSummary?.manual_count || 0), amount: 0, tone: "#7b4ad8" },
    { key: "match_blocked", label: "Posted but match blocked", count: Number(controlSummary?.match_blocked_count || 0), amount: Number(controlSummary?.match_blocked_amount || 0), tone: "#9f2042" },
    { key: "overdue_unpaid", label: "Overdue unpaid invoices", count: Number(controlSummary?.overdue_unpaid_count || 0), amount: Number(controlSummary?.overdue_unpaid_amount || 0), tone: "#8b5a00" },
    { key: "payment_ready", label: "Posted and payment ready", count: Number(controlSummary?.payment_ready_count || 0), amount: Number(controlSummary?.payment_ready_amount || 0), tone: "#0a7a35" },
  ];

  const invoiceFocusActions = [
    {
      key: "draft",
      label: "Clear draft buildup",
      note: `${Number(controlSummary?.draft_count || 0)} drafts still need document hygiene before approval flow starts.`,
      onClick: () => setControlBucket("draft"),
      tone: "#8b5a00",
    },
    {
      key: "submitted",
      label: "Push approvals",
      note: `${Number(controlSummary?.submitted_count || 0)} submissions are waiting on approval movement.`,
      onClick: () => setControlBucket("submitted"),
      tone: "#234a8f",
    },
    {
      key: "match_blocked",
      label: "Resolve 3-way blocks",
      note: `${Number(controlSummary?.match_blocked_count || 0)} posted invoices are blocked by purchasing mismatch.`,
      onClick: () => setControlBucket("match_blocked"),
      tone: "#9f2042",
    },
    {
      key: "payment_ready",
      label: "Hand off to payables",
      note: `${Number(controlSummary?.payment_ready_count || 0)} invoices are clean and ready for settlement control.`,
      onClick: () => setControlBucket("payment_ready"),
      tone: "#0a7a35",
    },
  ];

  return (
    <div style={{ maxWidth: 1460 }}>
      <PageHero
        eyebrow="Purchase Billing Desk"
        title="Purchase Invoices"
        description="Control AP upstream from payment: isolate draft and approval bottlenecks, surface manual invoice discipline, separate 3-way blocked posted invoices, and hand payment-ready AP into the payables desk."
        actions={<button onClick={() => {
          loadList();
          loadControlSummary().catch(() => {});
          loadControlQueue().catch(() => {});
        }} disabled={loading || controlLoading}>{loading || controlLoading ? "Refreshing..." : "Refresh Queue"}</button>}
        stats={heroStats}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16 }}>
        <DeskCard title="AP Runbook" subtitle="Choose the control lane first so the invoice team works the correct backlog instead of scanning all buckets equally.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
            {invoiceFocusActions.map((action) => (
              <button key={action.label} onClick={action.onClick} style={commandButtonStyle(controlBucket === action.key)}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>{action.label}</div>
                <div style={{ fontSize: 12, marginTop: 6, color: action.tone }}>{action.note}</div>
              </button>
            ))}
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="AP Invoice Control Desk" subtitle="Work invoice exceptions before they spill into approvals, 3-way blocks, or payables follow-through">
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              {controlCards.map((card) => (
                <button key={card.key} onClick={() => setControlBucket(card.key)} style={commandButtonStyle(controlBucket === card.key)}>
                  <div style={{ fontSize: 12, opacity: 0.68 }}>{card.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: card.tone }}>{card.count}</div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>{card.amount > 0 ? fmtMoney(card.amount) : "Open queue"}</div>
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={controlQuery}
                onChange={(e) => setControlQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadControlQueue({ q: controlQuery }).catch(() => {});
                }}
                placeholder="Search invoice, vendor, PO, or vendor ref"
                style={{ ...inputStyle(), minWidth: 260, flex: "1 1 260px" }}
              />
              <button onClick={() => loadControlQueue({ q: controlQuery })} disabled={controlLoading}>
                {controlLoading ? "Refreshing..." : "Refresh Control Queue"}
              </button>
              <div style={{ fontSize: 12, color: "#58627a" }}>
                Ready for payables: {fmtMoney(controlSummary?.payment_ready_amount || 0)}
              </div>
            </div>

            <NoticeBanner tone="error" message={controlError} />

            {controlLoading ? (
              <div>Loading AP invoice controls…</div>
            ) : controlRows.length ? (
              <div style={{ display: "grid", gap: 12 }}>
                {controlRows.map((row) => {
                  const appearance = statusAppearance(row.invoice_status);
                  const canOpenMatch = Number.isFinite(Number(row.purchase_order_id)) && Number(row.purchase_order_id) > 0;
                  const activePayments = Number(row.active_payment_count || 0);
                  return (
                    <div
                      key={row.id}
                      style={{
                        border: "1px solid #e7ebf3",
                        borderRadius: 18,
                        padding: 14,
                        background: "#ffffff",
                        boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                        display: "grid",
                        gap: 12,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>
                            {fmtDate(row.invoice_date)}
                          </div>
                          <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{row.purchase_invoice_number}</div>
                          <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                            {row.vendor_name} • {row.po_number || "Manual invoice"}{row.vendor_invoice_no ? ` • Vendor ref ${row.vendor_invoice_no}` : ""}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          <DeskChip label={String(row.invoice_status || "draft").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                          {row.is_match_blocked ? <DeskChip label="3-WAY BLOCK" tone="#fff2f3" color="#9f2042" /> : null}
                          {activePayments ? <DeskChip label={`PAYMENT ${activePayments}`} tone="#f2fbf6" color="#24593b" /> : null}
                        </div>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                        <MiniMetric label="Source" value={row.po_number || "Manual"} />
                        <MiniMetric label="Currency" value={row.invoice_currency_code || "—"} />
                        <MiniMetric label="Grand Total" value={fmtMoney(row.grand_total_invoice, row.invoice_currency_code)} />
                        <MiniMetric label="Outstanding" value={fmtMoney(row.outstanding_invoice, row.invoice_currency_code)} />
                        <MiniMetric label="Age" value={`${Number(row.ageing_days || 0)}d`} />
                        <MiniMetric label="Approval" value={`${Number(row.current_approval_level || 0)} / ${Number(row.required_approval_level || 0)}`} />
                      </div>

                      <div style={{ fontSize: 12, color: "#58627a" }}>
                        Created by {row.created_by_name || "—"} • Submitted {row.submitted_by_name || "—"} {row.submitted_at ? `on ${fmtDate(row.submitted_at)}` : ""} • Approved {row.approved_by_name || "—"} {row.approved_at ? `on ${fmtDate(row.approved_at)}` : ""}
                      </div>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button onClick={() => setView({ type: "detail", id: row.id })}>Open Invoice</button>
                        {typeof onOpenApprovalDesk === "function" && row.invoice_status === "submitted" ? (
                          <button onClick={() => onOpenApprovalDesk({ doc_type: "purchase_invoice" })}>Open Approval Desk</button>
                        ) : null}
                        {typeof onOpenThreeWayMatch === "function" && canOpenMatch ? (
                          <button onClick={() => onOpenThreeWayMatch({ po_id: row.purchase_order_id })}>Open 3-way Match</button>
                        ) : null}
                        {typeof onOpenVendorPayments === "function" && row.invoice_status === "posted" ? (
                          <button
                            onClick={() =>
                              onOpenVendorPayments({
                                command_bucket: row.is_match_blocked
                                  ? "blocked_match"
                                  : Number(row.ageing_days || 0) > 30
                                    ? "overdue"
                                    : "payment_run_ready",
                                command_q: row.vendor_name || "",
                              })
                            }
                          >
                            Open Payables Desk
                          </button>
                        ) : null}
                      </div>

                      {row.invoice_status === "draft" ? (
                        <div style={{ padding: 12, borderRadius: 14, background: "#fff8ef", border: "1px solid #fde3b5", fontSize: 12, color: "#7c4b00" }}>
                          Keep draft control tight here before the invoice enters approval and downstream AP ageing.
                        </div>
                      ) : row.invoice_status === "submitted" ? (
                        <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, color: "#58627a" }}>
                          Submitted invoice is waiting on approval progression before it can become a posted AP obligation.
                        </div>
                      ) : row.is_match_blocked ? (
                        <div style={{ padding: 12, borderRadius: 14, background: "#fff7f7", border: "1px solid #ffd8d8", fontSize: 12, color: "#8c2d3d" }}>
                          This posted invoice is blocked by 3-way quantity mismatch. Resolve purchasing flow before settlement momentum continues.
                        </div>
                      ) : activePayments > 0 ? (
                        <div style={{ padding: 12, borderRadius: 14, background: "#f2fbf6", border: "1px solid #d9f1e3", fontSize: 12, color: "#24593b" }}>
                          A payment is already in flight for this vendor and currency bucket. Use the payables desk for settlement follow-through.
                        </div>
                      ) : Number(row.outstanding_invoice || 0) > 0 ? (
                        <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, color: "#58627a" }}>
                          This invoice is clean from a match perspective and is part of the payable exposure that can move into settlement control.
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                No AP invoice rows in this control bucket right now.
              </div>
            )}
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(320px, 430px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard
          title="Launch Purchase Invoice"
          subtitle="Use PO-backed billing when quantities are already controlled upstream or open a manual invoice desk for direct vendor billing."
          actions={<DeskChip label={createMode === "from_po" ? "FROM PO" : "MANUAL"} tone="#eef4ff" color="#234a8f" />}
        >
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setCreateMode("from_po")} style={{ opacity: createMode === "from_po" ? 1 : 0.72 }}>
                From PO
              </button>
              <button type="button" onClick={() => setCreateMode("manual")} style={{ opacity: createMode === "manual" ? 1 : 0.72 }}>
                Manual
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
                <button onClick={createInvoice} disabled={creating}>{creating ? "Creating..." : "Create From PO"}</button>
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
                <FieldLabel label="Currency">
                  <select value={createCurrencyId} onChange={(e) => setCreateCurrencyId(e.target.value)} style={inputStyle()}>
                    <option value="">Select currency</option>
                    {bootstrap.currencies.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.currency_code}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                <button onClick={createInvoice} disabled={creating}>{creating ? "Creating..." : "Create Manual Invoice"}</button>
              </>
            )}

            <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, lineHeight: 1.7, color: "#58627a" }}>
              {createMode === "from_po"
                ? "PO-backed creation preserves vendor, quantities, and purchasing lineage for finance approval."
                : "Manual invoices stay available for vendor bills that do not need a PO conversion path."}
            </div>
          </div>
        </DeskCard>

        <DeskCard title="Invoice Queue" subtitle="Queue-first billing review without forcing users into a wide register">
          <div style={{ display: "grid", gap: 12, maxHeight: 1040, overflowY: "auto", paddingRight: 4 }}>
            {loading ? (
              <div>Loading purchase invoices…</div>
            ) : items.length ? (
              items.map((item) => {
                const appearance = statusAppearance(item.invoice_status);
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
                          {fmtDate(item.invoice_date)}
                        </div>
                        <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                          {item.purchase_invoice_number}
                        </div>
                      </div>
                      <DeskChip label={String(item.invoice_status || "draft").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                    </div>

                    <div style={{ fontSize: 14, fontWeight: 700 }}>{item.vendor_name || "No vendor"}</div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Source PO" value={item.po_number || "Manual"} />
                      <MiniMetric label="Currency" value={item.invoice_currency_code || "—"} />
                      <MiniMetric label="Total" value={fmtMoney(item.grand_total_invoice, item.invoice_currency_code)} />
                    </div>
                  </button>
                );
              })
            ) : (
              <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                No purchase invoices yet. Create the first one from a PO or open a manual vendor bill.
              </div>
            )}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}

function PurchaseInvoiceDetail({ id, onBack }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [approvalRemarks, setApprovalRemarks] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], currencies: [] });
  const [invoice, setInvoice] = useState(null);
  const [lines, setLines] = useState([]);
  const [vendorId, setVendorId] = useState("");
  const [status, setStatus] = useState("draft");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [vendorInvoiceNo, setVendorInvoiceNo] = useState("");
  const [remarks, setRemarks] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);

  const totals = useMemo(() => calcTotals(lines), [lines]);
  const canEditLines = (invoice?.invoice_status || "draft") === "draft";

  useEffect(() => {
    setLoading(true);
    setError("");
    setNotice("");
    Promise.all([apiFetch("/purchase-invoices/bootstrap"), apiFetch(`/purchase-invoices/${id}`)])
      .then(([boot, detail]) => {
        setBootstrap({
          vendors: Array.isArray(boot?.vendors) ? boot.vendors : [],
          currencies: Array.isArray(boot?.currencies) ? boot.currencies : [],
        });
        const header = detail?.purchase_invoice || null;
        setInvoice(header);
        setLines(Array.isArray(detail?.lines) ? detail.lines.map((l) => ({ ...l })) : []);
        setVendorId(header?.vendor_id ? String(header.vendor_id) : "");
        setStatus(header?.invoice_status || "draft");
        setInvoiceDate(toIsoDate(header?.invoice_date));
        setVendorInvoiceNo(header?.vendor_invoice_no || "");
        setRemarks(header?.remarks || "");
      })
      .catch((e) => setError(e?.data?.error || "Failed to load purchase invoice."))
      .finally(() => setLoading(false));
  }, [id]);

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
      const data = await apiFetch(`/purchase-invoices/product-lookup?q=${encodeURIComponent(q)}`);
      setSearchResults(Array.isArray(data?.products) ? data.products : []);
    } catch (e) {
      setError("Product lookup failed.");
    } finally {
      setSearching(false);
    }
  }

  function addProduct(product) {
    const unit = Number(product?.last_purchase_price ?? product?.list_price ?? 0);
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
        unit_price_invoice: Number.isFinite(unit) ? unit : 0,
      },
    ]);
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        vendor_id: vendorId ? Number(vendorId) : undefined,
        invoice_status: status,
        invoice_date: invoiceDate || undefined,
        vendor_invoice_no: vendorInvoiceNo || null,
        remarks: remarks || null,
        approval_remarks: approvalRemarks || null,
      };

      if (canEditLines) {
        payload.lines = lines.map((line) => ({
          id: line.id,
          qty: Number(line.qty || 0),
          unit_price_invoice: Number(line.unit_price_invoice ?? line.unit_price_base ?? 0),
          gst_pct: Number(line.gst_pct || 0),
        }));
      }

      const data = await apiFetch(`/purchase-invoices/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      const header = data?.purchase_invoice || invoice;
      setInvoice(header);
      setLines(Array.isArray(data?.lines) ? data.lines.map((l) => ({ ...l })) : lines);
      setVendorId(header?.vendor_id ? String(header.vendor_id) : vendorId);
      setStatus(header?.invoice_status || status);
      setInvoiceDate(toIsoDate(header?.invoice_date));
      setVendorInvoiceNo(header?.vendor_invoice_no || "");
      setRemarks(header?.remarks || "");
      setNotice("Purchase invoice saved.");
      setApprovalRemarks("");
    } catch (e) {
      if (e?.data?.error === "INVOICE_NOT_EDITABLE") setError("Only draft invoices can be edited.");
      else if (e?.data?.error === "INVALID_INVOICE_QTY") setError("Qty must be greater than 0.");
      else if (e?.data?.error === "INVALID_PRICE") setError("Check unit price and GST %.");
      else if (e?.data?.error === "INVALID_VENDOR" || e?.data?.error === "VENDOR_NOT_FOUND") setError("Select a valid vendor.");
      else setError("Failed to save purchase invoice.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div>Loading purchase invoice…</div>;

  if (!invoice) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Purchase invoice not found."}</div>
      </div>
    );
  }

  const currencyCode =
    bootstrap.currencies.find((c) => String(c.id) === String(invoice.invoice_currency_id))?.currency_code ||
    invoice.invoice_currency_code ||
    "";

  const statusMeta = statusAppearance(status);

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Active Billing Desk"
        title={invoice.purchase_invoice_number}
        description={`${invoice.vendor_name || "Vendor pending"}${invoice.po_number ? ` • Source ${invoice.po_number}` : " • Manual invoice"} • ${canEditLines ? "Draft invoice remains editable." : "Document is in controlled mode after draft."}`}
        actions={
          <>
            <button onClick={onBack}>Back</button>
            <button onClick={() => setHistoryOpen(true)}>History / Remarks</button>
            <button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
          </>
        }
        stats={[
          { label: "Status", value: String(status || "draft").toUpperCase(), tone: statusMeta.color },
          { label: "Lines", value: lines.length, tone: "#143d7a" },
          { label: "Subtotal", value: fmtMoney(totals.subtotal, currencyCode), tone: "#234a8f" },
          { label: "Grand Total", value: fmtMoney(totals.grandTotal, currencyCode), tone: "#0a7a35" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(320px, 0.8fr)", gap: 16, alignItems: "start" }}>
        <DeskCard
          title="Invoice Snapshot"
          subtitle="Finance controls stay compact while the item editor uses a more readable card layout"
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

            <FieldLabel label="Invoice Date">
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} style={inputStyle()} />
            </FieldLabel>

            <FieldLabel label="Vendor Invoice No">
              <input value={vendorInvoiceNo} onChange={(e) => setVendorInvoiceNo(e.target.value)} style={inputStyle()} />
            </FieldLabel>
          </div>

          <FieldLabel label="Remarks" style={{ marginTop: 12 }}>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={4} style={textAreaStyle()} />
          </FieldLabel>
        </DeskCard>

        <DeskCard title="Totals" subtitle="Preview values update locally and the server stays authoritative after save">
          <div style={{ display: "grid", gap: 10 }}>
            <MiniMetric label="Subtotal" value={fmtMoney(totals.subtotal, currencyCode)} />
            <MiniMetric label="GST" value={fmtMoney(totals.taxTotal, currencyCode)} />
            <MiniMetric label="Grand Total" value={fmtMoney(totals.grandTotal, currencyCode)} />
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Add Items" subtitle="Search supplier items or add a fallback manual line">
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
          title="Invoice Lines"
          subtitle={canEditLines ? "Card editor avoids the cramped operator table." : "Read-only card view after draft."}
          actions={<DeskChip label={canEditLines ? "EDITABLE" : "READ ONLY"} tone={canEditLines ? "#eef4ff" : "#f5f6fa"} color={canEditLines ? "#234a8f" : "#5d6782"} />}
        >
          {lines.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {lines.map((line, index) => {
                const qtyValue = Number(line.qty || 0);
                const unit = Number(line.unit_price_invoice ?? line.unit_price_base ?? 0);
                const amount = money((Number.isFinite(qtyValue) ? qtyValue : 0) * (Number.isFinite(unit) ? unit : 0));
                const label = line.item_code || line.item_name || "—";
                const desc = line.product_group_name || line.item_name || line.line_description || "—";
                return (
                  <div key={`${line.id || "new"}-${index}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#fcfdff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Line {index + 1}</div>
                        <div style={{ fontWeight: 800, marginTop: 4 }}>{label}</div>
                        <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4 }}>{desc}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <DeskChip label={`GST ${Number(line.gst_pct || 0)}%`} tone="#fff6e8" color="#8b5a00" />
                        <DeskChip label={fmtMoney(amount, currencyCode)} tone="#eef4ff" color="#234a8f" />
                        {canEditLines ? <button onClick={() => removeLine(index)}>Remove</button> : null}
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12 }}>
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
                          value={line.unit_price_invoice ?? line.unit_price_base ?? ""}
                          disabled={!canEditLines}
                          min="0"
                          step="0.01"
                          onChange={(e) => updateLine(index, { unit_price_invoice: e.target.value })}
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
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No lines yet. Search an item or add a manual line to start billing.
            </div>
          )}
        </DeskCard>
      </div>
      <ApprovalHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docType="purchase_invoice"
        docId={id}
        remarks={approvalRemarks}
        onRemarksChange={setApprovalRemarks}
      />
    </div>
  );
}
