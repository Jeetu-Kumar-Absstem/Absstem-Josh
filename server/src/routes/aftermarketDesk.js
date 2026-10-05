const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId } = require("../services/companyContext");

const router = express.Router();

function normalizeLimit(value, fallback = 80, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

router.get("/summary", requireScreenAction("aftermarket_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "NO_ACTIVE_COMPANY" });

    const q = normalizeText(req.query.q);
    const qLike = q ? `%${q}%` : null;

    const baseParams = [companyId];
    const searchWhere =
      qLike && qLike.length
        ? `and (
            c.customer_name ilike $2
            or swc.case_number ilike $2
          )`
        : "";

    const serviceFieldReturnRes = await pool.query(
      `
        select
          count(*)::int as case_count,
          coalesce(sum(pending_qty), 0)::numeric(18,4) as pending_qty
        from (
          select
            swc.id,
            greatest(
              coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
              - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'field_return'), 0),
              0
            ) as pending_qty
          from service_warranty_cases swc
          join customers c on c.id = swc.customer_id
          where swc.company_id = $1
            and swc.case_status = 'open'
            ${searchWhere}
        ) t
        where t.pending_qty > 0
      `,
      qLike ? [...baseParams, qLike] : baseParams
    );

    const serviceReplacementRes = await pool.query(
      `
        select
          count(*)::int as case_count,
          coalesce(sum(pending_qty), 0)::numeric(18,4) as pending_qty
        from (
          select
            swc.id,
            greatest(
              coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
              - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'replacement_issue'), 0),
              0
            ) as pending_qty
          from service_warranty_cases swc
          join customers c on c.id = swc.customer_id
          where swc.company_id = $1
            and swc.case_status = 'open'
            ${searchWhere}
        ) t
        where t.pending_qty > 0
      `,
      qLike ? [...baseParams, qLike] : baseParams
    );

    const serviceStaleRes = await pool.query(
      `
        select
          count(*)::int as case_count
        from (
          select
            swc.id,
            greatest(
              greatest(
                coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
                - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'field_return'), 0),
                0
              ),
              greatest(
                coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
                - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'replacement_issue'), 0),
                0
              )
            ) as pending_support,
            (current_date - coalesce(swc.case_date, current_date))::int as ageing_days
          from service_warranty_cases swc
          join customers c on c.id = swc.customer_id
          where swc.company_id = $1
            and swc.case_status = 'open'
            ${searchWhere}
        ) t
        where t.pending_support > 0 and t.ageing_days >= 7
      `,
      qLike ? [...baseParams, qLike] : baseParams
    );

    const amcSearchWhere =
      qLike && qLike.length
        ? `and (
            c.customer_name ilike $2
            or ac.contract_number ilike $2
          )`
        : "";

    const amcOverdueRes = await pool.query(
      `
        select count(*)::int as visit_count
        from amc_visits av
        join amc_contracts ac on ac.id = av.amc_contract_id
        join customers c on c.id = ac.customer_id
        where ac.company_id = $1
          and av.visit_status = 'scheduled'
          and av.due_date is not null
          and av.due_date < current_date
          ${amcSearchWhere}
      `,
      qLike ? [companyId, qLike] : [companyId]
    );

    const amcDueTodayRes = await pool.query(
      `
        select count(*)::int as visit_count
        from amc_visits av
        join amc_contracts ac on ac.id = av.amc_contract_id
        join customers c on c.id = ac.customer_id
        where ac.company_id = $1
          and av.visit_status = 'scheduled'
          and av.due_date = current_date
          ${amcSearchWhere}
      `,
      qLike ? [companyId, qLike] : [companyId]
    );

    const amcDueNextRes = await pool.query(
      `
        select count(*)::int as visit_count
        from amc_visits av
        join amc_contracts ac on ac.id = av.amc_contract_id
        join customers c on c.id = ac.customer_id
        where ac.company_id = $1
          and av.visit_status = 'scheduled'
          and av.due_date is not null
          and av.due_date > current_date
          and av.due_date <= current_date + interval '7 days'
          ${amcSearchWhere}
      `,
      qLike ? [companyId, qLike] : [companyId]
    );

    const amcExpiring7Res = await pool.query(
      `
        select count(*)::int as contract_count
        from amc_contracts ac
        join customers c on c.id = ac.customer_id
        where ac.company_id = $1
          and ac.contract_status = 'active'
          and ac.end_date is not null
          and ac.end_date > current_date
          and ac.end_date <= current_date + interval '7 days'
          ${amcSearchWhere}
      `,
      qLike ? [companyId, qLike] : [companyId]
    );

    const amcExpiring30Res = await pool.query(
      `
        select count(*)::int as contract_count
        from amc_contracts ac
        join customers c on c.id = ac.customer_id
        where ac.company_id = $1
          and ac.contract_status = 'active'
          and ac.end_date is not null
          and ac.end_date > current_date
          and ac.end_date <= current_date + interval '30 days'
          ${amcSearchWhere}
      `,
      qLike ? [companyId, qLike] : [companyId]
    );

    const serviceFieldReturn = serviceFieldReturnRes.rows[0] || {};
    const serviceReplacement = serviceReplacementRes.rows[0] || {};
    const serviceStale = serviceStaleRes.rows[0] || {};

    return res.json({
      ok: true,
      summary: {
        service: {
          pending_field_return: {
            case_count: Number(serviceFieldReturn.case_count || 0),
            pending_qty: serviceFieldReturn.pending_qty || 0,
          },
          pending_replacement: {
            case_count: Number(serviceReplacement.case_count || 0),
            pending_qty: serviceReplacement.pending_qty || 0,
          },
          open_stale_7d: {
            case_count: Number(serviceStale.case_count || 0),
          },
        },
        amc: {
          overdue_visits: Number(amcOverdueRes.rows[0]?.visit_count || 0),
          due_today: Number(amcDueTodayRes.rows[0]?.visit_count || 0),
          due_next_7d: Number(amcDueNextRes.rows[0]?.visit_count || 0),
          expiring_7d: Number(amcExpiring7Res.rows[0]?.contract_count || 0),
          expiring_30d: Number(amcExpiring30Res.rows[0]?.contract_count || 0),
        },
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/queue", requireScreenAction("aftermarket_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "NO_ACTIVE_COMPANY" });

    const bucket = normalizeText(req.query.bucket).toLowerCase() || "service_pending_field_return";
    const q = normalizeText(req.query.q);
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const qLike = q ? `%${q}%` : null;

    if (bucket === "amc_expiring_7d" || bucket === "amc_expiring_30d") {
      const params = [companyId];
      let where = `
        where ac.company_id = $1
          and ac.contract_status = 'active'
          and ac.end_date is not null
          and ac.end_date > current_date
      `;
      if (bucket === "amc_expiring_7d") {
        where += ` and ac.end_date <= current_date + interval '7 days'`;
      } else {
        where += ` and ac.end_date <= current_date + interval '30 days'`;
      }
      if (qLike) {
        params.push(qLike);
        where += ` and (c.customer_name ilike $2 or ac.contract_number ilike $2)`;
      }
      params.push(limit);
      const r = await pool.query(
        `
          select
            'amc_contract'::text as stage,
            ac.id as record_id,
            ac.id as amc_contract_id,
            ac.contract_number as record_number,
            ac.contract_status as record_status,
            ac.end_date as due_date,
            (ac.end_date - current_date)::int as ageing_days,
            c.id as customer_id,
            c.customer_name,
            null::int as service_warranty_case_id
          from amc_contracts ac
          join customers c on c.id = ac.customer_id
          ${where}
          order by ac.end_date asc nulls last, ac.id asc
          limit $${params.length}
        `,
        params
      );
      return res.json({ ok: true, rows: r.rows });
    }

    if (bucket.startsWith("amc_")) {
      const params = [companyId];
      let where = `
        where ac.company_id = $1
          and av.visit_status = 'scheduled'
      `;
      if (qLike) {
        params.push(qLike);
        where += ` and (c.customer_name ilike $2 or ac.contract_number ilike $2)`;
      }
      if (bucket === "amc_overdue_visits") where += ` and av.due_date is not null and av.due_date < current_date`;
      if (bucket === "amc_due_today") where += ` and av.due_date = current_date`;
      if (bucket === "amc_due_next_7d") {
        where += ` and av.due_date is not null and av.due_date > current_date and av.due_date <= current_date + interval '7 days'`;
      }

      params.push(limit);
      const r = await pool.query(
        `
          select
            'amc_visit'::text as stage,
            av.id as record_id,
            ac.id as amc_contract_id,
            ac.contract_number as record_number,
            av.visit_status as record_status,
            av.visit_no,
            av.due_date,
            (current_date - coalesce(av.due_date, current_date))::int as ageing_days,
            c.id as customer_id,
            c.customer_name,
            av.service_warranty_case_id
          from amc_visits av
          join amc_contracts ac on ac.id = av.amc_contract_id
          join customers c on c.id = ac.customer_id
          ${where}
          order by av.due_date asc nulls last, av.id asc
          limit $${params.length}
        `,
        params
      );
      return res.json({ ok: true, rows: r.rows });
    }

    const params = [companyId];
    let where = `
      where swc.company_id = $1
        and swc.case_status = 'open'
    `;
    if (qLike) {
      params.push(qLike);
      where += ` and (c.customer_name ilike $2 or swc.case_number ilike $2)`;
    }
    if (bucket === "service_pending_field_return") {
      where += `
        and greatest(
          coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
          - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'field_return'), 0),
          0
        ) > 0
      `;
    }
    if (bucket === "service_pending_replacement") {
      where += `
        and greatest(
          coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
          - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'replacement_issue'), 0),
          0
        ) > 0
      `;
    }
    if (bucket === "service_open_stale_7d") {
      where += `
        and (current_date - coalesce(swc.case_date, current_date))::int >= 7
        and greatest(
          greatest(
            coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
            - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'field_return'), 0),
            0
          ),
          greatest(
            coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
            - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'replacement_issue'), 0),
            0
          )
        ) > 0
      `;
    }

    params.push(limit);
    const r = await pool.query(
      `
        select
          'service_case'::text as stage,
          swc.id as record_id,
          swc.case_number as record_number,
          swc.case_status as record_status,
          swc.case_date,
          (current_date - coalesce(swc.case_date, current_date))::int as ageing_days,
          c.id as customer_id,
          c.customer_name,
          d.dispatch_number,
          so.so_number,
          greatest(
            coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
            - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'field_return'), 0),
            0
          ) as qty_pending_field_return,
          greatest(
            coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0)
            - coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'replacement_issue'), 0),
            0
          ) as qty_pending_replacement
        from service_warranty_cases swc
        join customers c on c.id = swc.customer_id
        left join sales_orders so on so.id = swc.sales_order_id
        join dispatches d on d.id = swc.dispatch_id
        ${where}
        order by ageing_days desc, swc.updated_at desc, swc.id desc
        limit $${params.length}
      `,
      params
    );
    return res.json({ ok: true, rows: r.rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

