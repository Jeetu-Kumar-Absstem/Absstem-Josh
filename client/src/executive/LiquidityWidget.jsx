import React from "react";

export default function LiquidityWidget({ workingCapital }) {
  if (!workingCapital) return null;

  const {
    liquid_cash_balance = 0,
    net_working_capital = 0,
    collection_velocity_pct = 0,
    receivables = {},
    payables = {},
    tax_position = {},
  } = workingCapital;

  const arAging = receivables.aging || {};
  const apAging = payables.aging || {};

  return (
    <div className="ecc-panel">
      <div className="ecc-panel-header">
        <h3>Working Capital, Liquidity & Cash Flow Velocity</h3>
        <span className="ecc-chip positive">AR / AP / cash as of window end</span>
      </div>
      <div className="ecc-panel-body">
        {/* Velocity Gauge */}
        <div className="ecc-progress-group">
          <div className="ecc-progress-label">
            <span>Invoices dated in this window</span>
            <span style={{ color: "var(--absstem-primary, #0ea5e9)" }}>
              {Number(receivables.invoiced || 0) > 0
                ? `${collection_velocity_pct}% collected`
                : "None dated in window"}
            </span>
          </div>
          <div className="ecc-progress-bar-bg">
            <div
              className="ecc-progress-bar-fill"
              style={{
                width: `${Math.min(100, Math.max(0, collection_velocity_pct))}%`,
                background: "var(--absstem-primary, #0ea5e9)",
              }}
            />
          </div>
        </div>

        {/* Quick Position Matrix */}
        <div className="ecc-metric-box-grid">
          <div className="ecc-metric-box">
            <span className="box-title">Cash & Bank</span>
            <span className="box-value" style={{ color: "#15803d" }}>
              ₹{Number(liquid_cash_balance).toLocaleString("en-IN")}
            </span>
          </div>
          <div className="ecc-metric-box">
            <span className="box-title">Total AR (Receivables)</span>
            <span className="box-value" style={{ color: "#0284c7" }}>
              ₹{Number(receivables.total || 0).toLocaleString("en-IN")}
            </span>
          </div>
          <div className="ecc-metric-box">
            <span className="box-title">Total AP (Payables)</span>
            <span className="box-value" style={{ color: "#d97706" }}>
              ₹{Number(payables.total || 0).toLocaleString("en-IN")}
            </span>
          </div>
          <div className="ecc-metric-box">
            <span className="box-title">Net GST Liability</span>
            <span className="box-value" style={{ color: tax_position.net_gst_payable > 0 ? "#b91c1c" : "#15803d" }}>
              ₹{Number(tax_position.net_gst_payable || 0).toLocaleString("en-IN")}
            </span>
          </div>
        </div>

        {/* Aging Breakdown */}
        <div className="ecc-subgrid-2">
          {/* AR Aging */}
          <div style={{ background: "#f8fafc", padding: 12, borderRadius: 6, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 8px", fontSize: "0.8125rem", color: "#334155" }}>
              AR Aging Buckets ({receivables.active_count || 0} Open)
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.75rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>&lt; 30 Days:</span>
                <strong>₹{Number(arAging.under_30 || 0).toLocaleString("en-IN")}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>31 - 60 Days:</span>
                <strong>₹{Number(arAging.days_31_60 || 0).toLocaleString("en-IN")}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>61 - 90 Days:</span>
                <strong style={{ color: "#d97706" }}>₹{Number(arAging.days_61_90 || 0).toLocaleString("en-IN")}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>&gt; 90 Days Overdue:</span>
                <strong style={{ color: "#b91c1c" }}>₹{Number(arAging.over_90 || 0).toLocaleString("en-IN")}</strong>
              </div>
            </div>
          </div>

          {/* AP 3-Way Match & Aging */}
          <div style={{ background: "#f8fafc", padding: 12, borderRadius: 6, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 8px", fontSize: "0.8125rem", color: "#334155" }}>
              AP 3-Way Match & Payables ({payables.active_count || 0} Open)
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.75rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>✓ 3-Way Verified:</span>
                <strong style={{ color: "#15803d" }}>{payables.matched_count || 0} Bills</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>⚠ Mismatch / On Hold:</span>
                <strong style={{ color: "#b91c1c" }}>{payables.mismatch_count || 0} Bills</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Due &lt; 30 Days:</span>
                <strong>₹{Number(apAging.under_30 || 0).toLocaleString("en-IN")}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Due &gt; 30 Days:</span>
                <strong>₹{Number((apAging.days_31_60 || 0) + (apAging.over_60 || 0)).toLocaleString("en-IN")}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
