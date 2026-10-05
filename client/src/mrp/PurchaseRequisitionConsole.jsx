import React, { useState } from "react";

export default function PurchaseRequisitionConsole({ requisitions = [], onConvertToPo, onRefresh }) {
  const [selectedPr, setSelectedPr] = useState(null);
  const [vendorId, setVendorId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleOpenConvert = (pr) => {
    setSelectedPr(pr);
    setVendorId(pr.vendor_id || "");
  };

  const handleConvertSubmit = async (e) => {
    e.preventDefault();
    if (!selectedPr) return;
    setSubmitting(true);
    try {
      await onConvertToPo(selectedPr.id, vendorId ? Number(vendorId) : null);
      setSelectedPr(null);
      setVendorId("");
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`PO conversion failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mrp-panel">
      <div className="mrp-panel-header">
        <h3>Purchase Requisitions (PR) Management & PO Conversion</h3>
        <span style={{ fontSize: "0.8125rem", color: "#64748b" }}>
          Showing {requisitions.length} Requisitions
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="mrp-table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Requisition #</th>
              <th style={{ width: 110 }}>Date / Required</th>
              <th>Preferred Vendor (AVL)</th>
              <th style={{ width: 160 }}>Department / Purpose</th>
              <th style={{ width: 80, textAlign: "center" }}>Lines</th>
              <th style={{ width: 120, textAlign: "right" }}>Est. Total</th>
              <th style={{ width: 100, textAlign: "center" }}>Source</th>
              <th style={{ width: 100, textAlign: "center" }}>Status</th>
              <th style={{ width: 120, textAlign: "center" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {requisitions.length === 0 ? (
              <tr>
                <td colSpan="9" style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                  No purchase requisitions found. Requisitions generated from MRP will appear here.
                </td>
              </tr>
            ) : (
              requisitions.map((pr) => (
                <tr key={pr.id}>
                  <td>
                    <strong>{pr.requisition_number}</strong>
                    {pr.po_number && (
                      <div style={{ fontSize: "0.6875rem", color: "#15803d" }}>
                        PO: {pr.po_number}
                      </div>
                    )}
                  </td>
                  <td>
                    <div>{pr.requisition_date ? String(pr.requisition_date).slice(0, 10) : "—"}</div>
                    <small style={{ color: "#64748b" }}>
                      Need: {pr.required_by_date ? String(pr.required_by_date).slice(0, 10) : "—"}
                    </small>
                  </td>
                  <td>
                    <strong>{pr.vendor_name || "Unassigned / Open RFQ"}</strong>
                    {pr.vendor_code && (
                      <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>{pr.vendor_code}</div>
                    )}
                  </td>
                  <td>
                    <div>{pr.department || "Production Planning"}</div>
                    <small style={{ color: "#64748b" }}>{pr.purpose || "Material Procurement"}</small>
                  </td>
                  <td style={{ textAlign: "center", fontWeight: 700 }}>
                    {pr.total_lines || 1}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                    <strong>₹{Number(pr.estimated_total || 0).toLocaleString("en-IN")}</strong>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {pr.mrp_generated ? (
                      <span className="mrp-status-chip submitted" style={{ fontSize: "0.625rem" }}>
                        ⚡ MRP Auto
                      </span>
                    ) : (
                      <span className="mrp-status-chip draft" style={{ fontSize: "0.625rem" }}>
                        Manual
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={`mrp-status-chip ${pr.requisition_status}`}>
                      {pr.requisition_status}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {pr.requisition_status !== "closed" && (
                      <button
                        className="mrp-btn primary small"
                        type="button"
                        onClick={() => handleOpenConvert(pr)}
                      >
                        Convert to PO
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selectedPr && (
        <div className="mrp-modal-overlay">
          <div className="mrp-modal-card">
            <div className="mrp-modal-header">
              <h2>Convert PR #{selectedPr.requisition_number} to Purchase Order</h2>
              <button
                type="button"
                className="mrp-btn secondary small"
                onClick={() => setSelectedPr(null)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleConvertSubmit}>
              <div className="mrp-modal-body">
                <div className="mrp-form-group">
                  <label>Requisition Number</label>
                  <input type="text" value={selectedPr.requisition_number} disabled />
                </div>
                <div className="mrp-form-group">
                  <label>Estimated Total (₹)</label>
                  <input
                    type="text"
                    value={`₹ ${Number(selectedPr.estimated_total || 0).toLocaleString("en-IN")}`}
                    disabled
                  />
                </div>
                <div className="mrp-form-group">
                  <label>Assigned Approved Vendor ID *</label>
                  <input
                    type="number"
                    required
                    placeholder="Enter Vendor ID"
                    value={vendorId}
                    onChange={(e) => setVendorId(e.target.value)}
                  />
                  <small style={{ color: "#64748b" }}>
                    Currently selected: {selectedPr.vendor_name || "None (Please enter Vendor ID)"}
                  </small>
                </div>
              </div>
              <div className="mrp-modal-footer">
                <button
                  type="button"
                  className="mrp-btn secondary"
                  onClick={() => setSelectedPr(null)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button type="submit" className="mrp-btn primary" disabled={submitting}>
                  {submitting ? "Converting..." : "Generate Formal Purchase Order"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
