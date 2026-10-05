const { pool } = require("../db/pool");
const { recalcStockBalances } = require("./stockLedger");
const { generateInvoiceFromDispatch } = require("./financeAccounting");
const { autoRegisterEquipmentFromDispatch } = require("./serviceMaintenance");

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

/**
 * Creates and confirms an Outbound Dispatch Shipment.
 * Deducts finished items from inventory ledger if stock is available.
 */
async function processSalesDispatch(client, {
  companyId,
  salesOrderId,
  dispatchDate = new Date(),
  transporterName = null,
  lrNo = null,
  vehicleNo = null,
  trackingRef = null,
  carrierName = null,
  driverContact = null,
  totalPackages = 1,
  grossWeightKg = 0,
  remarks = null,
  userId = null,
}) {
  // Load Sales Order
  const soRes = await client.query(
    `
      select
        so.id, so.so_number, so.customer_id, so.distributor_id,
        so.shipping_address, c.customer_name, so.order_status
      from sales_orders so
      join customers c on c.id = so.customer_id
      where so.id = $1 and so.company_id = $2
      limit 1
    `,
    [salesOrderId, companyId]
  );
  const so = soRes.rows[0];
  if (!so) {
    const err = new Error("SALES_ORDER_NOT_FOUND");
    err.status = 404;
    throw err;
  }

  // Load Order Lines
  const linesRes = await client.query(
    `
      select id, line_no, product_id, item_code, item_name, line_description, qty, gst_pct
      from sales_order_lines
      where sales_order_id = $1
      order by line_no asc
    `,
    [salesOrderId]
  );
  const soLines = linesRes.rows;

  // Generate Dispatch Number
  const numRes = await client.query(`select next_company_document_number($1, 'DSP') as dsp_num`, [companyId]);
  const dispatchNumber = numRes.rows[0]?.dsp_num || `DSP-${Date.now().toString(36).toUpperCase()}`;

  // Create Dispatch Record
  const dispatchRes = await client.query(
    `
      insert into dispatches (
        company_id, dispatch_number, sales_order_id, customer_id, distributor_id,
        dispatch_status, dispatch_date, transporter_name, lr_no, vehicle_no,
        tracking_ref, carrier_name, driver_contact, total_packages, gross_weight_kg,
        consignee_name, consignee_address, remarks, stock_deducted, created_by
      )
      values (
        $1, $2, $3, $4, $5, 'dispatched', $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, true, $18
      )
      returning *
    `,
    [
      companyId,
      dispatchNumber,
      salesOrderId,
      so.customer_id,
      so.distributor_id,
      dispatchDate,
      transporterName,
      lrNo,
      vehicleNo,
      trackingRef,
      carrierName,
      driverContact,
      totalPackages,
      grossWeightKg,
      so.customer_name,
      so.shipping_address,
      remarks,
      userId,
    ]
  );
  const dispatch = dispatchRes.rows[0];

  // Insert Dispatch Lines and create Stock Ledger Movement
  const affectedProductIds = [];
  for (const sol of soLines) {
    await client.query(
      `
        insert into dispatch_lines (
          dispatch_id, sales_order_line_id, line_no, item_code, item_name,
          line_description, qty_ordered, qty_dispatch, gst_pct
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        dispatch.id,
        sol.id,
        sol.line_no,
        sol.item_code,
        sol.item_name,
        sol.line_description,
        sol.qty,
        sol.qty,
        sol.gst_pct,
      ]
    );

    if (sol.product_id) {
      affectedProductIds.push(Number(sol.product_id));
      await client.query(
        `
          insert into stock_movements (
            company_id, product_id, qty_signed, movement_date,
            ref_type, ref_id, ref_line_id, created_by
          )
          values ($1, $2, $3, $4, 'SALES_DISPATCH', $5, $6, $7)
        `,
        [
          companyId,
          sol.product_id,
          -qty(sol.qty),
          dispatchDate,
          dispatch.id,
          sol.id,
          userId,
        ]
      );
    }
  }

  // Update Sales Order status to 'dispatched'
  await client.query(`update sales_orders set order_status = 'dispatched', updated_at = now() where id = $1`, [salesOrderId]);

  // Recalculate stock balances for all shipped products
  if (affectedProductIds.length) {
    await recalcStockBalances(client, companyId, affectedProductIds);
  }

  // Automatically generate compliant customer tax invoice & GL entries from confirmed dispatch
  try {
    await generateInvoiceFromDispatch(client, {
      companyId,
      dispatchId: dispatch.id,
      userId,
    });
  } catch (invErr) {
    console.warn("Auto-invoice generation on dispatch notice:", invErr?.message || invErr);
  }

  // Automatically register serialized equipment assets in service registry
  try {
    await autoRegisterEquipmentFromDispatch(client, {
      companyId,
      dispatchId: dispatch.id,
      userId,
    });
  } catch (srvErr) {
    console.warn("Auto-registration of equipment on dispatch notice:", srvErr?.message || srvErr);
  }

  return dispatch;
}

module.exports = {
  processSalesDispatch,
};
