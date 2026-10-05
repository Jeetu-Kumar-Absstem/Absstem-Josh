import { useEffect, useId } from "react";

/** Compact “Showing X–Y of Z” with prev/next for server-paged desks. */
export function ListPager({
  meta = null,
  onPageChange,
  loading = false,
  label = "rows",
}) {
  if (!meta || !Number.isFinite(Number(meta.total_count))) return null;
  const total = Number(meta.total_count) || 0;
  const from = Number(meta.showing_from) || 0;
  const to = Number(meta.showing_to) || 0;
  const page = Number(meta.page) || 1;
  const pageCount = Number(meta.page_count) || 1;
  const canPrev = page > 1 && !loading;
  const canNext = Boolean(meta.has_more) && !loading;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid #e2e8f0",
        background: "#f8fafc",
        fontSize: 12,
        color: "#475569",
      }}
    >
      <span>
        Showing <strong>{from || 0}</strong>–<strong>{to || 0}</strong> of <strong>{total}</strong> {label}
        {pageCount > 1 ? ` · page ${page}/${pageCount}` : ""}
      </span>
      {pageCount > 1 || meta.has_more || page > 1 ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" disabled={!canPrev} onClick={() => onPageChange?.(page - 1)}>
            Previous
          </button>
          <button type="button" disabled={!canNext} onClick={() => onPageChange?.(page + 1)}>
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Honest banner when a desk returns a hard cap (e.g. 200) instead of full result set. */
export function ListCapBanner({
  shown = 0,
  total = null,
  cap = 200,
  entityLabel = "rows",
}) {
  const totalN = total == null ? null : Number(total);
  const shownN = Number(shown) || 0;
  const capped = totalN != null ? shownN < totalN : shownN >= cap;
  if (!capped && !(shownN >= cap)) return null;
  const message =
    totalN != null && Number.isFinite(totalN)
      ? `Showing ${shownN} of ${totalN} ${entityLabel} (list capped at ${cap}). Narrow filters or search to find older rows.`
      : `Showing first ${shownN} ${entityLabel} (cap ${cap}). Narrow filters or search — more may exist.`;

  return (
    <div
      role="status"
      style={{
        marginTop: 10,
        marginBottom: 4,
        padding: "8px 12px",
        borderRadius: 10,
        border: "1px solid #fde68a",
        background: "#fffbeb",
        color: "#92400e",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {message}
    </div>
  );
}

function fmtCount(n) {
  return Number(n || 0).toLocaleString("en-IN");
}

/**
 * Always-visible “Showing N of M” line for capped (non-paged) desks.
 * `visible` = rows on screen after local filters, `loaded` = rows the server returned,
 * `total` = server count for the same filters.
 */
export function ListCountSummary({ visible = 0, loaded = null, total = null, cap = null, entityLabel = "rows", loading = false, extra = null }) {
  if (loading) return null;
  const visibleN = Number(visible) || 0;
  const loadedN = loaded == null ? visibleN : Number(loaded) || 0;
  const totalN = total == null || !Number.isFinite(Number(total)) ? null : Number(total);
  const capped = totalN != null && loadedN < totalN;
  const locallyFiltered = visibleN !== loadedN;

  let message;
  if (totalN == null) {
    message = (
      <>
        Showing <strong>{fmtCount(visibleN)}</strong> {entityLabel}
      </>
    );
  } else if (!locallyFiltered) {
    message = (
      <>
        Showing <strong>{fmtCount(visibleN)}</strong> of <strong>{fmtCount(totalN)}</strong> {entityLabel}
      </>
    );
  } else {
    message = (
      <>
        Showing <strong>{fmtCount(visibleN)}</strong> after filters · <strong>{fmtCount(loadedN)}</strong> loaded of{" "}
        <strong>{fmtCount(totalN)}</strong> {entityLabel}
      </>
    );
  }

  return (
    <div role="status" className={`list-count-summary ${capped ? "is-capped" : ""}`}>
      <span>
        {message}
        {extra ? <> · {extra}</> : null}
      </span>
      {capped ? (
        <span>
          List capped at {fmtCount(cap || loadedN)} newest{locallyFiltered ? "; local filters only apply to loaded rows" : ""}. Narrow
          filters or search to reach older {entityLabel}.
        </span>
      ) : null}
    </div>
  );
}

/** Visual dormancy marker driven by server-computed `is_dormant` / `dormant_days` / `dormancy_level`. */
export function DormancyChip({ row }) {
  if (!row?.is_dormant) return null;
  const level = String(row.dormancy_level || "dormant");
  const days = Number(row.dormant_days);
  const hasDays = Number.isFinite(days) && days > 0;
  const label =
    level === "expired"
      ? `Lapsed${hasDays ? ` ${days}d` : ""}`
      : `${level === "deep" ? "Dormant" : "Idle"}${hasDays ? ` ${days}d` : ""}`;
  const className = `dormancy-chip ${level === "deep" ? "is-deep" : ""} ${level === "expired" ? "is-expired" : ""}`;
  return (
    <span className={className} title={row.dormancy_reason || "Dormant"} aria-label={row.dormancy_reason || label}>
      {label}
    </span>
  );
}

/**
 * Desk hotkeys: N = new, / = focus search, Enter = open selected (when not typing in input).
 */
export function useDeskHotkeys({
  enabled = true,
  onNew = null,
  onFocusSearch = null,
  onOpenSelected = null,
  searchInputRef = null,
} = {}) {
  const scopeId = useId();

  useEffect(() => {
    if (!enabled) return undefined;

    function isTypingTarget(target) {
      if (!target) return false;
      const tag = String(target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (target.isContentEditable) return true;
      return false;
    }

    function onKeyDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const typing = isTypingTarget(event.target);

      if (event.key === "/" && !typing && typeof onFocusSearch === "function") {
        event.preventDefault();
        if (searchInputRef?.current) searchInputRef.current.focus();
        else onFocusSearch();
        return;
      }

      if ((event.key === "n" || event.key === "N") && !typing && typeof onNew === "function") {
        event.preventDefault();
        onNew();
        return;
      }

      if (event.key === "Enter" && !typing && typeof onOpenSelected === "function") {
        event.preventDefault();
        onOpenSelected();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onNew, onFocusSearch, onOpenSelected, searchInputRef, scopeId]);
}

export default ListPager;
