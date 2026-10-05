import React from "react";

export default function SupplierPerformanceTracker({ performance = [] }) {
  return (
    <div className="mrp-panel">
      <div className="mrp-panel-header">
        <h3>Supplier Performance & Delivery Timeliness Tracker</h3>
        <span style={{ fontSize: "0.8125rem", color: "#64748b" }}>
          Historical PO vs. Goods Receipt (GRN) Analytics
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="mrp-table">
          <thead>
            <tr>
              <th>Vendor Name / Code</th>
              <th style={{ width: 130, textAlign: "center" }}>Orders Placed</th>
              <th style={{ width: 140, textAlign: "right" }}>On-Time Delivery</th>
              <th style={{ width: 140, textAlign: "right" }}>Quality Pass Rate</th>
              <th style={{ width: 120, textAlign: "right" }}>Avg. Lead Time</th>
              <th style={{ width: 160, textAlign: "center" }}>Reliability Score</th>
              <th style={{ width: 130, textAlign: "center" }}>Status Rating</th>
            </tr>
          </thead>
          <tbody>
            {performance.length === 0 ? (
              <tr>
                <td colSpan="7" style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                  No supplier performance metrics evaluated yet.
                </td>
              </tr>
            ) : (
              performance.map((s) => {
                const score = Number(s.vendor_score || 0);
                const onTime = Number(s.on_time_delivery_rate_pct || 100);
                const quality = Number(s.quality_pass_rate_pct || 100);
                const lead = Number(s.average_lead_time_days || 0);

                let ratingLabel = "Preferred Tier 1";
                let ratingClass = "optimal";
                if (score < 80) {
                  ratingLabel = "At Risk / Slow";
                  ratingClass = "critical_shortage";
                } else if (score < 90) {
                  ratingLabel = "Tier 2 Standard";
                  ratingClass = "reorder_needed";
                }

                return (
                  <tr key={s.vendor_id}>
                    <td>
                      <strong>{s.vendor_name}</strong>
                      <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>{s.vendor_code}</div>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <strong>{s.total_orders_placed || 0} POs</strong>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong style={{ color: onTime >= 95 ? "#15803d" : "#d97706" }}>
                        {onTime}%
                      </strong>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong style={{ color: quality >= 98 ? "#15803d" : "#d97706" }}>
                        {quality}%
                      </strong>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong>{lead} days</strong>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                        <div
                          style={{
                            width: 60,
                            height: 6,
                            background: "#e2e8f0",
                            borderRadius: 3,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.min(100, score)}%`,
                              height: "100%",
                              background: score >= 90 ? "#15803d" : score >= 80 ? "#d97706" : "#b91c1c",
                            }}
                          />
                        </div>
                        <strong>{score}/100</strong>
                      </div>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`mrp-status-chip ${ratingClass}`}>
                        {ratingLabel}
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
