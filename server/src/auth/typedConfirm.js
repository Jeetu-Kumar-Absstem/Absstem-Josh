function readConfirmPhrase(req) {
  const fromBody = req?.body && typeof req.body === "object" ? req.body.confirm_phrase : undefined;
  const fromHeader = typeof req?.get === "function" ? req.get("x-confirm-phrase") : undefined;
  return String(fromBody ?? fromHeader ?? "").trim();
}

/**
 * Irreversible actions must carry the exact phrase the operator typed.
 * Returns true when it matches; otherwise sends 400 CONFIRM_PHRASE_REQUIRED and returns false.
 */
function checkTypedConfirm(req, res, expectedPhrase, action = "this action") {
  const expected = String(expectedPhrase || "").trim();
  if (expected && readConfirmPhrase(req) === expected) return true;
  res.status(400).json({
    ok: false,
    error: "CONFIRM_PHRASE_REQUIRED",
    expected,
    detail: `Type ${expected} to confirm ${action}.`,
  });
  return false;
}

function requireTypedConfirm(expectedPhrase, action) {
  return (req, res, next) => {
    const expected = typeof expectedPhrase === "function" ? expectedPhrase(req) : expectedPhrase;
    if (checkTypedConfirm(req, res, expected, action)) return next();
    return undefined;
  };
}

module.exports = { readConfirmPhrase, checkTypedConfirm, requireTypedConfirm };
