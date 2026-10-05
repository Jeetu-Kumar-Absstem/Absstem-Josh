import { useEffect } from "react";

/**
 * Reusable slide-over shell for queue context, quick edits, and nested document trails.
 * Keeps the underlying list/page mounted so Back is not required to restore filters.
 */
export default function SlideOverDrawer({
  open,
  onClose,
  title,
  subtitle = null,
  eyebrow = "Quick desk",
  nextAction = null,
  width = 560,
  children = null,
  footer = null,
}) {
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.42)",
        backdropFilter: "blur(2px)",
        zIndex: 9998,
        display: "flex",
        justifyContent: "flex-end",
      }}
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Detail drawer"}
        style={{
          width: "100%",
          maxWidth: width,
          height: "100%",
          backgroundColor: "#ffffff",
          boxShadow: "-12px 0 36px rgba(15, 23, 42, 0.16)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderLeft: "1px solid #e2e8f0",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            padding: "18px 22px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            background: "#f8fafc",
          }}
        >
          <div style={{ minWidth: 0 }}>
            {eyebrow ? (
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {eyebrow}
              </div>
            ) : null}
            <h3 style={{ margin: "4px 0 0", fontSize: 18, color: "#0f172a", lineHeight: 1.25 }}>{title || "Detail"}</h3>
            {subtitle ? <div style={{ marginTop: 6, fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>{subtitle}</div> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            style={{
              background: "#f1f5f9",
              border: "none",
              borderRadius: "50%",
              width: 32,
              height: 32,
              cursor: "pointer",
              fontSize: 14,
              color: "#64748b",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {nextAction ? (
          <div
            style={{
              margin: "14px 22px 0",
              padding: 14,
              borderRadius: 12,
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
            }}
          >
            <div style={{ fontSize: 11, color: "#1e40af", fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              Guided next action
            </div>
            <div style={{ marginTop: 6, fontSize: 14, color: "#1e3a8a", fontWeight: 700 }}>{nextAction.title || nextAction}</div>
            {nextAction.note ? <div style={{ marginTop: 4, fontSize: 12, color: "#334155", lineHeight: 1.5 }}>{nextAction.note}</div> : null}
            {nextAction.action ? <div style={{ marginTop: 10 }}>{nextAction.action}</div> : null}
          </div>
        ) : null}

        <div style={{ padding: "18px 22px", flex: 1, overflowY: "auto" }}>{children}</div>

        {footer ? (
          <div
            style={{
              padding: "14px 22px",
              borderTop: "1px solid #e2e8f0",
              background: "#f8fafc",
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            {footer}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
