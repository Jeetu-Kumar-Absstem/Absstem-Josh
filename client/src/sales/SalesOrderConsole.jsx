import { useState } from "react";

export default function SalesOrderConsole({ orders, onSelectOrder, onConvertToOrder }) {
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [quoteIdInput, setQuoteIdInput] = useState("");
  const [poNumberInput, setPoNumberInput] = useState("");
  const [poDateInput, setPoDateInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleConvertSubmit(e) {
    e.preventDefault();
    if (!quoteIdInput) return;
    setLoading(true);
    try {
      await onConvertToOrder({
        quoteId: quoteIdInput,
        customer_po_number: poNumberInput || null,
        customer_po_date: poDateInput || null,
      });
      setShowConvertModal(false);
      setQuoteIdInput("");
      setPoNumberInput("");
      setPoDateInput("");
    } catch (err) {
      alert(err.message || "Failed to convert quote");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="cd-panel">
      <div className="cd-panel-header">
        <h3>Confirmed Sales Orders & Production Linkages</h3>
        <button
          className="cd-btn primary small"
          type="button"
          onClick={() => setShowConvertModal(true)}
        >
          + Convert Quote to Order
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="cd-table">
          <thead>
            <tr>
              <th style={{ width: 130 }}>SO Number</th>
              <th>Customer</th>
              <th style={{ width: 100 }}>Order Date</th>
              <th style={{ width: 120, textAlign: "right" }}>Grand Total</th>
              <th style={{ width: 110 }}>Customer PO</th>
              <th style={{ width: 130 }}>Linked Work Order</th>
              <th style={{ width: 100, textAlign: "center" }}>Status</th>
              <th style={{ width: 120, textAlign: "center" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {!orders || orders.length === 0 ? (
              <tr>
                <td colSpan="8" style={{ textAlign: "center", padding: 24, color: "#94a3b8" }}>
                  No active sales orders found. Convert an approved quote to get started.
                </td>
              </tr>
            ) : (
              orders.map((so) => (
                <tr key={so.id}>
                  <td style={{ fontWeight: 700, color: "#0f172a" }}>{so.so_number}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{so.customer_name}</div>
                    <div style={{ fontSize: 11, color: "#64748b" }}>{so.customer_gstin || "GST Unspecified"}</div>
                  </td>
                  <td>{so.order_date ? new Date(so.order_date).toLocaleDateString() : "-"}</td>
                  <td style={{ fontWeight: 700, color: "#0f172a", textAlign: "right", fontFamily: "monospace" }}>
                    ₹{Number(so.grand_total_base || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                  </td>
                  <td>{so.customer_po_number || "-"}</td>
                  <td>
                    {so.work_order_no ? (
                      <div>
                        <span style={{ fontWeight: 600, color: "#0284c7" }}>{so.work_order_no}</span>
                        <div style={{ fontSize: 10, color: "#64748b" }}>Status: {so.work_order_status}</div>
                      </div>
                    ) : (
                      <span style={{ color: "#94a3b8", fontSize: 11 }}>Stock item / No WO</span>
                    )}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={`cd-status-chip ${so.order_status}`}>
                      {so.order_status}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <button
                      className="cd-btn secondary small"
                      type="button"
                      onClick={() => onSelectOrder(so.id)}
                    >
                      View & Dispatch
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showConvertModal && (
        <div className="cd-modal-overlay">
          <div className="cd-modal-card">
            <div className="cd-modal-header">
              <h2>Smart Quote-to-Order Conversion</h2>
              <button
                type="button"
                style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer" }}
                onClick={() => setShowConvertModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleConvertSubmit}>
              <div className="cd-modal-body">
                <div className="cd-form-group">
                  <label>Quote ID *</label>
                  <input
                    type="number"
                    placeholder="e.g. 101"
                    value={quoteIdInput}
                    onChange={(e) => setQuoteIdInput(e.target.value)}
                    required
                  />
                  <small style={{ color: "#64748b" }}>Enter the system Quote ID to automatically pull lines and client terms.</small>
                </div>

                <div className="cd-form-group">
                  <label>Customer PO Number</label>
                  <input
                    type="text"
                    placeholder="e.g. PO/ABS/2026/899"
                    value={poNumberInput}
                    onChange={(e) => setPoNumberInput(e.target.value)}
                  />
                </div>

                <div className="cd-form-group">
                  <label>Customer PO Date</label>
                  <input
                    type="date"
                    value={poDateInput}
                    onChange={(e) => setPoDateInput(e.target.value)}
                  />
                </div>

                <small style={{ color: "#64748b" }}>
                  Only issued quotes convert. The order opens as Draft with the quote&apos;s payment, freight and
                  delivery terms — confirm clearance and release it from Sales Orders.
                </small>
              </div>
              <div className="cd-modal-footer">
                <button
                  type="button"
                  className="cd-btn secondary"
                  onClick={() => setShowConvertModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cd-btn primary"
                  disabled={loading}
                >
                  {loading ? "Converting..." : "Convert to Sales Order"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
