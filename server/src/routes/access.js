const express = require("express");

const { pool } = require("../db/pool");
const { ACCESS_MODULES, accessModelMode } = require("../auth/accessModel");
const {
  accessTablesExist,
  backfillAll,
  getProfileState,
  previewProfileChange,
  saveProfileGrants,
  suggestProfile,
  sweepExpiredOverrides,
  validateProposedGrants,
  verifyZeroDifference,
} = require("../services/accessProfiles");
const {
  applyPersonChange,
  comparePeople,
  getPersonAccessState,
  normalizeOverrideChanges,
  planCopyFrom,
  previewNewPerson,
  previewPersonChange,
} = require("../services/personAccess");

const router = express.Router();

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name !== "SuperAdmin") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  return next();
});

router.get("/status", async (_req, res, next) => {
  try {
    const ready = await accessTablesExist(pool);
    let counts = null;
    let lastRun = null;
    let lastCutover = null;
    if (ready) {
      const [c, r] = await Promise.all([
        pool.query(
          `
            select
              (select count(*)::int from access_profile_grants) as grants,
              (select count(*)::int from user_access_overrides where revoked_at is null) as overrides,
              (select count(*)::int from access_baseline_rules where is_active) as baseline_rules
          `
        ),
        pool.query(
          `
            select id, run_kind, users_checked, screens_checked, mismatch_users, mismatch_count, created_at,
                   deny_default, bypass_users, blockers
            from access_verification_runs
            order by id desc
            limit 20
          `
        ),
      ]);
      counts = c.rows[0];
      lastRun = r.rows[0] || null;
      lastCutover = r.rows.find((x) => x.run_kind === "cutover_check") || null;
    }
    const cutoverReady = Boolean(lastCutover && lastCutover.mismatch_users === 0 && !(lastCutover.blockers || []).length);
    return res.json({
      ok: true,
      mode: accessModelMode(),
      tables_ready: ready,
      counts,
      last_run: lastRun,
      last_cutover_check: lastCutover,
      cutover_ready: cutoverReady,
    });
  } catch (err) {
    return next(err);
  }
});

router.use(async (_req, res, next) => {
  if (accessModelMode() === "off") {
    return res.status(404).json({ ok: false, error: "ACCESS_V2_OFF", detail: "Set ACCESS_MODEL_V2=shadow to use Access Profiles." });
  }
  if (!(await accessTablesExist(pool).catch(() => false))) {
    return res.status(503).json({ ok: false, error: "ACCESS_TABLES_MISSING", detail: "Apply migration 197_access_profiles_v1.sql first." });
  }
  return next();
});

router.post("/backfill", async (req, res, next) => {
  if (accessModelMode() === "on") {
    return res.status(409).json({ ok: false, error: "ACCESS_V2_ACTIVE", detail: "Access Profiles are the source of truth now; nothing to rebuild from." });
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const backfill = await backfillAll(client, { actorId: req.user.id });
    const report = await verifyZeroDifference(client, { actorId: req.user.id, runKind: "backfill" });
    await client.query("commit");
    return res.json({ ok: true, backfill, report });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/verify", async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const report = await verifyZeroDifference(client, { actorId: req.user.id, runKind: "verify" });
    await client.query("commit");
    return res.json({ ok: true, report });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/verification-runs", async (_req, res, next) => {
  try {
    const r = await pool.query(
      `
        select v.id, v.run_kind, v.users_checked, v.screens_checked, v.mismatch_users, v.mismatch_count,
               v.details, v.created_at, u.full_name as ran_by_name
        from access_verification_runs v
        left join erp_users u on u.id = v.ran_by
        order by v.id desc
        limit 20
      `
    );
    return res.json({ ok: true, runs: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/profiles", async (_req, res, next) => {
  try {
    const r = await pool.query(
      `
        select r.id, r.role_key, r.role_name, r.is_active,
               (select count(*)::int from erp_users u where u.primary_role_id = r.id and u.is_active = true) as active_users,
               (select count(*)::int from access_profile_grants g where g.role_id = r.id and g.module_key is not null) as module_grants,
               (select count(*)::int from access_profile_grants g where g.role_id = r.id and g.screen_key is not null) as screen_grants,
               (select count(*)::int from access_profile_grants g where g.role_id = r.id and g.level = 'custom') as custom_grants
        from roles r
        order by r.is_active desc, r.role_name asc
      `
    );
    return res.json({ ok: true, profiles: r.rows, modules: ACCESS_MODULES });
  } catch (err) {
    return next(err);
  }
});

router.get("/profiles/:roleId", async (req, res, next) => {
  try {
    const roleId = Number(req.params.roleId);
    if (!Number.isFinite(roleId)) return res.status(400).json({ ok: false, error: "INVALID_ROLE" });
    const state = await getProfileState(pool, roleId);
    if (!state) return res.status(404).json({ ok: false, error: "ROLE_NOT_FOUND" });
    return res.json({ ok: true, ...state });
  } catch (err) {
    return next(err);
  }
});

function readProposal(req, res) {
  const { grants, errors } = validateProposedGrants(req.body?.grants);
  if (errors.length) {
    res.status(400).json({ ok: false, error: "INVALID_GRANTS", detail: errors.join(", "), invalid: errors });
    return null;
  }
  return grants;
}

router.post("/profiles/:roleId/preview", async (req, res, next) => {
  try {
    const roleId = Number(req.params.roleId);
    if (!Number.isFinite(roleId)) return res.status(400).json({ ok: false, error: "INVALID_ROLE" });
    const grants = readProposal(req, res);
    if (!grants) return undefined;
    const impact = await previewProfileChange(pool, roleId, grants);
    delete impact.next_grants;
    return res.json({ ok: true, impact });
  } catch (err) {
    return next(err);
  }
});

router.put("/profiles/:roleId", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const roleId = Number(req.params.roleId);
    if (!Number.isFinite(roleId)) return res.status(400).json({ ok: false, error: "INVALID_ROLE" });
    const grants = readProposal(req, res);
    if (!grants) return undefined;
    const roleRes = await client.query(`select id, role_key from roles where id = $1`, [roleId]);
    if (!roleRes.rows[0]) return res.status(404).json({ ok: false, error: "ROLE_NOT_FOUND" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";

    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(197, $1)`, [roleId]);
    const result = await saveProfileGrants(client, roleId, grants, { actorId: req.user.id, reason });
    await client.query("commit");
    delete result.impact.next_grants;
    const state = await getProfileState(pool, roleId);
    return res.json({ ok: true, impact: result.impact, ...state });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

function readRule(body) {
  const departmentKey = typeof body?.department_key === "string" && body.department_key.trim() ? body.department_key.trim() : null;
  const designation = typeof body?.designation_name === "string" && body.designation_name.trim() ? body.designation_name.trim() : null;
  const companyId = Number(body?.company_id) > 0 ? Number(body.company_id) : null;
  const roleId = Number(body?.suggested_role_id) > 0 ? Number(body.suggested_role_id) : null;
  const priority = Number.isFinite(Number(body?.priority)) ? Math.trunc(Number(body.priority)) : 100;
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!departmentKey && !designation) return { error: "RULE_MATCH_REQUIRED", detail: "Pick a department, a designation, or both." };
  if (!roleId) return { error: "RULE_PROFILE_REQUIRED", detail: "Pick the access profile to suggest." };
  return { rule: { departmentKey, designation, companyId, roleId, priority, note, isActive: body?.is_active !== false } };
}

function ruleWriteError(err, res) {
  if (err?.code === "23505") {
    return res.status(409).json({ ok: false, error: "RULE_DUPLICATE", detail: "An active rule already exists for this company, department and designation." });
  }
  if (err?.code === "23503") {
    return res.status(400).json({ ok: false, error: "RULE_REFERENCE_INVALID", detail: err.detail || "Unknown company, department or profile." });
  }
  return null;
}

const RULE_SELECT = `
  select r.*, ro.role_name as suggested_role_name, d.department_name,
         coalesce(c.display_name, c.legal_name) as company_name
  from access_baseline_rules r
  join roles ro on ro.id = r.suggested_role_id
  left join departments d on d.department_key = r.department_key
  left join companies c on c.id = r.company_id
`;

router.get("/baseline-rules", async (_req, res, next) => {
  try {
    const [rules, departments, designations, companies, roles] = await Promise.all([
      pool.query(`${RULE_SELECT} order by r.is_active desc, r.department_key nulls last, r.designation_name nulls last, r.priority`),
      pool.query(`select department_key, department_name from departments where is_active order by sort_order, department_name`),
      pool.query(`select designation_name from designations where is_active order by sort_order, designation_name`),
      pool.query(`select id, coalesce(display_name, legal_name) as company_name from companies where is_active order by id`),
      pool.query(`select id, role_key, role_name from roles where is_active order by role_name`),
    ]);
    return res.json({
      ok: true,
      rules: rules.rows,
      departments: departments.rows,
      designations: designations.rows.map((d) => d.designation_name),
      companies: companies.rows,
      profiles: roles.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/baseline-rules/suggest", async (req, res, next) => {
  try {
    const suggestion = await suggestProfile(pool, {
      companyId: req.query.company_id,
      departmentKey: req.query.department_key ? String(req.query.department_key) : null,
      designation: req.query.designation ? String(req.query.designation) : null,
    });
    return res.json({ ok: true, suggestion });
  } catch (err) {
    return next(err);
  }
});

router.post("/baseline-rules", async (req, res, next) => {
  try {
    const { rule, error, detail } = readRule(req.body);
    if (error) return res.status(400).json({ ok: false, error, detail });
    const r = await pool.query(
      `
        insert into access_baseline_rules (company_id, department_key, designation_name, suggested_role_id, priority, is_active, note, created_by, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
        returning id
      `,
      [rule.companyId, rule.departmentKey, rule.designation, rule.roleId, rule.priority, rule.isActive, rule.note || null, req.user.id]
    );
    return res.status(201).json({ ok: true, id: Number(r.rows[0].id) });
  } catch (err) {
    if (ruleWriteError(err, res)) return undefined;
    return next(err);
  }
});

router.put("/baseline-rules/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const { rule, error, detail } = readRule(req.body);
    if (error) return res.status(400).json({ ok: false, error, detail });
    const r = await pool.query(
      `
        update access_baseline_rules
        set company_id = $2, department_key = $3, designation_name = $4, suggested_role_id = $5,
            priority = $6, is_active = $7, note = $8, updated_by = $9, updated_at = now()
        where id = $1
      `,
      [id, rule.companyId, rule.departmentKey, rule.designation, rule.roleId, rule.priority, rule.isActive, rule.note || null, req.user.id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true });
  } catch (err) {
    if (ruleWriteError(err, res)) return undefined;
    return next(err);
  }
});

router.delete("/baseline-rules/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const r = await pool.query(`delete from access_baseline_rules where id = $1`, [id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ---------- Person Command Center ----------

function sendAccessError(err, res) {
  if (err && err.status && err.code) {
    res.status(err.status).json({ ok: false, error: err.code, detail: err.detail || undefined });
    return true;
  }
  return false;
}

function readChanges(req, res) {
  const { changes, errors } = normalizeOverrideChanges(req.body?.changes);
  if (errors.length) {
    res.status(400).json({ ok: false, error: "INVALID_CHANGES", detail: errors.join(", "), invalid: errors });
    return null;
  }
  return changes;
}

function readUserId(req, res, param = "id") {
  const id = Number(req.params[param]);
  if (!(id > 0)) {
    res.status(400).json({ ok: false, error: "INVALID_USER" });
    return null;
  }
  return id;
}

router.get("/users/:id/access", async (req, res, next) => {
  try {
    const userId = readUserId(req, res);
    if (!userId) return undefined;
    await sweepExpiredOverrides(pool, { userId });
    const state = await getPersonAccessState(pool, userId);
    if (!state) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
    return res.json({ ok: true, ...state });
  } catch (err) {
    if (sendAccessError(err, res)) return undefined;
    return next(err);
  }
});

router.post("/users/:id/access/preview", async (req, res, next) => {
  try {
    const userId = readUserId(req, res);
    if (!userId) return undefined;
    const changes = readChanges(req, res);
    if (!changes) return undefined;
    const preview = await previewPersonChange(pool, userId, { roleId: req.body?.role_id, changes });
    return res.json({ ok: true, preview });
  } catch (err) {
    if (sendAccessError(err, res)) return undefined;
    return next(err);
  }
});

router.put("/users/:id/access", async (req, res, next) => {
  const userId = readUserId(req, res);
  if (!userId) return undefined;
  const changes = readChanges(req, res);
  if (!changes) return undefined;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(198, $1)`, [userId]);
    const preview = await previewPersonChange(client, userId, { roleId: req.body?.role_id, changes });
    await applyPersonChange(client, userId, {
      roleId: req.body?.role_id,
      changes,
      reason: req.body?.reason,
      actorId: req.user.id,
    });
    await client.query("commit");
    const state = await getPersonAccessState(pool, userId);
    return res.json({ ok: true, preview, ...state });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (sendAccessError(err, res)) return undefined;
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/users/:id/access/compare", async (req, res, next) => {
  try {
    const userId = readUserId(req, res);
    if (!userId) return undefined;
    const otherId = Number(req.query.with);
    if (!(otherId > 0)) return res.status(400).json({ ok: false, error: "INVALID_USER" });
    const comparison = await comparePeople(pool, userId, otherId);
    return res.json({ ok: true, ...comparison });
  } catch (err) {
    if (sendAccessError(err, res)) return undefined;
    return next(err);
  }
});

router.get("/users/:id/access/copy-plan", async (req, res, next) => {
  try {
    const userId = readUserId(req, res);
    if (!userId) return undefined;
    const fromId = Number(req.query.from);
    if (!(fromId > 0)) return res.status(400).json({ ok: false, error: "INVALID_USER" });
    const plan = await planCopyFrom(pool, userId, fromId);
    return res.json({ ok: true, plan });
  } catch (err) {
    if (sendAccessError(err, res)) return undefined;
    return next(err);
  }
});

router.post("/provision/preview", async (req, res, next) => {
  try {
    const changes = readChanges(req, res);
    if (!changes) return undefined;
    const [preview, suggestion] = await Promise.all([
      previewNewPerson(pool, { roleId: req.body?.role_id, changes }),
      req.body?.department_key || req.body?.designation
        ? suggestProfile(pool, {
            companyId: req.body?.company_id,
            departmentKey: req.body?.department_key || null,
            designation: req.body?.designation || null,
          })
        : null,
    ]);
    return res.json({ ok: true, preview, suggestion });
  } catch (err) {
    return next(err);
  }
});

// One page, one save: identity + profile + exceptions in a single transaction (see POST /users).
router.post("/users/provision", (req, res, next) => {
  const users = require("./users");
  return users.createUser(req, res, next);
});

router.post("/cutover-check", async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const report = await verifyZeroDifference(client, { actorId: req.user.id, runKind: "cutover_check", denyDefault: true });
    await client.query("commit");
    return res.json({ ok: true, report });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
