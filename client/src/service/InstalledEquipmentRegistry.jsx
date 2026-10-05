import React, { useState } from "react";

export default function InstalledEquipmentRegistry({ equipment = [], onAddEquipment, onRefresh }) {
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    serial_number: "",
    customer_id: "",
    item_name: "",
    item_code: "FG-EQUIP",
    site_location: "",
    site_address: "",
    commissioning_date: new Date().toISOString().slice(0, 10),
    warranty_start_date: new Date().toISOString().slice(0, 10),
    warranty_end_date: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
    notes: "",
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onAddEquipment(formData);
      setShowModal(false);
      setFormData({
        serial_number: "",
        customer_id: "",
        item_name: "",
        item_code: "FG-EQUIP",
        site_location: "",
        site_address: "",
        commissioning_date: new Date().toISOString().slice(0, 10),
        warranty_start_date: new Date().toISOString().slice(0, 10),
        warranty_end_date: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
        notes: "",
      });
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`Equipment registration failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sd-panel">
      <div className="sd-panel-header">
        <h3>Installed Serialized Equipment Registry</h3>
        <button
          className="sd-btn primary small"
          type="button"
          onClick={() => setShowModal(true)}
        >
          + Register Installed Equipment
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="sd-table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Serial Number</th>
              <th>Equipment / Model</th>
              <th>Customer & Site Location</th>
              <th style={{ width: 140 }}>SO / Dispatch Ref</th>
              <th style={{ width: 110 }}>Commissioned</th>
              <th style={{ width: 140, textAlign: "center" }}>Warranty Coverage</th>
              <th style={{ width: 110, textAlign: "center" }}>Status</th>
              <th style={{ width: 100, textAlign: "center" }}>Tickets</th>
            </tr>
          </thead>
          <tbody>
            {equipment.length === 0 ? (
              <tr>
                <td colSpan="8" style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                  No installed equipment records found. Equipment is auto-registered upon confirmed dispatches.
                </td>
              </tr>
            ) : (
              equipment.map((eq) => {
                const isWarrantyActive = eq.warranty_end_date && new Date(eq.warranty_end_date) >= new Date();
                return (
                  <tr key={eq.id}>
                    <td>
                      <strong>{eq.serial_number}</strong>
                    </td>
                    <td>
                      <div><strong>{eq.item_name}</strong></div>
                      <small style={{ color: "#64748b" }}>{eq.item_code}</small>
                    </td>
                    <td>
                      <div><strong>{eq.customer_name}</strong></div>
                      <small style={{ color: "#64748b" }}>{eq.site_location || eq.site_address || "—"}</small>
                    </td>
                    <td>
                      <div>{eq.so_number || "—"}</div>
                      <small style={{ color: "#64748b" }}>Disp: {eq.dispatch_number || "—"}</small>
                    </td>
                    <td>{eq.commissioning_date ? String(eq.commissioning_date).slice(0, 10) : "—"}</td>
                    <td style={{ textAlign: "center" }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          background: isWarrantyActive ? "#dcfce7" : "#f1f5f9",
                          color: isWarrantyActive ? "#15803d" : "#64748b",
                        }}
                      >
                        {isWarrantyActive ? "✓ Under Warranty" : "Expired"}
                      </span>
                      <div style={{ fontSize: "0.6875rem", color: "#94a3b8", marginTop: 2 }}>
                        Until {eq.warranty_end_date ? String(eq.warranty_end_date).slice(0, 10) : "—"}
                      </div>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`sd-status-chip ${eq.equipment_status}`}>
                        {eq.equipment_status}
                      </span>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <strong>{eq.total_tickets_logged || 0} calls</strong>
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
              <h2>Register Installed Equipment Asset</h2>
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
                <div className="sd-form-group">
                  <label>Serial Number / Machine ID *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. SN-PSA-O2-2026-001"
                    value={formData.serial_number}
                    onChange={(e) => setFormData({ ...formData, serial_number: e.target.value })}
                  />
                </div>
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
                    <label>Item Code</label>
                    <input
                      type="text"
                      value={formData.item_code}
                      onChange={(e) => setFormData({ ...formData, item_code: e.target.value })}
                    />
                  </div>
                </div>
                <div className="sd-form-group">
                  <label>Equipment / Model Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Medical Oxygen Generator Model Absstem 500L"
                    value={formData.item_name}
                    onChange={(e) => setFormData({ ...formData, item_name: e.target.value })}
                  />
                </div>
                <div className="sd-form-group">
                  <label>Site Location / Hospital Facility</label>
                  <input
                    type="text"
                    placeholder="e.g. Apollo Hospital ICU Wing, Delhi"
                    value={formData.site_location}
                    onChange={(e) => setFormData({ ...formData, site_location: e.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="sd-form-group">
                    <label>Commissioning Date</label>
                    <input
                      type="date"
                      value={formData.commissioning_date}
                      onChange={(e) => setFormData({ ...formData, commissioning_date: e.target.value })}
                    />
                  </div>
                  <div className="sd-form-group">
                    <label>Warranty Expiry Date</label>
                    <input
                      type="date"
                      value={formData.warranty_end_date}
                      onChange={(e) => setFormData({ ...formData, warranty_end_date: e.target.value })}
                    />
                  </div>
                </div>
                <div className="sd-form-group">
                  <label>Installation Remarks</label>
                  <textarea
                    rows="2"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
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
                  {submitting ? "Registering..." : "Save Equipment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
