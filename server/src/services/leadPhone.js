function normalizePhoneDigits(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return "";
  // Prefer last 10 digits for IN-style mobiles when longer country codes are present.
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function phonesMatch(a, b) {
  const left = normalizePhoneDigits(a);
  const right = normalizePhoneDigits(b);
  if (!left || !right) return false;
  return left === right;
}

/**
 * Build SQL-friendly digit forms for matching stored phones that may include spaces/dashes/+91.
 * Returns null when phone is empty/invalid.
 */
function phoneMatchPatterns(phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits || digits.length < 7) return null;
  return {
    digits,
    likeSuffix: `%${digits}`,
  };
}

module.exports = {
  normalizePhoneDigits,
  phonesMatch,
  phoneMatchPatterns,
};
