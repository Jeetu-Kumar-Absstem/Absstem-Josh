const express = require("express");
const multer = require("multer");

const { pool } = require("../db/pool");
const { requireScreenAction } = require("../auth/authorization");
const { getActiveCompanyId } = require("../services/companyContext");
const { runExtractionPipeline } = require("../services/extraction/pipeline");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

router.use(requireAuth);

async function loadPrPendingLines(requisitionId, companyId) {
  const id = Number(requisitionId);
  if (!Number.isFinite(id) || id <= 0) return [];
  const r = await pool.query(
    `
      select
        prl.id,
        prl.line_no,
        prl.item_code,
        prl.item_name,
        prl.uom,
        greatest(
          coalesce(prl.qty_requested, 0)
          - coalesce((
              select sum(pol.qty)
              from purchase_order_lines pol
              join purchase_orders po on po.id = pol.purchase_order_id
              where pol.purchase_requisition_line_id = prl.id
                and po.po_status <> 'cancelled'
            ), 0),
          0
        ) as qty_pending
      from purchase_requisition_lines prl
      join purchase_requisitions pr on pr.id = prl.purchase_requisition_id
      where prl.purchase_requisition_id = $1
        and pr.company_id = $2
      order by prl.line_no asc, prl.id asc
    `,
    [id, Number(companyId)]
  );
  return r.rows.filter((row) => Number(row.qty_pending || 0) > 0.0001);
}

/**
 * Vendor quote PDF / text → extracted commercials for ConfirmDraftCard → receive (+ optional PO).
 */
router.post(
  "/vendor-quote-pdf",
  requireScreenAction("vendor_quotes", "can_create"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      const companyId = getActiveCompanyId(req);
      if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

      const requisitionId = Number(req.body?.purchase_requisition_id || req.body?.requisition_id);
      if (!Number.isFinite(requisitionId) || requisitionId <= 0) {
        return res.status(400).json({ ok: false, error: "REQUISITION_REQUIRED" });
      }

      const file = req.file || null;
      const pastedText = typeof req.body?.text === "string" ? req.body.text : "";
      if (!file && !pastedText.trim()) {
        return res.status(400).json({ ok: false, error: "FILE_OR_TEXT_REQUIRED" });
      }

      const prLines = await loadPrPendingLines(requisitionId, companyId);
      const extraction = await runExtractionPipeline({
        docType: "vendor_quote_pdf",
        text: pastedText,
        buffer: file?.buffer || null,
        meta: { prLines },
      });

      return res.json({
        ok: true,
        extraction,
        context: {
          purchase_requisition_id: requisitionId,
          purchase_rfq_vendor_id: req.body?.purchase_rfq_vendor_id ? Number(req.body.purchase_rfq_vendor_id) : null,
          vendor_id: req.body?.vendor_id ? Number(req.body.vendor_id) : null,
          create_po_after: String(req.body?.create_po_after || "true").toLowerCase() !== "false",
          file_name: file?.originalname || null,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * Inbound email text / existing queue fields → lead extract for ConfirmDraftCard.
 */
router.post("/inbound-email", requireScreenAction("leads", "can_view"), async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const extraction = await runExtractionPipeline({
      docType: "inbound_email",
      text: typeof body.body_text === "string" ? body.body_text : typeof body.text === "string" ? body.text : "",
      meta: {
        subject: body.subject,
        from_name: body.from_name,
        from_email: body.from_email,
        body_preview: body.body_preview,
      },
    });
    return res.json({
      ok: true,
      extraction,
      context: {
        inbound_email_id: body.inbound_email_id ? Number(body.inbound_email_id) : null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
