const express = require("express");

const { pool } = require("../db/pool");
const { getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name !== "SuperAdmin") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  return next();
}

function cleanText(value) {
  return String(value || "").trim();
}

function cleanNullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function toOptionalInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toRequiredPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toOptionalDecimal(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toRequiredPositiveDecimal(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toOptionalDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function toBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(text)) return true;
  if (["false", "0", "no", "n"].includes(text)) return false;
  return fallback;
}

function resolveCompanyId(req, extraValue = null) {
  return requireResolvedCompanyId(req, extraValue);
}

async function getCompanyOptions(client) {
  const { rows } = await client.query(
    `
      select
        c.id,
        c.company_code,
        coalesce(cp.company_name, c.display_name, c.legal_name, c.company_code) as company_name
      from companies c
      left join company_profiles_v2 cp on cp.company_id = c.id
      where c.is_active = true
      order by company_name asc, c.company_code asc
    `
  );
  return rows;
}

async function getScopedProducts(client, companyId) {
  const { rows } = await client.query(
    `
      select
        p.id,
        p.item_code,
        p.item_name,
        p.uom,
        p.hsn_no,
        p.gst_pct,
        p.list_price,
        pc.category_name,
        pg.group_name,
        coalesce(cpp.is_manufactured, p.is_manufactured, false) as is_manufactured
      from products p
      join company_product_policies cpp
        on cpp.product_id = p.id
       and cpp.company_id = $1
      left join product_categories pc on pc.id = p.category_id
      left join product_groups pg on pg.id = p.group_id
      where p.is_active = true
        and coalesce(cpp.sourcing_mode, '') <> 'blocked'
      order by p.item_code asc, p.item_name asc
      limit 800
    `,
    [companyId]
  );
  return rows;
}

async function getScopedCustomers(client, companyId) {
  const { rows } = await client.query(
    `
      select
        c.id,
        c.customer_code,
        c.customer_name,
        c.legal_name,
        c.city,
        c.state,
        c.is_active
      from customers c
      where c.company_id = $1
        and coalesce(c.merged_into_customer_id, 0) = 0
      order by c.customer_name asc, c.id asc
      limit 500
    `,
    [companyId]
  );
  return rows;
}

async function getScopedSalesOrders(client, companyId) {
  const { rows } = await client.query(
    `
      select
        so.id,
        so.so_number,
        so.customer_id,
        c.customer_name,
        so.order_status,
        so.order_date
      from sales_orders so
      join customers c on c.id = so.customer_id
      where so.company_id = $1
      order by so.id desc
      limit 500
    `,
    [companyId]
  );
  return rows;
}

async function getScopedDispatches(client, companyId) {
  const { rows } = await client.query(
    `
      select
        d.id,
        d.dispatch_number,
        d.customer_id,
        c.customer_name,
        d.sales_order_id,
        so.so_number,
        d.dispatch_status,
        d.dispatch_date
      from dispatches d
      join customers c on c.id = d.customer_id
      left join sales_orders so on so.id = d.sales_order_id
      where d.company_id = $1
      order by d.id desc
      limit 500
    `,
    [companyId]
  );
  return rows;
}

async function getScopedJobCards(client, companyId) {
  const { rows } = await client.query(
    `
      select
        jc.id,
        jc.job_card_number,
        jc.job_id,
        jc.job_status,
        jc.job_date,
        jc.sales_order_id,
        so.so_number,
        jc.finished_good_product_id,
        p.item_code as finished_good_item_code,
        p.item_name as finished_good_item_name,
        jc.bom_id,
        mb.bom_code
      from job_cards jc
      left join sales_orders so on so.id = jc.sales_order_id
      left join products p on p.id = jc.finished_good_product_id
      left join manufacturing_boms mb on mb.id = jc.bom_id
      where jc.company_id = $1
      order by jc.id desc
      limit 500
    `,
    [companyId]
  );
  return rows;
}

async function getScopedManufacturingBoms(client, companyId) {
  const { rows } = await client.query(
    `
      select
        mb.id,
        mb.bom_code,
        mb.revision_no,
        mb.is_active,
        mb.finished_good_product_id,
        p.item_code as finished_good_item_code,
        p.item_name as finished_good_item_name
      from manufacturing_boms mb
      join products p on p.id = mb.finished_good_product_id
      where mb.company_id = $1
      order by mb.is_active desc, mb.bom_code asc, mb.revision_no desc
      limit 500
    `,
    [companyId]
  );
  return rows;
}

async function getProductSnapshot(client, productId) {
  const pid = toOptionalInt(productId);
  if (!pid) return null;
  const { rows } = await client.query(
    `
      select id, item_code, item_name, uom
      from products
      where id = $1
      limit 1
    `,
    [pid]
  );
  return rows[0] || null;
}

async function loadJobAssets(client, companyId) {
  const { rows } = await client.query(
    `
      select
        ja.id,
        ja.company_id,
        ja.customer_id,
        c.customer_code,
        c.customer_name,
        ja.sales_order_id,
        so.so_number,
        ja.dispatch_id,
        d.dispatch_number,
        ja.job_card_id,
        jc.job_card_number,
        ja.asset_status,
        ja.job_id,
        ja.serial_no,
        ja.asset_code,
        ja.asset_name,
        ja.finished_good_product_id,
        coalesce(ja.finished_good_item_code, p.item_code) as finished_good_item_code,
        coalesce(ja.finished_good_item_name, p.item_name) as finished_good_item_name,
        ja.installation_date,
        ja.commissioning_date,
        ja.warranty_start_date,
        ja.warranty_end_date,
        ja.site_name,
        ja.site_address,
        ja.remarks,
        coalesce(lines.bom_line_count, 0) as bom_line_count,
        ja.updated_at
      from job_assets ja
      join customers c on c.id = ja.customer_id
      left join sales_orders so on so.id = ja.sales_order_id
      left join dispatches d on d.id = ja.dispatch_id
      left join job_cards jc on jc.id = ja.job_card_id
      left join products p on p.id = ja.finished_good_product_id
      left join (
        select job_asset_id, count(*)::int as bom_line_count
        from job_asset_bom_lines
        group by job_asset_id
      ) lines on lines.job_asset_id = ja.id
      where ja.company_id = $1
      order by ja.updated_at desc, ja.id desc
      limit 400
    `,
    [companyId]
  );
  return rows;
}

async function loadAftermarketMappings(client, companyId) {
  const { rows } = await client.query(
    `
      select
        pam.id,
        pam.company_id,
        pam.parent_product_id,
        pp.item_code as parent_item_code,
        pp.item_name as parent_item_name,
        pam.replacement_product_id,
        rp.item_code as replacement_item_code,
        rp.item_name as replacement_item_name,
        pam.mapping_type,
        pam.qty_per_parent,
        pam.is_recommended,
        pam.is_mandatory,
        pam.service_interval_hours,
        pam.service_interval_days,
        pam.notes,
        pam.is_active,
        pam.updated_at
      from product_aftermarket_mappings pam
      join products pp on pp.id = pam.parent_product_id
      join products rp on rp.id = pam.replacement_product_id
      where pam.company_id = $1
      order by pam.updated_at desc, pam.id desc
      limit 500
    `,
    [companyId]
  );
  return rows;
}

async function getJobAssetOrNull(client, companyId, jobAssetId) {
  const id = toRequiredPositiveInt(jobAssetId);
  if (!id) return null;
  const { rows } = await client.query(
    `
      select *
      from job_assets
      where id = $1
        and company_id = $2
      limit 1
    `,
    [id, companyId]
  );
  return rows[0] || null;
}

async function loadAssetBomLines(client, companyId, jobAssetId) {
  const asset = await getJobAssetOrNull(client, companyId, jobAssetId);
  if (!asset) return null;
  const { rows } = await client.query(
    `
      select
        jabl.id,
        jabl.job_asset_id,
        jabl.bom_id,
        mb.bom_code,
        jabl.manufacturing_bom_line_id,
        jabl.line_no,
        jabl.installed_product_id,
        coalesce(p.item_code, jabl.installed_item_code) as installed_item_code,
        coalesce(jabl.installed_item_name, p.item_name) as installed_item_name,
        coalesce(nullif(trim(jabl.uom), ''), p.uom) as uom,
        jabl.qty_installed,
        jabl.remarks,
        jabl.source_kind,
        jabl.updated_at
      from job_asset_bom_lines jabl
      left join products p on p.id = jabl.installed_product_id
      left join manufacturing_boms mb on mb.id = jabl.bom_id
      where jabl.job_asset_id = $1
      order by jabl.line_no asc, jabl.id asc
    `,
    [asset.id]
  );
  return rows;
}

router.use(requireAuth);
router.use(requireSuperAdmin);

router.get("/bootstrap", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const activeCompanyId = getActiveCompanyId(req) || null;
    const companies = await getCompanyOptions(client);
    if (!activeCompanyId) {
      return res.json({
        ok: true,
        active_company_id: null,
        companies,
        customers: [],
        products: [],
        sales_orders: [],
        dispatches: [],
        job_cards: [],
        manufacturing_boms: [],
        job_assets: [],
        aftermarket_mappings: [],
      });
    }

    const [customers, products, salesOrders, dispatches, jobCards, manufacturingBoms, jobAssets, aftermarketMappings] = await Promise.all([
      getScopedCustomers(client, activeCompanyId),
      getScopedProducts(client, activeCompanyId),
      getScopedSalesOrders(client, activeCompanyId),
      getScopedDispatches(client, activeCompanyId),
      getScopedJobCards(client, activeCompanyId),
      getScopedManufacturingBoms(client, activeCompanyId),
      loadJobAssets(client, activeCompanyId),
      loadAftermarketMappings(client, activeCompanyId),
    ]);

    return res.json({
      ok: true,
      active_company_id: activeCompanyId,
      companies,
      customers,
      products,
      sales_orders: salesOrders,
      dispatches,
      job_cards: jobCards,
      manufacturing_boms: manufacturingBoms,
      job_assets: jobAssets,
      aftermarket_mappings: aftermarketMappings,
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/job-assets/:id/bom-lines", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const rows = await loadAssetBomLines(client, companyId, req.params.id);
    if (!rows) return res.status(404).json({ ok: false, error: "JOB_ASSET_NOT_FOUND" });
    return res.json({ ok: true, bom_lines: rows });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/job-assets", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const customerId = toRequiredPositiveInt(req.body?.customer_id);
    const jobId = cleanText(req.body?.job_id);
    const serialNo = cleanText(req.body?.serial_no);
    if (!customerId) return res.status(400).json({ ok: false, error: "CUSTOMER_REQUIRED" });
    if (!jobId) return res.status(400).json({ ok: false, error: "JOB_ID_REQUIRED" });
    if (!serialNo) return res.status(400).json({ ok: false, error: "SERIAL_NO_REQUIRED" });

    const finishedGoodProductId = toOptionalInt(req.body?.finished_good_product_id);
    const product = await getProductSnapshot(client, finishedGoodProductId);

    await client.query("begin");
    const { rows } = await client.query(
      `
        insert into job_assets (
          company_id,
          customer_id,
          sales_order_id,
          sales_order_line_id,
          dispatch_id,
          dispatch_line_id,
          job_card_id,
          asset_status,
          job_id,
          serial_no,
          asset_code,
          asset_name,
          finished_good_product_id,
          finished_good_item_code,
          finished_good_item_name,
          installation_date,
          commissioning_date,
          warranty_start_date,
          warranty_end_date,
          site_name,
          site_address,
          remarks,
          created_by
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23
        )
        returning id
      `,
      [
        companyId,
        customerId,
        toOptionalInt(req.body?.sales_order_id),
        toOptionalInt(req.body?.sales_order_line_id),
        toOptionalInt(req.body?.dispatch_id),
        toOptionalInt(req.body?.dispatch_line_id),
        toOptionalInt(req.body?.job_card_id),
        cleanText(req.body?.asset_status) || "active",
        jobId,
        serialNo,
        cleanNullableText(req.body?.asset_code),
        cleanNullableText(req.body?.asset_name),
        finishedGoodProductId,
        product?.item_code || cleanNullableText(req.body?.finished_good_item_code),
        product?.item_name || cleanNullableText(req.body?.finished_good_item_name),
        toOptionalDate(req.body?.installation_date),
        toOptionalDate(req.body?.commissioning_date),
        toOptionalDate(req.body?.warranty_start_date),
        toOptionalDate(req.body?.warranty_end_date),
        cleanNullableText(req.body?.site_name),
        cleanNullableText(req.body?.site_address),
        cleanNullableText(req.body?.remarks),
        req.user.id || null,
      ]
    );
    await client.query("commit");
    const jobAssets = await loadJobAssets(client, companyId);
    const jobAsset = jobAssets.find((item) => Number(item.id) === Number(rows[0]?.id)) || null;
    return res.status(201).json({ ok: true, job_asset: jobAsset });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_JOB_ASSET_REFERENCE" });
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/job-assets/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const assetId = toRequiredPositiveInt(req.params.id);
    if (!assetId) return res.status(400).json({ ok: false, error: "INVALID_JOB_ASSET" });
    const existing = await getJobAssetOrNull(client, companyId, assetId);
    if (!existing) return res.status(404).json({ ok: false, error: "JOB_ASSET_NOT_FOUND" });

    const customerId = toRequiredPositiveInt(req.body?.customer_id);
    const jobId = cleanText(req.body?.job_id);
    const serialNo = cleanText(req.body?.serial_no);
    if (!customerId) return res.status(400).json({ ok: false, error: "CUSTOMER_REQUIRED" });
    if (!jobId) return res.status(400).json({ ok: false, error: "JOB_ID_REQUIRED" });
    if (!serialNo) return res.status(400).json({ ok: false, error: "SERIAL_NO_REQUIRED" });

    const finishedGoodProductId = toOptionalInt(req.body?.finished_good_product_id);
    const product = await getProductSnapshot(client, finishedGoodProductId);

    await client.query("begin");
    await client.query(
      `
        update job_assets
        set
          customer_id = $2,
          sales_order_id = $3,
          sales_order_line_id = $4,
          dispatch_id = $5,
          dispatch_line_id = $6,
          job_card_id = $7,
          asset_status = $8,
          job_id = $9,
          serial_no = $10,
          asset_code = $11,
          asset_name = $12,
          finished_good_product_id = $13,
          finished_good_item_code = $14,
          finished_good_item_name = $15,
          installation_date = $16,
          commissioning_date = $17,
          warranty_start_date = $18,
          warranty_end_date = $19,
          site_name = $20,
          site_address = $21,
          remarks = $22,
          updated_at = now()
        where id = $1
          and company_id = $23
      `,
      [
        assetId,
        customerId,
        toOptionalInt(req.body?.sales_order_id),
        toOptionalInt(req.body?.sales_order_line_id),
        toOptionalInt(req.body?.dispatch_id),
        toOptionalInt(req.body?.dispatch_line_id),
        toOptionalInt(req.body?.job_card_id),
        cleanText(req.body?.asset_status) || "active",
        jobId,
        serialNo,
        cleanNullableText(req.body?.asset_code),
        cleanNullableText(req.body?.asset_name),
        finishedGoodProductId,
        product?.item_code || cleanNullableText(req.body?.finished_good_item_code),
        product?.item_name || cleanNullableText(req.body?.finished_good_item_name),
        toOptionalDate(req.body?.installation_date),
        toOptionalDate(req.body?.commissioning_date),
        toOptionalDate(req.body?.warranty_start_date),
        toOptionalDate(req.body?.warranty_end_date),
        cleanNullableText(req.body?.site_name),
        cleanNullableText(req.body?.site_address),
        cleanNullableText(req.body?.remarks),
        companyId,
      ]
    );
    await client.query("commit");
    const jobAssets = await loadJobAssets(client, companyId);
    const jobAsset = jobAssets.find((item) => Number(item.id) === assetId) || null;
    return res.json({ ok: true, job_asset: jobAsset });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_JOB_ASSET_REFERENCE" });
    return next(err);
  } finally {
    client.release();
  }
});

router.delete("/job-assets/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const assetId = toRequiredPositiveInt(req.params.id);
    if (!assetId) return res.status(400).json({ ok: false, error: "INVALID_JOB_ASSET" });
    const existing = await getJobAssetOrNull(client, companyId, assetId);
    if (!existing) return res.status(404).json({ ok: false, error: "JOB_ASSET_NOT_FOUND" });
    await client.query(`delete from job_assets where id = $1 and company_id = $2`, [assetId, companyId]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/job-assets/:id/bom-lines", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const assetId = toRequiredPositiveInt(req.params.id);
    if (!assetId) return res.status(400).json({ ok: false, error: "INVALID_JOB_ASSET" });
    const asset = await getJobAssetOrNull(client, companyId, assetId);
    if (!asset) return res.status(404).json({ ok: false, error: "JOB_ASSET_NOT_FOUND" });

    const lineNo = toRequiredPositiveInt(req.body?.line_no);
    const qtyInstalled = toRequiredPositiveDecimal(req.body?.qty_installed);
    const installedProductId = toOptionalInt(req.body?.installed_product_id);
    const product = await getProductSnapshot(client, installedProductId);
    const installedItemCode = cleanText(req.body?.installed_item_code) || cleanText(product?.item_code);
    if (!lineNo) return res.status(400).json({ ok: false, error: "LINE_NO_REQUIRED" });
    if (!qtyInstalled) return res.status(400).json({ ok: false, error: "QTY_REQUIRED" });
    if (!installedItemCode) return res.status(400).json({ ok: false, error: "INSTALLED_ITEM_CODE_REQUIRED" });

    await client.query("begin");
    const { rows } = await client.query(
      `
        insert into job_asset_bom_lines (
          job_asset_id,
          bom_id,
          manufacturing_bom_line_id,
          line_no,
          installed_product_id,
          installed_item_code,
          installed_item_name,
          uom,
          qty_installed,
          remarks,
          source_kind
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        returning id
      `,
      [
        assetId,
        toOptionalInt(req.body?.bom_id),
        toOptionalInt(req.body?.manufacturing_bom_line_id),
        lineNo,
        installedProductId,
        installedItemCode,
        cleanNullableText(req.body?.installed_item_name) || cleanNullableText(product?.item_name),
        cleanNullableText(req.body?.uom) || cleanNullableText(product?.uom),
        qtyInstalled,
        cleanNullableText(req.body?.remarks),
        cleanText(req.body?.source_kind) || "manual_snapshot",
      ]
    );
    await client.query("commit");
    const lines = await loadAssetBomLines(client, companyId, assetId);
    const bomLine = (lines || []).find((item) => Number(item.id) === Number(rows[0]?.id)) || null;
    return res.status(201).json({ ok: true, bom_line: bomLine });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_BOM_LINE_NO" });
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/bom-lines/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const lineId = toRequiredPositiveInt(req.params.id);
    if (!lineId) return res.status(400).json({ ok: false, error: "INVALID_BOM_LINE" });

    const { rows: existingRows } = await client.query(
      `
        select jabl.id, jabl.job_asset_id
        from job_asset_bom_lines jabl
        join job_assets ja on ja.id = jabl.job_asset_id
        where jabl.id = $1
          and ja.company_id = $2
        limit 1
      `,
      [lineId, companyId]
    );
    const existing = existingRows[0] || null;
    if (!existing) return res.status(404).json({ ok: false, error: "BOM_LINE_NOT_FOUND" });

    const lineNo = toRequiredPositiveInt(req.body?.line_no);
    const qtyInstalled = toRequiredPositiveDecimal(req.body?.qty_installed);
    const installedProductId = toOptionalInt(req.body?.installed_product_id);
    const product = await getProductSnapshot(client, installedProductId);
    const installedItemCode = cleanText(req.body?.installed_item_code) || cleanText(product?.item_code);
    if (!lineNo) return res.status(400).json({ ok: false, error: "LINE_NO_REQUIRED" });
    if (!qtyInstalled) return res.status(400).json({ ok: false, error: "QTY_REQUIRED" });
    if (!installedItemCode) return res.status(400).json({ ok: false, error: "INSTALLED_ITEM_CODE_REQUIRED" });

    await client.query("begin");
    await client.query(
      `
        update job_asset_bom_lines
        set
          bom_id = $2,
          manufacturing_bom_line_id = $3,
          line_no = $4,
          installed_product_id = $5,
          installed_item_code = $6,
          installed_item_name = $7,
          uom = $8,
          qty_installed = $9,
          remarks = $10,
          source_kind = $11,
          updated_at = now()
        where id = $1
      `,
      [
        lineId,
        toOptionalInt(req.body?.bom_id),
        toOptionalInt(req.body?.manufacturing_bom_line_id),
        lineNo,
        installedProductId,
        installedItemCode,
        cleanNullableText(req.body?.installed_item_name) || cleanNullableText(product?.item_name),
        cleanNullableText(req.body?.uom) || cleanNullableText(product?.uom),
        qtyInstalled,
        cleanNullableText(req.body?.remarks),
        cleanText(req.body?.source_kind) || "manual_snapshot",
      ]
    );
    await client.query("commit");
    const lines = await loadAssetBomLines(client, companyId, existing.job_asset_id);
    const bomLine = (lines || []).find((item) => Number(item.id) === lineId) || null;
    return res.json({ ok: true, bom_line: bomLine });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_BOM_LINE_NO" });
    return next(err);
  } finally {
    client.release();
  }
});

router.delete("/bom-lines/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const lineId = toRequiredPositiveInt(req.params.id);
    if (!lineId) return res.status(400).json({ ok: false, error: "INVALID_BOM_LINE" });
    const { rows } = await client.query(
      `
        delete from job_asset_bom_lines jabl
        using job_assets ja
        where jabl.id = $1
          and ja.id = jabl.job_asset_id
          and ja.company_id = $2
        returning jabl.id
      `,
      [lineId, companyId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "BOM_LINE_NOT_FOUND" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/aftermarket-mappings", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const parentProductId = toRequiredPositiveInt(req.body?.parent_product_id);
    const replacementProductId = toRequiredPositiveInt(req.body?.replacement_product_id);
    const qtyPerParent = toRequiredPositiveDecimal(req.body?.qty_per_parent);
    const mappingType = cleanText(req.body?.mapping_type) || "consumable";
    if (!parentProductId) return res.status(400).json({ ok: false, error: "PARENT_PRODUCT_REQUIRED" });
    if (!replacementProductId) return res.status(400).json({ ok: false, error: "REPLACEMENT_PRODUCT_REQUIRED" });
    if (!qtyPerParent) return res.status(400).json({ ok: false, error: "QTY_PER_PARENT_REQUIRED" });

    await client.query("begin");
    const { rows } = await client.query(
      `
        insert into product_aftermarket_mappings (
          company_id,
          parent_product_id,
          replacement_product_id,
          mapping_type,
          qty_per_parent,
          is_recommended,
          is_mandatory,
          service_interval_hours,
          service_interval_days,
          notes,
          is_active,
          created_by
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        returning id
      `,
      [
        companyId,
        parentProductId,
        replacementProductId,
        mappingType,
        qtyPerParent,
        toBoolean(req.body?.is_recommended, true),
        toBoolean(req.body?.is_mandatory, false),
        toOptionalInt(req.body?.service_interval_hours),
        toOptionalInt(req.body?.service_interval_days),
        cleanNullableText(req.body?.notes),
        toBoolean(req.body?.is_active, true),
        req.user.id || null,
      ]
    );
    await client.query("commit");
    const mappings = await loadAftermarketMappings(client, companyId);
    const mapping = mappings.find((item) => Number(item.id) === Number(rows[0]?.id)) || null;
    return res.status(201).json({ ok: true, mapping });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_AFTERMARKET_MAPPING" });
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/aftermarket-mappings/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const mappingId = toRequiredPositiveInt(req.params.id);
    if (!mappingId) return res.status(400).json({ ok: false, error: "INVALID_AFTERMARKET_MAPPING" });
    const { rows: existingRows } = await client.query(
      `
        select id
        from product_aftermarket_mappings
        where id = $1
          and company_id = $2
        limit 1
      `,
      [mappingId, companyId]
    );
    if (!existingRows[0]) return res.status(404).json({ ok: false, error: "AFTERMARKET_MAPPING_NOT_FOUND" });

    const parentProductId = toRequiredPositiveInt(req.body?.parent_product_id);
    const replacementProductId = toRequiredPositiveInt(req.body?.replacement_product_id);
    const qtyPerParent = toRequiredPositiveDecimal(req.body?.qty_per_parent);
    const mappingType = cleanText(req.body?.mapping_type) || "consumable";
    if (!parentProductId) return res.status(400).json({ ok: false, error: "PARENT_PRODUCT_REQUIRED" });
    if (!replacementProductId) return res.status(400).json({ ok: false, error: "REPLACEMENT_PRODUCT_REQUIRED" });
    if (!qtyPerParent) return res.status(400).json({ ok: false, error: "QTY_PER_PARENT_REQUIRED" });

    await client.query("begin");
    await client.query(
      `
        update product_aftermarket_mappings
        set
          parent_product_id = $2,
          replacement_product_id = $3,
          mapping_type = $4,
          qty_per_parent = $5,
          is_recommended = $6,
          is_mandatory = $7,
          service_interval_hours = $8,
          service_interval_days = $9,
          notes = $10,
          is_active = $11,
          updated_at = now()
        where id = $1
          and company_id = $12
      `,
      [
        mappingId,
        parentProductId,
        replacementProductId,
        mappingType,
        qtyPerParent,
        toBoolean(req.body?.is_recommended, true),
        toBoolean(req.body?.is_mandatory, false),
        toOptionalInt(req.body?.service_interval_hours),
        toOptionalInt(req.body?.service_interval_days),
        cleanNullableText(req.body?.notes),
        toBoolean(req.body?.is_active, true),
        companyId,
      ]
    );
    await client.query("commit");
    const mappings = await loadAftermarketMappings(client, companyId);
    const mapping = mappings.find((item) => Number(item.id) === mappingId) || null;
    return res.json({ ok: true, mapping });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_AFTERMARKET_MAPPING" });
    return next(err);
  } finally {
    client.release();
  }
});

router.delete("/aftermarket-mappings/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const mappingId = toRequiredPositiveInt(req.params.id);
    if (!mappingId) return res.status(400).json({ ok: false, error: "INVALID_AFTERMARKET_MAPPING" });
    const { rows } = await client.query(
      `
        delete from product_aftermarket_mappings
        where id = $1
          and company_id = $2
        returning id
      `,
      [mappingId, companyId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "AFTERMARKET_MAPPING_NOT_FOUND" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
