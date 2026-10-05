const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const {
  recordAuditLog,
  getAuditLogs,
  triggerDatabaseBackup,
  listBackups,
  getSystemHealthOverview,
} = require("../services/systemAudit");

const { applyRoleProfileIdentity, syncPrimaryRole } = require("../services/userIdentityGuards");

const router = express.Router();

const PRIVILEGED_ROLE_KEYS = ["super_admin", "superadmin", "business_admin"];
const PRIVILEGED_SCREEN_KEYS = ["admin_desk", "users", "rights", "approval_policy_matrix", "admin_masters", "onboarding", "data_ops"];

function cleanText(value, max = 255) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * 1. Audit Trail Inspector Endpoints
 */
router.get("/audit-logs", requireScreenAction("admin_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = req.companyId || null;
    const module = cleanText(req.query.module, 50);
    const actionType = cleanText(req.query.action_type, 50);
    const search = cleanText(req.query.search, 100);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const logs = await getAuditLogs(pool, {
      companyId,
      module,
      actionType,
      search,
      limit,
      offset,
    });

    return res.json({ ok: true, audit_logs: logs });
  } catch (error) {
    return next(error);
  }
});

router.post("/audit-logs", requireScreenAction("admin_desk", "can_create"), async (req, res, next) => {
  try {
    const companyId = req.companyId || null;
    const { action_type, module, target_table, target_id, old_payload, new_payload, remarks } = req.body || {};

    const logId = await recordAuditLog(pool, {
      companyId,
      actorId: req.user?.id || null,
      actorEmail: req.user?.email || null,
      actorName: req.user?.full_name || null,
      actionType: action_type || "CUSTOM_EVENT",
      module: module || "SYSTEM_ADMIN",
      targetTable: target_table,
      targetId: target_id,
      oldPayload: old_payload,
      newPayload: new_payload,
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers["user-agent"],
      status: "success",
      remarks,
    });

    return res.status(201).json({ ok: true, audit_log_id: logId });
  } catch (error) {
    return next(error);
  }
});

/**
 * 2. System Backups & Snapshot Management
 */
router.get("/backups", requireScreenAction("admin_desk", "can_view"), async (req, res, next) => {
  try {
    const backups = await listBackups(pool, { limit: 50 });
    return res.json({ ok: true, backups });
  } catch (error) {
    return next(error);
  }
});

router.post("/backups/trigger", requireScreenAction("admin_desk", "can_create"), async (req, res, next) => {
  try {
    const companyId = req.companyId || null;
    const backupType = cleanText(req.body?.backup_type, 30) || "manual";
    const destination = cleanText(req.body?.storage_destination, 30) || "local_vps";

    const backupRecord = await triggerDatabaseBackup(pool, {
      companyId,
      backupType,
      destination,
      userId: req.user?.id || null,
    });

    return res.status(201).json({
      ok: true,
      backup: backupRecord,
      message: `Backup intent ${backupRecord.backup_code} recorded as metadata-only. No pg_dump was executed — this is not disaster-recovery coverage.`,
      is_real_dump: false,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * 3. System Health & Telemetry
 */
router.get("/system-health", requireScreenAction("admin_desk", "can_view"), async (req, res, next) => {
  try {
    const health = await getSystemHealthOverview(pool);
    return res.json({ ok: true, health });
  } catch (error) {
    return next(error);
  }
});

/**
 * 4. User & RBAC Management
 */
router.get("/users", requireScreenAction("admin_desk", "can_view"), async (req, res, next) => {
  try {
    const usersRes = await pool.query(`
      select
        u.id,
        u.email,
        u.full_name,
        u.is_active,
        u.last_login_at,
        u.created_at,
        ug.group_name,
        r.id as primary_role_id,
        r.role_key,
        r.role_name
      from erp_users u
      left join user_groups ug on ug.id = u.group_id
      left join roles r on r.id = u.primary_role_id
      order by u.id asc
    `);

    const rolesRes = await pool.query(`
      select id, role_key, role_name, is_active
      from roles
      order by role_name asc
    `);

    return res.json({
      ok: true,
      users: usersRes.rows,
      roles: rolesRes.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/users/:id/role", requireScreenAction("admin_desk", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.id);
    const roleId = Number(req.body?.role_id);

    if (!userId || !roleId) {
      return res.status(400).json({ ok: false, error: "INVALID_USER_OR_ROLE" });
    }
    const actorIsSuperAdmin = req.user?.group_name === "SuperAdmin";
    if (userId === Number(req.user?.id) && !actorIsSuperAdmin) {
      return res.status(403).json({ ok: false, error: "CANNOT_CHANGE_OWN_ROLE" });
    }

    await client.query("begin");

    const prevRes = await client.query(
      `
        select u.*, g.group_name
        from erp_users u
        left join user_groups g on g.id = u.group_id
        where u.id = $1
        for update of u
      `,
      [userId]
    );
    const prevUser = prevRes.rows[0];
    if (!prevUser) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
    }

    const roleRes = await client.query(`select id, role_key, role_name, is_active from roles where id = $1`, [roleId]);
    const role = roleRes.rows[0];
    if (!role || role.is_active === false) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_ROLE" });
    }

    const aligned = await applyRoleProfileIdentity(client, {
      roleId,
      groupId: prevUser.group_id,
      departmentKey: prevUser.department_key,
    });
    const nextGroupId = aligned.groupId || prevUser.group_id;
    const nextGroupRes = await client.query(`select group_name from user_groups where id = $1`, [nextGroupId]);
    const nextGroupName = nextGroupRes.rows[0]?.group_name || null;

    if (nextGroupName === "SuperAdmin" && role.role_key !== "super_admin") {
      await client.query("rollback");
      return res.status(400).json({
        ok: false,
        error: "SUPERADMIN_REQUIRES_SUPER_ADMIN_ROLE",
        detail: "Only the Super Admin role may be placed in the SuperAdmin group.",
      });
    }

    const privilegedRes = await client.query(
      `
        select exists (
          select 1
          from screen_permissions
          where role_id = $1
            and screen_key = any($2::text[])
            and (can_edit = true or can_approve = true)
        ) as grants_admin
      `,
      [roleId, PRIVILEGED_SCREEN_KEYS]
    );
    const touchesPrivilege =
      prevUser.group_name === "SuperAdmin" ||
      nextGroupName === "SuperAdmin" ||
      PRIVILEGED_ROLE_KEYS.includes(String(role.role_key || "")) ||
      Boolean(privilegedRes.rows[0]?.grants_admin);
    if (touchesPrivilege && !actorIsSuperAdmin) {
      await client.query("rollback");
      return res.status(403).json({
        ok: false,
        error: "SUPERADMIN_REQUIRED",
        detail: "Only a SuperAdmin can assign admin-level roles or change the role of a SuperAdmin user.",
      });
    }

    const updRes = await client.query(
      `
        update erp_users
        set primary_role_id = $1, group_id = $2, department_key = $3, updated_at = now()
        where id = $4
        returning id, email, full_name, primary_role_id, group_id, department_key
      `,
      [roleId, nextGroupId, aligned.role ? aligned.departmentKey : prevUser.department_key, userId]
    );
    await syncPrimaryRole(client, userId, roleId);
    const accessAuditReady = await client.query(`select to_regclass('public.user_access_audit') is not null as ready`);
    if (accessAuditReady.rows[0]?.ready) {
      await client.query(
        `
          insert into user_access_audit (actor_user_id, target_user_id, action, before_json, after_json)
          values ($1, $2, 'role_changed', $3::jsonb, $4::jsonb)
        `,
        [
          req.user?.id || null,
          userId,
          JSON.stringify({ primary_role_id: prevUser.primary_role_id, group_id: prevUser.group_id, department_key: prevUser.department_key }),
          JSON.stringify({ primary_role_id: roleId, group_id: nextGroupId, department_key: updRes.rows[0]?.department_key || null }),
        ]
      );
    }

    // Record audit log
    await recordAuditLog(client, {
      companyId: req.companyId || null,
      actorId: req.user?.id || null,
      actorEmail: req.user?.email || null,
      actorName: req.user?.full_name || null,
      actionType: "ROLE_CHANGE",
      module: "SYSTEM_ADMIN",
      targetTable: "erp_users",
      targetId: userId,
      oldPayload: { primary_role_id: prevUser.primary_role_id, group_id: prevUser.group_id },
      newPayload: { primary_role_id: roleId, group_id: nextGroupId },
      remarks: `Updated primary role for user ${prevUser.email}`,
    });

    await client.query("commit");
    return res.json({ ok: true, user: updRes.rows[0], message: "User role updated successfully." });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

/**
 * Go-live checklist (server-persisted)
 */
router.get("/go-live-checklist", requireScreenAction("admin_desk", "can_view"), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select checklist_key, items_json, updated_by, updated_at from go_live_checklist_state where checklist_key = 'absstem_pilot_v1' limit 1`
    );
    return res.json({
      ok: true,
      checklist: rows[0] || { checklist_key: "absstem_pilot_v1", items_json: {}, updated_at: null },
      ready: true,
    });
  } catch (err) {
    if (String(err?.message || "").includes("go_live_checklist_state")) {
      return res.json({ ok: true, checklist: { checklist_key: "absstem_pilot_v1", items_json: {} }, ready: false });
    }
    return next(err);
  }
});

router.put("/go-live-checklist", requireScreenAction("admin_desk", "can_edit"), async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const items = body.items && typeof body.items === "object" ? body.items : {};
    const { rows } = await pool.query(
      `
        insert into go_live_checklist_state (checklist_key, items_json, updated_by, updated_at)
        values ('absstem_pilot_v1', $1::jsonb, $2, now())
        on conflict (checklist_key) do update
        set items_json = excluded.items_json, updated_by = excluded.updated_by, updated_at = now()
        returning checklist_key, items_json, updated_by, updated_at
      `,
      [JSON.stringify(items), req.user?.id || null]
    );
    return res.json({ ok: true, checklist: rows[0] });
  } catch (err) {
    if (String(err?.message || "").includes("go_live_checklist_state")) {
      return res.status(400).json({ ok: false, error: "MIGRATION_REQUIRED", message: "Apply migration 189_wave4_admin_safety_v1.sql" });
    }
    return next(err);
  }
});

/**
 * user_access_audit viewer
 */
router.get("/user-access-audit", requireScreenAction("admin_desk", "can_view"), async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 80)));
    const { rows } = await pool.query(
      `
        select
          a.*,
          actor.full_name as actor_name,
          actor.email as actor_email,
          target.full_name as target_user_name,
          target.email as target_user_email
        from user_access_audit a
        left join erp_users actor on actor.id = a.actor_user_id
        left join erp_users target on target.id = a.target_user_id
        order by a.created_at desc
        limit $1
      `,
      [limit]
    );
    return res.json({ ok: true, audits: rows, ready: true });
  } catch (err) {
    if (String(err?.message || "").includes("user_access_audit")) {
      return res.json({ ok: true, audits: [], ready: false });
    }
    return next(err);
  }
});

module.exports = router;
