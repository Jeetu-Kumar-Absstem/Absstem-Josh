import { useMemo, useState } from "react";

const HYBRID_ROLES = [
  {
    key: "sales",
    label: "Sales",
    tone: "#2354d5",
    tint: "#eef4ff",
    title: "Sales operating center",
    description: "Role-based home in the middle, but with a persistent action rail for blockers, approvals, and handoff pressure. This keeps scroll low without losing urgency.",
    summary: [
      { label: "Pinned desks", value: "4", note: "leads, customers, quotes, sales orders" },
      { label: "Urgent actions", value: "5", note: "quotes needing issue, discount, or mail handoff" },
      { label: "Resumable work", value: "7", note: "recent records kept visible" },
    ],
    quickActions: ["Create quote", "Resume Q26000017", "Open customers", "Review lead queue"],
    modules: [
      { label: "Leads", caption: "Pipeline review and demand intake", stat: "18 active", detail: "Start work here" },
      { label: "Customers", caption: "Hydrate or create account context", stat: "5 recent", detail: "Master-linked" },
      { label: "Quotes", caption: "Revision, PDF, and commercial control", stat: "19 live", detail: "Primary desk" },
      { label: "Sales Orders", caption: "Conversion after issue", stat: "4 pending", detail: "Downstream handoff" },
    ],
    recent: [
      { record: "Q26000017", context: "Absstem Industrial Solutions · draft still missing package apply" },
      { record: "Q26000014", context: "ISGEC Heavy Engineering Limited · commercial review open" },
      { record: "Lead L2600042", context: "Inbound review complete · ready for quoting" },
    ],
    rail: {
      now: [
        { title: "Q26000017 blocked on line creation", meta: "Apply configurator package before issue", severity: "amber" },
        { title: "Q26000014 needs final discount sign-off", meta: "Commercial review should stay visible", severity: "blue" },
      ],
      signals: [
        { label: "Approval queue", value: "2 pending" },
        { label: "Mail unlocked", value: "1 quote" },
        { label: "Issue-ready", value: "5 quotes" },
      ],
      escalations: ["Draft quote with no valid line", "Discount review above threshold", "Customer handoff waiting on issue"],
    },
  },
  {
    key: "finance",
    label: "Finance",
    tone: "#14804a",
    tint: "#ecfbf2",
    title: "Finance operating center",
    description: "Finance sees a calmer short home for invoices, receipts, AR, and GL, while the side rail keeps collections pressure and reconciliation exceptions visible at all times.",
    summary: [
      { label: "Pinned desks", value: "4", note: "invoices, receipts, AR, GL" },
      { label: "Urgent actions", value: "6", note: "collections, allocations, and close checks" },
      { label: "Resumable work", value: "5", note: "recent invoice and receipt flow" },
    ],
    quickActions: ["Open invoices", "Post receipt", "Review AR desk", "Run GL checks"],
    modules: [
      { label: "Invoices", caption: "Billing desk and posting control", stat: "6 active", detail: "Billing lane" },
      { label: "Receipts", caption: "Collections and cash allocation", stat: "4 to allocate", detail: "Cash desk" },
      { label: "AR Desk", caption: "Follow-ups, promises, disputes", stat: "9 overdue", detail: "Pressure desk" },
      { label: "GL Desk", caption: "Close and journal control", stat: "Month open", detail: "Financial close" },
    ],
    recent: [
      { record: "INV2600012", context: "Posted today · receipt match still pending" },
      { record: "RCT2600008", context: "Draft receipt · allocation incomplete" },
      { record: "AR dispute", context: "Repeat dispute needs escalation" },
    ],
    rail: {
      now: [
        { title: "Promise overdue for major customer", meta: "Follow-up due today", severity: "red" },
        { title: "Receipt posted but not allocated", meta: "Cash should move into AR immediately", severity: "amber" },
      ],
      signals: [
        { label: "Overdue follow-ups", value: "9" },
        { label: "Reconciliation gaps", value: "3" },
        { label: "Billing checks", value: "6" },
      ],
      escalations: ["Unapplied cash ageing", "Promise overdue", "Trial balance run pending"],
    },
  },
  {
    key: "operations",
    label: "Operations",
    tone: "#b45309",
    tint: "#fff7eb",
    title: "Operations operating center",
    description: "Operations gets the role-based modules it needs, while shortages, readiness, release blockers, and dispatch pressure stay anchored in a side rail instead of buried in long dashboard grids.",
    summary: [
      { label: "Pinned desks", value: "4", note: "sales desk, job cards, dispatches, manufacturing" },
      { label: "Urgent actions", value: "4", note: "shortages, readiness, release, dispatch" },
      { label: "Resumable work", value: "6", note: "manufacturing and fulfilment context" },
    ],
    quickActions: ["Open sales desk", "Open job cards", "Open dispatches", "Open stores desk"],
    modules: [
      { label: "Sales Desk", caption: "Quote to order to dispatch continuity", stat: "4 live buckets", detail: "Commercial to ops" },
      { label: "Job Cards", caption: "Issue, return, and consumption", stat: "7 pending", detail: "Stores execution" },
      { label: "Dispatches", caption: "Shipment and transporter control", stat: "4 ready", detail: "Fulfilment desk" },
      { label: "Manufacturing BOMs", caption: "FG setup and readiness", stat: "2 gaps", detail: "Setup lane" },
    ],
    recent: [
      { record: "JC2600011", context: "Issue pending for field return rework" },
      { record: "DSP2600004", context: "Transporter details awaited" },
      { record: "FG Readiness", context: "Two orders ready for next stage" },
    ],
    rail: {
      now: [
        { title: "FG setup gap blocking release", meta: "Manufacturing BOM review required", severity: "red" },
        { title: "Stores shortage needs procurement", meta: "Raise requirement before release", severity: "amber" },
      ],
      signals: [
        { label: "Ready release", value: "5" },
        { label: "Dispatch-ready", value: "4" },
        { label: "Blocked supply", value: "2" },
      ],
      escalations: ["Release blocked by setup", "Transporter pending on ready order", "Procurement not raised for shortage"],
    },
  },
  {
    key: "superadmin",
    label: "SuperAdmin",
    tone: "#7c3aed",
    tint: "#f5efff",
    title: "Governance operating center",
    description: "Admin work stays role-based and uncluttered, but the right rail still surfaces prototype review, template risk, and pricing or access governance as live priorities.",
    summary: [
      { label: "Pinned desks", value: "4", note: "masters, product, templates, users" },
      { label: "Urgent actions", value: "3", note: "pricing, templates, prototype review" },
      { label: "Resumable work", value: "5", note: "setup and governance context" },
    ],
    quickActions: ["Open admin masters", "Open product master", "Open templates", "Review prototypes"],
    modules: [
      { label: "Admin Masters", caption: "Business controls and pricing masters", stat: "11 groups", detail: "Governance" },
      { label: "Product Master", caption: "Items, import, and structure", stat: "SKU lane", detail: "Commercial setup" },
      { label: "Templates", caption: "Letterheads, PDFs, and assets", stat: "Doc control", detail: "Customer-facing output" },
      { label: "User Master", caption: "People, access, and hierarchy", stat: "Access lane", detail: "Security and org" },
    ],
    recent: [
      { record: "Price Types", context: "Server-backed pricing control recently updated" },
      { record: "Templates", context: "Scope annexure assets refreshed" },
      { record: "Main UI review", context: "Hybrid direction being evaluated" },
    ],
    rail: {
      now: [
        { title: "Prototype decision still open", meta: "Choose direction before live home conversion", severity: "purple" },
        { title: "Template asset review pending", meta: "Customer-facing outputs need oversight", severity: "amber" },
      ],
      signals: [
        { label: "Prototype pages", value: "6 live" },
        { label: "Template review", value: "2 pending" },
        { label: "Pricing governance", value: "Stable" },
      ],
      escalations: ["Prototype cleanup still pending", "Template asset drift risk", "Access and pricing rule review"],
    },
  },
];

function StatusDot({ severity }) {
  const tones = {
    red: { bg: "#fff0ee", fg: "#b23828" },
    amber: { bg: "#fff6e7", fg: "#9a5a00" },
    blue: { bg: "#eef4ff", fg: "#2354d5" },
    green: { bg: "#e9fbf0", fg: "#0e6a45" },
    purple: { bg: "#f5efff", fg: "#7c3aed" },
  };
  const tone = tones[severity] || tones.blue;
  return (
    <span
      style={{
        display: "inline-flex",
        width: 10,
        height: 10,
        borderRadius: 999,
        background: tone.fg,
        boxShadow: `0 0 0 5px ${tone.bg}`,
      }}
    />
  );
}

function MetricTile({ item, tone }) {
  return (
    <div
      style={{
        border: "1px solid #dde5f4",
        borderRadius: 18,
        background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,251,255,0.98) 100%)",
        padding: 14,
        boxShadow: "0 14px 28px rgba(19, 32, 56, 0.06)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "0 auto auto 0",
          width: 120,
          height: 120,
          background: `radial-gradient(circle at top left, ${tone}22 0%, transparent 72%)`,
          pointerEvents: "none",
        }}
      />
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6e7c99", fontWeight: 800 }}>{item.label}</div>
      <div style={{ marginTop: 6, fontSize: 24, fontWeight: 900, color: tone, lineHeight: 1.05 }}>{item.value}</div>
      <div style={{ marginTop: 6, color: "#60708a", fontSize: 12, lineHeight: 1.45 }}>{item.note}</div>
    </div>
  );
}

export default function MainUiHybridPrototype() {
  const [activeRole, setActiveRole] = useState("sales");
  const role = useMemo(() => HYBRID_ROLES.find((item) => item.key === activeRole) || HYBRID_ROLES[0], [activeRole]);

  return (
    <div
      style={{
        padding: 16,
        color: "#17243c",
        background:
          "radial-gradient(circle at top left, rgba(35,84,213,0.08) 0%, transparent 26%), radial-gradient(circle at top right, rgba(124,58,237,0.08) 0%, transparent 24%), linear-gradient(180deg, #f5f8fd 0%, #eef3fb 100%)",
        minHeight: "100%",
      }}
    >
      <div
        style={{
          border: "1px solid #dbe4f2",
          borderRadius: 28,
          background: `linear-gradient(135deg, ${role.tint} 0%, #f7faff 42%, #ffffff 100%)`,
          padding: 20,
          boxShadow: "0 22px 44px rgba(24, 38, 67, 0.09)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            right: -40,
            top: -52,
            width: 240,
            height: 240,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${role.tone}18 0%, transparent 72%)`,
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: -60,
            bottom: -70,
            width: 220,
            height: 220,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(22,34,58,0.05) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "start", flexWrap: "wrap" }}>
          <div style={{ maxWidth: 840, position: "relative", zIndex: 1 }}>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 800, color: "#7281a1" }}>Main UI Hybrid Prototype</div>
            <h1 style={{ margin: "8px 0 10px", fontSize: 30, lineHeight: 1.04, maxWidth: 700 }}>Role-based operating center with a persistent command rail</h1>
            <div style={{ color: "#5f6d86", lineHeight: 1.58, maxWidth: 720, fontSize: 14 }}>
              This combines Concept B and C intentionally: the center stays calm and role-based, while the right side continuously shows blockers,
              approvals, escalations, and next actions. It is the practical low-scroll structure with a command-center behavior layer.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <span style={{ padding: "6px 10px", borderRadius: 999, background: "#fff", border: "1px solid #dbe3f2", color: role.tone, fontWeight: 800, fontSize: 11 }}>
                Recommended direction
              </span>
              <span style={{ padding: "6px 10px", borderRadius: 999, background: "#fff", border: "1px solid #dbe3f2", color: "#52627d", fontWeight: 800, fontSize: 11 }}>
                Calm center
              </span>
              <span style={{ padding: "6px 10px", borderRadius: 999, background: "#fff", border: "1px solid #dbe3f2", color: "#52627d", fontWeight: 800, fontSize: 11 }}>
                Persistent urgency rail
              </span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end", position: "relative", zIndex: 1 }}>
            <button type="button" style={{ borderRadius: 999, border: "1px solid #cfdaf0", background: "rgba(255,255,255,0.92)", padding: "7px 11px", fontWeight: 800, fontSize: 12 }}>
              Hybrid recommendation
            </button>
            <button type="button" style={{ borderRadius: 999, border: "1px solid #cfdaf0", background: "rgba(255,255,255,0.92)", padding: "7px 11px", fontWeight: 800, fontSize: 12 }}>
              SuperAdmin review
            </button>
            <button type="button" style={{ borderRadius: 999, border: "1px solid #cfdaf0", background: "rgba(255,255,255,0.92)", padding: "7px 11px", fontWeight: 800, fontSize: 12 }}>
              No live writes
            </button>
          </div>
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", position: "relative", zIndex: 1 }}>
          {HYBRID_ROLES.map((item) => {
            const active = item.key === activeRole;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveRole(item.key)}
                style={{
                  borderRadius: 999,
                  border: active ? `1px solid ${item.tone}33` : "1px solid #dbe2f0",
                  background: active ? "#fff" : "rgba(255,255,255,0.72)",
                  color: active ? item.tone : "#55637e",
                  padding: "8px 12px",
                  fontWeight: 800,
                  cursor: "pointer",
                  boxShadow: active ? "0 14px 26px rgba(26, 43, 74, 0.10)" : "none",
                  fontSize: 12,
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        {role.summary.map((item) => (
          <MetricTile key={item.label} item={item} tone={role.tone} />
        ))}
      </div>

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "minmax(220px, 0.78fr) minmax(500px, 1.45fr) minmax(280px, 0.88fr)", gap: 12, alignItems: "start" }}>
        <section
          style={{
            border: "1px solid #dfe5f2",
            borderRadius: 20,
            background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,251,255,0.98) 100%)",
            padding: 14,
            boxShadow: "0 14px 28px rgba(19, 32, 56, 0.05)",
          }}
        >
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Role home</div>
          <h2 style={{ margin: "8px 0 8px", fontSize: 20, lineHeight: 1.18 }}>{role.title}</h2>
          <div style={{ color: "#60708a", lineHeight: 1.5, fontSize: 13 }}>{role.description}</div>

          <div style={{ marginTop: 14, padding: 12, borderRadius: 16, background: `linear-gradient(180deg, ${role.tint} 0%, rgba(255,255,255,0.92) 100%)`, border: "1px solid #e0e7f3" }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Quick actions</div>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {role.quickActions.map((action) => (
                <button
                  key={action}
                  type="button"
                  style={{
                    textAlign: "left",
                    border: "1px solid #e0e6f2",
                    borderRadius: 14,
                    padding: "10px 12px",
                    background: "rgba(255,255,255,0.96)",
                    fontWeight: 700,
                    color: "#22324e",
                    cursor: "pointer",
                    boxShadow: "0 10px 18px rgba(23, 34, 56, 0.04)",
                    fontSize: 13,
                  }}
                >
                  {action}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #edf1f7" }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Recent work</div>
            <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
              {role.recent.map((item) => (
                <div key={item.record} style={{ borderBottom: "1px solid #eef2f8", paddingBottom: 10 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 900, color: "#22324e" }}>{item.record}</div>
                    <span style={{ padding: "4px 8px", borderRadius: 999, background: role.tint, color: role.tone, fontSize: 11, fontWeight: 800 }}>Resume</span>
                  </div>
                  <div style={{ marginTop: 4, color: "#617089", lineHeight: 1.45, fontSize: 13 }}>{item.context}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          style={{
            border: "1px solid #dfe5f2",
            borderRadius: 20,
            background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(249,251,255,0.98) 100%)",
            padding: 14,
            boxShadow: "0 14px 28px rgba(19, 32, 56, 0.05)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Pinned desks</div>
              <h2 style={{ margin: "8px 0 0", fontSize: 20 }}>Short, role-based center canvas</h2>
            </div>
            <span
              style={{
                padding: "5px 8px",
                borderRadius: 999,
                background: role.tint,
                color: role.tone,
                fontWeight: 800,
                fontSize: 11,
              }}
            >
              {role.label}
            </span>
          </div>

          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {role.modules.map((module) => (
              <button
                key={module.label}
                type="button"
                style={{
                  textAlign: "left",
                  border: "1px solid #e0e6f2",
                  borderRadius: 18,
                  background: "linear-gradient(180deg, #ffffff 0%, #f7faff 100%)",
                  padding: 14,
                  cursor: "pointer",
                  display: "grid",
                  gap: 6,
                  boxShadow: "0 10px 18px rgba(18, 29, 52, 0.04)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <div style={{ fontSize: 16, fontWeight: 900, color: "#1c2c47" }}>{module.label}</div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: role.tone, padding: "4px 7px", borderRadius: 999, background: role.tint }}>{module.stat}</div>
                </div>
                <div style={{ color: "#5f6f88", lineHeight: 1.45, fontSize: 13 }}>{module.caption}</div>
                <div style={{ fontSize: 11, color: "#7b889f", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>{module.detail}</div>
              </button>
            ))}
          </div>
        </section>

        <aside style={{ display: "grid", gap: 12 }}>
          <section
            style={{
              border: "1px solid rgba(18, 28, 48, 0.08)",
              borderRadius: 20,
              background: "linear-gradient(180deg, #152543 0%, #1e345d 100%)",
              color: "#fff",
              padding: 14,
              boxShadow: "0 18px 36px rgba(13, 22, 40, 0.16)",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "rgba(255,255,255,0.62)", fontWeight: 800 }}>Action rail</div>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              {role.rail.now.map((item) => (
                <div key={item.title} style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 12, background: "rgba(255,255,255,0.08)", backdropFilter: "blur(8px)" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
                    <div style={{ paddingTop: 4 }}>
                      <StatusDot severity={item.severity} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 800, color: "#fff", fontSize: 13, lineHeight: 1.4 }}>{item.title}</div>
                      <div style={{ marginTop: 5, color: "rgba(255,255,255,0.72)", lineHeight: 1.45, fontSize: 12 }}>{item.meta}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section
            style={{
              border: "1px solid #dfe5f2",
              borderRadius: 20,
              background: "#fff",
              padding: 14,
              boxShadow: "0 14px 28px rgba(19, 32, 56, 0.05)",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Signals</div>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              {role.rail.signals.map((item) => (
                <div key={item.label} style={{ border: "1px solid #e2e8f2", borderRadius: 16, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)" }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#7483a0", fontWeight: 800 }}>{item.label}</div>
                  <div style={{ marginTop: 5, fontWeight: 900, color: "#22324e", fontSize: 19 }}>{item.value}</div>
                </div>
              ))}
            </div>
          </section>

          <section
            style={{
              border: "1px solid #dfe5f2",
              borderRadius: 20,
              background: "#fff",
              padding: 14,
              boxShadow: "0 14px 28px rgba(19, 32, 56, 0.05)",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Escalations</div>
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              {role.rail.escalations.map((item) => (
                <div
                  key={item}
                  style={{
                    borderRadius: 14,
                    background: `linear-gradient(180deg, ${role.tint} 0%, #ffffff 100%)`,
                    color: role.tone,
                    padding: "9px 11px",
                    fontWeight: 700,
                    lineHeight: 1.42,
                    border: "1px solid #e0e7f3",
                    fontSize: 12,
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
