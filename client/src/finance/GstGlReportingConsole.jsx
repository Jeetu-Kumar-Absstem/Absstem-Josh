import React from "react";

export default function GstGlReportingConsole({ gstSummary, accounts = [], entries = [] }) {
  const outputTax = gstSummary?.output_tax || {};
  const itc = gstSummary?.input_tax_credit || {};

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* GST Tax Reconciliation Card */}
      <div className="fd-panel">
        <div className="fd-panel-header">
          <h3>Real-time GST & Input Tax Credit (ITC) Reconciliation</h3>
          <span style={{ fontSize: "0.8125rem", color: "#64748b" }}>
            Real-time Statutory Setoff Status
          </span>
        </div>
        <div style={{ padding: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          <div style={{ background: "#f8fafc", padding: 16, borderRadius: 8, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 10px", fontSize: "0.875rem", color: "#0f172a" }}>
              1. Output GST Liability (Sales)
            </h4>
            <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#b91c1c" }}>
              ₹{Number(outputTax.total || 0).toLocaleString("en-IN")}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: 6 }}>
              CGST: ₹{Number(outputTax.cgst || 0).toLocaleString("en-IN")} | SGST: ₹{Number(outputTax.sgst || 0).toLocaleString("en-IN")}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
              IGST: ₹{Number(outputTax.igst || 0).toLocaleString("en-IN")} ({outputTax.invoice_count || 0} Invoices)
            </div>
          </div>

          <div style={{ background: "#f8fafc", padding: 16, borderRadius: 8, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 10px", fontSize: "0.875rem", color: "#0f172a" }}>
              2. Input Tax Credit (ITC Paid)
            </h4>
            <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#15803d" }}>
              ₹{Number(itc.total || 0).toLocaleString("en-IN")}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: 6 }}>
              From {itc.bill_count || 0} Verified Vendor Bills
            </div>
            <div style={{ fontSize: "0.75rem", color: "#15803d" }}>
              Eligible for full statutory setoff against Output Liability
            </div>
          </div>

          <div style={{ background: "#eff6ff", padding: 16, borderRadius: 8, border: "1px solid #bfdbfe" }}>
            <h4 style={{ margin: "0 0 10px", fontSize: "0.875rem", color: "#1e40af" }}>
              3. Net GST Payable / Carry Forward
            </h4>
            <div style={{ fontSize: "1.3rem", fontWeight: 700, color: gstSummary?.net_gst_liability > 0 ? "#1e40af" : "#15803d" }}>
              {gstSummary?.net_gst_liability > 0
                ? `Net Payable: ₹${Number(gstSummary.net_gst_liability).toLocaleString("en-IN")}`
                : `ITC Credit: ₹${Number(gstSummary?.itc_carry_forward || 0).toLocaleString("en-IN")}`}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#3b82f6", marginTop: 6 }}>
              Auto-calculated double entry balance
            </div>
          </div>
        </div>
      </div>

      {/* Chart of Accounts & General Ledger Audit */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="fd-panel">
          <div className="fd-panel-header">
            <h3>Master Chart of Accounts (COA)</h3>
          </div>
          <div style={{ maxHeight: 340, overflowY: "auto" }}>
            <table className="fd-table">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>Code</th>
                  <th>Account Name</th>
                  <th style={{ width: 100, textAlign: "center" }}>Type</th>
                  <th style={{ width: 120, textAlign: "right" }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acc) => (
                  <tr key={acc.id}>
                    <td><strong>{acc.account_code}</strong></td>
                    <td>{acc.account_name}</td>
                    <td style={{ textAlign: "center" }}><span className="fd-status-chip draft">{acc.account_type}</span></td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}><strong>₹{Number(acc.net_balance || 0).toLocaleString("en-IN")}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="fd-panel">
          <div className="fd-panel-header">
            <h3>Recent Double-Entry GL Audit Trail</h3>
          </div>
          <div style={{ maxHeight: 340, overflowY: "auto" }}>
            <table className="fd-table">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Entry #</th>
                  <th>Account</th>
                  <th style={{ width: 100, textAlign: "right" }}>Debit</th>
                  <th style={{ width: 100, textAlign: "right" }}>Credit</th>
                  <th style={{ width: 120, textAlign: "center" }}>Event</th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan="5" style={{ textAlign: "center", padding: 18, color: "#94a3b8" }}>
                      No GL entries posted yet.
                    </td>
                  </tr>
                ) : (
                  entries.slice(0, 15).map((gle) => (
                    <tr key={gle.id}>
                      <td>
                        <strong>{gle.entry_number}</strong>
                        <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>
                          {gle.entry_date ? String(gle.entry_date).slice(0, 10) : "—"}
                        </div>
                      </td>
                      <td>
                        {gle.account_name}
                        <small style={{ display: "block", color: "#64748b" }}>{gle.account_code}</small>
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "monospace", color: Number(gle.debit) > 0 ? "#15803d" : "#94a3b8" }}>
                        {Number(gle.debit) > 0 ? `₹${Number(gle.debit).toLocaleString("en-IN")}` : "—"}
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "monospace", color: Number(gle.credit) > 0 ? "#b91c1c" : "#94a3b8" }}>
                        {Number(gle.credit) > 0 ? `₹${Number(gle.credit).toLocaleString("en-IN")}` : "—"}
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <span className="fd-status-chip issued">{gle.source_event}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
