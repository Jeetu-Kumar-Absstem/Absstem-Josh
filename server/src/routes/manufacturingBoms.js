const express = require("express");

const { pool } = require("../db/pool");
const { ownRecordsOnly, requireScreenAction, hasScreenAction } = require("../auth/authorization");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");

const router = express.Router();

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(values) {
  return values.map(csvCell).join(",");
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const source = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || (row.length === 1 && String(row[0] || "").trim())) rows.push(row);
      row = [];
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
  }
  row.push(field);
  if (row.length > 1 || (row.length === 1 && String(row[0] || "").trim())) rows.push(row);
  return rows;
}

function csvRowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || "").trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = cells[index] === undefined ? "" : cells[index];
    });
    return obj;
  });
}

function normalizeItemCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function parseBool(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "active"].includes(text)) return true;
  if (["0", "false", "no", "n", "inactive"].includes(text)) return false;
  return defaultValue;
}

function canAccessBom(req, row) {
  if (!row) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "manufacturing_boms")) return true;
  return Number(row.created_by) === Number(req.user.id);
}

/** Explicit engineering_approver / super_admin (or screen can_approve) for master lock. */
function canApproveBomMaster(req) {
  if (!req?.user) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  const roleKey = String(req.user.role_key || "").trim().toLowerCase();
  if (roleKey === "super_admin" || roleKey === "engineering_approver") return true;
  return hasScreenAction(req, "manufacturing_boms", "can_approve");
}

function isBomLocked(bom) {
  return String(bom?.lifecycle_state || "") === "Locked/Active";
}

function assertBomEditable(req, bom) {
  if (!isBomLocked(bom)) return null;
  if (canApproveBomMaster(req)) {
    return {
      status: 403,
      body: {
        ok: false,
        error: "BOM_LOCKED",
        detail:
          "This master BOM is Locked/Active. Clone a new Draft revision (Revise) before editing; only unlock via a controlled revise path.",
      },
    };
  }
  return {
    status: 403,
    body: {
      ok: false,
      error: "BOM_LOCKED",
      detail:
        "Forbidden: Locked/Active master BOM cannot be modified. Clone it into a new Draft revision instead.",
    },
  };
}

async function assertNoServiceOnlyComponents(client, companyId, productIds) {
  const ids = [...new Set((productIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return;

  const r = await client.query(
    `
      select
        p.id,
        p.item_code,
        p.item_name,
        coalesce(cpp.sourcing_mode, 'buy_external') as sourcing_mode
      from products p
      left join company_product_policies cpp
        on cpp.product_id = p.id and cpp.company_id = $2
      where p.id = any($1::int[])
        and lower(coalesce(cpp.sourcing_mode, '')) = 'service_only'
    `,
    [ids, Number(companyId)]
  );
  if (!r.rows.length) return;

  const codes = r.rows.map((row) => row.item_code || `#${row.id}`).join(", ");
  const err = new Error("SERVICE_ONLY_COMPONENT_FORBIDDEN");
  err.status = 400;
  err.code = "SERVICE_ONLY_COMPONENT_FORBIDDEN";
  err.detail = `Racmet freeze: Active - Service Only items cannot be added to a production BOM (${codes}).`;
  throw err;
}

async function getManufacturedProducts(client, companyId) {
  const cid = Number(companyId);
  return lookupProducts(client, { companyId: cid, q: "", mode: "manufacture", limit: 300 });
}

async function getManufacturingReadiness(client, companyId) {
  const r = await client.query(
    `
      with bom_counts as (
        select
          mb.finished_good_product_id,
          count(*)::int as total_bom_count,
          count(*) filter (where mb.is_active = true)::int as active_bom_count
        from manufacturing_boms mb
        where mb.company_id = $1 or mb.is_active = true
        group by mb.finished_good_product_id
      ),
      latest_active_bom as (
        select distinct on (mb.finished_good_product_id)
          mb.finished_good_product_id,
          mb.id as bom_id,
          mb.bom_code,
          mb.revision_no,
          mb.company_id as bom_company_id,
          c.company_code as bom_company_code,
          coalesce(lines.line_count, 0) as line_count
        from manufacturing_boms mb
        join companies c on c.id = mb.company_id
        left join (
          select bom_id, count(*)::int as line_count
          from manufacturing_bom_lines
          group by bom_id
        ) lines on lines.bom_id = mb.id
        where (mb.company_id = $1 or mb.is_active = true)
          and mb.is_active = true
        order by mb.finished_good_product_id, (case when mb.company_id = $1 then 1 else 2 end), mb.revision_no desc, mb.updated_at desc, mb.id desc
      )
      select
        p.id,
        p.item_code,
        p.item_name,
        p.uom,
        coalesce(cpp.is_manufactured, p.is_manufactured, false) as is_manufactured,
        coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
        coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) as sourcing_mode,
        cpp.intercompany_source_company_id,
        coalesce(cp.company_name, c.display_name, c.legal_name, c.company_code) as intercompany_source_company_name,
        coalesce(bc.total_bom_count, 0) as total_bom_count,
        coalesce(bc.active_bom_count, 0) as active_bom_count,
        lab.bom_id as latest_active_bom_id,
        lab.bom_code as latest_active_bom_code,
        lab.revision_no as latest_active_revision_no,
        lab.bom_company_id,
        lab.bom_company_code,
        case when lab.bom_company_id is not null and lab.bom_company_id != $1 then true else false end as is_inherited,
        coalesce(lab.line_count, 0) as latest_active_line_count
      from products p
      left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $1
      left join company_profiles_v2 cp on cp.company_id = cpp.intercompany_source_company_id
      left join companies c on c.id = cpp.intercompany_source_company_id
      left join bom_counts bc on bc.finished_good_product_id = p.id
      left join latest_active_bom lab on lab.finished_good_product_id = p.id
      where p.is_active = true
        and (
          coalesce(cpp.is_manufactured, p.is_manufactured, false) = true
          or coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) is not null
          or coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) = 'buy_intercompany'
          or coalesce(bc.total_bom_count, 0) > 0
        )
      order by p.item_code asc, p.id asc
    `,
    [Number(companyId)]
  );

  return r.rows.map((row) => {
    const prefix = normalizeText(row.mfg_job_prefix);
    const latestLineCount = Number(row.latest_active_line_count || 0);
    const activeBomCount = Number(row.active_bom_count || 0);
    const sourcingMode = String(row.sourcing_mode || "").trim().toLowerCase() || (row.is_manufactured === true ? "manufacture" : "buy_external");
    const sourceCompanyName = normalizeText(row.intercompany_source_company_name);
    const isInherited = Boolean(row.is_inherited);
    const localManufacturingOwner = row.is_manufactured === true && sourcingMode === "manufacture";
    const readyForJob = (localManufacturingOwner || isInherited) && activeBomCount > 0 && latestLineCount > 0;
    let readinessStatus = "ready";
    let readinessNote = "Ready for job creation.";
    let recommendedAction = "use_bom_editor";
    let recommendedActionLabel = "Use in BOM editor";
    let attentionLevel = "low";
    let ownershipScopeLabel = "Manufactured in this company.";
    let ownershipNote = "Maintain the BOM in this company.";

    if (sourcingMode === "buy_intercompany" || isInherited) {
      const sourceLabel = row.bom_company_code ? `Absstem (${row.bom_company_code})` : (sourceCompanyName || "AT Master");
      readinessStatus = "intercompany_supply";
      readinessNote = activeBomCount > 0 
        ? `Inherited active recipe from ${sourceLabel} (Rev ${row.latest_active_revision_no || 1}, ${latestLineCount} lines). Ready for kitting & dispatch.`
        : `This FG is supplied from ${sourceLabel}. Maintain the master recipe in ${sourceLabel}.`;
      recommendedAction = "use_bom_editor";
      recommendedActionLabel = "View Inherited Recipe";
      attentionLevel = activeBomCount > 0 ? "low" : "medium";
      ownershipScopeLabel = `Inherited from ${sourceLabel}`;
      ownershipNote = readinessNote;
    } else if (!row.is_manufactured) {
      readinessStatus = "missing_fg_flag";
      readinessNote = "Mark as Manufactured FG in Product Master.";
      recommendedAction = "mark_manufactured_fg";
      recommendedActionLabel = "Mark manufactured FG";
      attentionLevel = "high";
    } else if (!prefix) {
      readinessStatus = "missing_prefix";
      readinessNote = "Assign manufacturing JobID prefix in Product Master.";
      recommendedAction = "set_job_prefix";
      recommendedActionLabel = "Set JobID prefix";
      attentionLevel = "high";
    } else if (activeBomCount <= 0) {
      readinessStatus = "missing_active_bom";
      readinessNote = "Create or activate a BOM.";
      recommendedAction = "create_bom";
      recommendedActionLabel = "Create BOM";
      attentionLevel = "high";
    } else if (latestLineCount <= 0) {
      readinessStatus = "empty_bom";
      readinessNote = "Active BOM has no component lines.";
      recommendedAction = "add_bom_lines";
      recommendedActionLabel = "Add BOM lines";
      attentionLevel = "high";
    }

    return {
      ...row,
      ready_for_job: readyForJob,
      readiness_status: readinessStatus,
      readiness_note: readinessNote,
      recommended_action: recommendedAction,
      recommended_action_label: recommendedActionLabel,
      attention_level: attentionLevel,
      ownership_scope_label: ownershipScopeLabel,
      ownership_note: ownershipNote,
    };
  });
}

async function getManufacturingDashboardSummary(client, companyId, readinessRows = []) {
  const jobSummary = await client.query(
    `
      select
        count(*)::int as total_jobs,
        count(*) filter (
          where lower(coalesce(job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')
        )::int as open_jobs,
        count(*) filter (
          where sales_order_line_id is not null
            and lower(coalesce(job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')
        )::int as so_linked_open_jobs,
        count(*) filter (
          where coalesce(actual_output_qty, 0) > 0
        )::int as jobs_with_output,
        coalesce(sum(actual_output_qty) filter (
          where coalesce(finished_good_receipt_date, created_at::date) >= current_date - interval '7 days'
        ), 0)::numeric(18,4) as output_last_7d
      from job_cards
      where company_id = $1
        and job_type = 'manufacturing'
    `,
    [Number(companyId)]
  );

  const bomSummary = await client.query(
    `
      select
        count(*)::int as total_boms,
        count(*) filter (where is_active = true)::int as active_boms
      from manufacturing_boms
      where company_id = $1
    `,
    [Number(companyId)]
  );

  const storesPendingSummary = await client.query(
    `
      select
        count(*)::int as stores_pending_jobs,
        coalesce(sum(stats.pending_issue_qty), 0)::numeric(18,4) as stores_pending_qty
      from job_cards jc
      left join lateral (
        select
          coalesce(sum(greatest(jcl.qty_requested - (coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)), 0)), 0) as pending_issue_qty
        from job_card_lines jcl
        left join lateral (
          select coalesce(sum(qty), 0) as issue_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'issue'
        ) issue_stats on true
        left join lateral (
          select coalesce(sum(qty), 0) as return_qty
          from job_card_movements
          where job_card_line_id = jcl.id and movement_type = 'return'
        ) return_stats on true
        where jcl.job_card_id = jc.id
      ) stats on true
      where jc.company_id = $1
        and jc.job_type = 'manufacturing'
        and lower(coalesce(jc.job_status, 'draft')) in ('draft', 'submitted', 'approved', 'open')
        and coalesce(stats.pending_issue_qty, 0) > 0
    `,
    [Number(companyId)]
  );

  const jobRow = jobSummary.rows[0] || {};
  const bomRow = bomSummary.rows[0] || {};
  const storesRow = storesPendingSummary.rows[0] || {};
  const readyRows = readinessRows.filter((row) => row.ready_for_job);

  return {
    fg_candidates: readinessRows.length,
    fg_ready: readyRows.length,
    active_boms: Number(bomRow.active_boms || 0),
    total_boms: Number(bomRow.total_boms || 0),
    manufacturing_jobs: Number(jobRow.total_jobs || 0),
    open_manufacturing_jobs: Number(jobRow.open_jobs || 0),
    so_linked_open_jobs: Number(jobRow.so_linked_open_jobs || 0),
    stores_pending_jobs: Number(storesRow.stores_pending_jobs || 0),
    stores_pending_qty: Number(storesRow.stores_pending_qty || 0),
    jobs_with_output: Number(jobRow.jobs_with_output || 0),
    output_last_7d: Number(jobRow.output_last_7d || 0),
  };
}

async function getComponentLookup(client, companyId, q) {
  return lookupProducts(client, { companyId, q, mode: "stock", limit: 100, includeStockQty: true });
}

async function getBomHeaderOrNull(client, id, companyId) {
  // First check active company
  const r = await client.query(
    `
      select
        mb.*,
        p.item_code as finished_good_item_code,
        p.item_name as finished_good_item_name,
        p.uom as finished_good_uom,
        coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
        coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) as sourcing_mode,
        cpp.intercompany_source_company_id,
        coalesce(cp.company_name, c.display_name, c.legal_name, c.company_code) as intercompany_source_company_name,
        u.full_name as created_by_name,
        false as is_inherited,
        null::text as inherited_from_company_code
      from manufacturing_boms mb
      join products p on p.id = mb.finished_good_product_id
      left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = mb.company_id
      left join company_profiles_v2 cp on cp.company_id = cpp.intercompany_source_company_id
      left join companies c on c.id = cpp.intercompany_source_company_id
      left join erp_users u on u.id = mb.created_by
      where mb.id = $1 and mb.company_id = $2
      limit 1
    `,
    [Number(id), Number(companyId)]
  );
  if (r.rows[0]) return r.rows[0];

  // Intercompany Fallback: If not found in local company, check if BOM ID exists in source authoring company
  const fallback = await client.query(
    `
      select
        mb.*,
        p.item_code as finished_good_item_code,
        p.item_name as finished_good_item_name,
        p.uom as finished_good_uom,
        coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
        'buy_intercompany' as sourcing_mode,
        mb.company_id as intercompany_source_company_id,
        coalesce(cp.company_name, c.display_name, c.legal_name, c.company_code) as intercompany_source_company_name,
        u.full_name as created_by_name,
        true as is_inherited,
        c.company_code as inherited_from_company_code
      from manufacturing_boms mb
      join products p on p.id = mb.finished_good_product_id
      join companies c on c.id = mb.company_id
      left join company_profiles_v2 cp on cp.company_id = mb.company_id
      left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $2
      left join erp_users u on u.id = mb.created_by
      where mb.id = $1
      limit 1
    `,
    [Number(id), Number(companyId)]
  );

  return fallback.rows[0] || null;
}

async function getBomLines(client, bomId) {
  const r = await client.query(
    `
      select
        bl.*,
        p.serial_no_required,
        cs.spec_code,
        cs.spec_name,
        cs.geometry as spec_geometry,
        cs.material as spec_material,
        cs.pressure_rating as spec_pressure_rating
      from manufacturing_bom_lines bl
      left join products p on p.id = bl.component_product_id
      left join component_specifications cs on cs.id = bl.component_specification_id
      where bl.bom_id = $1
      order by bl.line_no asc
    `,
    [Number(bomId)]
  );
  return r.rows;
}

async function validateFinishedGood(client, companyId, productId) {
  const r = await client.query(
    `
      select
        p.id,
        p.item_code,
        p.item_name,
        p.uom,
        coalesce(cpp.is_manufactured, p.is_manufactured, false) as is_manufactured,
        coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
        coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) as sourcing_mode,
        cpp.intercompany_source_company_id,
        coalesce(cp.company_name, c.display_name, c.legal_name, c.company_code) as intercompany_source_company_name
      from products p
      left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = $2
      left join company_profiles_v2 cp on cp.company_id = cpp.intercompany_source_company_id
      left join companies c on c.id = cpp.intercompany_source_company_id
      where p.id = $1
      limit 1
    `,
    [Number(productId), Number(companyId)]
  );
  const row = r.rows[0] || null;
  if (!row) return { error: "INVALID_FINISHED_GOOD" };
  // Allow intercompany supplied products to be referenced and have recipes/BOMs configured or extended
  if (row.is_manufactured !== true && String(row.sourcing_mode || "").trim().toLowerCase() !== "buy_intercompany") {
    return { error: "PRODUCT_NOT_MARKED_MANUFACTURED" };
  }
  return { row };
}

async function normalizeLines(client, rawLines, companyId = null) {
  const lines = Array.isArray(rawLines) ? rawLines.filter((line) => asNumber(line.component_product_id) > 0) : [];
  const productIds = [...new Set(lines.map((line) => Number(line.component_product_id)))];
  if (!productIds.length) return [];

  const r = await client.query(
    `
      select id, item_code, item_name, uom
      from products
      where id = any($1::int[])
    `,
    [productIds]
  );
  const productMap = new Map(r.rows.map((row) => [Number(row.id), row]));
  if (productMap.size !== productIds.length) {
    const err = new Error("INVALID_COMPONENT_PRODUCT");
    err.status = 400;
    throw err;
  }

  if (companyId) {
    await assertNoServiceOnlyComponents(client, companyId, productIds);
  }

  const specIds = [
    ...new Set(lines.map((line) => asNumber(line.component_specification_id)).filter((n) => n > 0)),
  ];
  const specMap = new Map();
  if (specIds.length) {
    const params = [specIds];
    let where = "id = any($1::int[]) and is_active = true";
    if (companyId) {
      params.push(Number(companyId));
      where += ` and (company_id is null or company_id = $2)`;
    }
    const specRes = await client.query(
      `select id, spec_code, spec_name, geometry, material, pressure_rating, uom from component_specifications where ${where}`,
      params
    );
    for (const row of specRes.rows) specMap.set(Number(row.id), row);
    if (specMap.size !== specIds.length) {
      const err = new Error("INVALID_COMPONENT_SPECIFICATION");
      err.status = 400;
      throw err;
    }
  }

  return lines.map((line, index) => {
    const qtyPer = qty(line.qty_per);
    if (qtyPer <= 0) {
      const err = new Error("INVALID_QTY_PER");
      err.status = 400;
      throw err;
    }
    const product = productMap.get(Number(line.component_product_id));
    const specId = asNumber(line.component_specification_id);
    return {
      line_no: index + 1,
      component_product_id: Number(line.component_product_id),
      component_specification_id: specId > 0 ? specId : null,
      item_code: product.item_code || null,
      item_name: product.item_name || null,
      uom: product.uom || null,
      qty_per: qtyPer,
      remarks: normalizeText(line.remarks),
    };
  });
}

router.get("/import/template", requireScreenAction("manufacturing_boms", "can_view"), async (_req, res, next) => {
  try {
    const headers = [
      "BOMCode",
      "FinishedGoodItemCode",
      "ComponentItemCode",
      "ComponentSpecCode",
      "QtyPer",
      "Remarks",
      "RevisionNo",
      "IsActive",
    ];
    const sample = ["nGEN120SH", "nGEN120SH", "EC60", "", "1", "", "1", "TRUE"];
    const csv = `${csvRow(headers)}\r\n${csvRow(sample)}\r\n`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="BOM_Template.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    return next(err);
  }
});

router.post("/import", requireScreenAction("manufacturing_boms", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const csvText = typeof body.csv === "string" ? body.csv : typeof body.content === "string" ? body.content : "";
    if (!csvText.trim()) return res.status(400).json({ ok: false, error: "CSV_REQUIRED" });

    const objects = csvRowsToObjects(parseCsvText(csvText));
    if (!objects.length) return res.status(400).json({ ok: false, error: "CSV_EMPTY" });

    const groups = new Map();
    const rowErrors = [];
    objects.forEach((row, index) => {
      const lineNo = index + 2;
      const bomCode = normalizeText(row.BOMCode || row.bom_code);
      const fgCode = normalizeItemCode(row.FinishedGoodItemCode || row.finished_good_item_code);
      const componentCode = normalizeItemCode(row.ComponentItemCode || row.component_item_code);
      const componentSpecCode = normalizeItemCode(
        row.ComponentSpecCode ||
          row.ComponentSpecificationCode ||
          row.component_spec_code ||
          row.component_specification_code
      );
      const qtyPer = qty(row.QtyPer || row.qty_per);
      const revisionNo = Math.max(1, Math.trunc(asNumber(row.RevisionNo || row.revision_no) || 1));
      if (!bomCode || !fgCode || !componentCode || qtyPer <= 0) {
        rowErrors.push({ line: lineNo, error: "INVALID_ROW", bom_code: bomCode, component: componentCode });
        return;
      }
      const key = `${bomCode}::${revisionNo}::${fgCode}`;
      if (!groups.has(key)) {
        groups.set(key, {
          bom_code: bomCode,
          revision_no: revisionNo,
          finished_good_item_code: fgCode,
          is_active: parseBool(row.IsActive || row.is_active, true),
          remarks: normalizeText(row.HeaderRemarks || row.header_remarks),
          lines: [],
        });
      }
      groups.get(key).lines.push({
        component_item_code: componentCode,
        component_spec_code: componentSpecCode,
        qty_per: qtyPer,
        remarks: normalizeText(row.Remarks || row.remarks),
        line: lineNo,
      });
    });

    if (!groups.size) return res.status(400).json({ ok: false, error: "NO_VALID_BOM_ROWS", row_errors: rowErrors });

    const productRes = await client.query(
      `
        select id, upper(trim(item_code)) as item_code
        from products
        where is_active = true
      `
    );
    const productByCode = new Map(productRes.rows.map((row) => [row.item_code, Number(row.id)]));

    const specificationRes = await client.query(
      `
        select id, upper(trim(spec_code)) as spec_code
        from component_specifications
        where is_active = true
          and (company_id is null or company_id = $1)
        order by company_id nulls first, id asc
      `,
      [companyId]
    );
    const specificationByCode = new Map(
      specificationRes.rows.map((row) => [row.spec_code, Number(row.id)])
    );

    const created = [];
    const updated = [];
    const importErrors = [...rowErrors];

    await client.query("begin");

    for (const group of groups.values()) {
      const finishedGoodProductId = productByCode.get(group.finished_good_item_code);
      if (!finishedGoodProductId) {
        importErrors.push({ bom_code: group.bom_code, error: "FINISHED_GOOD_NOT_FOUND", item_code: group.finished_good_item_code });
        continue;
      }
      const fg = await validateFinishedGood(client, companyId, finishedGoodProductId);
      if (fg.error) {
        importErrors.push({ bom_code: group.bom_code, error: fg.error, item_code: group.finished_good_item_code });
        continue;
      }

      const linePayload = [];
      let lineFailed = false;
      for (const line of group.lines) {
        const componentId = productByCode.get(line.component_item_code);
        if (!componentId) {
          importErrors.push({ bom_code: group.bom_code, error: "COMPONENT_NOT_FOUND", item_code: line.component_item_code, line: line.line });
          lineFailed = true;
          break;
        }
        const componentSpecificationId = line.component_spec_code
          ? specificationByCode.get(line.component_spec_code)
          : null;
        if (line.component_spec_code && !componentSpecificationId) {
          importErrors.push({
            bom_code: group.bom_code,
            error: "COMPONENT_SPECIFICATION_NOT_FOUND",
            spec_code: line.component_spec_code,
            line: line.line,
          });
          lineFailed = true;
          break;
        }
        linePayload.push({
          component_product_id: componentId,
          component_specification_id: componentSpecificationId,
          qty_per: line.qty_per,
          remarks: line.remarks,
        });
      }
      if (lineFailed) continue;

      let normalizedLines;
      try {
        normalizedLines = await normalizeLines(client, linePayload, companyId);
      } catch (err) {
        importErrors.push({ bom_code: group.bom_code, error: err?.message || "INVALID_LINES" });
        continue;
      }
      if (!normalizedLines.length) {
        importErrors.push({ bom_code: group.bom_code, error: "BOM_LINES_REQUIRED" });
        continue;
      }

      const existingRes = await client.query(
        `
          select id
          from manufacturing_boms
          where company_id = $1
            and bom_code = $2
            and revision_no = $3
          limit 1
        `,
        [companyId, group.bom_code, group.revision_no]
      );
      const existingId = existingRes.rows[0]?.id ? Number(existingRes.rows[0].id) : null;

      if (existingId) {
        await client.query(
          `
            update manufacturing_boms
            set finished_good_product_id = $2,
                is_active = $3,
                remarks = coalesce($4, remarks),
                updated_at = now()
            where id = $1
          `,
          [existingId, finishedGoodProductId, group.is_active !== false, group.remarks]
        );
        await client.query(`delete from manufacturing_bom_lines where bom_id = $1`, [existingId]);
        for (const line of normalizedLines) {
          await client.query(
            `
              insert into manufacturing_bom_lines (
                bom_id, line_no, component_product_id, component_specification_id, item_code, item_name, uom, qty_per, remarks
              )
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            `,
            [existingId, line.line_no, line.component_product_id, line.component_specification_id || null, line.item_code, line.item_name, line.uom, line.qty_per, line.remarks]
          );
        }
        updated.push({ id: existingId, bom_code: group.bom_code, revision_no: group.revision_no });
      } else {
        const headerRes = await client.query(
          `
            insert into manufacturing_boms (
              company_id, bom_code, finished_good_product_id, revision_no, is_active, remarks, created_by
            )
            values ($1,$2,$3,$4,$5,$6,$7)
            returning id
          `,
          [companyId, group.bom_code, finishedGoodProductId, group.revision_no, group.is_active !== false, group.remarks, req.user.id]
        );
        const bomId = Number(headerRes.rows[0]?.id);
        for (const line of normalizedLines) {
          await client.query(
            `
              insert into manufacturing_bom_lines (
                bom_id, line_no, component_product_id, component_specification_id, item_code, item_name, uom, qty_per, remarks
              )
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            `,
            [bomId, line.line_no, line.component_product_id, line.component_specification_id || null, line.item_code, line.item_name, line.uom, line.qty_per, line.remarks]
          );
        }
        created.push({ id: bomId, bom_code: group.bom_code, revision_no: group.revision_no });
      }
    }

    await client.query("commit");
    return res.json({
      ok: true,
      created_count: created.length,
      updated_count: updated.length,
      error_count: importErrors.length,
      created,
      updated,
      errors: importErrors.slice(0, 50),
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/bootstrap", requireScreenAction("manufacturing_boms", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const finished_goods = await getManufacturedProducts(pool, companyId);
    const readiness = await getManufacturingReadiness(pool, companyId);
    const dashboard = await getManufacturingDashboardSummary(pool, companyId, readiness);
    return res.json({ ok: true, finished_goods, readiness, dashboard });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-lookup", requireScreenAction("manufacturing_boms", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const products = await getComponentLookup(pool, companyId, q);
    return res.json({ ok: true, products });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("manufacturing_boms", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const params = [companyId];
    let userFilter = "";
    if (ownRecordsOnly(req, "manufacturing_boms")) {
      params.push(Number(req.user.id));
      userFilter = `and mb.created_by = $${params.length}`;
    }

    const r = await pool.query(
      `
        select
          mb.id,
          mb.company_id,
          mb.bom_code,
          mb.revision_no,
          mb.is_active,
          mb.lifecycle_state,
          mb.approved_at,
          mb.updated_at,
          p.item_code as finished_good_item_code,
          p.item_name as finished_good_item_name,
          coalesce(cpp.mfg_job_prefix, p.mfg_job_prefix) as mfg_job_prefix,
          coalesce(cpp.sourcing_mode, case when coalesce(p.is_manufactured, false) then 'manufacture' else 'buy_external' end) as sourcing_mode,
          coalesce(cp.company_name, c.display_name, c.legal_name, c.company_code) as intercompany_source_company_name,
          c.company_code as bom_company_code,
          case when mb.company_id != $1 then true else false end as is_inherited,
          u.full_name as created_by_name,
          coalesce(lines.line_count, 0) as line_count
        from manufacturing_boms mb
        join products p on p.id = mb.finished_good_product_id
        join companies c on c.id = mb.company_id
        left join company_product_policies cpp on cpp.product_id = p.id and cpp.company_id = mb.company_id
        left join company_profiles_v2 cp on cp.company_id = cpp.intercompany_source_company_id
        left join erp_users u on u.id = mb.created_by
        left join (
          select bom_id, count(*)::int as line_count
          from manufacturing_bom_lines
          group by bom_id
        ) lines on lines.bom_id = mb.id
        where (mb.company_id = $1 or (mb.is_active = true and mb.lifecycle_state = 'Locked/Active'))
          ${userFilter}
        order by (case when mb.company_id = $1 then 1 else 2 end), mb.updated_at desc, mb.id desc
      `,
      params
    );
    return res.json({ ok: true, boms: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requireScreenAction("manufacturing_boms", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const bom = await getBomHeaderOrNull(pool, id, companyId);
    if (!bom) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessBom(req, bom)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (!canAccessCompanyContext(req, bom)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });

    const lines = await getBomLines(pool, id);
    return res.json({ ok: true, bom, lines });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("manufacturing_boms", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const finishedGoodProductId = Number(body.finished_good_product_id);
    if (!Number.isFinite(finishedGoodProductId) || finishedGoodProductId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_FINISHED_GOOD" });
    }

    const fg = await validateFinishedGood(client, companyId, finishedGoodProductId);
    if (fg.error) return res.status(400).json({ ok: false, error: fg.error });

    const normalizedLines = await normalizeLines(client, body.lines, companyId);
    if (!normalizedLines.length) return res.status(400).json({ ok: false, error: "BOM_LINES_REQUIRED" });

    await client.query("begin");

    let bomCode = normalizeText(body.bom_code);
    if (!bomCode) {
      const seqRes = await client.query(
        `select next_company_running_sequence($1, 'BOM', 'BOM', 4) as bom_code`,
        [companyId]
      );
      bomCode = seqRes.rows[0]?.bom_code || null;
    }
    if (!bomCode) {
      await client.query("rollback");
      return res.status(500).json({ ok: false, error: "NUMBERING_FAILED" });
    }

    const headerRes = await client.query(
      `
        insert into manufacturing_boms (
          company_id,
          bom_code,
          finished_good_product_id,
          revision_no,
          is_active,
          lifecycle_state,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,$5,'Draft',$6,$7)
        returning id
      `,
      [
        companyId,
        bomCode,
        finishedGoodProductId,
        Math.max(1, Math.trunc(asNumber(body.revision_no) || 1)),
        body.is_active !== false,
        normalizeText(body.remarks),
        req.user.id,
      ]
    );
    const bomId = headerRes.rows[0]?.id;

    for (const line of normalizedLines) {
      await client.query(
        `
          insert into manufacturing_bom_lines (
            bom_id,
            line_no,
            component_product_id,
            component_specification_id,
            item_code,
            item_name,
            uom,
            qty_per,
            remarks
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [bomId, line.line_no, line.component_product_id, line.component_specification_id || null, line.item_code, line.item_name, line.uom, line.qty_per, line.remarks]
      );
    }

    await client.query("commit");
    const bom = await getBomHeaderOrNull(client, bomId, companyId);
    const lines = await getBomLines(client, bomId);
    return res.status(201).json({ ok: true, bom, lines });
  } catch (err) {
    await client.query("rollback");
    if (err?.message === "INVALID_COMPONENT_PRODUCT" || err?.message === "INVALID_QTY_PER" || err?.message === "INVALID_COMPONENT_SPECIFICATION") {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err?.message === "SERVICE_ONLY_COMPONENT_FORBIDDEN" || err?.code === "SERVICE_ONLY_COMPONENT_FORBIDDEN") {
      return res.status(400).json({
        ok: false,
        error: "SERVICE_ONLY_COMPONENT_FORBIDDEN",
        detail: err.detail || err.message,
      });
    }
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_BOM_CODE" });
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id", requireScreenAction("manufacturing_boms", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const bom = await getBomHeaderOrNull(client, id, companyId);
    if (!bom) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessBom(req, bom)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const locked = assertBomEditable(req, bom);
    if (locked) return res.status(locked.status).json(locked.body);

    const finishedGoodProductId = Number(body.finished_good_product_id || bom.finished_good_product_id);
    const fg = await validateFinishedGood(client, companyId, finishedGoodProductId);
    if (fg.error) return res.status(400).json({ ok: false, error: fg.error });

    const normalizedLines = await normalizeLines(client, body.lines, companyId);
    if (!normalizedLines.length) return res.status(400).json({ ok: false, error: "BOM_LINES_REQUIRED" });

    let nextLifecycle = String(bom.lifecycle_state || "Draft");
    if (body.lifecycle_state === "Pending Review" && nextLifecycle === "Draft") {
      nextLifecycle = "Pending Review";
    }
    if (nextLifecycle === "Locked/Active") nextLifecycle = "Draft";

    await client.query("begin");
    await client.query(
      `
        update manufacturing_boms
        set finished_good_product_id = $2,
            revision_no = $3,
            is_active = $4,
            remarks = $5,
            lifecycle_state = $6,
            updated_at = now()
        where id = $1 and company_id = $7
      `,
      [
        id,
        finishedGoodProductId,
        Math.max(1, Math.trunc(asNumber(body.revision_no) || bom.revision_no || 1)),
        body.is_active !== false,
        normalizeText(body.remarks),
        nextLifecycle,
        companyId,
      ]
    );

    await client.query(`delete from manufacturing_bom_lines where bom_id = $1`, [id]);
    for (const line of normalizedLines) {
      await client.query(
        `
          insert into manufacturing_bom_lines (
            bom_id,
            line_no,
            component_product_id,
            component_specification_id,
            item_code,
            item_name,
            uom,
            qty_per,
            remarks
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [id, line.line_no, line.component_product_id, line.component_specification_id || null, line.item_code, line.item_name, line.uom, line.qty_per, line.remarks]
      );
    }

    await client.query("commit");
    const nextBom = await getBomHeaderOrNull(client, id, companyId);
    const lines = await getBomLines(client, id);
    return res.json({ ok: true, bom: nextBom, lines });
  } catch (err) {
    await client.query("rollback");
    if (err?.message === "INVALID_COMPONENT_PRODUCT" || err?.message === "INVALID_QTY_PER" || err?.message === "INVALID_COMPONENT_SPECIFICATION") {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err?.message === "SERVICE_ONLY_COMPONENT_FORBIDDEN" || err?.code === "SERVICE_ONLY_COMPONENT_FORBIDDEN") {
      return res.status(400).json({
        ok: false,
        error: "SERVICE_ONLY_COMPONENT_FORBIDDEN",
        detail: err.detail || err.message,
      });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/submit-review", requireScreenAction("manufacturing_boms", "can_edit"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const bom = await getBomHeaderOrNull(pool, id, companyId);
    if (!bom) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessBom(req, bom)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (isBomLocked(bom)) {
      return res.status(403).json({
        ok: false,
        error: "BOM_LOCKED",
        detail: "Locked/Active masters cannot be submitted for review. Clone a Draft revision first.",
      });
    }

    const lines = await getBomLines(pool, id);
    if (!lines.length) return res.status(400).json({ ok: false, error: "BOM_LINES_REQUIRED" });

    await pool.query(
      `
        update manufacturing_boms
        set lifecycle_state = 'Pending Review', updated_at = now()
        where id = $1 and company_id = $2
      `,
      [id, companyId]
    );
    const nextBom = await getBomHeaderOrNull(pool, id, companyId);
    return res.json({ ok: true, bom: nextBom, lines });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/approve", async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    if (!canApproveBomMaster(req)) {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN",
        detail: "Only engineering_approver or SuperAdmin can lock a master BOM.",
      });
    }
    if (!hasScreenAction(req, "manufacturing_boms", "can_view") && req.user.group_name !== "SuperAdmin") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const bom = await getBomHeaderOrNull(pool, id, companyId);
    if (!bom) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessBom(req, bom)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    if (isBomLocked(bom)) {
      return res.json({ ok: true, bom, already_locked: true });
    }

    const lines = await getBomLines(pool, id);
    if (!lines.length) return res.status(400).json({ ok: false, error: "BOM_LINES_REQUIRED" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
          update manufacturing_boms
          set is_active = false, updated_at = now()
          where company_id = $1
            and bom_code = $2
            and id <> $3
            and is_active = true
        `,
        [companyId, bom.bom_code, id]
      );
      await client.query(
        `
          update manufacturing_boms
          set lifecycle_state = 'Locked/Active',
              is_active = true,
              approved_at = now(),
              approved_by = $3,
              updated_at = now()
          where id = $1 and company_id = $2
        `,
        [id, companyId, req.user.id]
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    const nextBom = await getBomHeaderOrNull(pool, id, companyId);
    const nextLines = await getBomLines(pool, id);
    return res.json({ ok: true, bom: nextBom, lines: nextLines });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/revise", requireScreenAction("manufacturing_boms", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const source = await getBomHeaderOrNull(client, id, companyId);
    if (!source) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canAccessBom(req, source)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const sourceLines = await getBomLines(client, id);
    if (!sourceLines.length) return res.status(400).json({ ok: false, error: "BOM_LINES_REQUIRED" });

    await assertNoServiceOnlyComponents(
      client,
      companyId,
      sourceLines.map((line) => line.component_product_id)
    );

    const maxRevRes = await client.query(
      `
        select coalesce(max(revision_no), 0)::int as max_revision
        from manufacturing_boms
        where company_id = $1
          and bom_code = $2
      `,
      [companyId, source.bom_code]
    );
    const nextRevision = Math.max(1, Number(maxRevRes.rows[0]?.max_revision || source.revision_no || 1) + 1);
    const deactivatePrior = body.deactivate_prior !== false;

    await client.query("begin");
    if (deactivatePrior) {
      await client.query(
        `
          update manufacturing_boms
          set is_active = false, updated_at = now()
          where company_id = $1
            and bom_code = $2
            and is_active = true
        `,
        [companyId, source.bom_code]
      );
    }

    const headerRes = await client.query(
      `
        insert into manufacturing_boms (
          company_id,
          bom_code,
          finished_good_product_id,
          revision_no,
          is_active,
          lifecycle_state,
          remarks,
          created_by
        )
        values ($1,$2,$3,$4,true,'Draft',$5,$6)
        returning id
      `,
      [
        companyId,
        source.bom_code,
        source.finished_good_product_id,
        nextRevision,
        normalizeText(body.remarks) ||
          normalizeText(source.remarks) ||
          `Revised from ${source.bom_code} rev ${source.revision_no || 1}`,
        req.user.id,
      ]
    );
    const bomId = Number(headerRes.rows[0]?.id);
    for (let index = 0; index < sourceLines.length; index += 1) {
      const line = sourceLines[index];
      await client.query(
        `
          insert into manufacturing_bom_lines (
            bom_id, line_no, component_product_id, component_specification_id, item_code, item_name, uom, qty_per, remarks
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          bomId,
          index + 1,
          line.component_product_id,
          line.component_specification_id || null,
          line.item_code,
          line.item_name,
          line.uom,
          line.qty_per,
          line.remarks,
        ]
      );
    }
    await client.query("commit");

    const bom = await getBomHeaderOrNull(client, bomId, companyId);
    const lines = await getBomLines(client, bomId);
    return res.status(201).json({
      ok: true,
      bom,
      lines,
      source_bom_id: id,
      deactivated_prior: deactivatePrior,
      cloned_from_locked: isBomLocked(source),
    });
  } catch (err) {
    await client.query("rollback");
    if (err?.message === "SERVICE_ONLY_COMPONENT_FORBIDDEN" || err?.code === "SERVICE_ONLY_COMPONENT_FORBIDDEN") {
      return res.status(400).json({
        ok: false,
        error: "SERVICE_ONLY_COMPONENT_FORBIDDEN",
        detail: err.detail || err.message,
      });
    }
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_BOM_REVISION" });
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
