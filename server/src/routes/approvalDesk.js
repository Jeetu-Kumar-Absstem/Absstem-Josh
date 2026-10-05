const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");
const {
  docTypeLabel,
  evaluateApprovalPermission,
  formatPolicyScope,
  getDocConfig,
  getDocumentSnapshot,
  getDocTypeOptions,
  insertApprovalHistory,
  resolveApprovalState,
} = require("../services/approvalPolicy");

const router = express.Router();

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(2));
}

function buildPolicyMatchReason(decision) {
  const policy = decision?.nextPolicy;
  if (!policy) {
    if (decision?.requiresPolicy) return "Policy chain required";
    return "Screen approver (no amount band)";
  }
  const parts = [];
  if (policy.vendor_name) parts.push(`Vendor ${policy.vendor_name}`);
  const minAmount = Number(policy.min_amount);
  if (Number.isFinite(minAmount)) parts.push(`Min ${money(minAmount)}`);
  if (policy.max_amount !== null && policy.max_amount !== undefined && policy.max_amount !== "") {
    parts.push(`Max ${money(policy.max_amount)}`);
  }
  parts.push(`L${decision.nextLevel || policy.level_no || "—"} → ${formatPolicyScope(policy)}`);
  return parts.join(" · ");
}

const LINE_SUMMARY_CONFIG = {
  purchase_requisition: {
    table: "purchase_requisition_lines",
    fk: "purchase_requisition_id",
    nameExpr: "coalesce(nullif(item_name, ''), nullif(item_code, ''), 'Line ' || line_no::text)",
  },
  purchase_order: {
    table: "purchase_order_lines",
    fk: "purchase_order_id",
    nameExpr: "coalesce(nullif(item_name, ''), nullif(item_code, ''), 'Line ' || line_no::text)",
  },
  goods_receipt: {
    table: "goods_receipt_lines",
    fk: "goods_receipt_id",
    nameExpr: "coalesce(nullif(item_name, ''), nullif(item_code, ''), 'Line ' || line_no::text)",
  },
  purchase_invoice: {
    table: "purchase_invoice_lines",
    fk: "purchase_invoice_id",
    nameExpr: "coalesce(nullif(item_name, ''), nullif(item_code, ''), 'Line ' || line_no::text)",
  },
};

async function loadLineSummary(docType, docId) {
  const cfg = LINE_SUMMARY_CONFIG[docType];
  if (!cfg || !Number.isFinite(Number(docId))) return null;
  try {
    const r = await pool.query(
      `
        select
          count(*)::int as line_count,
          array_agg(${cfg.nameExpr} order by line_no asc) as names
        from ${cfg.table}
        where ${cfg.fk} = $1
      `,
      [Number(docId)]
    );
    const lineCount = Number(r.rows[0]?.line_count || 0);
    if (!lineCount) return null;
    const names = Array.isArray(r.rows[0]?.names) ? r.rows[0].names.filter(Boolean) : [];
    const preview = names.slice(0, 2).join(", ");
    const extra = names.length > 2 ? ` +${names.length - 2}` : "";
    return `${lineCount} line${lineCount === 1 ? "" : "s"}${preview ? `: ${preview}${extra}` : ""}`;
  } catch {
    return null;
  }
}

async function loadHrContextSummary(docType, row) {
  if (docType === "leave_request") {
    const days = money(row.total_amount);
    return `${days} day${days === 1 ? "" : "s"} leave`;
  }
  if (docType === "expense_claim") {
    return `Expense ${row.currency_code || "INR"} ${money(row.total_amount).toFixed(2)}`;
  }
  return null;
}

function canApproveDocument(req, docType) {
  const config = getDocConfig(docType);
  return req.user?.group_name === "SuperAdmin" || hasScreenAction(req, config.screenKey, "can_approve");
}

async function getQueueRows(req, filters = {}) {
  const companyId = getActiveCompanyId(req);
  const docTypes = getDocTypeOptions().map((item) => item.key).filter((key) => !filters.doc_type || filters.doc_type === key);
  const rows = [];
  const isSuper = req.user?.group_name === "SuperAdmin";

  for (const docType of docTypes) {
    const config = getDocConfig(docType);
    if (!hasScreenAction(req, config.screenKey, "can_view")) continue;

    const params = [Number(companyId)];
    const pendingStatuses = Array.isArray(config.pendingStatuses) && config.pendingStatuses.length
      ? config.pendingStatuses
      : ["submitted"];
    params.push(pendingStatuses);
    const where = [`d.${config.statusColumn} = any($${params.length}::text[])`, `d.company_id = $1`];
    if (filters.vendor_id && config.vendorColumn && config.vendorColumn !== "null") {
      params.push(Number(filters.vendor_id));
      where.push(`${config.vendorColumn} = $${params.length}`);
    }
    if (filters.created_by) {
      params.push(Number(filters.created_by));
      where.push(`d.created_by = $${params.length}`);
    }
    if (filters.date_from) {
      params.push(filters.date_from);
      where.push(`d.${config.dateColumn} >= $${params.length}`);
    }
    if (filters.date_to) {
      params.push(filters.date_to);
      where.push(`d.${config.dateColumn} <= $${params.length}`);
    }

    const noLevels = config.hasApprovalLevels === false;
    const selectLevels = noLevels
      ? `0 as current_approval_level, 1 as required_approval_level, d.created_at as submitted_at, null::text as submitted_by_name`
      : `d.current_approval_level, d.required_approval_level, d.submitted_at, su.full_name as submitted_by_name`;
    const joins = noLevels
      ? `left join erp_users cu on cu.id = d.created_by`
      : `left join erp_users cu on cu.id = d.created_by
        left join erp_users su on su.id = d.submitted_by`;
    const orderBy = noLevels
      ? `d.${config.dateColumn} asc, d.${config.idColumn} asc`
      : `d.submitted_at asc nulls last, d.${config.dateColumn} asc, d.${config.idColumn} asc`;

    let r;
    try {
      r = await pool.query(
        `
          select
            '${docType}'::text as doc_type,
            d.${config.idColumn} as doc_id,
            ${config.numberColumn} as doc_number,
            d.${config.dateColumn} as doc_date,
            d.${config.statusColumn} as doc_status,
            d.company_id as company_id,
            ${config.vendorColumn} as vendor_id,
            ${config.vendorName} as vendor_name,
            ${config.totalColumn} as total_amount,
            ${config.totalCurrencyCode} as currency_code,
            ${selectLevels},
            d.created_by,
            cu.full_name as created_by_name
          from ${config.table} d
          ${config.vendorJoin}
          ${config.totalCurrencyJoin || ""}
          ${joins}
          where ${where.join(" and ")}
          order by ${orderBy}
        `,
        params
      );
    } catch {
      continue;
    }
    for (const row of r.rows) {
      const state = noLevels
        ? { currentLevel: 0, requiredLevel: 1, policies: [] }
        : await resolveApprovalState(pool, docType, row, companyId);
      const decision = noLevels
        ? { allowed: canApproveDocument(req, docType) || isSuper, requiresPolicy: false, nextLevel: 0, nextPolicy: null }
        : evaluateApprovalPermission({
            user: req.user,
            state,
            fallbackCanApprove: canApproveDocument(req, docType),
          });
      if (!isSuper && !decision.allowed) continue;
      const policy_match_reason = noLevels
        ? docType === "leave_request"
          ? "HR leave manager approval"
          : docType === "expense_claim"
            ? "HR expense manager approval"
            : "One-step approval"
        : buildPolicyMatchReason(decision);
      const line_summary = noLevels
        ? await loadHrContextSummary(docType, row)
        : await loadLineSummary(docType, row.doc_id);
      rows.push({
        ...row,
        total_amount: money(row.total_amount),
        current_approval_level: state.currentLevel,
        required_approval_level: state.requiredLevel,
        next_approval_level: decision.requiresPolicy ? decision.nextLevel : 0,
        next_approver: decision.nextPolicy ? formatPolicyScope(decision.nextPolicy) : decision.requiresPolicy ? "—" : "Screen approver",
        can_approve: Boolean(decision.allowed),
        policy_label: docTypeLabel(docType),
        policy_match_reason,
        line_summary,
      });
    }
  }

  return rows.sort((a, b) => new Date(a.submitted_at || 0).getTime() - new Date(b.submitted_at || 0).getTime());
}

async function getBootstrap() {
  const [vendorsRes, usersRes] = await Promise.all([
    pool.query(
      `
        select id, company_name
        from vendors
        where is_active = true
        order by company_name asc
      `
    ),
    pool.query(
      `
        select id, full_name, email
        from erp_users
        where is_active = true
        order by full_name asc nulls last, email asc
      `
    ),
  ]);
  return {
    vendors: vendorsRes.rows,
    users: usersRes.rows,
    doc_types: getDocTypeOptions(),
  };
}

router.get("/bootstrap", requireScreenAction("approval_desk", "can_view"), async (_req, res, next) => {
  try {
    const companyId = getActiveCompanyId(_req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const bootstrap = await getBootstrap();
    return res.json({ ok: true, ...bootstrap });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("approval_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const filters = {
      doc_type: typeof req.query.doc_type === "string" ? req.query.doc_type.trim() : "",
      vendor_id: Number.isFinite(Number(req.query.vendor_id)) && Number(req.query.vendor_id) > 0 ? Number(req.query.vendor_id) : null,
      created_by: Number.isFinite(Number(req.query.created_by)) && Number(req.query.created_by) > 0 ? Number(req.query.created_by) : null,
      date_from: typeof req.query.date_from === "string" && req.query.date_from.trim() ? req.query.date_from.trim() : null,
      date_to: typeof req.query.date_to === "string" && req.query.date_to.trim() ? req.query.date_to.trim() : null,
    };

    const [bootstrap, queue] = await Promise.all([getBootstrap(), getQueueRows(req, filters)]);

    const counts = {
      total_submitted: queue.length,
      purchase_requisition: queue.filter((row) => row.doc_type === "purchase_requisition").length,
      purchase_order: queue.filter((row) => row.doc_type === "purchase_order").length,
      goods_receipt: queue.filter((row) => row.doc_type === "goods_receipt").length,
      purchase_invoice: queue.filter((row) => row.doc_type === "purchase_invoice").length,
      vendor_payment: queue.filter((row) => row.doc_type === "vendor_payment").length,
      overdue: queue.filter((row) => {
        const submittedAt = row.submitted_at ? new Date(row.submitted_at).getTime() : 0;
        return submittedAt > 0 && Date.now() - submittedAt >= 2 * 24 * 60 * 60 * 1000;
      }).length,
    };

    return res.json({ ok: true, ...bootstrap, counts, queue });
  } catch (err) {
    return next(err);
  }
});

router.post("/action", requireScreenAction("approval_desk", "can_view"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const docType = typeof body.doc_type === "string" ? body.doc_type.trim() : "";
    const action = typeof body.action === "string" ? body.action.trim() : "";
    const docId = Number(body.doc_id);
    const remarks = typeof body.remarks === "string" ? body.remarks.trim().slice(0, 500) : "";
    const config = getDocConfig(docType);
    if (!config) return res.status(400).json({ ok: false, error: "INVALID_DOC_TYPE" });
    if (!["approve", "send_back", "post"].includes(action)) return res.status(400).json({ ok: false, error: "INVALID_ACTION" });
    if (!Number.isFinite(docId) || docId <= 0) return res.status(400).json({ ok: false, error: "INVALID_DOC_ID" });
    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    const header = await getDocumentSnapshot(client, docType, docId, companyId);
    if (!header) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const currentStatus = String(header.doc_status || "").toLowerCase();
    const noLevels = config.hasApprovalLevels === false;
    const pendingStatuses = Array.isArray(config.pendingStatuses) && config.pendingStatuses.length
      ? config.pendingStatuses.map((s) => String(s).toLowerCase())
      : ["submitted"];
    const isPending = pendingStatuses.includes(currentStatus);

    if (action === "approve" && !isPending) return res.status(409).json({ ok: false, error: "NEEDS_SUBMISSION" });
    if (action === "send_back" && !isPending) return res.status(409).json({ ok: false, error: "INVALID_TRANSITION" });
    if (
      action === "post" &&
      !isPending &&
      currentStatus !== "approved" &&
      !pendingStatuses.includes(currentStatus) &&
      req.user.group_name !== "SuperAdmin"
    ) {
      return res.status(409).json({ ok: false, error: "NEEDS_APPROVAL" });
    }

    await client.query("begin");
    if (noLevels) {
      if (!canApproveDocument(req, docType) && req.user.group_name !== "SuperAdmin") {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }

      let nextStatus = config.postStatus || "approved";
      let historyAction = "approved";
      if (action === "approve") {
        nextStatus = config.postStatus || "approved";
        historyAction = "approved";
      } else if (action === "send_back") {
        nextStatus = docType === "expense_claim" ? "returned" : "rejected";
        historyAction = "sent_back";
      } else if (action === "post") {
        nextStatus = config.postStatus || "approved";
        historyAction = "posted";
      }

      await client.query(
        `
          update ${config.table}
          set ${config.statusColumn} = $2,
              updated_at = now()
          where ${config.idColumn} = $1 and company_id = $3
        `,
        [docId, nextStatus, companyId]
      );
      await insertApprovalHistory(client, {
        docType,
        docId,
        action: historyAction,
        actionLevel: 0,
        policyId: null,
        remarks: remarks || null,
        actedBy: req.user.id,
      });
      await client.query("commit");
      return res.json({ ok: true });
    }

    if (action === "approve") {
      const state = await resolveApprovalState(client, docType, header, companyId);
      const decision = evaluateApprovalPermission({
        user: req.user,
        state,
        fallbackCanApprove: canApproveDocument(req, docType),
      });
      if (!decision.allowed) {
        await client.query("rollback");
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }

      if (decision.requiresPolicy && !decision.finalApproval && req.user.group_name !== "SuperAdmin") {
        await client.query(
          `
            update ${config.table}
            set current_approval_level = $2,
                required_approval_level = $3,
                updated_at = now()
            where ${config.idColumn} = $1 and company_id = $4
          `,
          [docId, decision.nextLevel, decision.requiredLevel, companyId]
        );
      } else {
        await client.query(
          `
            update ${config.table}
            set ${config.statusColumn} = 'approved',
                current_approval_level = $2,
                required_approval_level = $3,
                approved_by = $4,
                approved_at = now(),
                updated_at = now()
            where ${config.idColumn} = $1 and company_id = $5
          `,
          [docId, decision.requiredLevel, decision.requiredLevel, req.user.id, companyId]
        );
      }
      await insertApprovalHistory(client, {
        docType,
        docId,
        action: "approved",
        actionLevel: decision.requiresPolicy ? decision.nextLevel : 0,
        policyId: decision.nextPolicy?.id || null,
        remarks: remarks || null,
        actedBy: req.user.id,
      });
    } else if (action === "send_back") {
      await client.query(
        `
          update ${config.table}
          set ${config.statusColumn} = 'draft',
              submitted_by = null,
              submitted_at = null,
              approved_by = null,
              approved_at = null,
              current_approval_level = 0,
              required_approval_level = 0,
              updated_at = now()
          where ${config.idColumn} = $1 and company_id = $2
        `,
        [docId, companyId]
      );
      await insertApprovalHistory(client, {
        docType,
        docId,
        action: "sent_back",
        actionLevel: Math.max(0, Number(header.current_approval_level || 0)),
        remarks: remarks || null,
        actedBy: req.user.id,
      });
    } else if (action === "post") {
      const state = await resolveApprovalState(client, docType, header, companyId);
      const nextCurrentLevel =
        req.user.group_name === "SuperAdmin"
          ? state.requiredLevel
          : Math.max(state.currentLevel, state.requiredLevel);
      await client.query(
        `
          update ${config.table}
          set ${config.statusColumn} = $2,
              current_approval_level = $3,
              required_approval_level = $4,
              approved_by = case when approved_by is null then $5 else approved_by end,
              approved_at = case when approved_at is null then now() else approved_at end,
              updated_at = now()
          where ${config.idColumn} = $1 and company_id = $6
        `,
        [docId, config.postStatus, nextCurrentLevel, state.requiredLevel, req.user.id, companyId]
      );
      await insertApprovalHistory(client, {
        docType,
        docId,
        action: "posted",
        actionLevel: nextCurrentLevel,
        remarks: remarks || null,
        actedBy: req.user.id,
      });
    }
    await client.query("commit");

    return res.json({ ok: true });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
