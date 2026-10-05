import { useEffect, useState } from "react";
import { apiFetch, daysUntilDate, formatAmount, statusColor, statusTone, toDateInputValue } from "./quoteShared";

export const QUOTE_WORKSPACE_STAGES = [
  { key: "build", label: "Build", hint: "Customer, offer, commercials, deliver" },
  { key: "govern", label: "Govern", hint: "Approvals, revisions, delivery, closure" },
];

function WorkspaceChip({ label, value, tone = "rgba(255,255,255,0.14)", color = "#fff" }) {
  if (!label) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 999,
        background: tone,
        color,
        border: "1px solid rgba(255,255,255,0.2)",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.01em",
      }}
    >
      <span style={{ opacity: 0.72, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
      <span>{value}</span>
    </span>
  );
}

export default function QuoteWorkspace({
  quoteId,
  stage = "build",
  stages = QUOTE_WORKSPACE_STAGES,
  onStageChange,
  onBackToList,
  refreshKey = 0,
  children,
}) {
  const [header, setHeader] = useState(null);

  useEffect(() => {
    const id = Number(quoteId);
    if (!Number.isFinite(id) || id <= 0) {
      setHeader(null);
      return;
    }
    let active = true;
    apiFetch(`/quotes/${id}`)
      .then((data) => {
        if (!active) return;
        setHeader({
          quote: data?.quote || null,
          revision: data?.revision || null,
          sales_order: data?.sales_order || null,
        });
      })
      .catch(() => {
        if (active) setHeader(null);
      });
    return () => {
      active = false;
    };
  }, [quoteId, stage, refreshKey]);

  const quote = header?.quote || null;
  const revision = header?.revision || null;
  const status = String(quote?.quote_status || revision?.revision_status || "draft");
  const validDays = daysUntilDate(quote?.quote_valid_till);
  const validityLabel = quote?.quote_valid_till
    ? validDays === null
      ? toDateInputValue(quote.quote_valid_till)
      : validDays < 0
        ? `Expired ${Math.abs(validDays)}d ago`
        : validDays === 0
          ? "Expires today"
          : `${validDays}d left`
    : "Not set";

  return (
    <div style={{ maxWidth: 1460 }}>
      <div
        style={{
          borderRadius: 22,
          padding: 18,
          background:
            "radial-gradient(circle at top left, rgba(111,147,255,0.22), transparent 45%), linear-gradient(135deg, #112a5c 0%, #1d4ca8 52%, #7ba1ff 130%)",
          color: "#fff",
          boxShadow: "0 24px 48px rgba(18,41,88,0.12)",
        }}
      >
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 11, letterSpacing: "0.09em", textTransform: "uppercase", opacity: 0.76 }}>Quote workspace</div>
            <div style={{ marginTop: 8, fontSize: 26, fontWeight: 800, lineHeight: 1.12 }}>
              {quote?.quote_number || (quoteId ? `Quote #${quoteId}` : "New quote")}
            </div>
            <div style={{ marginTop: 6, fontSize: 13, opacity: 0.86, lineHeight: 1.6 }}>
              {quote?.customer_name || "Customer not selected yet"}
              {quote?.customer_site_name ? ` • ${quote.customer_site_name}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span
              style={{
                padding: "7px 12px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: "0.04em",
                textTransform: "capitalize",
                background: statusTone(status),
                color: statusColor(status),
                border: "1px solid rgba(255,255,255,0.24)",
              }}
            >
              {status.replaceAll("_", " ")}
            </span>
            {onBackToList ? (
              <button
                type="button"
                onClick={onBackToList}
                style={{
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.28)",
                  background: "rgba(255,255,255,0.12)",
                  color: "#fff",
                  padding: "8px 14px",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Back to queue
              </button>
            ) : null}
          </div>
        </div>

        <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <WorkspaceChip label="Revision" value={revision?.revision_no || "—"} />
          <WorkspaceChip label="Kind" value={quote?.quote_kind === "budgetary" ? "Budgetary" : "Firm"} />
          <WorkspaceChip
            label="Validity"
            value={validityLabel}
            tone={validDays !== null && validDays < 0 ? "rgba(255,120,120,0.22)" : "rgba(255,255,255,0.14)"}
          />
          <WorkspaceChip label="Follow-up" value={quote?.next_follow_up_at ? toDateInputValue(quote.next_follow_up_at) : "Not set"} />
          <WorkspaceChip
            label="Lead time"
            value={
              revision?.delivery_lead_time_days === null || revision?.delivery_lead_time_days === undefined
                ? "Not set"
                : `${revision.delivery_lead_time_days}d`
            }
          />
          <WorkspaceChip
            label="Warranty"
            value={
              revision?.warranty_months === null || revision?.warranty_months === undefined
                ? "Not set"
                : `${revision.warranty_months} mo`
            }
          />
          <WorkspaceChip label="Sent" value={quote?.first_sent_at ? toDateInputValue(quote.first_sent_at) : "Not sent"} />
          {quote?.customer_po_ref ? <WorkspaceChip label="Customer PO" value={quote.customer_po_ref} /> : null}
          <WorkspaceChip label="Value" value={formatAmount(revision?.grand_total_quote)} />
          {header?.sales_order?.so_number ? <WorkspaceChip label="Sales order" value={header.sales_order.so_number} /> : null}
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
          {stages.map((item) => {
            const active = item.key === stage;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => (active ? null : onStageChange?.(item.key))}
                style={{
                  textAlign: "left",
                  borderRadius: 16,
                  border: active ? "1px solid rgba(255,255,255,0.6)" : "1px solid rgba(255,255,255,0.2)",
                  background: active ? "rgba(255,255,255,0.96)" : "rgba(255,255,255,0.1)",
                  color: active ? "#12275a" : "#fff",
                  padding: "10px 14px",
                  cursor: active ? "default" : "pointer",
                  minWidth: 190,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 800 }}>{item.label}</div>
                <div style={{ marginTop: 3, fontSize: 11, opacity: active ? 0.66 : 0.8, lineHeight: 1.5 }}>{item.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>{children}</div>
    </div>
  );
}
