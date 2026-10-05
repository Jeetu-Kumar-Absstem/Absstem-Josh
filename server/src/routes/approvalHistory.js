const express = require("express");

const { pool } = require("../db/pool");
const { hasScreenAction, ownRecordsOnly } = require("../auth/authorization");
const { getDocConfig, getDocumentSnapshot } = require("../services/approvalPolicy");
const { getActiveCompanyId } = require("../services/companyContext");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

router.use(requireAuth);

router.get("/:docType/:docId", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const docType = typeof req.params.docType === "string" ? req.params.docType.trim() : "";
    const docId = Number(req.params.docId);
    const config = getDocConfig(docType);
    if (!config) return res.status(400).json({ ok: false, error: "INVALID_DOC_TYPE" });
    if (!Number.isFinite(docId) || docId <= 0) return res.status(400).json({ ok: false, error: "INVALID_DOC_ID" });
    if (!hasScreenAction(req, config.screenKey, "can_view")) return res.status(403).json({ ok: false, error: "FORBIDDEN" });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const doc = await getDocumentSnapshot(client, docType, docId, companyId);
    if (!doc) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    if (ownRecordsOnly(req, config.screenKey)) {
      const ownerRes = await client.query(
        `
          select created_by
          from ${config.table}
          where ${config.idColumn} = $1 and company_id = $2
          limit 1
        `,
        [docId, companyId]
      );
      const createdBy = Number(ownerRes.rows[0]?.created_by);
      if (Number.isFinite(createdBy) && createdBy > 0 && Number(createdBy) !== Number(req.user.id) && req.user.group_name !== "SuperAdmin") {
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
    }

    const historyRes = await client.query(
      `
        select
          h.id,
          h.action,
          h.action_level,
          h.remarks,
          h.acted_at,
          h.acted_by,
          u.full_name as acted_by_name,
          u.email as acted_by_email,
          h.policy_id,
          p.level_no as policy_level_no,
          r.role_name as policy_role_name,
          ug.group_name as policy_group_name,
          v.company_name as policy_vendor_name
        from approval_action_history h
        left join erp_users u on u.id = h.acted_by
        left join approval_policies p on p.id = h.policy_id
        left join roles r on r.id = p.role_id
        left join user_groups ug on ug.id = p.group_id
        left join vendors v on v.id = p.vendor_id
        where h.doc_type = $1 and h.doc_id = $2
        order by h.acted_at desc, h.id desc
      `,
      [docType, docId]
    );

    return res.json({
      ok: true,
      doc: {
        doc_type: docType,
        doc_id: docId,
        doc_number: doc.doc_number || null,
        doc_status: doc.doc_status || null,
        current_approval_level: Number(doc.current_approval_level || 0),
        required_approval_level: Number(doc.required_approval_level || 0),
      },
      history: historyRes.rows,
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
