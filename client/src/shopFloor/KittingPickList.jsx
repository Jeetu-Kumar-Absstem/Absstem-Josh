import { useState } from "react";
import FastScan from "./FastScan";

export default function KittingPickList({
  workOrder,
  kits = [],
  onIssueMaterial,
  onOpenScrapModal,
}) {
  const [selectedKit, setSelectedKit] = useState(null);
  const [issueQty, setIssueQty] = useState("");
  const [binLocation, setBinLocation] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [barcodeScanned, setBarcodeScanned] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  function handleScan(scannedCode) {
    // Attempt to find a kit matching the scanned item_code or barcode
    const match = kits.find(
      (k) =>
        k.item_code.toLowerCase() === scannedCode.toLowerCase() ||
        k.spec_code?.toLowerCase() === scannedCode.toLowerCase()
    );
    if (match) {
      openIssueModal(match, scannedCode);
    } else {
      alert(`No component in this pick list matches code: ${scannedCode}`);
    }
  }

  function openIssueModal(kit, autoBarcode = "") {
    setSelectedKit(kit);
    const pending = Math.max(0, Number(kit.required_qty) - Number(kit.issued_qty));
    setIssueQty(String(pending > 0 ? pending : 1));
    setBarcodeScanned(autoBarcode || "");
    setBinLocation("");
    setLotNumber("");
    setNotes("");
  }

  async function submitIssue(e) {
    e.preventDefault();
    if (!selectedKit) return;
    setSaving(true);
    try {
      await onIssueMaterial({
        work_order_kit_id: selectedKit.id,
        qty_issued: Number(issueQty),
        bin_location: binLocation,
        lot_number: lotNumber,
        barcode_scanned: barcodeScanned,
        notes,
      });
      setSelectedKit(null);
    } catch (err) {
      alert(err.message || "Failed to issue material");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sf-panel">
      <div className="sf-panel-header">
        <div>
          <h3>Assembly Pick List & Kitting Verification</h3>
          <small style={{ color: "#64748b" }}>
            Target: {workOrder.target_qty} {workOrder.finished_good_uom || "units"} · BOM: {workOrder.bom_code}
          </small>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="sf-btn secondary small"
            type="button"
            onClick={() => onOpenScrapModal(null)}
          >
            + Log Assembly Scrap
          </button>
        </div>
      </div>

      <div className="sf-panel-body">
        <FastScan onScan={handleScan} placeholder="Scan component QR / Barcode for fast pick..." />

        <div style={{ overflowX: "auto" }}>
          <table className="sf-table">
            <thead>
              <tr>
                <th style={{ width: 45, textAlign: "center" }}>#</th>
                <th style={{ width: 140 }}>Item Code / Spec</th>
                <th>Description</th>
                <th style={{ width: 100, textAlign: "right" }}>Required</th>
                <th style={{ width: 100, textAlign: "right" }}>Issued</th>
                <th style={{ width: 120, textAlign: "right" }}>Available Stock</th>
                <th style={{ width: 110, textAlign: "center" }}>Status</th>
                <th style={{ width: 140, textAlign: "center" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {kits.map((k) => {
                const required = Number(k.required_qty || 0);
                const issued = Number(k.issued_qty || 0);
                const stock = Number(k.current_stock_qty || 0);
                const isShortage = stock < required - issued && issued < required;

                return (
                  <tr key={k.id} style={{ background: isShortage ? "#fff1f2" : "inherit" }}>
                    <td style={{ textAlign: "center" }}>{k.line_no}</td>
                    <td>
                      <strong>{k.item_code}</strong>
                      {k.spec_code ? (
                        <div style={{ fontSize: 11, color: "#0369a1" }}>
                          Spec: {k.spec_code}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div>{k.item_name}</div>
                      {k.material || k.pressure_rating ? (
                        <small style={{ color: "#64748b" }}>
                          {[k.material, k.pressure_rating].filter(Boolean).join(" · ")}
                        </small>
                      ) : null}
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      {required} {k.uom}
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong>{issued}</strong> {k.uom}
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <span style={{ color: stock <= 0 ? "#e11d48" : "#0f172a", fontWeight: stock <= 0 ? 700 : 400 }}>
                        {stock} {k.uom}
                      </span>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`sf-status-chip ${k.kitting_status}`}>
                        {k.kitting_status?.replace("_", " ")}
                      </span>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                        <button
                          className="sf-btn small"
                          type="button"
                          disabled={workOrder.status === "completed" || workOrder.status === "cancelled"}
                          onClick={() => openIssueModal(k)}
                        >
                          Issue / Pick
                        </button>
                        <button
                          className="sf-btn secondary small"
                          type="button"
                          onClick={() => onOpenScrapModal(k)}
                          title="Log damaged or scrap component"
                        >
                          Scrap
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {selectedKit ? (
        <div className="sf-modal-backdrop">
          <div className="sf-modal-card">
            <div className="sf-modal-header">
              <h3 style={{ margin: 0 }}>Issue Material to Floor</h3>
              <button
                type="button"
                style={{ border: 0, background: "transparent", cursor: "pointer", fontSize: 18 }}
                onClick={() => setSelectedKit(null)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={submitIssue}>
              <div className="sf-modal-body">
                <div>
                  <strong>{selectedKit.item_code}</strong> - {selectedKit.item_name}
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                    Required: {selectedKit.required_qty} | Issued: {selectedKit.issued_qty} | Current Stock: {selectedKit.current_stock_qty} {selectedKit.uom}
                  </div>
                </div>

                <div className="sf-form-group">
                  <label htmlFor="issue-qty">Quantity to Issue ({selectedKit.uom})</label>
                  <input
                    id="issue-qty"
                    type="number"
                    step="any"
                    min="0.0001"
                    max={selectedKit.current_stock_qty}
                    required
                    value={issueQty}
                    onChange={(e) => setIssueQty(e.target.value)}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div className="sf-form-group">
                    <label htmlFor="issue-bin">Store Bin / Rack</label>
                    <input
                      id="issue-bin"
                      type="text"
                      placeholder="e.g. RACK-A2-04"
                      value={binLocation}
                      onChange={(e) => setBinLocation(e.target.value)}
                    />
                  </div>
                  <div className="sf-form-group">
                    <label htmlFor="issue-lot">Lot / Batch No.</label>
                    <input
                      id="issue-lot"
                      type="text"
                      placeholder="Optional Lot #"
                      value={lotNumber}
                      onChange={(e) => setLotNumber(e.target.value)}
                    />
                  </div>
                </div>

                <div className="sf-form-group">
                  <label htmlFor="issue-barcode">Barcode / Serial Verified</label>
                  <input
                    id="issue-barcode"
                    type="text"
                    placeholder="Scanned code"
                    value={barcodeScanned}
                    onChange={(e) => setBarcodeScanned(e.target.value)}
                  />
                </div>

                <div className="sf-form-group">
                  <label htmlFor="issue-notes">Issuance Remarks</label>
                  <input
                    id="issue-notes"
                    type="text"
                    placeholder="e.g. Stage 1 pre-assembly"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ padding: "12px 18px", background: "#f8fafc", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  className="sf-btn secondary"
                  type="button"
                  onClick={() => setSelectedKit(null)}
                >
                  Cancel
                </button>
                <button className="sf-btn" type="submit" disabled={saving}>
                  {saving ? "Posting Deduction..." : "Confirm & Deduct Stock"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
