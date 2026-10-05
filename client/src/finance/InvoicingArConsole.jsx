import React, { useState } from "react";

export default function InvoicingArConsole({ invoices = [], onRecordPayment, onRefresh }) {
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleOpenPaymentModal = (inv) => {
    setSelectedInvoice(inv);
    setPaymentAmount(inv.balance_due || inv.grand_total_base);
  };

  const handlePaymentSubmit = async (e) => {
    e.preventDefault();
    if (!selectedInvoice || !paymentAmount) return;
    setSubmitting(true);
    try {
      await onRecordPayment(selectedInvoice.id, Number(paymentAmount));
      setSelectedInvoice(null);
      setPaymentAmount("");
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`Payment recording failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fd-panel">
      <div className="fd-panel-header">
        <h3>Customer Tax Invoices & Accounts Receivable (AR)</h3>
        <span style={{ fontSize: "0.8125rem", color: "#64748b" }}>
          Showing {invoices.length} Invoices
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="fd-table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Invoice #</th>
              <th style={{ width: 110 }}>Date / Due</th>
              <th>Customer</th>
              <th style={{ width: 140 }}>Sales Order / Dispatch</th>
              <th style={{ width: 160 }}>Tax Breakdown</th>
              <th style={{ width: 120, textAlign: "right" }}>Grand Total</th>
              <th style={{ width: 120, textAlign: "right" }}>Balance Due</th>
              <th style={{ width: 100, textAlign: "center" }}>Status</th>
              <th style={{ width: 120, textAlign: "center" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 ? (
              <tr>
                <td colSpan="9" style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                  No customer invoices found. Invoices are generated automatically on confirmed dispatches.
                </td>
              </tr>
            ) : (
              invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>
                    <strong>{inv.invoice_number}</strong>
                    {inv.is_interstate && (
                      <span style={{ display: "block", fontSize: "0.6875rem", color: "#0284c7" }}>
                        Interstate IGST
                      </span>
                    )}
                  </td>
                  <td>
                    <div>{inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : "—"}</div>
                    <small style={{ color: "#94a3b8" }}>
                      Due: {inv.due_date ? String(inv.due_date).slice(0, 10) : "—"}
                    </small>
                  </td>
                  <td>
                    <strong>{inv.customer_name}</strong>
                    {inv.customer_gstin && (
                      <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>
                        GSTIN: {inv.customer_gstin}
                      </div>
                    )}
                  </td>
                  <td>
                    <div>{inv.so_number || "—"}</div>
                    <small style={{ color: "#64748b" }}>Disp: {inv.dispatch_number || "—"}</small>
                  </td>
                  <td>
                    {inv.is_interstate ? (
                      <div>IGST: ₹{Number(inv.igst_amount || 0).toLocaleString("en-IN")}</div>
                    ) : (
                      <div style={{ fontSize: "0.75rem" }}>
                        CGST: ₹{Number(inv.cgst_amount || 0).toLocaleString("en-IN")} | SGST: ₹{Number(inv.sgst_amount || 0).toLocaleString("en-IN")}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                    <strong>₹{Number(inv.grand_total_base || 0).toLocaleString("en-IN")}</strong>
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                    <strong style={{ color: Number(inv.balance_due) > 0 ? "#b91c1c" : "#15803d" }}>
                      ₹{Number(inv.balance_due ?? inv.grand_total_base ?? 0).toLocaleString("en-IN")}
                    </strong>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={`fd-status-chip ${inv.invoice_status}`}>
                      {inv.invoice_status}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {inv.invoice_status !== "paid" && (
                      <button
                        className="fd-btn primary small"
                        type="button"
                        onClick={() => handleOpenPaymentModal(inv)}
                      >
                        Record Payment
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selectedInvoice && (
        <div className="fd-modal-overlay">
          <div className="fd-modal-card">
            <div className="fd-modal-header">
              <h2>Record AR Customer Payment</h2>
              <button
                type="button"
                className="fd-btn secondary small"
                onClick={() => setSelectedInvoice(null)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handlePaymentSubmit}>
              <div className="fd-modal-body">
                <div className="fd-form-group">
                  <label>Invoice Number</label>
                  <input type="text" value={selectedInvoice.invoice_number} disabled />
                </div>
                <div className="fd-form-group">
                  <label>Customer</label>
                  <input type="text" value={selectedInvoice.customer_name} disabled />
                </div>
                <div className="fd-form-group">
                  <label>Total Outstanding Balance (₹)</label>
                  <input
                    type="text"
                    value={`₹ ${Number(selectedInvoice.balance_due || selectedInvoice.grand_total_base).toLocaleString("en-IN")}`}
                    disabled
                  />
                </div>
                <div className="fd-form-group">
                  <label>Payment Amount Received (₹) *</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                  />
                </div>
              </div>
              <div className="fd-modal-footer">
                <button
                  type="button"
                  className="fd-btn secondary"
                  onClick={() => setSelectedInvoice(null)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button type="submit" className="fd-btn primary" disabled={submitting}>
                  {submitting ? "Posting..." : "Clear AR & Post to Bank"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
