import { useMemo, useState } from "react";
import { clearLastDeskFix } from "../shared/joshUi";
import { buildMyDayItems, buildPulseChips } from "./buildMyDayItems";
import {
  canAccessPage,
  defaultLaneForFamily,
  getHomeRoleConfig,
  listAccessibleLanes,
  resolveHomeRoleFamily,
} from "./roleAccess";
import { useHomeFamilyData } from "./useHomeFamilyData";
import WaitingOnYouStrip from "./WaitingOnYouStrip";

/**
 * Department-first Home (My Day v2)
 *
 * Waiting on You — For you action queue (inbox-zero routing)
 * Zone A — Identity (quiet brand / role)
 * Zone B — Do this next (ranked personal actions; always visible)
 * Zone C — My desks (permission-filtered pins)
 * Zone D — Department pulse (default family only)
 * Optional — Other areas you can see (collapsed; multi-lane users only)
 */
export default function HomePanel({
  me,
  onNavigate,
  lastDeskFix = null,
  onClearLastDeskFix = null,
  companyLabel = "",
  forYou = [],
  onOpenNotification = null,
  onEnablePush = null,
  pushEnabled = false,
  onRequestSku = null,
}) {
  const family = resolveHomeRoleFamily(me);
  const roleConfig = getHomeRoleConfig(me);
  const data = useHomeFamilyData(me, family);

  const pins = useMemo(
    () =>
      (roleConfig.pins || []).filter((pin) => {
        if (pin.action === "request_sku") return true;
        return pin.page && canAccessPage(me, pin.page);
      }),
    [me, roleConfig.pins]
  );

  const myDayItems = useMemo(
    () =>
      buildMyDayItems({
        me,
        family,
        data,
        // For you actions live in Waiting on You strip — avoid duplicate cards in Zone B.
        forYou: [],
        onNavigate,
        onOpenNotification,
      }),
    [me, family, data, onNavigate, onOpenNotification]
  );

  const pulseChips = useMemo(
    () => buildPulseChips({ me, family, data, onNavigate }),
    [me, family, data, onNavigate]
  );

  const accessibleLanes = useMemo(() => listAccessibleLanes(me), [me]);
  const defaultLane = defaultLaneForFamily(family);
  const extraLanes = accessibleLanes.filter((lane) => lane.key !== defaultLane);
  const [otherAreasOpen, setOtherAreasOpen] = useState(false);
  const [browseLane, setBrowseLane] = useState(extraLanes[0]?.key || "");

  const primary = myDayItems[0] || null;
  const listBusy = data.loading && myDayItems.length === 0;

  function resumeLastFix() {
    if (!lastDeskFix?.page || !canAccessPage(me, lastDeskFix.page)) return;
    const opts = { resetQuote: true };
    if (lastDeskFix.manufacturingBomsLaunch) opts.manufacturingBomsLaunch = lastDeskFix.manufacturingBomsLaunch;
    if (lastDeskFix.jobCardsLaunch) opts.jobCardsLaunch = lastDeskFix.jobCardsLaunch;
    if (lastDeskFix.adminLaunch) opts.adminLaunch = lastDeskFix.adminLaunch;
    onNavigate(lastDeskFix.page, opts);
  }

  return (
    <div
      className="home-phase-shell home-main-shell home-v2-shell"
      style={{ "--home-tone": roleConfig.tone, "--home-tint": roleConfig.tint }}
    >
      <WaitingOnYouStrip
        forYou={forYou}
        onOpenNotification={onOpenNotification}
        onEnablePush={onEnablePush}
        pushEnabled={pushEnabled}
      />

      <section className="home-main-hero home-v2-hero" aria-label="My Day">
        <div className="home-main-hero-brand home-v2-zone-a" data-zone="A">
          <img className="home-main-logo" src="/absstem_logo.svg" alt="Absstem" width={160} height={26} />
          <div className="home-main-brand-meta">
            <span className="home-main-company">{companyLabel || me.group_name}</span>
            <span className="home-main-role">{roleConfig.label} My Day</span>
          </div>
          <h2 className="home-main-title">{roleConfig.title}</h2>
          <p className="home-main-copy">{roleConfig.description}</p>
        </div>

        <div className="home-main-hero-focus home-v2-zone-b" data-zone="B">
          <div className="panel-kicker">Do this next</div>

          {listBusy ? (
            <p className="home-main-focus-body">Loading your day…</p>
          ) : primary ? (
            <>
              <strong className="home-main-focus-title">{primary.title}</strong>
              <p className="home-main-focus-body">{primary.body}</p>
              <div className="home-main-focus-actions">
                <button type="button" className="button-primary" onClick={primary.onClick}>
                  {primary.action}
                </button>
                <button
                  type="button"
                  className="button-ghost compact-button"
                  onClick={() => window.dispatchEvent(new Event("josh:open-command-palette"))}
                >
                  Jump with ⌘K
                </button>
              </div>
            </>
          ) : (
            <div className="home-v2-empty" role="status">
              <strong className="home-main-focus-title">All clear</strong>
              <p className="home-main-focus-body">No pending desk actions. Check Waiting on you above for inbox items.</p>
              <div className="home-main-focus-actions">
                {pins[0] ? (
                  <button
                    type="button"
                    className="button-primary"
                    onClick={() => {
                      if (pins[0].action === "request_sku") {
                        onRequestSku?.();
                        return;
                      }
                      onNavigate(pins[0].page, { resetQuote: true });
                    }}
                  >
                    Open {pins[0].label}
                  </button>
                ) : null}
              </div>
            </div>
          )}

          <div className="home-main-daylist home-v2-daylist">
            <div className="panel-kicker">My Day</div>
            <div className="home-main-day-stack">
              {myDayItems.length === 0 && !listBusy ? (
                <div className="home-v2-day-empty">Nothing queued — enjoy the calm.</div>
              ) : (
                myDayItems.map((item, index) => (
                  <button key={item.id} type="button" className="home-main-day-item" onClick={item.onClick}>
                    <span className="home-main-day-index">
                      {item.kind === "approval" ? "!" : item.kind === "field" ? "●" : index + 1}
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <em>{item.action}</em>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="home-main-daylist home-v2-zone-c" data-zone="C">
          <div className="panel-kicker">My desks</div>
          <div className="home-v2-pin-stack">
            {pins.map((pin) => (
              <button
                key={pin.page || pin.action || pin.label}
                type="button"
                className="home-pinned-card home-v2-pin"
                onClick={() => {
                  if (pin.action === "request_sku") {
                    onRequestSku?.();
                    return;
                  }
                  onNavigate(pin.page, { resetQuote: true });
                }}
              >
                <strong>{pin.label}</strong>
                <span>{pin.caption}</span>
              </button>
            ))}
            {pins.length === 0 ? (
              <p className="home-main-focus-body">No desks available for this role yet.</p>
            ) : null}
          </div>

          {lastDeskFix?.page && canAccessPage(me, lastDeskFix.page) ? (
            <div className="home-main-resume">
              <div className="panel-kicker">Resume last fix</div>
              <strong>{lastDeskFix.label || lastDeskFix.page}</strong>
              <div className="home-main-resume-actions">
                <button type="button" className="button-primary compact-button" onClick={resumeLastFix}>
                  Resume
                </button>
                <button
                  type="button"
                  className="button-ghost compact-button"
                  onClick={() => (typeof onClearLastDeskFix === "function" ? onClearLastDeskFix() : clearLastDeskFix())}
                >
                  Clear
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {pulseChips.length >= 2 ? (
        <section className="home-v2-zone-d" data-zone="D" aria-label="Department pulse">
          <div className="home-v2-pulse-head">
            <div className="panel-kicker">Department pulse</div>
            <h3>{roleConfig.label} signals</h3>
            <p>Live counts from desks you can open. Empty or inaccessible metrics stay hidden.</p>
          </div>
          <div className="home-v2-pulse-grid">
            {pulseChips.map((chip) => (
              <button key={chip.label} type="button" className="home-summary-card home-v2-pulse-chip" onClick={chip.onClick}>
                <span>{chip.label}</span>
                <strong>{chip.value}</strong>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {extraLanes.length > 0 ? (
        <section className="surface-card home-v2-other-areas">
          <div className="home-v2-other-head">
            <div>
              <div className="panel-kicker">Other areas you can see</div>
              <h3>Cross-department browse</h3>
              <p>Optional. Does not change your My Day ranking.</p>
            </div>
            <button
              type="button"
              className="button-ghost compact-button"
              onClick={() => setOtherAreasOpen((open) => !open)}
            >
              {otherAreasOpen ? "Hide" : "Show"}
            </button>
          </div>
          {otherAreasOpen ? (
            <div className="home-lane-switcher">
              {extraLanes.map((lane) => (
                <button
                  key={lane.key}
                  type="button"
                  className={`home-lane-chip ${browseLane === lane.key ? "home-lane-chip-active" : ""}`}
                  onClick={() => {
                    setBrowseLane(lane.key);
                    onNavigate(lane.page, { resetQuote: true });
                  }}
                >
                  <div className="home-lane-chip-head">
                    <strong>{lane.label}</strong>
                  </div>
                  <span>{lane.detail}</span>
                  <small>Open desk</small>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export { canAccessPage, resolveHomeRoleFamily, getHomeRoleConfig } from "./roleAccess";
