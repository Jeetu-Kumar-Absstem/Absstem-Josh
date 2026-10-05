async function loadCampaignRoi(client, companyId, campaignId) {
  const { rows } = await client.query(
    `
      with attributed as (
        select
          l.id,
          l.lifecycle_status,
          l.status,
          l.customer_id,
          l.converted_customer_id,
          l.converted_quote_id,
          l.converted_sales_order_id
        from leads l
        where l.company_id = $1
          and l.first_touch_campaign_id = $2
      ),
      quote_rollup as (
        select
          qh.lead_id,
          count(distinct qh.id)::int as quote_count,
          coalesce(sum(coalesce(qr.grand_total_quote, 0)), 0)::numeric as quote_value
        from quote_headers qh
        left join quote_revisions qr on qr.quote_id = qh.id and qr.is_latest = true
        where qh.lead_id in (select id from attributed)
        group by qh.lead_id
      ),
      order_rollup as (
        select
          qh.lead_id,
          count(distinct so.id)::int as sales_order_count,
          coalesce(sum(coalesce(so.grand_total_order, 0)), 0)::numeric as order_value
        from sales_orders so
        left join quote_revisions qr on qr.id = so.quote_revision_id
        left join quote_headers qh on qh.id = qr.quote_id
        where qh.lead_id in (select id from attributed)
        group by qh.lead_id
      )
      select
        c.id,
        c.campaign_name,
        c.channel_type,
        c.planned_budget,
        c.actual_spend,
        c.utm_source,
        c.utm_medium,
        c.utm_campaign,
        count(a.id)::int as lead_count,
        count(a.id) filter (where a.lifecycle_status = 'mql')::int as mql_count,
        count(a.id) filter (where a.lifecycle_status = 'sql')::int as sql_count,
        count(a.id) filter (where a.lifecycle_status = 'negotiation')::int as negotiation_count,
        count(a.id) filter (where a.lifecycle_status = 'won')::int as won_count,
        count(a.id) filter (
          where a.customer_id is not null
             or a.converted_customer_id is not null
             or a.converted_quote_id is not null
             or a.converted_sales_order_id is not null
        )::int as fruitful_leads,
        coalesce(sum(q.quote_count), 0)::int as quote_count,
        coalesce(sum(q.quote_value), 0)::numeric as quote_value,
        coalesce(sum(o.sales_order_count), 0)::int as sales_order_count,
        coalesce(sum(o.order_value), 0)::numeric as order_value
      from marketing_campaigns c
      left join attributed a on true
      left join quote_rollup q on q.lead_id = a.id
      left join order_rollup o on o.lead_id = a.id
      where c.company_id = $1
        and c.id = $2
      group by
        c.id, c.campaign_name, c.channel_type, c.planned_budget, c.actual_spend,
        c.utm_source, c.utm_medium, c.utm_campaign
    `,
    [companyId, campaignId]
  );
  const row = rows[0];
  if (!row) return null;
  const spend = Number(row.actual_spend || 0);
  const leads = Number(row.lead_count || 0);
  const mql = Number(row.mql_count || 0);
  const sql = Number(row.sql_count || 0);
  const orders = Number(row.sales_order_count || 0);
  const orderValue = Number(row.order_value || 0);
  const ratio = (num, den) => (den > 0 ? spend / den : 0);
  return {
    campaign_id: row.id,
    campaign_name: row.campaign_name,
    channel_type: row.channel_type,
    attribution: "first_touch",
    planned_budget: Number(row.planned_budget || 0),
    actual_spend: spend,
    utm: {
      source: row.utm_source,
      medium: row.utm_medium,
      campaign: row.utm_campaign,
    },
    lead_count: leads,
    mql_count: mql,
    sql_count: sql,
    negotiation_count: Number(row.negotiation_count || 0),
    won_count: Number(row.won_count || 0),
    fruitful_leads: Number(row.fruitful_leads || 0),
    quote_count: Number(row.quote_count || 0),
    quote_value: Number(row.quote_value || 0),
    sales_order_count: orders,
    order_value: orderValue,
    cpl: ratio(spend, leads),
    cost_per_mql: ratio(spend, mql),
    cost_per_sql: ratio(spend, sql),
    cost_per_order: ratio(spend, orders),
    roi: spend > 0 ? (orderValue - spend) / spend : 0,
  };
}

module.exports = {
  loadCampaignRoi,
};
