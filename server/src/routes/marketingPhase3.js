const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { loadTradeShowRoiRows } = require("../services/tradeShowRoi");

const router = express.Router();

const TRADE_STATUSES = new Set(["Planned", "Active", "Completed", "Closed"]);
const VOC_SOURCES = new Set(["Voice of Customer", "Voice of Channel"]);
const VOC_SEVERITIES = new Set(["Info", "Watch", "Critical"]);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cleanText(value, max = 4000) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

function toDateOnly(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  return text.slice(0, 10);
}

function cleanAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Number(Math.max(0, n).toFixed(2)) : 0;
}

router.use(requireAuth);

// ─── Trade show campaigns (ROI) ───────────────────────────────────────────────

router.get("/trade-shows", requireScreenAction("marketing", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const rows = await loadTradeShowRoiRows(pool, {
      companyId,
      campaignId: req.query.id || null,
    });
    return res.json({ ok: true, campaigns: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/trade-shows/:id/roi", requireScreenAction("marketing", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const rows = await loadTradeShowRoiRows(pool, {
      companyId,
      campaignId: req.params.id,
    });
    if (!rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, campaign: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/trade-shows", requireScreenAction("marketing", "can_create"), async (req, res, next) => {
  try {
    const eventName = cleanText(req.body?.event_name, 200);
    if (!eventName) return res.status(400).json({ ok: false, error: "EVENT_NAME_REQUIRED" });
    let status = String(req.body?.status || "Planned").trim();
    if (!TRADE_STATUSES.has(status)) status = "Planned";
    const companyId = requireResolvedCompanyId(req);

    const r = await pool.query(
      `
        insert into trade_show_campaigns (
          company_id, event_name, event_date, total_spend, status,
          marketing_exhibition_id, region, notes, created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        returning *
      `,
      [
        companyId,
        eventName,
        toDateOnly(req.body?.event_date),
        cleanAmount(req.body?.total_spend),
        status,
        asInt(req.body?.marketing_exhibition_id),
        cleanText(req.body?.region, 80),
        cleanText(req.body?.notes),
        req.user.id,
      ]
    );
    const rows = await loadTradeShowRoiRows(pool, { companyId, campaignId: r.rows[0].id });
    return res.status(201).json({ ok: true, campaign: rows[0] || r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.patch("/trade-shows/:id", requireScreenAction("marketing", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const cur = await pool.query(`select * from trade_show_campaigns where id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    let status = req.body?.status != null ? String(req.body.status).trim() : cur.rows[0].status;
    if (!TRADE_STATUSES.has(status)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });

    const r = await pool.query(
      `
        update trade_show_campaigns
        set
          event_name = coalesce($2, event_name),
          event_date = coalesce($3::date, event_date),
          total_spend = coalesce($4, total_spend),
          status = $5,
          marketing_exhibition_id = coalesce($6, marketing_exhibition_id),
          region = coalesce($7, region),
          notes = coalesce($8, notes),
          updated_at = now()
        where id = $1
        returning *
      `,
      [
        id,
        cleanText(req.body?.event_name, 200),
        toDateOnly(req.body?.event_date),
        req.body?.total_spend !== undefined ? cleanAmount(req.body.total_spend) : null,
        status,
        req.body?.marketing_exhibition_id !== undefined ? asInt(req.body.marketing_exhibition_id) : null,
        req.body?.region !== undefined ? cleanText(req.body.region, 80) : null,
        req.body?.notes !== undefined ? cleanText(req.body.notes) : null,
      ]
    );
    const companyId = requireResolvedCompanyId(req);
    const rows = await loadTradeShowRoiRows(pool, { companyId, campaignId: id });
    return res.json({ ok: true, campaign: rows[0] || r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/trade-shows/:id/attach-lead", requireScreenAction("marketing", "can_edit"), async (req, res, next) => {
  try {
    const campaignId = asInt(req.params.id);
    const leadId = asInt(req.body?.lead_id);
    if (!campaignId || !leadId) return res.status(400).json({ ok: false, error: "CAMPAIGN_AND_LEAD_REQUIRED" });

    const camp = await pool.query(`select id from trade_show_campaigns where id = $1`, [campaignId]);
    if (!camp.rows[0]) return res.status(404).json({ ok: false, error: "CAMPAIGN_NOT_FOUND" });

    const existing = await pool.query(`select id, trade_show_campaign_id from leads where id = $1`, [leadId]);
    if (!existing.rows[0]) return res.status(404).json({ ok: false, error: "LEAD_NOT_FOUND" });
    const already = asInt(existing.rows[0].trade_show_campaign_id);
    if (already && already !== campaignId) {
      return res.status(409).json({ ok: false, error: "LEAD_ALREADY_ATTRIBUTED" });
    }

    const lead = await pool.query(
      `
        update leads
        set trade_show_campaign_id = $2, updated_at = now()
        where id = $1
        returning id, status, trade_show_campaign_id
      `,
      [leadId, campaignId]
    );
    if (!lead.rows[0]) return res.status(404).json({ ok: false, error: "LEAD_NOT_FOUND" });
    return res.json({ ok: true, lead: lead.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/trade-shows/:id/detach-lead", requireScreenAction("marketing", "can_edit"), async (req, res, next) => {
  try {
    const campaignId = asInt(req.params.id);
    const leadId = asInt(req.body?.lead_id);
    if (!campaignId || !leadId) return res.status(400).json({ ok: false, error: "CAMPAIGN_AND_LEAD_REQUIRED" });

    const camp = await pool.query(`select id from trade_show_campaigns where id = $1`, [campaignId]);
    if (!camp.rows[0]) return res.status(404).json({ ok: false, error: "CAMPAIGN_NOT_FOUND" });

    const existing = await pool.query(`select id, trade_show_campaign_id from leads where id = $1`, [leadId]);
    if (!existing.rows[0]) return res.status(404).json({ ok: false, error: "LEAD_NOT_FOUND" });
    const attached = asInt(existing.rows[0].trade_show_campaign_id);
    if (!attached) {
      return res.status(409).json({ ok: false, error: "LEAD_NOT_ATTRIBUTED" });
    }
    if (attached !== campaignId) {
      return res.status(409).json({ ok: false, error: "LEAD_ALREADY_ATTRIBUTED" });
    }

    const lead = await pool.query(
      `
        update leads
        set trade_show_campaign_id = null, updated_at = now()
        where id = $1 and trade_show_campaign_id = $2
        returning id, status, trade_show_campaign_id
      `,
      [leadId, campaignId]
    );
    if (!lead.rows[0]) return res.status(404).json({ ok: false, error: "LEAD_NOT_FOUND" });
    return res.json({ ok: true, lead: lead.rows[0] });
  } catch (err) {
    return next(err);
  }
});

// ─── Voice of market ──────────────────────────────────────────────────────────

router.get("/voice-of-market", requireScreenAction("marketing", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    if (req.query.source_type) {
      params.push(String(req.query.source_type));
      where.push(`v.source_type = $${params.length}`);
    }
    if (req.query.strategic_category) {
      params.push(String(req.query.strategic_category).trim());
      where.push(`v.strategic_category = $${params.length}`);
    }
    const companyId = requireResolvedCompanyId(req);
    if (companyId) {
      params.push(companyId);
      where.push(`(v.company_id is null or v.company_id = $${params.length})`);
    }

    const r = await pool.query(
      `
        select
          v.*,
          c.customer_name as customer_name,
          d.company_name as distributor_name,
          u.full_name as submitted_by_name
        from voice_of_market_logs v
        left join customers c on c.id = v.customer_id
        left join distributors d on d.id = v.distributor_id
        left join erp_users u on u.id = v.submitted_by
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by v.created_at desc
        limit 500
      `,
      params
    );
    return res.json({ ok: true, logs: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/voice-of-market", requireScreenAction("marketing", "can_create"), async (req, res, next) => {
  try {
    const sourceType = String(req.body?.source_type || "").trim();
    const notes = cleanText(req.body?.feedback_notes);
    const category = cleanText(req.body?.strategic_category, 120);
    if (!VOC_SOURCES.has(sourceType)) return res.status(400).json({ ok: false, error: "INVALID_SOURCE_TYPE" });
    if (!notes) return res.status(400).json({ ok: false, error: "FEEDBACK_NOTES_REQUIRED" });
    if (!category) return res.status(400).json({ ok: false, error: "STRATEGIC_CATEGORY_REQUIRED" });

    let severity = String(req.body?.severity || "Info").trim();
    if (!VOC_SEVERITIES.has(severity)) severity = "Info";

    const companyId = requireResolvedCompanyId(req);
    const r = await pool.query(
      `
        insert into voice_of_market_logs (
          company_id, source_type, submitted_by, customer_id, distributor_id,
          feedback_notes, strategic_category, severity, is_highlighted
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        returning *
      `,
      [
        companyId,
        sourceType,
        req.user.id,
        asInt(req.body?.customer_id),
        asInt(req.body?.distributor_id),
        notes,
        category,
        severity,
        Boolean(req.body?.is_highlighted),
      ]
    );
    return res.status(201).json({ ok: true, log: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.patch("/voice-of-market/:id", requireScreenAction("marketing", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const cur = await pool.query(`select * from voice_of_market_logs where id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    let sourceType = req.body?.source_type != null ? String(req.body.source_type).trim() : cur.rows[0].source_type;
    if (!VOC_SOURCES.has(sourceType)) return res.status(400).json({ ok: false, error: "INVALID_SOURCE_TYPE" });
    let severity = req.body?.severity != null ? String(req.body.severity).trim() : cur.rows[0].severity;
    if (!VOC_SEVERITIES.has(severity)) return res.status(400).json({ ok: false, error: "INVALID_SEVERITY" });

    const r = await pool.query(
      `
        update voice_of_market_logs
        set
          source_type = $2,
          customer_id = coalesce($3, customer_id),
          distributor_id = coalesce($4, distributor_id),
          feedback_notes = coalesce($5, feedback_notes),
          strategic_category = coalesce($6, strategic_category),
          severity = $7,
          is_highlighted = coalesce($8, is_highlighted),
          updated_at = now()
        where id = $1
        returning *
      `,
      [
        id,
        sourceType,
        req.body?.customer_id !== undefined ? asInt(req.body.customer_id) : null,
        req.body?.distributor_id !== undefined ? asInt(req.body.distributor_id) : null,
        req.body?.feedback_notes !== undefined ? cleanText(req.body.feedback_notes) : null,
        req.body?.strategic_category !== undefined ? cleanText(req.body.strategic_category, 120) : null,
        severity,
        req.body?.is_highlighted !== undefined ? Boolean(req.body.is_highlighted) : null,
      ]
    );
    return res.json({ ok: true, log: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
