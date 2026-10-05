const crypto = require("crypto");
const { normalizePhoneDigits } = require("./leadPhone");
const { CHANNELS } = require("./leadTaxonomy");
const { lookupPincode, maybeAutoAssignTerritory } = require("./geoRouting");

const CHANNEL_SOURCE_CODE = {
  website: "WEBSITE_FORM",
  google_lead_form: "GOOGLE_LEAD_FORM",
  meta_lead_form: "META_LEAD_FORM",
  linkedin_lead_form: "LINKEDIN_LEAD_FORM",
  whatsapp: "WHATSAPP_API",
  telephony_tollfree: "TOLLFREE_TELEPHONY",
  qr_form: "QR_FORM",
  exhibition_form: "EXHIBITION",
  email_inbound: "EMAIL_INBOUND",
  manual: null,
};

function hashIngestKey(plain) {
  return crypto.createHash("sha256").update(String(plain || ""), "utf8").digest("hex");
}

function normalizeChannel(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (CHANNELS.includes(raw)) return raw;
  const aliases = {
    google: "google_lead_form",
    meta: "meta_lead_form",
    facebook: "meta_lead_form",
    linkedin: "linkedin_lead_form",
    telephony: "telephony_tollfree",
    tollfree: "telephony_tollfree",
    qr: "qr_form",
    exhibition: "exhibition_form",
    email: "email_inbound",
  };
  return aliases[raw] || "manual";
}

function trimText(value, max = 240) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  return raw.slice(0, max);
}

async function resolveSourceId(client, companyId, channel, explicitSourceId) {
  if (Number.isFinite(Number(explicitSourceId))) return Number(explicitSourceId);
  const code = CHANNEL_SOURCE_CODE[channel];
  if (!code) return null;
  const { rows } = await client.query(
    `select id from lead_sources where source_code = $1 and is_active = true limit 1`,
    [code]
  );
  return rows[0]?.id ? Number(rows[0].id) : null;
}

async function findMatchingLead(client, companyId, { phone, email }) {
  const digits = normalizePhoneDigits(phone);
  if (digits && digits.length >= 7) {
    const { rows } = await client.query(
      `
        select l.id
        from lead_contacts lc
        join leads l on l.id = lc.lead_id
        where l.company_id = $1
          and lc.phone_digits = $2
        order by lc.is_primary desc, l.id desc
        limit 1
      `,
      [companyId, digits]
    );
    if (rows[0]) return { leadId: Number(rows[0].id), matchMethod: "phone" };
  }
  const emailNorm = String(email || "").trim().toLowerCase();
  if (emailNorm) {
    const { rows } = await client.query(
      `
        select l.id
        from lead_contacts lc
        join leads l on l.id = lc.lead_id
        where l.company_id = $1
          and lower(lc.email::text) = $2
        order by lc.is_primary desc, l.id desc
        limit 1
      `,
      [companyId, emailNorm]
    );
    if (rows[0]) return { leadId: Number(rows[0].id), matchMethod: "email" };
  }
  return null;
}

async function insertTouchpoint(client, payload) {
  const { rows } = await client.query(
    `
      insert into lead_touchpoints (
        company_id, lead_id, channel, occurred_at, lead_source_id,
        marketing_campaign_id, marketing_exhibition_id,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        gclid, fbclid, li_fat_id, external_event_id, raw_payload,
        contact_name, email, phone, phone_digits, company_name,
        city, state, pincode, country, match_method
      )
      values (
        $1,$2,$3,coalesce($4::timestamptz, now()),$5,
        $6,$7,
        $8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17::jsonb,
        $18,$19,$20,$21,$22,
        $23,$24,$25,$26,$27
      )
      returning *
    `,
    [
      payload.companyId,
      payload.leadId,
      payload.channel,
      payload.occurredAt || null,
      payload.leadSourceId || null,
      payload.marketingCampaignId || null,
      payload.marketingExhibitionId || null,
      payload.utmSource || null,
      payload.utmMedium || null,
      payload.utmCampaign || null,
      payload.utmTerm || null,
      payload.utmContent || null,
      payload.gclid || null,
      payload.fbclid || null,
      payload.liFatId || null,
      payload.externalEventId || null,
      payload.rawPayload ? JSON.stringify(payload.rawPayload) : null,
      payload.contactName || null,
      payload.email || null,
      payload.phone || null,
      payload.phoneDigits || null,
      payload.companyName || null,
      payload.city || null,
      payload.state || null,
      payload.pincode || null,
      payload.country || null,
      payload.matchMethod || null,
    ]
  );
  return rows[0];
}

async function stampLeadTouch(client, leadId, { channel, campaignId, isFirst }) {
  await client.query(
    `
      update leads
      set
        last_touchpoint_at = now(),
        last_touch_channel = $2,
        last_touch_campaign_id = coalesce($3, last_touch_campaign_id),
        marketing_campaign_id = coalesce($3, marketing_campaign_id),
        first_touch_channel = case when $4 then coalesce(first_touch_channel, $2) else first_touch_channel end,
        first_touch_campaign_id = case when $4 then coalesce(first_touch_campaign_id, $3) else first_touch_campaign_id end,
        updated_at = now()
      where id = $1
    `,
    [leadId, channel, campaignId || null, Boolean(isFirst)]
  );

  if (Number.isFinite(Number(campaignId))) {
    await client.query(
      `
        insert into lead_campaign_attributions (company_id, lead_id, campaign_id, role)
        select company_id, id, $2, $3
        from leads
        where id = $1
        on conflict (lead_id, campaign_id, role) do nothing
      `,
      [leadId, Number(campaignId), isFirst ? "first" : "assist"]
    );
  }
}

async function appendToExistingLead(client, { leadId, companyId, actorId, payload, matchMethod }) {
  const touch = await insertTouchpoint(client, {
    ...payload,
    leadId,
    matchMethod,
  });
  await stampLeadTouch(client, leadId, {
    channel: payload.channel,
    campaignId: payload.marketingCampaignId,
    isFirst: false,
  });
  await client.query(
    `
      insert into lead_activities (lead_id, activity_type, subject, notes, created_by)
      values ($1, 'note', $2, $3, $4)
    `,
    [
      leadId,
      `Repeat touch — ${payload.channel}`,
      `Appended ${payload.channel} touchpoint${payload.phone ? ` (${payload.phone})` : ""}.`,
      actorId || null,
    ]
  );
  await client.query(
    `update leads set last_sales_engagement_at = now(), newsletter_segment = null, dormant_since = null, updated_at = now() where id = $1`,
    [leadId]
  );
  return { leadId, touchpoint: touch, appended: true, matchMethod };
}

async function createLeadFromIngest(client, { companyId, actorId, payload, omitPhone = false }) {
  const numRes = await client.query(`select next_document_number('L') as lead_number`);
  const leadNumber = numRes.rows[0]?.lead_number;
  const geo = payload.pincode ? await lookupPincode(client, payload.pincode) : null;
  const city = payload.city || geo?.city_name || null;
  const state = payload.state || geo?.state_name || null;
  const country = payload.country || geo?.country_code || (geo ? "IN" : null);

  const leadRes = await client.query(
    `
      insert into leads (
        lead_number, company_id, company_name, lead_source_id,
        marketing_campaign_id, marketing_exhibition_id,
        status, lifecycle_status, sales_activity_status, sales_temperature, priority,
        city, state, pincode, country,
        first_touch_campaign_id, last_touch_campaign_id, first_touch_channel, last_touch_channel,
        last_touchpoint_at, last_sales_engagement_at, created_by
      )
      values (
        $1,$2,$3,$4,
        $5,$6,
        'new','new_lead','uncontacted',coalesce($7,'warm'),'medium',
        $8,$9,$10,$11,
        $5,$5,$12,$12,
        now(), now(), $13
      )
      returning *
    `,
    [
      leadNumber,
      companyId,
      payload.companyName || "Unknown",
      payload.leadSourceId || null,
      payload.marketingCampaignId || null,
      payload.marketingExhibitionId || null,
      payload.salesTemperature || "warm",
      city,
      state,
      payload.pincode || null,
      country,
      payload.channel,
      actorId || null,
    ]
  );
  const lead = leadRes.rows[0];

  const contactName = payload.contactName || payload.companyName || "Contact";
  const phone = omitPhone ? null : payload.phone;
  await client.query(
    `
      insert into lead_contacts (lead_id, full_name, email, phone, is_primary)
      values ($1,$2,$3,$4,true)
    `,
    [lead.id, contactName, payload.email || null, phone]
  );

  const touch = await insertTouchpoint(client, {
    ...payload,
    leadId: lead.id,
    city,
    state,
    country,
    matchMethod: "created_new",
  });
  await stampLeadTouch(client, lead.id, {
    channel: payload.channel,
    campaignId: payload.marketingCampaignId,
    isFirst: true,
  });

  if (!payload.skipAutoAssign) {
    await maybeAutoAssignTerritory(client, {
      leadId: lead.id,
      companyId,
      pincode: payload.pincode,
      city,
      state,
      actorId,
    });
  }

  return { lead, touchpoint: touch, appended: false, matchMethod: "created_new", phone_omitted: omitPhone };
}

function buildPayloadFromBody(body, { companyId, channel }) {
  const contacts = Array.isArray(body.contacts) ? body.contacts : [];
  const primary = contacts.find((c) => c && c.is_primary) || contacts[0] || {};
  const phone = trimText(body.phone || primary.phone, 40);
  return {
    companyId,
    channel,
    occurredAt: body.occurred_at || null,
    leadSourceId: Number.isFinite(Number(body.lead_source_id)) ? Number(body.lead_source_id) : null,
    marketingCampaignId: Number.isFinite(Number(body.marketing_campaign_id)) ? Number(body.marketing_campaign_id) : null,
    marketingExhibitionId: Number.isFinite(Number(body.marketing_exhibition_id))
      ? Number(body.marketing_exhibition_id)
      : null,
    utmSource: trimText(body.utm_source),
    utmMedium: trimText(body.utm_medium),
    utmCampaign: trimText(body.utm_campaign),
    utmTerm: trimText(body.utm_term),
    utmContent: trimText(body.utm_content),
    gclid: trimText(body.gclid, 120),
    fbclid: trimText(body.fbclid, 120),
    liFatId: trimText(body.li_fat_id, 120),
    externalEventId: trimText(body.external_event_id || body.external_id, 180),
    rawPayload: body.raw_payload && typeof body.raw_payload === "object" ? body.raw_payload : null,
    contactName: trimText(body.contact_name || primary.full_name),
    email: trimText(body.email || primary.email, 180),
    phone,
    phoneDigits: normalizePhoneDigits(phone) || null,
    companyName: trimText(body.company_name, 200) || "Unknown",
    city: trimText(body.city, 80),
    state: trimText(body.state, 80),
    pincode: trimText(body.pincode, 12),
    country: trimText(body.country, 40),
    salesTemperature: body.sales_temperature || null,
    skipAutoAssign: Boolean(body.skip_auto_assign),
  };
}

async function ingestLead(client, { companyId, actorId, channel, body, mode = "ingest" }) {
  const resolvedChannel = normalizeChannel(channel || body.channel);
  const payload = buildPayloadFromBody(body, { companyId, channel: resolvedChannel });
  payload.channel = resolvedChannel;
  payload.leadSourceId = await resolveSourceId(client, companyId, resolvedChannel, payload.leadSourceId);

  if (payload.externalEventId) {
    const existing = await client.query(
      `
        select id, lead_id
        from lead_touchpoints
        where company_id = $1 and channel = $2 and external_event_id = $3
        limit 1
      `,
      [companyId, resolvedChannel, payload.externalEventId]
    );
    if (existing.rows[0]) {
      return {
        ok: true,
        idempotent: true,
        lead_id: existing.rows[0].lead_id,
        touchpoint_id: existing.rows[0].id,
        appended: true,
      };
    }
  }

  const match = await findMatchingLead(client, companyId, { phone: payload.phone, email: payload.email });

  if (match && mode === "ingest") {
    const result = await appendToExistingLead(client, {
      leadId: match.leadId,
      companyId,
      actorId,
      payload,
      matchMethod: match.matchMethod,
    });
    return { ok: true, ...result, lead_id: result.leadId };
  }

  if (match && mode === "ui_create" && !body.force_new_lead && !body.append_to_lead_id) {
    const dupRes = await client.query(
      `
        select
          l.id as lead_id,
          l.lead_number,
          l.company_name,
          l.status,
          l.lifecycle_status,
          l.sales_activity_status,
          l.created_at,
          lc.full_name as contact_name,
          lc.email as contact_email,
          lc.phone as contact_phone
        from leads l
        left join lead_contacts lc on lc.lead_id = l.id and lc.is_primary = true
        where l.id = $1
        limit 1
      `,
      [match.leadId]
    );
    const err = new Error("LEAD_DUPLICATE_PHONE");
    err.status = 409;
    err.code = "LEAD_DUPLICATE_PHONE";
    err.duplicates = dupRes.rows;
    throw err;
  }

  if (match && (body.append_to_lead_id || mode === "append")) {
    const appendId = Number(body.append_to_lead_id || match.leadId);
    const result = await appendToExistingLead(client, {
      leadId: appendId,
      companyId,
      actorId,
      payload,
      matchMethod: match.matchMethod || "manual",
    });
    return { ok: true, ...result, lead_id: result.leadId };
  }

  let omitPhone = Boolean(body.force_new_lead) && Boolean(match);
  const created = await createLeadFromIngest(client, {
    companyId,
    actorId,
    payload,
    omitPhone,
  });
  return {
    ok: true,
    lead: created.lead,
    lead_id: created.lead.id,
    touchpoint: created.touchpoint,
    appended: false,
    matchMethod: "created_new",
    warning: omitPhone ? "PHONE_OMITTED_DUPLICATE" : null,
  };
}

async function resolveIngestEndpoint(client, apiKey) {
  const hash = hashIngestKey(apiKey);
  const { rows } = await client.query(
    `
      select *
      from lead_ingestion_endpoints
      where api_key_hash = $1
        and is_enabled = true
      limit 1
    `,
    [hash]
  );
  return rows[0] || null;
}

module.exports = {
  hashIngestKey,
  normalizeChannel,
  findMatchingLead,
  ingestLead,
  appendToExistingLead,
  insertTouchpoint,
  resolveIngestEndpoint,
  CHANNEL_SOURCE_CODE,
};
