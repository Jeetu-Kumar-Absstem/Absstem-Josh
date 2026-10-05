import React, { useState } from "react";

export default function AccountsPayableThreeWayMatchDesk({ bills = [], onProcessBill, onRefresh }) {
  const [showMatchModal, setShowMatchModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    vendor_id: "",
    purchase_order_id: "",
    goods_receipt_id: "",
    vendor_invoice_ref: "",
    bill_date: new Date().toISOString().slice(0, 10),
    lines: [{ item_code: "", item_name: "", qty_billed: 1, unit_price_billed: 0, gst_pct: 18 }],
  });

  const handleLineChange = (index, field, value) => {
    const updated = [...formData.lines];
    updated[index] = { ...updated[index], [field]: value };
    setFormData({ ...formData, lines: updated });
  };

  const addLine = () => {
    setFormData({
      ...formData,
      lines: [...formData.lines, { item_code: "", item_name: "", qty_billed: 1, unit_price_billed: 0, gst_pct: 18 }],
    });
  };

  const removeLine = (index) => {
    if (formData.lines.length <= 1) return;
    setFormData({ ...formData, lines: formData.lines.filter((_, idx) => idx !== index) });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onProcessBill(formData);
      setShowMatchModal(false);
      setFormData({
        vendor_id: "",
        purchase_order_id: "",
        goods_receipt_id: "",
        vendor_invoice_ref: "",
        bill_date: new Date().toISOString().slice(0, 10),
        lines: [{ item_code: "", item_name: "", qty_billed: 1, unit_price_billed: 0, gst_pct: 18 }],
      });
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`3-Way Match validation failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fd-panel">
      <div className="fd-panel-header">
        <h3>Accounts Payable & 3-Way Match Desk (PO vs. GRN vs. Bill)</h3>
        <button
          className="fd-btn primary small"
          type="button"
          onClick={() => setShowMatchModal(true)}
        >
          + Verify & Ingest Vendor Bill
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="fd-table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Bill # / Ref</th>
              <th style={{ width: 100 }}>Date</th>
              <th>Vendor</th>
              <th style={{ width: 140 }}>PO / GRN Linked</th>
              <th style={{ width: 110, textAlign: "right" }}>Subtotal</th>
              <th style={{ width: 110, textAlign: "right" }}>Tax (ITC)</th>
              <th style={{ width: 120, textAlign: "right" }}>Grand Total</th>
              <th style={{ width: 140, textAlign: "center" }}>3-Way Match Status</th>
              <th style={{ width: 110, textAlign: "center" }}>Payment Status</th>
              <th style={{ width: 110, textAlign: "center" }}>Statutory Lock</th>
            </tr>
          </thead>
          <tbody>
            {bills.length === 0 ? (
              <tr>
                <td colSpan="10" style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                  No vendor bills found. Ingest supplier invoices to trigger automated 3-way matching.
                </td>
              </tr>
            ) : (
              bills.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.bill_number}</strong>
                    <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>
                      Ref: {b.vendor_invoice_ref}
                    </div>
                  </td>
                  <td>{b.bill_date ? String(b.bill_date).slice(0, 10) : "—"}</td>
                  <td>
                    <strong>{b.vendor_name}</strong>
                    <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>{b.vendor_code}</div>
                  </td>
                  <td>
                    <div>PO: {b.po_number || `PO #${b.purchase_order_id}`}</div>
                    <small style={{ color: "#64748b" }}>
                      GRN: {b.receipt_number || (b.goods_receipt_id ? `GRN #${b.goods_receipt_id}` : "Direct")}
                    </small>
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                    ₹{Number(b.subtotal || 0).toLocaleString("en-IN")}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                    ₹{Number(b.tax_total || 0).toLocaleString("en-IN")}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                    <strong>₹{Number(b.grand_total || 0).toLocaleString("en-IN")}</strong>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={`fd-status-chip ${b.match_status}`}>
                      {b.match_status === "matched_ok" ? "✓ 3-Way Matched" : b.match_status}
                    </span>
                    {b.match_notes && (
                      <div style={{ fontSize: "0.6875rem", color: "#64748b", maxWidth: 160 }}>
                        {b.match_notes}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={`fd-status-chip ${b.payment_status}`}>
                      {b.payment_status}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {b.statutory_verified ? (
                      <span style={{ color: "#15803d", fontSize: "0.75rem", fontWeight: 600 }}>
                        ✓ Verified
                      </span>
                    ) : (
                      <span style={{ color: "#b91c1c", fontSize: "0.75rem", fontWeight: 600 }}>
                        🔒 Locked
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showMatchModal && (
        <div className="fd-modal-overlay">
          <div className="fd-modal-card" style={{ maxWidth: 700 }}>
            <div className="fd-modal-header">
              <h2>Ingest & 3-Way Match Vendor Bill</h2>
              <button
                type="button"
                className="fd-btn secondary small"
                onClick={() => setShowMatchModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="fd-modal-body">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="fd-form-group">
                    <label>Vendor ID *</label>
                    <input
                      type="number"
                      required
                      placeholder="e.g. 1"
                      value={formData.vendor_id}
                      onChange={(e) => setFormData({ ...formData, vendor_id: e.target.value })}
                    />
                  </div>
                  <div className="fd-form-group">
                    <label>Purchase Order ID *</label>
                    <input
                      type="number"
                      required
                      placeholder="e.g. 1"
                      value={formData.purchase_order_id}
                      onChange={(e) => setFormData({ ...formData, purchase_order_id: e.target.value })}
                    />
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="fd-form-group">
                    <label>Goods Receipt (GRN) ID (Optional)</label>
                    <input
                      type="number"
                      placeholder="e.g. 1"
                      value={formData.goods_receipt_id}
                      onChange={(e) => setFormData({ ...formData, goods_receipt_id: e.target.value })}
                    />
                  </div>
                  <div className="fd-form-group">
                    <label>Vendor Invoice Ref / Number *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. VEND-INV-99201"
                      value={formData.vendor_invoice_ref}
                      onChange={(e) => setFormData({ ...formData, vendor_invoice_ref: e.target.value })}
                    />
                  </div>
                </div>

                <div className="fd-form-group">
                  <label>Bill Date</label>
                  <input
                    type="date"
                    required
                    value={formData.bill_date}
                    onChange={(e) => setFormData({ ...formData, bill_date: e.target.value })}
                  />
                </div>

                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <label style={{ fontSize: "0.75rem", fontWeight: 600, color: "#475569" }}>
                      Billed Line Items
                    </label>
                    <button type="button" className="fd-btn secondary small" onClick={addLine}>
                      + Add Line
                    </button>
                  </div>

                  {formData.lines.map((l, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "2fr 1fr 1fr 1fr auto",
                        gap: 8,
                        marginBottom: 8,
                        alignItems: "center",
                      }}
                    >
                      <input
                        type="text"
                        required
                        placeholder="Item Code"
                        value={l.item_code}
                        onChange={(e) => handleLineChange(idx, "item_code", e.target.value)}
                      />
                      <input
                        type="number"
                        step="0.0001"
                        required
                        placeholder="Qty"
                        value={l.qty_billed}
                        onChange={(e) => handleLineChange(idx, "qty_billed", e.target.value)}
                      />
                      <input
                        type="number"
                        step="0.01"
                        required
                        placeholder="Rate (₹)"
                        value={l.unit_price_billed}
                        onChange={(e) => handleLineChange(idx, "unit_price_billed", e.target.value)}
                      />
                      <select
                        value={l.gst_pct}
                        onChange={(e) => handleLineChange(idx, "gst_pct", e.target.value)}
                      >
                        <option value="5">5% GST</option>
                        <option value="12">12% GST</option>
                        <option value="18">18% GST</option>
                        <option value="28">28% GST</option>
                      </select>
                      <button
                        type="button"
                        className="fd-btn secondary small"
                        style={{ color: "#ef4444" }}
                        onClick={() => removeLine(idx)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="fd-modal-footer">
                <button
                  type="button"
                  className="fd-btn secondary"
                  onClick={() => setShowMatchModal(false)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button type="submit" className="fd-btn primary" disabled={submitting}>
                  {submitting ? "Verifying Match..." : "Run 3-Way Match & Book AP"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
