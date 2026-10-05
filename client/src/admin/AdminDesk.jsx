import React, { useEffect, useState } from "react";
import AuditTrailInspector from "./AuditTrailInspector";
import UserRbacMatrix from "./UserRbacMatrix";
import SystemHealthBackupDashboard from "./SystemHealthBackupDashboard";
import "./admin.css";

function AccessAuditViewer({ audits = [], ready = true, onRefresh }) {
  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <h3>User access audit</h3>
          <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
            Rights / offboarding / onboarding events from user_access_audit
          </span>
        </div>
        <button className="admin-btn secondary small" type="button" onClick={onRefresh}>
          ↻ Refresh
        </button>
      </div>
      {!ready ? (
        <div style={{ padding: 16, color: "#b45309" }}>user_access_audit table not ready.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Target user</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {audits.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: 24, color: "#94a3b8" }}>
                    No access audit rows yet.
                  </td>
                </tr>
              ) : (
                audits.map((row) => (
                  <tr key={row.id}>
                    <td>{row.created_at ? new Date(row.created_at).toLocaleString("en-IN") : "—"}</td>
                    <td>{row.action || "—"}</td>
                    <td>{row.actor_name || row.actor_email || "—"}</td>
                    <td>{row.target_user_name || row.target_user_email || "—"}</td>
                    <td>{row.target_role_id || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AdminDesk({ onNavigate }) {
  const [activeTab, setActiveTab] = useState("audit"); // 'audit', 'rbac', 'access', 'health'
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState([]);
  const [users, setUsers] = useState([]);
  const [backups, setBackups] = useState([]);
  const [health, setHealth] = useState(null);
  const [accessAudits, setAccessAudits] = useState([]);
  const [accessAuditReady, setAccessAuditReady] = useState(true);

  const [auditFilter, setAuditFilter] = useState({
    module: "ALL",
    actionType: "ALL",
    search: "",
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (auditFilter.module && auditFilter.module !== "ALL") params.append("module", auditFilter.module);
      if (auditFilter.actionType && auditFilter.actionType !== "ALL") params.append("action_type", auditFilter.actionType);
      if (auditFilter.search) params.append("search", auditFilter.search);

      const [logsRes, usersRes, backupsRes, healthRes, accessRes] = await Promise.all([
        fetch(`/api/admin/audit-logs?${params.toString()}`).then((r) => r.json()),
        fetch("/api/admin/users").then((r) => r.json()),
        fetch("/api/admin/backups").then((r) => r.json()),
        fetch("/api/admin/system-health").then((r) => r.json()),
        fetch("/api/admin/user-access-audit?limit=80").then((r) => r.json()).catch(() => ({ ok: false })),
      ]);

      if (logsRes.ok) setLogs(logsRes.audit_logs || []);
      if (usersRes.ok) {
        setUsers(usersRes.users || []);
      }
      if (backupsRes.ok) setBackups(backupsRes.backups || []);
      if (healthRes.ok) setHealth(healthRes.health || null);
      if (accessRes.ok) {
        setAccessAudits(accessRes.audits || []);
        setAccessAuditReady(accessRes.ready !== false);
      }
    } catch (err) {
      console.error("Failed to load admin governance data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [auditFilter.module, auditFilter.actionType]);

  const handleTriggerBackup = async (payload) => {
    const res = await fetch("/api/admin/backups/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Backup snapshot failed");
    await loadData();
    return data;
  };

  const activeUsersCount = users.filter((u) => u.is_active).length;
  const lastBackup = backups[0];
  const roleCount = new Set(users.map((u) => u.role_key || u.primary_role_id).filter(Boolean)).size;

  return (
    <div className="admin-desk">
      {/* Command Bar */}
      <div className="admin-command-bar">
        <div className="admin-title-group">
          <h1>System Administration & Security Governance</h1>
          <p>Audit trails, access matrix, access audit viewer, and honest backup-intent logging</p>
        </div>
        <div className="admin-actions-group">
          <button className="admin-btn secondary" type="button" onClick={loadData} disabled={loading}>
            {loading ? "Refreshing..." : "↻ Refresh System State"}
          </button>
        </div>
      </div>

      {/* Top Level KPIs */}
      <div className="admin-kpi-grid">
        <div className="admin-kpi-card">
          <span className="label">Active Staff Accounts</span>
          <span className="value" style={{ color: "#0ea5e9" }}>
            {activeUsersCount} / {users.length} Users
          </span>
          <span className="subtext">Across {roleCount} roles in use</span>
        </div>
        <div className="admin-kpi-card">
          <span className="label">Audit Events Logged</span>
          <span className="value" style={{ color: "#334155" }}>
            {logs.length}+ Logs
          </span>
          <span className="subtext">Past 24h: {health?.audit_telemetry?.events_past_24h ?? "—"} events</span>
        </div>
        <div className="admin-kpi-card">
          <span className="label">Latest Backup Intent</span>
          <span className="value" style={{ color: lastBackup ? "#b45309" : "#94a3b8", fontSize: 18 }}>
            {lastBackup ? lastBackup.status || "metadata_only" : "None"}
          </span>
          <span className="subtext">
            {lastBackup
              ? `${lastBackup.backup_code} · ${lastBackup.file_size_display || "No dump file"}`
              : "Not DR coverage — see Health tab"}
          </span>
        </div>
        <div className="admin-kpi-card">
          <span className="label">Database</span>
          <span className="value" style={{ color: health?.database?.status === "REACHABLE" ? "#15803d" : "#b45309" }}>
            {health?.database?.status || "UNKNOWN"}
          </span>
          <span className="subtext">
            {health?.database?.size_pretty || "—"} · {health?.database?.active_connections ?? "—"} conns
          </span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="admin-tabs">
        <button
          className={`admin-tab-btn ${activeTab === "audit" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("audit")}
        >
          Security Audit Trail ({logs.length})
        </button>
        <button
          className={`admin-tab-btn ${activeTab === "rbac" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("rbac")}
        >
          User Directory · read-only ({users.length})
        </button>
        <button
          className={`admin-tab-btn ${activeTab === "access" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("access")}
        >
          Access Audit ({accessAudits.length})
        </button>
        <button
          className={`admin-tab-btn ${activeTab === "health" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("health")}
        >
          System Health & Backup Governance
        </button>
      </div>

      {/* Tab Panels */}
      {activeTab === "audit" && (
        <AuditTrailInspector
          logs={logs}
          filterState={auditFilter}
          onFilterChange={setAuditFilter}
          onRefresh={loadData}
        />
      )}

      {activeTab === "rbac" && (
        <UserRbacMatrix
          users={users}
          onRefresh={loadData}
          onOpenOrgAccess={
            typeof onNavigate === "function"
              ? (adminLaunch = { view: "directory" }) => onNavigate("users", { resetQuote: true, adminLaunch })
              : undefined
          }
          onOpenRights={typeof onNavigate === "function" ? () => onNavigate("rights", { resetQuote: true }) : undefined}
          onOpenAccessPreview={
            typeof onNavigate === "function"
              ? (userId) => onNavigate("user_access_preview", { resetQuote: true, adminLaunch: { userId, focusLane: "all" } })
              : undefined
          }
        />
      )}

      {activeTab === "access" && (
        <AccessAuditViewer audits={accessAudits} ready={accessAuditReady} onRefresh={loadData} />
      )}

      {activeTab === "health" && (
        <SystemHealthBackupDashboard
          health={health}
          backups={backups}
          onTriggerBackup={handleTriggerBackup}
          onRefresh={loadData}
        />
      )}
    </div>
  );
}
