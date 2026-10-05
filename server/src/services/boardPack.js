/**
 * Executive board pack compiler — commissioning, trade show ROI, voice of market.
 */

const { loadTradeShowRoiRows } = require("./tradeShowRoi");

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function monthBounds(month, year) {
  const y = asInt(year);
  const m = asInt(month);
  if (!y || !m || m < 1 || m > 12) {
    const err = new Error("INVALID_REPORT_MONTH");
    err.status = 400;
    err.code = "INVALID_REPORT_MONTH";
    throw err;
  }
  const reportMonth = `${y}-${String(m).padStart(2, "0")}-01`;
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return {
    reportMonth,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    year: y,
    month: m,
  };
}

/**
 * Compile a manuscript-ready board pack for the given calendar month.
 * Upserts executive_board_packs as Draft (does not auto-publish).
 */
async function generateBoardPack(client, { month, year, actorUserId, companyId = null }) {
  const actorId = asInt(actorUserId);
  if (!actorId) {
    const err = new Error("ACTOR_REQUIRED");
    err.status = 400;
    err.code = "ACTOR_REQUIRED";
    throw err;
  }

  const bounds = monthBounds(month, year);
  const companyFilter = companyId ? asInt(companyId) : null;

  // ── Commissioning completed in month ─────────────────────────────────────
  const commissioningParams = [bounds.startIso, bounds.endIso];
  let commissioningWhere = `
    ct.status = 'Completed'
    and coalesce(ct.client_signoff_date, ct.updated_at)::timestamptz >= $1::timestamptz
    and coalesce(ct.client_signoff_date, ct.updated_at)::timestamptz < $2::timestamptz
  `;
  if (companyFilter) {
    commissioningParams.push(companyFilter);
    commissioningWhere += ` and (ct.company_id is null or ct.company_id = $${commissioningParams.length})`;
  }

  const commissioningRes = await client.query(
    `
      select
        ct.id,
        ct.sales_order_id,
        ct.customer_id,
        c.customer_name as customer_name,
        ct.assigned_engineer_id,
        u.full_name as engineer_name,
        ct.client_signoff_date,
        ct.updated_at,
        so.so_number,
        so.grand_total_order
      from commissioning_tickets ct
      left join customers c on c.id = ct.customer_id
      left join erp_users u on u.id = ct.assigned_engineer_id
      left join sales_orders so on so.id = ct.sales_order_id
      where ${commissioningWhere}
      order by coalesce(ct.client_signoff_date, ct.updated_at) desc
      limit 200
    `,
    commissioningParams
  );

  const milestoneParams = [bounds.startIso, bounds.endIso];
  let milestoneWhere = `
    pm.due_type = 'commissioning'
    and pm.status in ('ready_to_bill', 'billed')
    and pm.unlocked_at is not null
    and pm.unlocked_at >= $1::timestamptz
    and pm.unlocked_at < $2::timestamptz
  `;
  if (companyFilter) {
    milestoneParams.push(companyFilter);
    milestoneWhere += ` and (so.company_id is null or so.company_id = $${milestoneParams.length})`;
  }

  let milestones = { rows: [] };
  try {
    milestones = await client.query(
      `
        select
          pm.id,
          pm.sales_order_id,
          pm.milestone_name,
          coalesce(pm.milestone_amount_order, pm.milestone_amount_base, 0) as amount,
          pm.status,
          pm.unlocked_at,
          so.so_number
        from payment_milestones pm
        left join sales_orders so on so.id = pm.sales_order_id
        where ${milestoneWhere}
        order by pm.unlocked_at desc nulls last, pm.id desc
        limit 200
      `,
      milestoneParams
    );
  } catch {
    milestones = { rows: [] };
  }

  const commissioningRevenue = commissioningRes.rows.reduce(
    (sum, row) => sum + money(row.grand_total_order),
    0
  );
  const milestoneAmount = milestones.rows.reduce((sum, row) => sum + money(row.amount), 0);

  // ── Trade show ROI (events in month + attributed closed-won) ─────────────
  const tradeShows = await loadTradeShowRoiRows(client, { companyId: companyFilter });
  const tradeShowsInMonth = tradeShows.filter((row) => {
    if (!row.event_date) return false;
    const d = String(row.event_date).slice(0, 10);
    return d >= bounds.reportMonth && d < bounds.endIso.slice(0, 10);
  });
  const tradeShowSpend = tradeShowsInMonth.reduce((s, r) => s + money(r.total_spend), 0);
  const tradeShowLeads = tradeShowsInMonth.reduce((s, r) => s + Number(r.lead_count || 0), 0);
  const tradeShowRevenue = tradeShowsInMonth.reduce((s, r) => s + money(r.closed_won_revenue), 0);

  // ── Voice of market (top notes in month) ─────────────────────────────────
  const vocParams = [bounds.startIso, bounds.endIso];
  let vocWhere = `v.created_at >= $1::timestamptz and v.created_at < $2::timestamptz`;
  if (companyFilter) {
    vocParams.push(companyFilter);
    vocWhere += ` and (v.company_id is null or v.company_id = $${vocParams.length})`;
  }

  const vocRes = await client.query(
    `
      select
        v.id,
        v.source_type,
        v.strategic_category,
        v.severity,
        v.is_highlighted,
        v.feedback_notes,
        v.customer_id,
        v.distributor_id,
        v.submitted_by,
        v.created_at,
        c.customer_name as customer_name,
        d.company_name as distributor_name,
        u.full_name as submitted_by_name
      from voice_of_market_logs v
      left join customers c on c.id = v.customer_id
      left join distributors d on d.id = v.distributor_id
      left join erp_users u on u.id = v.submitted_by
      where ${vocWhere}
      order by
        v.is_highlighted desc,
        case v.severity when 'Critical' then 0 when 'Watch' then 1 else 2 end,
        v.created_at desc
      limit 50
    `,
    vocParams
  );

  const vocByCategory = {};
  for (const row of vocRes.rows) {
    const key = row.strategic_category || "Uncategorized";
    vocByCategory[key] = (vocByCategory[key] || 0) + 1;
  }

  const financial_summary_json = {
    report_month: bounds.reportMonth,
    year: bounds.year,
    month: bounds.month,
    commissioning: {
      completed_count: commissioningRes.rows.length,
      order_value_linked: money(commissioningRevenue),
      milestones_unlocked_or_billed: milestones.rows.length,
      milestone_amount: money(milestoneAmount),
      tickets: commissioningRes.rows.slice(0, 25).map((r) => ({
        id: r.id,
        so_number: r.so_number,
        customer_name: r.customer_name,
        engineer_name: r.engineer_name,
        client_signoff_date: r.client_signoff_date,
        grand_total_order: money(r.grand_total_order),
      })),
    },
    trade_show_roi: {
      campaigns_in_month: tradeShowsInMonth.length,
      total_spend: money(tradeShowSpend),
      lead_count: tradeShowLeads,
      closed_won_revenue: money(tradeShowRevenue),
      blended_cost_per_lead: tradeShowLeads > 0 ? money(tradeShowSpend / tradeShowLeads) : null,
      campaigns: tradeShowsInMonth.map((r) => ({
        id: r.id,
        event_name: r.event_name,
        event_date: r.event_date,
        total_spend: money(r.total_spend),
        lead_count: r.lead_count,
        closed_won_leads: r.closed_won_leads,
        closed_won_revenue: money(r.closed_won_revenue),
        cost_per_lead: r.cost_per_lead,
        roi_multiple: r.roi_multiple,
      })),
    },
  };

  const voc_summary_json = {
    report_month: bounds.reportMonth,
    total_notes: vocRes.rows.length,
    by_category: vocByCategory,
    by_source: {
      voice_of_customer: vocRes.rows.filter((r) => r.source_type === "Voice of Customer").length,
      voice_of_channel: vocRes.rows.filter((r) => r.source_type === "Voice of Channel").length,
    },
    top_notes: vocRes.rows.slice(0, 15).map((r) => ({
      id: r.id,
      source_type: r.source_type,
      strategic_category: r.strategic_category,
      severity: r.severity,
      is_highlighted: r.is_highlighted,
      feedback_notes: r.feedback_notes,
      customer_name: r.customer_name,
      distributor_name: r.distributor_name,
      submitted_by_name: r.submitted_by_name,
      created_at: r.created_at,
    })),
  };

  const manuscript_json = {
    title: `Executive Board Pack — ${bounds.year}-${String(bounds.month).padStart(2, "0")}`,
    generated_at: new Date().toISOString(),
    headline: {
      commissioning_completed: commissioningRes.rows.length,
      trade_show_spend: money(tradeShowSpend),
      trade_show_closed_won_revenue: money(tradeShowRevenue),
      voice_of_market_notes: vocRes.rows.length,
    },
    sections: [
      {
        key: "commissioning",
        heading: "Closed commissioning milestones",
        body: `${commissioningRes.rows.length} commissioning ticket(s) completed; linked SO value ${money(
          commissioningRevenue
        )}; ${milestones.rows.length} commissioning milestone(s) ready/billed (${money(milestoneAmount)}).`,
      },
      {
        key: "trade_show_roi",
        heading: "Trade show ROI",
        body: `${tradeShowsInMonth.length} campaign(s) in period; spend ${money(
          tradeShowSpend
        )}; ${tradeShowLeads} lead(s); closed-won revenue ${money(tradeShowRevenue)}.`,
      },
      {
        key: "voice_of_market",
        heading: "Voice of Customer / Channel",
        body: `${vocRes.rows.length} note(s) logged. Top categories: ${
          Object.entries(vocByCategory)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([k, v]) => `${k} (${v})`)
            .join(", ") || "none"
        }.`,
      },
    ],
    financial_summary_json,
    voc_summary_json,
  };

  const upsert = await client.query(
    `
      insert into executive_board_packs (
        company_id, report_month, generated_by,
        financial_summary_json, voc_summary_json, manuscript_json, status
      )
      values ($1, $2::date, $3, $4::jsonb, $5::jsonb, $6::jsonb, 'Draft')
      on conflict (company_id, report_month) do update
      set
        generated_by = excluded.generated_by,
        financial_summary_json = excluded.financial_summary_json,
        voc_summary_json = excluded.voc_summary_json,
        manuscript_json = excluded.manuscript_json,
        status = case
          when executive_board_packs.status = 'Published' then 'Published'
          else 'Draft'
        end,
        updated_at = now()
      returning *
    `,
    [
      companyFilter,
      bounds.reportMonth,
      actorId,
      JSON.stringify(financial_summary_json),
      JSON.stringify(voc_summary_json),
      JSON.stringify(manuscript_json),
    ]
  );

  return upsert.rows[0];
}

module.exports = {
  generateBoardPack,
  monthBounds,
};
