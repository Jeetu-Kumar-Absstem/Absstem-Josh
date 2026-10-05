/**
 * Trade show ROI — cost-per-lead and closed-won revenue from leads.trade_show_campaign_id.
 */

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

async function loadTradeShowRoiRows(client, { companyId = null, campaignId = null } = {}) {
  const params = [];
  const where = [];
  if (companyId) {
    params.push(companyId);
    where.push(`(t.company_id is null or t.company_id = $${params.length})`);
  }
  if (campaignId) {
    params.push(asInt(campaignId));
    where.push(`t.id = $${params.length}`);
  }

  const { rows } = await client.query(
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
        t.id,
        t.company_id,
        t.event_name,
        t.event_date,
        t.total_spend,
        t.status,
        t.marketing_exhibition_id,
        t.region,
        t.notes,
        count(distinct l.id)::int as lead_count,
        count(distinct l.id) filter (where l.status = 'order_won')::int as closed_won_leads,
        count(distinct l.id) filter (
          where l.customer_id is not null
             or l.converted_customer_id is not null
             or l.converted_quote_id is not null
             or l.converted_sales_order_id is not null
        )::int as fruitful_leads,
        coalesce(sum(coalesce(q.quote_value, 0)), 0)::numeric(14, 2) as quote_value,
        coalesce(sum(coalesce(o.order_value, 0)), 0)::numeric(14, 2) as closed_won_revenue,
        coalesce(sum(coalesce(o.sales_order_count, 0)), 0)::int as sales_order_count
      from trade_show_campaigns t
      left join leads l on l.trade_show_campaign_id = t.id
      left join quote_rollup q on q.lead_id = l.id
      left join order_rollup o on o.lead_id = l.id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      group by
        t.id, t.company_id, t.event_name, t.event_date, t.total_spend, t.status,
        t.marketing_exhibition_id, t.region, t.notes
      order by t.event_date desc nulls last, t.id desc
    `,
    params
  );

  return rows.map((row) => {
    const spend = money(row.total_spend);
    const leads = Number(row.lead_count || 0);
    const won = Number(row.closed_won_leads || 0);
    const revenue = money(row.closed_won_revenue);
    return {
      ...row,
      total_spend: spend,
      quote_value: money(row.quote_value),
      closed_won_revenue: revenue,
      cost_per_lead: leads > 0 ? money(spend / leads) : null,
      cost_per_closed_won: won > 0 ? money(spend / won) : null,
      roi_multiple: spend > 0 ? money(revenue / spend) : null,
    };
  });
}

module.exports = {
  loadTradeShowRoiRows,
};
