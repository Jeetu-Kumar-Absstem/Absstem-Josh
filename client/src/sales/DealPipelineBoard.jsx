import { useState } from "react";

const STAGES = [
  { key: "inquiry", label: "Inquiries", badge: "New" },
  { key: "quoted", label: "Quoted", badge: "Sent" },
  { key: "negotiation", label: "Negotiation", badge: "Active" },
  { key: "won", label: "Won / Booking", badge: "Confirmed" },
  { key: "lost", label: "Lost", badge: "Closed" },
];

export default function DealPipelineBoard({ deals, onStageChange, onCreateDeal }) {
  const [activeModal, setActiveModal] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState(null);

  const dealsByStage = STAGES.reduce((acc, stage) => {
    acc[stage.key] = (deals || []).filter((d) => d.stage === stage.key);
    return acc;
  }, {});

  return (
    <div className="cd-pipeline-container">
      <div className="cd-pipeline-board">
        {STAGES.map((stage) => {
          const items = dealsByStage[stage.key] || [];
          const totalVal = items.reduce((sum, item) => sum + Number(item.expected_value || 0), 0);

          return (
            <div key={stage.key} className="cd-column">
              <div className="cd-column-header">
                <div>
                  <span className="cd-column-title">{stage.label}</span>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>
                    ₹{totalVal.toLocaleString("en-IN")}
                  </div>
                </div>
                <span className="cd-column-badge">{items.length}</span>
              </div>

              <div className="cd-column-body">
                {items.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "20px 0", color: "#94a3b8", fontSize: 12 }}>
                    No deals
                  </div>
                ) : (
                  items.map((deal) => (
                    <div key={deal.id} className="cd-deal-card">
                      <div className="cd-deal-header">
                        <span className="cd-deal-code">{deal.deal_code}</span>
                        <span className="cd-deal-val">
                          ₹{Number(deal.expected_value || 0).toLocaleString("en-IN")}
                        </span>
                      </div>
                      <div className="cd-deal-title">{deal.title}</div>
                      <div className="cd-deal-customer">{deal.customer_name || "Direct Customer"}</div>

                      {deal.quote_number && (
                        <div style={{ fontSize: 11, color: "#4338ca", fontWeight: 600 }}>
                          Quote: {deal.quote_number}
                        </div>
                      )}
                      {deal.so_number && (
                        <div style={{ fontSize: 11, color: "#15803d", fontWeight: 600 }}>
                          SO: {deal.so_number}
                        </div>
                      )}

                      <div className="cd-deal-footer">
                        <span>{deal.probability_pct}% prob</span>
                        {deal.stage !== "won" && deal.stage !== "lost" && (
                          <select
                            style={{ fontSize: 11, padding: "2px 4px", borderRadius: 4, border: "1px solid #cbd5e1" }}
                            value={deal.stage}
                            onChange={(e) => onStageChange(deal.id, e.target.value)}
                          >
                            <option value="inquiry">Inquiry</option>
                            <option value="quoted">Quoted</option>
                            <option value="negotiation">Negotiation</option>
                            <option value="won">Won</option>
                            <option value="lost">Lost</option>
                          </select>
                        )}
                        {deal.stage === "won" && <span className="cd-status-chip won">WON</span>}
                        {deal.stage === "lost" && <span className="cd-status-chip lost">LOST</span>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
