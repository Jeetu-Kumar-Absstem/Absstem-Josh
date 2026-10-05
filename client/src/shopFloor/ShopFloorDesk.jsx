import { useCallback, useEffect, useState } from "react";
import KittingPickList from "./KittingPickList";
import ScrapConsole from "./ScrapConsole";
import { toast } from "../shared/joshUi";
import "./shopFloor.css";

export default function ShopFloorDesk({ onNavigate }) {
  const [workOrders, setWorkOrders] = useState([]);
  const [selectedWoId, setSelectedWoId] = useState(null);
  const [activeDetail, setActiveDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [boms, setBoms] = useState([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showScrapModal, setShowScrapModal] = useState(false);
  const [scrapTargetKit, setScrapTargetKit] = useState(null);

  // New Work Order Form State
  const [newBomId, setNewBomId] = useState("");
  const [newTargetQty, setNewTargetQty] = useState("1");
  const [newPriority, setNewPriority] = useState("normal");
  const [newBatchNumber, setNewBatchNumber] = useState("");
  const [newRemarks, setNewRemarks] = useState("");
  const [creating, setCreating] = useState(false);

  const loadWorkOrders = useCallback(async () => {
    try {
      const res = await fetch("/api/shop-floor/work-orders");
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to load work orders");
      setWorkOrders(data.work_orders || []);
      if (!selectedWoId && data.work_orders?.length > 0) {
        setSelectedWoId(data.work_orders[0].id);
      }
    } catch (err) {
      toast(err.message || "Failed to load work orders", "error");
    } finally {
      setLoading(false);
    }
  }, [selectedWoId]);

  const loadWorkOrderDetail = useCallback(async (id) => {
    if (!id) return;
    try {
      const res = await fetch(`/api/shop-floor/work-orders/${id}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to load work order detail");
      setActiveDetail(data);
    } catch (err) {
      toast(err.message || "Failed to load work order detail", "error");
    }
  }, []);

  const loadBoms = useCallback(async () => {
    try {
      const res = await fetch("/manufacturing-boms");
      const data = await res.json();
      if (res.ok && data.ok) {
        setBoms(data.boms || data.rows || []);
      }
    } catch {
      // Ignored non-blocking
    }
  }, []);

  useEffect(() => {
    loadWorkOrders();
    loadBoms();
  }, [loadWorkOrders, loadBoms]);

  useEffect(() => {
    if (selectedWoId) {
      loadWorkOrderDetail(selectedWoId);
    }
  }, [selectedWoId, loadWorkOrderDetail]);

  async function handleCreateWorkOrder(e) {
    e.preventDefault();
    if (!newBomId) return;
    setCreating(true);
    try {
      const res = await fetch("/api/shop-floor/work-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manufacturing_bom_id: Number(newBomId),
          target_qty: Number(newTargetQty),
          priority: newPriority,
          batch_number: newBatchNumber,
          remarks: newRemarks,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to create work order");
      toast("Work Order scheduled and BOM exploded into kitting list!", "success");
      setShowCreateModal(false);
      setSelectedWoId(data.work_order.id);
      await loadWorkOrders();
    } catch (err) {
      toast(err.message || "Failed to create work order", "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleIssueMaterial(payload) {
    const res = await fetch(`/api/shop-floor/work-orders/${selectedWoId}/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || data.detail || "Failed to issue material");
    toast(data.message || "Material issued successfully", "success");
    await loadWorkOrderDetail(selectedWoId);
    await loadWorkOrders();
  }

  async function handleLogScrap(payload) {
    const res = await fetch(`/api/shop-floor/work-orders/${selectedWoId}/scrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || data.detail || "Failed to log scrap");
    toast(data.message || "Scrap recorded and variance posted", "success");
    await loadWorkOrderDetail(selectedWoId);
    await loadWorkOrders();
  }

  async function handleStatusChange(status) {
    try {
      const res = await fetch(`/api/shop-floor/work-orders/${selectedWoId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to update status");
      toast(`Work order marked ${status}`, "success");
      await loadWorkOrderDetail(selectedWoId);
      await loadWorkOrders();
    } catch (err) {
      toast(err.message || "Failed to update status", "error");
    }
  }

  const activeWo = activeDetail?.work_order;
  const kits = activeDetail?.kits || [];
  const scrap = activeDetail?.scrap || [];

  return (
    <div className="shop-floor-desk">
      {/* Command Bar */}
      <div className="sf-command-bar">
        <div className="sf-brand-title">
          <span className="sf-badge-mark">SHOP FLOOR</span>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>
              Assembly & Inventory Kitting Command
            </h2>
            <small style={{ color: "#64748b" }}>
              BOM Explosion · Real-time Material Issuance · Assembly Floor Scrap Tracking
            </small>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="sf-btn"
            type="button"
            onClick={() => setShowCreateModal(true)}
          >
            + Schedule New Work Order
          </button>
          <button
            className="sf-btn secondary"
            type="button"
            onClick={() => {
              loadWorkOrders();
              if (selectedWoId) loadWorkOrderDetail(selectedWoId);
            }}
          >
            Refresh Desk
          </button>
        </div>
      </div>

      {/* KPI Overview */}
      <div className="sf-kpi-grid">
        <div className="sf-kpi-card">
          <span>Active Work Orders</span>
          <strong>{workOrders.filter((w) => w.status === "in_production" || w.status === "scheduled").length}</strong>
          <small>In-Production & Scheduled</small>
        </div>
        <div className="sf-kpi-card">
          <span>Fully Kitted Orders</span>
          <strong>
            {workOrders.filter((w) => Number(w.fulfilled_components) > 0 && Number(w.fulfilled_components) === Number(w.total_components)).length}
          </strong>
          <small>Ready for Assembly</small>
        </div>
        <div className="sf-kpi-card">
          <span>Assembly Scrap Impact</span>
          <strong style={{ color: "#e11d48" }}>
            ₹ {workOrders.reduce((sum, w) => sum + Number(w.total_scrap_variance_cost || 0), 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </strong>
          <small>Total Material Variance</small>
        </div>
        <div className="sf-kpi-card">
          <span>Completed Orders</span>
          <strong>{workOrders.filter((w) => w.status === "completed").length}</strong>
          <small>Closed production runs</small>
        </div>
      </div>

      {/* Main Split Grid */}
      <div className="sf-grid-layout">
        {/* Left Side: Work Orders Queue */}
        <div className="sf-panel">
          <div className="sf-panel-header">
            <h3>Work Orders Queue</h3>
            <span style={{ fontSize: 11, color: "#64748b" }}>{workOrders.length} total</span>
          </div>

          <div style={{ maxHeight: "calc(100vh - 360px)", overflowY: "auto" }}>
            {loading ? (
              <div style={{ padding: 20, textAlign: "center", color: "#64748b" }}>
                Loading work orders...
              </div>
            ) : workOrders.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>
                No active work orders. Click "+ Schedule New Work Order" to begin.
              </div>
            ) : (
              workOrders.map((wo) => {
                const isSelected = String(wo.id) === String(selectedWoId);
                return (
                  <div
                    key={wo.id}
                    className={`sf-wo-item ${isSelected ? "active" : ""}`}
                    onClick={() => setSelectedWoId(wo.id)}
                  >
                    <div className="sf-wo-head">
                      <strong style={{ fontSize: 14 }}>{wo.work_order_no}</strong>
                      <span className={`sf-status-chip ${wo.status}`}>
                        {wo.status.replace("_", " ")}
                      </span>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, color: "#1e293b", fontSize: 13 }}>
                        {wo.finished_good_item_code}
                      </div>
                      <small style={{ color: "#64748b" }}>{wo.finished_good_item_name}</small>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginTop: 4 }}>
                      <span>
                        Target: <strong>{wo.target_qty}</strong> {wo.finished_good_uom || "units"}
                      </span>
                      <span>
                        Kitted: {wo.fulfilled_components || 0}/{wo.total_components || 0}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Side: Active Work Order Kitting & Scrap Command */}
        <div>
          {activeWo ? (
            <div>
              {/* Work Order Header Details */}
              <div className="sf-panel" style={{ marginBottom: 16 }}>
                <div className="sf-panel-header">
                  <div>
                    <h3 style={{ fontSize: 16 }}>
                      {activeWo.work_order_no} · {activeWo.finished_good_item_name}
                    </h3>
                    <small style={{ color: "#64748b" }}>
                      BOM Code: <strong>{activeWo.bom_code}</strong> | Batch: {activeWo.batch_number || "N/A"} | Priority: {activeWo.priority}
                    </small>
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {activeWo.status !== "completed" && activeWo.status !== "cancelled" ? (
                      <>
                        <button
                          className="sf-btn small"
                          type="button"
                          onClick={() => handleStatusChange("completed")}
                        >
                          Complete Assembly
                        </button>
                        <button
                          className="sf-btn secondary small"
                          type="button"
                          onClick={() => handleStatusChange("cancelled")}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <span className={`sf-status-chip ${activeWo.status}`}>
                        {activeWo.status.toUpperCase()}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Kitting Pick List View */}
              <KittingPickList
                workOrder={activeWo}
                kits={kits}
                onIssueMaterial={handleIssueMaterial}
                onOpenScrapModal={(kit) => {
                  setScrapTargetKit(kit);
                  setShowScrapModal(true);
                }}
              />

              {/* Scrap & Variance Console */}
              <ScrapConsole
                workOrder={activeWo}
                kits={kits}
                scrapList={scrap}
                onLogScrap={handleLogScrap}
                selectedKit={scrapTargetKit}
                onClose={showScrapModal ? () => setShowScrapModal(false) : null}
              />
            </div>
          ) : (
            <div className="sf-panel" style={{ padding: 40, textAlign: "center", color: "#64748b" }}>
              Select a Work Order on the left to inspect BOM kitting, issue components, and log floor scrap.
            </div>
          )}
        </div>
      </div>

      {/* Schedule Work Order Modal */}
      {showCreateModal ? (
        <div className="sf-modal-backdrop">
          <div className="sf-modal-card">
            <div className="sf-modal-header">
              <h3 style={{ margin: 0 }}>Schedule Work Order from Master BOM</h3>
              <button
                type="button"
                style={{ border: 0, background: "transparent", cursor: "pointer", fontSize: 18 }}
                onClick={() => setShowCreateModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateWorkOrder}>
              <div className="sf-modal-body">
                <div className="sf-form-group">
                  <label htmlFor="select-bom">Select Master BOM</label>
                  <select
                    id="select-bom"
                    required
                    value={newBomId}
                    onChange={(e) => setNewBomId(e.target.value)}
                  >
                    <option value="">-- Choose BOM --</option>
                    {boms.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.bom_code} - {b.finished_good_item_code || b.item_code} ({b.finished_good_item_name || b.item_name || "Finished Good"}) [{b.lifecycle_state || "Active"}]
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div className="sf-form-group">
                    <label htmlFor="target-qty">Target Production Qty</label>
                    <input
                      id="target-qty"
                      type="number"
                      step="any"
                      min="1"
                      required
                      value={newTargetQty}
                      onChange={(e) => setNewTargetQty(e.target.value)}
                    />
                  </div>
                  <div className="sf-form-group">
                    <label htmlFor="wo-priority">Priority</label>
                    <select
                      id="wo-priority"
                      value={newPriority}
                      onChange={(e) => setNewPriority(e.target.value)}
                    >
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </div>
                </div>

                <div className="sf-form-group">
                  <label htmlFor="batch-number">Production Batch / Serial Prefix</label>
                  <input
                    id="batch-number"
                    type="text"
                    placeholder="e.g. BATCH-2026-Q3-01"
                    value={newBatchNumber}
                    onChange={(e) => setNewBatchNumber(e.target.value)}
                  />
                </div>

                <div className="sf-form-group">
                  <label htmlFor="wo-remarks">Assembly Line Remarks</label>
                  <textarea
                    id="wo-remarks"
                    placeholder="Special instructions for the floor operator"
                    value={newRemarks}
                    onChange={(e) => setNewRemarks(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ padding: "12px 18px", background: "#f8fafc", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  className="sf-btn secondary"
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button className="sf-btn" type="submit" disabled={creating || !newBomId}>
                  {creating ? "Exploding BOM..." : "Schedule & Explode Kitting"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
