const { pool } = require("../db/pool");
const { recalcStockBalances } = require("./stockLedger");
const { getOrCreateGlAccount, postGlDoubleEntry } = require("./financeAccounting");

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

/**
 * Auto-registers installed serialized equipment upon dispatch confirmation.
 */
async function autoRegisterEquipmentFromDispatch(client, { companyId, dispatchId, userId = null }) {
  const dRes = await client.query(
    `
      select
        d.id as dispatch_id,
        d.sales_order_id,
        d.customer_id,
        d.work_order_id,
        c.customer_name,
        so.shipping_address
      from dispatches d
      join customers c on c.id = d.customer_id
      left join sales_orders so on so.id = d.sales_order_id
      where d.id = $1 and (d.company_id = $2 or d.company_id is null)
      limit 1
    `,
    [dispatchId, companyId]
  );
  const dispatch = dRes.rows[0];
  if (!dispatch) return [];

  const linesRes = await client.query(
    `
      select
        dl.*,
        sol.manufacturing_bom_id
      from dispatch_lines dl
      left join sales_order_lines sol on sol.id = dl.sales_order_line_id
      where dl.dispatch_id = $1
    `,
    [dispatchId]
  );

  const createdAssets = [];
  const today = new Date();
  const warrantyEnd = new Date(today);
  warrantyEnd.setFullYear(warrantyEnd.getFullYear() + 1); // 1 Year Default Warranty

  for (const line of linesRes.rows) {
    const lineQty = Math.max(1, Math.floor(Number(line.qty_dispatch || 1)));
    for (let i = 1; i <= lineQty; i += 1) {
      const serialNumber = `SN-${line.item_code}-${dispatch.dispatch_id}-${i}-${Date.now().toString(36).toUpperCase()}`;
      
      const insRes = await client.query(
        `
          insert into installed_equipment (
            company_id, serial_number, product_id, item_code, item_name,
            customer_id, sales_order_id, dispatch_id, work_order_id,
            manufacturing_bom_id, site_location, site_address,
            commissioning_date, warranty_start_date, warranty_end_date,
            equipment_status, notes, created_by
          )
          values (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12,
            $13, $14, $15,
            'operational', $16, $17
          )
          on conflict (company_id, serial_number) do nothing
          returning *
        `,
        [
          companyId,
          serialNumber,
          line.product_id,
          line.item_code,
          line.item_name,
          dispatch.customer_id,
          dispatch.sales_order_id,
          dispatch.dispatch_id,
          dispatch.work_order_id,
          line.manufacturing_bom_id,
          dispatch.customer_name,
          dispatch.shipping_address,
          today,
          today,
          warrantyEnd,
          `Auto-registered on dispatch shipment #${dispatchId}`,
          userId,
        ]
      );
      if (insRes.rows[0]) createdAssets.push(insRes.rows[0]);
    }
  }

  return createdAssets;
}

/**
 * Checks warranty and AMC status for an installed equipment.
 */
async function checkEquipmentCoverage(client, equipmentId) {
  const eqRes = await client.query(
    `
      select
        ie.*,
        c.customer_name
      from installed_equipment ie
      join customers c on c.id = ie.customer_id
      where ie.id = $1
      limit 1
    `,
    [equipmentId]
  );
  const eq = eqRes.rows[0];
  if (!eq) return { isUnderWarranty: false, isUnderAmc: false, activeAmc: null };

  const now = new Date();
  const isUnderWarranty = eq.warranty_end_date ? new Date(eq.warranty_end_date) >= now : false;

  const amcRes = await client.query(
    `
      select *
      from amc_contracts
      where (installed_equipment_id = $1 or customer_id = $2)
        and contract_status = 'active'
        and end_date >= current_date
      order by end_date desc
      limit 1
    `,
    [equipmentId, eq.customer_id]
  );
  const activeAmc = amcRes.rows[0] || null;

  return {
    isUnderWarranty,
    isUnderAmc: Boolean(activeAmc),
    activeAmc,
    equipment: eq,
  };
}

/**
 * Issues spare parts for a service ticket, deducts stock, and books GL service expense.
 */
async function issueServiceTicketParts(client, {
  companyId,
  serviceTicketId,
  productId,
  itemCode,
  itemName,
  uom = "NOS",
  qtyIssued,
  userId = null,
}) {
  const ticketRes = await client.query(
    `
      select
        st.*,
        ie.serial_number,
        ie.item_name as equipment_name,
        c.customer_name
      from service_tickets st
      join customers c on c.id = st.customer_id
      left join installed_equipment ie on ie.id = st.installed_equipment_id
      where st.id = $1 and (st.company_id = $2 or st.company_id is null)
      limit 1
    `,
    [serviceTicketId, companyId]
  );
  const ticket = ticketRes.rows[0];
  if (!ticket) {
    const err = new Error("SERVICE_TICKET_NOT_FOUND");
    err.status = 404;
    throw err;
  }

  const issueQty = qty(qtyIssued);
  if (issueQty <= 0) {
    const err = new Error("INVALID_QUANTITY");
    err.status = 400;
    throw err;
  }

  // Get current weighted average valuation for the spare part
  const valRes = await client.query(
    `
      select current_valuation_rate
      from stock_balances
      where company_id = $1 and product_id = $2
      limit 1
    `,
    [companyId, productId]
  );
  const unitCost = Number(valRes.rows[0]?.current_valuation_rate || 0);
  const totalCost = money(issueQty * unitCost);

  // 1. Post negative stock movement
  await client.query(
    `
      insert into stock_movements (
        company_id, product_id, qty_signed, movement_date,
        ref_type, ref_id, ref_line_id, remarks, created_by
      )
      values ($1, $2, $3, current_date, 'SERVICE_TICKET_PART', $4, null, $5, $6)
    `,
    [
      companyId,
      productId,
      -issueQty,
      serviceTicketId,
      `Spare parts issued for Service Ticket ${ticket.ticket_number}`,
      userId,
    ]
  );

  // Recalculate stock balance
  await recalcStockBalances(client, companyId, [productId]);

  // 2. Post GL Entry: Debit Service Expense (5100 / 5200), Credit Inventory (1200)
  const expAcctId = await getOrCreateGlAccount(client, companyId, "5100", "Cost of Goods Sold (COGS)", "expense", "debit");
  const invAcctId = await getOrCreateGlAccount(client, companyId, "1200", "Inventory Finished Goods", "asset", "debit");

  let glEntryId = null;
  if (totalCost > 0) {
    glEntryId = await postGlDoubleEntry(client, {
      companyId,
      entryNumber: `GL-SRV-${ticket.ticket_number}`,
      entryDate: new Date(),
      sourceEvent: "SERVICE_PART_ISSUE",
      refType: "service_tickets",
      refId: ticket.id,
      debitAccountId: expAcctId,
      creditAccountId: invAcctId,
      amount: totalCost,
      narration: `Spare parts consumption for ticket ${ticket.ticket_number} (${itemCode})`,
      userId,
    });
  }

  // 3. Record in service_ticket_parts
  const partRes = await client.query(
    `
      insert into service_ticket_parts (
        company_id, service_ticket_id, product_id, item_code, item_name,
        uom, qty_issued, unit_cost, total_cost, stock_deducted, gl_entry_id, issued_by
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11)
      returning *
    `,
    [
      companyId,
      serviceTicketId,
      productId,
      itemCode,
      itemName,
      uom,
      issueQty,
      unitCost,
      totalCost,
      glEntryId,
      userId,
    ]
  );

  // Update cumulative parts cost on ticket
  await client.query(
    `
      update service_tickets
      set parts_cost_total = coalesce(parts_cost_total, 0) + $1,
          updated_at = now()
      where id = $2
    `,
    [totalCost, serviceTicketId]
  );

  return partRes.rows[0];
}

module.exports = {
  autoRegisterEquipmentFromDispatch,
  checkEquipmentCoverage,
  issueServiceTicketParts,
};
