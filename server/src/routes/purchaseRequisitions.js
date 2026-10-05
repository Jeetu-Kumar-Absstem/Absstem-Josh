const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly, requireScreenAction } = require("../auth/authorization");
const { evaluateApprovalPermission, formatPolicyScope, insertApprovalHistory, resolveApprovalState } = require("../services/approvalPolicy");
const { canAccessCompanyContext, getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const { lookupProducts } = require("../services/companyProductLookup");

const router = express.Router();

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(value) {
  const n = num(value, 0);
  return Math.round(n * 100) / 100;
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function calcTotals(lines) {
  let subtotal = 0;
  let taxTotal = 0;
  for (const line of lines) {
    const qtyRequested = num(line.qty_requested, 0);
    const unit = num(line.estimated_unit_price, 0);
    const gst = num(line.gst_pct, 0);
    const lineSubtotal = money(qtyRequested * unit);
    const lineTax = money(lineSubtotal * (gst / 100));
    subtotal += lineSubtotal;
    taxTotal += lineTax;
  }
  subtotal = money(subtotal);
  taxTotal = money(taxTotal);
  return {
    subtotal,
    taxTotal,
    grandTotal: money(subtotal + taxTotal),
  };
}

function canAccessPurchaseRequisition(req, requisition) {
  if (!requisition) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "purchase_requisitions")) return true;
  return Number(requisition.created_by) === Number(req.user.id);
}

function canAccessJobCardSource(req, jobCard) {
  if (!jobCard) return false;
  if (req.user.group_name === "SuperAdmin") return true;
  if (!ownRecordsOnly(req, "job_cards")) return true;
  return Number(jobCard.created_by) === Number(req.user.id);
}

async function getApprovalPreview(client, req, requisition, companyId) {
  if (!requisition) return null;
  const state = await resolveApprovalState(
    client,
    "purchase_requisition",
    {
      id: requisition.id,
      company_id: requisition.company_id || companyId,
      total_amount: requisition.estimated_total,
      current_approval_level: requisition.current_approval_level,
      required_approval_level: requisition.required_approval_level,
      doc_status: requisition.requisition_status,
      doc_number: requisition.requisition_number,
      doc_date: requisition.requisition_date,
    },
    companyId
  );
  const fallbackCanApprove = req.user?.group_name === "SuperAdmin" || hasScreenAction(req, "purchase_requisitions", "can_approve");
  const decision = evaluateApprovalPermission({
    user: req.user,
    state,
    fallbackCanApprove,
  });
  const normalizedStatus = String(requisition.requisition_status || "").toLowerCase();
  return {
    current_level: state.currentLevel,
    required_level: state.requiredLevel,
    next_level: state.requiredLevel > 0 && normalizedStatus === "submitted" ? state.nextLevel : 0,
    next_approver:
      normalizedStatus !== "submitted"
        ? "Submit first"
        : state.nextPolicy
          ? formatPolicyScope(state.nextPolicy)
          : state.requiredLevel > 0
            ? "Final approval"
            : fallbackCanApprove
              ? "Screen approver"
              : "—",
    can_current_user_approve: Boolean(decision.allowed) && normalizedStatus === "submitted",
    can_manage_post_approval: Boolean(fallbackCanApprove),
    requires_policy: state.requiredLevel > 0,
  };
}

async function getPurchaseRequisitionHeaderOrNull(client, requisitionId, companyId) {
  const r = await client.query(
    `
      select
        pr.*,
        cu.full_name as created_by_name,
        su.full_name as submitted_by_name,
        au.full_name as approved_by_name
      from purchase_requisitions pr
      left join erp_users cu on cu.id = pr.created_by
      left join erp_users su on su.id = pr.submitted_by
      left join erp_users au on au.id = pr.approved_by
      where pr.id = $1 and pr.company_id = $2
      limit 1
    `,
    [requisitionId, Number(companyId)]
  );
  return r.rows[0] || null;
}

async function getPurchaseRequisitionLines(client, requisitionId) {
  const r = await client.query(
    `
      with ordered_qty as (
        select
          pol.purchase_requisition_line_id,
          sum(case when po.po_status <> 'cancelled' then pol.qty else 0 end) as qty_ordered
        from purchase_order_lines pol
        join purchase_orders po on po.id = pol.purchase_order_id
        where pol.purchase_requisition_line_id is not null
        group by pol.purchase_requisition_line_id
      )
      select
        prl.*,
        pg.group_name as product_group_name,
        coalesce(oq.qty_ordered, 0) as qty_ordered,
        greatest(prl.qty_requested - coalesce(oq.qty_ordered, 0), 0) as qty_pending
      from purchase_requisition_lines prl
      left join products p on p.id = prl.product_id
      left join product_groups pg on pg.id = p.group_id
      left join ordered_qty oq on oq.purchase_requisition_line_id = prl.id
      where prl.purchase_requisition_id = $1
      order by prl.line_no asc
    `,
    [requisitionId]
  );
  return r.rows;
}

router.get("/bootstrap", requireScreenAction("purchase_requisitions", "can_view"), async (_req, res, next) => {
  try {
    const departmentsRes = await pool.query(
      `
        select department_key, department_name, sort_order, default_workspace_family
        from departments
        where is_active = true
        order by sort_order asc nulls last, department_name asc
      `
    );
    return res.json({ ok: true, departments: departmentsRes.rows });
  } catch (err) {
    return next(err);
  }
});

router.get("/product-lookup", requireScreenAction("purchase_requisitions", "can_view"), async (req, res, next) => {
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

router.get("/", requireScreenAction("purchase_requisitions", "can_view"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const params = [];
    const where = [];

    const activeCompanyId = getActiveCompanyId(req);
    if (!activeCompanyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    params.push(activeCompanyId);
    where.push(`pr.company_id = $${params.length}`);
    if (ownRecordsOnly(req, "purchase_requisitions")) {
      params.push(Number(req.user.id));
      where.push(`pr.created_by = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`pr.requisition_status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(pr.requisition_number ilike $${params.length} or coalesce(pr.department,'') ilike $${params.length} or coalesce(pr.purpose,'') ilike $${params.length})`);
    }

    const r = await pool.query(
      `
        select
          pr.id,
          pr.requisition_number,
          pr.requisition_status,
          pr.requisition_date,
          pr.required_by_date,
          pr.department,
          pr.estimated_total,
          pr.created_at,
          cu.full_name as created_by_name
        from purchase_requisitions pr
        left join erp_users cu on cu.id = pr.created_by
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by pr.created_at desc, pr.id desc
      `,
      params
    );

    return res.json({ ok: true, purchase_requisitions: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("purchase_requisitions", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    await client.query("begin");

    const numRes = await client.query(`select next_company_document_number($1,'PRQ') as requisition_number`, [companyId]);
    const requisitionNumber = numRes.rows[0]?.requisition_number;
    const insertRes = await client.query(
      `
        insert into purchase_requisitions (
          company_id,
          requisition_number,
          requisition_status,
          requisition_date,
          required_by_date,
          department,
          purpose,
          remarks,
          created_by
        )
        values ($1,$2,'draft',current_date,$3,$4,$5,$6,$7)
        returning id
      `,
      [
        companyId,
        requisitionNumber,
        body.required_by_date || null,
        typeof body.department === "string" ? body.department.trim() || null : null,
        typeof body.purpose === "string" ? body.purpose.trim() || null : null,
        typeof body.remarks === "string" ? body.remarks.trim() || null : null,
        req.user.id,
      ]
    );
    await client.query("commit");

    const requisitionId = insertRes.rows[0]?.id;
    const purchaseRequisition = await getPurchaseRequisitionHeaderOrNull(client, requisitionId, companyId);
    const lines = await getPurchaseRequisitionLines(client, requisitionId);
    return res.status(201).json({ ok: true, purchase_requisition: purchaseRequisition, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/from-shortage-action", requireScreenAction("purchase_requisitions", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const shortageActionId = Number(body.shortage_action_id);
    if (!Number.isFinite(shortageActionId) || shortageActionId <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_SHORTAGE_ACTION_ID" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const existingLink = await client.query(
      `
        select
          pr.id as purchase_requisition_id,
          pr.requisition_number,
          pr.requisition_status
        from purchase_requisition_lines prl
        join purchase_requisitions pr on pr.id = prl.purchase_requisition_id
        where pr.company_id = $1
          and prl.source_shortage_action_id = $2
        order by pr.created_at desc, pr.id desc
        limit 1
      `,
      [Number(companyId), shortageActionId]
    );
    const already = existingLink.rows[0] || null;
    if (already && already.purchase_requisition_id) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "SHORTAGE_REQUISITION_ALREADY_RAISED",
        purchase_requisition_id: already.purchase_requisition_id,
        requisition_number: already.requisition_number,
        requisition_status: already.requisition_status,
      });
    }

    const sourceRes = await client.query(
      `
        select
          jsa.id as shortage_action_id,
          jsa.action_type,
          jsa.action_date,
          jsa.shortage_qty,
          jsa.reference_no,
          jsa.expected_date,
          jsa.remarks as shortage_remarks,
          jc.id as job_card_id,
          jc.company_id,
          jc.job_card_number,
          jc.job_id,
          jc.job_status,
          jc.job_type,
          jc.department as job_card_department,
          jc.created_by,
          jcl.id as job_card_line_id,
          jcl.line_no,
          jcl.product_id,
          jcl.item_code,
          jcl.item_name,
          jcl.uom,
          p.hsn_no,
          coalesce(p.gst_pct, 0) as gst_pct,
          coalesce(p.last_purchase_price, p.list_price, 0) as estimated_unit_price,
          greatest(
            coalesce(jcl.qty_requested, 0) - (
              coalesce(issue_stats.issue_qty, 0) - coalesce(return_stats.return_qty, 0)
            ),
            0
          ) as pending_qty
        from job_card_line_shortage_actions jsa
        join job_cards jc on jc.id = jsa.job_card_id
        join job_card_lines jcl on jcl.id = jsa.job_card_line_id
        left join products p on p.id = jcl.product_id
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
        where jsa.id = $1
        limit 1
      `,
      [shortageActionId]
    );
    const source = sourceRes.rows[0] || null;
    if (!source) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "SHORTAGE_ACTION_NOT_FOUND" });
    }
    if (Number(source.company_id) !== Number(companyId)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessCompanyContext(req, source)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessJobCardSource(req, source)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (String(source.job_type || "").toLowerCase() !== "manufacturing" && !["service", "installation"].includes(String(source.job_type || "").toLowerCase())) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "SHORTAGE_SOURCE_JOB_TYPE_NOT_ALLOWED" });
    }
    if (String(source.action_type || "").toLowerCase() === "resolved") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "SHORTAGE_ACTION_ALREADY_RESOLVED" });
    }

    const pendingQty = money(source.pending_qty);
    const demandQty = source.shortage_qty !== null && source.shortage_qty !== undefined ? money(source.shortage_qty) : pendingQty;
    if (pendingQty <= 0 || demandQty <= 0) {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "NO_PENDING_SHORTAGE_QTY" });
    }
    if (demandQty > pendingQty) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "SHORTAGE_QTY_EXCEEDS_PENDING" });
    }

    const numRes = await client.query(`select next_company_document_number($1,'PRQ') as requisition_number`, [companyId]);
    const requisitionNumber = numRes.rows[0]?.requisition_number;
    const jobTypeLabel = String(source.job_type || "").toLowerCase() === "manufacturing" ? "Manufacturing" : "Service MRN";
    const purpose = `${jobTypeLabel} shortage for ${source.job_card_number}${source.job_id ? ` / ${source.job_id}` : ""}`;
    const remarks = [
      `Raised from Stores shortage action for ${source.job_card_number}${source.job_id ? ` / JobID ${source.job_id}` : ""}.`,
      `Line ${source.line_no} • ${source.item_code || "No item code"} • ${source.item_name || "No item name"}.`,
      source.reference_no ? `Stores Ref: ${source.reference_no}.` : null,
      source.expected_date ? `Expected by: ${source.expected_date}.` : null,
      source.shortage_remarks ? `Stores Notes: ${source.shortage_remarks}` : null,
    ]
      .filter(Boolean)
      .join(" ");

    const insertRes = await client.query(
      `
        insert into purchase_requisitions (
          company_id,
          requisition_number,
          requisition_status,
          requisition_date,
          required_by_date,
          department,
          purpose,
          remarks,
          created_by
        )
        values ($1,$2,'draft',current_date,$3,$4,$5,$6,$7)
        returning id
      `,
      [
        companyId,
        requisitionNumber,
        source.expected_date || null,
        normalizeText(source.job_card_department) || "Stores / Manufacturing",
        purpose,
        remarks,
        req.user.id,
      ]
    );
    const requisitionId = insertRes.rows[0]?.id;

    const lineSubtotal = money(demandQty * money(source.estimated_unit_price || 0));
    const lineTotal = money(lineSubtotal * (1 + num(source.gst_pct, 0) / 100));
    const lineDescription = [
      `Source Job Card ${source.job_card_number}${source.job_id ? ` / JobID ${source.job_id}` : ""}`,
      `Job line ${source.line_no}`,
      `Shortage action ${source.action_type} dated ${source.action_date}`,
      `Pending qty ${pendingQty.toFixed(4)}`,
      `Requested shortage qty ${demandQty.toFixed(4)}`,
    ].join(" • ");

    await client.query(
      `
        insert into purchase_requisition_lines (
          purchase_requisition_id,
          line_no,
          product_id,
          item_code,
          item_name,
          line_description,
          hsn_no,
          uom,
          qty_requested,
          estimated_unit_price,
          gst_pct,
          line_total_estimated,
          source_job_card_id,
          source_job_card_line_id,
          source_shortage_action_id
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `,
      [
        requisitionId,
        1,
        source.product_id ? Number(source.product_id) : null,
        source.item_code || null,
        source.item_name || null,
        lineDescription,
        normalizeText(source.hsn_no),
        normalizeText(source.uom),
        demandQty,
        money(source.estimated_unit_price || 0),
        num(source.gst_pct, 0),
        lineTotal,
        Number(source.job_card_id),
        Number(source.job_card_line_id),
        Number(source.shortage_action_id),
      ]
    );

    await client.query(
      `
        update purchase_requisitions
        set estimated_subtotal = $2,
            estimated_tax_total = $3,
            estimated_total = $4,
            updated_at = now()
        where id = $1 and company_id = $5
      `,
      [requisitionId, lineSubtotal, money(lineTotal - lineSubtotal), lineTotal, companyId]
    );

    await client.query("commit");
    const purchaseRequisition = await getPurchaseRequisitionHeaderOrNull(client, requisitionId, companyId);
    const lines = await getPurchaseRequisitionLines(client, requisitionId);
    return res.status(201).json({ ok: true, purchase_requisition: purchaseRequisition, lines });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id", requireScreenAction("purchase_requisitions", "can_view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const purchaseRequisition = await getPurchaseRequisitionHeaderOrNull(pool, id, companyId);
    if (!purchaseRequisition) return res.status(404).json({ ok: false });
    if (!canAccessCompanyContext(req, purchaseRequisition)) return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    if (!canAccessPurchaseRequisition(req, purchaseRequisition)) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const lines = await getPurchaseRequisitionLines(pool, id);
    const approvalPreview = await getApprovalPreview(pool, req, purchaseRequisition, companyId);
    return res.json({ ok: true, purchase_requisition: purchaseRequisition, lines, approval_preview: approvalPreview });
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", requireScreenAction("purchase_requisitions", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const nextStatus = typeof body.requisition_status === "string" ? body.requisition_status.trim().toLowerCase() : "";
    if (nextStatus && !["draft", "submitted", "approved", "closed", "cancelled"].includes(nextStatus)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS" });
    }
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    await client.query("begin");
    const existing = await getPurchaseRequisitionHeaderOrNull(client, id, companyId);
    if (!existing) {
      await client.query("rollback");
      return res.status(404).json({ ok: false });
    }
    if (!canAccessCompanyContext(req, existing)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "COMPANY_CONTEXT_MISMATCH" });
    }
    if (!canAccessPurchaseRequisition(req, existing)) {
      await client.query("rollback");
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const editingLines = Array.isArray(body.lines);
    const currentStatus = (existing.requisition_status || "draft").toLowerCase();
    if (editingLines && currentStatus !== "draft") {
      await client.query("rollback");
      return res.status(409).json({ ok: false, error: "REQUISITION_NOT_EDITABLE" });
    }

    let normalizedUpdateStatus = nextStatus ? nextStatus : existing.requisition_status || "draft";
    normalizedUpdateStatus = String(normalizedUpdateStatus || "").toLowerCase();
    const isSuper = req.user.group_name === "SuperAdmin";
    const canApprove = isSuper || hasScreenAction(req, "purchase_requisitions", "can_approve");

    if (normalizedUpdateStatus !== currentStatus) {
      if (normalizedUpdateStatus === "submitted") {
        if (currentStatus !== "draft" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "INVALID_TRANSITION" });
        }
      } else if (normalizedUpdateStatus === "draft") {
        if (currentStatus !== "submitted" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "INVALID_TRANSITION" });
        }
      } else if (normalizedUpdateStatus === "approved") {
        if (!canApprove) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "FORBIDDEN" });
        }
        if (currentStatus !== "submitted" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "NEEDS_SUBMISSION" });
        }
      } else if (normalizedUpdateStatus === "closed") {
        if (!canApprove) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "FORBIDDEN" });
        }
        if (currentStatus !== "approved" && !isSuper) {
          await client.query("rollback");
          return res.status(409).json({ ok: false, error: "NEEDS_APPROVAL" });
        }
      } else if (normalizedUpdateStatus === "cancelled") {
        if (!isSuper && currentStatus === "approved" && !canApprove) {
          await client.query("rollback");
          return res.status(403).json({ ok: false, error: "FORBIDDEN" });
        }
      }
    }

    const linesPayload = editingLines ? body.lines : null;
    const normalizedLines = [];
    if (editingLines) {
      for (const raw of linesPayload) {
        const productId =
          raw?.product_id === undefined || raw?.product_id === null || raw?.product_id === ""
            ? null
            : Number(raw.product_id);
        if (productId !== null && (!Number.isFinite(productId) || productId <= 0)) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_PRODUCT" });
        }

        const qtyRequested = num(raw?.qty_requested, 0);
        if (!Number.isFinite(qtyRequested) || qtyRequested <= 0) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_QTY" });
        }

        const unit = num(raw?.estimated_unit_price, 0);
        const gst = num(raw?.gst_pct, 0);
        if (!Number.isFinite(unit) || unit < 0 || !Number.isFinite(gst) || gst < 0 || gst > 100) {
          await client.query("rollback");
          return res.status(400).json({ ok: false, error: "INVALID_PRICE" });
        }

        normalizedLines.push({
          product_id: productId,
          item_code: typeof raw?.item_code === "string" ? raw.item_code.trim() : raw?.item_code || null,
          item_name: typeof raw?.item_name === "string" ? raw.item_name.trim() : raw?.item_name || null,
          line_description: typeof raw?.line_description === "string" ? raw.line_description.trim() : raw?.line_description || null,
          hsn_no: typeof raw?.hsn_no === "string" ? raw.hsn_no.trim() : raw?.hsn_no || null,
          uom: typeof raw?.uom === "string" ? raw.uom.trim() : raw?.uom || null,
          qty_requested: qtyRequested,
          estimated_unit_price: unit,
          gst_pct: gst,
        });
      }
    }

    const totals = editingLines
      ? calcTotals(normalizedLines)
      : {
          subtotal: money(existing.estimated_subtotal || 0),
          taxTotal: money(existing.estimated_tax_total || 0),
          grandTotal: money(existing.estimated_total || 0),
        };
    let approvalCurrentLevel = Number(existing.current_approval_level || 0);
    let approvalRequiredLevel = Number(existing.required_approval_level || 0);
    let approveBy = normalizedUpdateStatus === "approved" && currentStatus !== "approved" ? req.user.id : null;
    let approvalDecision = null;

    if (normalizedUpdateStatus === "submitted" && currentStatus !== "submitted") {
      const state = await resolveApprovalState(client, "purchase_requisition", {
        id,
        vendor_id: null,
        total_amount: totals.grandTotal,
        current_approval_level: 0,
      }, companyId);
      approvalCurrentLevel = 0;
      approvalRequiredLevel = state.requiredLevel;
    } else if (normalizedUpdateStatus === "draft") {
      approvalCurrentLevel = 0;
      approvalRequiredLevel = 0;
    } else if (normalizedUpdateStatus === "approved" && currentStatus !== "approved") {
      const state = await resolveApprovalState(client, "purchase_requisition", {
        id,
        vendor_id: null,
        total_amount: totals.grandTotal || existing.estimated_total,
        current_approval_level: existing.current_approval_level,
        required_approval_level: existing.required_approval_level,
      }, companyId);
      approvalDecision = evaluateApprovalPermission({
        user: req.user,
        state,
        fallbackCanApprove: canApprove,
      });
      if (!approvalDecision.allowed) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
      approvalRequiredLevel = approvalDecision.requiredLevel;
      if (approvalDecision.requiresPolicy && !approvalDecision.finalApproval && !isSuper) {
        normalizedUpdateStatus = "submitted";
        approvalCurrentLevel = approvalDecision.nextLevel;
        approveBy = null;
      } else {
        approvalCurrentLevel = approvalDecision.requiredLevel;
      }
    }

    const submitBy = normalizedUpdateStatus === "submitted" && currentStatus !== "submitted" ? req.user.id : null;
    const clearWorkflow = normalizedUpdateStatus === "draft";

    await client.query(
      `
        update purchase_requisitions
        set requisition_status = $2,
            requisition_date = coalesce($3, requisition_date),
            required_by_date = $4,
            department = $5,
            purpose = $6,
            remarks = $7,
            estimated_subtotal = $8,
            estimated_tax_total = $9,
            estimated_total = $10,
            current_approval_level = $11,
            required_approval_level = $12,
            submitted_by = case when $13::boolean then null when $14::integer is not null then $14 else submitted_by end,
            submitted_at = case when $13::boolean then null when $14::integer is not null then now() else submitted_at end,
            approved_by = case when $13::boolean then null when $15::integer is not null then $15 else approved_by end,
            approved_at = case when $13::boolean then null when $15::integer is not null then now() else approved_at end,
            updated_at = now()
        where id = $1 and company_id = $16
      `,
      [
        id,
        normalizedUpdateStatus,
        body.requisition_date || null,
        body.required_by_date || null,
        typeof body.department === "string" ? body.department.trim() || null : existing.department || null,
        typeof body.purpose === "string" ? body.purpose.trim() || null : existing.purpose || null,
        typeof body.remarks === "string" ? body.remarks.trim() || null : existing.remarks || null,
        totals.subtotal,
        totals.taxTotal,
        totals.grandTotal,
        approvalCurrentLevel,
        approvalRequiredLevel,
        clearWorkflow,
        submitBy,
        approveBy,
        companyId,
      ]
    );

    if (editingLines) {
      const existingLines = await getPurchaseRequisitionLines(client, id);
      const hasOrderedQty = existingLines.some((line) => Number(line.qty_ordered || 0) > 0);
      if (hasOrderedQty) {
        await client.query("rollback");
        return res.status(409).json({ ok: false, error: "REQUISITION_LINES_ALREADY_ORDERED" });
      }

      await client.query(`delete from purchase_requisition_lines where purchase_requisition_id = $1`, [id]);
      let lineNo = 1;
      for (const line of normalizedLines) {
        const lineSubtotal = money(num(line.qty_requested, 0) * num(line.estimated_unit_price, 0));
        const lineTotal = money(lineSubtotal * (1 + num(line.gst_pct, 0) / 100));
        await client.query(
          `
            insert into purchase_requisition_lines (
              purchase_requisition_id,
              line_no,
              product_id,
              item_code,
              item_name,
              line_description,
              hsn_no,
              uom,
              qty_requested,
              estimated_unit_price,
              gst_pct,
              line_total_estimated
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          `,
          [
            id,
            lineNo,
            line.product_id,
            line.item_code,
            line.item_name,
            line.line_description,
            line.hsn_no,
            line.uom,
            line.qty_requested,
            line.estimated_unit_price,
            line.gst_pct,
            lineTotal,
          ]
        );
        lineNo += 1;
      }
    }

    const actionRemarks = typeof body.approval_remarks === "string" ? body.approval_remarks.trim().slice(0, 500) : "";
    const requestedApproval = nextStatus === "approved" && currentStatus !== "approved";
    if (currentStatus !== normalizedUpdateStatus) {
      if (normalizedUpdateStatus === "submitted") {
        await insertApprovalHistory(client, {
          docType: "purchase_requisition",
          docId: id,
          action: "submitted",
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (normalizedUpdateStatus === "draft") {
        await insertApprovalHistory(client, {
          docType: "purchase_requisition",
          docId: id,
          action: "sent_back",
          actionLevel: Math.max(0, Number(existing.current_approval_level || 0)),
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      } else if (normalizedUpdateStatus === "closed") {
        await insertApprovalHistory(client, {
          docType: "purchase_requisition",
          docId: id,
          action: "posted",
          actionLevel: approvalCurrentLevel,
          remarks: actionRemarks || null,
          actedBy: req.user.id,
        });
      }
    }
    if (requestedApproval) {
      await insertApprovalHistory(client, {
        docType: "purchase_requisition",
        docId: id,
        action: "approved",
        actionLevel: approvalDecision?.requiresPolicy ? approvalDecision.nextLevel : 0,
        policyId: approvalDecision?.nextPolicy?.id || null,
        remarks: actionRemarks || null,
        actedBy: req.user.id,
      });
    }

    await client.query("commit");
    const purchaseRequisition = await getPurchaseRequisitionHeaderOrNull(client, id, companyId);
    const lines = await getPurchaseRequisitionLines(client, id);
    const approvalPreview = await getApprovalPreview(client, req, purchaseRequisition, companyId);
    return res.json({ ok: true, purchase_requisition: purchaseRequisition, lines, approval_preview: approvalPreview });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
