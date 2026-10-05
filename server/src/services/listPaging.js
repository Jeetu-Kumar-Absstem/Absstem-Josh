/**
 * Shared list honesty / pager helpers for Wave 5 scale desks.
 */

function normalizePageLimit(value, { fallback = 50, max = 200 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

function normalizePageOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function buildListMeta({ totalCount, limit, offset, returned }) {
  const total = Math.max(0, Number(totalCount) || 0);
  const lim = Math.max(1, Number(limit) || 50);
  const off = Math.max(0, Number(offset) || 0);
  const count = Math.max(0, Number(returned) || 0);
  const from = total === 0 || count === 0 ? 0 : off + 1;
  const to = total === 0 || count === 0 ? 0 : off + count;
  return {
    total_count: total,
    limit: lim,
    offset: off,
    returned: count,
    has_more: off + count < total,
    showing_from: from,
    showing_to: to,
    page: Math.floor(off / lim) + 1,
    page_count: Math.max(1, Math.ceil(total / lim) || 1),
  };
}

module.exports = { normalizePageLimit, normalizePageOffset, buildListMeta };
