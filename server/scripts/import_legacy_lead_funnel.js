const fs = require("fs");
const path = require("path");

require("dotenv").config();

const { pool } = require("../src/db/pool");

const FILE_CANDIDATES = {
  leads: ["LeadEntryReport_18-Jun-2026.csv", "Old Lead Reports.csv", "Old Lead Report.csv"],
  quotes: ["QuotationReport_18-Jun-2026.csv"],
  customers: ["CustomerMaster_16-Jun-2026.csv"],
  salesOrders: ["SalesOrderReport_18-Jun-2026.csv"],
  users: ["UserMaster_16-Jun-2026.csv"],
};

function parseArgs(argv) {
  const out = {
    folder: path.resolve(process.cwd()),
    batch: `legacy_lead_funnel_${new Date().toISOString().replace(/[:.]/g, "-")}`,
    apply: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      out.apply = true;
      continue;
    }
    if (token.startsWith("--folder=")) {
      out.folder = path.resolve(token.slice("--folder=".length));
      continue;
    }
    if (token === "--folder" && argv[i + 1]) {
      out.folder = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith("--batch=")) {
      out.batch = token.slice("--batch=".length).trim() || out.batch;
      continue;
    }
    if (token === "--batch" && argv[i + 1]) {
      out.batch = argv[i + 1].trim() || out.batch;
      i += 1;
    }
  }

  return out;
}

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
  const header = rows[0].map((h) => String(h || "").trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = String(r[i] || "").trim();
    return obj;
  });
}

function parseLegacyDate(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "01-Jan-1900") return null;

  const monthMap = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };

  const parts = raw.split(/\s+/).filter(Boolean);
  const datePart = parts[0];
  const timePart = parts[1] || "";
  const ampmPart = String(parts[2] || "").toUpperCase();
  const dm = datePart.split("-");
  if (dm.length !== 3) return null;

  const day = Number(dm[0]);
  const mon = monthMap[String(dm[1] || "").slice(0, 3).toUpperCase()];
  let year = Number(dm[2]);
  if (year < 100) year += 2000;
  if (!Number.isFinite(day) || !Number.isFinite(mon) || !Number.isFinite(year)) return null;

  let hour = 0;
  let minute = 0;
  let second = 0;

  if (timePart) {
    const t = timePart.split(":");
    hour = Number(t[0] || 0);
    minute = Number(t[1] || 0);
    second = Number((t[2] || "0").replace(/[^0-9]/g, "")) || 0;
    if (ampmPart === "PM" && hour < 12) hour += 12;
    if (ampmPart === "AM" && hour === 12) hour = 0;
  }

  const dt = new Date(Date.UTC(year, mon, day, hour, minute, second));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseLegacyActor(value) {
  const raw = String(value || "").trim();
  if (!raw) return { code: null, name: null, raw: "" };
  const idx = raw.indexOf(":");
  if (idx >= 0) {
    return {
      code: raw.slice(0, idx).trim().replace(/\s+/g, ""),
      name: raw.slice(idx + 1).trim() || null,
      raw,
    };
  }
  return { code: null, name: raw, raw };
}

function parseDisplayWithCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return { name: null, code: null, raw: "" };
  const match = raw.match(/^(.*?)(?:\s*:\s*([A-Z]\d+))?$/i);
  return {
    name: String(match?.[1] || raw).trim() || null,
    code: String(match?.[2] || "").trim() || null,
    raw,
  };
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function parseNumber(value) {
  const raw = String(value || "").replace(/,/g, "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readCsvObjects(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return rowsToObjects(parseCsv(text));
}

function resolveFile(folder, candidates) {
  for (const fileName of candidates) {
    const full = path.join(folder, fileName);
    if (fs.existsSync(full)) return full;
  }
  throw new Error(`Missing required CSV. Tried: ${candidates.join(", ")}`);
}

function chooseLatest(rows, dateKey) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  list.sort((a, b) => {
    const at = a?.[dateKey] ? new Date(a[dateKey]).getTime() : 0;
    const bt = b?.[dateKey] ? new Date(b[dateKey]).getTime() : 0;
    return bt - at;
  });
  return list[0] || null;
}

function quoteSuggestsWon(quoteRow) {
  const text = normalizeText(`${quoteRow?.statusRaw || ""} ${quoteRow?.finalRemarks || ""}`);
  return text.includes("converted to order") || text.includes("order received") || text.includes("won");
}

function mapLeadStatus(row, matchedQuote, matchedSalesOrder) {
  if (matchedSalesOrder) return "order_won";
  if (matchedQuote) return "quoted";

  const text = normalizeText(`${row.statusRaw || ""} ${row.finalStatusRemarks || ""}`);
  if (text.includes("spam")) return "spam";
  if (text.includes("duplicate")) return "duplicate";
  if (text.includes("follow up")) return "follow_up";
  if (text.includes("qualified") || text.includes("product inquiry")) return "qualified";
  if (text.includes("shelved") || text.includes("lost")) return "lost";
  if (text.includes("non product inquiry") || text.includes("not required")) return "closed_no_action";
  return "new";
}

function buildPriority(status) {
  if (status === "qualified" || status === "quoted") return "high";
  if (status === "follow_up") return "medium";
  return "low";
}

function pickLegacySalesOrder(quoteRow, ordersByCustomerCode, ordersByCustomerName) {
  if (!quoteRow || !quoteSuggestsWon(quoteRow)) return null;

  const candidates =
    (quoteRow.customerCode && ordersByCustomerCode.get(quoteRow.customerCode)) ||
    ordersByCustomerName.get(normalizeText(quoteRow.customerName)) ||
    [];

  if (!candidates.length) return null;

  const sameSalesPerson = candidates.filter(
    (row) => row.salespersonCode && quoteRow.salespersonCode && row.salespersonCode === quoteRow.salespersonCode
  );
  const usable = sameSalesPerson.length ? sameSalesPerson : candidates;
  const quoteTime = quoteRow.quotationDate ? new Date(quoteRow.quotationDate).getTime() : 0;

  const afterQuote = usable
    .filter((row) => row.soDate && new Date(row.soDate).getTime() >= quoteTime - 45 * 24 * 60 * 60 * 1000)
    .sort((a, b) => new Date(a.soDate).getTime() - new Date(b.soDate).getTime());

  const selected = afterQuote[0] || usable[0] || null;
  if (!selected) return null;

  return {
    row: selected,
    confidence: sameSalesPerson.length ? "legacy_order_customer_salesperson" : "legacy_order_customer",
  };
}

async function stageBatch(client, batchKey, folder, dryRun, parsed) {
  await client.query(
    `
      insert into legacy_import_batches (import_key, source_folder, dry_run, notes)
      values ($1,$2,$3,$4)
      on conflict (import_key) do update set
        source_folder = excluded.source_folder,
        dry_run = excluded.dry_run,
        notes = excluded.notes
    `,
    [batchKey, folder, dryRun, "Legacy lead funnel import"]
  );

  await client.query(`delete from legacy_users_staging where batch_key = $1`, [batchKey]);
  await client.query(`delete from legacy_customers_staging where batch_key = $1`, [batchKey]);
  await client.query(`delete from legacy_leads_staging where batch_key = $1`, [batchKey]);
  await client.query(`delete from legacy_quotes_staging where batch_key = $1`, [batchKey]);
  await client.query(`delete from legacy_sales_orders_staging where batch_key = $1`, [batchKey]);

  for (let i = 0; i < parsed.users.length; i += 1) {
    const row = parsed.users[i];
    await client.query(
      `
        insert into legacy_users_staging (
          batch_key, row_no, user_code, full_name, email, phone, user_group_name,
          reporting_head_1, reporting_head_2, organisation_name, active, super_admin, raw
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      `,
      [
        batchKey,
        i + 1,
        row.userCode,
        row.fullName,
        row.email,
        row.phone,
        row.userGroupName,
        row.reportingHead1,
        row.reportingHead2,
        row.organisationName,
        row.active,
        row.superAdmin,
        JSON.stringify(row.raw),
      ]
    );
  }

  for (let i = 0; i < parsed.customers.length; i += 1) {
    const row = parsed.customers[i];
    await client.query(
      `
        insert into legacy_customers_staging (
          batch_key, row_no, customer_code, customer_name, city_name, state_name,
          phone_no, email, active, account_manager, raw
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      `,
      [
        batchKey,
        i + 1,
        row.customerCode,
        row.customerName,
        row.cityName,
        row.stateName,
        row.phoneNo,
        row.email,
        row.active,
        row.accountManagerRaw,
        JSON.stringify(row.raw),
      ]
    );
  }

  for (let i = 0; i < parsed.leads.length; i += 1) {
    const row = parsed.leads[i];
    await client.query(
      `
        insert into legacy_leads_staging (
          batch_key, row_no, legacy_lead_no, legacy_quote_no, lead_manager_code, lead_manager_name,
          company_name, prospect_code, title, contact_name, city, state, country, mobile_no, email,
          lead_source_name, lead_date, follow_up_date, follow_up_remarks, final_status_remarks,
          category, group_name, item_name, industry, requirement, created_by_code, created_by_name,
          created_at_legacy, modified_by_code, modified_by_name, modified_at_legacy, status_raw,
          mailing_status, raw
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34::jsonb
        )
      `,
      [
        batchKey,
        i + 1,
        row.legacyLeadNo,
        row.legacyQuoteNo,
        row.leadManagerCode,
        row.leadManagerName,
        row.companyName,
        row.prospectCode,
        row.title,
        row.contactName,
        row.city,
        row.state,
        row.country,
        row.mobileNo,
        row.email,
        row.leadSourceName,
        row.leadDate,
        row.followUpDate,
        row.followUpRemarks,
        row.finalStatusRemarks,
        row.category,
        row.groupName,
        row.itemName,
        row.industry,
        row.requirement,
        row.createdByCode,
        row.createdByName,
        row.createdAtLegacy,
        row.modifiedByCode,
        row.modifiedByName,
        row.modifiedAtLegacy,
        row.statusRaw,
        row.mailingStatus,
        JSON.stringify(row.raw),
      ]
    );
  }

  for (let i = 0; i < parsed.quotes.length; i += 1) {
    const row = parsed.quotes[i];
    await client.query(
      `
        insert into legacy_quotes_staging (
          batch_key, row_no, quotation_no, legacy_lead_no, quotation_date, customer_name,
          customer_code, contact_person, contact_no, contact_email, salesperson_code,
          salesperson_name, group_name, quantity, subtotal, gst_rate, gst_amount,
          total_price, city, state, quotation_remarks, follow_up_date, follow_up_remarks,
          status_raw, final_remarks, raw
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,$25,$26::jsonb
        )
      `,
      [
        batchKey,
        i + 1,
        row.quotationNo,
        row.legacyLeadNo,
        row.quotationDate,
        row.customerName,
        row.customerCode,
        row.contactPerson,
        row.contactNo,
        row.contactEmail,
        row.salespersonCode,
        row.salespersonName,
        row.groupName,
        row.quantity,
        row.subtotal,
        row.gstRate,
        row.gstAmount,
        row.totalPrice,
        row.city,
        row.state,
        row.quotationRemarks,
        row.followUpDate,
        row.followUpRemarks,
        row.statusRaw,
        row.finalRemarks,
        JSON.stringify(row.raw),
      ]
    );
  }

  for (let i = 0; i < parsed.salesOrders.length; i += 1) {
    const row = parsed.salesOrders[i];
    await client.query(
      `
        insert into legacy_sales_orders_staging (
          batch_key, row_no, so_no, so_date, customer_name, customer_code,
          salesperson_code, salesperson_name, group_name, status_raw,
          so_remarks, city, state, job_no, raw
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      `,
      [
        batchKey,
        i + 1,
        row.soNo,
        row.soDate,
        row.customerName,
        row.customerCode,
        row.salespersonCode,
        row.salespersonName,
        row.groupName,
        row.statusRaw,
        row.soRemarks,
        row.city,
        row.state,
        row.jobNo,
        JSON.stringify(row.raw),
      ]
    );
  }
}

async function buildDbMaps(client) {
  const userRes = await client.query(`select id, email, full_name from erp_users`);
  const customerRes = await client.query(`select id, customer_code, customer_name from customers`);
  const sourceRes = await client.query(`select id, source_name from lead_sources`);
  const quoteRes = await client.query(
    `
      select
        qh.id as quote_id,
        qh.quote_number,
        qh.customer_id,
        qh.lead_id,
        qr.id as quote_revision_id,
        so.id as sales_order_id,
        so.so_number,
        so.order_date
      from quote_headers qh
      left join quote_revisions qr
        on qr.quote_id = qh.id
       and qr.is_latest = true
      left join sales_orders so
        on so.quote_revision_id = qr.id
    `
  );

  return {
    userByEmail: new Map(userRes.rows.map((r) => [normalizeEmail(r.email), r])),
    userByName: new Map(userRes.rows.map((r) => [normalizeText(r.full_name), r])),
    customerByCode: new Map(customerRes.rows.map((r) => [String(r.customer_code || "").trim(), r])),
    customerByName: new Map(customerRes.rows.map((r) => [normalizeText(r.customer_name), r])),
    sourceByName: new Map(sourceRes.rows.map((r) => [normalizeText(r.source_name), r.id])),
    quoteByNumber: new Map(quoteRes.rows.map((r) => [String(r.quote_number || "").trim(), r])),
  };
}

async function resolveLeadSourceId(client, cache, sourceName) {
  const key = normalizeText(sourceName);
  if (!key) return null;
  if (cache.sourceByName.has(key)) return cache.sourceByName.get(key);

  const code = key.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "legacy";
  const inserted = await client.query(
    `
      insert into lead_sources (source_code, source_name, is_active)
      values ($1,$2,true)
      on conflict (source_code) do update set source_name = excluded.source_name, is_active = true
      returning id
    `,
    [`legacy_${code}`, String(sourceName || "").trim()]
  );
  cache.sourceByName.set(key, inserted.rows[0].id);
  return inserted.rows[0].id;
}

async function insertActivityIfMissing(client, leadId, activityType, subject, notes, activityAt, createdBy) {
  const existing = await client.query(
    `
      select id
      from lead_activities
      where lead_id = $1
        and activity_type = $2
        and subject = $3
        and coalesce(notes, '') = coalesce($4, '')
        and coalesce(activity_at, timestamptz '1970-01-01') = coalesce($5, timestamptz '1970-01-01')
      limit 1
    `,
    [leadId, activityType, subject, notes || null, activityAt || null]
  );
  if (existing.rows.length) return false;

  await client.query(
    `
      insert into lead_activities (lead_id, activity_type, subject, notes, activity_at, created_by)
      values ($1,$2,$3,$4,$5,$6)
    `,
    [leadId, activityType, subject, notes || null, activityAt || null, createdBy || null]
  );
  return true;
}

async function upsertPrimaryContact(client, leadId, row) {
  const fullName = row.contactName || row.companyName || null;
  const email = row.email || null;
  const phone = row.mobileNo || null;
  if (!fullName && !email && !phone) return false;

  const existing = await client.query(
    `
      select id
      from lead_contacts
      where lead_id = $1
        and coalesce(lower(full_name), '') = coalesce(lower($2), '')
        and coalesce(lower(email), '') = coalesce(lower($3), '')
        and coalesce(phone, '') = coalesce($4, '')
      limit 1
    `,
    [leadId, fullName || "", email || "", phone || ""]
  );
  if (existing.rows.length) return false;

  const primaryCheck = await client.query(`select 1 from lead_contacts where lead_id = $1 and is_primary = true limit 1`, [leadId]);
  await client.query(
    `
      insert into lead_contacts (lead_id, full_name, email, phone, designation, is_primary)
      values ($1,$2,$3,$4,$5,$6)
    `,
    [leadId, fullName || "Legacy Contact", email, phone, row.title || null, primaryCheck.rows.length === 0]
  );
  return true;
}

function loadAndNormalize(folder) {
  const leadsFile = resolveFile(folder, FILE_CANDIDATES.leads);
  const quotesFile = resolveFile(folder, FILE_CANDIDATES.quotes);
  const customersFile = resolveFile(folder, FILE_CANDIDATES.customers);
  const salesOrdersFile = resolveFile(folder, FILE_CANDIDATES.salesOrders);
  const usersFile = resolveFile(folder, FILE_CANDIDATES.users);

  const userRows = readCsvObjects(usersFile).map((raw) => ({
    raw,
    userCode: String(raw.UserCode || "").trim(),
    fullName: String(raw.UserName || "").trim(),
    email: normalizeEmail(raw["Email ID"]),
    phone: normalizePhone(raw.Phone),
    userGroupName: String(raw.UserGroupName || "").trim(),
    reportingHead1: String(raw.ReportingHead1 || "").trim(),
    reportingHead2: String(raw.ReportingHead2 || "").trim(),
    organisationName: String(raw["Organisation Name"] || "").trim(),
    active: String(raw.Active || "").trim(),
    superAdmin: String(raw.SuperAdmin || "").trim(),
  }));

  const customerRows = readCsvObjects(customersFile).map((raw) => ({
    raw,
    customerCode: String(raw.CustomerCode || "").trim(),
    customerName: String(raw.CustomerName || "").trim(),
    cityName: String(raw.CityName || "").trim(),
    stateName: String(raw.StateName || "").trim(),
    phoneNo: normalizePhone(raw.PhoneNo),
    email: normalizeEmail(raw["Email ID"]),
    active: String(raw.Active || "").trim(),
    accountManagerRaw: String(raw.AccountManager || "").trim(),
  }));

  const leadRows = readCsvObjects(leadsFile)
    .map((raw) => {
      const leadManager = parseLegacyActor(raw.LeadManager);
      const createdBy = parseLegacyActor(raw.CreatedBy);
      const modifiedBy = parseLegacyActor(raw.ModifiedBy);
      const company = parseDisplayWithCode(raw.CompanyName);
      return {
        raw,
        legacyLeadNo: String(raw.LeadNo || "").trim(),
        legacyQuoteNo: String(raw.QuotationNo || "").trim(),
        leadManagerCode: leadManager.code,
        leadManagerName: leadManager.name,
        companyName: company.name,
        prospectCode: company.code,
        title: String(raw.Title || "").trim() || null,
        contactName: String(raw.ContactName || "").trim() || null,
        city: String(raw.City || "").trim() || null,
        state: String(raw.State || "").trim() || null,
        country: String(raw.Country || "").trim() || null,
        mobileNo: normalizePhone(raw.MobileNo),
        email: normalizeEmail(raw.EMail),
        leadSourceName: String(raw.LeadSource || "").trim() || null,
        leadDate: parseLegacyDate(raw.LeadDate),
        followUpDate: parseLegacyDate(raw.FollowUpDate),
        followUpRemarks: String(raw.FollowUpRemarks || "").trim() || null,
        finalStatusRemarks: String(raw.FinalStatusRemarks || "").trim() || null,
        category: String(raw.Category || "").trim() || null,
        groupName: String(raw.Group || "").trim() || null,
        itemName: String(raw.Item || raw.ItemCode || "").trim() || null,
        industry: String(raw.Industry || "").trim() || null,
        requirement: String(raw.Requirement || "").trim() || null,
        createdByCode: createdBy.code,
        createdByName: createdBy.name,
        createdAtLegacy: parseLegacyDate(raw.CreatedDate),
        modifiedByCode: modifiedBy.code,
        modifiedByName: modifiedBy.name,
        modifiedAtLegacy: parseLegacyDate(raw.ModifiedDate),
        statusRaw: String(raw.Status || "").trim() || null,
        mailingStatus: String(raw.MailingStatus || "").trim() || null,
      };
    })
    .filter((row) => row.legacyLeadNo);

  const quoteRows = readCsvObjects(quotesFile).map((raw) => {
    const customer = parseDisplayWithCode(raw.Customer);
    const salesperson = parseLegacyActor(raw.SalesPerson);
    return {
      raw,
      quotationNo: String(raw.QuotationNo || "").trim(),
      legacyLeadNo: String(raw.LeadNo || "").trim() || null,
      quotationDate: parseLegacyDate(raw.QuotationDate),
      customerName: customer.name,
      customerCode: customer.code,
      contactPerson: String(raw.ContactPerson || "").trim() || null,
      contactNo: normalizePhone(raw.ContactNo),
      contactEmail: normalizeEmail(raw.ContactEMail),
      salespersonCode: salesperson.code,
      salespersonName: salesperson.name,
      groupName: String(raw.Group || "").trim() || null,
      quantity: parseNumber(raw.Quantity),
      subtotal: parseNumber(raw.SubTotal),
      gstRate: parseNumber(raw.GSTRate),
      gstAmount: parseNumber(raw.GSTAmount),
      totalPrice: parseNumber(raw.TotalPrice),
      city: String(raw.City || "").trim() || null,
      state: String(raw.State || "").trim() || null,
      quotationRemarks: String(raw.QuotationRemarks || "").trim() || null,
      followUpDate: parseLegacyDate(raw.FollowUpDate),
      followUpRemarks: String(raw.FollowupRemarks || "").trim() || null,
      statusRaw: String(raw.Status || "").trim() || null,
      finalRemarks: String(raw.FinalRemarks || "").trim() || null,
    };
  });

  const salesOrderRows = readCsvObjects(salesOrdersFile).map((raw) => {
    const customer = parseDisplayWithCode(raw.Customer);
    const salesperson = parseLegacyActor(raw.SalesPerson);
    return {
      raw,
      soNo: String(raw["SO No"] || "").trim(),
      soDate: parseLegacyDate(raw["SO Date"]),
      customerName: customer.name,
      customerCode: customer.code,
      salespersonCode: salesperson.code,
      salespersonName: salesperson.name,
      groupName: String(raw.Group || "").trim() || null,
      statusRaw: String(raw.Status || "").trim() || null,
      soRemarks: String(raw.SORemarks || "").trim() || null,
      city: String(raw.City || "").trim() || null,
      state: String(raw.State || "").trim() || null,
      jobNo: String(raw.JobNo || "").trim() || null,
    };
  });

  return {
    files: { leadsFile, quotesFile, customersFile, salesOrdersFile, usersFile },
    users: userRows,
    customers: customerRows,
    leads: leadRows,
    quotes: quoteRows,
    salesOrders: salesOrderRows,
  };
}

async function applyImport(client, batchKey, parsed) {
  const db = await buildDbMaps(client);

  const legacyUserIdByCode = new Map();
  for (const row of parsed.users) {
    const byEmail = row.email ? db.userByEmail.get(row.email) : null;
    const byName = row.fullName ? db.userByName.get(normalizeText(row.fullName)) : null;
    const resolved = byEmail || byName || null;
    if (row.userCode && resolved) legacyUserIdByCode.set(row.userCode, resolved.id);
  }

  const quotesByLeadNo = new Map();
  const quotesByQuoteNo = new Map();
  for (const row of parsed.quotes) {
    if (row.legacyLeadNo) {
      const list = quotesByLeadNo.get(row.legacyLeadNo) || [];
      list.push(row);
      quotesByLeadNo.set(row.legacyLeadNo, list);
    }
    if (row.quotationNo) quotesByQuoteNo.set(row.quotationNo, row);
  }

  const ordersByCustomerCode = new Map();
  const ordersByCustomerName = new Map();
  for (const row of parsed.salesOrders) {
    if (row.customerCode) {
      const list = ordersByCustomerCode.get(row.customerCode) || [];
      list.push(row);
      ordersByCustomerCode.set(row.customerCode, list);
    }
    const nameKey = normalizeText(row.customerName);
    if (nameKey) {
      const list = ordersByCustomerName.get(nameKey) || [];
      list.push(row);
      ordersByCustomerName.set(nameKey, list);
    }
  }

  const summary = {
    created: 0,
    updated: 0,
    quoteLinksApplied: 0,
    quoteLinkConflicts: 0,
    contactsInserted: 0,
    activitiesInserted: 0,
    exactLeadQuoteMatches: 0,
    explicitLeadQuoteMatches: 0,
    wonMatches: 0,
    byStatus: {},
  };

  for (const row of parsed.leads) {
    const matchedByLeadNo = chooseLatest(quotesByLeadNo.get(row.legacyLeadNo), "quotationDate");
    const matchedByQuoteNo = row.legacyQuoteNo ? quotesByQuoteNo.get(row.legacyQuoteNo) || null : null;
    const matchedQuote = matchedByLeadNo || matchedByQuoteNo || null;
    if (matchedByLeadNo) summary.exactLeadQuoteMatches += 1;
    else if (matchedByQuoteNo) summary.explicitLeadQuoteMatches += 1;

    const legacyOrder = pickLegacySalesOrder(matchedQuote, ordersByCustomerCode, ordersByCustomerName);
    if (legacyOrder) summary.wonMatches += 1;

    const dbQuote = matchedQuote?.quotationNo ? db.quoteByNumber.get(matchedQuote.quotationNo) || null : null;
    const matchedStatus = mapLeadStatus(row, matchedQuote, legacyOrder || dbQuote?.sales_order_id);
    summary.byStatus[matchedStatus] = (summary.byStatus[matchedStatus] || 0) + 1;

    const sourceId = await resolveLeadSourceId(client, db, row.leadSourceName);
    const assignedTo = row.leadManagerCode ? legacyUserIdByCode.get(row.leadManagerCode) || null : null;
    const createdBy =
      (row.createdByCode && legacyUserIdByCode.get(row.createdByCode)) ||
      assignedTo ||
      null;

    const customerFromQuote = matchedQuote?.customerCode ? db.customerByCode.get(matchedQuote.customerCode) || null : null;
    const customerFromName =
      !customerFromQuote && matchedQuote?.customerName
        ? db.customerByName.get(normalizeText(matchedQuote.customerName)) || null
        : null;
    const resolvedCustomer = customerFromQuote || customerFromName || null;

    const convertedSalesOrderId = dbQuote?.sales_order_id || null;
    const convertedToOrderAt = dbQuote?.order_date || null;
    const legacyMatchConfidence = matchedByLeadNo
      ? "exact_lead_no"
      : matchedByQuoteNo
        ? "lead_quote_no"
        : legacyOrder
          ? legacyOrder.confidence
          : "open_unmatched";

    const payload = {
      lead_number: row.legacyLeadNo,
      company_name: row.companyName || row.contactName || "Legacy Lead",
      lead_source_id: sourceId,
      customer_id: resolvedCustomer?.id || dbQuote?.customer_id || null,
      status: matchedStatus,
      priority: buildPriority(matchedStatus),
      assigned_to: assignedTo,
      created_by: createdBy,
      legacy_lead_no: row.legacyLeadNo,
      legacy_quote_no: matchedQuote?.quotationNo || row.legacyQuoteNo || null,
      legacy_sales_order_no: legacyOrder?.row?.soNo || null,
      legacy_customer_code: matchedQuote?.customerCode || null,
      legacy_status_raw: row.statusRaw || null,
      legacy_owner_raw: row.leadManagerName || null,
      legacy_follow_up_at: row.followUpDate,
      legacy_created_at: row.createdAtLegacy || row.leadDate,
      legacy_updated_at: row.modifiedAtLegacy || null,
      legacy_import_batch: batchKey,
      legacy_match_confidence: legacyMatchConfidence,
      close_reason: row.finalStatusRemarks || matchedQuote?.finalRemarks || null,
      converted_quote_id: dbQuote?.quote_id || null,
      converted_to_quote_at: dbQuote?.quote_id ? row.leadDate || row.createdAtLegacy || new Date() : null,
      converted_customer_id: resolvedCustomer?.id || dbQuote?.customer_id || null,
      converted_sales_order_id: convertedSalesOrderId,
      converted_to_order_at: convertedToOrderAt,
    };

    const updateExistingLead = async (leadId) => {
      const r = await client.query(
        `
          update leads
          set
            company_name = $2,
            lead_source_id = $3,
            customer_id = coalesce($4, customer_id),
            status = $5,
            priority = $6,
            assigned_to = coalesce($7, assigned_to),
            created_by = coalesce(created_by, $8),
            updated_at = now(),
            legacy_lead_no = coalesce(legacy_lead_no, $9),
            legacy_quote_no = $10,
            legacy_sales_order_no = $11,
            legacy_customer_code = $12,
            legacy_status_raw = $13,
            legacy_owner_raw = $14,
            legacy_follow_up_at = $15,
            legacy_created_at = coalesce(legacy_created_at, $16),
            legacy_updated_at = coalesce($17, legacy_updated_at),
            legacy_import_batch = $18,
            legacy_match_confidence = $19,
            close_reason = $20,
            converted_quote_id = coalesce($21, converted_quote_id),
            converted_to_quote_at = coalesce($22, converted_to_quote_at),
            converted_customer_id = coalesce($23, converted_customer_id),
            converted_sales_order_id = coalesce($24, converted_sales_order_id),
            converted_to_order_at = coalesce($25, converted_to_order_at)
          where id = $1
          returning id
        `,
        [
          leadId,
          payload.company_name,
          payload.lead_source_id,
          payload.customer_id,
          payload.status,
          payload.priority,
          payload.assigned_to,
          payload.created_by,
          payload.legacy_lead_no,
          payload.legacy_quote_no,
          payload.legacy_sales_order_no,
          payload.legacy_customer_code,
          payload.legacy_status_raw,
          payload.legacy_owner_raw,
          payload.legacy_follow_up_at,
          payload.legacy_created_at,
          payload.legacy_updated_at,
          payload.legacy_import_batch,
          payload.legacy_match_confidence,
          payload.close_reason,
          payload.converted_quote_id,
          payload.converted_to_quote_at,
          payload.converted_customer_id,
          payload.converted_sales_order_id,
          payload.converted_to_order_at,
        ]
      );
      return r.rows[0] || null;
    };

    let lead = null;
    let inserted = false;

    const existingByLegacy = await client.query(
      `select id from leads where legacy_lead_no = $1 limit 1`,
      [payload.legacy_lead_no]
    );
    if (existingByLegacy.rows.length) {
      lead = await updateExistingLead(existingByLegacy.rows[0].id);
    } else {
      const existingByNumber = await client.query(
        `select id from leads where lead_number = $1 limit 1`,
        [payload.lead_number]
      );
      if (existingByNumber.rows.length) {
        lead = await updateExistingLead(existingByNumber.rows[0].id);
      } else {
        const insertRes = await client.query(
          `
            insert into leads (
              lead_number,
              company_name,
              lead_source_id,
              customer_id,
              status,
              priority,
              assigned_to,
              created_by,
              legacy_lead_no,
              legacy_quote_no,
              legacy_sales_order_no,
              legacy_customer_code,
              legacy_status_raw,
              legacy_owner_raw,
              legacy_follow_up_at,
              legacy_created_at,
              legacy_updated_at,
              legacy_import_batch,
              legacy_match_confidence,
              close_reason,
              converted_quote_id,
              converted_to_quote_at,
              converted_customer_id,
              converted_sales_order_id,
              converted_to_order_at
            )
            values (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
            )
            returning id
          `,
          [
            payload.lead_number,
            payload.company_name,
            payload.lead_source_id,
            payload.customer_id,
            payload.status,
            payload.priority,
            payload.assigned_to,
            payload.created_by,
            payload.legacy_lead_no,
            payload.legacy_quote_no,
            payload.legacy_sales_order_no,
            payload.legacy_customer_code,
            payload.legacy_status_raw,
            payload.legacy_owner_raw,
            payload.legacy_follow_up_at,
            payload.legacy_created_at,
            payload.legacy_updated_at,
            payload.legacy_import_batch,
            payload.legacy_match_confidence,
            payload.close_reason,
            payload.converted_quote_id,
            payload.converted_to_quote_at,
            payload.converted_customer_id,
            payload.converted_sales_order_id,
            payload.converted_to_order_at,
          ]
        );
        lead = insertRes.rows[0] || null;
        inserted = Boolean(lead);
      }
    }

    if (inserted) summary.created += 1;
    else summary.updated += 1;

    if (await upsertPrimaryContact(client, lead.id, row)) summary.contactsInserted += 1;

    if (row.followUpRemarks) {
      const inserted = await insertActivityIfMissing(
        client,
        lead.id,
        "legacy_follow_up",
        "Legacy follow-up",
        row.followUpRemarks,
        row.followUpDate || row.modifiedAtLegacy || row.createdAtLegacy || row.leadDate || null,
        createdBy
      );
      if (inserted) summary.activitiesInserted += 1;
    }

    if (row.finalStatusRemarks) {
      const inserted = await insertActivityIfMissing(
        client,
        lead.id,
        "legacy_status_note",
        "Legacy status note",
        row.finalStatusRemarks,
        row.modifiedAtLegacy || row.createdAtLegacy || row.leadDate || null,
        createdBy
      );
      if (inserted) summary.activitiesInserted += 1;
    }

    if (matchedQuote) {
      const note = [
        `Legacy quote ${matchedQuote.quotationNo}`,
        matchedQuote.customerCode ? `Customer ${matchedQuote.customerCode}` : null,
        matchedQuote.statusRaw ? `Status ${matchedQuote.statusRaw}` : null,
        matchedQuote.finalRemarks ? `Final ${matchedQuote.finalRemarks}` : null,
      ]
        .filter(Boolean)
        .join(" | ");

      const inserted = await insertActivityIfMissing(
        client,
        lead.id,
        "legacy_quote_match",
        "Legacy quote linkage",
        note,
        matchedQuote.quotationDate || row.modifiedAtLegacy || row.createdAtLegacy || null,
        createdBy
      );
      if (inserted) summary.activitiesInserted += 1;
    }

    if (dbQuote) {
      const link = await client.query(
        `
          update quote_headers
          set lead_id = $2
          where id = $1
            and (lead_id is null or lead_id = $2)
          returning id
        `,
        [dbQuote.quote_id, lead.id]
      );
      if (link.rows.length) summary.quoteLinksApplied += 1;
      else if (dbQuote.lead_id && Number(dbQuote.lead_id) !== Number(lead.id)) summary.quoteLinkConflicts += 1;
    }
  }

  await client.query(`update legacy_import_batches set applied_at = now(), dry_run = false where import_key = $1`, [batchKey]);
  return summary;
}

function printSummary(parsed, summary, apply, batchKey, files) {
  console.log("");
  console.log(`Batch: ${batchKey}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Lead file: ${files.leadsFile}`);
  console.log(`Quote file: ${files.quotesFile}`);
  console.log(`Customer file: ${files.customersFile}`);
  console.log(`Sales order file: ${files.salesOrdersFile}`);
  console.log(`User file: ${files.usersFile}`);
  console.log("");
  console.log("Staged rows:");
  console.log(`  Leads: ${parsed.leads.length}`);
  console.log(`  Quotes: ${parsed.quotes.length}`);
  console.log(`  Customers: ${parsed.customers.length}`);
  console.log(`  Sales Orders: ${parsed.salesOrders.length}`);
  console.log(`  Users: ${parsed.users.length}`);
  console.log("");
  if (!summary) return;
  console.log("Apply summary:");
  console.log(`  Leads created: ${summary.created}`);
  console.log(`  Leads updated: ${summary.updated}`);
  console.log(`  Quote links applied: ${summary.quoteLinksApplied}`);
  console.log(`  Quote link conflicts: ${summary.quoteLinkConflicts}`);
  console.log(`  Contacts inserted: ${summary.contactsInserted}`);
  console.log(`  Activities inserted: ${summary.activitiesInserted}`);
  console.log(`  Exact LeadNo -> Quote matches: ${summary.exactLeadQuoteMatches}`);
  console.log(`  Lead QuoteNo -> Quote matches: ${summary.explicitLeadQuoteMatches}`);
  console.log(`  Won matches: ${summary.wonMatches}`);
  console.log("  Status totals:");
  for (const [status, count] of Object.entries(summary.byStatus).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`    ${status}: ${count}`);
  }
  console.log("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const parsed = loadAndNormalize(args.folder);
  const client = await pool.connect();

  try {
    await client.query("begin");
    await stageBatch(client, args.batch, args.folder, !args.apply, parsed);

    let summary = null;
    if (args.apply) summary = await applyImport(client, args.batch, parsed);

    await client.query("commit");
    printSummary(parsed, summary, args.apply, args.batch, parsed.files);
  } catch (err) {
    await client.query("rollback");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
