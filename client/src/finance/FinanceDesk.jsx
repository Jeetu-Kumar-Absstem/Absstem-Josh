import React, { useEffect, useState } from "react";
import InvoicingArConsole from "./InvoicingArConsole";
import AccountsPayableThreeWayMatchDesk from "./AccountsPayableThreeWayMatchDesk";
import GstGlReportingConsole from "./GstGlReportingConsole";
import "./finance.css";

export default function FinanceDesk() {
  const [activeTab, setActiveTab] = useState("invoicing"); // 'invoicing', 'ap_match', 'gst_gl'
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState([]);
  const [vendorBills, setVendorBills] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [glEntries, setGlEntries] = useState([]);
  const [gstSummary, setGstSummary] = useState(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [invRes, billsRes, acctsRes, glRes, gstRes] = await Promise.all([
        fetch("/api/finance/invoices").then((r) => r.json()),
        fetch("/api/finance/vendor-bills").then((r) => r.json()),
        fetch("/api/finance/chart-of-accounts").then((r) => r.json()),
        fetch("/api/finance/gl-entries").then((r) => r.json()),
        fetch("/api/finance/gst-reconciliation").then((r) => r.json()),
      ]);

      if (invRes.ok) setInvoices(invRes.invoices || []);
      if (billsRes.ok) setVendorBills(billsRes.bills || []);
      if (acctsRes.ok) setAccounts(acctsRes.accounts || []);
      if (glRes.ok) setGlEntries(glRes.entries || []);
      if (gstRes.ok) setGstSummary(gstRes.summary || null);
    } catch (err) {
      console.error("Failed to load finance data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRecordPayment = async (invoiceId, paymentAmount) => {
    const res = await fetch(`/api/finance/invoices/${invoiceId}/record-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment_amount: paymentAmount }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Payment recording failed");
    await loadData();
  };

  const handleProcessBill = async (payload) => {
    const res = await fetch("/api/finance/vendor-bills/match-and-process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "3-Way Match validation failed");
    await loadData();
  };

  // Aggregated KPIs
  const totalReceivables = invoices.reduce((sum, inv) => sum + Number(inv.balance_due || inv.grand_total_base || 0), 0);
  const totalPayables = vendorBills.filter((b) => b.payment_status === "unpaid").reduce((sum, b) => sum + Number(b.grand_total || 0), 0);
  const netGstLiability = gstSummary?.net_gst_liability || 0;

  return (
    <div className="finance-desk">
      {/* Command Bar */}
      <div className="fd-command-bar">
        <div className="fd-title-group">
          <h1>Finance, Automated Invoicing & GST Reconciliation</h1>
          <p>Double-Entry General Ledger, 3-Way Match AP & Real-time Tax Audit</p>
        </div>
        <div className="fd-actions-group">
          <button className="fd-btn secondary" type="button" onClick={loadData} disabled={loading}>
            {loading ? "Refreshing..." : "↻ Refresh Ledger"}
          </button>
        </div>
      </div>

      {/* KPI Overview */}
      <div className="fd-kpi-grid">
        <div className="fd-kpi-card">
          <span className="label">Accounts Receivable (AR)</span>
          <span className="value" style={{ color: "#0284c7" }}>
            ₹{totalReceivables.toLocaleString("en-IN")}
          </span>
          <span className="subtext">{invoices.length} Tax Invoices Issued</span>
        </div>
        <div className="fd-kpi-card">
          <span className="label">Accounts Payable (AP)</span>
          <span className="value" style={{ color: "#d97706" }}>
            ₹{totalPayables.toLocaleString("en-IN")}
          </span>
          <span className="subtext">{vendorBills.length} Vendor Invoices Tracked</span>
        </div>
        <div className="fd-kpi-card">
          <span className="label">Net GST Tax Liability</span>
          <span className="value" style={{ color: netGstLiability > 0 ? "#b91c1c" : "#15803d" }}>
            ₹{netGstLiability.toLocaleString("en-IN")}
          </span>
          <span className="subtext">Output GST vs Input Tax Credit</span>
        </div>
        <div className="fd-kpi-card">
          <span className="label">General Ledger Status</span>
          <span className="value" style={{ color: "#0f172a" }}>
            {glEntries.length} Entries
          </span>
          <span className="subtext">Across {accounts.length} Chart Accounts</span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="fd-tabs">
        <button
          className={`fd-tab-btn ${activeTab === "invoicing" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("invoicing")}
        >
          Invoicing & Accounts Receivable (AR)
        </button>
        <button
          className={`fd-tab-btn ${activeTab === "ap_match" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("ap_match")}
        >
          Accounts Payable & 3-Way Match Desk
        </button>
        <button
          className={`fd-tab-btn ${activeTab === "gst_gl" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("gst_gl")}
        >
          GST Reconciliation & General Ledger
        </button>
      </div>

      {/* Tab Panels */}
      {activeTab === "invoicing" && (
        <InvoicingArConsole
          invoices={invoices}
          onRecordPayment={handleRecordPayment}
          onRefresh={loadData}
        />
      )}

      {activeTab === "ap_match" && (
        <AccountsPayableThreeWayMatchDesk
          bills={vendorBills}
          onProcessBill={handleProcessBill}
          onRefresh={loadData}
        />
      )}

      {activeTab === "gst_gl" && (
        <GstGlReportingConsole
          gstSummary={gstSummary}
          accounts={accounts}
          entries={glEntries}
        />
      )}
    </div>
  );
}
