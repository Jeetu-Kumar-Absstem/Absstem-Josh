const express = require("express");
const multer = require("multer");
const { pool } = require("../db/pool");
const {
  DRIVE_CATEGORIES,
  normalizeCategory,
  canUploadDrive,
  canViewDrive,
  driveCapabilities,
  requireDriveUpload,
} = require("../auth/driveAccess");
const googleDrive = require("../services/googleDrive");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function publicFileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    drive_file_id: row.drive_file_id,
    category: row.category,
    file_name: row.file_name,
    mime_type: row.mime_type,
    file_size_bytes: row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
    company_id: row.company_id != null ? Number(row.company_id) : null,
    product_id: row.product_id != null ? Number(row.product_id) : null,
    owner_ref: row.owner_ref || null,
    uploaded_by: row.uploaded_by != null ? Number(row.uploaded_by) : null,
    created_at: row.created_at,
  };
}

function safeDispositionName(name) {
  return String(name || "file")
    .replace(/[\r\n"]/g, "_")
    .slice(0, 180);
}

router.use(requireAuth);

router.get("/capabilities", (req, res) => {
  return res.json({
    ok: true,
    drive_configured: googleDrive.isDriveConfigured(),
    ...driveCapabilities(req.user),
  });
});

router.get("/files", async (req, res, next) => {
  try {
    const category = normalizeCategory(req.query.category);
    if (category && !canViewDrive(req.user, category)) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const productId = req.query.product_id ? Number(req.query.product_id) : null;
    const params = [];
    const where = ["deleted_at is null"];

    if (category) {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    if (Number.isInteger(companyId) && companyId > 0) {
      params.push(companyId);
      where.push(`company_id = $${params.length}`);
    }
    if (Number.isInteger(productId) && productId > 0) {
      params.push(productId);
      where.push(`product_id = $${params.length}`);
    }

    const result = await pool.query(
      `
        select id, drive_file_id, category, file_name, mime_type, file_size_bytes,
               company_id, product_id, owner_ref, uploaded_by, created_at
        from drive_files
        where ${where.join(" and ")}
        order by created_at desc, id desc
        limit 200
      `,
      params
    );

    const files = result.rows
      .filter((row) => canViewDrive(req.user, row.category))
      .map(publicFileRow);

    return res.json({ ok: true, files });
  } catch (err) {
    return next(err);
  }
});

router.post("/upload/:category", requireDriveUpload(), upload.single("file"), async (req, res, next) => {
  try {
    if (!googleDrive.isDriveConfigured()) {
      return res.status(503).json({ ok: false, error: "DRIVE_NOT_CONFIGURED" });
    }
    const category = req.driveCategory || normalizeCategory(req.params.category);
    if (!category || !canUploadDrive(req.user, category)) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ ok: false, error: "FILE_REQUIRED" });
    }

    const companyId = req.body?.company_id ? Number(req.body.company_id) : null;
    const productId = req.body?.product_id ? Number(req.body.product_id) : null;
    const ownerRef = String(req.body?.owner_ref || "").trim().slice(0, 120) || null;
    const fileName = String(req.file.originalname || req.body?.file_name || "upload").slice(0, 240);
    const mimeType = req.file.mimetype || "application/octet-stream";

    const uploaded = await googleDrive.uploadFile({
      category,
      fileName,
      mimeType,
      buffer: req.file.buffer,
    });

    const insert = await pool.query(
      `
        insert into drive_files (
          drive_file_id, category, file_name, mime_type, file_size_bytes,
          company_id, product_id, owner_ref, uploaded_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        returning id, drive_file_id, category, file_name, mime_type, file_size_bytes,
                  company_id, product_id, owner_ref, uploaded_by, created_at
      `,
      [
        uploaded.drive_file_id,
        category,
        uploaded.file_name || fileName,
        uploaded.mime_type || mimeType,
        uploaded.file_size_bytes ?? req.file.size ?? null,
        Number.isInteger(companyId) && companyId > 0 ? companyId : null,
        Number.isInteger(productId) && productId > 0 ? productId : null,
        ownerRef,
        req.user.id || null,
      ]
    );

    return res.status(201).json({ ok: true, file: publicFileRow(insert.rows[0]) });
  } catch (err) {
    const googleMsg = err?.errors?.[0]?.message || err?.response?.data?.error?.message || err?.message;
    if (err?.code === "INVALID_GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON" || String(err?.message || "").includes("INVALID_GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON")) {
      return res.status(500).json({ ok: false, error: "INVALID_DRIVE_CREDENTIALS", detail: "Service account JSON could not be parsed." });
    }
    if (String(err?.message || "").includes("DRIVE_NOT_CONFIGURED") || err?.status === 503) {
      return res.status(503).json({ ok: false, error: "DRIVE_NOT_CONFIGURED", detail: "Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON/FILE and recreate api." });
    }
    if (googleMsg) {
      const status = Number(err?.code) >= 400 && Number(err?.code) < 600 ? Number(err.code) : 502;
      return res.status(status === 403 ? 403 : 502).json({
        ok: false,
        error: "DRIVE_UPLOAD_FAILED",
        detail: String(googleMsg).slice(0, 400),
      });
    }
    return next(err);
  }
});

router.get("/view/:fileId", async (req, res, next) => {
  try {
    if (!googleDrive.isDriveConfigured()) {
      return res.status(503).json({ ok: false, error: "DRIVE_NOT_CONFIGURED" });
    }

    const fileId = String(req.params.fileId || "").trim();
    if (!fileId) return res.status(400).json({ ok: false, error: "INVALID_FILE_ID" });

    const byInternal = String(req.query.by || "").toLowerCase() === "id";
    const lookup = await pool.query(
      `
        select id, drive_file_id, category, file_name, mime_type, file_size_bytes
        from drive_files
        where deleted_at is null
          and ${byInternal ? "id = $1" : "drive_file_id = $1"}
        limit 1
      `,
      [byInternal ? Number(fileId) : fileId]
    );
    const row = lookup.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!canViewDrive(req.user, row.category)) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    const download = ["1", "true", "yes"].includes(String(req.query.download || "").toLowerCase());
    const stream = await googleDrive.downloadFileStream(row.drive_file_id);

    res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `${download ? "attachment" : "inline"}; filename="${safeDispositionName(row.file_name)}"`
    );
    res.setHeader("Cache-Control", "private, no-store");
    stream.on("error", (err) => next(err));
    return stream.pipe(res);
  } catch (err) {
    return next(err);
  }
});

router.get("/categories", requireAuth, (_req, res) => {
  return res.json({ ok: true, categories: DRIVE_CATEGORIES });
});

module.exports = router;
