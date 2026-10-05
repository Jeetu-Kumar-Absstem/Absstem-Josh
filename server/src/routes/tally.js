const express = require("express");
const multer = require("multer");

const { pool } = require("../db/pool");
const { hasScreenAction, requireScreenAction } = require("../auth/authorization");
const { checkTypedConfirm } = require("../auth/typedConfirm");
const { getActiveCompanyId } = require("../services/companyContext");
const {
  parseTallyData,
  resolveCompany,
  stageAndAutoMatchTally,
  getStagedRecords,
  updateStagedRecordAction,
  bulkApproveStagingBatch,
  commitStagingBatchToLive,
  getTallyImportLogs,
  getTallyReconciliationVouchers,
  getTallyMasterMappings,
} = require("../services/tallyEngine");

const TALLY_UPLOAD_MAX_BYTES = 300 * 1024 * 1024; // 300MB — large transaction exports

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TALLY_UPLOAD_MAX_BYTES },
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

router.use(requireAuth);

function isTruthyFlag(value) {
  return value === true || value === 1 || ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

async function countNeedsReview(db, batchId) {
  const r = await db.query(
    `select count(*)::int as n from tally_staging_area where batch_id = $1 and resolution_status = 'NEEDS_REVIEW'`,
    [batchId]
  );
  return Number(r.rows[0]?.n || 0);
}

/**
 * GET /companies
 * List companies for the import dropdown (AI, AT, etc.)
 */
router.get("/companies", requireScreenAction("tally_import_desk", "can_view"), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `
        select
          id,
          company_code,
          legal_name,
          coalesce(display_name, legal_name) as display_name,
          gstin,
          is_active
        from companies
        where is_active = true
        order by company_code asc
      `
    );
    return res.json({ ok: true, companies: rows });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /preview
 * Parse XML/JSON and return counts + detect company metadata without committing
 */
router.post("/preview", requireScreenAction("tally_import_desk", "can_view"), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ ok: false, error: "NO_FILE_UPLOADED" });
    }

    const { tallyCompanyName, tallyGstin, ledgers, stock_items, vouchers } = parseTallyData(
      req.file.buffer,
      req.file.originalname || "tally_export.xml"
    );

    const targetCompanyId = req.body?.company_id || req.query?.company_id;
    let targetCompany = null;
    let mismatchWarning = null;

    if (targetCompanyId) {
      targetCompany = await resolveCompany(pool, targetCompanyId);
      if (targetCompany && (tallyGstin || tallyCompanyName)) {
        const targetGstin = (targetCompany.gstin || "").toUpperCase();
        if (tallyGstin && targetGstin && tallyGstin !== targetGstin) {
          mismatchWarning = `Mismatch Warning: File header contains GSTIN '${tallyGstin}', but selected company '${targetCompany.company_code}' has GSTIN '${targetGstin}'.`;
        }
      }
    }

    return res.json({
      ok: true,
      file_name: req.file.originalname,
      file_size_bytes: req.file.buffer.length,
      tally_company_name: tallyCompanyName,
      tally_gstin: tallyGstin,
      mismatch_warning: mismatchWarning,
      masters_count: ledgers.length + stock_items.length,
      ledgers_count: ledgers.length,
      stock_items_count: stock_items.length,
      vouchers_count: vouchers.length,
      sample_ledgers: ledgers.slice(0, 8),
      sample_stock_items: stock_items.slice(0, 8),
      sample_vouchers: vouchers.slice(0, 8),
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || "PARSE_FAILED" });
  }
});

/**
 * POST /stage-and-match
 * Upload into isolated staging schema & run deterministic + fuzzy auto-match pipeline
 */
router.post(
  "/stage-and-match",
  requireScreenAction("tally_import_desk", "can_create"),
  upload.single("file"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ ok: false, error: "NO_FILE_UPLOADED" });
      }

      const rawCompanyId = req.body?.company_id || req.query?.company_id || getActiveCompanyId(req);
      if (!rawCompanyId) {
        return res.status(400).json({ ok: false, error: "COMPANY_ID_REQUIRED", message: "Target company selection is required." });
      }

      await client.query("begin");

      const result = await stageAndAutoMatchTally(client, {
        companyIdOrCode: rawCompanyId,
        fileBuffer: req.file.buffer,
        fileName: req.file.originalname || "tally_import.xml",
        userId: req.user?.id || null,
      });

      await client.query("commit");
      return res.status(200).json(result);
    } catch (err) {
      await client.query("rollback");
      return res.status(err.status || 500).json({
        ok: false,
        error: err.code || "STAGING_FAILED",
        message: err.message || "Failed to stage and match Tally data.",
      });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /staging/:batchId
 * Fetch staged records, exceptions, and AI recommendations
 */
router.get("/staging/:batchId", requireScreenAction("tally_import_desk", "can_view"), async (req, res, next) => {
  try {
    const batchId = Number(req.params.batchId);
    if (!Number.isFinite(batchId)) return res.status(400).json({ ok: false, error: "INVALID_BATCH_ID" });

    const resolutionStatus = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const recordType = typeof req.query.record_type === "string" ? req.query.record_type.trim() : "";
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const records = await getStagedRecords(pool, {
      batchId,
      resolutionStatus,
      recordType,
      search,
    });

    const [logRes, statsRes] = await Promise.all([
      pool.query(`select * from tally_import_logs where id = $1 limit 1`, [batchId]),
      pool.query(
        `
          select
            count(*)::int as total_records,
            count(*) filter (where resolution_status = 'AUTO_MATCHED')::int as auto_matched_count,
            count(*) filter (where resolution_status = 'NEEDS_REVIEW')::int as exceptions_count,
            count(*) filter (where resolution_status = 'APPROVED')::int as approved_count,
            count(*) filter (where resolution_status = 'OVERRIDDEN')::int as overridden_count,
            count(*) filter (where resolution_status = 'COMMITTED')::int as committed_count
          from tally_staging_area
          where batch_id = $1
        `,
        [batchId]
      ),
    ]);

    return res.json({
      ok: true,
      batch: logRes.rows[0] || null,
      stats: statsRes.rows[0] || {},
      records,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /staging/:id/action
 * Approve or override a single staged exception
 */
router.post("/staging/:id/action", requireScreenAction("tally_import_desk", "can_edit"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const stagingId = Number(req.params.id);
    if (!Number.isFinite(stagingId)) return res.status(400).json({ ok: false, error: "INVALID_STAGING_ID" });

    const { action, target_id, notes } = req.body || {};
    await client.query("begin");
    const updated = await updateStagedRecordAction(client, {
      stagingId,
      action: action || "APPROVE",
      targetId: target_id || null,
      notes,
    });
    await client.query("commit");

    return res.json({ ok: true, record: updated });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /staging/:batchId/bulk-approve
 * Bulk approve auto-matched suggestions. NEEDS_REVIEW rows (variances, fuzzy matches) stay
 * for one-by-one review unless include_exceptions=true is sent explicitly.
 */
router.post("/staging/:batchId/bulk-approve", requireScreenAction("tally_import_desk", "can_edit"), async (req, res, next) => {
  const batchId = Number(req.params.batchId);
  if (!Number.isFinite(batchId)) return res.status(400).json({ ok: false, error: "INVALID_BATCH_ID" });
  if (!checkTypedConfirm(req, res, "BULK APPROVE", "a Tally bulk approval")) return undefined;
  const includeExceptions = isTruthyFlag(req.body?.include_exceptions);
  if (includeExceptions && !hasScreenAction(req, "tally_import_desk", "can_approve")) {
    return res.status(403).json({
      ok: false,
      error: "EXCEPTION_APPROVAL_FORBIDDEN",
      detail: "Bulk-approving exceptions needs Tally Import Desk approve rights. Review them one by one instead.",
    });
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await bulkApproveStagingBatch(client, batchId, { includeExceptions });
    const needsReviewRemaining = await countNeedsReview(client, batchId);
    await client.query("commit");

    return res.json({ ...result, needs_review_remaining: needsReviewRemaining });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /staging/:batchId/commit
 * Commit approved staging batch into live operational tables (Customers, Vendors, Products, Chart of Accounts, Vouchers)
 */
router.post("/staging/:batchId/commit", requireScreenAction("tally_import_desk", "can_approve"), async (req, res, next) => {
  const batchId = Number(req.params.batchId);
  if (!Number.isFinite(batchId)) return res.status(400).json({ ok: false, error: "INVALID_BATCH_ID" });
  if (!checkTypedConfirm(req, res, "COMMIT LIVE", "a Tally commit to live")) return undefined;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await commitStagingBatchToLive(client, batchId, req.user?.id || null);
    const needsReviewSkipped = await countNeedsReview(client, batchId);
    await client.query("commit");

    return res.json({ ...result, needs_review_skipped: needsReviewSkipped });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

/**
 * Legacy endpoint: stage + optional auto-commit.
 * Auto-commit requires can_approve, auto_commit=true AND review_acknowledged=true, and only runs
 * when staging produced zero NEEDS_REVIEW rows (variance / fuzzy matches). Otherwise it stays staged.
 */
router.post(
  "/import-and-reconcile",
  requireScreenAction("tally_import_desk", "can_create"),
  upload.single("file"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ ok: false, error: "NO_FILE_UPLOADED" });
      }

      const rawCompanyId = req.body?.company_id || req.query?.company_id || getActiveCompanyId(req);
      if (!rawCompanyId) {
        return res.status(400).json({ ok: false, error: "COMPANY_ID_REQUIRED", message: "Target company selection is required." });
      }

      const wantsAutoCommit = isTruthyFlag(req.body?.auto_commit ?? req.query?.auto_commit);
      const reviewAcknowledged = isTruthyFlag(req.body?.review_acknowledged ?? req.query?.review_acknowledged);

      if (wantsAutoCommit && !hasScreenAction(req, "tally_import_desk", "can_approve")) {
        return res.status(403).json({
          ok: false,
          error: "AUTO_COMMIT_FORBIDDEN",
          message: "Auto-commit requires Tally Import Desk approve rights. Stage only, then commit from the desk.",
        });
      }
      if (wantsAutoCommit && !reviewAcknowledged) {
        return res.status(400).json({
          ok: false,
          error: "REVIEW_ACK_REQUIRED",
          message: "Auto-commit needs review_acknowledged=true. Stage only, review the batch, then Commit to Live from the desk.",
        });
      }

      await client.query("begin");

      const stageRes = await stageAndAutoMatchTally(client, {
        companyIdOrCode: rawCompanyId,
        fileBuffer: req.file.buffer,
        fileName: req.file.originalname || "tally_import.xml",
        userId: req.user?.id || null,
      });

      const needsReview = await countNeedsReview(client, stageRes.batch_id);
      let commitRes = null;
      let autoCommitSkipped = null;
      if (wantsAutoCommit && needsReview > 0) {
        autoCommitSkipped = "EXCEPTIONS_PENDING";
      } else if (wantsAutoCommit) {
        commitRes = await commitStagingBatchToLive(client, stageRes.batch_id, req.user?.id || null);
      }

      await client.query("commit");
      return res.status(200).json({
        ...stageRes,
        ...(commitRes || {}),
        auto_committed: Boolean(commitRes),
        auto_commit_skipped: autoCommitSkipped,
        needs_review_count: needsReview,
        message: commitRes
          ? "Staged and committed to live."
          : autoCommitSkipped
            ? `Staged only — ${needsReview} record(s) need review (amount variance or fuzzy match). Resolve them, then Commit to Live.`
            : "Staged only. Review exceptions, then Commit to Live (approve) — auto-commit needs approve rights, auto_commit=true and review_acknowledged=true.",
      });
    } catch (err) {
      await client.query("rollback");
      return res.status(err.status || 500).json({
        ok: false,
        error: err.code || "IMPORT_FAILED",
        message: err.message || "Failed to import and reconcile Tally data.",
      });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /import-logs
 * Fetch past import runs per company
 */
router.get("/import-logs", requireScreenAction("tally_import_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const logs = await getTallyImportLogs(pool, companyId);
    return res.json({ ok: true, logs });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /reconciliations
 * Fetch reconciled vouchers with variance metrics
 */
router.get("/reconciliations", requireScreenAction("tally_import_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const importLogId = req.query.import_log_id ? Number(req.query.import_log_id) : null;
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const reconciliations = await getTallyReconciliationVouchers(pool, {
      companyId,
      importLogId,
      status,
      search,
    });

    return res.json({ ok: true, reconciliations });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /master-mappings
 * Fetch master dictionary mappings
 */
router.get("/master-mappings", requireScreenAction("tally_import_desk", "can_view"), async (req, res, next) => {
  try {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const masterType = typeof req.query.master_type === "string" ? req.query.master_type.trim() : "";
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const mappings = await getTallyMasterMappings(pool, {
      companyId,
      masterType,
      search,
    });

    return res.json({ ok: true, mappings });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
