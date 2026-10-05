import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero } from "../shared/joshUi";

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

function fmtQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function pillStyle(ok) {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    borderRadius: 999,
    border: `1px solid ${ok ? "#cfe8d8" : "#f3c7c7"}`,
    background: ok ? "#f2fbf6" : "#fff5f5",
    color: ok ? "#0a7a35" : "#b00020",
    fontSize: 12,
    fontWeight: 700,
  };
}

const fieldInputStyle = {
  height: 36,
  padding: "0 10px",
  borderRadius: 10,
  border: "1px solid #d8e0ec",
  background: "#ffffff",
};

const EXCEPTION_BUCKETS = [
  ["all", "All open"],
  ["mismatch", "Qty mismatch"],
  ["over_invoiced", "Invoiced > received"],
  ["over_received", "Received > ordered"],
  ["short_close", "Short-close ready"],
  ["aging", "Stalled 7d+"],
  ["short_closed", "Short-closed"],
];

const AGE_BANDS = [
  ["all", "Any age"],
  ["0_7", "0–7 days"],
  ["8_30", "8–30 days"],
  ["31_plus", "31+ days"],
];

function bandColor(band) {
  if (band === "31_plus") return { tone: "#fff2f3", color: "#9f2042" };
  if (band === "8_30") return { tone: "#fff7ea", color: "#8b5a00" };
  return { tone: "#f6f7fb", color: "#58627a" };
}

function chipButtonStyle(active) {
  return {
    borderRadius: 999,
    border: `1px solid ${active ? "#2354d5" : "#d8e0ef"}`,
    background: active ? "#2354d5" : "#fff",
    color: active ? "#fff" : "#1f3556",
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
  };
}

export default function ThreeWayMatch({
  launch,
  onConsumeLaunch,
  onOpenGoodsReceipts = null,
  onOpenPurchaseInvoices = null,
  onOpenVendorPayments = null,
}) {
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [exceptionLoading, setExceptionLoading] = useState(false);
  const [shortCloseBusy, setShortCloseBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [exceptionBucket, setExceptionBucket] = useState("all");
  const [exceptionAgeBand, setExceptionAgeBand] = useState("all");
  const [exceptionCounts, setExceptionCounts] = useState({});
  const [ageBandCounts, setAgeBandCounts] = useState({});
  const [rowShortCloseId, setRowShortCloseId] = useState(null);
  const [rowShortCloseRemarks, setRowShortCloseRemarks] = useState("");
  const [poId, setPoId] = useState("");
  const [data, setData] = useState(null);
  const [shortCloseRemarks, setShortCloseRemarks] = useState("");

  async function loadBootstrap() {
    setLoading(true);
    setError("");
    try {
      const r = await apiFetch("/three-way-match/bootstrap");
      setPurchaseOrders(Array.isArray(r?.purchase_orders) ? r.purchase_orders : []);
    } catch (e) {
      setError(e?.data?.error || "Failed to load purchase orders.");
    } finally {
      setLoading(false);
    }
  }

  async function loadExceptions(bucket = exceptionBucket, band = exceptionAgeBand) {
    setExceptionLoading(true);
    try {
      const params = new URLSearchParams({ bucket: bucket || "all", age_band: band || "all" });
      const r = await apiFetch(`/three-way-match/exceptions?${params.toString()}`);
      setExceptions(Array.isArray(r?.exceptions) ? r.exceptions : []);
      setExceptionCounts(r?.counts || {});
      setAgeBandCounts(r?.age_bands || {});
    } catch (e) {
      setError(e?.data?.detail || e?.data?.error || "Failed to load exception queue.");
    } finally {
      setExceptionLoading(false);
    }
  }

  useEffect(() => {
    loadBootstrap();
    loadExceptions("all");
  }, []);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextPoId = Number(launch.po_id);
    if (Number.isFinite(nextPoId) && nextPoId > 0) {
      setPoId(String(nextPoId));
      loadPoDetail(nextPoId);
    }
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  async function loadPoDetail(nextPoId) {
    const id = Number(nextPoId);
    if (!Number.isFinite(id) || id <= 0) return;
    setDetailLoading(true);
    setError("");
    setNotice("");
    try {
      const r = await apiFetch(`/three-way-match/po/${id}`);
      setData(r);
      setPoId(String(id));
    } catch (e) {
      setError(e?.data?.error || "Failed to load match details.");
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!poId) return;
    loadPoDetail(poId);
  }, [poId]);

  async function shortClosePo(targetId = null, remarksOverride = null) {
    const id = Number(targetId || poId || data?.purchase_order?.id);
    if (!Number.isFinite(id) || id <= 0) return;
    const remarks = remarksOverride != null ? remarksOverride : shortCloseRemarks;
    setShortCloseBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await apiFetch(`/three-way-match/po/${id}/short-close`, {
        method: "POST",
        body: JSON.stringify({ remarks: remarks || null }),
      });
      setData(r);
      setPoId(String(id));
      setNotice(`${r?.purchase_order?.po_number || "PO"}: short-closed remaining qty ${fmtQty(r?.pending_qty_closed)}.`);
      setShortCloseRemarks("");
      setRowShortCloseId(null);
      setRowShortCloseRemarks("");
      await loadExceptions(exceptionBucket, exceptionAgeBand);
      await loadBootstrap();
    } catch (e) {
      const code = e?.data?.error;
      let message = e?.data?.detail || e?.data?.message || e?.data?.error || "Short-close failed.";
      if (code === "ALREADY_SHORT_CLOSED") message = "PO receipt is already short-closed.";
      else if (code === "NOTHING_TO_SHORT_CLOSE") message = "No remaining quantity to short-close.";
      else if (code === "PO_NOT_RECEIVABLE") message = "PO must be approved/closed to short-close remaining qty.";
      setError(String(message));
    } finally {
      setShortCloseBusy(false);
    }
  }

  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const summary = data?.summary || null;
  const flags = data?.flags || {};
  const mismatchCount = useMemo(() => lines.filter((l) => l.is_qty_mismatch).length, [lines]);
  const matchedCount = useMemo(() => lines.length - mismatchCount, [lines.length, mismatchCount]);
  const currentPoId = Number(data?.purchase_order?.id || poId || 0);

  return (
    <div style={{ maxWidth: 1240, display: "grid", gap: 16 }}>
      <PageHero
        eyebrow="Purchase Control"
        title="3-way match exception desk"
        description="Work the mismatch and short-close queue, inspect PO / GRN / invoice quantities, and jump to the desk that can clear the blocker."
        actions={
          <>
            <button
              type="button"
              onClick={() => {
                loadBootstrap();
                loadExceptions(exceptionBucket, exceptionAgeBand);
              }}
              disabled={loading || exceptionLoading}
            >
              Refresh
            </button>
            <button type="button" onClick={() => loadPoDetail(poId)} disabled={!poId || detailLoading}>
              {detailLoading ? "Loading..." : "Load Match"}
            </button>
          </>
        }
        stats={[
          { label: "Open exceptions", value: exceptionCounts.all ?? exceptions.length, tone: (exceptionCounts.all ?? exceptions.length) ? "#b00020" : "#0b7d45" },
          { label: "Stalled 31d+", value: ageBandCounts["31_plus"] ?? 0, tone: ageBandCounts["31_plus"] ? "#b00020" : "#0b7d45" },
          { label: "Matched lines", value: matchedCount, tone: "#0b7d45" },
          { label: "Mismatch lines", value: mismatchCount, tone: mismatchCount ? "#b00020" : "#0b7d45" },
          { label: "Current PO", value: data?.purchase_order?.po_number || "None", tone: "#7c3aed" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <DeskCard
        title="Exception queue"
        subtitle="Every open PO mismatch and short-close candidate for this company. Age = days since the last posted GRN or invoice."
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {EXCEPTION_BUCKETS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setExceptionBucket(value);
                loadExceptions(value, exceptionAgeBand);
              }}
              style={chipButtonStyle(exceptionBucket === value)}
            >
              {label}
              {exceptionCounts[value] != null ? ` (${exceptionCounts[value]})` : ""}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>Aging:</span>
          {AGE_BANDS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setExceptionAgeBand(value);
                loadExceptions(exceptionBucket, value);
              }}
              style={chipButtonStyle(exceptionAgeBand === value)}
            >
              {label}
              {value !== "all" && ageBandCounts[value] != null ? ` (${ageBandCounts[value]})` : ""}
            </button>
          ))}
        </div>
        {exceptionLoading ? (
          <div style={{ padding: 12, opacity: 0.72 }}>Loading exceptions…</div>
        ) : exceptions.length ? (
          <div style={{ display: "grid", gap: 10 }}>
            {exceptions.map((row) => (
              <div
                key={row.purchase_order_id}
                style={{
                  border: "1px solid #e7ebf3",
                  borderRadius: 14,
                  padding: 12,
                  background: Number(row.purchase_order_id) === currentPoId ? "#f5f8ff" : "#ffffff",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>{row.po_number}</div>
                    <div style={{ fontSize: 12, opacity: 0.72 }}>{row.vendor_name || "—"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {row.over_invoiced_lines > 0 ? <DeskChip label={`${row.over_invoiced_lines} invoiced > received`} tone="#fff2f3" color="#9f2042" /> : null}
                    {row.over_received_lines > 0 ? <DeskChip label={`${row.over_received_lines} received > ordered`} tone="#fff2f3" color="#9f2042" /> : null}
                    {row.can_short_close ? <DeskChip label={`Short-close ${fmtQty(row.pending_receive)} pending`} tone="#fff7ea" color="#8b5a00" /> : null}
                    {row.short_closed ? <DeskChip label="Short-closed" tone="#effcf3" color="#0b7d45" /> : null}
                    <DeskChip label={`Stalled ${row.stalled_days ?? 0}d`} {...bandColor(row.age_band)} />
                  </div>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                  {row.queue_reason}
                  {row.last_activity_at ? <span style={{ opacity: 0.65 }}> · last GRN/invoice {fmtDate(row.last_activity_at)}</span> : null}
                </div>
                {rowShortCloseId === row.purchase_order_id ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <input
                      placeholder="Short-close reason (vendor cannot supply, spec changed…)"
                      value={rowShortCloseRemarks}
                      onChange={(e) => setRowShortCloseRemarks(e.target.value)}
                      style={{ ...fieldInputStyle, flex: 1, minWidth: 220 }}
                      disabled={shortCloseBusy}
                    />
                    <button
                      type="button"
                      className="button-primary"
                      disabled={shortCloseBusy || !rowShortCloseRemarks.trim()}
                      onClick={() => shortClosePo(row.purchase_order_id, rowShortCloseRemarks.trim())}
                    >
                      {shortCloseBusy ? "Short-closing…" : `Confirm short-close ${fmtQty(row.pending_receive)}`}
                    </button>
                    <button type="button" className="button-ghost" disabled={shortCloseBusy} onClick={() => setRowShortCloseId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {row.recommended_action === "short_close" && rowShortCloseId !== row.purchase_order_id ? (
                    <button
                      type="button"
                      className="button-primary"
                      onClick={() => {
                        setRowShortCloseId(row.purchase_order_id);
                        setRowShortCloseRemarks("");
                      }}
                    >
                      Short-close remaining
                    </button>
                  ) : null}
                  {(row.recommended_action === "post_draft_grn" || row.recommended_action === "return_or_amend") &&
                  typeof onOpenGoodsReceipts === "function" ? (
                    <button type="button" className="button-primary" onClick={() => onOpenGoodsReceipts({ po_id: row.purchase_order_id, q: row.po_number })}>
                      {row.recommended_action_label}
                    </button>
                  ) : null}
                  {row.recommended_action === "hold_invoice" && typeof onOpenPurchaseInvoices === "function" ? (
                    <button type="button" className="button-primary" onClick={() => onOpenPurchaseInvoices({ po_id: row.purchase_order_id, q: row.po_number })}>
                      {row.recommended_action_label}
                    </button>
                  ) : null}
                  {row.recommended_action === "hold_invoice" && typeof onOpenVendorPayments === "function" ? (
                    <button type="button" className="button-ghost" onClick={() => onOpenVendorPayments({ q: row.vendor_name || row.po_number })}>
                      Check vendor payments
                    </button>
                  ) : null}
                  <button type="button" className="button-ghost" onClick={() => loadPoDetail(row.purchase_order_id)}>
                    Inspect lines
                  </button>
                  {typeof onOpenGoodsReceipts === "function" ? (
                    <button type="button" className="button-ghost" onClick={() => onOpenGoodsReceipts({ po_id: row.purchase_order_id, q: row.po_number })}>
                      Open GRN
                    </button>
                  ) : null}
                  {typeof onOpenPurchaseInvoices === "function" ? (
                    <button type="button" className="button-ghost" onClick={() => onOpenPurchaseInvoices({ po_id: row.purchase_order_id, q: row.po_number })}>
                      Open PI
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: 14, borderRadius: 12, border: "1px dashed #d5dcec", opacity: 0.76 }}>No exceptions in this bucket.</div>
        )}
      </DeskCard>

      <DeskCard title="Pick Purchase Order" subtitle="Load one PO at a time so matching review stays focused and audit-friendly.">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Purchase Order
            <select value={poId} onChange={(e) => setPoId(e.target.value)} style={fieldInputStyle}>
              <option value="">Select PO</option>
              {purchaseOrders.map((po) => (
                <option key={po.id} value={String(po.id)}>
                  {po.po_number} • {po.vendor_name} • {fmtDate(po.po_date)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => loadPoDetail(poId)} disabled={!poId || detailLoading}>
            {detailLoading ? "Loading..." : "Load"}
          </button>
        </div>
      </DeskCard>

      {data?.purchase_order ? (
        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16 }}>
          <DeskCard title="PO Snapshot" subtitle="Context first: vendor, date, status, then the action that clears the exception.">
            <div style={{ fontSize: 13, lineHeight: 1.9 }}>
              <div>PO: {data.purchase_order.po_number}</div>
              <div>Vendor: {data.purchase_order.vendor_name}</div>
              <div>Date: {fmtDate(data.purchase_order.po_date)}</div>
              <div>Status: {data.purchase_order.po_status}</div>
              <div>Age: {flags.age_days ?? "—"} days</div>
              {flags.short_closed ? <div style={{ color: "#0a7a35" }}>Receipt short-closed</div> : null}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {typeof onOpenGoodsReceipts === "function" ? (
                <button type="button" onClick={() => onOpenGoodsReceipts({ po_id: currentPoId, q: data.purchase_order.po_number })}>
                  Open GRN
                </button>
              ) : null}
              {typeof onOpenPurchaseInvoices === "function" ? (
                <button type="button" onClick={() => onOpenPurchaseInvoices({ po_id: currentPoId, q: data.purchase_order.po_number })}>
                  Open purchase invoices
                </button>
              ) : null}
              {typeof onOpenVendorPayments === "function" ? (
                <button type="button" onClick={() => onOpenVendorPayments({ q: data.purchase_order.vendor_name || data.purchase_order.po_number })}>
                  Open vendor payments
                </button>
              ) : null}
            </div>
          </DeskCard>

          <DeskCard title="Match Summary (Qty)" subtitle="Mismatch and short-close actions live here — not only inspection.">
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
              <div style={{ flex: 1 }} />
              <DeskChip
                label={mismatchCount === 0 ? "Matched" : "Mismatch detected"}
                tone={mismatchCount === 0 ? "#effcf3" : "#fff2f3"}
                color={mismatchCount === 0 ? "#0b7d45" : "#9f2042"}
              />
            </div>
            {summary ? (
              <div style={{ fontSize: 13, lineHeight: 1.9 }}>
                <div>Ordered: {fmtQty(summary.ordered)}</div>
                <div>Received (Posted): {fmtQty(summary.received_posted)}</div>
                <div>Received (Draft): {fmtQty(summary.received_draft)}</div>
                <div>Invoiced (Posted): {fmtQty(summary.invoiced_posted)}</div>
                <div>Invoiced (Draft): {fmtQty(summary.invoiced_draft)}</div>
                <div>Pending receive: {fmtQty(summary.pending_receive)}</div>
                <div style={{ marginTop: 8 }}>Mismatch lines: {summary.mismatch_lines}</div>
              </div>
            ) : (
              <div style={{ opacity: 0.72 }}>No summary</div>
            )}
            {flags.can_short_close ? (
              <div style={{ marginTop: 14, display: "1px solid #f0dfb0", borderRadius: 12, padding: 12, background: "#fffaf0", display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Short-close remaining receipt qty</div>
                <div style={{ fontSize: 12, opacity: 0.78 }}>Closes unreceived balance on this PO after partial GRN. Same control as Goods Receipts.</div>
                <input
                  value={shortCloseRemarks}
                  onChange={(e) => setShortCloseRemarks(e.target.value)}
                  placeholder="Remarks (optional)"
                  style={{ ...fieldInputStyle, width: "100%" }}
                />
                <button type="button" disabled={shortCloseBusy} onClick={() => shortClosePo()}>
                  {shortCloseBusy ? "Short-closing…" : "Short-close remaining"}
                </button>
              </div>
            ) : null}
          </DeskCard>
        </div>
      ) : null}

      {data?.purchase_order ? (
        <DeskCard title="Line Match" subtitle="The line table is the decision surface. Jump to exceptions with the status column.">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "60px 180px 1fr 110px 130px 130px 130px 130px 90px",
              gap: 8,
              padding: 12,
              fontSize: 12,
              opacity: 0.8,
              borderBottom: "1px solid #e5e5e5",
            }}
          >
            <div>#</div>
            <div>Item</div>
            <div>Description</div>
            <div>Ordered</div>
            <div>GRN Posted</div>
            <div>GRN Draft</div>
            <div>INV Posted</div>
            <div>INV Draft</div>
            <div>Status</div>
          </div>
          {detailLoading ? (
            <div style={{ padding: 12 }}>Loading…</div>
          ) : lines.length ? (
            lines.map((line) => {
              const ok = !line.is_qty_mismatch;
              const label = line.item_code || line.item_name || "—";
              const desc = line.line_description || line.item_name || "—";
              return (
                <div
                  key={line.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "60px 180px 1fr 110px 130px 130px 130px 130px 90px",
                    gap: 8,
                    padding: 12,
                    borderBottom: "1px solid #f2f2f2",
                    fontSize: 13,
                    alignItems: "center",
                  }}
                >
                  <div>{line.line_no}</div>
                  <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{label}</div>
                  <div style={{ opacity: 0.85 }}>{desc}</div>
                  <div>{fmtQty(line.qty_ordered)}</div>
                  <div>{fmtQty(line.qty_received_posted)}</div>
                  <div>{fmtQty(line.qty_received_draft)}</div>
                  <div>{fmtQty(line.qty_invoiced_posted)}</div>
                  <div>{fmtQty(line.qty_invoiced_draft)}</div>
                  <div>
                    <span style={pillStyle(ok)}>{ok ? "OK" : "Check"}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{ padding: 12, opacity: 0.72 }}>No PO lines found.</div>
          )}
        </DeskCard>
      ) : null}
    </div>
  );
}
