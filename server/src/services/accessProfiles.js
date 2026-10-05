const {
  ACCESS_MODULES,
  FLAG_KEYS,
  LEVELS,
  accessModelMode,
  diffScreens,
  explainScreens,
  flagsToLevel,
  grantToFlags,
  levelToFlags,
  normalizeGrant,
} = require("../auth/accessModel");
const {
  SCREEN_CATALOG,
  buildLegacyFallback,
  loadAccessGrants,
  loadCompiledPermissionMaps,
  loadLegacyPermissionMaps,
} = require("../auth/userContext");
const { resolveRoleProfile } = require("../auth/roleProfile");

const CATALOG_KEYS = new Set(SCREEN_CATALOG.map((s) => s.screen_key));

async function accessTablesExist(client) {
  const r = await client.query(
    `
      select to_regclass('public.access_profile_grants') is not null
         and to_regclass('public.user_access_overrides') is not null
         and to_regclass('public.access_baseline_rules') is not null
         and to_regclass('public.access_verification_runs') is not null as ready
    `
  );
  return Boolean(r.rows[0]?.ready);
}

function rowFlags(row) {
  const out = {};
  for (const k of FLAG_KEYS) out[k] = Boolean(row[k]);
  return out;
}

async function insertGrant(client, roleId, grant, { source, actorId }) {
  const flags = grant.level === "custom" ? grant : {};
  await client.query(
    `
      insert into access_profile_grants (
        role_id, module_key, screen_key, level, scope,
        can_view, can_create, can_edit, can_approve, own_records_only, financial_masking,
        source, updated_by
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `,
    [
      roleId,
      grant.module_key || null,
      grant.screen_key || null,
      grant.level,
      grant.scope || "all",
      grant.level === "custom" ? Boolean(flags.can_view) : null,
      grant.level === "custom" ? Boolean(flags.can_create) : null,
      grant.level === "custom" ? Boolean(flags.can_edit) : null,
      grant.level === "custom" ? Boolean(flags.can_approve) : null,
      grant.level === "custom" ? Boolean(flags.own_records_only) : null,
      grant.level === "custom" ? Boolean(flags.financial_masking) : null,
      source,
      Number(actorId) > 0 ? Number(actorId) : null,
    ]
  );
}

/**
 * Derive a role's grants from its explicit screen_permissions rows.
 * A module grant is only created when every catalog screen of the module has an explicit row,
 * because a module grant would otherwise replace the group default on the screens without one.
 */
async function rebuildGrantsFromLegacy(client, roleId, { actorId = null } = {}) {
  const rowsRes = await client.query(
    `
      select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
      from screen_permissions
      where role_id = $1
    `,
    [roleId]
  );
  const explicit = new Map(rowsRes.rows.map((r) => [r.screen_key, rowFlags(r)]));
  await client.query(`delete from access_profile_grants where role_id = $1`, [roleId]);

  // The group default differs only between SuperAdmin and everyone else, and SuperAdmin-group users
  // bypass screen checks entirely. So the default that matters is the Staff one whenever the role has
  // (or maps to) non-SuperAdmin users; writing it out as explicit grants makes deny-by-default lossless.
  const roleRes = await client.query(`select id, role_key, role_name, default_workspace_family from roles where id = $1`, [roleId]);
  const groupRes = await client.query(
    `select distinct g.group_name from erp_users u join user_groups g on g.id = u.group_id where u.primary_role_id = $1`,
    [roleId]
  );
  const hasStaffUsers = groupRes.rows.some((r) => r.group_name !== "SuperAdmin");
  const groupNames = (await client.query(`select group_name from user_groups where is_active = true`)).rows.map((g) => g.group_name);
  const mapsToSuperAdmin = roleRes.rows[0] ? resolveRoleProfile(roleRes.rows[0], { groupNames }).groupName === "SuperAdmin" : false;
  const baselineScreens = buildLegacyFallback(!hasStaffUsers && mapsToSuperAdmin ? "SuperAdmin" : "Staff").screens;
  const effective = (screenKey) => explicit.get(screenKey) || baselineScreens[screenKey] || null;

  const covered = new Set();
  let moduleGrants = 0;
  for (const mod of ACCESS_MODULES) {
    const screens = SCREEN_CATALOG.filter((s) => s.module_key === mod.module_key);
    if (!screens.length || !screens.every((s) => effective(s.screen_key))) continue;
    const tally = new Map();
    for (const s of screens) {
      const fit = flagsToLevel(effective(s.screen_key), { module_key: mod.module_key });
      if (!fit) continue;
      const key = `${fit.level}|${fit.scope}`;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    if (!tally.size) continue;
    const [bestKey] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const [level, scope] = bestKey.split("|");
    await insertGrant(client, roleId, { module_key: mod.module_key, level, scope }, { source: "legacy", actorId });
    moduleGrants += 1;
    for (const s of screens) {
      const fit = flagsToLevel(effective(s.screen_key), { module_key: mod.module_key });
      if (fit && fit.level === level && fit.scope === scope) covered.add(s.screen_key);
      else if (!explicit.has(s.screen_key)) explicit.set(s.screen_key, effective(s.screen_key));
    }
  }

  let screenGrants = 0;
  for (const [screenKey, flags] of explicit) {
    if (covered.has(screenKey)) continue;
    const fit = flagsToLevel(flags, { screen_key: screenKey });
    const grant = fit ? { screen_key: screenKey, ...fit } : { screen_key: screenKey, level: "custom", scope: flags.own_records_only ? "own" : "all", ...flags };
    await insertGrant(client, roleId, grant, { source: "legacy", actorId });
    screenGrants += 1;
  }
  return { role_id: roleId, module_grants: moduleGrants, screen_grants: screenGrants };
}

/** Mirror a role's grants into screen_permissions so legacy enforcement stays identical. */
async function writeLegacyFromGrants(client, roleId) {
  const grants = await loadAccessGrants(client, roleId);
  const moduleGrants = new Map(grants.filter((g) => g.module_key).map((g) => [g.module_key, g]));
  const screenGrants = new Map(grants.filter((g) => g.screen_key).map((g) => [g.screen_key, g]));
  const upsert = async (screenKey, flags) =>
    client.query(
      `
        insert into screen_permissions (role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (role_id, screen_key) do update
        set can_view = excluded.can_view,
            can_create = excluded.can_create,
            can_edit = excluded.can_edit,
            can_approve = excluded.can_approve,
            own_records_only = excluded.own_records_only,
            financial_masking = excluded.financial_masking
      `,
      [roleId, screenKey, flags.can_view, flags.can_create, flags.can_edit, flags.can_approve, flags.own_records_only, flags.financial_masking]
    );
  const uncovered = [];
  for (const s of SCREEN_CATALOG) {
    const g = screenGrants.get(s.screen_key) || moduleGrants.get(s.module_key);
    if (g) await upsert(s.screen_key, grantToFlags(g));
    else uncovered.push(s.screen_key);
  }
  for (const [key, g] of screenGrants) if (!CATALOG_KEYS.has(key)) await upsert(key, grantToFlags(g));
  if (uncovered.length) {
    await client.query(`delete from screen_permissions where role_id = $1 and screen_key = any($2::text[])`, [roleId, uncovered]);
  }
}

/** The user_screen_permissions row (tri-state) that an override stands for. */
function overrideToLegacyRow(o) {
  if (o.level === "custom") {
    const out = {};
    for (const k of FLAG_KEYS) out[k] = o[k] === null || o[k] === undefined ? null : Boolean(o[k]);
    return out;
  }
  const flags = levelToFlags(o.level, o.scope);
  return { ...flags, financial_masking: null };
}

function sameTriState(a, b) {
  return FLAG_KEYS.every((k) => {
    const x = a[k] === null || a[k] === undefined ? null : Boolean(a[k]);
    const y = b[k] === null || b[k] === undefined ? null : Boolean(b[k]);
    return x === y;
  });
}

/** Rewrite user_screen_permissions from the active overrides so legacy enforcement stays identical. */
async function mirrorUserOverridesToLegacy(client, userId) {
  const r = await client.query(
    `select * from user_access_overrides where user_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
    [userId]
  );
  await client.query(`delete from user_screen_permissions where user_id = $1`, [userId]);
  for (const o of r.rows) {
    if (!CATALOG_KEYS.has(o.screen_key)) continue;
    const row = overrideToLegacyRow(o);
    await client.query(
      `
        insert into user_screen_permissions (
          user_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking, updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,now())
      `,
      [userId, o.screen_key, row.can_view, row.can_create, row.can_edit, row.can_approve, row.own_records_only, row.financial_masking]
    );
  }
}

/** Revoke overrides whose expiry has passed; returns the affected user ids. */
async function sweepExpiredOverrides(client, { userId = null } = {}) {
  const r = await client.query(
    `
      update user_access_overrides
      set revoked_at = now(), updated_at = now()
      where revoked_at is null and expires_at is not null and expires_at <= now()
        and ($1::int is null or user_id = $1)
      returning user_id
    `,
    [Number(userId) > 0 ? Number(userId) : null]
  );
  const users = [...new Set(r.rows.map((x) => Number(x.user_id)))];
  for (const id of users) await mirrorUserOverridesToLegacy(client, id);
  return users;
}

function startAccessExpirySweep(pool, { minutes = 15 } = {}) {
  const tick = async () => {
    if (accessModelMode() === "off") return;
    let client;
    try {
      if (!(await accessTablesExist(pool))) return;
      client = await pool.connect();
      await client.query("begin");
      const users = await sweepExpiredOverrides(client);
      await client.query("commit");
      if (users.length) process.stdout.write(`[access-v2] expired exceptions closed for ${users.length} user(s)\n`);
    } catch (err) {
      if (client) await client.query("rollback").catch(() => {});
      process.stderr.write(`[access-v2] expiry sweep failed: ${err?.message || err}\n`);
    } finally {
      if (client) client.release();
    }
  };
  const timer = setInterval(tick, minutes * 60 * 1000);
  if (timer.unref) timer.unref();
  const first = setTimeout(tick, 10 * 1000);
  if (first.unref) first.unref();
  return { started: true, minutes };
}

/**
 * The legacy per-user screen editor saved user_screen_permissions: make the overrides match it.
 * Overrides that still say the same thing keep their reason and expiry; the rest are revoked.
 */
async function syncUserOverridesFromLegacy(client, userId, { actorId = null } = {}) {
  await client.query(
    `
      update user_access_overrides set revoked_at = now(), updated_at = now()
      where user_id = $1 and revoked_at is null and expires_at is not null and expires_at <= now()
    `,
    [userId]
  );
  const [legacyRes, activeRes] = await Promise.all([
    client.query(
      `
        select screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
        from user_screen_permissions
        where user_id = $1
      `,
      [userId]
    ),
    client.query(`select * from user_access_overrides where user_id = $1 and revoked_at is null`, [userId]),
  ]);
  const legacy = new Map(
    legacyRes.rows.filter((row) => FLAG_KEYS.some((k) => row[k] !== null && row[k] !== undefined)).map((row) => [row.screen_key, row])
  );
  const kept = new Set();
  const actor = Number(actorId) > 0 ? Number(actorId) : null;
  for (const o of activeRes.rows) {
    const row = legacy.get(o.screen_key);
    if (row && sameTriState(overrideToLegacyRow(o), row)) {
      kept.add(o.screen_key);
      continue;
    }
    await client.query(`update user_access_overrides set revoked_at = now(), revoked_by = $2, updated_at = now() where id = $1`, [o.id, actor]);
  }
  let inserted = 0;
  for (const [screenKey, row] of legacy) {
    if (kept.has(screenKey)) continue;
    await client.query(
      `
        insert into user_access_overrides (
          user_id, screen_key, level, scope,
          can_view, can_create, can_edit, can_approve, own_records_only, financial_masking,
          reason, source, granted_by
        )
        values ($1,$2,'custom','all',$3,$4,$5,$6,$7,$8,'Set in per-user screen access','legacy',$9)
      `,
      [userId, screenKey, row.can_view, row.can_create, row.can_edit, row.can_approve, row.own_records_only, row.financial_masking, actor]
    );
    inserted += 1;
  }
  return inserted;
}

async function backfillAll(client, { actorId = null } = {}) {
  const roles = await client.query(`select id from roles order by id`);
  const roleResults = [];
  for (const r of roles.rows) roleResults.push(await rebuildGrantsFromLegacy(client, Number(r.id), { actorId }));
  const users = await client.query(
    `
      select user_id from user_screen_permissions
      union
      select user_id from user_access_overrides where source = 'legacy'
    `
  );
  let overrides = 0;
  for (const u of users.rows) overrides += await syncUserOverridesFromLegacy(client, Number(u.user_id));
  return {
    roles: roleResults.length,
    module_grants: roleResults.reduce((s, r) => s + r.module_grants, 0),
    screen_grants: roleResults.reduce((s, r) => s + r.screen_grants, 0),
    user_overrides: overrides,
  };
}

/** Compare legacy vs compiled permissions for every user and store the snapshot. */
/**
 * Compare legacy vs compiled permissions for every user and store the snapshot.
 * `denyDefault` checks the cutover: compiled with closed defaults must still equal today's access.
 * SuperAdmin-group users pass every screen check in both models, so they are counted as bypass.
 */
async function verifyZeroDifference(client, { actorId = null, runKind = "verify", denyDefault = false, maxDetails = 200 } = {}) {
  await sweepExpiredOverrides(client);
  const users = await client.query(
    `
      select u.id, u.full_name, u.email, u.primary_role_id, u.is_active, g.group_name
      from erp_users u
      join user_groups g on g.id = u.group_id
      order by u.id
    `
  );
  const run = await client.query(
    `insert into access_verification_runs (run_kind, ran_by, deny_default) values ($1, $2, $3) returning id`,
    [runKind, Number(actorId) > 0 ? Number(actorId) : null, Boolean(denyDefault)]
  );
  const runId = Number(run.rows[0].id);
  let screensChecked = 0;
  let mismatchUsers = 0;
  let mismatchCount = 0;
  let bypassUsers = 0;
  const details = [];
  const blockers = [];
  for (const u of users.rows) {
    if (u.group_name === "SuperAdmin") {
      bypassUsers += 1;
      continue;
    }
    const roleId = Number(u.primary_role_id);
    if (denyDefault && !(roleId > 0) && u.is_active) {
      blockers.push({ user_id: Number(u.id), full_name: u.full_name, email: u.email, problem: "NO_ACCESS_PROFILE" });
    }
    const opts = { userId: Number(u.id) };
    const [legacy, compiled] = await Promise.all([
      loadLegacyPermissionMaps(client, roleId, u.group_name, opts),
      loadCompiledPermissionMaps(client, roleId, u.group_name, { ...opts, denyDefault }),
    ]);
    const changes = diffScreens(legacy.screens, compiled.screens);
    screensChecked += new Set([...Object.keys(legacy.screens), ...Object.keys(compiled.screens)]).size;
    if (changes.length) {
      mismatchUsers += 1;
      mismatchCount += changes.length;
      if (details.length < maxDetails) details.push({ user_id: Number(u.id), full_name: u.full_name, email: u.email, changes });
    }
    await client.query(
      `
        insert into access_permission_snapshots (run_id, user_id, legacy_screens, compiled_screens, matches)
        values ($1,$2,$3::jsonb,$4::jsonb,$5)
      `,
      [runId, u.id, JSON.stringify(legacy.screens), JSON.stringify(compiled.screens), changes.length === 0]
    );
  }
  await client.query(
    `
      update access_verification_runs
      set users_checked = $2, screens_checked = $3, mismatch_users = $4, mismatch_count = $5, details = $6::jsonb,
          bypass_users = $7, blockers = $8::jsonb
      where id = $1
    `,
    [runId, users.rows.length, screensChecked, mismatchUsers, mismatchCount, JSON.stringify(details), bypassUsers, JSON.stringify(blockers)]
  );
  return {
    run_id: runId,
    run_kind: runKind,
    deny_default: Boolean(denyDefault),
    users_checked: users.rows.length,
    bypass_users: bypassUsers,
    screens_checked: screensChecked,
    mismatch_users: mismatchUsers,
    mismatch_count: mismatchCount,
    zero_difference: mismatchUsers === 0,
    blockers,
    cutover_ready: Boolean(denyDefault) && mismatchUsers === 0 && blockers.length === 0,
    details,
  };
}

function mergeProposedGrants(existing, proposed) {
  const keepOther = existing.filter((g) => g.screen_key && !CATALOG_KEYS.has(g.screen_key));
  return [...keepOther, ...proposed];
}

function validateProposedGrants(list) {
  const errors = [];
  const out = [];
  const seen = new Set();
  const screenKeys = CATALOG_KEYS;
  for (const input of Array.isArray(list) ? list : []) {
    const { grant, error } = normalizeGrant(input, { screenKeys });
    if (error) {
      errors.push(error);
      continue;
    }
    const key = grant.module_key ? `m:${grant.module_key}` : `s:${grant.screen_key}`;
    if (seen.has(key)) {
      errors.push(`DUPLICATE:${key}`);
      continue;
    }
    seen.add(key);
    out.push(grant);
  }
  return { grants: out, errors };
}

async function previewProfileChange(client, roleId, proposedGrants) {
  const existing = await loadAccessGrants(client, roleId);
  const nextGrants = mergeProposedGrants(existing, proposedGrants);
  const users = await client.query(
    `
      select u.id, u.full_name, u.email, g.group_name
      from erp_users u
      join user_groups g on g.id = u.group_id
      where u.primary_role_id = $1 and u.is_active = true
      order by u.full_name
    `,
    [roleId]
  );
  const affected = [];
  for (const u of users.rows) {
    const opts = { userId: Number(u.id) };
    const [before, after] = await Promise.all([
      loadCompiledPermissionMaps(client, roleId, u.group_name, { ...opts, grants: existing }),
      loadCompiledPermissionMaps(client, roleId, u.group_name, { ...opts, grants: nextGrants }),
    ]);
    const changes = diffScreens(before.screens, after.screens);
    if (changes.length) {
      affected.push({
        user_id: Number(u.id),
        full_name: u.full_name,
        email: u.email,
        group_name: u.group_name,
        superadmin_bypass: u.group_name === "SuperAdmin",
        changes,
      });
    }
  }
  const nameOf = new Map(SCREEN_CATALOG.map((s) => [s.screen_key, s.screen_name]));
  for (const a of affected) for (const c of a.changes) c.screen_name = nameOf.get(c.screen_key) || c.screen_key;
  return { total_users: users.rows.length, affected_users: affected.length, users: affected, next_grants: nextGrants };
}

async function saveProfileGrants(client, roleId, proposedGrants, { actorId = null, reason = "" } = {}) {
  const before = await loadAccessGrants(client, roleId);
  const impact = await previewProfileChange(client, roleId, proposedGrants);
  await client.query(
    `delete from access_profile_grants where role_id = $1 and (module_key is not null or screen_key = any($2::text[]))`,
    [roleId, [...CATALOG_KEYS]]
  );
  for (const g of proposedGrants) await insertGrant(client, roleId, g, { source: "v2", actorId });
  await writeLegacyFromGrants(client, roleId);
  const after = await loadAccessGrants(client, roleId);
  const auditReady = await client.query(`select to_regclass('public.user_access_audit') is not null as ready`);
  if (auditReady.rows[0]?.ready) {
    await client.query(
      `
        insert into user_access_audit (actor_user_id, target_role_id, action, before_json, after_json)
        values ($1, $2, 'access_profile_saved', $3::jsonb, $4::jsonb)
      `,
      [
        Number(actorId) > 0 ? Number(actorId) : null,
        roleId,
        JSON.stringify({ grants: before }),
        JSON.stringify({ grants: after, reason: reason || null, affected_users: impact.affected_users }),
      ]
    );
  }
  return { impact, grants: after };
}

function describeGrant(g) {
  if (!g) return null;
  const base = { level: g.level, scope: g.scope, source: g.source };
  if (g.level === "custom") for (const k of FLAG_KEYS) base[k] = Boolean(g[k]);
  return base;
}

async function getProfileState(client, roleId) {
  const roleRes = await client.query(
    `
      select r.id, r.role_key, r.role_name, r.is_active, r.default_workspace_family,
             (select count(*)::int from erp_users u where u.primary_role_id = r.id and u.is_active = true) as active_users
      from roles r
      where r.id = $1
    `,
    [roleId]
  );
  const role = roleRes.rows[0];
  if (!role) return null;
  const grants = await loadAccessGrants(client, roleId);
  const moduleGrants = new Map(grants.filter((g) => g.module_key).map((g) => [g.module_key, g]));
  const screenGrants = new Map(grants.filter((g) => g.screen_key).map((g) => [g.screen_key, g]));
  const staffDefault = buildLegacyFallback("Staff").screens;
  const groupNames = (await client.query(`select group_name from user_groups where is_active = true`)).rows.map((g) => g.group_name);
  const mapped = resolveRoleProfile(role, { groupNames });

  const denyDefault = accessModelMode() === "on";
  const describeDefault = (screenKey) => {
    if (denyDefault) return "none";
    const fit = flagsToLevel(staffDefault[screenKey] || {}, { screen_key: screenKey });
    return fit ? fit.level : "custom";
  };

  const modules = ACCESS_MODULES.map((mod) => ({
    ...mod,
    grant: describeGrant(moduleGrants.get(mod.module_key)),
    screens: SCREEN_CATALOG.filter((s) => s.module_key === mod.module_key).map((s) => ({
      screen_key: s.screen_key,
      screen_name: s.screen_name,
      grant: describeGrant(screenGrants.get(s.screen_key)),
      default_level: describeDefault(s.screen_key),
    })),
  }));
  const other = [
    ...SCREEN_CATALOG.filter((s) => !ACCESS_MODULES.some((m) => m.module_key === s.module_key)).map((s) => ({
      screen_key: s.screen_key,
      screen_name: s.screen_name,
      module_key: s.module_key,
      grant: describeGrant(screenGrants.get(s.screen_key)),
      default_level: describeDefault(s.screen_key),
    })),
    ...[...screenGrants.keys()]
      .filter((k) => !CATALOG_KEYS.has(k))
      .map((k) => ({ screen_key: k, screen_name: k, module_key: null, grant: describeGrant(screenGrants.get(k)), read_only: true })),
  ];
  return {
    role: { ...role, maps_to_group: mapped?.groupName || null },
    modules,
    other,
    levels: LEVELS,
    deny_default: denyDefault,
    explain: explainScreens({ catalog: SCREEN_CATALOG, grants }),
  };
}

async function suggestProfile(client, { companyId = null, departmentKey = null, designation = null } = {}) {
  const r = await client.query(
    `
      select r.id as rule_id, r.company_id, r.department_key, r.designation_name, r.priority,
             ro.id as role_id, ro.role_key, ro.role_name,
             (case when r.company_id is not null then 4 else 0 end
              + case when r.designation_name is not null then 2 else 0 end
              + case when r.department_key is not null then 1 else 0 end) as specificity
      from access_baseline_rules r
      join roles ro on ro.id = r.suggested_role_id and ro.is_active = true
      where r.is_active = true
        and (r.company_id is null or r.company_id = $1)
        and (r.department_key is null or r.department_key = $2)
        and (r.designation_name is null or r.designation_name = $3::citext)
      order by specificity desc, r.priority asc, r.id asc
      limit 1
    `,
    [Number(companyId) > 0 ? Number(companyId) : null, departmentKey || null, designation ? String(designation).trim() : null]
  );
  return r.rows[0] || null;
}

module.exports = {
  CATALOG_KEYS,
  accessTablesExist,
  rebuildGrantsFromLegacy,
  writeLegacyFromGrants,
  syncUserOverridesFromLegacy,
  mirrorUserOverridesToLegacy,
  sweepExpiredOverrides,
  startAccessExpirySweep,
  overrideToLegacyRow,
  describeGrant,
  backfillAll,
  verifyZeroDifference,
  validateProposedGrants,
  previewProfileChange,
  saveProfileGrants,
  getProfileState,
  suggestProfile,
};
