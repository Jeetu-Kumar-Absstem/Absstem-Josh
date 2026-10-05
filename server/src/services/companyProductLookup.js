function normalizeMode(mode) {
  const m = typeof mode === "string" ? mode.trim().toLowerCase() : "";
  if (m === "sale" || m === "saleable") return "sale";
  if (m === "purchase" || m === "purchaseable") return "purchase";
  if (m === "stock" || m === "stocked") return "stock";
  if (m === "manufacture" || m === "manufactured") return "manufacture";
  return null;
}

function normalizeLimit(value, fallback = 50, max = 300) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function buildPolicyFilters(mode, companyParamIndex) {
  const m = normalizeMode(mode);
  // Company-local inactivity: blocked OR not saleable (for quote/default catalog).
  // products.is_active remains global SKU retirement only.
  const where = [`coalesce(cpp.sourcing_mode, '') <> 'blocked'`];
  if (!m || m === "sale") where.push(`coalesce(cpp.is_saleable, true) = true`);
  if (m === "purchase") where.push(`coalesce(cpp.is_purchaseable, true) = true`);
  if (m === "stock") where.push(`coalesce(cpp.is_stocked, true) = true`);
  if (m === "manufacture") where.push(`coalesce(cpp.is_manufactured, p.is_manufactured, false) = true`);
  return {
    join: `left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $${companyParamIndex}`,
    where,
  };
}

async function lookupProducts(
  client,
  {
    companyId,
    q = "",
    categoryId = null,
    groupId = null,
    mode = null,
    limit = 50,
    includeStockQty = false,
  } = {}
) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid) || cid <= 0) return [];

  const search = typeof q === "string" ? q.trim() : "";
  const params = [];
  const where = [`p.is_active = true`];

  if (search) {
    params.push(`%${search}%`);
    where.push(`(
      p.item_code ilike $${params.length}
      or p.item_name ilike $${params.length}
    )`);
  }

  const catId = typeof categoryId === "number" ? categoryId : Number(categoryId);
  if (Number.isFinite(catId) && catId > 0) {
    params.push(catId);
    where.push(`p.category_id = $${params.length}`);
  }

  const grpId = typeof groupId === "number" ? groupId : Number(groupId);
  if (Number.isFinite(grpId) && grpId > 0) {
    params.push(grpId);
    where.push(`p.group_id = $${params.length}`);
  }

  const policy = buildPolicyFilters(mode, params.length + 1);
  where.push(...policy.where);

  const stockJoin = includeStockQty ? `left join stock_balances sb on sb.company_id = $${params.length + 1} and sb.product_id = p.id` : ``;
  const stockSelect = includeStockQty ? `, coalesce(sb.stock_qty, 0) as stock_qty` : `, 0::numeric as stock_qty`;

  const orderBySql = search
    ? `
      order by
        case
          when p.item_code ilike $1 then 0
          when p.item_name ilike $1 then 1
          when p.item_code ilike replace($1, '%', '') || '%' then 2
          when p.item_name ilike replace($1, '%', '') || '%' then 3
          else 4
        end,
        p.item_name asc
    `
    : `order by p.item_name asc`;

  const finalLimit = normalizeLimit(limit, 50, 300);
  const r = await client.query(
    `
      select
        p.id,
        p.category_id,
        p.group_id,
        p.item_code,
        p.item_name,
        p.uom,
        p.hsn_no,
        p.gst_pct,
        p.list_price,
        p.last_purchase_price,
        coalesce(p.serial_no_required, false) as serial_no_required,
        coalesce(cpp.is_manufactured, p.is_manufactured, false) as is_manufactured,
        coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
        coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) as sourcing_mode,
        cpp.intercompany_source_company_id,
        coalesce(cp.company_name, c.display_name, c.legal_name, c.company_code) as intercompany_source_company_name
        ${stockSelect},
        pc.category_name,
        pg.group_name
      from products p
      left join product_categories pc on pc.id = p.category_id
      left join product_groups pg on pg.id = p.group_id
      ${policy.join}
      left join company_profiles_v2 cp on cp.company_id = cpp.intercompany_source_company_id
      left join companies c on c.id = cpp.intercompany_source_company_id
      ${stockJoin}
      where ${where.join(" and ")}
      ${orderBySql}
      limit ${finalLimit}
    `,
    [...params, cid]
  );
  return r.rows;
}

async function getCompanyProductOrNull(client, { companyId, productId, mode = null } = {}) {
  const cid = Number(companyId);
  const pid = Number(productId);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(pid) || pid <= 0) return null;

  const policy = buildPolicyFilters(mode, 2);
  const r = await client.query(
    `
      select
        p.id,
        p.item_code,
        p.item_name,
        p.uom,
        p.hsn_no,
        p.gst_pct,
        p.list_price
      from products p
      ${policy.join}
      where p.id = $1
        and p.is_active = true
        and ${policy.where.join(" and ")}
      limit 1
    `,
    [pid, cid]
  );
  return r.rows[0] || null;
}

module.exports = {
  getCompanyProductOrNull,
  getCompanyProductByItemCodeOrNull: async (client, { companyId, itemCode, mode = null } = {}) => {
    const cid = Number(companyId);
    const code = typeof itemCode === "string" ? itemCode.trim() : "";
    if (!Number.isFinite(cid) || cid <= 0 || !code) return null;
    const policy = buildPolicyFilters(mode, 2);
    const r = await client.query(
      `
        select
          p.id,
          p.item_code,
          p.item_name,
          p.uom,
          p.hsn_no,
          p.gst_pct,
          p.list_price
        from products p
        ${policy.join}
        where lower(p.item_code) = lower($1)
          and p.is_active = true
          and ${policy.where.join(" and ")}
        order by case when p.item_code = $1 then 0 else 1 end, p.id asc
        limit 1
      `,
      [code, cid]
    );
    return r.rows[0] || null;
  },
  getCompanyProductByItemNameOrNull: async (client, { companyId, itemName, mode = null } = {}) => {
    const cid = Number(companyId);
    const name = typeof itemName === "string" ? itemName.trim() : "";
    if (!Number.isFinite(cid) || cid <= 0 || !name) return null;
    const policy = buildPolicyFilters(mode, 2);
    const r = await client.query(
      `
        select
          p.id,
          p.item_code,
          p.item_name,
          p.uom,
          p.hsn_no,
          p.gst_pct,
          p.list_price
        from products p
        ${policy.join}
        where lower(p.item_name) = lower($1)
          and p.is_active = true
          and ${policy.where.join(" and ")}
        order by case when p.item_name = $1 then 0 else 1 end, p.id asc
        limit 1
      `,
      [name, cid]
    );
    return r.rows[0] || null;
  },
  lookupProducts,
};
