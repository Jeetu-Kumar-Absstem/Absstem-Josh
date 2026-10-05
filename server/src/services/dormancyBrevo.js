const DEFAULT_DORMANCY_MONTHS = 6;

async function runDormancyScan(client, { companyId = null, months = DEFAULT_DORMANCY_MONTHS } = {}) {
  const params = [months];
  let companySql = "";
  if (Number.isFinite(Number(companyId))) {
    params.push(Number(companyId));
    companySql = `and l.company_id = $${params.length}`;
  }
  const marked = await client.query(
    `
      update leads l
      set
        newsletter_segment = 'dormant_6m',
        dormant_since = coalesce(l.dormant_since, now()),
        updated_at = now()
      where coalesce(l.lifecycle_status, '') not in ('won', 'cancelled')
        and coalesce(l.status, '') not in ('order_won', 'cancelled')
        and coalesce(l.newsletter_segment, '') is distinct from 'dormant_6m'
        and coalesce(l.last_sales_engagement_at, l.updated_at, l.created_at)
            < now() - make_interval(months => $1)
        ${companySql}
      returning l.id, l.company_id
    `,
    params
  );

  const cleared = await client.query(
    `
      update leads l
      set
        newsletter_segment = null,
        dormant_since = null,
        updated_at = now()
      where l.newsletter_segment = 'dormant_6m'
        and (
          coalesce(l.lifecycle_status, '') = 'won'
          or coalesce(l.last_sales_engagement_at, l.updated_at) >= now() - make_interval(months => $1)
        )
        ${companySql}
      returning l.id, l.company_id
    `,
    params
  );

  return {
    marked: marked.rows.length,
    cleared: cleared.rows.length,
  };
}

async function previewDormancy(client, companyId, { months = DEFAULT_DORMANCY_MONTHS, limit = 25 } = {}) {
  const { rows } = await client.query(
    `
      select
        l.id,
        l.lead_number,
        l.company_name,
        l.lifecycle_status,
        l.last_sales_engagement_at,
        l.newsletter_segment,
        lc.email
      from leads l
      left join lead_contacts lc on lc.lead_id = l.id and lc.is_primary = true
      where l.company_id = $1
        and (
          l.newsletter_segment = 'dormant_6m'
          or (
            coalesce(l.lifecycle_status, '') not in ('won', 'cancelled')
            and coalesce(l.last_sales_engagement_at, l.updated_at, l.created_at)
                < now() - make_interval(months => $2)
          )
        )
      order by l.last_sales_engagement_at nulls first, l.id
      limit $3
    `,
    [companyId, months, limit]
  );
  const countRes = await client.query(
    `
      select count(*)::int as n
      from leads
      where company_id = $1
        and newsletter_segment = 'dormant_6m'
    `,
    [companyId]
  );
  return { sample: rows, dormant_count: Number(countRes.rows[0]?.n || 0) };
}

async function syncBrevoSegment(client, companyId) {
  const apiKey = String(process.env.BREVO_API_KEY || "").trim();
  const listId = Number(process.env.BREVO_DORMANT_LIST_ID || 0);
  if (!apiKey) {
    const err = new Error("BREVO_NOT_CONFIGURED");
    err.status = 400;
    err.code = "BREVO_NOT_CONFIGURED";
    throw err;
  }

  const { rows } = await client.query(
    `
      select
        l.id,
        l.brevo_contact_id,
        l.newsletter_segment,
        lc.email,
        lc.full_name
      from leads l
      join lead_contacts lc on lc.lead_id = l.id and lc.is_primary = true
      where l.company_id = $1
        and lc.email is not null
        and not exists (
          select 1 from email_opt_outs eo where lower(eo.email::text) = lower(lc.email::text)
        )
        and (
          l.newsletter_segment = 'dormant_6m'
          or l.brevo_contact_id is not null
        )
      limit 500
    `,
    [companyId]
  );

  const results = { pushed: 0, removed: 0, errors: 0 };
  for (const row of rows) {
    const email = String(row.email || "").trim();
    if (!email) continue;
    const add = row.newsletter_segment === "dormant_6m";
    try {
      const payload = add
        ? {
            email,
            attributes: { FIRSTNAME: row.full_name || "", JOSH_LEAD_ID: String(row.id), COMPANY_ID: String(companyId) },
            listIds: Number.isFinite(listId) && listId > 0 ? [listId] : undefined,
            updateEnabled: true,
          }
        : {
            email,
            unlinkListIds: Number.isFinite(listId) && listId > 0 ? [listId] : undefined,
            updateEnabled: true,
          };
      const resp = await fetch("https://api.brevo.com/v3/contacts", {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      const bodyText = await resp.text().catch(() => "");
      if (!resp.ok && resp.status !== 204) {
        results.errors += 1;
        await client.query(
          `insert into brevo_sync_logs (company_id, action, payload_summary, status, error_text) values ($1,$2,$3,'error',$4)`,
          [companyId, add ? "upsert" : "remove", email, bodyText.slice(0, 500)]
        );
        continue;
      }
      if (add) results.pushed += 1;
      else results.removed += 1;
      await client.query(
        `insert into brevo_sync_logs (company_id, action, payload_summary, status) values ($1,$2,$3,'ok')`,
        [companyId, add ? "upsert" : "remove", email]
      );
    } catch (err) {
      results.errors += 1;
      await client.query(
        `insert into brevo_sync_logs (company_id, action, payload_summary, status, error_text) values ($1,$2,$3,'error',$4)`,
        [companyId, add ? "upsert" : "remove", email, String(err?.message || err).slice(0, 500)]
      );
    }
  }
  return results;
}

function startDormancyWorker(pool) {
  const enabled = String(process.env.BREVO_SYNC_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return { started: false };
  const hours = Math.max(1, Number(process.env.DORMANCY_SCAN_HOURS || 6));
  const timer = setInterval(() => {
    runDormancyScan(pool).catch((err) => {
      process.stderr.write(`[dormancy] scan failed: ${err?.message || err}\n`);
    });
  }, hours * 60 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  runDormancyScan(pool).catch(() => {});
  return { started: true, hours };
}

module.exports = {
  DEFAULT_DORMANCY_MONTHS,
  runDormancyScan,
  previewDormancy,
  syncBrevoSegment,
  startDormancyWorker,
};
