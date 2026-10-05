/**
 * Shared timeline query parsing for list + analytics endpoints.
 * Calendar math is always Asia/Kolkata so FY / MTD match Indian desks.
 */

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SERVER_NOW_PRESETS = new Set(["current_month", "current_fy_ytd", "ttm"]);

function parseIsoDate(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

/** Calendar parts in Asia/Kolkata so FY bounds match Indian desks. */
function indiaParts(asOf = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(asOf).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month), // 1-12
    day: Number(parts.day),
  };
}

function indianFyStartIso(asOf = new Date()) {
  const { year, month } = indiaParts(asOf);
  const fyStartYear = month >= 4 ? year : year - 1;
  return `${fyStartYear}-04-01`;
}

function todayIso(asOf = new Date()) {
  const { year, month, day } = indiaParts(asOf);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatIndiaDate(iso) {
  const raw = parseIsoDate(iso);
  if (!raw) return "";
  const [year, month, day] = raw.split("-").map(Number);
  return `${String(day).padStart(2, "0")} ${MONTH_SHORT[month - 1]} ${year}`;
}

function lastDayOfMonthIso(year, month1to12) {
  const last = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  return `${year}-${String(month1to12).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

function compactRangeLabel(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) return "";
  const [fy, fm, fd] = dateFrom.split("-").map(Number);
  const [ty, tm, td] = dateTo.split("-").map(Number);
  if (fy === ty && fm === tm) {
    return `${String(fd).padStart(2, "0")}–${String(td).padStart(2, "0")} ${MONTH_SHORT[fm - 1]} ${fy}`;
  }
  if (fy === ty) {
    return `${String(fd).padStart(2, "0")} ${MONTH_SHORT[fm - 1]} – ${String(td).padStart(2, "0")} ${MONTH_SHORT[tm - 1]} ${ty}`;
  }
  return `${formatIndiaDate(dateFrom)} – ${formatIndiaDate(dateTo)}`;
}

function describeTimeline(preset, dateFrom, dateTo) {
  const rangeLabel = compactRangeLabel(dateFrom, dateTo);
  if (preset === "current_month" && dateFrom) {
    const [year, month] = dateFrom.split("-").map(Number);
    const monthEnd = lastDayOfMonthIso(year, month);
    const isMtd = Boolean(dateTo && dateTo < monthEnd);
    const monthName = MONTH_SHORT[month - 1];
    return {
      label: isMtd ? `${monthName} ${year} MTD` : `${monthName} ${year}`,
      rangeLabel,
      hint: isMtd
        ? `Month-to-date through ${formatIndiaDate(dateTo)} — not the full month`
        : `Full calendar month (${rangeLabel})`,
    };
  }
  if (preset === "ttm") {
    return {
      label: "Trailing 12 months",
      rangeLabel,
      hint: "Last 12 months through today (Asia/Kolkata)",
    };
  }
  if (preset === "custom") {
    return {
      label: "Custom range",
      rangeLabel,
      hint: rangeLabel,
    };
  }
  const fyStartYear = dateFrom && dateFrom.slice(5, 7) === "04" ? Number(dateFrom.slice(0, 4)) : indiaParts().year;
  return {
    label: `FY ${fyStartYear}–${String(fyStartYear + 1).slice(-2)} YTD`,
    rangeLabel,
    hint: "Indian financial year to date (Asia/Kolkata)",
  };
}

function resolvePresetWindow(preset, asOf = new Date()) {
  const now = asOf instanceof Date ? asOf : new Date();
  const today = todayIso(now);
  if (preset === "ttm") {
    const ttmStart = new Date(`${today}T12:00:00+05:30`);
    ttmStart.setUTCDate(ttmStart.getUTCDate() - 364);
    return { dateFrom: todayIso(ttmStart), dateTo: today };
  }
  if (preset === "current_month") {
    const { year, month } = indiaParts(now);
    return {
      dateFrom: `${year}-${String(month).padStart(2, "0")}-01`,
      dateTo: today,
    };
  }
  return {
    dateFrom: indianFyStartIso(now),
    dateTo: today,
  };
}

/**
 * Resolve date_from / date_to from request query.
 * Named presets always use server Asia/Kolkata today — client dates are ignored
 * so a PC clock in the wrong year cannot shift Current Month / FY.
 * Default: Current Indian FY YTD (not all-time).
 */
function resolveTimelineFromQuery(query = {}, { defaultPreset = "current_fy_ytd", asOf = new Date() } = {}) {
  const presetRaw = typeof query.timeline_preset === "string" ? query.timeline_preset.trim() : defaultPreset;
  const preset = presetRaw || defaultPreset;
  let dateFrom = parseIsoDate(query.date_from);
  let dateTo = parseIsoDate(query.date_to);

  if (preset === "custom" && dateFrom && dateTo) {
    // keep caller dates
  } else {
    const resolved = resolvePresetWindow(SERVER_NOW_PRESETS.has(preset) ? preset : "current_fy_ytd", asOf);
    dateFrom = resolved.dateFrom;
    dateTo = resolved.dateTo;
  }

  if (dateFrom && dateTo && dateFrom > dateTo) {
    const tmp = dateFrom;
    dateFrom = dateTo;
    dateTo = tmp;
  }

  const described = describeTimeline(preset, dateFrom, dateTo);
  return {
    preset: preset || defaultPreset,
    dateFrom,
    dateTo,
    label: described.label,
    rangeLabel: described.rangeLabel,
    hint: described.hint,
    timezone: "Asia/Kolkata",
  };
}

function describeNow(asOf = new Date()) {
  const today = todayIso(asOf);
  const currentMonth = resolveTimelineFromQuery({ timeline_preset: "current_month" }, { asOf });
  const currentFy = resolveTimelineFromQuery({ timeline_preset: "current_fy_ytd" }, { asOf });
  const ttm = resolveTimelineFromQuery({ timeline_preset: "ttm" }, { asOf });
  return {
    today,
    timezone: "Asia/Kolkata",
    windows: {
      current_month: {
        date_from: currentMonth.dateFrom,
        date_to: currentMonth.dateTo,
        label: currentMonth.label,
        range_label: currentMonth.rangeLabel,
        hint: currentMonth.hint,
      },
      current_fy_ytd: {
        date_from: currentFy.dateFrom,
        date_to: currentFy.dateTo,
        label: currentFy.label,
        range_label: currentFy.rangeLabel,
        hint: currentFy.hint,
      },
      ttm: {
        date_from: ttm.dateFrom,
        date_to: ttm.dateTo,
        label: ttm.label,
        range_label: ttm.rangeLabel,
        hint: ttm.hint,
      },
    },
  };
}

/**
 * Append inclusive date-range predicate on a SQL expression (date or timestamptz).
 * Mutates params array; returns SQL fragment or null.
 */
function pushDateRangeFilter(params, expression, dateFrom, dateTo) {
  const parts = [];
  if (dateFrom) {
    params.push(dateFrom);
    parts.push(`(${expression})::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    parts.push(`(${expression})::date <= $${params.length}::date`);
  }
  if (!parts.length) return null;
  return `(${parts.join(" and ")})`;
}

module.exports = {
  parseIsoDate,
  resolveTimelineFromQuery,
  pushDateRangeFilter,
  indianFyStartIso,
  todayIso,
  indiaParts,
  describeTimeline,
  describeNow,
  formatIndiaDate,
};
