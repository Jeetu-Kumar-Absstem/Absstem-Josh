import { useEffect, useRef, useState } from "react";
import "./PressFitLinker.css";

/**
 * Press-Fit Entity Linker — standard micro-interaction for linking records
 * (e.g. Lead → Sales Order). Pipes slide shut; crimp snaps only after `onLink` resolves.
 *
 * @param {object} props
 * @param {string} [props.leftLabel]
 * @param {string} [props.rightLabel]
 * @param {() => Promise<unknown>} [props.onLink] Resolves on successful API link; reject to abort animation.
 * @param {() => Promise<unknown>|void} [props.onUnlink] Optional unlink / reset action.
 * @param {boolean} [props.linked] Controlled linked state (skips open UI when true).
 * @param {boolean} [props.disabled]
 * @param {string} [props.linkLabel="Link Records"]
 * @param {string} [props.linkedLabel="Linked · Crimped"]
 * @param {"primary"|"red"} [props.crimpAccent="primary"] Crimp ring color (brand primary or industrial red).
 * @param {(err: Error) => void} [props.onError]
 * @param {() => void} [props.onLinked] Fired after successful crimp animation starts.
 * @param {string} [props.className]
 */
export default function PressFitLinker({
  leftLabel = "Record A",
  rightLabel = "Record B",
  onLink,
  onUnlink,
  linked = false,
  disabled = false,
  linkLabel = "Link Records",
  linkedLabel = "Linked · Crimped",
  crimpAccent = "primary",
  onError,
  onLinked,
  className = "",
}) {
  /** @type {"open"|"linking"|"mating"|"crimped"} */
  const [phase, setPhase] = useState(linked ? "crimped" : "open");
  const [error, setError] = useState("");
  const timersRef = useRef([]);

  useEffect(() => {
    setPhase((prev) => {
      if (linked) return "crimped";
      if (prev === "linking" || prev === "mating") return prev;
      return "open";
    });
  }, [linked]);

  useEffect(
    () => () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  function schedule(fn, ms) {
    const id = window.setTimeout(fn, ms);
    timersRef.current.push(id);
    return id;
  }

  async function handleLink() {
    if (disabled || phase !== "open" || typeof onLink !== "function") return;
    setError("");
    setPhase("linking");

    try {
      await onLink();
      setPhase("mating");
      schedule(() => {
        setPhase("crimped");
        if (typeof onLinked === "function") onLinked();
      }, 280);
    } catch (err) {
      setPhase("open");
      const message = err?.message || "Link failed";
      setError(message);
      if (typeof onError === "function") onError(err instanceof Error ? err : new Error(message));
    }
  }

  async function handleUnlink() {
    if (disabled) return;
    setError("");
    try {
      if (typeof onUnlink === "function") await onUnlink();
      setPhase("open");
    } catch (err) {
      const message = err?.message || "Unlink failed";
      setError(message);
      if (typeof onError === "function") onError(err instanceof Error ? err : new Error(message));
    }
  }

  const isBusy = phase === "linking" || phase === "mating";
  const isCrimped = phase === "crimped";
  const rootClass = [
    "pfl",
    crimpAccent === "red" ? "pfl--accent-red" : "",
    phase === "mating" ? "pfl--mating" : "",
    isCrimped ? "pfl--crimped pfl--linked" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  let buttonText = linkLabel;
  if (phase === "linking") buttonText = "Linking…";
  else if (phase === "mating") buttonText = "Mating…";
  else if (isCrimped) buttonText = linkedLabel;

  return (
    <div className={rootClass} aria-live="polite">
      <div className="pfl__stage">
        <div className="pfl__entity pfl__entity--left">
          <span className="pfl__flange" aria-hidden="true" />
          <span className="pfl__pipe" aria-hidden="true" />
          <span className="pfl__label" title={leftLabel}>
            {leftLabel}
          </span>
        </div>
        <div className="pfl__joint" aria-hidden="true">
          <span className="pfl__gap" />
          <span className="pfl__crimp" />
        </div>
        <div className="pfl__entity pfl__entity--right">
          <span className="pfl__pipe" aria-hidden="true" />
          <span className="pfl__flange" aria-hidden="true" />
          <span className="pfl__label" title={rightLabel}>
            {rightLabel}
          </span>
        </div>
      </div>

      <div className="pfl__actions">
        <button
          type="button"
          className="pfl__btn"
          onClick={handleLink}
          disabled={disabled || isBusy || isCrimped || typeof onLink !== "function"}
        >
          {buttonText}
        </button>
        {isCrimped && typeof onUnlink === "function" ? (
          <button type="button" className="pfl__btn pfl__btn--ghost" onClick={handleUnlink} disabled={disabled}>
            Unlink
          </button>
        ) : null}
        {error ? <span className="pfl__status pfl__status--error">{error}</span> : null}
        {isCrimped && !error ? <span className="pfl__status pfl__status--ok">Joint locked</span> : null}
      </div>
    </div>
  );
}
