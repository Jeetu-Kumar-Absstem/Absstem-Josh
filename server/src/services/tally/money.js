function money2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Tally round-off only absorbs rupee rounding; anything at or above this is a real mismatch.
const ROUND_OFF_LIMIT = 1;

// Tally vs Josh amounts reconcile when they agree within 5 paise after 2-decimal rounding.
const RECON_TOLERANCE = 0.05;

function reconVariance(tallyAmount, joshAmount) {
  return money2(Math.abs(money2(tallyAmount) - money2(joshAmount)));
}

function withinReconTolerance(variance) {
  return money2(variance) <= RECON_TOLERANCE;
}

module.exports = { money2, money: money2, ROUND_OFF_LIMIT, RECON_TOLERANCE, reconVariance, withinReconTolerance };
