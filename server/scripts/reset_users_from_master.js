const fs = require("fs");
const path = require("path");

require("dotenv").config();

const { pool } = require("../src/db/pool");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || (row.length === 1 && row[0].trim().length)) rows.push(row);
      row = [];
      continue;
    }

    if (ch === "\r") continue;

    field += ch;
  }

  row.push(field);
  if (row.length > 1 || (row.length === 1 && row[0].trim().length)) rows.push(row);

  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((item) => String(item || "").trim());
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const obj = {};
    for (let j = 0; j < header.length; j += 1) {
      obj[header[j]] = String(row[j] || "").trim();
    }
    out.push(obj);
  }
  return out;
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text.length ? text : null;
}

function normalizeEmail(value) {
  return cleanText(value)?.toLowerCase() || null;
}

function normalizeYesNo(value) {
  return String(value || "").trim().toUpperCase() === "YES";
}

function normalizePct(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function parseDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parts = raw.split("-");
  if (parts.length !== 3) return null;

  const monthMap = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };

  const day = Number(parts[0]);
  const month = monthMap[String(parts[1] || "").slice(0, 3).toLowerCase()];
  let year = Number(parts[2]);

  if (!Number.isFinite(day) || !month || !Number.isFinite(year)) return null;
  if (year < 100) year += 2000;

  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function parseActorCode(value, { preferRight = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!raw.includes(":")) return raw.replace(/\s+/g, "");
  const [left, right] = raw.split(":");
  const chosen = preferRight ? right : left;
  return String(chosen || "")
    .trim()
    .split(/\s+/)[0]
    .trim() || null;
}

function mapRoleKey(row) {
  const isSuperAdmin = normalizeYesNo(row.SuperAdmin);
  const userCode = String(row.UserCode || "").trim().toUpperCase();
  const designation = String(row.UserGroupName || "").trim().toLowerCase();

  if (isSuperAdmin) return "super_admin";
  if (userCode.startsWith("DT") || designation === "distributor") return "distributor";
  if (designation.includes("sales head")) return "sales_head";
  if (designation.includes("regional")) return "regional_head";
  if (designation.includes("design engineer")) return "design_engineer";
  if (designation.includes("accountant") || designation.includes("account assistance")) return "accounts";
  if (designation.includes("service engineer")) return "service_engineer";
  if (designation.includes("service")) return "post_sales";
  if (designation.includes("purchase")) return "purchase";
  if (designation.includes("dispatch")) return "dispatch";
  if (designation.includes("stores")) return "stores";
  if (designation.includes("qa")) return "qa";
  if (designation.includes("production planner")) return "production_planner";
  if (
    designation.includes("chief executive officer") ||
    designation.includes("director") ||
    designation.includes("general manager") ||
    designation.includes("branding manager") ||
    designation === "admin"
  ) {
    return "management";
  }
  return "sales_executive";
}

async function ensureCoreSetup(client) {
  const groupDefs = [
    ["SuperAdmin", 100],
    ["Distributor", 15],
    ["Staff", 0],
  ];

  for (const [groupName, maxDiscount] of groupDefs) {
    await client.query(
      `
        insert into user_groups (group_name, max_autonomous_discount_pct, is_active)
        values ($1, $2, true)
        on conflict (group_name) do update set
          max_autonomous_discount_pct = excluded.max_autonomous_discount_pct,
          is_active = true
      `,
      [groupName, maxDiscount]
    );
  }

  const groupsRes = await client.query(`select id, group_name from user_groups`);
  const groupByName = new Map(groupsRes.rows.map((row) => [row.group_name, row.id]));

  const neededRoles = [
    ["super_admin", "SuperAdmin"],
    ["distributor", "Distributor"],
    ["management", "Management"],
    ["sales_head", "Sales Head"],
    ["sales_executive", "Sales Executive"],
    ["regional_head", "Regional Head"],
    ["accounts", "Accounts"],
    ["post_sales", "Post Sales"],
    ["service_engineer", "Service Engineer"],
    ["design_engineer", "Design Engineer"],
    ["purchase", "Purchase"],
    ["dispatch", "Dispatch"],
    ["stores", "Stores"],
    ["qa", "QA"],
    ["production_planner", "Production Planner"],
  ];

  for (const [roleKey, roleName] of neededRoles) {
    await client.query(
      `
        insert into roles (role_key, role_name, is_active)
        values ($1, $2, true)
        on conflict (role_key) do update set
          role_name = excluded.role_name,
          is_active = true
      `,
      [roleKey, roleName]
    );
  }

  const rolesRes = await client.query(`select id, role_key from roles`);
  const roleByKey = new Map(rolesRes.rows.map((row) => [row.role_key, row.id]));

  return { groupByName, roleByKey };
}

async function ensureDistributor(client, companyName, email, phone, cache) {
  const normalized = String(companyName || "").trim();
  if (!normalized) return null;

  const cacheKey = normalized.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const existingRes = await client.query(
    `
      select id
      from distributors
      where lower(company_name) = lower($1)
      order by id asc
      limit 1
    `,
    [normalized]
  );

  if (existingRes.rows[0]?.id) {
    const distributorId = existingRes.rows[0].id;
    await client.query(
      `
        update distributors
        set
          contact_email = coalesce($2, contact_email),
          contact_phone = coalesce($3, contact_phone),
          is_active = true,
          updated_at = now()
        where id = $1
      `,
      [distributorId, email, phone]
    );
    cache.set(cacheKey, distributorId);
    return distributorId;
  }

  const insertRes = await client.query(
    `
      insert into distributors (company_name, contact_email, contact_phone, is_active, updated_at)
      values ($1, $2, $3, true, now())
      returning id
    `,
    [normalized, email, phone]
  );

  const distributorId = insertRes.rows[0].id;
  cache.set(cacheKey, distributorId);
  return distributorId;
}

async function syncPrimaryRole(client, userId, roleId, keepAssignedByUserId) {
  await client.query(`delete from user_roles where user_id = $1`, [userId]);
  await client.query(
    `
      insert into user_roles (user_id, role_id, is_primary, assigned_by)
      values ($1, $2, true, $3)
    `,
    [userId, roleId, keepAssignedByUserId]
  );
}

async function syncDistributorLink(client, userId, distributorId) {
  if (!distributorId) {
    await client.query(`delete from user_distributor_links where user_id = $1`, [userId]);
    return;
  }

  await client.query(
    `
      insert into user_distributor_links (user_id, distributor_id)
      values ($1, $2)
      on conflict (user_id) do update set distributor_id = excluded.distributor_id
    `,
    [userId, distributorId]
  );
}

async function loadUserReferenceColumns(client) {
  const res = await client.query(
    `
      select
        ns.nspname as schema_name,
        cls.relname as table_name,
        att.attname as column_name,
        con.confdeltype as on_delete_type
      from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace ns on ns.oid = cls.relnamespace
      join unnest(con.conkey) as k(attnum) on true
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
      where con.contype = 'f'
        and con.confrelid = 'erp_users'::regclass
      order by ns.nspname, cls.relname, att.attname
    `
  );
  return res.rows;
}

async function hardDeleteOtherUsers(client, keepUserId) {
  const refs = await loadUserReferenceColumns(client);

  for (const ref of refs) {
    const tableName = `"${ref.schema_name}"."${ref.table_name}"`;
    const columnName = `"${ref.column_name}"`;

    if (ref.on_delete_type === "c") {
      continue;
    }

    if (ref.table_name === "erp_users" && (ref.column_name === "primary_manager_user_id" || ref.column_name === "secondary_manager_user_id")) {
      await client.query(
        `update ${tableName} set ${columnName} = null where ${columnName} is not null and ${columnName} <> $1`,
        [keepUserId]
      );
      continue;
    }

    await client.query(
      `update ${tableName} set ${columnName} = $1 where ${columnName} is not null and ${columnName} <> $1`,
      [keepUserId]
    );
  }

  await client.query(`delete from erp_users where id <> $1`, [keepUserId]);
}

function normalizeCsvRows(csvRows) {
  return csvRows
    .map((row) => {
      const userCode = cleanText(row.UserCode);
      const email = normalizeEmail(row["Email ID"]);
      if (!userCode || !email) return null;

      const isDistributor = userCode.toUpperCase().startsWith("DT") || String(row.UserGroupName || "").trim().toLowerCase() === "distributor";
      const isSuperAdmin = email === "amit.s@absstem.com" || normalizeYesNo(row.SuperAdmin);

      return {
        raw: row,
        userCode,
        fullName: cleanText(row.UserName),
        email,
        phone: cleanText(row.Phone),
        designation: cleanText(row.UserGroupName),
        employeeCode: parseActorCode(row.Employee, { preferRight: false }),
        companyName: isDistributor ? cleanText(row["Organisation Name"]) : null,
        dateOfJoining: parseDate(row.DOJ),
        localAddress: cleanText(row.LAddress),
        permanentAddress: cleanText(row.PAddress),
        discountThresholdPct: normalizePct(row["Discount % threshold"]),
        isActive: normalizeYesNo(row.Active),
        isDistributor,
        isSuperAdmin,
        primaryHeadCode: parseActorCode(row.ReportingHead1, { preferRight: true }),
        secondaryHeadCode: parseActorCode(row.ReportingHead2, { preferRight: true }),
        roleKey: mapRoleKey(row),
      };
    })
    .filter(Boolean);
}

async function upsertUser(client, user, ids, keepUserId, distributorCache) {
  const groupId = user.isSuperAdmin
    ? ids.groupByName.get("SuperAdmin")
    : user.isDistributor
      ? ids.groupByName.get("Distributor")
      : ids.groupByName.get("Staff");

  const roleId = ids.roleByKey.get(user.isSuperAdmin ? "super_admin" : user.roleKey) || ids.roleByKey.get("sales_executive");

  const upsertRes = await client.query(
    `
      insert into erp_users (
        user_code,
        email,
        full_name,
        phone,
        designation,
        company_name,
        employee_code,
        group_id,
        primary_role_id,
        date_of_joining,
        local_address,
        permanent_address,
        discount_threshold_pct,
        is_active,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
      on conflict (email) do update set
        user_code = excluded.user_code,
        full_name = excluded.full_name,
        phone = excluded.phone,
        designation = excluded.designation,
        company_name = excluded.company_name,
        employee_code = excluded.employee_code,
        group_id = excluded.group_id,
        primary_role_id = excluded.primary_role_id,
        date_of_joining = excluded.date_of_joining,
        local_address = excluded.local_address,
        permanent_address = excluded.permanent_address,
        discount_threshold_pct = excluded.discount_threshold_pct,
        is_active = excluded.is_active,
        updated_at = now()
      returning id
    `,
    [
      user.userCode,
      user.email,
      user.fullName,
      user.phone,
      user.designation,
      user.companyName,
      user.employeeCode,
      groupId,
      roleId,
      user.dateOfJoining,
      user.localAddress,
      user.permanentAddress,
      user.discountThresholdPct,
      user.isSuperAdmin ? true : user.isActive,
    ]
  );

  const userId = upsertRes.rows[0].id;
  await syncPrimaryRole(client, userId, roleId, keepUserId);

  if (user.isDistributor) {
    const distributorId = await ensureDistributor(client, user.companyName, user.email, user.phone, distributorCache);
    await syncDistributorLink(client, userId, distributorId);
  } else {
    await syncDistributorLink(client, userId, null);
  }

  return userId;
}

async function applyReporting(client, users, userIdByCode) {
  for (const user of users) {
    const userId = userIdByCode.get(user.userCode);
    if (!userId) continue;

    let primaryManagerUserId = user.primaryHeadCode ? userIdByCode.get(user.primaryHeadCode) || null : null;
    let secondaryManagerUserId = user.secondaryHeadCode ? userIdByCode.get(user.secondaryHeadCode) || null : null;

    if (user.isDistributor) {
      if (user.secondaryHeadCode && /^DT/i.test(user.secondaryHeadCode) && user.secondaryHeadCode.toUpperCase() !== user.userCode.toUpperCase()) {
        primaryManagerUserId = userIdByCode.get(user.secondaryHeadCode) || null;
        secondaryManagerUserId = user.primaryHeadCode ? userIdByCode.get(user.primaryHeadCode) || null : null;
      } else {
        secondaryManagerUserId = null;
      }
    }

    await client.query(
      `
        update erp_users
        set
          primary_manager_user_id = $2,
          secondary_manager_user_id = $3,
          updated_at = now()
        where id = $1
      `,
      [userId, primaryManagerUserId, secondaryManagerUserId]
    );
  }
}

async function main() {
  const csvArg = process.argv[2] || path.resolve(process.cwd(), "..", "UserMaster_16-Jun-2026.csv");
  const csvPath = path.resolve(csvArg);

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  const csvText = fs.readFileSync(csvPath, "utf8");
  const csvRows = normalizeCsvRows(rowsToObjects(parseCsv(csvText)));
  if (!csvRows.length) {
    throw new Error("No usable user rows found in CSV.");
  }

  const amitRow = csvRows.find((row) => row.email === "amit.s@absstem.com");
  if (!amitRow) {
    throw new Error("Required SuperAdmin row amit.s@absstem.com was not found in the CSV.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const ids = await ensureCoreSetup(client);
    const distributorCache = new Map();

    const amitId = await upsertUser(client, { ...amitRow, isSuperAdmin: true }, ids, null, distributorCache);
    await hardDeleteOtherUsers(client, amitId);

    const userIdByCode = new Map();
    for (const user of csvRows) {
      const userId = await upsertUser(client, { ...user, isSuperAdmin: user.email === "amit.s@absstem.com" }, ids, amitId, distributorCache);
      userIdByCode.set(user.userCode, userId);
    }

    await applyReporting(client, csvRows, userIdByCode);

    const countsRes = await client.query(
      `
        select
          count(*)::int as total_users,
          count(*) filter (where is_active) ::int as active_users
        from erp_users
      `
    );

    await client.query("commit");

    const counts = countsRes.rows[0] || {};
    console.log("User reset/import completed.");
    console.log(`CSV: ${csvPath}`);
    console.log(`Total users in DB: ${counts.total_users || 0}`);
    console.log(`Active users in DB: ${counts.active_users || 0}`);
    console.log(`Preserved SuperAdmin: amit.s@absstem.com (user id ${amitId})`);
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
