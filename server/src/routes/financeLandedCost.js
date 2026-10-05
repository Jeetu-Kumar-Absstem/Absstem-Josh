const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { getCompanyLandedCostSettings } = require("../services/landedCost");

const router = express.Router();

router.get("/settings", requireScreenAction("landed_cost", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const settings = await getCompanyLandedCostSettings(pool, companyId);
    return res.json({ ok: true, settings });
  } catch (err) {
    return next(err);
  }
});

router.put("/settings", requireScreenAction("landed_cost", "can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const threshold = Number(req.body?.landed_cost_variance_threshold_pct);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1000) {
      return res.status(400).json({ ok: false, error: "INVALID_VARIANCE_THRESHOLD" });
    }
    const result = await pool.query(
      `
        insert into company_finance_settings (company_id, landed_cost_variance_threshold_pct)
        values ($1, $2)
        on conflict (company_id) do update
          set landed_cost_variance_threshold_pct = excluded.landed_cost_variance_threshold_pct,
              updated_at = now()
        returning *
      `,
      [companyId, threshold]
    );
    return res.json({ ok: true, settings: result.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.get("/valuation", requireScreenAction("landed_cost", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 250));
    const result = await pool.query(
      `
        select
          p.id as product_id,
          p.item_code,
          p.item_name,
          p.uom,
          coalesce(sb.stock_qty, 0) as stock_qty,
          coalesce(sb.average_unit_cost_base, 0) as average_unit_cost_base,
          coalesce(sb.stock_value_base, 0) as stock_value_base,
          sb.valuation_updated_at
        from products p
        join stock_balances sb on sb.product_id = p.id and sb.company_id = $1
        where p.is_active = true
          and abs(coalesce(sb.stock_qty, 0)) > 0.0001
        order by coalesce(sb.stock_value_base, 0) desc, p.item_code asc
        limit $2
      `,
      [companyId, limit]
    );
    const summary = result.rows.reduce(
      (acc, row) => {
        acc.stock_qty += Number(row.stock_qty || 0);
        acc.stock_value_base += Number(row.stock_value_base || 0);
        return acc;
      },
      { stock_qty: 0, stock_value_base: 0 }
    );
    return res.json({ ok: true, summary, rows: result.rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
