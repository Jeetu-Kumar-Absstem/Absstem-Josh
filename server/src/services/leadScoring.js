const POINT_MAP = {
  quote_mail_open: 5,
  quote_link_click: 10,
  marketing_mail_open: 2,
  marketing_mail_click: 8,
  website_revisit: 3,
  pdf_view: 5,
  meeting_booked: 15,
  manual_adjust: 0,
};

async function recomputeScore(client, leadId) {
  const { rows } = await client.query(
    `
      select coalesce(sum(points), 0)::numeric as score
      from lead_engagement_events
      where lead_id = $1
    `,
    [leadId]
  );
  const score = Number(rows[0]?.score || 0);
  let temperature = null;
  if (score >= 40) temperature = "hot";
  else if (score >= 15) temperature = "warm";
  await client.query(
    `
      update leads
      set
        engagement_score = $2,
        engagement_score_updated_at = now(),
        sales_temperature = case
          when $3::text is null then sales_temperature
          else $3
        end,
        last_sales_engagement_at = now(),
        newsletter_segment = null,
        dormant_since = null,
        updated_at = now()
      where id = $1
    `,
    [leadId, score, temperature]
  );
  return score;
}

async function recordEngagementEvent(client, {
  leadId,
  companyId,
  eventType,
  sourceTable = null,
  sourceId = null,
  points = null,
  meta = null,
}) {
  const id = Number(leadId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const type = String(eventType || "").trim();
  if (!POINT_MAP[type] && type !== "manual_adjust") return null;

  if (type === "quote_mail_open" || type === "marketing_mail_open") {
    const cap = await client.query(
      `
        select count(*)::int as n
        from lead_engagement_events
        where lead_id = $1
          and event_type = $2
          and occurred_at::date = current_date
      `,
      [id, type]
    );
    if (Number(cap.rows[0]?.n || 0) >= 1) return null;
  }

  const pts = Number.isFinite(Number(points)) ? Number(points) : POINT_MAP[type] || 0;
  try {
    const { rows } = await client.query(
      `
        insert into lead_engagement_events (
          company_id, lead_id, event_type, source_table, source_id, points, meta
        )
        values ($1,$2,$3,$4,$5,$6,$7::jsonb)
        returning id
      `,
      [
        companyId || null,
        id,
        type,
        sourceTable,
        sourceId,
        pts,
        meta ? JSON.stringify(meta) : null,
      ]
    );
    if (!rows[0] && sourceId) return null;
  } catch {
    return null;
  }
  await recomputeScore(client, id);
  return true;
}

async function recordQuoteMailOpen(client, quoteRevisionId) {
  const { rows } = await client.query(
    `
      select qh.lead_id, qh.company_id, qml.id as log_id
      from quote_revisions qr
      join quote_headers qh on qh.id = qr.quote_id
      left join quote_mail_logs qml on qml.quote_revision_id = qr.id
      where qr.id = $1
        and qh.lead_id is not null
      limit 1
    `,
    [quoteRevisionId]
  );
  const row = rows[0];
  if (!row?.lead_id) return;
  await recordEngagementEvent(client, {
    leadId: row.lead_id,
    companyId: row.company_id,
    eventType: "quote_mail_open",
    sourceTable: "quote_mail_logs",
    sourceId: row.log_id || quoteRevisionId,
  });
}

async function recordMarketingMailEvent(client, trackingToken, eventType) {
  const { rows } = await client.query(
    `
      select
        l.id as lead_id,
        l.company_id,
        ml.id as log_id
      from marketing_mail_logs ml
      join lead_contacts lc
        on lower(lc.email::text) = lower(ml.to_email::text)
      join leads l on l.id = lc.lead_id and l.company_id = ml.company_id
      where ml.tracking_token = $1
      limit 1
    `,
    [trackingToken]
  );
  const row = rows[0];
  if (!row?.lead_id) return;
  await recordEngagementEvent(client, {
    leadId: row.lead_id,
    companyId: row.company_id,
    eventType,
    sourceTable: "marketing_mail_logs",
    sourceId: row.log_id,
  });
}

module.exports = {
  POINT_MAP,
  recordEngagementEvent,
  recordQuoteMailOpen,
  recordMarketingMailEvent,
  recomputeScore,
};
