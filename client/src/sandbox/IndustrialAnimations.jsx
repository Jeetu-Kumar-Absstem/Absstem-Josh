import { useEffect, useRef, useState } from "react";
import PressFitLinker from "../components/PressFitLinker";
import "./IndustrialAnimations.css";

function DualBedLoader() {
  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">PSA adsorber metaphor</div>
      <h3 className="ia-card__title">Dual-Bed Loader</h3>
      <p className="ia-card__copy">
        Two vertical beds cycle pressure: as Bed A pressurizes from the bottom, Bed B vents. Rhythm mirrors swing adsorption.
      </p>
      <div className="ia-dual" aria-hidden="true">
        <div className="ia-dual__column">
          <span className="ia-dual__label">Bed A</span>
          <div className="ia-dual__shell">
            <div className="ia-dual__fill ia-dual__fill--a" />
            <div className="ia-dual__ports">
              <span />
              <span />
            </div>
          </div>
          <span className="ia-dual__phase ia-dual__phase--a">Pressurize</span>
        </div>
        <div className="ia-dual__manifold" title="Equalization / purge cross-tie">
          <div className="ia-dual__pipe" />
        </div>
        <div className="ia-dual__column">
          <span className="ia-dual__label">Bed B</span>
          <div className="ia-dual__shell">
            <div className="ia-dual__fill ia-dual__fill--b" />
            <div className="ia-dual__ports">
              <span />
              <span />
            </div>
          </div>
          <span className="ia-dual__phase ia-dual__phase--b">Vent / purge</span>
        </div>
      </div>
      <div className="ia-dual__legend">
        <span className="ia-chip">Cycle ~2.4s</span>
        <span className="ia-chip ia-chip--muted">Mechanical, not bounce</span>
      </div>
    </div>
  );
}

function PneumaticSubmitButton() {
  const [state, setState] = useState("idle");

  function handleClick() {
    if (state !== "idle") return;
    setState("firing");
    window.setTimeout(() => setState("locked"), 420);
  }

  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">Pipe-run commit</div>
      <h3 className="ia-card__title">Pneumatic Flow Submit</h3>
      <p className="ia-card__copy">
        Click once. A pressure pulse travels the barrel left → right, then the face snaps to a rigid lock mark — no soft morph.
      </p>
      <div className="ia-pneumatic-row">
        <button
          type="button"
          className={`ia-pneumatic ${state === "firing" ? "ia-pneumatic--firing" : ""} ${
            state === "locked" ? "ia-pneumatic--locked" : ""
          }`}
          onClick={handleClick}
          disabled={state === "firing"}
          aria-live="polite"
        >
          <span className="ia-pneumatic__pulse" aria-hidden="true" />
          <span className="ia-pneumatic__face">
            {state === "locked" ? (
              <span className="ia-pneumatic__lock" aria-label="Locked">
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                  <path
                    d="M5 12.5 L10 17.5 L19 7.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="square"
                    strokeLinejoin="miter"
                  />
                </svg>
              </span>
            ) : (
              <span className="ia-pneumatic__label">Submit &amp; Lock</span>
            )}
          </span>
        </button>
        {state === "locked" ? (
          <button type="button" className="ia-reset" onClick={() => setState("idle")}>
            Reset valve
          </button>
        ) : null}
      </div>
      <div className="ia-dual__legend">
        <span className="ia-chip">Status: {state}</span>
      </div>
    </div>
  );
}

function ValveLockToggle() {
  const [open, setOpen] = useState(false);
  const [turning, setTurning] = useState(false);

  function toggle() {
    if (turning) return;
    setTurning(true);
    window.setTimeout(() => {
      setOpen((v) => !v);
      setTurning(false);
    }, 280);
  }

  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">Quarter-turn isolation</div>
      <h3 className="ia-card__title">Valve Lock Toggle</h3>
      <p className="ia-card__copy">
        Not an iOS slider. The handwheel turns a hard 90° into open/locked — brief inertia, then a positive stop.
      </p>
      <button
        type="button"
        className={`ia-valve ${open ? "ia-valve--open" : ""} ${turning ? "ia-valve--turning" : ""}`}
        onClick={toggle}
        aria-pressed={open}
        aria-label={open ? "Valve open / locked open" : "Valve closed"}
      >
        <span className="ia-valve__body">
          <span className="ia-valve__flange ia-valve__flange--l" />
          <span className="ia-valve__bore" />
          <span className="ia-valve__flange ia-valve__flange--r" />
          <span className={`ia-valve__stem ${open ? "ia-valve__stem--open" : ""}`}>
            <span className="ia-valve__wheel">
              <span className="ia-valve__spoke" />
              <span className="ia-valve__spoke" />
              <span className="ia-valve__hub" />
            </span>
          </span>
        </span>
        <span className="ia-valve__meta">
          <strong>{open ? "OPEN · LOCKED" : "CLOSED"}</strong>
          <small>{open ? "Flow path clear — stem latched" : "Isolation position"}</small>
        </span>
      </button>
    </div>
  );
}

function TigWeldProgress() {
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const rafRef = useRef(0);
  const startRef = useRef(0);

  function simulate() {
    if (running) return;
    setRunning(true);
    setProgress(0);
    startRef.current = performance.now();
    const duration = 2800;

    function tick(now) {
      const t = Math.min(1, (now - startRef.current) / duration);
      // Slightly uneven feed — like travel speed on a weld pass
      const eased = t < 0.92 ? t * 0.96 : 0.883 + (t - 0.92) * 1.46;
      const pct = Math.min(100, Math.round(eased * 100));
      setProgress(pct);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setProgress(100);
        setRunning(false);
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">Fabrication pass</div>
      <h3 className="ia-card__title">TIG Weld Progress</h3>
      <p className="ia-card__copy">
        Leading edge burns like an arc. Behind it, a segmented bead cools — not a soft gradient fill.
      </p>
      <div className="ia-weld" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <div className="ia-weld__track">
          <div className="ia-weld__bead" style={{ width: `${progress}%` }}>
            <span className="ia-weld__segments" aria-hidden="true" />
            {progress > 0 && progress < 100 ? <span className="ia-weld__arc" aria-hidden="true" /> : null}
          </div>
        </div>
        <div className="ia-weld__readout">
          <strong>{progress}%</strong>
          <span>{progress >= 100 ? "Pass complete · bead cooled" : running ? "Torch travel…" : "Ready to weld"}</span>
        </div>
      </div>
      <div className="ia-pneumatic-row" style={{ marginTop: 14 }}>
        <button type="button" className="ia-pneumatic ia-pneumatic--compact" onClick={simulate} disabled={running}>
          <span className="ia-pneumatic__face">
            <span className="ia-pneumatic__label">{running ? "Welding…" : "Simulate Upload"}</span>
          </span>
        </button>
        {!running && progress > 0 ? (
          <button type="button" className="ia-reset" onClick={() => setProgress(0)}>
            Clear bead
          </button>
        ) : null}
      </div>
    </div>
  );
}

const PID_STAGES = [
  { key: "so", label: "Sales Order", short: "SO" },
  { key: "dispatch", label: "Dispatch", short: "DSP" },
  { key: "commissioning", label: "Commissioning", short: "COM" },
];

function PidPipelineStepper() {
  const [stage, setStage] = useState(0);
  const [flowing, setFlowing] = useState(null); // index of pipe animating into next

  function next() {
    if (stage >= PID_STAGES.length - 1 || flowing !== null) return;
    setFlowing(stage);
    window.setTimeout(() => {
      setStage((s) => s + 1);
      setFlowing(null);
    }, 520);
  }

  function reset() {
    setFlowing(null);
    setStage(0);
  }

  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">P&amp;ID plant-to-cash</div>
      <h3 className="ia-card__title">Pipeline Stepper</h3>
      <p className="ia-card__copy">
        Nodes are instrument bubbles; connectors are pipe. Process-cyan fills the run only when advancing stage.
      </p>
      <div className="ia-pid" aria-label="Order pipeline stages">
        {PID_STAGES.map((node, i) => (
          <div key={node.key} className="ia-pid__unit">
            <div
              className={`ia-pid__node ${i <= stage ? "ia-pid__node--hot" : ""} ${i === stage ? "ia-pid__node--active" : ""}`}
            >
              <span className="ia-pid__tag">{node.short}</span>
            </div>
            <span className="ia-pid__caption">{node.label}</span>
            {i < PID_STAGES.length - 1 ? (
              <div className={`ia-pid__pipe ${i < stage ? "ia-pid__pipe--filled" : ""} ${flowing === i ? "ia-pid__pipe--flowing" : ""}`}>
                <span className="ia-pid__pipe-bore" />
                <span className="ia-pid__pipe-flow" />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="ia-pneumatic-row" style={{ marginTop: 16 }}>
        <button type="button" className="ia-pneumatic ia-pneumatic--compact" onClick={next} disabled={stage >= 2 || flowing !== null}>
          <span className="ia-pneumatic__face">
            <span className="ia-pneumatic__label">{stage >= 2 ? "Line complete" : "Next Stage"}</span>
          </span>
        </button>
        {stage > 0 ? (
          <button type="button" className="ia-reset" onClick={reset}>
            Blowdown / reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PneumaticCylinderReveal() {
  const [open, setOpen] = useState(false);

  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">Actuator stroke</div>
      <h3 className="ia-card__title">Pneumatic Cylinder Reveal</h3>
      <p className="ia-card__copy">
        Linear extend, then a hard clunk into end-stop — no soft ease-in-out accordion.
      </p>
      <button
        type="button"
        className={`ia-cyl-trigger ${open ? "ia-cyl-trigger--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="ia-cyl-trigger__rod" aria-hidden="true" />
        <span>{open ? "Retract cylinder" : "Extend cylinder"}</span>
        <strong>{open ? "EXTENDED" : "RETRACTED"}</strong>
      </button>
      <div className={`ia-cyl ${open ? "ia-cyl--open" : ""}`}>
        <div className="ia-cyl__inner">
          <div className="ia-cyl__stamp">Commissioning packet</div>
          <p>
            Site readiness checklist, signed report Drive link, and warranty clock start notes. This panel hits its
            mechanical limit stop — you should feel the deceleration, not a fade.
          </p>
          <ul>
            <li>Client sign-off attached</li>
            <li>Milestone unlock queued</li>
            <li>Spare map verified</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function GaugeNeedleReadout() {
  const [psi, setPsi] = useState(42);

  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">Instrument face</div>
      <h3 className="ia-card__title">Gauge Needle Readout</h3>
      <p className="ia-card__copy">
        Better than a spinning spinner for “system pressure / load.” Needle slews with mass — no digital tween fluff.
      </p>
      <div className="ia-gauge">
        <div className="ia-gauge__dial" aria-hidden="true">
          <div className="ia-gauge__ticks" />
          <div className="ia-gauge__needle" style={{ transform: `rotate(${-120 + (psi / 100) * 240}deg)` }} />
          <div className="ia-gauge__hub" />
        </div>
        <div className="ia-gauge__meta">
          <strong>{psi} barg</strong>
          <span>Skid discharge pressure</span>
          <input
            className="ia-gauge__slider"
            type="range"
            min={0}
            max={100}
            value={psi}
            onChange={(e) => setPsi(Number(e.target.value))}
            aria-label="Set gauge pressure"
          />
        </div>
      </div>
    </div>
  );
}

function BoltTorqueConfirm() {
  const [torqued, setTorqued] = useState(false);
  const [spinning, setSpinning] = useState(false);

  function tighten() {
    if (torqued || spinning) return;
    setSpinning(true);
    window.setTimeout(() => {
      setSpinning(false);
      setTorqued(true);
    }, 480);
  }

  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">Flange make-up</div>
      <h3 className="ia-card__title">Bolt Torque Confirm</h3>
      <p className="ia-card__copy">
            Acknowledgement that feels like a wrench turn and a positive stop — useful for “confirm &amp; lock row.”
      </p>
      <button
        type="button"
        className={`ia-bolt ${torqued ? "ia-bolt--set" : ""} ${spinning ? "ia-bolt--spinning" : ""}`}
        onClick={tighten}
        disabled={spinning}
      >
        <span className="ia-bolt__hex" aria-hidden="true" />
        <span className="ia-bolt__copy">
          <strong>{torqued ? "TORQUED · SET" : spinning ? "APPLYING…" : "CONFIRM · TORQUE"}</strong>
          <small>{torqued ? "Spec achieved — do not re-mark" : "Click to apply final turn"}</small>
        </span>
      </button>
      {torqued ? (
        <button type="button" className="ia-reset" style={{ marginTop: 12 }} onClick={() => setTorqued(false)}>
          Break flange (reset)
        </button>
      ) : null}
    </div>
  );
}

function SkidPowerRail() {
  const [on, setOn] = useState(false);

  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">MCC / skid power</div>
      <h3 className="ia-card__title">Breaker Throw</h3>
      <p className="ia-card__copy">
        Enable/disable with a vertical knife-switch throw — heavier than a checkbox for “put this SO live.”
      </p>
      <button
        type="button"
        className={`ia-breaker ${on ? "ia-breaker--on" : ""}`}
        onClick={() => setOn((v) => !v)}
        aria-pressed={on}
      >
        <span className="ia-breaker__slot">
          <span className={`ia-breaker__handle ${on ? "ia-breaker__handle--on" : ""}`} />
        </span>
        <span className="ia-breaker__meta">
          <strong>{on ? "ENERGIZED" : "ISOLATED"}</strong>
          <small>{on ? "Bus live · cyan indicator" : "Open circuit · safe"}</small>
        </span>
      </button>
    </div>
  );
}

function PressFitEntityLinker() {
  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">Interference fit · promoted</div>
      <h3 className="ia-card__title">Press-Fit Entity Linker</h3>
      <p className="ia-card__copy">
        Production component lives at <code>components/PressFitLinker</code> (also exported from joshUi). Demo below
        calls a fake async link — crimp only fires on success.
      </p>
      <PressFitLinker
        leftLabel="Lead #4821"
        rightLabel="SO-AT-0194"
        onLink={async () => {
          await new Promise((r) => setTimeout(r, 450));
        }}
        onUnlink={async () => {
          await new Promise((r) => setTimeout(r, 200));
        }}
      />
    </div>
  );
}

function BlowdownValveDelete() {
  const HOLD_MS = 1500;
  const [gone, setGone] = useState(false);
  const [holding, setHolding] = useState(false);
  const [fill, setFill] = useState(0);
  const [venting, setVenting] = useState(false);
  const startRef = useRef(0);
  const rafRef = useRef(0);
  const doneRef = useRef(false);

  function clearHold() {
    cancelAnimationFrame(rafRef.current);
    setHolding(false);
    if (!doneRef.current) setFill(0);
  }

  function tick(now) {
    const elapsed = now - startRef.current;
    const pct = Math.min(100, (elapsed / HOLD_MS) * 100);
    setFill(pct);
    if (elapsed >= HOLD_MS) {
      doneRef.current = true;
      setHolding(false);
      setFill(100);
      setVenting(true);
      window.setTimeout(() => {
        setGone(true);
        setVenting(false);
      }, 380);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function beginHold(e) {
    if (gone || venting || holding) return;
    e.preventDefault();
    doneRef.current = false;
    setHolding(true);
    setFill(0);
    startRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  }

  function endHold() {
    if (doneRef.current) return;
    clearHold();
  }

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  function restore() {
    doneRef.current = false;
    setGone(false);
    setFill(0);
    setVenting(false);
    setHolding(false);
  }

  return (
    <div className="ia-card">
      <div className="ia-card__eyebrow">Irreversible vent</div>
      <h3 className="ia-card__title">Blowdown Valve Delete</h3>
      <p className="ia-card__copy">
        Click-and-hold 1.5s. Pressure builds on the handwheel; at threshold the row vents off-screen with a cyan gas
        burst — high friction by design.
      </p>

      <div className={`ia-blowdown ${gone ? "ia-blowdown--empty" : ""} ${venting ? "ia-blowdown--venting" : ""}`}>
        {!gone ? (
          <div className={`ia-blowdown__row ${venting ? "ia-blowdown__row--yeet" : ""}`}>
            <div className="ia-blowdown__meta">
              <strong>Visitor log · VL-8842</strong>
              <span>Faridabad plant · Active check-in</span>
            </div>
            <button
              type="button"
              className={`ia-blowdown__valve ${holding ? "ia-blowdown__valve--holding" : ""}`}
              onMouseDown={beginHold}
              onMouseUp={endHold}
              onMouseLeave={endHold}
              onTouchStart={beginHold}
              onTouchEnd={endHold}
              onTouchCancel={endHold}
              onContextMenu={(e) => e.preventDefault()}
              aria-label="Hold to blowdown delete"
              disabled={venting}
            >
              <span className="ia-blowdown__wheel" aria-hidden="true">
                <span className="ia-blowdown__spoke" />
                <span className="ia-blowdown__spoke" />
                <span className="ia-blowdown__hub" />
                <span className="ia-blowdown__pressure" style={{ ["--ia-blow"]: `${fill}%` }} />
              </span>
              <span className="ia-blowdown__hint">
                <strong>{holding ? `${Math.round(fill)}%` : "HOLD"}</strong>
                <small>{holding ? "Building pressure…" : "1.5s to vent"}</small>
              </span>
            </button>
            {venting ? <span className="ia-blowdown__plume" aria-hidden="true" /> : null}
          </div>
        ) : (
          <div className="ia-blowdown__cleared">
            <span className="ia-chip">Line vented · record gone</span>
            <button type="button" className="ia-reset" onClick={restore}>
              Re-pressurize (restore demo row)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Temporary industrial micro-interaction sandbox.
 * Mounted at /sandbox (see main.jsx) — fully isolated from ERP shell.
 */
export default function IndustrialAnimations() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "day";
    return window.localStorage.getItem("josh-ia-theme") || "day";
  });

  useEffect(() => {
    document.title = "JOSH · Industrial animation sandbox";
  }, []);

  useEffect(() => {
    window.localStorage.setItem("josh-ia-theme", theme);
  }, [theme]);

  return (
    <div className={`ia-sandbox ia-sandbox--${theme}`}>
      <header className="ia-hero">
        <div className="ia-hero__top">
          <div className="ia-hero__kicker">Temporary sandbox · /sandbox</div>
          <div className="ia-theme" role="group" aria-label="Sandbox theme">
            <button
              type="button"
              className={theme === "day" ? "ia-theme__btn ia-theme__btn--active" : "ia-theme__btn"}
              onClick={() => setTheme("day")}
            >
              Daylight shop floor
            </button>
            <button
              type="button"
              className={theme === "night" ? "ia-theme__btn ia-theme__btn--active" : "ia-theme__btn"}
              onClick={() => setTheme("night")}
            >
              Night process bay
            </button>
          </div>
        </div>
        <h1 className="ia-hero__title">Industrial UI micro-interactions</h1>
        <p className="ia-hero__copy">
          Dark sells the arc and cyan glow. For JOSH, daylight steel usually wins — these patterns must sit in a light ERP
          shell. Toggle both and judge weight, not just vibe.
        </p>
      </header>

      <div className="ia-section-label">Core set</div>
      <div className="ia-grid">
        <DualBedLoader />
        <PneumaticSubmitButton />
        <ValveLockToggle />
      </div>

      <div className="ia-section-label">Plant-to-cash &amp; fabrication</div>
      <div className="ia-grid">
        <TigWeldProgress />
        <PidPipelineStepper />
        <PneumaticCylinderReveal />
      </div>

      <div className="ia-section-label">Extra shop-floor ideas</div>
      <div className="ia-grid">
        <GaugeNeedleReadout />
        <BoltTorqueConfirm />
        <SkidPowerRail />
      </div>

      <div className="ia-section-label">High-friction interactions</div>
      <div className="ia-grid">
        <PressFitEntityLinker />
        <BlowdownValveDelete />
      </div>

      <footer className="ia-footer">
        Self-contained CSS · theme preference stored locally · promote winners into joshUi, then delete this sandbox
      </footer>
    </div>
  );
}
