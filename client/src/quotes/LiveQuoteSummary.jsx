import {
  CustomerChip,
  SidebarKeyValueRow,
  SidebarMetricCard,
} from "./quoteBuilderUi";
import { calcLineNetTotal, toNumber } from "./quoteBuilderHelpers";

export default function LiveQuoteSummary({ api }) {
  const {
    checklistItems,
    grandTotal = 0,
    lifecycleBadge,
    mailBootstrap,
    pricingSnapshotCards = [],
    primaryFlowAction,
    quote,
    readiness,
    recommendedNextAction,
    reviewConfiguratorContext,
    reviewConfiguratorWarnings = [],
    selectedCustomer,
    selectedGroupNames = [],
    setStep,
    sidebarCommercialRows = [],
    steps,
    subtotal = 0,
    taxTotal = 0,
    topLineItemsPreview = [],
  } = api || {};

  const badge = lifecycleBadge || {
    label: "Ready",
    background: "#f2fbf5",
    border: "1px solid #cfe7d6",
    color: "#0b6b38",
  };
  const nextAction = recommendedNextAction || {
    title: "Continue",
    body: "Keep working through the quote steps.",
    step: 0,
    ctaLabel: "Go to step",
  };
  const flowAction = primaryFlowAction || {
    label: "Continue",
    tone: "#eef4ff",
    color: "#2354d5",
    borderColor: "rgba(35,84,213,0.14)",
  };
  const blockers = readiness?.blockers || [];
  const warnings = readiness?.warnings || [];

  return (
    <div className="builder-sidebar" style={{ position: "sticky", top: 16 }}>
      <div
        style={{
          border: "1px solid rgba(201,214,240,0.8)",
          borderRadius: 22,
          padding: 16,
          background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(247,250,255,0.98) 100%)",
          boxShadow: "0 24px 48px rgba(18,41,88,0.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            borderRadius: 18,
            padding: 16,
            background:
              "radial-gradient(circle at top left, rgba(111,147,255,0.22), transparent 45%), linear-gradient(135deg, #112a5c 0%, #1d4ca8 52%, #7ba1ff 130%)",
            color: "#fff",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: "0.09em", textTransform: "uppercase", opacity: 0.78 }}>Builder Summary</div>
              <div style={{ marginTop: 8, fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>
                {quote?.quote_number || "Draft quote in progress"}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6, opacity: 0.84 }}>
                {quote?.customer_name || selectedCustomer?.customer_name || "Customer not selected yet"}
              </div>
            </div>
            <div
              style={{
                alignSelf: "start",
                padding: "7px 10px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: "0.04em",
                background: "rgba(255,255,255,0.14)",
                border: "1px solid rgba(255,255,255,0.2)",
                backdropFilter: "blur(10px)",
              }}
            >
              {badge.label}
            </div>
          </div>
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {pricingSnapshotCards.map((card) => (
              <SidebarMetricCard key={card.label} label={card.label} value={card.value} note={card.note} accent={card.accent} />
            ))}
          </div>
        </div>

        <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
            Recommended next action
          </div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{nextAction.title}</div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.78, lineHeight: 1.7 }}>{nextAction.body}</div>
          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <CustomerChip
              label={flowAction.label}
              tone={flowAction.tone}
              color={flowAction.color}
              borderColor={flowAction.borderColor}
            />
            <button type="button" onClick={() => setStep?.(nextAction.step)}>
              {nextAction.ctaLabel || `Go to ${steps?.[nextAction.step]?.label || "step"}`}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 10 }}>
            Quote checklist
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {(checklistItems || []).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setStep?.(item.step)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: 10,
                  alignItems: "start",
                  textAlign: "left",
                  padding: 12,
                  borderRadius: 14,
                  background: item.done
                    ? "linear-gradient(180deg, #f6fcf8 0%, #ffffff 100%)"
                    : "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
                  borderColor: item.done ? "#d7eadf" : "rgba(214,224,244,0.92)",
                }}
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    display: "grid",
                    placeItems: "center",
                    marginTop: 1,
                    background: item.done ? "#0b6b38" : "#e9eef8",
                    color: item.done ? "#fff" : "#5a6781",
                    fontSize: 12,
                    fontWeight: 800,
                  }}
                >
                  {item.done ? "✓" : item.step + 1}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800 }}>{item.label}</div>
                  <div style={{ marginTop: 4, fontSize: 11, opacity: 0.74, lineHeight: 1.6 }}>{item.detail}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
            Commercial frame
          </div>
          <div>
            {sidebarCommercialRows.map((row, index) => (
              <div key={row.label} style={{ borderBottom: index === sidebarCommercialRows.length - 1 ? "none" : undefined }}>
                <SidebarKeyValueRow label={row.label} value={row.value} emphasis={row.label === "Quote currency"} />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(223,229,241,0.78)" }}>
            <SidebarKeyValueRow label="Subtotal" value={Number(subtotal).toFixed(2)} />
            <SidebarKeyValueRow label="GST" value={Number(taxTotal).toFixed(2)} />
            <div style={{ borderBottom: "none" }}>
              <SidebarKeyValueRow label="Grand total" value={Number(grandTotal).toFixed(2)} emphasis />
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 10 }}>
            Quote readiness
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <CustomerChip
              label={blockers.length ? `${blockers.length} blocker(s)` : "Issue-ready"}
              tone={blockers.length ? "#fff1f1" : "#f2fbf5"}
              color={blockers.length ? "#9f3f3f" : "#0b6b38"}
              borderColor={blockers.length ? "rgba(243,199,199,0.95)" : "rgba(207,231,214,0.95)"}
            />
            <CustomerChip
              label={warnings.length ? `${warnings.length} warning(s)` : "No warnings"}
              tone={warnings.length ? "#fff9ee" : "#f5f7fb"}
              color={warnings.length ? "#8a6708" : "#53627d"}
              borderColor={warnings.length ? "rgba(234,215,161,0.95)" : "rgba(229,234,243,0.95)"}
            />
            <CustomerChip
              label={mailBootstrap?.mail_source?.effective_sender?.connected ? "Mail sender ready" : "Mail sender missing"}
              tone={mailBootstrap?.mail_source?.effective_sender?.connected ? "#f2fbf5" : "#fff1f1"}
              color={mailBootstrap?.mail_source?.effective_sender?.connected ? "#0b6b38" : "#9f3f3f"}
              borderColor={
                mailBootstrap?.mail_source?.effective_sender?.connected
                  ? "rgba(207,231,214,0.95)"
                  : "rgba(243,199,199,0.95)"
              }
            />
          </div>
          <div style={{ marginTop: 10, padding: "12px 12px 0", borderTop: "1px solid rgba(223,229,241,0.78)" }}>
            <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58, marginBottom: 6 }}>
              Current next step
            </div>
            <div style={{ fontSize: 14, fontWeight: 800 }}>{flowAction.label}</div>
            <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7, opacity: 0.78 }}>{nextAction.body}</div>
          </div>
          {blockers.length || warnings.length ? (
            <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7, opacity: 0.74 }}>
              {blockers.length
                ? "Resolve blockers before issue so the PDF, approval, and mail handoff stay aligned."
                : "Builder is issue-ready, but the warning review is still worth a final scan."}
            </div>
          ) : null}
        </div>

        {reviewConfiguratorContext?.family_key ? (
          <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
            <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
              Configurator route
            </div>
            <SidebarKeyValueRow
              label="Family"
              value={reviewConfiguratorContext.family_label || reviewConfiguratorContext.family_name || "—"}
            />
            <SidebarKeyValueRow label="Variant" value={reviewConfiguratorContext.variant_label || "—"} />
            <SidebarKeyValueRow label="Route" value={reviewConfiguratorContext.presentation_company_code || "—"} />
            <div style={{ borderBottom: "none" }}>
              <SidebarKeyValueRow label="Profile" value={reviewConfiguratorContext.proposal_profile_key || "—"} />
            </div>
            {reviewConfiguratorWarnings.length ? (
              <div
                style={{
                  marginTop: 10,
                  border: "1px solid #f2e3b2",
                  background: "linear-gradient(180deg, #fffaf0 0%, #fffef8 100%)",
                  borderRadius: 12,
                  padding: "10px 12px",
                  fontSize: 12,
                  lineHeight: 1.65,
                }}
              >
                {reviewConfiguratorWarnings.join(" ")}
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 10 }}>
            Top line items
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {topLineItemsPreview.map((line) => (
              <div
                key={line.key}
                style={{
                  border: "1px solid rgba(225,231,242,0.96)",
                  borderRadius: 14,
                  padding: 12,
                  background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, lineHeight: 1.45 }}>{line.item_name || "Manual Item"}</div>
                    <div style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>{line.item_code || "Uncoded item"}</div>
                  </div>
                  <CustomerChip label={`Qty ${line.qty}`} tone="#f3f7ff" color="#2954aa" borderColor="rgba(138,165,221,0.24)" />
                </div>
                <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, opacity: 0.78 }}>
                  <span>{toNumber(line.unit_price_quote, 0).toFixed(2)} net unit</span>
                  <span>{calcLineNetTotal(line).toFixed(2)} line total</span>
                </div>
              </div>
            ))}
            {!topLineItemsPreview.length ? <div style={{ fontSize: 12, opacity: 0.7 }}>No lines added yet.</div> : null}
          </div>
        </div>

        {selectedGroupNames.length ? (
          <div style={{ marginTop: 14, border: "1px solid rgba(219,227,241,0.9)", borderRadius: 16, padding: 14, background: "rgba(255,255,255,0.84)" }}>
            <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.6, marginBottom: 8 }}>
              Selected items snapshot
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {selectedGroupNames.map((name) => (
                <CustomerChip key={name} label={name} tone="#f5f7fb" color="#46536b" borderColor="rgba(229,234,243,0.95)" />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
