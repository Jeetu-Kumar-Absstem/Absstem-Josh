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

function fmtMoney(value, currencyCode) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${currencyCode ? `${currencyCode} ` : ""}${n.toFixed(2)}`;
}

function groupSerialRows(lines, serialRows) {
  const serialsByLineId = new Map();
  for (const row of serialRows || []) {
    const key = Number(row.purchase_return_line_id);
    if (!serialsByLineId.has(key)) serialsByLineId.set(key, []);
    serialsByLineId.get(key).push(row.serial_no);
  }
  return (lines || []).map((line) => ({
    ...line,
    serial_text: (serialsByLineId.get(Number(line.id)) || []).join("\n"),
  }));
}

export default function PurchaseReturns({ launch = null, onConsumeLaunch = null } = {}) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [listQuery, setListQuery] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], currencies: [], goods_receipts: [], purchase_invoices: [] });
  const [returns, setReturns] = useState([]);
  const [createVendorId, setCreateVendorId] = useState("");
  const [createGoodsReceiptId, setCreateGoodsReceiptId] = useState("");

  async function loadBootstrap() {
    const data = await apiFetch("/purchase-returns/bootstrap");
    setBootstrap({
      vendors: Array.isArray(data?.vendors) ? data.vendors : [],
      currencies: Array.isArray(data?.currencies) ? data.currencies : [],
      goods_receipts: Array.isArray(data?.goods_receipts) ? data.goods_receipts : [],
      purchase_invoices: Array.isArray(data?.purchase_invoices) ? data.purchase_invoices : [],
    });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/purchase-returns");
      setReturns(Array.isArray(data?.purchase_returns) ? data.purchase_returns : []);
    } catch (e) {
      setError(e?.data?.error || "Failed to load purchase returns.");
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
    if (typeof launch.q === "string") {
      setListQuery(launch.q);
    }
    const fromGrnId = Number(launch.from_grn_id);
    if (Number.isFinite(fromGrnId) && fromGrnId > 0) {
      setCreateGoodsReceiptId(String(fromGrnId));
      setNotice(`Opened from GRN #${fromGrnId}. Select Create From GRN to start the return, or filter the list.`);
    }
    if (view.type !== "list") setView({ type: "list" });
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  const filteredReturns = useMemo(() => {
    const q = String(listQuery || "").trim().toLowerCase();
    if (!q) return returns;
    return returns.filter((item) => {
      const haystack = [item.return_number, item.debit_note_number, item.vendor_name, item.return_status, item.grn_number]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [returns, listQuery]);

  async function createManual() {
    const vendorId = Number(createVendorId);
    if (!Number.isFinite(vendorId) || vendorId <= 0) {
      setError("Select a vendor first.");
      return;
    }
    setError("");
    try {
      const data = await apiFetch("/purchase-returns", {
        method: "POST",
        body: JSON.stringify({ vendor_id: vendorId }),
      });
      if (data?.purchase_return?.id) setView({ type: "detail", id: data.purchase_return.id });
    } catch (e) {
      setError(e?.data?.error || "Failed to create purchase return.");
    }
  }

  async function createFromGrn() {
    const goodsReceiptId = Number(createGoodsReceiptId);
    if (!Number.isFinite(goodsReceiptId) || goodsReceiptId <= 0) {
      setError("Select a GRN first.");
      return;
    }
    setError("");
    try {
      const data = await apiFetch(`/purchase-returns/from-grn/${goodsReceiptId}`, { method: "POST" });
      if (data?.purchase_return?.id) setView({ type: "detail", id: data.purchase_return.id });
    } catch (e) {
      setError(e?.data?.error || "Failed to create return from GRN.");
    }
  }

  if (view.type === "detail") {
    return <PurchaseReturnDetail id={view.id} onBack={() => setView({ type: "list" })} onNotice={(msg) => setNotice(msg)} />;
  }

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Purchase Return / Debit Note</h2>
        <input
          value={listQuery}
          onChange={(e) => setListQuery(e.target.value)}
          placeholder="Search return / vendor / GRN"
          style={{ minWidth: 220, height: 36 }}
        />
        <button onClick={loadList} disabled={loading}>Refresh</button>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Create Manual Return</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 10, alignItems: "end" }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Vendor
              <select value={createVendorId} onChange={(e) => setCreateVendorId(e.target.value)} style={{ height: 36 }}>
                <option value="">Select vendor</option>
                {bootstrap.vendors.map((vendor) => (
                  <option key={vendor.id} value={String(vendor.id)}>{vendor.company_name}</option>
                ))}
              </select>
            </label>
            <button onClick={createManual}>Create</button>
          </div>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Create From GRN</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 10, alignItems: "end" }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              GRN
              <select value={createGoodsReceiptId} onChange={(e) => setCreateGoodsReceiptId(e.target.value)} style={{ height: 36 }}>
                <option value="">Select GRN</option>
                {bootstrap.goods_receipts.map((grn) => (
                  <option key={grn.id} value={String(grn.id)}>{grn.grn_number} - {grn.vendor_name}</option>
                ))}
              </select>
            </label>
            <button onClick={createFromGrn}>Create</button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "160px 140px 1fr 120px 120px", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
          <div>Return No</div><div>Debit Note</div><div>Vendor</div><div>Status</div><div>Total</div>
        </div>
        {loading ? (
          <div style={{ padding: 12 }}>Loading…</div>
        ) : filteredReturns.length ? (
          filteredReturns.map((item) => (
            <button
              key={item.id}
              onClick={() => setView({ type: "detail", id: item.id })}
              style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: "160px 140px 1fr 120px 120px", gap: 8, padding: 12, borderBottom: "1px solid #f2f2f2" }}
            >
              <div>{item.return_number}</div>
              <div>{item.debit_note_number || "—"}</div>
              <div>{item.vendor_name}</div>
              <div style={{ textTransform: "capitalize" }}>{item.return_status}</div>
              <div>{fmtMoney(item.grand_total_invoice, item.return_currency_code)}</div>
            </button>
          ))
        ) : (
          <div style={{ padding: 12, opacity: 0.72 }}>{listQuery ? "No purchase returns match this filter." : "No purchase returns yet."}</div>
        )}
      </div>
    </div>
  );
}

function PurchaseReturnDetail({ id, onBack, onNotice }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], currencies: [], goods_receipts: [], purchase_invoices: [] });
  const [purchaseReturn, setPurchaseReturn] = useState(null);
  const [lines, setLines] = useState([]);
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupResults, setLookupResults] = useState([]);
  const [form, setForm] = useState({
    return_status: "draft",
    return_date: "",
    vendor_id: "",
    goods_receipt_id: "",
    purchase_invoice_id: "",
    remarks: "",
  });

  useEffect(() => {
    setLoading(true);
    Promise.all([apiFetch("/purchase-returns/bootstrap"), apiFetch(`/purchase-returns/${id}`)])
      .then(([boot, data]) => {
        setBootstrap({
          vendors: Array.isArray(boot?.vendors) ? boot.vendors : [],
          currencies: Array.isArray(boot?.currencies) ? boot.currencies : [],
          goods_receipts: Array.isArray(boot?.goods_receipts) ? boot.goods_receipts : [],
          purchase_invoices: Array.isArray(boot?.purchase_invoices) ? boot.purchase_invoices : [],
        });
        const header = data?.purchase_return || null;
        const nextLines = groupSerialRows(Array.isArray(data?.lines) ? data.lines : [], Array.isArray(data?.serial_rows) ? data.serial_rows : []);
        setPurchaseReturn(header);
        setLines(nextLines);
        setForm({
          return_status: header?.return_status || "draft",
          return_date: header?.return_date ? String(header.return_date).slice(0, 10) : "",
          vendor_id: header?.vendor_id ? String(header.vendor_id) : "",
          goods_receipt_id: header?.goods_receipt_id ? String(header.goods_receipt_id) : "",
          purchase_invoice_id: header?.purchase_invoice_id ? String(header.purchase_invoice_id) : "",
          remarks: header?.remarks || "",
        });
      })
      .catch((e) => setError(e?.data?.error || "Failed to load purchase return."))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    const q = lookupQuery.trim();
    if (!q || !purchaseReturn || purchaseReturn.return_status !== "draft") {
      setLookupResults([]);
      return;
    }
    const timer = setTimeout(() => {
      apiFetch(`/purchase-returns/product-lookup?q=${encodeURIComponent(q)}`)
        .then((data) => setLookupResults(Array.isArray(data?.products) ? data.products : []))
        .catch(() => setLookupResults([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [lookupQuery, purchaseReturn]);

  const totals = useMemo(() => {
    return lines.reduce(
      (acc, line) => {
        const qtyReturn = Number(line.qty_return || 0);
        const rate = Number(line.unit_price_invoice || 0);
        const gst = Number(line.gst_pct || 0);
        const lineTotal = qtyReturn * rate;
        const tax = (lineTotal * gst) / 100;
        acc.subtotal += lineTotal;
        acc.tax += tax;
        acc.total += lineTotal + tax;
        return acc;
      },
      { subtotal: 0, tax: 0, total: 0 }
    );
  }, [lines]);

  function updateLine(index, key, value) {
    setLines((prev) => prev.map((line, idx) => (idx === index ? { ...line, [key]: value } : line)));
  }

  function removeLine(index) {
    setLines((prev) => prev.filter((_, idx) => idx !== index));
  }

  function addProduct(product) {
    setLines((prev) => [
      ...prev,
      {
        goods_receipt_line_id: null,
        purchase_invoice_line_id: null,
        product_id: product.id,
        item_code: product.item_code || "",
        item_name: product.item_name || "",
        line_description: product.item_name || "",
        hsn_no: product.hsn_no || "",
        uom: product.uom || "",
        qty_return: "1",
        unit_price_base: String(product.last_purchase_price ?? 0),
        unit_price_invoice: String(product.last_purchase_price ?? 0),
        gst_pct: String(product.gst_pct ?? 0),
        serial_no_required: Boolean(product.serial_no_required),
        serial_text: "",
      },
    ]);
    setLookupQuery("");
    setLookupResults([]);
  }

  async function save() {
    if (!purchaseReturn) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        ...form,
        vendor_id: Number(form.vendor_id || 0),
        goods_receipt_id: form.goods_receipt_id ? Number(form.goods_receipt_id) : null,
        purchase_invoice_id: form.purchase_invoice_id ? Number(form.purchase_invoice_id) : null,
        lines: lines.map((line) => ({
          goods_receipt_line_id: line.goods_receipt_line_id || null,
          purchase_invoice_line_id: line.purchase_invoice_line_id || null,
          product_id: line.product_id || null,
          item_code: line.item_code || null,
          item_name: line.item_name || null,
          line_description: line.line_description || null,
          hsn_no: line.hsn_no || null,
          uom: line.uom || null,
          qty_return: Number(line.qty_return || 0),
          unit_price_base: Number(line.unit_price_base || 0),
          unit_price_invoice: Number(line.unit_price_invoice || 0),
          gst_pct: Number(line.gst_pct || 0),
        })),
        serial_rows: lines.flatMap((line, index) =>
          String(line.serial_text || "")
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)
            .map((serial_no) => ({ line_no: index + 1, serial_no }))
        ),
      };
      const data = await apiFetch(`/purchase-returns/${purchaseReturn.id}`, { method: "PUT", body: JSON.stringify(payload) });
      const header = data?.purchase_return || purchaseReturn;
      const nextLines = groupSerialRows(Array.isArray(data?.lines) ? data.lines : [], Array.isArray(data?.serial_rows) ? data.serial_rows : []);
      setPurchaseReturn(header);
      setLines(nextLines);
      setForm((prev) => ({
        ...prev,
        return_status: header?.return_status || prev.return_status,
        return_date: header?.return_date ? String(header.return_date).slice(0, 10) : prev.return_date,
      }));
      setNotice("Purchase return saved.");
      onNotice?.("Purchase return saved.");
    } catch (e) {
      setError(e?.data?.error || "Failed to save purchase return.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div>Loading purchase return…</div>;
  if (!purchaseReturn) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Purchase return not found."}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1250 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{purchaseReturn.return_number}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {purchaseReturn.vendor_name} • Debit Note {purchaseReturn.debit_note_number || "—"}
          </div>
        </div>
        <button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Header</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Status">
              <select value={form.return_status} onChange={(e) => setForm((p) => ({ ...p, return_status: e.target.value }))}>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Date">
              <input type="date" value={form.return_date} onChange={(e) => setForm((p) => ({ ...p, return_date: e.target.value }))} />
            </Field>
            <Field label="Vendor">
              <select value={form.vendor_id} onChange={(e) => setForm((p) => ({ ...p, vendor_id: e.target.value }))} disabled={purchaseReturn.return_status !== "draft"}>
                <option value="">Select vendor</option>
                {bootstrap.vendors.map((vendor) => (
                  <option key={vendor.id} value={String(vendor.id)}>{vendor.company_name}</option>
                ))}
              </select>
            </Field>
            <Field label="GRN">
              <select value={form.goods_receipt_id} onChange={(e) => setForm((p) => ({ ...p, goods_receipt_id: e.target.value }))} disabled={purchaseReturn.return_status !== "draft"}>
                <option value="">-- None --</option>
                {bootstrap.goods_receipts.map((grn) => (
                  <option key={grn.id} value={String(grn.id)}>{grn.grn_number}</option>
                ))}
              </select>
            </Field>
            <Field label="Purchase Invoice">
              <select value={form.purchase_invoice_id} onChange={(e) => setForm((p) => ({ ...p, purchase_invoice_id: e.target.value }))} disabled={purchaseReturn.return_status !== "draft"}>
                <option value="">-- None --</option>
                {bootstrap.purchase_invoices.map((invoice) => (
                  <option key={invoice.id} value={String(invoice.id)}>{invoice.purchase_invoice_number}</option>
                ))}
              </select>
            </Field>
            <Field label="Currency">
              <div style={{ height: 34, display: "flex", alignItems: "center" }}>{purchaseReturn.return_currency_code || "—"}</div>
            </Field>
          </div>
          <Field label="Remarks">
            <textarea rows={3} style={{ width: "100%" }} value={form.remarks} onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))} />
          </Field>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Debit Note Summary</div>
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            <div>GRN: {purchaseReturn.grn_number || "—"}</div>
            <div>Purchase Invoice: {purchaseReturn.purchase_invoice_number || "—"}</div>
            <div>Subtotal: {fmtMoney(totals.subtotal, purchaseReturn.return_currency_code)}</div>
            <div>Tax: {fmtMoney(totals.tax, purchaseReturn.return_currency_code)}</div>
            <div><strong>Total: {fmtMoney(totals.total, purchaseReturn.return_currency_code)}</strong></div>
          </div>
        </div>
      </div>

      {purchaseReturn.return_status === "draft" ? (
        <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Add Item</div>
          <input
            value={lookupQuery}
            onChange={(e) => setLookupQuery(e.target.value)}
            placeholder="Search by item code or item name"
            style={{ width: "100%", height: 36, padding: "0 10px" }}
          />
          {lookupResults.length ? (
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {lookupResults.map((product) => (
                <button
                  key={product.id}
                  onClick={() => addProduct(product)}
                  style={{ all: "unset", cursor: "pointer", border: "1px solid #e5e5e5", borderRadius: 8, padding: 10 }}
                >
                  {product.item_code} - {product.item_name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: 12, borderBottom: "1px solid #e5e5e5", fontWeight: 700 }}>Return Lines</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1.4fr 90px 90px 100px 100px 100px 120px 70px", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
          <div>Item Code</div><div>Item</div><div>Qty</div><div>UOM</div><div>Rate</div><div>GST%</div><div>Line</div><div>Serials</div><div></div>
        </div>
        {lines.length ? lines.map((line, index) => {
          const lineTotal = Number(line.qty_return || 0) * Number(line.unit_price_invoice || 0);
          return (
            <div key={`${line.product_id || "line"}-${index}`} style={{ padding: 12, borderBottom: "1px solid #f2f2f2" }}>
              <div style={{ display: "grid", gridTemplateColumns: "120px 1.4fr 90px 90px 100px 100px 100px 120px 70px", gap: 8, alignItems: "start" }}>
                <div>{line.item_code || "—"}</div>
                <div>
                  <input value={line.item_name || ""} onChange={(e) => updateLine(index, "item_name", e.target.value)} disabled={purchaseReturn.return_status !== "draft"} />
                  <textarea rows={2} value={line.line_description || ""} onChange={(e) => updateLine(index, "line_description", e.target.value)} disabled={purchaseReturn.return_status !== "draft"} style={{ width: "100%", marginTop: 6 }} />
                </div>
                <input value={line.qty_return ?? ""} onChange={(e) => updateLine(index, "qty_return", e.target.value)} disabled={purchaseReturn.return_status !== "draft"} />
                <input value={line.uom || ""} onChange={(e) => updateLine(index, "uom", e.target.value)} disabled={purchaseReturn.return_status !== "draft"} />
                <input value={line.unit_price_invoice ?? ""} onChange={(e) => updateLine(index, "unit_price_invoice", e.target.value)} disabled={purchaseReturn.return_status !== "draft"} />
                <input value={line.gst_pct ?? ""} onChange={(e) => updateLine(index, "gst_pct", e.target.value)} disabled={purchaseReturn.return_status !== "draft"} />
                <div style={{ height: 34, display: "flex", alignItems: "center" }}>{fmtMoney(lineTotal, purchaseReturn.return_currency_code)}</div>
                <textarea
                  rows={3}
                  value={line.serial_text || ""}
                  onChange={(e) => updateLine(index, "serial_text", e.target.value)}
                  disabled={purchaseReturn.return_status !== "draft" || line.serial_no_required !== true}
                  placeholder={line.serial_no_required ? "One serial per line" : "Not required"}
                />
                <button onClick={() => removeLine(index)} disabled={purchaseReturn.return_status !== "draft"}>Remove</button>
              </div>
            </div>
          );
        }) : <div style={{ padding: 12, opacity: 0.72 }}>No return lines yet.</div>}
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
