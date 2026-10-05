import React, { useEffect, useState } from "react";
import InstalledEquipmentRegistry from "./InstalledEquipmentRegistry";
import AmcContractDashboard from "./AmcContractDashboard";
import FieldTicketingConsole from "./FieldTicketingConsole";
import "./service.css";

export default function ServiceDesk() {
  const [activeTab, setActiveTab] = useState("equipment"); // 'equipment', 'amc', 'tickets'
  const [loading, setLoading] = useState(true);
  const [equipment, setEquipment] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [tickets, setTickets] = useState([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [eqRes, amcRes, tktRes] = await Promise.all([
        fetch("/api/service/equipment").then((r) => r.json()),
        fetch("/api/service/amc-contracts").then((r) => r.json()),
        fetch("/api/service/tickets").then((r) => r.json()),
      ]);

      if (eqRes.ok) setEquipment(eqRes.equipment || []);
      if (amcRes.ok) setContracts(amcRes.contracts || []);
      if (tktRes.ok) setTickets(tktRes.tickets || []);
    } catch (err) {
      console.error("Failed to load service data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAddEquipment = async (payload) => {
    const res = await fetch("/api/service/equipment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Equipment creation failed");
    await loadData();
  };

  const handleAddContract = async (payload) => {
    const res = await fetch("/api/service/amc-contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "AMC contract creation failed");
    await loadData();
  };

  const handleAddTicket = async (payload) => {
    const res = await fetch("/api/service/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Service ticket creation failed");
    await loadData();
  };

  const handleIssueParts = async (ticketId, payload) => {
    const res = await fetch(`/api/service/tickets/${ticketId}/issue-parts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Spare parts issuance failed");
    await loadData();
  };

  const handleUpdateStatus = async (ticketId, status, resolutionNotes) => {
    const res = await fetch(`/api/service/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, resolution_notes: resolutionNotes }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Ticket status update failed");
    await loadData();
  };

  const activeEquipmentCount = equipment.length;
  const activeAmcCount = contracts.filter((c) => c.end_date && new Date(c.end_date) >= new Date()).length;
  const openTicketsCount = tickets.filter((t) => ["open", "in_progress"].includes(t.ticket_status)).length;
  const totalPartsCost = tickets.reduce((sum, t) => sum + Number(t.parts_cost_total || 0), 0);

  return (
    <div className="service-desk">
      {/* Command Bar */}
      <div className="sd-command-bar">
        <div className="sd-title-group">
          <h1>Equipment Servicing, Field Maintenance & AMC Management</h1>
          <p>Serialized Asset Tracking, Warranty/AMC Verification & Spare Parts Ledger</p>
        </div>
        <div className="sd-actions-group">
          <button className="sd-btn secondary" type="button" onClick={loadData} disabled={loading}>
            {loading ? "Refreshing..." : "↻ Refresh Desk"}
          </button>
        </div>
      </div>

      {/* KPI Overview */}
      <div className="sd-kpi-grid">
        <div className="sd-kpi-card">
          <span className="label">Installed Asset Base</span>
          <span className="value" style={{ color: "#0ea5e9" }}>
            {activeEquipmentCount} Machines
          </span>
          <span className="subtext">Serialized Finished Goods</span>
        </div>
        <div className="sd-kpi-card">
          <span className="label">Active AMC Contracts</span>
          <span className="value" style={{ color: "#15803d" }}>
            {activeAmcCount} Contracts
          </span>
          <span className="subtext">Annual Maintenance Coverage</span>
        </div>
        <div className="sd-kpi-card">
          <span className="label">Open Breakdown Calls</span>
          <span className="value" style={{ color: openTicketsCount > 0 ? "#b91c1c" : "#15803d" }}>
            {openTicketsCount} Calls
          </span>
          <span className="subtext">Active Field Dispatches</span>
        </div>
        <div className="sd-kpi-card">
          <span className="label">Service Parts Consumed</span>
          <span className="value" style={{ color: "#0f172a" }}>
            ₹{totalPartsCost.toLocaleString("en-IN")}
          </span>
          <span className="subtext">Inventory Deducted & GL Posted</span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="sd-tabs">
        <button
          className={`sd-tab-btn ${activeTab === "equipment" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("equipment")}
        >
          Installed Equipment Registry
        </button>
        <button
          className={`sd-tab-btn ${activeTab === "amc" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("amc")}
        >
          AMC Contracts & Preventive Maintenance
        </button>
        <button
          className={`sd-tab-btn ${activeTab === "tickets" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("tickets")}
        >
          Service Tickets & Field Console
        </button>
      </div>

      {/* Tab Panels */}
      {activeTab === "equipment" && (
        <InstalledEquipmentRegistry
          equipment={equipment}
          onAddEquipment={handleAddEquipment}
          onRefresh={loadData}
        />
      )}

      {activeTab === "amc" && (
        <AmcContractDashboard
          contracts={contracts}
          onAddContract={handleAddContract}
          onRefresh={loadData}
        />
      )}

      {activeTab === "tickets" && (
        <FieldTicketingConsole
          tickets={tickets}
          onAddTicket={handleAddTicket}
          onIssueParts={handleIssueParts}
          onUpdateStatus={handleUpdateStatus}
          onRefresh={loadData}
        />
      )}
    </div>
  );
}
