const express = require("express");
const { pool } = require("../db/pool");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { lookupPincode, maybeAutoAssignTerritory } = require("../services/geoRouting");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireTerritoryView(req, res, next) {
  if (
    hasScreenAction(req, "geo_territories", "can_view") ||
    hasScreenAction(req, "marketing_desk", "can_view") ||
    hasScreenAction(req, "leads", "can_view")
  ) {
    return next();
  }
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

function requireTerritoryEdit(req, res, next) {
  if (
    hasScreenAction(req, "geo_territories", "can_edit") ||
    hasScreenAction(req, "marketing_desk", "can_edit")
  ) {
    return next();
  }
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

router.use(requireAuth);

router.get("/pincode/:pincode", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const row = await lookupPincode(pool, req.params.pincode);
    if (!row) return res.status(404).json({ ok: false, error: "PINCODE_NOT_FOUND" });
    return res.json({
      ok: true,
      pincode: row.pincode,
      city: row.city_name,
      state: row.state_name,
      state_code: row.state_code,
      country: row.country_code || "IN",
      district: row.district,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/territories", requireTerritoryView, async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await pool.query(
      `
        select
          t.*,
          coalesce(
            json_agg(
              json_build_object(
                'id', a.id,
                'user_id', a.user_id,
                'full_name', u.full_name,
                'is_default', a.is_default
              )
            ) filter (where a.id is not null),
            '[]'::json
          ) as agents
        from sales_territories t
        left join sales_territory_agents a on a.territory_id = t.id
        left join erp_users u on u.id = a.user_id
        where t.company_id = $1
        group by t.id
        order by t.priority asc, t.name
      `,
      [companyId]
    );
    return res.json({ ok: true, territories: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/territories", requireTerritoryEdit, async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const name = String(body.name || "").trim();
    const matchType = String(body.match_type || "pincode_prefix").trim();
    const matchValue = String(body.match_value || "").trim();
    if (!name || !matchValue) return res.status(400).json({ ok: false, error: "NAME_AND_MATCH_REQUIRED" });
    const { rows } = await pool.query(
      `
        insert into sales_territories (
          company_id, name, circle_code, match_type, match_value, priority, is_active
        )
        values ($1,$2,$3,$4,$5,$6,true)
        returning *
      `,
      [
        companyId,
        name,
        String(body.circle_code || "").trim() || null,
        matchType,
        matchValue,
        Number.isFinite(Number(body.priority)) ? Number(body.priority) : 100,
      ]
    );
    const territory = rows[0];
    const userId = Number(body.default_user_id);
    if (Number.isFinite(userId)) {
      await pool.query(
        `insert into sales_territory_agents (territory_id, user_id, is_default) values ($1,$2,true)`,
        [territory.id, userId]
      );
    }
    return res.status(201).json({ ok: true, territory });
  } catch (err) {
    return next(err);
  }
});

router.post("/leads/:id/auto-assign", requireScreenAction("leads", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const leadId = Number(req.params.id);
    const leadRes = await client.query(`select * from leads where id = $1 and company_id = $2 limit 1`, [
      leadId,
      companyId,
    ]);
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ ok: false });
    await client.query("begin");
    const match = await maybeAutoAssignTerritory(client, {
      leadId,
      companyId,
      pincode: lead.pincode,
      city: lead.city,
      state: lead.state,
      actorId: req.user.id,
      reassign: Boolean(req.body?.reassign),
    });
    await client.query("commit");
    return res.json({ ok: true, assigned: Boolean(match), territory: match });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
