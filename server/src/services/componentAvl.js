/**
 * Component specification + Approved Vendor List (AVL) helpers.
 */

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

function cleanText(value, max = 240) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, max);
}

function landedCostFactor(row) {
  const freight = money(row.freight_percentage) / 100;
  const duty = money(row.import_duty_percentage) / 100;
  const base = money(row.unit_price_hint);
  if (base <= 0) return null;
  return money(base * (1 + freight) * (1 + duty));
}

/**
 * If a product on a PO is used by a BOM line with a component specification,
 * the selected vendor must appear on that specification's active AVL.
 *
 * Legacy AVL rows may contain only vendor_name, so those rows are also matched
 * against the selected vendor's legal name or vendor code.
 */
async function assertVendorApprovedForProducts(client, { companyId, vendorId, productIds }) {
  const vid = asInt(vendorId);
  const cid = asInt(companyId);
  const ids = [...new Set((productIds || []).map(asInt).filter(Boolean))];
  if (!vid || !ids.length) return;

  const r = await client.query(
    `
      with selected_vendor as (
        select id, company_name, vendor_code
        from vendors
        where id = $3
          and company_id = $2
          and is_active = true
        limit 1
      ),
      specs as (
        select distinct bl.component_specification_id as spec_id, bl.component_product_id as product_id
        from manufacturing_bom_lines bl
        join manufacturing_boms mb on mb.id = bl.bom_id
        join component_specifications s on s.id = bl.component_specification_id
        where bl.component_product_id = any($1::bigint[])
          and bl.component_specification_id is not null
          and mb.is_active = true
          and s.is_active = true
          and (s.company_id is null or s.company_id = $2)
        union
        select distinct a.component_specification_id, a.product_id
        from component_specification_avl a
        join component_specifications s on s.id = a.component_specification_id
        where a.product_id = any($1::bigint[])
          and a.is_active = true
          and s.is_active = true
          and (s.company_id is null or s.company_id = $2)
      )
      select
        s.product_id,
        s.spec_id,
        cs.spec_code,
        cs.spec_name,
        exists (
          select 1
          from component_specification_avl a
          cross join selected_vendor sv
          where a.component_specification_id = s.spec_id
            and a.is_active = true
            and (
              a.vendor_id = sv.id
              or (
                a.vendor_id is null
                and lower(trim(coalesce(a.vendor_name, ''))) in (
                  lower(trim(coalesce(sv.company_name, ''))),
                  lower(trim(coalesce(sv.vendor_code, '')))
                )
              )
            )
        ) as vendor_approved
      from specs s
      join component_specifications cs on cs.id = s.spec_id
    `,
    [ids, cid, vid]
  );

  const bad = r.rows.filter((row) => !row.vendor_approved);
  if (!bad.length) return;

  const detail = bad
    .map((row) => `${row.spec_code || "SPEC"} (${row.spec_name || "spec"}) · product #${row.product_id}`)
    .join("; ");
  const err = new Error("UNAPPROVED_VENDOR");
  err.status = 400;
  err.code = "UNAPPROVED_VENDOR";
  err.detail = `Vendor is not on the Approved Vendor List for: ${detail}`;
  throw err;
}

async function listSpecifications(client, { companyId, q = "", limit = 200 } = {}) {
  const params = [];
  const where = ["s.is_active = true"];
  if (companyId) {
    params.push(companyId);
    where.push(`(s.company_id is null or s.company_id = $${params.length})`);
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    where.push(
      `(s.spec_code ilike $${params.length} or s.spec_name ilike $${params.length} or coalesce(s.material,'') ilike $${params.length} or coalesce(s.geometry,'') ilike $${params.length})`
    );
  }
  params.push(Math.min(Math.max(asInt(limit) || 200, 1), 500));
  const r = await client.query(
    `
      select
        s.*,
        (
          select count(*)::int from component_specification_avl a
          where a.component_specification_id = s.id and a.is_active = true
        ) as avl_count,
        (
          select a.brand_name from component_specification_avl a
          where a.component_specification_id = s.id and a.is_active = true and a.is_preferred = true
          order by a.id asc limit 1
        ) as preferred_brand
      from component_specifications s
      where ${where.join(" and ")}
      order by s.spec_code asc
      limit $${params.length}
    `,
    params
  );
  return r.rows;
}

async function getSpecification(client, id, companyId = null) {
  const params = [asInt(id)];
  let where = "s.id = $1";
  if (companyId) {
    params.push(companyId);
    where += ` and (s.company_id is null or s.company_id = $${params.length})`;
  }
  const r = await client.query(
    `
      select s.*
      from component_specifications s
      where ${where}
      limit 1
    `,
    params
  );
  return r.rows[0] || null;
}

async function listAvl(client, specId) {
  const r = await client.query(
    `
      select
        a.*,
        v.company_name as vendor_company_name,
        v.vendor_code,
        p.item_code as product_item_code,
        p.item_name as product_item_name,
        p.brand as product_brand
      from component_specification_avl a
      left join vendors v on v.id = a.vendor_id
      left join products p on p.id = a.product_id
      where a.component_specification_id = $1
      order by a.is_preferred desc, a.is_active desc, a.brand_name nulls last, a.id asc
    `,
    [asInt(specId)]
  );
  return r.rows.map((row) => ({
    ...row,
    landed_cost_hint: landedCostFactor(row),
  }));
}

module.exports = {
  asInt,
  money,
  cleanText,
  landedCostFactor,
  assertVendorApprovedForProducts,
  listSpecifications,
  getSpecification,
  listAvl,
};
