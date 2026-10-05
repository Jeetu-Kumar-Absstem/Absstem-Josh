const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(4));
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function normalizeDate(value) {
  return normalizeText(value);
}

function normalizeLimit(value, fallback = 80, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function normalizeId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
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

const HOLD_ACTION_TO_COLUMN = {
  supplier_replacement: "qty_replaced",
  rework: "qty_reworked",
  final_acceptance: "qty_accepted_after_hold",
};

function canAccessQualityControl(req, header) {
  if (!header) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "quality_control")) return true;
  return Number(header.created_by) === Number(req.user.id);
}

async function getQualityControlHeaderOrNull(client, id, companyId) {
  const r = await client.query(
    `
      select
        qc.*,
        gr.grn_number,
        gr.receipt_date,
        gr.receipt_status,
        gr.vendor_id,
        v.company_name as vendor_name,
        pr.return_number as rtv_return_number,
        cu.full_name as created_by_name
      from quality_controls qc
      join goods_receipts gr on gr.id = qc.goods_receipt_id
      join vendors v on v.id = gr.vendor_id
      left join purchase_returns pr on pr.id = qc.rtv_purchase_return_id
      left join erp_users cu on cu.id = qc.created_by
      where qc.id = $1 and qc.company_id = $2
      limit 1
    `,
    [id, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getQualityControlLines(client, id) {
  const r = await client.query(
    `
      select
        qcl.*,
        greatest(qcl.qty_rejected - qcl.qty_rtv_created, 0) as qty_pending_rtv,
        greatest(qcl.qty_on_hold - qcl.qty_replaced - qcl.qty_reworked - qcl.qty_accepted_after_hold, 0) as qty_pending_hold_resolution,
        (qcl.qty_accepted + qcl.qty_replaced + qcl.qty_reworked + qcl.qty_accepted_after_hold) as qty_effective_accepted
      from quality_control_lines qcl
      where qcl.quality_control_id = $1
      order by qcl.line_no asc
    `,
    [id]
  );
  return r.rows;
}

async function getQualityHoldActions(client, id) {
  const r = await client.query(
    `
      select
        qha.*,
        qcl.line_no,
        qcl.item_code,
        qcl.item_name,
        qcl.line_description,
        u.full_name as created_by_name,
        sc.id as supplier_claim_id,
        sc.claim_number as supplier_claim_number,
        sc.claim_status as supplier_claim_status
      from quality_hold_actions qha
      join quality_control_lines qcl on qcl.id = qha.quality_control_line_id
      left join erp_users u on u.id = qha.created_by
      left join supplier_claim_lines scl on scl.quality_hold_action_id = qha.id
      left join supplier_claims sc on sc.id = scl.supplier_claim_id
      where qha.quality_control_id = $1
      order by qha.action_date desc, qha.id desc
    `,
    [id]
  );
  return r.rows;
}

async function getQualityNcrCases(client, qualityControlId) {
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
        qcl.line_no,
        qcl.item_code,
        qcl.item_name,
        qcl.line_description,
        owner_user.full_name as containment_owner_name,
        created_user.full_name as created_by_name,
        verified_user.full_name as verified_by_name,
        coalesce(ast.total_action_count, 0) as total_action_count,
        coalesce(ast.open_action_count, 0) as open_action_count,
        coalesce(ast.overdue_action_count, 0) as overdue_action_count
      from quality_ncr_cases n
      left join quality_control_lines qcl on qcl.id = n.quality_control_line_id
      left join erp_users owner_user on owner_user.id = n.containment_owner_id
      left join erp_users created_user on created_user.id = n.created_by
      left join erp_users verified_user on verified_user.id = n.verified_by
      left join action_stats ast on ast.ncr_case_id = n.id
      where n.quality_control_id = $1
      order by n.created_at desc, n.id desc
    `,
    [Number(qualityControlId)]
  );
  return r.rows;
}

async function getQualityCapaActions(client, qualityControlId) {
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
      where n.quality_control_id = $1
      order by coalesce(a.due_date, current_date) asc, a.id asc
    `,
    [Number(qualityControlId)]
  );
  return r.rows;
}

function getQualityCapaBucket(row) {
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

function matchesQualityCapaBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getQualityCapaBucket(row) !== "other";
  return getQualityCapaBucket(row) === key;
}

function getQualityCapaRank(row) {
  const bucket = getQualityCapaBucket(row);
  if (bucket === "containment_due") return 0;
  if (bucket === "action_overdue") return 1;
  if (bucket === "verification_due") return 2;
  if (bucket === "root_cause_due") return 3;
  if (bucket === "new_ncr") return 4;
  return 5;
}

async function queryQualityCapaRows(client, req, { q = "", limit = 600 } = {}) {
  const params = [];
  const activeCompanyId = getActiveCompanyId(req);
  if (!activeCompanyId) return [];
  params.push(activeCompanyId);
  let where = `where n.company_id = $${params.length}`;
  if (ownRecordsOnly(req, "quality_control")) {
    params.push(req.user.id);
    where += ` and qc.created_by = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` and (
      n.ncr_number ilike $${params.length}
      or qc.qc_number ilike $${params.length}
      or gr.grn_number ilike $${params.length}
      or v.company_name ilike $${params.length}
      or coalesce(qcl.item_code, '') ilike $${params.length}
      or coalesce(qcl.item_name, '') ilike $${params.length}
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
        qc.id as quality_control_id,
        qc.qc_number,
        gr.grn_number,
        v.company_name as vendor_name,
        qcl.line_no,
        qcl.item_code,
        qcl.item_name,
        coalesce(ast.total_action_count, 0) as total_action_count,
        coalesce(ast.open_action_count, 0) as open_action_count,
        coalesce(ast.overdue_action_count, 0) as overdue_action_count
      from quality_ncr_cases n
      join quality_controls qc on qc.id = n.quality_control_id
      join goods_receipts gr on gr.id = qc.goods_receipt_id
      join vendors v on v.id = gr.vendor_id
      left join quality_control_lines qcl on qcl.id = n.quality_control_line_id
      left join action_stats ast on ast.ncr_case_id = n.id
      ${where}
      order by n.created_at desc, n.id desc
      limit ${safeLimit}
    `,
    params
  );
  return r.rows;
}

async function getQualityCapaSummary(client, req, { q = "" } = {}) {
  const rows = await queryQualityCapaRows(client, req, { q, limit: 800 });
  return {
    ncrCount: rows.length,
    newNcr: rows.filter((row) => getQualityCapaBucket(row) === "new_ncr").length,
    containmentDue: rows.filter((row) => getQualityCapaBucket(row) === "containment_due").length,
    rootCauseDue: rows.filter((row) => getQualityCapaBucket(row) === "root_cause_due").length,
    actionOverdue: rows.filter((row) => getQualityCapaBucket(row) === "action_overdue").length,
    verificationDue: rows.filter((row) => getQualityCapaBucket(row) === "verification_due").length,
  };
}

async function getQualityCapaQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryQualityCapaRows(client, req, { q, limit: 800 });
  return rows
    .filter((row) => matchesQualityCapaBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getQualityCapaRank(a) - getQualityCapaRank(b);
      if (rankDiff !== 0) return rankDiff;
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const sevDiff = (sevOrder[String(a.severity || "medium").toLowerCase()] ?? 9) - (sevOrder[String(b.severity || "medium").toLowerCase()] ?? 9);
      if (sevDiff !== 0) return sevDiff;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

async function getPostedGrnsWithoutQc(client, companyId) {
  const r = await client.query(
    `
      select
        gr.id,
        gr.grn_number,
        gr.receipt_date,
        v.company_name as vendor_name
      from goods_receipts gr
      join vendors v on v.id = gr.vendor_id
      left join quality_controls qc on qc.goods_receipt_id = gr.id
      where gr.receipt_status = 'posted'
        and gr.company_id = $1
        and qc.id is null
      order by gr.receipt_date desc, gr.id desc
    `
    ,
    [Number(companyId)]
  );
  return r.rows;
}

function getQualityReworkBucket(row) {
  if (qty(row.replacement_pending_qty) > 0) return "replacement_pending";
  if (qty(row.qty_rejected_pending_rtv) > 0) return "rtv_pending";
  if (qty(row.rework_action_qty) > 0 && qty(row.qty_pending_hold_resolution) > 0) return "rework_pending";
  if (qty(row.final_acceptance_action_qty) > 0 && qty(row.qty_pending_hold_resolution) > 0) return "final_acceptance_pending";
  if (qty(row.qty_pending_hold_resolution) > 0 && Number(row.hold_action_count || 0) <= 0) return "awaiting_disposition";
  return "other";
}

function matchesQualityReworkBucket(row, bucket = "all") {
  const key = String(bucket || "all").trim().toLowerCase();
  if (!key || key === "all") return getQualityReworkBucket(row) !== "other";
  return getQualityReworkBucket(row) === key;
}

function getQualityReworkRank(row) {
  const bucket = getQualityReworkBucket(row);
  if (bucket === "replacement_pending") return 0;
  if (bucket === "rtv_pending") return 1;
  if (bucket === "rework_pending") return 2;
  if (bucket === "final_acceptance_pending") return 3;
  if (bucket === "awaiting_disposition") return 4;
  return 5;
}

async function queryQualityReworkRows(client, req, { q = "", limit = 600 } = {}) {
  const params = [];
  const activeCompanyId = getActiveCompanyId(req);
  if (!activeCompanyId) return [];
  params.push(activeCompanyId);
  let where = `where qc.company_id = $${params.length}`;
  if (ownRecordsOnly(req, "quality_control")) {
    params.push(req.user.id);
    where += ` and qc.created_by = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` and (qc.qc_number ilike $${params.length} or gr.grn_number ilike $${params.length} or v.company_name ilike $${params.length})`;
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 600, 1), 1000);
  const r = await client.query(
    `
      with action_totals as (
        select
          qha.quality_control_id,
          count(*)::int as hold_action_count,
          coalesce(sum(case when qha.action_type = 'rework' then qha.qty else 0 end), 0) as rework_action_qty,
          coalesce(sum(case when qha.action_type = 'supplier_replacement' then qha.qty else 0 end), 0) as replacement_action_qty,
          coalesce(sum(case when qha.action_type = 'final_acceptance' then qha.qty else 0 end), 0) as final_acceptance_action_qty
        from quality_hold_actions qha
        group by qha.quality_control_id
      ),
      claim_totals as (
        select
          qha.quality_control_id,
          coalesce(sum(greatest(scl.qty_claimed - scl.qty_received, 0)), 0) as replacement_pending_qty
        from supplier_claim_lines scl
        join quality_hold_actions qha on qha.id = scl.quality_hold_action_id
        group by qha.quality_control_id
      )
      select
        qc.id,
        qc.qc_number,
        qc.qc_status,
        qc.inspection_date,
        qc.rtv_purchase_return_id,
        gr.id as goods_receipt_id,
        gr.grn_number,
        v.company_name as vendor_name,
        coalesce(sum(greatest(qcl.qty_on_hold - qcl.qty_replaced - qcl.qty_reworked - qcl.qty_accepted_after_hold, 0)), 0) as qty_pending_hold_resolution,
        coalesce(sum(greatest(qcl.qty_rejected - qcl.qty_rtv_created, 0)), 0) as qty_rejected_pending_rtv,
        coalesce(at.hold_action_count, 0) as hold_action_count,
        coalesce(at.rework_action_qty, 0) as rework_action_qty,
        coalesce(at.replacement_action_qty, 0) as replacement_action_qty,
        coalesce(at.final_acceptance_action_qty, 0) as final_acceptance_action_qty,
        coalesce(ct.replacement_pending_qty, 0) as replacement_pending_qty
      from quality_controls qc
      join goods_receipts gr on gr.id = qc.goods_receipt_id
      join vendors v on v.id = gr.vendor_id
      left join quality_control_lines qcl on qcl.quality_control_id = qc.id
      left join action_totals at on at.quality_control_id = qc.id
      left join claim_totals ct on ct.quality_control_id = qc.id
      ${where}
      group by qc.id, qc.qc_number, qc.qc_status, qc.inspection_date, qc.rtv_purchase_return_id, gr.id, gr.grn_number, v.company_name, at.hold_action_count, at.rework_action_qty, at.replacement_action_qty, at.final_acceptance_action_qty, ct.replacement_pending_qty
      order by qc.created_at desc, qc.id desc
      limit ${safeLimit}
    `,
    params
  );
  return r.rows;
}

async function getQualityReworkSummary(client, req, { q = "" } = {}) {
  const rows = await queryQualityReworkRows(client, req, { q, limit: 800 });
  return {
    qualityControls: rows.length,
    awaitingDisposition: rows.filter((row) => getQualityReworkBucket(row) === "awaiting_disposition").length,
    reworkPending: rows.filter((row) => getQualityReworkBucket(row) === "rework_pending").length,
    replacementPending: rows.filter((row) => getQualityReworkBucket(row) === "replacement_pending").length,
    finalAcceptancePending: rows.filter((row) => getQualityReworkBucket(row) === "final_acceptance_pending").length,
    rtvPending: rows.filter((row) => getQualityReworkBucket(row) === "rtv_pending").length,
    pendingHoldQty: rows.reduce((sum, row) => sum + qty(row.qty_pending_hold_resolution), 0),
    replacementPendingQty: rows.reduce((sum, row) => sum + qty(row.replacement_pending_qty), 0),
    rejectedPendingRtvQty: rows.reduce((sum, row) => sum + qty(row.qty_rejected_pending_rtv), 0),
  };
}

async function getQualityReworkQueue(client, req, { q = "", bucket = "all", limit = 80 } = {}) {
  const rows = await queryQualityReworkRows(client, req, { q, limit: 800 });
  return rows
    .filter((row) => matchesQualityReworkBucket(row, bucket))
    .sort((a, b) => {
      const rankDiff = getQualityReworkRank(a) - getQualityReworkRank(b);
      if (rankDiff !== 0) return rankDiff;
      const severityA = qty(a.replacement_pending_qty) + qty(a.qty_rejected_pending_rtv) + qty(a.qty_pending_hold_resolution);
      const severityB = qty(b.replacement_pending_qty) + qty(b.qty_rejected_pending_rtv) + qty(b.qty_pending_hold_resolution);
      if (severityB !== severityA) return severityB - severityA;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, normalizeLimit(limit, 80, 200));
}

async function getGoodsReceiptForQc(client, id, companyId) {
  const headerRes = await client.query(
    `
      select
        gr.*,
        v.company_name as vendor_name
      from goods_receipts gr
      join vendors v on v.id = gr.vendor_id
      where gr.id = $1 and gr.company_id = $2
      limit 1
    `,
    [id, Number(companyId)]
  );
  const header = headerRes.rows[0] || null;
  if (!header) return null;

  const linesRes = await client.query(
    `
      select
        grl.*
      from goods_receipt_lines grl
      where grl.goods_receipt_id = $1
      order by grl.line_no asc
    `,
    [id]
  );

  return { header, lines: linesRes.rows };
}

async function getDefaultCurrencyId(client) {
  const r = await client.query(`select id from currencies where currency_code = 'INR' limit 1`);
  const id = Number(r.rows[0]?.id);
  if (Number.isFinite(id) && id > 0) return id;
  const fallback = await client.query(`select id from currencies where is_active = true order by currency_code asc limit 1`);
  const fallbackId = Number(fallback.rows[0]?.id);
  return Number.isFinite(fallbackId) && fallbackId > 0 ? fallbackId : null;
}

async function createDraftPurchaseReturnFromQualityControl(client, companyId, qualityControlId, userId) {
  const header = await getQualityControlHeaderOrNull(client, qualityControlId, companyId);
  if (!header) {
    const err = new Error("Quality control not found");
    err.code = "QC_NOT_FOUND";
    throw err;
  }
  if (Number(header.rtv_purchase_return_id || 0) > 0) {
    const err = new Error("RTV already created");
    err.code = "RTV_ALREADY_CREATED";
    throw err;
  }
  const lines = await getQualityControlLines(client, qualityControlId);
  const pending = lines.filter((line) => qty(line.qty_pending_rtv) > 0);
  if (!pending.length) {
    const err = new Error("No rejected quantity pending RTV");
    err.code = "NO_PENDING_RTV";
    throw err;
  }

  const currencyId = await getDefaultCurrencyId(client);
  if (!currencyId) {
    const err = new Error("No currency");
    err.code = "INVALID_CURRENCY";
    throw err;
  }

  const [returnNoRes, debitNoRes] = await Promise.all([
    client.query(`select next_company_document_number($1,'PRET') as return_number`, [companyId]),
    client.query(`select next_company_document_number($1,'DNOTE') as debit_note_number`, [companyId]),
  ]);
  const returnNumber = returnNoRes.rows[0]?.return_number;
  const debitNoteNumber = debitNoRes.rows[0]?.debit_note_number;
  const insertHeader = await client.query(
    `
      insert into purchase_returns (
        company_id,
        return_number,
        debit_note_number,
        vendor_id,
        goods_receipt_id,
        return_status,
        return_date,
        remarks,
        base_currency_id,
        return_currency_id,
        created_by
      )
      values ($1,$2,$3,$4,$5,'draft',current_date,$6,$7,$8,$9)
      returning id
    `,
    [
      companyId,
      returnNumber,
      debitNoteNumber,
      header.vendor_id,
      header.goods_receipt_id,
      `Created from QC ${header.qc_number}`,
      currencyId,
      currencyId,
      userId,
    ]
  );
  const purchaseReturnId = insertHeader.rows[0]?.id;

  let lineNo = 1;
  for (const line of pending) {
    await client.query(
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
          gst_pct,
          unit_price_base,
          unit_price_invoice,
          line_total_base,
          line_total_invoice
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,0,0,0,0)
      `,
      [
        purchaseReturnId,
        line.goods_receipt_line_id,
        null,
        lineNo,
        line.product_id || null,
        line.item_code || null,
        line.item_name || null,
        line.line_description || null,
        line.hsn_no || null,
        line.uom || null,
        qty(line.qty_pending_rtv),
      ]
    );
    lineNo += 1;
  }

  await client.query(
    `
      update quality_control_lines
      set qty_rtv_created = qty_rejected
      where quality_control_id = $1
    `,
    [qualityControlId]
  );

  await client.query(
    `
      update quality_controls
      set rtv_purchase_return_id = $2,
          updated_at = now()
      where id = $1
    `,
    [qualityControlId, purchaseReturnId]
  );

  return { id: purchaseReturnId, return_number: returnNumber };
}

router.get("/bootstrap", requireScreenAction("quality_control", "can_view"), async (_req, res, next) => {
  try {
    const companyId = getActiveCompanyId(_req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const postedGrns = await getPostedGrnsWithoutQc(pool, companyId);
    return res.json({ ok: true, posted_grns: postedGrns });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("quality_control", "can_view"), async (req, res, next) => {
  try {
    const params = [];
    let where = "";
    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    where = `where qc.company_id = $${params.length}`;
    if (ownRecordsOnly(req, "quality_control")) {
      params.push(req.user.id);
      where += ` and qc.created_by = $${params.length}`;
    }
    const r = await pool.query(
      `
        select
          qc.id,
          qc.qc_number,
          qc.qc_status,
          qc.inspection_date,
          qc.rtv_purchase_return_id,
          gr.grn_number,
          v.company_name as vendor_name,
          coalesce(sum(greatest(qcl.qty_on_hold - qcl.qty_replaced - qcl.qty_reworked - qcl.qty_accepted_after_hold, 0)), 0) as qty_pending_hold_resolution
        from quality_controls qc
        join goods_receipts gr on gr.id = qc.goods_receipt_id
        join vendors v on v.id = gr.vendor_id
        left join quality_control_lines qcl on qcl.quality_control_id = qc.id
        ${where}
        group by qc.id, qc.qc_number, qc.qc_status, qc.inspection_date, qc.rtv_purchase_return_id, gr.grn_number, v.company_name
        order by qc.created_at desc, qc.id desc
      `,
      params
    );
    return res.json({ ok: true, quality_controls: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/rework-summary", requireScreenAction("quality_control", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getQualityReworkSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/rework-queue", requireScreenAction("quality_control", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getQualityReworkQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/capa-summary", requireScreenAction("quality_control", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const summary = await getQualityCapaSummary(pool, req, { q });
    return res.json({ ok: true, summary });
  } catch (err) {
    return next(err);
  }
});

router.get("/capa-queue", requireScreenAction("quality_control", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const bucket = typeof req.query.bucket === "string" ? req.query.bucket.trim().toLowerCase() : "all";
    const limit = normalizeLimit(req.query.limit, 80, 200);
    const rows = await getQualityCapaQueue(pool, req, { q, bucket, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/from-grn/:id", requireScreenAction("quality_control", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const goodsReceiptId = Number(req.params.id);
    if (!Number.isFinite(goodsReceiptId) || goodsReceiptId <= 0) return res.status(400).json({ ok: false, error: "INVALID_GRN" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const existingRes = await client.query(`select id from quality_controls where goods_receipt_id = $1 limit 1`, [goodsReceiptId]);
    if (existingRes.rows[0]?.id) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QC_ALREADY_EXISTS" });
    }

    const grn = await getGoodsReceiptForQc(client, goodsReceiptId, companyId);
    if (!grn?.header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "GRN_NOT_FOUND" });
    }
    if (String(grn.header.receipt_status || "").toLowerCase() !== "posted") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "GRN_NOT_POSTED" });
    }

    const numRes = await client.query(`select next_company_document_number($1,'QC') as qc_number`, [companyId]);
    const qcNumber = numRes.rows[0]?.qc_number;
    const insertHeader = await client.query(
      `
        insert into quality_controls (
          company_id,
          qc_number,
          goods_receipt_id,
          qc_status,
          inspection_date,
          remarks,
          created_by
        )
        values ($1,$2,$3,'draft',current_date,null,$4)
        returning id
      `,
      [companyId, qcNumber, goodsReceiptId, req.user.id]
    );
    const qualityControlId = insertHeader.rows[0]?.id;

    let lineNo = 1;
    for (const line of grn.lines) {
      await client.query(
        `
          insert into quality_control_lines (
            quality_control_id,
            goods_receipt_line_id,
            line_no,
            product_id,
            item_code,
            item_name,
            line_description,
            hsn_no,
            uom,
            qty_received,
            qty_accepted,
            qty_on_hold,
            qty_rejected,
            qty_rtv_created,
            hold_reason,
            rejection_reason
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,0,0,0,null,null)
        `,
        [
          qualityControlId,
          line.id,
          lineNo,
          line.product_id || null,
          line.item_code || null,
          line.item_name || null,
          line.line_description || null,
          line.hsn_no || null,
          line.uom || null,
          qty(line.qty_received),
        ]
      );
      lineNo += 1;
    }

    await client.query("commit");
    const header = await getQualityControlHeaderOrNull(client, qualityControlId, companyId);
    const lines = await getQualityControlLines(client, qualityControlId);
    const holdActions = await getQualityHoldActions(client, qualityControlId);
    const ncrCases = await getQualityNcrCases(client, qualityControlId);
    const capaActions = await getQualityCapaActions(client, qualityControlId);
    return res.status(201).json({ ok: true, quality_control: header, lines, hold_actions: holdActions, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("quality_control", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const header = await getQualityControlHeaderOrNull(pool, id, companyId);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessCompanyContext(req, header)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessQualityControl(req, header)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const lines = await getQualityControlLines(pool, id);
    const holdActions = await getQualityHoldActions(pool, id);
    const ncrCases = await getQualityNcrCases(pool, id);
    const capaActions = await getQualityCapaActions(pool, id);
    return res.json({ ok: true, quality_control: header, lines, hold_actions: holdActions, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("quality_control", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const status = typeof body.qc_status === "string" ? body.qc_status.trim().toLowerCase() : "draft";
    if (!["draft", "closed", "cancelled"].includes(status)) return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const header = await getQualityControlHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessQualityControl(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(header.qc_status || "").toLowerCase() !== "draft" && Array.isArray(body.lines)) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QC_NOT_EDITABLE" });
    }

    const linesPayload = Array.isArray(body.lines) ? body.lines : [];
    if (linesPayload.length) {
      for (const line of linesPayload) {
        const received = qty(line.qty_received);
        const accepted = qty(line.qty_accepted);
        const onHold = qty(line.qty_on_hold);
        const rejected = qty(line.qty_rejected);
        if (Math.abs(received - (accepted + onHold + rejected)) > 0.0001) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "QTY_SPLIT_MISMATCH" });
        }
        if (accepted < 0 || onHold < 0 || rejected < 0) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_QTY" });
        }
      }

      const currentLines = await getQualityControlLines(client, id);
      const lineMap = new Map(currentLines.map((line) => [Number(line.id), line]));
      for (const line of linesPayload) {
        const lineId = Number(line.id);
        const current = lineMap.get(lineId);
        if (!current) continue;
        await client.query(
          `
            update quality_control_lines
            set qty_accepted = $2,
                qty_on_hold = $3,
                qty_rejected = $4,
                hold_reason = $5,
                rejection_reason = $6
            where id = $1 and quality_control_id = $7
          `,
          [
            lineId,
            qty(line.qty_accepted),
            qty(line.qty_on_hold),
            qty(line.qty_rejected),
            typeof line.hold_reason === "string" ? line.hold_reason.trim() || null : current.hold_reason || null,
            typeof line.rejection_reason === "string" ? line.rejection_reason.trim() || null : current.rejection_reason || null,
            id,
          ]
        );
      }
    }

    await client.query(
      `
        update quality_controls
        set qc_status = $2,
            inspection_date = coalesce($3, inspection_date),
            remarks = $4,
            updated_at = now()
        where id = $1
      `,
      [id, status, body.inspection_date || null, typeof body.remarks === "string" ? body.remarks.trim() || null : header.remarks || null]
    );

    await client.query("commit");
    const nextHeader = await getQualityControlHeaderOrNull(client, id, companyId);
    const lines = await getQualityControlLines(client, id);
    const holdActions = await getQualityHoldActions(client, id);
    const ncrCases = await getQualityNcrCases(client, id);
    const capaActions = await getQualityCapaActions(client, id);
    return res.json({ ok: true, quality_control: nextHeader, lines, hold_actions: holdActions, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/hold-actions", requireScreenAction("quality_control", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const lineId = Number(body.quality_control_line_id || body.line_id);
    const actionType = typeof body.action_type === "string" ? body.action_type.trim().toLowerCase() : "";
    const targetColumn = HOLD_ACTION_TO_COLUMN[actionType];
    const actionQty = money(body.qty);

    if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ ok: false, error: "INVALID_LINE_ID" });
    if (!targetColumn) return res.status(400).json({ ok: false, error: "INVALID_ACTION_TYPE" });
    if (actionQty <= 0) return res.status(400).json({ ok: false, error: "INVALID_QTY" });

    await client.query("begin");
    const header = await getQualityControlHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessQualityControl(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(header.qc_status || "").toLowerCase() !== "closed") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QC_NOT_CLOSED" });
    }

    const lines = await getQualityControlLines(client, id);
    const line = lines.find((row) => Number(row.id) === lineId);
    if (!line) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "LINE_NOT_FOUND" });
    }

    const pendingHoldQty = money(line.qty_pending_hold_resolution);
    if (pendingHoldQty <= 0) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NO_PENDING_HOLD_QTY" });
    }
    if (actionQty > pendingHoldQty) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "HOLD_QTY_EXCEEDED" });
    }

    const insertAction = await client.query(
      `
        insert into quality_hold_actions (
          quality_control_id,
          quality_control_line_id,
          action_type,
          action_date,
          qty,
          reference_no,
          expected_date,
          remarks,
          created_by
        )
        values ($1,$2,$3,coalesce($4, current_date),$5,$6,$7,$8,$9)
        returning id
      `,
      [
        id,
        lineId,
        actionType,
        normalizeText(body.action_date),
        actionQty,
        normalizeText(body.reference_no),
        normalizeText(body.expected_date),
        normalizeText(body.remarks),
        req.user.id,
      ]
    );

    await client.query(
      `
        update quality_control_lines
        set ${targetColumn} = ${targetColumn} + $2
        where id = $1 and quality_control_id = $3
      `,
      [lineId, actionQty, id]
    );

    await client.query(
      `
        update quality_controls
        set updated_at = now()
        where id = $1
      `,
      [id]
    );

    await client.query("commit");
    const nextHeader = await getQualityControlHeaderOrNull(client, id, companyId);
    const nextLines = await getQualityControlLines(client, id);
    const holdActions = await getQualityHoldActions(client, id);
    const ncrCases = await getQualityNcrCases(client, id);
    const capaActions = await getQualityCapaActions(client, id);
    return res.status(201).json({
      ok: true,
      quality_control: nextHeader,
      lines: nextLines,
      hold_actions: holdActions,
      ncr_cases: ncrCases,
      capa_actions: capaActions,
      hold_action_id: insertAction.rows[0]?.id || null,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/create-rtv", requireScreenAction("quality_control", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const header = await getQualityControlHeaderOrNull(client, id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessQualityControl(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(header.qc_status || "").toLowerCase() !== "closed") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "QC_NOT_CLOSED" });
    }

    const purchaseReturn = await createDraftPurchaseReturnFromQualityControl(client, companyId, id, req.user.id);
    await client.query("commit");
    const nextHeader = await getQualityControlHeaderOrNull(client, id, companyId);
    const lines = await getQualityControlLines(client, id);
    const holdActions = await getQualityHoldActions(client, id);
    const ncrCases = await getQualityNcrCases(client, id);
    const capaActions = await getQualityCapaActions(client, id);
    return res.status(201).json({ ok: true, quality_control: nextHeader, lines, hold_actions: holdActions, ncr_cases: ncrCases, capa_actions: capaActions, purchase_return: purchaseReturn });
  } catch (err) {
    await client.query("rollback");
    if (err?.code === "RTV_ALREADY_CREATED") return res.status(409).json({ ok: false, error: "RTV_ALREADY_CREATED" });
    if (err?.code === "NO_PENDING_RTV") return res.status(409).json({ ok: false, error: "NO_PENDING_RTV" });
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/ncr-cases", requireScreenAction("quality_control", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const qualityControlId = Number(req.params.id);
    if (!Number.isFinite(qualityControlId) || qualityControlId <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    await client.query("begin");
    const header = await getQualityControlHeaderOrNull(client, qualityControlId, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessQualityControl(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const defectSummary = normalizeText(body.defect_summary);
    if (!defectSummary) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "DEFECT_SUMMARY_REQUIRED" });
    }

    const qualityControlLineId = normalizeId(body.quality_control_line_id || body.line_id);
    if (qualityControlLineId) {
      const lineCheck = await client.query(
        `select id from quality_control_lines where id = $1 and quality_control_id = $2 limit 1`,
        [qualityControlLineId, qualityControlId]
      );
      if (!lineCheck.rows[0]?.id) {
        await client.query("rollback");
        return res.status(404).json({ ok: false, error: "LINE_NOT_FOUND" });
      }
    }

    const ncrRes = await client.query(`select next_company_document_number($1,'NCR') as ncr_number`, [companyId]);
    const ncrNumber = ncrRes.rows[0]?.ncr_number;
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const status = deriveNcrStatus(body, actions);
    const insertRes = await client.query(
      `
        insert into quality_ncr_cases (
          company_id,
          ncr_number,
          quality_control_id,
          quality_control_line_id,
          source_type,
          severity,
          category,
          qty_affected,
          defect_summary,
          containment_action,
          containment_owner_id,
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
        values ($1,$2,$3,$4,'quality_control',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        returning id
      `,
      [
        companyId,
        ncrNumber,
        qualityControlId,
        qualityControlLineId,
        normalizeSeverity(body.severity),
        normalizeNcrCategory(body.category),
        money(body.qty_affected),
        defectSummary,
        normalizeText(body.containment_action),
        normalizeId(body.containment_owner_id),
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

    await client.query(`update quality_controls set updated_at = now() where id = $1`, [qualityControlId]);
    await client.query("commit");
    const qualityControl = await getQualityControlHeaderOrNull(client, qualityControlId, companyId);
    const lines = await getQualityControlLines(client, qualityControlId);
    const holdActions = await getQualityHoldActions(client, qualityControlId);
    const ncrCases = await getQualityNcrCases(client, qualityControlId);
    const capaActions = await getQualityCapaActions(client, qualityControlId);
    return res.status(201).json({ ok: true, quality_control: qualityControl, lines, hold_actions: holdActions, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/ncr-cases/:ncrId", requireScreenAction("quality_control", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const ncrId = Number(req.params.ncrId);
    if (!Number.isFinite(ncrId) || ncrId <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const body = req.body && typeof req.body === "object" ? req.body : {};

    await client.query("begin");
    const ncrRes = await client.query(
      `select * from quality_ncr_cases where id = $1 and company_id = $2 limit 1`,
      [ncrId, companyId]
    );
    const ncr = ncrRes.rows[0] || null;
    if (!ncr) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    const header = await getQualityControlHeaderOrNull(client, ncr.quality_control_id, companyId);
    if (!header) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (!canAccessCompanyContext(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessQualityControl(req, header)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const defectSummary = normalizeText(body.defect_summary) || ncr.defect_summary;
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const derivedStatus = deriveNcrStatus(
      {
        ...ncr,
        ...body,
        defect_summary: defectSummary,
      },
      actions.length ? actions : [{ action_status: "done" }]
    );

    await client.query(
      `
        update quality_ncr_cases
        set severity = $2,
            category = $3,
            qty_affected = $4,
            defect_summary = $5,
            containment_action = $6,
            containment_owner_id = $7,
            containment_due_date = $8,
            containment_completed_date = $9,
            root_cause = $10,
            corrective_plan = $11,
            preventive_plan = $12,
            verification_method = $13,
            verified_by = $14,
            verification_date = $15,
            status = $16,
            remarks = $17,
            updated_at = now()
        where id = $1 and company_id = $18
      `,
      [
        ncrId,
        normalizeSeverity(body.severity || ncr.severity),
        normalizeNcrCategory(body.category || ncr.category),
        money(body.qty_affected ?? ncr.qty_affected),
        defectSummary,
        normalizeText(body.containment_action) ?? ncr.containment_action,
        normalizeId(body.containment_owner_id ?? ncr.containment_owner_id),
        normalizeDate(body.containment_due_date) ?? ncr.containment_due_date,
        normalizeDate(body.containment_completed_date) ?? ncr.containment_completed_date,
        normalizeText(body.root_cause) ?? ncr.root_cause,
        normalizeText(body.corrective_plan) ?? ncr.corrective_plan,
        normalizeText(body.preventive_plan) ?? ncr.preventive_plan,
        normalizeText(body.verification_method) ?? ncr.verification_method,
        normalizeId(body.verified_by ?? ncr.verified_by),
        normalizeDate(body.verification_date) ?? ncr.verification_date,
        derivedStatus,
        normalizeText(body.remarks) ?? ncr.remarks,
        companyId,
      ]
    );

    const existingActionsRes = await client.query(
      `select id from quality_capa_actions where ncr_case_id = $1`,
      [ncrId]
    );
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

    await client.query(`update quality_controls set updated_at = now() where id = $1`, [ncr.quality_control_id]);
    await client.query("commit");
    const qualityControl = await getQualityControlHeaderOrNull(client, ncr.quality_control_id, companyId);
    const lines = await getQualityControlLines(client, ncr.quality_control_id);
    const holdActions = await getQualityHoldActions(client, ncr.quality_control_id);
    const ncrCases = await getQualityNcrCases(client, ncr.quality_control_id);
    const capaActions = await getQualityCapaActions(client, ncr.quality_control_id);
    return res.json({ ok: true, quality_control: qualityControl, lines, hold_actions: holdActions, ncr_cases: ncrCases, capa_actions: capaActions });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
