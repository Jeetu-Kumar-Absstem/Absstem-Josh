const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");

const router = express.Router();

function userCompanyIds(req) {
  if (req.user?.group_name === "SuperAdmin") return null;
  const companies = Array.isArray(req.user?.companies) ? req.user.companies : [];
  const ids = companies.map((c) => Number(c.company_id)).filter((n) => Number.isFinite(n) && n > 0);
  return ids.length ? ids : [];
}

router.get("/", requireScreenAction("intercompany_dashboard", "can_view"), async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 10), 500);

    const ids = userCompanyIds(req);
    if (Array.isArray(ids) && ids.length === 0) return res.json({ ok: true, rows: [] });

    const params = [];
    const where = [];
    if (ids === null) {
      where.push(`po.intercompany_counterparty_company_id is not null`);
    } else {
      params.push(ids);
      where.push(`po.intercompany_counterparty_company_id is not null`);
      where.push(`(po.company_id = any($1::int[]) or po.intercompany_counterparty_company_id = any($1::int[]))`);
    }
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where.push(
        `(
          po.po_number ilike ${p}
          or so.so_number ilike ${p}
          or d.dispatch_number ilike ${p}
          or grn.grn_number ilike ${p}
          or ci.invoice_number ilike ${p}
          or pinv.purchase_invoice_number ilike ${p}
        )`
      );
    }
    params.push(limit);
    const limitParam = `$${params.length}`;

    const r = await pool.query(
      `
        with base as (
          select
            po.*
          from purchase_orders po
          where ${where.join(" and ")}
          order by po.id desc
          limit ${limitParam}
        ),
        so_join as (
          select
            po.id as purchase_order_id,
            po.po_number,
            po.po_status,
            po.po_date,
            po.company_id as buyer_company_id,
            bco.company_code as buyer_company_code,
            bco.display_name as buyer_company_name,
            po.intercompany_counterparty_company_id as seller_company_id,
            sco.company_code as seller_company_code,
            sco.display_name as seller_company_name,
            po.intercompany_sales_order_id,
            so.so_number,
            so.order_status
          from base po
          join companies bco on bco.id = po.company_id
          join companies sco on sco.id = po.intercompany_counterparty_company_id
          left join sales_orders so on so.id = po.intercompany_sales_order_id
        ),
        with_dispatch as (
          select
            s.*,
            d.id as dispatch_id,
            d.dispatch_number,
            d.dispatch_status
          from so_join s
          left join lateral (
            select *
            from dispatches d
            where s.intercompany_sales_order_id is not null
              and d.sales_order_id = s.intercompany_sales_order_id
              and d.dispatch_status <> 'cancelled'
            order by d.id desc
            limit 1
          ) d on true
        ),
        with_grn as (
          select
            x.*,
            grn.id as goods_receipt_id,
            grn.grn_number,
            grn.receipt_status as grn_status
          from with_dispatch x
          left join lateral (
            select *
            from goods_receipts grn
            where x.dispatch_id is not null
              and grn.company_id = x.buyer_company_id
              and grn.intercompany_dispatch_id = x.dispatch_id
            limit 1
          ) grn on true
        ),
        with_inv as (
          select
            x.*,
            ci.id as customer_invoice_id,
            ci.invoice_number,
            ci.invoice_status,
            ci.intercompany_purchase_invoice_id
          from with_grn x
          left join lateral (
            select *
            from customer_invoices ci
            where x.intercompany_sales_order_id is not null
              and ci.sales_order_id = x.intercompany_sales_order_id
              and ci.invoice_status <> 'cancelled'
            order by ci.id desc
            limit 1
          ) ci on true
        )
        select
          x.*,
          pinv.id as purchase_invoice_id,
          pinv.purchase_invoice_number,
          pinv.invoice_status as purchase_invoice_status
        from with_inv x
        left join purchase_invoices pinv on pinv.id = x.intercompany_purchase_invoice_id
        order by x.purchase_order_id desc
      `,
      params
    );

    return res.json({ ok: true, rows: r.rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

