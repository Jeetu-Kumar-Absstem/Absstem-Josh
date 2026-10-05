const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const {
  explodeWorkOrderBom,
  issueWorkOrderMaterial,
  logWorkOrderScrap,
  getWorkOrderDetail,
} = require("../services/shopFloor");

const router = express.Router();

function cleanText(value, max = 255) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * List active & historical Work Orders
 */
router.get("/work-orders", requireScreenAction("shop_floor", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const status = req.query.status ? String(req.query.status).trim() : null;

    let query = `
      select
        wo.*,
        p.item_code as finished_good_item_code,
        p.item_name as finished_good_item_name,
        p.uom as finished_good_uom,
        mb.bom_code,
        mb.revision_code as bom_revision_code,
        (
          select count(*)
          from work_order_kits wok
          where wok.work_order_id = wo.id
        ) as total_components,
        (
          select count(*)
          from work_order_kits wok
          where wok.work_order_id = wo.id and wok.issued_qty >= wok.required_qty
        ) as fulfilled_components,
        (
          select coalesce(sum(s.variance_cost_base), 0)
          from shop_floor_scrap s
          where s.work_order_id = wo.id
        ) as total_scrap_variance_cost
      from work_orders wo
      join products p on p.id = wo.finished_good_product_id
      join manufacturing_boms mb on mb.id = wo.manufacturing_bom_id
      where wo.company_id = $1
    `;
    const params = [companyId];

    if (status && ["scheduled", "in_production", "completed", "cancelled"].includes(status)) {
      params.push(status);
      query += ` and wo.status = $${params.length}`;
    }

    query += ` order by case when wo.status in ('scheduled', 'in_production') then 0 else 1 end, wo.scheduled_start_date asc nulls last, wo.id desc`;

    const result = await pool.query(query, params);
    return res.json({ ok: true, work_orders: result.rows });
  } catch (error) {
    return next(error);
  }
});

/**
 * Get full Work Order detail (Kitting, Issuances, Scrap, Availability)
 */
router.get("/work-orders/:id", requireScreenAction("shop_floor", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const workOrderId = Number(req.params.id);
    if (!Number.isFinite(workOrderId) || workOrderId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_WORK_ORDER_ID" });
    }

    const detail = await getWorkOrderDetail(pool, { workOrderId, companyId });
    if (!detail) {
      return res.status(404).json({ ok: false, error: "WORK_ORDER_NOT_FOUND" });
    }

    return res.json({ ok: true, ...detail });
  } catch (error) {
    return next(error);
  }
});

/**
 * Create a new Work Order from a locked Master BOM & explode kitting list
 */
router.post("/work-orders", requireScreenAction("shop_floor", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const bomId = Number(req.body?.manufacturing_bom_id);
    const targetQty = Number(req.body?.target_qty) || 1;
    const priority = cleanText(req.body?.priority, 20) || "normal";
    const batchNumber = cleanText(req.body?.batch_number, 80);
    const remarks = cleanText(req.body?.remarks, 500);
    const scheduledStartDate = req.body?.scheduled_start_date || new Date().toISOString().slice(0, 10);
    const scheduledEndDate = req.body?.scheduled_end_date || null;

    if (!Number.isFinite(bomId) || bomId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_BOM_ID" });
    }
    if (targetQty <= 0) {
      return res.status(400).json({ ok: false, error: "TARGET_QTY_MUST_BE_POSITIVE" });
    }

    await client.query("begin");

    // Fetch BOM and ensure it is valid
    const bomRes = await client.query(
      `
        select id, company_id, finished_good_product_id, bom_code, lifecycle_state, is_active
        from manufacturing_boms
        where id = $1 and company_id = $2
        limit 1
      `,
      [bomId, companyId]
    );
    const bom = bomRes.rows[0];
    if (!bom) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "BOM_NOT_FOUND" });
    }

    // Generate Work Order No
    const numRes = await client.query(`select next_company_document_number($1, 'WO') as wo_num`, [companyId]);
    const workOrderNo = numRes.rows[0]?.wo_num || `WO-${Date.now().toString(36).toUpperCase()}`;

    const insertWoRes = await client.query(
      `
        insert into work_orders (
          company_id, work_order_no, manufacturing_bom_id, finished_good_product_id,
          target_qty, priority, scheduled_start_date, scheduled_end_date,
          batch_number, remarks, created_by
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        returning *
      `,
      [
        companyId,
        workOrderNo,
        bom.id,
        bom.finished_good_product_id,
        targetQty,
        priority,
        scheduledStartDate,
        scheduledEndDate,
        batchNumber,
        remarks,
        req.user?.id || null,
      ]
    );
    const workOrder = insertWoRes.rows[0];

    // Explode BOM into Kitting Pick List
    const kits = await explodeWorkOrderBom(client, {
      workOrderId: workOrder.id,
      companyId,
    });

    await client.query("commit");
    return res.status(201).json({
      ok: true,
      work_order: workOrder,
      kits,
    });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

/**
 * Issue materials for a specific Work Order kit line
 */
router.post("/work-orders/:id/issue", requireScreenAction("shop_floor", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const workOrderId = Number(req.params.id);
    const workOrderKitId = Number(req.body?.work_order_kit_id);
    const qtyToIssue = Number(req.body?.qty_issued);
    const binLocation = cleanText(req.body?.bin_location, 50);
    const lotNumber = cleanText(req.body?.lot_number, 50);
    const barcodeScanned = cleanText(req.body?.barcode_scanned, 100);
    const notes = cleanText(req.body?.notes, 255);

    if (!Number.isFinite(workOrderId) || workOrderId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_WORK_ORDER_ID" });
    }
    if (!Number.isFinite(workOrderKitId) || workOrderKitId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_WORK_ORDER_KIT_ID" });
    }
    if (!Number.isFinite(qtyToIssue) || qtyToIssue <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_ISSUE_QUANTITY" });
    }

    await client.query("begin");

    const issuance = await issueWorkOrderMaterial(client, {
      companyId,
      workOrderId,
      workOrderKitId,
      qtyToIssue,
      binLocation,
      lotNumber,
      barcodeScanned,
      userId: req.user?.id || null,
      notes,
    });

    await client.query("commit");
    return res.status(201).json({
      ok: true,
      issuance,
      message: "Material issued successfully and deducted from inventory ledger.",
    });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

/**
 * Log Component Scrap / Waste during Assembly
 */
router.post("/work-orders/:id/scrap", requireScreenAction("shop_floor", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const workOrderId = Number(req.params.id);
    const workOrderKitId = req.body?.work_order_kit_id ? Number(req.body.work_order_kit_id) : null;
    const productId = Number(req.body?.product_id);
    const qtyScrapped = Number(req.body?.qty_scrapped);
    const reasonCode = cleanText(req.body?.reason_code, 50) || "DAMAGED_IN_ASSEMBLY";
    const stageName = cleanText(req.body?.stage_name, 100);
    const remarks = cleanText(req.body?.remarks, 255);

    if (!Number.isFinite(workOrderId) || workOrderId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_WORK_ORDER_ID" });
    }
    if (!Number.isFinite(productId) || productId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_PRODUCT_ID" });
    }
    if (!Number.isFinite(qtyScrapped) || qtyScrapped <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_SCRAP_QUANTITY" });
    }

    await client.query("begin");

    const scrap = await logWorkOrderScrap(client, {
      companyId,
      workOrderId,
      workOrderKitId,
      productId,
      qtyScrapped,
      reasonCode,
      stageName,
      userId: req.user?.id || null,
      remarks,
    });

    await client.query("commit");
    return res.status(201).json({
      ok: true,
      scrap,
      message: "Scrap recorded and variance cost calculated.",
    });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

/**
 * Update Work Order Status (e.g., mark completed or cancelled)
 */
router.patch("/work-orders/:id/status", requireScreenAction("shop_floor", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const workOrderId = Number(req.params.id);
    const status = cleanText(req.body?.status, 30);
    const completedQty = req.body?.completed_qty !== undefined ? Number(req.body.completed_qty) : null;

    if (!["scheduled", "in_production", "completed", "cancelled"].includes(status)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }

    await client.query("begin");
    const updateRes = await client.query(
      `
        update work_orders
        set status = $1,
            completed_qty = coalesce($2, completed_qty),
            actual_completed_at = case when $1 = 'completed' then coalesce(actual_completed_at, now()) else actual_completed_at end,
            updated_at = now()
        where id = $3 and company_id = $4
        returning *
      `,
      [status, completedQty, workOrderId, companyId]
    );

    if (!updateRes.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "WORK_ORDER_NOT_FOUND" });
    }

    await client.query("commit");
    return res.json({ ok: true, work_order: updateRes.rows[0] });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
