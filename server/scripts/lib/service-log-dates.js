/**
 * Date handling for the service team's log, shared by the review-workbook builder and
 * the service-history importer so both agree on what a date in that file means.
 */

const t = (v) => String(v == null ? "" : v).trim();

/**
 * An ISO date from the log's DD-MM-YYYY text, or null.
 *
 * Typos that lost a digit ("17-04-206") or doubled a separator ("30-07--2023") are real
 * in this data and are rejected rather than guessed at.
 */
function logDate(value) {
  const s = t(value);
  let m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const day = Number(dd);
    const month = Number(mm);
    const year = Number(yyyy);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (year < 2000 || year > 2100) return null;
    return `${yyyy}-${mm}-${dd}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Swap the day and month of an ISO date, or null if that is not a real date.
 *
 * Some 2026 visit dates were typed as DD-MM text into cells a month-first Excel read as
 * MM-DD, so the stored serial has the two fields transposed. The tell is a stored date in
 * Oct-Dec 2026 with a day of 1-7: only a true day of 10-12 can be misread as a month, and
 * only a true month of 1-7 has happened yet. Every one of those swaps back to a real past
 * date.
 */
function swappedDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t(iso));
  if (!m) return null;
  const [, y, mo, d] = m;
  if (Number(d) < 1 || Number(d) > 12) return null; // the day cannot become a month
  const candidate = `${y}-${d}-${mo}`;
  const check = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(check.getTime())) return null;
  return check.toISOString().slice(0, 10) === candidate ? candidate : null;
}

/**
 * Could this date have been transposed without anyone noticing?
 *
 * True when both fields are 1-12, so the wrong reading is still a real date. These cannot
 * be told apart from correct entries by looking at the file, which is why they are listed
 * for a human rather than corrected.
 */
function isAmbiguousDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t(iso));
  return Boolean(m) && Number(m[3]) <= 12 && Number(m[2]) <= 12;
}

module.exports = { logDate, swappedDate, isAmbiguousDate };
