const { getActiveCompanyId, requireResolvedCompanyId } = require("./companyContext");

function allowLegacyUnlinkedCustomers() {
  return String(process.env.CUSTOMER_COMPANY_STRICT || "").trim().toLowerCase() !== "true";
}

function buildCustomerCompanyScopeSql(customerExpr, companyParamRef, { includeLegacyUnlinked = allowLegacyUnlinkedCustomers() } = {}) {
  const linked = `exists (
    select 1
    from customer_company_links ccl
    where ccl.customer_id = ${customerExpr}
      and ccl.company_id = ${companyParamRef}
      and ccl.is_active = true
  )`;
  if (!includeLegacyUnlinked) return linked;
  return `(
    ${linked}
    or not exists (
      select 1
      from customer_company_links ccl_any
      where ccl_any.customer_id = ${customerExpr}
        and ccl_any.is_active = true
    )
  )`;
}

async function linkCustomerToCompany(client, customerId, companyId, ownershipType = "owned") {
  if (!Number.isFinite(Number(customerId)) || !Number.isFinite(Number(companyId))) return;
  await client.query(
    `
      insert into customer_company_links (customer_id, company_id, ownership_type, is_active, updated_at)
      values ($1,$2,$3,true,now())
      on conflict (customer_id, company_id)
      do update set
        is_active = true,
        ownership_type = excluded.ownership_type,
        updated_at = now()
    `,
    [Number(customerId), Number(companyId), ownershipType]
  );
}

async function getCustomerCompanyAccess(client, customerId, companyId) {
  if (!Number.isFinite(Number(customerId))) return { exists: false, linked: false, hasAnyLink: false };
  const params = [Number(customerId)];
  let linkedSql = "false";
  if (Number.isFinite(Number(companyId))) {
    params.push(Number(companyId));
    linkedSql = `exists (
      select 1
      from customer_company_links ccl
      where ccl.customer_id = c.id
        and ccl.company_id = $2
        and ccl.is_active = true
    )`;
  }
  const { rows } = await client.query(
    `
      select
        true as exists,
        ${linkedSql} as linked,
        exists (
          select 1
          from customer_company_links ccl_any
          where ccl_any.customer_id = c.id
            and ccl_any.is_active = true
        ) as has_any_link
      from customers c
      where c.id = $1
      limit 1
    `,
    params
  );
  return rows[0] || { exists: false, linked: false, has_any_link: false };
}

async function getSingleActiveCustomerCompanyId(client, customerId) {
  if (!Number.isFinite(Number(customerId))) return null;
  const { rows } = await client.query(
    `
      select company_id
      from customer_company_links
      where customer_id = $1
        and is_active = true
      group by company_id
      order by min(case when ownership_type = 'owned' then 0 else 1 end), company_id asc
    `,
    [Number(customerId)]
  );
  if (rows.length !== 1) return null;
  const companyId = Number(rows[0]?.company_id);
  return Number.isFinite(companyId) && companyId > 0 ? companyId : null;
}

async function ensureCustomerCompanyAccess(client, req, customerId, { allowLegacyUnlinked = allowLegacyUnlinkedCustomers() } = {}) {
  const companyId = requireResolvedCompanyId(req);
  if (!companyId) {
    const err = new Error("COMPANY_NOT_SELECTED");
    err.status = 400;
    throw err;
  }
  const access = await getCustomerCompanyAccess(client, customerId, companyId);
  if (!access.exists) {
    const err = new Error("CUSTOMER_NOT_FOUND");
    err.status = 404;
    throw err;
  }
  if (access.linked) return companyId;
  if (allowLegacyUnlinked && !access.has_any_link) return companyId;
  const err = new Error("CUSTOMER_NOT_ALLOWED");
  err.status = 403;
  throw err;
}

module.exports = {
  buildCustomerCompanyScopeSql,
  ensureCustomerCompanyAccess,
  getActiveCompanyId,
  getCustomerCompanyAccess,
  getSingleActiveCustomerCompanyId,
  linkCustomerToCompany,
  requireResolvedCompanyId,
  allowLegacyUnlinkedCustomers,
};
