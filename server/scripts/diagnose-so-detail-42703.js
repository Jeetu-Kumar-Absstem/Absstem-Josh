/**
 * Reproduce GET /sales-orders/:id exactly and print the real error.
 *
 *   node scripts/diagnose-so-detail-42703.js [--id=4]
 */
const { pool } = require("../src/db/pool");
const { getCustomerCreditSnapshot, getCreditControlDecision } = require("../src/services/creditControl");

const idArg = process.argv.find((a) => a.startsWith("--id="));
const salesOrderId = Number(idArg ? idArg.slice(5) : 4);

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

async function getSalesOrderHeaderOrNull(client, salesOrderId) {
  const r = await client.query(
    `
      select
        so.*,
        co.company_code,
        c.customer_code,
        c.customer_name,
        c.address_line1,
        c.address_line2,
        c.address_line3,
        c.city,
        c.state,
        c.pincode,
        d.company_name as distributor_name,
        base.currency_code as base_currency_code,
        ord.currency_code as order_currency_code,
        i.incoterm_code,
        pt.term_code as payment_term_code,
        pt.term_name as payment_term_name,
        ft.term_code as freight_term_code,
        ft.term_name as freight_term_name,
        pf.term_code as p_and_f_term_code,
        pf.term_name as p_and_f_term_name,
        qr.quote_id,
        qr.revision_no as quote_revision_no,
        qr.revision_status as quote_revision_status,
        qh.quote_number,
        sts.site_name as ship_to_site_name,
        icpo.po_number as intercompany_purchase_order_number,
        icpo.company_id as intercompany_purchase_order_company_id,
        icco.company_code as intercompany_company_code,
        icco.display_name as intercompany_company_name
      from sales_orders so
      left join companies co on co.id = so.company_id
      join customers c on c.id = so.customer_id
      left join distributors d on d.id = so.distributor_id
      left join currencies base on base.id = so.base_currency_id
      left join currencies ord on ord.id = so.order_currency_id
      left join incoterms i on i.id = so.incoterm_id
      left join payment_terms pt on pt.id = so.payment_term_id
      left join freight_terms ft on ft.id = so.freight_term_id
      left join p_and_f_terms pf on pf.id = so.p_and_f_term_id
      left join quote_revisions qr on qr.id = so.quote_revision_id
      left join quote_headers qh on qh.id = qr.quote_id
      left join customer_sites sts on sts.id = so.ship_to_customer_site_id
      left join purchase_orders icpo on icpo.id = so.intercompany_purchase_order_id
      left join companies icco on icco.id = so.intercompany_counterparty_company_id
      where so.id = $1
      limit 1
    `,
    [salesOrderId]
  );
  return r.rows[0] || null;
}

async function step(label, fn) {
  try {
    const result = await fn();
    console.log(`OK  ${label}`);
    return result;
  } catch (err) {
    console.log(`FAIL ${label}`);
    console.log(`  code=${err.code} status=${err.status}`);
    console.log(`  message=${err.message}`);
    if (err.detail) console.log(`  detail=${err.detail}`);
    if (err.hint) console.log(`  hint=${err.hint}`);
    console.log(err.stack);
    throw err;
  }
}

async function main() {
  console.log(`Reproducing GET /sales-orders/${salesOrderId}\n`);

  const order = await step("header", () => getSalesOrderHeaderOrNull(pool, salesOrderId));
  if (!order) {
    console.log("Order not found (would be 404)");
    await pool.end();
    return;
  }
  console.log(`  so_number=${order.so_number} job_no=${order.job_no} customer=${order.customer_id}`);

  const [rawLines, dispatchQtyMap, invoiceQtyMap, dispatches, invoices] = await step("parallel bundles", async () => {
    const linesRes = await pool.query(
      `
        select sol.*, pg.group_name as product_group_name
        from sales_order_lines sol
        left join products p on p.id = sol.product_id
        left join product_groups pg on pg.id = p.group_id
        where sol.sales_order_id = $1
        order by sol.line_no asc
      `,
      [salesOrderId]
    );
    const dispatchRes = await pool.query(
      `
        select dl.sales_order_line_id, coalesce(sum(dl.qty_dispatch), 0) as qty_dispatched
        from dispatch_lines dl
        join dispatches d on d.id = dl.dispatch_id
        where d.sales_order_id = $1 and d.dispatch_status <> 'cancelled'
        group by dl.sales_order_line_id
      `,
      [salesOrderId]
    );
    const invoiceRes = await pool.query(
      `
        select il.sales_order_line_id, coalesce(sum(il.qty), 0) as qty_invoiced
        from invoice_lines il
        join customer_invoices ci on ci.id = il.customer_invoice_id
        where ci.sales_order_id = $1 and ci.invoice_status <> 'cancelled'
        group by il.sales_order_line_id
      `,
      [salesOrderId]
    );
    const dSum = await pool.query(
      `select id, dispatch_number, dispatch_status, dispatch_date from dispatches where sales_order_id = $1 order by created_at desc, id desc`,
      [salesOrderId]
    );
    const iSum = await pool.query(
      `select id, invoice_number, invoice_status, invoice_date, grand_total_invoice from customer_invoices where sales_order_id = $1 order by created_at desc, id desc`,
      [salesOrderId]
    );
    return [
      linesRes.rows,
      new Map(dispatchRes.rows.map((row) => [Number(row.sales_order_line_id), qty(row.qty_dispatched)])),
      new Map(invoiceRes.rows.map((row) => [Number(row.sales_order_line_id), qty(row.qty_invoiced)])),
      dSum.rows,
      iSum.rows,
    ];
  });

  await step("customer_sites (fixed order)", () =>
    pool.query(
      `
        select id, site_code, site_name, site_type, address_line1, address_line2, city, state, pincode, can_dispatch, is_active
        from customer_sites
        where customer_id = $1
        order by is_default_ship_to desc, is_default_quote_site desc, site_name asc, id asc
      `,
      [order.customer_id]
    )
  );

  await step("customer_sites (OLD broken is_primary order)", async () => {
    try {
      await pool.query(
        `
          select id from customer_sites
          where customer_id = $1
          order by is_primary desc, site_name asc, id asc
        `,
        [order.customer_id]
      );
      console.log("  (unexpected: is_primary exists)");
    } catch (err) {
      if (err.code === "42703") {
        console.log("  confirmed: is_primary missing on customer_sites (old API would 42703 here)");
        return null;
      }
      throw err;
    }
  });

  const creditControl = await step("credit snapshot", () =>
    getCustomerCreditSnapshot(pool, {
      customerId: order.customer_id,
      companyId: order.company_id,
      distributorId: order.distributor_id,
      pendingSalesOrderAmount: ["confirmed", "closed"].includes(String(order.order_status || "").toLowerCase())
        ? 0
        : Number(order.grand_total_order || 0),
    })
  );

  if (creditControl) {
    try {
      getCreditControlDecision(creditControl, "so_confirmation");
      getCreditControlDecision(creditControl, "dispatch_release");
      console.log("OK  credit decisions");
    } catch (err) {
      console.log(`FAIL credit decisions: ${err.message}`);
      console.log(err.stack);
    }
  }

  console.log(`\nDone. lines=${rawLines.length} dispatches=${dispatches.length} invoices=${invoices.length}`);
  console.log("If all OK here, prod API file may not be updated — redeploy salesOrders.js and restart.");
  await pool.end();
}

main().catch(async () => {
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
