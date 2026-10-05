const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { recalcStockBalances } = require("../services/stockLedger");

const router = express.Router();

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function qty4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function normalizeId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeLimit(value, fallback = 80, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function getReverseLogisticsBucket(row) {
  const returnedQty = qty4(row.qty_returned);
  const acceptedQty = qty4(row.qty_accepted);
  const scrappedQty = qty4(row.qty_scrapped);
  if (acceptedQty + scrappedQty > returnedQty + 0.0001) return "over_disposed";
  const pending = qty4(Math.max(returnedQty - acceptedQty - scrappedQty, 0));
  if (pending <= 0.0001) return "closed";
  const dateText = row.source_date ? String(row.source_date).slice(0, 10) : null;
  if (dateText) {
    const d = new Date(dateText);
    const today = new Date();
    d.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    const ageDays = Math.floor((today.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
    if (Number.isFinite(ageDays) && ageDays >= 7) return "stale_7d";
  }
  return "pending_disposition";
}

function matchesReverseLogisticsBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return true;
  return getReverseLogisticsBucket(row) === key;
}

function getReverseLogisticsRank(row) {
  const bucket = getReverseLogisticsBucket(row);
  if (bucket === "over_disposed") return 0;
  if (bucket === "stale_7d") return 1;
  if (bucket === "pending_disposition") return 2;
  if (bucket === "closed") return 3;
  return 9;
}

async function queryReverseLogisticsRows(client, req, { q = "", limit = 600 } = {}) {
  const companyId = getActiveCompanyId(req);
  if (!companyId) return [];
  const params = [companyId];
  const qText = normalizeText(q);
  let qSql = "";
  if (qText) {
    params.push(`%${qText}%`);
    qSql = `
      and (
        coalesce(source_number, '') ilike $${params.length}
        or coalesce(customer_name, '') ilike $${params.length}
        or coalesce(item_code, '') ilike $${params.length}
        or coalesce(item_name, '') ilike $${params.length}
      )
    `;
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);

  const r = await client.query(
    `
      with service_returns as (
        select
          'service_warranty'::text as source_type,
          swc.id as source_id,
          swc.case_number as source_number,
          swc.case_date as source_date,
          swc.customer_id,
          c.customer_name,
          swcl.id as source_line_id,
          swcl.line_no,
          swcl.product_id,
          swcl.item_code,
          swcl.item_name,
          swcl.uom,
          coalesce(sum(case when swm.movement_type = 'field_return' then swm.qty else 0 end), 0)::numeric(18, 4) as qty_returned,
          coalesce(swcl.qty_accepted, 0)::numeric(18, 4) as qty_accepted,
          coalesce(swcl.qty_scrapped, 0)::numeric(18, 4) as qty_scrapped,
          swcl.disposition_date,
          swcl.disposition_remarks
        from service_warranty_cases swc
        join customers c on c.id = swc.customer_id
        join service_warranty_case_lines swcl on swcl.service_warranty_case_id = swc.id
        join service_warranty_movements swm on swm.service_warranty_case_line_id = swcl.id
        where swc.company_id = $1
        group by
          swc.id,
          swc.case_number,
          swc.case_date,
          swc.customer_id,
          c.customer_name,
          swcl.id,
          swcl.line_no,
          swcl.product_id,
          swcl.item_code,
          swcl.item_name,
          swcl.uom,
          swcl.qty_accepted,
          swcl.qty_scrapped,
          swcl.disposition_date,
          swcl.disposition_remarks
      ),
      sales_returns as (
        select
          'sales_return'::text as source_type,
          sr.id as source_id,
          sr.return_number as source_number,
          sr.return_date as source_date,
          sr.customer_id,
          c.customer_name,
          srl.id as source_line_id,
          srl.line_no,
          srl.product_id,
          srl.item_code,
          srl.item_name,
          srl.uom,
          coalesce(srl.qty_return, 0)::numeric(18, 4) as qty_returned,
          coalesce(srl.qty_accepted, 0)::numeric(18, 4) as qty_accepted,
          coalesce(srl.qty_scrapped, 0)::numeric(18, 4) as qty_scrapped,
          srl.disposition_date,
          srl.disposition_remarks
        from sales_returns sr
        join customers c on c.id = sr.customer_id
        join sales_return_lines srl on srl.sales_return_id = sr.id
        where sr.company_id = $1
          and sr.return_status = 'posted'
      )
      select *
      from (
        select * from service_returns
        union all
        select * from sales_returns
      ) rows
      where qty_returned > 0
      ${qSql}
      order by source_date desc nulls last, source_number desc nulls last, source_id desc, line_no asc
      limit ${safeLimit}
    `,
    params
  );

  return r.rows;
}

async function getReverseLogisticsSummary(client, req, { q = "" } = {}) {
  const rows = await queryReverseLogisticsRows(client, req, { q, limit: 1000 });
  const active = rows.filter((row) => {
    const bucket = getReverseLogisticsBucket(row);
    return bucket !== "closed";
  });
  const pendingLines = active.filter((row) => getReverseLogisticsBucket(row) === "pending_disposition").length;
  const stale = active.filter((row) => getReverseLogisticsBucket(row) === "stale_7d").length;
  const over = rows.filter((row) => getReverseLogisticsBucket(row) === "over_disposed").length;
  const pendingQty = active.reduce((acc, row) => {
    const returnedQty = qty4(row.qty_returned);
    const acceptedQty = qty4(row.qty_accepted);
    const scrappedQty = qty4(row.qty_scrapped);
    return acc + Math.max(returnedQty - acceptedQty - scrappedQty, 0);
  }, 0);
  return {
    pending_lines: pendingLines,
    stale_7d_lines: stale,
    over_disposed_lines: over,
    pending_qty: Number(pendingQty.toFixed(4)),
  };
}

async function getReverseLogisticsQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryReverseLogisticsRows(client, req, { q, limit: 1000 });
  return rows
    .filter((row) => matchesReverseLogisticsBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getReverseLogisticsRank(a) - getReverseLogisticsRank(b);
      if (rankDiff !== 0) return rankDiff;
      const dateA = a.source_date ? String(a.source_date) : "";
      const dateB = b.source_date ? String(b.source_date) : "";
      if (dateA !== dateB) return dateA < dateB ? 1 : -1;
      return Number(b.source_id || 0) - Number(a.source_id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

router.get("/summary", requireScreenAction("reverse_logistics", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getReverseLogisticsSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/queue", requireScreenAction("reverse_logistics", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getReverseLogisticsQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.put("/disposition", requireScreenAction("reverse_logistics", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const sourceType = String(body.source_type || "").trim().toLowerCase();
    const sourceId = normalizeId(body.source_id);
    const sourceLineId = normalizeId(body.source_line_id);
    if (!sourceType || !["sales_return", "service_warranty"].includes(sourceType)) {
      return res.status(400).json({ ok: false, error: "INVALID_SOURCE_TYPE" });
    }
    if (!sourceId || !sourceLineId) {
      return res.status(400).json({ ok: false, error: "INVALID_SOURCE" });
    }

    await client.query("begin");

    let companyId = null;
    let productId = null;
    let returnedQty = 0;
    let currentAccepted = 0;
    let currentScrapped = 0;

    if (sourceType === "sales_return") {
      const headerRes = await client.query(`select id, company_id from sales_returns where id = $1 limit 1`, [sourceId]);
      const header = headerRes.rows[0] || null;
      if (!header) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "SALES_RETURN_NOT_FOUND" });
      }
      if (!canAccessCompanyContext(req, header)) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
      }
      companyId = requireResolvedCompanyId(req, header.company_id);
      const lineRes = await client.query(
        `
          select id, product_id, qty_return, qty_accepted, qty_scrapped
          from sales_return_lines
          where id = $1 and sales_return_id = $2
          limit 1
        `,
        [sourceLineId, sourceId]
      );
      const line = lineRes.rows[0] || null;
      if (!line) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "SALES_RETURN_LINE_NOT_FOUND" });
      }
      productId = normalizeId(line.product_id);
      returnedQty = qty4(line.qty_return);
      currentAccepted = qty4(line.qty_accepted);
      currentScrapped = qty4(line.qty_scrapped);
    } else {
      const headerRes = await client.query(`select id, company_id from service_warranty_cases where id = $1 limit 1`, [sourceId]);
      const header = headerRes.rows[0] || null;
      if (!header) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "SERVICE_CASE_NOT_FOUND" });
      }
      if (!canAccessCompanyContext(req, header)) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
      }
      companyId = requireResolvedCompanyId(req, header.company_id);
      const lineRes = await client.query(
        `
          select id, product_id, qty_accepted, qty_scrapped
          from service_warranty_case_lines
          where id = $1 and service_warranty_case_id = $2
          limit 1
        `,
        [sourceLineId, sourceId]
      );
      const line = lineRes.rows[0] || null;
      if (!line) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "SERVICE_CASE_LINE_NOT_FOUND" });
      }
      const returnedRes = await client.query(
        `
          select coalesce(sum(qty), 0)::numeric(18, 4) as qty_returned
          from service_warranty_movements
          where service_warranty_case_line_id = $1
            and movement_type = 'field_return'
        `,
        [sourceLineId]
      );
      productId = normalizeId(line.product_id);
      returnedQty = qty4(returnedRes.rows[0]?.qty_returned);
      currentAccepted = qty4(line.qty_accepted);
      currentScrapped = qty4(line.qty_scrapped);
    }

    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    if (!productId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "PRODUCT_NOT_FOUND" });
    }

    const nextAccepted = qty4(body.qty_accepted);
    const nextScrapped = qty4(body.qty_scrapped);
    if (nextAccepted < 0 || nextScrapped < 0) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NEGATIVE_QTY" });
    }
    if (nextScrapped + nextAccepted > returnedQty + 0.0001) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DISPOSITION_EXCEEDS_RETURNED" });
    }
    if (nextScrapped + 0.0001 < currentScrapped) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "SCRAP_CANNOT_DECREASE" });
    }

    const dispositionDate = normalizeText(body.disposition_date) || null;
    const dispositionRemarks = normalizeText(body.disposition_remarks) || null;

    if (sourceType === "sales_return") {
      await client.query(
        `
          update sales_return_lines
          set qty_accepted = $3,
              qty_scrapped = $4,
              disposition_date = coalesce($5::date, disposition_date, current_date),
              disposition_remarks = $6,
              updated_at = now()
          where id = $1 and sales_return_id = $2
        `,
        [sourceLineId, sourceId, nextAccepted, nextScrapped, dispositionDate, dispositionRemarks]
      );
    } else {
      await client.query(
        `
          update service_warranty_case_lines
          set qty_accepted = $3,
              qty_scrapped = $4,
              disposition_date = coalesce($5::date, disposition_date, current_date),
              disposition_remarks = $6,
              updated_at = now()
          where id = $1 and service_warranty_case_id = $2
        `,
        [sourceLineId, sourceId, nextAccepted, nextScrapped, dispositionDate, dispositionRemarks]
      );
    }

    const deltaScrap = qty4(Math.max(nextScrapped - currentScrapped, 0));
    if (deltaScrap > 0.0001) {
      const moveDate = dispositionDate ? dispositionDate : new Date().toISOString().slice(0, 10);
      await client.query(
        `
          insert into stock_movements (company_id, product_id, qty_signed, movement_date, ref_type, ref_id, ref_line_id, created_by)
          values ($1,$2,$3,coalesce($4::date, current_date),$5,$6,$7,$8)
        `,
        [companyId, productId, -deltaScrap, moveDate, "CUSTOMER_RETURN_SCRAP", sourceId, sourceLineId, req.user.id]
      );
      await recalcStockBalances(client, companyId, [productId]);
    }

    await client.query("commit");

    const summary = await getReverseLogisticsSummary(client, req, { q: "" });
    const rows = await getReverseLogisticsQueue(client, req, { q: "", bucket: "all", limit: 80 });
    return res.json({ ok: true, summary, rows });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;

