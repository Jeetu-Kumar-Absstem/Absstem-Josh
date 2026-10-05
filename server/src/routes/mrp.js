const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const {
  calculateNetMaterialRequirements,
  generatePurchaseRequisitionsFromMrp,
  convertRequisitionToPurchaseOrder,
  evaluateSupplierPerformance,
} = require("../services/mrpPlanning");

const router = express.Router();

function cleanText(value, max = 255) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * 1. Net Material Requirements Engine (MRP II)
 */
router.get("/net-requirements", requireScreenAction("mrp_planning_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const requirements = await calculateNetMaterialRequirements(pool, companyId);
    return res.json({ ok: true, requirements });
  } catch (error) {
    return next(error);
  }
});

router.post("/generate-requisitions", requireScreenAction("mrp_planning_desk", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    await client.query("begin");
    const result = await generatePurchaseRequisitionsFromMrp(client, {
      companyId,
      items,
      userId: req.user?.id || null,
    });
    await client.query("commit");

    return res.status(201).json({ ok: true, ...result });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

/**
 * 2. Purchase Requisitions Management
 */
router.get("/requisitions", requireScreenAction("mrp_planning_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const status = cleanText(req.query.status, 30);

    let query = `
      select
        pr.*,
        v.company_name as vendor_name,
        v.vendor_code,
        po.po_number,
        (
          select count(*)
          from purchase_requisition_lines prl
          where prl.purchase_requisition_id = pr.id
        ) as total_lines
      from purchase_requisitions pr
      left join vendors v on v.id = pr.vendor_id
      left join purchase_orders po on po.id = pr.po_converted_id
      where (pr.company_id = $1 or pr.company_id is null)
    `;
    const params = [companyId];

    if (status) {
      params.push(status);
      query += ` and pr.requisition_status = $${params.length}`;
    }

    query += ` order by pr.requisition_date desc, pr.id desc limit 150`;

    const result = await pool.query(query, params);
    return res.json({ ok: true, requisitions: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/requisitions/:id/convert-to-po", requireScreenAction("mrp_planning_desk", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const requisitionId = Number(req.params.id);
    const vendorId = req.body?.vendor_id ? Number(req.body.vendor_id) : null;

    if (!requisitionId || requisitionId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_REQUISITION_ID" });
    }

    await client.query("begin");
    const po = await convertRequisitionToPurchaseOrder(client, {
      companyId,
      requisitionId,
      vendorId,
      userId: req.user?.id || null,
    });
    await client.query("commit");

    return res.status(201).json({ ok: true, purchase_order: po, message: "Requisition successfully converted to Purchase Order." });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

/**
 * 3. MRP Parameters CRUD
 */
router.get("/parameters", requireScreenAction("mrp_planning_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select
          mpp.*,
          v.company_name as preferred_vendor_name,
          p.product_name
        from mrp_planning_parameters mpp
        left join vendors v on v.id = mpp.preferred_vendor_id
        left join products p on p.id = mpp.product_id
        where (mpp.company_id = $1 or mpp.company_id is null)
        order by mpp.item_code asc
      `,
      [companyId]
    );
    return res.json({ ok: true, parameters: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/parameters", requireScreenAction("mrp_planning_desk", "can_create"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const itemCode = cleanText(req.body?.item_code, 100);
    const itemName = cleanText(req.body?.item_name, 255);
    const safetyStock = Number(req.body?.safety_stock || 0);
    const reorderPoint = Number(req.body?.reorder_point || 0);
    const reorderQty = Number(req.body?.reorder_qty || 0);
    const leadTimeDays = Number(req.body?.lead_time_days || 7);
    const preferredVendorId = req.body?.preferred_vendor_id ? Number(req.body.preferred_vendor_id) : null;

    if (!itemCode || !itemName) {
      return res.status(400).json({ ok: false, error: "MISSING_REQUIRED_FIELDS" });
    }

    const insRes = await pool.query(
      `
        insert into mrp_planning_parameters (
          company_id, item_code, item_name, uom, safety_stock,
          reorder_point, reorder_qty, lead_time_days, preferred_vendor_id,
          auto_reorder, notes, created_by
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        on conflict (company_id, item_code) do update
        set item_name = excluded.item_name,
            safety_stock = excluded.safety_stock,
            reorder_point = excluded.reorder_point,
            reorder_qty = excluded.reorder_qty,
            lead_time_days = excluded.lead_time_days,
            preferred_vendor_id = excluded.preferred_vendor_id,
            auto_reorder = excluded.auto_reorder,
            notes = excluded.notes,
            updated_at = now()
        returning *
      `,
      [
        companyId,
        itemCode,
        itemName,
        cleanText(req.body?.uom, 20) || "NOS",
        safetyStock,
        reorderPoint,
        reorderQty,
        leadTimeDays,
        preferredVendorId,
        req.body?.auto_reorder !== false,
        cleanText(req.body?.notes, 500),
        req.user?.id || null,
      ]
    );

    return res.status(201).json({ ok: true, parameter: insRes.rows[0] });
  } catch (error) {
    return next(error);
  }
});

/**
 * 4. Supplier Performance Tracker
 */
router.get("/supplier-performance", requireScreenAction("mrp_planning_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const performance = await evaluateSupplierPerformance(pool, companyId);
    return res.json({ ok: true, performance });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
