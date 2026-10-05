import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

let toastPush = null;

export function toast(message, tone = "info") {
  if (typeof toastPush === "function") toastPush({ id: `${Date.now()}-${Math.random()}`, message, tone });
}

const ToastContext = createContext({ push: () => {} });

export function ToastHost({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((item) => {
    setItems((current) => [...current.slice(-4), item]);
  }, []);

  useEffect(() => {
    toastPush = push;
    return () => {
      if (toastPush === push) toastPush = null;
    };
  }, [push]);

  useEffect(() => {
    if (!items.length) return undefined;
    const timers = items.map((item) =>
      setTimeout(() => {
        setItems((current) => current.filter((row) => row.id !== item.id));
      }, 4200)
    );
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [items]);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          right: 18,
          bottom: 18,
          zIndex: 10050,
          display: "grid",
          gap: 10,
          width: "min(360px, calc(100vw - 32px))",
        }}
      >
        {items.map((item) => {
          const tones = {
            error: { color: "#9f2042", background: "#fff2f3", border: "#ffd0d6" },
            success: { color: "#0b7d45", background: "#effcf3", border: "#c8efd6" },
            warning: { color: "#8b5a00", background: "#fff6e8", border: "#f2dfb0" },
            info: { color: "#234a8f", background: "#eef4ff", border: "#d9e6ff" },
          };
          const style = tones[item.tone] || tones.info;
          return (
            <div
              key={item.id}
              style={{
                color: style.color,
                background: style.background,
                border: `1px solid ${style.border}`,
                borderRadius: 14,
                padding: "12px 14px",
                boxShadow: "0 16px 36px rgba(17, 32, 56, 0.14)",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {item.message}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function EmptyState({ title, body, action }) {
  return (
    <div
      style={{
        border: "1px dashed #d5deea",
        borderRadius: 18,
        padding: "28px 22px",
        background: "rgba(255,255,255,0.78)",
        textAlign: "center",
      }}
    >
      <div style={{ fontWeight: 800, fontSize: 16, color: "#17304d" }}>{title || "Nothing here yet"}</div>
      {body ? <div style={{ marginTop: 8, fontSize: 13, opacity: 0.68, lineHeight: 1.6 }}>{body}</div> : null}
      {action ? <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>{action}</div> : null}
    </div>
  );
}

/**
 * Prevents double-submit races across financial saves.
 * Use distinct keys per action (e.g. "save", "post", "create-po").
 */
export function useSubmitLock() {
  const [busyKey, setBusyKey] = useState(null);
  const busyRef = useRef(null);

  const runLocked = useCallback(async (key, fn) => {
    const lockKey = key || "default";
    if (busyRef.current) return { ok: false, skipped: true };
    busyRef.current = lockKey;
    setBusyKey(lockKey);
    try {
      const result = await fn();
      return { ok: true, result };
    } finally {
      busyRef.current = null;
      setBusyKey(null);
    }
  }, []);

  const isBusy = useCallback((key) => {
    if (!key) return Boolean(busyKey);
    return busyKey === key;
  }, [busyKey]);

  return {
    busyKey,
    busy: Boolean(busyKey),
    isBusy,
    runLocked,
  };
}

export function DeskCard({ title, subtitle, actions, children }) {
  return (
    <div
      style={{
        border: "1px solid #e0e6f0",
        borderRadius: 22,
        padding: 16,
        background: "#ffffff",
        boxShadow: "0 12px 30px rgba(17, 32, 56, 0.05)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 13, opacity: 0.68, marginTop: 4 }}>{subtitle}</div> : null}
        </div>
        {actions || null}
      </div>
      {children}
    </div>
  );
}

export function DeskStat({ label, value, tone, hint = "" }) {
  return (
    <div className="desk-stat" title={hint || undefined}>
      <div className="desk-stat-label">{label}</div>
      <div className="desk-stat-value" style={{ color: tone }}>{value}</div>
      {hint ? <div className="desk-stat-hint">{hint}</div> : null}
    </div>
  );
}

export function MiniMetric({ label, value }) {
  return (
    <div style={{ border: "1px solid #edf1f6", borderRadius: 12, padding: 10, background: "#ffffff" }}>
      <div style={{ fontSize: 11, opacity: 0.62 }}>{label}</div>
      <div style={{ fontWeight: 800, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export function DeskChip({ label, tone, color }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        background: tone,
        color,
        padding: "6px 10px",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {label}
    </span>
  );
}

export function PageHero({ eyebrow, title, description, actions, stats, maxWidth = 760 }) {
  return (
    <div
      style={{
        border: "1px solid #dde5f1",
        borderRadius: 24,
        padding: 20,
        background: "linear-gradient(135deg, #f7fafc 0%, #ffffff 42%, #eef4ff 100%)",
        boxShadow: "0 20px 45px rgba(28, 45, 74, 0.08)",
      }}
    >
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          {eyebrow ? (
            <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.56, marginBottom: 8 }}>
              {eyebrow}
            </div>
          ) : null}
          <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>{title}</h2>
          {description ? (
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth, lineHeight: 1.7 }}>
              {description}
            </div>
          ) : null}
        </div>
        {actions ? <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{actions}</div> : null}
      </div>
      {Array.isArray(stats) && stats.length ? (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(stats.length, 4)}, minmax(140px, 1fr))`, gap: 12, marginTop: 18 }}>
          {stats.map((stat) => (
            <DeskStat key={stat.label} label={stat.label} value={stat.value} tone={stat.tone} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DeskTopStrip({ title, actions, metrics = [] }) {
  return (
    <div
      style={{
        border: "1px solid #dde5f1",
        borderRadius: 22,
        padding: 16,
        background: "#fbfcff",
        boxShadow: "0 12px 30px rgba(17, 32, 56, 0.05)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 24, lineHeight: 1.1, fontWeight: 900, color: "#17304d" }}>{title}</div>
        </div>
        {actions ? <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>{actions}</div> : null}
      </div>
      {Array.isArray(metrics) && metrics.length ? (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(metrics.length, 4)}, minmax(150px, 1fr))`, gap: 12, marginTop: 14 }}>
          {metrics.map((metric) => {
            const content = (
              <>
                <div style={{ fontSize: 11, opacity: 0.66 }}>{metric.label}</div>
                <div style={{ fontSize: 24, fontWeight: 900, marginTop: 6, color: metric.tone || "#234a8f" }}>{metric.value}</div>
                {metric.note ? <div style={{ fontSize: 12, opacity: 0.66, marginTop: 6 }}>{metric.note}</div> : null}
              </>
            );

            if (typeof metric.onClick === "function") {
              return (
                <button
                  key={metric.label}
                  type="button"
                  onClick={metric.onClick}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    borderRadius: 18,
                    padding: 14,
                    background: "#ffffff",
                    border: "1px solid #e6ebf2",
                    boxShadow: "0 8px 22px rgba(17, 32, 56, 0.05)",
                  }}
                >
                  {content}
                </button>
              );
            }

            return (
              <div
                key={metric.label}
                style={{
                  borderRadius: 18,
                  padding: 14,
                  background: "#ffffff",
                  border: "1px solid #e6ebf2",
                  boxShadow: "0 8px 22px rgba(17, 32, 56, 0.05)",
                }}
              >
                {content}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function NoticeBanner({ tone = "info", message }) {
  if (!message) return null;
  const tones = {
    error: { color: "#b00020", background: "#fff3f3", border: "#ffd8d8" },
    success: { color: "#0a7a35", background: "#f2fff6", border: "#d6f4df" },
    warning: { color: "#8b5a00", background: "#fff9ec", border: "#f2dfb0" },
    info: { color: "#234a8f", background: "#eef4ff", border: "#d9e6ff" },
  };
  const style = tones[tone] || tones.info;
  return (
    <div
      style={{
        color: style.color,
        marginTop: 12,
        padding: "12px 14px",
        borderRadius: 14,
        background: style.background,
        border: `1px solid ${style.border}`,
      }}
    >
      {message}
    </div>
  );
}

export function FieldLabel({ label, children, style }) {
  return (
    <label style={{ display: "grid", gap: 6, fontSize: 12, ...style }}>
      <span style={{ opacity: 0.72 }}>{label}</span>
      {children}
    </label>
  );
}

export function getDeskStatusAppearance(status, config = {}) {
  const s = String(status || "").toLowerCase();
  const success = Array.isArray(config.success) ? config.success : [];
  const info = Array.isArray(config.info) ? config.info : [];
  const danger = Array.isArray(config.danger) ? config.danger : [];
  const warning = Array.isArray(config.warning) ? config.warning : [];
  const match = (keywords) => keywords.some((item) => s.includes(String(item).toLowerCase()));

  if (match(success)) return { tone: "#effcf3", color: "#0b7d45" };
  if (match(info)) return { tone: "#eef4ff", color: "#234a8f" };
  if (match(danger)) return { tone: "#fff2f3", color: "#9f2042" };
  if (match(warning)) return { tone: "#fff6e8", color: "#8b5a00" };

  return {
    tone: config.fallbackTone || "#f6f7fb",
    color: config.fallbackColor || "#58627a",
  };
}

export function BoolStatusChip({ active, activeLabel = "Active", inactiveLabel = "Inactive" }) {
  return (
    <DeskChip
      label={active ? activeLabel : inactiveLabel}
      tone={active ? "#effcf3" : "#f5f6fa"}
      color={active ? "#0b7d45" : "#5d6782"}
    />
  );
}

export function HeaderChip({ label, tone = "#234a8f", background = "rgba(31, 94, 255, 0.1)" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 800,
        color: tone,
        background,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

/** Short process hint under the desk hero — keeps pilot scope explicit. */
export function DeskPilotBanner({ title, body, tone = "info", actions = null }) {
  if (!title && !body) return null;
  const tones = {
    info: { color: "#234a8f", background: "linear-gradient(90deg, #eef4ff 0%, #f8fbff 100%)", border: "#c7d7ff" },
    warning: { color: "#8b5a00", background: "linear-gradient(90deg, #fff9ec 0%, #fffdf8 100%)", border: "#f2dfb0" },
    success: { color: "#0a7a35", background: "linear-gradient(90deg, #f2fff6 0%, #f8fffb 100%)", border: "#d6f4df" },
  };
  const style = tones[tone] || tones.info;
  return (
    <div
      style={{
        border: `1px solid ${style.border}`,
        background: style.background,
        borderRadius: 14,
        padding: "12px 16px",
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        alignItems: "center",
        color: style.color,
      }}
    >
      <div>
        {title ? <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 800 }}>{title}</div> : null}
        {body ? <div style={{ fontSize: 13, marginTop: title ? 4 : 0, lineHeight: 1.55, opacity: 0.92 }}>{body}</div> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div> : null}
    </div>
  );
}

export function DeskFocusCard({ title, note, tone = "#1f5eff", active = false, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: typeof onClick === "function" ? "pointer" : "default",
        border: active ? `1px solid ${tone}` : "1px solid #e3e8f2",
        borderLeft: `4px solid ${tone}`,
        borderRadius: 14,
        padding: "12px 14px",
        background: active ? `${tone}12` : "#fbfcff",
        display: "grid",
        gap: 4,
        boxSizing: "border-box",
      }}
    >
      <strong style={{ fontSize: 14, color: tone }}>{title}</strong>
      {note ? <span style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.5 }}>{note}</span> : null}
    </button>
  );
}

export function DeskReviewItem({ title, body, tone = "#234a8f", background = "#eef4ff", border = "#d9e6ff" }) {
  return (
    <div style={{ border: `1px solid ${border}`, background, borderRadius: 14, padding: 12 }}>
      <strong style={{ color: tone, fontSize: 13 }}>{title}</strong>
      {body ? <div style={{ fontSize: 12, opacity: 0.82, marginTop: 4, lineHeight: 1.55 }}>{body}</div> : null}
    </div>
  );
}

/** Shared Fix now + Review rail layout used across Admin / Mfg / Eng desks. */
export function DeskActionRails({ fixTitle = "Fix now", fixSubtitle, fixItems = [], reviewTitle = "Review rail", reviewSubtitle, reviewItems = [], emptyReview = null }) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 16, alignItems: "start" }}>
      <DeskCard title={fixTitle} subtitle={fixSubtitle || "Jump to the lane most likely to block work next."}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {fixItems.length ? fixItems.map((item) => <DeskFocusCard key={item.key || item.title} {...item} />) : <EmptyState title="No urgent blockers" body="Current scan looks clear." />}
        </div>
      </DeskCard>
      <DeskCard title={reviewTitle} subtitle={reviewSubtitle || "Scan risk before opening an editor."}>
        <div style={{ display: "grid", gap: 10 }}>
          {reviewItems.length ? reviewItems.map((item) => <DeskReviewItem key={item.key || item.title} {...item} />) : emptyReview || <EmptyState title="Baseline looks healthy" body="No review items right now." />}
        </div>
      </DeskCard>
    </section>
  );
}

const LAST_DESK_FIX_KEY = "josh-last-desk-fix-v1";

export function loadLastDeskFix() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_DESK_FIX_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLastDeskFix(value) {
  if (typeof window === "undefined") return;
  try {
    if (!value) {
      window.localStorage.removeItem(LAST_DESK_FIX_KEY);
      return;
    }
    window.localStorage.setItem(
      LAST_DESK_FIX_KEY,
      JSON.stringify({
        ...value,
        saved_at: new Date().toISOString(),
      })
    );
  } catch {
  }
}

export function clearLastDeskFix() {
  saveLastDeskFix(null);
}

export { default as PressFitLinker } from "../components/PressFitLinker";
export { default as ValveLockToggle } from "../components/ValveLockToggle";
