import React from "react";

export default function ShopFloorHealthPanel({ manufacturing }) {
  if (!manufacturing) return null;

  const {
    completion_efficiency_pct = 0,
    work_orders = {},
    scrap = {},
    inventory = {},
  } = manufacturing;

  return (
    <div className="ecc-panel">
      <div className="ecc-panel-header">
        <h3>Manufacturing & Shop Floor Execution Health</h3>
        <span className="ecc-chip neutral">Production Kitting Active</span>
      </div>
      <div className="ecc-panel-body">
        {/* Work Order Efficiency Gauge */}
        <div className="ecc-progress-group">
          <div className="ecc-progress-label">
            <span>Work Order Completion Efficiency</span>
            <span style={{ color: "#15803d" }}>
              {completion_efficiency_pct}% Completed
            </span>
          </div>
          <div className="ecc-progress-bar-bg">
            <div
              className="ecc-progress-bar-fill"
              style={{
                width: `${Math.min(100, Math.max(0, completion_efficiency_pct))}%`,
                background: "#15803d",
              }}
            />
          </div>
        </div>

        {/* Work Order Lifecycle Matrix */}
        <div className="ecc-metric-box-grid">
          <div className="ecc-metric-box">
            <span className="box-title">Total Work Orders</span>
            <span className="box-value">{work_orders.total || 0}</span>
          </div>
          <div className="ecc-metric-box">
            <span className="box-title">Scheduled</span>
            <span className="box-value" style={{ color: "#0284c7" }}>
              {work_orders.scheduled || 0}
            </span>
          </div>
          <div className="ecc-metric-box">
            <span className="box-title">In Production</span>
            <span className="box-value" style={{ color: "#d97706" }}>
              {work_orders.in_production || 0}
            </span>
          </div>
          <div className="ecc-metric-box">
            <span className="box-title">Completed FG</span>
            <span className="box-value" style={{ color: "#15803d" }}>
              {work_orders.completed || 0}
            </span>
          </div>
        </div>

        {/* Scrap Variance & Inventory Valuation */}
        <div className="ecc-subgrid-2">
          {/* Scrap Analysis */}
          <div style={{ background: "#f8fafc", padding: 12, borderRadius: 6, border: "1px solid #e2e8f0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h4 style={{ margin: 0, fontSize: "0.8125rem", color: "#334155" }}>
                Material Scrap & Variances
              </h4>
              <span className="ecc-chip alert">
                ₹{Number(scrap.total_variance_cost || 0).toLocaleString("en-IN")}
              </span>
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: 6 }}>
              {scrap.incidents || 0} scrap logs ({Number(scrap.total_qty || 0).toLocaleString("en-IN")} units)
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "0.6875rem" }}>
              {scrap.top_reasons && scrap.top_reasons.length > 0 ? (
                scrap.top_reasons.map((r, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ textTransform: "capitalize" }}>• {r.reason}:</span>
                    <strong>₹{Number(r.variance_cost || 0).toLocaleString("en-IN")}</strong>
                  </div>
                ))
              ) : (
                <span style={{ color: "#94a3b8" }}>No significant scrap recorded</span>
              )}
            </div>
          </div>

          {/* Inventory Valuation */}
          <div style={{ background: "#f8fafc", padding: 12, borderRadius: 6, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 6px", fontSize: "0.8125rem", color: "#334155" }}>
              Warehouse on-hand (live)
            </h4>
            <div style={{ fontSize: "1.2rem", fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>
              ₹{Number(inventory.total_valuation || 0).toLocaleString("en-IN")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "0.75rem", color: "#64748b" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Active Stock SKUs:</span>
                <strong style={{ color: "#15803d" }}>{inventory.active_sku_count || 0} SKUs</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Out of Stock Items:</span>
                <strong style={{ color: inventory.out_of_stock_count > 0 ? "#b91c1c" : "#64748b" }}>
                  {inventory.out_of_stock_count || 0} SKUs
                </strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
