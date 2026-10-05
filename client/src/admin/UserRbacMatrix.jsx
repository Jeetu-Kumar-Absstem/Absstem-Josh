import React, { useState } from "react";

/**
 * Read-only directory of users + primary roles.
 * Screen permissions and role writes live in Org & Access / Rights Matrix only.
 */
export default function UserRbacMatrix({ users = [], onRefresh, onOpenOrgAccess, onOpenRights, onOpenAccessPreview }) {
  const [search, setSearch] = useState("");
  const canDeepLink = typeof onOpenOrgAccess === "function";

  const filteredUsers = users.filter((u) => {
    if (!search) return true;
    const term = search.toLowerCase();
    return (
      u.email?.toLowerCase().includes(term) ||
      u.full_name?.toLowerCase().includes(term) ||
      u.role_name?.toLowerCase().includes(term)
    );
  });

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <h3>User Directory (read-only)</h3>
          <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
            Role and screen rights are managed in Org & Access. This tab does not change permissions.
          </span>
        </div>
        <div className="admin-filter-bar">
          <input
            type="text"
            className="admin-filter-input"
            placeholder="Search users or roles..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="admin-btn secondary small" type="button" onClick={onRefresh}>
            Refresh
          </button>
          {typeof onOpenRights === "function" ? (
            <button className="admin-btn secondary small" type="button" onClick={() => onOpenRights()}>
              Open Rights Matrix
            </button>
          ) : null}
          {canDeepLink ? (
            <button className="admin-btn primary small" type="button" onClick={() => onOpenOrgAccess({ view: "directory" })}>
              Open Org & Access
            </button>
          ) : null}
        </div>
      </div>

      <div
        style={{
          marginBottom: 12,
          padding: "10px 12px",
          borderRadius: 8,
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          fontSize: 13,
          color: "#334155",
        }}
      >
        To change a user&apos;s role, screen access, or financial authority, use the row links below — they open that user in{" "}
        <strong>Org & Access</strong>. Use <strong>Rights Matrix</strong> for role templates.
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th style={{ width: 60, textAlign: "center" }}>ID</th>
              <th>Full Name & Email</th>
              <th style={{ width: 140 }}>User Group</th>
              <th style={{ width: 180 }}>Assigned Primary Role</th>
              <th style={{ width: 140 }}>Last Login</th>
              <th style={{ width: 100, textAlign: "center" }}>Status</th>
              {canDeepLink ? <th style={{ width: 240 }}>Manage in Org & Access</th> : null}
            </tr>
          </thead>
          <tbody>
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={canDeepLink ? 7 : 6} style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                  No users found.
                </td>
              </tr>
            ) : (
              filteredUsers.map((user) => (
                <tr key={user.id}>
                  <td style={{ textAlign: "center" }}>{user.id}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{user.full_name || "—"}</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>{user.email || "—"}</div>
                  </td>
                  <td>{user.group_name || "—"}</td>
                  <td>{user.role_name || "—"}</td>
                  <td>{user.last_login_at ? new Date(user.last_login_at).toLocaleString() : "—"}</td>
                  <td style={{ textAlign: "center" }}>{user.is_active ? "Active" : "Inactive"}</td>
                  {canDeepLink ? (
                    <td>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          className="admin-btn secondary small"
                          type="button"
                          onClick={() => onOpenOrgAccess({ view: "directory", userId: user.id, governanceTab: "identity" })}
                        >
                          Edit role
                        </button>
                        <button
                          className="admin-btn secondary small"
                          type="button"
                          onClick={() => onOpenOrgAccess({ view: "directory", userId: user.id, governanceTab: "screens" })}
                        >
                          Screen access
                        </button>
                        {typeof onOpenAccessPreview === "function" ? (
                          <button className="admin-btn secondary small" type="button" onClick={() => onOpenAccessPreview(user.id)}>
                            Preview
                          </button>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
