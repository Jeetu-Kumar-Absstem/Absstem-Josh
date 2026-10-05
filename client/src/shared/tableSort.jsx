import { useMemo, useState } from "react";

export function loadSort(storageKey, spec, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "");
    if (parsed && spec[parsed.column] && (parsed.dir === "asc" || parsed.dir === "desc")) {
      return { column: parsed.column, dir: parsed.dir };
    }
  } catch {
    /* keep fallback */
  }
  return fallback;
}

export function saveSort(storageKey, sort) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(sort));
  } catch {
    /* ignore quota / private mode */
  }
}

export function compareValues(a, b, type) {
  if (type === "number") {
    const na = Number(a);
    const nb = Number(b);
    return (Number.isFinite(na) ? na : 0) - (Number.isFinite(nb) ? nb : 0);
  }
  if (type === "date") {
    const ta = a ? new Date(a).getTime() : 0;
    const tb = b ? new Date(b).getTime() : 0;
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  }
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}

export function sortRows(rows, sort, spec, getValue, tieBreak) {
  const meta = spec[sort.column];
  if (!meta) return rows;
  const dir = sort.dir === "desc" ? -1 : 1;
  const read = getValue || ((row, column) => row[column]);
  return [...rows].sort((left, right) => {
    const cmp = compareValues(read(left, sort.column), read(right, sort.column), meta.type) * dir;
    if (cmp !== 0) return cmp;
    return tieBreak ? compareValues(tieBreak(left), tieBreak(right), "string") : 0;
  });
}

export function nextSort(current, column, spec) {
  if (current.column === column) {
    return { column, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { column, dir: spec[column]?.defaultDir || "asc" };
}

export function useSortedRows(rows, spec, fallback, options = {}) {
  const { storageKey = null, getValue, tieBreak } = options;
  const [sort, setSort] = useState(() =>
    storageKey ? loadSort(storageKey, spec, fallback) : fallback
  );
  const sorted = useMemo(
    () => sortRows(rows, sort, spec, getValue, tieBreak),
    [rows, sort, spec, getValue, tieBreak]
  );

  function onSort(next) {
    setSort(next);
    if (storageKey) saveSort(storageKey, next);
  }

  return { sort, onSort, sorted };
}

export function SortTh({ column, label, sort, spec, onSort, className, style, align = "left" }) {
  const active = sort.column === column;
  const justify = align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start";
  const classes = ["sort-th", className].filter(Boolean).join(" ");
  return (
    <th
      className={classes}
      style={style}
      onClick={() => onSort(nextSort(sort, column, spec))}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      title="Click to sort"
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: "100%", justifyContent: justify }}>
        {label}
        <span style={{ fontSize: 9, opacity: active ? 0.9 : 0.35, lineHeight: 1 }}>
          {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </span>
    </th>
  );
}
