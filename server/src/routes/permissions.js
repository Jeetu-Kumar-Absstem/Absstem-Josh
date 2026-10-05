const express = require("express");

const { pool } = require("../db/pool");
const { SCREEN_CATALOG, loadPermissionMaps, loadUserContextById } = require("../auth/userContext");
const { accessTablesExist, rebuildGrantsFromLegacy, syncUserOverridesFromLegacy } = require("../services/accessProfiles");
const { accessModelMode } = require("../auth/accessModel");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name !== "SuperAdmin") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  return next();
}

function flag(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function nullableFlag(v) {
  if (v === null || v === undefined || v === "") return null;
  return flag(v);
}

function hasAnyScreenOverride(row) {
  return [
    row?.can_view,
    row?.can_create,
    row?.can_edit,
    row?.can_approve,
    row?.own_records_only,
    row?.financial_masking,
  ].some((value) => value !== null && value !== undefined && value !== "");
}

const SCREEN_KEYS = new Set(SCREEN_CATALOG.map((screen) => screen.screen_key));

async function writeUserAccessAudit(client, {
  actorUserId = null,
  targetUserId = null,
  targetRoleId = null,
  action,
  beforeJson = null,
  afterJson = null,
} = {}) {
  if (!action) return;
  const readyRes = await client.query(`select to_regclass('public.user_access_audit') is not null as ready`);
  if (!Boolean(readyRes.rows[0]?.ready)) return;
  await client.query(
    `
      insert into user_access_audit (
        actor_user_id,
        target_user_id,
        target_role_id,
        action,
        before_json,
        after_json
      )
      values ($1,$2,$3,$4,coalesce($5::jsonb, '{}'::jsonb), coalesce($6::jsonb, '{}'::jsonb))
    `,
    [
      Number(actorUserId) > 0 ? Number(actorUserId) : null,
      Number(targetUserId) > 0 ? Number(targetUserId) : null,
      Number(targetRoleId) > 0 ? Number(targetRoleId) : null,
      String(action),
      beforeJson == null ? null : JSON.stringify(beforeJson),
      afterJson == null ? null : JSON.stringify(afterJson),
    ]
  );
}

router.use(requireAuth);
router.use(requireSuperAdmin);

// After cutover (ACCESS_MODEL_V2=on) Access Profiles and the person Access tab are the only editors.
function rejectWhenAccessV2On(req, res, next) {
  if (accessModelMode() !== "on") return next();
  return res.status(409).json({
    ok: false,
    error: "ACCESS_V2_ACTIVE",
    detail: "Access is now edited in Access Profiles (profiles) and the person's Access tab (exceptions).",
  });
}

router.get("/bootstrap", async (_req, res, next) => {
  try {
    const [rolesRes, modulesRes, roleModuleRes, screenRes] = await Promise.all([
      pool.query(
        `
          select id, role_key, role_name
          from roles
          where is_active = true
          order by role_name asc
        `
      ),
      pool.query(
        `
          select id, module_key, module_name
          from erp_modules
          where is_active = true
          order by module_name asc
        `
      ),
      pool.query(
        `
          select
            p.role_id,
            m.module_key,
            p.can_view,
            p.can_create,
            p.can_edit,
            p.can_approve
          from role_module_permissions p
          join erp_modules m on m.id = p.module_id
        `
      ),
      pool.query(
        `
          select
            role_id,
            screen_key,
            can_view,
            can_create,
            can_edit,
            can_approve,
            own_records_only,
            financial_masking
          from screen_permissions
        `
      ),
    ]);

    return res.json({
      ok: true,
      roles: rolesRes.rows,
      modules: modulesRes.rows,
      screens: SCREEN_CATALOG,
      role_module_permissions: roleModuleRes.rows,
      screen_permissions: screenRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/user/:userId/effective", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ ok: false, error: "INVALID_USER" });

    const user = await loadUserContextById(client, userId);
    if (!user) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });

    const [basePermissions, overridesRes] = await Promise.all([
      loadPermissionMaps(client, Number(user.primary_role_id), user.group_name),
      client.query(
        `
          select
            screen_key,
            can_view,
            can_create,
            can_edit,
            can_approve,
            own_records_only,
            financial_masking
          from user_screen_permissions
          where user_id = $1
          order by screen_key asc
        `,
        [userId]
      ),
    ]);

    return res.json({
      ok: true,
      user,
      screens: SCREEN_CATALOG,
      role_permissions: basePermissions,
      effective_permissions: user.permissions,
      user_screen_permissions: overridesRes.rows,
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/user/:userId/screens", rejectWhenAccessV2On, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ ok: false, error: "INVALID_USER" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const screenPermissions = Array.isArray(body.screen_permissions) ? body.screen_permissions : [];

    await client.query("begin");

    const userExists = await client.query(`select id from erp_users where id = $1 limit 1`, [userId]);
    if (!userExists.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
    }

    const beforeRes = await client.query(
      `
        select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
        from user_screen_permissions
        where user_id = $1
        order by screen_key asc
      `,
      [userId]
    );

    await client.query(`delete from user_screen_permissions where user_id = $1`, [userId]);
    for (const row of screenPermissions) {
      const screenKey = typeof row?.screen_key === "string" ? row.screen_key.trim() : "";
      if (!screenKey || !SCREEN_KEYS.has(screenKey) || !hasAnyScreenOverride(row)) continue;
      await client.query(
        `
          insert into user_screen_permissions (
            user_id,
            screen_key,
            can_view,
            can_create,
            can_edit,
            can_approve,
            own_records_only,
            financial_masking,
            updated_at
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,now())
        `,
        [
          userId,
          screenKey,
          nullableFlag(row.can_view),
          nullableFlag(row.can_create),
          nullableFlag(row.can_edit),
          nullableFlag(row.can_approve),
          nullableFlag(row.own_records_only),
          nullableFlag(row.financial_masking),
        ]
      );
    }

    const afterRes = await client.query(
      `
        select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
        from user_screen_permissions
        where user_id = $1
        order by screen_key asc
      `,
      [userId]
    );
    if (await accessTablesExist(client)) await syncUserOverridesFromLegacy(client, userId, { actorId: req.user?.id });
    await client.query("commit");

    try {
      await writeUserAccessAudit(pool, {
        actorUserId: req.user?.id,
        targetUserId: userId,
        action: "user_screen_overrides",
        beforeJson: { screen_permissions: beforeRes.rows },
        afterJson: { screen_permissions: afterRes.rows },
      });
    } catch (auditErr) {
      process.stderr.write(
        `[permissions] screen-override audit failed for user ${userId}: ${auditErr?.stack || auditErr}\n`
      );
    }

    const user = await loadUserContextById(pool, userId);
    return res.json({ ok: true, user });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23503") {
      return res.status(409).json({
        ok: false,
        error: "FOREIGN_KEY_VIOLATION",
        detail: err.detail || err.message || "A related record is missing (foreign key).",
        pg_code: "23503",
        constraint: err.constraint || null,
      });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/role/:roleId", rejectWhenAccessV2On, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const roleId = Number(req.params.roleId);
    if (!Number.isFinite(roleId)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const modulePermissions = Array.isArray(body.module_permissions) ? body.module_permissions : [];
    const screenPermissions = Array.isArray(body.screen_permissions) ? body.screen_permissions : [];

    await client.query("begin");

    const beforeModules = await client.query(
      `
        select m.module_key, rmp.can_view, rmp.can_create, rmp.can_edit, rmp.can_approve
        from role_module_permissions rmp
        join erp_modules m on m.id = rmp.module_id
        where rmp.role_id = $1
        order by m.module_key asc
      `,
      [roleId]
    );
    const beforeScreens = await client.query(
      `
        select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
        from screen_permissions
        where role_id = $1
        order by screen_key asc
      `,
      [roleId]
    );

    const roleRes = await client.query(`select id from roles where id = $1 limit 1`, [roleId]);
    if (!roleRes.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "ROLE_NOT_FOUND" });
    }

    if (Array.isArray(body.module_permissions)) {
      await client.query(`delete from role_module_permissions where role_id = $1`, [roleId]);
    }
    for (const row of modulePermissions) {
      const moduleKey = typeof row?.module_key === "string" ? row.module_key.trim() : "";
      if (!moduleKey) continue;
      const moduleRes = await client.query(`select id from erp_modules where module_key = $1 and is_active = true limit 1`, [moduleKey]);
      const moduleId = Number(moduleRes.rows[0]?.id);
      if (!Number.isFinite(moduleId)) continue;
      await client.query(
        `
          insert into role_module_permissions (role_id, module_id, can_view, can_create, can_edit, can_approve)
          values ($1,$2,$3,$4,$5,$6)
        `,
        [roleId, moduleId, flag(row.can_view), flag(row.can_create), flag(row.can_edit), flag(row.can_approve)]
      );
    }

    // Seeded rows outside the catalog (e.g. home) stay valid for re-saves of the same role.
    const knownRoleKeys = new Set(beforeScreens.rows.map((r) => r.screen_key));
    const seenKeys = new Set();
    const invalidKeys = [];
    for (const row of screenPermissions) {
      const screenKey = typeof row?.screen_key === "string" ? row.screen_key.trim() : "";
      if (!screenKey || seenKeys.has(screenKey) || (!SCREEN_KEYS.has(screenKey) && !knownRoleKeys.has(screenKey))) {
        invalidKeys.push(screenKey || String(row?.screen_key ?? ""));
        continue;
      }
      seenKeys.add(screenKey);
    }
    const removeKeys = Array.isArray(body.remove_screen_keys)
      ? body.remove_screen_keys.map((k) => String(k || "").trim()).filter(Boolean)
      : [];
    for (const key of removeKeys) {
      if (!knownRoleKeys.has(key)) invalidKeys.push(key);
    }
    if (invalidKeys.length) {
      await client.query("rollback");
      return res.status(400).json({
        ok: false,
        error: "INVALID_SCREEN_KEYS",
        detail: `Unknown, duplicate or empty screen keys: ${invalidKeys.join(", ")}`,
        invalid_keys: invalidKeys,
      });
    }

    if (removeKeys.length) {
      await client.query(`delete from screen_permissions where role_id = $1 and screen_key = any($2::text[])`, [
        roleId,
        removeKeys,
      ]);
    }
    for (const row of screenPermissions) {
      const screenKey = row.screen_key.trim();
      await client.query(
        `
          insert into screen_permissions (
            role_id,
            screen_key,
            can_view,
            can_create,
            can_edit,
            can_approve,
            own_records_only,
            financial_masking
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8)
          on conflict (role_id, screen_key) do update
          set can_view = excluded.can_view,
              can_create = excluded.can_create,
              can_edit = excluded.can_edit,
              can_approve = excluded.can_approve,
              own_records_only = excluded.own_records_only,
              financial_masking = excluded.financial_masking
        `,
        [
          roleId,
          screenKey,
          flag(row.can_view),
          flag(row.can_create),
          flag(row.can_edit),
          flag(row.can_approve),
          flag(row.own_records_only),
          flag(row.financial_masking),
        ]
      );
    }

    const afterModules = await client.query(
      `
        select m.module_key, rmp.can_view, rmp.can_create, rmp.can_edit, rmp.can_approve
        from role_module_permissions rmp
        join erp_modules m on m.id = rmp.module_id
        where rmp.role_id = $1
        order by m.module_key asc
      `,
      [roleId]
    );
    const afterScreens = await client.query(
      `
        select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
        from screen_permissions
        where role_id = $1
        order by screen_key asc
      `,
      [roleId]
    );
    await writeUserAccessAudit(client, {
      actorUserId: req.user?.id,
      targetRoleId: roleId,
      action: "role_permissions",
      beforeJson: { module_permissions: beforeModules.rows, screen_permissions: beforeScreens.rows },
      afterJson: { module_permissions: afterModules.rows, screen_permissions: afterScreens.rows },
    });

    if (await accessTablesExist(client)) await rebuildGrantsFromLegacy(client, roleId, { actorId: req.user?.id });
    await client.query("commit");
    return res.json({ ok: true });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
