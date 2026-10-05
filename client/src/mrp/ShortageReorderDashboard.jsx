import React, { useState } from "react";

export default function ShortageReorderDashboard({ requirements = [], onGenerateRequisitions, onRefresh }) {
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);

  const toggleSelectAll = () => {
    if (selectedItems.size === requirements.filter((r) => r.recommended_reorder_qty > 0).length) {
      setSelectedItems(new Set());
    } else {
      const allShortageKeys = new Set(
        requirements.filter((r) => r.recommended_reorder_qty > 0).map((r) => r.item_code)
      );
      setSelectedItems(allShortageKeys);
    }
  };

  const toggleItem = (code) => {
    const next = new Set(selectedItems);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setSelectedItems(next);
  };

  const handleGenerateClick = async () => {
    setSubmitting(true);
    try {
      const itemsToOrder = requirements.filter((r) =>
        selectedItems.size > 0 ? selectedItems.has(r.item_code) : r.recommended_reorder_qty > 0
      );
      const res = await onGenerateRequisitions(itemsToOrder);
      alert(res?.message || "Purchase Requisitions created successfully!");
      setSelectedItems(new Set());
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`Requisition generation failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const shortageItems = requirements.filter((r) => r.recommended_reorder_qty > 0);
  const totalEstimatedReorderCost = shortageItems.reduce((sum, r) => sum + Number(r.estimated_total_cost || 0), 0);

  return (
    <div className="mrp-panel">
      <div className="mrp-panel-header">
        <div>
          <h3>Material Shortage & Predictive Reorder Queue (MRP II)</h3>
          <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
            {shortageItems.length} Shortage Items Detected (Est. Procurement: ₹{totalEstimatedReorderCost.toLocaleString("en-IN")})
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="mrp-btn secondary small"
            type="button"
            onClick={toggleSelectAll}
          >
            {selectedItems.size === shortageItems.length && shortageItems.length > 0 ? "Deselect All" : "Select All Shortages"}
          </button>
          <button
            className="mrp-btn primary small"
            type="button"
            disabled={submitting || shortageItems.length === 0}
            onClick={handleGenerateClick}
          >
            {submitting ? "Generating PRs..." : `⚡ Auto-Generate ${selectedItems.size || shortageItems.length} Requisitions`}
          </button>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="mrp-table">
          <thead>
            <tr>
              <th style={{ width: 32, textAlign: "center" }}></th>
              <th>Item Code / Description</th>
              <th style={{ width: 110, textAlign: "right" }}>Stock on Hand</th>
              <th style={{ width: 100, textAlign: "right" }}>Open PO Qty</th>
              <th style={{ width: 120, textAlign: "right" }}>Work Order Demand</th>
              <th style={{ width: 110, textAlign: "right" }}>Safety Threshold</th>
              <th style={{ width: 110, textAlign: "right" }}>Net Shortage</th>
              <th style={{ width: 130, textAlign: "right" }}>Recommended Order</th>
              <th style={{ width: 140 }}>Preferred Vendor</th>
              <th style={{ width: 120, textAlign: "right" }}>Est. Total Cost</th>
              <th style={{ width: 110, textAlign: "center" }}>MRP Status</th>
            </tr>
          </thead>
          <tbody>
            {requirements.length === 0 ? (
              <tr>
                <td colSpan="11" style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                  No material requirements found. Stock is optimal across all component specifications.
                </td>
              </tr>
            ) : (
              requirements.map((r) => {
                const isSelected = selectedItems.has(r.item_code);
                const hasShortage = r.recommended_reorder_qty > 0;
                return (
                  <tr key={r.item_code} style={{ background: isSelected ? "#f0f9ff" : "inherit" }}>
                    <td style={{ textAlign: "center" }}>
                      {hasShortage && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleItem(r.item_code)}
                        />
                      )}
                    </td>
                    <td>
                      <strong>{r.item_code}</strong>
                      <div style={{ fontSize: "0.75rem", color: "#475569" }}>{r.item_name}</div>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong style={{ color: r.current_stock < r.safety_stock ? "#b91c1c" : "#1e293b" }}>
                        {r.current_stock} {r.uom}
                      </strong>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>{r.open_po_qty} {r.uom}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong style={{ color: r.gross_demand > 0 ? "#0ea5e9" : "#64748b" }}>
                        {r.gross_demand} {r.uom}
                      </strong>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>{r.safety_stock} {r.uom}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong style={{ color: r.net_shortage > 0 ? "#b91c1c" : "#15803d" }}>
                        {r.net_shortage > 0 ? `-${r.net_shortage} ${r.uom}` : "✓ Covered"}
                      </strong>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong style={{ color: r.recommended_reorder_qty > 0 ? "#d97706" : "#64748b" }}>
                        {r.recommended_reorder_qty > 0 ? `${r.recommended_reorder_qty} ${r.uom}` : "0"}
                      </strong>
                    </td>
                    <td>
                      <div style={{ fontSize: "0.75rem", fontWeight: 600 }}>{r.preferred_vendor_name}</div>
                      <small style={{ color: "#64748b" }}>Lead: {r.lead_time_days} days</small>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong>₹{Number(r.estimated_total_cost || 0).toLocaleString("en-IN")}</strong>
                      <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>@ ₹{r.estimated_unit_price}/unit</div>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`mrp-status-chip ${r.status}`}>
                        {r.status === "critical_shortage" ? "Critical" : r.status === "reorder_needed" ? "Reorder Due" : "Optimal"}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
