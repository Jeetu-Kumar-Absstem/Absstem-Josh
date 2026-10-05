import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  TIMELINE_PRESETS,
  loadStoredTimeline,
  persistTimeline,
  parseIsoDate,
  resolveTimelineWindow,
} from "./globalTimeline";

const GlobalTimelineContext = createContext(null);

async function fetchServerToday() {
  const res = await fetch("/api/timeline/now", {
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const data = await res.json().catch(() => null);
  const today = typeof data?.today === "string" ? data.today.trim() : "";
  if (!res.ok || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  return parseIsoDate(today);
}

export function GlobalTimelineProvider({ children }) {
  const stored = loadStoredTimeline();
  const [asOf, setAsOf] = useState(() => new Date());
  const initial = resolveTimelineWindow(
    stored?.preset || TIMELINE_PRESETS.CURRENT_FY_YTD,
    stored?.custom_from || null,
    stored?.custom_to || null,
    asOf
  );

  const [preset, setPresetState] = useState(initial.preset);
  const [customFrom, setCustomFromState] = useState(stored?.custom_from || initial.date_from);
  const [customTo, setCustomToState] = useState(stored?.custom_to || initial.date_to);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchServerToday()
      .then((serverAsOf) => {
        if (cancelled || !serverAsOf) return;
        setAsOf(serverAsOf);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const window = useMemo(() => {
    return resolveTimelineWindow(preset, customFrom, customTo, asOf);
  }, [preset, customFrom, customTo, asOf]);

  const apply = useCallback((nextPreset, nextFrom, nextTo) => {
    const resolved = resolveTimelineWindow(nextPreset, nextFrom, nextTo, asOf);
    setPresetState(resolved.preset);
    if (resolved.preset === TIMELINE_PRESETS.CUSTOM) {
      setCustomFromState(resolved.date_from);
      setCustomToState(resolved.date_to);
      persistTimeline({
        preset: resolved.preset,
        custom_from: resolved.date_from,
        custom_to: resolved.date_to,
      });
    } else {
      persistTimeline({ preset: resolved.preset, custom_from: null, custom_to: null });
    }
    setRevision((n) => n + 1);
  }, [asOf]);

  const setPreset = useCallback(
    (next) => {
      apply(next, customFrom, customTo);
    },
    [apply, customFrom, customTo]
  );

  const setCustomRange = useCallback(
    (from, to) => {
      apply(TIMELINE_PRESETS.CUSTOM, from, to);
    },
    [apply]
  );

  const value = useMemo(
    () => ({
      preset: window.preset,
      date_from: window.date_from,
      date_to: window.date_to,
      label: window.label,
      range_label: window.range_label,
      hint: window.hint,
      asOf,
      custom_from: customFrom,
      custom_to: customTo,
      setPreset,
      setCustomRange,
      apply,
      revision,
    }),
    [window, asOf, customFrom, customTo, setPreset, setCustomRange, apply, revision]
  );

  return <GlobalTimelineContext.Provider value={value}>{children}</GlobalTimelineContext.Provider>;
}

export function useGlobalTimeline() {
  const ctx = useContext(GlobalTimelineContext);
  if (!ctx) {
    const fallback = resolveTimelineWindow(TIMELINE_PRESETS.CURRENT_FY_YTD);
    return {
      ...fallback,
      asOf: new Date(),
      custom_from: fallback.date_from,
      custom_to: fallback.date_to,
      setPreset: () => {},
      setCustomRange: () => {},
      apply: () => {},
      revision: 0,
    };
  }
  return ctx;
}
