import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskStat, MiniMetric, NoticeBanner, PageHero, FieldLabel, getDeskStatusAppearance } from "../shared/joshUi";

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

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function qty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function fmtQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return qty(n).toFixed(4);
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return money(n).toFixed(2);
}

const BUCKETS = [
  { key: "all", label: "All orders" },
  { key: "overdue", label: "Overdue" },
  { key: "draft", label: "Draft" },
  { key: "sent", label: "Sent" },
  { key: "partial_received", label: "Partial received" },
  { key: "received", label: "Received" },
  { key: "closed", label: "Closed" },
  { key: "cancelled", label: "Cancelled" },
];

export default function Subcontracting({ launch, onConsumeLaunch }) {
  const [view, setView] = useState({ type: "list" });
  const [bootstrap, setBootstrap] = useState({ vendors: [] });
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [listQuery, setListQuery] = useState("");
  const [listBucket, setListBucket] = useState("all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creatingVendorId, setCreatingVendorId] = useState("");
  const [creatingDueDate, setCreatingDueDate] = useState("");
  const [creatingRemarks, setCreatingRemarks] = useState("");
  const [creating, setCreating] = useState(false);

  const rowStats = useMemo(() => {
    const total = rows.length;
    const overdue = rows.filter((r) => {
      const status = String(r.subcontract_status || "").toLowerCase();
      if (["closed", "cancelled"].includes(status)) return false;
      if (!r.due_date) return false;
      const d = new Date(r.due_date);
      if (Number.isNaN(d.getTime())) return false;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      d.setHours(0, 0, 0, 0);
      return d < today;
    }).length;
    return { total, overdue };
  }, [rows]);

  async function loadBootstrap() {
    const data = await apiFetch("/subcontracting/bootstrap");
    setBootstrap({ vendors: Array.isArray(data?.vendors) ? data.vendors : [] });
  }

  async function loadSummary() {
    setSummaryLoading(true);
    setError("");
    try {
      const data = await apiFetch("/subcontracting/summary");
      setSummary(data?.summary || null);
    } catch (e) {
      setSummary(null);
      setError(getApiErrorMessage(e, "Failed to load subcontracting summary."));
    } finally {
      setSummaryLoading(false);
    }
  }

  async function loadList(overrides = {}) {
    setLoading(true);
    setError("");
    try {
      const q = overrides.q !== undefined ? overrides.q : listQuery;
      const bucket = overrides.bucket !== undefined ? overrides.bucket : listBucket;
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (bucket && bucket !== "all") params.set("bucket", bucket);
      const query = params.toString();
      const data = await apiFetch(`/subcontracting${query ? `?${query}` : ""}`);
      setRows(Array.isArray(data?.orders) ? data.orders : []);
    } catch (e) {
      setRows([]);
      setError(getApiErrorMessage(e, "Failed to load subcontract orders."));
    } finally {
      setLoading(false);
    }
  }

  async function startOrder() {
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const vendorId = Number(creatingVendorId);
      const data = await apiFetch("/subcontracting/start", {
        method: "POST",
        body: JSON.stringify({
          vendor_id: Number.isFinite(vendorId) && vendorId > 0 ? vendorId : undefined,
          due_date: creatingDueDate || undefined,
          remarks: creatingRemarks || undefined,
        }),
      });
      const id = Number(data?.subcontract_order_id);
      if (Number.isFinite(id) && id > 0) {
        setCreatingVendorId("");
        setCreatingDueDate("");
        setCreatingRemarks("");
        setView({ type: "detail", id });
      } else {
        setError("Failed to start subcontract order.");
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to start subcontract order."));
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadSummary().catch(() => {});
      loadList().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextQuery = typeof launch.q === "string" ? launch.q : "";
    const nextBucket = typeof launch.bucket === "string" ? launch.bucket : "all";
    setListQuery(nextQuery);
    setListBucket(nextBucket);
    if (view.type !== "list") setView({ type: "list" });
    loadSummary().catch(() => {});
    loadList({ q: nextQuery, bucket: nextBucket }).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  if (view.type === "detail") {
    return (
      <SubcontractOrderDetail
        id={view.id}
        vendors={bootstrap.vendors}
        onBack={() => {
          setView({ type: "list" });
          loadSummary().catch(() => {});
          loadList().catch(() => {});
        }}
        onNotice={(msg) => setNotice(msg)}
      />
    );
  }

  return (
    <div style={{ maxWidth: 1520 }}>
      <PageHero
        eyebrow="Outside Processing Ledger"
        title="Subcontracting"
        description="Create subcontract orders, track send/receive movements, and keep overdue outside processing visible as a queue."
        actions={
          <>
            <button
              onClick={() => {
                loadSummary().catch(() => {});
                loadList().catch(() => {});
              }}
              disabled={loading || summaryLoading}
            >
              {loading || summaryLoading ? "Refreshing..." : "Refresh"}
            </button>
          </>
        }
        stats={[
          { label: "Orders in view", value: rowStats.total, tone: "#143d7a" },
          { label: "Overdue in view", value: rowStats.overdue, tone: "#9f2042" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(360px, 0.9fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Subcontract Queue" subtitle="Filter, open, and drill through outside processing orders">
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input value={listQuery} onChange={(e) => setListQuery(e.target.value)} placeholder="Search number / vendor / job card" style={{ minWidth: 260 }} />
              <select value={listBucket} onChange={(e) => setListBucket(e.target.value)}>
                {BUCKETS.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </select>
              <button onClick={() => loadList().catch(() => {})} disabled={loading}>
                {loading ? "Loading..." : "Load"}
              </button>
            </div>

            <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
              {rows.map((row) => {
                const status = String(row.subcontract_status || "draft").toLowerCase();
                const appearance = getDeskStatusAppearance(status, {
                  success: ["received", "closed"],
                  info: ["sent", "partial_received"],
                  danger: ["overdue", "cancelled"],
                  warning: ["draft"],
                });
                const overdue =
                  !["closed", "cancelled"].includes(status) && row.due_date ? new Date(row.due_date).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0) : false;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => setView({ type: "detail", id: Number(row.id) })}
                    style={{
                      textAlign: "left",
                      border: "1px solid #e6ebf2",
                      borderRadius: 18,
                      padding: 14,
                      background: "#ffffff",
                      display: "grid",
                      gap: 10,
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ display: "grid", gap: 2 }}>
                        <div style={{ fontWeight: 850 }}>{row.subcontract_number}</div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          {row.vendor_name || "Vendor pending"}
                          {row.job_card_number ? ` • ${row.job_card_number}` : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {overdue ? <DeskChip label="OVERDUE" tone="#fff2f3" color="#9f2042" /> : null}
                        <DeskChip label={status.replaceAll("_", " ").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Due" value={fmtDate(row.due_date)} />
                      <MiniMetric label="Ordered" value={fmtQty(row.ordered_qty)} />
                      <MiniMetric label="Sent" value={fmtQty(row.sent_qty)} />
                      <MiniMetric label="Received" value={fmtQty(row.received_qty)} />
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.74 }}>
                      Amount (base): <strong>{fmtMoney(row.amount_base)}</strong>
                    </div>
                  </button>
                );
              })}
              {!rows.length ? <div style={{ fontSize: 12, opacity: 0.7 }}>{loading ? "Loading subcontract queue…" : "No subcontract orders found."}</div> : null}
            </div>
          </DeskCard>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Subcontracting Signals" subtitle="Overdue and status spread">
            {summary ? (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                  <DeskStat label="Total" value={summary.total || 0} tone="#143d7a" />
                  <DeskStat label="Overdue" value={summary.overdue || 0} tone="#9f2042" />
                  <DeskStat label="Draft" value={summary.draft || 0} tone="#8b5a00" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                  <MiniMetric label="Sent" value={summary.sent || 0} />
                  <MiniMetric label="Partial received" value={summary.partial_received || 0} />
                  <MiniMetric label="Received" value={summary.received || 0} />
                  <MiniMetric label="Closed" value={summary.closed || 0} />
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    onClick={() => {
                      setListBucket("overdue");
                      loadList({ bucket: "overdue" }).catch(() => {});
                    }}
                  >
                    Overdue Queue
                  </button>
                  <button
                    onClick={() => {
                      setListBucket("draft");
                      loadList({ bucket: "draft" }).catch(() => {});
                    }}
                  >
                    Draft Queue
                  </button>
                  <button
                    onClick={() => {
                      setListBucket("sent");
                      loadList({ bucket: "sent" }).catch(() => {});
                    }}
                  >
                    Sent Queue
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.72 }}>{summaryLoading ? "Loading subcontracting summary…" : "Subcontracting summary not available."}</div>
            )}
          </DeskCard>

          <DeskCard title="Start Subcontract Order" subtitle="Allocate a new SC number and begin capturing outside processing movements">
            <div style={{ display: "grid", gap: 10 }}>
              <FieldLabel label="Vendor">
                <select value={creatingVendorId} onChange={(e) => setCreatingVendorId(e.target.value)}>
                  <option value="">Select vendor (optional)</option>
                  {bootstrap.vendors.map((v) => (
                    <option key={v.id} value={String(v.id)}>
                      {v.company_name}
                    </option>
                  ))}
                </select>
              </FieldLabel>
              <FieldLabel label="Due date">
                <input type="date" value={creatingDueDate} onChange={(e) => setCreatingDueDate(e.target.value)} />
              </FieldLabel>
              <FieldLabel label="Remarks">
                <input value={creatingRemarks} onChange={(e) => setCreatingRemarks(e.target.value)} placeholder="Optional operator note" />
              </FieldLabel>
              <button onClick={() => startOrder().catch(() => {})} disabled={creating}>
                {creating ? "Starting..." : "Start Order"}
              </button>
            </div>
          </DeskCard>
        </div>
      </div>
    </div>
  );
}

function SubcontractOrderDetail({ id, vendors, onBack, onNotice }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [order, setOrder] = useState(null);
  const [lines, setLines] = useState([]);
  const [movements, setMovements] = useState([]);

  const [vendorId, setVendorId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [closeMode, setCloseMode] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);

  const [movementLineId, setMovementLineId] = useState("");
  const [movementType, setMovementType] = useState("send");
  const [movementQty, setMovementQty] = useState("");
  const [movementDate, setMovementDate] = useState("");

  const status = String(order?.subcontract_status || "draft").toLowerCase();
  const isLocked = ["closed", "cancelled"].includes(status);

  const statusAppearance = getDeskStatusAppearance(status, {
    success: ["received", "closed"],
    info: ["sent", "partial_received"],
    danger: ["cancelled"],
    warning: ["draft"],
  });

  function syncFromHeader(header) {
    setVendorId(header?.vendor_id ? String(header.vendor_id) : "");
    setDueDate(toIsoDate(header?.due_date || ""));
    setRemarks(header?.remarks || "");
    setCloseMode("");
  }

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/subcontracting/${id}`);
      if (!data?.ok) {
        setError("Failed to load subcontract order.");
        setOrder(null);
        setLines([]);
        setMovements([]);
        return;
      }
      const header = data?.order || null;
      setOrder(header);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setMovements(Array.isArray(data?.movements) ? data.movements : []);
      syncFromHeader(header);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load subcontract order."));
      setOrder(null);
      setLines([]);
      setMovements([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, [id]);

  function updateLine(index, patch) {
    setLines((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, ...patch };
        const q = qty(next.qty_ordered || 0);
        const rate = qty(next.unit_rate_base || 0);
        return {
          ...next,
          qty_ordered: q,
          unit_rate_base: rate,
          amount_base: money(q * rate),
        };
      })
    );
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
      const data = await apiFetch(`/subcontracting/product-lookup?q=${encodeURIComponent(q)}`);
      setSearchResults(Array.isArray(data?.products) ? data.products : []);
    } catch (e) {
      setSearchResults([]);
      setError(getApiErrorMessage(e, "Product lookup failed."));
    } finally {
      setSearching(false);
    }
  }

  function addProduct(product) {
    setLines((prev) => [
      ...prev,
      {
        id: null,
        product_id: product.id,
        item_code: product.item_code || "",
        item_name: product.item_name || "",
        uom: product.uom || "",
        description: product.item_name || "",
        qty_ordered: 1,
        qty_sent: 0,
        qty_received: 0,
        unit_rate_base: 0,
        amount_base: 0,
        remarks: "",
      },
    ]);
    setSearchTerm("");
    setSearchResults([]);
  }

  async function save() {
    if (!order) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const closeStatus = closeMode === "close" ? "closed" : closeMode === "cancel" ? "cancelled" : undefined;
      const payloadLines = lines.map((l) => ({
        id: l.id || undefined,
        product_id: l.product_id,
        description: l.description || l.item_name || "",
        qty_ordered: qty(l.qty_ordered || 0),
        unit_rate_base: qty(l.unit_rate_base || 0),
        remarks: l.remarks || "",
      }));
      const data = await apiFetch(`/subcontracting/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          vendor_id: vendorId ? Number(vendorId) : null,
          due_date: dueDate || null,
          remarks: remarks || "",
          subcontract_status: closeStatus,
          lines: payloadLines,
        }),
      });
      const header = data?.order || null;
      setOrder(header);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setMovements(Array.isArray(data?.movements) ? data.movements : []);
      syncFromHeader(header);
      setNotice("Subcontract order saved.");
      if (typeof onNotice === "function") onNotice("Subcontract order saved.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save subcontract order."));
    } finally {
      setSaving(false);
    }
  }

  const movementCandidates = useMemo(() => {
    return lines.map((l) => {
      const ordered = qty(l.qty_ordered || 0);
      const sent = qty(l.qty_sent || 0);
      const received = qty(l.qty_received || 0);
      const remainingToSend = qty(Math.max(ordered - sent, 0));
      const remainingToReceive = qty(Math.max(sent - received, 0));
      return {
        id: l.id,
        label: `${l.line_no ? `${l.line_no}. ` : ""}${l.item_code || ""} ${l.item_name || ""}`.trim(),
        remainingToSend,
        remainingToReceive,
      };
    });
  }, [lines]);

  useEffect(() => {
    if (!movementCandidates.length) return;
    if (movementLineId) return;
    const first = movementCandidates.find((c) => c.remainingToSend > 0.0001 || c.remainingToReceive > 0.0001);
    if (first?.id) setMovementLineId(String(first.id));
  }, [movementCandidates, movementLineId]);

  async function recordMovement() {
    if (!order) return;
    const lineId = Number(movementLineId);
    const q = qty(movementQty);
    if (!Number.isFinite(lineId) || lineId <= 0) {
      setError("Select a line first.");
      return;
    }
    if (!q || q <= 0) {
      setError("Enter a valid movement qty.");
      return;
    }
    setMoving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/subcontracting/${id}/movement`, {
        method: "POST",
        body: JSON.stringify({
          subcontract_order_line_id: lineId,
          movement_type: movementType,
          qty: q,
          movement_date: movementDate || undefined,
        }),
      });
      const header = data?.order || null;
      setOrder(header);
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setMovements(Array.isArray(data?.movements) ? data.movements : []);
      syncFromHeader(header);
      setMovementQty("");
      setNotice("Movement recorded.");
      if (typeof onNotice === "function") onNotice("Subcontract movement recorded.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to record movement."));
    } finally {
      setMoving(false);
    }
  }

  if (loading) return <div>Loading subcontract order…</div>;

  if (!order) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <NoticeBanner tone="error" message={error || "Subcontract order not found."} />
      </div>
    );
  }

  const totals = lines.reduce(
    (acc, l) => {
      acc.ordered += qty(l.qty_ordered || 0);
      acc.sent += qty(l.qty_sent || 0);
      acc.received += qty(l.qty_received || 0);
      acc.amount += money(l.amount_base || 0);
      return acc;
    },
    { ordered: 0, sent: 0, received: 0, amount: 0 }
  );

  return (
    <div style={{ maxWidth: 1520 }}>
      <PageHero
        eyebrow="Subcontract execution desk"
        title={order.subcontract_number || "Subcontract order"}
        description={`${order.vendor_name || "Vendor pending"}${order.job_card_number ? ` • ${order.job_card_number}` : ""}`}
        actions={
          <>
            <button onClick={onBack}>Back</button>
            <button onClick={() => refresh().catch(() => {})} disabled={loading}>
              Refresh
            </button>
            <button onClick={() => save().catch(() => {})} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
            <DeskChip label={status.replaceAll("_", " ").toUpperCase()} tone={statusAppearance.tone} color={statusAppearance.color} />
          </>
        }
        stats={[
          { label: "Ordered", value: totals.ordered.toFixed(4), tone: "#143d7a" },
          { label: "Sent", value: totals.sent.toFixed(4), tone: "#234a8f" },
          { label: "Received", value: totals.received.toFixed(4), tone: "#0b7d45" },
          { label: "Amount (base)", value: totals.amount.toFixed(2), tone: "#0a7a35" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(360px, 0.8fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Order Header" subtitle="Vendor, due date, and closure controls">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <FieldLabel label="Vendor">
                <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} disabled={isLocked}>
                  <option value="">Select vendor</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={String(v.id)}>
                      {v.company_name}
                    </option>
                  ))}
                </select>
              </FieldLabel>
              <FieldLabel label="Due date">
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={isLocked} />
              </FieldLabel>
              <FieldLabel label="Close / Cancel">
                <select value={closeMode} onChange={(e) => setCloseMode(e.target.value)} disabled={isLocked}>
                  <option value="">Keep open (system status)</option>
                  <option value="close">Mark closed</option>
                  <option value="cancel">Cancel order</option>
                </select>
              </FieldLabel>
              <FieldLabel label="Remarks">
                <input value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={isLocked} placeholder="Operator note / work instruction" />
              </FieldLabel>
            </div>
          </DeskCard>

          <DeskCard title="Line Desk" subtitle="Products and quantities being processed outside">
            <div style={{ display: "grid", gap: 10 }}>
              {lines.map((line, index) => {
                const remainingSend = qty(Math.max(qty(line.qty_ordered || 0) - qty(line.qty_sent || 0), 0));
                const remainingReceive = qty(Math.max(qty(line.qty_sent || 0) - qty(line.qty_received || 0), 0));
                return (
                  <div key={line.id || `${line.product_id}-${index}`} style={{ border: "1px solid #edf1f6", borderRadius: 16, padding: 12, background: "#ffffff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 800 }}>
                        {line.item_code ? `${line.item_code} • ` : ""}
                        {line.item_name || line.description || "Line"}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <DeskChip label={`SEND REM: ${remainingSend.toFixed(4)}`} tone="#eef4ff" color="#234a8f" />
                        <DeskChip label={`RCV REM: ${remainingReceive.toFixed(4)}`} tone="#effcf3" color="#0b7d45" />
                        <button onClick={() => removeLine(index)} disabled={isLocked}>
                          Remove
                        </button>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                      <FieldLabel label="Description">
                        <input value={line.description || ""} onChange={(e) => updateLine(index, { description: e.target.value })} disabled={isLocked} />
                      </FieldLabel>
                      <FieldLabel label="UOM">
                        <input value={line.uom || ""} onChange={(e) => updateLine(index, { uom: e.target.value })} disabled />
                      </FieldLabel>
                      <FieldLabel label="Qty ordered">
                        <input
                          value={String(line.qty_ordered ?? "")}
                          onChange={(e) => updateLine(index, { qty_ordered: e.target.value })}
                          disabled={isLocked}
                          inputMode="decimal"
                        />
                      </FieldLabel>
                      <FieldLabel label="Unit rate (base)">
                        <input
                          value={String(line.unit_rate_base ?? "")}
                          onChange={(e) => updateLine(index, { unit_rate_base: e.target.value })}
                          disabled={isLocked}
                          inputMode="decimal"
                        />
                      </FieldLabel>
                      <FieldLabel label="Amount (base)">
                        <input value={fmtMoney(line.amount_base)} disabled />
                      </FieldLabel>
                      <FieldLabel label="Sent">
                        <input value={fmtQty(line.qty_sent)} disabled />
                      </FieldLabel>
                      <FieldLabel label="Received">
                        <input value={fmtQty(line.qty_received)} disabled />
                      </FieldLabel>
                      <FieldLabel label="Line remarks">
                        <input value={line.remarks || ""} onChange={(e) => updateLine(index, { remarks: e.target.value })} disabled={isLocked} />
                      </FieldLabel>
                    </div>
                  </div>
                );
              })}
              {!lines.length ? <div style={{ fontSize: 12, opacity: 0.7 }}>No lines yet. Add a product from the lookup.</div> : null}
            </div>

            <div style={{ marginTop: 14, borderTop: "1px solid #edf1f6", paddingTop: 14, display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search products" style={{ minWidth: 240 }} />
                <button onClick={() => searchProducts().catch(() => {})} disabled={searching}>
                  {searching ? "Searching..." : "Search"}
                </button>
              </div>
              {searchResults.length ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {searchResults.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => addProduct(p)}
                      disabled={isLocked}
                      style={{
                        textAlign: "left",
                        border: "1px solid #edf1f6",
                        borderRadius: 14,
                        padding: 10,
                        background: "#ffffff",
                        cursor: isLocked ? "not-allowed" : "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 800 }}>{p.item_code}</div>
                      <div style={{ fontSize: 12, opacity: 0.74 }}>
                        {p.item_name} {p.uom ? `• ${p.uom}` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </DeskCard>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Send / Receive Movement" subtitle="Post stock movements for outside processing">
            <div style={{ display: "grid", gap: 10 }}>
              <FieldLabel label="Line">
                <select value={movementLineId} onChange={(e) => setMovementLineId(e.target.value)} disabled={isLocked}>
                  <option value="">Select line</option>
                  {movementCandidates.map((l) => (
                    <option key={l.id} value={String(l.id)}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </FieldLabel>
              <FieldLabel label="Movement type">
                <select value={movementType} onChange={(e) => setMovementType(e.target.value)} disabled={isLocked}>
                  <option value="send">Send (to vendor)</option>
                  <option value="receive">Receive (back from vendor)</option>
                </select>
              </FieldLabel>
              <FieldLabel label="Qty">
                <input value={movementQty} onChange={(e) => setMovementQty(e.target.value)} disabled={isLocked} inputMode="decimal" placeholder="0.0000" />
              </FieldLabel>
              <FieldLabel label="Movement date">
                <input type="date" value={movementDate} onChange={(e) => setMovementDate(e.target.value)} disabled={isLocked} />
              </FieldLabel>
              <button onClick={() => recordMovement().catch(() => {})} disabled={moving || isLocked}>
                {isLocked ? "Order locked" : moving ? "Posting..." : "Record Movement"}
              </button>
            </div>
          </DeskCard>

          <DeskCard title="Movement Log" subtitle="Latest send/receive events">
            <div style={{ display: "grid", gap: 10 }}>
              {movements.map((m) => {
                const type = String(m.movement_type || "").toLowerCase();
                const typeAppearance = getDeskStatusAppearance(type, {
                  info: ["send"],
                  success: ["receive"],
                });
                return (
                  <div key={m.id} style={{ border: "1px solid #edf1f6", borderRadius: 16, padding: 12, background: "#ffffff", display: "grid", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ fontWeight: 800 }}>
                        {m.item_code ? `${m.item_code} • ` : ""}
                        {m.item_name || ""}
                      </div>
                      <DeskChip label={type.toUpperCase()} tone={typeAppearance.tone} color={typeAppearance.color} />
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.74 }}>
                      {fmtDate(m.movement_date)} • Qty: <strong>{fmtQty(m.qty)}</strong>
                    </div>
                  </div>
                );
              })}
              {!movements.length ? <div style={{ fontSize: 12, opacity: 0.7 }}>No movements recorded yet.</div> : null}
            </div>
          </DeskCard>
        </div>
      </div>
    </div>
  );
}

