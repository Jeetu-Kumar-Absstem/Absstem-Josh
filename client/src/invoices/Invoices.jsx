import { useEffect, useMemo, useRef, useState } from "react";
import SlideOverDrawer from "../components/SlideOverDrawer";
import BlockerRibbon from "../shared/BlockerRibbon";
import { DeskCard, DeskChip, DeskStat, EmptyState, MiniMetric, getDeskStatusAppearance, toast, useSubmitLock } from "../shared/joshUi";
import { ListPager, useDeskHotkeys } from "../shared/listScale";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    cache: "no-store",
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

export default function Invoices({ openInvoiceId, launch, onConsumeLaunch, onOpenSalesOrder, onOpenReceipt, onOpenDispatch, activeCompanyId = null }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [listQuery, setListQuery] = useState("");
  const [listStatus, setListStatus] = useState("");
  const [listBucket, setListBucket] = useState("");
  const [listSource, setListSource] = useState("");
  const [listCustomerId, setListCustomerId] = useState("");
  const [listCustomerName, setListCustomerName] = useState("");
  const [listPage, setListPage] = useState(1);
  const [listMeta, setListMeta] = useState(null);
  const [selectedListId, setSelectedListId] = useState(null);
  const searchInputRef = useRef(null);
  const PAGE_SIZE = 50;

  const invoiceStats = useMemo(() => {
    const statusCounts = listMeta?.status_counts && typeof listMeta.status_counts === "object" ? listMeta.status_counts : null;
    const sourceCounts = listMeta?.source_counts && typeof listMeta.source_counts === "object" ? listMeta.source_counts : null;
    const countStatus = (status) =>
      statusCounts
        ? Number(statusCounts[status] || 0)
        : items.filter((item) => String(item.invoice_status || "").toLowerCase() === status).length;
    return {
      total: items.length,
      draft: countStatus("draft"),
      issued: countStatus("issued"),
      paid: countStatus("paid"),
      tallyImport: sourceCounts
        ? Number(sourceCounts.tally_import || 0)
        : items.filter((item) => String(item.invoice_source || "").toLowerCase() === "tally_import").length,
      fromServer: Boolean(statusCounts),
    };
  }, [items, listMeta]);

  async function loadList(overrides = {}) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : listQuery;
      const status = overrides.status !== undefined ? overrides.status : listStatus;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : listBucket;
      const source = overrides.source !== undefined ? overrides.source : listSource;
      const customerId = overrides.customer_id !== undefined ? overrides.customer_id : listCustomerId;
      const page = overrides.page !== undefined ? overrides.page : listPage;
      const offset = Math.max(0, (Number(page) || 1) - 1) * PAGE_SIZE;
      if (qText) params.set("q", qText);
      if (status) params.set("status", status);
      if (bucket) params.set("bucket", bucket);
      if (source) params.set("source", source);
      if (customerId) params.set("customer_id", customerId);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      const path = `/invoices${params.toString() ? `?${params.toString()}` : ""}`;
      const data = await apiFetch(path);
      if (!data || typeof data !== "object") {
        setItems([]);
        setListMeta(null);
        setError("Unexpected response from invoices API. Try a hard refresh (Ctrl+Shift+R).");
        return;
      }
      setItems(Array.isArray(data.invoices) ? data.invoices : []);
      setListMeta(data.list || null);
      if (overrides.page !== undefined) setListPage(Number(overrides.page) || 1);
    } catch (e) {
      const detail = e?.data?.detail ? `: ${e.data.detail}` : "";
      setError(`${e?.data?.error || "Failed to load invoices."}${detail}`);
      setListMeta(null);
    } finally {
      setLoading(false);
    }
  }

  useDeskHotkeys({
    enabled: view.type === "list",
    searchInputRef,
    onFocusSearch: () => searchInputRef.current?.focus(),
    onOpenSelected: () => {
      if (selectedListId) setView({ type: "detail", id: selectedListId });
    },
  });

  function clearAllFilters() {
    setListQuery("");
    setListStatus("");
    setListBucket("");
    setListSource("");
    setListCustomerId("");
    setListCustomerName("");
    setListPage(1);
    loadList({ q: "", status: "", bucket: "", source: "", customer_id: "", page: 1 }).catch(() => {});
  }

  const activeFilters = useMemo(() => {
    const parts = [];
    if (listQuery.trim()) parts.push(`Search: "${listQuery.trim()}"`);
    if (listStatus) parts.push(`Status: ${listStatus}`);
    if (listBucket) parts.push(`Bucket: ${listBucket.replace(/_/g, " ")}`);
    if (listSource) parts.push(`Source: ${listSource === "tally_import" ? "Tally Import" : "Josh ERP"}`);
    if (listCustomerId) parts.push(`Customer: ${listCustomerName || listCustomerId}`);
    return parts;
  }, [listQuery, listStatus, listBucket, listSource, listCustomerId, listCustomerName]);

  useEffect(() => {
    if (view.type === "list") loadList();
  }, [view.type, activeCompanyId]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const fromSalesOrderId = Number(launch.from_sales_order_id || 0);
    if (Number.isFinite(fromSalesOrderId) && fromSalesOrderId > 0) {
      if (typeof onConsumeLaunch === "function") onConsumeLaunch();
      (async () => {
        setLoading(true);
        setError("");
        setNotice("");
        try {
          const data = await apiFetch(`/invoices/from-sales-order/${fromSalesOrderId}`, {
            method: "POST",
            body: JSON.stringify({}),
          });
          const invoiceId = Number(data?.invoice?.id || data?.id || 0);
          if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
            setError("Invoice was created but no id was returned.");
            return;
          }
          setNotice(`Invoice created from sales order #${fromSalesOrderId}.`);
          setView({ type: "detail", id: invoiceId });
        } catch (e) {
          const detail = e?.data?.detail || e?.data?.error || e?.message || "Create invoice failed.";
          setError(String(detail));
        } finally {
          setLoading(false);
        }
      })().catch(() => {});
      return;
    }
    const nextQuery = typeof launch.q === "string" ? launch.q : "";
    const nextStatus = typeof launch.status === "string" ? launch.status : "";
    const nextBucket = typeof launch.bucket === "string" ? launch.bucket : "";
    const nextCustomerId = launch.customer_id ? String(launch.customer_id) : "";
    const nextCustomerName = typeof launch.customer_name === "string" ? launch.customer_name : "";
    setListQuery(nextQuery);
    setListStatus(nextStatus);
    setListBucket(nextBucket);
    setListCustomerId(nextCustomerId);
    setListCustomerName(nextCustomerName);
    setListPage(1);
    if (view.type !== "list") setView({ type: "list" });
    loadList({ q: nextQuery, status: nextStatus, bucket: nextBucket, customer_id: nextCustomerId, page: 1 }).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    const id = Number(openInvoiceId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
  }, [openInvoiceId]);

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
              Invoice Command Desk
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>Invoices</h2>
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth: 760, lineHeight: 1.7 }}>
              Track billing, payment readiness, and intercompany purchase-invoice handoff from a cleaner commercial desk.
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
              placeholder="Search invoice / customer / SO / Cust PO / SAP code"
              style={{ minWidth: 240 }}
            />
            {listCustomerId ? (
              <button
                type="button"
                onClick={() => {
                  setListCustomerId("");
                  setListCustomerName("");
                  setListPage(1);
                  loadList({ customer_id: "", page: 1 }).catch(() => {});
                }}
                style={{
                  borderRadius: 999,
                  padding: "8px 12px",
                  border: "1px solid #dfe5ef",
                  background: "#fff",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                Customer: {listCustomerName || listCustomerId} ×
              </button>
            ) : null}
            <select
              value={listStatus}
              onChange={(e) => {
                setListStatus(e.target.value);
                setListPage(1);
              }}
            >
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="issued">Issued</option>
              <option value="paid">Paid</option>
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
              <option value="outstanding">Outstanding</option>
              <option value="overdue">Overdue</option>
              <option value="post_dispatch_outstanding">Dispatch done, cash pending</option>
              <option value="ageing_0_30">Ageing 0-30</option>
              <option value="ageing_31_60">Ageing 31-60</option>
              <option value="ageing_61_90">Ageing 61-90</option>
              <option value="ageing_90_plus">Ageing 90+</option>
            </select>
            <select
              value={listSource}
              onChange={(e) => {
                setListSource(e.target.value);
                setListPage(1);
              }}
            >
              <option value="">All sources</option>
              <option value="erp">Josh ERP</option>
              <option value="tally_import">Tally Import</option>
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
            {activeFilters.length ? (
              <button type="button" onClick={clearAllFilters} disabled={loading} style={{ borderColor: "#f59e0b", color: "#92400e" }}>
                Clear filters
              </button>
            ) : null}
          </div>
        </div>

        {activeFilters.length ? (
          <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 14, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 13 }}>
            Active filters: {activeFilters.join(" · ")}. Tally imports have no sales order, so bucket filters like “Dispatch done, cash pending” hide them.
          </div>
        ) : null}

        <div className="desk-metric-grid" style={{ marginTop: 18 }}>
          <DeskStat label="Invoices In View" value={listMeta?.total_count ?? invoiceStats.total} tone="#143d7a" />
          <DeskStat label="Draft" value={invoiceStats.draft} tone="#8b5a00" />
          <DeskStat label="Issued" value={invoiceStats.issued} tone="#234a8f" />
          <DeskStat label="Paid" value={invoiceStats.paid} tone="#0a7a35" />
          <DeskStat label="Tally Import" value={invoiceStats.tallyImport} tone="#0f766e" />
        </div>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#f2fff6", border: "1px solid #d6f4df" }}>{notice}</div> : null}
      <div style={{ marginTop: 16 }}>
        <DeskCard title="Invoice Queue" subtitle="Open invoice control and receipt actions · / search · Enter open">
          <div style={{ display: "grid", gap: 10, maxHeight: 980, overflowY: "auto", paddingRight: 4 }}>
            {loading ? (
              <div>Loading invoices…</div>
            ) : items.length ? (
              items.map((item) => {
                const ageingDays = Number(item.ageing_days || 0);
                const dueDateLabel = item.due_date ? `Due ${fmtDate(item.due_date)}` : "Due —";
                const selected = Number(selectedListId) === Number(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelectedListId(item.id);
                      setView({ type: "detail", id: item.id });
                    }}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      border: selected ? "1px solid #93c5fd" : "1px solid #e7ebf3",
                      borderRadius: 18,
                      padding: 14,
                      background: selected ? "#f0f7ff" : "#ffffff",
                      boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                      display: "grid",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>{fmtDate(item.invoice_date)}</div>
                        <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{item.invoice_number}</div>
                      </div>
                      <DeskChip label={String(item.invoice_status || "draft").toUpperCase()} tone={statusTone(item.invoice_status)} color={statusColor(item.invoice_status)} />
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{item.customer_name}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {String(item.invoice_source || "").toLowerCase() === "tally_import" ? (
                        <DeskChip label="Tally Import" tone="#ecfdf5" color="#047857" />
                      ) : null}
                      {item.sales_order_id && typeof onOpenSalesOrder === "function" ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenSalesOrder(item.sales_order_id);
                          }}
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            borderRadius: 999,
                            padding: "4px 10px",
                            background: "#eef4ff",
                            color: "#234a8f",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {item.so_number ? `SO ${item.so_number}` : "Open sales order"}
                        </button>
                      ) : (
                        <DeskChip label={item.so_number ? `SO ${item.so_number}` : "No sales order"} tone="#eef4ff" color="#234a8f" />
                      )}
                      {item.customer_po_number ? (
                        <DeskChip label={`Cust PO ${item.customer_po_number}`} tone="#fff7ea" color="#9a5a00" />
                      ) : (
                        <DeskChip label="No customer PO" tone="#f6f7fb" color="#58627a" />
                      )}
                      <DeskChip label={dueDateLabel} tone="#f6f7fb" color="#58627a" />
                      {ageingDays > 0 ? (
                        <DeskChip label={`${ageingDays}d overdue`} tone="#fff6e8" color="#8b5a00" />
                      ) : (
                        <DeskChip label="Not overdue" tone="#f0fdf4" color="#0a7a35" />
                      )}
                      <DeskChip label={`Outstanding ${fmtMoney(item.outstanding_invoice, item.invoice_currency_code)}`} tone="#f6f7fb" color="#58627a" />
                      <DeskChip label={`Total ${fmtMoney(item.grand_total_invoice, item.invoice_currency_code)}`} tone="#f6f7fb" color="#58627a" />
                    </div>
                  </button>
                );
              })
            ) : (
              <EmptyState
                title="No invoices yet"
                body="Create the first one from a confirmed sales order, or adjust filters to widen the queue."
              />
            )}
          </div>
          <ListPager
            meta={listMeta}
            loading={loading}
            label="invoices"
            onPageChange={(nextPage) => {
              setListPage(nextPage);
              loadList({ page: nextPage }).catch(() => {});
            }}
          />
        </DeskCard>
      </div>
    </div>
    <SlideOverDrawer
      open={view.type === "detail"}
      onClose={closeDetail}
      eyebrow="Invoice"
      title={view.type === "detail" ? `Invoice #${view.id}` : "Invoice"}
      subtitle="Billing queue stays open behind this drawer — close when the invoice step is done."
      width={900}
    >
      {view.type === "detail" ? (
        <InvoiceDetail
          id={view.id}
          embedded
          onBack={closeDetail}
          onOpenSalesOrder={onOpenSalesOrder}
          onOpenReceipt={onOpenReceipt}
          onOpenDispatch={onOpenDispatch}
          onNotice={(msg) => setNotice(msg)}
        />
      ) : null}
    </SlideOverDrawer>
    </>
  );
}

function InvoiceDetail({ id, onBack, onOpenSalesOrder, onOpenReceipt, onOpenDispatch, onNotice, embedded = false }) {
  const { busy, isBusy, runLocked } = useSubmitLock();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invoice, setInvoice] = useState(null);
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState("draft");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [customerPoNumber, setCustomerPoNumber] = useState("");
  const [customerPoDate, setCustomerPoDate] = useState("");
  const [packingForwardingAmount, setPackingForwardingAmount] = useState("");
  const [freightAmount, setFreightAmount] = useState("");
  const [creatingIntercompany, setCreatingIntercompany] = useState(false);
  const [dispatchEway, setDispatchEway] = useState(null);
  const [ewayBillNo, setEwayBillNo] = useState("");
  const [ewayBillDate, setEwayBillDate] = useState("");
  const [ewayValidTill, setEwayValidTill] = useState("");
  const [ewaySaving, setEwaySaving] = useState(false);
  const invoiceControlRef = useRef(null);
  const saving = isBusy("save");
  const creatingReceipt = isBusy("create-receipt");

  function applyInvoicePayload(data, fallbackInvoice = null) {
    const nextInvoice = data?.invoice || fallbackInvoice;
    setInvoice(nextInvoice || null);
    if (data && Object.prototype.hasOwnProperty.call(data, "dispatch_eway")) {
      setDispatchEway(data.dispatch_eway || null);
    }
    if (Array.isArray(data?.lines)) {
      setLines(data.lines.map((line) => ({ ...line, qty: String(line.qty ?? 0) })));
    }
    if (nextInvoice) {
      setStatus(nextInvoice.invoice_status || "draft");
      setInvoiceDate(nextInvoice.invoice_date ? String(nextInvoice.invoice_date).slice(0, 10) : "");
      setRemarks(nextInvoice.remarks || "");
      setCustomerPoNumber(nextInvoice.customer_po_number || "");
      setCustomerPoDate(nextInvoice.customer_po_date ? String(nextInvoice.customer_po_date).slice(0, 10) : "");
      setEwayBillNo(nextInvoice.eway_bill_no || "");
      setEwayBillDate(nextInvoice.eway_bill_date ? String(nextInvoice.eway_bill_date).slice(0, 10) : "");
      setEwayValidTill(nextInvoice.eway_valid_till ? String(nextInvoice.eway_valid_till).slice(0, 16) : "");
      setPackingForwardingAmount(
        nextInvoice.packing_forwarding_line_id != null
          ? String(nextInvoice.packing_forwarding_amount ?? 0)
          : ""
      );
      setFreightAmount(
        nextInvoice.freight_line_id != null
          ? String(nextInvoice.freight_amount ?? 0)
          : nextInvoice.charge_policy?.freight?.suggested_amount
            ? String(nextInvoice.charge_policy.freight.suggested_amount)
            : ""
      );
    }
  }

  useEffect(() => {
    setLoading(true);
    apiFetch(`/invoices/${id}`)
      .then((data) => applyInvoicePayload(data))
      .catch((e) => setError(e?.data?.error || "Failed to load invoice."))
      .finally(() => setLoading(false));
  }, [id]);

  async function saveStatus() {
    await runLocked("save", async () => {
      setError("");
      setNotice("");
      try {
        const goodsLines = lines.filter((line) => !String(line.charge_kind || "").trim());
        const chargePolicy = invoice?.charge_policy || {};
        const isTallyImport = String(invoice?.invoice_source || "").toLowerCase() === "tally_import";
        const isDraftInvoice = String(invoice?.invoice_status || "").toLowerCase() === "draft";
        const tallyPoOnlySave = isTallyImport && !isDraftInvoice;
        const payload = tallyPoOnlySave
          ? {
              customer_po_number: customerPoNumber,
              customer_po_date: customerPoDate || null,
            }
          : {
              invoice_status: status,
              invoice_date: invoiceDate,
              remarks,
              customer_po_number: customerPoNumber,
              customer_po_date: customerPoDate || null,
              lines: goodsLines.map((line) => ({
                id: line.id,
                qty: Number(line.qty || 0),
                customer_item_code: line.customer_item_code || "",
                customer_item_description: line.customer_item_description || "",
              })),
            };
        if (!tallyPoOnlySave) {
          if (chargePolicy.packing_forwarding?.billable) {
            payload.packing_forwarding_amount = Number(packingForwardingAmount || 0);
          }
          if (chargePolicy.freight?.billable) {
            payload.freight_amount = Number(freightAmount || 0);
          }
        }
        const data = await apiFetch(`/invoices/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        applyInvoicePayload(data, invoice);
        const msg = "Invoice updated successfully.";
        setNotice(msg);
        toast(msg, "success");
        onNotice?.(msg);
      } catch (e) {
        let message = e?.data?.error || "Failed to update invoice.";
        if (e?.data?.error === "INVALID_INVOICE_QTY") {
          message = "Invoice quantity must be between 0 and the remaining invoice quantity.";
        } else if (e?.data?.error === "NO_INVOICE_QTY") {
          message = "At least one invoice line must have a quantity greater than zero.";
        } else if (e?.data?.error === "INVOICE_NOT_EDITABLE") {
          message = "Only draft invoices can have their quantities edited.";
        }
        setError(message);
        toast(message, "error");
      }
    });
  }

  async function createReceipt() {
    await runLocked("create-receipt", async () => {
      setError("");
      setNotice("");
      try {
        const data = await apiFetch(`/receipts/from-invoice/${id}`, { method: "POST" });
        const receiptId = data?.receipt?.id;
        const msg = "Receipt created.";
        setNotice(msg);
        toast(msg, "success");
        onNotice?.(msg);
        if (receiptId && onOpenReceipt) onOpenReceipt(receiptId);
      } catch (e) {
        const code = e?.data?.error;
        let message = code || "Failed to create receipt.";
        if (code === "INVOICE_ALREADY_SETTLED") message = "This invoice is already fully settled.";
        else if (code === "INVOICE_CANCELLED") message = "Cancelled invoices cannot accept receipts.";
        setError(message);
        toast(message, "error");
      }
    });
  }

  async function createIntercompanyPurchaseInvoice() {
    setCreatingIntercompany(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/invoices/${id}/intercompany/create-purchase-invoice`, { method: "POST" });
      setInvoice(data?.invoice || invoice);
      setNotice("Intercompany purchase invoice created.");
    } catch (e) {
      const code = e?.data?.error;
      if (code === "INTERCOMPANY_NOT_CONFIGURED") setError("This sales order is not linked to an intercompany PO.");
      else if (code === "INTERCOMPANY_VENDOR_MAPPING_MISSING") setError("Intercompany vendor mapping missing for the buyer company.");
      else if (code === "INTERCOMPANY_ACCESS_DENIED") setError("Your user is not linked to the counterparty company.");
      else if (code === "INTERCOMPANY_PURCHASE_INVOICE_ALREADY_LINKED") setError("Purchase invoice is already created for this customer invoice.");
      else setError(code || "Failed to create intercompany purchase invoice.");
    } finally {
      setCreatingIntercompany(false);
    }
  }

  const invoiceBlockers = useMemo(() => {
    if (!invoice) return [];
    const items = [];
    const invStatus = String(invoice.invoice_status || "").toLowerCase();
    const fromTally = String(invoice.invoice_source || "").toLowerCase() === "tally_import";
    const scrollToControl = () => invoiceControlRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (invStatus === "cancelled") return [];
    if (invStatus === "draft") {
      items.push({
        id: "invoice-draft",
        severity: "med",
        reason: "Draft invoice — not yet billed to the customer.",
        explain: "Receipts and Tally export only pick up issued invoices.",
        ownerDesk: "Billing",
        ctaLabel: "Review and issue",
        onCta: scrollToControl,
      });
    }
    const einvoiceStatus = String(invoice.einvoice_status || "").toLowerCase();
    if (["failed", "error", "rejected"].includes(einvoiceStatus) || String(invoice.einvoice_error || "").trim()) {
      items.push({
        id: "einvoice-failed",
        severity: "high",
        reason: `E-invoice ${einvoiceStatus || "failed"}${invoice.einvoice_error ? `: ${invoice.einvoice_error}` : ""}`,
        ownerDesk: "Finance",
      });
    }
    const hasEway = Boolean(String(invoice.eway_bill_no || dispatchEway?.eway_bill_no || "").trim());
    if (!fromTally && invStatus !== "draft" && !hasEway && Number(invoice.grand_total_invoice || 0) >= 50000) {
      const dispatchId = Number(dispatchEway?.dispatch_id || invoice.dispatch_id || 0);
      items.push({
        id: "eway-missing",
        severity: "med",
        reason: "No e-way bill recorded for a consignment of ₹50,000 or more.",
        ownerDesk: "Dispatch",
        ctaLabel: dispatchId && typeof onOpenDispatch === "function" ? "Open dispatch" : undefined,
        onCta: dispatchId && typeof onOpenDispatch === "function" ? () => onOpenDispatch(dispatchId) : undefined,
      });
    }
    const outstanding = Number(invoice.outstanding_invoice || 0);
    const due = invoice.due_date ? new Date(String(invoice.due_date).slice(0, 10)) : null;
    if (invStatus === "issued" && outstanding > 0 && due && !Number.isNaN(due.getTime()) && due < new Date(new Date().toDateString())) {
      const days = Math.floor((Date.now() - due.getTime()) / 86400000);
      items.push({
        id: "invoice-overdue",
        severity: days > 30 ? "high" : "med",
        reason: `Payment overdue by ${days} day${days === 1 ? "" : "s"} — ${fmtMoney(outstanding, invoice.invoice_currency_code)} outstanding.`,
        ownerDesk: "AR Desk",
        ctaLabel: "Record receipt",
        onCta: () => createReceipt(),
      });
    }
    const noHsn = lines.filter((line) => !String(line.charge_kind || "").trim() && !String(line.hsn_no || "").trim());
    if (!fromTally && invStatus === "draft" && noHsn.length) {
      items.push({
        id: "hsn-missing",
        severity: "high",
        reason: `${noHsn.length} line${noHsn.length === 1 ? "" : "s"} without HSN — GST invoice cannot be issued cleanly.`,
        explain: noHsn.slice(0, 3).map((line) => line.item_code || line.item_name).join(", "),
        ownerDesk: "Product Master",
      });
    }
    return items;
  }, [invoice, lines, dispatchEway, onOpenDispatch]);

  if (loading) return <div>Loading invoice…</div>;
  if (!invoice) {
    return (
      <div>
        {!embedded ? <button onClick={onBack}>Back</button> : null}
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Invoice not found."}</div>
      </div>
    );
  }

  const chargePolicy = invoice.charge_policy || {};
  const goodsLines = lines.filter((line) => !String(line.charge_kind || "").trim());
  const chargeLines = lines.filter((line) => String(line.charge_kind || "").trim());
  const showChargesCard = Boolean(chargePolicy.packing_forwarding?.billable || chargePolicy.freight?.billable || chargeLines.length);
  const isDraft = String(invoice.invoice_status || "").toLowerCase() === "draft";
  const isTallyImport = String(invoice.invoice_source || "").toLowerCase() === "tally_import";
  const tallyParallel = isTallyImport && !invoice.sales_order_id;
  const showErpWorkflow = !tallyParallel;
  const canEditPo = isDraft || isTallyImport;

  function renderInvoiceLinesCard() {
    return (
      <DeskCard
        title="Invoice Lines"
        subtitle={tallyParallel ? "Imported from Tally — line amounts are read-only here" : "Adjust billing quantity while invoice remains draft"}
      >
        <div style={{ display: "grid", gap: 10 }}>
          {goodsLines.map((line) => (
            <div key={line.id} style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 14, background: "#ffffff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>L{line.line_no} • {line.item_code || line.item_name || "—"}</div>
                  <div style={{ fontSize: 12, opacity: 0.68 }}>{line.product_group_name || line.line_description || "—"}</div>
                </div>
                <DeskChip label={fmtMoney(Number(line.unit_price_invoice || 0) * Number(line.qty || 0), invoice.invoice_currency_code)} tone="#f6f7fb" color="#58627a" />
              </div>
              {tallyParallel ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
                  <MiniMetric label="Qty" value={Number(line.qty || 0)} />
                  <MiniMetric label="Rate" value={Number(line.unit_price_invoice || 0)} />
                  <MiniMetric label="GST%" value={line.gst_pct ?? 0} />
                </div>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
                    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                      Customer Part Code
                      <input
                        value={line.customer_item_code || ""}
                        disabled={!isDraft}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((row) => (row.id === line.id ? { ...row, customer_item_code: e.target.value } : row))
                          )
                        }
                        placeholder="SAP / customer item code"
                      />
                    </label>
                    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                      Customer Part Description
                      <input
                        value={line.customer_item_description || ""}
                        disabled={!isDraft}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((row) => (row.id === line.id ? { ...row, customer_item_description: e.target.value } : row))
                          )
                        }
                        placeholder="Customer material description"
                      />
                    </label>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr)) 140px", gap: 10, marginTop: 12, alignItems: "end" }}>
                    <MiniMetric label="Ordered" value={Number(line.qty_ordered || 0)} />
                    <MiniMetric label="Prev Inv." value={Number(line.qty_previously_invoiced || 0)} />
                    <MiniMetric label="Avail." value={Number(line.qty_remaining_before_invoice || 0)} />
                    <MiniMetric label="GST%" value={line.gst_pct ?? 0} />
                    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                      Qty
                      <input
                        value={line.qty}
                        disabled={!isDraft}
                        onChange={(e) => setLines((prev) => prev.map((row) => (row.id === line.id ? { ...row, qty: e.target.value } : row)))}
                      />
                    </label>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </DeskCard>
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
              Active Invoice Desk
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>{invoice.invoice_number}</h2>
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth: 780, lineHeight: 1.7 }}>
              {invoice.customer_name} • {invoice.so_number ? `SO ${invoice.so_number}` : "No source order"}
              {invoice.customer_po_number ? ` • Cust PO ${invoice.customer_po_number}` : ""}
              {invoice.job_no ? ` • Job ${invoice.job_no}` : ""} • payment and intercompany actions stay available from this desk.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <DeskChip label={String(invoice.invoice_status || "draft").toUpperCase()} tone={statusTone(invoice.invoice_status)} color={statusColor(invoice.invoice_status)} />
            {!embedded ? <button onClick={onBack}>Back To Queue</button> : null}
            <a
              href={`/invoices/${id}/pdf`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none", border: "1px solid #d0d0d0", borderRadius: 6, padding: "8px 12px", color: "#111", background: "#fff", fontSize: 13 }}
            >
              Download GST PDF
            </a>
            <button
              onClick={createIntercompanyPurchaseInvoice}
              disabled={creatingIntercompany || Boolean(invoice.intercompany_purchase_invoice_id) || !invoice.intercompany_counterparty_company_id || tallyParallel}
            >
              {creatingIntercompany ? "Working..." : invoice.intercompany_purchase_invoice_id ? "Purchase Invoice Linked" : "Create Counterparty Purchase Invoice"}
            </button>
            <button onClick={createReceipt} disabled={busy || Number(invoice.outstanding_invoice || 0) <= 0}>
              {creatingReceipt ? "Working..." : "Create Receipt"}
            </button>
            {invoice.sales_order_id && onOpenSalesOrder ? <button onClick={() => onOpenSalesOrder(invoice.sales_order_id)}>Open Sales Order</button> : null}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 12, marginTop: 18 }}>
          <DeskStat label="Subtotal" value={fmtMoney(invoice.subtotal_invoice, invoice.invoice_currency_code)} tone="#143d7a" />
          <DeskStat label="GST" value={fmtMoney(invoice.tax_total_invoice, invoice.invoice_currency_code)} tone="#8b5a00" />
          <DeskStat label="Received" value={fmtMoney(invoice.amount_received_invoice, invoice.invoice_currency_code)} tone="#234a8f" />
          <DeskStat label="Outstanding" value={fmtMoney(invoice.outstanding_invoice, invoice.invoice_currency_code)} tone="#7a1637" />
          <DeskStat label="Grand Total" value={fmtMoney(invoice.grand_total_invoice, invoice.invoice_currency_code)} tone="#0a7a35" />
        </div>
        <BlockerRibbon blockers={invoiceBlockers} />
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#f2fff6", border: "1px solid #d6f4df" }}>{notice}</div> : null}

      <div
        style={{
          marginTop: 16,
          display: "grid",
          gridTemplateColumns: tallyParallel
            ? "minmax(0, 1fr) minmax(280px, 320px)"
            : "minmax(280px, 0.72fr) minmax(0, 1.1fr) minmax(300px, 0.7fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {tallyParallel ? (
            <DeskCard title="Tally Parallel Import" subtitle="Complete the commercial chain">
              <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                This invoice was imported from Tally without a Josh sales order.
                {invoice.tally_voucher_number ? ` Tally voucher: ${invoice.tally_voucher_number}.` : ""}
                {" "}Bulk-link SO + PO via CSV columns{" "}
                <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                  invoice_number, so_number, customer_po_number, customer_po_date, job_no
                </span>
                {" "}to <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>/invoices/tally-chain-link</span>,
                or enter the customer PO below and save.
              </div>
            </DeskCard>
          ) : null}
          <DeskCard title="Invoice Snapshot" subtitle="Source order and intercompany context">
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <div>
                Sales Order:{" "}
                {invoice.sales_order_id && typeof onOpenSalesOrder === "function" ? (
                  <button
                    type="button"
                    onClick={() => onOpenSalesOrder(invoice.sales_order_id)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      color: "#234a8f",
                      fontWeight: 700,
                      textDecoration: "underline",
                    }}
                  >
                    {invoice.so_number || `#${invoice.sales_order_id}`}
                  </button>
                ) : (
                  invoice.so_number || "—"
                )}
              </div>
              <div>Order Status: {invoice.order_status || "—"}</div>
              <div>Attention To: {invoice.attention_to || "—"}</div>
              <div>Invoice Date: {fmtDate(invoice.invoice_date)}</div>
              <div>Job No: {invoice.job_no || "—"}</div>
              {invoice.intercompany_counterparty_company_id ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>Intercompany</div>
                  <div style={{ opacity: 0.78 }}>
                    Counterparty: {invoice.intercompany_company_code ? `${invoice.intercompany_company_code} - ` : ""}{invoice.intercompany_company_name || "—"}
                  </div>
                  <div style={{ opacity: 0.78 }}>
                    Purchase Invoice: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{invoice.intercompany_purchase_invoice_number || (invoice.intercompany_purchase_invoice_id ? `#${invoice.intercompany_purchase_invoice_id}` : "—")}</span>
                  </div>
                </div>
              ) : null}
            </div>
          </DeskCard>

          <div ref={invoiceControlRef} />
          <DeskCard title="Invoice Control" subtitle="Status, dating, and remarks">
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="draft">Draft</option>
                <option value="issued">Issued</option>
                <option value="paid">Paid</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Invoice Date">
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </Field>
            <Field label="Customer PO Number">
              <input
                value={customerPoNumber}
                onChange={(e) => setCustomerPoNumber(e.target.value)}
                disabled={!canEditPo}
                placeholder="Customer PO / SAP reference"
              />
            </Field>
            <Field label="Customer PO Date">
              <input
                type="date"
                value={customerPoDate}
                onChange={(e) => setCustomerPoDate(e.target.value)}
                disabled={!canEditPo}
              />
            </Field>
            <Field label="Remarks">
              <textarea rows={3} style={{ width: "100%" }} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </Field>
            <button onClick={saveStatus} disabled={busy}>{saving ? "Saving..." : tallyParallel ? "Save PO Details" : "Save Invoice"}</button>
          </DeskCard>

          {tallyParallel ? renderInvoiceLinesCard() : null}

          {showErpWorkflow ? (
          <DeskCard title="E-Invoice" subtitle="NIC metadata bridge — manual IRN/QR capture until GSP is configured">
            <div style={{ fontSize: 13, lineHeight: 1.8, marginBottom: 12 }}>
              <div>Status: {invoice.einvoice_status || "none"}</div>
              <div>IRN: {invoice.irn || "—"}</div>
              <div>Ack No: {invoice.irn_ack_no || "—"}</div>
              <div>Ack Date: {fmtDate(invoice.irn_ack_date)}</div>
              <div>Signed QR: {invoice.signed_qr_code ? "Stored" : "—"}</div>
              {invoice.converted_from_proforma_number ? (
                <div style={{ marginTop: 8, fontWeight: 700 }}>Converted from Proforma {invoice.converted_from_proforma_number}</div>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  try {
                    const data = await apiFetch(`/invoices/${id}/einvoice/payload`);
                    const blob = new Blob([JSON.stringify(data?.payload || data, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${invoice.invoice_number || "invoice"}_einvoice.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toast("NIC payload downloaded.", "success");
                  } catch (e) {
                    toast(e?.data?.error || "Payload download failed.", "error");
                  }
                }}
              >
                Download NIC JSON
              </button>
              <button
                type="button"
                disabled={busy || !["issued", "paid"].includes(String(invoice.invoice_status || "").toLowerCase())}
                onClick={async () => {
                  const irn = window.prompt("IRN");
                  if (!irn) return;
                  const irn_ack_no = window.prompt("Ack No") || "";
                  const irn_ack_date = window.prompt("Ack Date (YYYY-MM-DD or ISO)") || "";
                  const signed_qr_code = window.prompt("Signed QR payload") || "";
                  try {
                    const data = await apiFetch(`/invoices/${id}/einvoice/irn`, {
                      method: "POST",
                      body: JSON.stringify({ irn, irn_ack_no, irn_ack_date, signed_qr_code }),
                    });
                    applyInvoicePayload(data, invoice);
                    toast("IRN saved.", "success");
                  } catch (e) {
                    toast(e?.data?.error || "Failed to save IRN.", "error");
                  }
                }}
              >
                Enter IRN details
              </button>
              <button
                type="button"
                disabled={busy || !invoice.irn}
                onClick={async () => {
                  if (!window.confirm("Clear IRN metadata from this invoice?")) return;
                  try {
                    const data = await apiFetch(`/invoices/${id}/einvoice/irn`, {
                      method: "DELETE",
                      body: JSON.stringify({ reason: "Cleared from invoice desk" }),
                    });
                    applyInvoicePayload(data, invoice);
                    toast("IRN cleared.", "success");
                  } catch (e) {
                    toast(e?.data?.error || "Failed to clear IRN.", "error");
                  }
                }}
              >
                Clear IRN
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  !["issued", "paid"].includes(String(invoice.invoice_status || "").toLowerCase()) ||
                  Boolean(invoice.irn)
                }
                title={
                  invoice.irn
                    ? "IRN already present — cancel via GSP or clear first"
                    : ["issued", "paid"].includes(String(invoice.invoice_status || "").toLowerCase())
                      ? "Generate IRN via MasterGST"
                      : "Issue the invoice before generating IRN"
                }
                onClick={async () => {
                  if (!window.confirm("Generate IRN via MasterGST for this invoice?")) return;
                  try {
                    const data = await apiFetch(`/invoices/${id}/einvoice/generate`, {
                      method: "POST",
                      body: JSON.stringify({}),
                    });
                    applyInvoicePayload(data, invoice);
                    toast(
                      data?.gsp?.mocked
                        ? `Mock IRN saved (${String(data?.gsp?.irn || "").slice(0, 12)}…).`
                        : `IRN generated via MasterGST.`,
                      "success"
                    );
                  } catch (e) {
                    toast(
                      e?.data?.error === "NOT_CONFIGURED"
                        ? e?.data?.detail || "MasterGST is not configured for this company."
                        : e?.data?.detail || e?.data?.error || "IRN generate failed.",
                      "error"
                    );
                  }
                }}
              >
                Generate IRN via GSP
              </button>
              <button
                type="button"
                disabled={busy || !invoice.irn}
                title="Cancel IRN on MasterGST — does not clear e-way bill fields"
                onClick={async () => {
                  if (!window.confirm(`Cancel IRN ${invoice.irn} via MasterGST? E-way fields will be kept.`)) return;
                  try {
                    const data = await apiFetch(`/invoices/${id}/einvoice/cancel`, {
                      method: "POST",
                      body: JSON.stringify({ remark: "Cancelled from Josh invoice desk" }),
                    });
                    applyInvoicePayload(data, invoice);
                    toast(
                      data?.preserved_eway?.eway_bill_no
                        ? `IRN cancelled. E-way ${data.preserved_eway.eway_bill_no} preserved.`
                        : "IRN cancelled via MasterGST.",
                      "success"
                    );
                  } catch (e) {
                    toast(
                      e?.data?.error === "NOT_CONFIGURED"
                        ? e?.data?.detail || "MasterGST is not configured for this company."
                        : e?.data?.detail || e?.data?.error || "IRN cancel failed.",
                      "error"
                    );
                  }
                }}
              >
                Cancel IRN via GSP
              </button>
            </div>
          </DeskCard>
          ) : null}

          {showErpWorkflow ? (
          <DeskCard title="E-Way Bill" subtitle="Filed e-way bill against this invoice — synced from the dispatch, overridable here">
            <div style={{ fontSize: 13, lineHeight: 1.8, marginBottom: 12 }}>
              <div>
                Current: {invoice.eway_bill_no || "—"}
                {invoice.eway_bill_date ? ` · ${fmtDate(invoice.eway_bill_date)}` : ""}
                {invoice.eway_valid_till ? ` · valid till ${fmtDate(invoice.eway_valid_till)}` : ""}
              </div>
              {dispatchEway?.dispatch_number ? (
                <div style={{ marginTop: 4, opacity: 0.78 }}>
                  From dispatch{" "}
                  {dispatchEway?.dispatch_id && typeof onOpenDispatch === "function" ? (
                    <button
                      type="button"
                      onClick={() => onOpenDispatch(Number(dispatchEway.dispatch_id))}
                      style={{ all: "unset", cursor: "pointer", color: "#1d4ed8", fontWeight: 700, textDecoration: "underline" }}
                    >
                      {dispatchEway.dispatch_number}
                    </button>
                  ) : (
                    dispatchEway.dispatch_number
                  )}
                  : {dispatchEway.eway_bill_no || "—"}
                  {dispatchEway.transport_mode ? ` · ${dispatchEway.transport_mode}` : ""}
                  {dispatchEway.vehicle_no ? ` · ${dispatchEway.vehicle_no}` : ""}
                </div>
              ) : (
                <div style={{ marginTop: 4, opacity: 0.62 }}>No linked dispatch e-way details.</div>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="E-Way Bill No">
                <input value={ewayBillNo} onChange={(e) => setEwayBillNo(e.target.value)} placeholder="12-digit EBN" />
              </Field>
              <Field label="E-Way Bill Date">
                <input type="date" value={ewayBillDate} onChange={(e) => setEwayBillDate(e.target.value)} />
              </Field>
              <Field label="Valid Till">
                <input type="datetime-local" value={ewayValidTill} onChange={(e) => setEwayValidTill(e.target.value)} />
              </Field>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={
                  busy ||
                  ewaySaving ||
                  !["issued", "paid"].includes(String(invoice.invoice_status || "").toLowerCase())
                }
                title={
                  ["issued", "paid"].includes(String(invoice.invoice_status || "").toLowerCase())
                    ? invoice.irn
                      ? "Generate e-way via MasterGST using IRN"
                      : "Generate e-way via MasterGST from invoice + dispatch Part A/B"
                    : "Issue the invoice before generating e-way"
                }
                onClick={async () => {
                  if (!window.confirm(invoice.irn ? "Generate e-way bill via MasterGST using this invoice IRN?" : "Generate e-way bill via MasterGST from invoice + dispatch fields?")) {
                    return;
                  }
                  setEwaySaving(true);
                  try {
                    const data = await apiFetch(`/invoices/${id}/eway/generate`, { method: "POST", body: JSON.stringify({}) });
                    applyInvoicePayload(data, invoice);
                    toast(
                      data?.gsp?.mocked
                        ? `Mock EBN ${data?.gsp?.eway_bill_no || ""} saved.`
                        : `E-way bill ${data?.gsp?.eway_bill_no || ""} generated via MasterGST.`,
                      "success"
                    );
                  } catch (e) {
                    toast(
                      e?.data?.error === "NOT_CONFIGURED"
                        ? e?.data?.detail || "MasterGST is not configured for this company."
                        : e?.data?.detail || e?.data?.error || "E-way generate failed.",
                      "error"
                    );
                  } finally {
                    setEwaySaving(false);
                  }
                }}
              >
                Generate via GSP
              </button>
              <button
                type="button"
                disabled={busy || ewaySaving || !invoice.eway_bill_no}
                onClick={async () => {
                  if (!window.confirm(`Cancel e-way bill ${invoice.eway_bill_no} via MasterGST?`)) return;
                  setEwaySaving(true);
                  try {
                    const data = await apiFetch(`/invoices/${id}/eway/cancel`, {
                      method: "POST",
                      body: JSON.stringify({ remark: "Cancelled from Josh invoice desk" }),
                    });
                    applyInvoicePayload(data, invoice);
                    toast("E-way bill cancelled via MasterGST.", "success");
                  } catch (e) {
                    toast(
                      e?.data?.error === "NOT_CONFIGURED"
                        ? e?.data?.detail || "MasterGST is not configured for this company."
                        : e?.data?.detail || e?.data?.error || "E-way cancel failed.",
                      "error"
                    );
                  } finally {
                    setEwaySaving(false);
                  }
                }}
              >
                Cancel via GSP
              </button>
              <button
                type="button"
                disabled={busy || ewaySaving || !dispatchEway?.eway_bill_no}
                onClick={() => {
                  setEwayBillNo(dispatchEway.eway_bill_no || "");
                  setEwayBillDate(dispatchEway.eway_bill_date ? String(dispatchEway.eway_bill_date).slice(0, 10) : "");
                  setEwayValidTill(dispatchEway.eway_valid_till ? String(dispatchEway.eway_valid_till).slice(0, 16) : "");
                }}
              >
                Pull from dispatch
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  ewaySaving ||
                  !["issued", "paid"].includes(String(invoice.invoice_status || "").toLowerCase())
                }
                title={
                  ["issued", "paid"].includes(String(invoice.invoice_status || "").toLowerCase())
                    ? undefined
                    : "Issue the invoice before filing e-way details"
                }
                onClick={async () => {
                  setEwaySaving(true);
                  try {
                    const data = await apiFetch(`/invoices/${id}/eway`, {
                      method: "PUT",
                      body: JSON.stringify({
                        eway_bill_no: ewayBillNo || null,
                        eway_bill_date: ewayBillDate || null,
                        eway_valid_till: ewayValidTill || null,
                      }),
                    });
                    applyInvoicePayload(data, invoice);
                    toast("E-way details saved.", "success");
                  } catch (e) {
                    toast(
                      e?.data?.error === "EWAY_BILL_NO_INVALID"
                        ? "E-way bill number must be 12 digits."
                        : e?.data?.error || "Failed to save e-way details.",
                      "error"
                    );
                  } finally {
                    setEwaySaving(false);
                  }
                }}
              >
                {ewaySaving ? "Working…" : "Save e-way details"}
              </button>
              <button
                type="button"
                disabled={busy || ewaySaving || !invoice.eway_bill_no}
                onClick={async () => {
                  if (!window.confirm("Clear e-way details from this invoice?")) return;
                  setEwaySaving(true);
                  try {
                    const data = await apiFetch(`/invoices/${id}/eway`, {
                      method: "PUT",
                      body: JSON.stringify({
                        eway_bill_no: null,
                        eway_bill_date: null,
                        eway_valid_till: null,
                      }),
                    });
                    applyInvoicePayload(data, invoice);
                    toast("E-way details cleared.", "success");
                  } catch (e) {
                    toast(e?.data?.error || "Failed to clear e-way details.", "error");
                  } finally {
                    setEwaySaving(false);
                  }
                }}
              >
                Clear e-way details
              </button>
            </div>
          </DeskCard>
          ) : null}

          {showErpWorkflow && showChargesCard ? (
            <DeskCard
              title="Taxable Charges"
              subtitle="Packing & Forwarding and Freight are separate commercial terms. Each bills with goods GST only when that term says Absstem invoices the amount."
            >
              <div style={{ display: "grid", gap: 16 }}>
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.55 }}>Packing & Forwarding</div>
                  {chargePolicy.packing_forwarding?.billable ? (
                    <Field label={`Amount · ${chargePolicy.packing_forwarding.term_name || chargePolicy.packing_forwarding.term_code || "Extra at Actuals"}`}>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={packingForwardingAmount}
                        disabled={!isDraft}
                        onChange={(e) => setPackingForwardingAmount(e.target.value)}
                        placeholder="0.00"
                      />
                    </Field>
                  ) : (
                    <div style={{ fontSize: 13, opacity: 0.72 }}>
                      {chargePolicy.packing_forwarding?.term_name || chargePolicy.packing_forwarding?.term_code || "No P&F term"} — not billed as a separate invoice line.
                    </div>
                  )}
                </div>

                <div style={{ display: "grid", gap: 8, borderTop: "1px solid #e7ebf3", paddingTop: 12 }}>
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.55 }}>Freight</div>
                  <div style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.5 }}>
                    Modes: Inclusive · Buyer Scope · Buyer Approved (billed on invoice). Only the billed modes open an amount field.
                  </div>
                  {chargePolicy.freight?.billable ? (
                    <Field label={`Amount · ${chargePolicy.freight.term_name || chargePolicy.freight.term_code || "Buyer Approved (Billed)"}`}>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={freightAmount}
                        disabled={!isDraft}
                        onChange={(e) => setFreightAmount(e.target.value)}
                        placeholder="0.00"
                      />
                      {chargePolicy.freight.suggested_amount ? (
                        <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
                          Dispatch freight seed: {fmtMoney(chargePolicy.freight.suggested_amount, invoice.invoice_currency_code)}
                        </div>
                      ) : null}
                    </Field>
                  ) : (
                    <div style={{ fontSize: 13, opacity: 0.72 }}>
                      {chargePolicy.freight?.term_name || chargePolicy.freight?.term_code || "No freight term"} — Inclusive / Buyer Scope (not billed on this invoice).
                    </div>
                  )}
                </div>

                {chargeLines.length ? (
                  <div style={{ fontSize: 12, lineHeight: 1.7, opacity: 0.78, borderTop: "1px solid #e7ebf3", paddingTop: 12 }}>
                    {chargeLines.map((line) => (
                      <div key={line.id}>
                        {line.item_name || line.charge_kind}: {fmtMoney(Number(line.line_total_invoice || 0), invoice.invoice_currency_code)}
                        {" · "}GST {line.gst_pct ?? 0}%
                        {line.hsn_no ? ` · HSN ${line.hsn_no}` : ""}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </DeskCard>
          ) : null}
        </div>

        {!tallyParallel ? (
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {renderInvoiceLinesCard()}
        </div>
        ) : null}

        <div style={{ display: "grid", gap: 16, position: tallyParallel ? "sticky" : "sticky", top: 12, minWidth: 0 }}>
          <DeskCard title="Action Rail" subtitle="Receipt, intercompany, and commercial amount visibility">
            <div style={{ display: "grid", gap: 8 }}>
              <DeskChip label={`Outstanding ${fmtMoney(invoice.outstanding_invoice, invoice.invoice_currency_code)}`} tone="#f6f7fb" color="#58627a" />
              <DeskChip label={`Received ${fmtMoney(invoice.amount_received_invoice, invoice.invoice_currency_code)}`} tone="#eef4ff" color="#234a8f" />
              {invoice.intercompany_purchase_invoice_id ? <DeskChip label="Counterparty PI linked" tone="#effcf3" color="#0b7d45" /> : null}
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
    success: ["paid"],
    info: ["issued"],
    danger: ["cancelled"],
    warning: ["draft"],
    fallbackTone: "#fff6e8",
  }).tone;
}

function statusColor(status) {
  return getDeskStatusAppearance(status, {
    success: ["paid"],
    info: ["issued"],
    danger: ["cancelled"],
    warning: ["draft"],
    fallbackColor: "#8b5a00",
  }).color;
}
