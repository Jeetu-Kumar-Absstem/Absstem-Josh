import React, { useState } from "react";

export default function AuditTrailInspector({ logs = [], onFilterChange, filterState, onRefresh }) {
  const [inspectLog, setInspectLog] = useState(null);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <h3>Enterprise Security Audit Trail & Event Logs</h3>
          <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
            Immutable chronological record of all database and governance operations
          </span>
        </div>
        <div className="admin-filter-bar">
          <input
            type="text"
            className="admin-filter-input"
            placeholder="Search logs, tables, remarks..."
            value={filterState.search || ""}
            onChange={(e) => onFilterChange({ ...filterState, search: e.target.value })}
          />
          <select
            className="admin-filter-select"
            value={filterState.module || "ALL"}
            onChange={(e) => onFilterChange({ ...filterState, module: e.target.value })}
          >
            <option value="ALL">All Modules</option>
            <option value="SYSTEM_ADMIN">System Admin</option>
            <option value="MANUFACTURING">Manufacturing</option>
            <option value="PURCHASE">Purchase & Vendors</option>
            <option value="SALES">Commercial Sales</option>
            <option value="FINANCE">Finance & Accounts</option>
            <option value="SERVICE">Service & Maintenance</option>
            <option value="MRP">MRP Planning</option>
            <option value="INVENTORY">Inventory & Stock</option>
            <option value="AUTH">Authentication</option>
          </select>
          <select
            className="admin-filter-select"
            value={filterState.actionType || "ALL"}
            onChange={(e) => onFilterChange({ ...filterState, actionType: e.target.value })}
          >
            <option value="ALL">All Actions</option>
            <option value="CREATE">CREATE</option>
            <option value="UPDATE">UPDATE</option>
            <option value="DELETE">DELETE</option>
            <option value="APPROVE">APPROVE</option>
            <option value="ROLE_CHANGE">ROLE_CHANGE</option>
            <option value="BACKUP_TRIGGER">BACKUP_TRIGGER</option>
            <option value="GL_POST">GL_POST</option>
            <option value="BOM_LOCK">BOM_LOCK</option>
          </select>
          <button className="admin-btn secondary small" type="button" onClick={onRefresh}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th style={{ width: 110 }}>Timestamp</th>
              <th style={{ width: 160 }}>Actor</th>
              <th style={{ width: 120 }}>Module</th>
              <th style={{ width: 100, textAlign: "center" }}>Action</th>
              <th style={{ width: 140 }}>Target Entity</th>
              <th>Remarks / Description</th>
              <th style={{ width: 110 }}>IP & Client</th>
              <th style={{ width: 90, textAlign: "center" }}>Status</th>
              <th style={{ width: 80, textAlign: "center" }}>Payload</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td colSpan="9" style={{ textAlign: "center", padding: "28px", color: "#94a3b8" }}>
                  No audit trail events match the current filter criteria.
                </td>
              </tr>
            ) : (
              logs.map((l) => (
                <tr key={l.id}>
                  <td>
                    <strong>{new Date(l.created_at).toLocaleDateString("en-IN")}</strong>
                    <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>
                      {new Date(l.created_at).toLocaleTimeString("en-IN")}
                    </div>
                  </td>
                  <td>
                    <strong>{l.actor_display_name || l.actor_name || "System"}</strong>
                    <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>
                      {l.actor_display_email || l.actor_email || "system@absstem.com"}
                    </div>
                  </td>
                  <td>
                    <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "#334155" }}>
                      {l.module}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={`admin-chip ${l.action_type || "UPDATE"}`}>
                      {l.action_type}
                    </span>
                  </td>
                  <td>
                    <strong>{l.target_table || "—"}</strong>
                    {l.target_id && (
                      <div style={{ fontSize: "0.6875rem", color: "#64748b" }}>ID: #{l.target_id}</div>
                    )}
                  </td>
                  <td>
                    <div style={{ maxWidth: 280, fontSize: "0.75rem", color: "#334155" }}>
                      {l.remarks || "State transition verified"}
                    </div>
                  </td>
                  <td>
                    <div style={{ fontSize: "0.75rem", color: "#475569" }}>{l.ip_address || "127.0.0.1"}</div>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={`admin-chip ${l.status || "success"}`}>
                      {l.status || "success"}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {(l.old_payload || l.new_payload) ? (
                      <button
                        className="admin-btn secondary small"
                        type="button"
                        onClick={() => setInspectLog(l)}
                      >
                        Inspect
                      </button>
                    ) : (
                      <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {inspectLog && (
        <div className="admin-modal-overlay">
          <div className="admin-modal-card">
            <div className="admin-modal-header">
              <h2>Audit Event #{inspectLog.id} Payload Inspection</h2>
              <button
                type="button"
                className="admin-btn secondary small"
                onClick={() => setInspectLog(null)}
              >
                ✕
              </button>
            </div>
            <div className="admin-modal-body">
              <div>
                <strong style={{ fontSize: "0.8125rem", color: "#475569" }}>
                  Action: {inspectLog.action_type} on {inspectLog.target_table} (#{inspectLog.target_id})
                </strong>
                <p style={{ margin: "4px 0 12px", fontSize: "0.75rem", color: "#64748b" }}>
                  By {inspectLog.actor_display_name} at {new Date(inspectLog.created_at).toLocaleString("en-IN")}
                </p>
              </div>

              {inspectLog.old_payload && (
                <div>
                  <label style={{ fontSize: "0.75rem", fontWeight: 700, color: "#b91c1c" }}>
                    Previous State (Old Payload):
                  </label>
                  <pre className="admin-payload-box">
                    {JSON.stringify(inspectLog.old_payload, null, 2)}
                  </pre>
                </div>
              )}

              {inspectLog.new_payload && (
                <div>
                  <label style={{ fontSize: "0.75rem", fontWeight: 700, color: "#15803d" }}>
                    Committed State (New Payload):
                  </label>
                  <pre className="admin-payload-box">
                    {JSON.stringify(inspectLog.new_payload, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <div className="admin-modal-footer">
              <button
                type="button"
                className="admin-btn secondary"
                onClick={() => setInspectLog(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
