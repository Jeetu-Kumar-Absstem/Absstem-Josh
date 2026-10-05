import { useEffect, useState } from "react";
import { SortTh, useSortedRows } from "../shared/tableSort";

const LIST_SORT_KEY = "josh.stockLedger.sort.v1";
const LIST_SORT_SPEC = {
  item_code: { type: "string", defaultDir: "asc" },
  item_name: { type: "string", defaultDir: "asc" },
  uom: { type: "string", defaultDir: "asc" },
  stock_qty: { type: "number", defaultDir: "desc" },
};
const MOVE_SORT_SPEC = {
  movement_date: { type: "date", defaultDir: "desc" },
  qty_signed: { type: "number", defaultDir: "desc" },
  ref_type: { type: "string", defaultDir: "asc" },
  ref_number: { type: "string", defaultDir: "asc" },
};

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

function fmtRefType(value) {
  const labels = {
    TALLY_PURCHASE: "Purchase (Tally)",
    TALLY_SALE: "Sale (Tally)",
    TALLY_STOCK_JOURNAL: "Stock Journal (Tally)",
    TALLY_OPENING: "Opening (Tally)",
    TALLY_CREDIT_NOTE: "Credit Note (Tally)",
    TALLY_DEBIT_NOTE: "Debit Note (Tally)",
    TALLY_STOCK: "Tally Stock",
  };
  return labels[value] || value;
}

function fmtQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

export default function StockLedger({ launch = null, onConsumeLaunch = null } = {}) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState("");
  const { sort, onSort: changeSort, sorted: sortedItems } = useSortedRows(
    items,
    LIST_SORT_SPEC,
    { column: "stock_qty", dir: "desc" },
    { storageKey: LIST_SORT_KEY, tieBreak: (row) => row.item_code }
  );

  async function loadList(nextQuery = "") {
    setLoading(true);
    setError("");
    try {
      const q = String(nextQuery || "").trim();
      const url = q ? `/stock-ledger/products?q=${encodeURIComponent(q)}` : "/stock-ledger/products";
      const data = await apiFetch(url);
      setItems(Array.isArray(data?.products) ? data.products : []);
    } catch (e) {
      setError(e?.data?.error || "Failed to load stock ledger.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") loadList(query);
  }, [view.type]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const productId = Number(launch.product_id);
    const nextQuery = typeof launch.q === "string" ? launch.q : "";
    if (nextQuery) setQuery(nextQuery);
    if (Number.isFinite(productId) && productId > 0) {
      setLoading(true);
      setError("");
      apiFetch(`/stock-ledger/product/${productId}`)
        .then((data) => {
          if (data?.product) setView({ type: "detail", product: data.product });
        })
        .catch((e) => {
          setError(e?.data?.error || "Failed to open stock ledger product.");
        })
        .finally(() => {
          setLoading(false);
          if (typeof onConsumeLaunch === "function") onConsumeLaunch();
        });
      return;
    }
    if (nextQuery) loadList(nextQuery);
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch, onConsumeLaunch]);

  if (view.type === "detail") {
    return <StockLedgerDetail product={view.product} onBack={() => setView({ type: "list" })} />;
  }

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Stock Ledger</h2>
        <button onClick={() => loadList(query)} disabled={loading}>
          Refresh
        </button>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search item code or name"
          style={{ flex: 1, height: 36, padding: "0 10px" }}
          onKeyDown={(e) => {
            if (e.key === "Enter") loadList(query);
          }}
        />
        <button onClick={() => loadList(query)} disabled={loading}>
          Search
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}

      <div
        className="cd-table-responsive"
        style={{ marginTop: 16, border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}
      >
        <table className="cd-table" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr>
              <SortTh column="item_code" label="Item Code" sort={sort} spec={LIST_SORT_SPEC} onSort={changeSort} className="col-left" style={{ width: "200px" }} />
              <SortTh column="item_name" label="Item Name" sort={sort} spec={LIST_SORT_SPEC} onSort={changeSort} className="col-left" />
              <SortTh column="uom" label="UOM" sort={sort} spec={LIST_SORT_SPEC} onSort={changeSort} className="col-center" style={{ width: "100px" }} align="center" />
              <SortTh column="stock_qty" label="Stock Qty" sort={sort} spec={LIST_SORT_SPEC} onSort={changeSort} className="col-right" style={{ width: "140px" }} align="right" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", padding: "24px 12px", color: "#64748b" }}>
                  Loading…
                </td>
              </tr>
            ) : sortedItems.length ? (
              sortedItems.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => setView({ type: "detail", product: item })}
                  style={{ cursor: "pointer" }}
                >
                  <td className="col-left" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontWeight: 700, color: "#1e40af" }}>
                    {item.item_code}
                  </td>
                  <td className="col-left" style={{ fontWeight: 600, color: "#1e293b" }}>
                    {item.item_name}
                  </td>
                  <td className="col-center">{item.uom || "—"}</td>
                  <td className="col-right">{fmtQty(item.stock_qty)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} style={{ padding: "24px 12px", color: "#64748b" }}>
                  No products found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StockLedgerDetail({ product, onBack }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [movements, setMovements] = useState([]);
  const { sort, onSort: setSort, sorted: sortedMovements } = useSortedRows(
    movements,
    MOVE_SORT_SPEC,
    { column: "movement_date", dir: "desc" },
    { tieBreak: (row) => String(row.id) }
  );

  useEffect(() => {
    setLoading(true);
    setError("");
    apiFetch(`/stock-ledger/movements?product_id=${encodeURIComponent(String(product.id))}`)
      .then((data) => setMovements(Array.isArray(data?.movements) ? data.movements : []))
      .catch((e) => setError(e?.data?.error || "Failed to load movements."))
      .finally(() => setLoading(false));
  }, [product.id]);

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{product.item_code}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{product.item_name}</div>
        </div>
        <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>Stock: {fmtQty(product.stock_qty)}</div>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}

      <div
        className="cd-table-responsive"
        style={{ marginTop: 16, border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}
      >
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #e2e8f0", fontWeight: 700 }}>Movements</div>
        <table className="cd-table" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr>
              <SortTh column="movement_date" label="Date" sort={sort} spec={MOVE_SORT_SPEC} onSort={setSort} className="col-left" style={{ width: "140px" }} />
              <SortTh column="qty_signed" label="Qty" sort={sort} spec={MOVE_SORT_SPEC} onSort={setSort} className="col-right" style={{ width: "120px" }} align="right" />
              <SortTh column="ref_type" label="Ref" sort={sort} spec={MOVE_SORT_SPEC} onSort={setSort} className="col-left" style={{ width: "180px" }} />
              <SortTh column="ref_number" label="Ref Number" sort={sort} spec={MOVE_SORT_SPEC} onSort={setSort} className="col-left" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", padding: "24px 12px", color: "#64748b" }}>
                  Loading…
                </td>
              </tr>
            ) : sortedMovements.length ? (
              sortedMovements.map((m) => (
                <tr key={m.id}>
                  <td className="col-left">{fmtDate(m.movement_date)}</td>
                  <td
                    className="col-right"
                    style={{ color: Number(m.qty_signed || 0) < 0 ? "#b00020" : "#0a7a35", fontWeight: 600 }}
                  >
                    {fmtQty(m.qty_signed)}
                  </td>
                  <td className="col-left">{fmtRefType(m.ref_type)}</td>
                  <td className="col-left" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    {m.ref_number || "—"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} style={{ padding: "24px 12px", color: "#64748b" }}>
                  No movements yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
