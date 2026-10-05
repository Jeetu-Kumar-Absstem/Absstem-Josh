import React from "react";

export default function CommercialServicePulse({ commercialService }) {
  if (!commercialService) return null;

  const {
    pipeline = {},
    sales_orders = {},
    dispatches = {},
    service = {},
  } = commercialService;

  const stages = pipeline.stages || {};

  return (
    <div className="ecc-panel" style={{ gridColumn: "1 / -1" }}>
      <div className="ecc-panel-header">
        <h3>Commercial Sales Momentum & Field Service Operations Pulse</h3>
        <span className="ecc-chip positive">Deals dated in this window</span>
      </div>
      <div className="ecc-panel-body">
        <div className="ecc-split-2">
          {/* Sales & Pipeline Funnel */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.875rem", fontWeight: 700, color: "#0f172a" }}>
                Commercial Deals Funnel ({pipeline.total_deals || 0} Deals)
              </span>
              <span style={{ fontSize: "0.8125rem", color: "var(--absstem-primary, #0ea5e9)", fontWeight: 600 }}>
                Weighted: ₹{Number(pipeline.weighted_value || 0).toLocaleString("en-IN")}
              </span>
            </div>

            {/* Stages Grid */}
            <div className="ecc-metric-box-grid">
              <div className="ecc-metric-box">
                <span className="box-title">Inquiry</span>
                <span className="box-value">₹{Number(stages.inquiry || 0).toLocaleString("en-IN")}</span>
              </div>
              <div className="ecc-metric-box">
                <span className="box-title">Quoted</span>
                <span className="box-value" style={{ color: "#0284c7" }}>
                  ₹{Number(stages.quoted || 0).toLocaleString("en-IN")}
                </span>
              </div>
              <div className="ecc-metric-box">
                <span className="box-title">Negotiation</span>
                <span className="box-value" style={{ color: "#d97706" }}>
                  ₹{Number(stages.negotiation || 0).toLocaleString("en-IN")}
                </span>
              </div>
              <div className="ecc-metric-box">
                <span className="box-title">Won / Closed</span>
                <span className="box-value" style={{ color: "#15803d" }}>
                  ₹{Number(stages.won || 0).toLocaleString("en-IN")}
                </span>
              </div>
            </div>

            {/* Sales Orders & Outbound Fulfillment */}
            <div style={{ background: "#f8fafc", padding: 12, borderRadius: 6, border: "1px solid #e2e8f0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#334155", marginBottom: 4 }}>
                <span>Confirmed Sales Orders:</span>
                <strong>{sales_orders.total_orders || 0} Orders (₹{Number(sales_orders.booked_value || 0).toLocaleString("en-IN")})</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#64748b" }}>
                <span>Dispatches Fulfilled:</span>
                <strong>{sales_orders.dispatched_orders || 0} Shipped ({dispatches.total_packages || 0} Packages / {Number(dispatches.total_weight_kg || 0).toLocaleString("en-IN")} kg)</strong>
              </div>
            </div>
          </div>

          {/* Field Service & Asset Operations */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.875rem", fontWeight: 700, color: "#0f172a" }}>
                Installed Asset Base & Service SLA
              </span>
              <span style={{ fontSize: "0.8125rem", color: "#15803d", fontWeight: 600 }}>
                {service.installed_equipment_count || 0} Serialized Machines
              </span>
            </div>

            {/* Service Metric Boxes */}
            <div className="ecc-metric-box-grid">
              <div className="ecc-metric-box">
                <span className="box-title">Active Warranties</span>
                <span className="box-value" style={{ color: "#15803d" }}>
                  {service.active_warranty_count || 0}
                </span>
              </div>
              <div className="ecc-metric-box">
                <span className="box-title">Active AMCs</span>
                <span className="box-value" style={{ color: "#0284c7" }}>
                  {service.active_amc_count || 0} (₹{Number(service.active_amc_value || 0).toLocaleString("en-IN")})
                </span>
              </div>
              <div className="ecc-metric-box">
                <span className="box-title">Open Calls</span>
                <span className="box-value" style={{ color: service.open_tickets > 0 ? "#b91c1c" : "#15803d" }}>
                  {service.open_tickets || 0}
                </span>
              </div>
              <div className="ecc-metric-box">
                <span className="box-title">Critical SLA Calls</span>
                <span className="box-value" style={{ color: service.critical_open > 0 ? "#b91c1c" : "#64748b" }}>
                  {service.critical_open || 0}
                </span>
              </div>
            </div>

            {/* Service Parts & Resolved Calls */}
            <div style={{ background: "#f8fafc", padding: 12, borderRadius: 6, border: "1px solid #e2e8f0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#334155", marginBottom: 4 }}>
                <span>Resolved Field Interventions:</span>
                <strong style={{ color: "#15803d" }}>{service.resolved_tickets || 0} Tickets Closed</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#64748b" }}>
                <span>Spare Parts Consumed in Field:</span>
                <strong>₹{Number(service.parts_consumed_cost || 0).toLocaleString("en-IN")}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
