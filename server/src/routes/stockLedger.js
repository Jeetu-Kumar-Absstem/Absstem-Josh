const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");

const router = express.Router();

router.get("/exceptions-summary", requireScreenAction("stock_ledger", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const staleDays = Math.max(7, Math.min(180, Number(req.query.stale_days) || 45));

    const r = await pool.query(
      `
        with balances as (
          select
            p.id as product_id,
            p.item_code,
            p.item_name,
            coalesce(sb.stock_qty, 0) as stock_qty,
            coalesce(sb.average_unit_cost_base, 0) as average_unit_cost_base,
            coalesce(sb.stock_value_base, 0) as stock_value_base,
            last_mv.last_movement_at
          from products p
          left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $1
          left join stock_balances sb on sb.company_id = $1 and sb.product_id = p.id
          left join lateral (
            select max(sm.movement_date) as last_movement_at
            from stock_movements sm
            where sm.company_id = $1 and sm.product_id = p.id
          ) last_mv on true
          where p.is_active = true
            and coalesce(cpp.sourcing_mode, '') <> 'blocked'
            and coalesce(cpp.is_stocked, true) = true
            and coalesce(cpp.is_stocked, true) = true
        )
        select
          count(*) filter (where stock_qty < -0.0001)::int as negative_count,
          count(*) filter (
            where stock_qty > 0.0001
              and (
                last_movement_at is null
                or last_movement_at < (current_date - ($2::int || ' days')::interval)
              )
          )::int as stale_count,
          count(*) filter (where stock_qty = 0 and last_movement_at is not null)::int as zero_with_history_count
        from balances
      `,
      [companyId, staleDays]
    );

    const row = r.rows[0] || {};
    return res.json({
      ok: true,
      summary: {
        negative_count: Number(row.negative_count || 0),
        stale_count: Number(row.stale_count || 0),
        zero_with_history_count: Number(row.zero_with_history_count || 0),
        stale_days: staleDays,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/exceptions-queue", requireScreenAction("stock_ledger", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const bucket = String(req.query.bucket || "negative").trim().toLowerCase();
    const staleDays = Math.max(7, Math.min(180, Number(req.query.stale_days) || 45));
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 120));

    let filter = `stock_qty < -0.0001`;
    if (bucket === "stale") {
      filter = `stock_qty > 0.0001 and (last_movement_at is null or last_movement_at < (current_date - ($2::int || ' days')::interval))`;
    } else if (bucket === "zero") {
      filter = `stock_qty = 0 and last_movement_at is not null`;
    }

    const r = await pool.query(
      `
        with balances as (
          select
            p.id as product_id,
            p.item_code,
            p.item_name,
            p.uom,
            coalesce(sb.stock_qty, 0) as stock_qty,
            coalesce(sb.average_unit_cost_base, 0) as average_unit_cost_base,
            coalesce(sb.stock_value_base, 0) as stock_value_base,
            last_mv.last_movement_at
          from products p
          left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $1
          left join stock_balances sb on sb.company_id = $1 and sb.product_id = p.id
          left join lateral (
            select max(sm.movement_date) as last_movement_at
            from stock_movements sm
            where sm.company_id = $1 and sm.product_id = p.id
          ) last_mv on true
          where p.is_active = true
            and coalesce(cpp.sourcing_mode, '') <> 'blocked'
            and coalesce(cpp.is_stocked, true) = true
            and coalesce(cpp.is_stocked, true) = true
        )
        select *
        from balances
        where ${filter}
        order by stock_qty asc, item_code asc
        limit $3
      `,
      [companyId, staleDays, limit]
    );

    return res.json({ ok: true, bucket, rows: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/reorder-alerts", requireScreenAction("stock_ledger", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 120));

    const r = await pool.query(
      `
        select
          p.id as product_id,
          p.item_code,
          p.item_name,
          p.uom,
          coalesce(sb.stock_qty, 0) as stock_qty,
          cpp.min_stock,
          cpp.reorder_qty,
          cpp.safety_stock,
          greatest(
            coalesce(cpp.reorder_qty, coalesce(cpp.min_stock, 0) - coalesce(sb.stock_qty, 0)),
            0
          ) as suggested_reorder_qty
        from products p
        join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $1
        left join stock_balances sb on sb.company_id = $1 and sb.product_id = p.id
        where p.is_active = true
          and coalesce(cpp.is_stocked, true) = true
          and coalesce(cpp.sourcing_mode, '') <> 'blocked'
            and coalesce(cpp.is_stocked, true) = true
          and cpp.min_stock is not null
          and coalesce(sb.stock_qty, 0) <= cpp.min_stock
        order by (coalesce(sb.stock_qty, 0) - cpp.min_stock) asc, p.item_code asc
        limit $2
      `,
      [companyId, limit]
    );

    return res.json({
      ok: true,
      summary: { below_min_count: r.rows.length },
      rows: r.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/products", requireScreenAction("stock_ledger", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const products = await lookupProducts(pool, { companyId, q, mode: "stock", limit: 500, includeStockQty: true });
    return res.json({ ok: true, products });
  } catch (err) {
    return next(err);
  }
});

router.get("/product/:id", requireScreenAction("stock_ledger", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId) || productId <= 0) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });

    const r = await pool.query(
      `
        select
          p.id,
          p.item_code,
          p.item_name,
          p.uom,
          coalesce(sb.stock_qty, 0) as stock_qty,
          coalesce(sb.average_unit_cost_base, 0) as average_unit_cost_base,
          coalesce(sb.stock_value_base, 0) as stock_value_base
        from products p
        left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $1
        left join stock_balances sb on sb.company_id = $1 and sb.product_id = p.id
        where p.id = $2
          and p.is_active = true
          and coalesce(cpp.sourcing_mode, '') <> 'blocked'
            and coalesce(cpp.is_stocked, true) = true
          and coalesce(cpp.is_stocked, true) = true
        limit 1
      `,
      [companyId, productId]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "PRODUCT_NOT_FOUND" });
    return res.json({ ok: true, product: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.get("/movements", requireScreenAction("stock_ledger", "can_view"), async (req, res, next) => {
  try {
    const productId = Number(req.query.product_id);
    if (!Number.isFinite(productId) || productId <= 0) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const r = await pool.query(
      `
        select
          sm.id,
          sm.movement_date,
          sm.qty_signed,
          sm.unit_cost_base,
          sm.value_signed_base,
          sm.ref_type,
          sm.ref_id,
          case
            when sm.ref_type = 'GRN' then gr.grn_number
            when sm.ref_type = 'PURCHASE_RETURN' then pr.return_number
            when sm.ref_type = 'SALES_RETURN' then sr.return_number
            when sm.ref_type = 'DISPATCH' then d.dispatch_number
            when sm.ref_type = 'FIELD_RETURN' then swc.case_number
            when sm.ref_type = 'SERVICE_REPLACEMENT' then swc.case_number
            when sm.ref_type = 'MATERIAL_ISSUE' then jc.job_card_number
            when sm.ref_type = 'MATERIAL_RETURN' then jc.job_card_number
            when sm.ref_type = 'MANUFACTURING_RECEIPT' then jc.job_card_number
            when sm.ref_type = 'LOCATION_TRANSFER_OUT' then st.transfer_number
            when sm.ref_type = 'LOCATION_TRANSFER_IN' then st.transfer_number
            when sm.ref_type = 'STOCK_ADJUSTMENT' then sa.adjustment_number
            when sm.ref_type in ('TALLY_PURCHASE', 'TALLY_SALE', 'TALLY_STOCK_JOURNAL', 'TALLY_OPENING', 'TALLY_CREDIT_NOTE', 'TALLY_DEBIT_NOTE', 'TALLY_STOCK') then tv.voucher_number
            else null
          end as ref_number
        from stock_movements sm
        left join goods_receipts gr on (sm.ref_type = 'GRN' and gr.id = sm.ref_id)
        left join purchase_returns pr on (sm.ref_type = 'PURCHASE_RETURN' and pr.id = sm.ref_id)
        left join sales_returns sr on (sm.ref_type = 'SALES_RETURN' and sr.id = sm.ref_id)
        left join dispatches d on (sm.ref_type = 'DISPATCH' and d.id = sm.ref_id)
        left join service_warranty_cases swc on ((sm.ref_type = 'FIELD_RETURN' or sm.ref_type = 'SERVICE_REPLACEMENT') and swc.id = sm.ref_id)
        left join job_cards jc on ((sm.ref_type = 'MATERIAL_ISSUE' or sm.ref_type = 'MATERIAL_RETURN' or sm.ref_type = 'MANUFACTURING_RECEIPT') and jc.id = sm.ref_id)
        left join stock_transfers st on ((sm.ref_type = 'LOCATION_TRANSFER_OUT' or sm.ref_type = 'LOCATION_TRANSFER_IN') and st.id = sm.ref_id)
        left join stock_adjustments sa on (sm.ref_type = 'STOCK_ADJUSTMENT' and sa.id = sm.ref_id)
        left join tally_inventory_vouchers tv on (
          sm.ref_type in ('TALLY_PURCHASE', 'TALLY_SALE', 'TALLY_STOCK_JOURNAL', 'TALLY_OPENING', 'TALLY_CREDIT_NOTE', 'TALLY_DEBIT_NOTE', 'TALLY_STOCK')
          and tv.id = sm.ref_id
        )
        where sm.product_id = $1 and sm.company_id = $2
        order by sm.movement_date desc, sm.id desc
        limit 500
      `,
      [productId, companyId]
    );

    return res.json({ ok: true, movements: r.rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
