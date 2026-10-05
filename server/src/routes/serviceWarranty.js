const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId } = require("../services/companyContext");
const { syncStockForServiceWarrantyCase } = require("../services/stockLedger");

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

function normalizeDate(value) {
  return normalizeText(value);
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

function normalizeNcrStatus(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["open", "contained", "root_cause_pending", "action_in_progress", "verification_pending", "closed", "cancelled"].includes(text)) {
    return text;
  }
  return null;
}

function normalizeActionStatus(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["open", "in_progress", "done", "cancelled"].includes(text)) return text;
  return null;
}

function normalizeSeverity(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["low", "medium", "high", "critical"].includes(text)) return text;
  return "medium";
}

function normalizeNcrCategory(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["incoming_defect", "process_deviation", "vendor_quality", "documentation", "packaging", "other"].includes(text)) return text;
  return "other";
}

function deriveNcrStatus(caseInput = {}, actions = []) {
  const explicitStatus = normalizeNcrStatus(caseInput.status);
  if (explicitStatus === "cancelled") return "cancelled";
  if (explicitStatus === "closed") return "closed";
  if (normalizeDate(caseInput.verification_date)) return "closed";
  const activeActions = Array.isArray(actions)
    ? actions.filter((row) => normalizeActionStatus(row.action_status || row.status) !== "cancelled")
    : [];
  const hasOpenActions = activeActions.some((row) => {
    const status = normalizeActionStatus(row.action_status || row.status);
    return status !== "done";
  });
  if (!normalizeDate(caseInput.containment_completed_date)) return "open";
  if (!normalizeText(caseInput.root_cause)) return "root_cause_pending";
  if (hasOpenActions) return "action_in_progress";
  if (activeActions.length > 0) return "verification_pending";
  return "contained";
}

function canAccessServiceCase(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "service_warranty")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

async function getDispatchSeedHeader(client, dispatchId) {
  const r = await client.query(
    `
      select
        d.id,
        d.dispatch_number,
        d.dispatch_status,
        d.dispatch_date,
        d.sales_order_id,
        d.customer_id,
        d.created_by as dispatch_created_by,
        c.customer_name,
        so.so_number,
        (
          select ci.id
          from customer_invoices ci
          where ci.sales_order_id = d.sales_order_id
            and ci.invoice_status <> 'cancelled'
          order by ci.invoice_date desc nulls last, ci.id desc
          limit 1
        ) as customer_invoice_id
      from dispatches d
      join customers c on c.id = d.customer_id
      join sales_orders so on so.id = d.sales_order_id
      where d.id = $1
      limit 1
    `,
    [dispatchId]
  );
  return r.rows[0] || null;
}

async function getDispatchSeedLines(client, dispatchId) {
  const r = await client.query(
    `
      select
        dl.id as dispatch_line_id,
        dl.sales_order_line_id,
        dl.line_no,
        dl.item_code,
        dl.item_name,
        dl.line_description,
        dl.uom,
        dl.qty_dispatch as qty_eligible,
        sol.product_id,
        coalesce(p.serial_no_required, false) as serial_no_required
      from dispatch_lines dl
      left join sales_order_lines sol on sol.id = dl.sales_order_line_id
      left join products p on p.id = sol.product_id
      where dl.dispatch_id = $1
      order by dl.line_no asc, dl.id asc
    `,
    [dispatchId]
  );
  return r.rows;
}

async function getServiceCaseHeaderOrNull(client, id) {
  const r = await client.query(
    `
      select
        swc.*,
        c.customer_name,
        so.so_number,
        d.dispatch_number,
        ci.invoice_number,
        u.full_name as created_by_name,
        coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0) as total_eligible_qty,
        coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'field_return'), 0) as total_field_returned,
        coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'replacement_issue'), 0) as total_replaced
      from service_warranty_cases swc
      join customers c on c.id = swc.customer_id
      left join sales_orders so on so.id = swc.sales_order_id
      join dispatches d on d.id = swc.dispatch_id
      left join customer_invoices ci on ci.id = swc.customer_invoice_id
      left join erp_users u on u.id = swc.created_by
      where swc.id = $1
      limit 1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function getServiceCaseLines(client, id) {
  const r = await client.query(
    `
      select
        swcl.*,
        coalesce(sum(case when swm.movement_type = 'field_return' then swm.qty else 0 end), 0) as qty_field_returned,
        coalesce(sum(case when swm.movement_type = 'replacement_issue' then swm.qty else 0 end), 0) as qty_replaced,
        greatest(swcl.qty_eligible - coalesce(sum(case when swm.movement_type = 'field_return' then swm.qty else 0 end), 0), 0) as qty_pending_field_return,
        greatest(swcl.qty_eligible - coalesce(sum(case when swm.movement_type = 'replacement_issue' then swm.qty else 0 end), 0), 0) as qty_pending_replacement,
        greatest(
          greatest(swcl.qty_eligible - coalesce(sum(case when swm.movement_type = 'field_return' then swm.qty else 0 end), 0), 0),
          greatest(swcl.qty_eligible - coalesce(sum(case when swm.movement_type = 'replacement_issue' then swm.qty else 0 end), 0), 0)
        ) as qty_pending_support
      from service_warranty_case_lines swcl
      left join service_warranty_movements swm on swm.service_warranty_case_line_id = swcl.id
      where swcl.service_warranty_case_id = $1
      group by swcl.id
      order by swcl.line_no asc
    `,
    [id]
  );
  return r.rows;
}

async function getServiceCaseMovements(client, id) {
  const r = await client.query(
    `
      select
        swm.*,
        swcl.line_no,
        swcl.item_code,
        swcl.item_name,
        swcl.line_description,
        swcl.serial_no_required,
        u.full_name as created_by_name,
        coalesce(array_remove(array_agg(swms.serial_no order by swms.serial_no), null), '{}') as serials
      from service_warranty_movements swm
      join service_warranty_case_lines swcl on swcl.id = swm.service_warranty_case_line_id
      left join service_warranty_movement_serials swms on swms.service_warranty_movement_id = swm.id
      left join erp_users u on u.id = swm.created_by
      where swm.service_warranty_case_id = $1
      group by swm.id, swcl.line_no, swcl.item_code, swcl.item_name, swcl.line_description, swcl.serial_no_required, u.full_name
      order by swm.movement_date desc, swm.id desc
    `,
    [id]
  );
  return r.rows.map((row) => ({
    ...row,
    serials: Array.isArray(row.serials) ? row.serials.filter(Boolean) : [],
  }));
}

async function getServiceCaseNcrCases(client, serviceCaseId) {
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
        swcl.line_no,
        swcl.item_code,
        swcl.item_name,
        swcl.line_description,
        owner_user.full_name as containment_owner_name,
        created_user.full_name as created_by_name,
        verified_user.full_name as verified_by_name,
        move.movement_type as source_movement_type,
        move.movement_date as source_movement_date,
        coalesce(ast.total_action_count, 0) as total_action_count,
        coalesce(ast.open_action_count, 0) as open_action_count,
        coalesce(ast.overdue_action_count, 0) as overdue_action_count
      from quality_ncr_cases n
      left join service_warranty_case_lines swcl on swcl.id = n.service_warranty_case_line_id
      left join service_warranty_movements move on move.id = n.service_warranty_movement_id
      left join erp_users owner_user on owner_user.id = n.containment_owner_id
      left join erp_users created_user on created_user.id = n.created_by
      left join erp_users verified_user on verified_user.id = n.verified_by
      left join action_stats ast on ast.ncr_case_id = n.id
      where n.service_warranty_case_id = $1
      order by n.created_at desc, n.id desc
    `,
    [Number(serviceCaseId)]
  );
  return r.rows;
}

async function getServiceCaseCapaActions(client, serviceCaseId) {
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
      where n.service_warranty_case_id = $1
      order by coalesce(a.due_date, current_date) asc, a.id asc
    `,
    [Number(serviceCaseId)]
  );
  return r.rows;
}

function getServiceFailureBucket(row) {
  const status = String(row.status || "").toLowerCase();
  if (["closed", "cancelled"].includes(status)) return "other";
  if (!normalizeDate(row.containment_completed_date) && normalizeDate(row.containment_due_date) && row.containment_due_date < new Date().toISOString().slice(0, 10)) {
    return "containment_due";
  }
  if (normalizeDate(row.containment_completed_date) && !normalizeText(row.root_cause)) return "root_cause_due";
  if (Number(row.overdue_action_count || 0) > 0) return "action_overdue";
  if (Number(row.open_action_count || 0) <= 0 && Number(row.total_action_count || 0) > 0 && !normalizeDate(row.verification_date)) {
    return "verification_due";
  }
  if (!normalizeDate(row.containment_completed_date)) return "new_ncr";
  return "all";
}

function matchesServiceFailureBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getServiceFailureBucket(row) !== "other";
  return getServiceFailureBucket(row) === key;
}

function getServiceFailureRank(row) {
  const bucket = getServiceFailureBucket(row);
  if (bucket === "containment_due") return 0;
  if (bucket === "action_overdue") return 1;
  if (bucket === "verification_due") return 2;
  if (bucket === "root_cause_due") return 3;
  if (bucket === "new_ncr") return 4;
  return 5;
}

async function queryServiceFailureRows(client, req, { q = "", limit = 600 } = {}) {
  const params = [];
  const activeCompanyId = getActiveCompanyId(req);
  if (!activeCompanyId) return [];
  params.push(activeCompanyId);
  let where = `where n.company_id = $${params.length} and n.source_type = 'service_warranty'`;
  if (ownRecordsOnly(req, "service_warranty")) {
    params.push(req.user.id);
    where += ` and swc.created_by = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` and (
      n.ncr_number ilike $${params.length}
      or swc.case_number ilike $${params.length}
      or c.customer_name ilike $${params.length}
      or d.dispatch_number ilike $${params.length}
      or coalesce(swcl.item_code, '') ilike $${params.length}
      or coalesce(swcl.item_name, '') ilike $${params.length}
      or coalesce(n.defect_summary, '') ilike $${params.length}
    )`;
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);
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
        n.id,
        n.ncr_number,
        n.status,
        n.severity,
        n.category,
        n.qty_affected,
        n.defect_summary,
        n.containment_due_date,
        n.containment_completed_date,
        n.root_cause,
        n.verification_date,
        swc.id as service_warranty_case_id,
        swc.case_number,
        swc.case_status,
        swc.issue_type,
        c.customer_name,
        d.dispatch_number,
        swcl.line_no,
        swcl.item_code,
        swcl.item_name,
        coalesce(ast.total_action_count, 0) as total_action_count,
        coalesce(ast.open_action_count, 0) as open_action_count,
        coalesce(ast.overdue_action_count, 0) as overdue_action_count
      from quality_ncr_cases n
      join service_warranty_cases swc on swc.id = n.service_warranty_case_id
      join customers c on c.id = swc.customer_id
      join dispatches d on d.id = swc.dispatch_id
      left join service_warranty_case_lines swcl on swcl.id = n.service_warranty_case_line_id
      left join action_stats ast on ast.ncr_case_id = n.id
      ${where}
      order by n.created_at desc, n.id desc
      limit ${safeLimit}
    `,
    params
  );
  return r.rows;
}

async function getServiceFailureSummary(client, req, { q = "" } = {}) {
  const rows = await queryServiceFailureRows(client, req, { q, limit: 800 });
  return {
    ncrCount: rows.length,
    newNcr: rows.filter((row) => getServiceFailureBucket(row) === "new_ncr").length,
    containmentDue: rows.filter((row) => getServiceFailureBucket(row) === "containment_due").length,
    rootCauseDue: rows.filter((row) => getServiceFailureBucket(row) === "root_cause_due").length,
    actionOverdue: rows.filter((row) => getServiceFailureBucket(row) === "action_overdue").length,
    verificationDue: rows.filter((row) => getServiceFailureBucket(row) === "verification_due").length,
  };
}

async function getServiceFailureQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryServiceFailureRows(client, req, { q, limit: 800 });
  return rows
    .filter((row) => matchesServiceFailureBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getServiceFailureRank(a) - getServiceFailureRank(b);
      if (rankDiff !== 0) return rankDiff;
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const sevDiff = (sevOrder[String(a.severity || "medium").toLowerCase()] ?? 9) - (sevOrder[String(b.severity || "medium").toLowerCase()] ?? 9);
      if (sevDiff !== 0) return sevDiff;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

router.get("/bootstrap", requireScreenAction("service_warranty", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    const where = [`d.dispatch_status in ('dispatched', 'delivered')`];
    if (ownRecordsOnly(req, "service_warranty")) {
      params.push(Number(req.user.id));
      where.push(`d.created_by = $${params.length}`);
    }

    const r = await pool.query(
      `
        select
          d.id,
          d.dispatch_number,
          d.dispatch_date,
          c.customer_name,
          so.so_number
        from dispatches d
        join customers c on c.id = d.customer_id
        join sales_orders so on so.id = d.sales_order_id
        where ${where.join(" and ")}
        order by d.dispatch_date desc, d.id desc
        limit 200
      `,
      params
    );
    return res.json({ ok: true, dispatches: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("service_warranty", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    let where = "";
    if (ownRecordsOnly(req, "service_warranty")) {
      params.push(Number(req.user.id));
      where = `where swc.created_by = $${params.length}`;
    }

    const r = await pool.query(
      `
        select
          swc.id,
          swc.case_number,
          swc.case_status,
          swc.case_date,
          swc.issue_type,
          c.customer_name,
          so.so_number,
          d.dispatch_number,
          coalesce((select sum(qty_eligible) from service_warranty_case_lines where service_warranty_case_id = swc.id), 0) as total_eligible_qty,
          coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'field_return'), 0) as total_field_returned,
          coalesce((select sum(qty) from service_warranty_movements where service_warranty_case_id = swc.id and movement_type = 'replacement_issue'), 0) as total_replaced
        from service_warranty_cases swc
        join customers c on c.id = swc.customer_id
        left join sales_orders so on so.id = swc.sales_order_id
        join dispatches d on d.id = swc.dispatch_id
        ${where}
        order by swc.created_at desc, swc.id desc
      `,
      params
    );
    return res.json({ ok: true, service_cases: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/failure-summary", requireScreenAction("service_warranty", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getServiceFailureSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/failure-queue", requireScreenAction("service_warranty", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getServiceFailureQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/from-dispatch/:id", requireScreenAction("service_warranty", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const dispatchId = Number(req.params.id);
    if (!Number.isFinite(dispatchId) || dispatchId <= 0) return res.status(400).json({ ok: false, error: "INVALID_DISPATCH" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const issueType = typeof body.issue_type === "string" ? body.issue_type.trim().toLowerCase() : "warranty";
    if (!["warranty", "service", "field_return"].includes(issueType)) {
      return res.status(400).json({ ok: false, error: "INVALID_ISSUE_TYPE" });
    }

    await client.query("begin");
    const header = await getDispatchSeedHeader(client, dispatchId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "DISPATCH_NOT_FOUND" });
    }
    if (String(header.dispatch_status || "").toLowerCase() === "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "DISPATCH_NOT_ELIGIBLE" });
    }
    if (ownRecordsOnly(req, "service_warranty") && Number(header.dispatch_created_by) !== Number(req.user.id) && req.user.group_name !== "SuperAdmin") {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const lines = await getDispatchSeedLines(client, dispatchId);
    const eligibleLines = lines.filter((row) => Number(row.product_id) > 0 && qty(row.qty_eligible) > 0);
    if (!eligibleLines.length) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NO_ELIGIBLE_LINES" });
    }

    const numRes = await client.query(`select next_document_number('SWC') as case_number`);
    const caseNumber = numRes.rows[0]?.case_number;
    const insertCase = await client.query(
      `
        insert into service_warranty_cases (
          case_number,
          case_status,
          case_date,
          customer_id,
          sales_order_id,
          dispatch_id,
          customer_invoice_id,
          issue_type,
          reported_by,
          remarks,
          created_by
        )
        values ($1,'open',coalesce($2, current_date),$3,$4,$5,$6,$7,$8,$9,$10)
        returning id
      `,
      [
        caseNumber,
        body.case_date || null,
        header.customer_id,
        header.sales_order_id || null,
        dispatchId,
        header.customer_invoice_id || null,
        issueType,
        normalizeText(body.reported_by),
        normalizeText(body.remarks),
        req.user.id,
      ]
    );
    const caseId = insertCase.rows[0]?.id;

    for (const row of eligibleLines) {
      await client.query(
        `
          insert into service_warranty_case_lines (
            service_warranty_case_id,
            dispatch_line_id,
            sales_order_line_id,
            line_no,
            product_id,
            item_code,
            item_name,
            line_description,
            uom,
            serial_no_required,
            qty_eligible,
            remarks
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `,
        [
          caseId,
          row.dispatch_line_id,
          row.sales_order_line_id || null,
          row.line_no,
          row.product_id,
          row.item_code || null,
          row.item_name || null,
          row.line_description || null,
          row.uom || null,
          row.serial_no_required === true,
          money(row.qty_eligible),
          null,
        ]
      );
    }

    await client.query("commit");
    const nextHeader = await getServiceCaseHeaderOrNull(client, caseId);
    const nextLines = await getServiceCaseLines(client, caseId);
    const movements = await getServiceCaseMovements(client, caseId);
    const ncrCases = await getServiceCaseNcrCases(client, caseId);
    const capaActions = await getServiceCaseCapaActions(client, caseId);
    return res.status(201).json({ ok: true, service_case: nextHeader, lines: nextLines, movements, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("service_warranty", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const header = await getServiceCaseHeaderOrNull(pool, id);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessServiceCase(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const lines = await getServiceCaseLines(pool, id);
    const movements = await getServiceCaseMovements(pool, id);
    const ncrCases = await getServiceCaseNcrCases(pool, id);
    const capaActions = await getServiceCaseCapaActions(pool, id);
    return res.json({ ok: true, service_case: header, lines, movements, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("service_warranty", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const caseStatus = typeof body.case_status === "string" ? body.case_status.trim().toLowerCase() : "open";
    const issueType = typeof body.issue_type === "string" ? body.issue_type.trim().toLowerCase() : "warranty";
    if (!["open", "closed", "cancelled"].includes(caseStatus)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    if (!["warranty", "service", "field_return"].includes(issueType)) return res.status(400).json({ ok: false, error: "INVALID_ISSUE_TYPE" });

    await client.query("begin");
    const header = await getServiceCaseHeaderOrNull(client, id);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessServiceCase(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    await client.query(
      `
        update service_warranty_cases
        set case_status = $2,
            case_date = coalesce($3, case_date),
            issue_type = $4,
            reported_by = $5,
            remarks = $6,
            updated_at = now()
        where id = $1
      `,
      [id, caseStatus, body.case_date || null, issueType, normalizeText(body.reported_by), normalizeText(body.remarks)]
    );

    const companyRes = await client.query(`select company_id from service_warranty_cases where id = $1 limit 1`, [id]);
    const companyId = Number(companyRes.rows[0]?.company_id) || null;
    await syncStockForServiceWarrantyCase(client, companyId, id);

    await client.query("commit");
    const nextHeader = await getServiceCaseHeaderOrNull(client, id);
    const lines = await getServiceCaseLines(client, id);
    const movements = await getServiceCaseMovements(client, id);
    const ncrCases = await getServiceCaseNcrCases(client, id);
    const capaActions = await getServiceCaseCapaActions(client, id);
    return res.json({ ok: true, service_case: nextHeader, lines, movements, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/movements", requireScreenAction("service_warranty", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const lineId = Number(body.service_warranty_case_line_id || body.line_id);
    const movementType = typeof body.movement_type === "string" ? body.movement_type.trim().toLowerCase() : "";
    const movementQty = money(body.qty);
    if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ ok: false, error: "INVALID_LINE_ID" });
    if (!["field_return", "replacement_issue"].includes(movementType)) return res.status(400).json({ ok: false, error: "INVALID_MOVEMENT_TYPE" });
    if (movementQty <= 0) return res.status(400).json({ ok: false, error: "INVALID_QTY" });

    await client.query("begin");
    const header = await getServiceCaseHeaderOrNull(client, id);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessServiceCase(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(header.case_status || "").toLowerCase() !== "open") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "CASE_NOT_OPEN" });
    }

    const lines = await getServiceCaseLines(client, id);
    const line = lines.find((row) => Number(row.id) === lineId);
    if (!line) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "LINE_NOT_FOUND" });
    }

    const qtyAlready = movementType === "field_return" ? money(line.qty_field_returned) : money(line.qty_replaced);
    const qtyEligible = money(line.qty_eligible);
    if (money(qtyAlready + movementQty) > qtyEligible) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "QTY_EXCEEDS_ELIGIBLE" });
    }

    const rawSerials = Array.isArray(body.serials) ? body.serials : [];
    const serials = rawSerials.map((item) => String(item || "").trim()).filter(Boolean);
    if (new Set(serials).size !== serials.length) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DUPLICATE_SERIALS" });
    }

    if (line.serial_no_required === true) {
      if (!isIntLike(movementQty)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "SERIAL_QTY_NOT_INTEGER" });
      }
      if (serials.length !== Number(movementQty)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "SERIAL_COUNT_MISMATCH" });
      }
    }

    const insertMove = await client.query(
      `
        insert into service_warranty_movements (
          service_warranty_case_id,
          service_warranty_case_line_id,
          movement_type,
          movement_date,
          qty,
          reference_no,
          remarks,
          created_by
        )
        values ($1,$2,$3,coalesce($4, current_date),$5,$6,$7,$8)
        returning id
      `,
      [id, lineId, movementType, body.movement_date || null, movementQty, normalizeText(body.reference_no), normalizeText(body.remarks), req.user.id]
    );
    const movementId = insertMove.rows[0]?.id;

    for (const serialNo of serials) {
      await client.query(
        `
          insert into service_warranty_movement_serials (
            service_warranty_movement_id,
            serial_no
          )
          values ($1,$2)
        `,
        [movementId, serialNo]
      );
    }

    const companyRes = await client.query(`select company_id from service_warranty_cases where id = $1 limit 1`, [id]);
    const companyId = Number(companyRes.rows[0]?.company_id) || null;
    await syncStockForServiceWarrantyCase(client, companyId, id);

    await client.query("commit");
    const nextHeader = await getServiceCaseHeaderOrNull(client, id);
    const nextLines = await getServiceCaseLines(client, id);
    const movements = await getServiceCaseMovements(client, id);
    const ncrCases = await getServiceCaseNcrCases(client, id);
    const capaActions = await getServiceCaseCapaActions(client, id);
    return res.status(201).json({ ok: true, service_case: nextHeader, lines: nextLines, movements, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "23505") {
      return res.status(409).json({ ok: false, error: "DUPLICATE_SERIALS" });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/ncr-cases", requireScreenAction("service_warranty", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const serviceCaseId = Number(req.params.id);
    if (!Number.isFinite(serviceCaseId) || serviceCaseId <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    await client.query("begin");
    const header = await getServiceCaseHeaderOrNull(client, serviceCaseId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessServiceCase(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const defectSummary = normalizeText(body.defect_summary);
    if (!defectSummary) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DEFECT_SUMMARY_REQUIRED" });
    }
    const lineId = normalizeId(body.service_warranty_case_line_id || body.line_id);
    const movementId = normalizeId(body.service_warranty_movement_id || body.movement_id);
    if (lineId) {
      const lineRes = await client.query(`select id from service_warranty_case_lines where id = $1 and service_warranty_case_id = $2 limit 1`, [lineId, serviceCaseId]);
      if (!lineRes.rows[0]?.id) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "LINE_NOT_FOUND" });
      }
    }
    if (movementId) {
      const moveRes = await client.query(`select id from service_warranty_movements where id = $1 and service_warranty_case_id = $2 limit 1`, [movementId, serviceCaseId]);
      if (!moveRes.rows[0]?.id) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "MOVEMENT_NOT_FOUND" });
      }
    }
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const status = deriveNcrStatus(body, actions);
    const numRes = await client.query(`select next_company_document_number($1,'NCR') as ncr_number`, [header.company_id]);
    const ncrNumber = numRes.rows[0]?.ncr_number;
    const insertRes = await client.query(
      `
        insert into quality_ncr_cases (
          company_id,
          ncr_number,
          quality_control_id,
          quality_control_line_id,
          service_warranty_case_id,
          service_warranty_case_line_id,
          service_warranty_movement_id,
          source_type,
          severity,
          category,
          qty_affected,
          defect_summary,
          containment_action,
          containment_due_date,
          containment_completed_date,
          root_cause,
          corrective_plan,
          preventive_plan,
          verification_method,
          verification_date,
          status,
          remarks,
          created_by
        )
        values ($1,$2,null,null,$3,$4,$5,'service_warranty',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        returning id
      `,
      [
        header.company_id,
        ncrNumber,
        serviceCaseId,
        lineId,
        movementId,
        normalizeSeverity(body.severity),
        normalizeNcrCategory(body.category),
        money(body.qty_affected),
        defectSummary,
        normalizeText(body.containment_action),
        normalizeDate(body.containment_due_date),
        normalizeDate(body.containment_completed_date),
        normalizeText(body.root_cause),
        normalizeText(body.corrective_plan),
        normalizeText(body.preventive_plan),
        normalizeText(body.verification_method),
        normalizeDate(body.verification_date),
        status,
        normalizeText(body.remarks),
        req.user.id,
      ]
    );
    const ncrCaseId = Number(insertRes.rows[0]?.id);
    for (const raw of actions) {
      const title = normalizeText(raw.action_title);
      const actionType = typeof raw.action_type === "string" ? raw.action_type.trim().toLowerCase() : "";
      const actionStatus = normalizeActionStatus(raw.action_status) || "open";
      if (!title || !["correction", "corrective", "preventive"].includes(actionType)) continue;
      await client.query(
        `
          insert into quality_capa_actions (
            ncr_case_id,
            action_type,
            action_title,
            owner_user_id,
            due_date,
            completed_date,
            action_status,
            completion_note,
            created_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          ncrCaseId,
          actionType,
          title,
          normalizeId(raw.owner_user_id),
          normalizeDate(raw.due_date),
          normalizeDate(raw.completed_date),
          actionStatus,
          normalizeText(raw.completion_note),
          req.user.id,
        ]
      );
    }
    await client.query(`update service_warranty_cases set updated_at = now() where id = $1`, [serviceCaseId]);
    await client.query("commit");
    const nextHeader = await getServiceCaseHeaderOrNull(client, serviceCaseId);
    const nextLines = await getServiceCaseLines(client, serviceCaseId);
    const movements = await getServiceCaseMovements(client, serviceCaseId);
    const ncrCases = await getServiceCaseNcrCases(client, serviceCaseId);
    const capaActions = await getServiceCaseCapaActions(client, serviceCaseId);
    return res.status(201).json({ ok: true, service_case: nextHeader, lines: nextLines, movements, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/ncr-cases/:ncrId", requireScreenAction("service_warranty", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const ncrId = Number(req.params.ncrId);
    if (!Number.isFinite(ncrId) || ncrId <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    await client.query("begin");
    const ncrRes = await client.query(
      `select * from quality_ncr_cases where id = $1 and source_type = 'service_warranty' limit 1`,
      [ncrId]
    );
    const ncr = ncrRes.rows[0] || null;
    if (!ncr) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    const header = await getServiceCaseHeaderOrNull(client, ncr.service_warranty_case_id);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessServiceCase(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    const defectSummary = normalizeText(body.defect_summary) || ncr.defect_summary;
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const derivedStatus = deriveNcrStatus({ ...ncr, ...body, defect_summary: defectSummary }, actions.length ? actions : [{ action_status: "done" }]);
    await client.query(
      `
        update quality_ncr_cases
        set severity = $2,
            category = $3,
            qty_affected = $4,
            defect_summary = $5,
            containment_action = $6,
            containment_due_date = $7,
            containment_completed_date = $8,
            root_cause = $9,
            corrective_plan = $10,
            preventive_plan = $11,
            verification_method = $12,
            verification_date = $13,
            status = $14,
            remarks = $15,
            updated_at = now()
        where id = $1
      `,
      [
        ncrId,
        normalizeSeverity(body.severity || ncr.severity),
        normalizeNcrCategory(body.category || ncr.category),
        money(body.qty_affected ?? ncr.qty_affected),
        defectSummary,
        normalizeText(body.containment_action) ?? ncr.containment_action,
        normalizeDate(body.containment_due_date) ?? ncr.containment_due_date,
        normalizeDate(body.containment_completed_date) ?? ncr.containment_completed_date,
        normalizeText(body.root_cause) ?? ncr.root_cause,
        normalizeText(body.corrective_plan) ?? ncr.corrective_plan,
        normalizeText(body.preventive_plan) ?? ncr.preventive_plan,
        normalizeText(body.verification_method) ?? ncr.verification_method,
        normalizeDate(body.verification_date) ?? ncr.verification_date,
        derivedStatus,
        normalizeText(body.remarks) ?? ncr.remarks,
      ]
    );
    const existingActionsRes = await client.query(`select id from quality_capa_actions where ncr_case_id = $1`, [ncrId]);
    const existingActionIds = new Set(existingActionsRes.rows.map((row) => Number(row.id)));
    const seenIds = new Set();
    for (const raw of actions) {
      const actionId = normalizeId(raw.id);
      const title = normalizeText(raw.action_title);
      const actionType = typeof raw.action_type === "string" ? raw.action_type.trim().toLowerCase() : "";
      const actionStatus = normalizeActionStatus(raw.action_status) || "open";
      if (!title || !["correction", "corrective", "preventive"].includes(actionType)) continue;
      if (actionId && existingActionIds.has(actionId)) {
        seenIds.add(actionId);
        await client.query(
          `
            update quality_capa_actions
            set action_type = $2,
                action_title = $3,
                owner_user_id = $4,
                due_date = $5,
                completed_date = $6,
                action_status = $7,
                completion_note = $8,
                updated_at = now()
            where id = $1 and ncr_case_id = $9
          `,
          [
            actionId,
            actionType,
            title,
            normalizeId(raw.owner_user_id),
            normalizeDate(raw.due_date),
            normalizeDate(raw.completed_date),
            actionStatus,
            normalizeText(raw.completion_note),
            ncrId,
          ]
        );
      } else {
        await client.query(
          `
            insert into quality_capa_actions (
              ncr_case_id,
              action_type,
              action_title,
              owner_user_id,
              due_date,
              completed_date,
              action_status,
              completion_note,
              created_by
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `,
          [
            ncrId,
            actionType,
            title,
            normalizeId(raw.owner_user_id),
            normalizeDate(raw.due_date),
            normalizeDate(raw.completed_date),
            actionStatus,
            normalizeText(raw.completion_note),
            req.user.id,
          ]
        );
      }
    }
    for (const row of existingActionsRes.rows) {
      const actionId = Number(row.id);
      if (seenIds.has(actionId)) continue;
      const retained = actions.some((raw) => normalizeId(raw.id) === actionId);
      if (!retained) {
        await client.query(`delete from quality_capa_actions where id = $1 and ncr_case_id = $2`, [actionId, ncrId]);
      }
    }
    await client.query(`update service_warranty_cases set updated_at = now() where id = $1`, [ncr.service_warranty_case_id]);
    await client.query("commit");
    const nextHeader = await getServiceCaseHeaderOrNull(client, ncr.service_warranty_case_id);
    const nextLines = await getServiceCaseLines(client, ncr.service_warranty_case_id);
    const movements = await getServiceCaseMovements(client, ncr.service_warranty_case_id);
    const ncrCases = await getServiceCaseNcrCases(client, ncr.service_warranty_case_id);
    const capaActions = await getServiceCaseCapaActions(client, ncr.service_warranty_case_id);
    return res.json({ ok: true, service_case: nextHeader, lines: nextLines, movements, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
