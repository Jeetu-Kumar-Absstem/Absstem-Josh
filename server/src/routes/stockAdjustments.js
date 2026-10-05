const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");
const { syncStockForStockAdjustment } = require("../services/stockLedger");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(4));
}

function isIntLike(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.floor(n) === n;
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function canAccessStockAdjustment(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "stock_adjustments")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function getProductLookup(client, companyId, q) {
  return lookupProducts(client, { companyId, q, mode: "stock", limit: 100, includeStockQty: true });
}

async function getStockAdjustmentHeaderOrNull(client, id, companyId) {
  const r = await client.query(
    `
      select
        sa.*,
        u.full_name as created_by_name,
        coalesce(sum(sal.adjustment_qty), 0) as net_adjustment_qty
      from stock_adjustments sa
      left join erp_users u on u.id = sa.created_by
      left join stock_adjustment_lines sal on sal.stock_adjustment_id = sa.id
      where sa.id = $1 and sa.company_id = $2
      group by sa.id, u.full_name
      limit 1
    `,
    [id, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getStockAdjustmentLines(client, id) {
  const lineRes = await client.query(
    `
      select *
      from stock_adjustment_lines
      where stock_adjustment_id = $1
      order by line_no asc
    `,
    [id]
  );
  const serialRes = await client.query(
    `
      select stock_adjustment_line_id, serial_no
      from stock_adjustment_line_serials
      where stock_adjustment_line_id = any(
        select id from stock_adjustment_lines where stock_adjustment_id = $1
      )
      order by id asc
    `,
    [id]
  );

  const serialsByLine = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.stock_adjustment_line_id);
    if (!serialsByLine.has(key)) serialsByLine.set(key, []);
    serialsByLine.get(key).push(String(row.serial_no || ""));
  }

  return lineRes.rows.map((row) => ({
    ...row,
    serials: serialsByLine.get(Number(row.id)) || [],
  }));
}

async function getProductSnapshots(client, companyId, productIds) {
  const cid = Number(companyId);
  const ids = [...new Set((productIds || []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0))];
  if (!ids.length) return new Map();
  const r = await client.query(
    `
      select
        p.id,
        p.item_code,
        p.item_name,
        p.uom,
        coalesce(p.serial_no_required, false) as serial_no_required,
        coalesce(sb.stock_qty, 0) as system_qty
      from products p
      left join stock_balances sb on sb.company_id = $1 and sb.product_id = p.id
      where p.id = any($2::int[])
    `,
    [cid, ids]
  );
  return new Map(r.rows.map((row) => [Number(row.id), row]));
}

router.get("/product-lookup", requireScreenAction("stock_adjustments", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const products = await getProductLookup(pool, companyId, q);
    return res.json({ ok: true, products });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("stock_adjustments", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const filters = [];
    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    filters.push(`sa.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "stock_adjustments")) {
      params.push(Number(req.user.id));
      filters.push(`sa.created_by = $${params.length}`);
    }
    const where = filters.length ? `where ${filters.join(" and ")}` : "";

    const r = await pool.query(
      `
        select
          sa.id,
          sa.adjustment_number,
          sa.adjustment_status,
          sa.adjustment_mode,
          sa.adjustment_date,
          coalesce(sum(sal.adjustment_qty), 0) as net_adjustment_qty,
          count(sal.id) as line_count
        from stock_adjustments sa
        left join stock_adjustment_lines sal on sal.stock_adjustment_id = sa.id
        ${where}
        group by sa.id
        order by sa.created_at desc, sa.id desc
      `,
      params
    );
    return res.json({ ok: true, stock_adjustments: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("stock_adjustments", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const adjustmentMode = typeof body.adjustment_mode === "string" ? body.adjustment_mode.trim().toLowerCase() : "physical_verification";
    if (!["physical_verification", "manual_adjustment"].includes(adjustmentMode)) {
      return res.status(400).json({ ok: false, error: "INVALID_MODE" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const numRes = await client.query(`select next_company_document_number($1,'STA') as adjustment_number`, [companyId]);
    const adjustmentNumber = numRes.rows[0]?.adjustment_number;
    const insertRes = await client.query(
      `
        insert into stock_adjustments (
          company_id,
          adjustment_number,
          adjustment_status,
          adjustment_mode,
          adjustment_date,
          remarks,
          created_by
        )
        values ($1,$2,'draft',$3,coalesce($4, current_date),$5,$6)
        returning id
      `,
      [companyId, adjustmentNumber, adjustmentMode, body.adjustment_date || null, normalizeText(body.remarks), req.user.id]
    );
    const id = insertRes.rows[0]?.id;
    await client.query("commit");
    const header = await getStockAdjustmentHeaderOrNull(client, id, companyId);
    const lines = await getStockAdjustmentLines(client, id);
    return res.status(201).json({ ok: true, stock_adjustment: header, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("stock_adjustments", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const header = await getStockAdjustmentHeaderOrNull(pool, id, companyId);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessCompanyContext(req, header)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessStockAdjustment(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const lines = await getStockAdjustmentLines(pool, id);
    return res.json({ ok: true, stock_adjustment: header, lines });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("stock_adjustments", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const adjustmentStatus = typeof body.adjustment_status === "string" ? body.adjustment_status.trim().toLowerCase() : "draft";
    const adjustmentMode = typeof body.adjustment_mode === "string" ? body.adjustment_mode.trim().toLowerCase() : "physical_verification";
    if (!["draft", "posted", "cancelled"].includes(adjustmentStatus)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    if (!["physical_verification", "manual_adjustment"].includes(adjustmentMode)) return res.status(400).json({ ok: false, error: "INVALID_MODE" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const header = await getStockAdjustmentHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessStockAdjustment(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const currentStatus = String(header.adjustment_status || "").toLowerCase();
    const editingLines = Array.isArray(body.lines);
    if (editingLines && currentStatus !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "ADJUSTMENT_NOT_EDITABLE" });
    }

    await client.query(
      `
        update stock_adjustments
        set adjustment_status = $2,
            adjustment_mode = $3,
            adjustment_date = coalesce($4, adjustment_date),
            remarks = $5,
            updated_at = now()
        where id = $1 and company_id = $6
      `,
      [id, adjustmentStatus, adjustmentMode, body.adjustment_date || null, normalizeText(body.remarks), companyId]
    );

    if (editingLines) {
      const rawLines = body.lines.filter((line) => line && Number(line.product_id) > 0);
      const productIds = rawLines.map((line) => Number(line.product_id));
      const productMap = await getProductSnapshots(client, companyId, productIds);
      if (productMap.size !== [...new Set(productIds)].length) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
      }

      const serialRows = Array.isArray(body.serial_rows) ? body.serial_rows : [];
      const serialsByLineNo = new Map();
      for (const row of serialRows) {
        const lineNo = Number(row.line_no);
        const serialNo = String(row.serial_no || "").trim();
        if (!Number.isFinite(lineNo) || lineNo <= 0 || !serialNo) continue;
        if (!serialsByLineNo.has(lineNo)) serialsByLineNo.set(lineNo, []);
        serialsByLineNo.get(lineNo).push(serialNo);
      }

      const seenProducts = new Set();
      const normalized = rawLines.map((line, index) => {
        const productId = Number(line.product_id);
        if (seenProducts.has(productId)) {
          const err = new Error("Duplicate product");
          err.code = "DUPLICATE_PRODUCT";
          throw err;
        }
        seenProducts.add(productId);

        const product = productMap.get(productId);
        const systemQty = money(product?.system_qty);
        const countedQty = money(line.counted_qty);
        if (countedQty < 0) {
          const err = new Error("Invalid counted qty");
          err.code = "INVALID_COUNTED_QTY";
          throw err;
        }
        const adjustmentQty = money(countedQty - systemQty);
        const serialNoRequired = product?.serial_no_required === true;
        const lineNo = index + 1;
        const serials = serialsByLineNo.get(lineNo) || [];
        if (new Set(serials).size !== serials.length) {
          const err = new Error("Duplicate serials");
          err.code = "DUPLICATE_SERIALS";
          throw err;
        }
        if (serialNoRequired && Math.abs(adjustmentQty) > 0) {
          if (!isIntLike(Math.abs(adjustmentQty))) {
            const err = new Error("Serial qty not integer");
            err.code = "SERIAL_QTY_NOT_INTEGER";
            throw err;
          }
          if (serials.length !== Math.abs(Number(adjustmentQty))) {
            const err = new Error("Serial count mismatch");
            err.code = "SERIAL_COUNT_MISMATCH";
            throw err;
          }
        }
        return {
          line_no: lineNo,
          product_id: productId,
          item_code: product?.item_code || null,
          item_name: product?.item_name || null,
          uom: product?.uom || null,
          serial_no_required: serialNoRequired,
          system_qty: systemQty,
          counted_qty: countedQty,
          adjustment_qty: adjustmentQty,
          remarks: normalizeText(line.remarks),
          serials,
        };
      });

      await client.query(`delete from stock_adjustment_line_serials where stock_adjustment_line_id in (select id from stock_adjustment_lines where stock_adjustment_id = $1)`, [id]);
      await client.query(`delete from stock_adjustment_lines where stock_adjustment_id = $1`, [id]);

      for (const line of normalized) {
        const insertLine = await client.query(
          `
            insert into stock_adjustment_lines (
              stock_adjustment_id,
              line_no,
              product_id,
              item_code,
              item_name,
              uom,
              serial_no_required,
              system_qty,
              counted_qty,
              adjustment_qty,
              remarks
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            returning id
          `,
          [
            id,
            line.line_no,
            line.product_id,
            line.item_code,
            line.item_name,
            line.uom,
            line.serial_no_required,
            line.system_qty,
            line.counted_qty,
            line.adjustment_qty,
            line.remarks,
          ]
        );
        const lineId = insertLine.rows[0]?.id;
        for (const serialNo of line.serials) {
          await client.query(
            `
              insert into stock_adjustment_line_serials (
                stock_adjustment_line_id,
                serial_no
              )
              values ($1,$2)
            `,
            [lineId, serialNo]
          );
        }
      }
    }

    const companyRes = await client.query(`select company_id from stock_adjustments where id = $1 limit 1`, [id]);
    const syncCompanyId = Number(companyRes.rows[0]?.company_id) || null;
    await syncStockForStockAdjustment(client, syncCompanyId, id);

    await client.query("commit");
    const nextHeader = await getStockAdjustmentHeaderOrNull(client, id, companyId);
    const lines = await getStockAdjustmentLines(client, id);
    return res.json({ ok: true, stock_adjustment: nextHeader, lines });
  } catch (err) {
    await client.query("rollback");
    if (["DUPLICATE_PRODUCT", "INVALID_COUNTED_QTY", "SERIAL_QTY_NOT_INTEGER", "SERIAL_COUNT_MISMATCH", "DUPLICATE_SERIALS"].includes(err?.code)) {
      return res.status(400).json({ ok: false, error: err.code });
    }
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
