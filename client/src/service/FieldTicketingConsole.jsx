import React, { useState } from "react";

export default function FieldTicketingConsole({ tickets = [], onAddTicket, onIssueParts, onUpdateStatus, onRefresh }) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [showPartsModal, setShowPartsModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // New Ticket State
  const [newTicket, setNewTicket] = useState({
    customer_id: "",
    installed_equipment_id: "",
    ticket_priority: "high",
    complaint_type: "breakdown",
    symptom_summary: "",
    reported_by: "",
    site_name: "",
  });

  // Spare Parts Form State
  const [partData, setPartData] = useState({
    product_id: "",
    item_code: "",
    item_name: "",
    qty_issued: 1,
    uom: "NOS",
  });

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onAddTicket(newTicket);
      setShowCreateModal(false);
      setNewTicket({
        customer_id: "",
        installed_equipment_id: "",
        ticket_priority: "high",
        complaint_type: "breakdown",
        symptom_summary: "",
        reported_by: "",
        site_name: "",
      });
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`Service ticket creation failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePartsSubmit = async (e) => {
    e.preventDefault();
    if (!selectedTicket) return;
    setSubmitting(true);
    try {
      await onIssueParts(selectedTicket.id, partData);
      setShowPartsModal(false);
      setPartData({ product_id: "", item_code: "", item_name: "", qty_issued: 1, uom: "NOS" });
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`Spare parts issuance failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (ticketId, nextStatus) => {
    const resolutionNotes = nextStatus === "resolved" ? prompt("Enter service resolution notes:") : null;
    try {
      await onUpdateStatus(ticketId, nextStatus, resolutionNotes);
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`Status update failed: ${err.message || err}`);
    }
  };

  return (
    <div className="sd-panel">
      <div className="sd-panel-header">
        <h3>Customer Service Tickets & Field Dispatch Console</h3>
        <button
          className="sd-btn primary small"
          type="button"
          onClick={() => setShowCreateModal(true)}
        >
          + Log Service Ticket / Breakdown Call
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="sd-table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Ticket #</th>
              <th style={{ width: 160 }}>Customer & Site</th>
              <th style={{ width: 150 }}>Equipment / Serial</th>
              <th>Complaint / Symptoms</th>
              <th style={{ width: 120, textAlign: "center" }}>Coverage SLA</th>
              <th style={{ width: 120, textAlign: "right" }}>Parts Consumed</th>
              <th style={{ width: 110, textAlign: "center" }}>Status</th>
              <th style={{ width: 160, textAlign: "center" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tickets.length === 0 ? (
              <tr>
                <td colSpan="8" style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                  No service tickets logged.
                </td>
              </tr>
            ) : (
              tickets.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.ticket_number}</strong>
                    <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>
                      {t.complaint_type} | {t.ticket_priority}
                    </div>
                  </td>
                  <td>
                    <strong>{t.customer_name}</strong>
                    <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>
                      {t.site_name || "—"}
                    </div>
                  </td>
                  <td>
                    {t.serial_number ? (
                      <div>
                        <strong>{t.serial_number}</strong>
                        <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>{t.equipment_name}</div>
                      </div>
                    ) : (
                      <span style={{ color: "#94a3b8" }}>General / On-site</span>
                    )}
                  </td>
                  <td>
                    <div style={{ maxWidth: 220, fontSize: "0.8125rem" }}>
                      {t.symptom_summary}
                    </div>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {t.is_under_warranty && (
                      <span className="sd-status-chip operational" style={{ marginRight: 4 }}>
                        Warranty
                      </span>
                    )}
                    {t.is_under_amc && (
                      <span className="sd-status-chip active">
                        AMC
                      </span>
                    )}
                    {!t.is_under_warranty && !t.is_under_amc && (
                      <span className="sd-status-chip draft">Chargeable</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                    <strong>₹{Number(t.parts_cost_total || 0).toLocaleString("en-IN")}</strong>
                    <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>
                      {t.parts_consumed_count || 0} parts issued
                    </div>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={`sd-status-chip ${t.ticket_status}`}>
                      {t.ticket_status}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                      {t.ticket_status !== "closed" && (
                        <button
                          className="sd-btn secondary small"
                          type="button"
                          onClick={() => {
                            setSelectedTicket(t);
                            setShowPartsModal(true);
                          }}
                        >
                          + Spare Part
                        </button>
                      )}
                      {t.ticket_status === "open" && (
                        <button
                          className="sd-btn primary small"
                          type="button"
                          onClick={() => handleStatusChange(t.id, "in_progress")}
                        >
                          Start
                        </button>
                      )}
                      {t.ticket_status === "in_progress" && (
                        <button
                          className="sd-btn primary small"
                          style={{ background: "#15803d", borderColor: "#15803d" }}
                          type="button"
                          onClick={() => handleStatusChange(t.id, "resolved")}
                        >
                          Resolve
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Log Ticket Modal */}
      {showCreateModal && (
        <div className="sd-modal-overlay">
          <div className="sd-modal-card">
            <div className="sd-modal-header">
              <h2>Log Customer Service Call / Breakdown Ticket</h2>
              <button
                type="button"
                className="sd-btn secondary small"
                onClick={() => setShowCreateModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateSubmit}>
              <div className="sd-modal-body">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="sd-form-group">
                    <label>Customer ID *</label>
                    <input
                      type="number"
                      required
                      placeholder="e.g. 1"
                      value={newTicket.customer_id}
                      onChange={(e) => setNewTicket({ ...newTicket, customer_id: e.target.value })}
                    />
                  </div>
                  <div className="sd-form-group">
                    <label>Installed Equipment ID (Optional)</label>
                    <input
                      type="number"
                      placeholder="e.g. 1"
                      value={newTicket.installed_equipment_id}
                      onChange={(e) => setNewTicket({ ...newTicket, installed_equipment_id: e.target.value })}
                    />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="sd-form-group">
                    <label>Priority</label>
                    <select
                      value={newTicket.ticket_priority}
                      onChange={(e) => setNewTicket({ ...newTicket, ticket_priority: e.target.value })}
                    >
                      <option value="critical">Critical / Emergency</option>
                      <option value="high">High</option>
                      <option value="normal">Normal</option>
                      <option value="low">Low</option>
                    </select>
                  </div>
                  <div className="sd-form-group">
                    <label>Complaint Type</label>
                    <select
                      value={newTicket.complaint_type}
                      onChange={(e) => setNewTicket({ ...newTicket, complaint_type: e.target.value })}
                    >
                      <option value="breakdown">Equipment Breakdown</option>
                      <option value="preventive">Preventive Maintenance (PM)</option>
                      <option value="installation">Installation & Setup</option>
                      <option value="complaint">General Complaint</option>
                    </select>
                  </div>
                </div>
                <div className="sd-form-group">
                  <label>Symptom Summary / Issue Description *</label>
                  <textarea
                    rows="3"
                    required
                    placeholder="e.g. Compressor tripping on high discharge pressure error code E04"
                    value={newTicket.symptom_summary}
                    onChange={(e) => setNewTicket({ ...newTicket, symptom_summary: e.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="sd-form-group">
                    <label>Reported By (Contact Name)</label>
                    <input
                      type="text"
                      placeholder="e.g. Dr. Verma (Biomedical Head)"
                      value={newTicket.reported_by}
                      onChange={(e) => setNewTicket({ ...newTicket, reported_by: e.target.value })}
                    />
                  </div>
                  <div className="sd-form-group">
                    <label>Site / Hospital Wing</label>
                    <input
                      type="text"
                      placeholder="e.g. Block B Plant Room"
                      value={newTicket.site_name}
                      onChange={(e) => setNewTicket({ ...newTicket, site_name: e.target.value })}
                    />
                  </div>
                </div>
              </div>
              <div className="sd-modal-footer">
                <button
                  type="button"
                  className="sd-btn secondary"
                  onClick={() => setShowCreateModal(false)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button type="submit" className="sd-btn primary" disabled={submitting}>
                  {submitting ? "Logging..." : "Create Ticket"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Spare Parts Issuance Modal */}
      {showPartsModal && selectedTicket && (
        <div className="sd-modal-overlay">
          <div className="sd-modal-card">
            <div className="sd-modal-header">
              <h2>Issue Spare Part for Ticket #{selectedTicket.ticket_number}</h2>
              <button
                type="button"
                className="sd-btn secondary small"
                onClick={() => setShowPartsModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handlePartsSubmit}>
              <div className="sd-modal-body">
                <div className="sd-form-group">
                  <label>Product ID *</label>
                  <input
                    type="number"
                    required
                    placeholder="e.g. 1"
                    value={partData.product_id}
                    onChange={(e) => setPartData({ ...partData, product_id: e.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="sd-form-group">
                    <label>Item Code *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. SOL-VLV-24V"
                      value={partData.item_code}
                      onChange={(e) => setPartData({ ...partData, item_code: e.target.value })}
                    />
                  </div>
                  <div className="sd-form-group">
                    <label>Quantity to Issue *</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={partData.qty_issued}
                      onChange={(e) => setPartData({ ...partData, qty_issued: e.target.value })}
                    />
                  </div>
                </div>
                <div className="sd-form-group">
                  <label>Spare Part Description *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 24V DC Solenoid Valve Assembly"
                    value={partData.item_name}
                    onChange={(e) => setPartData({ ...partData, item_name: e.target.value })}
                  />
                </div>
              </div>
              <div className="sd-modal-footer">
                <button
                  type="button"
                  className="sd-btn secondary"
                  onClick={() => setShowPartsModal(false)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button type="submit" className="sd-btn primary" disabled={submitting}>
                  {submitting ? "Issuing..." : "Issue & Deduct Inventory"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
