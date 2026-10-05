import React, { useState } from "react";

export default function AmcContractDashboard({ contracts = [], onAddContract, onRefresh }) {
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    customer_id: "",
    installed_equipment_id: "",
    start_date: new Date().toISOString().slice(0, 10),
    end_date: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
    planned_visits: 4,
    contract_value: 0,
    remarks: "",
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onAddContract(formData);
      setShowModal(false);
      setFormData({
        customer_id: "",
        installed_equipment_id: "",
        start_date: new Date().toISOString().slice(0, 10),
        end_date: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
        planned_visits: 4,
        contract_value: 0,
        remarks: "",
      });
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`AMC Contract creation failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sd-panel">
      <div className="sd-panel-header">
        <h3>Annual Maintenance Contracts (AMCs) & Preventive Maintenance</h3>
        <button
          className="sd-btn primary small"
          type="button"
          onClick={() => setShowModal(true)}
        >
          + Create AMC Contract
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="sd-table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Contract #</th>
              <th>Customer</th>
              <th style={{ width: 160 }}>Linked Equipment / Serial</th>
              <th style={{ width: 140 }}>Period (Start - End)</th>
              <th style={{ width: 130, textAlign: "center" }}>Planned Visits</th>
              <th style={{ width: 120, textAlign: "right" }}>Contract Value</th>
              <th style={{ width: 100, textAlign: "center" }}>Status</th>
              <th style={{ width: 120, textAlign: "center" }}>Renewal Status</th>
            </tr>
          </thead>
          <tbody>
            {contracts.length === 0 ? (
              <tr>
                <td colSpan="8" style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                  No active AMC contracts found.
                </td>
              </tr>
            ) : (
              contracts.map((c) => {
                const isActive = c.end_date && new Date(c.end_date) >= new Date();
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.contract_number}</strong>
                    </td>
                    <td>
                      <strong>{c.customer_name}</strong>
                    </td>
                    <td>
                      {c.serial_number ? (
                        <div>
                          <strong>{c.serial_number}</strong>
                          <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>{c.equipment_name}</div>
                        </div>
                      ) : (
                        <span style={{ color: "#94a3b8" }}>Facility-wide AMC</span>
                      )}
                    </td>
                    <td>
                      <div>{c.start_date ? String(c.start_date).slice(0, 10) : "—"}</div>
                      <small style={{ color: "#64748b" }}>
                        to {c.end_date ? String(c.end_date).slice(0, 10) : "—"}
                      </small>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <strong>{c.planned_visits || 4} PM Visits/yr</strong>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong>₹{Number(c.contract_value || 0).toLocaleString("en-IN")}</strong>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`sd-status-chip ${isActive ? "active" : "closed"}`}>
                        {isActive ? "active" : "expired"}
                      </span>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span style={{ fontSize: "0.75rem", color: isActive ? "#15803d" : "#b91c1c", fontWeight: 600 }}>
                        {isActive ? "Coverage Good" : "Renewal Due"}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="sd-modal-overlay">
          <div className="sd-modal-card">
            <div className="sd-modal-header">
              <h2>Create Annual Maintenance Contract (AMC)</h2>
              <button
                type="button"
                className="sd-btn secondary small"
                onClick={() => setShowModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="sd-modal-body">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="sd-form-group">
                    <label>Customer ID *</label>
                    <input
                      type="number"
                      required
                      placeholder="e.g. 1"
                      value={formData.customer_id}
                      onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
                    />
                  </div>
                  <div className="sd-form-group">
                    <label>Installed Equipment ID (Optional)</label>
                    <input
                      type="number"
                      placeholder="e.g. 1"
                      value={formData.installed_equipment_id}
                      onChange={(e) => setFormData({ ...formData, installed_equipment_id: e.target.value })}
                    />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="sd-form-group">
                    <label>Start Date *</label>
                    <input
                      type="date"
                      required
                      value={formData.start_date}
                      onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                    />
                  </div>
                  <div className="sd-form-group">
                    <label>End Date *</label>
                    <input
                      type="date"
                      required
                      value={formData.end_date}
                      onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                    />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="sd-form-group">
                    <label>Planned PM Visits / Year</label>
                    <input
                      type="number"
                      value={formData.planned_visits}
                      onChange={(e) => setFormData({ ...formData, planned_visits: e.target.value })}
                    />
                  </div>
                  <div className="sd-form-group">
                    <label>Contract Value (₹) *</label>
                    <input
                      type="number"
                      required
                      value={formData.contract_value}
                      onChange={(e) => setFormData({ ...formData, contract_value: e.target.value })}
                    />
                  </div>
                </div>
                <div className="sd-form-group">
                  <label>Contract Remarks & SLA</label>
                  <textarea
                    rows="2"
                    value={formData.remarks}
                    onChange={(e) => setFormData({ ...formData, remarks: e.target.value })}
                  />
                </div>
              </div>
              <div className="sd-modal-footer">
                <button
                  type="button"
                  className="sd-btn secondary"
                  onClick={() => setShowModal(false)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button type="submit" className="sd-btn primary" disabled={submitting}>
                  {submitting ? "Creating..." : "Save AMC Contract"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
