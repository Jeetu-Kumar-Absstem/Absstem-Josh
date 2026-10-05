import { useEffect, useMemo, useState } from "react";

/**
 * Irreversible admin actions: require typing an exact phrase before Confirm enables.
 */
export default function TypedConfirmModal({
  open,
  title = "Confirm irreversible action",
  message = null,
  confirmPhrase = "CONFIRM",
  inputLabel = null,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  danger = true,
  onCancel,
  onConfirm,
}) {
  const [typed, setTyped] = useState("");
  const phrase = String(confirmPhrase || "CONFIRM").trim();
  const matched = useMemo(() => typed.trim() === phrase, [typed, phrase]);

  useEffect(() => {
    if (!open) return undefined;
    setTyped("");
    function onKeyDown(event) {
      if (event.key === "Escape" && !busy) onCancel?.();
    }
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, busy, onCancel]);

  if (!open) return null;

  const accent = danger ? "#b91c1c" : "#1d4ed8";

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 12000,
        background: "rgba(15, 23, 42, 0.55)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
      onClick={() => {
        if (!busy) onCancel?.();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="typed-confirm-title"
        style={{
          width: "min(480px, 100%)",
          background: "#fff",
          borderRadius: 16,
          border: "1px solid #dbe3f0",
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.28)",
          padding: 20,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div id="typed-confirm-title" style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>
          {title}
        </div>
        {message ? (
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.55, color: "#475569" }}>{message}</div>
        ) : null}
        <div style={{ marginTop: 14, fontSize: 12, color: "#64748b" }}>
          {inputLabel || (
            <>
              Type <code style={{ fontWeight: 700, color: accent }}>{phrase}</code> to continue
            </>
          )}
        </div>
        <input
          autoFocus
          value={typed}
          disabled={busy}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matched && !busy) onConfirm?.(typed.trim());
          }}
          placeholder={phrase}
          style={{
            marginTop: 8,
            width: "100%",
            boxSizing: "border-box",
            border: `1px solid ${matched ? "#86efac" : "#cbd5e1"}`,
            borderRadius: 10,
            padding: "10px 12px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 14,
          }}
        />
        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" disabled={busy} onClick={() => onCancel?.()}>
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={!matched || busy}
            onClick={() => onConfirm?.(typed.trim())}
            style={{
              background: matched && !busy ? accent : "#94a3b8",
              color: "#fff",
              border: "none",
              borderRadius: 10,
              padding: "8px 14px",
              fontWeight: 700,
              cursor: matched && !busy ? "pointer" : "not-allowed",
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
