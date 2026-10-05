import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskStat, EmptyState, toast, useSubmitLock } from "../shared/joshUi";

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

function statusTone(status) {
  const s = String(status || "").toLowerCase();
  if (s === "issued") return "#eef4ff";
  if (s === "converted") return "#effcf3";
  if (s === "adjusted") return "#fff8e8";
  if (s === "cancelled" || s === "expired") return "#fff3f3";
  return "#f6f7fb";
}

function statusColor(status) {
  const s = String(status || "").toLowerCase();
  if (s === "issued") return "#234a8f";
  if (s === "converted") return "#0b7d45";
  if (s === "adjusted") return "#8b5a00";
  if (s === "cancelled" || s === "expired") return "#b00020";
  return "#58627a";
}

export default function ProformaInvoices({ openProformaId, launch, onConsumeLaunch, onOpenSalesOrder, onOpenInvoice }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [listQuery, setListQuery] = useState("");
  const [listStatus, setListStatus] = useState("");

  const stats = useMemo(() => {
    const total = items.length;
    const draft = items.filter((i) => i.proforma_status === "draft").length;
    const issued = items.filter((i) => i.proforma_status === "issued").length;
    const converted = items.filter((i) => i.proforma_status === "converted").length;
    return { total, draft, issued, converted };
  }, [items]);

  async function loadList(overrides = {}) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const qText = overrides.q !== undefined ? overrides.q : listQuery;
      const status = overrides.status !== undefined ? overrides.status : listStatus;
      if (qText) params.set("q", qText);
      if (status) params.set("status", status);
      if (overrides.sales_order_id) params.set("sales_order_id", overrides.sales_order_id);
      const data = await apiFetch(`/proforma-invoices${params.toString() ? `?${params}` : ""}`);
      setItems(Array.isArray(data?.proformas) ? data.proformas : []);
    } catch (e) {
      setError(e?.data?.error || "Failed to load proformas.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") loadList();
  }, [view.type]);

  useEffect(() => {
    if (openProformaId) setView({ type: "detail", id: Number(openProformaId) });
  }, [openProformaId]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    if (launch.proforma_id) {
      setView({ type: "detail", id: Number(launch.proforma_id) });
    } else if (launch.sales_order_id) {
      setView({ type: "create", sales_order_id: Number(launch.sales_order_id), payment_milestone_id: launch.payment_milestone_id || null });
    }
    onConsumeLaunch?.();
  }, [launch]);

  if (view.type === "detail") {
    return (
      <ProformaDetail
        id={view.id}
        onBack={() => setView({ type: "list" })}
        onOpenSalesOrder={onOpenSalesOrder}
        onOpenInvoice={onOpenInvoice}
        onNotice={(msg) => setNotice(msg)}
      />
    );
  }

  if (view.type === "create") {
    return (
      <CreateProforma
        salesOrderId={view.sales_order_id}
        paymentMilestoneId={view.payment_milestone_id}
        onBack={() => setView({ type: "list" })}
        onCreated={(id) => setView({ type: "detail", id })}
      />
    );
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.56 }}>Proforma Desk</div>
          <h2 style={{ margin: "6px 0 0" }}>Advance & milestone billing</h2>
          <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>Isolated from AR ageing — convert to tax invoice when supply/payment milestones are met.</div>
        </div>
        <button type="button" onClick={() => loadList()}>Refresh</button>
      </div>

      {error ? <div style={{ color: "#b00020", marginBottom: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginBottom: 12 }}>{notice}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: 12, marginBottom: 16 }}>
        <DeskStat label="Total" value={stats.total} tone="#143d7a" />
        <DeskStat label="Draft" value={stats.draft} tone="#8b5a00" />
        <DeskStat label="Issued" value={stats.issued} tone="#234a8f" />
        <DeskStat label="Converted" value={stats.converted} tone="#0a7a35" />
      </div>

      <DeskCard title="Proforma queue" subtitle="Filter and open a proforma">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <input placeholder="Search number / customer / SO" value={listQuery} onChange={(e) => setListQuery(e.target.value)} style={{ minWidth: 220 }} />
          <select value={listStatus} onChange={(e) => setListStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="issued">Issued</option>
            <option value="converted">Converted</option>
            <option value="adjusted">Adjusted</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button type="button" onClick={() => loadList()}>Apply</button>
        </div>
        {loading ? <div>Loading…</div> : null}
        {!loading && !items.length ? <EmptyState title="No proformas" body="Create a proforma from a confirmed sales order." /> : null}
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView({ type: "detail", id: item.id })}
              style={{
                textAlign: "left",
                border: "1px solid #e7ebf3",
                borderRadius: 14,
                padding: 14,
                background: "#fff",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>{item.proforma_number}</div>
                  <div style={{ fontSize: 13, opacity: 0.7 }}>
                    {item.customer_name || "—"} · SO {item.so_number || "—"} · {item.billing_basis || "—"}
                    {item.billed_percent != null ? ` · ${Number(item.billed_percent)}%` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <DeskChip label={String(item.proforma_status || "").toUpperCase()} tone={statusTone(item.proforma_status)} color={statusColor(item.proforma_status)} />
                  <span style={{ fontWeight: 700 }}>{fmtMoney(item.grand_total_proforma, item.proforma_currency_code)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </DeskCard>
    </div>
  );
}

function CreateProforma({ salesOrderId, paymentMilestoneId, onBack, onCreated }) {
  const { busy, runLocked } = useSubmitLock();
  const [error, setError] = useState("");
  const [basis, setBasis] = useState(paymentMilestoneId ? "milestone" : "adhoc");
  const [percent, setPercent] = useState("50");
  const [milestoneId, setMilestoneId] = useState(paymentMilestoneId ? String(paymentMilestoneId) : "");
  const [milestones, setMilestones] = useState([]);
  const [remarks, setRemarks] = useState("");

  useEffect(() => {
    apiFetch(`/sales-orders/${salesOrderId}/payment-milestones`)
      .then((data) => setMilestones(Array.isArray(data?.milestones) ? data.milestones : []))
      .catch(() => setMilestones([]));
  }, [salesOrderId]);

  async function create() {
    await runLocked("create", async () => {
      setError("");
      try {
        const body = {
          billing_basis: basis,
          remarks: remarks || null,
        };
        if (basis === "milestone") {
          body.payment_milestone_id = Number(milestoneId);
        } else if (basis === "adhoc") {
          body.billed_percent = Number(percent);
        }
        const data = await apiFetch(`/proforma-invoices/from-sales-order/${salesOrderId}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        toast("Proforma created.", "success");
        onCreated?.(data?.proforma?.id);
      } catch (e) {
        const message = e?.data?.error || "Failed to create proforma.";
        setError(message);
        toast(message, "error");
      }
    });
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <button type="button" onClick={onBack}>Back</button>
      <h2>Create Proforma · SO #{salesOrderId}</h2>
      {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
      <DeskCard title="Billing basis" subtitle="Milestone / percent adhoc (qty splits use remaining SO lines via API lines[])">
        <label style={{ display: "grid", gap: 6, marginBottom: 12 }}>
          Basis
          <select value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="milestone">Milestone</option>
            <option value="adhoc">Adhoc %</option>
            <option value="qty">Quantity (enter after create via edit)</option>
          </select>
        </label>
        {basis === "milestone" ? (
          <label style={{ display: "grid", gap: 6, marginBottom: 12 }}>
            Milestone
            <select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
              <option value="">Select…</option>
              {milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.milestone_name} ({m.milestone_percent}%)
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {basis === "adhoc" ? (
          <label style={{ display: "grid", gap: 6, marginBottom: 12 }}>
            Billed %
            <input type="number" min="0.01" max="100" step="0.01" value={percent} onChange={(e) => setPercent(e.target.value)} />
          </label>
        ) : null}
        <label style={{ display: "grid", gap: 6, marginBottom: 12 }}>
          Remarks
          <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </label>
        <button type="button" disabled={busy} onClick={create}>{busy ? "Working…" : "Create Proforma"}</button>
      </DeskCard>
    </div>
  );
}

function ProformaDetail({ id, onBack, onOpenSalesOrder, onOpenInvoice, onNotice }) {
  const { busy, isBusy, runLocked } = useSubmitLock();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [proforma, setProforma] = useState(null);
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState("draft");
  const [remarks, setRemarks] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/proforma-invoices/${id}`);
      setProforma(data?.proforma || null);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setStatus(data?.proforma?.proforma_status || "draft");
      setRemarks(data?.proforma?.remarks || "");
    } catch (e) {
      setError(e?.data?.error || "Failed to load proforma.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function save() {
    await runLocked("save", async () => {
      setError("");
      try {
        const data = await apiFetch(`/proforma-invoices/${id}`, {
          method: "PUT",
          body: JSON.stringify({ proforma_status: status, remarks }),
        });
        setProforma(data?.proforma || proforma);
        setLines(Array.isArray(data?.lines) ? data.lines : lines);
        toast("Proforma updated.", "success");
        onNotice?.("Proforma updated.");
      } catch (e) {
        const message = e?.data?.error || "Failed to update.";
        setError(message);
        toast(message, "error");
      }
    });
  }

  async function convert() {
    await runLocked("convert", async () => {
      setError("");
      try {
        const data = await apiFetch(`/proforma-invoices/${id}/convert-to-invoice`, { method: "POST" });
        toast("Tax invoice created from proforma.", "success");
        onNotice?.("Converted to tax invoice.");
        if (data?.invoice?.id && onOpenInvoice) onOpenInvoice(data.invoice.id);
        else await load();
      } catch (e) {
        const message = e?.data?.error || "Conversion failed.";
        setError(message);
        toast(message, "error");
      }
    });
  }

  if (loading) return <div>Loading proforma…</div>;
  if (!proforma) {
    return (
      <div>
        <button type="button" onClick={onBack}>Back</button>
        <div style={{ color: "#b00020" }}>{error || "Not found"}</div>
      </div>
    );
  }

  const canConvert = ["issued", "adjusted"].includes(String(proforma.proforma_status)) && !proforma.converted_invoice_id;

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button type="button" onClick={onBack}>Back</button>
        <a href={`/proforma-invoices/${id}/pdf`} target="_blank" rel="noreferrer" style={{ border: "1px solid #d0d0d0", borderRadius: 6, padding: "8px 12px", textDecoration: "none", color: "#111" }}>
          Download PDF
        </a>
        {proforma.sales_order_id && onOpenSalesOrder ? (
          <button type="button" onClick={() => onOpenSalesOrder(proforma.sales_order_id)}>Open Sales Order</button>
        ) : null}
        {proforma.converted_invoice_id && onOpenInvoice ? (
          <button type="button" onClick={() => onOpenInvoice(proforma.converted_invoice_id)}>Open Tax Invoice</button>
        ) : null}
        {canConvert ? (
          <button type="button" disabled={busy} onClick={convert}>
            {isBusy("convert") ? "Converting…" : "Convert to Tax Invoice"}
          </button>
        ) : null}
      </div>

      <h2 style={{ marginTop: 0 }}>{proforma.proforma_number}</h2>
      <DeskChip label={String(proforma.proforma_status || "").toUpperCase()} tone={statusTone(proforma.proforma_status)} color={statusColor(proforma.proforma_status)} />

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <DeskCard title="Snapshot" subtitle="Commercial context (not AR)">
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>Customer: {proforma.customer_name || "—"}</div>
            <div>SO: {proforma.so_number || "—"}</div>
            <div>Basis: {proforma.billing_basis || "—"}{proforma.billed_percent != null ? ` · ${Number(proforma.billed_percent)}%` : ""}</div>
            <div>Milestone: {proforma.milestone_name || "—"}</div>
            <div>Date: {fmtDate(proforma.proforma_date)} · Valid till: {fmtDate(proforma.valid_till)}</div>
            <div>Grand: {fmtMoney(proforma.grand_total_proforma, proforma.proforma_currency_code)}</div>
          </div>
        </DeskCard>
        <DeskCard title="Control" subtitle="Draft → Issued → Convert">
          <label style={{ display: "grid", gap: 6, marginBottom: 12 }}>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={["converted", "adjusted"].includes(proforma.proforma_status)}>
              <option value="draft">Draft</option>
              <option value="issued">Issued</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 6, marginBottom: 12 }}>
            Remarks
            <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </label>
          <button type="button" disabled={busy || ["converted"].includes(proforma.proforma_status)} onClick={save}>
            {isBusy("save") ? "Saving…" : "Save"}
          </button>
        </DeskCard>
      </div>

      <DeskCard title="Lines" subtitle="Collection instrument lines — conversion prices from sales order">
        <div style={{ display: "grid", gap: 8 }}>
          {lines.map((line) => (
            <div key={line.id} style={{ border: "1px solid #e7ebf3", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 700 }}>L{line.line_no} · {line.item_code || line.item_name || "—"}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                Qty {line.qty} · {fmtMoney(line.unit_price_proforma)} · GST {line.gst_pct}% · {fmtMoney(line.line_total_proforma)}
              </div>
            </div>
          ))}
        </div>
      </DeskCard>
    </div>
  );
}
