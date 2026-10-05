const express = require("express");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { getPolicyBootstrap, listApprovalPolicies } = require("../services/approvalPolicy");
const { getActiveCompanyId, requireResolvedCompanyId } = require("../services/companyContext");

const router = express.Router();

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function normalizeNullableInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeDocType(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLevel(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function findApproverUserProblem(client, userId) {
  if (!userId) return null;
  const r = await client.query(`select id, is_active from erp_users where id = $1 limit 1`, [userId]);
  if (!r.rows[0]) return "APPROVER_USER_NOT_FOUND";
  if (r.rows[0].is_active === false) return "APPROVER_USER_INACTIVE";
  return null;
}

function mapPolicyWriteError(err, res) {
  if (err?.code === "23505" && String(err.constraint || "").includes("user_doc_level")) {
    return res.status(409).json({
      ok: false,
      error: "DUPLICATE_USER_BAND",
      detail: "This user already has an active band for this document type and level.",
    });
  }
  if (err?.code === "23514") {
    return res.status(400).json({ ok: false, error: "APPROVER_SCOPE_REQUIRED" });
  }
  return null;
}

async function getListPayloadForCompany(client, companyId) {
  const [bootstrap, policies] = await Promise.all([getPolicyBootstrap(client), listApprovalPolicies(client, companyId)]);
  return { ...bootstrap, approval_policies: policies };
}

router.get("/bootstrap", requireScreenAction("approval_policy_matrix", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    return res.json({ ok: true, ...(await getListPayloadForCompany(pool, companyId)) });
  } catch (err) {
    return next(err);
  }
});

router.get("/", requireScreenAction("approval_policy_matrix", "can_view"), async (req, res, next) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });
    return res.json({ ok: true, approval_policies: await listApprovalPolicies(pool, companyId) });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireScreenAction("approval_policy_matrix", "can_create"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const docType = normalizeDocType(body.doc_type);
    const levelNo = normalizeLevel(body.level_no);
    const roleId = normalizeNullableInt(body.role_id);
    const groupId = normalizeNullableInt(body.group_id);
    const userId = normalizeNullableInt(body.user_id);
    const vendorId = normalizeNullableInt(body.vendor_id);
    const minAmount = money(body.min_amount);
    const maxAmount = body.max_amount === undefined || body.max_amount === null || body.max_amount === "" ? null : money(body.max_amount);
    const remarks = typeof body.remarks === "string" ? body.remarks.trim() : "";
    const isActive = body.is_active !== false;

    if (!["purchase_requisition", "purchase_order", "goods_receipt", "purchase_invoice", "vendor_payment"].includes(docType)) {
      return res.status(400).json({ ok: false, error: "INVALID_DOC_TYPE" });
    }
    if (!levelNo) return res.status(400).json({ ok: false, error: "INVALID_LEVEL" });
    if (!roleId && !groupId && !userId) return res.status(400).json({ ok: false, error: "APPROVER_SCOPE_REQUIRED" });
    if (maxAmount !== null && maxAmount < minAmount) return res.status(400).json({ ok: false, error: "INVALID_RANGE" });

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const userProblem = await findApproverUserProblem(client, userId);
    if (userProblem) return res.status(400).json({ ok: false, error: userProblem });

    await client.query("begin");
    const inserted = await client.query(
      `
        insert into approval_policies (
          company_id,
          doc_type,
          level_no,
          role_id,
          group_id,
          user_id,
          vendor_id,
          min_amount,
          max_amount,
          remarks,
          is_active,
          created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        returning id
      `,
      [companyId, docType, levelNo, roleId, groupId, userId, vendorId, minAmount, maxAmount, remarks || null, isActive, req.user.id]
    );
    await client.query("commit");

    const policyId = inserted.rows[0]?.id;
    const rows = await listApprovalPolicies(client, companyId);
    const approvalPolicy = rows.find((row) => Number(row.id) === Number(policyId)) || null;
    return res.status(201).json({ ok: true, approval_policy: approvalPolicy });
  } catch (err) {
    await client.query("rollback");
    if (mapPolicyWriteError(err, res)) return undefined;
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id", requireScreenAction("approval_policy_matrix", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const companyId = requireResolvedCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const docType = normalizeDocType(body.doc_type);
    const levelNo = normalizeLevel(body.level_no);
    const roleId = normalizeNullableInt(body.role_id);
    const groupId = normalizeNullableInt(body.group_id);
    const userIdProvided = Object.prototype.hasOwnProperty.call(body, "user_id");
    const vendorId = normalizeNullableInt(body.vendor_id);
    const minAmount = money(body.min_amount);
    const maxAmount = body.max_amount === undefined || body.max_amount === null || body.max_amount === "" ? null : money(body.max_amount);
    const remarks = typeof body.remarks === "string" ? body.remarks.trim() : "";
    const isActive = body.is_active !== false;

    if (!["purchase_requisition", "purchase_order", "goods_receipt", "purchase_invoice", "vendor_payment"].includes(docType)) {
      return res.status(400).json({ ok: false, error: "INVALID_DOC_TYPE" });
    }
    if (!levelNo) return res.status(400).json({ ok: false, error: "INVALID_LEVEL" });
    if (maxAmount !== null && maxAmount < minAmount) return res.status(400).json({ ok: false, error: "INVALID_RANGE" });

    await client.query("begin");
    const existing = await client.query(
      `select id, user_id from approval_policies where id = $1 and company_id = $2 limit 1 for update`,
      [id, companyId]
    );
    if (!existing.rows[0]?.id) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    // Clients that predate user-scoped rows omit user_id; keep the stored value for them.
    const userId = userIdProvided ? normalizeNullableInt(body.user_id) : normalizeNullableInt(existing.rows[0].user_id);
    if (!roleId && !groupId && !userId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "APPROVER_SCOPE_REQUIRED" });
    }
    const userProblem = await findApproverUserProblem(client, userId);
    if (userProblem) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: userProblem });
    }

    await client.query(
      `
        update approval_policies
        set doc_type = $2,
            level_no = $3,
            role_id = $4,
            group_id = $5,
            vendor_id = $6,
            min_amount = $7,
            max_amount = $8,
            remarks = $9,
            is_active = $10,
            user_id = $12,
            updated_at = now()
        where id = $1 and company_id = $11
      `,
      [id, docType, levelNo, roleId, groupId, vendorId, minAmount, maxAmount, remarks || null, isActive, companyId, userId]
    );
    await client.query("commit");

    const rows = await listApprovalPolicies(client, companyId);
    const approvalPolicy = rows.find((row) => Number(row.id) === Number(id)) || null;
    return res.json({ ok: true, approval_policy: approvalPolicy });
  } catch (err) {
    await client.query("rollback");
    if (mapPolicyWriteError(err, res)) return undefined;
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
