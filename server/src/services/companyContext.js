function getActiveCompanyId(req) {
  const id = Number(req?.ctx?.company_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function canAccessCompanyContext(req, row) {
  if (!row) return false;
  if (req?.user?.group_name === "SuperAdmin") return true;
  const activeCompanyId = getActiveCompanyId(req);
  if (!activeCompanyId) return false;
  return Number(row.company_id) === activeCompanyId;
}

function requireResolvedCompanyId(req, sourceCompanyId = null) {
  const activeCompanyId = getActiveCompanyId(req);
  if (activeCompanyId) return activeCompanyId;
  if (req?.user?.group_name === "SuperAdmin") {
    const fallback = Number(sourceCompanyId);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
  }
  return null;
}

module.exports = {
  canAccessCompanyContext,
  getActiveCompanyId,
  requireResolvedCompanyId,
};

