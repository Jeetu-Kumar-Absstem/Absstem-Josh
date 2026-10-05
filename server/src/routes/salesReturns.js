const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { syncStockForSalesReturn } = require("../services/stockLedger");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(2));
}

function qty4(value) {
  return Number(qty(value).toFixed(4));
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function isIntLike(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.floor(n) === n;
}

function canAccessSalesReturn(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "sales_returns")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

function calculateLineAmounts(lines) {
  return lines.map((line) => {
    const returnQty = qty4(line.qty_return);
    const unitPrice = money(line.unit_price_invoice);
    const gstPct = qty(line.gst_pct);
    const lineTotal = money(returnQty * unitPrice);
    const taxTotal = money((lineTotal * gstPct) / 100);
    return {
      ...line,
      qty_return: returnQty,
      unit_price_invoice: unitPrice,
      gst_pct: gstPct,
      line_total_invoice: lineTotal,
      tax_total_invoice: taxTotal,
    };
  });
}

function calculateTotals(lines) {
  const normalized = calculateLineAmounts(lines);
  return normalized.reduce(
    (acc, line) => {
      acc.subtotal_invoice = money(acc.subtotal_invoice + line.line_total_invoice);
      acc.tax_total_invoice = money(acc.tax_total_invoice + line.tax_total_invoice);
      acc.grand_total_invoice = money(acc.grand_total_invoice + line.line_total_invoice + line.tax_total_invoice);
      return acc;
    },
    { subtotal_invoice: 0, tax_total_invoice: 0, grand_total_invoice: 0 }
  );
}

async function getInvoiceHeaderSeed(client, invoiceId) {
  const r = await client.query(
    `
      select
        ci.*,
        co.company_code,
        c.customer_name,
        so.so_number
      from customer_invoices ci
      left join companies co on co.id = ci.company_id
      join customers c on c.id = ci.customer_id
      join sales_orders so on so.id = ci.sales_order_id
      where ci.id = $1
      limit 1
    `,
    [invoiceId]
  );
  return r.rows[0] || null;
}

async function getReturnedQtyMap(client, customerInvoiceId, { excludeSalesReturnId = null } = {}) {
  const params = [Number(customerInvoiceId)];
  let excludeSql = "";
  if (Number.isFinite(Number(excludeSalesReturnId)) && Number(excludeSalesReturnId) > 0) {
    params.push(Number(excludeSalesReturnId));
    excludeSql = ` and sr.id <> $${params.length}`;
  }
  const r = await client.query(
    `
      select
        srl.invoice_line_id,
        coalesce(sum(srl.qty_return), 0) as qty_returned
      from sales_return_lines srl
      join sales_returns sr on sr.id = srl.sales_return_id
      where sr.customer_invoice_id = $1
        and sr.return_status <> 'cancelled'
        and srl.invoice_line_id is not null
        ${excludeSql}
      group by srl.invoice_line_id
    `,
    params
  );
  return new Map(r.rows.map((row) => [Number(row.invoice_line_id), qty4(row.qty_returned)]));
}

async function getInvoiceSeedLines(client, customerInvoiceId, { excludeSalesReturnId = null } = {}) {
  const returnedQtyMap = await getReturnedQtyMap(client, customerInvoiceId, { excludeSalesReturnId });
  const r = await client.query(
    `
      select
        il.id as invoice_line_id,
        il.sales_order_line_id,
        il.product_id,
        il.item_code,
        il.item_name,
        il.line_description,
        il.uom,
        il.qty,
        il.unit_price_invoice,
        il.gst_pct,
        coalesce(p.serial_no_required, false) as serial_no_required
      from invoice_lines il
      left join products p on p.id = il.product_id
      where il.customer_invoice_id = $1
      order by il.line_no asc
    `,
    [customerInvoiceId]
  );
  return r.rows.map((row, index) => ({
    line_no: index + 1,
    invoice_line_id: Number(row.invoice_line_id),
    sales_order_line_id: row.sales_order_line_id ? Number(row.sales_order_line_id) : null,
    product_id: row.product_id ? Number(row.product_id) : null,
    item_code: row.item_code || null,
    item_name: row.item_name || null,
    line_description: row.line_description || null,
    uom: row.uom || null,
    serial_no_required: row.serial_no_required === true,
    qty_invoiced: qty4(row.qty),
    qty_previously_returned: qty4(returnedQtyMap.get(Number(row.invoice_line_id))),
    qty_pending_return: qty4(Math.max(qty(row.qty) - qty(returnedQtyMap.get(Number(row.invoice_line_id))), 0)),
    qty_return: 0,
    unit_price_invoice: money(row.unit_price_invoice),
    gst_pct: qty(row.gst_pct),
    remarks: null,
  }));
}

async function getSalesReturnHeaderOrNull(client, id) {
  const r = await client.query(
    `
      select
        sr.*,
        co.company_code,
        c.customer_name,
        ci.invoice_number,
        d.dispatch_number,
        u.full_name as created_by_name
      from sales_returns sr
      left join companies co on co.id = sr.company_id
      join customers c on c.id = sr.customer_id
      left join customer_invoices ci on ci.id = sr.customer_invoice_id
      left join dispatches d on d.id = sr.dispatch_id
      left join erp_users u on u.id = sr.created_by
      where sr.id = $1
      limit 1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function getSalesReturnLines(client, id, customerInvoiceId = null) {
  const linesRes = await client.query(
    `
      select
        srl.*,
        coalesce(p.serial_no_required, false) as serial_no_required
      from sales_return_lines srl
      left join products p on p.id = srl.product_id
      where srl.sales_return_id = $1
      order by srl.line_no asc
    `,
    [id]
  );
  const serialRes = await client.query(
    `
      select sales_return_line_id, serial_no
      from sales_return_serials
      where sales_return_line_id = any(select id from sales_return_lines where sales_return_id = $1)
      order by id asc
    `,
    [id]
  );
  const serialsByLine = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.sales_return_line_id);
    if (!serialsByLine.has(key)) serialsByLine.set(key, []);
    serialsByLine.get(key).push(String(row.serial_no || ""));
  }
  if (!customerInvoiceId) {
    return linesRes.rows.map((row) => ({
      ...row,
      serials: serialsByLine.get(Number(row.id)) || [],
      qty_invoiced: qty4(row.qty_return),
      qty_previously_returned: 0,
      qty_pending_return: 0,
    }));
  }

  const seedLines = await getInvoiceSeedLines(client, customerInvoiceId, { excludeSalesReturnId: id });
  const savedByInvoiceLineId = new Map(
    linesRes.rows
      .filter((row) => Number.isFinite(Number(row.invoice_line_id)))
      .map((row) => [Number(row.invoice_line_id), row])
  );

  return seedLines.map((seed) => {
    const saved = savedByInvoiceLineId.get(Number(seed.invoice_line_id)) || null;
    return {
      id: saved?.id || null,
      sales_return_id: saved?.sales_return_id || id,
      line_no: saved?.line_no || seed.line_no,
      invoice_line_id: seed.invoice_line_id,
      sales_order_line_id: seed.sales_order_line_id,
      product_id: seed.product_id,
      item_code: seed.item_code,
      item_name: seed.item_name,
      line_description: seed.line_description,
      uom: seed.uom,
      qty_return: saved ? qty4(saved.qty_return) : 0,
      unit_price_invoice: saved ? money(saved.unit_price_invoice) : money(seed.unit_price_invoice),
      gst_pct: saved ? qty(saved.gst_pct) : qty(seed.gst_pct),
      line_total_invoice: saved ? money(saved.line_total_invoice) : 0,
      tax_total_invoice: saved ? money(saved.tax_total_invoice) : 0,
      remarks: saved?.remarks || null,
      serial_no_required: seed.serial_no_required === true,
      serials: saved ? serialsByLine.get(Number(saved.id)) || [] : [],
      qty_invoiced: qty4(seed.qty_invoiced),
      qty_previously_returned: qty4(seed.qty_previously_returned),
      qty_pending_return: qty4(seed.qty_pending_return),
    };
  });
}

async function getSalesReturnNcrCases(client, salesReturnId) {
  const r = await client.query(
    `
      with action_stats as (
        select
          a.ncr_case_id,
          count(*)::int as total_action_count,
          count(*) filter (where a.action_status in ('open', 'in_progress'))::int as open_action_count,
          count(*) filter (
            where a.action_status in ('open', 'in_progress')
              and a.due_date is not null
              and a.due_date < current_date
          )::int as overdue_action_count
        from quality_capa_actions a
        group by a.ncr_case_id
      )
      select
        n.*,
        d.id as customer_collection_dispute_id,
        d.dispute_reason,
        d.dispute_status,
        owner_user.full_name as containment_owner_name,
        created_user.full_name as created_by_name,
        verified_user.full_name as verified_by_name,
        coalesce(ast.total_action_count, 0) as total_action_count,
        coalesce(ast.open_action_count, 0) as open_action_count,
        coalesce(ast.overdue_action_count, 0) as overdue_action_count
      from quality_ncr_cases n
      left join customer_collection_disputes d on d.id = n.customer_collection_dispute_id
      left join erp_users owner_user on owner_user.id = n.containment_owner_id
      left join erp_users created_user on created_user.id = n.created_by
      left join erp_users verified_user on verified_user.id = n.verified_by
      left join action_stats ast on ast.ncr_case_id = n.id
      where n.sales_return_id = $1
      order by n.created_at desc, n.id desc
    `,
    [Number(salesReturnId)]
  );
  return r.rows;
}

async function getSalesReturnCapaActions(client, salesReturnId) {
  const r = await client.query(
    `
      select
        a.*,
        n.ncr_number,
        owner_user.full_name as owner_name,
        created_user.full_name as created_by_name
      from quality_capa_actions a
      join quality_ncr_cases n on n.id = a.ncr_case_id
      left join erp_users owner_user on owner_user.id = a.owner_user_id
      left join erp_users created_user on created_user.id = a.created_by
      where n.sales_return_id = $1
      order by coalesce(a.due_date, current_date) asc, a.id asc
    `,
    [Number(salesReturnId)]
  );
  return r.rows;
}

router.get("/bootstrap", requireScreenAction("sales_returns", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    let ownFilter = "";
    let companyFilter = "";
    const activeCompanyId = getActiveCompanyId(req);
    if (activeCompanyId) {
      params.push(activeCompanyId);
      companyFilter = ` and ci.company_id = $${params.length}`;
    }
    if (ownRecordsOnly(req, "sales_returns")) {
      params.push(Number(req.user.id));
      ownFilter = ` and ci.created_by = $${params.length}`;
    }
    const r = await pool.query(
      `
        select
          ci.id,
          ci.invoice_number,
          ci.invoice_date,
          c.customer_name,
          ci.grand_total_invoice
        from customer_invoices ci
        join customers c on c.id = ci.customer_id
        where ci.invoice_status <> 'cancelled'
        ${companyFilter}
        ${ownFilter}
        order by ci.invoice_date desc, ci.id desc
        limit 200
      `,
      params
    );
    return res.json({ ok: true, invoices: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("sales_returns", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    let where = "";
    const activeCompanyId = getActiveCompanyId(req);
    if (activeCompanyId) {
      params.push(activeCompanyId);
      where = `where sr.company_id = $${params.length}`;
    }
    if (ownRecordsOnly(req, "sales_returns")) {
      params.push(Number(req.user.id));
      where = where
        ? `${where} and sr.created_by = $${params.length}`
        : `where sr.created_by = $${params.length}`;
    }
    const r = await pool.query(
      `
        select
          sr.id,
          sr.return_number,
          sr.credit_note_number,
          sr.return_status,
          sr.return_date,
          sr.credit_note_amount,
          c.customer_name,
          ci.invoice_number
        from sales_returns sr
        join customers c on c.id = sr.customer_id
        left join customer_invoices ci on ci.id = sr.customer_invoice_id
        ${where}
        order by sr.created_at desc, sr.id desc
      `,
      params
    );
    return res.json({ ok: true, sales_returns: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/from-invoice/:id", requireScreenAction("sales_returns", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) return res.status(400).json({ ok: false, error: "INVALID_INVOICE" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const disputeId = Number(body.dispute_id);
    await client.query("begin");
    const invoice = await getInvoiceHeaderSeed(client, invoiceId);
    if (!invoice) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "INVOICE_NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, invoice)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (ownRecordsOnly(req, "sales_returns") && req.user.group_name !== "SuperAdmin" && Number(invoice.created_by) !== Number(req.user.id)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const seedLines = await getInvoiceSeedLines(client, invoiceId);
    const eligibleLines = seedLines.filter((line) => qty(line.qty_pending_return) > 0);
    if (!eligibleLines.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NO_PENDING_RETURN_QTY" });
    }

    const companyId = requireResolvedCompanyId(req, invoice.company_id);
    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    const numRes = await client.query(`select next_company_document_number($1, 'SRT') as return_number`, [companyId]);
    const returnNumber = numRes.rows[0]?.return_number;
    const insertRes = await client.query(
      `
        insert into sales_returns (
          return_number,
          company_id,
          customer_id,
          customer_invoice_id,
          return_status,
          return_date,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,'draft',current_date,$5,$6)
        returning id
      `,
      [returnNumber, companyId, invoice.customer_id, invoice.id, `Created from invoice ${invoice.invoice_number}`, req.user.id]
    );
    const id = insertRes.rows[0]?.id;

    if (Number.isFinite(disputeId) && disputeId > 0) {
      const disputeRes = await client.query(
        `
          select id, customer_id, customer_invoice_id
          from customer_collection_disputes
          where id = $1
          limit 1
        `,
        [disputeId]
      );
      const dispute = disputeRes.rows[0];
      if (!dispute) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "DISPUTE_NOT_FOUND" });
      }
      if (Number(dispute.customer_id) !== Number(invoice.customer_id) || Number(dispute.customer_invoice_id || 0) !== Number(invoice.id)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "DISPUTE_INVOICE_MISMATCH" });
      }
      await client.query(
        `
          update customer_collection_disputes
          set sales_return_id = $2,
              dispute_status = case when dispute_status = 'resolved' then 'open' else dispute_status end,
              updated_at = now()
          where id = $1
        `,
        [disputeId, id]
      );
      await client.query(
        `
          update quality_ncr_cases
          set sales_return_id = $2,
              updated_at = now()
          where customer_collection_dispute_id = $1
            and source_type = 'collection_dispute'
        `,
        [disputeId, id]
      );
    }

    let lineNo = 1;
    for (const line of eligibleLines) {
      await client.query(
        `
          insert into sales_return_lines (
            sales_return_id,
            line_no,
            invoice_line_id,
            sales_order_line_id,
            product_id,
            item_code,
            item_name,
            line_description,
            uom,
            qty_return,
            unit_price_invoice,
            gst_pct,
            line_total_invoice,
            tax_total_invoice,
            remarks
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,0,0,$12)
        `,
        [id, lineNo, line.invoice_line_id, line.sales_order_line_id || null, line.product_id || null, line.item_code || null, line.item_name || null, line.line_description || null, line.uom || null, line.unit_price_invoice, line.gst_pct, null]
      );
      lineNo += 1;
    }

    await client.query("commit");
    const header = await getSalesReturnHeaderOrNull(client, id);
    const lines = await getSalesReturnLines(client, id, header?.customer_invoice_id || null);
    const ncrCases = await getSalesReturnNcrCases(client, id);
    const capaActions = await getSalesReturnCapaActions(client, id);
    return res.status(201).json({ ok: true, sales_return: header, lines, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("sales_returns", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const header = await getSalesReturnHeaderOrNull(pool, id);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessSalesReturn(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, header)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    const lines = await getSalesReturnLines(pool, id, header.customer_invoice_id || null);
    const ncrCases = await getSalesReturnNcrCases(pool, id);
    const capaActions = await getSalesReturnCapaActions(pool, id);
    return res.json({ ok: true, sales_return: header, lines, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("sales_returns", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const returnStatus = typeof body.return_status === "string" ? body.return_status.trim().toLowerCase() : "draft";
    if (!["draft", "posted", "cancelled"].includes(returnStatus)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });

    await client.query("begin");
    const header = await getSalesReturnHeaderOrNull(client, id);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessSalesReturn(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    const currentStatus = String(header.return_status || "").toLowerCase();
    const editingLines = Array.isArray(body.lines);
    if (editingLines && currentStatus !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "RETURN_NOT_EDITABLE" });
    }

    let totals = {
      subtotal_invoice: money(header.subtotal_invoice),
      tax_total_invoice: money(header.tax_total_invoice),
      grand_total_invoice: money(header.grand_total_invoice),
    };

    if (editingLines) {
      const rawLines = body.lines.filter((line) => line && Number(line.invoice_line_id || line.id || 0) >= 0);
      const seedLines = await getInvoiceSeedLines(client, header.customer_invoice_id, { excludeSalesReturnId: id });
      const seedMap = new Map(seedLines.map((line) => [Number(line.invoice_line_id), line]));
      const serialRows = Array.isArray(body.serial_rows) ? body.serial_rows : [];
      const serialsByLineNo = new Map();
      for (const row of serialRows) {
        const lineNo = Number(row.line_no);
        const serialNo = String(row.serial_no || "").trim();
        if (!Number.isFinite(lineNo) || lineNo <= 0 || !serialNo) continue;
        if (!serialsByLineNo.has(lineNo)) serialsByLineNo.set(lineNo, []);
        serialsByLineNo.get(lineNo).push(serialNo);
      }

      const normalized = rawLines.map((line, index) => {
        const invoiceLineId = Number(line.invoice_line_id || line.id);
        const seed = seedMap.get(invoiceLineId);
        if (!seed) {
          const err = new Error("INVALID_LINE");
          err.code = "INVALID_LINE";
          throw err;
        }
        const returnQty = qty4(line.qty_return);
        if (returnQty < 0 || returnQty > qty(seed.qty_pending_return)) {
          const err = new Error("RETURN_EXCEEDS_INVOICE");
          err.code = "RETURN_EXCEEDS_INVOICE";
          throw err;
        }
        const serials = serialsByLineNo.get(index + 1) || [];
        if (new Set(serials).size !== serials.length) {
          const err = new Error("DUPLICATE_SERIALS");
          err.code = "DUPLICATE_SERIALS";
          throw err;
        }
        if (seed.serial_no_required === true && returnQty > 0) {
          if (!isIntLike(returnQty)) {
            const err = new Error("SERIAL_QTY_NOT_INTEGER");
            err.code = "SERIAL_QTY_NOT_INTEGER";
            throw err;
          }
          if (serials.length !== Number(returnQty)) {
            const err = new Error("SERIAL_COUNT_MISMATCH");
            err.code = "SERIAL_COUNT_MISMATCH";
            throw err;
          }
        }
        return {
          line_no: index + 1,
          invoice_line_id: invoiceLineId,
          sales_order_line_id: seed.sales_order_line_id || null,
          product_id: seed.product_id || null,
          item_code: seed.item_code || null,
          item_name: seed.item_name || null,
          line_description: seed.line_description || null,
          uom: seed.uom || null,
          qty_return: returnQty,
          unit_price_invoice: money(seed.unit_price_invoice),
          gst_pct: qty(seed.gst_pct),
          remarks: normalizeText(line.remarks),
          serials,
          serial_no_required: seed.serial_no_required === true,
        };
      });

      const nonZero = normalized.filter((line) => line.qty_return > 0);
      totals = calculateTotals(nonZero);

      await client.query(`delete from sales_return_serials where sales_return_line_id in (select id from sales_return_lines where sales_return_id = $1)`, [id]);
      await client.query(`delete from sales_return_lines where sales_return_id = $1`, [id]);

      for (const line of nonZero) {
        const lineWithAmounts = calculateLineAmounts([line])[0];
        const insertLine = await client.query(
          `
            insert into sales_return_lines (
              sales_return_id,
              line_no,
              invoice_line_id,
              sales_order_line_id,
              product_id,
              item_code,
              item_name,
              line_description,
              uom,
              qty_return,
              unit_price_invoice,
              gst_pct,
              line_total_invoice,
              tax_total_invoice,
              remarks
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            returning id
          `,
          [
            id,
            lineWithAmounts.line_no,
            lineWithAmounts.invoice_line_id,
            lineWithAmounts.sales_order_line_id,
            lineWithAmounts.product_id,
            lineWithAmounts.item_code,
            lineWithAmounts.item_name,
            lineWithAmounts.line_description,
            lineWithAmounts.uom,
            lineWithAmounts.qty_return,
            lineWithAmounts.unit_price_invoice,
            lineWithAmounts.gst_pct,
            lineWithAmounts.line_total_invoice,
            lineWithAmounts.tax_total_invoice,
            lineWithAmounts.remarks,
          ]
        );
        const lineId = insertLine.rows[0]?.id;
        for (const serialNo of line.serials) {
          await client.query(`insert into sales_return_serials (sales_return_line_id, serial_no) values ($1,$2)`, [lineId, serialNo]);
        }
      }
    }

    let creditNoteNumber = header.credit_note_number;
    if (returnStatus === "posted" && !creditNoteNumber) {
      const cnRes = await client.query(`select next_company_document_number($1, 'CRN') as credit_note_number`, [header.company_id]);
      creditNoteNumber = cnRes.rows[0]?.credit_note_number || null;
    }

    await client.query(
      `
        update sales_returns
        set return_status = $2,
            return_date = coalesce($3, return_date),
            remarks = $4,
            subtotal_invoice = $5,
            tax_total_invoice = $6,
            grand_total_invoice = $7,
            credit_note_amount = $8,
            credit_note_number = coalesce($9, credit_note_number),
            updated_at = now()
        where id = $1
      `,
      [id, returnStatus, body.return_date || null, normalizeText(body.remarks), totals.subtotal_invoice, totals.tax_total_invoice, totals.grand_total_invoice, totals.grand_total_invoice, creditNoteNumber]
    );

    await client.query(
      `
        update customer_collection_disputes d
        set dispute_status = case when $2 = 'posted' then 'resolved' else d.dispute_status end,
            resolution_notes = case
              when $2 = 'posted' then coalesce(d.resolution_notes, 'Resolved via linked credit note')
              else d.resolution_notes
            end,
            resolved_by = case when $2 = 'posted' then $3 else d.resolved_by end,
            resolved_at = case when $2 = 'posted' then now() else d.resolved_at end,
            updated_at = now()
        where d.sales_return_id = $1
      `,
      [id, returnStatus, Number(req.user.id)]
    );

    await client.query(
      `
        update quality_ncr_cases
        set sales_return_id = $2,
            updated_at = now()
        where source_type = 'collection_dispute'
          and customer_collection_dispute_id in (
            select d.id
            from customer_collection_disputes d
            where d.sales_return_id = $1
          )
      `,
      [id, id]
    );

    const companyRes = await client.query(`select company_id from sales_returns where id = $1 limit 1`, [id]);
    const companyId = Number(companyRes.rows[0]?.company_id) || null;
    await syncStockForSalesReturn(client, companyId, id);

    await client.query("commit");
    const nextHeader = await getSalesReturnHeaderOrNull(client, id);
    const lines = await getSalesReturnLines(client, id, nextHeader.customer_invoice_id || null);
    const ncrCases = await getSalesReturnNcrCases(client, id);
    const capaActions = await getSalesReturnCapaActions(client, id);
    return res.json({ ok: true, sales_return: nextHeader, lines, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    if (["INVALID_LINE", "RETURN_EXCEEDS_INVOICE", "DUPLICATE_SERIALS", "SERIAL_QTY_NOT_INTEGER", "SERIAL_COUNT_MISMATCH"].includes(err?.code)) {
      return res.status(400).json({ ok: false, error: err.code });
    }
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
