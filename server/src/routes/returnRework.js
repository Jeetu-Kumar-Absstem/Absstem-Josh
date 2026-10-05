const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");

const router = express.Router();

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function normalizeId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function qty4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function normalizeLimit(value, fallback = 80, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function getAgeDays(value) {
  const dateText = value ? String(value).slice(0, 10) : "";
  if (!dateText) return null;
  const d = new Date(dateText);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  d.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
}

function getReturnReworkBucket(row) {
  const acceptedQty = qty4(row.qty_accepted);
  const plannedActive = qty4(row.qty_planned_active);
  const pendingQty = qty4(Math.max(acceptedQty - plannedActive, 0));
  if (pendingQty <= 0.0001) return "closed";
  const ageDays = getAgeDays(row.source_date);
  if (Number.isFinite(ageDays) && ageDays >= 7) return "stale_7d";
  const activeJobs = Number(row.active_job_count || 0);
  if (activeJobs <= 0) return "pending_start";
  return "in_progress";
}

function matchesBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return true;
  return getReturnReworkBucket(row) === key;
}

function rankRow(row) {
  const bucket = getReturnReworkBucket(row);
  if (bucket === "stale_7d") return 0;
  if (bucket === "pending_start") return 1;
  if (bucket === "in_progress") return 2;
  if (bucket === "closed") return 3;
  return 9;
}

async function queryReturnReworkRows(client, req, { q = "", limit = 600 } = {}) {
  const companyId = getActiveCompanyId(req);
  if (!companyId) return [];
  const qText = normalizeText(q);
  const params = [companyId];
  let qSql = "";
  if (qText) {
    params.push(`%${qText}%`);
    qSql = `
      and (
        coalesce(source_number, '') ilike $${params.length}
        or coalesce(customer_name, '') ilike $${params.length}
        or coalesce(item_code, '') ilike $${params.length}
        or coalesce(item_name, '') ilike $${params.length}
        or coalesce(latest_job_card_number, '') ilike $${params.length}
      )
    `;
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);

  const r = await client.query(
    `
      with reverse_rows as (
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
          coalesce(swcl.qty_accepted, 0)::numeric(18, 4) as qty_accepted
        from service_warranty_cases swc
        join customers c on c.id = swc.customer_id
        join service_warranty_case_lines swcl on swcl.service_warranty_case_id = swc.id
        where swc.company_id = $1
          and coalesce(swcl.qty_accepted, 0) > 0
      ),
      sales_rows as (
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
          coalesce(srl.qty_accepted, 0)::numeric(18, 4) as qty_accepted
        from sales_returns sr
        join customers c on c.id = sr.customer_id
        join sales_return_lines srl on srl.sales_return_id = sr.id
        where sr.company_id = $1
          and sr.return_status = 'posted'
          and coalesce(srl.qty_accepted, 0) > 0
      ),
      base as (
        select * from reverse_rows
        union all
        select * from sales_rows
      ),
      rework_jobs as (
        select
          rj.company_id,
          rj.source_type,
          rj.source_id,
          rj.source_line_id,
          count(*) filter (where coalesce(jc.job_status, '') <> 'cancelled')::int as active_job_count,
          coalesce(sum(case when coalesce(jc.job_status, '') <> 'cancelled' then rj.qty_planned else 0 end), 0)::numeric(18, 4) as qty_planned_active,
          max(rj.job_card_id) filter (where rj.job_card_id is not null) as latest_job_card_id,
          max(jc.job_card_number) filter (where jc.id is not null) as latest_job_card_number,
          max(jc.job_status) filter (where jc.id is not null) as latest_job_status
        from customer_return_rework_jobs rj
        left join job_cards jc on jc.id = rj.job_card_id
        where rj.company_id = $1
        group by rj.company_id, rj.source_type, rj.source_id, rj.source_line_id
      )
      select
        b.*,
        coalesce(r.active_job_count, 0)::int as active_job_count,
        coalesce(r.qty_planned_active, 0)::numeric(18, 4) as qty_planned_active,
        r.latest_job_card_id,
        r.latest_job_card_number,
        r.latest_job_status
      from base b
      left join rework_jobs r
        on r.company_id = $1
        and r.source_type = b.source_type
        and r.source_id = b.source_id
        and r.source_line_id = b.source_line_id
      where true
      ${qSql}
      order by source_date desc nulls last, source_number desc nulls last, source_id desc, line_no asc
      limit ${safeLimit}
    `,
    params
  );

  return r.rows;
}

async function getReturnReworkSummary(client, req, { q = "" } = {}) {
  const rows = await queryReturnReworkRows(client, req, { q, limit: 1000 });
  const pendingStart = rows.filter((row) => getReturnReworkBucket(row) === "pending_start").length;
  const inProgress = rows.filter((row) => getReturnReworkBucket(row) === "in_progress").length;
  const stale = rows.filter((row) => getReturnReworkBucket(row) === "stale_7d").length;
  const pendingQty = rows.reduce((acc, row) => {
    const acceptedQty = qty4(row.qty_accepted);
    const plannedQty = qty4(row.qty_planned_active);
    return acc + Math.max(acceptedQty - plannedQty, 0);
  }, 0);
  return {
    pending_start_lines: pendingStart,
    in_progress_lines: inProgress,
    stale_7d_lines: stale,
    pending_qty: Number(pendingQty.toFixed(4)),
  };
}

async function getReturnReworkQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryReturnReworkRows(client, req, { q, limit: 1000 });
  return rows
    .filter((row) => matchesBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = rankRow(a) - rankRow(b);
      if (rankDiff !== 0) return rankDiff;
      const dateA = a.source_date ? String(a.source_date) : "";
      const dateB = b.source_date ? String(b.source_date) : "";
      if (dateA !== dateB) return dateA < dateB ? 1 : -1;
      return Number(b.source_id || 0) - Number(a.source_id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

router.get("/summary", requireScreenAction("return_rework", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getReturnReworkSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/queue", requireScreenAction("return_rework", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getReturnReworkQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/start", requireScreenAction("return_rework", "can_edit"), async (req, res, next) => {
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
    let lineNo = null;
    let sourceNumber = null;
    let sourceDate = null;
    let customerName = null;
    let itemCode = null;
    let itemName = null;
    let uom = null;
    let acceptedQty = 0;

    if (sourceType === "sales_return") {
      const headerRes = await client.query(`select id, company_id, return_number, return_date from sales_returns where id = $1 limit 1`, [sourceId]);
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
      sourceNumber = header.return_number;
      sourceDate = header.return_date;
      const rowRes = await client.query(
        `
          select
            srl.id,
            srl.line_no,
            srl.product_id,
            srl.item_code,
            srl.item_name,
            srl.uom,
            coalesce(srl.qty_accepted, 0)::numeric(18, 4) as qty_accepted,
            c.customer_name
          from sales_return_lines srl
          join sales_returns sr on sr.id = srl.sales_return_id
          join customers c on c.id = sr.customer_id
          where srl.id = $1 and srl.sales_return_id = $2
          limit 1
        `,
        [sourceLineId, sourceId]
      );
      const row = rowRes.rows[0] || null;
      if (!row) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "SALES_RETURN_LINE_NOT_FOUND" });
      }
      productId = normalizeId(row.product_id);
      lineNo = row.line_no;
      itemCode = row.item_code;
      itemName = row.item_name;
      uom = row.uom;
      acceptedQty = qty4(row.qty_accepted);
      customerName = row.customer_name;
    } else {
      const headerRes = await client.query(`select id, company_id, case_number, case_date from service_warranty_cases where id = $1 limit 1`, [sourceId]);
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
      sourceNumber = header.case_number;
      sourceDate = header.case_date;
      const rowRes = await client.query(
        `
          select
            swcl.id,
            swcl.line_no,
            swcl.product_id,
            swcl.item_code,
            swcl.item_name,
            swcl.uom,
            coalesce(swcl.qty_accepted, 0)::numeric(18, 4) as qty_accepted,
            c.customer_name
          from service_warranty_case_lines swcl
          join service_warranty_cases swc on swc.id = swcl.service_warranty_case_id
          join customers c on c.id = swc.customer_id
          where swcl.id = $1 and swcl.service_warranty_case_id = $2
          limit 1
        `,
        [sourceLineId, sourceId]
      );
      const row = rowRes.rows[0] || null;
      if (!row) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "SERVICE_CASE_LINE_NOT_FOUND" });
      }
      productId = normalizeId(row.product_id);
      lineNo = row.line_no;
      itemCode = row.item_code;
      itemName = row.item_name;
      uom = row.uom;
      acceptedQty = qty4(row.qty_accepted);
      customerName = row.customer_name;
    }

    if (!companyId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    }
    if (!productId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "PRODUCT_NOT_FOUND" });
    }
    if (acceptedQty <= 0.0001) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "NO_ACCEPTED_QTY" });
    }

    const plannedRes = await client.query(
      `
        select
          coalesce(sum(case when coalesce(jc.job_status, '') <> 'cancelled' then rj.qty_planned else 0 end), 0)::numeric(18, 4) as qty_planned_active
        from customer_return_rework_jobs rj
        left join job_cards jc on jc.id = rj.job_card_id
        where rj.company_id = $1
          and rj.source_type = $2
          and rj.source_id = $3
          and rj.source_line_id = $4
      `,
      [companyId, sourceType, sourceId, sourceLineId]
    );
    const plannedActive = qty4(plannedRes.rows[0]?.qty_planned_active);
    const pendingQty = qty4(Math.max(acceptedQty - plannedActive, 0));

    const qtyPlanned = qty4(body.qty_planned);
    if (qtyPlanned <= 0.0001) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_QTY" });
    }
    if (qtyPlanned > pendingQty + 0.0001) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "QTY_EXCEEDS_PENDING" });
    }

    const jobDate = normalizeText(body.job_date) || null;
    const technicianName = normalizeText(body.technician_name) || null;
    const department = normalizeText(body.department) || null;
    const siteName = normalizeText(body.site_name) || null;
    const remarks = normalizeText(body.remarks) || null;

    const numRes = await client.query(`select next_company_document_number($1, 'JCB') as job_card_number`, [companyId]);
    const jobCardNumber = numRes.rows[0]?.job_card_number;
    if (!jobCardNumber) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "JOB_CARD_NUMBER_FAILED" });
    }

    const jobRemarksParts = [
      "RMA rework",
      sourceType === "sales_return" ? "Sales Return" : "Service Case",
      sourceNumber ? String(sourceNumber) : null,
      lineNo ? `L${lineNo}` : null,
      customerName ? String(customerName) : null,
      itemCode ? String(itemCode) : null,
    ].filter(Boolean);
    const jobRemarks = `${jobRemarksParts.join(" • ")}${remarks ? ` • ${remarks}` : ""}`;

    const jobRes = await client.query(
      `
        insert into job_cards (
          job_card_number,
          company_id,
          job_status,
          job_date,
          job_type,
          technician_name,
          department,
          site_name,
          remarks,
          created_by
        )
        values ($1,$2,'draft',coalesce($3, current_date),'internal_issue',$4,$5,$6,$7,$8)
        returning id
      `,
      [jobCardNumber, companyId, jobDate, technicianName, department, siteName, jobRemarks, req.user.id]
    );
    const jobCardId = jobRes.rows[0]?.id;
    if (!jobCardId) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "JOB_CARD_CREATE_FAILED" });
    }

    const productRes = await client.query(`select serial_no_required from products where id = $1 limit 1`, [productId]);
    const serialRequired = Boolean(productRes.rows[0]?.serial_no_required);

    await client.query(
      `
        insert into job_card_lines (
          job_card_id,
          line_no,
          product_id,
          item_code,
          item_name,
          uom,
          serial_no_required,
          qty_requested,
          qty_consumed,
          remarks
        )
        values ($1, 1, $2, $3, $4, $5, $6, $7, 0, $8)
      `,
      [jobCardId, productId, itemCode, itemName, uom, serialRequired, qtyPlanned, "RMA rework"]
    );

    await client.query(
      `
        insert into customer_return_rework_jobs (
          company_id,
          source_type,
          source_id,
          source_line_id,
          product_id,
          qty_planned,
          job_card_id,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [companyId, sourceType, sourceId, sourceLineId, productId, qtyPlanned, jobCardId, remarks, req.user.id]
    );

    await client.query("commit");

    const summary = await getReturnReworkSummary(pool, req, { q: "" });
    const rows = await getReturnReworkQueue(pool, req, { q: "", bucket: "all", limit: 80 });
    return res.status(201).json({ ok: true, job_card_id: jobCardId, summary, rows });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;

