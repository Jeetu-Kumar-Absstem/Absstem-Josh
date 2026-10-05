import { useState } from "react";

export default function DispatchFulfillmentConsole({ dispatches, selectedOrder, onCloseOrderDetail, onProcessDispatch }) {
  const [showDispatchModal, setShowDispatchModal] = useState(false);
  const [transporter, setTransporter] = useState("");
  const [lrNo, setLrNo] = useState("");
  const [vehicleNo, setVehicleNo] = useState("");
  const [carrier, setCarrier] = useState("");
  const [driverContact, setDriverContact] = useState("");
  const [packages, setPackages] = useState("1");
  const [weight, setWeight] = useState("0");
  const [remarks, setRemarks] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleDispatchSubmit(e) {
    e.preventDefault();
    if (!selectedOrder?.order?.id) return;
    setLoading(true);
    try {
      await onProcessDispatch(selectedOrder.order.id, {
        transporter_name: transporter,
        lr_no: lrNo,
        vehicle_no: vehicleNo,
        carrier_name: carrier,
        driver_contact: driverContact,
        total_packages: Number(packages || 1),
        gross_weight_kg: Number(weight || 0),
        remarks,
      });
      setShowDispatchModal(false);
    } catch (err) {
      alert(err.message || "Failed to process dispatch");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {selectedOrder && (
        <div className="cd-panel" style={{ border: "2px solid #0284c7" }}>
          <div className="cd-panel-header" style={{ background: "#f0f9ff" }}>
            <div>
              <h3 style={{ color: "#0369a1" }}>
                Order #{selectedOrder.order.so_number} - {selectedOrder.order.customer_name}
              </h3>
              <div style={{ fontSize: 12, color: "#0284c7" }}>
                Status: {selectedOrder.order.order_status} | Total: ₹{Number(selectedOrder.order.grand_total_base || 0).toLocaleString("en-IN")}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {selectedOrder.order.order_status !== "dispatched" && (
                <button
                  className="cd-btn primary small"
                  type="button"
                  onClick={() => setShowDispatchModal(true)}
                >
                  🚀 Dispatch & Deduct Stock
                </button>
              )}
              <button
                className="cd-btn secondary small"
                type="button"
                onClick={onCloseOrderDetail}
              >
                Close
              </button>
            </div>
          </div>

          <div style={{ padding: 16 }}>
            <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#334155" }}>Order Line Items & Stock Availability</h4>
            <table className="cd-table">
              <thead>
                <tr>
                  <th style={{ width: 40, textAlign: "center" }}>#</th>
                  <th style={{ width: 140 }}>Item Code</th>
                  <th>Item Name / Description</th>
                  <th style={{ width: 110, textAlign: "right" }}>Order Qty</th>
                  <th style={{ width: 110, textAlign: "right" }}>Unit Price</th>
                  <th style={{ width: 120, textAlign: "right" }}>Line Total</th>
                  <th style={{ width: 130, textAlign: "right" }}>Available Stock</th>
                </tr>
              </thead>
              <tbody>
                {selectedOrder.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={{ textAlign: "center" }}>{l.line_no}</td>
                    <td style={{ fontWeight: 600 }}>{l.item_code}</td>
                    <td>{l.item_name || l.line_description}</td>
                    <td style={{ fontWeight: 700, textAlign: "right", fontFamily: "monospace" }}>{l.qty} {l.uom || "NOS"}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>₹{Number(l.unit_price_base || 0).toFixed(2)}</td>
                    <td style={{ fontWeight: 700, textAlign: "right", fontFamily: "monospace" }}>₹{Number(l.line_total_base || 0).toFixed(2)}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <span
                        style={{
                          fontWeight: 700,
                          color: Number(l.available_stock_qty) >= Number(l.qty) ? "#16a34a" : "#dc2626",
                        }}
                      >
                        {Number(l.available_stock_qty || 0).toFixed(2)} {l.uom || "NOS"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="cd-panel">
        <div className="cd-panel-header">
          <h3>Outbound Dispatches & Consignments</h3>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="cd-table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>Dispatch Number</th>
                <th style={{ width: 130 }}>Sales Order</th>
                <th>Customer</th>
                <th style={{ width: 110 }}>Dispatch Date</th>
                <th style={{ width: 140 }}>Transporter</th>
                <th style={{ width: 130 }}>LR / Tracking No</th>
                <th style={{ width: 120 }}>Vehicle No</th>
                <th style={{ width: 100, textAlign: "center" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {!dispatches || dispatches.length === 0 ? (
                <tr>
                  <td colSpan="8" style={{ textAlign: "center", padding: 24, color: "#94a3b8" }}>
                    No outbound dispatches recorded.
                  </td>
                </tr>
              ) : (
                dispatches.map((d) => (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 700, color: "#0f172a" }}>{d.dispatch_number}</td>
                    <td style={{ fontWeight: 600, color: "#0284c7" }}>{d.so_number}</td>
                    <td>{d.customer_name}</td>
                    <td>{d.dispatch_date ? new Date(d.dispatch_date).toLocaleDateString() : "-"}</td>
                    <td>{d.transporter_name || d.carrier_name || "-"}</td>
                    <td>{d.lr_no || d.tracking_ref || "-"}</td>
                    <td>{d.vehicle_no || "-"}</td>
                    <td style={{ textAlign: "center" }}>
                      <span className="cd-status-chip dispatched">
                        {d.dispatch_status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showDispatchModal && (
        <div className="cd-modal-overlay">
          <div className="cd-modal-card">
            <div className="cd-modal-header">
              <h2>Confirm Consignment Dispatch</h2>
              <button
                type="button"
                style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer" }}
                onClick={() => setShowDispatchModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleDispatchSubmit}>
              <div className="cd-modal-body">
                <div className="cd-form-group">
                  <label>Transporter Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. V-Trans / Safexpress / Spoton"
                    value={transporter}
                    onChange={(e) => setTransporter(e.target.value)}
                    required
                  />
                </div>
                <div className="cd-form-group">
                  <label>LR / Tracking Reference Number *</label>
                  <input
                    type="text"
                    placeholder="e.g. LR-9920198"
                    value={lrNo}
                    onChange={(e) => setLrNo(e.target.value)}
                    required
                  />
                </div>
                <div className="cd-form-group">
                  <label>Vehicle Number</label>
                  <input
                    type="text"
                    placeholder="e.g. DL-01-AB-1234"
                    value={vehicleNo}
                    onChange={(e) => setVehicleNo(e.target.value)}
                  />
                </div>
                <div className="cd-form-group">
                  <label>Driver Contact / Phone</label>
                  <input
                    type="text"
                    placeholder="e.g. +91 9876543210"
                    value={driverContact}
                    onChange={(e) => setDriverContact(e.target.value)}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="cd-form-group">
                    <label>Total Packages</label>
                    <input
                      type="number"
                      value={packages}
                      onChange={(e) => setPackages(e.target.value)}
                    />
                  </div>
                  <div className="cd-form-group">
                    <label>Gross Weight (KG)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={weight}
                      onChange={(e) => setWeight(e.target.value)}
                    />
                  </div>
                </div>
                <div className="cd-form-group">
                  <label>Dispatch Remarks</label>
                  <textarea
                    rows="2"
                    placeholder="Inspection complete, packed with standard warranty seals."
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                  />
                </div>
              </div>
              <div className="cd-modal-footer">
                <button
                  type="button"
                  className="cd-btn secondary"
                  onClick={() => setShowDispatchModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cd-btn primary"
                  disabled={loading}
                >
                  {loading ? "Processing..." : "Generate Dispatch & Deduct Stock"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
