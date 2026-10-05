const express = require("express");
const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { requireResolvedCompanyId } = require("../services/companyContext");
const {
  generateInvoiceFromDispatch,
  validateAndProcessVendorBill,
  getGstReconciliationSummary,
  getOrCreateGlAccount,
  postGlDoubleEntry,
} = require("../services/financeAccounting");

const router = express.Router();

function cleanText(value, max = 255) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * 1. Customer Invoices & Accounts Receivable (AR)
 */
router.get("/invoices", requireScreenAction("finance_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const status = req.query.status ? String(req.query.status).trim() : null;

    let query = `
      select
        ci.*,
        c.customer_name,
        c.gstin as customer_gstin,
        so.so_number,
        d.dispatch_number
      from customer_invoices ci
      join customers c on c.id = ci.customer_id
      left join sales_orders so on so.id = ci.sales_order_id
      left join dispatches d on d.id = ci.dispatch_id
      where (ci.company_id = $1 or ci.company_id is null)
    `;
    const params = [companyId];

    if (status && ["draft", "issued", "paid", "cancelled"].includes(status)) {
      params.push(status);
      query += ` and ci.invoice_status = $${params.length}`;
    }

    query += ` order by ci.invoice_date desc, ci.id desc limit 150`;

    const result = await pool.query(query, params);
    return res.json({ ok: true, invoices: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/invoices/generate-from-dispatch", requireScreenAction("finance_desk", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const dispatchId = Number(req.body?.dispatch_id);
    if (!Number.isFinite(dispatchId) || dispatchId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_DISPATCH_ID" });
    }

    await client.query("begin");
    const result = await generateInvoiceFromDispatch(client, {
      companyId,
      dispatchId,
      userId: req.user?.id || null,
    });
    await client.query("commit");

    return res.status(201).json({
      ok: true,
      ...result,
      message: result.already_invoiced
        ? "Invoice already generated for this dispatch."
        : "Tax invoice generated & double-entry GL posted successfully.",
    });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/invoices/:id/record-payment", requireScreenAction("finance_desk", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const invoiceId = Number(req.params.id);
    const paymentAmount = Number(req.body?.payment_amount || 0);

    if (!Number.isFinite(invoiceId) || invoiceId <= 0 || paymentAmount <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYMENT_AMOUNT" });
    }

    await client.query("begin");

    const invRes = await client.query(
      `select * from customer_invoices where id = $1 and (company_id = $2 or company_id is null) for update`,
      [invoiceId, companyId]
    );
    const inv = invRes.rows[0];
    if (!inv) throw Object.assign(new Error("INVOICE_NOT_FOUND"), { status: 404 });

    const newPaid = Number(inv.paid_amount || 0) + paymentAmount;
    const newBalance = Math.max(0, Number(inv.grand_total_base) - newPaid);
    const newStatus = newBalance <= 0.01 ? "paid" : "issued";

    const updated = await client.query(
      `
        update customer_invoices
        set paid_amount = $1,
            balance_due = $2,
            invoice_status = $3,
            updated_at = now()
        where id = $4
        returning *
      `,
      [newPaid, newBalance, newStatus, invoiceId]
    );

    // GL Double Entry: Debit Bank (1400), Credit AR (1100)
    const bankAcctId = await getOrCreateGlAccount(client, companyId, "1400", "Bank & Cash Accounts", "asset", "debit");
    const arAcctId = await getOrCreateGlAccount(client, companyId, "1100", "Accounts Receivable (Trade Debtors)", "asset", "debit");

    await postGlDoubleEntry(client, {
      companyId,
      entryNumber: `PMT-${inv.invoice_number}-${Date.now().toString(36).toUpperCase()}`,
      entryDate: new Date(),
      sourceEvent: "PAYMENT",
      refType: "customer_invoices",
      refId: inv.id,
      debitAccountId: bankAcctId,
      creditAccountId: arAcctId,
      amount: paymentAmount,
      narration: `Payment received against Invoice ${inv.invoice_number}`,
      userId: req.user?.id || null,
    });

    await client.query("commit");
    return res.json({ ok: true, invoice: updated.rows[0], message: "Payment recorded and AR cleared." });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

/**
 * 2. Vendor Bills & 3-Way Matching AP Desk
 */
router.get("/vendor-bills", requireScreenAction("finance_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select
          vb.*,
          v.company_name as vendor_name,
          v.vendor_code,
          po.po_number,
          gr.receipt_number
        from vendor_bills vb
        join vendors v on v.id = vb.vendor_id
        left join purchase_orders po on po.id = vb.purchase_order_id
        left join goods_receipts gr on gr.id = vb.goods_receipt_id
        where (vb.company_id = $1 or vb.company_id is null)
        order by vb.bill_date desc, vb.id desc
        limit 150
      `,
      [companyId]
    );
    return res.json({ ok: true, bills: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/vendor-bills/match-and-process", requireScreenAction("finance_desk", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    const vendorId = Number(req.body?.vendor_id);
    const purchaseOrderId = Number(req.body?.purchase_order_id);
    const goodsReceiptId = req.body?.goods_receipt_id ? Number(req.body.goods_receipt_id) : null;
    const vendorInvoiceRef = cleanText(req.body?.vendor_invoice_ref, 80);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];

    if (!vendorId || !purchaseOrderId || !vendorInvoiceRef || !lines.length) {
      return res.status(400).json({ ok: false, error: "MISSING_REQUIRED_BILL_FIELDS" });
    }

    await client.query("begin");
    const result = await validateAndProcessVendorBill(client, {
      companyId,
      vendorId,
      purchaseOrderId,
      goodsReceiptId,
      vendorInvoiceRef,
      billDate: req.body?.bill_date || new Date(),
      lines,
      userId: req.user?.id || null,
    });
    await client.query("commit");

    return res.status(201).json({
      ok: true,
      ...result,
      message: result.matchStatus === "matched_ok"
        ? "3-Way Match verified! AP booked & GL updated."
        : `Bill recorded with match status: ${result.matchStatus}`,
    });
  } catch (error) {
    await client.query("rollback");
    return next(error);
  } finally {
    client.release();
  }
});

/**
 * 3. General Ledger & Chart of Accounts
 */
router.get("/chart-of-accounts", requireScreenAction("finance_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select
          coa.*,
          (
            select coalesce(sum(gle.debit - gle.credit), 0)
            from general_ledger_entries gle
            where gle.account_id = coa.id
          ) as net_balance
        from chart_of_accounts coa
        where (coa.company_id = $1 or coa.company_id is null) and coa.is_active = true
        order by coa.account_code asc
      `,
      [companyId]
    );
    return res.json({ ok: true, accounts: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/gl-entries", requireScreenAction("finance_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const result = await pool.query(
      `
        select
          gle.*,
          coa.account_code,
          coa.account_name,
          coa.account_type
        from general_ledger_entries gle
        join chart_of_accounts coa on coa.id = gle.account_id
        where (gle.company_id = $1 or gle.company_id is null)
        order by gle.entry_date desc, gle.id desc
        limit 200
      `,
      [companyId]
    );
    return res.json({ ok: true, entries: result.rows });
  } catch (error) {
    return next(error);
  }
});

/**
 * 4. Real-time GST & Tax Reconciliation Metrics
 */
router.get("/gst-reconciliation", requireScreenAction("finance_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = requireResolvedCompanyId(req);
    const summary = await getGstReconciliationSummary(pool, companyId);
    return res.json({ ok: true, summary });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
