export default function BlockerRibbon({ blockers = [] }) {
  const items = Array.isArray(blockers) ? blockers.filter(Boolean) : [];
  if (!items.length) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        marginTop: 12,
      }}
    >
      {items.map((item) => {
        const severity = String(item.severity || "med").toLowerCase();
        const creditMode = String(item.creditMode || item.mode || "").toLowerCase();
        const isHard = severity === "high" || severity === "hard" || creditMode === "hard_block";
        const isSoft = severity === "soft" || creditMode === "soft_block" || item.warn;
        const tone = isHard ? "#fff2f2" : isSoft ? "#fff7ea" : "#fff7ea";
        const border = isHard ? "#fecaca" : "#fde68a";
        const color = isHard ? "#991b1b" : "#92400e";
        const modeLabel =
          creditMode === "hard_block"
            ? "Hard block"
            : creditMode === "soft_block"
              ? "Soft block"
              : creditMode === "warning"
                ? "Warning"
                : null;
        return (
          <div
            key={item.id || item.reason}
            style={{
              flex: "1 1 280px",
              minWidth: 240,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 12,
              border: `1px solid ${border}`,
              background: tone,
              color,
              fontSize: 13,
              lineHeight: 1.45,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 2 }}>
                {item.ownerDesk ? (
                  <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.72 }}>
                    {item.ownerDesk}
                  </div>
                ) : null}
                {modeLabel ? (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      padding: "2px 6px",
                      borderRadius: 999,
                      border: `1px solid ${border}`,
                      background: "#fff",
                    }}
                  >
                    {modeLabel}
                  </span>
                ) : null}
              </div>
              <div style={{ fontWeight: 600 }}>{item.reason}</div>
              {item.explain ? (
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 4 }}>{item.explain}</div>
              ) : null}
            </div>
            {item.ctaLabel && typeof item.onCta === "function" ? (
              <button
                type="button"
                onClick={item.onCta}
                style={{
                  flexShrink: 0,
                  border: `1px solid ${border}`,
                  borderRadius: 8,
                  padding: "6px 10px",
                  background: "#ffffff",
                  color: "#111827",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {item.ctaLabel}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
