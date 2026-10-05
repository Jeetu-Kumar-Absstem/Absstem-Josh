import React, { useEffect, useState } from "react";
import ShortageReorderDashboard from "./ShortageReorderDashboard";
import PurchaseRequisitionConsole from "./PurchaseRequisitionConsole";
import SupplierPerformanceTracker from "./SupplierPerformanceTracker";
import "./mrp.css";

export default function MrpPlanningDesk() {
  const [activeTab, setActiveTab] = useState("shortages"); // 'shortages', 'requisitions', 'suppliers'
  const [loading, setLoading] = useState(true);
  const [requirements, setRequirements] = useState([]);
  const [requisitions, setRequisitions] = useState([]);
  const [performance, setPerformance] = useState([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [reqRes, prRes, perfRes] = await Promise.all([
        fetch("/api/mrp/net-requirements").then((r) => r.json()),
        fetch("/api/mrp/requisitions").then((r) => r.json()),
        fetch("/api/mrp/supplier-performance").then((r) => r.json()),
      ]);

      if (reqRes.ok) setRequirements(reqRes.requirements || []);
      if (prRes.ok) setRequisitions(prRes.requisitions || []);
      if (perfRes.ok) setPerformance(perfRes.performance || []);
    } catch (err) {
      console.error("Failed to load MRP planning data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleGenerateRequisitions = async (items) => {
    const res = await fetch("/api/mrp/generate-requisitions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Requisition generation failed");
    await loadData();
    return data;
  };

  const handleConvertToPo = async (requisitionId, vendorId) => {
    const res = await fetch(`/api/mrp/requisitions/${requisitionId}/convert-to-po`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor_id: vendorId }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Conversion to PO failed");
    await loadData();
    return data;
  };

  const criticalCount = requirements.filter((r) => r.status === "critical_shortage").length;
  const reorderCount = requirements.filter((r) => r.recommended_reorder_qty > 0).length;
  const pendingPrCount = requisitions.filter((r) => r.requisition_status === "submitted").length;
  const avgSupplierScore = performance.length > 0
    ? (performance.reduce((sum, p) => sum + Number(p.vendor_score || 0), 0) / performance.length).toFixed(1)
    : "100";

  return (
    <div className="mrp-planning-desk">
      {/* Command Bar */}
      <div className="mrp-command-bar">
        <div className="mrp-title-group">
          <h1>Materials Requirement Planning (MRP II) & Auto-Procurement</h1>
          <p>Net Shortage Calculation, Auto-Grouped Requisitions & Vendor Performance Engine</p>
        </div>
        <div className="mrp-actions-group">
          <button className="mrp-btn secondary" type="button" onClick={loadData} disabled={loading}>
            {loading ? "Calculating..." : "↻ Recalculate MRP Net Demand"}
          </button>
        </div>
      </div>

      {/* KPI Overview */}
      <div className="mrp-kpi-grid">
        <div className="mrp-kpi-card">
          <span className="label">Critical Stock Depletions</span>
          <span className="value" style={{ color: criticalCount > 0 ? "#b91c1c" : "#15803d" }}>
            {criticalCount} Items
          </span>
          <span className="subtext">Below Safety Stock Limits</span>
        </div>
        <div className="mrp-kpi-card">
          <span className="label">Total Reorder Needs</span>
          <span className="value" style={{ color: reorderCount > 0 ? "#d97706" : "#15803d" }}>
            {reorderCount} Components
          </span>
          <span className="subtext">BOM Demand + Buffer Deficits</span>
        </div>
        <div className="mrp-kpi-card">
          <span className="label">Open Purchase Requisitions</span>
          <span className="value" style={{ color: "#0ea5e9" }}>
            {pendingPrCount} Pending PRs
          </span>
          <span className="subtext">Awaiting PO Conversion</span>
        </div>
        <div className="mrp-kpi-card">
          <span className="label">Average Vendor Reliability</span>
          <span className="value" style={{ color: "#0f172a" }}>
            {avgSupplierScore} / 100
          </span>
          <span className="subtext">On-Time & Quality Weighted</span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="mrp-tabs">
        <button
          className={`mrp-tab-btn ${activeTab === "shortages" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("shortages")}
        >
          Shortage & Reorder Queue (MRP II)
        </button>
        <button
          className={`mrp-tab-btn ${activeTab === "requisitions" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("requisitions")}
        >
          Purchase Requisitions Console ({requisitions.length})
        </button>
        <button
          className={`mrp-tab-btn ${activeTab === "suppliers" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("suppliers")}
        >
          Supplier Performance & Lead Times
        </button>
      </div>

      {/* Tab Panels */}
      {activeTab === "shortages" && (
        <ShortageReorderDashboard
          requirements={requirements}
          onGenerateRequisitions={handleGenerateRequisitions}
          onRefresh={loadData}
        />
      )}

      {activeTab === "requisitions" && (
        <PurchaseRequisitionConsole
          requisitions={requisitions}
          onConvertToPo={handleConvertToPo}
          onRefresh={loadData}
        />
      )}

      {activeTab === "suppliers" && (
        <SupplierPerformanceTracker
          performance={performance}
        />
      )}
    </div>
  );
}
