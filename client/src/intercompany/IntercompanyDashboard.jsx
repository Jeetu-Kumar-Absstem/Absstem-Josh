import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, MiniMetric, NoticeBanner, PageHero, getDeskStatusAppearance } from "../shared/joshUi";

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

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["approved", "posted", "delivered", "dispatched", "closed", "issued", "paid", "confirmed"],
    info: ["ready", "submitted"],
    warning: ["draft", "pending"],
    danger: ["cancelled"],
    fallbackTone: "#f6f7fb",
  });
}

function friendlyError(code) {
  const c = String(code || "");
  if (c === "PO_NEEDS_APPROVAL") return "PO must be approved/closed before creating SO.";
  if (c === "ORDER_NOT_READY_FOR_DISPATCH") return "SO must be confirmed/closed before creating Dispatch.";
  if (c === "ORDER_NOT_READY_FOR_INVOICE") return "SO must be confirmed/closed before creating Invoice.";
  if (c === "DISPATCH_NOT_READY_FOR_GRN") return "Dispatch must be Dispatched/Delivered before creating GRN.";
  if (c === "INTERCOMPANY_VENDOR_MAPPING_MISSING") return "Intercompany vendor mapping is missing.";
  if (c === "INTERCOMPANY_CUSTOMER_MAPPING_MISSING") return "Intercompany customer mapping is missing.";
  if (c === "INTERCOMPANY_NOT_CONFIGURED") return "This document is not marked/configured as intercompany.";
  if (c === "INTERCOMPANY_ACCESS_DENIED") return "You do not have access to the counterparty company.";
  return c || "Request failed.";
}

export default function IntercompanyDashboard({
  onOpenPurchaseOrder,
  onOpenSalesOrder,
  onOpenDispatch,
  onOpenGoodsReceipt,
  onOpenInvoice,
  onOpenPurchaseInvoice,
}) {
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/intercompany-status?limit=200&search=${encodeURIComponent(search || "")}`);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setError(e?.data?.error || "Failed to load intercompany dashboard.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  const grouped = useMemo(() => rows, [rows]);
  const stats = useMemo(() => {
    const total = rows.length;
    const linkedSO = rows.filter((row) => Boolean(row.intercompany_sales_order_id)).length;
    const linkedGRN = rows.filter((row) => Boolean(row.goods_receipt_id)).length;
    const linkedPINV = rows.filter((row) => Boolean(row.purchase_invoice_id)).length;
    return { total, linkedSO, linkedGRN, linkedPINV };
  }, [rows]);

  async function runAction(fn) {
    setActing(true);
    setError("");
    setNotice("");
    try {
      const out = await fn();
      await load();
      return out;
    } finally {
      setActing(false);
    }
  }

  async function createSO(purchaseOrderId) {
    await runAction(async () => {
      const data = await apiFetch(`/purchase-orders/${purchaseOrderId}/intercompany/create-sales-order`, { method: "POST" });
      if (data?.intercompany_sales_order?.id && onOpenSalesOrder) onOpenSalesOrder(data.intercompany_sales_order.id);
      setNotice("Counterparty Sales Order ready.");
    }).catch((e) => {
      setError(friendlyError(e?.data?.error) || "Failed to create Sales Order.");
    });
  }

  async function createDispatch(salesOrderId) {
    await runAction(async () => {
      try {
        const data = await apiFetch(`/dispatches/from-sales-order/${salesOrderId}`, { method: "POST", body: JSON.stringify({}) });
        if (data?.dispatch?.id && onOpenDispatch) onOpenDispatch(data.dispatch.id);
        setNotice("Dispatch created.");
      } catch (e) {
        if (e?.data?.error === "ORDER_NOT_READY" && e?.data?.override_allowed) {
          const detail = e?.data?.detail || "Production readiness is blocking dispatch.";
          const reason = window.prompt(`Dispatch blocked: ${detail}\n\nEnter override reason:`);
          if (reason && reason.trim().length >= 3) {
            const forced = await apiFetch(`/dispatches/from-sales-order/${salesOrderId}`, {
              method: "POST",
              body: JSON.stringify({ force: true, force_reason: reason.trim() }),
            });
            if (forced?.dispatch?.id && onOpenDispatch) onOpenDispatch(forced.dispatch.id);
            setNotice("Dispatch created with override.");
            return;
          }
        }
        throw e;
      }
    }).catch((e) => {
      setError(e?.data?.detail || friendlyError(e?.data?.error) || "Failed to create dispatch.");
    });
  }

  async function createGRN(dispatchId) {
    await runAction(async () => {
      const data = await apiFetch(`/dispatches/${dispatchId}/intercompany/upsert-grn`, { method: "POST" });
      if (data?.goods_receipt_id && onOpenGoodsReceipt) onOpenGoodsReceipt(data.goods_receipt_id);
      setNotice("GRN created/refreshed.");
    }).catch((e) => {
      setError(friendlyError(e?.data?.error) || "Failed to create GRN.");
    });
  }

  async function createInvoice(salesOrderId) {
    await runAction(async () => {
      const data = await apiFetch(`/invoices/from-sales-order/${salesOrderId}`, { method: "POST" });
      if (data?.invoice?.id && onOpenInvoice) onOpenInvoice(data.invoice.id);
      setNotice("Invoice created.");
    }).catch((e) => {
      setError(friendlyError(e?.data?.error) || "Failed to create invoice.");
    });
  }

  async function createPurchaseInvoice(invoiceId) {
    await runAction(async () => {
      const data = await apiFetch(`/invoices/${invoiceId}/intercompany/create-purchase-invoice`, { method: "POST" });
      if (data?.intercompany_purchase_invoice?.id && onOpenPurchaseInvoice) onOpenPurchaseInvoice(data.intercompany_purchase_invoice.id);
      setNotice("Counterparty Purchase Invoice ready.");
    }).catch((e) => {
      setError(friendlyError(e?.data?.error) || "Failed to create purchase invoice.");
    });
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Intercompany Status Desk"
        title="Intercompany Dashboard"
        description="Track the linked chain from buyer PO through seller SO, dispatch, GRN, and dual invoice creation while keeping one-click next actions visible."
        actions={
          <>
            <input
              placeholder="Search doc no..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ height: 38, padding: "0 10px", width: 240, borderRadius: 10, border: "1px solid #d8dfeb" }}
            />
            <button onClick={load} disabled={loading || acting}>{loading ? "Loading..." : "Search"}</button>
          </>
        }
        stats={[
          { label: "Chains In View", value: stats.total, tone: "#143d7a" },
          { label: "With SO", value: stats.linkedSO, tone: "#234a8f" },
          { label: "With GRN", value: stats.linkedGRN, tone: "#0a7a35" },
          { label: "With PINV", value: stats.linkedPINV, tone: "#8b5a00" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Intercompany Chains" subtitle="Each card shows both companies and the next missing operational link">
          {grouped.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {grouped.map((row) => {
                const hasSO = Boolean(row.intercompany_sales_order_id);
                const hasDispatch = Boolean(row.dispatch_id);
                const hasGRN = Boolean(row.goods_receipt_id);
                const hasInv = Boolean(row.customer_invoice_id);
                const hasPINV = Boolean(row.purchase_invoice_id);
                const poOk = ["approved", "closed"].includes(String(row.po_status || "").toLowerCase());
                const soOk = ["confirmed", "closed"].includes(String(row.order_status || "").toLowerCase());
                const dispatchOk = ["dispatched", "delivered"].includes(String(row.dispatch_status || "").toLowerCase());
                const poMeta = statusAppearance(row.po_status);
                const soMeta = statusAppearance(row.order_status);
                const dispatchMeta = statusAppearance(row.dispatch_status);
                const grnMeta = statusAppearance(row.grn_status);
                const invMeta = statusAppearance(row.invoice_status);
                const pinvMeta = statusAppearance(row.purchase_invoice_status);

                return (
                  <div key={row.purchase_order_id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 800 }}>
                          {row.buyer_company_code} → {row.seller_company_code}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.5 }}>
                          {row.buyer_company_name} → {row.seller_company_name}
                        </div>
                      </div>
                      <button onClick={() => onOpenPurchaseOrder && onOpenPurchaseOrder(row.purchase_order_id)} disabled={!onOpenPurchaseOrder}>
                        Open PO
                      </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginTop: 12 }}>
                      <ChainCard
                        title="Purchase Order (Buyer)"
                        number={row.po_number}
                        status={row.po_status}
                        statusMeta={poMeta}
                        metrics={[
                          { label: "Buyer", value: row.buyer_company_code || "—" },
                          { label: "Seller", value: row.seller_company_code || "—" },
                        ]}
                      />

                      <ChainCard
                        title="Sales Order (Seller)"
                        number={row.so_number}
                        status={row.order_status}
                        statusMeta={soMeta}
                        metrics={[
                          { label: "State", value: hasSO ? "Linked" : "Missing" },
                          { label: "Ready", value: poOk ? "PO ready" : "PO blocked" },
                        ]}
                        actions={
                          hasSO ? (
                            <button onClick={() => onOpenSalesOrder && onOpenSalesOrder(row.intercompany_sales_order_id)} disabled={!onOpenSalesOrder}>
                              Open SO
                            </button>
                          ) : (
                            <button onClick={() => createSO(row.purchase_order_id)} disabled={acting || !poOk}>
                              Create SO
                            </button>
                          )
                        }
                        help={!hasSO && !poOk ? "Approve or close PO first." : ""}
                      />

                      <ChainCard
                        title="Dispatch (Seller)"
                        number={row.dispatch_number}
                        status={row.dispatch_status}
                        statusMeta={dispatchMeta}
                        metrics={[
                          { label: "State", value: hasDispatch ? "Linked" : "Missing" },
                          { label: "Gate", value: soOk ? "SO ready" : "SO blocked" },
                        ]}
                        actions={
                          hasDispatch ? (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => onOpenDispatch && onOpenDispatch(row.dispatch_id)} disabled={!onOpenDispatch}>Open Dispatch</button>
                              {!hasGRN ? <button onClick={() => createGRN(row.dispatch_id)} disabled={acting}>Create GRN</button> : null}
                            </div>
                          ) : hasSO ? (
                            <button onClick={() => createDispatch(row.intercompany_sales_order_id)} disabled={acting || !soOk}>Create Dispatch</button>
                          ) : null
                        }
                        help={!hasDispatch && hasSO && !soOk ? "Confirm or close SO first." : !hasSO ? "Create SO first." : ""}
                      />
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginTop: 12 }}>
                      <ChainCard
                        title="GRN (Buyer)"
                        number={row.grn_number}
                        status={row.grn_status}
                        statusMeta={grnMeta}
                        metrics={[
                          { label: "State", value: hasGRN ? "Linked" : "Missing" },
                          { label: "Gate", value: dispatchOk ? "Dispatch ready" : "Dispatch blocked" },
                        ]}
                        actions={
                          hasGRN ? (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => onOpenGoodsReceipt && onOpenGoodsReceipt(row.goods_receipt_id)} disabled={!onOpenGoodsReceipt}>Open GRN</button>
                              <button onClick={() => createGRN(row.dispatch_id)} disabled={acting || !hasDispatch || !dispatchOk}>Refresh GRN</button>
                            </div>
                          ) : hasDispatch ? (
                            <button onClick={() => createGRN(row.dispatch_id)} disabled={acting || !dispatchOk}>Create GRN</button>
                          ) : null
                        }
                        help={!hasGRN && hasDispatch && !dispatchOk ? "Dispatch must be dispatched or delivered." : !hasDispatch ? "Create Dispatch first." : ""}
                      />

                      <ChainCard
                        title="Invoice (Seller)"
                        number={row.invoice_number}
                        status={row.invoice_status}
                        statusMeta={invMeta}
                        metrics={[
                          { label: "State", value: hasInv ? "Linked" : "Missing" },
                          { label: "Gate", value: soOk ? "SO ready" : "SO blocked" },
                        ]}
                        actions={
                          hasInv ? (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => onOpenInvoice && onOpenInvoice(row.customer_invoice_id)} disabled={!onOpenInvoice}>Open Invoice</button>
                              {!hasPINV ? <button onClick={() => createPurchaseInvoice(row.customer_invoice_id)} disabled={acting}>Create PINV</button> : null}
                            </div>
                          ) : hasSO ? (
                            <button onClick={() => createInvoice(row.intercompany_sales_order_id)} disabled={acting || !soOk}>Create Invoice</button>
                          ) : null
                        }
                        help={!hasInv && hasSO && !soOk ? "Confirm or close SO first." : !hasSO ? "Create SO first." : ""}
                      />

                      <ChainCard
                        title="Purchase Invoice (Buyer)"
                        number={row.purchase_invoice_number}
                        status={row.purchase_invoice_status}
                        statusMeta={pinvMeta}
                        metrics={[
                          { label: "State", value: hasPINV ? "Linked" : "Missing" },
                          { label: "Source", value: hasInv ? "Seller invoice ready" : "Waiting seller invoice" },
                        ]}
                        actions={
                          hasPINV ? (
                            <button onClick={() => onOpenPurchaseInvoice && onOpenPurchaseInvoice(row.purchase_invoice_id)} disabled={!onOpenPurchaseInvoice}>
                              Open PINV
                            </button>
                          ) : null
                        }
                        help={!hasPINV && !hasInv ? "Create seller invoice first." : !hasPINV ? "Use Create PINV from seller invoice." : ""}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !loading ? (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No intercompany documents found.
            </div>
          ) : (
            <div>Loading intercompany dashboard…</div>
          )}
        </DeskCard>
      </div>
    </div>
  );
}

function ChainCard({ title, number, status, statusMeta, metrics, actions, help }) {
  return (
    <div style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 12, background: "#fcfdff", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700 }}>{title}</div>
          <div style={{ marginTop: 6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 13 }}>
            {number || "Not created"}
          </div>
        </div>
        <DeskChip label={String(status || "pending").toUpperCase()} tone={statusMeta.tone} color={statusMeta.color} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        {(metrics || []).map((metric) => (
          <MiniMetric key={`${title}-${metric.label}`} label={metric.label} value={metric.value} />
        ))}
      </div>
      {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div> : null}
      {help ? <div style={{ fontSize: 12, opacity: 0.7 }}>{help}</div> : null}
    </div>
  );
}
