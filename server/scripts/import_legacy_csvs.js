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
  const header = rows[0].map((h) => (h || "").trim());
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    const obj = {};
    for (let j = 0; j < header.length; j += 1) {
      obj[header[j]] = (r[j] || "").trim();
    }
    out.push(obj);
  }
  return out;
}

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function parseLegacyActor(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const idx = raw.indexOf(":");
  const left = idx >= 0 ? raw.slice(0, idx).trim() : raw.split(/\s+/)[0].trim();
  const code = left.replace(/\s+/g, "");
  const name = idx >= 0 ? raw.slice(idx + 1).trim() : raw;
  return { code, name };
}

function parseLegacyDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw === "01-Jan-1900") return null;

  const monthMap = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11,
  };

  const parts = raw.split(/\s+/).filter(Boolean);
  const datePart = parts[0];
  const timePart = parts.length >= 2 ? parts[1] : "";
  const ampmPart = parts.length >= 3 ? parts[2] : "";

  const dm = datePart.split("-");
  if (dm.length !== 3) return null;
  const day = Number(dm[0]);
  const mon = monthMap[String(dm[1] || "").slice(0, 3).toUpperCase()];
  const year = Number(dm[2]);
  if (!Number.isFinite(day) || !Number.isFinite(mon) || !Number.isFinite(year)) return null;

  let hour = 0;
  let minute = 0;
  let second = 0;

  if (timePart) {
    const t = timePart.split(":");
    hour = Number(t[0] || 0);
    minute = Number(t[1] || 0);
    second = Number((t[2] || "0").replace(/[^0-9]/g, "")) || 0;

    const ampm = String(ampmPart || "").toUpperCase();
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
  }

  const dt = new Date(Date.UTC(year, mon, day, hour, minute, second));
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

async function getCoreIds(client) {
  const groupsRes = await client.query(
    `select id, group_name from user_groups where group_name in ('SuperAdmin','Distributor')`
  );
  const rolesRes = await client.query(
    `select id, role_key from roles where role_key in ('super_admin','distributor','sales_executive')`
  );

  const groupByName = new Map(groupsRes.rows.map((r) => [r.group_name, r.id]));
  const roleByKey = new Map(rolesRes.rows.map((r) => [r.role_key, r.id]));

  if (!groupByName.get("SuperAdmin")) {
    const r = await client.query(
      `insert into user_groups (group_name, max_autonomous_discount_pct) values ('SuperAdmin', 100) returning id`
    );
    groupByName.set("SuperAdmin", r.rows[0].id);
  }

  if (!groupByName.get("Distributor")) {
    const r = await client.query(
      `insert into user_groups (group_name, max_autonomous_discount_pct) values ('Distributor', 15) returning id`
    );
    groupByName.set("Distributor", r.rows[0].id);
  }

  if (!groupByName.get("Staff")) {
    const r = await client.query(
      `insert into user_groups (group_name, max_autonomous_discount_pct) values ('Staff', 0) returning id`
    );
    groupByName.set("Staff", r.rows[0].id);
  }

  if (!roleByKey.get("sales_executive")) {
    const r = await client.query(
      `insert into roles (role_key, role_name) values ('sales_executive','Sales Executive') on conflict (role_key) do update set role_name = excluded.role_name returning id`
    );
    roleByKey.set("sales_executive", r.rows[0].id);
  }

  if (!roleByKey.get("distributor")) {
    const r = await client.query(
      `insert into roles (role_key, role_name) values ('distributor','Distributor') on conflict (role_key) do update set role_name = excluded.role_name returning id`
    );
    roleByKey.set("distributor", r.rows[0].id);
  }

  if (!roleByKey.get("super_admin")) {
    const r = await client.query(
      `insert into roles (role_key, role_name) values ('super_admin','SuperAdmin') on conflict (role_key) do update set role_name = excluded.role_name returning id`
    );
    roleByKey.set("super_admin", r.rows[0].id);
  }

  return { groupByName, roleByKey };
}

async function buildUserMaps(client, userMasterPath) {
  const text = fs.readFileSync(userMasterPath, "utf8");
  const data = rowsToObjects(parseCsv(text));

  const { groupByName, roleByKey } = await getCoreIds(client);

  const superAdminGroupId = groupByName.get("SuperAdmin");
  const distributorGroupId = groupByName.get("Distributor");
  const staffGroupId = groupByName.get("Staff");

  const superAdminRoleId = roleByKey.get("super_admin");
  const distributorRoleId = roleByKey.get("distributor");
  const salesExecRoleId = roleByKey.get("sales_executive");

  let created = 0;
  let updated = 0;
  let skipped = 0;

  const codeToEmail = new Map();

  for (const r of data) {
    const userCode = String(r.UserCode || "").trim();
    const email = String(r["Email ID"] || "").trim().toLowerCase();
    const active = String(r.Active || "").trim().toUpperCase();

    if (userCode) codeToEmail.set(userCode, email);
    if (!email || active !== "YES") {
      skipped += 1;
      continue;
    }

    const fullName = String(r.UserName || "").trim();
    const isSuperAdmin = String(r.SuperAdmin || "").trim().toUpperCase() === "YES";

    const isDistributor = userCode.startsWith("DT");
    const groupId = isSuperAdmin
      ? superAdminGroupId
      : isDistributor
        ? distributorGroupId
        : staffGroupId;

    const primaryRoleId = isSuperAdmin
      ? superAdminRoleId
      : isDistributor
        ? distributorRoleId
        : salesExecRoleId;

    const upsertRes = await client.query(
      `
        insert into erp_users (email, full_name, group_id, primary_role_id, is_active)
        values ($1,$2,$3,$4,true)
        on conflict (email) do update set
          full_name = excluded.full_name,
          group_id = excluded.group_id,
          primary_role_id = excluded.primary_role_id,
          is_active = true,
          updated_at = now()
        returning (xmax = 0) as inserted
      `,
      [email, fullName || null, groupId, primaryRoleId]
    );

    if (upsertRes.rows[0]?.inserted) created += 1;
    else updated += 1;

    await client.query(
      `
        insert into user_roles (user_id, role_id, is_primary)
        values (
          (select id from erp_users where email = $1),
          $2,
          true
        )
        on conflict (user_id, role_id) do update set is_primary = excluded.is_primary
      `,
      [email, primaryRoleId]
    );
  }

  const usersRes = await client.query(`select id, email from erp_users`);
  const emailToId = new Map(usersRes.rows.map((u) => [String(u.email).toLowerCase(), u.id]));

  return { codeToEmail, emailToId, stats: { created, updated, skipped } };
}

async function importCustomers(client, customerCsvPath) {
  const text = fs.readFileSync(customerCsvPath, "utf8");
  const data = rowsToObjects(parseCsv(text));

  let upserted = 0;
  let skipped = 0;

  for (const r of data) {
    const customerCode = String(r.CustomerCode || "").trim();
    const customerName = String(r.CustomerName || "").trim();
    if (!customerCode || !customerName) {
      skipped += 1;
      continue;
    }

    const active = String(r.Active || "").trim().toUpperCase() === "YES";

    const address1 = String(r.AddressLine1 || "").trim() || null;
    const address2 = String(r.AddressLine2 || "").trim() || null;
    const address3 = String(r.AddressLine3 || "").trim() || null;
    const city = String(r.CityName || "").trim() || null;
    const state = String(r.StateName || "").trim() || null;
    const pincode = String(r.PinCode || "").trim() || null;
    const phone = String(r.PhoneNo || "").trim() || null;
    const email = String(r["Email ID"] || "").trim().toLowerCase() || null;
    const gstin = String(r["GST IN"] || "").trim() || null;

    await client.query(
      `
        insert into customers (
          customer_code,
          customer_name,
          address_line1,
          address_line2,
          address_line3,
          city,
          state,
          pincode,
          phone,
          email,
          gstin,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
        on conflict (customer_code) do update set
          customer_name = excluded.customer_name,
          address_line1 = excluded.address_line1,
          address_line2 = excluded.address_line2,
          address_line3 = excluded.address_line3,
          city = excluded.city,
          state = excluded.state,
          pincode = excluded.pincode,
          phone = excluded.phone,
          email = excluded.email,
          gstin = excluded.gstin,
          is_active = excluded.is_active,
          updated_at = now()
      `,
      [
        customerCode,
        customerName,
        address1,
        address2,
        address3,
        city,
        state,
        pincode,
        phone,
        email,
        gstin,
        active,
      ]
    );

    upserted += 1;
  }

  return { upserted, skipped };
}

async function ensureLeadSource(client, sourceName, cache) {
  const name = String(sourceName || "").trim();
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);

  const baseCode = slugify(name) || "source";
  let code = baseCode;
  for (let i = 0; i < 20; i += 1) {
    const tryCode = i === 0 ? code : `${baseCode}_${i + 1}`;
    try {
      await client.query(
        `
          insert into lead_sources (source_code, source_name, is_active)
          values ($1,$2,true)
          on conflict (source_code) do update set source_name = excluded.source_name, is_active = true
        `,
        [tryCode, name]
      );

      const { rows } = await client.query(
        `select id from lead_sources where source_code = $1 limit 1`,
        [tryCode]
      );
      const id = rows[0]?.id || null;
      cache.set(name, id);
      return id;
    } catch (err) {
      if (i === 19) throw err;
    }
  }

  return null;
}

function chooseCompanyName(row) {
  const companyName = String(row.CompanyName || "").trim();
  if (companyName) return companyName;
  const contactName = String(row.ContactName || "").trim();
  if (contactName) return contactName;
  const email = String(row.EMail || "").trim();
  if (email) return email;
  const phone = String(row.MobileNo || "").trim();
  if (phone) return phone;
  return "Unknown";
}

function buildImportNotes(row) {
  const keys = [
    "LeadNo",
    "QuotationNo",
    "LeadManager",
    "Title",
    "ContactName",
    "City",
    "State",
    "Country",
    "MobileNo",
    "EMail",
    "LeadSource",
    "LeadDate",
    "FollowUpDate",
    "FollowUpRemarks",
    "FinalStatusRemarks",
    "Category",
    "Group",
    "Item",
    "Industry",
    "Requirement",
    "CreatedBy",
    "CreatedDate",
    "ModifiedBy",
    "ModifiedDate",
    "Status",
    "MailingStatus",
  ];

  const parts = [];
  for (const k of keys) {
    const v = String(row[k] || "").trim();
    if (v) parts.push(`${k}: ${v}`);
  }
  return parts.join("\n");
}

async function importLeads(client, leadsCsvPath, { codeToEmail, emailToId, superAdminId }) {
  const text = fs.readFileSync(leadsCsvPath, "utf8");
  const data = rowsToObjects(parseCsv(text));

  const sourceCache = new Map();

  let inserted = 0;
  let skipped = 0;
  let contactsCreated = 0;
  let activitiesCreated = 0;
  let assignmentsCreated = 0;

  for (const r of data) {
    const leadNo = String(r.LeadNo || "").trim();
    if (!leadNo) {
      skipped += 1;
      continue;
    }

    const existing = await client.query(`select id from leads where lead_number = $1`, [leadNo]);
    if (existing.rows[0]?.id) {
      skipped += 1;
      continue;
    }

    const companyName = chooseCompanyName(r);
    const status = String(r.Status || "").trim() || "new";

    const leadSourceId = await ensureLeadSource(client, r.LeadSource, sourceCache);

    const lm = parseLegacyActor(r.LeadManager);
    const cb = parseLegacyActor(r.CreatedBy);

    const assignedToEmail = lm?.code ? (codeToEmail.get(lm.code) || "") : "";
    const createdByEmail = cb?.code ? (codeToEmail.get(cb.code) || "") : "";

    const assignedToId =
      assignedToEmail && emailToId.get(String(assignedToEmail).toLowerCase())
        ? emailToId.get(String(assignedToEmail).toLowerCase())
        : null;
    const createdById =
      createdByEmail && emailToId.get(String(createdByEmail).toLowerCase())
        ? emailToId.get(String(createdByEmail).toLowerCase())
        : superAdminId;

    const leadDate = parseLegacyDate(r.LeadDate);
    const modifiedDate = parseLegacyDate(r.ModifiedDate);

    const leadRes = await client.query(
      `
        insert into leads (
          lead_number,
          company_name,
          lead_source_id,
          status,
          priority,
          assigned_to,
          created_by,
          created_at,
          updated_at
        )
        values ($1,$2,$3,$4,'medium',$5,$6,coalesce($7, now()),coalesce($8, coalesce($7, now())))
        returning id
      `,
      [
        leadNo,
        companyName,
        Number.isFinite(leadSourceId) ? leadSourceId : null,
        status,
        Number.isFinite(assignedToId) ? assignedToId : null,
        Number.isFinite(createdById) ? createdById : superAdminId,
        leadDate,
        modifiedDate,
      ]
    );

    const leadId = leadRes.rows[0].id;
    inserted += 1;

    const contactName = String(r.ContactName || "").trim();
    const contactEmail = String(r.EMail || "").trim().toLowerCase();
    const contactPhone = String(r.MobileNo || "").trim();

    const finalContactName =
      contactName || contactEmail || contactPhone ? contactName || contactEmail || contactPhone : "";

    if (finalContactName) {
      await client.query(
        `
          insert into lead_contacts (lead_id, full_name, email, phone, designation, is_primary)
          values ($1,$2,$3,$4,$5,true)
        `,
        [
          leadId,
          finalContactName,
          contactEmail || null,
          contactPhone || null,
          String(r.Title || "").trim() || null,
        ]
      );
      contactsCreated += 1;
    }

    const notes = buildImportNotes(r);
    await client.query(
      `
        insert into lead_activities (lead_id, activity_type, subject, notes, due_at, activity_at, created_by)
        values ($1,'note',$2,$3,$4,coalesce($5, now()),$6)
      `,
      [
        leadId,
        "Imported legacy lead data",
        notes || null,
        parseLegacyDate(r.FollowUpDate),
        leadDate,
        Number.isFinite(createdById) ? createdById : superAdminId,
      ]
    );
    activitiesCreated += 1;

    if (Number.isFinite(assignedToId)) {
      await client.query(
        `
          insert into lead_assignments (lead_id, assigned_to, assigned_by, assignment_reason, assigned_at)
          values ($1,$2,$3,$4,coalesce($5, now()))
        `,
        [
          leadId,
          assignedToId,
          Number.isFinite(createdById) ? createdById : superAdminId,
          "Imported from legacy LeadManager",
          leadDate,
        ]
      );
      assignmentsCreated += 1;
    }
  }

  return { inserted, skipped, contactsCreated, activitiesCreated, assignmentsCreated };
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const leadsCsv =
    process.argv[2] || path.join(repoRoot, "LeadEntryReport_16-Jun-2026.csv");
  const customersCsv =
    process.argv[3] || path.join(repoRoot, "CustomerMaster_16-Jun-2026.csv");
  const usersCsv =
    process.argv[4] || path.join(repoRoot, "UserMaster_16-Jun-2026.csv");

  for (const p of [leadsCsv, customersCsv, usersCsv]) {
    if (!fs.existsSync(p)) {
      process.stderr.write(`Missing file: ${p}\n`);
      process.exit(1);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const superAdminEmail = (process.env.SUPERADMIN_EMAIL || "amit.s@absstem.com")
      .trim()
      .toLowerCase();
    const superRes = await client.query(
      `select id from erp_users where email = $1 limit 1`,
      [superAdminEmail]
    );

    if (!superRes.rows[0]?.id) {
      process.stderr.write(
        `SuperAdmin user not found in erp_users for email: ${superAdminEmail}\n`
      );
      process.exit(1);
    }

    const superAdminId = superRes.rows[0].id;

    const userMaps = await buildUserMaps(client, usersCsv);
    const customerStats = await importCustomers(client, customersCsv);
    const leadStats = await importLeads(client, leadsCsv, {
      codeToEmail: userMaps.codeToEmail,
      emailToId: userMaps.emailToId,
      superAdminId,
    });

    await client.query("commit");

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          users: userMaps.stats,
          customers: customerStats,
          leads: leadStats,
        },
        null,
        2
      ) + "\n"
    );
  } catch (err) {
    await client.query("rollback");
    process.stderr.write(`${err?.stack || err}\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();

