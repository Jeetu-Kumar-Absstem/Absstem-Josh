const express = require("express");
const multer = require("multer");

const { pool } = require("../db/pool");
const { getActiveCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");
const {
  applyProductWorkbookImport,
  buildCurrentProductWorkbookExport,
  buildProductWorkbookTemplateBuffer,
  getCompanyPoliciesForProduct,
  getProductById,
  previewProductWorkbook,
  saveIntercompanyPolicyPair,
  saveProduct,
  syncLegacyManufacturingFields,
  upsertCategory,
  upsertCompanyProductPolicy,
  upsertGroup,
} = require("../services/productMaster");
const { OXYGEN_PACKAGE_BY_MODEL, normalizeOxygenModelKey } = require("../configurator/oxygenPackageData");
const { getClanProductMasterGapReport, applyClanProductMapping } = require("../services/clanProductGap");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { checkTypedConfirm } = require("../auth/typedConfirm");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(values) {
  return values.map(csvCell).join(",");
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

const requireProductView = requireScreenAction("product_master", "can_view");
const requireProductCreate = requireScreenAction("product_master", "can_create");
const requireProductEdit = requireScreenAction("product_master", "can_edit");
const requireProductApprove = requireScreenAction("product_master", "can_approve");

const PRODUCT_APPLY_PHRASE = "APPLY UPLOAD";

/** Product Master Desk (catalog) and Product Master Admin share these routes; either grant works. */
function requireProductAny(action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    if (hasScreenAction(req, "product_master", action) || hasScreenAction(req, "product_master_desk", action)) return next();
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  };
}

function incomingItemCode(body) {
  const b = body && typeof body === "object" ? body : {};
  return String(b.item_code ?? b.ItemCode ?? b["Item Code"] ?? b.Item_Code ?? "").trim();
}

function itemCodeChangeAttempted(existingItemCode, body) {
  const dbCode = String(existingItemCode ?? "").trim();
  const incoming = incomingItemCode(body);
  if (!dbCode || !incoming) return false;
  return dbCode.toLowerCase() !== incoming.toLowerCase();
}

function normalizeCaptionKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

const OXYGEN_PREFERRED_ATTRS = [
  { caption: "RECOMMENDED OXYGEN STORAGE", valueKey: "storageVolume" },
  { caption: "RECOMMENDED AIR RECEIVER", valueKey: "airVesselVolume" },
];

async function loadOxygenProductAttributeState(client) {
  const res = await client.query(
    `
      select
        p.id as product_id,
        p.item_code,
        p.item_name,
        pa.caption,
        pa.sort_order
      from products p
      join product_categories pc on pc.id = p.category_id
      left join product_attributes pa on pa.product_id = p.id
      where p.is_active = true
        and lower(coalesce(pc.category_name, '')) = 'oxygen'
      order by p.id asc, pa.sort_order asc nulls last, pa.id asc nulls last
    `
  );

  const byProduct = new Map();
  for (const row of res.rows) {
    if (!byProduct.has(row.product_id)) {
      byProduct.set(row.product_id, {
        product_id: row.product_id,
        item_code: row.item_code,
        item_name: row.item_name,
        captions: new Set(),
        maxSortOrder: 0,
      });
    }
    const entry = byProduct.get(row.product_id);
    if (row.caption) entry.captions.add(normalizeCaptionKey(row.caption));
    if (Number.isFinite(Number(row.sort_order))) entry.maxSortOrder = Math.max(entry.maxSortOrder, Number(row.sort_order));
  }

  return byProduct;
}

async function auditOxygenPackageAttributes(client) {
  const byProduct = await loadOxygenProductAttributeState(client);
  let matchedProducts = 0;
  let readyProducts = 0;
  let missingProducts = 0;
  let unmatchedProducts = 0;
  const samples = [];

  for (const entry of byProduct.values()) {
    const packageData =
      OXYGEN_PACKAGE_BY_MODEL.get(normalizeOxygenModelKey(entry.item_name)) ||
      OXYGEN_PACKAGE_BY_MODEL.get(normalizeOxygenModelKey(entry.item_code)) ||
      null;

    if (!packageData) {
      unmatchedProducts += 1;
      continue;
    }

    matchedProducts += 1;
    const missingCaptions = OXYGEN_PREFERRED_ATTRS
      .map((item) => item.caption)
      .filter((caption) => !entry.captions.has(normalizeCaptionKey(caption)));

    if (!missingCaptions.length) {
      readyProducts += 1;
    } else {
      missingProducts += 1;
      if (samples.length < 20) {
        samples.push({
          product_id: entry.product_id,
          item_code: entry.item_code,
          item_name: entry.item_name,
          missing_captions: missingCaptions,
        });
      }
    }
  }

  return {
    active_products: byProduct.size,
    matched_products: matchedProducts,
    ready_products: readyProducts,
    missing_products: missingProducts,
    unmatched_products: unmatchedProducts,
    samples,
  };
}

async function backfillOxygenPackageAttributes(client) {
  const byProduct = await loadOxygenProductAttributeState(client);

  let matchedProducts = 0;
  let backfilledProducts = 0;
  let insertedAttributes = 0;
  let skippedProducts = 0;

  for (const entry of byProduct.values()) {
    const packageData =
      OXYGEN_PACKAGE_BY_MODEL.get(normalizeOxygenModelKey(entry.item_name)) ||
      OXYGEN_PACKAGE_BY_MODEL.get(normalizeOxygenModelKey(entry.item_code)) ||
      null;

    if (!packageData) {
      skippedProducts += 1;
      continue;
    }
    matchedProducts += 1;

    let nextSortOrder = entry.maxSortOrder;
    let insertedForProduct = 0;
    for (const attr of OXYGEN_PREFERRED_ATTRS) {
      if (entry.captions.has(normalizeCaptionKey(attr.caption))) continue;
      nextSortOrder += 1;
      const rawValue = packageData[attr.valueKey];
      await client.query(
        `
          insert into product_attributes (product_id, sort_order, caption, spec_value)
          values ($1, $2, $3, $4)
        `,
        [entry.product_id, nextSortOrder, attr.caption, `${rawValue} L`]
      );
      insertedAttributes += 1;
      insertedForProduct += 1;
    }

    if (insertedForProduct > 0) backfilledProducts += 1;
  }

  return {
    total_products: byProduct.size,
    matched_products: matchedProducts,
    backfilled_products: backfilledProducts,
    inserted_attributes: insertedAttributes,
    skipped_products: skippedProducts,
  };
}

async function auditManufacturingReadiness(client, companyId) {
  const companyKey = Number(companyId);
  if (!Number.isFinite(companyKey) || companyKey <= 0) {
    const err = new Error("COMPANY_NOT_SELECTED");
    err.status = 400;
    throw err;
  }
  const params = [companyKey];
  const bomWhere = `where mb.company_id = $1`;
  const policyJoin = `left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $1`;

  const r = await client.query(
    `
      with bom_counts as (
        select
          mb.finished_good_product_id,
          count(*)::int as total_bom_count,
          count(*) filter (where mb.is_active = true)::int as active_bom_count
        from manufacturing_boms mb
        ${bomWhere}
        group by mb.finished_good_product_id
      )
      select
        p.id as product_id,
        p.item_code,
        p.item_name,
        p.is_active,
          coalesce(cpp.is_manufactured, p.is_manufactured, false) as is_manufactured,
          coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
        pc.category_name,
        pg.group_name,
        coalesce(bc.total_bom_count, 0) as total_bom_count,
        coalesce(bc.active_bom_count, 0) as active_bom_count
      from products p
      left join product_categories pc on pc.id = p.category_id
      left join product_groups pg on pg.id = p.group_id
        ${policyJoin}
      left join bom_counts bc on bc.finished_good_product_id = p.id
      where p.is_active = true
        and (
          coalesce(cpp.is_manufactured, p.is_manufactured, false) = true
          or coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) is not null
          or coalesce(bc.total_bom_count, 0) > 0
        )
      order by p.item_code asc, p.id asc
    `,
    params
  );

  const rows = r.rows.map((row) => {
    let status = "ready";
    let note = "Ready for manufacturing setup.";
    if (!row.is_manufactured) {
      status = "missing_fg_flag";
      note = "Turn on Manufactured FG.";
    } else if (!row.mfg_job_prefix) {
      status = "missing_prefix";
      note = "Assign JobID prefix.";
    } else if (Number(row.active_bom_count || 0) <= 0) {
      status = "missing_bom";
      note = "No active BOM in selected company.";
    }
    return {
      ...row,
      ready: status === "ready",
      status,
      note,
    };
  });

  const samples = rows.filter((row) => !row.ready).slice(0, 24);
  return {
    audit_company_id: companyKey,
    total_candidates: rows.length,
    ready_count: rows.filter((row) => row.ready).length,
    missing_fg_flag_count: rows.filter((row) => row.status === "missing_fg_flag").length,
    missing_prefix_count: rows.filter((row) => row.status === "missing_prefix").length,
    missing_bom_count: rows.filter((row) => row.status === "missing_bom").length,
    samples,
  };
}

router.use(requireAuth);

router.get("/admin/bootstrap", requireProductView, async (req, res, next) => {
  try {
    const activeCompanyId = getActiveCompanyId(req) || null;
    const [categoriesRes, groupsRes, companiesRes] = await Promise.all([
      pool.query(
        `
          select id, category_name, is_active
          from product_categories
          order by category_name asc
        `
      ),
      pool.query(
        `
          select id, category_id, group_name, is_active
          from product_groups
          order by group_name asc
        `
      ),
      pool.query(
        `
          select
            c.id,
            c.company_code,
            coalesce(cp.company_name, c.company_code) as company_name,
            c.is_active
          from companies c
          left join company_profiles_v2 cp on cp.company_id = c.id
          where c.is_active = true
          order by coalesce(cp.company_name, c.company_code) asc
        `
      ),
    ]);
    return res.json({
      ok: true,
      active_company_id: activeCompanyId,
      categories: categoriesRes.rows,
      groups: groupsRes.rows,
      companies: companiesRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/list", requireProductView, async (req, res, next) => {
  try {
    const activeCompanyId = getActiveCompanyId(req) || null;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const categoryId = typeof req.query.category_id === "string" ? Number(req.query.category_id) : null;
    const groupId = typeof req.query.group_id === "string" ? Number(req.query.group_id) : null;
    const status = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
    const sourcingMode = typeof req.query.sourcing_mode === "string" ? req.query.sourcing_mode.trim().toLowerCase() : "";
    const params = [];
    const where = [];

    if (q) {
      params.push(`%${q}%`);
      const searchParam = `$${params.length}`;
      where.push(`(
        p.item_code ilike ${searchParam}
        or p.item_name ilike ${searchParam}
        or coalesce(p.brand, '') ilike ${searchParam}
        or coalesce(pc.category_name, '') ilike ${searchParam}
        or coalesce(pg.group_name, '') ilike ${searchParam}
      )`);
    }
    if (Number.isFinite(categoryId)) {
      params.push(categoryId);
      where.push(`p.category_id = $${params.length}`);
    }
    if (Number.isFinite(groupId)) {
      params.push(groupId);
      where.push(`p.group_id = $${params.length}`);
    }
    if (status === "active") where.push(`p.is_active = true`);
    if (status === "inactive") where.push(`p.is_active = false`);
    if (sourcingMode) {
      params.push(sourcingMode);
      where.push(
        `coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) = $${params.length}`
      );
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const { rows } = await pool.query(
      `
        select
          p.id,
          p.item_code,
          p.item_name,
          p.brand,
          p.uom,
          p.hsn_no,
          p.gst_pct,
          p.list_price,
          coalesce(cpp.is_manufactured, p.is_manufactured, false) as is_manufactured,
          coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
          coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) as sourcing_mode,
          cpp.intercompany_source_company_id,
          coalesce(cp.company_name, c.display_name, c.legal_name, c.company_code) as intercompany_source_company_name,
          p.is_auto_generated,
          p.is_active,
          p.updated_at,
          p.category_id,
          p.group_id,
          pc.category_name,
          pg.group_name,
          coalesce(pa.attribute_count, 0) as attribute_count
        from products p
        left join product_categories pc on pc.id = p.category_id
        left join product_groups pg on pg.id = p.group_id
        left join company_product_policies cpp
          on cpp.product_id = p.id
         and cpp.company_id = $${params.length + 1}
        left join company_profiles_v2 cp on cp.company_id = cpp.intercompany_source_company_id
        left join companies c on c.id = cpp.intercompany_source_company_id
        left join (
          select product_id, count(*)::int as attribute_count
          from product_attributes
          group by product_id
        ) pa on pa.product_id = p.id
        ${whereSql}
        order by p.updated_at desc, p.id desc
        limit 300
      `,
      [...params, activeCompanyId ? Number(activeCompanyId) : -1]
    );
    return res.json({ ok: true, products: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/maintenance/oxygen-package-backfill", requireProductApprove, async (_req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const summary = await backfillOxygenPackageAttributes(client);
    await client.query("commit");
    return res.json({ ok: true, summary });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/admin/maintenance/oxygen-package-audit", requireProductView, async (_req, res, next) => {
  const client = await pool.connect();
  try {
    const audit = await auditOxygenPackageAttributes(client);
    return res.json({ ok: true, audit });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/admin/maintenance/manufacturing-readiness-audit", requireProductView, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const audit = await auditManufacturingReadiness(client, Number(activeCompanyId));
    return res.json({ ok: true, audit });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/admin/:id", requireProductView, async (req, res, next) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
    const activeCompanyId = getActiveCompanyId(req) || null;
    const product = await getProductById(pool, productId, activeCompanyId);
    if (!product) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, product });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/category", requireProductCreate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const categoryId = await upsertCategory(client, req.body?.category_name);
    const categoryRes = await client.query(
      `select id, category_name, is_active from product_categories where id = $1 limit 1`,
      [categoryId]
    );
    return res.json({ ok: true, category: categoryRes.rows[0] || null });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/admin/group", requireProductCreate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const categoryId = Number(req.body?.category_id);
    if (!Number.isFinite(categoryId)) return res.status(400).json({ ok: false, error: "CATEGORY_REQUIRED" });
    const groupId = await upsertGroup(client, categoryId, req.body?.group_name);
    const groupRes = await client.query(
      `select id, category_id, group_name, is_active from product_groups where id = $1 limit 1`,
      [groupId]
    );
    return res.json({ ok: true, group: groupRes.rows[0] || null });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/admin", requireProductCreate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const activeCompanyId = getActiveCompanyId(req) || null;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    // Catalog mode skips policy unless explicitly requested (used for first create defaults).
    const updateCompanyPolicy =
      body.save_mode === "catalog" ? body.update_company_policy === true : body.update_company_policy !== false;
    await client.query("begin");
    const productId = await saveProduct(client, body, {
      companyId: activeCompanyId,
      updateCompanyPolicy,
    });
    const product = await getProductById(client, productId, activeCompanyId);
    await client.query("commit");
    return res.status(201).json({ ok: true, product });
  } catch (err) {
    await client.query("rollback");
    if (err?.message === "ITEM_CODE_REQUIRED" || err?.message === "CATEGORY_REQUIRED" || err?.message === "GROUP_REQUIRED") {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_ITEM_CODE" });
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/admin/:id", requireProductEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const activeCompanyId = getActiveCompanyId(req) || null;
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const updateCompanyPolicy =
      body.save_mode === "catalog" ? body.update_company_policy === true : body.update_company_policy !== false;
    await client.query("begin");
    const existingRes = await client.query(`select id, item_code from products where id = $1 limit 1`, [productId]);
    if (!existingRes.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (itemCodeChangeAttempted(existingRes.rows[0].item_code, body)) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "ITEM_CODE_FROZEN",
        detail: "Item code is locked after create. Use controlled rename/merge.",
      });
    }
    await saveProduct(client, body, {
      existingId: productId,
      companyId: activeCompanyId,
      updateCompanyPolicy,
    });
    const product = await getProductById(client, productId, activeCompanyId);
    await client.query("commit");
    return res.json({ ok: true, product });
  } catch (err) {
    await client.query("rollback");
    if (err?.message === "ITEM_CODE_REQUIRED" || err?.message === "CATEGORY_REQUIRED" || err?.message === "GROUP_REQUIRED") {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_ITEM_CODE" });
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/admin/:id/company-policies", requireProductView, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId) || productId <= 0) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
    const product = await getProductById(client, productId, getActiveCompanyId(req) || null);
    if (!product) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const policies = await getCompanyPoliciesForProduct(client, productId);
    return res.json({ ok: true, product_id: productId, policies });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/admin/:id/company-policy", requireProductEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId) || productId <= 0) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = Number(body.company_id) || getActiveCompanyId(req) || null;
    if (!Number.isFinite(companyId) || companyId <= 0) return res.status(400).json({ ok: false, error: "COMPANY_REQUIRED" });

    await client.query("begin");
    const existingRes = await client.query(`select id from products where id = $1 limit 1`, [productId]);
    if (!existingRes.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    await upsertCompanyProductPolicy(client, companyId, productId, {
      company_policy: body.company_policy && typeof body.company_policy === "object" ? body.company_policy : body,
    });
    await syncLegacyManufacturingFields(client, productId);
    const product = await getProductById(client, productId, companyId);
    const policies = await getCompanyPoliciesForProduct(client, productId);
    await client.query("commit");
    return res.json({ ok: true, product, policies });
  } catch (err) {
    await client.query("rollback");
    if (err?.status) return res.status(err.status).json({ ok: false, error: err.message });
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/admin/:id/company-policies/pair", requireProductEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId) || productId <= 0) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
    await client.query("begin");
    const pair = await saveIntercompanyPolicyPair(client, productId, req.body || {});
    const product = await getProductById(client, productId, getActiveCompanyId(req) || pair.manufacturer_company_id);
    await client.query("commit");
    return res.json({ ok: true, product, ...pair });
  } catch (err) {
    await client.query("rollback");
    if (
      [
        "INVALID_PRODUCT",
        "INVALID_MANUFACTURER_COMPANY",
        "INVALID_BUYER_COMPANY",
        "PAIR_COMPANIES_MUST_DIFFER",
        "INVALID_COMPANY",
        "NOT_FOUND",
      ].includes(err?.message)
    ) {
      return res.status(err.status || 400).json({ ok: false, error: err.message });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/admin/import/preview", requireProductEdit, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: "NO_FILE" });
    const preview = await previewProductWorkbook(pool, req.file.buffer, req.file.originalname || "");
    return res.json({ ok: true, preview });
  } catch (err) {
    if (err?.message === "PRODUCTS_SHEET_REQUIRED") return res.status(400).json({ ok: false, error: err.message });
    if (err?.message === "INCONSISTENT_PRODUCT_ROWS") return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    return next(err);
  }
});

router.post("/admin/import/apply", requireProductApprove, upload.single("file"), async (req, res, next) => {
  if (!checkTypedConfirm(req, res, PRODUCT_APPLY_PHRASE, "a Product Master upload")) return undefined;
  const client = await pool.connect();
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: "NO_FILE" });
    await client.query("begin");
    const summary = await applyProductWorkbookImport(client, req.file.buffer, req.file.originalname || "");
    await client.query("commit");
    return res.json({ ok: true, summary });
  } catch (err) {
    await client.query("rollback");
    if (err?.message === "PRODUCTS_SHEET_REQUIRED") return res.status(400).json({ ok: false, error: err.message });
    if (err?.message === "INCONSISTENT_PRODUCT_ROWS") return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    if (["ITEM_CODE_REQUIRED", "CATEGORY_REQUIRED", "GROUP_REQUIRED"].includes(err?.message)) {
      return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    }
    if (err?.message === "DUPLICATE_ITEM_CODE_ROWS") return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    if (err?.message === "DUPLICATE_COMPANY_ITEM_ROWS") return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/admin/import/template", requireProductView, async (_req, res, next) => {
  const client = await pool.connect();
  try {
    const workbook = await buildProductWorkbookTemplateBuffer(client);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="ProductMaster_Guided_Import.xlsx"');
    return res.status(200).send(workbook);
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/admin/import/current-workbook", requireProductView, async (_req, res, next) => {
  const client = await pool.connect();
  try {
    const exportArtifact = await buildCurrentProductWorkbookExport(client);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${exportArtifact.fileName}"`);
    return res.status(200).send(exportArtifact.buffer);
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

/** Duplicate watch: active products sharing the same normalized item name. */
router.get("/admin/duplicates", requireProductView, async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 40)));
    const { rows } = await pool.query(
      `
        with norm as (
          select
            id,
            item_code,
            item_name,
            is_active,
            lower(regexp_replace(coalesce(item_name, ''), '\\s+', ' ', 'g')) as name_key
          from products
          where coalesce(is_active, true) = true
            and coalesce(merged_into_product_id, 0) = 0
            and length(trim(coalesce(item_name, ''))) > 2
        ),
        dup_keys as (
          select name_key
          from norm
          group by name_key
          having count(*) > 1
          order by count(*) desc
          limit $1
        )
        select
          n.name_key,
          json_agg(
            json_build_object(
              'id', n.id,
              'item_code', n.item_code,
              'item_name', n.item_name
            )
            order by n.item_code
          ) as products,
          count(*)::int as product_count
        from norm n
        join dup_keys d on d.name_key = n.name_key
        group by n.name_key
        order by count(*) desc, n.name_key asc
      `,
      [limit]
    );
    return res.json({ ok: true, groups: rows });
  } catch (err) {
    if (String(err?.message || "").includes("merged_into_product_id")) {
      return res.json({ ok: true, groups: [], ready: false, message: "Apply migration 189_wave4_admin_safety_v1.sql for product merge." });
    }
    return next(err);
  }
});

async function countProductRefs(client, productId) {
  const tables = [
    ["quote_lines", "product_id"],
    ["sales_order_lines", "product_id"],
    ["customer_invoice_lines", "product_id"],
    ["purchase_order_lines", "product_id"],
    ["goods_receipt_lines", "product_id"],
    ["company_product_policies", "product_id"],
    ["customer_product_codes", "product_id"],
  ];
  const counts = {};
  let total = 0;
  for (const [table, col] of tables) {
    try {
      const r = await client.query(`select count(*)::int as c from ${table} where ${col} = $1`, [productId]);
      const c = Number(r.rows[0]?.c || 0);
      counts[table] = c;
      total += c;
    } catch (_e) {
      counts[table] = null;
    }
  }
  return { counts, total };
}

router.post("/admin/merge/preview", requireProductEdit, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const sourceId = Number(body.source_product_id);
    const targetId = Number(body.target_product_id);
    if (!Number.isFinite(sourceId) || sourceId <= 0) return res.status(400).json({ ok: false, error: "SOURCE_REQUIRED" });
    if (!Number.isFinite(targetId) || targetId <= 0) return res.status(400).json({ ok: false, error: "TARGET_REQUIRED" });
    if (sourceId === targetId) return res.status(400).json({ ok: false, error: "SOURCE_TARGET_SAME" });

    const src = await client.query(
      `select id, item_code, item_name, is_active, merged_into_product_id from products where id = $1`,
      [sourceId]
    );
    const tgt = await client.query(
      `select id, item_code, item_name, is_active, merged_into_product_id from products where id = $1`,
      [targetId]
    );
    if (!src.rows[0]) return res.status(404).json({ ok: false, error: "SOURCE_NOT_FOUND" });
    if (!tgt.rows[0]) return res.status(404).json({ ok: false, error: "TARGET_NOT_FOUND" });
    if (src.rows[0].merged_into_product_id) return res.status(400).json({ ok: false, error: "SOURCE_ALREADY_MERGED" });

    const refs = await countProductRefs(client, sourceId);
    return res.json({
      ok: true,
      source_product: src.rows[0],
      target_product: tgt.rows[0],
      reference_counts: refs.counts,
      reference_total: refs.total,
      confirm_phrase: src.rows[0].item_code,
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/admin/merge/execute", requireProductApprove, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const sourceId = Number(body.source_product_id);
    const targetId = Number(body.target_product_id);
    const confirmPhrase = String(body.confirm_phrase || "").trim();
    if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || sourceId === targetId) {
      return res.status(400).json({ ok: false, error: "INVALID_MERGE" });
    }

    await client.query("begin");
    const srcRes = await client.query(
      `select id, item_code, item_name, merged_into_product_id from products where id = $1 for update`,
      [sourceId]
    );
    const tgtRes = await client.query(
      `select id, item_code, item_name from products where id = $1 for update`,
      [targetId]
    );
    const source = srcRes.rows[0];
    const target = tgtRes.rows[0];
    if (!source || !target) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "PRODUCT_NOT_FOUND" });
    }
    if (source.merged_into_product_id) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "SOURCE_ALREADY_MERGED" });
    }
    if (confirmPhrase !== String(source.item_code || "").trim()) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "CONFIRM_PHRASE_REQUIRED", expected: source.item_code });
    }

    const remapped = {};
    const remapTables = [
      ["quote_lines", "product_id"],
      ["sales_order_lines", "product_id"],
      ["customer_invoice_lines", "product_id"],
      ["purchase_order_lines", "product_id"],
      ["goods_receipt_lines", "product_id"],
      ["company_product_policies", "product_id"],
      ["customer_product_codes", "product_id"],
    ];
    for (const [table, col] of remapTables) {
      await client.query("savepoint product_merge_remap");
      try {
        const r = await client.query(
          `update ${table} set ${col} = $1 where ${col} = $2`,
          [targetId, sourceId]
        );
        remapped[table] = r.rowCount || 0;
        await client.query("release savepoint product_merge_remap");
      } catch (remapErr) {
        if (remapErr?.code === "23505") {
          await client.query("rollback");
          return res.status(409).json({
            ok: false,
            error: "MERGE_CONFLICT",
            detail: `Both products already have rows in ${table}; resolve the duplicate there before merging.`,
          });
        }
        await client.query("rollback to savepoint product_merge_remap");
        remapped[table] = null;
      }
    }

    await client.query(
      `
        update products
        set
          is_active = false,
          merged_into_product_id = $2,
          updated_at = now()
        where id = $1
      `,
      [sourceId, targetId]
    );

    await client.query("commit");
    return res.json({
      ok: true,
      source_product_id: sourceId,
      target_product_id: targetId,
      remapped,
      message: `Merged ${source.item_code} into ${target.item_code}. Source deactivated.`,
    });
  } catch (err) {
    await client.query("rollback");
    if (String(err?.message || "").includes("merged_into_product_id")) {
      return res.status(400).json({ ok: false, error: "MIGRATION_REQUIRED", message: "Apply migration 189_wave4_admin_safety_v1.sql" });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/clan-gap", requireProductAny("can_view"), async (req, res, next) => {
  try {
    const company = String(req.query.company || "AI").trim().toUpperCase() === "AT" ? "AT" : "AI";
    const activeOnly = String(req.query.active_only || "true").toLowerCase() !== "false";
    const limit = Number(req.query.limit || 80);
    const type = String(req.query.type || "").trim().toLowerCase();
    const report = await getClanProductMasterGapReport({ company, activeOnly, limit, type });
    if (!report.ok) return res.status(404).json(report);
    return res.json(report);
  } catch (err) {
    return next(err);
  }
});

router.post("/clan-gap/apply", requireProductAny("can_create"), async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const company = String(body.company || "AI").trim().toUpperCase() === "AT" ? "AT" : "AI";
    const all = body.all === true;
    if (all && String(body.confirm_phrase || "").trim() !== `MAP ${company}`) {
      return res.status(400).json({ ok: false, error: "CONFIRM_PHRASE_REQUIRED", detail: `Type MAP ${company} to map every open Clan gap.` });
    }
    const itemCodes = Array.isArray(body.item_codes) ? body.item_codes.slice(0, 500) : [];
    const result = await applyClanProductMapping({ company, itemCodes, all, actorUserId: req.user?.id || null });
    if (!result.ok) return res.status(result.error === "ITEM_CODES_REQUIRED" ? 400 : 404).json(result);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get("/categories", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `
        select id, category_name
        from product_categories
        where is_active = true
        order by category_name asc
      `
    );
    return res.json({ ok: true, categories: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/groups", async (req, res, next) => {
  try {
    const categoryId = typeof req.query.category_id === "string" ? Number(req.query.category_id) : null;
    const params = [];
    let where = `where pg.is_active = true`;
    if (Number.isFinite(categoryId)) {
      params.push(categoryId);
      where += ` and pg.category_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `
        select pg.id, pg.group_name, pg.category_id
        from product_groups pg
        ${where}
        order by pg.group_name asc
      `,
      params
    );
    return res.json({ ok: true, groups: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const categoryId = typeof req.query.category_id === "string" ? Number(req.query.category_id) : null;
    const groupId = typeof req.query.group_id === "string" ? Number(req.query.group_id) : null;
    const itemType = typeof req.query.item_type === "string" ? req.query.item_type.trim().toLowerCase() : "";
    const companyId = getActiveCompanyId(req);
    
    // Check if desk list mode requested or general search
    if (req.query.desk === "true" || req.query.detailed === "true") {
      const status = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
      const params = [];
      const where = [];

      let companyParam = "";
      if (companyId) {
        params.push(companyId);
        companyParam = `$${params.length}`;
      }

      if (q) {
        params.push(`%${q}%`);
        const searchParam = `$${params.length}`;
        where.push(`(
          p.sku ilike ${searchParam}
          or p.item_code ilike ${searchParam}
          or p.item_name ilike ${searchParam}
          or coalesce(p.brand, '') ilike ${searchParam}
          or coalesce(pc.category_name, '') ilike ${searchParam}
          or coalesce(pg.group_name, '') ilike ${searchParam}
          or coalesce(p.hsn_no, '') ilike ${searchParam}
        )`);
      }
      if (Number.isFinite(categoryId) && categoryId > 0) {
        params.push(categoryId);
        where.push(`p.category_id = $${params.length}`);
      }
      if (Number.isFinite(groupId) && groupId > 0) {
        params.push(groupId);
        where.push(`p.group_id = $${params.length}`);
      }
      if (itemType) {
        params.push(itemType);
        where.push(`lower(coalesce(p.item_type, '')) = $${params.length}`);
      }
      if (status === "active") where.push(`p.is_active = true`);
      if (status === "inactive") where.push(`p.is_active = false`);

      const whereSql = where.length ? `where ${where.join(" and ")}` : "";
      const { rows } = await pool.query(
        `
          select
            p.id,
            coalesce(p.sku, p.item_code) as sku,
            p.item_code,
            p.item_name,
            p.brand,
            p.item_type,
            p.uom,
            p.hsn_no,
            p.gst_pct,
            p.list_price,
            p.standard_cost,
            p.selling_price,
            p.min_safety_stock,
            p.reorder_quantity,
            coalesce(cpp.preferred_vendor_id, p.preferred_vendor_id) as preferred_vendor_id,
            p.specifications_json,
            p.technical_notes,
            p.description,
            p.serial_no_required,
            p.family_key,
            p.module_role,
            p.variant_key,
            coalesce(cpp.is_manufactured, p.is_manufactured, false) as is_manufactured,
            coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
            cpp.sourcing_mode,
            cpp.intercompany_source_company_id,
            p.is_active,
            p.updated_at,
            p.category_id,
            p.group_id,
            pc.category_name,
            pg.group_name,
            coalesce(v.company_name, case when cpp.sourcing_mode = 'buy_intercompany' then coalesce(src_c.company_code, 'AT (Intercompany)') end) as preferred_vendor_name,
            v.vendor_code as preferred_vendor_code
          from products p
          ${companyParam ? `left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = ${companyParam}` : "left join company_product_policies cpp on cpp.product_id = p.id and false"}
          left join companies src_c on src_c.id = cpp.intercompany_source_company_id
          left join product_categories pc on pc.id = p.category_id
          left join product_groups pg on pg.id = p.group_id
          left join vendors v on v.id = coalesce(cpp.preferred_vendor_id, p.preferred_vendor_id)
          ${whereSql}
          order by p.item_code asc
          limit 500
        `,
        params
      );

      // Also compute macro KPIs for Product Master Desk
      const statsRes = await pool.query(
        `
          select
            count(*)::int as total_products,
            count(*) filter (where is_active = true)::int as active_products,
            count(*) filter (where lower(item_type) in ('finished_good', 'fg'))::int as finished_goods_count,
            count(*) filter (where lower(item_type) in ('raw_material', 'rm'))::int as raw_materials_count,
            count(*) filter (where lower(item_type) in ('sub_assembly', 'sa'))::int as sub_assemblies_count,
            count(*) filter (where lower(item_type) in ('spare_part', 'spare'))::int as spare_parts_count,
            coalesce(sum(standard_cost), 0)::numeric(18,2) as total_standard_cost_val
          from products
        `
      );

      return res.json({
        ok: true,
        products: rows,
        stats: statsRes.rows[0] || {},
      });
    }

    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const mode = typeof req.query.mode === "string" ? req.query.mode.trim().toLowerCase() : "sale";
    const shouldBrowseByFilter = !q && (Number.isFinite(categoryId) || Number.isFinite(groupId));
    const products = await lookupProducts(pool, {
      companyId,
      q,
      categoryId,
      groupId,
      mode,
      limit: shouldBrowseByFilter ? 100 : 50,
    });
    return res.json({ ok: true, products });
  } catch (err) {
    return next(err);
  }
});

// Single product details
router.get("/:id", requireProductAny("can_view"), async (req, res, next) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
    const companyId = getActiveCompanyId(req) || null;
    const product = await getProductById(pool, productId, companyId);
    if (!product) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, product });
  } catch (err) {
    return next(err);
  }
});

// Create product from Product Desk
router.post("/", requireProductAny("can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const activeCompanyId = getActiveCompanyId(req) || null;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    await client.query("begin");
    const productId = await saveProduct(client, body, {
      companyId: activeCompanyId,
      updateCompanyPolicy: true,
    });
    const product = await getProductById(client, productId, activeCompanyId);
    await client.query("commit");
    return res.status(201).json({ ok: true, product });
  } catch (err) {
    await client.query("rollback");
    if (["ITEM_CODE_REQUIRED", "CATEGORY_REQUIRED", "GROUP_REQUIRED"].includes(err?.message)) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_ITEM_CODE" });
    return next(err);
  } finally {
    client.release();
  }
});

// Update product from Product Desk
router.put("/:id", requireProductAny("can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const activeCompanyId = getActiveCompanyId(req) || null;
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    await client.query("begin");
    const existingRes = await client.query(`select id, item_code from products where id = $1 limit 1`, [productId]);
    if (!existingRes.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (itemCodeChangeAttempted(existingRes.rows[0].item_code, body)) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "ITEM_CODE_FROZEN",
        detail: "Item code is locked after create. Use controlled rename/merge.",
      });
    }
    await saveProduct(client, body, {
      existingId: productId,
      companyId: activeCompanyId,
      updateCompanyPolicy: true,
    });
    const product = await getProductById(client, productId, activeCompanyId);
    await client.query("commit");
    return res.json({ ok: true, product });
  } catch (err) {
    await client.query("rollback");
    if (["ITEM_CODE_REQUIRED", "CATEGORY_REQUIRED", "GROUP_REQUIRED"].includes(err?.message)) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_ITEM_CODE" });
    return next(err);
  } finally {
    client.release();
  }
});

// Delete product with BOM reference validation guardrail
router.delete("/:id", requireProductAny("can_approve"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
    const codeRes = await client.query(`select item_code from products where id = $1 limit 1`, [productId]);
    if (!codeRes.rows[0]) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!checkTypedConfirm(req, res, `DELETE ${String(codeRes.rows[0].item_code || productId).trim()}`, "a permanent product delete")) {
      return undefined;
    }

    // 1. BOM Reference Validation: Check if mapped as Finished Good in active or draft BOMs
    const fgBomRes = await client.query(
      `select id, bom_name, revision_no, lifecycle_state from manufacturing_boms where finished_good_product_id = $1 limit 5`,
      [productId]
    );
    if (fgBomRes.rows.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "PRODUCT_IN_BOM_AS_FINISHED_GOOD",
        message: `Cannot delete product. It is mapped as Finished Good in BOM '${fgBomRes.rows[0].bom_name}' (Rev ${fgBomRes.rows[0].revision_no}, State: ${fgBomRes.rows[0].lifecycle_state}).`,
        boms: fgBomRes.rows,
      });
    }

    // 2. BOM Reference Validation: Check if mapped as line component in active BOM lines
    const lineBomRes = await client.query(
      `select mb.id, mb.bom_name, mb.revision_no, mbl.item_code 
       from manufacturing_bom_lines mbl
       join manufacturing_boms mb on mb.id = mbl.manufacturing_bom_id
       where mbl.product_id = $1 or mbl.component_specification_id in (select id from component_specifications where generic_code = (select item_code from products where id = $1))
       limit 5`,
      [productId]
    );
    if (lineBomRes.rows.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "PRODUCT_IN_BOM_AS_COMPONENT",
        message: `Cannot delete product. It is referenced as a component in BOM '${lineBomRes.rows[0].bom_name}' (Rev ${lineBomRes.rows[0].revision_no}).`,
        boms: lineBomRes.rows,
      });
    }

    // 3. Work Order Reference Validation
    const woRes = await client.query(
      `select id, work_order_no, status from work_orders where finished_good_product_id = $1 limit 5`,
      [productId]
    );
    if (woRes.rows.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "PRODUCT_IN_WORK_ORDER",
        message: `Cannot delete product. It is tied to Work Order ${woRes.rows[0].work_order_no} (Status: ${woRes.rows[0].status}).`,
        work_orders: woRes.rows,
      });
    }

    await client.query("begin");
    await client.query(`delete from product_attributes where product_id = $1`, [productId]);
    await client.query(`delete from company_product_policies where product_id = $1`, [productId]);
    await client.query(`delete from mrp_planning_parameters where product_id = $1`, [productId]);
    await client.query(`delete from products where id = $1`, [productId]);
    await client.query("commit");

    return res.json({ ok: true, deleted_id: productId });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23503") {
      return res.status(400).json({
        ok: false,
        error: "FOREIGN_KEY_VIOLATION",
        message: "Cannot delete product. It is referenced by other transactional records in the system.",
      });
    }
    return next(err);
  } finally {
    client.release();
  }
});

// Bulk Excel Import & Export Endpoints
router.get("/excel/template", requireProductAny("can_view"), async (_req, res, next) => {
  const client = await pool.connect();
  try {
    const workbook = await buildProductWorkbookTemplateBuffer(client);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="ProductMaster_Guided_Import.xlsx"');
    return res.status(200).send(workbook);
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/excel/current-workbook", requireProductAny("can_view"), async (_req, res, next) => {
  const client = await pool.connect();
  try {
    const exportArtifact = await buildCurrentProductWorkbookExport(client);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${exportArtifact.fileName}"`);
    return res.status(200).send(exportArtifact.buffer);
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/excel/preview", requireProductAny("can_edit"), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: "NO_FILE" });
    const preview = await previewProductWorkbook(pool, req.file.buffer, req.file.originalname || "");
    return res.json({ ok: true, preview });
  } catch (err) {
    if (err?.message === "PRODUCTS_SHEET_REQUIRED") return res.status(400).json({ ok: false, error: err.message });
    if (err?.message === "INCONSISTENT_PRODUCT_ROWS") return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    return next(err);
  }
});

router.post("/excel/apply", requireProductAny("can_approve"), upload.single("file"), async (req, res, next) => {
  if (!checkTypedConfirm(req, res, PRODUCT_APPLY_PHRASE, "a Product Master upload")) return undefined;
  const client = await pool.connect();
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: "NO_FILE" });
    await client.query("begin");
    const summary = await applyProductWorkbookImport(client, req.file.buffer, req.file.originalname || "");
    await client.query("commit");
    return res.json({ ok: true, summary });
  } catch (err) {
    await client.query("rollback");
    if (err?.message === "PRODUCTS_SHEET_REQUIRED") return res.status(400).json({ ok: false, error: err.message });
    if (err?.message === "INCONSISTENT_PRODUCT_ROWS") return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    if (["ITEM_CODE_REQUIRED", "CATEGORY_REQUIRED", "GROUP_REQUIRED"].includes(err?.message)) {
      return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    }
    if (err?.message === "DUPLICATE_ITEM_CODE_ROWS") return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    if (err?.message === "DUPLICATE_COMPANY_ITEM_ROWS") return res.status(400).json({ ok: false, error: err.message, details: err.details || null });
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
