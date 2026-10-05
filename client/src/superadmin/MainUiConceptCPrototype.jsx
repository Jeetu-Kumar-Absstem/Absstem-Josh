import { useMemo, useState } from "react";

const COMMAND_STREAMS = [
  {
    key: "commercial",
    label: "Commercial",
    accent: "#2354d5",
    tone: "#eef4ff",
    hero: {
      title: "Commercial mission control",
      summary: "The home becomes a cross-functional command board. Instead of listing every module, it highlights active pressure points, approvals, and next desk transitions.",
      metrics: [
        { label: "Quotes blocked", value: "3" },
        { label: "Issue ready", value: "5" },
        { label: "Mail unlocked", value: "1" },
      ],
    },
    lanes: [
      {
        title: "Now",
        cards: [
          { title: "Q26000017 package still missing", meta: "Apply configurator package before issue", owner: "Sales" },
          { title: "Q26000014 needs final discount sign-off", meta: "Commercial review should stay above the fold", owner: "Manager" },
        ],
      },
      {
        title: "Next",
        cards: [
          { title: "Q26000006 customer mail unlocked", meta: "Open PDF and send customer handoff", owner: "Commercial desk" },
          { title: "Sales order conversion window", meta: "Issued quote can move downstream", owner: "Sales ops" },
        ],
      },
      {
        title: "Watch",
        cards: [
          { title: "Approval queue low but visible", meta: "Keep submitted commercial items in side rail", owner: "Approvals" },
        ],
      },
    ],
    rail: [
      { label: "Primary desk", value: "Quotes" },
      { label: "Current focus", value: "Issue + handoff" },
      { label: "Escalation", value: "Discount and line validity" },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    accent: "#b45309",
    tone: "#fff7eb",
    hero: {
      title: "Operations command shell",
      summary: "Release, production, dispatch, and shortages appear as one operating story. The shell is built for sequence, not browsing.",
      metrics: [
        { label: "Ready release", value: "5" },
        { label: "Dispatch ready", value: "4" },
        { label: "Blocked supply", value: "2" },
      ],
    },
    lanes: [
      {
        title: "Now",
        cards: [
          { title: "FG setup gap blocking release", meta: "Manufacturing BOM fix required first", owner: "Manufacturing" },
          { title: "Stores shortage not raised", meta: "Procurement handoff missing", owner: "Stores" },
        ],
      },
      {
        title: "Next",
        cards: [
          { title: "Dispatch-ready order needs transporter", meta: "Fulfilment lane visible in one click", owner: "Dispatch" },
          { title: "Ready qty can move to SO linkage", meta: "Commercial to operations continuity", owner: "Sales desk" },
        ],
      },
      {
        title: "Watch",
        cards: [
          { title: "Release load nearing limit", meta: "Capacity should appear as a side signal, not a full wall", owner: "Capacity" },
        ],
      },
    ],
    rail: [
      { label: "Primary desk", value: "Sales Desk" },
      { label: "Current focus", value: "Readiness + shortages" },
      { label: "Escalation", value: "Setup and material blockers" },
    ],
  },
  {
    key: "finance",
    label: "Finance",
    accent: "#14804a",
    tone: "#ecfbf2",
    hero: {
      title: "Finance control shell",
      summary: "Receivables, collections, GL, and AP should feel like a treasury board, not another long launcher screen.",
      metrics: [
        { label: "Overdue follow-ups", value: "9" },
        { label: "Reconciliation gaps", value: "3" },
        { label: "Billing checks", value: "6" },
      ],
    },
    lanes: [
      {
        title: "Now",
        cards: [
          { title: "Receipt posted but not allocated", meta: "Cash should land in AR flow immediately", owner: "Receipts" },
          { title: "Promise overdue for major customer", meta: "Action board should push the next follow-up", owner: "AR desk" },
        ],
      },
      {
        title: "Next",
        cards: [
          { title: "Trial balance run pending", meta: "GL checkpoint promoted into center canvas", owner: "GL desk" },
          { title: "Invoice posted with pending payment readiness", meta: "Billing to collection path stays visible", owner: "Invoices" },
        ],
      },
      {
        title: "Watch",
        cards: [
          { title: "Dispute ageing climbing", meta: "Exception-led rail prevents finance blind spots", owner: "AR disputes" },
        ],
      },
    ],
    rail: [
      { label: "Primary desk", value: "AR Desk" },
      { label: "Current focus", value: "Collections + reconciliation" },
      { label: "Escalation", value: "Promise ageing and unapplied cash" },
    ],
  },
];

const GLOBAL_SIGNAL_CARDS = [
  { label: "Approvals awaiting action", value: "4", note: "kept in a persistent side rail" },
  { label: "Pinned desks", value: "6", note: "fast jump without long scroll" },
  { label: "Context switches", value: "Low", note: "one shell, many lanes" },
];

export default function MainUiConceptCPrototype() {
  const [activeStream, setActiveStream] = useState("commercial");
  const stream = useMemo(() => COMMAND_STREAMS.find((item) => item.key === activeStream) || COMMAND_STREAMS[0], [activeStream]);

  return (
    <div style={{ padding: 20, color: "#17243c" }}>
      <div
        style={{
          border: "1px solid #d8e0f0",
          borderRadius: 28,
          background: "linear-gradient(135deg, #0f1f45 0%, #173777 48%, #20314f 100%)",
          color: "#fff",
          padding: 24,
          boxShadow: "0 26px 60px rgba(14, 24, 46, 0.28)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "start", flexWrap: "wrap" }}>
          <div style={{ maxWidth: 800 }}>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 800, opacity: 0.72 }}>Main UI Concept C</div>
            <h1 style={{ margin: "8px 0 10px", fontSize: 32, lineHeight: 1.08 }}>Command-center shell with a live action board and persistent rail</h1>
            <div style={{ color: "rgba(255,255,255,0.78)", lineHeight: 1.65, maxWidth: 760 }}>
              This is the stronger redesign option. The home stops behaving like a catalogue and becomes an operational command deck: one selected stream,
              one action board, and one side rail for signals, approvals, and shortcuts.
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button type="button" style={{ borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.08)", color: "#fff", padding: "9px 13px", fontWeight: 800 }}>
              Prototype only
            </button>
            <button type="button" style={{ borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.08)", color: "#fff", padding: "9px 13px", fontWeight: 800 }}>
              Radical redesign
            </button>
            <button type="button" style={{ borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.08)", color: "#fff", padding: "9px 13px", fontWeight: 800 }}>
              No live writes
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "240px minmax(560px, 1.45fr) minmax(280px, 0.9fr)", gap: 16, alignItems: "start" }}>
        <aside
          style={{
            border: "1px solid #dfe5f2",
            borderRadius: 24,
            background: "#fff",
            padding: 18,
            boxShadow: "0 18px 40px rgba(18, 30, 53, 0.06)",
            position: "sticky",
            top: 20,
          }}
        >
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#7281a1", fontWeight: 800 }}>Mission control</div>
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {COMMAND_STREAMS.map((item) => {
              const active = item.key === activeStream;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveStream(item.key)}
                  style={{
                    textAlign: "left",
                    border: active ? `1px solid ${item.accent}33` : "1px solid #dfe5f2",
                    borderRadius: 18,
                    background: active ? item.tone : "#fbfcff",
                    padding: 14,
                    cursor: "pointer",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ fontWeight: 900, color: active ? item.accent : "#22324e" }}>{item.label}</div>
                  <div style={{ fontSize: 12, color: "#65758f", lineHeight: 1.5 }}>{item.hero.title}</div>
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #ebeff6" }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#7281a1", fontWeight: 800 }}>Pinned jumps</div>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              {["Open Quotes", "Open Sales Desk", "Open AR Desk", "Open Templates"].map((item) => (
                <button
                  key={item}
                  type="button"
                  style={{
                    textAlign: "left",
                    border: "1px solid #e2e8f2",
                    borderRadius: 14,
                    background: "#fff",
                    padding: "11px 12px",
                    fontWeight: 700,
                    color: "#22324e",
                    cursor: "pointer",
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main style={{ display: "grid", gap: 16 }}>
          <section
            style={{
              border: "1px solid #dfe5f2",
              borderRadius: 24,
              background: "#fff",
              padding: 18,
              boxShadow: "0 18px 40px rgba(18, 30, 53, 0.06)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "start", flexWrap: "wrap" }}>
              <div style={{ maxWidth: 720 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#7281a1", fontWeight: 800 }}>Active stream</div>
                <h2 style={{ margin: "10px 0 10px", fontSize: 28, lineHeight: 1.1 }}>{stream.hero.title}</h2>
                <div style={{ color: "#60708a", lineHeight: 1.65 }}>{stream.hero.summary}</div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {stream.hero.metrics.map((item) => (
                  <div
                    key={item.label}
                    style={{
                      minWidth: 120,
                      border: `1px solid ${stream.accent}22`,
                      borderRadius: 18,
                      background: stream.tone,
                      padding: "12px 14px",
                    }}
                  >
                    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6e7d99", fontWeight: 800 }}>{item.label}</div>
                    <div style={{ marginTop: 6, fontSize: 24, fontWeight: 900, color: stream.accent }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section
            style={{
              border: "1px solid #dfe5f2",
              borderRadius: 24,
              background: "#fff",
              padding: 18,
              boxShadow: "0 18px 40px rgba(18, 30, 53, 0.06)",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#7281a1", fontWeight: 800 }}>Action board</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14, marginTop: 12 }}>
              {stream.lanes.map((lane) => (
                <div
                  key={lane.title}
                  style={{
                    borderRadius: 20,
                    background: "linear-gradient(180deg, #fbfcff 0%, #f6f8fc 100%)",
                    border: "1px solid #e1e7f2",
                    padding: 14,
                  }}
                >
                  <div
                    style={{
                      display: "inline-flex",
                      padding: "5px 10px",
                      borderRadius: 999,
                      background: stream.tone,
                      color: stream.accent,
                      fontSize: 12,
                      fontWeight: 900,
                    }}
                  >
                    {lane.title}
                  </div>
                  <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                    {lane.cards.map((card) => (
                      <button
                        key={card.title}
                        type="button"
                        style={{
                          textAlign: "left",
                          border: "1px solid #dfe5f2",
                          borderRadius: 18,
                          background: "#fff",
                          padding: 14,
                          cursor: "pointer",
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        <div style={{ fontWeight: 900, color: "#22324e", lineHeight: 1.4 }}>{card.title}</div>
                        <div style={{ color: "#60708a", lineHeight: 1.55 }}>{card.meta}</div>
                        <div style={{ fontSize: 12, color: stream.accent, fontWeight: 800 }}>{card.owner}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </main>

        <aside style={{ display: "grid", gap: 16 }}>
          <section
            style={{
              border: "1px solid #dfe5f2",
              borderRadius: 24,
              background: "#fff",
              padding: 18,
              boxShadow: "0 18px 40px rgba(18, 30, 53, 0.06)",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#7281a1", fontWeight: 800 }}>Persistent rail</div>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              {stream.rail.map((item) => (
                <div key={item.label} style={{ border: "1px solid #e2e8f2", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#7483a0", fontWeight: 800 }}>{item.label}</div>
                  <div style={{ marginTop: 6, fontWeight: 900, color: "#22324e" }}>{item.value}</div>
                </div>
              ))}
            </div>
          </section>

          <section
            style={{
              border: "1px solid #dfe5f2",
              borderRadius: 24,
              background: "#fff",
              padding: 18,
              boxShadow: "0 18px 40px rgba(18, 30, 53, 0.06)",
            }}
          >
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#7281a1", fontWeight: 800 }}>Global signals</div>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              {GLOBAL_SIGNAL_CARDS.map((item) => (
                <div key={item.label} style={{ border: "1px solid #e2e8f2", borderRadius: 16, padding: 14, background: "#fff" }}>
                  <div style={{ fontSize: 12, color: "#70809b", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 800 }}>{item.label}</div>
                  <div style={{ marginTop: 8, fontSize: 26, fontWeight: 900, color: "#1f3a6d" }}>{item.value}</div>
                  <div style={{ marginTop: 8, color: "#60708a", lineHeight: 1.55 }}>{item.note}</div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
