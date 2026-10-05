const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");

const router = express.Router();

const ASSET_CATEGORIES = new Set(["Laptop", "Phone", "Keys", "Monitor", "Peripheral", "Access_Card", "Other"]);
const ASSET_STATUSES = new Set(["Available", "Assigned", "Under_Repair", "Retired"]);
const VISITOR_STATUSES = new Set(["Active", "Completed"]);

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

// Active people directory for assign / host pickers (not SuperAdmin /users)
router.get("/people", requireScreenAction("office_admin", "can_view"), async (req, res, next) => {
  try {
    const r = await pool.query(
      `
        select id, full_name, email, user_code, is_active
        from erp_users
        where is_active = true
        order by full_name nulls last, email
        limit 2000
      `
    );
    return res.json({ ok: true, people: r.rows });
  } catch (err) {
    return next(err);
  }
});

// ─── Office assets ────────────────────────────────────────────────────────────

router.get("/assets", requireScreenAction("office_admin", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`a.status = $${params.length}`);
    }
    if (req.query.category) {
      params.push(String(req.query.category));
      where.push(`a.category = $${params.length}`);
    }
    if (req.query.assigned_user_id) {
      params.push(asInt(req.query.assigned_user_id));
      where.push(`a.assigned_user_id = $${params.length}`);
    }
    const companyId = requireResolvedCompanyId(req);
    if (companyId) {
      params.push(companyId);
      where.push(`(a.company_id is null or a.company_id = $${params.length})`);
    }

    const r = await pool.query(
      `
        select a.*, u.full_name as assigned_user_name, u.email as assigned_user_email
        from office_assets a
        left join erp_users u on u.id = a.assigned_user_id
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by a.asset_tag
        limit 500
      `,
      params
    );
    return res.json({ ok: true, assets: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/assets", requireScreenAction("office_admin", "can_create"), async (req, res, next) => {
  try {
    const assetTag = cleanText(req.body?.asset_tag, 80);
    const category = String(req.body?.category || "").trim();
    if (!assetTag) return res.status(400).json({ ok: false, error: "ASSET_TAG_REQUIRED" });
    if (!ASSET_CATEGORIES.has(category)) return res.status(400).json({ ok: false, error: "INVALID_CATEGORY" });

    let status = String(req.body?.status || "Available").trim();
    if (!ASSET_STATUSES.has(status)) status = "Available";
    let assignedUserId = asInt(req.body?.assigned_user_id);
    if (status === "Assigned" && !assignedUserId) {
      return res.status(400).json({ ok: false, error: "ASSIGNED_USER_REQUIRED" });
    }
    if (status === "Available" || status === "Retired") assignedUserId = null;

    const companyId = requireResolvedCompanyId(req);
    const r = await pool.query(
      `
        insert into office_assets (
          company_id, asset_tag, category, status, assigned_user_id, purchase_date, notes, created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        returning *
      `,
      [
        companyId,
        assetTag,
        category,
        status,
        assignedUserId,
        toDateOnly(req.body?.purchase_date),
        cleanText(req.body?.notes),
        req.user.id,
      ]
    );
    return res.status(201).json({ ok: true, asset: r.rows[0] });
  } catch (err) {
    if (String(err?.code) === "23505") return res.status(409).json({ ok: false, error: "ASSET_TAG_EXISTS" });
    return next(err);
  }
});

router.patch("/assets/:id", requireScreenAction("office_admin", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const cur = await pool.query(`select * from office_assets where id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const category = req.body?.category != null ? String(req.body.category).trim() : cur.rows[0].category;
    if (!ASSET_CATEGORIES.has(category)) return res.status(400).json({ ok: false, error: "INVALID_CATEGORY" });

    let status = req.body?.status != null ? String(req.body.status).trim() : cur.rows[0].status;
    if (!ASSET_STATUSES.has(status)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });

    let assignedUserId =
      req.body?.assigned_user_id !== undefined ? asInt(req.body.assigned_user_id) : cur.rows[0].assigned_user_id;
    if (status === "Assigned" && !assignedUserId) {
      return res.status(400).json({ ok: false, error: "ASSIGNED_USER_REQUIRED" });
    }
    if (status === "Available" || status === "Retired") assignedUserId = null;

    const r = await pool.query(
      `
        update office_assets
        set
          asset_tag = coalesce($2, asset_tag),
          category = $3,
          status = $4,
          assigned_user_id = $5,
          purchase_date = coalesce($6::date, purchase_date),
          notes = coalesce($7, notes),
          updated_at = now()
        where id = $1
        returning *
      `,
      [
        id,
        cleanText(req.body?.asset_tag, 80),
        category,
        status,
        assignedUserId,
        toDateOnly(req.body?.purchase_date),
        req.body?.notes !== undefined ? cleanText(req.body.notes) : null,
      ]
    );
    return res.json({ ok: true, asset: r.rows[0] });
  } catch (err) {
    if (String(err?.code) === "23505") return res.status(409).json({ ok: false, error: "ASSET_TAG_EXISTS" });
    if (String(err?.code) === "23514") return res.status(400).json({ ok: false, error: "CONSTRAINT_VIOLATION", detail: err.message });
    return next(err);
  }
});

router.delete("/assets/:id", requireScreenAction("office_admin", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const r = await pool.query(`delete from office_assets where id = $1 returning id`, [id]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ─── Plant visitors ───────────────────────────────────────────────────────────

router.get("/visitors", requireScreenAction("office_admin", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`v.status = $${params.length}`);
    }
    const companyId = requireResolvedCompanyId(req);
    if (companyId) {
      params.push(companyId);
      where.push(`(v.company_id is null or v.company_id = $${params.length})`);
    }
    const r = await pool.query(
      `
        select v.*, u.full_name as host_user_name
        from plant_visitor_logs v
        left join erp_users u on u.id = v.host_user_id
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by v.check_in_time desc
        limit 500
      `,
      params
    );
    return res.json({ ok: true, visitors: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/visitors", requireScreenAction("office_admin", "can_create"), async (req, res, next) => {
  try {
    const visitorName = cleanText(req.body?.visitor_name, 200);
    if (!visitorName) return res.status(400).json({ ok: false, error: "VISITOR_NAME_REQUIRED" });
    const companyId = requireResolvedCompanyId(req);
    const r = await pool.query(
      `
        insert into plant_visitor_logs (
          company_id, visitor_name, representing_company, purpose, host_user_id, status, created_by
        )
        values ($1,$2,$3,$4,$5,'Active',$6)
        returning *
      `,
      [
        companyId,
        visitorName,
        cleanText(req.body?.representing_company, 200),
        cleanText(req.body?.purpose, 1000),
        asInt(req.body?.host_user_id) || req.user.id,
        req.user.id,
      ]
    );
    return res.status(201).json({ ok: true, visitor: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.patch("/visitors/:id", requireScreenAction("office_admin", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const cur = await pool.query(`select * from plant_visitor_logs where id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    let status = req.body?.status != null ? String(req.body.status).trim() : cur.rows[0].status;
    if (!VISITOR_STATUSES.has(status)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });

    const checkOut =
      status === "Completed"
        ? req.body?.check_out_time
          ? new Date(req.body.check_out_time)
          : new Date()
        : null;

    const r = await pool.query(
      `
        update plant_visitor_logs
        set
          visitor_name = coalesce($2, visitor_name),
          representing_company = coalesce($3, representing_company),
          purpose = coalesce($4, purpose),
          host_user_id = coalesce($5, host_user_id),
          status = $6,
          check_out_time = case when $6 = 'Completed' then coalesce($7::timestamptz, now()) else null end,
          updated_at = now()
        where id = $1
        returning *
      `,
      [
        id,
        cleanText(req.body?.visitor_name, 200),
        req.body?.representing_company !== undefined ? cleanText(req.body.representing_company, 200) : null,
        req.body?.purpose !== undefined ? cleanText(req.body.purpose, 1000) : null,
        asInt(req.body?.host_user_id),
        status,
        checkOut && !Number.isNaN(checkOut.getTime()) ? checkOut.toISOString() : null,
      ]
    );
    return res.json({ ok: true, visitor: r.rows[0] });
  } catch (err) {
    if (String(err?.code) === "23514") return res.status(400).json({ ok: false, error: "CONSTRAINT_VIOLATION" });
    return next(err);
  }
});

router.post("/visitors/:id/checkout", requireScreenAction("office_admin", "can_edit"), async (req, res, next) => {
  req.body = { ...(req.body || {}), status: "Completed" };
  req.params = { ...req.params };
  // reuse patch handler logic via internal call
  try {
    const id = asInt(req.params.id);
    const r = await pool.query(
      `
        update plant_visitor_logs
        set status = 'Completed', check_out_time = now(), updated_at = now()
        where id = $1 and status = 'Active'
        returning *
      `,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND_OR_ALREADY_COMPLETED" });
    return res.json({ ok: true, visitor: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
