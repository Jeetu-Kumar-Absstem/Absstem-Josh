const express = require("express");
const crypto = require("crypto");

const { pool } = require("../db/pool");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { markMailAccountUsed, resolveEffectiveMailSource } = require("../services/mailAccounts");
const { sendMail } = require("../services/mailer");
const { loadCampaignRoi } = require("../services/campaignRoi");
const { previewDormancy, runDormancyScan, syncBrevoSegment } = require("../services/dormancyBrevo");
const { recordMarketingMailEvent } = require("../services/leadScoring");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function cleanDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function cleanAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
}

function normalizeCampaignChannel(value) {
  const allowed = new Set(["social_media", "google_ads", "email", "whatsapp", "referral", "other"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "social_media";
}

function normalizeCampaignStatus(value) {
  const allowed = new Set(["planned", "live", "paused", "closed"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "planned";
}

function normalizeExhibitionStatus(value) {
  const allowed = new Set(["planned", "upcoming", "live", "follow_up", "closed"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "planned";
}

function normalizeExhibitionCollaborationMode(value) {
  const allowed = new Set(["company", "joint"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "company";
}

function normalizeExhibitionCostSplitMode(value) {
  const allowed = new Set(["company", "distributor", "shared"]);
  const raw = String(value || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : "shared";
}

function normalizeEmailAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function splitEmailList(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const seen = new Set();
  const out = [];
  for (const part of raw.split(/[;,]+/)) {
    const email = normalizeEmailAddress(part);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function joinEmailList(value) {
  return splitEmailList(value).join(", ");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getAppBaseUrl() {
  return String(process.env.APP_BASE_URL || "http://localhost:5173").trim().replace(/\/+$/, "");
}

function buildMarketingMailTrackingToken() {
  return crypto.randomBytes(24).toString("hex");
}

function buildMarketingMailOpenUrl(token) {
  const key = String(token || "").trim();
  if (!key) return "";
  return `${getAppBaseUrl()}/marketing/mail/open/${encodeURIComponent(key)}`;
}

function buildMarketingMailClickUrl(token, url) {
  const key = String(token || "").trim();
  const target = String(url || "").trim();
  if (!key || !target) return target;
  return `${getAppBaseUrl()}/marketing/mail/click/${encodeURIComponent(key)}?url=${encodeURIComponent(target)}`;
}

function buildMarketingUnsubscribeUrl(token) {
  const key = String(token || "").trim();
  if (!key) return "";
  return `${getAppBaseUrl()}/marketing/mail/unsubscribe/${encodeURIComponent(key)}`;
}

function renderTextAsHtml(text) {
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.7; color: #1f2937; white-space: pre-wrap;">${escapeHtml(
    text || ""
  ).replaceAll("\n", "<br/>")}</div>`;
}

function requireAnyMarketingView(req, res, next) {
  if (
    hasScreenAction(req, "marketing_desk", "can_view") ||
    hasScreenAction(req, "campaigns", "can_view") ||
    hasScreenAction(req, "exhibitions", "can_view") ||
    hasScreenAction(req, "source_performance", "can_view") ||
    hasScreenAction(req, "marketing_mailers", "can_view")
  ) {
    return next();
  }
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

async function loadCampaignRows(companyId) {
  const { rows } = await pool.query(
    `
      with quote_rollup as (
        select
          qh.lead_id,
          count(distinct qh.id)::int as quote_count,
          coalesce(sum(coalesce(qr.grand_total_quote, 0)), 0)::numeric(14, 2) as quote_value
        from quote_headers qh
        left join quote_revisions qr
          on qr.quote_id = qh.id
         and qr.is_latest = true
        where qh.lead_id is not null
        group by qh.lead_id
      ),
      order_rollup as (
        select
          qh.lead_id,
          count(distinct so.id)::int as sales_order_count,
          coalesce(sum(coalesce(so.grand_total_order, 0)), 0)::numeric(14, 2) as order_value
        from sales_orders so
        left join quote_revisions qr on qr.id = so.quote_revision_id
        left join quote_headers qh on qh.id = qr.quote_id
        where qh.lead_id is not null
        group by qh.lead_id
      )
      select
        c.id,
        c.campaign_name,
        c.channel_type,
        c.city,
        c.start_date,
        c.end_date,
        c.planned_budget,
        c.actual_spend,
        c.campaign_status as status,
        c.agency_name,
        coalesce(c.notes, '') as notes,
        ls.source_name as lead_source_name,
        count(distinct l.id)::int as lead_count,
        count(distinct l.id) filter (
          where l.customer_id is not null
             or l.converted_customer_id is not null
             or l.converted_quote_id is not null
             or l.converted_sales_order_id is not null
        )::int as fruitful_leads,
        count(distinct coalesce(l.customer_id, l.converted_customer_id))::int as customer_count,
        coalesce(sum(coalesce(q.quote_count, 0)), 0)::int as quote_count,
        coalesce(sum(coalesce(q.quote_value, 0)), 0)::numeric(14, 2) as quote_value,
        coalesce(sum(coalesce(o.sales_order_count, 0)), 0)::int as sales_order_count,
        coalesce(sum(coalesce(o.order_value, 0)), 0)::numeric(14, 2) as order_value
      from marketing_campaigns c
      left join lead_sources ls on ls.id = c.lead_source_id
      left join leads l
        on l.company_id = c.company_id
       and l.marketing_campaign_id = c.id
      left join quote_rollup q on q.lead_id = l.id
      left join order_rollup o on o.lead_id = l.id
      where c.company_id = $1
      group by
        c.id,
        c.campaign_name,
        c.channel_type,
        c.city,
        c.start_date,
        c.end_date,
        c.planned_budget,
        c.actual_spend,
        c.campaign_status,
        c.agency_name,
        c.notes,
        ls.source_name
      order by c.start_date desc nulls last, c.updated_at desc, c.id desc
    `,
    [companyId]
  );
  return rows;
}

async function loadExhibitionRows(companyId) {
  const { rows } = await pool.query(
    `
      with quote_rollup as (
        select
          qh.lead_id,
          count(distinct qh.id)::int as quote_count,
          coalesce(sum(coalesce(qr.grand_total_quote, 0)), 0)::numeric(14, 2) as quote_value
        from quote_headers qh
        left join quote_revisions qr
          on qr.quote_id = qh.id
         and qr.is_latest = true
        where qh.lead_id is not null
        group by qh.lead_id
      ),
      order_rollup as (
        select
          qh.lead_id,
          count(distinct so.id)::int as sales_order_count,
          coalesce(sum(coalesce(so.grand_total_order, 0)), 0)::numeric(14, 2) as order_value
        from sales_orders so
        left join quote_revisions qr on qr.id = so.quote_revision_id
        left join quote_headers qh on qh.id = qr.quote_id
        where qh.lead_id is not null
        group by qh.lead_id
      )
      select
        e.id,
        e.exhibition_name,
        e.distributor_id,
        d.company_name as distributor_name,
        e.collaboration_mode,
        e.cost_split_mode,
        e.city,
        e.venue,
        e.stall_no,
        e.organizer_name,
        e.start_date,
        e.end_date,
        e.planned_budget,
        e.actual_spend,
        e.distributor_spend,
        (coalesce(e.actual_spend, 0) + coalesce(e.distributor_spend, 0))::numeric(14, 2) as total_spend,
        e.exhibition_status as status,
        coalesce(e.notes, '') as notes,
        ls.source_name as lead_source_name,
        count(distinct l.id)::int as lead_count,
        count(distinct l.id) filter (
          where l.customer_id is not null
             or l.converted_customer_id is not null
             or l.converted_quote_id is not null
             or l.converted_sales_order_id is not null
        )::int as fruitful_leads,
        count(distinct coalesce(l.customer_id, l.converted_customer_id))::int as customer_count,
        coalesce(sum(coalesce(q.quote_count, 0)), 0)::int as quote_count,
        coalesce(sum(coalesce(q.quote_value, 0)), 0)::numeric(14, 2) as quote_value,
        coalesce(sum(coalesce(o.sales_order_count, 0)), 0)::int as sales_order_count,
        coalesce(sum(coalesce(o.order_value, 0)), 0)::numeric(14, 2) as order_value
      from marketing_exhibitions e
      left join lead_sources ls on ls.id = e.lead_source_id
      left join distributors d on d.id = e.distributor_id
      left join leads l
        on l.company_id = e.company_id
       and l.marketing_exhibition_id = e.id
      left join quote_rollup q on q.lead_id = l.id
      left join order_rollup o on o.lead_id = l.id
      where e.company_id = $1
      group by
        e.id,
        e.exhibition_name,
        e.distributor_id,
        d.company_name,
        e.collaboration_mode,
        e.cost_split_mode,
        e.city,
        e.venue,
        e.stall_no,
        e.organizer_name,
        e.start_date,
        e.end_date,
        e.planned_budget,
        e.actual_spend,
        e.distributor_spend,
        e.exhibition_status,
        e.notes,
        ls.source_name
      order by e.start_date desc nulls last, e.updated_at desc, e.id desc
    `,
    [companyId]
  );
  return rows;
}

router.get("/mail/open/:trackingToken", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const token = String(req.params.trackingToken || "").trim();
    if (!token) return res.status(404).end();

    await client.query(
      `
        update marketing_mail_logs
        set opened_at = coalesce(opened_at, now()),
            last_opened_at = now(),
            open_count = coalesce(open_count, 0) + 1
        where tracking_token = $1
      `,
      [token]
    );
    await recordMarketingMailEvent(client, token, "marketing_mail_open").catch(() => {});

    const pixel = Buffer.from(
      "R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
      "base64"
    );
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.status(200).send(pixel);
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/mail/click/:trackingToken", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const token = String(req.params.trackingToken || "").trim();
    const urlRaw = String(req.query?.url || "").trim();
    if (!token || !urlRaw) return res.status(400).send("Invalid link");

    let safeUrl = "";
    try {
      const parsed = new URL(urlRaw);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("bad");
      safeUrl = parsed.toString();
    } catch {
      return res.status(400).send("Invalid link");
    }

    await client.query(
      `
        update marketing_mail_logs
        set clicked_at = coalesce(clicked_at, now()),
            last_clicked_at = now(),
            click_count = coalesce(click_count, 0) + 1
        where tracking_token = $1
      `,
      [token]
    );
    await recordMarketingMailEvent(client, token, "marketing_mail_click").catch(() => {});

    return res.redirect(302, safeUrl);
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/mail/unsubscribe/:unsubscribeToken", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const token = String(req.params.unsubscribeToken || "").trim();
    if (!token) return res.status(400).send("Invalid unsubscribe link");

    const logRes = await client.query(
      `
        select to_email
        from marketing_mail_logs
        where unsubscribe_token = $1
        limit 1
      `,
      [token]
    );
    const email = String(logRes.rows[0]?.to_email || "").trim();
    if (!email) return res.status(404).send("Invalid unsubscribe link");

    await client.query(
      `
        insert into email_opt_outs (email, reason, source)
        values ($1, 'Marketing unsubscribe', 'unsubscribe_link')
        on conflict (email) do update
        set opted_out_at = now(),
            reason = excluded.reason,
            source = excluded.source
      `,
      [email]
    );

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send("You have been unsubscribed from marketing emails.");
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.use(requireAuth);

router.get("/bootstrap", requireAnyMarketingView, async (_req, res, next) => {
  try {
    const [sourceRes, distributorRes, campaignRes, exhibitionRes] = await Promise.all([
      pool.query(
      `
        select id, source_code, source_name
        from lead_sources
        where is_active = true
        order by source_name
      `
      ),
      pool.query(
        `
          select id, distributor_code, company_name, contact_email
          from distributors
          where is_active = true
          order by company_name
        `
      ),
      pool.query(
        `
          select id, campaign_name, channel_type, campaign_status
          from marketing_campaigns
          where company_id = $1
          order by start_date desc nulls last, updated_at desc, id desc
          limit 200
        `,
        [requireResolvedCompanyId(_req)]
      ),
      pool.query(
        `
          select id, exhibition_name, city, exhibition_status
          from marketing_exhibitions
          where company_id = $1
          order by start_date desc nulls last, updated_at desc, id desc
          limit 200
        `,
        [requireResolvedCompanyId(_req)]
      ),
    ]);
    return res.json({
      ok: true,
      lead_sources: sourceRes.rows,
      distributors: distributorRes.rows,
      campaigns: campaignRes.rows,
      exhibitions: exhibitionRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/desk", requireAnyMarketingView, async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const [campaigns, exhibitions] = await Promise.all([loadCampaignRows(companyId), loadExhibitionRows(companyId)]);

    const summary = {
      live_campaigns: campaigns.filter((row) => row.status === "live").length,
      open_exhibitions: exhibitions.filter((row) => ["upcoming", "live", "follow_up"].includes(String(row.status || "").toLowerCase())).length,
      attributed_leads:
        campaigns.reduce((sum, row) => sum + Number(row.lead_count || 0), 0) +
        exhibitions.reduce((sum, row) => sum + Number(row.lead_count || 0), 0),
      fruitful_leads:
        campaigns.reduce((sum, row) => sum + Number(row.fruitful_leads || 0), 0) +
        exhibitions.reduce((sum, row) => sum + Number(row.fruitful_leads || 0), 0),
      quote_value:
        campaigns.reduce((sum, row) => sum + Number(row.quote_value || 0), 0) +
        exhibitions.reduce((sum, row) => sum + Number(row.quote_value || 0), 0),
      order_value:
        campaigns.reduce((sum, row) => sum + Number(row.order_value || 0), 0) +
        exhibitions.reduce((sum, row) => sum + Number(row.order_value || 0), 0),
    };

    const campaignAlerts = campaigns
      .filter((row) => Number(row.actual_spend || 0) > 0 && Number(row.fruitful_leads || 0) === 0)
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        type: "campaign",
        title: row.campaign_name,
        issue:
          Number(row.lead_count || 0) === 0
            ? "Spend recorded but no leads linked yet"
            : "Leads captured but no fruitful movement yet",
        action: "Open Campaigns",
        status: row.status,
        spend: Number(row.actual_spend || 0),
      }));

    const exhibitionAlerts = exhibitions
      .filter((row) => ["follow_up", "live", "upcoming"].includes(String(row.status || "").toLowerCase()) && Number(row.fruitful_leads || 0) === 0)
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        type: "exhibition",
        title: row.exhibition_name,
        issue:
          Number(row.lead_count || 0) === 0
            ? "No leads linked to this exhibition yet"
            : "Post-event follow-up has not turned fruitful yet",
        action: "Open Exhibitions",
        status: row.status,
        spend: Number(row.total_spend || row.actual_spend || 0),
      }));

    return res.json({
      ok: true,
      summary,
      campaign_alerts: campaignAlerts,
      exhibition_alerts: exhibitionAlerts,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/campaigns", requireScreenAction("campaigns", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const rows = await loadCampaignRows(companyId);
    return res.json({ ok: true, campaigns: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/campaigns", requireScreenAction("campaigns", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const campaignName = cleanText(req.body?.campaign_name);
    const channelType = normalizeCampaignChannel(req.body?.channel_type);
    const leadSourceId = Number(req.body?.lead_source_id);
    const city = cleanText(req.body?.city);
    const startDate = cleanDate(req.body?.start_date);
    const endDate = cleanDate(req.body?.end_date);
    const plannedBudget = cleanAmount(req.body?.planned_budget);
    const actualSpend = cleanAmount(req.body?.actual_spend);
    const status = normalizeCampaignStatus(req.body?.campaign_status);
    const agencyName = cleanText(req.body?.agency_name);
    const notes = cleanText(req.body?.notes);
    if (!campaignName) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

    const { rows } = await client.query(
      `
        insert into marketing_campaigns (
          company_id,
          campaign_name,
          channel_type,
          lead_source_id,
          city,
          start_date,
          end_date,
          planned_budget,
          actual_spend,
          campaign_status,
          agency_name,
          notes,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        returning id
      `,
      [
        companyId,
        campaignName,
        channelType,
        Number.isFinite(leadSourceId) ? leadSourceId : null,
        city,
        startDate,
        endDate,
        plannedBudget,
        actualSpend,
        status,
        agencyName,
        notes,
        req.user.id,
      ]
    );

    const createdRows = await loadCampaignRows(companyId);
    const created = createdRows.find((row) => Number(row.id) === Number(rows[0]?.id)) || null;
    return res.status(201).json({ ok: true, campaign: created });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.patch("/campaigns/:id", requireScreenAction("campaigns", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const status = normalizeCampaignStatus(req.body?.campaign_status);
    const actualSpend = cleanAmount(req.body?.actual_spend);
    const notes = cleanText(req.body?.notes);

    const { rowCount } = await client.query(
      `
        update marketing_campaigns
        set campaign_status = $3,
            actual_spend = case when $4 > 0 then $4 else actual_spend end,
            notes = coalesce($5, notes),
            utm_source = coalesce($7, utm_source),
            utm_medium = coalesce($8, utm_medium),
            utm_campaign = coalesce($9, utm_campaign),
            updated_by = $6,
            updated_at = now()
        where id = $1
          and company_id = $2
      `,
      [
        id,
        companyId,
        status,
        actualSpend,
        notes,
        req.user.id,
        cleanText(req.body?.utm_source),
        cleanText(req.body?.utm_medium),
        cleanText(req.body?.utm_campaign),
      ]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: "CAMPAIGN_NOT_FOUND" });
    const rows = await loadCampaignRows(companyId);
    const campaign = rows.find((row) => Number(row.id) === id) || null;
    return res.json({ ok: true, campaign });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/exhibitions", requireScreenAction("exhibitions", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const rows = await loadExhibitionRows(companyId);
    return res.json({ ok: true, exhibitions: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/exhibitions", requireScreenAction("exhibitions", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const exhibitionName = cleanText(req.body?.exhibition_name);
    const city = cleanText(req.body?.city);
    const venue = cleanText(req.body?.venue);
    const stallNo = cleanText(req.body?.stall_no);
    const organizerName = cleanText(req.body?.organizer_name);
    const distributorId =
      req.body?.distributor_id === null || req.body?.distributor_id === undefined ? null : Number(req.body?.distributor_id);
    const collaborationMode = normalizeExhibitionCollaborationMode(req.body?.collaboration_mode);
    const costSplitMode = normalizeExhibitionCostSplitMode(req.body?.cost_split_mode);
    const leadSourceId = Number(req.body?.lead_source_id);
    const startDate = cleanDate(req.body?.start_date);
    const endDate = cleanDate(req.body?.end_date);
    const plannedBudget = cleanAmount(req.body?.planned_budget);
    const actualSpend = cleanAmount(req.body?.actual_spend);
    const distributorSpend = cleanAmount(req.body?.distributor_spend);
    const status = normalizeExhibitionStatus(req.body?.exhibition_status);
    const notes = cleanText(req.body?.notes);
    if (!exhibitionName) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

    const { rows } = await client.query(
      `
        insert into marketing_exhibitions (
          company_id,
          exhibition_name,
          distributor_id,
          collaboration_mode,
          cost_split_mode,
          city,
          venue,
          stall_no,
          organizer_name,
          lead_source_id,
          start_date,
          end_date,
          planned_budget,
          actual_spend,
          distributor_spend,
          exhibition_status,
          notes,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
        returning id
      `,
      [
        companyId,
        exhibitionName,
        Number.isFinite(distributorId) ? distributorId : null,
        collaborationMode,
        costSplitMode,
        city,
        venue,
        stallNo,
        organizerName,
        Number.isFinite(leadSourceId) ? leadSourceId : null,
        startDate,
        endDate,
        plannedBudget,
        actualSpend,
        distributorSpend,
        status,
        notes,
        req.user.id,
      ]
    );

    const createdRows = await loadExhibitionRows(companyId);
    const exhibition = createdRows.find((row) => Number(row.id) === Number(rows[0]?.id)) || null;
    return res.status(201).json({ ok: true, exhibition });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.patch("/exhibitions/:id", requireScreenAction("exhibitions", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const status = normalizeExhibitionStatus(req.body?.exhibition_status);
    const actualSpend = cleanAmount(req.body?.actual_spend);
    const distributorSpend = cleanAmount(req.body?.distributor_spend);
    const distributorId =
      req.body?.distributor_id === null || req.body?.distributor_id === undefined ? null : Number(req.body?.distributor_id);
    const collaborationMode = normalizeExhibitionCollaborationMode(req.body?.collaboration_mode);
    const costSplitMode = normalizeExhibitionCostSplitMode(req.body?.cost_split_mode);
    const notes = cleanText(req.body?.notes);

    const { rowCount } = await client.query(
      `
        update marketing_exhibitions
        set exhibition_status = $3,
            actual_spend = case when $4 > 0 then $4 else actual_spend end,
            distributor_spend = case when $5 > 0 then $5 else distributor_spend end,
            distributor_id = $6,
            collaboration_mode = $7,
            cost_split_mode = $8,
            notes = coalesce($9, notes),
            updated_by = $10,
            updated_at = now()
        where id = $1
          and company_id = $2
      `,
      [
        id,
        companyId,
        status,
        actualSpend,
        distributorSpend,
        Number.isFinite(distributorId) ? distributorId : null,
        collaborationMode,
        costSplitMode,
        notes,
        req.user.id,
      ]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: "EXHIBITION_NOT_FOUND" });
    const rows = await loadExhibitionRows(companyId);
    const exhibition = rows.find((row) => Number(row.id) === id) || null;
    return res.json({ ok: true, exhibition });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/source-performance", requireScreenAction("source_performance", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const [campaigns, exhibitions] = await Promise.all([loadCampaignRows(companyId), loadExhibitionRows(companyId)]);
    const roiById = {};
    await Promise.all(
      campaigns.map(async (row) => {
        try {
          roiById[row.id] = await loadCampaignRoi(pool, companyId, row.id);
        } catch {
          roiById[row.id] = null;
        }
      })
    );

    const rows = [
      ...campaigns.map((row) => {
        const roi = roiById[row.id] || {};
        return {
          id: row.id,
          source_type: "campaign",
          source_name: row.campaign_name,
          channel_or_city: row.channel_type,
          status: row.status,
          spend: Number(row.actual_spend || 0),
          planned_budget: Number(row.planned_budget || 0),
          lead_count: Number(roi.lead_count ?? row.lead_count ?? 0),
          mql_count: Number(roi.mql_count || 0),
          sql_count: Number(roi.sql_count || 0),
          fruitful_leads: Number(row.fruitful_leads || 0),
          customer_count: Number(row.customer_count || 0),
          quote_count: Number(row.quote_count || 0),
          sales_order_count: Number(roi.sales_order_count ?? row.sales_order_count ?? 0),
          quote_value: Number(row.quote_value || 0),
          order_value: Number(roi.order_value ?? row.order_value ?? 0),
          cost_per_lead: Number(roi.cpl || 0),
          cost_per_mql: Number(roi.cost_per_mql || 0),
          cost_per_sql: Number(roi.cost_per_sql || 0),
          cost_per_order: Number(roi.cost_per_order || 0),
          cost_per_fruitful: Number(row.fruitful_leads || 0) > 0 ? Number(row.actual_spend || 0) / Number(row.fruitful_leads || 0) : 0,
          roi: Number(roi.roi || 0),
          attribution: "first_touch",
        };
      }),
      ...exhibitions.map((row) => ({
        id: row.id,
        source_type: "exhibition",
        source_name: row.exhibition_name,
        channel_or_city: row.city || row.venue || "",
        status: row.status,
        spend: Number(row.total_spend || row.actual_spend || 0),
        planned_budget: Number(row.planned_budget || 0),
        lead_count: Number(row.lead_count || 0),
        fruitful_leads: Number(row.fruitful_leads || 0),
        customer_count: Number(row.customer_count || 0),
        quote_count: Number(row.quote_count || 0),
        sales_order_count: Number(row.sales_order_count || 0),
        quote_value: Number(row.quote_value || 0),
        order_value: Number(row.order_value || 0),
        cost_per_lead:
          Number(row.lead_count || 0) > 0
            ? Number(row.total_spend || row.actual_spend || 0) / Number(row.lead_count || 0)
            : 0,
        cost_per_fruitful:
          Number(row.fruitful_leads || 0) > 0
            ? Number(row.total_spend || row.actual_spend || 0) / Number(row.fruitful_leads || 0)
            : 0,
      })),
    ].sort((a, b) => b.order_value - a.order_value || b.quote_value - a.quote_value || b.lead_count - a.lead_count);

    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

async function loadMailerRows(companyId) {
  const { rows } = await pool.query(
    `
      select
        m.id,
        m.mailer_name,
        m.mailer_type,
        m.subject,
        m.include_event_details,
        m.campaign_id,
        mc.campaign_name,
        m.exhibition_id,
        me.exhibition_name,
        m.mailer_status,
        m.created_at,
        m.updated_at,
        count(l.id)::int as sent_count,
        coalesce(sum(l.open_count), 0)::int as open_count,
        coalesce(sum(l.click_count), 0)::int as click_count
      from marketing_mailers m
      left join marketing_campaigns mc on mc.id = m.campaign_id
      left join marketing_exhibitions me on me.id = m.exhibition_id
      left join marketing_mail_logs l on l.mailer_id = m.id
      where m.company_id = $1
      group by
        m.id,
        m.mailer_name,
        m.mailer_type,
        m.subject,
        m.include_event_details,
        m.campaign_id,
        mc.campaign_name,
        m.exhibition_id,
        me.exhibition_name,
        m.mailer_status,
        m.created_at,
        m.updated_at
      order by m.created_at desc, m.id desc
      limit 200
    `,
    [companyId]
  );
  return rows;
}

async function loadMailerDetail(companyId, mailerId) {
  const { rows } = await pool.query(
    `
      select
        m.*,
        mc.campaign_name,
        me.exhibition_name
      from marketing_mailers m
      left join marketing_campaigns mc on mc.id = m.campaign_id
      left join marketing_exhibitions me on me.id = m.exhibition_id
      where m.company_id = $1
        and m.id = $2
      limit 1
    `,
    [companyId, mailerId]
  );
  return rows[0] || null;
}

async function loadMailerLogs(companyId, mailerId) {
  const { rows } = await pool.query(
    `
      select
        id,
        to_email,
        sent_at,
        error_text,
        opened_at,
        last_opened_at,
        open_count,
        clicked_at,
        last_clicked_at,
        click_count
      from marketing_mail_logs
      where company_id = $1
        and mailer_id = $2
      order by sent_at desc, id desc
      limit 300
    `,
    [companyId, mailerId]
  );
  return rows;
}

async function collectOptOutEmails(client, emails) {
  const list = Array.isArray(emails) ? emails.map((e) => normalizeEmailAddress(e)).filter(Boolean) : [];
  if (!list.length) return new Set();
  const { rows } = await client.query(
    `
      select lower(email::text) as email
      from email_opt_outs
      where lower(email::text) = any($1::text[])
    `,
    [list]
  );
  return new Set(rows.map((row) => String(row.email || "").trim()).filter(Boolean));
}

async function resolveAudienceEmails(client, companyId, payload) {
  const mode = String(payload?.audience_type || "").trim().toLowerCase();
  if (mode === "custom") {
    return splitEmailList(payload?.custom_emails || "");
  }

  if (mode === "distributor") {
    const distributorId = Number(payload?.distributor_id);
    if (!Number.isFinite(distributorId)) {
      const err = new Error("DISTRIBUTOR_REQUIRED");
      err.status = 400;
      throw err;
    }
    const { rows } = await client.query(
      `
        select contact_email
        from distributors
        where id = $1
          and is_active = true
        limit 1
      `,
      [distributorId]
    );
    const email = normalizeEmailAddress(rows[0]?.contact_email || "");
    return email ? [email] : [];
  }

  if (mode === "customers") {
    const { rows } = await client.query(
      `
        select distinct lower(email::text) as email
        from (
          select c.email
          from customers c
          join customer_company_links l
            on l.customer_id = c.id
           and l.company_id = $1
           and l.is_active = true
          where c.email is not null
          union
          select cc.email
          from customer_contacts cc
          join customers c on c.id = cc.customer_id
          join customer_company_links l
            on l.customer_id = c.id
           and l.company_id = $1
           and l.is_active = true
          where cc.email is not null
            and coalesce(cc.is_active, true) = true
        ) x
        where email is not null
      `,
      [companyId]
    );
    return rows.map((r) => normalizeEmailAddress(r.email)).filter(Boolean);
  }

  if (mode === "leads") {
    const { rows } = await client.query(
      `
        select distinct lower(lc.email::text) as email
        from lead_contacts lc
        join leads l on l.id = lc.lead_id
        where l.company_id = $1
          and lc.email is not null
      `,
      [companyId]
    );
    return rows.map((r) => normalizeEmailAddress(r.email)).filter(Boolean);
  }

  const err = new Error("AUDIENCE_NOT_SELECTED");
  err.status = 400;
  throw err;
}

function buildMailerEventHtml(exhibition) {
  if (!exhibition) return "";
  const name = escapeHtml(exhibition.exhibition_name || "");
  const city = escapeHtml(exhibition.city || "");
  const venue = escapeHtml(exhibition.venue || "");
  const stall = escapeHtml(exhibition.stall_no || "");
  const start = escapeHtml(exhibition.start_date || "");
  const end = escapeHtml(exhibition.end_date || "");
  const distributorName = escapeHtml(exhibition.distributor_name || "");
  const jointLabel = exhibition.collaboration_mode === "joint" ? "Joint exhibition with distributor" : "";
  const jointDetail = jointLabel && distributorName ? `${jointLabel}: ${distributorName}` : jointLabel;
  const parts = [
    name ? `<div style="font-weight:800; font-size:14px; margin-bottom:6px;">Upcoming event</div><div style="font-weight:800; font-size:15px; margin-bottom:6px;">${name}</div>` : "",
    [city, venue].filter(Boolean).join(" • "),
    stall ? `Stall: ${stall}` : "",
    start && end ? `Dates: ${start} to ${end}` : start ? `Date: ${start}` : "",
    jointDetail,
  ]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!parts.length) return "";
  return `
    <div style="margin-top:18px; border:1px solid #e6ebf2; border-radius:14px; padding:14px; background:#fbfcff;">
      <div style="font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.6; color:#0f172a;">
        ${parts.map((p) => `<div style="margin-bottom:6px;">${p}</div>`).join("")}
      </div>
    </div>
  `;
}

function buildMailerHtml({ bodyText, trackingToken, unsubscribeToken, exhibition }) {
  const trackingUrl = buildMarketingMailOpenUrl(trackingToken);
  const unsubscribeUrl = buildMarketingUnsubscribeUrl(unsubscribeToken);
  const raw = String(bodyText || "");
  const htmlBody = renderTextAsHtml(raw).replaceAll(
    /(https?:\/\/[^\s<>"']+)/g,
    (match) => `<a href="${escapeHtml(buildMarketingMailClickUrl(trackingToken, match))}" target="_blank" rel="noreferrer">${escapeHtml(match)}</a>`
  );
  const footer = unsubscribeUrl
    ? `<div style="margin-top:18px; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.6; color:#6b7280;">
        <div>If you do not want to receive marketing updates, you can unsubscribe here:</div>
        <div><a href="${escapeHtml(unsubscribeUrl)}" target="_blank" rel="noreferrer" style="color:#2354d5;">Unsubscribe</a></div>
      </div>`
    : "";
  const trackingPixelHtml = trackingUrl
    ? `<img src="${escapeHtml(trackingUrl)}" alt="" width="1" height="1" style="display:block; width:1px; height:1px; border:0; opacity:0; overflow:hidden;" />`
    : "";
  return `
    <div style="background:#f5f7fb; padding:18px;">
      <div style="max-width:720px; margin:0 auto; background:#ffffff; border:1px solid #e6ebf2; border-radius:18px; padding:18px;">
        ${htmlBody}
        ${buildMailerEventHtml(exhibition)}
        ${footer}
        ${trackingPixelHtml}
      </div>
    </div>
  `;
}

router.get("/mailers", requireScreenAction("marketing_mailers", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const rows = await loadMailerRows(companyId);
    return res.json({ ok: true, mailers: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/mailers/:id", requireScreenAction("marketing_mailers", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const mailer = await loadMailerDetail(companyId, id);
    if (!mailer) return res.status(404).json({ ok: false, error: "MAILER_NOT_FOUND" });
    const logs = await loadMailerLogs(companyId, id);
    return res.json({ ok: true, mailer, logs });
  } catch (err) {
    return next(err);
  }
});

router.post("/mailers", requireScreenAction("marketing_mailers", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const mailerName = cleanText(req.body?.mailer_name);
    const mailerType = String(req.body?.mailer_type || "newsletter").trim().toLowerCase();
    const subject = cleanText(req.body?.subject);
    const bodyText = String(req.body?.body_text || "").trim();
    const includeEventDetails = req.body?.include_event_details === true || req.body?.include_event_details === "true";
    const campaignId = Number(req.body?.campaign_id);
    const exhibitionId = Number(req.body?.exhibition_id);
    if (!mailerName || !subject || !bodyText) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    if (!["newsletter", "event_awareness"].includes(mailerType)) return res.status(400).json({ ok: false, error: "INVALID_TYPE" });

    const { rows } = await client.query(
      `
        insert into marketing_mailers (
          company_id,
          mailer_name,
          mailer_type,
          subject,
          body_text,
          include_event_details,
          campaign_id,
          exhibition_id,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        returning id
      `,
      [
        companyId,
        mailerName,
        mailerType,
        subject,
        bodyText,
        includeEventDetails,
        Number.isFinite(campaignId) ? campaignId : null,
        Number.isFinite(exhibitionId) ? exhibitionId : null,
        req.user.id,
      ]
    );

    const created = await loadMailerDetail(companyId, Number(rows[0]?.id));
    return res.status(201).json({ ok: true, mailer: created });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/mailers/:id/send", requireScreenAction("marketing_mailers", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const mailer = await loadMailerDetail(companyId, id);
    if (!mailer) return res.status(404).json({ ok: false, error: "MAILER_NOT_FOUND" });

    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const recipientsRaw = await resolveAudienceEmails(client, companyId, payload);
    const uniqueRecipients = Array.from(new Set(recipientsRaw.map((e) => normalizeEmailAddress(e)).filter(Boolean)));
    if (!uniqueRecipients.length) return res.status(400).json({ ok: false, error: "NO_RECIPIENT" });

    const optOutSet = await collectOptOutEmails(client, uniqueRecipients);
    const recipients = uniqueRecipients.filter((e) => !optOutSet.has(e));
    if (!recipients.length) return res.status(409).json({ ok: false, error: "ALL_RECIPIENTS_OPTED_OUT" });

    const limit = 200;
    if (recipients.length > limit) return res.status(409).json({ ok: false, error: "RECIPIENT_LIMIT", detail: `Limit ${limit} recipients per send.` });

    let exhibition = null;
    if (mailer.include_event_details && Number.isFinite(Number(mailer.exhibition_id))) {
      const expoRes = await client.query(
        `
          select
            e.exhibition_name,
            e.distributor_id,
            e.city,
            e.venue,
            e.stall_no,
            e.start_date,
            e.end_date,
            e.collaboration_mode,
            d.company_name as distributor_name
          from marketing_exhibitions e
          left join distributors d on d.id = e.distributor_id
          where e.company_id = $1
            and e.id = $2
          limit 1
        `,
        [companyId, Number(mailer.exhibition_id)]
      );
      exhibition = expoRes.rows[0] || null;
    }

    const senderDistributorId = Number(payload?.sender_distributor_id);
    const effectiveDistributorId = Number.isFinite(senderDistributorId)
      ? senderDistributorId
      : Number.isFinite(Number(mailer.exhibition_id)) && Number.isFinite(Number(exhibition?.distributor_id))
        ? Number(exhibition.distributor_id)
        : null;

    const senderSource = await resolveEffectiveMailSource(client, {
      userId: req.user.id,
      userGroupName: req.user.group_name,
      quoteDistributorId: effectiveDistributorId,
    });

    if (!senderSource || senderSource.type === "none") {
      return res.status(400).json({ ok: false, error: "MAIL_ACCOUNT_NOT_CONFIGURED" });
    }

    const sendResults = [];

    for (const email of recipients) {
      const trackingToken = buildMarketingMailTrackingToken();
      const unsubscribeToken = buildMarketingMailTrackingToken();
      const html = buildMailerHtml({
        bodyText: mailer.body_text,
        trackingToken,
        unsubscribeToken,
        exhibition,
      });

      try {
        const info = await sendMail({
          to: joinEmailList([email]),
          cc: "",
          bcc: "",
          subject: mailer.subject,
          text: `${mailer.body_text}\n\nUnsubscribe: ${buildMarketingUnsubscribeUrl(unsubscribeToken)}`,
          html,
          attachments: [],
          senderSource,
        });

        await client.query(
          `
            insert into marketing_mail_logs (
              company_id,
              mailer_id,
              to_email,
              sender_source,
              sender_email,
              provider,
              message_id,
              tracking_token,
              unsubscribe_token,
              sent_at,
              error_text
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),null)
          `,
          [
            companyId,
            mailer.id,
            email,
            senderSource.type || null,
            senderSource.email || null,
            senderSource.provider || null,
            info?.messageId || null,
            trackingToken,
            unsubscribeToken,
          ]
        );

        sendResults.push({ email, ok: true });
      } catch (error) {
        await client.query(
          `
            insert into marketing_mail_logs (
              company_id,
              mailer_id,
              to_email,
              sender_source,
              sender_email,
              provider,
              message_id,
              tracking_token,
              unsubscribe_token,
              sent_at,
              error_text
            )
            values ($1,$2,$3,$4,$5,$6,null,$7,$8,now(),$9)
          `,
          [
            companyId,
            mailer.id,
            email,
            senderSource.type || null,
            senderSource.email || null,
            senderSource.provider || null,
            trackingToken,
            unsubscribeToken,
            String(error?.message || error?.code || "SEND_FAILED"),
          ]
        );
        sendResults.push({ email, ok: false });
      }
    }

    if (senderSource.account?.id) {
      await markMailAccountUsed(client, senderSource.account.id);
    }

    await client.query(
      `update marketing_mailers set mailer_status = 'sent', updated_by = $3, updated_at = now() where company_id = $1 and id = $2`,
      [companyId, mailer.id, req.user.id]
    );

    const updated = await loadMailerDetail(companyId, mailer.id);
    return res.json({ ok: true, mailer: updated, results: sendResults });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/campaigns/:id/roi", requireScreenAction("campaigns", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const id = Number(req.params.id);
    const roi = await loadCampaignRoi(pool, companyId, id);
    if (!roi) return res.status(404).json({ ok: false, error: "CAMPAIGN_NOT_FOUND" });
    return res.json({ ok: true, roi, attribution: "first_touch" });
  } catch (err) {
    return next(err);
  }
});

router.get("/dormancy/preview", requireScreenAction("marketing_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const data = await previewDormancy(pool, companyId);
    return res.json({ ok: true, ...data });
  } catch (err) {
    return next(err);
  }
});

router.post("/dormancy/run", requireScreenAction("marketing_desk", "can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await runDormancyScan(pool, { companyId });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return next(err);
  }
});

router.post("/brevo/sync", requireScreenAction("marketing_desk", "can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await syncBrevoSegment(pool, companyId);
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err?.code === "BREVO_NOT_CONFIGURED") {
      return res.status(400).json({ ok: false, error: "BREVO_NOT_CONFIGURED", detail: "Set BREVO_API_KEY to enable newsletter sync." });
    }
    return next(err);
  }
});

router.get("/brevo/logs", requireScreenAction("marketing_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await pool.query(
      `
        select id, action, payload_summary, status, error_text, created_at
        from brevo_sync_logs
        where company_id = $1
        order by created_at desc
        limit 100
      `,
      [companyId]
    );
    return res.json({ ok: true, logs: rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
