const { resolveRoleProfile } = require("../auth/roleProfile");

/**
 * When a primary role is set, derive group_id + department_key from the Role Profile map.
 */
async function applyRoleProfileIdentity(client, { roleId, groupId, departmentKey }) {
  const rid = Number(roleId);
  if (!Number.isFinite(rid) || rid <= 0) {
    return { groupId: Number(groupId) || null, departmentKey: departmentKey || null, role: null };
  }

  const roleRes = await client.query(
    `
      select id, role_key, role_name, default_workspace_family
      from roles
      where id = $1 and is_active = true
      limit 1
    `,
    [rid]
  );
  const role = roleRes.rows[0] || null;
  if (!role) {
    return { groupId: Number(groupId) || null, departmentKey: departmentKey || null, role: null };
  }

  const [groupsRes, depsRes] = await Promise.all([
    client.query(`select id, group_name from user_groups where is_active = true`),
    client.query(`select department_key from departments where is_active = true`),
  ]);
  const mapped = resolveRoleProfile(role, {
    groupNames: groupsRes.rows.map((g) => g.group_name),
    departmentKeys: depsRes.rows.map((d) => d.department_key),
  });
  const groupRow = groupsRes.rows.find((g) => String(g.group_name) === String(mapped.groupName)) || null;
  return {
    groupId: groupRow?.id != null ? Number(groupRow.id) : Number(groupId) || null,
    departmentKey: mapped.departmentKey || null,
    role,
    mapped,
  };
}

async function syncPrimaryRole(client, userId, roleId) {
  await client.query(`update user_roles set is_primary = false where user_id = $1`, [userId]);
  if (!Number.isFinite(roleId)) return;
  await client.query(
    `
      insert into user_roles (user_id, role_id, is_primary)
      values ($1,$2,true)
      on conflict (user_id, role_id) do update set is_primary = true
    `,
    [userId, roleId]
  );
}

/**
 * Rejects manager assignments that would make the reporting tree loop back to the user.
 * Walks upward from each proposed manager through both primary and secondary links.
 * Returns null when valid, or { error, detail, chain } describing the problem.
 */
async function findManagerAssignmentProblem(client, { userId, primaryManagerUserId, secondaryManagerUserId }) {
  const uid = Number(userId);
  const managers = [primaryManagerUserId, secondaryManagerUserId]
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!managers.length) return null;

  if (Number.isFinite(uid) && managers.includes(uid)) {
    return { error: "INVALID_MANAGER", detail: "A person cannot be their own manager." };
  }

  const found = await client.query(`select id from erp_users where id = any($1::int[])`, [managers]);
  const foundIds = new Set(found.rows.map((row) => Number(row.id)));
  const missing = managers.filter((id) => !foundIds.has(id));
  if (missing.length) {
    return { error: "INVALID_MANAGER", detail: `Manager user ${missing.join(", ")} does not exist.` };
  }

  if (!Number.isFinite(uid) || uid <= 0) return null;

  const r = await client.query(
    `
      with recursive chain(id, path) as (
        select m.id, array[m.id]
        from erp_users m
        where m.id = any($1::int[])
        union all
        select next_mgr.id, c.path || next_mgr.id
        from chain c
        join erp_users u on u.id = c.id
        join lateral (
          select unnest(array[u.primary_manager_user_id, u.secondary_manager_user_id]) as id
        ) next_mgr on next_mgr.id is not null
        where not (next_mgr.id = any(c.path))
          and array_length(c.path, 1) < 60
      )
      select path from chain where id = $2 limit 1
    `,
    [managers, uid]
  );
  const loopPath = r.rows[0]?.path;
  if (!loopPath) return null;

  const names = await client.query(`select id, full_name from erp_users where id = any($1::int[])`, [[uid, ...loopPath]]);
  const nameById = new Map(names.rows.map((row) => [Number(row.id), row.full_name || `User ${row.id}`]));
  const chain = [uid, ...loopPath.map(Number)].map((id) => nameById.get(id) || `User ${id}`);
  return {
    error: "MANAGER_CYCLE",
    detail: `This would create a reporting loop: ${chain.join(" → ")}.`,
    chain,
  };
}

/**
 * Moves everyone reporting to fromUserId under toUserId without creating a loop.
 * A successor who was a direct report takes over the leaver's own managers instead;
 * a successor deeper in the leaver's team is rejected (error.code = MANAGER_CYCLE).
 * Returns the ids of users whose manager changed.
 */
async function reassignDirectReports(client, { fromUserId, toUserId }) {
  const fromId = Number(fromUserId);
  const toId = Number(toUserId);
  const depthRes = await client.query(
    `
      with recursive downline(id, depth) as (
        select u.id, 1
        from erp_users u
        where u.id <> $1 and (u.primary_manager_user_id = $1 or u.secondary_manager_user_id = $1)
        union
        select u.id, d.depth + 1
        from erp_users u
        join downline d on u.primary_manager_user_id = d.id or u.secondary_manager_user_id = d.id
        where u.id <> $1 and d.depth < 60
      )
      select min(depth)::int as depth from downline where id = $2
    `,
    [fromId, toId]
  );
  const successorDepth = depthRes.rows[0]?.depth || null;
  if (successorDepth && successorDepth > 1) {
    const err = new Error(
      "The successor sits inside the leaving person's team. Move the successor under someone outside that team first, or pick a different successor."
    );
    err.code = "MANAGER_CYCLE";
    err.status = 400;
    throw err;
  }

  const changed = [];
  if (successorDepth === 1) {
    const leaver = await client.query(
      `select primary_manager_user_id, secondary_manager_user_id from erp_users where id = $1`,
      [fromId]
    );
    const upPrimary = leaver.rows[0]?.primary_manager_user_id ?? null;
    const upSecondary = leaver.rows[0]?.secondary_manager_user_id ?? null;
    const promoted = await client.query(
      `
        update erp_users
        set
          primary_manager_user_id = case when primary_manager_user_id = $2 then nullif($3::int, id) else primary_manager_user_id end,
          secondary_manager_user_id = case when secondary_manager_user_id = $2 then nullif($4::int, id) else secondary_manager_user_id end,
          updated_at = now()
        where id = $1
        returning id
      `,
      [toId, fromId, upPrimary, upSecondary]
    );
    changed.push(...promoted.rows.map((row) => Number(row.id)));
  }

  const moved = await client.query(
    `
      update erp_users
      set
        primary_manager_user_id = case when primary_manager_user_id = $1 then $2 else primary_manager_user_id end,
        secondary_manager_user_id = case when secondary_manager_user_id = $1 then $2 else secondary_manager_user_id end,
        updated_at = now()
      where id <> $1
        and id <> $2
        and (primary_manager_user_id = $1 or secondary_manager_user_id = $1)
      returning id
    `,
    [fromId, toId]
  );
  changed.push(...moved.rows.map((row) => Number(row.id)));
  return changed;
}

module.exports = {
  applyRoleProfileIdentity,
  findManagerAssignmentProblem,
  reassignDirectReports,
  syncPrimaryRole,
};
