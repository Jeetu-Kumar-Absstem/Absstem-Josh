const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { generateBoardPack } = require("../services/boardPack");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

router.use(requireAuth);

router.get("/board-packs", requireScreenAction("management", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    const companyId = requireResolvedCompanyId(req);
    if (companyId) {
      params.push(companyId);
      where.push(`(p.company_id is null or p.company_id = $${params.length})`);
    }
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`p.status = $${params.length}`);
    }

    const r = await pool.query(
      `
        select
          p.id,
          p.company_id,
          p.report_month,
          p.generated_by,
          p.status,
          p.published_at,
          p.created_at,
          p.updated_at,
          p.financial_summary_json,
          p.voc_summary_json,
          p.manuscript_json,
          u.full_name as generated_by_name
        from executive_board_packs p
        left join erp_users u on u.id = p.generated_by
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by p.report_month desc
        limit 100
      `,
      params
    );
    return res.json({ ok: true, packs: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/board-packs/:id", requireScreenAction("management", "can_view"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const r = await pool.query(
      `
        select
          p.*,
          u.full_name as generated_by_name
        from executive_board_packs p
        left join erp_users u on u.id = p.generated_by
        where p.id = $1
      `,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, pack: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/board-packs/generate", requireScreenAction("management", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const companyId = requireResolvedCompanyId(req);
    const pack = await generateBoardPack(client, {
      month: req.body?.month,
      year: req.body?.year,
      actorUserId: req.user.id,
      companyId,
    });
    await client.query("commit");
    return res.status(201).json({ ok: true, pack });
  } catch (err) {
    await client.query("rollback");
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.code || err.message });
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/board-packs/:id/publish", requireScreenAction("management", "can_approve"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const r = await pool.query(
      `
        update executive_board_packs
        set status = 'Published', published_at = now(), updated_at = now()
        where id = $1
        returning *
      `,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, pack: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/board-packs/:id/unpublish", requireScreenAction("management", "can_approve"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const r = await pool.query(
      `
        update executive_board_packs
        set status = 'Draft', published_at = null, updated_at = now()
        where id = $1
        returning *
      `,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, pack: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

// Management can also read VoM highlights for the board desk
router.get("/voice-of-market", requireScreenAction("management", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = ["v.is_highlighted = true"];
    const companyId = requireResolvedCompanyId(req);
    if (companyId) {
      params.push(companyId);
      where.push(`(v.company_id is null or v.company_id = $${params.length})`);
    }
    const r = await pool.query(
      `
        select
          v.*,
          c.customer_name as customer_name,
          d.company_name as distributor_name,
          u.full_name as submitted_by_name
        from voice_of_market_logs v
        left join customers c on c.id = v.customer_id
        left join distributors d on d.id = v.distributor_id
        left join erp_users u on u.id = v.submitted_by
        where ${where.join(" and ")}
        order by v.created_at desc
        limit 100
      `,
      params
    );
    return res.json({ ok: true, logs: r.rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
