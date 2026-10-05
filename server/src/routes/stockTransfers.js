const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");
const { syncStockForStockTransfer } = require("../services/stockLedger");

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

function canAccessTransfer(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "stock_transfers")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function getLocations(client, companyId) {
  const cid = Number(companyId);
  const r = await client.query(
    `
      select id, location_code, location_name, location_type, is_active, remarks
      from stock_locations
      where company_id = $1
      order by location_name asc, id asc
    `,
    [cid]
  );
  return r.rows;
}

async function getProductLookup(client, companyId, q) {
  return lookupProducts(client, { companyId, q, mode: "stock", limit: 100, includeStockQty: true });
}

async function getStockTransferHeaderOrNull(client, id, companyId) {
  const r = await client.query(
    `
      select
        st.*,
        fl.location_name as from_location_name,
        tl.location_name as to_location_name,
        u.full_name as created_by_name,
        coalesce((select sum(qty) from stock_transfer_lines where stock_transfer_id = st.id), 0) as total_qty
      from stock_transfers st
      join stock_locations fl on fl.id = st.from_location_id
      join stock_locations tl on tl.id = st.to_location_id
      left join erp_users u on u.id = st.created_by
      where st.id = $1 and st.company_id = $2
      limit 1
    `,
    [id, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getStockTransferLines(client, id, companyId) {
  const lineRes = await client.query(
    `
      select *
      from stock_transfer_lines
      where stock_transfer_id = $1
      order by line_no asc
    `,
    [id]
  );
  const serialRes = await client.query(
    `
      select stock_transfer_line_id, serial_no
      from stock_transfer_line_serials
      where stock_transfer_line_id = any(
        select l.id
        from stock_transfer_lines l
        join stock_transfers st on st.id = l.stock_transfer_id
        where l.stock_transfer_id = $1 and st.company_id = $2
      )
      order by id asc
    `,
    [id, Number(companyId)]
  );
  const serialsByLine = new Map();
  for (const row of serialRes.rows) {
    const key = Number(row.stock_transfer_line_id);
    if (!serialsByLine.has(key)) serialsByLine.set(key, []);
    serialsByLine.get(key).push(String(row.serial_no || ""));
  }
  return lineRes.rows.map((row) => ({ ...row, serials: serialsByLine.get(Number(row.id)) || [] }));
}

router.get("/bootstrap", requireScreenAction("stock_transfers", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const locations = await getLocations(pool, companyId);
    return res.json({ ok: true, locations });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-lookup", requireScreenAction("stock_transfers", "can_view"), async (req, res, next) => {
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

router.get("/locations", requireScreenAction("stock_transfers", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    return res.json({ ok: true, locations: await getLocations(pool, companyId) });
  } catch (err) {
    return next(err);
  }
});

router.post("/locations", requireScreenAction("stock_transfers", "can_create"), async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const locationType = typeof body.location_type === "string" ? body.location_type.trim().toLowerCase() : "warehouse";
    if (!["warehouse", "site", "van", "service"].includes(locationType)) {
      return res.status(400).json({ ok: false, error: "INVALID_LOCATION_TYPE" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const r = await pool.query(
      `
        insert into stock_locations (
          company_id,
          location_code,
          location_name,
          location_type,
          is_active,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7)
        returning id
      `,
      [companyId, normalizeText(body.location_code), normalizeText(body.location_name), locationType, body.is_active !== false, normalizeText(body.remarks), req.user.id]
    );
    return res.status(201).json({ ok: true, location_id: r.rows[0]?.id || null, locations: await getLocations(pool, companyId) });
  } catch (err) {
    return next(err);
  }
});

router.put("/locations/:id", requireScreenAction("stock_transfers", "can_edit"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const locationType = typeof body.location_type === "string" ? body.location_type.trim().toLowerCase() : "warehouse";
    if (!["warehouse", "site", "van", "service"].includes(locationType)) {
      return res.status(400).json({ ok: false, error: "INVALID_LOCATION_TYPE" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    await pool.query(
      `
        update stock_locations
        set location_code = $2,
            location_name = $3,
            location_type = $4,
            is_active = $5,
            remarks = $6,
            updated_at = now()
        where id = $1 and company_id = $7
      `,
      [id, normalizeText(body.location_code), normalizeText(body.location_name), locationType, body.is_active !== false, normalizeText(body.remarks), companyId]
    );
    return res.json({ ok: true, locations: await getLocations(pool, companyId) });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("stock_transfers", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const filters = [];
    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    filters.push(`st.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "stock_transfers")) {
      params.push(Number(req.user.id));
      filters.push(`st.created_by = $${params.length}`);
    }
    const where = filters.length ? `where ${filters.join(" and ")}` : "";
    const r = await pool.query(
      `
        select
          st.id,
          st.transfer_number,
          st.transfer_status,
          st.transfer_date,
          fl.location_name as from_location_name,
          tl.location_name as to_location_name,
          coalesce((select sum(qty) from stock_transfer_lines where stock_transfer_id = st.id), 0) as total_qty
        from stock_transfers st
        join stock_locations fl on fl.id = st.from_location_id
        join stock_locations tl on tl.id = st.to_location_id
        ${where}
        order by st.created_at desc, st.id desc
      `,
      params
    );
    return res.json({ ok: true, stock_transfers: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("stock_transfers", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const fromLocationId = Number(body.from_location_id);
    const toLocationId = Number(body.to_location_id);
    if (!Number.isFinite(fromLocationId) || !Number.isFinite(toLocationId) || fromLocationId <= 0 || toLocationId <= 0 || fromLocationId === toLocationId) {
      return res.status(400).json({ ok: false, error: "INVALID_LOCATIONS" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    await client.query("begin");
    const locRes = await client.query(
      `select id from stock_locations where company_id = $1 and id = any($2::int[])`,
      [companyId, [fromLocationId, toLocationId]]
    );
    if (locRes.rows.length !== 2) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_LOCATIONS" });
    }
    const numRes = await client.query(`select next_company_document_number($1,'TRF') as transfer_number`, [companyId]);
    const transferNumber = numRes.rows[0]?.transfer_number;
    const insertRes = await client.query(
      `
        insert into stock_transfers (
          company_id,
          transfer_number,
          transfer_status,
          transfer_date,
          from_location_id,
          to_location_id,
          remarks,
          created_by
        )
        values ($1,$2,'draft',coalesce($3, current_date),$4,$5,$6,$7)
        returning id
      `,
      [companyId, transferNumber, body.transfer_date || null, fromLocationId, toLocationId, normalizeText(body.remarks), req.user.id]
    );
    const id = insertRes.rows[0]?.id;
    await client.query("commit");
    const header = await getStockTransferHeaderOrNull(client, id, companyId);
    const lines = await getStockTransferLines(client, id, companyId);
    return res.status(201).json({ ok: true, stock_transfer: header, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("stock_transfers", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const header = await getStockTransferHeaderOrNull(pool, id, companyId);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessCompanyContext(req, header)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessTransfer(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const lines = await getStockTransferLines(pool, id, companyId);
    return res.json({ ok: true, stock_transfer: header, lines });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("stock_transfers", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const transferStatus = typeof body.transfer_status === "string" ? body.transfer_status.trim().toLowerCase() : "draft";
    const fromLocationId = Number(body.from_location_id);
    const toLocationId = Number(body.to_location_id);
    if (!["draft", "posted", "cancelled"].includes(transferStatus)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    if (!Number.isFinite(fromLocationId) || !Number.isFinite(toLocationId) || fromLocationId <= 0 || toLocationId <= 0 || fromLocationId === toLocationId) {
      return res.status(400).json({ ok: false, error: "INVALID_LOCATIONS" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const header = await getStockTransferHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessTransfer(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const editingLines = Array.isArray(body.lines);
    const currentStatus = String(header.transfer_status || "").toLowerCase();
    if (editingLines && currentStatus !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "TRANSFER_NOT_EDITABLE" });
    }

    await client.query(
      `
        update stock_transfers
        set transfer_status = $2,
            transfer_date = coalesce($3, transfer_date),
            from_location_id = $4,
            to_location_id = $5,
            remarks = $6,
            updated_at = now()
        where id = $1 and company_id = $7
      `,
      [id, transferStatus, body.transfer_date || null, fromLocationId, toLocationId, normalizeText(body.remarks), companyId]
    );

    if (editingLines) {
      const rawLines = body.lines.filter((line) => line && Number(line.product_id) > 0);
      const productIds = [...new Set(rawLines.map((line) => Number(line.product_id)))];
      const productRes = productIds.length
        ? await client.query(
            `select id, item_code, item_name, uom, coalesce(serial_no_required, false) as serial_no_required, coalesce((select stock_qty from stock_balances where company_id = $2 and product_id = products.id), 0) as stock_qty from products where id = any($1::int[])`,
            [productIds, companyId]
          )
        : { rows: [] };
      const productMap = new Map(productRes.rows.map((row) => [Number(row.id), row]));
      if (productMap.size !== productIds.length) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
      }

      const serialRows = Array.isArray(body.serial_rows) ? body.serial_rows : [];
      const serialsByLine = new Map();
      for (const row of serialRows) {
        const lineNo = Number(row.line_no);
        const serialNo = String(row.serial_no || "").trim();
        if (!Number.isFinite(lineNo) || lineNo <= 0 || !serialNo) continue;
        if (!serialsByLine.has(lineNo)) serialsByLine.set(lineNo, []);
        serialsByLine.get(lineNo).push(serialNo);
      }

      const normalized = rawLines.map((line, index) => {
        const product = productMap.get(Number(line.product_id));
        const lineNo = index + 1;
        const transferQty = money(line.qty);
        if (transferQty <= 0) throw Object.assign(new Error("INVALID_QTY"), { code: "INVALID_QTY" });
        if (transferStatus === "posted" && transferQty > money(product.stock_qty)) {
          throw Object.assign(new Error("TRANSFER_EXCEEDS_STOCK"), { code: "TRANSFER_EXCEEDS_STOCK" });
        }
        const serials = serialsByLine.get(lineNo) || [];
        if (new Set(serials).size !== serials.length) throw Object.assign(new Error("DUPLICATE_SERIALS"), { code: "DUPLICATE_SERIALS" });
        if (product.serial_no_required === true) {
          if (!isIntLike(transferQty)) throw Object.assign(new Error("SERIAL_QTY_NOT_INTEGER"), { code: "SERIAL_QTY_NOT_INTEGER" });
          if (serials.length !== Number(transferQty)) throw Object.assign(new Error("SERIAL_COUNT_MISMATCH"), { code: "SERIAL_COUNT_MISMATCH" });
        }
        return {
          line_no: lineNo,
          product_id: Number(line.product_id),
          item_code: product.item_code || null,
          item_name: product.item_name || null,
          uom: product.uom || null,
          serial_no_required: product.serial_no_required === true,
          qty: transferQty,
          remarks: normalizeText(line.remarks),
          serials,
        };
      });

      await client.query(`delete from stock_transfer_line_serials where stock_transfer_line_id in (select id from stock_transfer_lines where stock_transfer_id = $1)`, [id]);
      await client.query(`delete from stock_transfer_lines where stock_transfer_id = $1`, [id]);

      for (const line of normalized) {
        const insertLine = await client.query(
          `
            insert into stock_transfer_lines (
              stock_transfer_id,
              line_no,
              product_id,
              item_code,
              item_name,
              uom,
              serial_no_required,
              qty,
              remarks
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            returning id
          `,
          [id, line.line_no, line.product_id, line.item_code, line.item_name, line.uom, line.serial_no_required, line.qty, line.remarks]
        );
        const lineId = insertLine.rows[0]?.id;
        for (const serialNo of line.serials) {
          await client.query(`insert into stock_transfer_line_serials (stock_transfer_line_id, serial_no) values ($1,$2)`, [lineId, serialNo]);
        }
      }
    }

    const companyRes = await client.query(`select company_id from stock_transfers where id = $1 limit 1`, [id]);
    const syncCompanyId = Number(companyRes.rows[0]?.company_id) || null;
    await syncStockForStockTransfer(client, syncCompanyId, id);

    await client.query("commit");
    const nextHeader = await getStockTransferHeaderOrNull(client, id, companyId);
    const lines = await getStockTransferLines(client, id, companyId);
    return res.json({ ok: true, stock_transfer: nextHeader, lines });
  } catch (err) {
    await client.query("rollback");
    if (["INVALID_QTY", "TRANSFER_EXCEEDS_STOCK", "DUPLICATE_SERIALS", "SERIAL_QTY_NOT_INTEGER", "SERIAL_COUNT_MISMATCH"].includes(err?.code)) {
      return res.status(400).json({ ok: false, error: err.code });
    }
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
