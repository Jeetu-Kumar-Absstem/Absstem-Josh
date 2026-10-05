const { pool } = require("../db/pool");

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Records an immutable audit trail entry across any operational action.
 */
async function recordAuditLog(db, {
  companyId = null,
  actorId = null,
  actorEmail = null,
  actorName = null,
  actionType = "UPDATE",
  module = "GENERAL",
  targetTable = null,
  targetId = null,
  oldPayload = null,
  newPayload = null,
  ipAddress = null,
  userAgent = null,
  status = "success",
  remarks = null,
}) {
  try {
    const client = db || pool;
    const res = await client.query(
      `
        insert into audit_logs (
          company_id, actor_id, actor_email, actor_name, action_type,
          module, target_table, target_id, old_payload, new_payload,
          ip_address, user_agent, status, remarks, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
        returning id
      `,
      [
        companyId,
        actorId,
        actorEmail,
        actorName,
        actionType.toUpperCase(),
        module.toUpperCase(),
        targetTable,
        targetId ? String(targetId) : null,
        oldPayload ? JSON.stringify(oldPayload) : null,
        newPayload ? JSON.stringify(newPayload) : null,
        ipAddress,
        userAgent,
        status,
        remarks,
      ]
    );
    return res.rows[0]?.id;
  } catch (err) {
    console.error("Failed to record audit log:", err?.message || err);
    return null;
  }
}

/**
 * Fetches filtered audit logs.
 */
async function getAuditLogs(db, {
  companyId = null,
  module = null,
  actionType = null,
  actorId = null,
  search = null,
  limit = 100,
  offset = 0,
}) {
  const client = db || pool;
  let query = `
    select
      al.*,
      coalesce(u.full_name, al.actor_name, 'System Engine') as actor_display_name,
      coalesce(u.email, al.actor_email, 'system@absstem.com') as actor_display_email
    from audit_logs al
    left join erp_users u on u.id = al.actor_id
    where 1=1
  `;
  const params = [];

  if (companyId) {
    params.push(companyId);
    query += ` and (al.company_id = $${params.length} or al.company_id is null)`;
  }

  if (module && module !== "ALL") {
    params.push(module.toUpperCase());
    query += ` and al.module = $${params.length}`;
  }

  if (actionType && actionType !== "ALL") {
    params.push(actionType.toUpperCase());
    query += ` and al.action_type = $${params.length}`;
  }

  if (actorId) {
    params.push(actorId);
    query += ` and al.actor_id = $${params.length}`;
  }

  if (search) {
    params.push(`%${search.trim().toLowerCase()}%`);
    query += ` and (
      lower(coalesce(al.target_table, '')) like $${params.length} or
      lower(coalesce(al.target_id, '')) like $${params.length} or
      lower(coalesce(al.remarks, '')) like $${params.length} or
      lower(coalesce(al.actor_name, '')) like $${params.length} or
      lower(coalesce(al.actor_email, '')) like $${params.length}
    )`;
  }

  query += ` order by al.created_at desc limit $${params.length + 1} offset $${params.length + 2}`;
  params.push(limit, offset);

  const res = await client.query(query, params);
  return res.rows;
}

/**
 * Records a backup *intent* only. Does NOT run pg_dump or write a restore file.
 * Wave 4: never present this as disaster-recovery coverage or fabricate dump size KPIs.
 */
async function triggerDatabaseBackup(db, {
  companyId = null,
  backupType = "manual",
  destination = "local_vps",
  userId = null,
}) {
  const client = db || pool;
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupCode = `BK-${Date.now().toString(36).toUpperCase()}`;
  const fileName = `josh_backup_intent_${timestamp}.log`;
  const filePath = null;

  const statsRes = await client.query(`
    select
      count(*) as total_tables,
      coalesce(sum(n_live_tup), 0) as total_records
    from pg_stat_user_tables
  `);
  const totalTables = Number(statsRes.rows[0]?.total_tables || 0);
  const totalRecords = Number(statsRes.rows[0]?.total_records || 0);
  const durationSec = Number(((Date.now() - startTime) / 1000).toFixed(2));

  const insRes = await client.query(
    `
      insert into system_backups (
        company_id, backup_code, backup_type, storage_destination,
        file_path, file_name, file_size_bytes, file_size_display,
        tables_included_count, records_backed_up, duration_seconds,
        status, error_message, created_by, created_at, completed_at
      )
      values ($1, $2, $3, $4, $5, $6, 0, 'No dump file', $7, $8, $9, 'metadata_only', $10, $11, now(), now())
      returning *
    `,
    [
      companyId,
      backupCode,
      backupType,
      destination,
      filePath,
      fileName,
      totalTables,
      totalRecords,
      durationSec,
      "Metadata-only: no pg_dump executed. Not disaster-recovery coverage.",
      userId,
    ]
  );

  await recordAuditLog(client, {
    companyId,
    actorId: userId,
    actionType: "BACKUP_TRIGGER",
    module: "SYSTEM_ADMIN",
    targetTable: "system_backups",
    targetId: insRes.rows[0]?.id,
    newPayload: insRes.rows[0],
    status: "warning",
    remarks: `Backup intent ${backupCode} logged as metadata_only — no dump file written`,
  });

  return insRes.rows[0];
}

/**
 * Returns recent system backups.
 */
async function listBackups(db, { limit = 50 } = {}) {
  const client = db || pool;
  const res = await client.query(
    `
      select
        sb.*,
        u.full_name as triggered_by_name,
        u.email as triggered_by_email
      from system_backups sb
      left join erp_users u on u.id = sb.created_by
      order by sb.created_at desc
      limit $1
    `,
    [limit]
  );
  return res.rows;
}

/**
 * Gathers system health, database metrics, and server heartbeat telemetry.
 */
async function getSystemHealthOverview(db) {
  const client = db || pool;

  // DB Size and connection count
  const dbSizeRes = await client.query(`
    select current_database() as database_name,
           pg_database_size(current_database()) as db_size_bytes,
           pg_size_pretty(pg_database_size(current_database())) as db_size,
           (select count(*) from pg_stat_activity where datname = current_database()) as active_connections
  `);

  // Total users and active users
  const userStatsRes = await client.query(`
    select
      count(*) as total_users,
      count(*) filter (where is_active = true) as active_users
    from erp_users
  `);

  // Recent audit events in past 24 hours
  const audit24hRes = await client.query(`
    select count(*) as events_24h
    from audit_logs
    where created_at >= now() - interval '24 hours'
  `);

  // Last backup status
  const lastBackupRes = await client.query(`
    select *
    from system_backups
    order by created_at desc
    limit 1
  `);
  const verifiedDumpRes = await client.query(`
    select count(*)::int as n
    from system_backups
    where status = 'completed' and coalesce(file_size_bytes, 0) > 0
  `);

  const dbRow = dbSizeRes.rows[0] || {};
  const poolMax = Number(pool?.options?.max);
  return {
    database: {
      status: dbRow.database_name ? "REACHABLE" : "UNKNOWN",
      current_database: dbRow.database_name || null,
      size_bytes: dbRow.db_size_bytes != null ? Number(dbRow.db_size_bytes) : null,
      size_pretty: dbRow.db_size || null,
      active_connections: dbRow.active_connections != null ? Number(dbRow.active_connections) : null,
      pool_capacity: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : null,
    },
    backup_coverage: {
      mode: "metadata_only",
      pg_dump_wired: false,
      restore_tested: false,
      verified_dump_count: Number(verifiedDumpRes.rows[0]?.n || 0),
      note: "Josh does not run pg_dump. Rely on OS/VPS scheduled dumps with a tested restore for disaster recovery.",
    },
    users: {
      total_count: Number(userStatsRes.rows[0]?.total_users || 0),
      active_count: Number(userStatsRes.rows[0]?.active_users || 0),
    },
    audit_telemetry: {
      events_past_24h: Number(audit24hRes.rows[0]?.events_24h || 0),
    },
    last_backup: lastBackupRes.rows[0] || null,
    api_process_uptime_seconds: Math.round(process.uptime()),
    server_time: new Date().toISOString(),
  };
}

module.exports = {
  recordAuditLog,
  getAuditLogs,
  triggerDatabaseBackup,
  listBackups,
  getSystemHealthOverview,
};
