const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const {
  asInt,
  money,
  cleanText,
  listSpecifications,
  getSpecification,
  listAvl,
} = require("../services/componentAvl");

const router = express.Router();

router.get("/", requireScreenAction("manufacturing_boms", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const rows = await listSpecifications(pool, {
      companyId,
      q: typeof req.query.q === "string" ? req.query.q : "",
      limit: req.query.limit,
    });
    return res.json({ ok: true, specifications: rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireScreenAction("manufacturing_boms", "can_view"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    const spec = await getSpecification(pool, id, companyId);
    if (!spec) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const avl = await listAvl(pool, id);
    return res.json({ ok: true, specification: spec, avl });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("manufacturing_boms", "can_create"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const specCode = cleanText(body.spec_code, 80);
    const specName = cleanText(body.spec_name, 200);
    if (!specCode || !specName) return res.status(400).json({ ok: false, error: "SPEC_CODE_AND_NAME_REQUIRED" });

    const r = await pool.query(
      `
        insert into component_specifications (
          company_id, spec_code, spec_name, geometry, material, pressure_rating, uom, notes, created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        returning *
      `,
      [
        companyId,
        specCode,
        specName,
        cleanText(body.geometry, 120),
        cleanText(body.material, 80),
        cleanText(body.pressure_rating, 80),
        cleanText(body.uom, 40),
        cleanText(body.notes, 2000),
        req.user.id,
      ]
    );
    return res.status(201).json({ ok: true, specification: r.rows[0] });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_SPEC_CODE" });
    return next(err);
  }
});

router.patch("/:id", requireScreenAction("manufacturing_boms", "can_edit"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    const existing = await getSpecification(pool, id, companyId);
    if (!existing) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const r = await pool.query(
      `
        update component_specifications
        set spec_name = coalesce($2, spec_name),
            geometry = coalesce($3, geometry),
            material = coalesce($4, material),
            pressure_rating = coalesce($5, pressure_rating),
            uom = coalesce($6, uom),
            notes = coalesce($7, notes),
            is_active = coalesce($8, is_active),
            updated_at = now()
        where id = $1
        returning *
      `,
      [
        id,
        cleanText(body.spec_name, 200),
        body.geometry !== undefined ? cleanText(body.geometry, 120) : null,
        body.material !== undefined ? cleanText(body.material, 80) : null,
        body.pressure_rating !== undefined ? cleanText(body.pressure_rating, 80) : null,
        body.uom !== undefined ? cleanText(body.uom, 40) : null,
        body.notes !== undefined ? cleanText(body.notes, 2000) : null,
        typeof body.is_active === "boolean" ? body.is_active : null,
      ]
    );
    return res.json({ ok: true, specification: r.rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/avl", requireScreenAction("manufacturing_boms", "can_view"), async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    const spec = await getSpecification(pool, id, companyId);
    if (!spec) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const avl = await listAvl(pool, id);
    return res.json({ ok: true, avl, specification: spec });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/avl", requireScreenAction("manufacturing_boms", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    const spec = await getSpecification(client, id, companyId);
    if (!spec) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const vendorId = asInt(body.vendor_id);
    const productId = asInt(body.product_id);
    const vendorName = cleanText(body.vendor_name, 200);
    const brandName = cleanText(body.brand_name, 120);
    if (!vendorId && !productId && !vendorName) {
      return res.status(400).json({ ok: false, error: "VENDOR_OR_PRODUCT_REQUIRED" });
    }
    if (vendorId) {
      const vendorRes = await client.query(
        `select id from vendors where id = $1 and company_id = $2 and is_active = true limit 1`,
        [vendorId, companyId]
      );
      if (!vendorRes.rows[0]) return res.status(400).json({ ok: false, error: "VENDOR_NOT_FOUND" });
    }
    if (productId) {
      const productRes = await client.query(
        `select id from products where id = $1 and is_active = true limit 1`,
        [productId]
      );
      if (!productRes.rows[0]) return res.status(400).json({ ok: false, error: "PRODUCT_NOT_FOUND" });
    }

    if (body.is_preferred === true) {
      await client.query(
        `update component_specification_avl set is_preferred = false, updated_at = now() where component_specification_id = $1`,
        [id]
      );
    }

    const r = await client.query(
      `
        insert into component_specification_avl (
          component_specification_id,
          vendor_id,
          product_id,
          vendor_name,
          brand_name,
          is_preferred,
          is_active,
          freight_percentage,
          import_duty_percentage,
          lead_time_days,
          unit_price_hint,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,$5,$6,coalesce($7,true),$8,$9,$10,$11,$12,$13)
        returning *
      `,
      [
        id,
        vendorId,
        productId,
        vendorName,
        brandName,
        body.is_preferred === true,
        typeof body.is_active === "boolean" ? body.is_active : true,
        money(body.freight_percentage),
        money(body.import_duty_percentage),
        Math.max(0, asInt(body.lead_time_days) || 0),
        body.unit_price_hint === "" || body.unit_price_hint == null ? null : money(body.unit_price_hint),
        cleanText(body.remarks, 1000),
        req.user.id,
      ]
    );
    const avl = await listAvl(client, id);
    return res.status(201).json({ ok: true, entry: r.rows[0], avl });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_AVL_ENTRY" });
    return next(err);
  } finally {
    client.release();
  }
});

router.patch("/:id/avl/:avlId", requireScreenAction("manufacturing_boms", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = asInt(req.params.id);
    const avlId = asInt(req.params.avlId);
    if (!id || !avlId) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    const spec = await getSpecification(client, id, companyId);
    if (!spec) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (body.is_preferred === true) {
      await client.query(
        `update component_specification_avl set is_preferred = false, updated_at = now() where component_specification_id = $1`,
        [id]
      );
    }

    const r = await client.query(
      `
        update component_specification_avl
        set vendor_id = coalesce($3, vendor_id),
            product_id = coalesce($4, product_id),
            vendor_name = coalesce($5, vendor_name),
            brand_name = coalesce($6, brand_name),
            is_preferred = coalesce($7, is_preferred),
            is_active = coalesce($8, is_active),
            freight_percentage = coalesce($9, freight_percentage),
            import_duty_percentage = coalesce($10, import_duty_percentage),
            lead_time_days = coalesce($11, lead_time_days),
            unit_price_hint = coalesce($12, unit_price_hint),
            remarks = coalesce($13, remarks),
            updated_at = now()
        where id = $1 and component_specification_id = $2
        returning *
      `,
      [
        avlId,
        id,
        asInt(body.vendor_id),
        asInt(body.product_id),
        body.vendor_name !== undefined ? cleanText(body.vendor_name, 200) : null,
        body.brand_name !== undefined ? cleanText(body.brand_name, 120) : null,
        typeof body.is_preferred === "boolean" ? body.is_preferred : null,
        typeof body.is_active === "boolean" ? body.is_active : null,
        body.freight_percentage !== undefined ? money(body.freight_percentage) : null,
        body.import_duty_percentage !== undefined ? money(body.import_duty_percentage) : null,
        body.lead_time_days !== undefined ? Math.max(0, asInt(body.lead_time_days) || 0) : null,
        body.unit_price_hint !== undefined
          ? body.unit_price_hint === "" || body.unit_price_hint == null
            ? null
            : money(body.unit_price_hint)
          : null,
        body.remarks !== undefined ? cleanText(body.remarks, 1000) : null,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "AVL_NOT_FOUND" });
    const avl = await listAvl(client, id);
    return res.json({ ok: true, entry: r.rows[0], avl });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
