const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const { pool } = require("../db/pool");
const { createOwnedAttachment } = require("../services/attachmentOwnership");
const { buildCompanyProfilePayload, getCompanyProfile, normalizeCompanyProfile } = require("../services/companyProfile");
const { hasScreenAction } = require("../auth/authorization");
const { checkTypedConfirm } = require("../auth/typedConfirm");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireAdminMastersAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name === "SuperAdmin") return next();
  if (hasScreenAction(req, "admin_masters", "can_view") || hasScreenAction(req, "admin_masters", "can_edit")) return next();
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

function requireAdminMastersEdit(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name === "SuperAdmin") return next();
  if (hasScreenAction(req, "admin_masters", "can_edit") || hasScreenAction(req, "admin_masters", "can_create")) return next();
  return res.status(403).json({ ok: false, error: "FORBIDDEN" });
}

/** Hard deletes of master data are SuperAdmin-only (ERP Admin may edit/deactivate, not destroy). */
function requireSuperAdminHardDelete(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name !== "SuperAdmin") {
    return res.status(403).json({
      ok: false,
      error: "SUPERADMIN_DELETE_ONLY",
      detail: "Permanent master deletes require SuperAdmin.",
    });
  }
  return next();
}

function cleanText(v) {
  return typeof v === "string" ? v.trim() : "";
}

function cleanNullable(v) {
  const s = cleanText(v);
  return s.length ? s : null;
}

function cleanBool(v, defaultValue = true) {
  if (v === undefined || v === null) return defaultValue;
  return v === true || v === "true" || v === 1 || v === "1";
}

function cleanInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanCommercialType(v) {
  const value = cleanText(v);
  return ["payment_term", "freight_term", "p_and_f_term", "incoterm", "tax_mode"].includes(value) ? value : "";
}

function cleanVendorPayload(body) {
  return {
    vendor_code: cleanNullable(body.vendor_code),
    company_name: cleanText(body.company_name),
    country_id: cleanInt(body.country_id),
    gstin: cleanNullable(body.gstin),
    pan_no: cleanNullable(body.pan_no),
    address_line1: cleanNullable(body.address_line1),
    address_line2: cleanNullable(body.address_line2),
    address_line3: cleanNullable(body.address_line3),
    city: cleanNullable(body.city),
    state: cleanNullable(body.state),
    pincode: cleanNullable(body.pincode),
    contact_name: cleanNullable(body.contact_name),
    contact_email: cleanNullable(body.contact_email),
    contact_phone: cleanNullable(body.contact_phone),
    msme_registered: cleanBool(body.msme_registered, false),
    tds_enabled: cleanBool(body.tds_enabled, false),
    tds_exempt: cleanBool(body.tds_exempt, false),
    tds_section_id: cleanInt(body.tds_section_id),
    lower_deduction_rate: body.lower_deduction_rate === "" ? null : cleanNumber(body.lower_deduction_rate),
    is_active: cleanBool(body.is_active, true),
  };
}

function safeFileSegment(v) {
  const s = String(v || "");
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned || "file";
}

function ensureCompanyProfileAssetDir() {
  const dir = path.resolve(__dirname, "..", "..", "storage", "company_profile");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getImageExtension(file) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const name = String(file?.originalname || "").toLowerCase();
  if (mime === "image/png" || name.endsWith(".png")) return { ext: ".png", mimeType: "image/png" };
  if (mime === "image/jpeg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) return { ext: ".jpg", mimeType: "image/jpeg" };
  if (mime === "image/webp" || name.endsWith(".webp")) return { ext: ".webp", mimeType: "image/webp" };
  if (mime === "image/svg+xml" || name.endsWith(".svg")) return { ext: ".svg", mimeType: "image/svg+xml" };
  return null;
}

async function ensureCompanyProfileRow(client, companyId, userId) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const err = new Error("INVALID_COMPANY");
    err.status = 400;
    throw err;
  }
  const companyRes = await client.query(
    `
      select id, company_code, legal_name, display_name, gstin, pan, address_line1, address_line2, address_line3, city, state, state_code, pincode, country, contact_email, contact_phone
      from companies
      where id = $1 and is_active = true
      limit 1
    `,
    [cid]
  );
  const company = companyRes.rows[0];
  if (!company) {
    const err = new Error("COMPANY_NOT_FOUND");
    err.status = 404;
    throw err;
  }
  await client.query(
    `
      insert into company_profiles_v2 (
        company_id,
        company_name,
        gstin,
        pan,
        address_line1,
        address_line2,
        address_line3,
        city,
        state,
        state_code,
        pincode,
        country,
        contact_email,
        contact_phone,
        updated_by,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
      on conflict (company_id) do nothing
    `,
    [
      cid,
      company.display_name || company.legal_name || "Company",
      company.gstin || null,
      company.pan || null,
      company.address_line1 || null,
      company.address_line2 || null,
      company.address_line3 || null,
      company.city || null,
      company.state || null,
      company.state_code || null,
      company.pincode || null,
      company.country || null,
      company.contact_email || null,
      company.contact_phone || null,
      userId,
    ]
  );
}

async function getActiveCompany(client, companyId) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const err = new Error("INVALID_COMPANY");
    err.status = 400;
    throw err;
  }
  const companyRes = await client.query(
    `
      select id, company_code, legal_name, coalesce(display_name, legal_name) as display_name
      from companies
      where id = $1 and is_active = true
      limit 1
    `,
    [cid]
  );
  const company = companyRes.rows[0] || null;
  if (!company) {
    const err = new Error("COMPANY_NOT_FOUND");
    err.status = 404;
    throw err;
  }
  return company;
}

async function loadCompanyProfiles() {
  const companiesRes = await pool.query(
    `
      select id, company_code, legal_name, coalesce(display_name, legal_name) as display_name
      from companies
      where is_active = true
      order by company_code asc
    `
  );

  const profiles = [];
  for (const company of companiesRes.rows) {
    const profile = await getCompanyProfile(pool, company.id);
    profiles.push({
      company_id: Number(company.id),
      company_code: String(company.company_code || "").trim(),
      legal_name: String(company.legal_name || "").trim(),
      display_name: String(company.display_name || company.legal_name || "").trim(),
      profile: normalizeCompanyProfile(profile),
    });
  }
  return profiles;
}

async function saveCompanyProfileImageAttachment(client, { file, key, uploadedBy, companyId }) {
  const meta = getImageExtension(file);
  if (!meta) {
    const err = new Error("INVALID_FILE_TYPE");
    err.status = 400;
    throw err;
  }
  const dir = ensureCompanyProfileAssetDir();
  const fileName = `${safeFileSegment(key)}_${Date.now()}${meta.ext}`;
  const absFilePath = path.join(dir, fileName);
  fs.writeFileSync(absFilePath, file.buffer);
  const row = await createOwnedAttachment(client, {
    fileName: file.originalname || fileName,
    filePath: absFilePath,
    mimeType: meta.mimeType,
    fileSizeBytes: file.size || file.buffer.length || 0,
    uploadedBy,
    companyId,
    ownerType: "company_profile",
    ownerId: companyId,
  });
  return Number(row?.id || 0);
}

const MASTER_CONFIG = {
  countries: {
    table: "countries",
    codeField: "iso_code",
    nameField: "country_name",
    extraFields: [],
    orderBy: "country_name asc",
  },
  states: {
    table: "states",
    codeField: "state_code",
    nameField: "state_name",
    extraFields: ["country_id"],
    orderBy: "state_name asc",
  },
  cities: {
    table: "cities",
    codeField: "city_code",
    nameField: "city_name",
    extraFields: ["country_id", "state_id"],
    orderBy: "city_name asc",
  },
  currencies: {
    table: "currencies",
    codeField: "currency_code",
    nameField: "currency_name",
    extraFields: ["symbol", "decimal_precision"],
    orderBy: "currency_code asc",
  },
  exchange_rates: {
    table: "exchange_rates",
    codeField: null,
    nameField: "rate_value",
    nameFieldType: "number",
    extraFields: ["from_currency_id", "to_currency_id", "rate_date", "source_type"],
    orderBy: "rate_date desc, id desc",
  },
  incoterms: {
    table: "incoterms",
    codeField: "incoterm_code",
    nameField: "incoterm_name",
    extraFields: [],
    orderBy: "incoterm_code asc",
  },
  payment_terms: {
    table: "payment_terms",
    codeField: "term_code",
    nameField: "term_name",
    extraFields: ["credit_days"],
    orderBy: "term_code asc",
  },
  freight_terms: {
    table: "freight_terms",
    codeField: "term_code",
    nameField: "term_name",
    extraFields: [],
    orderBy: "term_code asc",
  },
  p_and_f_terms: {
    table: "p_and_f_terms",
    codeField: "term_code",
    nameField: "term_name",
    extraFields: [],
    orderBy: "term_code asc",
  },
  terms_master: {
    table: "terms_master",
    codeField: null,
    nameField: "caption",
    extraFields: ["default_description", "sort_order"],
    // Columns from migration 199; written only once they exist.
    optionalExtraFields: ["applies_to", "spares_description"],
    orderBy: "sort_order asc, caption asc",
  },
  price_types: {
    table: "price_types",
    codeField: "price_type_code",
    nameField: "price_type_name",
    extraFields: ["multiplier", "sort_order"],
    orderBy: "sort_order asc, price_type_name asc",
  },
  tax_codes: {
    table: "tax_codes",
    codeField: "tax_code",
    nameField: "tax_name",
    extraFields: ["tax_rate"],
    orderBy: "tax_code asc",
  },
  lead_sources: {
    table: "lead_sources",
    codeField: "source_code",
    nameField: "source_name",
    extraFields: [],
    orderBy: "source_code asc",
  },
  quote_closure_reasons: {
    table: "quote_closure_reasons",
    codeField: "reason_code",
    nameField: "reason_name",
    extraFields: ["sort_order"],
    orderBy: "sort_order asc, reason_name asc",
  },
  roles: {
    table: "roles",
    idField: "id",
    codeField: "role_key",
    nameField: "role_name",
    extraFields: ["default_workspace_family"],
    orderBy: "role_name asc",
  },
  departments: {
    table: "departments",
    idField: "department_key",
    codeField: "department_key",
    nameField: "department_name",
    extraFields: ["sort_order", "default_workspace_family"],
    orderBy: "sort_order asc, department_name asc",
  },
  user_groups: {
    table: "user_groups",
    idField: "id",
    codeField: null,
    nameField: "group_name",
    extraFields: ["max_autonomous_discount_pct"],
    orderBy: "group_name asc",
  },
  erp_modules: {
    table: "erp_modules",
    codeField: "module_key",
    nameField: "module_name",
    extraFields: [],
    orderBy: "module_name asc",
  },
  designations: {
    table: "designations",
    codeField: null,
    nameField: "designation_name",
    extraFields: ["sort_order"],
    orderBy: "sort_order asc, designation_name asc",
  },
};

async function loadBootstrap({ vendorCompanyId = null } = {}) {
  const vendorCompany = cleanInt(vendorCompanyId);
  const [
    countriesRes,
    statesRes,
    citiesRes,
    companyProfiles,
    distRes,
    vendorsRes,
    tdsSectionsRes,
    currenciesRes,
    exchangeRatesRes,
    incotermsRes,
    paymentRes,
    freightRes,
    pAndFTermsRes,
    priceTypesRes,
    taxRes,
    leadSourcesRes,
    quoteClosureReasonsRes,
    rolesRes,
    departmentsRes,
    userGroupsRes,
    modulesRes,
    designationsRes,
    termsMasterRes,
  ] =
    await Promise.all([
      pool.query(
        `
          select id, iso_code, country_name, is_active
          from countries
          order by country_name asc
        `
      ),
      pool.query(
        `
          select
            s.id,
            s.country_id,
            c.country_name,
            c.iso_code as country_code,
            s.state_code,
            s.state_name,
            s.is_active
          from states s
          join countries c on c.id = s.country_id
          order by c.country_name asc, s.state_name asc
        `
      ),
      pool.query(
        `
          select
            ci.id,
            ci.country_id,
            ci.state_id,
            c.country_name,
            c.iso_code as country_code,
            s.state_name,
            s.state_code,
            ci.city_code,
            ci.city_name,
            ci.is_active
          from cities ci
          join countries c on c.id = ci.country_id
          join states s on s.id = ci.state_id
          order by c.country_name asc, s.state_name asc, ci.city_name asc
        `
      ),
      loadCompanyProfiles(),
      pool.query(
        `
          select
            d.id,
            d.distributor_code,
            d.company_name,
            d.country_id,
            c.country_name,
            d.contact_email,
            d.contact_phone,
            (ma.id is not null) as shared_mail_connected,
            ma.mailbox_email as shared_mailbox_email,
            d.is_active,
            d.updated_at
          from distributors d
          left join countries c on c.id = d.country_id
          left join mail_accounts ma
            on ma.owner_type = 'distributor'
            and ma.distributor_id = d.id
            and ma.provider = 'google'
            and ma.is_active = true
          order by d.company_name asc
        `
      ),
      pool.query(
        `
          select
            v.id,
            v.vendor_code,
            v.company_name,
            v.company_id,
            v.country_id,
            c.country_name,
            v.gstin,
            v.pan_no,
            v.address_line1,
            v.address_line2,
            v.address_line3,
            v.city,
            v.state,
            v.pincode,
            v.contact_name,
            v.contact_email,
            v.contact_phone,
            v.msme_registered,
            v.tds_enabled,
            v.tds_exempt,
            v.tds_section_id,
            ts.section_code as tds_section_code,
            ts.section_name as tds_section_name,
            v.lower_deduction_rate,
            v.is_active,
            v.updated_at
          from vendors v
          left join countries c on c.id = v.country_id
          left join tds_sections ts on ts.id = v.tds_section_id
          where ($1::int is null or v.company_id = $1::int)
          order by v.company_name asc
        `,
        [vendorCompany]
      ),
      pool.query(
        `
          select id, section_code, section_name, default_rate, threshold_amount, is_active
          from tds_sections
          order by section_code asc
        `
      ),
      pool.query(`select id, currency_code, currency_name, symbol, decimal_precision, is_active from currencies order by currency_code asc`),
      pool
        .query(`select to_regclass('public.exchange_rates') is not null as ready`)
        .then((r) =>
          r.rows[0]?.ready
            ? pool.query(
                `
                  select
                    er.id,
                    er.from_currency_id,
                    er.to_currency_id,
                    er.rate_value,
                    er.rate_date,
                    er.source_type,
                    er.is_active,
                    fc.currency_code as from_currency_code,
                    fc.currency_name as from_currency_name,
                    tc.currency_code as to_currency_code,
                    tc.currency_name as to_currency_name,
                    er.created_at
                  from exchange_rates er
                  join currencies fc on fc.id = er.from_currency_id
                  join currencies tc on tc.id = er.to_currency_id
                  order by er.rate_date desc, er.id desc
                `
              )
            : { rows: [] }
        ),
      pool.query(`select id, incoterm_code, incoterm_name, is_active from incoterms order by incoterm_code asc`),
      pool.query(`select id, term_code, term_name, credit_days, is_active from payment_terms order by term_code asc`),
      pool.query(`select id, term_code, term_name, is_active from freight_terms order by term_code asc`),
      pool.query(`select id, term_code, term_name, is_active from p_and_f_terms order by term_code asc`),
      pool.query(
        `select id, price_type_code, price_type_name, multiplier, sort_order, is_active from price_types order by sort_order asc, price_type_name asc`
      ),
      pool.query(`select id, tax_code, tax_name, tax_rate, is_active from tax_codes order by tax_code asc`),
      pool.query(`select id, source_code, source_name, is_active from lead_sources order by source_code asc`),
      pool
        .query(`select to_regclass('public.quote_closure_reasons') is not null as ready`)
        .then((r) =>
          r.rows[0]?.ready
            ? pool.query(
                `
                  select id, reason_code, reason_name, sort_order, is_active, updated_at
                  from quote_closure_reasons
                  order by sort_order asc, reason_name asc
                `
              )
            : { rows: [] }
        ),
      pool.query(`select id, role_key, role_name, default_workspace_family, is_active from roles order by role_name asc`),
      pool.query(
        `select department_key, department_name, sort_order, default_workspace_family, is_active from departments order by sort_order asc, department_name asc`
      ),
      pool.query(
        `select id, group_name, max_autonomous_discount_pct, is_active, updated_at from user_groups order by group_name asc`
      ),
      pool.query(`select id, module_key, module_name, is_active from erp_modules order by module_name asc`),
      pool
        .query(`select to_regclass('public.designations') is not null as ready`)
        .then((r) =>
          r.rows[0]?.ready
            ? pool.query(`select id, designation_name, sort_order, is_active from designations order by sort_order asc, designation_name asc`)
            : { rows: [] }
        ),
      pool
        .query(
          `select count(*)::int = 2 as ready from information_schema.columns
           where table_schema = current_schema() and table_name = 'terms_master' and column_name in ('applies_to', 'spares_description')`
        )
        .then((r) =>
          pool.query(
            `
              select id, sort_order, caption, default_description,
                ${r.rows[0]?.ready ? "applies_to, spares_description," : ""}
                is_active
              from terms_master
              order by sort_order asc, id asc
            `
          )
        ),
    ]);

  return {
    countries: countriesRes.rows,
    states: statesRes.rows,
    cities: citiesRes.rows,
    company_profiles: companyProfiles,
    distributors: distRes.rows,
    vendors: vendorsRes.rows,
    tds_sections: tdsSectionsRes.rows,
    currencies: currenciesRes.rows,
    exchange_rates: exchangeRatesRes.rows,
    incoterms: incotermsRes.rows,
    payment_terms: paymentRes.rows,
    freight_terms: freightRes.rows,
    p_and_f_terms: pAndFTermsRes.rows,
    price_types: priceTypesRes.rows,
    tax_codes: taxRes.rows,
    lead_sources: leadSourcesRes.rows,
    quote_closure_reasons: quoteClosureReasonsRes.rows,
    roles: rolesRes.rows,
    departments: departmentsRes.rows,
    user_groups: userGroupsRes.rows,
    erp_modules: modulesRes.rows,
    designations: designationsRes.rows,
    terms_master: termsMasterRes.rows,
  };
}

function cleanMasterPrimaryValue(config, raw) {
  if (config?.nameFieldType === "number") {
    if (raw === "" || raw === undefined || raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  return cleanText(raw);
}

function cleanMasterExtraValue(field, raw) {
  if (field === "country_id" || field === "state_id" || field === "from_currency_id" || field === "to_currency_id") {
    return raw === "" || raw === undefined || raw === null ? null : Number(raw);
  }
  if (field === "decimal_precision" || field === "credit_days") {
    return raw === "" || raw === undefined || raw === null ? null : Number(raw);
  }
  if (field === "multiplier") {
    return raw === "" || raw === undefined || raw === null ? 1 : Number(raw);
  }
  if (field === "tax_rate" || field === "max_autonomous_discount_pct" || field === "sort_order" || field === "rate_value") {
    return raw === "" || raw === undefined || raw === null ? 0 : Number(raw);
  }
  if (field === "applies_to") {
    const value = String(raw || "").trim().toLowerCase();
    return ["all", "completes", "spares"].includes(value) ? value : "all";
  }
  return cleanNullable(raw);
}

async function writableExtraFields(config, body, { forUpdate = false } = {}) {
  const optional = Array.isArray(config.optionalExtraFields) ? config.optionalExtraFields : [];
  if (!optional.length) return config.extraFields;
  const r = await pool.query(
    `select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1 and column_name = any($2::text[])`,
    [config.table, optional]
  );
  const present = new Set(r.rows.map((row) => row.column_name));
  return [
    ...config.extraFields,
    ...optional.filter((field) => present.has(field) && (!forUpdate || Object.prototype.hasOwnProperty.call(body, field))),
  ];
}

router.use(requireAuth);
router.use(requireAdminMastersAccess);

router.get("/bootstrap", async (req, res, next) => {
  try {
    const vendorCompanyId = cleanInt(req.query.company_id);
    return res.json({ ok: true, ...(await loadBootstrap({ vendorCompanyId })) });
  } catch (err) {
    return next(err);
  }
});

router.post("/company-profile/:assetKey", requireAdminMastersEdit, upload.single("file"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const assetKey = String(req.params.assetKey || "").trim().toLowerCase();
    if (!["logo", "signature"].includes(assetKey)) return res.status(404).json({ ok: false });
    if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });
    const companyId = cleanInt(req.body?.company_id);
    await client.query("begin");
    const company = await getActiveCompany(client, companyId);
    await ensureCompanyProfileRow(client, company.id, req.user.id);
    const attachmentId = await saveCompanyProfileImageAttachment(client, {
      file: req.file,
      key: `${String(company.company_code || "company").toLowerCase()}_${assetKey}`,
      uploadedBy: req.user.id,
      companyId: company.id,
    });
    const column = assetKey === "logo" ? "logo_attachment_id" : "signature_attachment_id";
    await client.query(`update company_profiles_v2 set ${column} = $1, updated_by = $2, updated_at = now() where company_id = $3`, [
      attachmentId,
      req.user.id,
      company.id,
    ]);
    await client.query("commit");
    return res.json({ ok: true, company_profile: await getCompanyProfile(pool, company.id) });
  } catch (err) {
    await client.query("rollback");
    if (err?.status === 400 || err?.status === 404) return res.status(err.status).json({ ok: false, error: err.message || "INVALID_FILE" });
    return next(err);
  } finally {
    client.release();
  }
});

router.delete("/company-profile/:assetKey", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const assetKey = String(req.params.assetKey || "").trim().toLowerCase();
    if (!["logo", "signature"].includes(assetKey)) return res.status(404).json({ ok: false });
    const companyId = cleanInt(req.query.company_id);
    const company = await getActiveCompany(pool, companyId);
    const column = assetKey === "logo" ? "logo_attachment_id" : "signature_attachment_id";
    await pool.query(`update company_profiles_v2 set ${column} = null, updated_by = $1, updated_at = now() where company_id = $2`, [req.user.id, company.id]);
    return res.json({ ok: true, company_profile: await getCompanyProfile(pool, company.id) });
  } catch (err) {
    if (err?.status === 400 || err?.status === 404) return res.status(err.status).json({ ok: false, error: err.message || "INVALID_COMPANY" });
    return next(err);
  }
});

router.put("/company-profile", requireAdminMastersEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = cleanInt(body.company_id);
    await client.query("begin");
    const company = await getActiveCompany(client, companyId);
    await ensureCompanyProfileRow(client, company.id, req.user.id);
    const payload = buildCompanyProfilePayload(body);
    if (!cleanText(body.company_name)) {
      payload.company_name = cleanText(company.display_name) || cleanText(company.legal_name) || payload.company_name;
    }
    const r = await client.query(
      `
        update company_profiles_v2
        set
          company_name = $1,
          website = $2,
          address_line1 = $3,
          address_line2 = $4,
          address_line3 = $5,
          city = $6,
          state = $7,
          state_code = $8,
          pincode = $9,
          country = $10,
          gstin = $11,
          pan = $12,
          contact_name = $13,
          contact_email = $14,
          contact_phone = $15,
          bank_name = $16,
          bank_branch = $17,
          account_name = $18,
          account_no = $19,
          ifsc = $20,
          invoice_declaration = $21,
          updated_by = $22
          ,
          updated_at = now()
        where company_id = $23
        returning company_id
      `,
      [
        payload.company_name,
        payload.website,
        payload.address_line1,
        payload.address_line2,
        payload.address_line3,
        payload.city,
        payload.state,
        payload.state_code,
        payload.pincode,
        payload.country,
        payload.gstin,
        payload.pan,
        payload.contact_name,
        payload.contact_email,
        payload.contact_phone,
        payload.bank_name,
        payload.bank_branch,
        payload.account_name,
        payload.account_no,
        payload.ifsc,
        payload.invoice_declaration,
        req.user.id,
        company.id,
      ]
    );
    await client.query("commit");
    return res.json({ ok: true, company_profile: await getCompanyProfile(pool, r.rows[0]?.company_id || company.id) });
  } catch (err) {
    await client.query("rollback");
    if (err?.status === 400 || err?.status === 404) return res.status(err.status).json({ ok: false, error: err.message || "INVALID_COMPANY" });
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/distributors", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyName = cleanText(body.company_name);
    if (!companyName) return res.status(400).json({ ok: false, error: "COMPANY_NAME_REQUIRED" });

    const r = await pool.query(
      `
        insert into distributors (
          distributor_code,
          company_name,
          country_id,
          contact_email,
          contact_phone,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,$6,now())
        returning *
      `,
      [
        cleanNullable(body.distributor_code),
        companyName,
        cleanInt(body.country_id),
        cleanNullable(body.contact_email),
        cleanNullable(body.contact_phone),
        cleanBool(body.is_active, true),
      ]
    );
    return res.status(201).json({ ok: true, distributor: r.rows[0] });
  } catch (err) {
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_DISTRIBUTOR" });
    return next(err);
  }
});

router.put("/distributors/:id", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyName = cleanText(body.company_name);
    if (!companyName) return res.status(400).json({ ok: false, error: "COMPANY_NAME_REQUIRED" });

    const r = await pool.query(
      `
        update distributors
        set
          distributor_code = $1,
          company_name = $2,
          country_id = $3,
          contact_email = $4,
          contact_phone = $5,
          is_active = $6,
          updated_at = now()
        where id = $7
        returning *
      `,
      [
        cleanNullable(body.distributor_code),
        companyName,
        cleanInt(body.country_id),
        cleanNullable(body.contact_email),
        cleanNullable(body.contact_phone),
        cleanBool(body.is_active, true),
        id,
      ]
    );
    const distributor = r.rows[0] || null;
    if (!distributor) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, distributor });
  } catch (err) {
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_DISTRIBUTOR" });
    return next(err);
  }
});

router.post("/vendors", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const companyId = cleanInt(req.body?.company_id);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const companyRes = await pool.query(`select id from companies where id = $1 limit 1`, [companyId]);
    if (!companyRes.rows[0]?.id) return res.status(400).json({ ok: false, error: "INVALID_COMPANY" });
    const payload = cleanVendorPayload(req.body && typeof req.body === "object" ? req.body : {});
    if (!payload.company_name) return res.status(400).json({ ok: false, error: "COMPANY_NAME_REQUIRED" });

    const r = await pool.query(
      `
        insert into vendors (
          company_id,
          vendor_code,
          company_name,
          country_id,
          gstin,
          pan_no,
          address_line1,
          address_line2,
          address_line3,
          city,
          state,
          pincode,
          contact_name,
          contact_email,
          contact_phone,
          msme_registered,
          tds_enabled,
          tds_exempt,
          tds_section_id,
          lower_deduction_rate,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
        returning *
      `,
      [
        companyId,
        payload.vendor_code,
        payload.company_name,
        payload.country_id,
        payload.gstin,
        payload.pan_no,
        payload.address_line1,
        payload.address_line2,
        payload.address_line3,
        payload.city,
        payload.state,
        payload.pincode,
        payload.contact_name,
        payload.contact_email,
        payload.contact_phone,
        payload.msme_registered,
        payload.tds_enabled,
        payload.tds_exempt,
        payload.tds_section_id,
        payload.lower_deduction_rate,
        payload.is_active,
      ]
    );
    return res.status(201).json({ ok: true, vendor: r.rows[0] });
  } catch (err) {
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_VENDOR" });
    return next(err);
  }
});

router.put("/vendors/:id", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const companyId = cleanInt(req.body?.company_id);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });
    const companyRes = await pool.query(`select id from companies where id = $1 limit 1`, [companyId]);
    if (!companyRes.rows[0]?.id) return res.status(400).json({ ok: false, error: "INVALID_COMPANY" });
    const payload = cleanVendorPayload(req.body && typeof req.body === "object" ? req.body : {});
    if (!payload.company_name) return res.status(400).json({ ok: false, error: "COMPANY_NAME_REQUIRED" });

    const existingVendorRes = await pool.query(
      `select vendor_code, gstin from vendors where id = $1 and company_id = $2 limit 1`,
      [id, companyId]
    );
    const existingVendor = existingVendorRes.rows[0];
    if (!existingVendor) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const keyChangeAllowed = req.user?.group_name === "SuperAdmin" && req.body?.allow_key_change === true;
    const dbVendorCode = String(existingVendor.vendor_code ?? "").trim();
    const incomingVendorCode = String(payload.vendor_code ?? "").trim();
    if (dbVendorCode && !keyChangeAllowed) {
      if (incomingVendorCode && dbVendorCode.toLowerCase() !== incomingVendorCode.toLowerCase()) {
        return res.status(409).json({
          ok: false,
          error: "VENDOR_CODE_FROZEN",
          detail: "Vendor code is locked after create. Use controlled rename/merge.",
        });
      }
      payload.vendor_code = dbVendorCode;
    }
    const dbGstin = String(existingVendor.gstin ?? "").trim().toUpperCase();
    const incomingGstin = String(payload.gstin ?? "").trim().toUpperCase();
    if (dbGstin && !keyChangeAllowed && dbGstin !== incomingGstin) {
      return res.status(409).json({
        ok: false,
        error: "GSTIN_FROZEN",
        detail: "GSTIN is locked after create. SuperAdmin may allow a controlled key change.",
      });
    }

    const r = await pool.query(
      `
        update vendors
        set
          vendor_code = $1,
          company_name = $2,
          country_id = $3,
          gstin = $4,
          pan_no = $5,
          address_line1 = $6,
          address_line2 = $7,
          address_line3 = $8,
          city = $9,
          state = $10,
          pincode = $11,
          contact_name = $12,
          contact_email = $13,
          contact_phone = $14,
          msme_registered = $15,
          tds_enabled = $16,
          tds_exempt = $17,
          tds_section_id = $18,
          lower_deduction_rate = $19,
          is_active = $20,
          updated_at = now()
        where id = $21 and company_id = $22
        returning *
      `,
      [
        payload.vendor_code,
        payload.company_name,
        payload.country_id,
        payload.gstin,
        payload.pan_no,
        payload.address_line1,
        payload.address_line2,
        payload.address_line3,
        payload.city,
        payload.state,
        payload.pincode,
        payload.contact_name,
        payload.contact_email,
        payload.contact_phone,
        payload.msme_registered,
        payload.tds_enabled,
        payload.tds_exempt,
        payload.tds_section_id,
        payload.lower_deduction_rate,
        payload.is_active,
        id,
        companyId,
      ]
    );
    const vendor = r.rows[0] || null;
    if (!vendor) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, vendor });
  } catch (err) {
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_VENDOR" });
    return next(err);
  }
});

router.post("/commercial-term-mappings", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const commercialType = cleanCommercialType(body.commercial_type);
    const commercialValue = cleanText(body.commercial_value);
    const termMasterId = cleanInt(body.term_master_id);
    if (!commercialType || !commercialValue || !termMasterId) {
      return res.status(400).json({ ok: false, error: "COMMERCIAL_MAPPING_REQUIRED" });
    }

    const termRes = await pool.query(`select id from terms_master where id = $1 limit 1`, [termMasterId]);
    if (!termRes.rows[0]?.id) return res.status(400).json({ ok: false, error: "INVALID_TERM_MASTER" });

    const r = await pool.query(
      `
        insert into commercial_term_mappings (
          commercial_type,
          commercial_value,
          term_master_id,
          override_description,
          is_active,
          updated_at
        )
        values ($1,$2,$3,$4,$5,now())
        returning *
      `,
      [
        commercialType,
        commercialValue,
        termMasterId,
        cleanNullable(body.override_description),
        cleanBool(body.is_active, true),
      ]
    );
    return res.status(201).json({ ok: true, item: r.rows[0] });
  } catch (err) {
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_COMMERCIAL_MAPPING" });
    return next(err);
  }
});

router.put("/commercial-term-mappings/:id", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const commercialType = cleanCommercialType(body.commercial_type);
    const commercialValue = cleanText(body.commercial_value);
    const termMasterId = cleanInt(body.term_master_id);
    if (!commercialType || !commercialValue || !termMasterId) {
      return res.status(400).json({ ok: false, error: "COMMERCIAL_MAPPING_REQUIRED" });
    }

    const termRes = await pool.query(`select id from terms_master where id = $1 limit 1`, [termMasterId]);
    if (!termRes.rows[0]?.id) return res.status(400).json({ ok: false, error: "INVALID_TERM_MASTER" });

    const r = await pool.query(
      `
        update commercial_term_mappings
        set
          commercial_type = $1,
          commercial_value = $2,
          term_master_id = $3,
          override_description = $4,
          is_active = $5,
          updated_at = now()
        where id = $6
        returning *
      `,
      [
        commercialType,
        commercialValue,
        termMasterId,
        cleanNullable(body.override_description),
        cleanBool(body.is_active, true),
        id,
      ]
    );
    const item = r.rows[0] || null;
    if (!item) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, item });
  } catch (err) {
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_COMMERCIAL_MAPPING" });
    return next(err);
  }
});

router.post("/:resource", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const resource = req.params.resource;
    const config = MASTER_CONFIG[resource];
    if (!config) return res.status(404).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const codeValue = config.codeField ? cleanText(body[config.codeField]) : null;
    const nameValue = cleanMasterPrimaryValue(config, body[config.nameField]);
    if ((config.codeField && !codeValue) || !nameValue) {
      return res.status(400).json({ ok: false, error: config.codeField ? "CODE_AND_NAME_REQUIRED" : "NAME_REQUIRED" });
    }

    const values = [];
    const columns = [];
    const placeholders = [];

    if (config.codeField) {
      values.push(codeValue);
      columns.push(config.codeField);
      placeholders.push(`$${values.length}`);
    }
    values.push(nameValue);
    columns.push(config.nameField);
    placeholders.push(`$${values.length}`);

    for (const field of await writableExtraFields(config, body)) {
      columns.push(field);
      values.push(cleanMasterExtraValue(field, body[field]));
      placeholders.push(`$${values.length}`);
    }

    columns.push("is_active");
    values.push(cleanBool(body.is_active, true));
    placeholders.push(`$${values.length}`);

    const r = await pool.query(
      `
        insert into ${config.table} (${columns.join(", ")})
        values (${placeholders.join(", ")})
        returning *
      `,
      values
    );
    return res.status(201).json({ ok: true, item: r.rows[0] });
  } catch (err) {
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_MASTER" });
    return next(err);
  }
});

router.put("/:resource/:id", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const resource = req.params.resource;
    const config = MASTER_CONFIG[resource];
    if (!config) return res.status(404).json({ ok: false });
    const idField = config.idField || "id";
    const id = idField === "id" ? Number(req.params.id) : cleanText(req.params.id);
    if ((idField === "id" && !Number.isFinite(id)) || (idField !== "id" && !id)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const codeValue = config.codeField ? cleanText(body[config.codeField]) : null;
    const nameValue = cleanMasterPrimaryValue(config, body[config.nameField]);
    if ((config.codeField && !codeValue) || !nameValue) {
      return res.status(400).json({ ok: false, error: config.codeField ? "CODE_AND_NAME_REQUIRED" : "NAME_REQUIRED" });
    }

    const sets = [];
    const values = [];

    if (config.codeField) {
      values.push(codeValue);
      sets.push(`${config.codeField} = $${values.length}`);
    }
    values.push(nameValue);
    sets.push(`${config.nameField} = $${values.length}`);

    for (const field of await writableExtraFields(config, body, { forUpdate: true })) {
      const value = cleanMasterExtraValue(field, body[field]);
      values.push(value);
      sets.push(`${field} = $${values.length}`);
    }

    values.push(cleanBool(body.is_active, true));
    sets.push(`is_active = $${values.length}`);
    values.push(id);

    const r = await pool.query(
      `
        update ${config.table}
        set ${sets.join(", ")}
        where ${idField} = $${values.length}
        returning *
      `,
      values
    );
    const item = r.rows[0] || null;
    if (!item) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, item });
  } catch (err) {
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_MASTER" });
    return next(err);
  }
});

router.delete("/:resource/:id", requireSuperAdminHardDelete, async (req, res, next) => {
  try {
    const resource = req.params.resource;
    const config = MASTER_CONFIG[resource];
    if (!config) return res.status(404).json({ ok: false });
    const idField = config.idField || "id";
    const id = idField === "id" ? Number(req.params.id) : cleanText(req.params.id);
    if ((idField === "id" && !Number.isFinite(id)) || (idField !== "id" && !id)) return res.status(400).json({ ok: false });
    if (!checkTypedConfirm(req, res, "DELETE", "a permanent master delete")) return undefined;

    const r = await pool.query(
      `
        delete from ${config.table}
        where ${idField} = $1
        returning *
      `,
      [id]
    );
    const item = r.rows[0] || null;
    if (!item) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, item });
  } catch (err) {
    if (err && err.code === "23503") return res.status(409).json({ ok: false, error: "MASTER_IN_USE" });
    return next(err);
  }
});

router.get("/einvoice-settings", requireAdminMastersAccess, async (req, res, next) => {
  try {
    const companyId = cleanInt(req.query.company_id) || cleanInt(req.ctx?.company_id);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const [settingsRes, companiesRes] = await Promise.all([
      pool.query(`select * from company_einvoice_settings where company_id = $1 limit 1`, [companyId]),
      pool.query(
        `select id, company_code, coalesce(display_name, legal_name) as company_name from companies where is_active = true order by company_code`
      ),
    ]);
    const settings = settingsRes.rows[0] || null;
    const envKey = settings?.credential_env_key || null;
    return res.json({
      ok: true,
      companies: companiesRes.rows,
      settings: settings
        ? {
            ...settings,
            credential_env_configured: Boolean(envKey && process.env[envKey]),
          }
        : {
            company_id: companyId,
            provider: "mastergst",
            seller_gstin: null,
            base_url: "https://apisandbox.mastergst.com",
            environment: "sandbox",
            is_enabled: false,
            credential_env_key: null,
            credential_env_configured: false,
          },
      defaults: {
        sandbox_base_url: "https://apisandbox.mastergst.com",
        production_base_url: "https://api.mastergst.com",
        provider: "mastergst",
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.put("/einvoice-settings", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = cleanInt(body.company_id) || cleanInt(req.ctx?.company_id);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const provider = cleanNullable(body.provider)?.toLowerCase() || "mastergst";
    if (!["mastergst", "manual", "other"].includes(provider)) {
      return res.status(400).json({ ok: false, error: "INVALID_PROVIDER" });
    }
    const environment = cleanText(body.environment).toLowerCase() === "production" ? "production" : "sandbox";
    const baseUrl =
      cleanNullable(body.base_url) ||
      (environment === "production" ? "https://api.mastergst.com" : "https://apisandbox.mastergst.com");
    const sellerGstin = cleanNullable(body.seller_gstin);
    const credentialEnvKey = cleanNullable(body.credential_env_key);
    const isEnabled = cleanBool(body.is_enabled, false);

    const r = await pool.query(
      `
        insert into company_einvoice_settings (
          company_id, provider, seller_gstin, base_url, environment, is_enabled, credential_env_key, updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7, now())
        on conflict (company_id) do update set
          provider = excluded.provider,
          seller_gstin = excluded.seller_gstin,
          base_url = excluded.base_url,
          environment = excluded.environment,
          is_enabled = excluded.is_enabled,
          credential_env_key = excluded.credential_env_key,
          updated_at = now()
        returning *
      `,
      [companyId, provider, sellerGstin, baseUrl, environment, isEnabled, credentialEnvKey]
    );

    const settings = r.rows[0];
    return res.json({
      ok: true,
      settings: {
        ...settings,
        credential_env_configured: Boolean(settings.credential_env_key && process.env[settings.credential_env_key]),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/expense-policy-limits", requireAdminMastersAccess, async (req, res, next) => {
  try {
    const companyId = cleanInt(req.query.company_id) || cleanInt(req.ctx?.company_id);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const r = await pool.query(
      `
        select id, company_id, category, daily_cap, claim_cap, is_active, updated_at
        from expense_policy_limits
        where company_id = $1
        order by category asc
      `,
      [companyId]
    );
    return res.json({ ok: true, limits: r.rows });
  } catch (err) {
    if (String(err?.message || "").includes("expense_policy_limits")) {
      return res.json({ ok: true, limits: [], ready: false });
    }
    return next(err);
  }
});

router.put("/expense-policy-limits", requireAdminMastersEdit, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = cleanInt(body.company_id) || cleanInt(req.ctx?.company_id);
    const category = cleanText(body.category);
    if (!companyId || !category) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    const dailyCap = body.daily_cap === null || body.daily_cap === "" ? null : Number(body.daily_cap);
    const claimCap = body.claim_cap === null || body.claim_cap === "" ? null : Number(body.claim_cap);
    const isActive = cleanBool(body.is_active, true);

    const r = await pool.query(
      `
        insert into expense_policy_limits (company_id, category, daily_cap, claim_cap, is_active, updated_at)
        values ($1, $2, $3, $4, $5, now())
        on conflict (company_id, category) do update set
          daily_cap = excluded.daily_cap,
          claim_cap = excluded.claim_cap,
          is_active = excluded.is_active,
          updated_at = now()
        returning *
      `,
      [companyId, category, Number.isFinite(dailyCap) ? dailyCap : null, Number.isFinite(claimCap) ? claimCap : null, isActive]
    );
    return res.json({ ok: true, limit: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
