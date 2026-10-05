const express = require("express");
const multer = require("multer");

const { pool } = require("../db/pool");
const {
  applyDatasetVersion,
  buildPreview,
  DATASET_KEYS,
  getDatasetRows,
  getDatasetStatus,
  loadDatasetFromFiles,
  parseDatasetJson,
  validateDatasetRows,
} = require("../services/configuratorStore");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name !== "SuperAdmin") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  return next();
}

router.use(requireAuth);

router.get("/admin/bootstrap", requireSuperAdmin, async (_req, res, next) => {
  const client = await pool.connect();
  try {
    for (const key of DATASET_KEYS) {
      await client.query(
        `
          insert into configurator_datasets (dataset_key, dataset_name, is_active, updated_at)
          values ($1, $2, true, now())
          on conflict (dataset_key) do nothing
        `,
        [key, key === "nitrogen" ? "Nitrogen PSA" : key === "oxygen" ? "Oxygen PSA" : "Air Compressor"]
      );
    }
    const status = await getDatasetStatus(client);
    return res.json({ ok: true, datasets: status });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/admin/:key/preview-from-files", requireSuperAdmin, async (req, res, next) => {
  try {
    const key = req.params.key;
    const { rows, file_name } = loadDatasetFromFiles(key);
    const validation = validateDatasetRows(key, rows);
    const preview = buildPreview(key, rows);
    return res.json({ ok: true, file_name, validation, preview });
  } catch (err) {
    if (err?.code === "INVALID_JSON") {
      return res.status(400).json({ ok: false, error: "INVALID_JSON", file_name: err.file_name || null });
    }
    return next(err);
  }
});

router.post("/admin/:key/apply-from-files", requireSuperAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const key = req.params.key;
    const { rows, file_name } = loadDatasetFromFiles(key);
    const validation = validateDatasetRows(key, rows);
    if (!validation.ok) return res.status(400).json({ ok: false, error: "INVALID_DATASET", validation });

    await client.query("begin");
    const applied = await applyDatasetVersion(client, key, {
      rows,
      fileName: file_name || null,
      actorUserId: req.user?.id || null,
    });
    await client.query("commit");

    return res.json({ ok: true, applied });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.code === "INVALID_JSON") {
      return res.status(400).json({ ok: false, error: "INVALID_JSON", file_name: err.file_name || null });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/admin/:key/upload/preview", requireSuperAdmin, upload.single("file"), async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: "NO_FILE" });
    const raw = req.file.buffer.toString("utf8");
    const rows = parseDatasetJson(raw);
    const validation = validateDatasetRows(key, rows);
    const preview = buildPreview(key, rows);
    return res.json({ ok: true, file_name: req.file.originalname, validation, preview });
  } catch (err) {
    if (err?.code === "INVALID_JSON") {
      return res.status(400).json({ ok: false, error: "INVALID_JSON" });
    }
    return next(err);
  }
});

router.post("/admin/:key/upload/apply", requireSuperAdmin, upload.single("file"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const key = req.params.key;
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: "NO_FILE" });
    const raw = req.file.buffer.toString("utf8");
    const rows = parseDatasetJson(raw);
    const validation = validateDatasetRows(key, rows);
    if (!validation.ok) return res.status(400).json({ ok: false, error: "INVALID_DATASET", validation });

    await client.query("begin");
    const applied = await applyDatasetVersion(client, key, {
      rows,
      fileName: req.file.originalname,
      actorUserId: req.user?.id || null,
    });
    await client.query("commit");

    return res.json({ ok: true, applied });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err?.code === "INVALID_JSON") {
      return res.status(400).json({ ok: false, error: "INVALID_JSON" });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:key/current", requireSuperAdmin, async (req, res, next) => {
  try {
    const key = req.params.key;
    const rows = await getDatasetRows(pool, key);
    return res.json({ ok: true, dataset_key: key, row_count: rows.length, rows: rows.slice(0, 200) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
