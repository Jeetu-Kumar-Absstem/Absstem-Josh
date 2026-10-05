const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { resolveTimelineFromQuery } = require("../services/timelineWindow");
const {
  getUnifiedExecutiveMetrics,
  getWorkingCapitalMetrics,
  getManufacturingMetrics,
  getCommercialServiceMetrics,
} = require("../services/executiveAnalytics");

const router = express.Router();

router.get("/dashboard-metrics", requireScreenAction("executive_command", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) {
      return res.status(400).json({
        ok: false,
        error: "COMPANY_NOT_SELECTED",
        detail: "Select a company context to load executive intelligence.",
      });
    }
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    const timeline = resolveTimelineFromQuery(req.query);
    const metrics = await getUnifiedExecutiveMetrics(pool, companyId, timeline);
    return res.json({
      ok: true,
      metrics,
      timeline: {
        preset: timeline.preset,
        date_from: timeline.dateFrom,
        date_to: timeline.dateTo,
        label: timeline.label,
        range_label: timeline.rangeLabel,
        hint: timeline.hint,
        timezone: timeline.timezone,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/working-capital", requireScreenAction("executive_command", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const timeline = resolveTimelineFromQuery(req.query);
    const data = await getWorkingCapitalMetrics(pool, companyId, timeline);
    return res.json({ ok: true, working_capital: data, timeline });
  } catch (error) {
    return next(error);
  }
});

router.get("/manufacturing", requireScreenAction("executive_command", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const timeline = resolveTimelineFromQuery(req.query);
    const data = await getManufacturingMetrics(pool, companyId, timeline);
    return res.json({ ok: true, manufacturing: data, timeline });
  } catch (error) {
    return next(error);
  }
});

router.get("/commercial-service", requireScreenAction("executive_command", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const timeline = resolveTimelineFromQuery(req.query);
    const data = await getCommercialServiceMetrics(pool, companyId, timeline);
    return res.json({ ok: true, commercial_service: data, timeline });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
