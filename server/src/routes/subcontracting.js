const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId } = require("../services/companyContext");
const { getCompanyProductOrNull, lookupProducts } = require("../services/companyProductLookup");

const router = express.Router();

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(value) {
  const n = num(value, 0);
  return Math.round(n * 10000) / 10000;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value, fallback = 120, max = 300) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function canAccessSubcontractOrder(req, order) {
  if (!order) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "subcontracting")) return true;
  return Number(order.created_by) === Number(req.user.id);
}

async function recalcCompanyStockBalances(client, companyId, productIds) {
  const cid = Number(companyId);
  const ids = (productIds || []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
  if (!Number.isFinite(cid) || cid <= 0) return;
  if (!ids.length) return;
  await client.query(
    `
      with target as (
        select $1::int as company_id, unnest($2::int[]) as product_id
      ),
      agg as (
        select
          t.company_id,
          t.product_id,
          coalesce(sum(sm.qty_signed), 0) as stock_qty
        from target t
        left join stock_movements sm
          on sm.company_id = t.company_id and sm.product_id = t.product_id
        group by t.company_id, t.product_id
      )
      insert into stock_balances (company_id, product_id, stock_qty, updated_at)
      select company_id, product_id, stock_qty, now()
      from agg
      on conflict (company_id, product_id) do update
      set stock_qty = excluded.stock_qty,
          updated_at = excluded.updated_at
    `,
    [cid, ids]
  );
}

async function getOrderHeaderOrNull(client, orderId, companyId) {
  const r = await client.query(
    `
      select
        so.*,
        v.company_name as vendor_name,
        jc.job_card_number
      from subcontract_orders so
      left join vendors v on v.id = so.vendor_id and v.company_id = so.company_id
      left join job_cards jc on jc.id = so.job_card_id
      where so.id = $1 and so.company_id = $2
      limit 1
    `,
    [Number(orderId), Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getOrderLines(client, orderId) {
  const r = await client.query(
    `
      select
        l.*,
        p.item_code,
        p.item_name
      from subcontract_order_lines l
      join products p on p.id = l.product_id
      where l.subcontract_order_id = $1
      order by l.line_no asc
    `,
    [Number(orderId)]
  );
  return r.rows.map((row) => ({
    ...row,
    qty_ordered: money(row.qty_ordered),
    qty_sent: money(row.qty_sent),
    qty_received: money(row.qty_received),
    unit_rate_base: money(row.unit_rate_base),
    amount_base: Math.round(num(row.amount_base) * 100) / 100,
  }));
}

async function getOrderMovements(client, orderId) {
  const r = await client.query(
    `
      select
        m.*,
        l.line_no,
        p.item_code,
        p.item_name
      from subcontract_movements m
      join subcontract_order_lines l on l.id = m.subcontract_order_line_id
      join products p on p.id = l.product_id
      where m.subcontract_order_id = $1
      order by m.movement_date desc, m.id desc
    `,
    [Number(orderId)]
  );
  return r.rows.map((row) => ({ ...row, qty: money(row.qty) }));
}

async function recalcOrderStatus(client, orderId, companyId) {
  const r = await client.query(
    `
      select
        so.subcontract_status,
        coalesce(sum(l.qty_ordered), 0) as qty_ordered,
        coalesce(sum(l.qty_sent), 0) as qty_sent,
        coalesce(sum(l.qty_received), 0) as qty_received
      from subcontract_orders so
      left join subcontract_order_lines l on l.subcontract_order_id = so.id
      where so.id = $1 and so.company_id = $2
      group by so.id
      limit 1
    `,
    [Number(orderId), Number(companyId)]
  );
  const row = r.rows[0] || null;
  if (!row) return null;
  const current = String(row.subcontract_status || "draft").toLowerCase();
  if (current === "closed" || current === "cancelled") return current;
  const ordered = money(row.qty_ordered);
  const sent = money(row.qty_sent);
  const received = money(row.qty_received);
  let next = "draft";
  if (ordered > 0.0001 && received + 0.0001 >= ordered) next = "received";
  else if (received > 0.0001) next = "partial_received";
  else if (sent > 0.0001) next = "sent";
  await client.query(`update subcontract_orders set subcontract_status = $2, updated_at = now() where id = $1`, [Number(orderId), next]);
  return next;
}

router.get("/bootstrap", requireScreenAction("subcontracting", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const vendorsRes = await pool.query(
      `
        select id, vendor_code, company_name, gstin, is_active
        from vendors
        where company_id = $1
          and is_active = true
        order by company_name asc
      `,
      [companyId]
    );
    return res.json({ ok: true, vendors: vendorsRes.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-lookup", requireScreenAction("subcontracting", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const products = await lookupProducts(pool, { companyId, q, mode: "purchase", limit: 60 });
    return res.json({ ok: true, products });
  } catch (err) {
    return next(err);
  }
});

router.post("/start", requireScreenAction("subcontracting", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const vendorId = Number(body.vendor_id) || null;
    const jobCardId = Number(body.job_card_id) || null;
    const dueDate = normalizeText(body.due_date) || null;
    await client.query("begin");
    if (vendorId) {
      const vendorRes = await client.query(`select id from vendors where id = $1 and company_id = $2 and is_active = true limit 1`, [
        vendorId,
        companyId,
      ]);
      if (!vendorRes.rows[0]?.id) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_VENDOR" });
      }
    }
    const numRes = await client.query(`select next_company_document_number($1,'SC') as subcontract_number`, [companyId]);
    const subcontractNumber = numRes.rows[0]?.subcontract_number;
    if (!subcontractNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "FAILED_TO_ALLOCATE_NUMBER" });
    }
    const headerRes = await client.query(
      `
        insert into subcontract_orders (
          company_id,
          subcontract_number,
          subcontract_status,
          vendor_id,
          job_card_id,
          order_date,
          due_date,
          remarks,
          created_by
        )
        values ($1,$2,'draft',$3,$4,current_date,$5,$6,$7)
        returning id
      `,
      [companyId, subcontractNumber, vendorId, jobCardId, dueDate, normalizeText(body.remarks), req.user.id]
    );
    const orderId = Number(headerRes.rows[0]?.id);
    if (body.product_id) {
      const productId = Number(body.product_id);
      const qtyOrdered = money(body.qty_ordered || 0);
      const unitRate = money(body.unit_rate_base || 0);
      const prod = await getCompanyProductOrNull(client, { companyId, productId, mode: "purchase" });
      if (!prod) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
      }
      const amountBase = Math.round(money(qtyOrdered * unitRate) * 100) / 100;
      await client.query(
        `
          insert into subcontract_order_lines (
            subcontract_order_id,
            line_no,
            product_id,
            description,
            uom,
            qty_ordered,
            qty_sent,
            qty_received,
            unit_rate_base,
            amount_base,
            remarks
          )
          values ($1,1,$2,$3,$4,$5,0,0,$6,$7,$8)
        `,
        [orderId, productId, prod.item_name, prod.uom, qtyOrdered, unitRate, amountBase, normalizeText(body.line_remarks)]
      );
    }
    await client.query("commit");
    return res.json({ ok: true, subcontract_order_id: orderId });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/summary", requireScreenAction("subcontracting", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const params = [Number(companyId)];
    const where = [`so.company_id = $1`];
    if (ownRecordsOnly(req, "subcontracting")) {
      params.push(Number(req.user.id));
      where.push(`so.created_by = $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const r = await pool.query(
      `
        select
          count(*)::int as total,
          sum(case when so.subcontract_status = 'draft' then 1 else 0 end)::int as draft,
          sum(case when so.subcontract_status = 'sent' then 1 else 0 end)::int as sent,
          sum(case when so.subcontract_status = 'partial_received' then 1 else 0 end)::int as partial_received,
          sum(case when so.subcontract_status = 'received' then 1 else 0 end)::int as received,
          sum(case when so.subcontract_status = 'closed' then 1 else 0 end)::int as closed,
          sum(case when so.subcontract_status = 'cancelled' then 1 else 0 end)::int as cancelled,
          sum(case when so.subcontract_status not in ('closed','cancelled') and so.due_date is not null and so.due_date < current_date then 1 else 0 end)::int as overdue
        from subcontract_orders so
        ${whereSql}
      `,
      params
    );
    return res.json({ ok: true, summary: r.rows[0] || null });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("subcontracting", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "";
    const limit = normalizeLimit(req.query.limit, 160, 300);
    const params = [Number(companyId)];
    const where = [`so.company_id = $1`];
    if (ownRecordsOnly(req, "subcontracting")) {
      params.push(Number(req.user.id));
      where.push(`so.created_by = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      where.push(`(
        so.subcontract_number ilike $${idx}
        or coalesce(v.company_name, '') ilike $${idx}
        or coalesce(jc.job_card_number, '') ilike $${idx}
      )`);
    }
    if (bucket && bucket !== "all") {
      if (bucket === "overdue") {
        where.push(`so.subcontract_status not in ('closed','cancelled') and so.due_date is not null and so.due_date < current_date`);
      } else {
        params.push(bucket);
        where.push(`so.subcontract_status = $${params.length}`);
      }
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const r = await pool.query(
      `
        select
          so.id,
          so.subcontract_number,
          so.subcontract_status,
          so.vendor_id,
          v.company_name as vendor_name,
          so.job_card_id,
          jc.job_card_number,
          so.order_date,
          so.due_date,
          so.remarks,
          coalesce(sum(l.qty_ordered), 0) as ordered_qty,
          coalesce(sum(l.qty_sent), 0) as sent_qty,
          coalesce(sum(l.qty_received), 0) as received_qty,
          coalesce(sum(l.amount_base), 0) as amount_base
        from subcontract_orders so
        left join vendors v on v.id = so.vendor_id and v.company_id = so.company_id
        left join job_cards jc on jc.id = so.job_card_id
        left join subcontract_order_lines l on l.subcontract_order_id = so.id
        ${whereSql}
        group by so.id, v.company_name, jc.job_card_number
        order by so.order_date desc, so.id desc
        limit ${limit}
      `,
      params
    );
    return res.json({
      ok: true,
      orders: r.rows.map((row) => ({
        ...row,
        ordered_qty: money(row.ordered_qty),
        sent_qty: money(row.sent_qty),
        received_qty: money(row.received_qty),
        amount_base: Math.round(num(row.amount_base) * 100) / 100,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireScreenAction("subcontracting", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const header = await getOrderHeaderOrNull(pool, id, companyId);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessSubcontractOrder(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const [lines, movements] = await Promise.all([getOrderLines(pool, id), getOrderMovements(pool, id)]);
    return res.json({ ok: true, order: header, lines, movements });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("subcontracting", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    await client.query("begin");
    const header = await getOrderHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessSubcontractOrder(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const nextStatus = typeof body.subcontract_status === "string" ? body.subcontract_status.trim().toLowerCase() : null;
    if (nextStatus && !["draft", "sent", "partial_received", "received", "closed", "cancelled"].includes(nextStatus)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }
    const vendorId = Number(body.vendor_id) || null;
    const dueDate = normalizeText(body.due_date) || null;
    await client.query(
      `
        update subcontract_orders
        set vendor_id = $2,
            due_date = $3,
            remarks = $4,
            subcontract_status = coalesce($5, subcontract_status),
            updated_at = now()
        where id = $1 and company_id = $6
      `,
      [id, vendorId, dueDate, normalizeText(body.remarks), nextStatus, companyId]
    );

    const existingLines = await client.query(
      `
        select id, product_id, qty_sent, qty_received
        from subcontract_order_lines
        where subcontract_order_id = $1
        order by line_no asc
      `,
      [id]
    );
    const existingMap = new Map(existingLines.rows.map((row) => [Number(row.id), row]));
    const nextLines = Array.isArray(body.lines) ? body.lines : [];
    const seenIds = new Set();
    let lineNo = 1;
    for (const raw of nextLines) {
      if (!raw) continue;
      const lineId = raw.id ? Number(raw.id) : null;
      if (lineId && (!Number.isFinite(lineId) || lineId <= 0)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_LINE_ID" });
      }
      if (lineId) {
        if (seenIds.has(lineId)) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "DUPLICATE_LINE_ID" });
        }
        seenIds.add(lineId);
      }
      const productId = Number(raw.product_id);
      if (!Number.isFinite(productId) || productId <= 0) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
      }
      const qtyOrdered = money(raw.qty_ordered || 0);
      const unitRate = money(raw.unit_rate_base || 0);
      if (qtyOrdered < 0 || unitRate < 0) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_QTY" });
      }
      const prod = await getCompanyProductOrNull(client, { companyId, productId, mode: "purchase" });
      if (!prod) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
      }
      const amountBase = Math.round(money(qtyOrdered * unitRate) * 100) / 100;
      if (lineId && existingMap.has(lineId)) {
        const existing = existingMap.get(lineId);
        const sent = money(existing.qty_sent);
        const received = money(existing.qty_received);
        if (Number(existing.product_id) !== productId && (sent > 0.0001 || received > 0.0001)) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "LINE_HAS_MOVEMENTS" });
        }
        await client.query(
          `
            update subcontract_order_lines
            set line_no = $2,
                product_id = $3,
                description = $4,
                uom = $5,
                qty_ordered = $6,
                unit_rate_base = $7,
                amount_base = $8,
                remarks = $9
            where id = $1 and subcontract_order_id = $10
          `,
          [lineId, lineNo, productId, normalizeText(raw.description) || prod.item_name, prod.uom, qtyOrdered, unitRate, amountBase, normalizeText(raw.remarks), id]
        );
      } else {
        await client.query(
          `
            insert into subcontract_order_lines (
              subcontract_order_id,
              line_no,
              product_id,
              description,
              uom,
              qty_ordered,
              qty_sent,
              qty_received,
              unit_rate_base,
              amount_base,
              remarks
            )
            values ($1,$2,$3,$4,$5,$6,0,0,$7,$8,$9)
          `,
          [id, lineNo, productId, normalizeText(raw.description) || prod.item_name, prod.uom, qtyOrdered, unitRate, amountBase, normalizeText(raw.remarks)]
        );
      }
      lineNo += 1;
    }

    for (const row of existingLines.rows) {
      const lineId = Number(row.id);
      if (seenIds.has(lineId)) continue;
      const sent = money(row.qty_sent);
      const received = money(row.qty_received);
      if (sent > 0.0001 || received > 0.0001) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "LINE_HAS_MOVEMENTS" });
      }
      await client.query(`delete from subcontract_order_lines where id = $1 and subcontract_order_id = $2`, [lineId, id]);
    }

    await recalcOrderStatus(client, id, companyId);
    await client.query("commit");
    const fresh = await getOrderHeaderOrNull(pool, id, companyId);
    const [lines, movements] = await Promise.all([getOrderLines(pool, id), getOrderMovements(pool, id)]);
    return res.json({ ok: true, order: fresh, lines, movements });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/movement", requireScreenAction("subcontracting", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const lineId = Number(body.subcontract_order_line_id);
    const movementType = typeof body.movement_type === "string" ? body.movement_type.trim().toLowerCase() : "";
    const qtyMove = money(body.qty);
    const movementDate = normalizeText(body.movement_date) || null;
    if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ ok: false, error: "INVALID_LINE_ID" });
    if (!["send", "receive"].includes(movementType)) return res.status(400).json({ ok: false, error: "INVALID_MOVEMENT_TYPE" });
    if (qtyMove <= 0) return res.status(400).json({ ok: false, error: "INVALID_QTY" });
    await client.query("begin");
    const header = await getOrderHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessSubcontractOrder(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const currentStatus = String(header.subcontract_status || "draft").toLowerCase();
    if (currentStatus === "closed" || currentStatus === "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ORDER_LOCKED" });
    }
    const lineRes = await client.query(
      `
        select
          l.id,
          l.product_id,
          l.qty_ordered,
          l.qty_sent,
          l.qty_received
        from subcontract_order_lines l
        where l.id = $1 and l.subcontract_order_id = $2
        limit 1
      `,
      [lineId, id]
    );
    const line = lineRes.rows[0] || null;
    if (!line) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "LINE_NOT_FOUND" });
    }
    const ordered = money(line.qty_ordered);
    const sent = money(line.qty_sent);
    const received = money(line.qty_received);
    if (movementType === "send") {
      const remainingToSend = money(Math.max(ordered - sent, 0));
      if (qtyMove > remainingToSend + 0.0001) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "SEND_EXCEEDS_ORDERED" });
      }
    }
    if (movementType === "receive") {
      const remainingToReceive = money(Math.max(sent - received, 0));
      if (qtyMove > remainingToReceive + 0.0001) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "RECEIVE_EXCEEDS_SENT" });
      }
    }
    const moveRes = await client.query(
      `
        insert into subcontract_movements (
          company_id,
          subcontract_order_id,
          subcontract_order_line_id,
          movement_type,
          movement_date,
          qty,
          created_by
        )
        values ($1,$2,$3,$4,coalesce($5::date, current_date),$6,$7)
        returning id
      `,
      [companyId, id, lineId, movementType, movementDate, qtyMove, req.user.id]
    );
    const movementId = Number(moveRes.rows[0]?.id);
    if (movementType === "send") {
      await client.query(
        `update subcontract_order_lines set qty_sent = qty_sent + $2 where id = $1 and subcontract_order_id = $3`,
        [lineId, qtyMove, id]
      );
    } else {
      await client.query(
        `update subcontract_order_lines set qty_received = qty_received + $2 where id = $1 and subcontract_order_id = $3`,
        [lineId, qtyMove, id]
      );
    }

    const refType = movementType === "send" ? "SUBCONTRACT_SEND" : "SUBCONTRACT_RECEIPT";
    const qtySigned = movementType === "send" ? -qtyMove : qtyMove;
    await client.query(
      `
        insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
        values ($1,$2,$3,coalesce($4::date, current_date),$5,$6,$7,$8)
      `,
      [companyId, Number(line.product_id), qtySigned, movementDate, refType, id, movementId, req.user.id]
    );
    await recalcCompanyStockBalances(client, companyId, [Number(line.product_id)]);
    await recalcOrderStatus(client, id, companyId);
    await client.query("commit");

    const fresh = await getOrderHeaderOrNull(pool, id, companyId);
    const [lines, movements] = await Promise.all([getOrderLines(pool, id), getOrderMovements(pool, id)]);
    return res.json({ ok: true, order: fresh, lines, movements });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
