const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const {
  delegateAdminRights,
  offboardEmployee,
  listQualifiedEngineers,
  previewOffboardDependencies,
  executeOffboardTransferProtocol,
} = require("../services/hrTransitions");

const router = express.Router();

const SKILL_LEVELS = new Set(["Aware", "Trained", "Competent", "Expert", "Assessor"]);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cleanText(value, max = 2000) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

function toDateOnly(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  return text.slice(0, 10);
}

router.use(requireAuth);

// Active people directory for skill / transition pickers (not SuperAdmin /users)
router.get("/people", requireScreenAction("hr_admin", "can_view"), async (req, res, next) => {
  try {
    const includeInactive = req.query.include_inactive === "1" || req.query.include_inactive === "true";
    const r = await pool.query(
      `
        select id, full_name, email, user_code, is_active, primary_role_id
        from erp_users
        where ($1::boolean = true or is_active = true)
        order by full_name nulls last, email
        limit 2000
      `,
      [includeInactive]
    );
    return res.json({ ok: true, people: r.rows });
  } catch (err) {
    return next(err);
  }
});

// ─── Skill matrices ───────────────────────────────────────────────────────────

router.get("/skills", requireScreenAction("hr_admin", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    if (req.query.user_id) {
      params.push(asInt(req.query.user_id));
      where.push(`s.user_id = $${params.length}`);
    }
    if (req.query.skill_category) {
      params.push(String(req.query.skill_category).trim());
      where.push(`s.skill_category = $${params.length}`);
    }
    const r = await pool.query(
      `
        select s.*, u.full_name, u.email,
               e.full_name as evaluated_by_name
        from hr_skill_matrices s
        join erp_users u on u.id = s.user_id
        left join erp_users e on e.id = s.evaluated_by
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by u.full_name, s.skill_category
        limit 1000
      `,
      params
    );
    return res.json({ ok: true, skills: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/skills/qualified", requireScreenAction("hr_admin", "can_view"), async (req, res, next) => {
  try {
    const skillCategory = cleanText(req.query.skill_category, 120);
    if (!skillCategory) return res.status(400).json({ ok: false, error: "SKILL_CATEGORY_REQUIRED" });
    const rows = await listQualifiedEngineers(pool, {
      skillCategory,
      minLevel: req.query.min_level || "Competent",
    });
    return res.json({ ok: true, engineers: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/skills", requireScreenAction("hr_admin", "can_create"), async (req, res, next) => {
  try {
    const userId = asInt(req.body?.user_id);
    const skillCategory = cleanText(req.body?.skill_category, 120);
    const level = String(req.body?.certification_level || "Trained").trim();
    if (!userId || !skillCategory) return res.status(400).json({ ok: false, error: "USER_AND_SKILL_REQUIRED" });
    if (!SKILL_LEVELS.has(level)) return res.status(400).json({ ok: false, error: "INVALID_LEVEL" });

    const r = await pool.query(
      `
        insert into hr_skill_matrices (
          user_id, skill_category, certification_level, last_evaluated_date, notes, evaluated_by
        )
        values ($1,$2,$3,$4,$5,$6)
        on conflict (user_id, skill_category) do update
        set
          certification_level = excluded.certification_level,
          last_evaluated_date = excluded.last_evaluated_date,
          notes = excluded.notes,
          evaluated_by = excluded.evaluated_by,
          updated_at = now()
        returning *
      `,
      [
        userId,
        skillCategory,
        level,
        toDateOnly(req.body?.last_evaluated_date) || new Date().toISOString().slice(0, 10),
        cleanText(req.body?.notes),
        req.user.id,
      ]
    );
    return res.status(201).json({ ok: true, skill: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.patch("/skills/:id", requireScreenAction("hr_admin", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const level = req.body?.certification_level != null ? String(req.body.certification_level).trim() : null;
    if (level && !SKILL_LEVELS.has(level)) return res.status(400).json({ ok: false, error: "INVALID_LEVEL" });

    const r = await pool.query(
      `
        update hr_skill_matrices
        set
          skill_category = coalesce($2, skill_category),
          certification_level = coalesce($3, certification_level),
          last_evaluated_date = coalesce($4::date, last_evaluated_date),
          notes = coalesce($5, notes),
          evaluated_by = $6,
          updated_at = now()
        where id = $1
        returning *
      `,
      [
        id,
        cleanText(req.body?.skill_category, 120),
        level,
        toDateOnly(req.body?.last_evaluated_date),
        req.body?.notes !== undefined ? cleanText(req.body.notes) : null,
        req.user.id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, skill: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete("/skills/:id", requireScreenAction("hr_admin", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const r = await pool.query(`delete from hr_skill_matrices where id = $1 returning id`, [id]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ─── Transitions ──────────────────────────────────────────────────────────────

router.post("/transitions/delegate", requireScreenAction("hr_admin", "can_approve"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await delegateAdminRights(client, {
      fromUserId: req.body?.from_user_id,
      toUserId: req.body?.to_user_id,
      modules: req.body?.modules,
      screenKeys: req.body?.screen_keys,
      actorUserId: req.user.id,
      actorGroupName: req.user.group_name,
      notes: req.body?.notes,
    });
    await client.query("commit");
    return res.json({ ok: true, delegation: result });
  } catch (err) {
    await client.query("rollback");
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.code || err.message, detail: err.detail || null });
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/transitions/offboard", requireScreenAction("hr_admin", "can_approve"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await offboardEmployee(client, {
      userId: req.body?.user_id,
      actorUserId: req.user.id,
      successorUserId: req.body?.successor_user_id,
      notes: req.body?.notes,
    });
    await client.query("commit");
    return res.json({ ok: true, offboard: result });
  } catch (err) {
    await client.query("rollback");
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.code || err.message, detail: err.detail || null });
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/transitions/alerts", requireScreenAction("hr_admin", "can_view"), async (req, res, next) => {
  try {
    const r = await pool.query(
      `
        select a.*, u.full_name, u.email
        from hr_offboarding_alerts a
        join erp_users u on u.id = a.offboarded_user_id
        where ($1::boolean = true or a.resolved_at is null)
        order by a.created_at desc
        limit 200
      `,
      [req.query.include_resolved === "1" || req.query.include_resolved === "true"]
    );
    return res.json({ ok: true, alerts: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/transitions/alerts/:id/resolve", requireScreenAction("hr_admin", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const r = await pool.query(
      `update hr_offboarding_alerts set resolved_at = now() where id = $1 returning *`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, alert: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

// ─── Offboarding Transfer Protocol ────────────────────────────────────────────

router.get("/users/:id/offboard-preview", requireScreenAction("hr_admin", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const preview = await previewOffboardDependencies(client, req.params.id);
    return res.json({ ok: true, ...preview });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.code || err.message, detail: err.detail || null });
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/users/:id/offboard", requireScreenAction("hr_admin", "can_approve"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await executeOffboardTransferProtocol(client, {
      userId: req.params.id,
      actorUserId: req.user.id,
      actorGroupName: req.user.group_name,
      reassignments: req.body?.reassignments,
      notes: cleanText(req.body?.notes),
      confirmEmail: req.body?.confirm_email,
    });
    await client.query("commit");
    return res.json({ ok: true, ...result });
  } catch (err) {
    await client.query("rollback");
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.code || err.message, detail: err.detail || null });
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
