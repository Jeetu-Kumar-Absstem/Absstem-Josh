const express = require("express");

const { pool } = require("../db/pool");
const { notifyLeadAssigned, notifyLeadFollowUpDue } = require("../services/notifications");

const LEAD_PIPELINE_STATUSES = [
  "new",
  "qualified",
  "follow_up",
  "quoted",
  "order_won",
  "lost",
  "closed",
  "closed_no_action",
  "cancelled",
];
const LEAD_CLOSING_STATUSES = new Set(["lost", "closed", "closed_no_action", "cancelled", "order_won"]);
const LEAD_RESPONSE_ACTIVITY_TYPES = new Set(["call", "meeting", "email", "whatsapp"]);
const LEAD_FOLLOW_UP_BUMP_STATUSES = new Set(["new", "qualified"]);
const { hasScreenAction, ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { buildCustomerCompanyScopeSql, ensureCustomerCompanyAccess, linkCustomerToCompany } = require("../services/customerCompanyAccess");
const { createCustomerFromParty } = require("../services/createCustomerFromParty");
const { getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { normalizePhoneDigits, phoneMatchPatterns } = require("../services/leadPhone");
const {
  taxonomyPayload,
  normalizeLifecycle,
  normalizeSalesActivity,
  normalizeTemperature,
  dualWriteFromLegacy,
  dualWriteFromLifecycle,
  CONTACT_OUTCOMES,
  LIFECYCLE,
} = require("../services/leadTaxonomy");
const { ingestLead, appendToExistingLead, insertTouchpoint } = require("../services/leadIngest");
const { lookupPincode, maybeAutoAssignTerritory } = require("../services/geoRouting");
const { recomputeScore, recordEngagementEvent } = require("../services/leadScoring");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

async function getDistributorIdForUser(userId) {
  const { rows } = await pool.query(
    `select distributor_id from user_distributor_links where user_id = $1 limit 1`,
    [userId]
  );
  return rows[0]?.distributor_id || null;
}

function canAccessLead(req, lead, distributorId = null) {
  if (!lead) return false;
  const activeCompanyId = getActiveCompanyId(req);
  if (req.user.group_name === "SuperAdmin") {
    return !activeCompanyId || Number(lead.company_id) === activeCompanyId;
  }
  if (!activeCompanyId || Number(lead.company_id) !== activeCompanyId) return false;
  if (req.user.group_name === "Distributor") {
    return Number(lead.distributor_id || 0) === Number(distributorId || 0);
  }
  if (!ownRecordsOnly(req, "leads")) return true;
  return Number(lead.assigned_to) === Number(req.user.id) || Number(lead.created_by) === Number(req.user.id);
}

async function userBelongsToCompany(client, userId, companyId) {
  if (!Number.isFinite(Number(userId)) || !Number.isFinite(Number(companyId))) return false;
  const { rows } = await client.query(
    `
      select 1
      from erp_users u
      join user_company_memberships ucm
        on ucm.user_id = u.id
       and ucm.is_active = true
      where u.id = $1
        and u.is_active = true
        and ucm.company_id = $2
      limit 1
    `,
    [Number(userId), Number(companyId)]
  );
  return rows.length > 0;
}

async function findLeadDuplicatesByPhone(client, companyId, phones) {
  const patterns = [];
  const seenDigits = new Set();
  for (const phone of phones || []) {
    const pattern = phoneMatchPatterns(phone);
    if (!pattern || seenDigits.has(pattern.digits)) continue;
    seenDigits.add(pattern.digits);
    patterns.push(pattern);
  }
  if (!patterns.length) return [];

  const duplicates = [];
  const seenLeadIds = new Set();

  for (const pattern of patterns) {
    const { rows } = await client.query(
      `
        select
          l.id as lead_id,
          l.lead_number,
          l.company_name,
          l.status,
          l.created_at,
          lc.full_name as contact_name,
          lc.email as contact_email,
          lc.phone as contact_phone,
          lc.is_primary
        from lead_contacts lc
        join leads l on l.id = lc.lead_id
        where l.company_id = $1
          and lc.phone is not null
          and nullif(btrim(lc.phone), '') is not null
          and regexp_replace(lc.phone, '\\D', '', 'g') like $2
        order by l.created_at desc, lc.is_primary desc, lc.id asc
        limit 20
      `,
      [companyId, `%${pattern.digits}`]
    );

    for (const row of rows) {
      const storedDigits = normalizePhoneDigits(row.contact_phone);
      if (storedDigits !== pattern.digits && !storedDigits.endsWith(pattern.digits)) continue;
      if (seenLeadIds.has(Number(row.lead_id))) continue;
      seenLeadIds.add(Number(row.lead_id));
      duplicates.push({
        lead_id: row.lead_id,
        lead_number: row.lead_number,
        company_name: row.company_name,
        status: row.status,
        created_at: row.created_at,
        matched_on: "phone",
        matched_phone: pattern.digits,
        contact_name: row.contact_name || null,
        contact_email: row.contact_email || null,
        contact_phone: row.contact_phone || null,
      });
    }
  }

  return duplicates;
}

async function validateLeadAttribution(client, companyId, marketingCampaignId, marketingExhibitionId) {
  if (Number.isFinite(marketingCampaignId) && Number.isFinite(marketingExhibitionId)) {
    const err = new Error("LEAD_ATTRIBUTION_CONFLICT");
    err.status = 400;
    throw err;
  }

  let resolvedLeadSourceId = null;

  if (Number.isFinite(marketingCampaignId)) {
    const { rows } = await client.query(
      `
        select id, lead_source_id
        from marketing_campaigns
        where id = $1
          and company_id = $2
        limit 1
      `,
      [marketingCampaignId, companyId]
    );
    if (!rows[0]) {
      const err = new Error("MARKETING_CAMPAIGN_NOT_FOUND");
      err.status = 404;
      throw err;
    }
    resolvedLeadSourceId = Number.isFinite(Number(rows[0].lead_source_id)) ? Number(rows[0].lead_source_id) : null;
  }

  if (Number.isFinite(marketingExhibitionId)) {
    const { rows } = await client.query(
      `
        select id, lead_source_id
        from marketing_exhibitions
        where id = $1
          and company_id = $2
        limit 1
      `,
      [marketingExhibitionId, companyId]
    );
    if (!rows[0]) {
      const err = new Error("MARKETING_EXHIBITION_NOT_FOUND");
      err.status = 404;
      throw err;
    }
    resolvedLeadSourceId = Number.isFinite(Number(rows[0].lead_source_id)) ? Number(rows[0].lead_source_id) : null;
  }

  return { resolvedLeadSourceId };
}

router.use(requireAuth);

router.get("/taxonomy", requireScreenAction("leads", "can_view"), async (_req, res) => {
  return res.json({ ok: true, ...taxonomyPayload() });
});

router.get("/sources", requireScreenAction("leads", "can_view"), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `
        select id, source_code, source_name
        from lead_sources
        where is_active = true
        order by source_name
      `
    );
    return res.json({ ok: true, sources: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/users", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const activeCompanyId = getActiveCompanyId(req);
    if (req.user.group_name !== "SuperAdmin" && !activeCompanyId) {
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    const params = [];
    const companyWhere = [];
    if (Number.isFinite(activeCompanyId)) {
      params.push(activeCompanyId);
      companyWhere.push(
        `exists (
          select 1
          from user_company_memberships ucm
          where ucm.user_id = u.id
            and ucm.company_id = $1
            and ucm.is_active = true
        )`
      );
    }
    const { rows } = await pool.query(
      `
        select distinct u.id, u.email, u.full_name
        from erp_users u
        where u.is_active = true
          ${companyWhere.length ? `and ${companyWhere.join(" and ")}` : ""}
        order by u.full_name
      `,
      params
    );
    return res.json({ ok: true, users: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/attribution-options", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const [campaignRes, exhibitionRes] = await Promise.all([
      pool.query(
        `
          select id, campaign_name, channel_type, campaign_status
          from marketing_campaigns
          where company_id = $1
          order by start_date desc nulls last, updated_at desc, id desc
          limit 200
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, exhibition_name, city, exhibition_status
          from marketing_exhibitions
          where company_id = $1
          order by start_date desc nulls last, updated_at desc, id desc
          limit 200
        `,
        [companyId]
      ),
    ]);

    return res.json({
      ok: true,
      campaigns: campaignRes.rows,
      exhibitions: exhibitionRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

const LEAD_DORMANT_DAYS = 45;
const LEAD_DEEP_DORMANT_DAYS = 120;
const LEAD_CLOSED_STATUSES = new Set(["order_won", "won", "lost", "closed", "closed_no_action", "cancelled"]);

/** Visual-only dormancy: open leads with no activity for 45+ days, or tagged dormant by marketing. */
function classifyLeadDormancy(row) {
  const none = { is_dormant: false, dormant_days: null, dormancy_level: null, dormancy_reason: null };
  const status = String(row.status || "").toLowerCase();
  const lifecycle = String(row.lifecycle_status || "").toLowerCase();
  if (LEAD_CLOSED_STATUSES.has(status) || lifecycle === "won" || lifecycle === "lost" || row.converted_sales_order_id) {
    return none;
  }
  const last = row.last_activity_at || row.updated_at || row.created_at;
  const lastMs = last ? new Date(last).getTime() : NaN;
  const idleDays = Number.isFinite(lastMs) ? Math.max(0, Math.floor((Date.now() - lastMs) / 86400000)) : null;
  const taggedDormant = String(row.newsletter_segment || "").toLowerCase() === "dormant_6m" || Boolean(row.dormant_since);
  const staleDormant = idleDays !== null && idleDays >= LEAD_DORMANT_DAYS;
  if (!taggedDormant && !staleDormant) return none;
  return {
    is_dormant: true,
    dormant_days: idleDays,
    dormancy_level: idleDays !== null && idleDays >= LEAD_DEEP_DORMANT_DAYS ? "deep" : "dormant",
    dormancy_reason: staleDormant
      ? `No activity for ${idleDays} days`
      : "Tagged dormant by marketing segment",
  };
}

router.get("/", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const status = typeof req.query.status === "string" ? req.query.status : "";
    const assignedTo =
      typeof req.query.assignedTo === "string" ? req.query.assignedTo : "";
    const activeCompanyId = getActiveCompanyId(req);
    if (req.user.group_name !== "SuperAdmin" && !activeCompanyId) {
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const where = [];
    const params = [];

    if (Number.isFinite(activeCompanyId)) {
      params.push(activeCompanyId);
      where.push(`l.company_id = $${params.length}`);
    }

    if (isDistributor) {
      params.push(distributorId);
      where.push(`l.distributor_id = $${params.length}`);
    }

    if (!isDistributor && ownRecordsOnly(req, "leads")) {
      params.push(req.user.id);
      where.push(`(l.assigned_to = $${params.length} or l.created_by = $${params.length})`);
    }

    if (status) {
      params.push(status);
      where.push(`(l.status = $${params.length} or l.lifecycle_status = $${params.length} or l.sales_activity_status = $${params.length})`);
    }
    const lifecycle = typeof req.query.lifecycle_status === "string" ? req.query.lifecycle_status.trim().toLowerCase() : "";
    if (lifecycle) {
      params.push(lifecycle);
      where.push(`l.lifecycle_status = $${params.length}`);
    }

    if (assignedTo === "me") {
      params.push(req.user.id);
      where.push(`l.assigned_to = $${params.length}`);
    } else if (assignedTo === "unassigned") {
      where.push(`l.assigned_to is null`);
    }

    const { resolveTimelineFromQuery, pushDateRangeFilter } = require("../services/timelineWindow");
    const timeline = resolveTimelineFromQuery(req.query);
    const leadDateFilter = pushDateRangeFilter(
      params,
      "coalesce(l.legacy_created_at, l.created_at)",
      timeline.dateFrom,
      timeline.dateTo
    );
    if (leadDateFilter) where.push(leadDateFilter);

    const queue = typeof req.query.queue === "string" ? req.query.queue.trim().toLowerCase() : "";
    const staleDaysRaw = Number(req.query.stale_days || req.query.staleDays || 7);
    const staleDays = Number.isFinite(staleDaysRaw) && staleDaysRaw > 0 ? Math.min(Math.trunc(staleDaysRaw), 90) : 7;

    if (queue === "mine") {
      params.push(req.user.id);
      where.push(`l.assigned_to = $${params.length}`);
      where.push(`coalesce(l.status, '') not in ('order_won', 'lost', 'closed', 'cancelled')`);
    } else if (queue === "overdue" || queue === "stale") {
      params.push(req.user.id);
      where.push(`l.assigned_to = $${params.length}`);
      where.push(`coalesce(l.status, '') not in ('order_won', 'lost', 'closed', 'cancelled')`);
      params.push(staleDays);
      where.push(`(
        exists (
          select 1
          from lead_activities la
          where la.lead_id = l.id
            and la.due_at is not null
            and la.due_at::date <= current_date
        )
        or (
          l.assigned_at is not null
          and l.first_response_at is null
          and l.assigned_at + make_interval(hours => coalesce(nullif(l.assign_sla_hours, 0), 24)) < now()
        )
        or coalesce(
          (select max(la.activity_at) from lead_activities la where la.lead_id = l.id),
          l.updated_at,
          l.created_at
        ) < now() - make_interval(days => $${params.length})
      )`);
    } else if (queue === "due_today") {
      params.push(req.user.id);
      where.push(`l.assigned_to = $${params.length}`);
      where.push(`coalesce(l.status, '') not in ('order_won', 'lost', 'closed', 'cancelled')`);
      where.push(`exists (
        select 1
        from lead_activities la
        where la.lead_id = l.id
          and la.due_at is not null
          and la.due_at::date = current_date
      )`);
    } else if (queue === "sla_breached") {
      params.push(req.user.id);
      where.push(`l.assigned_to = $${params.length}`);
      where.push(`coalesce(l.status, '') not in ('order_won', 'lost', 'closed', 'cancelled')`);
      where.push(`l.assigned_at is not null`);
      where.push(`l.first_response_at is null`);
      where.push(`l.assigned_at + make_interval(hours => coalesce(nullif(l.assign_sla_hours, 0), 24)) < now()`);
    } else if (queue === "quoted_not_ordered") {
      params.push(req.user.id);
      where.push(`l.assigned_to = $${params.length}`);
      where.push(`(l.status = 'quoted' or l.converted_quote_id is not null)`);
      where.push(`l.converted_sales_order_id is null`);
      where.push(`coalesce(l.status, '') not in ('order_won', 'lost', 'closed', 'cancelled')`);
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const LIST_CAP = 200;

    const countRes = await pool.query(
      `
        select count(*)::int as n
        from leads l
        ${whereSql}
      `,
      params
    );
    const totalCount = Number(countRes.rows[0]?.n || 0);

    const { rows } = await pool.query(
      `
        select
          l.id,
          l.lead_number,
          l.company_name,
          l.lead_source_id,
          l.marketing_campaign_id,
          l.marketing_exhibition_id,
          l.status,
          l.lifecycle_status,
          l.sales_activity_status,
          l.sales_temperature,
          l.engagement_score,
          l.pincode,
          l.city,
          l.state,
          l.priority,
          l.customer_id,
          l.converted_customer_id,
          l.converted_quote_id,
          l.converted_to_quote_at,
          l.converted_sales_order_id,
          l.converted_to_order_at,
          l.assigned_to,
          au.full_name as assigned_to_name,
          l.created_at,
          l.updated_at,
          l.newsletter_segment,
          l.dormant_since,
          (
            select max(la.activity_at)
            from lead_activities la
            where la.lead_id = l.id
          ) as last_activity_at,
          ls.source_name as lead_source_name,
          mc.campaign_name as marketing_campaign_name,
          me.exhibition_name as marketing_exhibition_name
        from leads l
        left join lead_sources ls on ls.id = l.lead_source_id
        left join erp_users au on au.id = l.assigned_to
        left join marketing_campaigns mc on mc.id = l.marketing_campaign_id
        left join marketing_exhibitions me on me.id = l.marketing_exhibition_id
        ${whereSql}
        order by l.created_at desc
        limit ${LIST_CAP}
      `,
      params
    );

    const leads = rows.map((row) => ({ ...row, ...classifyLeadDormancy(row) }));

    return res.json({
      ok: true,
      leads,
      list: {
        total_count: totalCount,
        returned: leads.length,
        cap: LIST_CAP,
        capped: totalCount > leads.length,
        showing_from: leads.length ? 1 : 0,
        showing_to: leads.length,
        dormant_in_view: leads.filter((lead) => lead.is_dormant).length,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/my-queue", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }
    const activeCompanyId = getActiveCompanyId(req);
    if (req.user.group_name !== "SuperAdmin" && !activeCompanyId) {
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const staleDaysRaw = Number(req.query.stale_days || 7);
    const staleDays = Number.isFinite(staleDaysRaw) && staleDaysRaw > 0 ? Math.min(Math.trunc(staleDaysRaw), 90) : 7;
    const params = [req.user.id];
    const where = [`l.assigned_to = $1`, `coalesce(l.status, '') not in ('order_won', 'lost', 'closed', 'cancelled')`];
    if (Number.isFinite(activeCompanyId)) {
      params.push(activeCompanyId);
      where.push(`l.company_id = $${params.length}`);
    }
    if (isDistributor) {
      params.push(distributorId);
      where.push(`l.distributor_id = $${params.length}`);
    }

    const leadsRes = await pool.query(
      `
        select
          l.id,
          l.lead_number,
          l.company_name,
          l.status,
          l.priority,
          l.customer_id,
          l.converted_quote_id,
          l.converted_sales_order_id,
          l.assigned_at,
          l.assign_sla_hours,
          l.first_response_at,
          l.updated_at,
          l.created_at,
          (
            select max(la.activity_at)
            from lead_activities la
            where la.lead_id = l.id
          ) as last_activity_at,
          (
            select min(la.due_at)
            from lead_activities la
            where la.lead_id = l.id
              and la.due_at is not null
              and la.due_at >= now()
          ) as next_due_at,
          (
            select min(la.due_at)
            from lead_activities la
            where la.lead_id = l.id
              and la.due_at is not null
              and la.due_at::date = current_date
          ) as due_today_at,
          (
            select min(la.due_at)
            from lead_activities la
            where la.lead_id = l.id
              and la.due_at is not null
              and la.due_at::date <= current_date
          ) as overdue_activity_due_at,
          case
            when l.assigned_at is not null
              and l.first_response_at is null
              and l.assigned_at + make_interval(hours => coalesce(nullif(l.assign_sla_hours, 0), 24)) < now()
            then true
            else false
          end as sla_breached
        from leads l
        where ${where.join(" and ")}
        order by l.updated_at desc nulls last
        limit 80
      `,
      params
    );

    const assigned = leadsRes.rows.map((row) => ({
      ...row,
      due_today: Boolean(row.due_today_at),
      sla_breached: Boolean(row.sla_breached),
    }));
    const cutoff = Date.now() - staleDays * 86400000;
    const overdue = assigned.filter((row) => {
      if (row.overdue_activity_due_at) return true;
      if (row.sla_breached) return true;
      const stamp = new Date(row.last_activity_at || row.updated_at || row.created_at || 0).getTime();
      return Number.isFinite(stamp) && stamp < cutoff;
    });
    const dueToday = assigned.filter((row) => row.due_today);
    const slaBreached = assigned.filter((row) => row.sla_breached);
    const quotedNotOrdered = assigned.filter(
      (row) => (row.status === "quoted" || row.converted_quote_id) && !row.converted_sales_order_id
    );

    let quotedQuotes = [];
    if (hasScreenAction(req, "quotes", "can_view")) {
      const quoteParams = [req.user.id];
      const quoteWhere = [
        `q.created_by = $1`,
        `q.quote_status = any($${quoteParams.length + 1}::text[])`,
      ];
      quoteParams.push(["issued", "sent", "approved"]);
      if (Number.isFinite(activeCompanyId)) {
        quoteParams.push(activeCompanyId);
        quoteWhere.push(`q.company_id = $${quoteParams.length}`);
      }
      const qRes = await pool.query(
        `
          select
            q.id,
            q.quote_number,
            q.quote_status,
            c.customer_name,
            q.updated_at,
            so.id as sales_order_id
          from quote_headers q
          join customers c on c.id = q.customer_id
          left join quote_revisions qr on qr.quote_id = q.id and qr.is_latest = true
          left join sales_orders so on so.quote_revision_id = qr.id and so.order_status <> 'cancelled'
          where ${quoteWhere.join(" and ")}
            and so.id is null
          order by q.updated_at desc
          limit 40
        `,
        quoteParams
      );
      quotedQuotes = qRes.rows;
    }

    return res.json({
      ok: true,
      stale_days: staleDays,
      assigned: assigned.slice(0, 20),
      overdue: overdue.slice(0, 20),
      due_today: dueToday.slice(0, 20),
      sla_breached: slaBreached.slice(0, 20),
      quoted_not_ordered: quotedNotOrdered.slice(0, 20),
      quotes_unconverted: quotedQuotes,
      summary: {
        assigned: assigned.length,
        overdue: overdue.length,
        due_today: dueToday.length,
        sla_breached: slaBreached.length,
        quoted_not_ordered: quotedNotOrdered.length,
        quotes_unconverted: quotedQuotes.length,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.patch("/:id", requireScreenAction("leads", "can_edit"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hasStatus = Object.prototype.hasOwnProperty.call(body, "status");
    const hasPriority = Object.prototype.hasOwnProperty.call(body, "priority");
    const hasCloseReason = Object.prototype.hasOwnProperty.call(body, "close_reason");
    const hasCompetitor = Object.prototype.hasOwnProperty.call(body, "competitor_name");
    const hasLifecycle = Object.prototype.hasOwnProperty.call(body, "lifecycle_status");
    const hasActivity = Object.prototype.hasOwnProperty.call(body, "sales_activity_status");
    const hasTemperature = Object.prototype.hasOwnProperty.call(body, "sales_temperature");
    const hasGeo = ["pincode", "city", "state", "country"].some((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (!hasStatus && !hasPriority && !hasCloseReason && !hasCompetitor && !hasLifecycle && !hasActivity && !hasTemperature && !hasGeo) {
      return res.status(400).json({ ok: false, error: "NO_FIELDS" });
    }

    const leadRes = await pool.query(
      `select id, company_id, distributor_id, assigned_to, created_by, status, priority, close_reason, competitor_name,
              lifecycle_status, sales_activity_status, sales_temperature, pincode, city, state, country
       from leads where id = $1 limit 1`,
      [id]
    );
    const lead = leadRes.rows[0] || null;
    if (!lead) return res.status(404).json({ ok: false });
    const distributorId = req.user.group_name === "Distributor" ? await getDistributorIdForUser(req.user.id) : null;
    if (!canAccessLead(req, lead, distributorId)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    let nextStatus = lead.status;
    let nextLifecycle = lead.lifecycle_status || "new_lead";
    let nextActivity = lead.sales_activity_status || "uncontacted";
    if (hasStatus) {
      const status = typeof body.status === "string" ? body.status.trim().toLowerCase() : "";
      if (!LEAD_PIPELINE_STATUSES.includes(status)) {
        return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
      }
      nextStatus = status;
      const mapped = dualWriteFromLegacy(status);
      nextLifecycle = mapped.lifecycle_status;
      nextActivity = mapped.sales_activity_status;
    }
    if (hasLifecycle) {
      nextLifecycle = normalizeLifecycle(body.lifecycle_status, nextLifecycle);
      const mapped = dualWriteFromLifecycle(nextLifecycle);
      if (!hasStatus) nextStatus = mapped.status;
    }
    if (hasActivity) {
      nextActivity = normalizeSalesActivity(body.sales_activity_status, nextActivity);
    }

    let nextCloseReason = lead.close_reason;
    if (hasCloseReason) {
      nextCloseReason =
        typeof body.close_reason === "string" && body.close_reason.trim() ? body.close_reason.trim() : null;
    }

    let nextCompetitor = lead.competitor_name;
    if (hasCompetitor) {
      nextCompetitor =
        typeof body.competitor_name === "string" && body.competitor_name.trim()
          ? body.competitor_name.trim()
          : null;
    }

    let nextPriority = lead.priority;
    if (hasPriority) {
      const priority = typeof body.priority === "string" ? body.priority.trim().toLowerCase() : "";
      if (!priority) return res.status(400).json({ ok: false, error: "INVALID_PRIORITY" });
      nextPriority = priority;
    }

    let nextTemperature = lead.sales_temperature || "warm";
    if (hasTemperature) {
      nextTemperature = normalizeTemperature(body.sales_temperature, nextTemperature);
    }

    let nextPincode = lead.pincode;
    let nextCity = lead.city;
    let nextState = lead.state;
    let nextCountry = lead.country;
    if (hasGeo) {
      if (Object.prototype.hasOwnProperty.call(body, "pincode")) nextPincode = String(body.pincode || "").trim() || null;
      if (Object.prototype.hasOwnProperty.call(body, "city")) nextCity = String(body.city || "").trim() || null;
      if (Object.prototype.hasOwnProperty.call(body, "state")) nextState = String(body.state || "").trim() || null;
      if (Object.prototype.hasOwnProperty.call(body, "country")) nextCountry = String(body.country || "").trim() || null;
      if (nextPincode && !nextCity) {
        const geo = await lookupPincode(pool, nextPincode);
        if (geo) {
          nextCity = geo.city_name;
          nextState = geo.state_name;
          nextCountry = geo.country_code || "IN";
        }
      }
    }

    if (LEAD_CLOSING_STATUSES.has(nextStatus) && !nextCloseReason) {
      return res.status(400).json({ ok: false, error: "CLOSE_REASON_REQUIRED" });
    }
    if (!LEAD_CLOSING_STATUSES.has(nextStatus)) {
      nextCloseReason = hasCloseReason ? nextCloseReason : null;
      if (!hasCompetitor) nextCompetitor = null;
    }

    const { rows } = await pool.query(
      `
        update leads
        set
          status = $2,
          lifecycle_status = $3,
          sales_activity_status = $4,
          sales_temperature = $5,
          priority = $6,
          close_reason = $7,
          competitor_name = $8,
          pincode = $9,
          city = $10,
          state = $11,
          country = $12,
          last_sales_engagement_at = now(),
          updated_at = now()
        where id = $1
        returning *
      `,
      [
        id,
        nextStatus,
        nextLifecycle,
        nextActivity,
        nextTemperature,
        nextPriority,
        nextCloseReason,
        nextCompetitor,
        nextPincode,
        nextCity,
        nextState,
        nextCountry,
      ]
    );

    return res.json({ ok: true, lead: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const isDistributor = req.user.group_name === "Distributor";
    const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorId) {
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const activeCompanyId = getActiveCompanyId(req);
    if (req.user.group_name !== "SuperAdmin" && !activeCompanyId) {
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const whereParams = [id];
    let whereSql = `where l.id = $1`;
    if (Number.isFinite(activeCompanyId)) {
      whereParams.push(activeCompanyId);
      whereSql += ` and l.company_id = $${whereParams.length}`;
    }
    if (isDistributor) {
      whereParams.push(distributorId);
      whereSql += ` and l.distributor_id = $${whereParams.length}`;
    }

    const leadRes = await pool.query(
      `
        select
          l.*,
          ls.source_name as lead_source_name,
          au.full_name as assigned_to_name,
          cu.customer_name as customer_name,
          d.company_name as distributor_name,
          mc.campaign_name as marketing_campaign_name,
          me.exhibition_name as marketing_exhibition_name
        from leads l
        left join lead_sources ls on ls.id = l.lead_source_id
        left join erp_users au on au.id = l.assigned_to
        left join customers cu on cu.id = l.customer_id
        left join distributors d on d.id = l.distributor_id
        left join marketing_campaigns mc on mc.id = l.marketing_campaign_id
        left join marketing_exhibitions me on me.id = l.marketing_exhibition_id
        ${whereSql}
        limit 1
      `,
      whereParams
    );

    const lead = leadRes.rows[0] || null;
    if (!lead) return res.status(404).json({ ok: false });
    if (!canAccessLead(req, lead, distributorId)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const contactsRes = await pool.query(
      `
        select id, full_name, email, phone, designation, is_primary
        from lead_contacts
        where lead_id = $1
        order by is_primary desc, id asc
      `,
      [id]
    );

    const activitiesRes = await pool.query(
      `
        select
          a.id,
          a.activity_type,
          a.subject,
          a.notes,
          a.due_at,
          a.activity_at,
          a.contact_outcome,
          a.created_by,
          u.full_name as created_by_name
        from lead_activities a
        left join erp_users u on u.id = a.created_by
        where a.lead_id = $1
        order by a.activity_at desc, a.id desc
        limit 200
      `,
      [id]
    );

    const assignmentsRes = await pool.query(
      `
        select
          la.id,
          la.assigned_to,
          u.full_name as assigned_to_name,
          la.assigned_by,
          ub.full_name as assigned_by_name,
          la.assignment_reason,
          la.assigned_at
        from lead_assignments la
        join erp_users u on u.id = la.assigned_to
        join erp_users ub on ub.id = la.assigned_by
        where la.lead_id = $1
        order by la.assigned_at desc, la.id desc
        limit 200
      `,
      [id]
    );

    const touchpointsRes = await pool.query(
      `
        select *
        from lead_touchpoints
        where lead_id = $1
        order by occurred_at desc, id desc
        limit 100
      `,
      [id]
    );

    return res.json({
      ok: true,
      lead,
      contacts: contactsRes.rows,
      activities: activitiesRes.rows,
      assignments: assignmentsRes.rows,
      touchpoints: touchpointsRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/touchpoints", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `select * from lead_touchpoints where lead_id = $1 order by occurred_at desc, id desc limit 200`,
      [id]
    );
    return res.json({ ok: true, touchpoints: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/touchpoints", requireScreenAction("leads", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const companyId = requireResolvedCompanyId(req);
    const leadRes = await client.query(`select * from leads where id = $1 limit 1`, [id]);
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ ok: false });
    if (!canAccessLead(req, lead)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    await client.query("begin");
    const result = await appendToExistingLead(client, {
      leadId: id,
      companyId: lead.company_id || companyId,
      actorId: req.user.id,
      payload: {
        companyId: lead.company_id || companyId,
        channel: body.channel || "manual",
        marketingCampaignId: Number.isFinite(Number(body.marketing_campaign_id))
          ? Number(body.marketing_campaign_id)
          : lead.marketing_campaign_id,
        contactName: body.contact_name || lead.company_name,
        email: body.email || null,
        phone: body.phone || null,
        phoneDigits: normalizePhoneDigits(body.phone) || null,
        companyName: lead.company_name,
        city: body.city || lead.city,
        state: body.state || lead.state,
        pincode: body.pincode || lead.pincode,
        country: body.country || lead.country,
        utmSource: body.utm_source,
        utmMedium: body.utm_medium,
        utmCampaign: body.utm_campaign,
        gclid: body.gclid,
        fbclid: body.fbclid,
      },
      matchMethod: "manual",
    });
    await client.query("commit");
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/engagement/recompute", requireScreenAction("leads", "can_edit"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const score = await recomputeScore(pool, id);
    return res.json({ ok: true, engagement_score: score });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("leads", "can_create"), async (req, res, next) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const companyName =
    typeof body.company_name === "string" ? body.company_name.trim() : "";

  if (!companyName) return res.status(400).json({ ok: false });

  const leadSourceId =
    body.lead_source_id === null || body.lead_source_id === undefined
      ? null
      : Number(body.lead_source_id);
  const distributorId =
    body.distributor_id === null || body.distributor_id === undefined
      ? null
      : Number(body.distributor_id);
  const customerId =
    body.customer_id === null || body.customer_id === undefined
      ? null
      : Number(body.customer_id);
  const assignedTo =
    body.assigned_to === null || body.assigned_to === undefined
      ? null
      : Number(body.assigned_to);
  const marketingCampaignId =
    body.marketing_campaign_id === null || body.marketing_campaign_id === undefined
      ? null
      : Number(body.marketing_campaign_id);
  const marketingExhibitionId =
    body.marketing_exhibition_id === null || body.marketing_exhibition_id === undefined
      ? null
      : Number(body.marketing_exhibition_id);

  const status = typeof body.status === "string" ? body.status : "new";
  const priority = typeof body.priority === "string" ? body.priority : "medium";

  const contactsInput = Array.isArray(body.contacts) ? body.contacts : [];

  const client = await pool.connect();
  try {
    await client.query("begin");

    const isDistributor = req.user.group_name === "Distributor";
    const distributorIdForUser = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorIdForUser) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    const forceNewLead = Boolean(body.force_new_lead);
    const appendToLeadId = Number(body.append_to_lead_id);
    const pincode = typeof body.pincode === "string" ? body.pincode.trim() : "";
    const geo = pincode ? await lookupPincode(client, pincode) : null;
    const city = typeof body.city === "string" && body.city.trim() ? body.city.trim() : geo?.city_name || null;
    const state = typeof body.state === "string" && body.state.trim() ? body.state.trim() : geo?.state_name || null;
    const country = typeof body.country === "string" && body.country.trim() ? body.country.trim() : geo?.country_code || (geo ? "IN" : null);

    const phonesToCheck = contactsInput
      .map((c) => (c && typeof c === "object" ? c.phone : null))
      .filter((phone) => typeof phone === "string" && phone.trim());
    const duplicates = await findLeadDuplicatesByPhone(client, companyId, phonesToCheck);
    if (duplicates.length && Number.isFinite(appendToLeadId) && appendToLeadId > 0) {
      const primary = contactsInput[0] || {};
      const result = await appendToExistingLead(client, {
        leadId: appendToLeadId,
        companyId,
        actorId: req.user.id,
        payload: {
          companyId,
          channel: "manual",
          marketingCampaignId: Number.isFinite(marketingCampaignId) ? marketingCampaignId : null,
          marketingExhibitionId: Number.isFinite(marketingExhibitionId) ? marketingExhibitionId : null,
          contactName: primary.full_name || companyName,
          email: primary.email || null,
          phone: primary.phone || null,
          phoneDigits: normalizePhoneDigits(primary.phone) || null,
          companyName,
          city,
          state,
          pincode: pincode || null,
          country,
        },
        matchMethod: "manual",
      });
      await client.query("commit");
      const leadRes = await pool.query(`select * from leads where id = $1`, [appendToLeadId]);
      return res.json({ ok: true, appended: true, lead: leadRes.rows[0], lead_id: appendToLeadId, touchpoint: result.touchpoint });
    }
    if (duplicates.length && !forceNewLead) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "LEAD_DUPLICATE_PHONE",
        message: "Existing lead found.",
        duplicates,
      });
    }

    const attribution = await validateLeadAttribution(
      client,
      companyId,
      Number.isFinite(marketingCampaignId) ? marketingCampaignId : null,
      Number.isFinite(marketingExhibitionId) ? marketingExhibitionId : null
    );

    const numRes = await client.query(
      `select next_document_number('L') as lead_number`
    );
    const leadNumber = numRes.rows[0]?.lead_number;

    const leadRes = await client.query(
      `
        insert into leads (
          lead_number,
          company_id,
          company_name,
          lead_source_id,
          marketing_campaign_id,
          marketing_exhibition_id,
          distributor_id,
          customer_id,
          status,
          lifecycle_status,
          sales_activity_status,
          sales_temperature,
          priority,
          city,
          state,
          pincode,
          country,
          first_touch_campaign_id,
          last_touch_campaign_id,
          first_touch_channel,
          last_touch_channel,
          last_touchpoint_at,
          assigned_to,
          created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'manual','manual',now(),$20,$21)
        returning *
      `,
      [
        leadNumber,
        companyId,
        companyName,
        Number.isFinite(leadSourceId)
          ? leadSourceId
          : attribution.resolvedLeadSourceId,
        Number.isFinite(marketingCampaignId) ? marketingCampaignId : null,
        Number.isFinite(marketingExhibitionId) ? marketingExhibitionId : null,
        isDistributor
          ? distributorIdForUser
          : Number.isFinite(distributorId)
            ? distributorId
            : null,
        Number.isFinite(customerId) ? customerId : null,
        status,
        normalizeLifecycle(status),
        status === "new" ? "uncontacted" : normalizeSalesActivity(status),
        normalizeTemperature(body.sales_temperature, "warm"),
        priority,
        city,
        state,
        pincode || null,
        country,
        Number.isFinite(marketingCampaignId) ? marketingCampaignId : null,
        Number.isFinite(marketingCampaignId) ? marketingCampaignId : null,
        Number.isFinite(assignedTo) ? assignedTo : null,
        req.user.id,
      ]
    );

    if (Number.isFinite(assignedTo)) {
      const assigneeAllowed = await userBelongsToCompany(client, assignedTo, companyId);
      if (!assigneeAllowed) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "ASSIGNEE_COMPANY_MISMATCH" });
      }
    }

    const lead = leadRes.rows[0];

    for (const c of contactsInput) {
      const obj = c && typeof c === "object" ? c : {};
      const fullName = typeof obj.full_name === "string" ? obj.full_name.trim() : "";
      if (!fullName) continue;

      const phoneValue =
        forceNewLead && duplicates.length
          ? null
          : typeof obj.phone === "string" && obj.phone.length
            ? obj.phone
            : null;

      await client.query(
        `
          insert into lead_contacts (lead_id, full_name, email, phone, designation, is_primary)
          values ($1,$2,$3,$4,$5,$6)
        `,
        [
          lead.id,
          fullName,
          typeof obj.email === "string" && obj.email.length ? obj.email : null,
          phoneValue,
          typeof obj.designation === "string" && obj.designation.length
            ? obj.designation
            : null,
          Boolean(obj.is_primary),
        ]
      );
    }

    if (Number.isFinite(assignedTo)) {
      await client.query(
        `
          insert into lead_assignments (lead_id, assigned_to, assigned_by, assignment_reason)
          values ($1,$2,$3,$4)
        `,
        [lead.id, assignedTo, req.user.id, "Assigned on creation"]
      );
    } else {
      await maybeAutoAssignTerritory(client, {
        leadId: lead.id,
        companyId,
        pincode,
        city,
        state,
        actorId: req.user.id,
      });
    }

    const primary = contactsInput[0] || {};
    await insertTouchpoint(client, {
      companyId,
      leadId: lead.id,
      channel: "manual",
      leadSourceId: Number.isFinite(leadSourceId) ? leadSourceId : attribution.resolvedLeadSourceId,
      marketingCampaignId: Number.isFinite(marketingCampaignId) ? marketingCampaignId : null,
      marketingExhibitionId: Number.isFinite(marketingExhibitionId) ? marketingExhibitionId : null,
      contactName: primary.full_name || null,
      email: primary.email || null,
      phone: forceNewLead && duplicates.length ? null : primary.phone || null,
      phoneDigits: forceNewLead && duplicates.length ? null : normalizePhoneDigits(primary.phone) || null,
      companyName,
      city,
      state,
      pincode: pincode || null,
      country,
      matchMethod: "created_new",
    });
    if (Number.isFinite(marketingCampaignId)) {
      await client.query(
        `
          insert into lead_campaign_attributions (company_id, lead_id, campaign_id, role)
          values ($1,$2,$3,'first')
          on conflict (lead_id, campaign_id, role) do nothing
        `,
        [companyId, lead.id, marketingCampaignId]
      );
    }

    await client.query("commit");

    if (Number.isFinite(assignedTo)) {
      notifyLeadAssigned({
        leadId: lead.id,
        leadNumber: lead.lead_number,
        companyName: lead.company_name,
        assignedTo,
        assignedBy: req.user.id,
        companyId: lead.company_id || companyId,
        reason: "Assigned on creation",
      }).catch(() => {});
    }

    return res.status(201).json({ ok: true, lead });
  } catch (err) {
    await client.query("rollback");
    if (err && (err.code === "23505" || String(err.constraint || "").includes("phone_digits"))) {
      return res.status(409).json({
        ok: false,
        error: "LEAD_DUPLICATE_PHONE",
        message: "A lead with this phone number already exists.",
      });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/bulk", requireScreenAction("leads", "can_create"), async (req, res, next) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const items = Array.isArray(body.leads) ? body.leads : [];
  if (!items.length) return res.status(400).json({ ok: false, error: "NO_LEADS" });
  if (items.length > 100) return res.status(400).json({ ok: false, error: "BULK_LIMIT_100" });

  const marketingCampaignId =
    body.marketing_campaign_id === null || body.marketing_campaign_id === undefined
      ? null
      : Number(body.marketing_campaign_id);
  const marketingExhibitionId =
    body.marketing_exhibition_id === null || body.marketing_exhibition_id === undefined
      ? null
      : Number(body.marketing_exhibition_id);
  const defaultAssignedTo =
    body.assigned_to === null || body.assigned_to === undefined ? null : Number(body.assigned_to);
  const defaultPriority = typeof body.priority === "string" ? body.priority : "medium";

  if (!Number.isFinite(marketingCampaignId) && !Number.isFinite(marketingExhibitionId)) {
    return res.status(400).json({ ok: false, error: "ATTRIBUTION_REQUIRED" });
  }
  if (Number.isFinite(marketingCampaignId) && Number.isFinite(marketingExhibitionId)) {
    return res.status(400).json({ ok: false, error: "LEAD_ATTRIBUTION_CONFLICT" });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const isDistributor = req.user.group_name === "Distributor";
    const distributorIdForUser = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorIdForUser) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }

    let attribution;
    try {
      attribution = await validateLeadAttribution(
        client,
        companyId,
        Number.isFinite(marketingCampaignId) ? marketingCampaignId : null,
        Number.isFinite(marketingExhibitionId) ? marketingExhibitionId : null
      );
    } catch (attrErr) {
      await client.query("rollback");
      const code = attrErr?.message || "ATTRIBUTION_FAILED";
      const status = Number(attrErr?.status) || 400;
      return res.status(status).json({ ok: false, error: code });
    }

    if (Number.isFinite(defaultAssignedTo)) {
      const assigneeAllowed = await userBelongsToCompany(client, defaultAssignedTo, companyId);
      if (!assigneeAllowed) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "ASSIGNEE_COMPANY_MISMATCH" });
      }
    }

    const created = [];
    const skipped = [];
    const pendingNotifications = [];

    for (const raw of items) {
      const item = raw && typeof raw === "object" ? raw : {};
      const companyName = typeof item.company_name === "string" ? item.company_name.trim() : "";
      if (!companyName) {
        skipped.push({ reason: "MISSING_COMPANY", item });
        continue;
      }

      const assignedTo =
        item.assigned_to === null || item.assigned_to === undefined
          ? defaultAssignedTo
          : Number(item.assigned_to);
      if (Number.isFinite(assignedTo)) {
        const assigneeAllowed = await userBelongsToCompany(client, assignedTo, companyId);
        if (!assigneeAllowed) {
          skipped.push({ reason: "ASSIGNEE_COMPANY_MISMATCH", company_name: companyName });
          continue;
        }
      }

      const numRes = await client.query(`select next_document_number('L') as lead_number`);
      const leadNumber = numRes.rows[0]?.lead_number;
      const leadRes = await client.query(
        `
          insert into leads (
            lead_number,
            company_id,
            company_name,
            lead_source_id,
            marketing_campaign_id,
            marketing_exhibition_id,
            distributor_id,
            customer_id,
            status,
            priority,
            assigned_to,
            created_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          returning *
        `,
        [
          leadNumber,
          companyId,
          companyName,
          attribution.resolvedLeadSourceId,
          Number.isFinite(marketingCampaignId) ? marketingCampaignId : null,
          Number.isFinite(marketingExhibitionId) ? marketingExhibitionId : null,
          isDistributor ? distributorIdForUser : null,
          null,
          "new",
          typeof item.priority === "string" ? item.priority : defaultPriority,
          Number.isFinite(assignedTo) ? assignedTo : null,
          req.user.id,
        ]
      );
      const lead = leadRes.rows[0];

      const contactName = typeof item.contact_name === "string" ? item.contact_name.trim() : "";
      const contactEmail = typeof item.email === "string" ? item.email.trim() : "";
      const contactPhone = typeof item.phone === "string" ? item.phone.trim() : "";
      if (contactName || contactEmail || contactPhone) {
        await client.query(
          `
            insert into lead_contacts (lead_id, full_name, email, phone, designation, is_primary)
            values ($1,$2,$3,$4,$5,$6)
          `,
          [
            lead.id,
            contactName || companyName,
            contactEmail || null,
            contactPhone || null,
            typeof item.designation === "string" && item.designation.trim() ? item.designation.trim() : null,
            true,
          ]
        );
      }

      if (Number.isFinite(assignedTo)) {
        await client.query(
          `
            insert into lead_assignments (lead_id, assigned_to, assigned_by, assignment_reason)
            values ($1,$2,$3,$4)
          `,
          [
            lead.id,
            assignedTo,
            req.user.id,
            Number.isFinite(marketingExhibitionId) ? "Exhibition intake" : "Campaign intake",
          ]
        );
        pendingNotifications.push({
          leadId: lead.id,
          leadNumber: lead.lead_number,
          companyName: lead.company_name,
          assignedTo,
          assignedBy: req.user.id,
          companyId: lead.company_id || companyId,
          reason: Number.isFinite(marketingExhibitionId) ? "Exhibition intake" : "Campaign intake",
        });
      }

      created.push({ id: lead.id, lead_number: lead.lead_number, company_name: lead.company_name });
    }

    await client.query("commit");
    for (const notification of pendingNotifications) {
      notifyLeadAssigned(notification).catch(() => {});
    }
    return res.status(201).json({
      ok: true,
      created_count: created.length,
      skipped_count: skipped.length,
      created,
      skipped,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/activities", requireScreenAction("leads", "can_edit"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const activityType =
      typeof body.activity_type === "string" ? body.activity_type.trim().toLowerCase() || "note" : "note";
    const subject =
      typeof body.subject === "string" ? body.subject.trim() : "";
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    const dueAt =
      typeof body.due_at === "string" && body.due_at.length ? body.due_at : null;
    const contactOutcome =
      typeof body.contact_outcome === "string" ? body.contact_outcome.trim().toLowerCase() : "";
    if (contactOutcome && !CONTACT_OUTCOMES.includes(contactOutcome)) {
      return res.status(400).json({ ok: false, error: "INVALID_OUTCOME" });
    }

    if (!subject) return res.status(400).json({ ok: false });

    const leadRes = await pool.query(
      `select id, company_id, distributor_id, assigned_to, created_by, status, lead_number, company_name,
              assigned_at, first_response_at
       from leads where id = $1 limit 1`,
      [id]
    );
    const lead = leadRes.rows[0] || null;
    if (!lead) return res.status(404).json({ ok: false });
    const distributorId = req.user.group_name === "Distributor" ? await getDistributorIdForUser(req.user.id) : null;
    if (!canAccessLead(req, lead, distributorId)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const { rows } = await pool.query(
      `
        insert into lead_activities (lead_id, activity_type, subject, notes, due_at, contact_outcome, created_by)
        values ($1,$2,$3,$4,$5,$6,$7)
        returning *
      `,
      [id, activityType, subject, notes || null, dueAt, contactOutcome || null, req.user.id]
    );

    const sets = ["updated_at = now()", "last_sales_engagement_at = now()", "newsletter_segment = null", "dormant_since = null"];
    const params = [id];
    if (lead.assigned_at && !lead.first_response_at) {
      sets.push("first_response_at = now()");
    }
    if (LEAD_RESPONSE_ACTIVITY_TYPES.has(activityType) && LEAD_FOLLOW_UP_BUMP_STATUSES.has(String(lead.status || ""))) {
      params.push("follow_up");
      sets.push(`status = $${params.length}`);
      params.push("sql");
      sets.push(`lifecycle_status = $${params.length}`);
      params.push("follow_up");
      sets.push(`sales_activity_status = $${params.length}`);
    } else if (LEAD_RESPONSE_ACTIVITY_TYPES.has(activityType) && String(lead.sales_activity_status || "") === "uncontacted") {
      params.push("contacted");
      sets.push(`sales_activity_status = $${params.length}`);
    }
    await pool.query(`update leads set ${sets.join(", ")} where id = $1`, params);

    if (contactOutcome === "meeting_booked") {
      await recordEngagementEvent(pool, {
        leadId: id,
        companyId: lead.company_id,
        eventType: "meeting_booked",
        sourceTable: "lead_activities",
        sourceId: rows[0].id,
      });
    }

    if (dueAt && lead.assigned_to) {
      notifyLeadFollowUpDue({
        leadId: id,
        leadNumber: lead.lead_number,
        companyName: lead.company_name,
        assignedTo: lead.assigned_to,
        actorUserId: req.user.id,
        companyId: lead.company_id,
        dueAt,
        activitySubject: subject,
      }).catch(() => {});
    }

    return res.status(201).json({ ok: true, activity: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/assign", requireScreenAction("leads", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const assignedTo = Number(body.assigned_to);
    const reason =
      typeof body.assignment_reason === "string"
        ? body.assignment_reason.trim()
        : "";
    const slaRaw = Number(body.assign_sla_hours);
    const assignSlaHours =
      Number.isFinite(slaRaw) && slaRaw > 0 ? Math.min(Math.trunc(slaRaw), 168) : 24;
    const requireNextActivity = body.require_next_activity !== false;
    const nextDueRaw = typeof body.next_activity_due_at === "string" ? body.next_activity_due_at.trim() : "";
    const nextDueAt = nextDueRaw || null;

    if (!Number.isFinite(assignedTo)) return res.status(400).json({ ok: false });

    await client.query("begin");

    const leadRes = await client.query(
      `select id, company_id, distributor_id, assigned_to, created_by, lead_number, company_name
       from leads where id = $1 limit 1`,
      [id]
    );
    const lead = leadRes.rows[0] || null;
    if (!lead) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    const distributorId = req.user.group_name === "Distributor" ? await getDistributorIdForUser(req.user.id) : null;
    if (!canAccessLead(req, lead, distributorId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const assigneeAllowed = await userBelongsToCompany(client, assignedTo, lead.company_id);
    if (!assigneeAllowed) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "ASSIGNEE_COMPANY_MISMATCH" });
    }

    await client.query(
      `
        update leads
        set
          assigned_to = $1,
          assigned_at = now(),
          assign_sla_hours = $2,
          first_response_at = null,
          updated_at = now()
        where id = $3
      `,
      [assignedTo, assignSlaHours, id]
    );

    await client.query(
      `
        insert into lead_assignments (lead_id, assigned_to, assigned_by, assignment_reason)
        values ($1,$2,$3,$4)
      `,
      [id, assignedTo, req.user.id, reason || null]
    );

    if (requireNextActivity) {
      await client.query(
        `
          insert into lead_activities (lead_id, activity_type, subject, notes, due_at, created_by)
          values ($1,'note','Next activity required',$2,$3,$4)
        `,
        [
          id,
          reason ? `Handoff: ${reason}` : "Complete the first response before the assign SLA expires.",
          nextDueAt || new Date(Date.now() + assignSlaHours * 3600000).toISOString(),
          req.user.id,
        ]
      );
    }

    await client.query("commit");

    notifyLeadAssigned({
      leadId: id,
      leadNumber: lead.lead_number,
      companyName: lead.company_name,
      assignedTo,
      assignedBy: req.user.id,
      companyId: lead.company_id,
      reason: reason || "",
      assignSlaHours,
      requireNextActivity,
    }).catch(() => {});

    return res.json({ ok: true, assign_sla_hours: assignSlaHours });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/convert-to-customer", requireScreenAction("leads", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });
    if (!hasScreenAction(req, "customers", "can_create") && !hasScreenAction(req, "customers", "can_edit")) {
      return res.status(403).json({ ok: false, error: "CUSTOMER_PERMISSION_REQUIRED" });
    }

    await client.query("begin");

    const isDistributor = req.user.group_name === "Distributor";
    const distributorIdForUser = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
    if (isDistributor && !distributorIdForUser) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    }

    const leadRes = await client.query(`select * from leads where id = $1 for update`, [id]);

    const lead = leadRes.rows[0] || null;
    if (!lead) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessLead(req, lead, distributorIdForUser)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    if (isDistributor && lead.distributor_id !== distributorIdForUser) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    if (lead.customer_id) {
      await ensureCustomerCompanyAccess(client, req, lead.customer_id);
      await linkCustomerToCompany(client, lead.customer_id, lead.company_id, "shared");
      const existingCustomer = await client.query(
        `select * from customers where id = $1 limit 1`,
        [lead.customer_id]
      );
      await client.query("commit");
      return res.json({
        ok: true,
        customer: existingCustomer.rows[0] || null,
        lead_id: id,
      });
    }

    const contactRes = await client.query(
      `
        select *
        from lead_contacts
        where lead_id = $1
        order by is_primary desc, id asc
        limit 1
      `,
      [id]
    );

    const contact = contactRes.rows[0] || null;
    const contactEmail =
      contact && typeof contact.email === "string" && contact.email.length
        ? contact.email.toLowerCase()
        : null;
    const contactPhone =
      contact && typeof contact.phone === "string" && contact.phone.length
        ? contact.phone
        : null;

    const result = await createCustomerFromParty(client, {
      party: {
        customer_name: lead.company_name,
        email: contactEmail,
        phone: contactPhone,
        contact_name: contact?.full_name || null,
        contact_email: contactEmail,
        contact_phone: contactPhone,
        contact_designation: contact?.designation || null,
        contact_roles: ["sales_enquiry", "quote_recipient"],
      },
      companyId: lead.company_id,
      distributorId: Number.isFinite(Number(lead.distributor_id)) ? Number(lead.distributor_id) : null,
      reuseExistingByEmail: true,
      ownershipType: "owned",
    });
    const customer = result.customer;
    const customerCreated = result.created === true;

    await client.query(
      `
        update leads
        set customer_id = $1,
            converted_customer_id = $1,
            updated_at = now()
        where id = $2
      `,
      [customer.id, id]
    );

    await client.query(
      `
        insert into lead_activities (lead_id, activity_type, subject, notes, created_by)
        values ($1,'note',$2,$3,$4)
      `,
      [
        id,
        customerCreated ? "Converted to customer" : "Linked existing customer",
        `Customer: ${customer.customer_name}`,
        req.user.id,
      ]
    );

    await client.query("commit");
    return res.json({ ok: true, customer, lead_id: id });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
