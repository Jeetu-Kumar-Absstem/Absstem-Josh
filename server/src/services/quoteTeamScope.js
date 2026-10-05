/**
 * Quote visibility for users whose Quotes permission is "own records only":
 * their own quotes, everyone below them in the reporting tree (primary or secondary
 * manager, any depth — distributor staff report to their internal manager the same way),
 * and, during an active leave cover, the covered colleague and that colleague's team.
 */

async function loadActiveCoversFor(db, userId) {
  const r = await db.query(
    `
      select d.id, d.from_user_id, u.full_name as from_user_name, d.start_date, d.end_date
      from quote_cover_delegations d
      join erp_users u on u.id = d.from_user_id
      where d.to_user_id = $1
        and d.cancelled_at is null
        and current_date between d.start_date and d.end_date
    `,
    [userId]
  );
  return r.rows;
}

async function loadReportingTreeIds(db, seedUserIds) {
  const seeds = [...new Set(seedUserIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (!seeds.length) return new Set();
  const r = await db.query(
    `
      with recursive team(id) as (
        select unnest($1::int[])
        union
        select u.id
        from erp_users u
        join team t on u.primary_manager_user_id = t.id or u.secondary_manager_user_id = t.id
      )
      select id from team
    `,
    [seeds]
  );
  return new Set(r.rows.map((row) => Number(row.id)));
}

async function loadQuoteScope(db, userId) {
  const me = Number(userId);
  const covers = await loadActiveCoversFor(db, me);
  const userIds = await loadReportingTreeIds(db, [me, ...covers.map((c) => c.from_user_id)]);
  userIds.add(me);
  return {
    userIds,
    coveringFor: covers.map((c) => ({
      user_id: Number(c.from_user_id),
      full_name: c.from_user_name,
      start_date: c.start_date,
      end_date: c.end_date,
    })),
  };
}

/** Strict reportees (any depth) of userId, excluding userId itself. */
async function loadReporteeIds(db, userId) {
  const me = Number(userId);
  const ids = await loadReportingTreeIds(db, [me]);
  ids.delete(me);
  return ids;
}

async function isCoveringFor(db, { coverUserId, absentUserId }) {
  const r = await db.query(
    `
      select 1
      from quote_cover_delegations
      where to_user_id = $1
        and from_user_id = $2
        and cancelled_at is null
        and current_date between start_date and end_date
      limit 1
    `,
    [Number(coverUserId), Number(absentUserId)]
  );
  return Boolean(r.rows[0]);
}

module.exports = {
  isCoveringFor,
  loadActiveCoversFor,
  loadQuoteScope,
  loadReporteeIds,
  loadReportingTreeIds,
};
