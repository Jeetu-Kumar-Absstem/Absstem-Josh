const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { ingestLead, resolveIngestEndpoint, hashIngestKey, normalizeChannel } = require("../services/leadIngest");

const router = express.Router();

async function requireIngestAuth(req, res, next) {
  if (req.user) return next();
  const key = String(req.headers["x-josh-ingest-key"] || req.headers["x-api-key"] || "").trim();
  if (!key) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  try {
    const endpoint = await resolveIngestEndpoint(pool, key);
    if (!endpoint) return res.status(401).json({ ok: false, error: "INVALID_INGEST_KEY" });
    req.ingestEndpoint = endpoint;
    req.ingestCompanyId = Number(endpoint.company_id);
    return next();
  } catch (err) {
    return next(err);
  }
}

function resolveCompany(req) {
  if (req.ingestCompanyId) return req.ingestCompanyId;
  return requireResolvedCompanyId(req);
}

async function handleIngest(req, res, next, channelHint) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const companyId = resolveCompany(req);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
    const endpoint = req.ingestEndpoint;
    if (endpoint) {
      if (!body.marketing_campaign_id && endpoint.default_campaign_id) {
        body.marketing_campaign_id = endpoint.default_campaign_id;
      }
      if (!body.lead_source_id && endpoint.default_source_id) {
        body.lead_source_id = endpoint.default_source_id;
      }
    }
    const channel = normalizeChannel(channelHint || body.channel || endpoint?.channel || "website");
    const result = await ingestLead(client, {
      companyId,
      actorId: req.user?.id || null,
      channel,
      body,
      mode: "ingest",
    });
    await client.query("commit");
    return res.status(result.appended ? 200 : 201).json(result);
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "LEAD_DUPLICATE_PHONE") {
      return res.status(409).json({
        ok: false,
        error: "LEAD_DUPLICATE_PHONE",
        message: "Existing lead found.",
        duplicates: err.duplicates || [],
      });
    }
    return next(err);
  } finally {
    client.release();
  }
}

router.post("/", requireIngestAuth, (req, res, next) => handleIngest(req, res, next, req.body?.channel));
router.post("/website", requireIngestAuth, (req, res, next) => handleIngest(req, res, next, "website"));
router.post("/google", requireIngestAuth, (req, res, next) => handleIngest(req, res, next, "google_lead_form"));
router.post("/meta", requireIngestAuth, (req, res, next) => handleIngest(req, res, next, "meta_lead_form"));
router.post("/linkedin", requireIngestAuth, (req, res, next) => handleIngest(req, res, next, "linkedin_lead_form"));
router.post("/whatsapp", requireIngestAuth, (req, res, next) => handleIngest(req, res, next, "whatsapp"));
router.post("/telephony", requireIngestAuth, (req, res, next) => handleIngest(req, res, next, "telephony_tollfree"));
router.post("/qr", requireIngestAuth, (req, res, next) => handleIngest(req, res, next, "qr_form"));

function requireSession(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireIngestAdmin(action) {
  return (req, res, next) => {
    if (
      hasScreenAction(req, "lead_ingestion", action) ||
      hasScreenAction(req, "marketing_desk", action)
    ) {
      return next();
    }
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  };
}

router.get("/endpoints", requireSession, requireIngestAdmin("can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await pool.query(
      `
        select id, channel, default_campaign_id, default_source_id, is_enabled, notes, created_at
        from lead_ingestion_endpoints
        where company_id = $1
        order by channel
      `,
      [companyId]
    );
    return res.json({ ok: true, endpoints: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/endpoints", requireSession, requireIngestAdmin("can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const channel = normalizeChannel(body.channel);
    const plain = crypto.randomBytes(24).toString("hex");
    const { rows } = await pool.query(
      `
        insert into lead_ingestion_endpoints (
          company_id, channel, api_key_hash, default_campaign_id, default_source_id, notes, is_enabled
        )
        values ($1,$2,$3,$4,$5,$6,true)
        on conflict (company_id, channel) do update
        set
          api_key_hash = excluded.api_key_hash,
          default_campaign_id = coalesce(excluded.default_campaign_id, lead_ingestion_endpoints.default_campaign_id),
          default_source_id = coalesce(excluded.default_source_id, lead_ingestion_endpoints.default_source_id),
          notes = coalesce(excluded.notes, lead_ingestion_endpoints.notes),
          is_enabled = true,
          updated_at = now()
        returning id, channel, default_campaign_id, default_source_id, is_enabled
      `,
      [
        companyId,
        channel,
        hashIngestKey(plain),
        Number.isFinite(Number(body.default_campaign_id)) ? Number(body.default_campaign_id) : null,
        Number.isFinite(Number(body.default_source_id)) ? Number(body.default_source_id) : null,
        typeof body.notes === "string" ? body.notes.trim() : null,
      ]
    );
    return res.status(201).json({ ok: true, endpoint: rows[0], api_key: plain });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
