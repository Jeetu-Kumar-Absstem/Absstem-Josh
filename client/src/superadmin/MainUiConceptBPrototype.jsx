import { useMemo, useState } from "react";

const ROLE_VIEWS = [
  {
    key: "sales",
    label: "Sales Workspace",
    eyebrow: "Role-based home",
    title: "Commercial control without the KPI wall",
    description: "A focused home for leads, customers, quotes, and sales orders. The user sees only the urgent actions, recent records, and the few modules that matter today.",
    tone: "#2354d5",
    tint: "#eef4ff",
    summary: [
      { label: "Action queue", value: "12", note: "quotes, follow-ups, and issue blocks" },
      { label: "Pinned modules", value: "4", note: "leads, customers, quotes, sales orders" },
      { label: "Recent records", value: "7", note: "resume work instead of searching" },
    ],
    quickActions: ["Create quote", "Open customer", "Resume Q26000017", "Review lead queue"],
    modules: [
      { label: "Leads", caption: "Pipeline review and incoming demand", stat: "18 active", detail: "Follow-up first" },
      { label: "Customers", caption: "Account context and master hydration", stat: "5 recent", detail: "CRM focus" },
      { label: "Quotes", caption: "Revision desk and customer handoff", stat: "19 live", detail: "Primary workspace" },
      { label: "Sales Orders", caption: "Issued quote conversion", stat: "4 pending", detail: "After issue" },
    ],
    queue: [
      { title: "Q26000017 needs package apply", meta: "Draft quote · no line items yet", severity: "amber" },
      { title: "Q26000014 waiting on commercial review", meta: "Discount discussion still open", severity: "blue" },
      { title: "Q26000006 ready for mail handoff", meta: "Issued and customer-facing actions unlocked", severity: "green" },
    ],
    recent: [
      { record: "Q26000017", context: "Absstem Industrial Solutions · draft resumed" },
      { record: "C12085", context: "Absstem Industrial Solutions Pvt. Ltd. · account context" },
      { record: "Lead L2600042", context: "Inbound enquiry ready for quoting" },
    ],
  },
  {
    key: "accounts",
    label: "Accounts Workspace",
    eyebrow: "Role-based home",
    title: "Ageing, billing, and reconciliation in one short surface",
    description: "Accounts users land on open money and pending decisions, not every module in the product. Billing, receipts, AR, and GL become one operating lane.",
    tone: "#14804a",
    tint: "#ecfbf2",
    summary: [
      { label: "Collections due", value: "9", note: "follow-ups and promises due today" },
      { label: "Invoice actions", value: "6", note: "draft, posted, or blocked billing work" },
      { label: "Reconciliation gaps", value: "3", note: "cash allocation and AP/AR checks" },
    ],
    quickActions: ["Open invoices", "Post receipt", "Review AR desk", "Run GL checks"],
    modules: [
      { label: "Invoices", caption: "Billing desk and posting control", stat: "6 active", detail: "Billing lane" },
      { label: "Receipts", caption: "Collections and allocation flow", stat: "4 to allocate", detail: "Cash desk" },
      { label: "AR Desk", caption: "Follow-ups, promises, disputes", stat: "9 overdue", detail: "Ops control" },
      { label: "GL Desk", caption: "Journals and trial balance", stat: "Month open", detail: "Close control" },
    ],
    queue: [
      { title: "2 invoices posted but not allocated", meta: "Receipt desk should lead the morning", severity: "amber" },
      { title: "AR promise overdue for Pepsico", meta: "Escalation follow-up needed", severity: "red" },
      { title: "Trial balance run pending", meta: "GL close checkpoint", severity: "blue" },
    ],
    recent: [
      { record: "INV2600012", context: "Posted today · waiting for receipt match" },
      { record: "RCT2600008", context: "Draft receipt · allocation incomplete" },
      { record: "AR dispute", context: "Repeat dispute flagged for review" },
    ],
  },
  {
    key: "operations",
    label: "Operations Workspace",
    eyebrow: "Role-based home",
    title: "Manufacturing and fulfilment as an action-led desk",
    description: "Production, dispatch, shortages, and readiness get grouped into a single working surface. Scroll falls because only the current execution layer is shown.",
    tone: "#b45309",
    tint: "#fff7eb",
    summary: [
      { label: "Ready to release", value: "5", note: "job and FG readiness visible first" },
      { label: "Blocked supply", value: "2", note: "procurement or shortage blockers" },
      { label: "Dispatch handoff", value: "4", note: "orders ready for movement" },
    ],
    quickActions: ["Open sales desk", "Open job cards", "Open dispatches", "Open stores desk"],
    modules: [
      { label: "Sales Desk", caption: "Quote to invoice handoff control", stat: "4 live buckets", detail: "Commercial to ops" },
      { label: "Job Cards", caption: "Issue, return, and consumption", stat: "7 pending", detail: "Stores execution" },
      { label: "Dispatches", caption: "Shipment and transporter control", stat: "4 ready", detail: "Fulfilment desk" },
      { label: "Manufacturing BOMs", caption: "FG setup and recipe readiness", stat: "2 gaps", detail: "Setup lane" },
    ],
    queue: [
      { title: "FG setup gap blocking release", meta: "Manufacturing BOM review required", severity: "red" },
      { title: "Dispatch-ready order waiting transporter", meta: "DSP handoff visible", severity: "amber" },
      { title: "Stores shortage needs procurement", meta: "Raise requirement before release", severity: "blue" },
    ],
    recent: [
      { record: "JC2600011", context: "Issue pending for field return rework" },
      { record: "DSP2600004", context: "Transporter details awaited" },
      { record: "FG Readiness", context: "Two orders ready for next stage" },
    ],
  },
  {
    key: "superadmin",
    label: "SuperAdmin Workspace",
    eyebrow: "Role-based home",
    title: "Governance, setup, and prototypes without crowding operations",
    description: "Administrative work stays separated from live commercial and operations traffic. The home becomes a launch pad instead of an endless mixed dashboard.",
    tone: "#7c3aed",
    tint: "#f5efff",
    summary: [
      { label: "Admin lanes", value: "4", note: "masters, users, templates, onboarding" },
      { label: "Prototype pages", value: "5", note: "review without touching live modules" },
      { label: "Setup focus", value: "UI-first", note: "less hunting through shell" },
    ],
    quickActions: ["Open admin masters", "Open product master", "Open templates", "Review prototypes"],
    modules: [
      { label: "Admin Masters", caption: "Business controls and pricing masters", stat: "11 master groups", detail: "Governance" },
      { label: "Product Master", caption: "Items, import, and structure", stat: "SKU lane", detail: "Commercial setup" },
      { label: "Templates", caption: "Letterheads, PDFs, and document assets", stat: "Doc control", detail: "Customer-facing assets" },
      { label: "User Master", caption: "People, access, and hierarchy", stat: "Access lane", detail: "Security and org" },
    ],
    queue: [
      { title: "Price type review requested", meta: "Commercial governance remains visible", severity: "blue" },
      { title: "Template asset refresh pending", meta: "Customer-facing output check", severity: "amber" },
      { title: "Prototype review still open", meta: "Main UI concept selection pending", severity: "purple" },
    ],
    recent: [
      { record: "Price Types", context: "Server-backed pricing control now live" },
      { record: "Templates", context: "Scope annexure assets recently updated" },
      { record: "Quotes Prototype", context: "Concept review path still available" },
    ],
  },
];

function SummaryTile({ item, tone }) {
  return (
    <div
      style={{
        border: "1px solid #dfe5f2",
        borderRadius: 18,
        background: "#fff",
        padding: 16,
        boxShadow: "0 16px 34px rgba(19, 32, 56, 0.06)",
      }}
    >
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6d7a95", fontWeight: 800 }}>{item.label}</div>
      <div style={{ marginTop: 8, fontSize: 28, fontWeight: 900, color: tone }}>{item.value}</div>
      <div style={{ marginTop: 8, fontSize: 13, color: "#617089", lineHeight: 1.6 }}>{item.note}</div>
    </div>
  );
}

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

export default function MainUiConceptBPrototype() {
  const [activeRole, setActiveRole] = useState("sales");
  const role = useMemo(() => ROLE_VIEWS.find((item) => item.key === activeRole) || ROLE_VIEWS[0], [activeRole]);

  return (
    <div style={{ padding: 20, color: "#17243c" }}>
      <div
        style={{
          border: "1px solid #dfe5f2",
          borderRadius: 28,
          background: "linear-gradient(135deg, #fafcff 0%, #f4f8ff 56%, #ffffff 100%)",
          padding: 24,
          boxShadow: "0 20px 44px rgba(24, 38, 67, 0.08)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "start", flexWrap: "wrap" }}>
          <div style={{ maxWidth: 780 }}>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 800, color: "#7281a1" }}>Main UI Concept B</div>
            <h1 style={{ margin: "8px 0 10px", fontSize: 32, lineHeight: 1.1 }}>Role-based workspace home with a short, action-led center</h1>
            <div style={{ color: "#5f6d86", lineHeight: 1.65, maxWidth: 720 }}>
              This concept removes the giant scroll wall by showing one role at a time. The center becomes a focused workspace with pinned modules,
              urgent actions, and recent work instead of every KPI block in the product.
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button type="button" style={{ borderRadius: 999, border: "1px solid #cfdaf0", background: "#fff", padding: "9px 13px", fontWeight: 800 }}>
              Prototype only
            </button>
            <button type="button" style={{ borderRadius: 999, border: "1px solid #cfdaf0", background: "#fff", padding: "9px 13px", fontWeight: 800 }}>
              SuperAdmin review
            </button>
            <button type="button" style={{ borderRadius: 999, border: "1px solid #cfdaf0", background: "#fff", padding: "9px 13px", fontWeight: 800 }}>
              No live writes
            </button>
          </div>
        </div>

        <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
          {ROLE_VIEWS.map((item) => {
            const active = item.key === activeRole;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveRole(item.key)}
                style={{
                  borderRadius: 999,
                  border: active ? `1px solid ${item.tone}33` : "1px solid #dbe2f0",
                  background: active ? item.tint : "#fff",
                  color: active ? item.tone : "#54637d",
                  padding: "9px 14px",
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 }}>
        {role.summary.map((item) => (
          <SummaryTile key={item.label} item={item} tone={role.tone} />
        ))}
      </div>

      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "minmax(240px, 0.8fr) minmax(520px, 1.35fr) minmax(300px, 0.95fr)", gap: 16, alignItems: "start" }}>
        <section
          style={{
            border: "1px solid #dfe5f2",
            borderRadius: 22,
            background: "#fff",
            padding: 18,
            boxShadow: "0 16px 34px rgba(19, 32, 56, 0.05)",
          }}
        >
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>{role.eyebrow}</div>
          <h2 style={{ margin: "10px 0 10px", fontSize: 24, lineHeight: 1.2 }}>{role.title}</h2>
          <div style={{ color: "#60708a", lineHeight: 1.6 }}>{role.description}</div>

          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Quick actions</div>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              {role.quickActions.map((action) => (
                <button
                  key={action}
                  type="button"
                  style={{
                    textAlign: "left",
                    border: "1px solid #e0e6f2",
                    borderRadius: 16,
                    padding: "12px 14px",
                    background: "#fbfcff",
                    fontWeight: 700,
                    color: "#22324e",
                    cursor: "pointer",
                  }}
                >
                  {action}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section
          style={{
            border: "1px solid #dfe5f2",
            borderRadius: 22,
            background: "#fff",
            padding: 18,
            boxShadow: "0 16px 34px rgba(19, 32, 56, 0.05)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Pinned modules</div>
              <h2 style={{ margin: "10px 0 0", fontSize: 24 }}>Only the desks this role should see first</h2>
            </div>
            <span
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                background: role.tint,
                color: role.tone,
                fontWeight: 800,
                fontSize: 12,
              }}
            >
              {role.label}
            </span>
          </div>

          <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
            {role.modules.map((module) => (
              <button
                key={module.label}
                type="button"
                style={{
                  textAlign: "left",
                  border: "1px solid #e0e6f2",
                  borderRadius: 20,
                  background: "linear-gradient(180deg, #ffffff 0%, #f9fbff 100%)",
                  padding: 16,
                  cursor: "pointer",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 900, color: "#1c2c47" }}>{module.label}</div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: role.tone }}>{module.stat}</div>
                </div>
                <div style={{ color: "#5f6f88", lineHeight: 1.55 }}>{module.caption}</div>
                <div style={{ fontSize: 12, color: "#7b889f", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>{module.detail}</div>
              </button>
            ))}
          </div>
        </section>

        <div style={{ display: "grid", gap: 16 }}>
          <section
            style={{
              border: "1px solid #dfe5f2",
              borderRadius: 22,
              background: "#fff",
              padding: 18,
              boxShadow: "0 16px 34px rgba(19, 32, 56, 0.05)",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Action queue</div>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              {role.queue.map((item) => (
                <div key={item.title} style={{ border: "1px solid #e3e8f2", borderRadius: 18, padding: 14, background: "#fbfcff" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
                    <div style={{ paddingTop: 4 }}>
                      <StatusDot severity={item.severity} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 800, color: "#22324e" }}>{item.title}</div>
                      <div style={{ marginTop: 6, color: "#5e6d87", lineHeight: 1.55 }}>{item.meta}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section
            style={{
              border: "1px solid #dfe5f2",
              borderRadius: 22,
              background: "#fff",
              padding: 18,
              boxShadow: "0 16px 34px rgba(19, 32, 56, 0.05)",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#73819c", fontWeight: 800 }}>Recent work</div>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              {role.recent.map((item) => (
                <div key={item.record} style={{ borderBottom: "1px solid #edf1f7", paddingBottom: 12 }}>
                  <div style={{ fontWeight: 800, color: "#22324e" }}>{item.record}</div>
                  <div style={{ marginTop: 5, color: "#617089", lineHeight: 1.55 }}>{item.context}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
