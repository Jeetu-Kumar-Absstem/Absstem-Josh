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

function toLineDraft(line) {
  const serials = Array.isArray(line?.serials) ? line.serials : [];
  return {
    id: line?.id || null,
    product_id: line?.product_id || null,
    item_code: line?.item_code || "",
    item_name: line?.item_name || "",
    uom: line?.uom || "",
    serial_no_required: line?.serial_no_required === true,
    system_qty: num(line?.system_qty),
    counted_qty: num(line?.counted_qty),
    adjustment_qty: num(line?.adjustment_qty),
    remarks: line?.remarks || "",
    serial_text: serials.join("\n"),
  };
}

export default function StockAdjustments() {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [createMode, setCreateMode] = useState("physical_verification");

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/stock-adjustments");
      setItems(Array.isArray(data?.stock_adjustments) ? data.stock_adjustments : []);
    } catch (_e) {
      setError("Failed to load stock adjustments.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") loadList();
  }, [view.type]);

  async function createDraft() {
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/stock-adjustments", {
        method: "POST",
        body: JSON.stringify({ adjustment_mode: createMode }),
      });
      const id = data?.stock_adjustment?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Stock adjustment draft created.");
    } catch (_e) {
      setError("Failed to create stock adjustment draft.");
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return <StockAdjustmentDetail id={view.id} onBack={() => setView({ type: "list" })} />;
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Stock Adjustment / Physical Verification</h2>
        <button onClick={loadList} disabled={loading}>
          Refresh
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Create Draft</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Mode
            <select value={createMode} onChange={(e) => setCreateMode(e.target.value)} style={{ height: 36 }}>
              <option value="physical_verification">Physical Verification</option>
              <option value="manual_adjustment">Manual Adjustment</option>
            </select>
          </label>
          <button onClick={createDraft} disabled={creating}>
            {creating ? "Creating..." : "Create Draft"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {loading ? (
          <div>Loading stock adjustments…</div>
        ) : items.length ? (
          items.map((row) => (
            <button
              key={row.id}
              onClick={() => setView({ type: "detail", id: row.id })}
              style={{ all: "unset", cursor: "pointer", border: "1px solid #e5e5e5", borderRadius: 10, padding: 14, display: "grid", gap: 8 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700 }}>{row.adjustment_number}</div>
                <div style={{ textTransform: "capitalize" }}>{row.adjustment_status}</div>
              </div>
              <div style={{ fontSize: 13, opacity: 0.78 }}>
                {row.adjustment_mode?.replaceAll("_", " ")} • {fmtDate(row.adjustment_date)}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(150px, 1fr))", gap: 10 }}>
                <Metric label="Lines" value={String(row.line_count || 0)} />
                <Metric label="Net Adjustment" value={num(row.net_adjustment_qty).toFixed(4)} />
              </div>
            </button>
          ))
        ) : (
          <div style={{ opacity: 0.72 }}>No stock adjustments yet.</div>
        )}
      </div>
    </div>
  );
}

function StockAdjustmentDetail({ id, onBack }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [header, setHeader] = useState(null);
  const [lines, setLines] = useState([]);
  const [adjustmentStatus, setAdjustmentStatus] = useState("draft");
  const [adjustmentMode, setAdjustmentMode] = useState("physical_verification");
  const [adjustmentDate, setAdjustmentDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupItems, setLookupItems] = useState([]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/stock-adjustments/${id}`);
      const nextHeader = data?.stock_adjustment || null;
      const nextLines = Array.isArray(data?.lines) ? data.lines.map(toLineDraft) : [];
      setHeader(nextHeader);
      setLines(nextLines);
      setAdjustmentStatus(nextHeader?.adjustment_status || "draft");
      setAdjustmentMode(nextHeader?.adjustment_mode || "physical_verification");
      setAdjustmentDate(toIsoDate(nextHeader?.adjustment_date));
      setRemarks(nextHeader?.remarks || "");
    } catch (_e) {
      setError("Failed to load stock adjustment.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  async function runLookup() {
    setLookupLoading(true);
    try {
      const q = String(lookupQuery || "").trim();
      const url = q ? `/stock-adjustments/product-lookup?q=${encodeURIComponent(q)}` : "/stock-adjustments/product-lookup";
      const data = await apiFetch(url);
      setLookupItems(Array.isArray(data?.products) ? data.products : []);
    } catch (_e) {
      setError("Failed to search products.");
    } finally {
      setLookupLoading(false);
    }
  }

  const isDraft = String(adjustmentStatus || "").toLowerCase() === "draft";

  const totals = useMemo(
    () => ({
      system: lines.reduce((sum, line) => sum + num(line.system_qty), 0),
      counted: lines.reduce((sum, line) => sum + num(line.counted_qty), 0),
      adjustment: lines.reduce((sum, line) => sum + (num(line.counted_qty) - num(line.system_qty)), 0),
    }),
    [lines]
  );

  function addProduct(product) {
    if (!product?.id) return;
    setLines((prev) => {
      if (prev.some((line) => Number(line.product_id) === Number(product.id))) return prev;
      return [
        ...prev,
        {
          id: null,
          product_id: product.id,
          item_code: product.item_code || "",
          item_name: product.item_name || "",
          uom: product.uom || "",
          serial_no_required: product.serial_no_required === true,
          system_qty: num(product.stock_qty),
          counted_qty: num(product.stock_qty),
          adjustment_qty: 0,
          remarks: "",
          serial_text: "",
        },
      ];
    });
  }

  function updateLine(index, patch) {
    setLines((prev) =>
      prev.map((line, i) => {
        if (i !== index) return line;
        const next = { ...line, ...patch };
        next.adjustment_qty = num(next.counted_qty) - num(next.system_qty);
        return next;
      })
    );
  }

  function removeLine(index) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        adjustment_status: adjustmentStatus,
        adjustment_mode: adjustmentMode,
        adjustment_date: adjustmentDate || null,
        remarks: remarks || null,
      };
      if (isDraft) {
        payload.lines = lines.map((line) => ({
          product_id: line.product_id,
          counted_qty: num(line.counted_qty),
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
      const data = await apiFetch(`/stock-adjustments/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const nextHeader = data?.stock_adjustment || header;
      const nextLines = Array.isArray(data?.lines) ? data.lines.map(toLineDraft) : lines;
      setHeader(nextHeader);
      setLines(nextLines);
      setAdjustmentStatus(nextHeader?.adjustment_status || adjustmentStatus);
      setAdjustmentMode(nextHeader?.adjustment_mode || adjustmentMode);
      setAdjustmentDate(toIsoDate(nextHeader?.adjustment_date));
      setRemarks(nextHeader?.remarks || "");
      setNotice("Stock adjustment saved.");
    } catch (e) {
      if (e?.data?.error === "ADJUSTMENT_NOT_EDITABLE") setError("Only draft stock adjustments can update lines.");
      else if (e?.data?.error === "DUPLICATE_PRODUCT") setError("Each product can appear only once.");
      else if (e?.data?.error === "SERIAL_COUNT_MISMATCH") setError("Serial-controlled adjustment lines require one serial per qty changed.");
      else if (e?.data?.error === "SERIAL_QTY_NOT_INTEGER") setError("Serial-controlled adjustment lines require an integer qty difference.");
      else if (e?.data?.error === "INVALID_COUNTED_QTY") setError("Counted qty cannot be negative.");
      else if (e?.data?.error === "DUPLICATE_SERIALS") setError("Duplicate serial numbers are not allowed.");
      else setError("Failed to save stock adjustment.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div>Loading stock adjustment…</div>;
  if (!header) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Stock adjustment not found."}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{header.adjustment_number}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{adjustmentMode.replaceAll("_", " ")} • {adjustmentStatus}</div>
        </div>
        <button onClick={refresh} disabled={loading}>
          Refresh
        </button>
        <button onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Adjustment Snapshot</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Adjustment Date
              <input type="date" value={adjustmentDate} onChange={(e) => setAdjustmentDate(e.target.value)} style={{ height: 34 }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Status
              <select value={adjustmentStatus} onChange={(e) => setAdjustmentStatus(e.target.value)} style={{ height: 36 }}>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Mode
              <select value={adjustmentMode} onChange={(e) => setAdjustmentMode(e.target.value)} style={{ height: 36 }}>
                <option value="physical_verification">Physical Verification</option>
                <option value="manual_adjustment">Manual Adjustment</option>
              </select>
            </label>
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} style={{ padding: 10 }} />
          </label>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Verification Totals</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(120px, 1fr))", gap: 10 }}>
            <Metric label="System Qty" value={totals.system.toFixed(4)} />
            <Metric label="Counted Qty" value={totals.counted.toFixed(4)} />
            <Metric label="Net Adjustment" value={totals.adjustment.toFixed(4)} />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Add Product</div>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            value={lookupQuery}
            onChange={(e) => setLookupQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runLookup();
            }}
            placeholder="Search item code or name"
            style={{ flex: 1, height: 36, padding: "0 10px" }}
            disabled={!isDraft}
          />
          <button onClick={runLookup} disabled={lookupLoading || !isDraft}>
            {lookupLoading ? "Searching..." : "Search"}
          </button>
        </div>
        {lookupItems.length ? (
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {lookupItems.map((item) => (
              <button
                key={item.id}
                onClick={() => addProduct(item)}
                disabled={!isDraft}
                style={{ all: "unset", cursor: isDraft ? "pointer" : "default", border: "1px solid #f0f0f0", borderRadius: 8, padding: 10, display: "flex", justifyContent: "space-between", gap: 12 }}
              >
                <div>
                  <strong>{item.item_code}</strong>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>{item.item_name}</div>
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>
                  Stock {num(item.stock_qty).toFixed(4)}
                </div>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>Adjustment Lines</div>
        {lines.length ? (
          lines.map((line, index) => {
            const adjustmentQty = num(line.counted_qty) - num(line.system_qty);
            return (
              <div key={`${line.product_id}:${index}`} style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 700 }}>
                    L{index + 1} • {line.item_code || line.item_name || "Item"}
                  </div>
                  {isDraft ? (
                    <button onClick={() => removeLine(index)}>Remove</button>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.72 }}>Posted / locked</div>
                  )}
                </div>
                <div style={{ fontSize: 13, opacity: 0.78, marginTop: 6 }}>{line.item_name || "—"}</div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: 10, marginTop: 12 }}>
                  <Metric label="System Qty" value={num(line.system_qty).toFixed(4)} />
                  <Metric label="Counted Qty" value={num(line.counted_qty).toFixed(4)} />
                  <Metric label="Adjustment Qty" value={adjustmentQty.toFixed(4)} />
                  <Metric label="UOM" value={line.uom || "—"} />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Counted Qty
                    <input
                      type="number"
                      min="0"
                      step="0.0001"
                      value={line.counted_qty}
                      disabled={!isDraft}
                      onChange={(e) => updateLine(index, { counted_qty: e.target.value })}
                      style={{ height: 34, padding: "0 8px" }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Remarks
                    <input
                      value={line.remarks}
                      disabled={!isDraft}
                      onChange={(e) => updateLine(index, { remarks: e.target.value })}
                      style={{ height: 34, padding: "0 8px" }}
                    />
                  </label>
                </div>

                {line.serial_no_required && adjustmentQty !== 0 ? (
                  <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                    Serials For Qty Changed
                    <textarea
                      value={line.serial_text}
                      disabled={!isDraft}
                      onChange={(e) => updateLine(index, { serial_text: e.target.value })}
                      rows={4}
                      placeholder="One serial number per line"
                      style={{ padding: 10 }}
                    />
                  </label>
                ) : null}
              </div>
            );
          })
        ) : (
          <div style={{ opacity: 0.72 }}>No products added yet.</div>
        )}
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
