const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");
const { syncStockForPurchaseReturn } = require("../services/stockLedger");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(2));
}

function isIntLike(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.floor(n) === n;
}

function canAccessPurchaseReturn(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "purchase_returns")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function getDefaultCurrencyId(client) {
  const r = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
  const id = Number(r.rows[0]?.id);
  if (Number.isFinite(id) && id > 0) return id;
  const fallback = await client.query(`select id from currencies where is_active = true order by currency_code asc limit 1`);
  const fallbackId = Number(fallback.rows[0]?.id);
  return Number.isFinite(fallbackId) && fallbackId > 0 ? fallbackId : null;
}

function calculateLineAmounts(lines) {
  return lines.map((line) => {
    const returnQty = qty(line.qty_return);
    const unitPriceBase = money(line.unit_price_base);
    const unitPriceInvoice = money(line.unit_price_invoice);
    const gstPct = qty(line.gst_pct);
    const lineTotalBase = money(returnQty * unitPriceBase);
    const lineTotalInvoice = money(returnQty * unitPriceInvoice);
    const taxBase = money((lineTotalBase * gstPct) / 100);
    const taxInvoice = money((lineTotalInvoice * gstPct) / 100);
    return {
      ...line,
      qty_return: returnQty,
      unit_price_base: unitPriceBase,
      unit_price_invoice: unitPriceInvoice,
      gst_pct: gstPct,
      line_total_base: lineTotalBase,
      line_total_invoice: lineTotalInvoice,
      tax_total_base: taxBase,
      tax_total_invoice: taxInvoice,
    };
  });
}

function calculateTotals(lines) {
  return calculateLineAmounts(lines).reduce(
    (acc, line) => {
      acc.subtotal_base = money(acc.subtotal_base + line.line_total_base);
      acc.subtotal_invoice = money(acc.subtotal_invoice + line.line_total_invoice);
      acc.tax_total_base = money(acc.tax_total_base + line.tax_total_base);
      acc.tax_total_invoice = money(acc.tax_total_invoice + line.tax_total_invoice);
      acc.grand_total_base = money(acc.grand_total_base + line.line_total_base + line.tax_total_base);
      acc.grand_total_invoice = money(acc.grand_total_invoice + line.line_total_invoice + line.tax_total_invoice);
      return acc;
    },
    {
      subtotal_base: 0,
      subtotal_invoice: 0,
      tax_total_base: 0,
      tax_total_invoice: 0,
      grand_total_base: 0,
      grand_total_invoice: 0,
    }
  );
}

async function getPurchaseReturnHeaderOrNull(client, id, companyId) {
  const r = await client.query(
    `
      select
        pr.*,
        v.vendor_code,
        v.company_name as vendor_name,
        gr.grn_number,
        pi.purchase_invoice_number,
        curr.currency_code as return_currency_code
      from purchase_returns pr
      join vendors v on v.id = pr.vendor_id
      left join goods_receipts gr on gr.id = pr.goods_receipt_id
      left join purchase_invoices pi on pi.id = pr.purchase_invoice_id
      left join currencies curr on curr.id = pr.return_currency_id
      where pr.id = $1 and pr.company_id = $2
      limit 1
    `,
    [id, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getPurchaseReturnLines(client, purchaseReturnId) {
  const r = await client.query(
    `
      select
        prl.*,
        p.serial_no_required
      from purchase_return_lines prl
      left join products p on p.id = prl.product_id
      where prl.purchase_return_id = $1
      order by prl.line_no asc
    `,
    [purchaseReturnId]
  );
  return r.rows;
}

async function getPurchaseReturnSerialRows(client, purchaseReturnId) {
  const r = await client.query(
    `
      select prs.id, prs.purchase_return_line_id, prs.serial_no
      from purchase_return_serials prs
      join purchase_return_lines prl on prl.id = prs.purchase_return_line_id
      where prl.purchase_return_id = $1
      order by prs.id asc
    `,
    [purchaseReturnId]
  );
  return r.rows;
}

async function getReturnedQtyMap(client, goodsReceiptId, { excludePurchaseReturnId = null } = {}) {
  const params = [Number(goodsReceiptId)];
  let excludeSql = "";
  if (Number.isFinite(Number(excludePurchaseReturnId)) && Number(excludePurchaseReturnId) > 0) {
    params.push(Number(excludePurchaseReturnId));
    excludeSql = ` and pr.id <> $${params.length}`;
  }

  const r = await client.query(
    `
      select
        prl.goods_receipt_line_id,
        coalesce(sum(prl.qty_return), 0) as qty_returned
      from purchase_return_lines prl
      join purchase_returns pr on pr.id = prl.purchase_return_id
      where pr.goods_receipt_id = $1
        and pr.return_status <> 'cancelled'
        and prl.goods_receipt_line_id is not null
        ${excludeSql}
      group by prl.goods_receipt_line_id
    `,
    params
  );
  return new Map(r.rows.map((row) => [Number(row.goods_receipt_line_id), qty(row.qty_returned)]));
}

async function getGoodsReceiptHeaderOrNull(client, goodsReceiptId, companyId) {
  const r = await client.query(
    `
      select
        gr.*,
        v.company_name as vendor_name
      from goods_receipts gr
      join vendors v on v.id = gr.vendor_id
      where gr.id = $1 and gr.company_id = $2
      limit 1
    `,
    [goodsReceiptId, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getGoodsReceiptLinesForReturn(client, goodsReceiptId) {
  const r = await client.query(
    `
      select
        grl.*,
        p.serial_no_required,
        p.last_purchase_price
      from goods_receipt_lines grl
      left join products p on p.id = grl.product_id
      where grl.goods_receipt_id = $1
      order by grl.line_no asc
    `,
    [goodsReceiptId]
  );
  return r.rows;
}

router.get("/bootstrap", requireScreenAction("purchase_returns", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const [vendorsRes, currenciesRes, grnRes, pinvRes] = await Promise.all([
      pool.query(
        `
          select id, vendor_code, company_name
          from vendors
          where company_id = $1
            and is_active = true
          order by company_name asc
        `,
        [companyId]
      ),
      pool.query(
        `
          select id, currency_code
          from currencies
          where is_active = true
          order by currency_code asc
        `
      ),
      pool.query(
        `
          select
            gr.id,
            gr.grn_number,
            gr.receipt_date,
            gr.receipt_status,
            v.company_name as vendor_name
          from goods_receipts gr
          join vendors v on v.id = gr.vendor_id and v.company_id = gr.company_id
          where gr.company_id = $1 and gr.receipt_status <> 'cancelled'
          order by gr.created_at desc, gr.id desc
          limit 250
        `,
        [companyId]
      ),
      pool.query(
        `
          select
            pi.id,
            pi.purchase_invoice_number,
            pi.invoice_date,
            pi.invoice_status,
            v.company_name as vendor_name
          from purchase_invoices pi
          join vendors v on v.id = pi.vendor_id and v.company_id = pi.company_id
          where pi.company_id = $1 and pi.invoice_status <> 'cancelled'
          order by pi.created_at desc, pi.id desc
          limit 250
        `,
        [companyId]
      ),
    ]);

    return res.json({
      ok: true,
      vendors: vendorsRes.rows,
      currencies: currenciesRes.rows,
      goods_receipts: grnRes.rows,
      purchase_invoices: pinvRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-lookup", requireScreenAction("purchase_returns", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.json({ ok: true, products: [] });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const products = await lookupProducts(pool, { companyId, q, mode: "purchase", limit: 25 });
    return res.json({ ok: true, products });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("purchase_returns", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    where.push(`pr.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "purchase_returns")) {
      params.push(Number(req.user.id));
      where.push(`pr.created_by = $${params.length}`);
    }

    const r = await pool.query(
      `
        select
          pr.id,
          pr.return_number,
          pr.debit_note_number,
          pr.return_status,
          pr.return_date,
          pr.grand_total_invoice,
          v.company_name as vendor_name,
          curr.currency_code as return_currency_code
        from purchase_returns pr
        join vendors v on v.id = pr.vendor_id and v.company_id = pr.company_id
        left join currencies curr on curr.id = pr.return_currency_id
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by pr.created_at desc, pr.id desc
      `,
      params
    );

    return res.json({ ok: true, purchase_returns: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("purchase_returns", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const vendorId = Number(body.vendor_id);
    if (!Number.isFinite(vendorId) || vendorId <= 0) return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const vendorRes = await client.query(`select id from vendors where id = $1 and company_id = $2 and is_active = true limit 1`, [vendorId, companyId]);
    if (!vendorRes.rows[0]?.id) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "VENDOR_NOT_FOUND" });
    }

    const currencyId = Number.isFinite(Number(body.return_currency_id)) ? Number(body.return_currency_id) : await getDefaultCurrencyId(client);
    if (!Number.isFinite(currencyId) || currencyId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    const [returnNoRes, debitNoRes] = await Promise.all([
      client.query(`select next_company_document_number($1,'PRET') as return_number`, [companyId]),
      client.query(`select next_company_document_number($1,'DNOTE') as debit_note_number`, [companyId]),
    ]);

    const insertRes = await client.query(
      `
        insert into purchase_returns (
          company_id,
          return_number,
          debit_note_number,
          vendor_id,
          return_status,
          return_date,
          base_currency_id,
          return_currency_id,
          created_by
        )
        values ($1,$2,$3,$4,'draft',current_date,$5,$6,$7)
        returning id
      `,
      [
        companyId,
        returnNoRes.rows[0]?.return_number,
        debitNoRes.rows[0]?.debit_note_number,
        vendorId,
        currencyId,
        currencyId,
        req.user.id,
      ]
    );

    await client.query("commit");
    const purchaseReturn = await getPurchaseReturnHeaderOrNull(client, insertRes.rows[0]?.id, companyId);
    return res.status(201).json({ ok: true, purchase_return: purchaseReturn, lines: [], serial_rows: [] });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/from-grn/:id", requireScreenAction("purchase_returns", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const goodsReceiptId = Number(req.params.id);
    if (!Number.isFinite(goodsReceiptId) || goodsReceiptId <= 0) return res.status(400).json({ ok: false });

    await client.query("begin");
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    const goodsReceipt = await getGoodsReceiptHeaderOrNull(client, goodsReceiptId, companyId);
    if (!goodsReceipt) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "GRN_NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, goodsReceipt)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }

    const currencyId = await getDefaultCurrencyId(client);
    const [returnNoRes, debitNoRes, returnedQtyMap, grnLines] = await Promise.all([
      client.query(`select next_company_document_number($1,'PRET') as return_number`, [companyId]),
      client.query(`select next_company_document_number($1,'DNOTE') as debit_note_number`, [companyId]),
      getReturnedQtyMap(client, goodsReceiptId),
      getGoodsReceiptLinesForReturn(client, goodsReceiptId),
    ]);

    const insertRes = await client.query(
      `
        insert into purchase_returns (
          company_id,
          return_number,
          debit_note_number,
          vendor_id,
          goods_receipt_id,
          return_status,
          return_date,
          base_currency_id,
          return_currency_id,
          created_by
        )
        values ($1,$2,$3,$4,$5,'draft',current_date,$6,$7,$8)
        returning id
      `,
      [
        companyId,
        returnNoRes.rows[0]?.return_number,
        debitNoRes.rows[0]?.debit_note_number,
        goodsReceipt.vendor_id,
        goodsReceiptId,
        currencyId,
        currencyId,
        req.user.id,
      ]
    );
    const purchaseReturnId = Number(insertRes.rows[0]?.id || 0);

    for (const line of grnLines) {
      const qtyReceived = qty(line.qty_received);
      const alreadyReturned = qty(returnedQtyMap.get(Number(line.id)));
      const pending = money(qtyReceived - alreadyReturned);
      if (pending <= 0.0001) continue;
      await client.query(
        `
          insert into purchase_return_lines (
            purchase_return_id,
            goods_receipt_line_id,
            line_no,
            product_id,
            item_code,
            item_name,
            line_description,
            hsn_no,
            uom,
            qty_return,
            unit_price_base,
            unit_price_invoice,
            gst_pct,
            line_total_base,
            line_total_invoice
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `,
        [
          purchaseReturnId,
          line.id,
          line.line_no,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.hsn_no || null,
          line.uom || null,
          pending,
          money(line.last_purchase_price),
          money(line.last_purchase_price),
          money(line.gst_pct),
          money(pending * money(line.last_purchase_price)),
          money(pending * money(line.last_purchase_price)),
        ]
      );
    }

    const insertedLines = await getPurchaseReturnLines(client, purchaseReturnId);
    const totals = calculateTotals(insertedLines);
    await client.query(
      `
        update purchase_returns
        set subtotal_base = $2,
            subtotal_invoice = $3,
            tax_total_base = $4,
            tax_total_invoice = $5,
            grand_total_base = $6,
            grand_total_invoice = $7,
            updated_at = now()
        where id = $1
      `,
      [
        purchaseReturnId,
        totals.subtotal_base,
        totals.subtotal_invoice,
        totals.tax_total_base,
        totals.tax_total_invoice,
        totals.grand_total_base,
        totals.grand_total_invoice,
      ]
    );

    await client.query("commit");
    const purchaseReturn = await getPurchaseReturnHeaderOrNull(client, purchaseReturnId, companyId);
    const lines = await getPurchaseReturnLines(client, purchaseReturnId);
    return res.status(201).json({ ok: true, purchase_return: purchaseReturn, lines, serial_rows: [] });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("purchase_returns", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const purchaseReturn = await getPurchaseReturnHeaderOrNull(pool, id, companyId);
    if (!purchaseReturn) return res.status(404).json({ ok: false });
    if (!canAccessCompanyContext(req, purchaseReturn)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessPurchaseReturn(req, purchaseReturn)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const [lines, serialRows] = await Promise.all([getPurchaseReturnLines(pool, id), getPurchaseReturnSerialRows(pool, id)]);
    return res.json({ ok: true, purchase_return: purchaseReturn, lines, serial_rows: serialRows });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("purchase_returns", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const purchaseReturnId = Number(req.params.id);
    if (!Number.isFinite(purchaseReturnId) || purchaseReturnId <= 0) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const status = typeof body.return_status === "string" ? body.return_status.trim().toLowerCase() : "draft";
    if (!["draft", "posted", "cancelled"].includes(status)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const purchaseReturn = await getPurchaseReturnHeaderOrNull(client, purchaseReturnId, companyId);
    if (!purchaseReturn) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessCompanyContext(req, purchaseReturn)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessPurchaseReturn(req, purchaseReturn)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (purchaseReturn.return_status !== "draft" && status !== "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "RETURN_NOT_EDITABLE" });
    }

    const requestedLines = Array.isArray(body.lines) ? body.lines : [];
    const serialRows = Array.isArray(body.serial_rows) ? body.serial_rows : [];
    const nextVendorId = Number.isFinite(Number(body.vendor_id)) ? Number(body.vendor_id) : Number(purchaseReturn.vendor_id);
    const nextGoodsReceiptId =
      body.goods_receipt_id === undefined ? purchaseReturn.goods_receipt_id : body.goods_receipt_id ? Number(body.goods_receipt_id) : null;
    const nextPurchaseInvoiceId =
      body.purchase_invoice_id === undefined
        ? purchaseReturn.purchase_invoice_id
        : body.purchase_invoice_id
          ? Number(body.purchase_invoice_id)
          : null;

    if (!Number.isFinite(nextVendorId) || nextVendorId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });
    }

    const currencyId = Number.isFinite(Number(body.return_currency_id))
      ? Number(body.return_currency_id)
      : Number(purchaseReturn.return_currency_id);
    if (!Number.isFinite(currencyId) || currencyId <= 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_CURRENCY" });
    }

    if (nextGoodsReceiptId) {
      const goodsReceipt = await getGoodsReceiptHeaderOrNull(client, nextGoodsReceiptId, companyId);
      if (!goodsReceipt || Number(goodsReceipt.vendor_id) !== nextVendorId) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "GRN_VENDOR_MISMATCH" });
      }
    }
    if (nextPurchaseInvoiceId) {
      const invoiceRes = await client.query(
        `select id, vendor_id, company_id from purchase_invoices where id = $1 and invoice_status <> 'cancelled' limit 1`,
        [nextPurchaseInvoiceId]
      );
      const invoice = invoiceRes.rows[0] || null;
      if (!invoice || Number(invoice.vendor_id) !== nextVendorId || Number(invoice.company_id) !== Number(companyId)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVOICE_VENDOR_MISMATCH" });
      }
    }

    const returnedQtyMap = nextGoodsReceiptId ? await getReturnedQtyMap(client, nextGoodsReceiptId, { excludePurchaseReturnId: purchaseReturnId }) : new Map();
    const normalizedLines = [];
    for (const row of requestedLines) {
      const returnQty = qty(row.qty_return);
      if (returnQty <= 0) continue;
      const goodsReceiptLineId =
        row.goods_receipt_line_id === undefined || row.goods_receipt_line_id === null || row.goods_receipt_line_id === ""
          ? null
          : Number(row.goods_receipt_line_id);
      if (goodsReceiptLineId && nextGoodsReceiptId) {
        const grLineRes = await client.query(
          `select qty_received from goods_receipt_lines where id = $1 and goods_receipt_id = $2 limit 1`,
          [goodsReceiptLineId, nextGoodsReceiptId]
        );
        const grLine = grLineRes.rows[0] || null;
        if (!grLine) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_GRN_LINE" });
        }
        const maxQty = qty(grLine.qty_received) - qty(returnedQtyMap.get(goodsReceiptLineId));
        if (returnQty > money(maxQty)) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "RETURN_EXCEEDS_RECEIVED" });
        }
      }
      normalizedLines.push({
        goods_receipt_line_id: goodsReceiptLineId,
        purchase_invoice_line_id:
          row.purchase_invoice_line_id === undefined || row.purchase_invoice_line_id === null || row.purchase_invoice_line_id === ""
            ? null
            : Number(row.purchase_invoice_line_id),
        product_id:
          row.product_id === undefined || row.product_id === null || row.product_id === ""
            ? null
            : Number(row.product_id),
        item_code: row.item_code || null,
        item_name: row.item_name || null,
        line_description: row.line_description || null,
        hsn_no: row.hsn_no || null,
        uom: row.uom || null,
        qty_return: returnQty,
        unit_price_base: money(row.unit_price_base),
        unit_price_invoice: money(row.unit_price_invoice),
        gst_pct: money(row.gst_pct),
      });
    }

    if (status === "posted" && normalizedLines.length === 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_LINES" });
    }

    const lineAmounts = calculateLineAmounts(normalizedLines);
    const totals = calculateTotals(lineAmounts);

    await client.query(
      `
        update purchase_returns
        set vendor_id = $2,
            goods_receipt_id = $3,
            purchase_invoice_id = $4,
            return_status = $5,
            return_date = coalesce($6, return_date),
            base_currency_id = $7,
            return_currency_id = $8,
            subtotal_base = $9,
            subtotal_invoice = $10,
            tax_total_base = $11,
            tax_total_invoice = $12,
            grand_total_base = $13,
            grand_total_invoice = $14,
            remarks = $15,
            updated_at = now()
        where id = $1 and company_id = $16
      `,
      [
        purchaseReturnId,
        nextVendorId,
        nextGoodsReceiptId,
        nextPurchaseInvoiceId,
        status,
        body.return_date || null,
        currencyId,
        currencyId,
        totals.subtotal_base,
        totals.subtotal_invoice,
        totals.tax_total_base,
        totals.tax_total_invoice,
        totals.grand_total_base,
        totals.grand_total_invoice,
        body.remarks || null,
        companyId,
      ]
    );

    await client.query(`delete from purchase_return_serials where purchase_return_line_id in (select id from purchase_return_lines where purchase_return_id = $1)`, [
      purchaseReturnId,
    ]);
    await client.query(`delete from purchase_return_lines where purchase_return_id = $1`, [purchaseReturnId]);

    const lineIdMap = new Map();
    for (let index = 0; index < lineAmounts.length; index += 1) {
      const row = lineAmounts[index];
      const insertRes = await client.query(
        `
          insert into purchase_return_lines (
            purchase_return_id,
            goods_receipt_line_id,
            purchase_invoice_line_id,
            line_no,
            product_id,
            item_code,
            item_name,
            line_description,
            hsn_no,
            uom,
            qty_return,
            unit_price_base,
            unit_price_invoice,
            gst_pct,
            line_total_base,
            line_total_invoice
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          returning id
        `,
        [
          purchaseReturnId,
          row.goods_receipt_line_id,
          row.purchase_invoice_line_id,
          index + 1,
          row.product_id,
          row.item_code,
          row.item_name,
          row.line_description,
          row.hsn_no,
          row.uom,
          row.qty_return,
          row.unit_price_base,
          row.unit_price_invoice,
          row.gst_pct,
          row.line_total_base,
          row.line_total_invoice,
        ]
      );
      const lineId = Number(insertRes.rows[0]?.id || 0);
      lineIdMap.set(index + 1, lineId);
    }

    for (const row of serialRows) {
      const lineNo = Number(row.line_no);
      const lineId = lineIdMap.get(lineNo);
      const serialNo = String(row.serial_no || "").trim();
      if (!lineId || !serialNo) continue;
      await client.query(
        `
          insert into purchase_return_serials (purchase_return_line_id, serial_no)
          values ($1,$2)
        `,
        [lineId, serialNo]
      );
    }

    const insertedLines = await getPurchaseReturnLines(client, purchaseReturnId);
    for (const line of insertedLines) {
      if (line.serial_no_required === true && !isIntLike(line.qty_return)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "SERIAL_QTY_NOT_INTEGER" });
      }
    }

    const companyRes = await client.query(`select company_id from purchase_returns where id = $1 limit 1`, [purchaseReturnId]);
    const syncCompanyId = Number(companyRes.rows[0]?.company_id) || null;
    await syncStockForPurchaseReturn(client, syncCompanyId, purchaseReturnId);
    await client.query("commit");

    const nextPurchaseReturn = await getPurchaseReturnHeaderOrNull(client, purchaseReturnId, companyId);
    const [lines, nextSerialRows] = await Promise.all([
      getPurchaseReturnLines(client, purchaseReturnId),
      getPurchaseReturnSerialRows(client, purchaseReturnId),
    ]);
    return res.json({ ok: true, purchase_return: nextPurchaseReturn, lines, serial_rows: nextSerialRows });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
