const {
  ACCESS_MODULES,
  FLAG_KEYS,
  LEVELS,
  accessModelMode,
  diffScreens,
  explainScreens,
  flagsToLevel,
  normalizeGrant,
} = require("../auth/accessModel");
const { SCREEN_CATALOG, loadAccessGrants, loadCompiledPermissionMaps } = require("../auth/userContext");
const { resolveRoleProfile } = require("../auth/roleProfile");
const { applyRoleProfileIdentity, syncPrimaryRole } = require("./userIdentityGuards");
const { CATALOG_KEYS, describeGrant, mirrorUserOverridesToLegacy, sweepExpiredOverrides } = require("./accessProfiles");

const SCREEN_BY_KEY = new Map(SCREEN_CATALOG.map((s) => [s.screen_key, s]));
const MODULE_KEYS = new Set(ACCESS_MODULES.map((m) => m.module_key));

async function mappedGroupName(client, role) {
  const groups = await client.query(`select group_name from user_groups where is_active = true`);
  return resolveRoleProfile(role, { groupNames: groups.rows.map((g) => g.group_name) })?.groupName || null;
}

function accessError(status, error, detail) {
  const err = new Error(detail || error);
  err.status = status;
  err.code = error;
  err.detail = detail || null;
  return err;
}

function fitLevel(flags, screenKey) {
  if (!flags) return { level: "none", scope: "all" };
  return flagsToLevel(flags, { screen_key: screenKey }) || { level: "custom", scope: flags.own_records_only ? "own" : "all" };
}

function pickFlags(flags) {
  const out = {};
  for (const k of FLAG_KEYS) out[k] = Boolean(flags?.[k]);
  return out;
}

function describeOverride(o) {
  if (!o) return null;
  const out = {
    id: o.id ? Number(o.id) : null,
    screen_key: o.screen_key,
    level: o.level,
    scope: o.scope,
    reason: o.reason || null,
    expires_at: o.expires_at || null,
    source: o.source || "v2",
    granted_by: o.granted_by ? Number(o.granted_by) : null,
    granted_by_name: o.granted_by_name || null,
    created_at: o.created_at || null,
  };
  if (o.level === "custom") for (const k of FLAG_KEYS) out[k] = o[k] === null || o[k] === undefined ? null : Boolean(o[k]);
  return out;
}

/**
 * One requested change to a person's overrides. `{ screen_key, clear: true }` (or level "inherit")
 * removes the override; otherwise `{ screen_key, level, scope, expires_at? }`. Custom keeps tri-state flags.
 */
function normalizeOverrideChange(input, { now = new Date() } = {}) {
  const screenKey = typeof input?.screen_key === "string" ? input.screen_key.trim() : "";
  if (!screenKey || !CATALOG_KEYS.has(screenKey)) return { error: `UNKNOWN_SCREEN:${screenKey || "?"}` };
  if (input.clear === true || input.level === "inherit") return { change: { screen_key: screenKey, clear: true } };

  let expiresAt = null;
  if (input.expires_at) {
    const d = new Date(input.expires_at);
    if (Number.isNaN(d.getTime())) return { error: `INVALID_EXPIRY:${screenKey}` };
    if (d.getTime() <= now.getTime()) return { error: `EXPIRY_IN_PAST:${screenKey}` };
    expiresAt = d.toISOString();
  }

  if (input.level === "custom") {
    const flags = {};
    for (const k of FLAG_KEYS) flags[k] = input[k] === null || input[k] === undefined || input[k] === "" ? null : Boolean(input[k]);
    if (FLAG_KEYS.every((k) => flags[k] === null)) return { error: `EMPTY_CUSTOM:${screenKey}` };
    return { change: { screen_key: screenKey, level: "custom", scope: flags.own_records_only ? "own" : "all", ...flags, expires_at: expiresAt } };
  }
  const { grant, error } = normalizeGrant({ screen_key: screenKey, level: input.level, scope: input.scope }, { screenKeys: CATALOG_KEYS });
  if (error) return { error };
  return { change: { screen_key: screenKey, level: grant.level, scope: grant.scope, expires_at: expiresAt } };
}

function normalizeOverrideChanges(list) {
  const changes = [];
  const errors = [];
  const seen = new Set();
  for (const input of Array.isArray(list) ? list : []) {
    const { change, error } = normalizeOverrideChange(input);
    if (error) {
      errors.push(error);
      continue;
    }
    if (seen.has(change.screen_key)) {
      errors.push(`DUPLICATE:${change.screen_key}`);
      continue;
    }
    seen.add(change.screen_key);
    changes.push(change);
  }
  return { changes, errors };
}

/** Active overrides after applying `changes` in memory (used for previews). */
function projectOverrides(active, changes) {
  const map = new Map(active.map((o) => [o.screen_key, o]));
  for (const c of changes) {
    if (c.clear) map.delete(c.screen_key);
    else map.set(c.screen_key, { ...c, reason: "(pending)", source: "v2" });
  }
  return [...map.values()];
}

async function loadActiveOverridesDetailed(client, userId) {
  const r = await client.query(
    `
      select o.*, g.full_name as granted_by_name
      from user_access_overrides o
      left join erp_users g on g.id = o.granted_by
      where o.user_id = $1 and o.revoked_at is null and (o.expires_at is null or o.expires_at > now())
      order by o.screen_key
    `,
    [userId]
  );
  return r.rows;
}

async function loadPerson(client, userId) {
  const r = await client.query(
    `
      select u.id, u.full_name, u.email, u.designation, u.department_key, u.is_active, u.group_id,
             u.primary_role_id, u.primary_manager_user_id, u.secondary_manager_user_id,
             u.discount_threshold_pct, g.group_name, g.max_autonomous_discount_pct,
             r.role_key, r.role_name, d.department_name,
             pm.full_name as primary_manager_name, sm.full_name as secondary_manager_name
      from erp_users u
      join user_groups g on g.id = u.group_id
      left join roles r on r.id = u.primary_role_id
      left join departments d on d.department_key = u.department_key
      left join erp_users pm on pm.id = u.primary_manager_user_id
      left join erp_users sm on sm.id = u.secondary_manager_user_id
      where u.id = $1
    `,
    [userId]
  );
  return r.rows[0] || null;
}

async function loadAuthority(client, person) {
  const policies = await client.query(
    `
      select p.id, p.doc_type, p.level_no, p.min_amount, p.max_amount, p.user_id, p.role_id, p.group_id,
             c.company_code, coalesce(c.display_name, c.legal_name) as company_name
      from approval_policies p
      left join companies c on c.id = p.company_id
      where p.is_active = true and (p.user_id = $1 or p.role_id = $2 or p.group_id = $3)
      order by p.doc_type, c.company_code, p.level_no
    `,
    [person.id, person.primary_role_id || null, person.group_id || null]
  );
  return {
    discount_threshold_pct: person.discount_threshold_pct === null ? null : Number(person.discount_threshold_pct),
    group_discount_pct: person.max_autonomous_discount_pct === null ? null : Number(person.max_autonomous_discount_pct),
    approval_policies: policies.rows.map((p) => ({
      ...p,
      applies_via: p.user_id ? "person" : p.role_id ? "profile" : "group",
      min_amount: p.min_amount === null ? null : Number(p.min_amount),
      max_amount: p.max_amount === null ? null : Number(p.max_amount),
    })),
  };
}

function screenRow(screen, { inherited, effective, explain, override }) {
  const inh = inherited[screen.screen_key];
  const eff = effective[screen.screen_key];
  return {
    screen_key: screen.screen_key,
    screen_name: screen.screen_name,
    module_key: screen.module_key,
    inherited: { ...fitLevel(inh, screen.screen_key), flags: pickFlags(inh), source: explain[screen.screen_key]?.source || "default" },
    override: describeOverride(override),
    effective: { ...fitLevel(eff, screen.screen_key), flags: pickFlags(eff) },
  };
}

/** Everything the person access tab shows: inherited vs override vs effective per screen. */
async function getPersonAccessState(client, userId) {
  const person = await loadPerson(client, userId);
  if (!person) return null;
  const roleId = Number(person.primary_role_id);
  const denyDefault = accessModelMode() === "on";
  const [grants, active, authority, profiles, history] = await Promise.all([
    loadAccessGrants(client, roleId),
    loadActiveOverridesDetailed(client, userId),
    loadAuthority(client, person),
    client.query(`select id, role_key, role_name from roles where is_active = true order by role_name`),
    client.query(
      `
        select o.screen_key, o.level, o.scope, o.reason, o.expires_at, o.revoked_at, o.created_at,
               g.full_name as granted_by_name, rv.full_name as revoked_by_name
        from user_access_overrides o
        left join erp_users g on g.id = o.granted_by
        left join erp_users rv on rv.id = o.revoked_by
        where o.user_id = $1 and (o.revoked_at is not null or (o.expires_at is not null and o.expires_at <= now()))
        order by coalesce(o.revoked_at, o.expires_at) desc
        limit 25
      `,
      [userId]
    ),
  ]);
  const [inheritedMaps, effectiveMaps] = await Promise.all([
    loadCompiledPermissionMaps(client, roleId, person.group_name, { userId, grants, overrides: [], denyDefault }),
    loadCompiledPermissionMaps(client, roleId, person.group_name, { userId, grants, overrides: active, denyDefault }),
  ]);
  const explain = explainScreens({ catalog: SCREEN_CATALOG, grants });
  const overrideMap = new Map(active.map((o) => [o.screen_key, o]));
  const ctx = { inherited: inheritedMaps.screens, effective: effectiveMaps.screens, explain };
  const moduleGrants = new Map(grants.filter((g) => g.module_key).map((g) => [g.module_key, g]));

  const modules = ACCESS_MODULES.map((mod) => {
    const screens = SCREEN_CATALOG.filter((s) => s.module_key === mod.module_key).map((s) =>
      screenRow(s, { ...ctx, override: overrideMap.get(s.screen_key) })
    );
    return {
      ...mod,
      profile_grant: describeGrant(moduleGrants.get(mod.module_key)),
      inherited_level: summarizeLevel(screens.map((s) => s.inherited)),
      effective_level: summarizeLevel(screens.map((s) => s.effective)),
      override_count: screens.filter((s) => s.override).length,
      screens,
    };
  });
  const other = SCREEN_CATALOG.filter((s) => !MODULE_KEYS.has(s.module_key)).map((s) =>
    screenRow(s, { ...ctx, override: overrideMap.get(s.screen_key) })
  );

  return {
    person: {
      id: Number(person.id),
      full_name: person.full_name,
      email: person.email,
      designation: person.designation,
      department_key: person.department_key,
      department_name: person.department_name,
      is_active: person.is_active,
      group_name: person.group_name,
      role_id: roleId > 0 ? roleId : null,
      role_key: person.role_key,
      role_name: person.role_name,
      primary_manager_name: person.primary_manager_name,
      secondary_manager_name: person.secondary_manager_name,
    },
    mode: accessModelMode(),
    deny_default: denyDefault,
    superadmin_bypass: person.group_name === "SuperAdmin",
    modules,
    other,
    authority,
    history: history.rows,
    profiles: profiles.rows,
    levels: LEVELS,
  };
}

function summarizeLevel(items) {
  const keys = new Set(items.map((i) => `${i.level}|${i.scope}`));
  if (keys.size !== 1) return { level: "mixed", scope: null };
  const [level, scope] = [...keys][0].split("|");
  return { level, scope };
}

/** Resolve a profile change for a person; null when unchanged. Group boundaries are kept to the identity editor. */
async function resolveProfileChange(client, person, roleIdInput) {
  const roleId = Number(roleIdInput);
  if (!(roleId > 0) || roleId === Number(person.primary_role_id)) return null;
  const roleRes = await client.query(`select id, role_key, role_name, default_workspace_family, is_active from roles where id = $1`, [roleId]);
  const role = roleRes.rows[0];
  if (!role || !role.is_active) throw accessError(400, "INVALID_PROFILE", "That access profile is inactive or missing.");
  if (person.group_name === "SuperAdmin" || role.role_key === "super_admin") {
    throw accessError(409, "PROFILE_PRIVILEGED", "SuperAdmin changes are made in the identity tab.");
  }
  const groupName = await mappedGroupName(client, role);
  const toDistributor = groupName === "Distributor" || role.role_key === "distributor";
  if (toDistributor !== (person.group_name === "Distributor")) {
    throw accessError(409, "PROFILE_GROUP_CHANGE", "Moving between distributor and internal profiles is done in the identity tab.");
  }
  if (groupName === "SuperAdmin") throw accessError(409, "PROFILE_PRIVILEGED", "SuperAdmin changes are made in the identity tab.");
  return { role, groupName: groupName || person.group_name };
}

/** Before/after for a person when their profile and/or overrides change. */
async function previewPersonChange(client, userId, { roleId = null, changes = [] } = {}) {
  const person = await loadPerson(client, userId);
  if (!person) throw accessError(404, "USER_NOT_FOUND");
  const profile = await resolveProfileChange(client, person, roleId);
  const currentRole = Number(person.primary_role_id);
  const nextRole = profile ? Number(profile.role.id) : currentRole;
  const nextGroup = profile ? profile.groupName : person.group_name;
  const active = await loadActiveOverridesDetailed(client, userId);
  const projected = projectOverrides(active, changes);
  const [before, after] = await Promise.all([
    loadCompiledPermissionMaps(client, currentRole, person.group_name, { userId, overrides: active }),
    loadCompiledPermissionMaps(client, nextRole, nextGroup, { userId, overrides: projected }),
  ]);
  const diff = diffScreens(before.screens, after.screens).map((c) => ({
    ...c,
    screen_name: SCREEN_BY_KEY.get(c.screen_key)?.screen_name || c.screen_key,
    before: fitLevel(before.screens[c.screen_key], c.screen_key),
    after: fitLevel(after.screens[c.screen_key], c.screen_key),
  }));
  return {
    user_id: Number(userId),
    superadmin_bypass: person.group_name === "SuperAdmin",
    profile_change: profile ? { from: person.role_name, to: profile.role.role_name, role_id: Number(profile.role.id) } : null,
    changes: diff,
    gained: diff.filter((d) => d.gained.length).length,
    lost: diff.filter((d) => d.lost.length).length,
  };
}

async function writeAudit(client, { actorId, userId, action, before, after }) {
  const ready = await client.query(`select to_regclass('public.user_access_audit') is not null as ready`);
  if (!ready.rows[0]?.ready) return;
  await client.query(
    `
      insert into user_access_audit (actor_user_id, target_user_id, action, before_json, after_json)
      values ($1, $2, $3, $4::jsonb, $5::jsonb)
    `,
    [Number(actorId) > 0 ? Number(actorId) : null, Number(userId) > 0 ? Number(userId) : null, action, JSON.stringify(before || {}), JSON.stringify(after || {})]
  );
}

/**
 * Apply only the sent changes to a person's overrides (and optionally their profile) in the caller's
 * transaction, mirror them to user_screen_permissions, and audit before/after.
 */
async function applyPersonChange(client, userId, { roleId = null, changes = [], reason = "", actorId = null, action = "user_access_overrides_saved" } = {}) {
  const person = await loadPerson(client, userId);
  if (!person) throw accessError(404, "USER_NOT_FOUND");
  if (changes.some((c) => !c.clear) && !String(reason || "").trim()) {
    throw accessError(400, "REASON_REQUIRED", "Give a reason for the access exception.");
  }
  await sweepExpiredOverrides(client, { userId });
  const profile = await resolveProfileChange(client, person, roleId);
  const beforeOverrides = (await loadActiveOverridesDetailed(client, userId)).map(describeOverride);
  const actor = Number(actorId) > 0 ? Number(actorId) : null;

  if (profile) {
    const aligned = await applyRoleProfileIdentity(client, { roleId: profile.role.id, groupId: person.group_id, departmentKey: person.department_key });
    await client.query(
      `update erp_users set primary_role_id = $2, group_id = coalesce($3, group_id), department_key = coalesce($4, department_key), updated_at = now() where id = $1`,
      [userId, Number(profile.role.id), aligned.groupId || null, aligned.departmentKey || null]
    );
    await syncPrimaryRole(client, Number(userId), Number(profile.role.id));
  }

  for (const c of changes) {
    await client.query(
      `update user_access_overrides set revoked_at = now(), revoked_by = $3, updated_at = now() where user_id = $1 and screen_key = $2 and revoked_at is null`,
      [userId, c.screen_key, actor]
    );
    if (c.clear) continue;
    const custom = c.level === "custom";
    await client.query(
      `
        insert into user_access_overrides (
          user_id, screen_key, level, scope,
          can_view, can_create, can_edit, can_approve, own_records_only, financial_masking,
          reason, expires_at, source, granted_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'v2',$13)
      `,
      [
        userId,
        c.screen_key,
        c.level,
        c.scope || "all",
        custom ? c.can_view : null,
        custom ? c.can_create : null,
        custom ? c.can_edit : null,
        custom ? c.can_approve : null,
        custom ? c.own_records_only : null,
        custom ? c.financial_masking : null,
        String(reason).trim().slice(0, 500),
        c.expires_at || null,
        actor,
      ]
    );
  }
  await mirrorUserOverridesToLegacy(client, userId);
  const afterOverrides = (await loadActiveOverridesDetailed(client, userId)).map(describeOverride);
  await writeAudit(client, {
    actorId,
    userId,
    action,
    before: { role_id: person.primary_role_id, role_name: person.role_name, overrides: beforeOverrides },
    after: {
      role_id: profile ? Number(profile.role.id) : person.primary_role_id,
      role_name: profile ? profile.role.role_name : person.role_name,
      overrides: afterOverrides,
      reason: String(reason || "").trim() || null,
      changed_screens: changes.map((c) => c.screen_key),
    },
  });
  return { profile_changed: Boolean(profile), overrides: afterOverrides };
}

/** Screen-by-screen comparison of two people's effective access. */
async function comparePeople(client, userId, otherId) {
  const [a, b] = await Promise.all([loadPerson(client, userId), loadPerson(client, otherId)]);
  if (!a || !b) throw accessError(404, "USER_NOT_FOUND");
  const [ma, mb] = await Promise.all([
    loadCompiledPermissionMaps(client, Number(a.primary_role_id), a.group_name, { userId: Number(a.id) }),
    loadCompiledPermissionMaps(client, Number(b.primary_role_id), b.group_name, { userId: Number(b.id) }),
  ]);
  const rows = [];
  for (const s of SCREEN_CATALOG) {
    const la = fitLevel(ma.screens[s.screen_key], s.screen_key);
    const lb = fitLevel(mb.screens[s.screen_key], s.screen_key);
    const same = FLAG_KEYS.every((k) => Boolean(ma.screens[s.screen_key]?.[k]) === Boolean(mb.screens[s.screen_key]?.[k]));
    if (!same) rows.push({ screen_key: s.screen_key, screen_name: s.screen_name, module_key: s.module_key, a: la, b: lb });
  }
  const who = (p) => ({ id: Number(p.id), full_name: p.full_name, role_name: p.role_name, group_name: p.group_name });
  return { a: who(a), b: who(b), differences: rows, same_count: SCREEN_CATALOG.length - rows.length };
}

/**
 * "Copy access from…": adopt the source person's profile and exceptions. Returns a proposal the
 * editor previews and saves through the normal path; nothing is written here.
 */
async function planCopyFrom(client, userId, fromId) {
  const [target, source] = await Promise.all([loadPerson(client, userId), loadPerson(client, fromId)]);
  if (!target || !source) throw accessError(404, "USER_NOT_FOUND");
  if (Number(target.id) === Number(source.id)) throw accessError(400, "SAME_USER");
  const [targetActive, sourceActive] = await Promise.all([
    loadActiveOverridesDetailed(client, userId),
    loadActiveOverridesDetailed(client, fromId),
  ]);
  const sourceKeys = new Set(sourceActive.map((o) => o.screen_key));
  const changes = [
    ...targetActive.filter((o) => !sourceKeys.has(o.screen_key)).map((o) => ({ screen_key: o.screen_key, clear: true })),
    ...sourceActive.map((o) => {
      const c = { screen_key: o.screen_key, level: o.level, scope: o.scope, expires_at: o.expires_at || null };
      if (o.level === "custom") for (const k of FLAG_KEYS) c[k] = o[k];
      return c;
    }),
  ];
  const roleId = Number(source.primary_role_id) > 0 && Number(source.primary_role_id) !== Number(target.primary_role_id) ? Number(source.primary_role_id) : null;
  return {
    from: { id: Number(source.id), full_name: source.full_name, role_name: source.role_name },
    role_id: roleId,
    role_name: roleId ? source.role_name : null,
    changes,
    suggested_reason: `Copied access from ${source.full_name}`,
  };
}

/** Live preview for Add person: what the chosen profile + exceptions will give, per module. */
async function previewNewPerson(client, { roleId, changes = [] }) {
  const roleRes = await client.query(`select id, role_key, role_name, default_workspace_family from roles where id = $1 and is_active = true`, [Number(roleId) || 0]);
  const role = roleRes.rows[0];
  if (!role) return { role: null, modules: [] };
  const groupName = (await mappedGroupName(client, role)) || "Staff";
  const projected = projectOverrides([], changes);
  const maps = await loadCompiledPermissionMaps(client, Number(role.id), groupName, { overrides: projected });
  const modules = ACCESS_MODULES.map((mod) => {
    const screens = SCREEN_CATALOG.filter((s) => s.module_key === mod.module_key).map((s) => ({
      screen_key: s.screen_key,
      screen_name: s.screen_name,
      ...fitLevel(maps.screens[s.screen_key], s.screen_key),
    }));
    return {
      module_key: mod.module_key,
      label: mod.label,
      ...summarizeLevel(screens),
      screens_open: screens.filter((s) => s.level !== "none").length,
      screens_total: screens.length,
      screens,
    };
  });
  const adminOpen = SCREEN_CATALOG.filter((s) => !MODULE_KEYS.has(s.module_key) && maps.screens[s.screen_key]?.can_view).map((s) => s.screen_name);
  return {
    role: { id: Number(role.id), role_name: role.role_name, group_name: groupName },
    superadmin_bypass: groupName === "SuperAdmin",
    modules,
    admin_screens: adminOpen,
  };
}

module.exports = {
  accessError,
  normalizeOverrideChanges,
  getPersonAccessState,
  previewPersonChange,
  applyPersonChange,
  comparePeople,
  planCopyFrom,
  previewNewPerson,
};
