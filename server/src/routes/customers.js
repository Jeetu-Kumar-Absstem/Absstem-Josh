const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const {
  buildCustomerCompanyScopeSql,
  ensureCustomerCompanyAccess,
  getActiveCompanyId,
  linkCustomerToCompany,
  requireResolvedCompanyId,
} = require("../services/customerCompanyAccess");
const { createCustomerFromParty } = require("../services/createCustomerFromParty");
const { notifyCreditHoldSet } = require("../services/notifications");

const router = express.Router();

const CONTACT_ROLE_KEYS = [
  "sales_enquiry",
  "quote_recipient",
  "technical_discussion",
  "dispatch_logistics",
  "invoice_recipient",
  "payment_followup",
  "service_warranty",
];

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function isAdminGroup(groupName) {
  const g = String(groupName || "").trim().toLowerCase();
  return g === "admin" || g === "superadmin" || g === "super admin";
}

function parseCleanupAllowlist() {
  const raw = String(process.env.CUSTOMER_MERGE_ALLOWLIST || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function canTemporarilyMergeCustomers(user) {
  if (!user) return false;
  if (isAdminGroup(user.group_name)) return true;

  const allowlist = parseCleanupAllowlist();
  if (!allowlist.length) return false;

  const email = String(user.email || "").trim().toLowerCase();
  const userId = String(user.id || "").trim();

  return allowlist.some((entry) => {
    const value = String(entry || "").trim();
    if (!value) return false;
    if (/^\d+$/.test(value) && userId) return value === userId;
    return value.toLowerCase() === email;
  });
}

function requireCustomerAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (!canTemporarilyMergeCustomers(req.user)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  return next();
}

function respondKnownCustomerError(res, err, fallbackStatus = 500, fallbackCode = "CUSTOMER_REQUEST_FAILED") {
  const message = String(err?.message || "");
  if (message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
  if (message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  if (message === "CUSTOMER_NOT_ALLOWED") return res.status(403).json({ ok: false, error: "CUSTOMER_NOT_ALLOWED" });
  if (message === "CUSTOMER_NOT_FOUND") return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });
  if (message === "COMPANY_NOT_SELECTED") return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
  if (err?.status) return res.status(err.status).json({ ok: false, error: message || fallbackCode });
  return res.status(fallbackStatus).json({ ok: false, error: fallbackCode });
}

function cleanNullableText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function cleanNullableEmail(value) {
  const text = cleanNullableText(value);
  return text ? text.toLowerCase() : null;
}

function cleanNullableDate(value) {
  const text = cleanNullableText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function cleanNullableAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function normalizeCreditControlMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["warning", "soft_block", "hard_block"].includes(mode) ? mode : "warning";
}

function normalizeSiteType(value) {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["plant", "ho", "branch", "warehouse", "billing_office"].includes(type) ? type : "plant";
}

function normalizeGstStatus(value) {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["pending", "available", "not_required"].includes(status) ? status : "pending";
}

function normalizeRoleKeys(value) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map((item) => String(item || "").trim().toLowerCase()).filter((item) => CONTACT_ROLE_KEYS.includes(item)))];
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeLooseBoolean(value, defaultValue = false) {
  if (value === null || value === undefined || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(raw)) return true;
  if (["false", "no", "n", "0"].includes(raw)) return false;
  return defaultValue;
}

function emailDomain(value) {
  return String(value || "").trim().toLowerCase().split("@")[1] || "";
}

const GENERIC_EMAIL_ROOTS = new Set(["gmail", "outlook", "hotmail", "yahoo", "icloud", "rediffmail"]);

function websiteDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const withoutProtocol = raw.replace(/^https?:\/\//i, "");
  const host = withoutProtocol.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  return host.replace(/^www\./, "");
}

function domainRoot(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (!domain) return "";
  const bare = domain.replace(/\.(com|in|co\.in|net|org|biz|co)$/i, "");
  return bare.split(".").slice(-1)[0] || "";
}

function isGenericEmailDomain(value) {
  const root = domainRoot(value);
  return Boolean(root && GENERIC_EMAIL_ROOTS.has(root));
}

function collectWebsiteDomains(payload) {
  return [...new Set([websiteDomain(payload?.website)].filter(Boolean))];
}

async function getDistributorIdForUser(userId) {
  const { rows } = await pool.query(`select distributor_id from user_distributor_links where user_id = $1 limit 1`, [userId]);
  return rows[0]?.distributor_id || null;
}

async function getDistributorScope(req) {
  const isDistributor = req.user.group_name === "Distributor";
  const distributorId = isDistributor ? await getDistributorIdForUser(req.user.id) : null;
  if (isDistributor && !distributorId) {
    const err = new Error("DISTRIBUTOR_NOT_LINKED");
    err.status = 400;
    throw err;
  }
  return { isDistributor, distributorId };
}

async function ensureCustomerVisible(client, req, customerId) {
  await ensureCustomerCompanyAccess(client, req, customerId);
  const { isDistributor, distributorId } = await getDistributorScope(req);
  if (!isDistributor) return;
  const linkRes = await client.query(
    `
      select 1
      from customer_distributor_links
      where customer_id = $1 and distributor_id = $2
      limit 1
    `,
    [customerId, distributorId]
  );
  if (!linkRes.rows.length) {
    const err = new Error("FORBIDDEN");
    err.status = 403;
    throw err;
  }
}

function isPositiveId(value) {
  if (value === null || value === undefined || value === "") return false;
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

function allowCustomerKeyChange(req, body) {
  return req.user?.group_name === "SuperAdmin" && body?.allow_key_change === true;
}

function normalizedCustomerCode(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizedCustomerGstin(value) {
  return String(value ?? "").trim().toUpperCase();
}

function customerPayload(body) {
  return {
    customer_name: typeof body?.customer_name === "string" ? body.customer_name.trim() : "",
    customer_code: cleanNullableText(body?.customer_code),
    legal_name: cleanNullableText(body?.legal_name),
    website: cleanNullableText(body?.website),
    industry: cleanNullableText(body?.industry),
    email: cleanNullableEmail(body?.email),
    phone: cleanNullableText(body?.phone),
    city: cleanNullableText(body?.city),
    state: cleanNullableText(body?.state),
    gstin: cleanNullableText(body?.gstin),
    fax: cleanNullableText(body?.fax),
    tinno: cleanNullableText(body?.tinno),
    pan: cleanNullableText(body?.pan),
    customer_type: cleanNullableText(body?.customer_type),
    account_manager: cleanNullableText(body?.account_manager),
    invoice_no: cleanNullableText(body?.invoice_no),
    invoice_date: cleanNullableDate(body?.invoice_date),
    in_case_of_hospital: normalizeLooseBoolean(body?.in_case_of_hospital, false),
    address_line1: cleanNullableText(body?.address_line1),
    address_line2: cleanNullableText(body?.address_line2),
    address_line3: cleanNullableText(body?.address_line3),
    pincode: cleanNullableText(body?.pincode),
    country_id: body?.country_id === null || body?.country_id === "" ? null : Number(body?.country_id),
    credit_limit: cleanNullableAmount(body?.credit_limit),
    credit_control_mode: normalizeCreditControlMode(body?.credit_control_mode),
    is_credit_hold: body?.is_credit_hold === true,
    credit_hold_reason: cleanNullableText(body?.credit_hold_reason),
    is_active: body?.is_active !== false,
  };
}

function contactPayload(body) {
  return {
    salutation: cleanNullableText(body?.salutation),
    full_name: cleanNullableText(body?.full_name),
    email: cleanNullableEmail(body?.email),
    phone: cleanNullableText(body?.phone),
    designation: cleanNullableText(body?.designation),
    department: cleanNullableText(body?.department),
    site_id: body?.site_id === null || body?.site_id === "" ? null : Number(body?.site_id),
    is_primary: body?.is_primary === true,
    is_active: body?.is_active !== false,
    roles: normalizeRoleKeys(body?.roles),
  };
}

function sitePayload(body) {
  return {
    site_code: cleanNullableText(body?.site_code),
    site_name: cleanNullableText(body?.site_name),
    site_type: normalizeSiteType(body?.site_type),
    address_line1: cleanNullableText(body?.address_line1),
    address_line2: cleanNullableText(body?.address_line2),
    address_line3: cleanNullableText(body?.address_line3),
    city: cleanNullableText(body?.city),
    state: cleanNullableText(body?.state),
    pincode: cleanNullableText(body?.pincode),
    country_id: body?.country_id === null || body?.country_id === "" ? null : Number(body?.country_id),
    gst_status: normalizeGstStatus(body?.gst_status),
    can_quote: body?.can_quote !== false,
    can_dispatch: body?.can_dispatch !== false,
    can_bill: body?.can_bill !== false,
    is_default_quote_site: body?.is_default_quote_site === true,
    is_default_ship_to: body?.is_default_ship_to === true,
    is_default_bill_to: body?.is_default_bill_to === true,
    is_active: body?.is_active !== false,
    tax_registration_id: body?.tax_registration_id === null || body?.tax_registration_id === "" ? null : Number(body?.tax_registration_id),
  };
}

function taxRegistrationPayload(body) {
  return {
    state: cleanNullableText(body?.state),
    gstin: cleanNullableText(body?.gstin),
    registration_name: cleanNullableText(body?.registration_name),
    is_active: body?.is_active !== false,
  };
}

function buildNameNeedle(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name) return "";
  const words = name.split(/\s+/).filter((word) => word.length >= 3);
  return (words[0] || name).slice(0, 40);
}

function normalizeCompanyName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(private|pvt|limited|ltd|llp|llc|inc|incorporated|corp|corporation|company|co)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Identifying signals for duplicate checks only — does not alter write payloads. */
function duplicateSignalPayload(body) {
  const base = customerPayload(body);
  const contactEmail = cleanNullableEmail(body?.contact_email) || base.email;
  const contactPhone = cleanNullableText(body?.contact_phone) || base.phone;
  const contactName = cleanNullableText(body?.contact_name) || cleanNullableText(body?.full_name);
  return {
    ...base,
    contact_email: contactEmail || null,
    contact_phone: contactPhone || null,
    contact_name: contactName || null,
  };
}

function duplicateReasons(row, payload) {
  const reasons = [];
  if (payload.gstin && row.match_gstin) reasons.push("GSTIN match");
  if (payload.gstin && row.match_site_gstin) reasons.push("Tax registration GSTIN match");
  if (payload.customer_code && row.match_code) reasons.push("Customer code match");
  if (payload.pan && row.match_pan) reasons.push("PAN match");
  if (payload.email && row.match_email) reasons.push("Email match");
  if (payload.email && row.match_email_domain) reasons.push("Email domain match");
  if (payload.contact_email && row.match_contact_email) reasons.push("Contact email match");
  if (payload.contact_phone && row.match_contact_phone) reasons.push("Contact phone match");
  if (payload.customer_name && row.match_name_normalized) reasons.push("Normalized company name match");
  else if (payload.customer_name && row.match_name) reasons.push("Company name similar");
  if (payload.phone && row.match_phone) reasons.push("Phone match");
  if (payload.website && row.match_website_domain) reasons.push("Website match");
  return reasons;
}

function duplicateConfidence(flags) {
  const nameScore = flags.match_name_normalized ? 60 : flags.match_name ? 25 : 0;
  const score =
    (flags.match_gstin || flags.match_site_gstin ? 100 : 0) +
    (flags.match_code ? 90 : 0) +
    (flags.match_pan ? 85 : 0) +
    (flags.match_email ? 80 : 0) +
    (flags.match_contact_email ? 70 : 0) +
    (flags.match_phone ? 55 : 0) +
    (flags.match_contact_phone ? 50 : 0) +
    (flags.match_email_domain ? 50 : 0) +
    (flags.match_website_domain ? 45 : 0) +
    nameScore;
  if (flags.match_gstin || flags.match_site_gstin || flags.match_code || flags.match_pan || score >= 100) {
    return { score, level: "high", label: "High confidence duplicate" };
  }
  if (score >= 45) return { score, level: "medium", label: "Medium confidence duplicate" };
  return { score, level: "low", label: "Low confidence review" };
}

function isBlockingDuplicate(row) {
  const level = row?.duplicate_confidence?.level;
  return level === "high" || level === "medium";
}

function splitDuplicateTiers(duplicates) {
  const list = Array.isArray(duplicates) ? duplicates : [];
  return {
    blocking: list.filter(isBlockingDuplicate),
    advisory: list.filter((row) => !isBlockingDuplicate(row)),
  };
}

function customerIdentityQuality(row) {
  const customerEmailDomain = emailDomain(row?.email);
  const customerWebsiteDomain = websiteDomain(row?.website);
  const checks = [
    Boolean(String(row?.gstin || "").trim()),
    Boolean(String(row?.legal_name || row?.customer_name || "").trim()),
    Boolean(String(row?.phone || "").trim()),
    Boolean(String(row?.city || "").trim() && String(row?.state || "").trim()),
    Boolean(customerWebsiteDomain),
    Boolean(customerEmailDomain && !isGenericEmailDomain(customerEmailDomain)),
  ];
  const issues = [
    !String(row?.gstin || "").trim() ? "GSTIN missing" : null,
    !customerWebsiteDomain ? "Website missing" : null,
    customerEmailDomain && isGenericEmailDomain(customerEmailDomain) ? "Generic email used" : null,
    !String(row?.phone || "").trim() ? "Phone missing" : null,
    !String(row?.legal_name || row?.customer_name || "").trim() ? "Legal name missing" : null,
    !(String(row?.city || "").trim() && String(row?.state || "").trim()) ? "Location incomplete" : null,
  ].filter(Boolean);
  return {
    score: Math.round((checks.filter(Boolean).length / checks.length) * 100),
    issues,
  };
}

async function inferCustomerCompanyIds(client, customerId) {
  if (!Number.isFinite(Number(customerId))) return [];
  const { rows } = await client.query(
    `
      select distinct company_id
      from (
        select company_id from leads where customer_id = $1 and company_id is not null
        union
        select company_id from leads where converted_customer_id = $1 and company_id is not null
        union
        select company_id from quote_headers where customer_id = $1 and company_id is not null
        union
        select company_id from sales_orders where customer_id = $1 and company_id is not null
        union
        select company_id from dispatches where customer_id = $1 and company_id is not null
        union
        select company_id from customer_invoices where customer_id = $1 and company_id is not null
        union
        select company_id from customer_receipts where customer_id = $1 and company_id is not null
        union
        select company_id from sales_returns where customer_id = $1 and company_id is not null
        union
        select company_id from service_warranty_cases where customer_id = $1 and company_id is not null
        union
        select company_id from amc_contracts where customer_id = $1 and company_id is not null
        union
        select company_id from customer_collection_actions where customer_id = $1 and company_id is not null
        union
        select company_id from customer_collection_disputes where customer_id = $1 and company_id is not null
        union
        select company_id from customer_ar_adjustments where customer_id = $1 and company_id is not null
        union
        select company_id from customer_credit_releases where customer_id = $1 and company_id is not null
      ) x
      order by company_id asc
    `,
    [Number(customerId)]
  );
  return rows.map((row) => Number(row.company_id)).filter(Number.isFinite);
}

async function backfillCustomerCompanyLinks(client, customerId, companyIds, ownershipType = "legacy_shared") {
  const normalized = [...new Set((Array.isArray(companyIds) ? companyIds : []).map((item) => Number(item)).filter(Number.isFinite))];
  for (const companyId of normalized) {
    await linkCustomerToCompany(client, customerId, companyId, ownershipType);
  }
  return normalized;
}

async function findDuplicateCustomers(client, payload, { excludeCustomerId = null, companyId = null } = {}) {
  const nameNeedle = buildNameNeedle(payload.customer_name);
  const normalizedName = normalizeCompanyName(payload.customer_name);
  const phoneDigits = digitsOnly(payload.phone);
  const contactPhoneDigits = digitsOnly(payload.contact_phone);
  const inputWebsiteDomains = collectWebsiteDomains(payload);
  const gst = String(payload.gstin || "").trim().toLowerCase();
  const code = String(payload.customer_code || "").trim().toLowerCase();
  const email = String(payload.email || "").trim().toLowerCase();
  const contactEmail = String(payload.contact_email || "").trim().toLowerCase();
  const pan = String(payload.pan || "").trim().toLowerCase();
  const emailDom = emailDomain(email);
  const matchEmailDomain = Boolean(emailDom && !isGenericEmailDomain(emailDom));

  const params = [];
  const where = ["c.is_active = true", "c.merged_into_customer_id is null"];

  if (isPositiveId(companyId)) {
    params.push(Number(companyId));
    where.push(buildCustomerCompanyScopeSql("c.id", `$${params.length}`));
  }

  if (isPositiveId(excludeCustomerId)) {
    params.push(Number(excludeCustomerId));
    where.push(`c.id <> $${params.length}`);
  }

  const or = [];
  if (gst) {
    params.push(gst);
    or.push(`lower(trim(coalesce(c.gstin, ''))) = $${params.length}`);
    or.push(`exists (
      select 1 from customer_tax_registrations ctr
      where ctr.customer_id = c.id
        and ctr.is_active = true
        and lower(trim(coalesce(ctr.gstin, ''))) = $${params.length}
    )`);
  }
  if (code) {
    params.push(code);
    or.push(`lower(trim(coalesce(c.customer_code, ''))) = $${params.length}`);
  }
  if (pan) {
    params.push(pan);
    or.push(`lower(trim(coalesce(c.pan, ''))) = $${params.length}`);
  }
  if (email) {
    params.push(email);
    or.push(`lower(trim(coalesce(c.email, ''))) = $${params.length}`);
  }
  if (matchEmailDomain) {
    params.push(emailDom);
    or.push(`(
      position('@' in coalesce(c.email, '')) > 0
      and lower(split_part(lower(trim(c.email)), '@', 2)) = $${params.length}
    )`);
  }
  if (contactEmail) {
    params.push(contactEmail);
    or.push(`exists (
      select 1 from customer_contacts cc
      where cc.customer_id = c.id
        and cc.is_active = true
        and lower(trim(coalesce(cc.email, ''))) = $${params.length}
    )`);
  }
  if (nameNeedle) {
    params.push(`%${nameNeedle}%`);
    or.push(`c.customer_name ilike $${params.length}`);
    or.push(`c.legal_name ilike $${params.length}`);
  }
  if (phoneDigits) {
    params.push(phoneDigits);
    or.push(`regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') = $${params.length}`);
  }
  if (contactPhoneDigits) {
    params.push(contactPhoneDigits);
    or.push(`exists (
      select 1 from customer_contacts cc
      where cc.customer_id = c.id
        and cc.is_active = true
        and regexp_replace(coalesce(cc.phone, ''), '\\D', '', 'g') = $${params.length}
    )`);
  }
  for (const domain of inputWebsiteDomains) {
    params.push(domain);
    or.push(`lower(regexp_replace(split_part(split_part(coalesce(c.website, ''), '/', 3), ':', 1), '^www\\.', '', 'i')) = $${params.length}`);
    or.push(`lower(regexp_replace(coalesce(c.website, ''), '^https?://', '', 'i')) like '%' || $${params.length} || '%'`);
  }

  if (!or.length) return [];

  const whereSql = `where ${where.join(" and ")} and (${or.join(" or ")})`;

  const orderParts = [];
  if (gst) {
    params.push(gst);
    orderParts.push(`case when lower(trim(coalesce(c.gstin, ''))) = $${params.length} then 0 else 1 end`);
  }
  if (code) {
    params.push(code);
    orderParts.push(`case when lower(trim(coalesce(c.customer_code, ''))) = $${params.length} then 0 else 1 end`);
  }
  if (email) {
    params.push(email);
    orderParts.push(`case when lower(trim(coalesce(c.email, ''))) = $${params.length} then 0 else 1 end`);
  }
  if (phoneDigits) {
    params.push(phoneDigits);
    orderParts.push(
      `case when regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') = $${params.length} then 0 else 1 end`
    );
  }
  orderParts.push("c.updated_at desc nulls last", "c.id desc");

  const baseRes = await client.query(
    `
      select
        c.id,
        c.customer_code,
        c.customer_name,
        c.legal_name,
        c.city,
        c.state,
        c.email,
        c.phone,
        c.gstin,
        c.pan,
        c.website
      from customers c
      ${whereSql}
      order by ${orderParts.join(", ")}
      limit 80
    `,
    params
  );

  // Load contact + tax registration signals for candidate ids (accurate post-filter flags).
  const candidateIds = baseRes.rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
  const contactRows = [];
  const taxRows = [];
  if (candidateIds.length) {
    const contactRes = await client.query(
      `
        select customer_id, email, phone
        from customer_contacts
        where customer_id = any($1::int[])
          and is_active = true
      `,
      [candidateIds]
    );
    contactRows.push(...contactRes.rows);
    const taxRes = await client.query(
      `
        select customer_id, gstin
        from customer_tax_registrations
        where customer_id = any($1::int[])
          and is_active = true
      `,
      [candidateIds]
    );
    taxRows.push(...taxRes.rows);
  }

  const contactsByCustomer = new Map();
  for (const row of contactRows) {
    const id = Number(row.customer_id);
    if (!contactsByCustomer.has(id)) contactsByCustomer.set(id, []);
    contactsByCustomer.get(id).push(row);
  }
  const taxByCustomer = new Map();
  for (const row of taxRows) {
    const id = Number(row.customer_id);
    if (!taxByCustomer.has(id)) taxByCustomer.set(id, []);
    taxByCustomer.get(id).push(row);
  }

  const filtered = [];
  for (const row of baseRes.rows) {
    const rowId = Number(row.id);
    const rowName = String(row.customer_name || "").toLowerCase();
    const rowLegal = String(row.legal_name || "").toLowerCase();
    const rowPhone = digitsOnly(row.phone);
    const rowEmail = String(row.email || "").trim().toLowerCase();
    const rowEmailDomain = emailDomain(rowEmail);
    const rowPan = String(row.pan || "").trim().toLowerCase();
    const rowNormalized = normalizeCompanyName(row.customer_name) || normalizeCompanyName(row.legal_name);
    const rowWebsiteDomains = collectWebsiteDomains(row);
    const websiteOverlap = inputWebsiteDomains.some((domain) => rowWebsiteDomains.includes(domain));
    const contacts = contactsByCustomer.get(rowId) || [];
    const taxRegs = taxByCustomer.get(rowId) || [];

    const matchContactEmail = Boolean(
      contactEmail && contacts.some((c) => String(c.email || "").trim().toLowerCase() === contactEmail)
    );
    const matchContactPhone = Boolean(
      contactPhoneDigits &&
        contacts.some((c) => {
          const digits = digitsOnly(c.phone);
          return digits && digits === contactPhoneDigits;
        })
    );
    const matchSiteGstin = Boolean(
      gst && taxRegs.some((t) => String(t.gstin || "").trim().toLowerCase() === gst)
    );

    const flags = {
      match_gstin: Boolean(gst && String(row.gstin || "").trim().toLowerCase() === gst),
      match_site_gstin: matchSiteGstin,
      match_code: Boolean(code && String(row.customer_code || "").trim().toLowerCase() === code),
      match_pan: Boolean(pan && rowPan && rowPan === pan),
      match_email: Boolean(email && rowEmail && rowEmail === email),
      match_email_domain: Boolean(
        matchEmailDomain && rowEmailDomain && rowEmailDomain === emailDom && !isGenericEmailDomain(rowEmailDomain)
      ),
      match_contact_email: matchContactEmail,
      match_contact_phone: matchContactPhone,
      match_name: Boolean(nameNeedle && (rowName.includes(nameNeedle) || rowLegal.includes(nameNeedle))),
      match_name_normalized: Boolean(normalizedName && rowNormalized && normalizedName === rowNormalized && normalizedName.length >= 3),
      match_phone: Boolean(phoneDigits && rowPhone && rowPhone === phoneDigits),
      match_website_domain: websiteOverlap,
    };

    if (Object.values(flags).some(Boolean)) {
      let confidence = duplicateConfidence(flags);
      const onlyWeakName =
        flags.match_name &&
        !flags.match_name_normalized &&
        !flags.match_gstin &&
        !flags.match_site_gstin &&
        !flags.match_code &&
        !flags.match_pan &&
        !flags.match_email &&
        !flags.match_email_domain &&
        !flags.match_contact_email &&
        !flags.match_contact_phone &&
        !flags.match_phone &&
        !flags.match_website_domain;
      if (onlyWeakName) {
        confidence = { score: confidence.score, level: "low", label: "Low confidence review" };
      }
      const identityQuality = customerIdentityQuality(row);
      filtered.push({
        id: row.id,
        customer_code: row.customer_code,
        customer_name: row.customer_name,
        legal_name: row.legal_name,
        city: row.city,
        state: row.state,
        email: row.email,
        phone: row.phone,
        gstin: row.gstin,
        pan: row.pan,
        website: row.website,
        ...flags,
        duplicate_confidence: confidence,
        identity_quality: identityQuality,
        hygiene_flags: identityQuality.issues,
        reasons: duplicateReasons(flags, payload),
      });
    }
  }
  filtered.sort((a, b) => (Number(b.duplicate_confidence?.score) || 0) - (Number(a.duplicate_confidence?.score) || 0));
  return filtered.slice(0, 12);
}

async function resolveCustomerForMergePreview(client, searchText) {
  const needle = String(searchText || "").trim();
  if (!needle) return null;

  const exactCodeRes = await client.query(
    `
      select id
      from customers
      where customer_code is not null
        and lower(customer_code) = lower($1)
      limit 1
    `,
    [needle]
  );
  if (exactCodeRes.rows[0]?.id) return Number(exactCodeRes.rows[0].id);

  const exactNameRes = await client.query(
    `
      select id
      from customers
      where lower(customer_name) = lower($1)
         or lower(coalesce(legal_name, '')) = lower($1)
      order by is_active desc, updated_at desc nulls last, id desc
      limit 2
    `,
    [needle]
  );
  if (exactNameRes.rows.length === 1) return Number(exactNameRes.rows[0].id);
  if (exactNameRes.rows.length > 1) {
    const err = new Error("SOURCE_CUSTOMER_AMBIGUOUS");
    err.status = 409;
    throw err;
  }

  const likeNeedle = `%${needle}%`;
  const fuzzyRes = await client.query(
    `
      select id
      from customers
      where customer_name ilike $1
         or coalesce(legal_name, '') ilike $1
      order by
        case
          when customer_name ilike $2 then 0
          when coalesce(legal_name, '') ilike $2 then 1
          else 2
        end,
        is_active desc,
        updated_at desc nulls last,
        id desc
      limit 2
    `,
    [likeNeedle, `${needle}%`]
  );
  if (fuzzyRes.rows.length === 1) return Number(fuzzyRes.rows[0].id);
  if (fuzzyRes.rows.length > 1) {
    const err = new Error("SOURCE_CUSTOMER_AMBIGUOUS");
    err.status = 409;
    throw err;
  }

  return null;
}

async function fetchContacts(client, customerId) {
  const res = await client.query(
    `
      select
        cc.id,
        cc.customer_id,
        cc.site_id,
        cc.salutation,
        cc.full_name,
        cc.email,
        cc.phone,
        cc.designation,
        cc.department,
        cc.is_primary,
        cc.is_active,
        cc.created_at,
        cs.site_name,
        coalesce(array_remove(array_agg(ccr.role_key order by ccr.role_key), null), '{}') as roles
      from customer_contacts cc
      left join customer_sites cs on cs.id = cc.site_id
      left join customer_contact_roles ccr on ccr.customer_contact_id = cc.id
      where cc.customer_id = $1
      group by cc.id, cs.site_name
      order by cc.is_primary desc, cc.is_active desc, cc.id asc
    `,
    [customerId]
  );
  return res.rows;
}

async function fetchSites(client, customerId, { activeOnly = false } = {}) {
  const res = await client.query(
    `
      select
        cs.*,
        stl.tax_registration_id,
        ctr.gstin as tax_gstin,
        ctr.registration_name as tax_registration_name
      from customer_sites cs
      left join customer_site_tax_links stl on stl.site_id = cs.id
      left join customer_tax_registrations ctr on ctr.id = stl.tax_registration_id
      where cs.customer_id = $1
        ${activeOnly ? "and cs.is_active = true" : ""}
      order by cs.is_default_quote_site desc, cs.site_name asc, cs.id asc
    `,
    [customerId]
  );
  return res.rows;
}

async function fetchTaxRegistrations(client, customerId) {
  const res = await client.query(
    `
      select *
      from customer_tax_registrations
      where customer_id = $1
      order by is_active desc, state asc nulls last, id asc
    `,
    [customerId]
  );
  return res.rows;
}

async function fetchLocationMasters(client) {
  const [countriesRes, statesRes, citiesRes] = await Promise.all([
    client.query(
      `
        select id, iso_code, country_name
        from countries
        where is_active = true
        order by country_name asc
      `
    ),
    client.query(
      `
        select
          s.id,
          s.country_id,
          c.iso_code as country_code,
          c.country_name,
          s.state_code,
          s.state_name
        from states s
        join countries c on c.id = s.country_id
        where s.is_active = true
        order by c.country_name asc, s.state_name asc
      `
    ),
    client.query(
      `
        select
          ci.id,
          ci.country_id,
          ci.state_id,
          c.iso_code as country_code,
          c.country_name,
          s.state_code,
          s.state_name,
          ci.city_code,
          ci.city_name
        from cities ci
        join countries c on c.id = ci.country_id
        join states s on s.id = ci.state_id
        where ci.is_active = true
        order by c.country_name asc, s.state_name asc, ci.city_name asc
      `
    ),
  ]);
  return {
    countries: countriesRes.rows,
    states: statesRes.rows,
    cities: citiesRes.rows,
  };
}

function normalizeMasterText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function toDisplayName(value) {
  return normalizeMasterText(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

function buildCityCodeSeed(countryCode, stateCode, cityName) {
  const code = `${String(countryCode || "").trim()}${String(stateCode || "").trim()}${String(cityName || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")}`;
  return code.slice(0, 24) || "CITY";
}

async function allocateCityCode(client, { countryCode, stateCode, cityName }) {
  const seed = buildCityCodeSeed(countryCode, stateCode, cityName);
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? seed : `${seed}${i + 1}`;
    const exists = await client.query(
      `select 1 from cities where upper(trim(city_code)) = upper(trim($1)) limit 1`,
      [candidate]
    );
    if (!exists.rows.length) return candidate;
  }
  return `${seed}${Date.now()}`;
}

async function upsertLocationCity(client, { countryId, stateId, cityName }) {
  const normalizedName = toDisplayName(cityName);
  if (!normalizedName) {
    const err = new Error("CITY_NAME_REQUIRED");
    err.status = 400;
    throw err;
  }

  const stateRes = await client.query(
    `
      select
        s.id,
        s.country_id,
        s.state_code,
        s.state_name,
        c.iso_code as country_code,
        c.country_name
      from states s
      join countries c on c.id = s.country_id
      where s.id = $1
        and c.id = $2
        and s.is_active = true
        and c.is_active = true
      limit 1
    `,
    [Number(stateId), Number(countryId)]
  );
  const state = stateRes.rows[0] || null;
  if (!state) {
    const err = new Error("STATE_NOT_FOUND");
    err.status = 400;
    throw err;
  }

  const existing = await client.query(
    `
      select
        ci.id,
        ci.country_id,
        ci.state_id,
        c.iso_code as country_code,
        c.country_name,
        s.state_code,
        s.state_name,
        ci.city_code,
        ci.city_name
      from cities ci
      join countries c on c.id = ci.country_id
      join states s on s.id = ci.state_id
      where ci.state_id = $1
        and lower(trim(ci.city_name)) = lower(trim($2))
      limit 1
    `,
    [state.id, normalizedName]
  );
  if (existing.rows[0]) return existing.rows[0];

  const cityCode = await allocateCityCode(client, {
    countryCode: state.country_code,
    stateCode: state.state_code,
    cityName: normalizedName,
  });
  const inserted = await client.query(
    `
      insert into cities (country_id, state_id, city_code, city_name, is_active)
      values ($1, $2, $3, $4, true)
      returning id, country_id, state_id, city_code, city_name
    `,
    [state.country_id, state.id, cityCode, normalizedName]
  );
  return {
    ...inserted.rows[0],
    country_code: state.country_code,
    country_name: state.country_name,
    state_code: state.state_code,
    state_name: state.state_name,
  };
}

async function fetchCustomerDetail(client, customerId, { companyId = null } = {}) {
  const customerRes = await client.query(`select * from customers where id = $1 limit 1`, [customerId]);
  const customer = customerRes.rows[0] || null;
  if (!customer) return null;
  const [contacts, sites, taxRegistrations, duplicateCandidates] = await Promise.all([
    fetchContacts(client, customerId),
    fetchSites(client, customerId),
    fetchTaxRegistrations(client, customerId),
    findDuplicateCustomers(client, customer, { excludeCustomerId: customerId, companyId }),
  ]);
  return {
    customer,
    contacts,
    sites,
    tax_registrations: taxRegistrations,
    duplicate_candidates: duplicateCandidates,
  };
}

async function syncContactRoles(client, contactId, roles) {
  await client.query(`delete from customer_contact_roles where customer_contact_id = $1`, [contactId]);
  for (const role of normalizeRoleKeys(roles)) {
    await client.query(`insert into customer_contact_roles (customer_contact_id, role_key) values ($1, $2)`, [contactId, role]);
  }
}

async function upsertCustomerSite(client, customerId, siteId, body) {
  const payload = sitePayload(body);
  if (!payload.site_name) {
    const err = new Error("SITE_NAME_REQUIRED");
    err.status = 400;
    throw err;
  }
  let saved = null;
  if (isPositiveId(siteId)) {
    const res = await client.query(
      `
        update customer_sites
        set site_code = $3,
            site_name = $4,
            site_type = $5,
            address_line1 = $6,
            address_line2 = $7,
            address_line3 = $8,
            city = $9,
            state = $10,
            pincode = $11,
            country_id = $12,
            gst_status = $13,
            can_quote = $14,
            can_dispatch = $15,
            can_bill = $16,
            is_default_quote_site = $17,
            is_default_ship_to = $18,
            is_default_bill_to = $19,
            is_active = $20,
            updated_at = now()
        where id = $1 and customer_id = $2
        returning *
      `,
      [
        Number(siteId),
        customerId,
        payload.site_code,
        payload.site_name,
        payload.site_type,
        payload.address_line1,
        payload.address_line2,
        payload.address_line3,
        payload.city,
        payload.state,
        payload.pincode,
        Number.isFinite(payload.country_id) ? payload.country_id : null,
        payload.gst_status,
        payload.can_quote,
        payload.can_dispatch,
        payload.can_bill,
        payload.is_default_quote_site,
        payload.is_default_ship_to,
        payload.is_default_bill_to,
        payload.is_active,
      ]
    );
    saved = res.rows[0] || null;
  } else {
    const res = await client.query(
      `
        insert into customer_sites (
          customer_id,
          site_code,
          site_name,
          site_type,
          address_line1,
          address_line2,
          address_line3,
          city,
          state,
          pincode,
          country_id,
          gst_status,
          can_quote,
          can_dispatch,
          can_bill,
          is_default_quote_site,
          is_default_ship_to,
          is_default_bill_to,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
        returning *
      `,
      [
        customerId,
        payload.site_code,
        payload.site_name,
        payload.site_type,
        payload.address_line1,
        payload.address_line2,
        payload.address_line3,
        payload.city,
        payload.state,
        payload.pincode,
        Number.isFinite(payload.country_id) ? payload.country_id : null,
        payload.gst_status,
        payload.can_quote,
        payload.can_dispatch,
        payload.can_bill,
        payload.is_default_quote_site,
        payload.is_default_ship_to,
        payload.is_default_bill_to,
        payload.is_active,
      ]
    );
    saved = res.rows[0] || null;
  }
  if (!saved) {
    const err = new Error("CUSTOMER_SITE_NOT_FOUND");
    err.status = 404;
    throw err;
  }
  if (payload.is_default_quote_site) {
    await client.query(`update customer_sites set is_default_quote_site = false where customer_id = $1 and id <> $2`, [customerId, saved.id]);
  }
  if (payload.is_default_ship_to) {
    await client.query(`update customer_sites set is_default_ship_to = false where customer_id = $1 and id <> $2`, [customerId, saved.id]);
  }
  if (payload.is_default_bill_to) {
    await client.query(`update customer_sites set is_default_bill_to = false where customer_id = $1 and id <> $2`, [customerId, saved.id]);
  }
  await client.query(`delete from customer_site_tax_links where site_id = $1`, [saved.id]);
  if (Number.isFinite(payload.tax_registration_id)) {
    await client.query(`insert into customer_site_tax_links (site_id, tax_registration_id, updated_at) values ($1, $2, now())`, [
      saved.id,
      payload.tax_registration_id,
    ]);
  }
  return saved;
}

async function upsertCustomerContact(client, customerId, contactId, body) {
  const payload = contactPayload(body);
  if (!payload.full_name) {
    const err = new Error("CONTACT_NAME_REQUIRED");
    err.status = 400;
    throw err;
  }
  let saved = null;
  if (isPositiveId(contactId)) {
    const res = await client.query(
      `
        update customer_contacts
        set site_id = $3,
            salutation = $4,
            full_name = $5,
            email = $6,
            phone = $7,
            designation = $8,
            department = $9,
            is_primary = $10,
            is_active = $11
        where id = $1 and customer_id = $2
        returning *
      `,
      [
        Number(contactId),
        customerId,
        Number.isFinite(payload.site_id) ? payload.site_id : null,
        payload.salutation,
        payload.full_name,
        payload.email,
        payload.phone,
        payload.designation,
        payload.department,
        payload.is_primary,
        payload.is_active,
      ]
    );
    saved = res.rows[0] || null;
  } else {
    const res = await client.query(
      `
        insert into customer_contacts (
          customer_id,
          site_id,
          salutation,
          full_name,
          email,
          phone,
          designation,
          department,
          is_primary,
          is_active,
          created_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
        returning *
      `,
      [
        customerId,
        Number.isFinite(payload.site_id) ? payload.site_id : null,
        payload.salutation,
        payload.full_name,
        payload.email,
        payload.phone,
        payload.designation,
        payload.department,
        payload.is_primary,
        payload.is_active,
      ]
    );
    saved = res.rows[0] || null;
  }
  if (!saved) {
    const err = new Error("CUSTOMER_CONTACT_NOT_FOUND");
    err.status = 404;
    throw err;
  }
  if (payload.is_primary) {
    await client.query(`update customer_contacts set is_primary = false where customer_id = $1 and id <> $2`, [customerId, saved.id]);
    await client.query(`update customer_contacts set is_primary = true where id = $1`, [saved.id]);
  }
  await syncContactRoles(client, saved.id, payload.roles);
  return saved;
}

async function upsertCustomerTaxRegistration(client, customerId, taxId, body) {
  const payload = taxRegistrationPayload(body);
  if (!payload.state && !payload.gstin && !payload.registration_name) {
    const err = new Error("TAX_REGISTRATION_REQUIRED");
    err.status = 400;
    throw err;
  }
  const normalizedGstin = payload.gstin ? payload.gstin.toUpperCase() : null;
  let saved = null;
  if (isPositiveId(taxId)) {
    const res = await client.query(
      `
        update customer_tax_registrations
        set state = $3,
            gstin = $4,
            registration_name = $5,
            is_active = $6,
            updated_at = now()
        where id = $1 and customer_id = $2
        returning *
      `,
      [Number(taxId), customerId, payload.state, normalizedGstin, payload.registration_name, payload.is_active]
    );
    saved = res.rows[0] || null;
  } else {
    const res = await client.query(
      `
        insert into customer_tax_registrations (
          customer_id,
          state,
          gstin,
          registration_name,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,now())
        returning *
      `,
      [customerId, payload.state, normalizedGstin, payload.registration_name, payload.is_active]
    );
    saved = res.rows[0] || null;
  }
  if (!saved) {
    const err = new Error("CUSTOMER_TAX_REGISTRATION_NOT_FOUND");
    err.status = 404;
    throw err;
  }
  return saved;
}

router.use(requireAuth);

router.get("/", requireScreenAction("customers", "can_view"), async (req, res, next) => {
  try {
    const { isDistributor, distributorId } = await getDistributorScope(req);
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const params = [];
    const where = ["c.is_active = true", "c.merged_into_customer_id is null"];
    params.push(companyId);
    where.push(buildCustomerCompanyScopeSql("c.id", `$${params.length}`));
    if (q) {
      params.push(`%${q}%`);
      const p = `$${params.length}`;
      where.push(
        `(
          c.customer_name ilike ${p}
          or c.customer_code ilike ${p}
          or c.legal_name ilike ${p}
          or c.email ilike ${p}
          or c.phone ilike ${p}
          or c.fax ilike ${p}
          or c.city ilike ${p}
          or c.state ilike ${p}
          or c.gstin ilike ${p}
          or c.tinno ilike ${p}
          or c.pan ilike ${p}
          or c.customer_type ilike ${p}
          or c.account_manager ilike ${p}
          or c.invoice_no ilike ${p}
          or to_char(c.invoice_date, 'YYYY-MM-DD') ilike ${p}
          or exists (
            select 1 from customer_contacts cc
            where cc.customer_id = c.id
              and (
                cc.full_name ilike ${p}
                or cc.email ilike ${p}
                or cc.phone ilike ${p}
                or cc.designation ilike ${p}
              )
          )
          or exists (
            select 1 from customer_sites cs
            where cs.customer_id = c.id
              and (
                cs.site_name ilike ${p}
                or cs.site_code ilike ${p}
                or cs.city ilike ${p}
                or cs.state ilike ${p}
              )
          )
          or exists (
            select 1 from customer_tax_registrations ctr
            where ctr.customer_id = c.id
              and (
                ctr.gstin ilike ${p}
                or ctr.registration_name ilike ${p}
              )
          )
        )`
      );
    }
    if (isDistributor) {
      params.push(distributorId);
      where.push(`exists (select 1 from customer_distributor_links cdl where cdl.customer_id = c.id and cdl.distributor_id = $${params.length})`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    let orderSql = "order by c.customer_name asc";
    let limitSql = "limit 200";
    if (q) {
      params.push(q);
      const qExact = `$${params.length}`;
      params.push(`${q}%`);
      const qPrefix = `$${params.length}`;
      orderSql = `
        order by
          case
            when lower(trim(coalesce(c.customer_code, ''))) = lower(trim(${qExact})) then 0
            when lower(c.customer_name) like lower(${qPrefix}) then 1
            when lower(trim(coalesce(c.customer_code, ''))) like lower(${qPrefix}) then 1
            else 2
          end asc,
          c.customer_name asc
      `;
      limitSql = "limit 50";
    }
    const { rows } = await pool.query(
      `
        select
          c.id,
          c.customer_code,
          c.customer_name,
          c.legal_name,
          c.website,
          c.industry,
          c.credit_limit,
          c.credit_control_mode,
          c.is_credit_hold,
          c.credit_hold_reason,
          c.city,
          c.state,
          c.phone,
          c.fax,
          c.email,
          c.gstin,
          c.tinno,
          c.pan,
          c.customer_type,
          c.account_manager,
          c.invoice_no,
          c.invoice_date,
          c.in_case_of_hospital,
          primary_contact.full_name as primary_contact_name,
          primary_contact.email as primary_contact_email,
          primary_contact.phone as primary_contact_phone,
          coalesce(site_stats.site_count, 0)::int as site_count,
          coalesce(site_stats.active_site_count, 0)::int as active_site_count,
          coalesce(site_stats.pending_gst_site_count, 0)::int as pending_gst_site_count,
          coalesce(contact_stats.contact_count, 0)::int as contact_count,
          coalesce(tax_stats.tax_registration_count, 0)::int as tax_registration_count
        from customers c
        left join lateral (
          select cc.full_name, cc.email, cc.phone
          from customer_contacts cc
          where cc.customer_id = c.id and cc.is_active = true
          order by cc.is_primary desc, cc.id asc
          limit 1
        ) primary_contact on true
        left join lateral (
          select
            count(*) as site_count,
            count(*) filter (where cs.is_active = true) as active_site_count,
            count(*) filter (where cs.gst_status = 'pending' and cs.is_active = true) as pending_gst_site_count
          from customer_sites cs
          where cs.customer_id = c.id
        ) site_stats on true
        left join lateral (
          select count(*) as contact_count
          from customer_contacts cc
          where cc.customer_id = c.id and cc.is_active = true
        ) contact_stats on true
        left join lateral (
          select count(*) as tax_registration_count
          from customer_tax_registrations ctr
          where ctr.customer_id = c.id and ctr.is_active = true
        ) tax_stats on true
        ${whereSql}
        ${orderSql}
        ${limitSql}
      `,
      params
    );
    return res.json({ ok: true, customers: rows });
  } catch (err) {
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    return next(err);
  }
});

router.post("/duplicate-check", requireScreenAction("customers", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const payload = duplicateSignalPayload(body);
    const excludeCustomerId = body.exclude_customer_id === null || body.exclude_customer_id === "" ? null : Number(body.exclude_customer_id);
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const duplicates = await findDuplicateCustomers(client, payload, { excludeCustomerId, companyId });
    const tiers = splitDuplicateTiers(duplicates);
    return res.json({
      ok: true,
      duplicates,
      blocking_duplicates: tiers.blocking,
      advisory_duplicates: tiers.advisory,
    });
  } catch (err) {
    return respondKnownCustomerError(res, err);
  } finally {
    client.release();
  }
});

router.get("/bootstrap", requireScreenAction("customers", "can_view"), async (_req, res, next) => {
  const client = await pool.connect();
  try {
    return res.json({ ok: true, ...(await fetchLocationMasters(client)) });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/location-masters/cities", requireAuth, async (req, res, next) => {
  if (!hasScreenAction(req, "customers", "can_create") && !hasScreenAction(req, "customers", "can_edit")) {
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  }
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const city = await upsertLocationCity(client, {
      countryId: body.country_id,
      stateId: body.state_id,
      cityName: body.city_name,
    });
    return res.json({ ok: true, city });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.message || "CITY_CREATE_FAILED" });
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/merge/preview", requireScreenAction("customers", "can_edit"), requireCustomerAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const sourceCustomerId = body.source_customer_id === null || body.source_customer_id === "" ? null : Number(body.source_customer_id);
    const targetCustomerId = Number(body.target_customer_id);
    const sourceCustomerCode = typeof body.source_customer_code === "string" ? body.source_customer_code.trim() : "";

    if (!Number.isFinite(targetCustomerId) || targetCustomerId <= 0) return res.status(400).json({ ok: false, error: "TARGET_CUSTOMER_REQUIRED" });
    if ((!Number.isFinite(sourceCustomerId) || sourceCustomerId <= 0) && !sourceCustomerCode) {
      return res.status(400).json({ ok: false, error: "SOURCE_CUSTOMER_REQUIRED" });
    }

    let resolvedSourceId = Number.isFinite(sourceCustomerId) && sourceCustomerId > 0 ? sourceCustomerId : null;
    if (!resolvedSourceId && sourceCustomerCode) {
      resolvedSourceId = await resolveCustomerForMergePreview(client, sourceCustomerCode);
      if (!resolvedSourceId) return res.status(404).json({ ok: false, error: "SOURCE_CUSTOMER_NOT_FOUND" });
    }

    if (resolvedSourceId === targetCustomerId) return res.status(400).json({ ok: false, error: "SOURCE_TARGET_SAME" });

    const [sourceRes, targetRes] = await Promise.all([
      client.query(`select id, customer_code, customer_name, legal_name, city, state, gstin, merged_into_customer_id, is_active from customers where id = $1 limit 1`, [
        resolvedSourceId,
      ]),
      client.query(`select id, customer_code, customer_name, legal_name, city, state, gstin, merged_into_customer_id, is_active from customers where id = $1 limit 1`, [
        targetCustomerId,
      ]),
    ]);

    const source = sourceRes.rows[0] || null;
    const target = targetRes.rows[0] || null;
    if (!source) return res.status(404).json({ ok: false, error: "SOURCE_CUSTOMER_NOT_FOUND" });
    if (!target) return res.status(404).json({ ok: false, error: "TARGET_CUSTOMER_NOT_FOUND" });
    await ensureCustomerVisible(client, req, source.id);
    await ensureCustomerVisible(client, req, target.id);
    if (!source.is_active || source.merged_into_customer_id) return res.status(400).json({ ok: false, error: "SOURCE_ALREADY_MERGED" });
    if (!target.is_active || target.merged_into_customer_id) return res.status(400).json({ ok: false, error: "TARGET_NOT_ACTIVE" });

    const counts = {};
    const countSql = async (sql, params) => {
      const r = await client.query(sql, params);
      return Number(r.rows[0]?.count || 0);
    };

    counts.sites = await countSql(`select count(*) from customer_sites where customer_id = $1`, [resolvedSourceId]);
    counts.contacts = await countSql(`select count(*) from customer_contacts where customer_id = $1`, [resolvedSourceId]);
    counts.tax_registrations = await countSql(`select count(*) from customer_tax_registrations where customer_id = $1`, [resolvedSourceId]);
    counts.distributor_links = await countSql(`select count(*) from customer_distributor_links where customer_id = $1`, [resolvedSourceId]);

    counts.leads = await countSql(`select count(*) from leads where customer_id = $1`, [resolvedSourceId]);
    counts.leads_converted_customer = await countSql(`select count(*) from leads where converted_customer_id = $1`, [resolvedSourceId]);
    counts.quotes = await countSql(`select count(*) from quote_headers where customer_id = $1`, [resolvedSourceId]);
    counts.sales_orders = await countSql(`select count(*) from sales_orders where customer_id = $1`, [resolvedSourceId]);
    counts.dispatches = await countSql(`select count(*) from dispatches where customer_id = $1`, [resolvedSourceId]);
    counts.customer_invoices = await countSql(`select count(*) from customer_invoices where customer_id = $1`, [resolvedSourceId]);
    counts.customer_receipts = await countSql(`select count(*) from customer_receipts where customer_id = $1`, [resolvedSourceId]);
    counts.sales_returns = await countSql(`select count(*) from sales_returns where customer_id = $1`, [resolvedSourceId]);
    counts.service_cases = await countSql(`select count(*) from service_warranty_cases where customer_id = $1`, [resolvedSourceId]);
    counts.amc_contracts = await countSql(`select count(*) from amc_contracts where customer_id = $1`, [resolvedSourceId]);
    counts.collection_actions = await countSql(`select count(*) from customer_collection_actions where customer_id = $1`, [resolvedSourceId]);
    counts.collection_disputes = await countSql(`select count(*) from customer_collection_disputes where customer_id = $1`, [resolvedSourceId]);
    counts.ar_adjustments = await countSql(`select count(*) from customer_ar_adjustments where customer_id = $1`, [resolvedSourceId]);
    counts.credit_releases = await countSql(`select count(*) from customer_credit_releases where customer_id = $1`, [resolvedSourceId]);
    counts.intercompany_partners = await countSql(`select count(*) from intercompany_partners where customer_id = $1`, [resolvedSourceId]);

    const siteCodeConflicts = await client.query(
      `
        select s.id, s.site_code
        from customer_sites s
        where s.customer_id = $1
          and s.site_code is not null
          and exists (
            select 1
            from customer_sites t
            where t.customer_id = $2
              and t.site_code is not null
              and lower(t.site_code) = lower(s.site_code)
          )
        order by s.id asc
      `,
      [resolvedSourceId, targetCustomerId]
    );

    return res.json({
      ok: true,
      source_customer: source,
      target_customer: target,
      counts,
      conflicts: {
        site_code_conflicts: siteCodeConflicts.rows,
      },
    });
  } catch (err) {
    return respondKnownCustomerError(res, err);
  } finally {
    client.release();
  }
});

router.post("/merge/execute", requireScreenAction("customers", "can_edit"), requireCustomerAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const sourceCustomerId = Number(body.source_customer_id);
    const targetCustomerId = Number(body.target_customer_id);
    const confirm = body.confirm === true;
    const confirmPhrase = String(body.confirm_phrase || "").trim();

    if (!confirm) return res.status(400).json({ ok: false, error: "CONFIRM_REQUIRED" });
    if (!Number.isFinite(sourceCustomerId) || sourceCustomerId <= 0) return res.status(400).json({ ok: false, error: "SOURCE_CUSTOMER_REQUIRED" });
    if (!Number.isFinite(targetCustomerId) || targetCustomerId <= 0) return res.status(400).json({ ok: false, error: "TARGET_CUSTOMER_REQUIRED" });
    if (sourceCustomerId === targetCustomerId) return res.status(400).json({ ok: false, error: "SOURCE_TARGET_SAME" });

    await client.query("begin");

    const sourceRes = await client.query(
      `select id, customer_code, merged_into_customer_id, is_active from customers where id = $1 for update`,
      [sourceCustomerId]
    );
    const targetRes = await client.query(
      `select id, merged_into_customer_id, is_active from customers where id = $1 for update`,
      [targetCustomerId]
    );

    const source = sourceRes.rows[0] || null;
    const target = targetRes.rows[0] || null;
    if (!source) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "SOURCE_CUSTOMER_NOT_FOUND" });
    }
    if (!target) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "TARGET_CUSTOMER_NOT_FOUND" });
    }
    const expectedPhrase = String(source.customer_code || "").trim() || `MERGE ${source.id}`;
    if (confirmPhrase !== expectedPhrase) {
      await client.query("rollback");
      return res.status(400).json({
        ok: false,
        error: "CONFIRM_PHRASE_REQUIRED",
        expected: expectedPhrase,
        detail: `Type ${expectedPhrase} to confirm the customer merge.`,
      });
    }
    if (!confirmPhrase) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "CONFIRM_PHRASE_REQUIRED", expected: source.customer_code });
    }
    if (!source.is_active || source.merged_into_customer_id) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "SOURCE_ALREADY_MERGED" });
    }
    if (!target.is_active || target.merged_into_customer_id) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "TARGET_NOT_ACTIVE" });
    }
    await ensureCustomerVisible(client, req, source.id);
    await ensureCustomerVisible(client, req, target.id);

    const targetDefaultsRes = await client.query(
      `
        select
          bool_or(is_default_quote_site) as has_default_quote_site,
          bool_or(is_default_ship_to) as has_default_ship_to,
          bool_or(is_default_bill_to) as has_default_bill_to
        from customer_sites
        where customer_id = $1
      `,
      [targetCustomerId]
    );

    const hasDefaults = targetDefaultsRes.rows[0] || {};

    const sourceSitesRes = await client.query(
      `select id, site_code, is_default_quote_site, is_default_ship_to, is_default_bill_to from customer_sites where customer_id = $1 order by id asc`,
      [sourceCustomerId]
    );

    for (const site of sourceSitesRes.rows) {
      const conflictRes = await client.query(
        `
          select 1
          from customer_sites t
          where t.customer_id = $1
            and t.site_code is not null
            and $2 is not null
            and lower(t.site_code) = lower($2)
          limit 1
        `,
        [targetCustomerId, site.site_code]
      );

      const nextSiteCode = conflictRes.rows.length ? null : site.site_code;
      const keepDefaultQuote = site.is_default_quote_site && !hasDefaults.has_default_quote_site;
      const keepDefaultShip = site.is_default_ship_to && !hasDefaults.has_default_ship_to;
      const keepDefaultBill = site.is_default_bill_to && !hasDefaults.has_default_bill_to;

      await client.query(
        `
          update customer_sites
          set customer_id = $2,
              site_code = $3,
              is_default_quote_site = $4,
              is_default_ship_to = $5,
              is_default_bill_to = $6,
              updated_at = now()
          where id = $1
        `,
        [site.id, targetCustomerId, nextSiteCode, keepDefaultQuote, keepDefaultShip, keepDefaultBill]
      );

      if (keepDefaultQuote) hasDefaults.has_default_quote_site = true;
      if (keepDefaultShip) hasDefaults.has_default_ship_to = true;
      if (keepDefaultBill) hasDefaults.has_default_bill_to = true;
    }

    await client.query(`update customer_contacts set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update customer_tax_registrations set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);

    await client.query(
      `
        insert into customer_company_links (customer_id, company_id, ownership_type, is_active, updated_at)
        select $2, company_id, ownership_type, true, now()
        from customer_company_links
        where customer_id = $1
          and is_active = true
        on conflict (customer_id, company_id) do update set
          is_active = true,
          ownership_type = excluded.ownership_type,
          updated_at = now()
      `,
      [sourceCustomerId, targetCustomerId]
    );
    await client.query(
      `
        insert into customer_distributor_links (customer_id, distributor_id)
        select $2, distributor_id
        from customer_distributor_links
        where customer_id = $1
        on conflict do nothing
      `,
      [sourceCustomerId, targetCustomerId]
    );
    await client.query(`delete from customer_distributor_links where customer_id = $1`, [sourceCustomerId]);
    await client.query(`delete from customer_company_links where customer_id = $1`, [sourceCustomerId]);

    await client.query(`update leads set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update leads set converted_customer_id = $2 where converted_customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update quote_headers set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update sales_orders set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update dispatches set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update customer_invoices set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update customer_receipts set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update sales_returns set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update service_warranty_cases set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update amc_contracts set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update customer_collection_actions set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update customer_collection_disputes set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update customer_ar_adjustments set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update customer_credit_releases set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);
    await client.query(`update intercompany_partners set customer_id = $2 where customer_id = $1`, [sourceCustomerId, targetCustomerId]);

    await client.query(
      `update customers set is_active = false, merged_into_customer_id = $2, merged_at = now(), merged_by = $3, updated_at = now() where id = $1`,
      [sourceCustomerId, targetCustomerId, req.user.id]
    );

    await client.query("commit");

    const mergedTarget = await fetchCustomerDetail(client, targetCustomerId);
    return res.json({ ok: true, customer: mergedTarget });
  } catch (err) {
    await client.query("rollback");
    return respondKnownCustomerError(res, err);
  } finally {
    client.release();
  }
});

router.get("/:id/sites", requireScreenAction("customers", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    await ensureCustomerVisible(client, req, customerId);
    const sites = await fetchSites(client, customerId, { activeOnly: true });
    return res.json({ ok: true, sites });
  } catch (err) {
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/company-link-gaps", requireScreenAction("customers", "can_view"), requireCustomerAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await client.query(
      `
        select
          c.id,
          c.customer_code,
          c.customer_name,
          c.email,
          c.phone,
          c.city,
          c.state,
          c.updated_at
        from customers c
        where c.is_active = true
          and c.merged_into_customer_id is null
          and not exists (
            select 1
            from customer_company_links ccl
            where ccl.customer_id = c.id
              and ccl.is_active = true
          )
        order by c.updated_at desc nulls last, c.id desc
        limit $1
      `,
      [limit]
    );
    const customers = [];
    for (const row of rows) {
      const inferredCompanyIds = await inferCustomerCompanyIds(client, row.id);
      customers.push({
        ...row,
        inferred_company_ids: inferredCompanyIds,
      });
    }
    return res.json({ ok: true, customers });
  } catch (err) {
    return respondKnownCustomerError(res, err);
  } finally {
    client.release();
  }
});

router.post("/:id/company-links/backfill", requireScreenAction("customers", "can_edit"), requireCustomerAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });

    await client.query("begin");

    const customerRes = await client.query(
      `
        select id, customer_code, customer_name
        from customers
        where id = $1
          and is_active = true
          and merged_into_customer_id is null
        limit 1
      `,
      [customerId]
    );
    const customer = customerRes.rows[0] || null;
    if (!customer) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });
    }

    const requestedCompanyIds = Array.isArray(req.body?.company_ids) ? req.body.company_ids : [];
    const inferredCompanyIds = await inferCustomerCompanyIds(client, customerId);
    const activeCompanyId = getActiveCompanyId(req);
    const useActiveCompany = req.body?.use_active_company === true;
    const ownershipType = ["owned", "shared", "legacy_shared"].includes(String(req.body?.ownership_type || "").trim().toLowerCase())
      ? String(req.body?.ownership_type || "").trim().toLowerCase()
      : "legacy_shared";

    const companyIds = [
      ...requestedCompanyIds,
      ...inferredCompanyIds,
      ...(useActiveCompany && Number.isFinite(activeCompanyId) ? [activeCompanyId] : []),
    ];
    const linkedCompanyIds = await backfillCustomerCompanyLinks(client, customerId, companyIds, ownershipType);
    if (!linkedCompanyIds.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_COMPANY_LINKS_RESOLVED" });
    }

    await client.query("commit");
    return res.json({
      ok: true,
      customer,
      linked_company_ids: linkedCompanyIds,
      inferred_company_ids: inferredCompanyIds,
    });
  } catch (err) {
    await client.query("rollback");
    return respondKnownCustomerError(res, err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("customers", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    await ensureCustomerVisible(client, req, customerId);
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const detail = await fetchCustomerDetail(client, customerId, { companyId });
    if (!detail) return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });
    return res.json({ ok: true, ...detail, can_merge: canTemporarilyMergeCustomers(req.user) });
  } catch (err) {
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/", requireScreenAction("customers", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const payload = customerPayload(body);
    if (!payload.customer_name) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER_NAME" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const signalPayload = duplicateSignalPayload(body);
    const duplicates = await findDuplicateCustomers(client, signalPayload, { companyId });
    const { blocking, advisory } = splitDuplicateTiers(duplicates);
    if (blocking.length && body.allow_duplicate !== true) {
      return res.status(409).json({
        ok: false,
        error: "POSSIBLE_DUPLICATE_CUSTOMER",
        duplicates: blocking,
        advisory_duplicates: advisory,
      });
    }
    const { isDistributor, distributorId } = await getDistributorScope(req);
    await client.query("begin");
    const memberships = Array.isArray(req.user?.companies) ? req.user.companies : [];
    const shareWithCompanyIds = memberships
      .map((membership) => Number(membership?.company_id))
      .filter((id) => Number.isFinite(id) && id > 0);

    const result = await createCustomerFromParty(client, {
      party: {
        ...payload,
        contact_salutation: body.contact_salutation,
        contact_name: body.contact_name,
        contact_email: body.contact_email,
        contact_phone: body.contact_phone,
        contact_designation: body.contact_designation,
        contact_department: body.contact_department,
        contact_roles: body.contact_roles || ["sales_enquiry", "quote_recipient"],
      },
      companyId,
      distributorId: isDistributor ? distributorId : null,
      shareWithCompanyIds,
      reuseExistingByEmail: false,
      ownershipType: "owned",
    });

    await client.query("commit");
    return res.status(201).json({
      ok: true,
      customer: result.customer,
      duplicates,
      blocking_duplicates: blocking,
      advisory_duplicates: advisory,
      site: result.site,
      contact: result.contact,
    });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "INVALID_CUSTOMER_NAME") return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER_NAME" });
    if (err?.message === "COMPANY_NOT_SELECTED") return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    await ensureCustomerVisible(client, req, customerId);
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const payload = customerPayload(body);
    if (!payload.customer_name) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER_NAME" });
    const beforeRes = await client.query(
      `select id, customer_name, customer_code, gstin, is_credit_hold, account_manager from customers where id = $1 limit 1`,
      [customerId]
    );
    const before = beforeRes.rows[0] || null;
    if (!before) return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });
    const keyChangeAllowed = allowCustomerKeyChange(req, body);
    if (
      !keyChangeAllowed &&
      normalizedCustomerCode(before.customer_code) !== normalizedCustomerCode(payload.customer_code)
    ) {
      return res.status(409).json({
        ok: false,
        error: "CUSTOMER_CODE_FROZEN",
        detail: "Customer code is locked after create. Use controlled rename/merge.",
      });
    }
    if (!keyChangeAllowed && normalizedCustomerGstin(before.gstin) !== normalizedCustomerGstin(payload.gstin)) {
      return res.status(409).json({
        ok: false,
        error: "GSTIN_FROZEN",
        detail: "GSTIN is locked after create. SuperAdmin may allow a controlled key change.",
      });
    }
    const duplicates = await findDuplicateCustomers(client, duplicateSignalPayload(body), {
      excludeCustomerId: customerId,
      companyId,
    });
    const { blocking, advisory } = splitDuplicateTiers(duplicates);
    if (blocking.length && body.allow_duplicate !== true) {
      return res.status(409).json({
        ok: false,
        error: "POSSIBLE_DUPLICATE_CUSTOMER",
        duplicates: blocking,
        advisory_duplicates: advisory,
      });
    }
    const { rows } = await client.query(
      `
        update customers
        set customer_code = $2,
            customer_name = $3,
            legal_name = $4,
            website = $5,
            industry = $6,
            address_line1 = $7,
            address_line2 = $8,
            address_line3 = $9,
            city = $10,
            state = $11,
            pincode = $12,
            country_id = $13,
            phone = $14,
            fax = $15,
            email = $16,
            gstin = $17,
            tinno = $18,
            pan = $19,
            customer_type = $20,
            account_manager = $21,
            invoice_no = $22,
            invoice_date = $23,
            in_case_of_hospital = $24,
            credit_limit = $25,
            credit_control_mode = $26,
            is_credit_hold = $27,
            credit_hold_reason = $28,
            is_active = $29,
            updated_at = now()
        where id = $1
        returning *
      `,
      [
        customerId,
        payload.customer_code,
        payload.customer_name,
        payload.legal_name,
        payload.website,
        payload.industry,
        payload.address_line1,
        payload.address_line2,
        payload.address_line3,
        payload.city,
        payload.state,
        payload.pincode,
        Number.isFinite(payload.country_id) ? payload.country_id : null,
        payload.phone,
        payload.fax,
        payload.email,
        payload.gstin,
        payload.tinno,
        payload.pan,
        payload.customer_type,
        payload.account_manager,
        payload.invoice_no,
        payload.invoice_date,
        payload.in_case_of_hospital,
        payload.credit_limit,
        payload.credit_control_mode,
        payload.is_credit_hold,
        payload.credit_hold_reason,
        payload.is_active,
      ]
    );
    const customer = rows[0] || null;
    if (!customer) return res.status(404).json({ ok: false, error: "CUSTOMER_NOT_FOUND" });
    if (payload.is_credit_hold === true && before && before.is_credit_hold !== true) {
      notifyCreditHoldSet({
        customerId,
        customerName: customer.customer_name || payload.customer_name,
        companyId,
        actorUserId: req.user.id,
        reason: payload.credit_hold_reason || "",
        accountManager: customer.account_manager || payload.account_manager || null,
      }).catch(() => {});
    }
    return res.json({ ok: true, customer, duplicates });
  } catch (err) {
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/sites", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    await ensureCustomerVisible(client, req, customerId);
    await client.query("begin");
    const site = await upsertCustomerSite(client, customerId, null, req.body || {});
    await client.query("commit");
    return res.status(201).json({ ok: true, site });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || "SITE_SAVE_FAILED" });
  } finally {
    client.release();
  }
});

router.put("/:id/sites/:siteId", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    const siteId = Number(req.params.siteId);
    if (!Number.isFinite(customerId) || !Number.isFinite(siteId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER_SITE" });
    await ensureCustomerVisible(client, req, customerId);
    await client.query("begin");
    const site = await upsertCustomerSite(client, customerId, siteId, req.body || {});
    await client.query("commit");
    return res.json({ ok: true, site });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || "SITE_SAVE_FAILED" });
  } finally {
    client.release();
  }
});

router.post("/:id/contacts", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    await ensureCustomerVisible(client, req, customerId);
    await client.query("begin");
    const contact = await upsertCustomerContact(client, customerId, null, req.body || {});
    await client.query("commit");
    return res.status(201).json({ ok: true, contact });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || "CONTACT_SAVE_FAILED" });
  } finally {
    client.release();
  }
});

router.put("/:id/contacts/:contactId", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    const contactId = Number(req.params.contactId);
    if (!Number.isFinite(customerId) || !Number.isFinite(contactId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER_CONTACT" });
    await ensureCustomerVisible(client, req, customerId);
    await client.query("begin");
    const contact = await upsertCustomerContact(client, customerId, contactId, req.body || {});
    await client.query("commit");
    return res.json({ ok: true, contact });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || "CONTACT_SAVE_FAILED" });
  } finally {
    client.release();
  }
});

router.post("/:id/tax-registrations", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    await ensureCustomerVisible(client, req, customerId);
    await client.query("begin");
    const tax_registration = await upsertCustomerTaxRegistration(client, customerId, null, req.body || {});
    await client.query("commit");
    return res.status(201).json({ ok: true, tax_registration });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || "TAX_REGISTRATION_SAVE_FAILED" });
  } finally {
    client.release();
  }
});

router.put("/:id/tax-registrations/:taxId", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    const taxId = Number(req.params.taxId);
    if (!Number.isFinite(customerId) || !Number.isFinite(taxId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER_TAX" });
    await ensureCustomerVisible(client, req, customerId);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const existingTaxRes = await client.query(
      `select gstin from customer_tax_registrations where id = $1 and customer_id = $2 limit 1`,
      [taxId, customerId]
    );
    const existingTax = existingTaxRes.rows[0];
    if (!existingTax) return res.status(404).json({ ok: false, error: "CUSTOMER_TAX_REGISTRATION_NOT_FOUND" });
    const taxPayload = taxRegistrationPayload(body);
    if (
      !allowCustomerKeyChange(req, body) &&
      normalizedCustomerGstin(existingTax.gstin) !== normalizedCustomerGstin(taxPayload.gstin)
    ) {
      return res.status(409).json({
        ok: false,
        error: "GSTIN_FROZEN",
        detail: "GSTIN is locked after create. SuperAdmin may allow a controlled key change.",
      });
    }
    await client.query("begin");
    const tax_registration = await upsertCustomerTaxRegistration(client, customerId, taxId, body);
    await client.query("commit");
    return res.json({ ok: true, tax_registration });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return res.status(err?.status || 500).json({ ok: false, error: err?.message || "TAX_REGISTRATION_SAVE_FAILED" });
  } finally {
    client.release();
  }
});

function customerProductCodePayload(body = {}) {
  const src = body && typeof body === "object" ? body : {};
  return {
    productId: Number(src.product_id),
    customerItemCode: String(src.customer_item_code ?? "").trim(),
    customerItemDescription: String(src.customer_item_description ?? "").trim() || null,
    customerUom: String(src.customer_uom ?? "").trim() || null,
  };
}

async function fetchCustomerProductCodes(client, companyId, customerId) {
  const r = await client.query(
    `
      select
        cpm.id,
        cpm.company_id,
        cpm.customer_id,
        cpm.product_id,
        cpm.customer_item_code,
        cpm.customer_item_description,
        cpm.customer_uom,
        cpm.is_active,
        p.item_code,
        p.item_name
      from customer_product_maps cpm
      left join products p on p.id = cpm.product_id
      where cpm.company_id = $1
        and cpm.customer_id = $2
        and cpm.is_active = true
      order by coalesce(p.item_code, ''), cpm.id
    `,
    [companyId, customerId]
  );
  return r.rows;
}

function respondCustomerProductCodeError(res, err, fallback) {
  if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
  if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  if (err?.code === "23505") return res.status(409).json({ ok: false, error: "PRODUCT_CODE_ALREADY_MAPPED" });
  return res.status(err?.status || 500).json({ ok: false, error: err?.message || fallback });
}

router.get("/:id/product-codes", requireScreenAction("customers", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    await ensureCustomerVisible(client, req, customerId);
    const product_codes = await fetchCustomerProductCodes(client, companyId, customerId);
    return res.json({ ok: true, product_codes });
  } catch (err) {
    if (err?.message === "DISTRIBUTOR_NOT_LINKED") return res.status(400).json({ ok: false, error: "DISTRIBUTOR_NOT_LINKED" });
    if (err?.message === "FORBIDDEN") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/product-codes", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    await ensureCustomerVisible(client, req, customerId);

    const payload = customerProductCodePayload(req.body);
    if (!Number.isFinite(payload.productId) || payload.productId <= 0) {
      return res.status(400).json({ ok: false, error: "PRODUCT_REQUIRED" });
    }
    if (!payload.customerItemCode) {
      return res.status(400).json({ ok: false, error: "CUSTOMER_ITEM_CODE_REQUIRED" });
    }

    await client.query("begin");
    const r = await client.query(
      `
        insert into customer_product_maps (
          company_id, customer_id, product_id, customer_item_code, customer_item_description, customer_uom, created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (company_id, customer_id, product_id) where is_active = true
        do update set
          customer_item_code = excluded.customer_item_code,
          customer_item_description = excluded.customer_item_description,
          customer_uom = excluded.customer_uom,
          updated_at = now()
        returning id
      `,
      [
        companyId,
        customerId,
        payload.productId,
        payload.customerItemCode,
        payload.customerItemDescription,
        payload.customerUom,
        req.user?.id || null,
      ]
    );
    await client.query("commit");

    const product_codes = await fetchCustomerProductCodes(client, companyId, customerId);
    const product_code = product_codes.find((row) => Number(row.id) === Number(r.rows[0]?.id)) || null;
    return res.status(201).json({ ok: true, product_code, product_codes });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return respondCustomerProductCodeError(res, err, "PRODUCT_CODE_SAVE_FAILED");
  } finally {
    client.release();
  }
});

router.put("/:id/product-codes/:mapId", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    const mapId = Number(req.params.mapId);
    if (!Number.isFinite(customerId) || !Number.isFinite(mapId)) {
      return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER_PRODUCT_CODE" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    await ensureCustomerVisible(client, req, customerId);

    const payload = customerProductCodePayload(req.body);
    if (!payload.customerItemCode) {
      return res.status(400).json({ ok: false, error: "CUSTOMER_ITEM_CODE_REQUIRED" });
    }

    await client.query("begin");
    const r = await client.query(
      `
        update customer_product_maps
        set
          product_id = coalesce($4, product_id),
          customer_item_code = $5,
          customer_item_description = $6,
          customer_uom = $7,
          updated_at = now()
        where id = $1 and company_id = $2 and customer_id = $3
        returning id
      `,
      [
        mapId,
        companyId,
        customerId,
        Number.isFinite(payload.productId) && payload.productId > 0 ? payload.productId : null,
        payload.customerItemCode,
        payload.customerItemDescription,
        payload.customerUom,
      ]
    );
    if (!r.rows.length) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "PRODUCT_CODE_NOT_FOUND" });
    }
    await client.query("commit");

    const product_codes = await fetchCustomerProductCodes(client, companyId, customerId);
    const product_code = product_codes.find((row) => Number(row.id) === mapId) || null;
    return res.json({ ok: true, product_code, product_codes });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return respondCustomerProductCodeError(res, err, "PRODUCT_CODE_SAVE_FAILED");
  } finally {
    client.release();
  }
});

router.delete("/:id/product-codes/:mapId", requireScreenAction("customers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const customerId = Number(req.params.id);
    const mapId = Number(req.params.mapId);
    if (!Number.isFinite(customerId) || !Number.isFinite(mapId)) {
      return res.status(400).json({ ok: false, error: "INVALID_CUSTOMER_PRODUCT_CODE" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    await ensureCustomerVisible(client, req, customerId);

    await client.query("begin");
    const r = await client.query(
      `
        update customer_product_maps
        set is_active = false,
            updated_at = now()
        where id = $1 and company_id = $2 and customer_id = $3 and is_active = true
        returning id
      `,
      [mapId, companyId, customerId]
    );
    if (!r.rows.length) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "PRODUCT_CODE_NOT_FOUND" });
    }
    await client.query("commit");

    const product_codes = await fetchCustomerProductCodes(client, companyId, customerId);
    return res.json({ ok: true, product_codes });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return respondCustomerProductCodeError(res, err, "PRODUCT_CODE_DELETE_FAILED");
  } finally {
    client.release();
  }
});

module.exports = router;
