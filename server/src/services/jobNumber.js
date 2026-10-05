/**
 * Absstem job / machine-serial number normalization.
 *
 * The same physical machine is written many ways across our sources:
 *   Service Master   M-028   N01   N010   N02 B   ID04 a   ID02/M-165   IDO25   NO61   AT-MX-01   ASP 01
 *   Service log      M-30    M-31
 *   Tally invoices   N047    ID007   IS0118N086   N046,N047
 *
 * Canonical form is PREFIX + 4-digit zero-padded number: N0047, M0028, ID0007.
 * Padding is produced by integer-parsing the numeric part, which is what collapses
 * the M-028 / M-30 / N01 / N010 variants onto one key.
 */

// prefix -> owning company code. M/MX/AS/ASP are medical (MedO); N/ID/GS are industrial.
const PREFIX_COMPANY = Object.freeze({
  M: "AT",
  MX: "AT",
  AS: "AT",
  ASP: "AT",
  N: "AI",
  ID: "AI",
  GS: "AI",
});

// prefix -> product family group. nGEN vs nGENX and Idos vs Idos C cannot be told
// apart from the number alone; resolve those from the model/capacity text.
const PREFIX_FAMILY_GROUP = Object.freeze({
  M: "MEDO",
  MX: "MEDO",
  AS: "MEDO",
  ASP: "MEDO",
  N: "NGEN",
  ID: "IDOS",
  GS: "GAS_STORAGE",
});

const PREFIX_ALIASES = Object.freeze({
  IDO: "ID",
  NO: "N", // "NO61" — letter O typed for zero
  MO: "M",
});

const KNOWN_PREFIXES = Object.freeze(["ASP", "IDO", "ID", "MX", "AS", "AT", "GS", "MO", "NO", "M", "N"]);

const ISSUE = Object.freeze({
  UNPARSEABLE: "UNPARSEABLE",
  BLANK: "BLANK",
  MULTI_REF: "MULTI_REF",
  LETTER_O_FOR_ZERO: "LETTER_O_FOR_ZERO",
  EMBEDDED_SPACE: "EMBEDDED_SPACE",
  LETTER_SUFFIX: "LETTER_SUFFIX",
  SLIP_WITHOUT_MACHINE: "SLIP_WITHOUT_MACHINE",
  SLIP_NUMBER_MISSING: "SLIP_NUMBER_MISSING",
  SHORT_NUMBER: "SHORT_NUMBER",
  UNKNOWN_PREFIX: "UNKNOWN_PREFIX",
});

function padNumber(digits) {
  return String(Number(digits)).padStart(4, "0");
}

function canonicalPrefix(rawPrefix) {
  const p = String(rawPrefix || "").toUpperCase();
  return PREFIX_ALIASES[p] || p;
}

/**
 * Parse one token (already split on separators) into a machine reference.
 * Returns null when the token carries no prefix+number pair.
 *
 * `afterSlip` marks a serial that followed an install-slip marker. Those are the
 * ones where a 1-2 digit number signals truncation ("IS0042N09" for N009 or N090);
 * standalone cells legitimately write short numbers all the time.
 */
function parseToken(token, { afterSlip = false } = {}) {
  const issues = [];
  let s = String(token || "").toUpperCase().trim();
  if (!s) return null;

  // "AT-MX-01" is an AT-prefixed MedO-X serial; drop the leading company tag.
  s = s.replace(/^AT[-\s]+(?=(MX|M|N|ID))/, "");

  // Capture a trailing single-letter variant marker before we strip spaces:
  // "N02 B" and "ID04 a" are two physical machines sharing one number.
  let suffix = null;
  const suffixMatch = s.match(/^(.*?[0-9])\s*([A-Z])$/);
  if (suffixMatch && !/^(MX|ASP|AS|ID|IDO|NO|MO)$/.test(suffixMatch[2])) {
    s = suffixMatch[1];
    suffix = suffixMatch[2];
    issues.push(ISSUE.LETTER_SUFFIX);
  }

  if (/[A-Z]\s+\d/.test(s)) issues.push(ISSUE.EMBEDDED_SPACE);
  s = s.replace(/\s+/g, "");

  const prefixMatch = KNOWN_PREFIXES.find((p) => s.startsWith(p));
  if (!prefixMatch) return null;

  let rest = s.slice(prefixMatch.length);
  // separators between prefix and number: N-047, M/028
  rest = rest.replace(/^[-/_.]+/, "");
  // letter O standing in for zero inside the numeric part
  if (/^O+\d/.test(rest)) {
    issues.push(ISSUE.LETTER_O_FOR_ZERO);
    rest = rest.replace(/^O+/, "0");
  }

  const numMatch = rest.match(/^(\d{1,4})/);
  if (!numMatch) return null;

  const prefix = canonicalPrefix(prefixMatch);
  if (canonicalPrefix(prefixMatch) !== String(prefixMatch).toUpperCase()) {
    if (/^(NO|MO|IDO)$/.test(String(prefixMatch).toUpperCase())) issues.push(ISSUE.LETTER_O_FOR_ZERO);
  }
  if (!PREFIX_COMPANY[prefix]) issues.push(ISSUE.UNKNOWN_PREFIX);
  if (afterSlip && numMatch[1].length <= 2) issues.push(ISSUE.SHORT_NUMBER);

  return {
    key: prefix + padNumber(numMatch[1]),
    prefix,
    number: Number(numMatch[1]),
    suffix,
    company: PREFIX_COMPANY[prefix] || null,
    familyGroup: PREFIX_FAMILY_GROUP[prefix] || null,
    issues,
  };
}

/**
 * Parse a raw job_no cell, which may hold an install slip, several machines, or both:
 *   "N047"              -> one machine
 *   "N046,N047"         -> two machines
 *   "ID02/M-165"        -> two machines in different companies
 *   "IS0118N086"        -> install slip IS0118 against machine N0086
 *   "IS0096"            -> install slip with no machine identified
 */
function parseJobRef(raw) {
  const original = String(raw == null ? "" : raw).trim();
  const result = {
    raw: original,
    refs: [],
    primary: null,
    company: null,
    installSlip: null,
    issues: [],
  };
  if (!original) {
    result.issues.push(ISSUE.BLANK);
    return result;
  }

  let work = original.toUpperCase();

  // Install slip prefix: IS0118N086 / IS 0118 / IS00114N075 (padding is inconsistent)
  let sawSlip = false;
  const slip = work.match(/^IS[\s-]*(\d+)/);
  if (slip) {
    sawSlip = true;
    work = work.slice(slip[0].length);
    // "IS00N076" leaves only zeros — the marker is there but the number is not.
    if (Number(slip[1]) === 0) result.issues.push(ISSUE.SLIP_NUMBER_MISSING);
    else result.installSlip = "IS" + String(Number(slip[1])).padStart(4, "0");
  } else if (/^IS[\s-]*(?=[A-Z])/.test(work)) {
    sawSlip = true;
    result.issues.push(ISSUE.SLIP_NUMBER_MISSING);
    work = work.replace(/^IS[\s-]*/, "");
  }

  const seen = new Set();
  for (const token of work.split(/[,;+&/]/)) {
    const ref = parseToken(token, { afterSlip: sawSlip });
    if (!ref || seen.has(ref.key + (ref.suffix || ""))) continue;
    seen.add(ref.key + (ref.suffix || ""));
    result.refs.push(ref);
    for (const i of ref.issues) if (!result.issues.includes(i)) result.issues.push(i);
  }

  if (!result.refs.length) {
    if (sawSlip) result.issues.push(ISSUE.SLIP_WITHOUT_MACHINE);
    else result.issues.push(ISSUE.UNPARSEABLE);
    return result;
  }

  if (result.refs.length > 1) result.issues.push(ISSUE.MULTI_REF);
  result.primary = result.refs[0].key;
  // Only assert a company when every reference agrees.
  const companies = [...new Set(result.refs.map((r) => r.company).filter(Boolean))];
  result.company = companies.length === 1 ? companies[0] : null;
  return result;
}

/** Convenience: canonical key for the first machine in the cell, or null. */
function normalizeJobNumber(raw) {
  return parseJobRef(raw).primary;
}

/** Every canonical machine key referenced by the cell. */
function allJobKeys(raw) {
  return parseJobRef(raw).refs.map((r) => r.key);
}

/** Company that owns a canonical key, from its prefix. */
function companyForJobKey(key) {
  const m = String(key || "").toUpperCase().match(/^([A-Z]+)/);
  return m ? PREFIX_COMPANY[m[1]] || null : null;
}

module.exports = {
  ISSUE,
  PREFIX_COMPANY,
  PREFIX_FAMILY_GROUP,
  parseJobRef,
  normalizeJobNumber,
  allJobKeys,
  companyForJobKey,
};
