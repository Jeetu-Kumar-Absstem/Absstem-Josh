/**
 * Indian FY helpers + global timeline presets for Josh desks.
 * FY runs 1 Apr → 31 Mar (e.g. FY 2026–27 = 2026-04-01 … 2027-03-31).
 * Calendar math uses Asia/Kolkata, not the browser's local clock.
 */

export const TIMELINE_PRESETS = Object.freeze({
  CURRENT_FY_YTD: "current_fy_ytd",
  TTM: "ttm",
  CURRENT_MONTH: "current_month",
  CUSTOM: "custom",
});

const STORAGE_KEY = "josh.globalTimeline.v1";
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function indiaParts(asOf = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(asOf).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

export function toIsoDate(d) {
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())) return d.trim();
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const { year, month, day } = indiaParts(d);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function parseIsoDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T12:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatIndiaDate(iso) {
  const raw = String(iso || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  const [year, month, day] = raw.split("-").map(Number);
  return `${pad2(day)} ${MONTH_SHORT[month - 1]} ${year}`;
}

function lastDayOfMonthIso(year, month1to12) {
  const last = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  return `${year}-${pad2(month1to12)}-${pad2(last)}`;
}

export function compactRangeLabel(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) return "";
  const [fy, fm, fd] = dateFrom.split("-").map(Number);
  const [ty, tm, td] = dateTo.split("-").map(Number);
  if (fy === ty && fm === tm) {
    return `${pad2(fd)}–${pad2(td)} ${MONTH_SHORT[fm - 1]} ${fy}`;
  }
  if (fy === ty) {
    return `${pad2(fd)} ${MONTH_SHORT[fm - 1]} – ${pad2(td)} ${MONTH_SHORT[tm - 1]} ${ty}`;
  }
  return `${formatIndiaDate(dateFrom)} – ${formatIndiaDate(dateTo)}`;
}

export function describeTimeline(preset, dateFrom, dateTo) {
  const rangeLabel = compactRangeLabel(dateFrom, dateTo);
  if (preset === TIMELINE_PRESETS.CURRENT_MONTH && dateFrom) {
    const [year, month] = dateFrom.split("-").map(Number);
    const monthEnd = lastDayOfMonthIso(year, month);
    const isMtd = Boolean(dateTo && dateTo < monthEnd);
    const monthName = MONTH_SHORT[month - 1];
    return {
      label: isMtd ? `${monthName} ${year} MTD` : `${monthName} ${year}`,
      range_label: rangeLabel,
      hint: isMtd
        ? `Month-to-date through ${formatIndiaDate(dateTo)} — not the full month`
        : `Full calendar month (${rangeLabel})`,
    };
  }
  if (preset === TIMELINE_PRESETS.TTM) {
    return {
      label: "Trailing 12 months",
      range_label: rangeLabel,
      hint: "Last 12 months through today (Asia/Kolkata)",
    };
  }
  if (preset === TIMELINE_PRESETS.CUSTOM) {
    return {
      label: "Custom range",
      range_label: rangeLabel,
      hint: rangeLabel,
    };
  }
  const fyStartYear = dateFrom && dateFrom.slice(5, 7) === "04" ? Number(dateFrom.slice(0, 4)) : indiaParts().year;
  return {
    label: `FY ${fyStartYear}–${String(fyStartYear + 1).slice(-2)} YTD`,
    range_label: rangeLabel,
    hint: "Indian financial year to date (Asia/Kolkata)",
  };
}

/** @returns {{ start: Date, end: Date, fyStartYear: number, label: string }} */
export function indianFinancialYearBounds(asOf = new Date()) {
  const d = asOf instanceof Date ? asOf : parseIsoDate(asOf) || new Date();
  const { year, month } = indiaParts(d);
  const fyStartYear = month >= 4 ? year : year - 1;
  const start = new Date(`${fyStartYear}-04-01T12:00:00+05:30`);
  const end = new Date(`${fyStartYear + 1}-03-31T12:00:00+05:30`);
  const label = `FY ${fyStartYear}–${String(fyStartYear + 1).slice(-2)}`;
  return { start, end, fyStartYear, label };
}

export function resolveTimelineWindow(preset, customFrom = null, customTo = null, asOf = new Date()) {
  const today = asOf instanceof Date ? asOf : parseIsoDate(asOf) || new Date();
  const todayIso = toIsoDate(today);
  let from = null;
  let to = todayIso;

  if (preset === TIMELINE_PRESETS.CUSTOM) {
    from = customFrom || todayIso;
    to = customTo || todayIso;
  } else if (preset === TIMELINE_PRESETS.TTM) {
    const start = new Date(`${todayIso}T12:00:00+05:30`);
    start.setUTCDate(start.getUTCDate() - 364);
    from = toIsoDate(start);
  } else if (preset === TIMELINE_PRESETS.CURRENT_MONTH) {
    const { year, month } = indiaParts(today);
    from = `${year}-${pad2(month)}-01`;
  } else {
    const fy = indianFinancialYearBounds(today);
    from = toIsoDate(fy.start);
    preset = TIMELINE_PRESETS.CURRENT_FY_YTD;
  }

  if (from && to && from > to) {
    const swap = from;
    from = to;
    to = swap;
  }

  const described = describeTimeline(preset, from, to);
  return {
    preset,
    date_from: from,
    date_to: to,
    label: described.label,
    range_label: described.range_label,
    hint: described.hint,
  };
}

export function loadStoredTimeline() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistTimeline(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        preset: state.preset,
        custom_from: state.custom_from || null,
        custom_to: state.custom_to || null,
      })
    );
  } catch {
    /* ignore */
  }
}

export function appendTimelineParams(params, timeline) {
  if (!params || !timeline) return params;
  if (timeline.date_from) params.set("date_from", timeline.date_from);
  if (timeline.date_to) params.set("date_to", timeline.date_to);
  if (timeline.preset) params.set("timeline_preset", timeline.preset);
  return params;
}

export function presetOptions(asOf = new Date()) {
  const monthWindow = resolveTimelineWindow(TIMELINE_PRESETS.CURRENT_MONTH, null, null, asOf);
  const fy = indianFinancialYearBounds(asOf);
  return [
    { value: TIMELINE_PRESETS.CURRENT_FY_YTD, label: `Current FY (${fy.label} YTD)` },
    { value: TIMELINE_PRESETS.TTM, label: "Trailing 12 Months (TTM)" },
    { value: TIMELINE_PRESETS.CURRENT_MONTH, label: `This month (${monthWindow.label})` },
    { value: TIMELINE_PRESETS.CUSTOM, label: "Custom Range" },
  ];
}
