import { createContext, useContext, useMemo, useState } from "react";

const VERTICAL_CHILD_THRESHOLD = 3;
const OrgChartOptions = createContext({ accessV2: false });

function isDistributorUser(user) {
  const group = String(user?.group_name || "").trim().toLowerCase();
  const role = String(user?.role_name || "").trim().toLowerCase();
  return group === "distributor" || role === "distributor";
}

function partnerOrgKey(user) {
  const distributorId = Number(user?.distributor_id);
  if (Number.isFinite(distributorId) && distributorId > 0) return `dist:${distributorId}`;
  const name = String(user?.distributor_name || user?.company_name || "").trim();
  if (name) return `name:${name.toLowerCase()}`;
  return `user:${Number(user?.id) || 0}`;
}

function partnerOrgLabel(users) {
  const sample = Array.isArray(users) ? users.find((u) => u?.distributor_name || u?.company_name) || users[0] : null;
  return sample?.distributor_name || sample?.company_name || sample?.full_name || "Channel partner";
}

function buildOrgForest(users, { hideLonelyRoots = false } = {}) {
  const byId = new Map();
  const childrenByManager = new Map();
  const list = Array.isArray(users) ? users : [];

  for (const user of list) {
    const id = Number(user?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    byId.set(id, user);
  }

  for (const user of byId.values()) {
    const id = Number(user.id);
    const managerId = Number(user.primary_manager_user_id);
    if (Number.isFinite(managerId) && managerId > 0 && managerId !== id && byId.has(managerId)) {
      if (!childrenByManager.has(managerId)) childrenByManager.set(managerId, []);
      childrenByManager.get(managerId).push(user);
    }
  }

  for (const kids of childrenByManager.values()) {
    kids.sort((a, b) => String(a.full_name || a.email || "").localeCompare(String(b.full_name || b.email || "")));
  }

  let roots = [];
  for (const user of byId.values()) {
    const id = Number(user.id);
    const managerId = Number(user.primary_manager_user_id);
    const hasValidManager = Number.isFinite(managerId) && managerId > 0 && managerId !== id && byId.has(managerId);
    if (!hasValidManager) roots.push(user);
  }

  roots.sort((a, b) => String(a.full_name || a.email || "").localeCompare(String(b.full_name || b.email || "")));

  // People whose primary-manager chain loops never hang off a root; surface them instead of dropping them.
  const reachable = new Set();
  const stack = roots.map((r) => Number(r.id));
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const kid of childrenByManager.get(id) || []) stack.push(Number(kid.id));
  }
  const loopUsers = [...byId.values()]
    .filter((u) => !reachable.has(Number(u.id)))
    .sort((a, b) => String(a.full_name || a.email || "").localeCompare(String(b.full_name || b.email || "")));

  if (hideLonelyRoots) {
    const withTeams = roots.filter((root) => (childrenByManager.get(Number(root.id)) || []).length > 0);
    if (withTeams.length) roots = withTeams;
  }

  return { byId, childrenByManager, roots, loopUsers };
}

function LoopWarning({ users, byId, onSelectUser }) {
  if (!users?.length) return null;
  return (
    <div style={{ border: "1px solid #fca5a5", background: "#fef2f2", borderRadius: 14, padding: 12, display: "grid", gap: 8 }}>
      <strong style={{ color: "#991b1b", fontSize: 13 }}>
        Manager loop: {users.length} {users.length === 1 ? "person is" : "people are"} not shown in the tree
      </strong>
      <div style={{ fontSize: 12, color: "#7f1d1d" }}>Their reporting lines point back to each other. Open one and change “Reports to” to break the loop.</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {users.map((u) => (
          <button key={u.id} type="button" onClick={() => onSelectUser?.(u, "identity")} style={{ fontSize: 12 }}>
            {u.full_name || u.email} → {byId.get(Number(u.primary_manager_user_id))?.full_name || u.primary_manager_name || "?"}
          </button>
        ))}
      </div>
    </div>
  );
}

const scrollWrapStyle = {
  width: "100%",
  maxWidth: "100%",
  overflowX: "auto",
  overflowY: "hidden",
  WebkitOverflowScrolling: "touch",
  padding: 24,
  boxSizing: "border-box",
  border: "1px solid #edf1f7",
  borderRadius: 16,
  background: "#fbfcff",
};

function PersonCard({
  user,
  selected,
  onSelect,
  tone = "internal",
  subtitle = null,
  footer = null,
}) {
  const { accessV2 } = useContext(OrgChartOptions);
  const inactive = user.is_active === false;
  const palette =
    tone === "partner"
      ? {
          border: selected ? "#d97706" : "#f3d2a0",
          bg: selected ? "linear-gradient(180deg, #fff7ed 0%, #ffffff 100%)" : "#fff",
          shadow: selected ? "0 14px 28px rgba(217, 119, 6, 0.18)" : "0 10px 22px rgba(15, 23, 42, 0.06)",
          accent: "#b45309",
        }
      : {
          border: selected ? "#1f5eff" : "#d7dfed",
          bg: selected ? "linear-gradient(180deg, #eef4ff 0%, #ffffff 100%)" : "#fff",
          shadow: selected ? "0 14px 28px rgba(31, 94, 255, 0.16)" : "0 10px 22px rgba(15, 23, 42, 0.06)",
          accent: "#1f5eff",
        };

  return (
    <div
      className="org-chart-card"
      style={{
        boxSizing: "border-box",
        display: "block",
        width: 200,
        minWidth: 200,
        maxWidth: 200,
        borderRadius: "14px 22px 14px 14px",
        border: `2px solid ${palette.border}`,
        background: inactive ? "#f8fafc" : palette.bg,
        boxShadow: palette.shadow,
        padding: "12px 14px",
        opacity: inactive ? 0.72 : 1,
        textAlign: "left",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect?.(user)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect?.(user);
          }
        }}
        style={{ cursor: "pointer" }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              flexShrink: 0,
              background: tone === "partner" ? "rgba(217, 119, 6, 0.14)" : "rgba(31, 94, 255, 0.12)",
              color: palette.accent,
              display: "grid",
              placeItems: "center",
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {String(user.full_name || user.email || "?")
              .trim()
              .slice(0, 1)
              .toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", lineHeight: 1.3, wordBreak: "break-word" }}>
              {user.full_name || user.email || `User #${user.id}`}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: "#334155", fontWeight: 700, wordBreak: "break-word" }}>
              {user.role_name || user.group_name || "No role"}
            </div>
            <div style={{ marginTop: 4, fontSize: 10, color: "#64748b", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {subtitle ||
                user.department_name ||
                user.department_key ||
                user.designation ||
                user.group_name ||
                "Unassigned"}
            </div>
          </div>
        </div>
        {inactive ? (
          <div style={{ marginTop: 8, fontSize: 10, fontWeight: 800, color: "#b45309", textTransform: "uppercase" }}>Inactive</div>
        ) : null}
      </div>
      {accessV2 && user.secondary_manager_user_id ? (
        <div
          title="Secondary (dotted-line) manager"
          style={{ marginTop: 8, fontSize: 11, color: "#475569", borderTop: "1px dashed #94a3b8", paddingTop: 6, wordBreak: "break-word" }}
        >
          ┄ also reports to {user.secondary_manager_name || `#${user.secondary_manager_user_id}`}
        </div>
      ) : null}
      {accessV2 ? (
        <button
          type="button"
          className="org-chart-no-print"
          onClick={(event) => {
            event.stopPropagation();
            onSelect?.(user, "access");
          }}
          style={{ marginTop: 8, fontSize: 11, padding: "2px 8px" }}
        >
          Access
        </button>
      ) : null}
      {footer}
    </div>
  );
}

function OrgNode({
  user,
  childrenByManager,
  selectedUserId,
  onSelectUser,
  ancestors,
  depth = 0,
  tone = "internal",
  partnersByOwnerId = null,
  onJumpPartner = null,
  verticalBranch = false,
}) {
  const id = Number(user.id);
  const kids = childrenByManager.get(id) || [];
  const selected = Number(selectedUserId) === id;
  const cycle = ancestors.has(id);
  const useVertical = kids.length >= VERTICAL_CHILD_THRESHOLD || (depth >= 1 && kids.length >= 2);
  const ownedPartners = partnersByOwnerId?.get(id) || [];

  return (
    <div
      className="org-chart-node"
      role="treeitem"
      style={{
        margin: 0,
        padding: verticalBranch ? "0 0 0 12px" : 0,
        display: "inline-flex",
        flexDirection: "column",
        alignItems: useVertical ? "flex-start" : "center",
        verticalAlign: "top",
        whiteSpace: "normal",
        flex: "0 0 auto",
        position: verticalBranch ? "relative" : undefined,
      }}
    >
      {verticalBranch ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: -16,
            top: 22,
            width: 16,
            height: 2,
            background: "#93c5fd",
          }}
        />
      ) : null}
      <PersonCard
        user={user}
        selected={selected}
        onSelect={onSelectUser}
        tone={tone}
        footer={
          ownedPartners.length ? (
            <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#b45309" }}>
                Channel partners ({ownedPartners.length})
              </div>
              {ownedPartners.slice(0, 4).map((partner) => (
                <button
                  key={partner.key}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onJumpPartner?.(partner.key);
                  }}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    borderRadius: 10,
                    border: "1px dashed #f0b45a",
                    background: "#fff7ed",
                    padding: "6px 8px",
                    fontSize: 11,
                    color: "#9a3412",
                    fontWeight: 700,
                  }}
                >
                  {partner.label}
                </button>
              ))}
              {ownedPartners.length > 4 ? (
                <div style={{ fontSize: 11, color: "#9a3412" }}>+{ownedPartners.length - 4} more</div>
              ) : null}
            </div>
          ) : null
        }
      />

      {!cycle && kids.length ? (
        useVertical ? (
          <div
            role="group"
            style={{
              margin: "14px 0 0 28px",
              padding: "0 0 0 16px",
              borderLeft: "2px solid #93c5fd",
              display: "grid",
              gap: 12,
              minWidth: "max-content",
            }}
          >
            {kids.map((child) => (
              <OrgNode
                key={child.id}
                user={child}
                childrenByManager={childrenByManager}
                selectedUserId={selectedUserId}
                onSelectUser={onSelectUser}
                ancestors={new Set([...ancestors, id])}
                depth={depth + 1}
                tone={tone}
                partnersByOwnerId={partnersByOwnerId}
                onJumpPartner={onJumpPartner}
                verticalBranch
              />
            ))}
          </div>
        ) : (
          <div
            className="org-chart-children"
            role="group"
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
              gap: 18,
              margin: "18px 0 0",
              padding: "18px 0 0",
              position: "relative",
              borderTop: "2px solid #93c5fd",
              minWidth: "max-content",
              width: "max-content",
            }}
          >
            {kids.map((child) => (
              <OrgNode
                key={child.id}
                user={child}
                childrenByManager={childrenByManager}
                selectedUserId={selectedUserId}
                onSelectUser={onSelectUser}
                ancestors={new Set([...ancestors, id])}
                depth={depth + 1}
                tone={tone}
                partnersByOwnerId={partnersByOwnerId}
                onJumpPartner={onJumpPartner}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function TreeCanvas({ roots, childrenByManager, selectedUserId, onSelectUser, emptyNote, tone = "internal", partnersByOwnerId = null, onJumpPartner = null }) {
  if (!roots?.length) {
    return (
      <div style={{ padding: 18, borderRadius: 16, border: "1px dashed #cbd5e1", color: "#64748b", background: "#fff" }}>
        {emptyNote}
      </div>
    );
  }

  return (
    <div className="org-chart-scroll" style={scrollWrapStyle}>
      <div
        role="tree"
        style={{
          display: "flex",
          gap: 28,
          justifyContent: "flex-start",
          alignItems: "flex-start",
          margin: 0,
          padding: 0,
          minWidth: "max-content",
          width: "max-content",
          whiteSpace: "nowrap",
        }}
      >
        {roots.map((root) => (
          <OrgNode
            key={root.id}
            user={root}
            childrenByManager={childrenByManager}
            selectedUserId={selectedUserId}
            onSelectUser={onSelectUser}
            ancestors={new Set()}
            depth={0}
            tone={tone}
            partnersByOwnerId={partnersByOwnerId}
            onJumpPartner={onJumpPartner}
          />
        ))}
      </div>
    </div>
  );
}

function safeDomId(key) {
  return `partner-org-${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function ModeChip({ active, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        borderRadius: 999,
        border: active ? "1px solid #96b5ff" : "1px solid #dfe5ef",
        background: active ? "#eef4ff" : "#fff",
        fontWeight: 700,
        padding: "8px 14px",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

/**
 * Hybrid org chart:
 * - Internal Absstem tree (horizontal top, vertical spurs for dense teams)
 * - Partner mini-trees with Absstem sales-owner assignment
 */
export default function OrgChart({
  users = [],
  selectedUserId = null,
  onSelectUser = null,
  includeInactive = false,
  hideLonelyRoots = true,
  emptyNote = "No users available for the org chart.",
  accessV2 = false,
}) {
  const [mode, setMode] = useState("both"); // both | internal | partners
  const [focusPartnerKey, setFocusPartnerKey] = useState(null);

  const visibleUsers = useMemo(() => {
    const list = Array.isArray(users) ? users : [];
    return includeInactive ? list : list.filter((user) => user?.is_active !== false);
  }, [users, includeInactive]);

  const usersById = useMemo(() => {
    const map = new Map();
    for (const user of visibleUsers) map.set(Number(user.id), user);
    return map;
  }, [visibleUsers]);

  const { internalUsers, partnerGroups, partnersByOwnerId } = useMemo(() => {
    const internal = [];
    const partners = [];
    for (const user of visibleUsers) {
      if (isDistributorUser(user)) partners.push(user);
      else internal.push(user);
    }

    const byOrg = new Map();
    for (const user of partners) {
      const key = partnerOrgKey(user);
      if (!byOrg.has(key)) byOrg.set(key, []);
      byOrg.get(key).push(user);
    }

    const groups = Array.from(byOrg.entries())
      .map(([key, orgUsers]) => {
        const forest = buildOrgForest(orgUsers, { hideLonelyRoots: false });
        const principal =
          forest.roots.find((row) => (forest.childrenByManager.get(Number(row.id)) || []).length > 0) ||
          forest.roots[0] ||
          orgUsers[0];
        const ownerId = Number(principal?.primary_manager_user_id);
        const salesOwner = Number.isFinite(ownerId) && ownerId > 0 ? usersById.get(ownerId) || null : null;
        return {
          key,
          label: partnerOrgLabel(orgUsers),
          users: orgUsers,
          forest,
          principal,
          salesOwner,
          ownerId: Number.isFinite(ownerId) && ownerId > 0 ? ownerId : null,
        };
      })
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));

    const byOwner = new Map();
    for (const group of groups) {
      if (!group.ownerId) continue;
      if (!byOwner.has(group.ownerId)) byOwner.set(group.ownerId, []);
      byOwner.get(group.ownerId).push(group);
    }

    return { internalUsers: internal, partnerGroups: groups, partnersByOwnerId: byOwner };
  }, [visibleUsers, usersById]);

  const internalForest = useMemo(
    () => buildOrgForest(internalUsers, { hideLonelyRoots }),
    [internalUsers, hideLonelyRoots]
  );

  function handlePrint() {
    window.print();
  }

  function jumpToPartner(key) {
    setMode((prev) => (prev === "internal" ? "both" : prev));
    setFocusPartnerKey(key);
    window.requestAnimationFrame(() => {
      const el = document.getElementById(safeDomId(key));
      el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });
  }

  const showInternal = mode === "both" || mode === "internal";
  const showPartners = mode === "both" || mode === "partners";

  return (
    <OrgChartOptions.Provider value={{ accessV2 }}>
    <div className="org-chart-root" style={{ width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden" }}>
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .org-chart-root, .org-chart-root * { visibility: visible !important; }
          .org-chart-root {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            background: #fff !important;
            overflow: visible !important;
          }
          .org-chart-no-print { display: none !important; }
          .org-chart-scroll { overflow: visible !important; border: none !important; background: transparent !important; }
          .org-chart-card { box-shadow: none !important; break-inside: avoid; }
        }
      `}</style>

      <div
        className="org-chart-no-print"
        style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ModeChip active={mode === "both"} label="Both" onClick={() => setMode("both")} />
          <ModeChip active={mode === "internal"} label="Internal only" onClick={() => setMode("internal")} />
          <ModeChip active={mode === "partners"} label="Partners only" onClick={() => setMode("partners")} />
        </div>
        <button type="button" onClick={handlePrint}>
          Print chart
        </button>
      </div>

      {showInternal ? (
        <section style={{ display: "grid", gap: 10, marginBottom: 22, minWidth: 0 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Absstem</div>
            <h3 style={{ margin: "6px 0 0", fontSize: 18, lineHeight: 1.3 }}>Internal organization</h3>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>
              Dense teams switch to vertical spurs. Sales owners show assigned Channel Partner chips (dashed assignment).
            </p>
          </div>
          {accessV2 ? <LoopWarning users={internalForest.loopUsers} byId={internalForest.byId} onSelectUser={onSelectUser} /> : null}
          <TreeCanvas
            roots={internalForest.roots}
            childrenByManager={internalForest.childrenByManager}
            selectedUserId={selectedUserId}
            onSelectUser={onSelectUser}
            emptyNote={emptyNote}
            tone="internal"
            partnersByOwnerId={partnersByOwnerId}
            onJumpPartner={jumpToPartner}
          />
        </section>
      ) : null}

      {showPartners ? (
        <section style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Channel partners</div>
            <h3 style={{ margin: "6px 0 0", fontSize: 18, lineHeight: 1.3 }}>Channel Partner Organizations</h3>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>
              Each distributor is its own org. The assignment strip shows which Absstem sales employee owns them.
            </p>
          </div>

          {!partnerGroups.length ? (
            <div style={{ padding: 18, borderRadius: 16, border: "1px dashed #cbd5e1", color: "#64748b" }}>
              No distributor organizations in the current directory filter.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
              {partnerGroups.map((group) => {
                const focused = focusPartnerKey === group.key;
                return (
                  <div
                    key={group.key}
                    id={safeDomId(group.key)}
                    style={{
                      border: focused ? "2px solid #f59e0b" : "1px solid #e2e8f0",
                      borderRadius: 18,
                      padding: 14,
                      background: "#fff",
                      minWidth: 0,
                      overflow: "hidden",
                      boxShadow: focused ? "0 0 0 4px rgba(245, 158, 11, 0.15)" : "none",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                      <div>
                        <strong style={{ fontSize: 15 }}>{group.label}</strong>
                        <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
                          {group.users.length} user{group.users.length === 1 ? "" : "s"} · self-contained partner tree
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        marginBottom: 12,
                        borderRadius: 14,
                        border: "1px dashed #f0b45a",
                        background: "#fff7ed",
                        padding: "10px 12px",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#b45309" }}>
                          Assigned Absstem sales owner
                        </div>
                        <div style={{ marginTop: 4, fontSize: 14, fontWeight: 800, color: "#9a3412" }}>
                          {group.salesOwner?.full_name || group.principal?.primary_manager_name || "Unassigned"}
                        </div>
                        <div style={{ marginTop: 2, fontSize: 12, color: "#9a3412" }}>
                          {group.salesOwner
                            ? `${group.salesOwner.role_name || "Sales"} · ${group.salesOwner.department_name || group.salesOwner.department_key || "Sales"}`
                            : "Set Primary Manager on the partner principal to link sales ownership."}
                        </div>
                      </div>
                      {group.salesOwner ? (
                        <button type="button" onClick={() => onSelectUser?.(group.salesOwner)}>
                          Open sales owner
                        </button>
                      ) : null}
                    </div>

                    <TreeCanvas
                      roots={group.forest.roots}
                      childrenByManager={group.forest.childrenByManager}
                      selectedUserId={selectedUserId}
                      onSelectUser={onSelectUser}
                      emptyNote="No hierarchy mapped for this partner yet."
                      tone="partner"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </div>
    </OrgChartOptions.Provider>
  );
}
