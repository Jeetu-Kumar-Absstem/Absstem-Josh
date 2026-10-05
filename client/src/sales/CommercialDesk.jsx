import { useEffect, useState } from "react";
import DealPipelineBoard from "./DealPipelineBoard";
import SalesOrderConsole from "./SalesOrderConsole";
import DispatchFulfillmentConsole from "./DispatchFulfillmentConsole";
import "./commercial.css";

export default function CommercialDesk() {
  const [activeTab, setActiveTab] = useState("pipeline"); // 'pipeline' | 'orders' | 'dispatches'
  const [deals, setDeals] = useState([]);
  const [orders, setOrders] = useState([]);
  const [dispatches, setDispatches] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreateDealModal, setShowCreateDealModal] = useState(false);
  const [dealTitle, setDealTitle] = useState("");
  const [dealValue, setDealValue] = useState("");
  const [dealProb, setDealProb] = useState("30");
  const [dealCustomer, setDealCustomer] = useState("");

  async function loadData() {
    setLoading(true);
    try {
      const [dealsRes, ordersRes, dispatchesRes] = await Promise.all([
        fetch("/api/sales/pipeline", { credentials: "include" }).then((r) => r.json()),
        fetch("/api/sales/orders", { credentials: "include" }).then((r) => r.json()),
        fetch("/api/sales/dispatches", { credentials: "include" }).then((r) => r.json()),
      ]);

      if (dealsRes.ok) setDeals(dealsRes.deals || []);
      if (ordersRes.ok) setOrders(ordersRes.orders || []);
      if (dispatchesRes.ok) setDispatches(dispatchesRes.dispatches || []);
    } catch (err) {
      console.error("Failed to load commercial desk data:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleStageChange(dealId, newStage) {
    try {
      const res = await fetch(`/api/sales/pipeline/${dealId}/stage`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: newStage }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to update deal stage");
      loadData();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleCreateDeal(e) {
    e.preventDefault();
    try {
      const res = await fetch("/api/sales/pipeline", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: dealTitle,
          expected_value: Number(dealValue || 0),
          probability_pct: Number(dealProb || 30),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to create deal");
      setShowCreateDealModal(false);
      setDealTitle("");
      setDealValue("");
      loadData();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleConvertToOrder(payload) {
    const res = await fetch(`/api/sales/quotes/${payload.quoteId}/convert-to-order`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const messages = {
        QUOTE_NOT_ISSUED: "This quote is not issued yet. Issue it from Quotes before converting.",
        SALES_ORDER_ALREADY_EXISTS: `Sales Order ${data?.so_number || ""} already exists for this quote.`,
        NO_LINES: "This quote has no included lines to order.",
        FORBIDDEN: "You don't have rights to convert this quote.",
      };
      throw new Error(messages[data?.error] || data?.detail || data?.error || "Conversion failed");
    }
    loadData();
    return data;
  }

  async function handleSelectOrder(orderId) {
    try {
      const res = await fetch(`/api/sales/orders/${orderId}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        setSelectedOrder(data);
        setActiveTab("dispatches");
      }
    } catch (err) {
      alert("Failed to load order details");
    }
  }

  async function handleProcessDispatch(orderId, payload) {
    const res = await fetch(`/api/sales/orders/${orderId}/dispatch`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail || data?.error || "Dispatch failed");
    setSelectedOrder(null);
    loadData();
    return data;
  }

  // Derived KPIs
  const pipelineValue = deals
    .filter((d) => ["inquiry", "quoted", "negotiation"].includes(d.stage))
    .reduce((sum, d) => sum + Number(d.expected_value || 0), 0);
  const confirmedOrdersVal = orders
    .filter((o) => o.order_status === "confirmed")
    .reduce((sum, o) => sum + Number(o.grand_total_base || 0), 0);
  const dispatchedCount = dispatches.length;

  return (
    <div className="commercial-desk">
      {/* Command Bar */}
      <div className="cd-command-bar">
        <div className="cd-title-group">
          <h1>Commercial & Sales Pipeline</h1>
          <p>CRM negotiations, smart quote-to-order conversion, and dispatch fulfillment</p>
        </div>
        <div className="cd-actions-group">
          <button
            className="cd-btn secondary"
            type="button"
            onClick={loadData}
          >
            ↻ Refresh
          </button>
          <button
            className="cd-btn primary"
            type="button"
            onClick={() => setShowCreateDealModal(true)}
          >
            + New Deal
          </button>
        </div>
      </div>

      {/* KPI Overview */}
      <div className="cd-kpi-grid">
        <div className="cd-kpi-card">
          <span className="label">Active Pipeline</span>
          <span className="value">₹{pipelineValue.toLocaleString("en-IN")}</span>
          <span className="subtext">{deals.filter((d) => ["inquiry", "quoted", "negotiation"].includes(d.stage)).length} open opportunities</span>
        </div>
        <div className="cd-kpi-card">
          <span className="label">Confirmed Booking</span>
          <span className="value">₹{confirmedOrdersVal.toLocaleString("en-IN")}</span>
          <span className="subtext">{orders.filter((o) => o.order_status === "confirmed").length} orders in production / ready</span>
        </div>
        <div className="cd-kpi-card">
          <span className="label">Total Dispatches</span>
          <span className="value">{dispatchedCount}</span>
          <span className="subtext">Outbound consignments processed</span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="cd-tabs">
        <button
          className={`cd-tab-btn ${activeTab === "pipeline" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("pipeline")}
        >
          Deal Pipeline Board ({deals.length})
        </button>
        <button
          className={`cd-tab-btn ${activeTab === "orders" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("orders")}
        >
          Sales Orders Desk ({orders.length})
        </button>
        <button
          className={`cd-tab-btn ${activeTab === "dispatches" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("dispatches")}
        >
          Dispatch & Fulfillment ({dispatches.length})
        </button>
      </div>

      {/* Tab Panels */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#64748b" }}>
          Loading commercial pipeline...
        </div>
      ) : (
        <>
          {activeTab === "pipeline" && (
            <DealPipelineBoard
              deals={deals}
              onStageChange={handleStageChange}
            />
          )}

          {activeTab === "orders" && (
            <SalesOrderConsole
              orders={orders}
              onSelectOrder={handleSelectOrder}
              onConvertToOrder={handleConvertToOrder}
            />
          )}

          {activeTab === "dispatches" && (
            <DispatchFulfillmentConsole
              dispatches={dispatches}
              selectedOrder={selectedOrder}
              onCloseOrderDetail={() => setSelectedOrder(null)}
              onProcessDispatch={handleProcessDispatch}
            />
          )}
        </>
      )}

      {/* Create Deal Modal */}
      {showCreateDealModal && (
        <div className="cd-modal-overlay">
          <div className="cd-modal-card">
            <div className="cd-modal-header">
              <h2>Add Commercial Deal / Inquiry</h2>
              <button
                type="button"
                style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer" }}
                onClick={() => setShowCreateDealModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateDeal}>
              <div className="cd-modal-body">
                <div className="cd-form-group">
                  <label>Deal Title / Project *</label>
                  <input
                    type="text"
                    placeholder="e.g. 500 LPM Medical Oxygen Plant - Apex Hospital"
                    value={dealTitle}
                    onChange={(e) => setDealTitle(e.target.value)}
                    required
                  />
                </div>
                <div className="cd-form-group">
                  <label>Expected Value (INR) *</label>
                  <input
                    type="number"
                    placeholder="e.g. 4500000"
                    value={dealValue}
                    onChange={(e) => setDealValue(e.target.value)}
                    required
                  />
                </div>
                <div className="cd-form-group">
                  <label>Win Probability (%)</label>
                  <input
                    type="number"
                    value={dealProb}
                    onChange={(e) => setDealProb(e.target.value)}
                  />
                </div>
              </div>
              <div className="cd-modal-footer">
                <button
                  type="button"
                  className="cd-btn secondary"
                  onClick={() => setShowCreateDealModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cd-btn primary"
                >
                  Save Deal
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
