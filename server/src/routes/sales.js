const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const { processSalesDispatch } = require("../services/commercialSales");
const { createSalesOrderFromQuote } = require("./salesOrders");

const router = express.Router();

function cleanText(value, max = 255) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * 1. Customer Accounts & CRM Contacts
 */
router.get("/customers", requireScreenAction("commercial_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const q = req.query.q ? String(req.query.q).trim() : "";

    let query = `
      select
        c.*,
        (
          select count(*)
          from sales_orders so
          where so.customer_id = c.id and so.order_status <> 'cancelled'
        ) as active_orders_count,
        (
          select coalesce(sum(so.grand_total_base), 0)
          from sales_orders so
          where so.customer_id = c.id and so.order_status <> 'cancelled'
        ) as total_revenue_base
      from customers c
      where (c.company_id = $1 or c.company_id is null)
    `;
    const params = [companyId];

    if (q) {
      params.push(`%${q}%`);
      query += ` and (c.customer_name ilike $${params.length} or c.customer_code ilike $${params.length} or c.gstin ilike $${params.length} or c.email::text ilike $${params.length})`;
    }

    query += ` order by c.customer_name asc limit 100`;

    const result = await pool.query(query, params);
    return res.json({ ok: true, customers: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/customers", requireScreenAction("commercial_desk", "can_create"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const customerName = cleanText(req.body?.customer_name, 255);
    const customerCode = cleanText(req.body?.customer_code, 50);
    const gstin = cleanText(req.body?.gstin, 20);
    const panNo = cleanText(req.body?.pan_no, 20);
    const email = cleanText(req.body?.email, 120);
    const phone = cleanText(req.body?.phone, 30);
    const billingAddress = cleanText(req.body?.billing_address, 500);
    const shippingAddress = cleanText(req.body?.shipping_address, 500);
    const paymentTerms = cleanText(req.body?.payment_terms, 120) || "Net 30 Days";
    const creditLimit = Number(req.body?.credit_limit || 0);
    const creditDays = Number(req.body?.credit_days || 0);

    if (!customerName) {
      return res.status(400).json({ ok: false, error: "CUSTOMER_NAME_REQUIRED" });
    }

    const result = await pool.query(
      `
        insert into customers (
          company_id, customer_name, customer_code, gstin, pan_no,
          email, phone, billing_address, shipping_address, payment_terms,
          credit_limit, credit_days, is_active
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
        returning *
      `,
      [
        companyId,
        customerName,
        customerCode,
        gstin,
        panNo,
        email,
        phone,
        billingAddress,
        shippingAddress,
        paymentTerms,
        creditLimit,
        creditDays,
      ]
    );

    return res.status(201).json({ ok: true, customer: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

/**
 * 2. Commercial Pipeline Deals
 */
router.get("/pipeline", requireScreenAction("commercial_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const stage = req.query.stage ? String(req.query.stage).trim() : null;

    let query = `
      select
        sp.*,
        c.customer_name,
        c.email as customer_email,
        u.name as assigned_to_name,
        qh.quote_number,
        so.so_number
      from sales_pipelines sp
      left join customers c on c.id = sp.customer_id
      left join erp_users u on u.id = sp.assigned_to
      left join quote_headers qh on qh.id = sp.quote_id
      left join sales_orders so on so.id = sp.sales_order_id
      where sp.company_id = $1
    `;
    const params = [companyId];

    if (stage && ["inquiry", "quoted", "negotiation", "won", "lost"].includes(stage)) {
      params.push(stage);
      query += ` and sp.stage = $${params.length}`;
    }

    query += ` order by case when sp.stage in ('inquiry', 'quoted', 'negotiation') then 0 else 1 end, sp.expected_value desc, sp.id desc`;

    const result = await pool.query(query, params);
    return res.json({ ok: true, deals: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/pipeline", requireScreenAction("commercial_desk", "can_create"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const title = cleanText(req.body?.title, 255);
    const customerId = req.body?.customer_id ? Number(req.body.customer_id) : null;
    const stage = cleanText(req.body?.stage, 30) || "inquiry";
    const expectedValue = Number(req.body?.expected_value || 0);
    const probabilityPct = Number(req.body?.probability_pct || 20);
    const targetClosingDate = req.body?.target_closing_date || null;
    const remarks = cleanText(req.body?.remarks, 500);

    if (!title) {
      return res.status(400).json({ ok: false, error: "DEAL_TITLE_REQUIRED" });
    }

    const numRes = await pool.query(`select next_company_document_number($1, 'DEAL') as code`, [companyId]);
    const dealCode = numRes.rows[0]?.code || `DEAL-${Date.now().toString(36).toUpperCase()}`;

    const result = await pool.query(
      `
        insert into sales_pipelines (
          company_id, deal_code, title, customer_id, assigned_to,
          stage, expected_value, probability_pct, target_closing_date, remarks, created_by
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        returning *
      `,
      [
        companyId,
        dealCode,
        title,
        customerId,
        req.user?.id || null,
        stage,
        expectedValue,
        probabilityPct,
        targetClosingDate,
        remarks,
        req.user?.id || null,
      ]
    );

    return res.status(201).json({ ok: true, deal: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.patch("/pipeline/:id/stage", requireScreenAction("commercial_desk", "can_edit"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const dealId = Number(req.params.id);
    const stage = cleanText(req.body?.stage, 30);
    const lossReason = cleanText(req.body?.loss_reason, 255);

    if (!["inquiry", "quoted", "negotiation", "won", "lost"].includes(stage)) {
      return res.status(400).json({ ok: false, error: "INVALID_STAGE" });
    }

    const result = await pool.query(
      `
        update sales_pipelines
        set stage = $1,
            loss_reason = case when $1 = 'lost' then $2 else loss_reason end,
            actual_closing_date = case when $1 in ('won', 'lost') then current_date else actual_closing_date end,
            probability_pct = case when $1 = 'won' then 100 when $1 = 'lost' then 0 else probability_pct end,
            updated_at = now()
        where id = $3 and company_id = $4
        returning *
      `,
      [stage, lossReason, dealId, companyId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, error: "DEAL_NOT_FOUND" });
    }

    return res.json({ ok: true, deal: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

/**
 * 3. Quote-to-Order Conversion API
 */
router.post(
  "/quotes/:id/convert-to-order",
  requireScreenAction("commercial_desk", "can_create"),
  requireScreenAction("sales_orders", "can_create"),
  (req, res, next) => {
    const quoteId = Number(req.params.id);
    if (!Number.isFinite(quoteId) || quoteId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_QUOTE_ID" });
    }
    req.params.quoteId = String(quoteId);
    return createSalesOrderFromQuote(req, res, next);
  }
);

/**
 * 4. Sales Orders Listing & Detail
 */
router.get("/orders", requireScreenAction("commercial_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const status = req.query.status ? String(req.query.status).trim() : null;

    let query = `
      select
        so.*,
        c.customer_name,
        c.gstin as customer_gstin,
        qh.quote_number,
        wo.work_order_no,
        wo.status as work_order_status,
        (
          select count(*)
          from sales_order_lines sol
          where sol.sales_order_id = so.id
        ) as total_lines_count,
        (
          select count(*)
          from dispatches d
          where d.sales_order_id = so.id and d.dispatch_status <> 'cancelled'
        ) as dispatch_count
      from sales_orders so
      join customers c on c.id = so.customer_id
      left join quote_headers qh on qh.id = so.quote_id
      left join work_orders wo on wo.id = so.work_order_id
      where (so.company_id = $1 or so.company_id is null)
    `;
    const params = [companyId];

    if (status && ["draft", "confirmed", "in_fulfillment", "dispatched", "cancelled"].includes(status)) {
      params.push(status);
      query += ` and so.order_status = $${params.length}`;
    }

    query += ` order by so.order_date desc, so.id desc limit 100`;

    const result = await pool.query(query, params);
    return res.json({ ok: true, orders: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/orders/:id", requireScreenAction("commercial_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const orderId = Number(req.params.id);

    const soRes = await pool.query(
      `
        select
          so.*,
          c.customer_name,
          c.gstin as customer_gstin,
          c.email as customer_email,
          c.phone as customer_phone,
          qh.quote_number,
          wo.work_order_no,
          wo.status as work_order_status
        from sales_orders so
        join customers c on c.id = so.customer_id
        left join quote_headers qh on qh.id = so.quote_id
        left join work_orders wo on wo.id = so.work_order_id
        where so.id = $1 and (so.company_id = $2 or so.company_id is null)
        limit 1
      `,
      [orderId, companyId]
    );
    const order = soRes.rows[0];
    if (!order) return res.status(404).json({ ok: false, error: "ORDER_NOT_FOUND" });

    const linesRes = await pool.query(
      `
        select
          sol.*,
          p.item_name,
          p.uom,
          coalesce(sb.stock_qty, 0) as available_stock_qty
        from sales_order_lines sol
        left join products p on p.id = sol.product_id
        left join stock_balances sb on sb.product_id = sol.product_id and sb.company_id = $2
        where sol.sales_order_id = $1
        order by sol.line_no asc
      `,
      [orderId, companyId]
    );

    const dispatchesRes = await pool.query(
      `
        select *
        from dispatches
        where sales_order_id = $1
        order by dispatch_date desc, id desc
      `,
      [orderId]
    );

    return res.json({
      ok: true,
      order,
      lines: linesRes.rows,
      dispatches: dispatchesRes.rows,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * 5. Outbound Dispatches & Fulfillment
 */
router.get("/dispatches", requireScreenAction("commercial_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select
          d.*,
          so.so_number,
          c.customer_name,
          c.gstin as customer_gstin,
          u.name as created_by_name
        from dispatches d
        join sales_orders so on so.id = d.sales_order_id
        join customers c on c.id = d.customer_id
        left join erp_users u on u.id = d.created_by
        where (d.company_id = $1 or d.company_id is null)
        order by d.dispatch_date desc, d.id desc
        limit 100
      `,
      [companyId]
    );
    return res.json({ ok: true, dispatches: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/orders/:id/dispatch", requireScreenAction("commercial_desk", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const salesOrderId = Number(req.params.id);
    const transporterName = cleanText(req.body?.transporter_name, 120);
    const lrNo = cleanText(req.body?.lr_no, 80);
    const vehicleNo = cleanText(req.body?.vehicle_no, 50);
    const trackingRef = cleanText(req.body?.tracking_ref, 100);
    const carrierName = cleanText(req.body?.carrier_name, 100);
    const driverContact = cleanText(req.body?.driver_contact, 50);
    const totalPackages = Number(req.body?.total_packages || 1);
    const grossWeightKg = Number(req.body?.gross_weight_kg || 0);
    const remarks = cleanText(req.body?.remarks, 500);

    if (!Number.isFinite(salesOrderId) || salesOrderId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_ORDER_ID" });
    }

    await client.query("begin");

    const dispatch = await processSalesDispatch(client, {
      companyId,
      salesOrderId,
      dispatchDate: req.body?.dispatch_date || new Date(),
      transporterName,
      lrNo,
      vehicleNo,
      trackingRef,
      carrierName,
      driverContact,
      totalPackages,
      grossWeightKg,
      remarks,
      userId: req.user?.id || null,
    });

    await client.query("commit");
    return res.status(201).json({
      ok: true,
      dispatch,
      message: "Dispatch generated and stock deducted from inventory ledger.",
    });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
