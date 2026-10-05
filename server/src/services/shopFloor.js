const { pool } = require("../db/pool");
const { recalcStockBalances } = require("./stockLedger");

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

/**
 * Explodes a Master BOM for a target Work Order quantity and builds/refreshes the Work Order Kit lines.
 */
async function explodeWorkOrderBom(client, { workOrderId, companyId }) {
  const woRes = await client.query(
    `
      select
        wo.id, wo.company_id, wo.manufacturing_bom_id, wo.target_qty, wo.status,
        wo.finished_good_product_id, mb.bom_code, mb.lifecycle_state, mb.is_active
      from work_orders wo
      join manufacturing_boms mb on mb.id = wo.manufacturing_bom_id
      where wo.id = $1 and wo.company_id = $2
      limit 1
    `,
    [workOrderId, companyId]
  );
  const wo = woRes.rows[0];
  if (!wo) {
    const err = new Error("WORK_ORDER_NOT_FOUND");
    err.status = 404;
    throw err;
  }

  // Load active BOM lines
  const bomLinesRes = await client.query(
    `
      select
        mbl.id as bom_line_id,
        mbl.line_no,
        mbl.component_product_id,
        mbl.component_specification_id,
        mbl.item_code,
        mbl.item_name,
        mbl.uom,
        mbl.qty_per,
        mbl.remarks,
        cs.spec_code,
        cs.spec_name,
        coalesce(sb.stock_qty, 0) as current_stock_qty,
        coalesce(sb.average_unit_cost_base, 0) as average_unit_cost_base
      from manufacturing_bom_lines mbl
      left join component_specifications cs on cs.id = mbl.component_specification_id
      left join stock_balances sb on sb.product_id = mbl.component_product_id and sb.company_id = $1
      where mbl.manufacturing_bom_id = $2
      order by mbl.line_no asc
    `,
    [companyId, wo.manufacturing_bom_id]
  );

  const bomLines = bomLinesRes.rows;
  const targetQty = qty(wo.target_qty);

  // Upsert/re-calculate kit items
  const kits = [];
  for (const line of bomLines) {
    const qtyPer = qty(line.qty_per);
    const requiredQty = qty(qtyPer * targetQty);

    const existingKitRes = await client.query(
      `
        select id, issued_qty, scrapped_qty, returned_qty
        from work_order_kits
        where work_order_id = $1 and component_product_id = $2
        limit 1
      `,
      [workOrderId, line.component_product_id]
    );
    const existing = existingKitRes.rows[0];

    if (existing) {
      const updateRes = await client.query(
        `
          update work_order_kits
          set bom_line_id = $1,
              component_specification_id = $2,
              line_no = $3,
              item_code = $4,
              item_name = $5,
              uom = $6,
              qty_per_unit = $7,
              required_qty = $8,
              notes = $9,
              updated_at = now()
          where id = $10
          returning *
        `,
        [
          line.bom_line_id,
          line.component_specification_id,
          line.line_no,
          line.item_code,
          line.item_name,
          line.uom,
          qtyPer,
          requiredQty,
          line.remarks,
          existing.id,
        ]
      );
      kits.push({
        ...updateRes.rows[0],
        spec_code: line.spec_code,
        spec_name: line.spec_name,
        current_stock_qty: line.current_stock_qty,
        average_unit_cost_base: line.average_unit_cost_base,
      });
    } else {
      const insertRes = await client.query(
        `
          insert into work_order_kits (
            work_order_id, bom_line_id, component_product_id, component_specification_id,
            line_no, item_code, item_name, uom, qty_per_unit, required_qty,
            issued_qty, scrapped_qty, returned_qty, notes
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0, 0, $11)
          returning *
        `,
        [
          workOrderId,
          line.bom_line_id,
          line.component_product_id,
          line.component_specification_id,
          line.line_no,
          line.item_code,
          line.item_name,
          line.uom,
          qtyPer,
          requiredQty,
          line.remarks,
        ]
      );
      kits.push({
        ...insertRes.rows[0],
        spec_code: line.spec_code,
        spec_name: line.spec_name,
        current_stock_qty: line.current_stock_qty,
        average_unit_cost_base: line.average_unit_cost_base,
      });
    }
  }

  return kits;
}

/**
 * Issue material for a specific work order kit line.
 * Deducts stock from inventory ledger using current weighted-average unit cost.
 */
async function issueWorkOrderMaterial(client, {
  companyId,
  workOrderId,
  workOrderKitId,
  qtyToIssue,
  binLocation = null,
  lotNumber = null,
  barcodeScanned = null,
  userId = null,
  notes = null,
}) {
  const issueQty = qty(qtyToIssue);
  if (issueQty <= 0) {
    const err = new Error("INVALID_ISSUE_QUANTITY");
    err.status = 400;
    throw err;
  }

  // Load Kit Line and Work Order
  const kitRes = await client.query(
    `
      select
        k.id, k.work_order_id, k.component_product_id, k.required_qty,
        k.issued_qty, k.scrapped_qty, k.item_code, k.item_name,
        wo.company_id, wo.status as work_order_status
      from work_order_kits k
      join work_orders wo on wo.id = k.work_order_id
      where k.id = $1 and wo.id = $2 and wo.company_id = $3
      limit 1
    `,
    [workOrderKitId, workOrderId, companyId]
  );
  const kit = kitRes.rows[0];
  if (!kit) {
    const err = new Error("WORK_ORDER_KIT_NOT_FOUND");
    err.status = 404;
    throw err;
  }

  if (["completed", "cancelled"].includes(kit.work_order_status)) {
    const err = new Error("WORK_ORDER_CLOSED");
    err.status = 400;
    err.detail = `Cannot issue materials to a ${kit.work_order_status} work order.`;
    throw err;
  }

  // Get current inventory valuation and stock balance
  const balanceRes = await client.query(
    `
      select stock_qty, stock_value_base, average_unit_cost_base
      from stock_balances
      where company_id = $1 and product_id = $2
      limit 1
    `,
    [companyId, kit.component_product_id]
  );
  const balance = balanceRes.rows[0] || { stock_qty: 0, average_unit_cost_base: 0 };
  const availableStock = qty(balance.stock_qty);
  const unitCost = Number(balance.average_unit_cost_base || 0);

  if (availableStock < issueQty) {
    const err = new Error("INSUFFICIENT_STOCK");
    err.status = 400;
    err.code = "INSUFFICIENT_STOCK";
    err.detail = `Insufficient stock for ${kit.item_code}. Available: ${availableStock}, Requested: ${issueQty}`;
    err.available_stock = availableStock;
    err.requested_qty = issueQty;
    throw err;
  }

  const totalCost = Number((issueQty * unitCost).toFixed(4));

  // Log issuance in shop_floor_issuances
  const issuanceRes = await client.query(
    `
      insert into shop_floor_issuances (
        company_id, work_order_id, work_order_kit_id, product_id,
        qty_issued, unit_cost_base, total_cost_base,
        bin_location, lot_number, barcode_scanned, issued_by, notes
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      returning *
    `,
    [
      companyId,
      workOrderId,
      workOrderKitId,
      kit.component_product_id,
      issueQty,
      unitCost,
      totalCost,
      binLocation,
      lotNumber,
      barcodeScanned,
      userId,
      notes,
    ]
  );
  const issuance = issuanceRes.rows[0];

  // Update Work Order Kit issued count
  await client.query(
    `
      update work_order_kits
      set issued_qty = issued_qty + $1,
          updated_at = now()
      where id = $2
    `,
    [issueQty, workOrderKitId]
  );

  // If work order was 'scheduled', move to 'in_production'
  if (kit.work_order_status === "scheduled") {
    await client.query(
      `
        update work_orders
        set status = 'in_production',
            actual_start_at = coalesce(actual_start_at, now()),
            updated_at = now()
        where id = $1
      `,
      [workOrderId]
    );
  }

  // Record negative stock movement (deduct inventory)
  await client.query(
    `
      insert into stock_movements (
        company_id, product_id, qty_signed, movement_date,
        ref_type, ref_id, ref_line_id, unit_cost_base, created_by
      )
      values ($1, $2, $3, now(), 'SHOP_FLOOR_ISSUE', $4, $5, $6, $7)
    `,
    [
      companyId,
      kit.component_product_id,
      -issueQty,
      workOrderId,
      issuance.id,
      unitCost,
      userId,
    ]
  );

  // Recalculate stock balances and valuation for this component
  await recalcStockBalances(client, companyId, [kit.component_product_id]);

  return issuance;
}

/**
 * Log scrap/waste during assembly for variance tracking.
 */
async function logWorkOrderScrap(client, {
  companyId,
  workOrderId,
  workOrderKitId = null,
  productId,
  qtyScrapped,
  reasonCode = "DAMAGED_IN_ASSEMBLY",
  stageName = null,
  userId = null,
  remarks = null,
}) {
  const scrapQty = qty(qtyScrapped);
  if (scrapQty <= 0) {
    const err = new Error("INVALID_SCRAP_QUANTITY");
    err.status = 400;
    throw err;
  }

  const prodId = Number(productId);
  if (!Number.isFinite(prodId) || prodId <= 0) {
    const err = new Error("INVALID_PRODUCT_ID");
    err.status = 400;
    throw err;
  }

  // Get current component valuation
  const balanceRes = await client.query(
    `
      select average_unit_cost_base
      from stock_balances
      where company_id = $1 and product_id = $2
      limit 1
    `,
    [companyId, prodId]
  );
  const unitCost = Number(balanceRes.rows[0]?.average_unit_cost_base || 0);
  const varianceCost = Number((scrapQty * unitCost).toFixed(4));

  const scrapRes = await client.query(
    `
      insert into shop_floor_scrap (
        company_id, work_order_id, work_order_kit_id, product_id,
        qty_scrapped, unit_cost_base, variance_cost_base,
        reason_code, stage_name, scrapped_by, remarks
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      returning *
    `,
    [
      companyId,
      workOrderId,
      workOrderKitId || null,
      prodId,
      scrapQty,
      unitCost,
      varianceCost,
      reasonCode,
      stageName,
      userId,
      remarks,
    ]
  );
  const scrap = scrapRes.rows[0];

  // Update Work Order Kit scrapped count if linked
  if (workOrderKitId) {
    await client.query(
      `
        update work_order_kits
        set scrapped_qty = scrapped_qty + $1,
            updated_at = now()
        where id = $2
      `,
      [scrapQty, workOrderKitId]
    );
  }

  // Increment total scrapped on work order
  await client.query(
    `
      update work_orders
      set scrapped_qty = scrapped_qty + $1,
          updated_at = now()
      where id = $2
    `,
    [scrapQty, workOrderId]
  );

  return scrap;
}

/**
 * Loads complete detail of a Work Order with exploded kits, issuances, and scrap records.
 */
async function getWorkOrderDetail(client, { workOrderId, companyId }) {
  const woRes = await client.query(
    `
      select
        wo.*,
        p.item_code as finished_good_item_code,
        p.item_name as finished_good_item_name,
        p.uom as finished_good_uom,
        mb.bom_code,
        mb.revision_code as bom_revision_code,
        mb.lifecycle_state as bom_lifecycle_state,
        u.name as created_by_name
      from work_orders wo
      join products p on p.id = wo.finished_good_product_id
      join manufacturing_boms mb on mb.id = wo.manufacturing_bom_id
      left join erp_users u on u.id = wo.created_by
      where wo.id = $1 and wo.company_id = $2
      limit 1
    `,
    [workOrderId, companyId]
  );
  const wo = woRes.rows[0];
  if (!wo) return null;

  // Kits with real-time stock balances and AVL spec
  const kitsRes = await client.query(
    `
      select
        k.*,
        cs.spec_code,
        cs.spec_name,
        cs.geometry,
        cs.material,
        cs.pressure_rating,
        coalesce(sb.stock_qty, 0) as current_stock_qty,
        coalesce(sb.average_unit_cost_base, 0) as average_unit_cost_base,
        greatest(0, k.required_qty - k.issued_qty) as pending_qty,
        case
          when k.issued_qty >= k.required_qty then 'FULLY_ISSUED'
          when k.issued_qty > 0 then 'PARTIAL_ISSUED'
          else 'PENDING'
        end as kitting_status
      from work_order_kits k
      left join component_specifications cs on cs.id = k.component_specification_id
      left join stock_balances sb on sb.product_id = k.component_product_id and sb.company_id = $1
      where k.work_order_id = $2
      order by k.line_no asc
    `,
    [companyId, workOrderId]
  );

  // Issuance history
  const issuancesRes = await client.query(
    `
      select
        i.*,
        p.item_code,
        p.item_name,
        p.uom,
        u.name as issued_by_name
      from shop_floor_issuances i
      join products p on p.id = i.product_id
      left join erp_users u on u.id = i.issued_by
      where i.work_order_id = $1 and i.company_id = $2
      order by i.issued_at desc
    `,
    [workOrderId, companyId]
  );

  // Scrap history
  const scrapRes = await client.query(
    `
      select
        s.*,
        p.item_code,
        p.item_name,
        p.uom,
        u.name as scrapped_by_name
      from shop_floor_scrap s
      join products p on p.id = s.product_id
      left join erp_users u on u.id = s.scrapped_by
      where s.work_order_id = $1 and s.company_id = $2
      order by s.scrapped_at desc
    `,
    [workOrderId, companyId]
  );

  return {
    work_order: wo,
    kits: kitsRes.rows,
    issuances: issuancesRes.rows,
    scrap: scrapRes.rows,
  };
}

module.exports = {
  explodeWorkOrderBom,
  issueWorkOrderMaterial,
  logWorkOrderScrap,
  getWorkOrderDetail,
};
