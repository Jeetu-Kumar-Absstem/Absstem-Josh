import React, { useState } from "react";

export default function SystemHealthBackupDashboard({ health, backups = [], onTriggerBackup, onRefresh }) {
  const [triggering, setTriggering] = useState(false);
  const [destination, setDestination] = useState("local_vps");
  const [backupType, setBackupType] = useState("manual");

  const handleBackupSubmit = async () => {
    setTriggering(true);
    try {
      const res = await onTriggerBackup({
        storage_destination: destination,
        backup_type: backupType,
      });
      alert(res?.message || "Backup intent recorded (metadata-only).");
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(`Backup intent failed: ${err.message || err}`);
    } finally {
      setTriggering(false);
    }
  };

  const dbInfo = health?.database || {};
  const auditInfo = health?.audit_telemetry || {};
  const coverage = health?.backup_coverage || null;
  const lastRealHint = backups.find((b) => b.status === "completed" && Number(b.file_size_bytes || 0) > 0);
  const dbReachable = dbInfo.status === "REACHABLE";

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div
        style={{
          border: "1px solid #f59e0b",
          background: "#fffbeb",
          borderRadius: 12,
          padding: "12px 14px",
          fontSize: 13,
          color: "#92400e",
          lineHeight: 1.5,
        }}
      >
        <strong>Honest backup status:</strong> Josh currently records <em>backup intent metadata only</em>.
        Triggering a snapshot does <strong>not</strong> run <code>pg_dump</code> and is <strong>not</strong> disaster-recovery coverage.
        Prefer OS/VPS scheduled dumps until a real dump+restore test is wired.
      </div>

      <div className="admin-kpi-grid">
        <div className="admin-kpi-card">
          <span className="label">Database Status</span>
          <span className="value" style={{ color: dbReachable ? "#15803d" : "#b45309" }}>
            {dbInfo.status || "UNKNOWN"}
          </span>
          <span className="subtext">
            {dbInfo.current_database ? `${dbInfo.current_database} · ` : ""}
            {dbInfo.size_pretty ? `${dbInfo.size_pretty} on disk` : "size not reported"}
          </span>
        </div>
        <div className="admin-kpi-card">
          <span className="label">DB Connections (this database)</span>
          <span className="value" style={{ color: "#0ea5e9" }}>
            {dbInfo.active_connections ?? "—"}
            {dbInfo.pool_capacity ? ` / ${dbInfo.pool_capacity} API pool` : ""}
          </span>
          <span className="subtext">From live pg_stat_activity</span>
        </div>
        <div className="admin-kpi-card">
          <span className="label">24-Hour Audit Velocity</span>
          <span className="value" style={{ color: "#334155" }}>
            {auditInfo.events_past_24h ?? "—"} Events
          </span>
          <span className="subtext">Logged to audit trail</span>
        </div>
        <div className="admin-kpi-card">
          <span className="label">Disaster-recovery coverage</span>
          <span className="value" style={{ color: "#b45309" }}>
            Not verified
          </span>
          <span className="subtext">
            {coverage?.restore_tested
              ? "Restore tested"
              : lastRealHint
                ? `${lastRealHint.backup_code} recorded, restore not tested`
                : "No pg_dump in Josh · no restore test on record"}
          </span>
        </div>
      </div>

      <div className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h3>Backup intent log (not DR archives)</h3>
            <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
              Records who requested a snapshot and catalog stats — no dump file is written
            </span>
          </div>
          <div className="admin-filter-bar">
            <select
              className="admin-filter-select"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="local_vps">Intended: Local VPS</option>
              <option value="google_drive">Intended: Google Drive</option>
              <option value="hybrid_cloud">Intended: Hybrid</option>
            </select>
            <select
              className="admin-filter-select"
              value={backupType}
              onChange={(e) => setBackupType(e.target.value)}
            >
              <option value="manual">manual</option>
              <option value="schema_only">schema_only</option>
              <option value="full_data">full_data</option>
            </select>
            <button
              className="admin-btn primary small"
              type="button"
              disabled={triggering}
              onClick={handleBackupSubmit}
            >
              {triggering ? "Recording…" : "Record backup intent"}
            </button>
            <button className="admin-btn secondary small" type="button" onClick={onRefresh}>
              ↻ Refresh
            </button>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>Backup ID</th>
                <th style={{ width: 90, textAlign: "center" }}>Type</th>
                <th style={{ width: 140 }}>Destination intent</th>
                <th>Filename / note</th>
                <th style={{ width: 100, textAlign: "right" }}>File Size</th>
                <th style={{ width: 120, textAlign: "right" }}>Live rows at request (not saved)</th>
                <th style={{ width: 90, textAlign: "right" }}>Duration</th>
                <th style={{ width: 130 }}>Triggered By</th>
                <th style={{ width: 120 }}>Timestamp</th>
                <th style={{ width: 120, textAlign: "center" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {backups.length === 0 ? (
                <tr>
                  <td colSpan="10" style={{ textAlign: "center", padding: "28px", color: "#94a3b8" }}>
                    No backup intent logs yet.
                  </td>
                </tr>
              ) : (
                backups.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <strong>{b.backup_code}</strong>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span style={{ textTransform: "capitalize", fontSize: "0.75rem" }}>
                        {b.backup_type || "manual"}
                      </span>
                    </td>
                    <td>
                      <strong>
                        {b.storage_destination === "google_drive"
                          ? "Google Drive"
                          : b.storage_destination === "hybrid_cloud"
                          ? "Hybrid Cloud"
                          : "Local VPS"}
                      </strong>
                    </td>
                    <td>
                      <code style={{ fontSize: "0.75rem", color: "#0369a1" }}>{b.file_name || "—"}</code>
                      {b.error_message ? (
                        <div style={{ fontSize: 11, color: "#92400e", marginTop: 4 }}>{b.error_message}</div>
                      ) : null}
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      {b.file_size_display || (Number(b.file_size_bytes || 0) > 0 ? `${b.file_size_bytes} B` : "No dump file")}
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                      {Number(b.records_backed_up || 0).toLocaleString("en-IN")} rows
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>{b.duration_seconds ?? "—"}s</td>
                    <td>{b.triggered_by_name || "—"}</td>
                    <td>
                      <div>{new Date(b.created_at).toLocaleDateString("en-IN")}</div>
                      <small style={{ color: "#64748b" }}>
                        {new Date(b.created_at).toLocaleTimeString("en-IN")}
                      </small>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`admin-chip ${b.status || "metadata_only"}`}>
                        {b.status || "metadata_only"}
                      </span>
                    </td>
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
