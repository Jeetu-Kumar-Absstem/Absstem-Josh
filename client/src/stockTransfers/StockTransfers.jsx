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

function emptyLine() {
  return {
    product_id: null,
    item_code: "",
    item_name: "",
    uom: "",
    serial_no_required: false,
    qty: 1,
    remarks: "",
    serial_text: "",
  };
}

export default function StockTransfers() {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [createFromLocationId, setCreateFromLocationId] = useState("");
  const [createToLocationId, setCreateToLocationId] = useState("");
  const [locationForm, setLocationForm] = useState({ id: null, location_code: "", location_name: "", location_type: "warehouse", is_active: true, remarks: "" });

  async function loadBootstrap() {
    const data = await apiFetch("/stock-transfers/bootstrap");
    setLocations(Array.isArray(data?.locations) ? data.locations : []);
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/stock-transfers");
      setItems(Array.isArray(data?.stock_transfers) ? data.stock_transfers : []);
    } catch (_e) {
      setError("Failed to load stock transfers.");
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

  async function saveLocation() {
    setError("");
    setNotice("");
    try {
      const path = locationForm.id ? `/stock-transfers/locations/${locationForm.id}` : "/stock-transfers/locations";
      const method = locationForm.id ? "PUT" : "POST";
      const data = await apiFetch(path, { method, body: JSON.stringify(locationForm) });
      const nextLocations = Array.isArray(data?.locations) ? data.locations : [];
      setLocations(nextLocations);
      setLocationForm({ id: null, location_code: "", location_name: "", location_type: "warehouse", is_active: true, remarks: "" });
      setNotice("Location saved.");
    } catch (_e) {
      setError("Failed to save location.");
    }
  }

  async function createTransfer() {
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/stock-transfers", {
        method: "POST",
        body: JSON.stringify({ from_location_id: Number(createFromLocationId), to_location_id: Number(createToLocationId) }),
      });
      const id = data?.stock_transfer?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Stock transfer draft created.");
    } catch (_e) {
      setError("Failed to create stock transfer.");
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return <StockTransferDetail id={view.id} onBack={() => setView({ type: "list" })} locations={locations} onRefreshLocations={loadBootstrap} />;
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Warehouse / Location Transfer</h2>
        <button onClick={loadList} disabled={loading}>Refresh</button>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Location Master</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Code
              <input value={locationForm.location_code} onChange={(e) => setLocationForm((p) => ({ ...p, location_code: e.target.value }))} style={{ height: 34, padding: "0 8px" }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Name
              <input value={locationForm.location_name} onChange={(e) => setLocationForm((p) => ({ ...p, location_name: e.target.value }))} style={{ height: 34, padding: "0 8px" }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Type
              <select value={locationForm.location_type} onChange={(e) => setLocationForm((p) => ({ ...p, location_type: e.target.value }))} style={{ height: 36 }}>
                <option value="warehouse">Warehouse</option>
                <option value="site">Site</option>
                <option value="van">Van</option>
                <option value="service">Service</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginTop: 26 }}>
              <input type="checkbox" checked={locationForm.is_active} onChange={(e) => setLocationForm((p) => ({ ...p, is_active: e.target.checked }))} />
              Active
            </label>
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={locationForm.remarks} onChange={(e) => setLocationForm((p) => ({ ...p, remarks: e.target.value }))} rows={3} style={{ padding: 10 }} />
          </label>
          <button onClick={saveLocation} style={{ marginTop: 12 }}>{locationForm.id ? "Update Location" : "Create Location"}</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {locations.map((row) => (
              <button key={row.id} onClick={() => setLocationForm({ ...row })} style={{ all: "unset", cursor: "pointer", border: "1px solid #f0f0f0", borderRadius: 8, padding: 10, display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div><strong>{row.location_code}</strong><div style={{ fontSize: 12, opacity: 0.72 }}>{row.location_name}</div></div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>{row.location_type}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Create Transfer Draft</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              From
              <select value={createFromLocationId} onChange={(e) => setCreateFromLocationId(e.target.value)} style={{ height: 36 }}>
                <option value="">Select source</option>
                {locations.filter((row) => row.is_active).map((row) => <option key={row.id} value={String(row.id)}>{row.location_name}</option>)}
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              To
              <select value={createToLocationId} onChange={(e) => setCreateToLocationId(e.target.value)} style={{ height: 36 }}>
                <option value="">Select destination</option>
                {locations.filter((row) => row.is_active).map((row) => <option key={row.id} value={String(row.id)}>{row.location_name}</option>)}
              </select>
            </label>
          </div>
          <button onClick={createTransfer} disabled={creating} style={{ marginTop: 12 }}>{creating ? "Creating..." : "Create Transfer"}</button>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {loading ? <div>Loading transfers…</div> : items.length ? items.map((row) => (
          <button key={row.id} onClick={() => setView({ type: "detail", id: row.id })} style={{ all: "unset", cursor: "pointer", border: "1px solid #e5e5e5", borderRadius: 10, padding: 14, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700 }}>{row.transfer_number}</div>
              <div style={{ textTransform: "capitalize" }}>{row.transfer_status}</div>
            </div>
            <div style={{ fontSize: 13, opacity: 0.78 }}>{row.from_location_name} → {row.to_location_name} • {fmtDate(row.transfer_date)}</div>
            <Metric label="Qty" value={num(row.total_qty).toFixed(4)} />
          </button>
        )) : <div style={{ opacity: 0.72 }}>No transfers yet.</div>}
      </div>
    </div>
  );
}

function StockTransferDetail({ id, onBack, locations, onRefreshLocations }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [header, setHeader] = useState(null);
  const [lines, setLines] = useState([]);
  const [transferStatus, setTransferStatus] = useState("draft");
  const [transferDate, setTransferDate] = useState("");
  const [fromLocationId, setFromLocationId] = useState("");
  const [toLocationId, setToLocationId] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupItems, setLookupItems] = useState([]);

  async function refresh() {
    await onRefreshLocations?.();
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/stock-transfers/${id}`);
      const transfer = data?.stock_transfer || null;
      setHeader(transfer);
      setLines(Array.isArray(data?.lines) ? data.lines.map((line) => ({ ...emptyLine(), ...line, serial_text: Array.isArray(line.serials) ? line.serials.join("\n") : "" })) : []);
      setTransferStatus(transfer?.transfer_status || "draft");
      setTransferDate(toIsoDate(transfer?.transfer_date));
      setFromLocationId(String(transfer?.from_location_id || ""));
      setToLocationId(String(transfer?.to_location_id || ""));
      setRemarks(transfer?.remarks || "");
    } catch (_e) {
      setError("Failed to load transfer.");
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
      const url = q ? `/stock-transfers/product-lookup?q=${encodeURIComponent(q)}` : "/stock-transfers/product-lookup";
      const data = await apiFetch(url);
      setLookupItems(Array.isArray(data?.products) ? data.products : []);
    } catch (_e) {
      setError("Failed to search products.");
    } finally {
      setLookupLoading(false);
    }
  }

  const isDraft = String(transferStatus || "").toLowerCase() === "draft";

  function addProduct(product) {
    if (!product?.id) return;
    setLines((prev) => {
      if (prev.some((line) => Number(line.product_id) === Number(product.id))) return prev;
      return [...prev, { ...emptyLine(), product_id: product.id, item_code: product.item_code || "", item_name: product.item_name || "", uom: product.uom || "", serial_no_required: product.serial_no_required === true, qty: 1 }];
    });
  }

  function updateLine(index, patch) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
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
        transfer_status: transferStatus,
        transfer_date: transferDate || null,
        from_location_id: Number(fromLocationId),
        to_location_id: Number(toLocationId),
        remarks: remarks || null,
      };
      if (isDraft) {
        payload.lines = lines.map((line) => ({
          product_id: line.product_id,
          qty: num(line.qty),
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
      const data = await apiFetch(`/stock-transfers/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      const transfer = data?.stock_transfer || header;
      setHeader(transfer);
      setLines(Array.isArray(data?.lines) ? data.lines.map((line) => ({ ...emptyLine(), ...line, serial_text: Array.isArray(line.serials) ? line.serials.join("\n") : "" })) : lines);
      setTransferStatus(transfer?.transfer_status || transferStatus);
      setNotice("Transfer saved.");
    } catch (e) {
      if (e?.data?.error === "TRANSFER_EXCEEDS_STOCK") setError("Transfer qty cannot exceed current global stock.");
      else if (e?.data?.error === "SERIAL_COUNT_MISMATCH") setError("Serial-controlled items require one serial per unit.");
      else setError("Failed to save transfer.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div>Loading transfer…</div>;
  if (!header) return <div>Transfer not found.</div>;

  const totalQty = useMemo(() => lines.reduce((sum, line) => sum + num(line.qty), 0), [lines]);

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{header.transfer_number}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{header.from_location_name} → {header.to_location_name} • {transferStatus}</div>
        </div>
        <button onClick={refresh}>Refresh</button>
        <button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Transfer Snapshot</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Date
              <input type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} style={{ height: 34 }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Status
              <select value={transferStatus} onChange={(e) => setTransferStatus(e.target.value)} style={{ height: 36 }}>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              From
              <select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)} style={{ height: 36 }}>
                {locations.filter((row) => row.is_active).map((row) => <option key={row.id} value={String(row.id)}>{row.location_name}</option>)}
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              To
              <select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} style={{ height: 36 }}>
                {locations.filter((row) => row.is_active).map((row) => <option key={row.id} value={String(row.id)}>{row.location_name}</option>)}
              </select>
            </label>
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} style={{ padding: 10 }} />
          </label>
        </div>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Transfer Metrics</div>
          <Metric label="Total Qty" value={totalQty.toFixed(4)} />
        </div>
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Add Product</div>
        <div style={{ display: "flex", gap: 10 }}>
          <input value={lookupQuery} onChange={(e) => setLookupQuery(e.target.value)} placeholder="Search products" style={{ flex: 1, height: 36, padding: "0 10px" }} disabled={!isDraft} />
          <button onClick={runLookup} disabled={lookupLoading || !isDraft}>{lookupLoading ? "Searching..." : "Search"}</button>
        </div>
        {lookupItems.length ? <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          {lookupItems.map((item) => (
            <button key={item.id} onClick={() => addProduct(item)} disabled={!isDraft} style={{ all: "unset", cursor: "pointer", border: "1px solid #f0f0f0", borderRadius: 8, padding: 10, display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div><strong>{item.item_code}</strong><div style={{ fontSize: 12, opacity: 0.72 }}>{item.item_name}</div></div>
              <div style={{ fontSize: 12, opacity: 0.72 }}>Global stock {num(item.stock_qty).toFixed(4)}</div>
            </button>
          ))}
        </div> : null}
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>Transfer Lines</div>
        {lines.length ? lines.map((line, index) => (
          <div key={`${line.product_id}:${index}`} style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700 }}>L{index + 1} • {line.item_code || line.item_name || "Item"}</div>
              {isDraft ? <button onClick={() => removeLine(index)}>Remove</button> : null}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Qty
                <input type="number" min="0" step="0.0001" value={line.qty} disabled={!isDraft} onChange={(e) => updateLine(index, { qty: e.target.value })} style={{ height: 34, padding: "0 8px" }} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Remarks
                <input value={line.remarks || ""} disabled={!isDraft} onChange={(e) => updateLine(index, { remarks: e.target.value })} style={{ height: 34, padding: "0 8px" }} />
              </label>
            </div>
            {line.serial_no_required ? (
              <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                Serial Numbers
                <textarea value={line.serial_text || ""} disabled={!isDraft} onChange={(e) => updateLine(index, { serial_text: e.target.value })} rows={4} placeholder="One serial per line" style={{ padding: 10 }} />
              </label>
            ) : null}
          </div>
        )) : <div style={{ opacity: 0.72 }}>No transfer lines yet.</div>}
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
