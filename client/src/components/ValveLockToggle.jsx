import { useState } from "react";
import "./ValveLockToggle.css";

/**
 * Quarter-turn valve lock — mechanical open/locked toggle for governance gates.
 *
 * @param {object} props
 * @param {boolean} [props.locked=false] When true, valve is OPEN · LOCKED (approved)
 * @param {(nextLocked: boolean) => void|Promise<void>} [props.onChange]
 * @param {boolean} [props.disabled]
 * @param {string} [props.lockedLabel="OPEN · LOCKED"]
 * @param {string} [props.unlockedLabel="CLOSED"]
 * @param {string} [props.lockedHint="Master BOM frozen — stem latched"]
 * @param {string} [props.unlockedHint="Draft / editable — isolation open for edit"]
 * @param {string} [props.className]
 */
export default function ValveLockToggle({
  locked = false,
  onChange,
  disabled = false,
  lockedLabel = "OPEN · LOCKED",
  unlockedLabel = "CLOSED",
  lockedHint = "Master BOM frozen — stem latched",
  unlockedHint = "Draft / editable — isolation open for edit",
  className = "",
}) {
  const [turning, setTurning] = useState(false);

  async function toggle() {
    if (disabled || turning) return;
    setTurning(true);
    try {
      await new Promise((r) => window.setTimeout(r, 280));
      if (typeof onChange === "function") await onChange(!locked);
    } finally {
      setTurning(false);
    }
  }

  const root = ["vlt", locked ? "vlt--locked" : "", turning ? "vlt--turning" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={root}
      onClick={toggle}
      disabled={disabled || turning}
      aria-pressed={locked}
      aria-label={locked ? "Valve locked / master frozen" : "Valve closed / editable"}
    >
      <span className="vlt__body" aria-hidden="true">
        <span className="vlt__flange vlt__flange--l" />
        <span className="vlt__bore" />
        <span className="vlt__flange vlt__flange--r" />
        <span className={`vlt__stem ${locked ? "vlt__stem--locked" : ""}`}>
          <span className="vlt__wheel">
            <span className="vlt__spoke" />
            <span className="vlt__spoke" />
            <span className="vlt__hub" />
          </span>
        </span>
      </span>
      <span className="vlt__meta">
        <strong>{locked ? lockedLabel : unlockedLabel}</strong>
        <small>{locked ? lockedHint : unlockedHint}</small>
      </span>
    </button>
  );
}
