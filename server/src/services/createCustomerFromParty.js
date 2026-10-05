/**
 * Unified party → customer master create used by Quotes inline create,
 * Lead convert, and any future transactional quick-create path.
 */
const { buildCustomerCompanyScopeSql, linkCustomerToCompany } = require("./customerCompanyAccess");

const CONTACT_ROLE_KEYS = [
  "sales_enquiry",
  "quote_recipient",
  "technical_discussion",
  "dispatch_logistics",
  "invoice_recipient",
  "payment_followup",
  "service_warranty",
];

function cleanNullableText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function cleanNullableEmail(value) {
  const text = cleanNullableText(value);
  return text ? text.toLowerCase() : null;
}

function normalizeRoleKeys(value) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of raw) {
    const key = String(item || "")
      .trim()
      .toLowerCase();
    if (CONTACT_ROLE_KEYS.includes(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

function normalizeParty(input = {}) {
  const customerName = cleanNullableText(input.customer_name) || cleanNullableText(input.company_name) || "";
  const email = cleanNullableEmail(input.email);
  const phone = cleanNullableText(input.phone);
  return {
    customer_name: customerName,
    customer_code: cleanNullableText(input.customer_code),
    legal_name: cleanNullableText(input.legal_name),
    website: cleanNullableText(input.website),
    industry: cleanNullableText(input.industry),
    email,
    phone,
    city: cleanNullableText(input.city),
    state: cleanNullableText(input.state),
    gstin: cleanNullableText(input.gstin),
    fax: cleanNullableText(input.fax),
    tinno: cleanNullableText(input.tinno),
    pan: cleanNullableText(input.pan),
    customer_type: cleanNullableText(input.customer_type),
    account_manager: cleanNullableText(input.account_manager),
    invoice_no: cleanNullableText(input.invoice_no),
    invoice_date: cleanNullableText(input.invoice_date),
    in_case_of_hospital: input.in_case_of_hospital === true,
    credit_limit:
      input.credit_limit === null || input.credit_limit === undefined || input.credit_limit === ""
        ? null
        : Number(input.credit_limit),
    credit_control_mode: cleanNullableText(input.credit_control_mode) || "warning",
    is_credit_hold: input.is_credit_hold === true,
    credit_hold_reason: cleanNullableText(input.credit_hold_reason),
    address_line1: cleanNullableText(input.address_line1),
    address_line2: cleanNullableText(input.address_line2),
    address_line3: cleanNullableText(input.address_line3),
    pincode: cleanNullableText(input.pincode),
    country_id:
      input.country_id === null || input.country_id === undefined || input.country_id === ""
        ? null
        : Number(input.country_id),
    contact_salutation: cleanNullableText(input.contact_salutation),
    contact_name: cleanNullableText(input.contact_name) || cleanNullableText(input.full_name),
    contact_email: cleanNullableEmail(input.contact_email) || email,
    contact_phone: cleanNullableText(input.contact_phone) || phone,
    contact_designation: cleanNullableText(input.contact_designation) || cleanNullableText(input.designation),
    contact_department: cleanNullableText(input.contact_department),
    contact_roles: normalizeRoleKeys(input.contact_roles || ["sales_enquiry", "quote_recipient"]),
    is_active: input.is_active !== false,
  };
}

async function findExistingByEmail(client, email, companyId) {
  if (!email || !companyId) return null;
  const res = await client.query(
    `
      select *
      from customers
      where email = $1
        and ${buildCustomerCompanyScopeSql("customers.id", "$2")}
      limit 1
    `,
    [email, companyId]
  );
  return res.rows[0] || null;
}

async function syncContactRoles(client, contactId, roles) {
  await client.query(`delete from customer_contact_roles where customer_contact_id = $1`, [contactId]);
  for (const role of normalizeRoleKeys(roles)) {
    await client.query(`insert into customer_contact_roles (customer_contact_id, role_key) values ($1, $2)`, [
      contactId,
      role,
    ]);
  }
}

async function seedPrimarySite(client, customerId, party) {
  const hasSiteSeed = Boolean(party.address_line1 || party.city || party.state || party.pincode);
  if (!hasSiteSeed) return null;

  const siteName = party.city ? `${party.city} Plant` : "Primary Plant";
  const res = await client.query(
    `
      insert into customer_sites (
        customer_id,
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
      values ($1,$2,'plant',$3,$4,$5,$6,$7,$8,$9,$10,true,true,true,true,true,true,true,now())
      returning *
    `,
    [
      customerId,
      siteName,
      party.address_line1,
      party.address_line2,
      party.address_line3,
      party.city,
      party.state,
      party.pincode,
      Number.isFinite(party.country_id) ? party.country_id : null,
      party.gstin ? "available" : "pending",
    ]
  );
  return res.rows[0] || null;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {object} options
 * @param {object} options.party - party fields (customer_name/company_name, contact, address…)
 * @param {number} options.companyId
 * @param {number|null} [options.distributorId]
 * @param {number[]} [options.shareWithCompanyIds]
 * @param {boolean} [options.reuseExistingByEmail=true]
 * @param {'owned'|'shared'} [options.ownershipType='owned']
 */
async function createCustomerFromParty(client, options = {}) {
  const party = normalizeParty(options.party || {});
  const companyId = Number(options.companyId);
  if (!party.customer_name) {
    const err = new Error("INVALID_CUSTOMER_NAME");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(companyId) || companyId <= 0) {
    const err = new Error("COMPANY_NOT_SELECTED");
    err.status = 400;
    throw err;
  }

  // Number(null) is 0, so a plain isFinite check would link non-distributor users to distributor 0.
  const rawDistributorId = options.distributorId;
  const distributorId =
    rawDistributorId !== null && rawDistributorId !== undefined && rawDistributorId !== "" &&
    Number.isInteger(Number(rawDistributorId)) && Number(rawDistributorId) > 0
      ? Number(rawDistributorId)
      : null;

  const reuseExistingByEmail = options.reuseExistingByEmail !== false;
  if (reuseExistingByEmail && party.email) {
    const existing = await findExistingByEmail(client, party.email, companyId);
    if (existing) {
      await linkCustomerToCompany(client, existing.id, companyId, "shared");
      if (distributorId) {
        await client.query(
          `
            insert into customer_distributor_links (customer_id, distributor_id, created_at)
            values ($1, $2, now())
            on conflict do nothing
          `,
          [existing.id, distributorId]
        );
      }

      let contact = null;
      const wantsContact = Boolean(party.contact_name || party.contact_email || party.contact_phone);
      if (wantsContact) {
        const existsRes = await client.query(
          `
            select *
            from customer_contacts
            where customer_id = $1
              and (
                ($2::citext is not null and email = $2::citext)
                or ($3::text is not null and phone = $3::text)
              )
            limit 1
          `,
          [existing.id, party.contact_email, party.contact_phone]
        );
        contact = existsRes.rows[0] || null;
        if (!contact) {
          const contactRes = await client.query(
            `
              insert into customer_contacts (
                customer_id, salutation, full_name, email, phone, designation, department, is_primary, is_active, created_at
              )
              values ($1,$2,$3,$4,$5,$6,$7,false,true,now())
              returning *
            `,
            [
              existing.id,
              party.contact_salutation,
              party.contact_name || party.customer_name,
              party.contact_email,
              party.contact_phone,
              party.contact_designation,
              party.contact_department,
            ]
          );
          contact = contactRes.rows[0] || null;
          if (contact?.id) await syncContactRoles(client, contact.id, party.contact_roles);
        }
      }

      return { customer: existing, site: null, contact, created: false };
    }
  }

  const insertRes = await client.query(
    `
      insert into customers (
        customer_code,
        customer_name,
        legal_name,
        website,
        industry,
        address_line1,
        address_line2,
        address_line3,
        city,
        state,
        pincode,
        country_id,
        phone,
        fax,
        email,
        gstin,
        tinno,
        pan,
        customer_type,
        account_manager,
        invoice_no,
        invoice_date,
        in_case_of_hospital,
        credit_limit,
        credit_control_mode,
        is_credit_hold,
        credit_hold_reason,
        is_active,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,now())
      returning *
    `,
    [
      party.customer_code,
      party.customer_name,
      party.legal_name,
      party.website,
      party.industry,
      party.address_line1,
      party.address_line2,
      party.address_line3,
      party.city,
      party.state,
      party.pincode,
      Number.isFinite(party.country_id) ? party.country_id : null,
      party.phone,
      party.fax,
      party.email,
      party.gstin,
      party.tinno,
      party.pan,
      party.customer_type,
      party.account_manager,
      party.invoice_no,
      party.invoice_date,
      party.in_case_of_hospital,
      Number.isFinite(party.credit_limit) ? party.credit_limit : null,
      party.credit_control_mode || "warning",
      party.is_credit_hold,
      party.credit_hold_reason,
      party.is_active,
    ]
  );
  const customer = insertRes.rows[0];
  await linkCustomerToCompany(client, customer.id, companyId, options.ownershipType || "owned");

  const shareIds = Array.isArray(options.shareWithCompanyIds) ? options.shareWithCompanyIds : [];
  for (const rawId of shareIds) {
    const memberCompanyId = Number(rawId);
    if (!Number.isFinite(memberCompanyId) || memberCompanyId <= 0) continue;
    if (memberCompanyId === companyId) continue;
    await linkCustomerToCompany(client, customer.id, memberCompanyId, "shared");
  }

  if (distributorId) {
    await client.query(
      `
        insert into customer_distributor_links (customer_id, distributor_id, created_at)
        values ($1, $2, now())
        on conflict do nothing
      `,
      [customer.id, distributorId]
    );
  }

  let contact = null;
  const wantsContact = Boolean(party.contact_name || party.contact_email || party.contact_phone);
  if (wantsContact) {
    const contactRes = await client.query(
      `
        insert into customer_contacts (
          customer_id, salutation, full_name, email, phone, designation, department, is_primary, is_active, created_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,true,true,now())
        returning *
      `,
      [
        customer.id,
        party.contact_salutation,
        party.contact_name || party.customer_name,
        party.contact_email,
        party.contact_phone,
        party.contact_designation,
        party.contact_department,
      ]
    );
    contact = contactRes.rows[0] || null;
    if (contact?.id) {
      await syncContactRoles(client, contact.id, party.contact_roles);
    }
  }

  const site = await seedPrimarySite(client, customer.id, party);

  return { customer, site, contact, created: true };
}

module.exports = {
  createCustomerFromParty,
  normalizeParty,
};
