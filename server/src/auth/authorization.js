function getScreenPermission(req, screenKey) {
  const perms = req?.user?.permissions?.screens?.[screenKey];
  return perms && typeof perms === "object"
    ? perms
    : {
        can_view: false,
        can_create: false,
        can_edit: false,
        can_approve: false,
        own_records_only: false,
        financial_masking: false,
      };
}

function hasScreenAction(req, screenKey, action) {
  if (!req?.user) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  const perms = getScreenPermission(req, screenKey);
  return Boolean(perms[action]);
}

function requireScreenAction(screenKey, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    if (hasScreenAction(req, screenKey, action)) return next();
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  };
}

function ownRecordsOnly(req, screenKey) {
  if (!req?.user) return false;
  if (req.user.group_name === "SuperAdmin") return false;
  const perms = getScreenPermission(req, screenKey);
  return Boolean(perms.own_records_only);
}

module.exports = {
  getScreenPermission,
  hasScreenAction,
  requireScreenAction,
  ownRecordsOnly,
};
