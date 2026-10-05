import { useEffect, useMemo, useState } from "react";

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

function toIsoDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return num(value).toFixed(2);
}

function mapLine(line) {
  return {
    ...line,
    qty_return: line?.qty_return ?? 0,
    remarks: line?.remarks || "",
    serial_text: Array.isArray(line?.serials) ? line.serials.join("\n") : "",
  };
}

function ncrStatusLabel(value) {
  const text = String(value || "").replaceAll("_", " ").trim();
  return text ? text.replace(/\b\w/g, (m) => m.toUpperCase()) : "Open";
}

export default function SalesReturns({ launch, onConsumeLaunch }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [bootstrap, setBootstrap] = useState({ invoices: [] });
  const [invoiceId, setInvoiceId] = useState("");

  async function loadBootstrap() {
    const data = await apiFetch("/sales-returns/bootstrap");
    setBootstrap({ invoices: Array.isArray(data?.invoices) ? data.invoices : [] });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/sales-returns");
      setItems(Array.isArray(data?.sales_returns) ? data.sales_returns : []);
    } catch (_e) {
      setError("Failed to load sales returns.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
    }
  }, [view.type]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextInvoiceId = typeof launch.invoice_id === "string" || typeof launch.invoice_id === "number" ? String(launch.invoice_id) : "";
    const nextDisputeId = typeof launch.dispute_id === "string" || typeof launch.dispute_id === "number" ? String(launch.dispute_id) : "";
    const nextSalesReturnId = typeof launch.sales_return_id === "string" || typeof launch.sales_return_id === "number" ? Number(launch.sales_return_id) : 0;
    const autoCreate = launch.auto_create === true;
    if (nextSalesReturnId > 0) {
      setView({ type: "detail", id: nextSalesReturnId });
      if (typeof onConsumeLaunch === "function") onConsumeLaunch();
      return;
    }
    if (nextInvoiceId) {
      setInvoiceId(nextInvoiceId);
      if (view.type !== "list") setView({ type: "list" });
      if (autoCreate) {
        apiFetch(`/sales-returns/from-invoice/${nextInvoiceId}`, {
          method: "POST",
          body: JSON.stringify({
            dispute_id: nextDisputeId ? Number(nextDisputeId) : null,
          }),
        })
          .then((data) => {
            const id = data?.sales_return?.id;
            if (id) setView({ type: "detail", id });
            setNotice("Sales return draft created.");
          })
          .catch((e) => {
            setError(e?.data?.error || "Failed to create sales return.");
          });
      }
    }
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  async function createFromInvoice(overrideInvoiceId = null) {
    const nextInvoiceId = overrideInvoiceId || invoiceId;
    if (!nextInvoiceId) {
      setError("Select an invoice first.");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/sales-returns/from-invoice/${nextInvoiceId}`, {
        method: "POST",
      });
      const id = data?.sales_return?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Sales return draft created.");
    } catch (e) {
      if (e?.data?.error === "NO_PENDING_RETURN_QTY") setError("The selected invoice has no pending quantity left for return.");
      else setError("Failed to create sales return.");
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return <SalesReturnDetail id={view.id} onBack={() => setView({ type: "list" })} />;
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Sales Return / Customer Credit Note</h2>
        <button onClick={loadList} disabled={loading}>Refresh</button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Create Return From Customer Invoice</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Invoice
            <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} style={{ height: 36 }}>
              <option value="">Select invoice</option>
              {bootstrap.invoices.map((row) => (
                <option key={row.id} value={String(row.id)}>
                  {row.invoice_number} • {row.customer_name} • {money(row.grand_total_invoice)}
                </option>
              ))}
            </select>
          </label>
          <button onClick={createFromInvoice} disabled={creating}>
            {creating ? "Creating..." : "Create Return"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {loading ? <div>Loading sales returns…</div> : items.length ? items.map((row) => (
          <button
            key={row.id}
            onClick={() => setView({ type: "detail", id: row.id })}
            style={{ all: "unset", cursor: "pointer", border: "1px solid #e5e5e5", borderRadius: 10, padding: 14, display: "grid", gap: 8 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700 }}>{row.return_number}</div>
              <div style={{ textTransform: "capitalize" }}>{row.return_status}</div>
            </div>
            <div style={{ fontSize: 13, opacity: 0.78 }}>
              {row.customer_name} • {row.invoice_number || "Manual"} • {fmtDate(row.return_date)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(160px, 1fr))", gap: 10 }}>
              <Metric label="Credit Note" value={row.credit_note_number || "Pending"} />
              <Metric label="Credit Amount" value={money(row.credit_note_amount)} />
            </div>
          </button>
        )) : <div style={{ opacity: 0.72 }}>No sales returns yet.</div>}
      </div>
    </div>
  );
}

function SalesReturnDetail({ id, onBack }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [header, setHeader] = useState(null);
  const [lines, setLines] = useState([]);
  const [ncrCases, setNcrCases] = useState([]);
  const [capaActions, setCapaActions] = useState([]);
  const [returnStatus, setReturnStatus] = useState("draft");
  const [returnDate, setReturnDate] = useState("");
  const [remarks, setRemarks] = useState("");

  function applySalesReturnResponse(data) {
    const salesReturn = data?.sales_return || null;
    setHeader(salesReturn);
    setLines(Array.isArray(data?.lines) ? data.lines.map(mapLine) : []);
    setNcrCases(Array.isArray(data?.ncr_cases) ? data.ncr_cases : []);
    setCapaActions(Array.isArray(data?.capa_actions) ? data.capa_actions : []);
    setReturnStatus(salesReturn?.return_status || "draft");
    setReturnDate(toIsoDate(salesReturn?.return_date));
    setRemarks(salesReturn?.remarks || "");
  }

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/sales-returns/${id}`);
      applySalesReturnResponse(data);
    } catch (_e) {
      setError("Failed to load sales return.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  const isDraft = String(returnStatus || "").toLowerCase() === "draft";

  const totals = useMemo(() => {
    return lines.reduce(
      (acc, line) => {
        const qtyReturn = num(line.qty_return);
        const lineTotal = qtyReturn * num(line.unit_price_invoice);
        const taxTotal = (lineTotal * num(line.gst_pct)) / 100;
        acc.qty += qtyReturn;
        acc.subtotal += lineTotal;
        acc.tax += taxTotal;
        acc.grand += lineTotal + taxTotal;
        return acc;
      },
      { qty: 0, subtotal: 0, tax: 0, grand: 0 }
    );
  }, [lines]);

  function updateLine(index, patch) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        return_status: returnStatus,
        return_date: returnDate || null,
        remarks: remarks || null,
      };
      if (isDraft) {
        payload.lines = lines.map((line) => ({
          invoice_line_id: line.invoice_line_id,
          qty_return: num(line.qty_return),
          remarks: line.remarks || null,
        }));
        payload.serial_rows = lines.flatMap((line, index) =>
          String(line.serial_text || "")
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)
            .map((serial_no) => ({ line_no: index + 1, serial_no }))
        );
      }
      const data = await apiFetch(`/sales-returns/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      applySalesReturnResponse(data);
      setNotice("Sales return saved.");
    } catch (e) {
      if (e?.data?.error === "RETURN_EXCEEDS_INVOICE") setError("Return quantity cannot exceed the invoice's pending return quantity.");
      else if (e?.data?.error === "SERIAL_QTY_NOT_INTEGER") setError("Serial-controlled items require a whole-number return quantity.");
      else if (e?.data?.error === "SERIAL_COUNT_MISMATCH") setError("Serial-controlled items require one serial number per returned unit.");
      else if (e?.data?.error === "DUPLICATE_SERIALS") setError("Duplicate serial numbers are not allowed in a return line.");
      else setError("Failed to save sales return.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div>Loading sales return…</div>;
  if (!header) return <div>Sales return not found.</div>;

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{header.return_number}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {header.customer_name} • {header.invoice_number || "No invoice"} • {returnStatus}
          </div>
        </div>
        <button onClick={refresh}>Refresh</button>
        <button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Return Snapshot</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Return Date
              <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} style={{ height: 34 }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Status
              <select value={returnStatus} onChange={(e) => setReturnStatus(e.target.value)} style={{ height: 36 }}>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(140px, 1fr))", gap: 10, marginTop: 12 }}>
            <Metric label="Invoice" value={header.invoice_number || "—"} />
            <Metric label="Credit Note" value={header.credit_note_number || "Pending"} />
            <Metric label="Customer" value={header.customer_name || "—"} />
            <Metric label="Dispatch" value={header.dispatch_number || "—"} />
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} style={{ padding: 10 }} />
          </label>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Credit Summary</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
            <Metric label="Return Qty" value={totals.qty.toFixed(4)} />
            <Metric label="Subtotal" value={money(totals.subtotal)} />
            <Metric label="Tax" value={money(totals.tax)} />
            <Metric label="Credit Total" value={money(totals.grand)} />
            <Metric label="Linked NCRs" value={String(ncrCases.length)} />
          </div>
        </div>
      </div>

      {ncrCases.length ? (
        <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Linked Commercial Failure NCRs</div>
          <div style={{ display: "grid", gap: 10 }}>
            {ncrCases.map((ncr) => {
              const relatedActions = capaActions.filter((row) => Number(row.ncr_case_id) === Number(ncr.id));
              return (
                <div key={ncr.id} style={{ border: "1px solid #edf1f6", borderRadius: 12, padding: 12, background: "#fbfcff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{ncr.ncr_number}</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>{ncr.defect_summary}</div>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.78 }}>
                      {ncrStatusLabel(ncr.status)} • {relatedActions.length} actions
                    </div>
                  </div>
                  {ncr.dispute_reason ? <div style={{ marginTop: 8, fontSize: 13 }}>Dispute: {ncr.dispute_reason}</div> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>Invoice Return Lines</div>
        {lines.length ? lines.map((line, index) => {
          const qtyReturn = num(line.qty_return);
          const lineTotal = qtyReturn * num(line.unit_price_invoice);
          const taxTotal = (lineTotal * num(line.gst_pct)) / 100;
          return (
            <div key={line.invoice_line_id || index} style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700 }}>L{index + 1} • {line.item_code || line.item_name || "Item"}</div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>{line.item_name || line.line_description || "—"}</div>
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>{line.uom || "UOM"}</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: 10, marginTop: 12 }}>
                <Metric label="Invoiced Qty" value={num(line.qty_invoiced).toFixed(4)} />
                <Metric label="Previously Returned" value={num(line.qty_previously_returned).toFixed(4)} />
                <Metric label="Pending Return" value={num(line.qty_pending_return).toFixed(4)} />
                <Metric label="Unit Price" value={money(line.unit_price_invoice)} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Qty Return
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={line.qty_return}
                    disabled={!isDraft}
                    onChange={(e) => updateLine(index, { qty_return: e.target.value })}
                    style={{ height: 34, padding: "0 8px" }}
                  />
                </label>
                <Metric label="Line Total" value={money(lineTotal)} />
                <Metric label="Tax Total" value={money(taxTotal)} />
              </div>

              <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                Line Remarks
                <input
                  value={line.remarks || ""}
                  disabled={!isDraft}
                  onChange={(e) => updateLine(index, { remarks: e.target.value })}
                  style={{ height: 34, padding: "0 8px" }}
                />
              </label>

              {line.serial_no_required ? (
                <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                  Serial Numbers
                  <textarea
                    value={line.serial_text || ""}
                    disabled={!isDraft}
                    onChange={(e) => updateLine(index, { serial_text: e.target.value })}
                    rows={4}
                    placeholder="One serial number per returned unit"
                    style={{ padding: 10 }}
                  />
                </label>
              ) : null}
            </div>
          );
        }) : <div style={{ opacity: 0.72 }}>No invoice lines available for return.</div>}
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={{ border: "1px solid #f1f1f1", borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.72 }}>{label}</div>
      <div style={{ fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}
