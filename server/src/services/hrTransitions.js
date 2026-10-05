const { notifyUser } = require("./notifications");
const { reassignDirectReports } = require("./userIdentityGuards");

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeModuleList(modules) {
  if (!Array.isArray(modules)) return [];
  return [...new Set(modules.map((m) => String(m || "").trim().toLowerCase()).filter(Boolean))];
}

function normalizeScreenKeys(screenKeys) {
  if (!Array.isArray(screenKeys)) return [];
  return [...new Set(screenKeys.map((k) => String(k || "").trim()).filter(Boolean))];
}

/**
 * Copy selected user screen overrides (and optionally elevate by module) from → to.
 * Logs into hr_rights_delegations + user_access_audit.
 * Platform admin screens (users/rights/admin_masters/…) require actor SuperAdmin.
 */
async function delegateAdminRights(client, { fromUserId, toUserId, modules = [], screenKeys = [], actorUserId, notes = null, actorGroupName = null }) {
  const fromId = asInt(fromUserId);
  const toId = asInt(toUserId);
  const actorId = asInt(actorUserId);
  if (!fromId || !toId || fromId === toId) {
    const err = new Error("INVALID_DELEGATION");
    err.status = 400;
    err.code = "INVALID_DELEGATION";
    throw err;
  }
  if (!actorId) {
    const err = new Error("ACTOR_REQUIRED");
    err.status = 400;
    err.code = "ACTOR_REQUIRED";
    throw err;
  }

  const users = await client.query(
    `select id, is_active, full_name, email from erp_users where id = any($1::int[])`,
    [[fromId, toId]]
  );
  const byId = new Map(users.rows.map((r) => [Number(r.id), r]));
  if (!byId.get(fromId) || !byId.get(toId)) {
    const err = new Error("USER_NOT_FOUND");
    err.status = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }
  if (byId.get(toId).is_active === false) {
    const err = new Error("TARGET_USER_INACTIVE");
    err.status = 400;
    err.code = "TARGET_USER_INACTIVE";
    throw err;
  }

  let moduleList = normalizeModuleList(modules);
  const explicitScreens = normalizeScreenKeys(screenKeys);
  const actorIsSuper = String(actorGroupName || "") === "SuperAdmin";

  const PLATFORM_ADMIN_SCREENS = new Set([
    "users",
    "rights",
    "admin_masters",
    "onboarding",
    "user_access_preview",
    "templates",
    "product_master",
    "job_asset_admin",
    "approval_policy_matrix",
    "intercompany_partners",
    "pilot_feedback",
    "superadmin_home",
  ]);

  if (moduleList.includes("admin") && !actorIsSuper) {
    const err = new Error("ADMIN_DELEGATION_SUPERADMIN_ONLY");
    err.status = 403;
    err.code = "ADMIN_DELEGATION_SUPERADMIN_ONLY";
    err.detail = "Only SuperAdmin can delegate Org & access / Admin Masters / Rights packs.";
    throw err;
  }
  if (!actorIsSuper) {
    moduleList = moduleList.filter((m) => m !== "admin");
  }

  const beforeTo = await client.query(
    `select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
     from user_screen_permissions where user_id = $1 order by screen_key`,
    [toId]
  );

  // Source: explicit user overrides for from-user
  const fromOverrides = await client.query(
    `select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
     from user_screen_permissions where user_id = $1`,
    [fromId]
  );

  // Optional: screens belonging to requested modules (explicit map + from-user role grants)
  let moduleScreens = [];
  if (moduleList.length) {
    const MODULE_SCREEN_MAP = {
      hr: ["hr_desk", "hr_admin", "attendance", "expenses", "leave", "salary", "salary_slips", "holidays", "activity_planner", "events"],
      office: ["office_admin"],
      admin: ["users", "rights", "admin_masters", "onboarding", "user_access_preview", "templates", "product_master"],
      service: ["field_service", "service_tickets", "aftermarket_desk", "service_warranty", "amc_contracts"],
    };
    const mapped = [];
    for (const mod of moduleList) {
      const keys = MODULE_SCREEN_MAP[mod] || MODULE_SCREEN_MAP[mod.replace(/_/g, "")] || [];
      mapped.push(...keys);
    }
    const roleRes = await client.query(`select primary_role_id from erp_users where id = $1`, [fromId]);
    const roleId = asInt(roleRes.rows[0]?.primary_role_id);
    if (roleId && mapped.length) {
      const modRes = await client.query(
        `
          select sp.screen_key, sp.can_view, sp.can_create, sp.can_edit, sp.can_approve,
                 sp.own_records_only, sp.financial_masking
          from screen_permissions sp
          where sp.role_id = $1
            and sp.screen_key = any($2::text[])
        `,
        [roleId, [...new Set(mapped)]]
      );
      moduleScreens = modRes.rows;
    }
    // Do not synthesize full grants when source role has no rows — prevents accidental elevation
  }

  const desired = new Map();
  for (const row of fromOverrides.rows) {
    if (explicitScreens.length && !explicitScreens.includes(row.screen_key)) continue;
    if (!actorIsSuper && PLATFORM_ADMIN_SCREENS.has(row.screen_key)) continue;
    desired.set(row.screen_key, row);
  }
  for (const row of moduleScreens) {
    if (!actorIsSuper && PLATFORM_ADMIN_SCREENS.has(row.screen_key)) continue;
    if (!desired.has(row.screen_key)) desired.set(row.screen_key, row);
  }
  for (const key of explicitScreens) {
    if (!actorIsSuper && PLATFORM_ADMIN_SCREENS.has(key)) continue;
    if (desired.has(key)) continue;
    const fromRole = fromOverrides.rows.find((r) => r.screen_key === key);
    desired.set(
      key,
      fromRole || {
        screen_key: key,
        can_view: true,
        can_create: true,
        can_edit: true,
        can_approve: false,
        own_records_only: false,
        financial_masking: false,
      }
    );
  }

  if (!desired.size) {
    const err = new Error("NO_RIGHTS_TO_DELEGATE");
    err.status = 400;
    err.code = "NO_RIGHTS_TO_DELEGATE";
    err.detail = "Provide modules and/or screen_keys that exist on the source user.";
    throw err;
  }

  for (const row of desired.values()) {
    await client.query(
      `
        insert into user_screen_permissions (
          user_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (user_id, screen_key) do update
        set
          can_view = excluded.can_view or user_screen_permissions.can_view,
          can_create = excluded.can_create or user_screen_permissions.can_create,
          can_edit = excluded.can_edit or user_screen_permissions.can_edit,
          can_approve = excluded.can_approve or user_screen_permissions.can_approve,
          own_records_only = excluded.own_records_only,
          financial_masking = excluded.financial_masking
      `,
      [
        toId,
        row.screen_key,
        Boolean(row.can_view),
        Boolean(row.can_create),
        Boolean(row.can_edit),
        Boolean(row.can_approve),
        Boolean(row.own_records_only),
        Boolean(row.financial_masking),
      ]
    );
  }

  const afterTo = await client.query(
    `select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
     from user_screen_permissions where user_id = $1 order by screen_key`,
    [toId]
  );

  const delegatedKeys = [...desired.keys()];

  await client.query(
    `
      insert into hr_rights_delegations (
        from_user_id, to_user_id, modules, screen_keys, performed_by, notes
      )
      values ($1,$2,$3::jsonb,$4::jsonb,$5,$6)
    `,
    [
      fromId,
      toId,
      JSON.stringify(moduleList),
      JSON.stringify(delegatedKeys),
      actorId,
      notes ? String(notes).slice(0, 2000) : null,
    ]
  );

  await client.query(
    `
      insert into user_access_audit (
        actor_user_id, target_user_id, action, before_json, after_json
      )
      values ($1,$2,'delegate_admin_rights',$3::jsonb,$4::jsonb)
    `,
    [
      actorId,
      toId,
      JSON.stringify({ from_user_id: fromId, screen_permissions: beforeTo.rows }),
      JSON.stringify({ from_user_id: fromId, modules: moduleList, screen_keys: delegatedKeys, screen_permissions: afterTo.rows }),
    ]
  );

  try {
    await notifyUser({
      userId: toId,
      eventType: "hr_rights_delegated",
      title: "Administrative rights delegated to you",
      body: `${byId.get(fromId).full_name || byId.get(fromId).email} rights were transferred for: ${delegatedKeys.slice(0, 8).join(", ")}${
        delegatedKeys.length > 8 ? "…" : ""
      }`,
      page: "users",
      payload: { from_user_id: fromId, screen_keys: delegatedKeys },
      actorUserId: actorId,
    });
  } catch {
    // non-fatal
  }

  return {
    from_user_id: fromId,
    to_user_id: toId,
    modules: moduleList,
    screen_keys: delegatedKeys,
    screen_permissions: afterTo.rows,
  };
}

/**
 * Offboard: release office assets, deactivate user, kill sessions, alert if rights still need successor.
 * Does not replace the full User Master offboard-user transfer flow — call that for work reassignment.
 */
async function offboardEmployee(client, { userId, actorUserId, successorUserId = null, notes = null }) {
  const id = asInt(userId);
  const actorId = asInt(actorUserId);
  if (!id || !actorId) {
    const err = new Error("INVALID_OFFBOARD");
    err.status = 400;
    err.code = "INVALID_OFFBOARD";
    throw err;
  }
  if (id === actorId) {
    const err = new Error("SELF_OFFBOARD_NOT_ALLOWED");
    err.status = 400;
    err.code = "SELF_OFFBOARD_NOT_ALLOWED";
    throw err;
  }

  const userRes = await client.query(
    `select id, is_active, full_name, email, primary_role_id from erp_users where id = $1 for update`,
    [id]
  );
  const user = userRes.rows[0];
  if (!user) {
    const err = new Error("USER_NOT_FOUND");
    err.status = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }
  if (user.is_active === false) {
    const err = new Error("USER_ALREADY_INACTIVE");
    err.status = 400;
    err.code = "USER_ALREADY_INACTIVE";
    throw err;
  }

  // (a) Release assigned office assets
  const assets = await client.query(
    `
      update office_assets
      set
        status = 'Available',
        assigned_user_id = null,
        notes = trim(both from coalesce(notes, '') || ' | Released on offboard ' || now()::date::text),
        updated_at = now()
      where assigned_user_id = $1
        and status in ('Assigned', 'Under_Repair')
      returning id, asset_tag, category
    `,
    [id]
  );

  // Pending admin-ish overrides that were never delegated
  const pendingRights = await client.query(
    `
      select screen_key, can_view, can_create, can_edit, can_approve
      from user_screen_permissions
      where user_id = $1
        and (can_approve = true or can_edit = true)
      order by screen_key
    `,
    [id]
  );

  const alerts = [];
  if (pendingRights.rows.length && !asInt(successorUserId)) {
    const msg = `Offboarded ${user.full_name || user.email} still had ${pendingRights.rows.length} elevated screen override(s) without a successor delegation.`;
    const alertIns = await client.query(
      `
        insert into hr_offboarding_alerts (offboarded_user_id, alert_type, message)
        values ($1, 'pending_rights_delegation', $2)
        returning *
      `,
      [id, msg]
    );
    alerts.push(alertIns.rows[0]);
  }

  // Clear user screen overrides on offboard (access revoked)
  await client.query(`delete from user_screen_permissions where user_id = $1`, [id]);
  let accessExceptionsRevoked = 0;
  const overridesReady = await client.query(`select to_regclass('public.user_access_overrides') is not null as ready`);
  if (overridesReady.rows[0]?.ready) {
    const revoked = await client.query(
      `
        update user_access_overrides
        set revoked_at = now(), revoked_by = $2, updated_at = now()
        where user_id = $1 and revoked_at is null
      `,
      [id, actorId]
    );
    accessExceptionsRevoked = revoked.rowCount;
  }

  // (b) Revoke ERP access
  await client.query(`update erp_users set is_active = false, updated_at = now() where id = $1`, [id]);

  // End the user's connect-pg-simple sessions; passport stores the user id at sess.passport.user.
  let sessionsCleared = 0;
  await client.query("savepoint offboard_sessions");
  try {
    const sess = await client.query(
      `
        delete from user_sessions
        where (sess::jsonb -> 'passport' ->> 'user') = $1
        returning sid
      `,
      [String(id)]
    );
    sessionsCleared = sess.rows.length;
    await client.query("release savepoint offboard_sessions");
  } catch {
    // session table may be absent in local/dev
    await client.query("rollback to savepoint offboard_sessions");
  }

  await client.query(
    `
      insert into user_access_audit (
        actor_user_id, target_user_id, action, before_json, after_json
      )
      values ($1,$2,'hr_offboard_employee',$3::jsonb,$4::jsonb)
    `,
    [
      actorId,
      id,
      JSON.stringify({
        is_active: true,
        pending_rights: pendingRights.rows,
        assigned_assets: assets.rows,
      }),
      JSON.stringify({
        is_active: false,
        assets_released: assets.rows,
        sessions_cleared: sessionsCleared,
        access_exceptions_revoked: accessExceptionsRevoked,
        successor_user_id: asInt(successorUserId),
        notes: notes || null,
        alerts,
      }),
    ]
  );

  // (c) Notify HR / actor about pending delegation
  for (const alert of alerts) {
    try {
      await notifyUser({
        userId: actorId,
        eventType: "hr_offboard_alert",
        title: "Offboarding alert: rights delegation pending",
        body: alert.message,
        page: "users",
        payload: { offboarded_user_id: id, alert_id: alert.id },
      });
    } catch {
      // non-fatal
    }
  }

  return {
    user_id: id,
    assets_released: assets.rows,
    sessions_cleared: sessionsCleared,
    access_exceptions_revoked: accessExceptionsRevoked,
    pending_rights_count: pendingRights.rows.length,
    alerts,
  };
}

/**
 * Helper for commissioning assignment: users with a skill at min level.
 */
async function listQualifiedEngineers(client, { skillCategory, minLevel = "Competent" }) {
  const order = ["Aware", "Trained", "Competent", "Expert", "Assessor"];
  const minIdx = Math.max(0, order.indexOf(String(minLevel)));
  const allowed = order.slice(minIdx);
  const r = await client.query(
    `
      select u.id, u.full_name, u.email, s.skill_category, s.certification_level, s.last_evaluated_date
      from hr_skill_matrices s
      join erp_users u on u.id = s.user_id
      where u.is_active = true
        and s.skill_category = $1
        and s.certification_level = any($2::text[])
      order by array_position($2::text[], s.certification_level) desc, u.full_name
    `,
    [String(skillCategory || "").trim(), allowed]
  );
  return r.rows;
}

async function tableReady(client, tableName) {
  const r = await client.query(`select to_regclass($1) is not null as ready`, [`public.${tableName}`]);
  return Boolean(r.rows[0]?.ready);
}

function groupSkeleton({ key, label, description, count, items, required }) {
  const n = Number(count) || 0;
  return {
    key,
    label,
    description: description || null,
    count: n,
    required: required == null ? n > 0 : Boolean(required) && n > 0,
    items: Array.isArray(items) ? items.slice(0, 12) : [],
  };
}

/**
 * Pre-flight dependency inventory for the Offboarding Transfer Protocol.
 * Does not require a successor yet — used to drive mandatory reassignment UI.
 */
async function previewOffboardDependencies(client, userId) {
  const id = asInt(userId);
  if (!id) {
    const err = new Error("INVALID_USER");
    err.status = 400;
    err.code = "INVALID_USER";
    throw err;
  }

  const userRes = await client.query(
    `select id, full_name, email, user_code, is_active from erp_users where id = $1 limit 1`,
    [id]
  );
  const user = userRes.rows[0];
  if (!user) {
    const err = new Error("USER_NOT_FOUND");
    err.status = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }
  if (user.is_active === false) {
    const err = new Error("USER_ALREADY_INACTIVE");
    err.status = 400;
    err.code = "USER_ALREADY_INACTIVE";
    throw err;
  }

  const groups = [];

  // Active leads (deals)
  {
    const countRes = await client.query(
      `
        select count(*)::int as count
        from leads
        where assigned_to = $1
          and coalesce(status, '') not in ('order_won', 'lost', 'closed', 'cancelled')
      `,
      [id]
    );
    const itemsRes = await client.query(
      `
        select id,
               coalesce(nullif(company_name, ''), lead_number, 'Lead #' || id::text) as label,
               status as detail
        from leads
        where assigned_to = $1
          and coalesce(status, '') not in ('order_won', 'lost', 'closed', 'cancelled')
        order by updated_at desc nulls last, id desc
        limit 12
      `,
      [id]
    );
    groups.push(
      groupSkeleton({
        key: "active_leads",
        label: "Active Leads / Deals",
        description: "Open leads assigned to this user",
        count: countRes.rows[0]?.count,
        items: itemsRes.rows,
      })
    );
  }

  // Assigned / open sales orders (created_by ownership — same as User Master transfer)
  {
    const countRes = await client.query(
      `
        select count(*)::int as count
        from sales_orders
        where created_by = $1
          and order_status = any($2::text[])
      `,
      [id, ["draft", "confirmed"]]
    );
    const itemsRes = await client.query(
      `
        select id,
               coalesce(so_number, 'SO #' || id::text) as label,
               order_status as detail
        from sales_orders
        where created_by = $1
          and order_status = any($2::text[])
        order by updated_at desc nulls last, id desc
        limit 12
      `,
      [id, ["draft", "confirmed"]]
    );
    groups.push(
      groupSkeleton({
        key: "sales_orders",
        label: "Assigned Sales Orders",
        description: "Open sales orders owned by this user",
        count: countRes.rows[0]?.count,
        items: itemsRes.rows,
      })
    );
  }

  // Active commissioning tickets
  if (await tableReady(client, "commissioning_tickets")) {
    const countRes = await client.query(
      `
        select count(*)::int as count
        from commissioning_tickets
        where assigned_engineer_id = $1
          and status = any($2::text[])
      `,
      [id, ["Pending", "In_Progress"]]
    );
    const itemsRes = await client.query(
      `
        select id,
               'Ticket #' || id::text as label,
               status || ' · SO ' || sales_order_id::text as detail
        from commissioning_tickets
        where assigned_engineer_id = $1
          and status = any($2::text[])
        order by scheduled_date nulls last, id desc
        limit 12
      `,
      [id, ["Pending", "In_Progress"]]
    );
    groups.push(
      groupSkeleton({
        key: "commissioning_tickets",
        label: "Active Commissioning Tickets",
        description: "Pending / in-progress field commissioning assignments",
        count: countRes.rows[0]?.count,
        items: itemsRes.rows,
      })
    );
  } else {
    groups.push(
      groupSkeleton({
        key: "commissioning_tickets",
        label: "Active Commissioning Tickets",
        description: "Commissioning module not installed",
        count: 0,
        items: [],
        required: false,
      })
    );
  }

  // Direct reports
  {
    const countRes = await client.query(
      `
        select count(*)::int as count
        from erp_users
        where id <> $1
          and (primary_manager_user_id = $1 or secondary_manager_user_id = $1)
      `,
      [id]
    );
    const itemsRes = await client.query(
      `
        select id,
               coalesce(full_name, email, 'User #' || id::text) as label,
               case
                 when primary_manager_user_id = $1 and secondary_manager_user_id = $1 then 'Primary + secondary'
                 when primary_manager_user_id = $1 then 'Primary manager'
                 else 'Secondary manager'
               end as detail
        from erp_users
        where id <> $1
          and (primary_manager_user_id = $1 or secondary_manager_user_id = $1)
        order by full_name nulls last, email
        limit 12
      `,
      [id]
    );
    groups.push(
      groupSkeleton({
        key: "direct_reports",
        label: "Subordinate Direct Reports",
        description: "Employees reporting to this user as primary or secondary manager",
        count: countRes.rows[0]?.count,
        items: itemsRes.rows,
      })
    );
  }

  // Administrative rights (elevated screen overrides)
  {
    const countRes = await client.query(
      `
        select count(*)::int as count
        from user_screen_permissions
        where user_id = $1
          and (can_approve = true or can_edit = true)
      `,
      [id]
    );
    const itemsRes = await client.query(
      `
        select screen_key as id,
               screen_key as label,
               trim(both ' · ' from concat_ws(' · ',
                 case when can_view then 'view' end,
                 case when can_create then 'create' end,
                 case when can_edit then 'edit' end,
                 case when can_approve then 'approve' end
               )) as detail
        from user_screen_permissions
        where user_id = $1
          and (can_approve = true or can_edit = true)
        order by screen_key
        limit 12
      `,
      [id]
    );
    groups.push(
      groupSkeleton({
        key: "admin_rights",
        label: "Administrative Rights",
        description: "Elevated screen overrides (edit / approve) that must be delegated",
        count: countRes.rows[0]?.count,
        items: itemsRes.rows,
      })
    );
  }

  // Office assets — informational (auto-released on offboard; no successor required)
  if (await tableReady(client, "office_assets")) {
    const countRes = await client.query(
      `
        select count(*)::int as count
        from office_assets
        where assigned_user_id = $1
          and status in ('Assigned', 'Under_Repair')
      `,
      [id]
    );
    const itemsRes = await client.query(
      `
        select id,
               coalesce(asset_tag, category, 'Asset #' || id::text) as label,
               status as detail
        from office_assets
        where assigned_user_id = $1
          and status in ('Assigned', 'Under_Repair')
        order by asset_tag nulls last, id
        limit 12
      `,
      [id]
    );
    groups.push(
      groupSkeleton({
        key: "office_assets",
        label: "Assigned Office Assets",
        description: "Released automatically to Available on offboard — no successor mapping required",
        count: countRes.rows[0]?.count,
        items: itemsRes.rows,
        required: false,
      })
    );
  }

  const blocking = groups.filter((g) => g.required);
  return {
    user: {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      user_code: user.user_code,
      is_active: user.is_active,
    },
    groups,
    blocking_group_keys: blocking.map((g) => g.key),
    can_proceed_without_reassignment: blocking.length === 0,
  };
}

async function assertActiveSuccessor(client, successorId, departingId) {
  const sid = asInt(successorId);
  if (!sid || sid === asInt(departingId)) {
    const err = new Error("INVALID_SUCCESSOR");
    err.status = 400;
    err.code = "INVALID_SUCCESSOR";
    err.detail = "Each required responsibility group needs a different active successor.";
    throw err;
  }
  const r = await client.query(`select id, is_active from erp_users where id = $1 limit 1`, [sid]);
  const row = r.rows[0];
  if (!row) {
    const err = new Error("SUCCESSOR_NOT_FOUND");
    err.status = 404;
    err.code = "SUCCESSOR_NOT_FOUND";
    throw err;
  }
  if (row.is_active === false) {
    const err = new Error("TARGET_USER_INACTIVE");
    err.status = 400;
    err.code = "TARGET_USER_INACTIVE";
    throw err;
  }
  return sid;
}

/**
 * Rigid offboarding protocol: reassign every blocking dependency group, then revoke access.
 * Body shape: { reassignments: { [groupKey]: successorUserId }, notes?, confirm_email? }
 */
async function executeOffboardTransferProtocol(
  client,
  { userId, actorUserId, actorGroupName = null, reassignments = {}, notes = null, confirmEmail = null }
) {
  const id = asInt(userId);
  const actorId = asInt(actorUserId);
  if (!id || !actorId) {
    const err = new Error("INVALID_OFFBOARD");
    err.status = 400;
    err.code = "INVALID_OFFBOARD";
    throw err;
  }
  if (id === actorId) {
    const err = new Error("SELF_OFFBOARD_NOT_ALLOWED");
    err.status = 400;
    err.code = "SELF_OFFBOARD_NOT_ALLOWED";
    throw err;
  }

  const preview = await previewOffboardDependencies(client, id);
  const expectedEmail = String(preview.user.email || "").trim().toLowerCase();
  if (confirmEmail != null && String(confirmEmail).trim()) {
    if (String(confirmEmail).trim().toLowerCase() !== expectedEmail) {
      const err = new Error("CONFIRM_EMAIL_MISMATCH");
      err.status = 400;
      err.code = "CONFIRM_EMAIL_MISMATCH";
      err.detail = "Type the departing user's exact email to confirm offboarding.";
      throw err;
    }
  }

  const map = reassignments && typeof reassignments === "object" ? reassignments : {};
  const transferSummary = {};

  for (const group of preview.groups) {
    if (!group.required) continue;
    const successorId = await assertActiveSuccessor(client, map[group.key], id);

    if (group.key === "active_leads") {
      const reason = `Offboarding transfer from user ${id} to ${successorId}`;
      const moved = await client.query(
        `
          with moved as (
            update leads
            set assigned_to = $1, updated_at = now()
            where assigned_to = $2
              and coalesce(status, '') not in ('order_won', 'lost', 'closed', 'cancelled')
            returning id
          )
          insert into lead_assignments (lead_id, assigned_to, assigned_by, assignment_reason)
          select id, $1, $3, $4
          from moved
          returning lead_id
        `,
        [successorId, id, actorId, reason]
      );
      transferSummary.active_leads = moved.rows.length;
    } else if (group.key === "sales_orders") {
      const moved = await client.query(
        `
          update sales_orders
          set created_by = $1, updated_at = now()
          where created_by = $2
            and order_status = any($3::text[])
          returning id
        `,
        [successorId, id, ["draft", "confirmed"]]
      );
      transferSummary.sales_orders = moved.rows.length;
    } else if (group.key === "commissioning_tickets") {
      if (await tableReady(client, "commissioning_tickets")) {
        const moved = await client.query(
          `
            update commissioning_tickets
            set assigned_engineer_id = $1, updated_at = now()
            where assigned_engineer_id = $2
              and status = any($3::text[])
            returning id
          `,
          [successorId, id, ["Pending", "In_Progress"]]
        );
        transferSummary.commissioning_tickets = moved.rows.length;
      } else {
        transferSummary.commissioning_tickets = 0;
      }
    } else if (group.key === "direct_reports") {
      const changedIds = await reassignDirectReports(client, { fromUserId: id, toUserId: successorId });
      transferSummary.direct_reports = changedIds.length;
    } else if (group.key === "admin_rights") {
      const keysRes = await client.query(
        `
          select screen_key
          from user_screen_permissions
          where user_id = $1
            and (can_approve = true or can_edit = true)
        `,
        [id]
      );
      const screenKeys = keysRes.rows.map((r) => r.screen_key);
      if (screenKeys.length) {
        try {
          const delegation = await delegateAdminRights(client, {
            fromUserId: id,
            toUserId: successorId,
            modules: [],
            screenKeys,
            actorUserId: actorId,
            actorGroupName,
            notes: notes || "Offboarding Transfer Protocol — admin rights",
          });
          transferSummary.admin_rights = Array.isArray(delegation.screen_keys)
            ? delegation.screen_keys.length
            : screenKeys.length;
        } catch (err) {
          // Platform-admin screens may be non-delegable for HR actors — continue offboard with alert path.
          if (err?.code === "NO_RIGHTS_TO_DELEGATE" || err?.code === "ADMIN_DELEGATION_SUPERADMIN_ONLY") {
            transferSummary.admin_rights = 0;
            transferSummary.admin_rights_note = err.code;
          } else {
            throw err;
          }
        }
      } else {
        transferSummary.admin_rights = 0;
      }
    }
  }

  // Prefer admin_rights successor, else any mapped successor, for legacy alert suppression
  const successorForOffboard =
    asInt(map.admin_rights) ||
    asInt(map.direct_reports) ||
    asInt(map.sales_orders) ||
    asInt(map.commissioning_tickets) ||
    asInt(map.active_leads) ||
    null;

  const offboard = await offboardEmployee(client, {
    userId: id,
    actorUserId: actorId,
    successorUserId: successorForOffboard,
    notes: notes || "Offboarding Transfer Protocol",
  });

  return {
    preview_snapshot: {
      blocking_group_keys: preview.blocking_group_keys,
      groups: preview.groups.map((g) => ({ key: g.key, count: g.count, required: g.required })),
    },
    transfers: transferSummary,
    reassignments: Object.fromEntries(
      Object.entries(map)
        .map(([k, v]) => [k, asInt(v)])
        .filter(([, v]) => v)
    ),
    offboard,
  };
}

module.exports = {
  delegateAdminRights,
  offboardEmployee,
  listQualifiedEngineers,
  previewOffboardDependencies,
  executeOffboardTransferProtocol,
};
