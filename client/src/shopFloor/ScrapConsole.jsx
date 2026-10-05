import { useState } from "react";

export default function ScrapConsole({
  workOrder,
  kits = [],
  scrapList = [],
  onLogScrap,
  selectedKit = null,
  onClose,
}) {
  const [targetKitId, setTargetKitId] = useState(selectedKit?.id || (kits[0]?.id || ""));
  const [qtyScrapped, setQtyScrapped] = useState("1");
  const [reasonCode, setReasonCode] = useState("DAMAGED_IN_ASSEMBLY");
  const [stageName, setStageName] = useState("Assembly Line");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);

  const currentKit = kits.find((k) => String(k.id) === String(targetKitId)) || kits[0];

  async function handleSubmit(e) {
    e.preventDefault();
    if (!currentKit) return;
    setSaving(true);
    try {
      await onLogScrap({
        work_order_kit_id: currentKit.id,
        product_id: currentKit.component_product_id,
        qty_scrapped: Number(qtyScrapped),
        reason_code: reasonCode,
        stage_name: stageName,
        remarks,
      });
      if (onClose) onClose();
      setRemarks("");
      setQtyScrapped("1");
    } catch (err) {
      alert(err.message || "Failed to log scrap");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sf-panel" style={{ marginTop: 16 }}>
      <div className="sf-panel-header">
        <div>
          <h3>Assembly Floor Scrap & Material Variance Log</h3>
          <small style={{ color: "#64748b" }}>
            Real-time loss tracking directly affecting job cost variance
          </small>
        </div>
      </div>

      <div className="sf-panel-body">
        {onClose ? (
          <form onSubmit={handleSubmit} style={{ marginBottom: 20, padding: 14, background: "#fff5f5", border: "1px solid #fed7d7", borderRadius: 6 }}>
            <h4 style={{ margin: "0 0 10px 0", color: "#9b2c2c" }}>Log Damaged / Scrap Component</h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              <div className="sf-form-group">
                <label htmlFor="scrap-component">Component</label>
                <select
                  id="scrap-component"
                  value={targetKitId}
                  onChange={(e) => setTargetKitId(e.target.value)}
                >
                  {kits.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.item_code} - {k.item_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sf-form-group">
                <label htmlFor="scrap-qty">Quantity Scrapped</label>
                <input
                  id="scrap-qty"
                  type="number"
                  step="any"
                  min="0.0001"
                  required
                  value={qtyScrapped}
                  onChange={(e) => setQtyScrapped(e.target.value)}
                />
              </div>

              <div className="sf-form-group">
                <label htmlFor="scrap-reason">Reason Code</label>
                <select
                  id="scrap-reason"
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value)}
                >
                  <option value="DAMAGED_IN_ASSEMBLY">Damaged in Assembly</option>
                  <option value="MACHINING_DEFECT">Machining Defect</option>
                  <option value="MATERIAL_FAIL">Material Failure</option>
                  <option value="OPERATOR_ERROR">Operator Error</option>
                  <option value="TOOLING_WEAR">Tooling Wear</option>
                  <option value="OTHER">Other Variance</option>
                </select>
              </div>

              <div className="sf-form-group">
                <label htmlFor="scrap-stage">Floor Stage</label>
                <input
                  id="scrap-stage"
                  type="text"
                  value={stageName}
                  onChange={(e) => setStageName(e.target.value)}
                />
              </div>
            </div>

            <div className="sf-form-group" style={{ marginTop: 10 }}>
              <label htmlFor="scrap-remarks">Root Cause / Remarks</label>
              <input
                id="scrap-remarks"
                type="text"
                placeholder="e.g. Thread stripped during high-torque tightening"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
              />
            </div>

            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="sf-btn secondary small" type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="sf-btn danger small" type="submit" disabled={saving}>
                {saving ? "Logging..." : "Record Scrap & Post Variance"}
              </button>
            </div>
          </form>
        ) : null}

        <div style={{ overflowX: "auto" }}>
          <table className="sf-table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>Time</th>
                <th>Component</th>
                <th style={{ width: 100, textAlign: "right" }}>Qty</th>
                <th style={{ width: 130, textAlign: "center" }}>Reason</th>
                <th style={{ width: 110 }}>Stage</th>
                <th style={{ width: 110, textAlign: "right" }}>Unit Cost</th>
                <th style={{ width: 130, textAlign: "right" }}>Variance Impact</th>
                <th style={{ width: 110 }}>Logged By</th>
              </tr>
            </thead>
            <tbody>
              {scrapList.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", color: "#94a3b8", padding: 20 }}>
                    No component scrap recorded for this production run.
                  </td>
                </tr>
              ) : (
                scrapList.map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.scrapped_at).toLocaleString()}</td>
                    <td>
                      <strong>{s.item_code}</strong>
                      <small style={{ display: "block", color: "#64748b" }}>{s.item_name}</small>
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong style={{ color: "#e11d48" }}>{s.qty_scrapped}</strong> {s.uom}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span className="sf-status-chip cancelled">
                        {s.reason_code?.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>{s.stage_name || "Assembly"}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>₹ {Number(s.unit_cost_base || 0).toFixed(2)}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      <strong style={{ color: "#e11d48" }}>
                        ₹ {Number(s.variance_cost_base || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </strong>
                    </td>
                    <td>{s.scrapped_by_name || "Operator"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
